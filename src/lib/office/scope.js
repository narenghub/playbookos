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

// ---------------------------------------------------------------------------------------------
// THE SECOND AND THIRD DELIBERATELY UNSCOPED READS, AND WHY THEY ARE HERE TOO
//
// R1's executor and reconciler both start from an APPROVAL ID and nothing else. Like
// bootstrapObjectiveForContext above, at the moment they run there is no company context yet —
// the company is what the read returns. A company predicate would have to come from the caller,
// which is the thing company context exists to refuse.
//
// They live in this file for the same reason: it owns every kernel table name, so the
// scope-discipline check needs no exemption for execute.js or reconcile.js. An exemption there
// would make every future query in the office's only outbound module unscoped and unreviewed —
// which is the last place to relax that rule.
//
// Neither takes a company, so neither caller can ask for another company's approval.
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// THE FOURTH DELIBERATELY UNSCOPED READ, AND WHY IT MUST BE UNSCOPED
//
// "What has already been prepared for this RFQ?" is a question about PRIMARY KEY collisions and
// about live authorizations, and office_approvals.id is global rather than per company. So a
// company predicate here would be worse than useless: it could report a pair as available while
// the insert still collides with another company's row. The truthful answer to a global-uniqueness
// question is a global read.
//
// It returns release_claimed_at and released_at because the states are not interchangeable. A
// REJECTED attempt is dead and must not block a corrected re-preparation — that is the whole
// point of separating a stable business intent from one preparation attempt. An APPROVED and
// unreleased attempt is a live authorization, and a CLAIMED one has already reached the outside
// world. Only the last two may block.
//
// It returns only what an eligibility listing needs — id, status, the payload's supplier and the
// resolution — never the frozen payload itself, so this cannot become a route to reading another
// company's prepared communication.
// ---------------------------------------------------------------------------------------------

/**
 * Approvals that already exist for an RFQ, for deciding whether a supplier pair can be prepared
 * again. UNSCOPED BY DESIGN: see the note above. Read-only.
 */
async function rfqApprovalsForEligibility(rfqId, deps = {}) {
  const query = (deps && deps.query) || require('../db').query;
  return (await query(
    `SELECT id, status, action_payload->>'supplier_id' AS supplier_id, resolution, created_at,
            release_claimed_at, released_at
       FROM office_approvals
      WHERE action_kind = 'send_rfq_email'
        AND action_payload->>'rfq_id' = $1
      ORDER BY created_at`, [rfqId])).rows;
}

/** Everything the executor needs to decide whether an approved action may be carried out. */
async function bootstrapApprovalForExecution(approvalId, deps = {}) {
  const res = await q(deps)(
    `SELECT a.id, a.company_id, a.objective_id, a.run_id, a.action_kind, a.action_payload,
            a.status, a.release_claimed_at, a.released_at, a.resolved_by, a.resolved_at,
            a.resolution, a.previous_status, a.superseded_at, a.superseded_by, a.superseded_reason,
            o.budget_usd, o.release_mode, o.status AS objective_status
       FROM office_approvals a
       JOIN objectives o ON o.id = a.objective_id AND o.company_id = a.company_id
      WHERE a.id = $1`, [approvalId]);
  return res.rows[0] || null;
}

/** Which company authorized an external attempt, so an unresolved claim can be attributed. */
async function bootstrapApprovalOwner(approvalId, deps = {}) {
  if (!approvalId) return null;
  const res = await q(deps)(
    `SELECT id AS approval_id, company_id, objective_id, run_id
       FROM office_approvals WHERE id = $1`, [approvalId]);
  return res.rows[0] || null;
}

async function bootstrapObjectiveForContext(objectiveId, deps = {}) {
  const res = await q(deps)(
    `SELECT id, company_id, status, autonomy_tier, approval_policy, budget_usd
       FROM objectives WHERE id = $1`,
    [objectiveId]
  );
  return res.rows[0] || null;
}

