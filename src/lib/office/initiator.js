// ── §6: THE SCHEDULER STARTS THE RUN, NOT A CHECKER ─────────────────────────
//
//   const report = await initiateDueObjectives({ companyId }, deps);
//
// Owner's §6 of 2026-11-25:
//
//   *"Implement the missing scheduled objective initiator using the existing goal engine,
//    orchestration and durable run ledger. Preserve the dependency plan's rule: initiation
//    consumes existing authority and creates none."*
//
// B3.10 proved the fifteen-step cycle executes. It did not prove the office RUNS: the cycle was
// driven by `check-autonomous-office-cycle-db.js`, a checker somebody invokes. This is the piece
// that makes a run start because a schedule fired and an objective was eligible, with no human
// starting each one.
//
// ── WHAT "CONSUMES EXISTING AUTHORITY AND CREATES NONE" MEANS HERE ─────────
//
// This module writes NOTHING except through the run ledger. It does not:
//
//   • activate an objective — a draft objective stays a draft. Activation is the CEO's act, and an
//     initiator that could activate would be a scheduler granting itself work.
//   • set or raise a budget — an objective with no finite budget is SKIPPED, not funded. B2.5a
//     refuses an unfunded autonomous run anyway, so funding one here would be inventing the
//     authorization that refusal exists to require.
//   • raise an autonomy tier, grant a capability, or create a membership.
//   • lift a STOP.
//
// `initiator-is-read-only.test.js` asserts each of those on the source, because the tempting
// shortcut — "the objective is obviously meant to be active, just activate it" — is exactly the
// step that turns a scheduler into an authority.
//
// ── DUPLICATE INITIATION IS ALREADY STRUCTURAL, AND IS NOT REBUILT HERE ────
//
// `beginObjectiveRun` mints a stable intent key and `uq_agent_runs_one_active` — a partial unique
// index over the live states — permits at most one active run per intent. So two schedulers, or one
// scheduler firing twice, cannot produce two runs of the same intent: the DATABASE declines the
// second and `beginObjectiveRun` returns `{ duplicate: true }`.
//
// Adding a "have I already run today?" check here would be a second arbiter, correct only while
// every future writer remembers it. The index cannot be forgotten. What this module does instead is
// COUNT the duplicates it was handed, so a scheduler misfiring twice a minute is visible rather
// than silently idempotent.
//
// ── THE DAY SLOT IS A BUSINESS DAY, NOT A UTC DAY ──────────────────────────
//
// `objectiveIntentKey` defaults to a UTC day slot. Since B7.23 the crons fire in America/Chicago,
// and the two disagree: 23:00 Chicago and 01:00 Chicago the next morning are the same UTC day, so a
// run on each of two consecutive business days would be declined as a duplicate. That is the same
// defect B7.23 found in performance scoring — a job answering the UTC-day question when the
// business-day question was the one asked — so this passes an explicit business-day key rather
// than taking the default.

'use strict';

const WORKFLOW = 'office-scheduled-initiation';

// Only this tier. 'none' means a human does the work, 'bounded' is not authorized for autonomous
// delegation (B3.3 refuses it), and 'supervised' means every consequential action is approved
// first — which is what makes an unattended start acceptable at all.
const AUTHORIZED_TIER = 'supervised';

const SKIP = Object.freeze({
  NOT_ACTIVE: 'objective_not_active',
  TIER: 'autonomy_tier_not_supervised',
  NO_BUDGET: 'no_finite_budget',
  COMPANY_INACTIVE: 'company_not_active',
  STOPPED: 'stopped_by_policy',
  DUPLICATE: 'already_initiated_for_this_slot',
});

const q = (deps) => (deps && deps.query) || require('../db').query;

/**
 * Objectives a schedule may start right now, and the reason every other one may not.
 *
 * Reads only. The SKIP reasons are returned rather than logged away, because "the scheduler did
 * nothing this morning" and "the scheduler found four objectives and all four lack a budget" are
 * very different operational facts and only one of them is a problem with the scheduler.
 */
