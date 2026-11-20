// ── DISPATCH, VALIDATE, ASSEMBLE, ESCALATE ──────────────────────────────────
//
// The second half of the pilot. Everything here runs on the server, where the credentials,
// governance and audit already live; the worker only ever receives a payload.
//
// ── DISPATCH IS IDEMPOTENT BECAUSE THE DATABASE MAKES IT SO ────────────────
//
// `uq_worker_tasks_intent` is UNIQUE on `worker_tasks.intent_key`, and `enqueueTask` hands back
// the existing task for a key it has already seen. So re-dispatching a plan cannot create a second
// task — not because this function remembers, but because the constraint refuses. `m76_plan_steps`
// carries the same UNIQUE on its own `intent_key`, which is a second independent guarantee for the
// property idempotency depends on.
//
// ── A REPORT IS ASSEMBLED FROM AUTHORITATIVE ROWS, NOT FROM A CACHE ────────
//
// `collect()` reads `worker_results` and `agent_runs` — the rows the worker's own submission and
// the lease lifecycle wrote. It does not read `m76_plan_steps.state`, which is a cache of where
// the pipeline got to and could be stale or wrong. If the two ever disagree, the authoritative
// rows win and the cache is the thing that is broken.
//
// ── AND NOTHING IS ASSEMBLED FROM UNVALIDATED OUTPUT ───────────────────────
//
// `validateReportBody` re-checks the arithmetic the handler already checked. The handler
// validating its own output is the author checking their own working; the server is the party
// deciding whether a report may exist. A validation failure is NOT retried — the input is
// deterministic, so a retry produces the same answer — it escalates to a human.

'use strict';

const crypto = require('crypto');
const LEASES = require('../worker/leases');
const SCHEMA = require('./schema');
const POLICY = require('./policy');
const PLANNER = require('./planner');

