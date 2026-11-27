// PlayNexa AI Office — K2: the Executive Agent, non-consequential by construction.
//
// THE RULING THIS FILE IS BUILT AGAINST:
//   "Do not enable consequential Executive Agent actions yet."
//
// So this agent reads an objective, opens a governed run against it, records what it observed,
// and finishes. It sends no email, no WhatsApp, makes no outward HTTP call and calls no LLM.
//
// That restraint is STRUCTURAL, not a promise in a comment:
//   • this module requires no mailer, no whatsapp module, no llm module, no fetch wrapper — the
//     capabilities are absent, not merely unused;
//   • scripts/check-office-k2-db.js asserts the module's require() graph contains none of them,
//     so adding one later fails a check rather than passing review;
//   • it also runs the agent with global fetch, the mailer and the WhatsApp sender replaced by
//     spies that FAIL the check if called. "It produced no output" is not evidence that nothing
//     was attempted — that lesson was paid for on 31 Oct, when a stubbed LLM returned null, the
//     RFQ email body came back null, dispatch treated it as a failed send, and every subject
//     assertion read `undefined` while appearing to pass.
//
// What it demonstrates for K2 is the chain, and nothing more:
//   CEO objective → governed run bound to (objective, company) → durable evidence → CEO-visible.

const { beginObjectiveRun } = require('./run');
const scope = require('./scope');
// B3.1a. Company-isolated agent memory. Required at the top, NOT lazily, so that
// check-office-k2-db.js sees it in this module's require() graph and keeps judging the real
// dependency set. `office/memory` holds no transport and none of the forbidden capability names:
// it is a table, a predicate and a context requirement.
const MEM = require('./memory');

// K8: declare this agent's kill-switch scope keys where they are DEFINED, so an operator can stop
// `workflow=objective-review` or `agent=executive-agent` by name and validation accepts it. An
// owner that forgets to register cannot be stopped by name — a loud, testable failure rather than
// a silent one. Additive: registration can never narrow what may be stopped.
require('../autonomy').registerScopes({
  workflows: ['objective-review'],
  agents: ['executive-agent'],
});

/**
 * The memory subject for one objective's review history.
 *
 * Derived from the OBJECTIVE, not from a timestamp or a run id, because the point of a subject is
 * that successive reviews of the same objective collide on it: that is what makes
 * `recallSubject` return the previous review and what gives `supersedes` something to point at. A
 * per-run subject would produce a pile of unrelated memories and a recall that always says "first".
 */
function reviewSubject(ctx) {
  return `objective-review:${ctx.objectiveId}`;
}

/**
 * What goes in the memory body: a sentence a person reading a briefing would want, built only from
 * values this run measured.
 *
 * Deliberately NOT a serialised blob. A memory body is read by people and by a future briefing, and
 * the structured numbers already live in the run outcome, which is the audited record. Storing JSON
 * here would invite a future caller to parse it and act on it — and a parsed memory that drives a
 * decision is precisely the "executable instructions" the owner's constraint rules out.
 */
function summariseForMemory(o) {
  const budget = o.budget_fraction_used === null
    ? 'no budget ceiling is set'
    : `${Math.round(o.budget_fraction_used * 100)}% of the budget is used`;
  return `Objective review: ${o.open_exceptions} open exception(s) `
    + `(${o.sla_breached} SLA-breached), ${o.pending_approvals} approval(s) pending, `
    + `$${o.spend_today_usd} spent today and ${budget}. Autonomy tier ${o.autonomy_tier}, `
    + `approval policy ${o.approval_policy}. Observation only — no business effect.`;
}

function lazyLedger(deps) {
  if (deps && deps.ledger) return deps.ledger;
  return require('../run-ledger').ledger({ query: deps && deps.query });
}