async function eligibleObjectives({ companyId = null, asOf = null } = {}, deps = {}) {
  // THE KERNEL SQL LIVES IN scope.js, which is the only module permitted to reach these tables
  // (check-office-scope-discipline.js). The first draft queried `objectives` and `companies`
  // directly from here and the gate caught it — correctly: an exemption list that grows one
  // reasonable entry at a time is how a discipline stops being one. The sweep is now
  // scope.bootstrapObjectivesForInitiation, which takes the same exception
  // bootstrapObjectiveForContext does, because a function whose job is to establish which company
  // is involved cannot require one first.
  //
  // It returns rows and decides nothing. Every eligibility rule below stays here, where it is
  // tested.
  const scope = deps.scope || require('./scope');
  const rows = await scope.bootstrapObjectivesForInitiation(companyId, deps);

  // resolveObjectiveContext, NOT resolveCompanyForScheduledWorkflow. The scheduled-workflow road
  // resolves a company through `workflow_companies`, which would mean this new workflow needed an
  // owner-approved mapping before it could read anything — and the mapping would be a second
  // answer to a question the objective already answers. The objective NAMES its company; that is
  // the trusted source beginObjectiveRun uses, and using the same one keeps there being one.
  const { resolveObjectiveContext } = deps.ctxFactory || require('./context');

  const eligible = [];
  const skipped = [];
  for (const o of rows) {
    const base = { objectiveId: o.id, companyId: o.company_id };
    if (o.company_status !== 'active') {
      skipped.push({ ...base, reason: SKIP.COMPANY_INACTIVE, detail: o.company_status });
      continue;
    }
    if (o.status !== 'active') {
      skipped.push({ ...base, reason: SKIP.NOT_ACTIVE, detail: o.status });
      continue;
    }
    if (o.autonomy_tier !== AUTHORIZED_TIER) {
      skipped.push({ ...base, reason: SKIP.TIER, detail: o.autonomy_tier });
      continue;
    }
    let exception = null;
    if (o.budget_usd === null) {
      // The SAME accessor reserveSpend consults. See the note in the query above.
      try {
        const octx = await resolveObjectiveContext({ objectiveId: o.id }, deps);
        exception = await scope.activeBudgetException(octx, o.id, deps);
      } catch (e) {
        // An unreadable exception is not an exception — the B2.5a rule. Skipped, with the reason,
        // rather than treated as funded.
        skipped.push({ ...base, reason: SKIP.NO_BUDGET,
          detail: `the budget exception could not be read (${e.message})` });
        continue;
      }
      if (!exception) {
        // NOT funded here. B2.5a would refuse the run anyway; skipping says so before a run
        // exists rather than after one has been opened and immediately refused.
        skipped.push({ ...base, reason: SKIP.NO_BUDGET });
        continue;
      }
    }
    eligible.push({ ...base, objective: o.objective, budgetUsd: o.budget_usd,
      viaException: exception !== null,
      exceptionId: exception ? exception.id : null });
  }
  return { eligible, skipped, considered: rows.length };
}

/**
 * Start a run for every objective a schedule may start right now.
 *
 * @returns {{initiated:Array, duplicates:Array, skipped:Array, refused:Array, considered:number}}
 *
 * `refused` is separate from `skipped` on purpose: skipped means the objective was not eligible,
 * refused means it was eligible and something declined the run. Collapsing the two would hide a
 * STOP behind the same count as a missing budget.
 */
async function initiateDueObjectives({ companyId = null, asOf = null,
  workflow = WORKFLOW, agent = 'office-initiator' } = {}, deps = {}) {
  const { eligible, skipped, considered } = await eligibleObjectives({ companyId, asOf }, deps);

  const run = deps.run || require('./run');
  const autonomy = deps.autonomy || require('../autonomy');
  const { businessToday } = deps.agentCore || require('../agent-core');
  const { objectiveIntentKey } = deps.runs || require('../runs');

  const initiated = [];
  const duplicates = [];
  const refused = [];

  for (const o of eligible) {
    // ── THE KILL SWITCH, PER OBJECTIVE'S COMPANY, BEFORE A RUN EXISTS ────
    //
    // Asked as CONSEQUENTIAL: starting an autonomous run is not thinking, it is the act that leads
    // to every consequential act downstream. An unreadable stop state therefore REFUSES, which is
    // why this is wrapped and the error is a refusal rather than a throw.
    let stopped = null;
    try {
      stopped = await autonomy.checkStopped(
        { capability: 'office.initiate', company: o.companyId, workflow, agent },
        { consequential: true });
    } catch (e) {
      refused.push({ ...o, reason: SKIP.STOPPED,
        detail: `the kill-switch state could not be read (${e.message}) — failing closed` });
      continue;
    }
    if (stopped) {
      refused.push({ ...o, reason: SKIP.STOPPED,
        detail: `${stopped.scope_type}${stopped.scope_key ? `:${stopped.scope_key}` : ''}`
          + ` — ${stopped.reason}` });
      continue;
    }

    // An explicit BUSINESS-day slot. See the header: the default is a UTC day, and since B7.23 the
    // crons fire in Chicago, so two consecutive business days can share one UTC slot.
    const day = businessToday();
    const intentKey = `${objectiveIntentKey(workflow, o.objectiveId)}:bd=${day}`;

    let begun;
    try {
      begun = await run.beginObjectiveRun({
        objectiveId: o.objectiveId,
        trigger: 'schedule',
        triggerDetail: `${workflow} for business day ${day}`,
        workflow, agent, intentKey,
      }, deps.runDeps || deps);
    } catch (e) {
      refused.push({ ...o, reason: 'run_not_created', detail: e.message });
      continue;
    }

    if (begun && begun.duplicate) {
      // Counted, not swallowed. A scheduler firing twice a minute is idempotent AND broken, and
      // only the count makes the second half visible.
      duplicates.push({ ...o, intentKey: begun.intentKey, businessDay: day });
      continue;
    }
    initiated.push({ ...o, runId: begun.runId, intentKey, businessDay: day,
      // The context is handed back so a caller can drive the cycle with it. It is the context
      // `beginObjectiveRun` resolved FROM THE OBJECTIVE — this module never builds one.
      context: begun.context });
  }

  return { initiated, duplicates, skipped, refused, considered,
    businessDay: (deps.agentCore || require('../agent-core')).businessToday() };
}

module.exports = {
  initiateDueObjectives, eligibleObjectives,
  WORKFLOW, AUTHORIZED_TIER, SKIP,
};
