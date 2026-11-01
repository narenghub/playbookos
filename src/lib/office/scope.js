// PlayNexa AI Office — the ONLY module that names kernel tables in SQL.
//
// WHY THIS FILE EXISTS, STATED HONESTLY.
// Composite foreign keys (src/lib/office/schema.js) make cross-company WRITES a referential
// impossibility: the database refuses them, whoever is connected and whatever they forgot. Keys
// do not scope READS. Two of the required proofs are read proofs — "company-scoped reads do not
// return the other company's rows" and "changing a route/query parameter cannot cross the
// boundary" — and no foreign key can discharge either.
//
// The ruling set the bar for the read side:
//   "If the proposed enforcement only works because every developer remembers to write
//    WHERE company_id = ?, K1 is not complete."
//
// So callers never write that predicate: they cannot, because they do not have the table names.
// Every read below composes its own scope from a context resolved by context.js. The predicate
// is in one file, reviewed once, and `scripts/check-office-scope-discipline.js` FAILS if a
// kernel table name appears in SQL anywhere else — which is the difference between "every
// developer remembers" and "a check fails if they don't".
//
// THE ASYMMETRY IS REAL AND IS NOT PAPERED OVER. The write side is enforced by the engine. The
// read side is enforced by a static repository check: it can be defeated by dynamic SQL, and it
// protects this repository rather than the database. Read-side enforcement IN the database needs
// row-level security, which needs a non-superuser application role, which is an infrastructure
// decision and not mine to take. Recorded as a residual risk.
//
// Every function here takes a resolved, frozen context and derives the company from it. None of
// them accepts a company argument — see context.js for why that is structural rather than
// defensive.

const { assertContext } = require('./context');

function lazyQuery() {
  return require('../db').query;
}

function q(deps) {
  return (deps && deps.query) || lazyQuery();
}

// ---------------------------------------------------------------------------------------------
// THE ONE DELIBERATELY UNSCOPED READ.
//
// Every other function in this file scopes by the context's company. This one cannot, and the
// reason is structural rather than an oversight: it is the BOOTSTRAP that derives the company in
// the first place. At the moment it runs there is no company context yet — the company is what
// it returns. A company predicate here would have to come from the caller, which is precisely
// the thing company context exists to refuse.
//
// It lives HERE, in the accessor, rather than in context.js where it is used, for one reason:
// this file owns every kernel table name, so `check-office-scope-discipline.js` needs no
// exemption for context.js. An exemption would have made every future query in that file
// unscoped and unreviewed — and this function is then the single unscoped read a reviewer has to
// look at, in the file where they are already looking for exactly that.
//
// It returns the objective's own company_id and never takes one. The caller cannot ask for a
// different company's objective because the caller cannot express a company.
// ---------------------------------------------------------------------------------------------

async function bootstrapObjectiveForContext(objectiveId, deps = {}) {
  const res = await q(deps)(
    `SELECT id, company_id, status, autonomy_tier, approval_policy, budget_usd
       FROM objectives WHERE id = $1`,
    [objectiveId]
  );
  return res.rows[0] || null;
}

// ---------------------------------------------------------------------------------------------
// Reads. Each one is scoped by the context's company and by nothing the caller passed.
// ---------------------------------------------------------------------------------------------

async function listObjectives(ctx, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `SELECT id, objective, priority, kpi_metric, kpi_target, deadline, budget_usd,
            autonomy_tier, approval_policy, status, created_by, created_at
       FROM objectives
      WHERE company_id = $1
      ORDER BY priority, created_at DESC`,
    [ctx.companyId]
  );
  return res.rows;
}

// Deliberately takes the objective id as an argument AND still scopes by company. A caller who
// substitutes another company's objective id — the "changing a query parameter" attack — gets
// zero rows rather than that company's objective.
async function getObjective(ctx, objectiveId, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `SELECT id, objective, priority, status, autonomy_tier, approval_policy, budget_usd, company_id
       FROM objectives
      WHERE company_id = $1 AND id = $2`,
    [ctx.companyId, objectiveId]
  );
  return res.rows[0] || null;
}

async function listOpenExceptions(ctx, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `SELECT id, run_id, objective_id, source, reason, severity, status, owner_user_id,
            created_at, sla_hours,
            EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0 AS age_hours,
            (sla_hours IS NOT NULL
               AND NOW() - created_at > (sla_hours || ' hours')::interval) AS sla_breached
       FROM office_exceptions
      WHERE company_id = $1 AND status IN ('open','acknowledged')
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        created_at`,
    [ctx.companyId]
  );
  return res.rows;
}

