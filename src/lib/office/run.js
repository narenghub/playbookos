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

  if (created.duplicate) return { duplicate: true, intentKey: created.intentKey, runId: null, context: null };

  // The context handed onward is the one resolved from the objective, now carrying the run. Frozen,
  // so a downstream caller cannot rewrite the company in place.
  return {
    duplicate: false,
    runId: created.runId,
    rootRunId: created.rootRunId,
    context: Object.freeze({
      companyId: ctx.companyId,
      objectiveId: ctx.objectiveId,
      runId: created.runId,
      autonomyTier: ctx.autonomyTier,
      approvalPolicy: ctx.approvalPolicy,
      budgetUsd: ctx.budgetUsd,
    }),
  };
}

module.exports = { beginObjectiveRun };
