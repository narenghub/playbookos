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

// K8: declare this agent's kill-switch scope keys where they are DEFINED, so an operator can stop
// `workflow=objective-review` or `agent=executive-agent` by name and validation accepts it. An
// owner that forgets to register cannot be stopped by name — a loud, testable failure rather than
// a silent one. Additive: registration can never narrow what may be stopped.
require('../autonomy').registerScopes({
  workflows: ['objective-review'],
  agents: ['executive-agent'],
});

function lazyLedger(deps) {
  if (deps && deps.ledger) return deps.ledger;
  return require('../run-ledger').ledger({ query: deps && deps.query });
}

// Consume an objective: open a run, read the company's own state through the scoped accessor, and
// record a workflow outcome. Returns what a CEO view would show.
async function runObjectiveReview({ objectiveId }, deps = {}) {
  const started = await beginObjectiveRun({
    objectiveId,
    trigger: 'office',
    triggerDetail: 'executive-agent/objective-review',
    workflow: 'objective-review',
    agent: 'executive-agent',
    // K4: declare the ceiling. This review is reads plus two inserts; if it is still going after
    // 15 minutes something is wrong, and recovery can say so without guessing a global threshold.
    maxRuntimeMinutes: 15,
  }, deps);

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

    await L.finish(ctx.runId, { state: 'SUCCEEDED' });
    return { ran: true, runId: ctx.runId, context: ctx, observation, outcomeId };
  } catch (e) {
    // Fail closed and leave the failure visible in the ledger rather than swallowing it.
    try { await L.finish(ctx.runId, { state: 'FAILED', error: e.message }); } catch (_) {}
    throw e;
  }
}

module.exports = { runObjectiveReview };