async function listPendingApprovals(ctx, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `SELECT id, run_id, objective_id, action_kind, action_payload, owner_user_id, reason,
            created_at, acknowledged_at,
            EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0 AS age_hours
       FROM office_approvals
      WHERE company_id = $1 AND status = 'pending'
      ORDER BY created_at`,
    [ctx.companyId]
  );
  return res.rows;
}

// Spend for the company's current UTC day. The $100/day cap is NOT enforced here — K5 budget
// refusal is a separate authorization and its production activation requires a ruling. This is
// the measurement the cap will later read.
async function spendToday(ctx, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd, COUNT(*)::int AS calls
       FROM office_cost_ledger
      WHERE company_id = $1 AND at >= date_trunc('day', NOW())`,
    [ctx.companyId]
  );
  return res.rows[0];
}

async function listOutcomes(ctx, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `SELECT id, run_id, objective_id, outcome, business_effect, effect_ref, at
       FROM office_outcomes
      WHERE company_id = $1
      ORDER BY at DESC`,
    [ctx.companyId]
  );
  return res.rows;
}

// ---------------------------------------------------------------------------------------------
// Writes. The company comes off the context; the composite FK then refuses any row whose
// (run_id, company_id) pair is not a real execution of that company. The guard is the database's,
// not this file's — this file only declines to hand it the wrong thing.
// ---------------------------------------------------------------------------------------------

async function recordCost(ctx, { runId, provider, model, tokensInput, tokensOutput, costUsd }, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `INSERT INTO office_cost_ledger
       (company_id, run_id, objective_id, provider, model, tokens_input, tokens_output, cost_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.companyId, runId, ctx.objectiveId || null, provider, model,
     tokensInput ?? null, tokensOutput ?? null, costUsd]
  );
  return res.rows[0];
}

async function openException(ctx, { id, runId, source, reason, severity, ownerUserId, slaHours }, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `INSERT INTO office_exceptions
       (id, company_id, run_id, objective_id, source, reason, severity, owner_user_id, sla_hours)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, status, created_at`,
    [id, ctx.companyId, runId, ctx.objectiveId || null, source, reason, severity,
     ownerUserId ?? null, slaHours ?? null]
  );
  return res.rows[0];
}

// Resolution is scoped by company as well as by id, so one company cannot close another's
// exception by guessing its id. The UPDATE matching zero rows is the refusal.
async function resolveException(ctx, { id, resolvedBy, resolution }, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `UPDATE office_exceptions
        SET status = 'resolved', resolved_at = NOW(), resolved_by = $3, resolution = $4
      WHERE company_id = $1 AND id = $2 AND status IN ('open','acknowledged')
      RETURNING id, status`,
    [ctx.companyId, id, resolvedBy, resolution]
  );
  return res.rows[0] || null;
}

async function requestApproval(ctx, { id, runId, actionKind, actionPayload, reason, ownerUserId }, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `INSERT INTO office_approvals
       (id, company_id, run_id, objective_id, action_kind, action_payload, reason, owner_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, status, created_at`,
    [id, ctx.companyId, runId, ctx.objectiveId || null, actionKind,
     JSON.stringify(actionPayload ?? {}), reason, ownerUserId ?? null]
  );
  return res.rows[0];
}

async function decideApproval(ctx, { id, decision, resolvedBy }, deps = {}) {
  assertContext(ctx);
  if (!['approved', 'rejected'].includes(decision)) throw new Error(`bad approval decision: ${decision}`);
  const res = await q(deps)(
    `UPDATE office_approvals
        SET status = $3, resolved_at = NOW(), resolved_by = $4
      WHERE company_id = $1 AND id = $2 AND status = 'pending'
      RETURNING id, status`,
    [ctx.companyId, id, decision, resolvedBy]
  );
  return res.rows[0] || null;
}

async function recordOutcome(ctx, { id, runId, outcome, businessEffect, effectRef }, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `INSERT INTO office_outcomes
       (id, company_id, run_id, objective_id, outcome, business_effect, effect_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, outcome, at`,
    [id, ctx.companyId, runId, ctx.objectiveId || null, outcome,
     businessEffect ?? null, effectRef ?? null]
  );
  return res.rows[0];
}

module.exports = {
  bootstrapObjectiveForContext,
  listObjectives, getObjective, listOpenExceptions, listPendingApprovals, spendToday, listOutcomes,
  recordCost, openException, resolveException, requestApproval, decideApproval, recordOutcome,
};
