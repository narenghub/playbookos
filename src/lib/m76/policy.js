// ── THE POLICY ENGINE ───────────────────────────────────────────────────────
//
// Between a plan and a dispatch. It answers one question — may each of these steps be run at all,
// right now — and it answers it for the WHOLE plan: one refusal refuses everything.
//
// ── WHY ALL-OR-NOTHING ─────────────────────────────────────────────────────
//
// Dispatching the permitted subset of a plan looks helpful and is the thing to avoid. The plan was
// validated as a unit; a plan minus its third step is a different plan that nobody validated, and
// its partial output is the most misleading possible artifact — a report that looks complete and
// silently omits whatever policy declined. So a refusal is recorded against the plan, the plan is
// REFUSED, and nothing is enqueued.
//
// ── THE FOUR CHECKS, AND WHAT EACH IS FOR ──────────────────────────────────
//
//   1. closed vocabulary     the planner's own shape check, re-run here rather than trusted. The
//                            plan may have come from a model, a route, or a future scheduler.
//   2. declared task type    the type must exist in task-types.js. Dispatching an undeclared type
//                            would be refused at claim time anyway, but a policy engine that lets
//                            it through has not checked policy, it has relied on the next layer.
//   3. READ-ONLY ONLY        the pilot may not dispatch a type whose declaration says it writes.
//                            `proposal.draft_once` (readOnly: false) is therefore undispatchable
//                            here without a deliberate change to this file.
//   4. autonomy STOPs        the same `checkStopped` the worker's own heartbeat consults, so a
//                            STOP that halts execution also prevents dispatch. Asked at the
//                            capability AND the pilot's workflow scope.
//
// Check 3 is the one doing most of the work. It is a structural statement about the pilot: nothing
// it dispatches can change anything outside its own tables. Combined with the worker having no
// database handle, no mailer and no fetch wrapper, "the pilot cannot act on the business" is
// enforced in three independent places rather than asserted in a comment.

'use strict';

const TYPES = require('../worker/task-types');
const PLANNER = require('./planner');
const WORKER_SCHEMA = require('../worker/identity-schema');

/** The workflow scope this pilot dispatches under. A STOP on it halts the pilot and nothing else. */
const PILOT_WORKFLOW = 'm76-autonomous-office-pilot';

/**
 * @param {object} plan      a plan from planner.plan(), or any other source
 * @param {object} opts      { workerId } — the identity the steps would be dispatched for
 * @param {object} deps      { autonomy, query }
 * @returns {Promise<{ok: boolean, refusals: string[], checked: number}>}
 */
async function validatePlan(plan, { workerId = null } = {}, deps = {}) {
  const autonomy = deps.autonomy || require('../autonomy');
  const refusals = [];

  // 1. The shape, re-checked here rather than trusted.
  for (const p of PLANNER.validateShape(plan)) refusals.push(`shape: ${p}`);
  if (refusals.length) return { ok: false, refusals, checked: 0 };

  let checked = 0;
  for (const step of plan.steps) {
    checked += 1;

    // 2. Declared in the worker's own vocabulary.
    if (!TYPES.isKnown(step.taskType)) {
      refusals.push(`step ${step.stepId}: task type '${step.taskType}' is not declared`);
      continue;
    }
    // `definitionOf`, not a local copy of the flags: task-types.js is the single declaration and
    // a second list here would drift from it silently. (Written as `describe` first, which does
    // not exist — the fallback would have made `readOnly` null and refused every step. Caught
    // before it ran, but it is exactly why the test below asserts a VALID plan passes.)
    const decl = TYPES.definitionOf(step.taskType);

    // 3. READ-ONLY ONLY. Read from the declaration, never from a local list that could drift.
    const readOnly = decl ? decl.readOnly : null;
    if (readOnly !== true) {
      refusals.push(`step ${step.stepId}: task type '${step.taskType}' does not declare `
        + `readOnly:true (declares ${JSON.stringify(readOnly)}); the pilot dispatches read-only work only`);
    }
  }

  // 4. STOPs — capability first, then this pilot's workflow. Asked the way the worker asks.
  const capabilityStop = await autonomy.checkStopped(
    { agent: workerId || 'm76-pilot', capability: WORKER_SCHEMA.WORKER_CAPABILITY },
    { consequential: true, deps },
  );
  if (capabilityStop) {
    refusals.push(`stopped at ${capabilityStop.scope_type}:`
      + `${capabilityStop.scope_key || WORKER_SCHEMA.WORKER_CAPABILITY} — ${capabilityStop.reason}`);
  }
  const workflowStop = await autonomy.checkStopped(
    { agent: workerId || 'm76-pilot', workflow: PILOT_WORKFLOW },
    { consequential: true, deps },
  );
  if (workflowStop) {
    refusals.push(`stopped at ${workflowStop.scope_type}:${workflowStop.scope_key} — ${workflowStop.reason}`);
  }

  return { ok: refusals.length === 0, refusals, checked };
}

module.exports = { validatePlan, PILOT_WORKFLOW };