const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('hex')}`;
const q = (deps) => (deps && deps.query) || require('../db').query;

// ── persistence ─────────────────────────────────────────────────────────────

async function recordGoal({ text, requestedBy = null }, deps = {}) {
  const query = q(deps);
  const goalId = newId('m76goal');
  await query(
    `INSERT INTO m76_goals (goal_id, text, requested_by) VALUES ($1, $2, $3)`,
    [goalId, String(text), requestedBy]);
  return { goalId };
}

/** A refused plan is PERSISTED. "We would not do that, and why" is the pilot's most useful record. */
async function recordPlan(plan, { state = 'PROPOSED', refusedReason = null }, deps = {}) {
  const query = q(deps);
  await query(
    `INSERT INTO m76_plans (plan_id, goal_id, planner, state, refused_reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (plan_id) DO UPDATE SET state = $4, refused_reason = $5`,
    [plan.planId, plan.goalId, plan.planner || 'unknown', state, refusedReason]);
  for (const s of plan.steps || []) {
    await query(
      `INSERT INTO m76_plan_steps
         (plan_id, step_id, ordinal, step_type, task_type, payload, intent_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (plan_id, step_id) DO NOTHING`,
      [plan.planId, s.stepId, s.ordinal, s.stepType, s.taskType,
        JSON.stringify(s.payload || {}), s.intentKey]);
    // The digest is NOT stored. It belongs to the validated plan object, and a digest kept in the
    // same row as the payload it protects would be rewritten by whatever rewrote the payload.
  }
  return { planId: plan.planId, state };
}

// ── dispatch ────────────────────────────────────────────────────────────────

/**
 * Enqueue every step of a VALIDATED plan. Refuses to dispatch a plan that policy has not passed —
 * the caller is expected to have run the policy engine, and this is the second lock on the door.
 */
async function dispatchPlan(plan, { workerId = null, validated = false } = {}, deps = {}) {
  if (!validated) {
    throw new Error('dispatchPlan requires a plan the policy engine has validated: dispatching an '
      + 'unvalidated plan is the one thing the policy engine exists to prevent');
  }
  const query = q(deps);
  // Injectable so idempotency, ordering and the unvalidated-plan refusal are testable without a
  // database. The real guarantee is `uq_worker_tasks_intent` and is proven against Postgres in
  // scripts/check-worker-leasing-db.js; this seam tests THIS function's logic, not the constraint.
  const leases = deps.leases || LEASES;
  const dispatched = [];
  for (const s of [...plan.steps].sort((a, b) => a.ordinal - b.ordinal)) {
    // ── THE PAYLOAD THAT RUNS IS THE PAYLOAD THAT WAS VALIDATED ───────────
    //
    // Read back from the PERSISTED row and re-digested. Dispatching `s.payload` from memory would
    // make this check circular — it would compare the plan against itself. Reading the row is what
    // makes an alteration between validation and dispatch detectable, whether it came from another
    // process, a concurrent operator, or a bug in recordPlan.
    //
    // The digest is over canonical JSON, because JSONB does not preserve key order and a raw
    // stringify comparison would report tampering on every round trip.
    const stored = await query(
      `SELECT payload FROM m76_plan_steps WHERE plan_id = $1 AND step_id = $2`,
      [plan.planId, s.stepId]);
    if (!stored.rows.length) {
      throw new Error(`step ${s.stepId}: no persisted row to dispatch — recordPlan did not run`);
    }
    const storedDigest = PLANNER.digestOf(stored.rows[0].payload);
    if (!s.payloadDigest || storedDigest !== s.payloadDigest) {
      throw new Error(`step ${s.stepId}: the persisted payload does not match the digest policy `
        + `validated (${s.payloadDigest ? s.payloadDigest.slice(0, 12) : 'none'} vs `
        + `${storedDigest.slice(0, 12)}). Nothing was dispatched.`);
    }

    const t = await leases.enqueueTask({
      taskType: s.taskType,
      payload: stored.rows[0].payload,
      intentKey: s.intentKey,
      workflow: POLICY.PILOT_WORKFLOW,
      createdBy: 'm76-pilot',
    }, deps);
    const taskId = t && (t.taskId || t.id);
    if (!taskId) {
      throw new Error(`step ${s.stepId}: enqueueTask returned no task id (${JSON.stringify(t).slice(0, 160)})`);
    }
    await query(
      `UPDATE m76_plan_steps SET task_id = $3, state = 'DISPATCHED'
        WHERE plan_id = $1 AND step_id = $2`, [plan.planId, s.stepId, taskId]);
    dispatched.push({ stepId: s.stepId, intentKey: s.intentKey, taskId, reused: Boolean(t && t.existing) });
  }
  await query(`UPDATE m76_plans SET state = 'DISPATCHED' WHERE plan_id = $1`, [plan.planId]);
  return { planId: plan.planId, dispatched };
}

// ── collection, from authoritative rows ─────────────────────────────────────

async function collect(plan, deps = {}) {
  const query = q(deps);
  const out = [];
  for (const s of [...plan.steps].sort((a, b) => a.ordinal - b.ordinal)) {
    const r = await query(
      `SELECT wr.status, wr.output, wr.worker_id, wr.run_id, wt.id AS task_id, wt.state AS task_state
         FROM worker_tasks wt
         LEFT JOIN worker_results wr ON wr.task_id = wt.id
        WHERE wt.intent_key = $1
        ORDER BY wr.submitted_at DESC NULLS LAST
        LIMIT 1`, [s.intentKey]);
    const row = r.rows[0] || null;
    const run = await query(
      `SELECT run_id, state, attempt FROM agent_runs
        WHERE intent_key = $1 ORDER BY started_at DESC LIMIT 1`, [s.intentKey]);
    out.push({
      stepId: s.stepId,
      stepType: s.stepType,
      taskType: s.taskType,
      intentKey: s.intentKey,
      taskId: row ? row.task_id : null,
      taskState: row ? row.task_state : null,
      status: row ? row.status : null,
      output: row ? row.output : null,
      workerId: row ? row.worker_id : null,
      runId: (run.rows[0] && run.rows[0].run_id) || (row && row.run_id) || null,
      runState: (run.rows[0] && run.rows[0].state) || null,
      attempt: (run.rows[0] && run.rows[0].attempt) || null,
    });
  }
  return out;
}

// ── BOUNDED RETRY ───────────────────────────────────────────────────────────
//
// `report.daily_operations` declares `reexecutable: true`, so an attempt whose worker died may be
// retried. "May" is not "for ever": without a cap, a step that fails for a reason retrying cannot
// fix becomes an infinite loop that looks like activity. Three attempts, then a human.
//
// This cap is the pilot's own policy and it sits ON TOP of the database's retry governance, which
// is stricter and cannot be reached around: `trg_agent_runs_retry_guard` still demands a recorded
// reason of at least 10 characters over an ABANDONED predecessor, and nothing here supplies one.
// A step whose predecessor was abandoned therefore needs a human regardless of this count.
const MAX_ATTEMPTS = 3;

/**
 * How many attempts has this step had, and may it have another?
 *
 * Counted from `agent_runs.attempt` — the authoritative record written by the lease lifecycle —
 * never from a counter the pilot keeps, which could disagree with reality.
 */
async function attemptsFor(intentKey, deps = {}) {
  const query = q(deps);
  const r = await query(
    `SELECT COALESCE(MAX(attempt), 0)::int AS attempts, COUNT(*)::int AS runs
       FROM agent_runs WHERE intent_key = $1`, [intentKey]);
  return { attempts: Number(r.rows[0].attempts), runs: Number(r.rows[0].runs) };
}

/**
 * @returns {{ok: true}} | {{ok: false, reason: string, detail: string}}
 */
async function mayRetry(step, deps = {}) {
  const TYPES = require('../worker/task-types');
  if (!TYPES.isReexecutable(step.taskType)) {
    return { ok: false, reason: 'not_reexecutable',
      detail: `${step.taskType} declares reexecutable:false; repeating it is not safe` };
  }
  const { attempts } = await attemptsFor(step.intentKey, deps);
  if (attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: 'retry_cap_exceeded',
      detail: `${attempts} attempt(s) already made; the pilot cap is ${MAX_ATTEMPTS}` };
  }
  return { ok: true, attempts };
}

// ── independent validation of the report body ───────────────────────────────

const KINDS = require('../../worker-client/handlers/report-daily-operations').KINDS;
const STATUSES = require('../../worker-client/handlers/report-daily-operations').STATUSES;

/**
 * Re-checks shape AND arithmetic, server-side, without trusting the worker's own validateOutput.
 *
 * @param {object} body     the submitted output
 * @param {object} expected { asOf, factCount }
 * @returns {string[]} problems; empty means it may be filed
 */
function validateReportBody(body, { asOf, factCount } = {}) {
  const problems = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['the report body is not an object'];
  if (body.asOf !== asOf) problems.push(`asOf is '${body.asOf}', expected '${asOf}'`);
  if (Number.isInteger(factCount) && body.factCount !== factCount) {
    problems.push(`factCount is ${body.factCount}, expected ${factCount}`);
  }
  if (!Array.isArray(body.sections) || body.sections.length !== KINDS.length) {
    problems.push(`sections must cover all ${KINDS.length} kinds`);
    return problems;
  }
  let summed = 0;
  let blocked = 0;
  for (const s of body.sections) {
    if (!KINDS.includes(s && s.kind)) { problems.push(`unknown section kind '${s && s.kind}'`); continue; }
    if (!Number.isInteger(s.count) || s.count < 0) {
      problems.push(`section ${s.kind}: count is not a non-negative integer`); continue;
    }
    const st = s.byStatus || {};
    const sum = STATUSES.reduce((n, k) => n + (Number(st[k]) || 0), 0);
    if (sum !== s.count) problems.push(`section ${s.kind}: statuses sum to ${sum}, count is ${s.count}`);
    summed += s.count;
    blocked += Number(st.blocked) || 0;
  }
  if (summed !== body.factCount) {
    problems.push(`sections sum to ${summed} but factCount is ${body.factCount}`);
  }
  if (!body.totals || typeof body.totals !== 'object') {
    problems.push('totals is missing');
  } else {
    if (body.totals.count !== summed) {
      problems.push(`totals.count is ${body.totals.count} but sections sum to ${summed}`);
    }
    if (body.totals.blocked !== blocked) {
      problems.push(`totals.blocked is ${body.totals.blocked} but sections report ${blocked}`);
    }
  }
  return problems;
}

// ── assembly, or escalation ─────────────────────────────────────────────────

/**
 * Assemble the report, or refuse and say exactly why.
 *
 * Refuses when any step did not succeed, or when the report body does not validate. There is no
 * partial report: a summary that silently omits a step is the most misleading artifact this
 * pipeline could produce.
 */
async function assemble(plan, { expectedFactCount = null } = {}, deps = {}) {
  const query = q(deps);
  const steps = await collect(plan, deps);

  const unfinished = steps.filter((s) => s.status !== 'SUCCEEDED');
  if (unfinished.length) {
    return {
      ok: false,
      reason: 'steps_not_succeeded',
      detail: unfinished.map((s) => `${s.stepId} (${s.stepType}): `
        + `status=${s.status || 'none'} task=${s.taskState || 'unknown'} run=${s.runState || 'unknown'}`),
      steps,
    };
  }

  const reportStep = steps.find((s) => s.taskType === 'report.daily_operations');
  if (!reportStep) {
    return { ok: false, reason: 'no_report_step', detail: ['the plan produced no report step'], steps };
  }

  const problems = validateReportBody(reportStep.output, {
    asOf: plan.asOf,
    factCount: Number.isInteger(expectedFactCount) ? expectedFactCount : undefined,
  });
  if (problems.length) {
    return { ok: false, reason: 'report_failed_validation', detail: problems, steps };
  }

  // The evidence is the point: every id a reader needs to check this without trusting it.
  const evidence = {
    planId: plan.planId,
    goalId: plan.goalId,
    planner: plan.planner,
    asOf: plan.asOf,
    seed: plan.seed,
    steps: steps.map((s) => ({
      stepId: s.stepId, stepType: s.stepType, taskType: s.taskType,
      intentKey: s.intentKey, taskId: s.taskId, runId: s.runId, workerId: s.workerId,
      attempt: s.attempt,
    })),
  };
  const auditCount = await query(
    `SELECT COUNT(*)::int n FROM worker_audit WHERE run_id = ANY($1)`,
    [steps.map((s) => s.runId).filter(Boolean)]);
  evidence.auditRows = Number(auditCount.rows[0].n);

  const reportId = newId('m76rep');
  await query(
    `INSERT INTO m76_reports (report_id, plan_id, as_of, body, evidence)
     VALUES ($1, $2, $3, $4, $5)`,
    [reportId, plan.planId, plan.asOf, JSON.stringify(reportStep.output), JSON.stringify(evidence)]);
  await query(`UPDATE m76_plans SET state = 'COMPLETED' WHERE plan_id = $1`, [plan.planId]);
  await query(`UPDATE m76_goals SET state = 'REPORTED' WHERE goal_id = $1`, [plan.goalId]);

  return { ok: true, reportId, body: reportStep.output, evidence, steps };
}

/**
 * A decision-queue item for a plan that needs a person.
 *
 * `decision-queue.js` takes INJECTED sources — `{ name, run }` — so the pilot plugs in without
 * that module being modified at all, and without adding a kind to its frozen KINDS allowlist.
 */
function escalationItem(plan, failure) {
  return {
    id: `m76:${plan.planId}`,
    kind: 'escalation',
    source: 'm76_plans',
    title: `M7.6 pilot plan ${plan.planId} needs a decision: ${failure.reason}`,
    detail: (failure.detail || []).join('; ').slice(0, 500),
    where: { page: 'Agent Control', anchor: `m76-${plan.planId}` },
  };
}

async function escalate(plan, failure, deps = {}) {
  const query = q(deps);
  await query(
    `UPDATE m76_plans SET state = 'ESCALATED', refused_reason = $2 WHERE plan_id = $1`,
    [plan.planId, `${failure.reason}: ${(failure.detail || []).join('; ')}`.slice(0, 500)]);
  return { escalated: true, item: escalationItem(plan, failure) };
}

/** The source object `decision-queue.collect()` accepts. Read-only. */
function decisionSource(deps = {}) {
  return {
    name: 'm76_plans',
    run: async () => {
      const query = q(deps);
      const r = await query(
        `SELECT plan_id, refused_reason FROM m76_plans WHERE state = 'ESCALATED'
          ORDER BY created_at DESC LIMIT 50`);
      return r.rows.map((row) => ({
        id: `m76:${row.plan_id}`,
        kind: 'escalation',
        source: 'm76_plans',
        title: `M7.6 pilot plan ${row.plan_id} needs a decision`,
        detail: String(row.refused_reason || '').slice(0, 500),
        where: { page: 'Agent Control', anchor: `m76-${row.plan_id}` },
      }));
    },
  };
}

module.exports = {
  recordGoal, recordPlan, dispatchPlan, collect, validateReportBody, assemble,
  escalate, escalationItem, decisionSource, attemptsFor, mayRetry,
  MAX_ATTEMPTS, SCHEMA,
};
