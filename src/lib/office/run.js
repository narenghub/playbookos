// PlayNexa AI Office — K2: starting a governed run against an objective.
//
// This is the ONLY place in the codebase that supplies `companyId` to the run ledger, and it does
// not accept one. The company is READ from the stored objective:
//
//     beginObjectiveRun({ objectiveId })
//         → resolveObjectiveContext(objectiveId)      ← company comes from the row
//         → ledger.createRun({ ..., companyId, objectiveId })
//
// There is no parameter through which a caller or an agent could name a company, which is the
// same structural choice as context.js: a validation check would have to be remembered and could
// be relaxed by a later caller with a reason.
//
// FOUR GUARANTEES, AND ONLY ONE OF THEM IS THIS FILE'S:
//   1. company and objective arrive together or not at all          — MATCH FULL (database)
//   2. the pair must be a real objective of that company            — composite FK (database)
//   3. neither can be changed after the insert                      — transition guard (database)
//   4. the company is never caller-supplied                         — this file's signature
// Three of the four are the engine's. This file only declines to hand it the wrong thing.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not execute anything consequential. Per the K2
// ruling, "do not enable consequential Executive Agent actions yet" — so the run this creates is
// an identity and an evidence trail, and the Executive Agent that consumes it (executive-agent.js)
// reads and records. No email, no WhatsApp, no outward call.

const { resolveObjectiveContext } = require('./context');

function lazyLedger(deps) {
  if (deps && deps.ledger) return deps.ledger;
  return require('../run-ledger').ledger({ query: deps && deps.query });
}

// Start a run for an objective. The objective must be ACTIVE: resolveObjectiveContext refuses
// draft, paused, met, missed and cancelled, so a run cannot be opened against an objective the
// CEO has not switched on — or has switched off.
async function beginObjectiveRun({ objectiveId, trigger, triggerDetail = null, workflow = null, agent = null, product = 'internal', intentKey = null, maxRuntimeMinutes = null }, deps = {}) {
  if (!objectiveId) throw new Error('beginObjectiveRun requires an objectiveId');
  if (!trigger) throw new Error('beginObjectiveRun requires a trigger');

  // Company derived here, from the stored objective, and nowhere else.
  const ctx = await resolveObjectiveContext({ objectiveId }, deps);

  // ── THE KILL SWITCH, AT THE SINK ──────────────────────────────────────────
  //
  // B3.11a, requirement 2 of 2026-11-26: *"Complete B3.11a authorization adoption through an actual
  // execution-path audit. Do not treat the heuristic list of 37 operations as a complete inventory
  // or import counts as enforcement evidence."*
  //
  // The audit (`scripts/check-authz-execution-paths.js`) found this. B3.12 put the stop check in
  // the INITIATOR, before the ledger opens, and that is a real design — but "the initiator checks"
  // is a claim about every caller, and measured across the production call sites it was **2 of 6**:
  // `office/initiator.js` and `office/procurement-rfq.js` checked; `agents/inquiry-agent.js`,
  // `agents/outreach-approval.js`, `office/executive-agent.js` and `connectors/grants-gov-job.js`
  // did not. On those four paths a stopped platform still opened runs.
  //
  // Four more upstream copies would have fixed exactly those four paths. This repository's own
  // lesson is the other one: a gate at the sink is on every path INCLUDING the ones nobody has
  // written yet, and an upstream convention is adopted until the next caller forgets it. So the
  // check lives here, and the initiator's own check stays where it is — it refuses a whole batch
  // with a per-objective reason before doing any work, which is better reporting, not redundancy.
  //
  // Consequential: TRUE. Opening a run is minting the identity that authorization attaches to, not
  // thinking about it, so an UNREADABLE stop state refuses rather than taking the read-only path's
  // null. A thrown error from the stop read is also a refusal: an unreadable stop is not permission.
  const autonomy = (deps && deps.autonomy) || require('../autonomy');
  let stopped;
  try {
    stopped = await autonomy.checkStopped({
      capability: 'office.initiate', company: ctx.companyId, workflow, agent,
    }, { consequential: true, deps });
  } catch (e) {
    stopped = { unknown: true, scope_type: 'global', scope_key: '',
      reason: `the stop state could not be read (${e.message})` };
  }
  if (stopped) {
    // A REFUSAL, NOT A THROW, and not a silent false either. `runId` and `context` are null, which
    // is the same shape the duplicate path already returns, so a caller that branches on either —
    // as four of the six do — cannot mistake this for a run it may use. `context` being null is
    // itself structural: assertContext refuses anything not branded by office/context.js, so a
    // caller that ignores all of this still cannot act on a company with it.
    return {
      stopped: true,
      stop: { scope_type: stopped.scope_type, scope_key: stopped.scope_key || '',
        reason: stopped.reason, unknown: stopped.unknown === true },
      duplicate: false,
      intentKey: null,
      runId: null,
      context: null,
    };
  }

  const L = lazyLedger(deps);

  // K4: an office run gets a STABLE INTENT KEY by default. Without one it is permanently
  // unretryable — the retry guard requires a non-null intent_key on both the predecessor and the
  // retry — so recovery could never produce an attempt 2 for it. The day-slot key also makes
  // uq_agent_runs_one_active decline a second run of the same workflow against the same objective
  // on the same day, which is the wanted behaviour: two concurrent reviews of one objective are
  // not two intents. A caller may still supply its own.
  const key = intentKey
    || require('../runs').objectiveIntentKey(workflow || 'objective-run', ctx.objectiveId);

  const created = await L.createRun({
    trigger, triggerDetail, workflow, agent, product,
    intentKey: key,
    maxRuntimeMinutes,
    objectiveId: ctx.objectiveId,
    companyId: ctx.companyId,
  });

  if (created.duplicate) return { stopped: false, duplicate: true, intentKey: created.intentKey, runId: null, context: null };

  // The context handed onward is the one resolved from the objective, now carrying the run. Frozen,
  // so a downstream caller cannot rewrite the company in place.
  return {
    // Present and false on every return, so `begun.stopped` is a question a caller can ask
    // without knowing which path it came back from. An absent property reads as false by accident;
    // this reads as false on purpose.
    stopped: false,
    duplicate: false,
    runId: created.runId,
    rootRunId: created.rootRunId,
    // deriveContext, not a bare Object.freeze: office/context.js brands contexts with a
    // module-private Symbol, and a hand-built copy — however frozen — is refused by assertContext
    // as "not produced by". Deriving keeps the brand and cannot change the company.
    context: require('./context').deriveContext(ctx, { runId: created.runId }),
  };
}

module.exports = { beginObjectiveRun };