// Consume an objective: open a run, read the company's own state through the scoped accessor, and
// record a workflow outcome. Returns what a CEO view would show.
async function runObjectiveReview({ objectiveId, intentKey = null }, deps = {}) {
  const started = await beginObjectiveRun({
    objectiveId,
    // THREADED, NOT INVENTED. beginObjectiveRun has always accepted an explicit intent key; this
    // function simply was not passing one through, so the only reachable key was the derived
    // per-objective-per-day one. That default is right for the scheduled path — a cron that fires
    // twice must not review twice — and it is unchanged when nothing is supplied.
    //
    // A caller that names its own key is declaring a DIFFERENT intent, which is what an intent key
    // models: a deliberate re-review after a correction, or a second reading later the same day.
    // It is an explicit, audited choice rather than a bypass, and check-office-k2-db.js still
    // asserts that the default path refuses a duplicate.
    intentKey,
    trigger: 'office',
    triggerDetail: 'executive-agent/objective-review',
    workflow: 'objective-review',
    agent: 'executive-agent',
    // K4: declare the ceiling. This review is reads plus two inserts; if it is still going after
    // 15 minutes something is wrong, and recovery can say so without guessing a global threshold.
    maxRuntimeMinutes: 15,
  }, deps);

  // A stop refuses before the ledger opens (B3.11a put the check at the sink in office/run.js).
  // Reported distinctly from a duplicate: "declined, another process owns this intent" and "the
  // platform is halted" call for opposite responses from whoever reads the log.
  if (started.stopped) {
    return { ran: false, reason: 'stopped_by_policy',
      stop: `${started.stop.scope_type}${started.stop.scope_key ? `:${started.stop.scope_key}` : ''}`
        + ` — ${started.stop.reason}` };
  }

  if (started.duplicate) {
    // Another process owns this intent. Declined, not failed — a false "workflow failed" alert is
    // worse than the duplicate.
    return { ran: false, reason: 'duplicate_intent', intentKey: started.intentKey };
  }

  const ctx = started.context;
  const L = lazyLedger(deps);

  // CREATED -> RUNNING before any work. The state machine refuses CREATED -> SUCCEEDED directly,
  // and `finish` is OPERATIONAL durability class: it LOGS and returns rather than throwing. So an
  // agent that skips this does its work, reports success, and leaves a run stuck in CREATED that
  // the reaper will eventually call ABANDONED — a false success with a contradicting ledger.
  // (This is not hypothetical: the first version of this file omitted it, and the K2 check still
  // passed because it asserted the company/objective pair without asserting the final state.)
  await L.startRun(ctx.runId);

  try {
    // Everything below is READ, through the company-scoped accessor. A different company's rows
    // are unreachable from here: the accessor composes the predicate from ctx and the caller has
    // no way to widen it.
    const objective = await scope.getObjective(ctx, ctx.objectiveId, deps);
    const spend = await scope.spendToday(ctx, deps);
    const exceptions = await scope.listOpenExceptions(ctx, deps);
    const approvals = await scope.listPendingApprovals(ctx, deps);

    // ── B3.1a: WHAT THIS COMPANY ALREADY KNOWS ABOUT THIS OBJECTIVE ──────────
    //
    // Recall happens through the memory accessor with THIS run's context, so the company is the
    // one the run is welded to and nothing the caller supplies can widen it.
    //
    // ── WHAT RECALLED MEMORY MAY AND MAY NOT DO ──────────────────────────────
    //
    // Owner requirement, and it is a structural property of the lines below rather than a promise:
    //
    //   "Retrieved memory is untrusted data, not executable instructions or authorization. Memory
    //    must not expand company access, agent permissions, approved capabilities or budgets."
    //
    // So recalled memory reaches exactly two things: whether this review is a FIRST or a FOLLOW_UP,
    // and the id of the review it continues. It is never parsed, never evaluated, and its body is
    // never used to decide anything. Every authorization value in the observation below —
    // `company_id`, `autonomy_tier`, `approval_policy`, `budget_usd` — is read from `ctx`, which
    // was minted from stored state by office/context.js. A memory whose body says "budget is
    // unlimited" or "you may act for ABIOZEN" changes none of them, and
    // check-office-memory-integration-db.js asserts exactly that against adversarial rows.
    //
    // The distinction worth keeping: memory changes what the agent REPORTS. It cannot change what
    // the agent is ALLOWED to do, because nothing downstream reads permission from it.
    // ── AND AN OUTAGE IS NOT A FACT ──────────────────────────────────────────
    //
    // If memory cannot be read, this review still happens: the business function is the objective
    // review, and recall is an enhancement to it. Letting a missing table or an unreadable row turn
    // a working review into a FAILED run would make memory a new single point of failure for the
    // thing it was added to improve.
    //
    // But it degrades to UNKNOWN, not to 'first'. Reporting 'first' would state that this objective
    // has never been reviewed, which is a claim about the company's history that a database error
    // does not support — the same rule the membership accessor follows when it returns UNKNOWN
    // rather than "not a member". And no memory is written in that state, because superseding the
    // previous review correctly is impossible when the previous review cannot be read: a write here
    // would fork the chain and leave two live reviews each claiming to be the latest.
    let priorReview = null;
    let recallFailed = null;
    let conflicting = 0;
    try {
      const priorReviews = await MEM.recallSubject(ctx, { subject: reviewSubject(ctx) }, deps);
      priorReview = priorReviews.length ? priorReviews[0] : null;
      // CONFLICT IS REPORTED, NOT RESOLVED BY SILENCE. Two live memories for one subject means
      // two runs each believed they were the first — reachable if two reviews of the same objective
      // raced before either had written. `recallSubject` orders by created_at DESC, so picking
      // [0] is deterministic rather than arbitrary, and that is the right behaviour: the newest
      // reading is the current one. But an agent that quietly picks and says nothing hides a state
      // somebody should look at, so the count travels in the observation.
      conflicting = priorReviews.length > 1 ? priorReviews.length : 0;
    } catch (e) {
      recallFailed = (e && e.code) || (e && e.message) || 'unknown';
      console.error(`[executive-agent] run ${ctx.runId}: memory not readable (${recallFailed}) — `
        + 'review continues, history reported as unknown, nothing written');
    }

    const observation = {
      objective_id: ctx.objectiveId,
      company_id: ctx.companyId,
      autonomy_tier: ctx.autonomyTier,
      approval_policy: ctx.approvalPolicy,
      budget_usd: ctx.budgetUsd,
      spend_today_usd: Number(spend.usd),
      open_exceptions: exceptions.length,
      sla_breached: exceptions.filter((e) => e.sla_breached).length,
      pending_approvals: approvals.length,
      // Budget STATE only. No refusal is enforced here: K5's refusal surface is a separate
      // authorization whose production activation requires a ruling. Reporting a threshold is not
      // the same as acting on one, and conflating them is how an unauthorized control ships.
      budget_fraction_used: (ctx.budgetUsd && ctx.budgetUsd > 0)
        ? Number((Number(spend.usd) / ctx.budgetUsd).toFixed(4))
        : null,

      // ── THE ONLY TWO FIELDS RECALL REACHES ─────────────────────────────────
      //
      // A real use of memory, not decoration: the agent genuinely does not know whether it has
      // reviewed this objective before until it asks, and the answer changes its output. And it is
      // the narrowest use that still demonstrates the loop — ids and a sequence label, no body
      // content, so there is nothing for an adversarial memory to say that is listened to.
      review_sequence: recallFailed ? 'unknown' : (priorReview ? 'follow_up' : 'first'),
      continues_memory_id: priorReview ? priorReview.id : null,
      prior_review_at: priorReview ? priorReview.createdAt : null,
      conflicting_memories: conflicting,
    };

    // Durable workflow outcome, welded to this company's run by the composite FK. 'no_effect' is
    // the honest value: the agent observed and changed nothing in the business.
    const outcomeId = `oc-${ctx.runId}`;
    await scope.recordOutcome(ctx, {
      id: outcomeId,
      runId: ctx.runId,
      outcome: 'no_effect',
      businessEffect: 'observation only — consequential Executive Agent actions are not enabled',
      effectRef: null,
    }, deps);

    // ── B3.1a: REMEMBER WHAT WAS OBSERVED, SO THE NEXT RUN INHERITS IT ──────
    //
    // `confidence: 'derived'`, never 'stated'. Nobody told the company this; an agent concluded it
    // from a reading. That distinction is the one thing standing between an agent's inference and a
    // company fact, and it is recorded on the row rather than inferred later.
    //
    // `supersedes` the previous review of the same subject, so recall has ONE answer and the
    // history is kept rather than overwritten. The database enforces one correction per memory, so
    // two concurrent runs cannot both claim to replace the same review.
    //
    // PROVENANCE comes from the context, not from the arguments: memory.remember prefers
    // `ctx.runId` over any `sourceRunId` a caller passes, and takes `sourceObjectiveId` from
    // `ctx.objectiveId`. So the row answers "which run produced this, under which objective, for
    // which company" from the run that actually executed.
    //
    // A memory write failure must not turn a completed review into a failed run — the business
    // observation is already durable in `recordOutcome` above, which is the audited record. So this
    // is reported in the return value and logged, not thrown. A silent failure would be worse than
    // either: the next run would read "first review" forever and nobody would know why.
    let memoryId = null;
    let memoryError = recallFailed ? `not_written:recall_failed:${recallFailed}` : null;
    if (recallFailed) {
      // Deliberately no write. See the recall block above: without the previous review there is
      // nothing to supersede, and an unsuperseded write forks the chain.
    } else try {
      const remembered = await MEM.remember(ctx, {
        kind: 'outcome',
        subject: reviewSubject(ctx),
        body: summariseForMemory(observation),
        author: 'agent:executive-agent',
        confidence: 'derived',
        supersedes: priorReview ? priorReview.id : null,
      }, deps);
      memoryId = remembered.id;
    } catch (e) {
      memoryError = (e && e.code) || (e && e.message) || 'unknown';
      console.error(`[executive-agent] run ${ctx.runId}: memory not recorded (${memoryError})`);
    }

    await L.finish(ctx.runId, { state: 'SUCCEEDED' });
    return { ran: true, runId: ctx.runId, context: ctx, observation, outcomeId,
      memoryId, memoryError };
  } catch (e) {
    // Fail closed and leave the failure visible in the ledger rather than swallowing it.
    try { await L.finish(ctx.runId, { state: 'FAILED', error: e.message }); } catch (_) {}
    throw e;
  }
}

module.exports = { runObjectiveReview };