// ---------------------------------------------------------------------------------------------
// K2 — CEO AUTHORITY. The one place a company is CHOSEN rather than derived.
//
// Everything else in this file derives the company from a resolved context, because an AGENT may
// not choose which company it acts for. The CEO may: picking the company is the substance of
// setting an objective. So createObjective takes a companyId explicitly, and that is not a
// loophole in the context rule — it is the human authority the context rule exists to protect.
//
// The distinction is enforced by shape rather than by trust: this function takes no context, and
// every function that takes a context has no company parameter. Neither can impersonate the
// other. Agent-reachable code paths go through resolveObjectiveContext, which reads the company
// off the stored objective and cannot be told one.
//
// An objective is created 'draft'. It grants no execution context until it is activated —
// resolveObjectiveContext refuses anything that is not 'active' — so creating an objective is
// never itself an authorization to execute.
// ---------------------------------------------------------------------------------------------

async function createObjective(spec, deps = {}) {
  const {
    id, companyId, objective, priority, kpiMetric = null, kpiTarget = null,
    deadline = null, budgetUsd = null, autonomyTier, approvalPolicy, createdBy,
  } = spec;
  if (!companyId) throw new Error('createObjective requires a companyId: an objective with no company cannot be executed');
  if (!createdBy) throw new Error('createObjective requires createdBy: an objective with no author has no authority behind it');

  const res = await q(deps)(
    `INSERT INTO objectives
       (id, company_id, objective, priority, kpi_metric, kpi_target, deadline, budget_usd,
        autonomy_tier, approval_policy, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11)
     RETURNING id, company_id, status, autonomy_tier, approval_policy, budget_usd, created_at`,
    [id, companyId, objective, priority, kpiMetric, kpiTarget, deadline, budgetUsd,
     autonomyTier, approvalPolicy, createdBy]
  );
  return res.rows[0];
}

// Activation is the CEO's separate, deliberate act — the moment an objective becomes executable.
// Scoped by company as well as by id so one company's activation cannot reach another's row.
async function setObjectiveStatus(ctx, { id, status }, deps = {}) {
  assertContext(ctx);
  if (!['draft', 'active', 'paused', 'met', 'missed', 'cancelled'].includes(status)) {
    throw new Error(`bad objective status: ${status}`);
  }
  const res = await q(deps)(
    `UPDATE objectives SET status = $3, updated_at = NOW()
      WHERE company_id = $1 AND id = $2
      RETURNING id, status, company_id`,
    [ctx.companyId, id, status]
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
    `SELECT id, objective, priority, status, autonomy_tier, approval_policy, budget_usd, company_id,
            kpi_metric, kpi_target, release_mode, deadline
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
// Spend for the company's current UTC day, with UNMEASURED CALLS COUNTED SEPARATELY rather than
// summed as zero. A budget that reads only `usd` would under-report by exactly the amount it could
// not see, so `unknown_calls` travels with it and K5's refusal surface must consult both.
async function spendToday(ctx, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `SELECT COALESCE(SUM(cost_usd) FILTER (WHERE cost_known), 0)::float8 AS usd,
            COUNT(*)::int AS calls,
            COUNT(*) FILTER (WHERE NOT cost_known)::int AS unknown_calls
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

// costKnown is REQUIRED, not inferred from costUsd being null — an inferred flag can be silently
// wrong in exactly the direction that matters (a caller that forgot to pass a cost would file it as
// "known to be nothing"). The database CHECK enforces that the pair is coherent either way.
async function recordCost(ctx, { runId, provider, model, tokensInput, tokensOutput,
  costUsd, costKnown, agent = null, workflow = null }, deps = {}) {
  assertContext(ctx);
  if (typeof costKnown !== 'boolean') {
    throw new Error('recordCost requires an explicit costKnown: an unmeasured call must not be filed as free');
  }
  const res = await q(deps)(
    `INSERT INTO office_cost_ledger
       (company_id, run_id, objective_id, provider, model, tokens_input, tokens_output,
        cost_usd, cost_known, agent, workflow)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, cost_known`,
    [ctx.companyId, runId, ctx.objectiveId || null, provider, model,
     tokensInput ?? null, tokensOutput ?? null,
     costKnown ? costUsd : null, costKnown, agent, workflow]
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

// ── SUPERSESSION: THE ONE NEW TRANSITION, AND NOTHING WIDER ─────────────────
//
//   approved + NEVER EXTERNALLY CLAIMED  →  superseded
//
// Deliberately NOT a change to decideApproval, and deliberately not a generic setApprovalStatus.
// decideApproval owns the human verdict — pending → approved or pending → rejected — and the fact
// that neither can afterwards be changed through it is a property worth keeping. Widening its
// predicate to admit this transition would have bought one correction at the cost of making every
// decided approval re-decidable.
//
// ── WHY THE CLAIM TABLE IS IN THE PREDICATE ───────────────────────────────
//
//   "Once external execution has been claimed, approval supersession is too late."
//
// release_claimed_at being NULL is the control plane's belief about that. supplier_outreach_log is
// where the external attempt is actually recorded, and it is written by a different code path at a
// different moment — the claim is taken BEFORE the mailer, precisely so a crash between them is
// visible. So both are required, and the stronger source is included rather than assumed to agree:
// if a claim row exists for this approval, or for its (rfq, supplier) pair, the outside world may
// already have been reached and the question of whether to supersede is moot.
//
// ONE STATEMENT, so there is no window between checking and acting. A caller that read the status
// first and then updated could be overtaken by a release in between — which is the one ordering
// that must never be possible here.
//
// Returns the row on success, or null. The caller says precisely why nothing happened; this
// function does not guess, because "no rows matched" has several causes and they are not alike.
async function supersedeApproval(ctx, { approvalId, supersededBy, reason }, deps = {}) {
  assertContext(ctx);
  if (!approvalId) throw new Error('supersedeApproval requires an approvalId');
  if (!supersededBy) throw new Error('supersedeApproval requires an actor: a supersession with no author is not evidence');
  if (!reason || String(reason).trim().length < 12) {
    throw new Error('supersedeApproval requires a durable reason: a terminal status nobody can account for later is worth little more than no record');
  }
  const res = await q(deps)(
    `UPDATE office_approvals a
        SET status = 'superseded',
            previous_status = a.status,
            superseded_at = NOW(),
            superseded_by = $3,
            superseded_reason = $4
      WHERE a.company_id = $1
        AND a.id = $2
        AND a.status = 'approved'
        AND a.release_claimed_at IS NULL
        AND a.released_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM supplier_outreach_log s
           WHERE s.approval_id = a.id
              OR (s.rfq_id = a.action_payload->>'rfq_id'
                  AND s.supplier_id = a.action_payload->>'supplier_id'))
      RETURNING id, status, previous_status, superseded_at, superseded_by, superseded_reason,
                resolution, resolved_by, resolved_at`,
    [ctx.companyId, approvalId, supersededBy, String(reason).trim()]
  );
  return res.rows[0] || null;
}

async function decideApproval(ctx, { id, decision, resolvedBy, resolution = null }, deps = {}) {
  assertContext(ctx);
  if (!['approved', 'rejected'].includes(decision)) throw new Error(`bad approval decision: ${decision}`);
  // `resolution` is WHY the human decided as they did, stored beside the verdict. Optional at this
  // layer so existing callers are unaffected; the operator-facing script requires it, because a
  // decision nobody can account for later is worth little more than no decision.
  //
  // Still arbitrated on status = 'pending': the WHERE clause is what makes a second decision
  // impossible, rather than a prior SELECT the caller is trusted to have done.
  const res = await q(deps)(
    `UPDATE office_approvals
        SET status = $3, resolved_at = NOW(), resolved_by = $4, resolution = COALESCE($5, resolution)
      WHERE company_id = $1 AND id = $2 AND status = 'pending'
      RETURNING id, status, resolution`,
    [ctx.companyId, id, decision, resolvedBy, resolution]
  );
  return res.rows[0] || null;
}

// K7 release, arbitrated. Lives here because this file owns every kernel table name — and because
// the scope-discipline check correctly refused to exempt approval.js: it is product code, and
// product code may never hold a kernel predicate at the call site.
//
// The claim and the read are ONE statement. A SELECT-then-UPDATE would let two concurrent releases
// both see 'approved' and both act, which is one human decision authorising two consequential
// sends. `released_at IS NULL` is what makes a second release impossible.
// ── WHAT THIS CLAIM MEANS, EXACTLY (ruling §2) ────────────────────────────────
//
// It means: THE EXECUTOR HAS DURABLY TAKEN RESPONSIBILITY FOR ATTEMPTING THIS EXTERNAL ACTION.
//
// It does NOT mean the supplier received anything. It runs before the supplier claim and before
// the mailer, so treating it as proof of delivery is how a durable record comes to lie — which is
// the ambiguity ruling §2 required removing.
//
// `release_claimed_at` carries that meaning in its name. `released_at` is kept in step with it for
// the existing checks and predicates that reference it, and means the same narrow thing.
//
// Arbitrated: the WHERE clause decides, so two concurrent executors cannot both claim. A
// SELECT-then-UPDATE would leave exactly the window this exists to close.
async function claimApprovalRelease(ctx, { approvalId, releasedBy }, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `UPDATE office_approvals
        SET release_claimed_at = NOW(), release_claimed_by = $3,
            released_at = NOW(), released_by = $3
      WHERE company_id = $1 AND id = $2
        AND status = 'approved'
        AND release_claimed_at IS NULL
        AND released_at IS NULL
      RETURNING id, action_kind, action_payload, resolved_by, resolved_at,
                release_claimed_at, release_claimed_by`,
    [ctx.companyId, approvalId, releasedBy]
  );
  return res.rows[0] || null;
}

// Why a release did not happen. 'not_approved' and 'already_released' call for very different
// operator responses, so they are distinguished rather than collapsed into a single failure.
async function approvalReleaseState(ctx, approvalId, deps = {}) {
  assertContext(ctx);
  // action_payload is returned so the release path can REVALIDATE the authority the frozen
  // communication asserts — specifically whether its signatory is still active — without
  // re-deriving or rewriting any of it.
  const res = await q(deps)(
    `SELECT status, released_at, released_by, release_claimed_at, release_claimed_by,
            resolved_at, resolved_by, action_payload, objective_id, run_id FROM office_approvals
      WHERE company_id = $1 AND id = $2`,
    [ctx.companyId, approvalId]
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

// Objective-level spend, measured and unmeasured, for the whole life of the objective. The
// enterprise cap is per DAY; an objective's budget is a TOTAL — a $10 objective that has spent
// $10 is finished whether that happened today or last week.
async function spendForObjective(ctx, objectiveId, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `SELECT COALESCE(SUM(cost_usd) FILTER (WHERE cost_known), 0)::float8 AS usd,
            COUNT(*)::int AS calls,
            COUNT(*) FILTER (WHERE NOT cost_known)::int AS unknown_calls
       FROM office_cost_ledger
      WHERE company_id = $1 AND objective_id = $2`,
    [ctx.companyId, objectiveId]
  );
  return res.rows[0];
}

// Unmeasured AI spend attributable to ONE run. The fail-closed release gate reads this: a
// consequential action must not be released on the back of a call whose cost nobody knows.
async function unmeasuredForRun(ctx, runId, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `SELECT COUNT(*) FILTER (WHERE NOT cost_known)::int AS unknown_calls,
            COUNT(*)::int AS calls
       FROM office_cost_ledger
      WHERE company_id = $1 AND run_id = $2`,
    [ctx.companyId, runId]
  );
  return res.rows[0];
}

// ── K9: PROVENANCE FOR ONE GOVERNED RUN ─────────────────────────────────────
//
// Answers, from durable evidence only:
//
//   "Which CEO objective caused this supplier action, what did the AI do, what did it cost,
//    who approved it, and what happened?"
//
// Company-scoped like every other read, and it RETROFITS NOTHING: it reports what a governed run
// recorded. A pre-K9 row has no objective and will simply return nothing, which is the correct
// answer rather than an inferred one.
async function provenance(ctx, runId, deps = {}) {
  assertContext(ctx);
  const query = q(deps);

  const run = (await query(
    `SELECT r.run_id, r.state, r.workflow, r.agent, r.trigger, r.attempt,
            r.created_at, r.started_at, r.ended_at,
            o.id AS objective_id, o.objective, o.priority, o.kpi_metric, o.kpi_target,
            o.deadline, o.budget_usd, o.autonomy_tier, o.approval_policy, o.created_by
       FROM agent_runs r
       JOIN objectives o ON o.id = r.objective_id AND o.company_id = r.company_id
      WHERE r.company_id = $1 AND r.run_id = $2`,
    [ctx.companyId, runId]
  )).rows[0];
  if (!run) return null;

  const ai = (await query(
    `SELECT provider, model, agent, workflow, tokens_input, tokens_output,
            cost_usd, cost_known, at
       FROM office_cost_ledger
      WHERE company_id = $1 AND run_id = $2 ORDER BY at`,
    [ctx.companyId, runId]
  )).rows;

  // External human representation is part of business provenance (ruling §13): who the supplier
  // would reply to, and who decided, are projected out of the frozen payload rather than
  // re-resolved — re-resolving would answer "who holds the role now", not "who did this letter
  // claim to be from".
  const approvals = (await query(
    `SELECT id, action_kind, status, reason, resolution, owner_user_id, created_at,
            resolved_by, resolved_at, released_at, released_by,
            action_payload ->> 'signed_by_name'    AS signed_by_name,
            action_payload ->> 'signed_by_title'   AS signed_by_title,
            action_payload ->> 'signed_by_email'   AS signed_by_email,
            action_payload ->> 'signed_by_user_id' AS signed_by_user_id,
            action_payload ->> 'identity_decision_id' AS identity_decision_id
       FROM office_approvals
      WHERE company_id = $1 AND run_id = $2 ORDER BY created_at`,
    [ctx.companyId, runId]
  )).rows;

  const outcomes = (await query(
    `SELECT id, outcome, business_effect, effect_ref, at
       FROM office_outcomes
      WHERE company_id = $1 AND run_id = $2 ORDER BY at`,
    [ctx.companyId, runId]
  )).rows;

  const exceptions = (await query(
    `SELECT id, source, reason, severity, status, created_at, resolved_at, resolution
       FROM office_exceptions
      WHERE company_id = $1 AND run_id = $2 ORDER BY created_at`,
    [ctx.companyId, runId]
  )).rows;

  // Measured AI spend is reported as a LOWER BOUND whenever any call was unmeasured. Summing
  // unknown costs as zero here would be the same defect as costOf() returning 0.
  const measured = ai.filter((a) => a.cost_known);
  const unmeasured = ai.length - measured.length;

  return {
    objective: {
      id: run.objective_id, objective: run.objective, priority: run.priority,
      kpi_metric: run.kpi_metric, kpi_target: run.kpi_target, deadline: run.deadline,
      budget_usd: run.budget_usd, autonomy_tier: run.autonomy_tier,
      approval_policy: run.approval_policy, created_by: run.created_by,
    },
    run: {
      run_id: run.run_id, state: run.state, workflow: run.workflow, agent: run.agent,
      trigger: run.trigger, attempt: run.attempt,
      created_at: run.created_at, started_at: run.started_at, ended_at: run.ended_at,
    },
    ai_calls: ai,
    ai_cost: {
      measured_usd: measured.reduce((t, a) => t + Number(a.cost_usd || 0), 0),
      measured_calls: measured.length,
      unmeasured_calls: unmeasured,
      lower_bound: unmeasured > 0,
    },
    approvals,
    outcomes,
    exceptions,
  };
}

module.exports = {
  provenance, spendForObjective, unmeasuredForRun, claimApprovalRelease, approvalReleaseState,
  bootstrapObjectiveForContext, bootstrapApprovalForExecution, bootstrapApprovalOwner,
  rfqApprovalsForEligibility,
  createObjective, setObjectiveStatus,
  listObjectives, getObjective, listOpenExceptions, listPendingApprovals, spendToday, listOutcomes,
  recordCost, openException, resolveException, requestApproval, decideApproval, supersedeApproval,
  recordOutcome,
};
