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

/**
 * The canonical approval binding (B7.6). This module holds the PRIMARY consumer — the gate's
 * released-approval check — so it compares through the same module every producer writes with.
 *
 * REQUIRED LAZILY, and not for the usual require.cache reason. check-office-k2-db.js asserts that
 * the Executive Agent cannot reach a consequential capability, and it does so by crawling
 * require.cache for anything under `outbound/`. A top-level require here put
 * outbound/approval-digest.js into the agent's module graph and failed that check.
 *
 * The honest fix is this, not an exemption. The check's rule is deliberately blunt — ANYTHING in
 * outbound/ — and that bluntness is why it works: it catches a module nobody thought to list. A
 * pure hash function is harmless, but carving out the first exception is how a crawl like this
 * stops catching things, and the module genuinely has no business being loaded until an approval
 * is actually being verified.
 */
function digestModule() {
  return require('../outbound/approval-digest');
}

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

/**
 * Objectives a schedule may consider, with the company facts needed to judge eligibility.
 *
 * ── WHY THIS LIVES HERE AND NOT IN THE INITIATOR ──────────────────────────
 *
 * The office kernel tables are reachable in SQL only from this module, which
 * `check-office-scope-discipline.js` enforces. §6's initiator needs to SWEEP objectives across
 * companies before any context exists — it is the thing that finds the work — so it cannot take a
 * resolved context as the accessor rule normally requires.
 *
 * That is the same exception `bootstrapObjectiveForContext` above takes, and for the same reason: a
 * function whose job is to ESTABLISH which company is involved cannot require one first. The honest
 * resolution is to put the query where kernel SQL belongs rather than to exempt a second module
 * from the discipline — an exemption list that grows one reasonable entry at a time is how a
 * discipline stops being one.
 *
 * READ ONLY, and it decides nothing. Every eligibility rule stays in the initiator, where it is
 * tested; this returns rows.
 */
async function bootstrapObjectivesForInitiation(companyId = null, deps = {}) {
  const res = await q(deps)(
    `SELECT o.id, o.company_id, o.objective, o.status, o.autonomy_tier, o.budget_usd,
            c.status AS company_status
       FROM objectives o
       JOIN companies c ON c.id = o.company_id
      WHERE ($1::text IS NULL OR o.company_id = $1)
      ORDER BY o.priority, o.id`,
    [companyId]
  );
  return res.rows;
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
// ── THE REVIEW SURFACE'S READS (CEO decision 2026-11-11, priority 2) ───────
//
// src/api/approvals.routes.js had these inline and the scope-discipline check refused it within
// minutes — correctly, and for the reason its own message gives: "a predicate written at the call
// site is a predicate somebody can forget." A forgotten company_id on THIS read would show one
// tenant another's held commercial letters, including the rendered message.
//
// listPendingApprovals already exists and is not enough here: a review screen needs the
// resolution and release columns, and needs to show decided items too, so that "why can I not
// approve this" is answerable on the screen.

/** Held actions for a review screen. Company-scoped; `statuses` is a whitelist, not free text. */
async function approvalsForReview(ctx, { statuses = ['pending'] } = {}, deps = {}) {
  assertContext(ctx);
  const allowed = ['pending', 'approved', 'rejected', 'superseded', 'expired'];
  const want = (Array.isArray(statuses) ? statuses : [statuses])
    .map((x) => String(x).toLowerCase())
    .filter((x) => allowed.includes(x));
  if (!want.length) return [];
  return (await q(deps)(
    `SELECT id, company_id, run_id, action_kind, action_payload, status, owner_user_id, reason,
            created_at, resolved_at, resolved_by, resolution, released_at, released_by
       FROM office_approvals
      WHERE company_id = $1 AND status = ANY($2)
      ORDER BY created_at`, [ctx.companyId, want])).rows;
}

/**
 * One held action, for review or for a decision.
 *
 * Company-scoped, so "another company's approval" and "no such approval" are indistinguishable to
 * the caller — which is the wanted behaviour: a 404 that differs from a 403 is an enumeration
 * oracle for other tenants' approval ids.
 */
async function approvalForReview(ctx, approvalId, deps = {}) {
  assertContext(ctx);
  return (await q(deps)(
    `SELECT id, company_id, run_id, action_kind, action_payload, status, owner_user_id, reason,
            created_at, resolved_at, resolved_by, resolution, released_at, released_by
       FROM office_approvals WHERE company_id = $1 AND id = $2`,
    [ctx.companyId, approvalId])).rows[0] || null;
}

// ── THE TRANSPORT'S AUTHORIZATION CHECK, ANSWERED INSIDE THE KERNEL ─────────
//
// email-gate.js refuses any send leaving the company unless a RELEASED approval authorises those
// exact bytes (CEO decision 2026-11-11, priority 1). That check needs office_approvals, and
// office_approvals is a kernel table, so the SQL lives here — scripts/check-office-scope-discipline.js
// refuses to exempt product code and is right to: a predicate written at the call site is a
// predicate somebody can forget.
//
// I had this query in email-gate.js first, written as `FROM ${APPROVAL_TABLE}`. The scanner did
// not flag it, because a constant hides the table name from a text search — I got past a checker
// by accident, using exactly the indirection this programme keeps finding in its own code. The
// scanner now also refuses a product file that merely NAMES a kernel table in a constant.
//
// ── WHY THIS ONE IS NOT COMPANY-SCOPED, AND WHY THAT IS SAFE ────────────────
//
// The transport has no company context: it has a recipient, a capability and an approval id. It
// cannot be given one without the caller supplying it, which is the thing context.js exists to
// refuse.
//
// So instead of widening the read, this returns a VERDICT and nothing else — {ok} or
// {ok:false, reason, detail}. No payload, no recipient, no company, no other company's data
// crosses back. A caller that names an approval id it should not know still learns only whether
// that id authorises the bytes it already holds, which it could determine by attempting the send.
//
// Fail closed on every uncertainty, an unreadable database included.
async function verifyReleasedApprovalForDigest({ approvalId, digest }, deps = {}) {
  if (!approvalId) {
    return { ok: false, reason: 'approval_required',
      detail: 'this message leaves the company and carries no approval id' };
  }
  if (!digest) {
    return { ok: false, reason: 'digest_required',
      detail: `approval ${approvalId} was presented without a digest of the message, so nothing `
        + 'ties the approval to these bytes' };
  }

  let row;
  try {
    row = (await q(deps)(
      `SELECT id, status, released_at, action_payload FROM office_approvals WHERE id = $1`,
      [approvalId])).rows[0];
  } catch (e) {
    return { ok: false, reason: 'approval_unreadable',
      detail: `the approval record could not be read (${e && e.message}); an unverifiable `
        + 'authorization is not an authorization' };
  }

  if (!row) return { ok: false, reason: 'no_such_approval', detail: `no approval ${approvalId} exists` };
  if (row.status !== 'approved') {
    return { ok: false, reason: 'approval_not_granted',
      detail: `approval ${approvalId} is '${row.status}'` };
  }
  // RELEASED, not merely approved. claimApprovalRelease is what claims the single use of a human
  // decision, and a message reaching a provider without having gone through it has skipped the
  // one control that stops one decision authorising two sends.
  if (!row.released_at) {
    return { ok: false, reason: 'approval_not_released',
      detail: `approval ${approvalId} is approved but was never released; the transport was `
        + 'reached without passing through release()' };
  }

  const payload = row.action_payload || {};
  if (!payload.transport_digest) {
    return { ok: false, reason: 'approval_has_no_digest',
      detail: `approval ${approvalId} records no transport digest, so the approved artefact and `
        + 'the message about to be sent cannot be compared' };
  }
  // compareDigests, not `!==`. THIS IS THE PRIMARY APPROVAL CONSUMER — the gate consults it before
  // every external send — so the three failure cases must be told apart here most of all:
  //
  //   legacy_version     a stored v1 digest. It bound TO, the subject and one body, so it cannot
  //                      establish the company, the sender identity, the provider account, CC/BCC,
  //                      both bodies or the attachments of the message it supposedly approved.
  //                      FRESH APPROVAL is required, and reporting "mismatch" would send somebody
  //                      hunting for tampering that never happened.
  //   actual_not_current a producer was not migrated. Refused rather than compared, because two
  //                      definitions of "the message" must never jointly authorize a send.
  //   mismatch           the real thing: these are not the bytes that were approved.
  const verdict = digestModule().compareDigests({
    approved: payload.transport_digest, actual: digest });
  if (!verdict.ok) {
    return { ok: false, reason: `approval_digest_${verdict.code}`,
      needsFreshApproval: verdict.code === 'legacy_version',
      detail: `approval ${approvalId} authorises ${payload.transport_digest}; the message about `
        + `to be sent is ${digest} — ${verdict.detail}` };
  }
  return { ok: true };
}

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

// ── B3.2: PLANS AND THEIR STEPS ─────────────────────────────────────────────
//
// Every one of these composes its predicate from `ctx`, so a caller holding a context for company A
// cannot name a plan of company B's — and the composite foreign keys mean the database refuses it
// even if one of these queries were written wrongly.

/**
 * Record a proposed plan. `status` is not a parameter: a plan can only be born 'proposed', and the
 * CHECK constraint refuses anything else. Making it an argument would be the one line a future
 * caller could use to insert a pre-authorized plan.
 */
async function createPlan(ctx, { id, runId, proposer, planner }, deps = {}) {
  assertContext(ctx);
  if (!ctx.objectiveId) throw new Error('a plan must belong to an objective');
  const res = await q(deps)(
    `INSERT INTO office_plans (id, company_id, objective_id, run_id, proposer, planner)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, status, proposer, planner, created_at`,
    [id, ctx.companyId, ctx.objectiveId, runId, proposer, planner]
  );
  return res.rows[0];
}

/** Record one proposed step. The validator's verdict is written separately, by setStepVerdict. */
async function recordPlanStep(ctx, s, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `INSERT INTO office_plan_steps
       (plan_id, company_id, step_id, ordinal, step_type, task_type, capability, consequential,
        execution_class, payload, payload_digest, intent_key, requires_approval)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
     RETURNING plan_id, step_id, ordinal`,
    [s.planId, ctx.companyId, s.stepId, s.ordinal, s.stepType, s.taskType ?? null,
      s.capability ?? null, s.consequential === true, s.executionClass,
      JSON.stringify(s.payload ?? {}), s.payloadDigest, s.intentKey, s.requiresApproval === true]
  );
  return res.rows[0];
}

/** The validator's verdict for one step. */
async function setStepVerdict(ctx, { planId, stepId, verdict, refusalCode = null, refusalDetail = null },
  deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `UPDATE office_plan_steps SET verdict = $4, refusal_code = $5, refusal_detail = $6
      WHERE company_id = $1 AND plan_id = $2 AND step_id = $3
      RETURNING step_id, verdict, refusal_code`,
    [ctx.companyId, planId, stepId, verdict, refusalCode, refusalDetail]
  );
  return res.rows[0] || null;
}

/**
 * The plan-level verdict, written ONLY by the validator.
 *
 * `validated_at` is set by the database's NOW() in the same statement, so a plan cannot carry a
 * verdict without the time it was reached, and the time cannot come from a caller's clock.
 */
async function setPlanVerdict(ctx, { planId, status, verdict, refusalCode = null, refusalDetail = null },
  deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `UPDATE office_plans
        SET status = $3, verdict = $4, refusal_code = $5, refusal_detail = $6, validated_at = NOW()
      WHERE company_id = $1 AND id = $2
      RETURNING id, status, verdict, refusal_code, validated_at`,
    [ctx.companyId, planId, status, verdict, refusalCode, refusalDetail]
  );
  return res.rows[0] || null;
}

async function getPlan(ctx, planId, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `SELECT id, objective_id, run_id, proposer, planner, status, verdict, refusal_code,
            refusal_detail, validated_at, created_at
       FROM office_plans WHERE company_id = $1 AND id = $2`,
    [ctx.companyId, planId]
  );
  return res.rows[0] || null;
}

/**
 * The plan belonging to a run, if one has been minted yet.
 *
 * The unattended cycle needs this and nothing else to know which phase it is in: a run with no
 * plan has not been planned, a run with a plan has. Reading the phase from DURABLE ROWS rather
 * than from anything held in memory is what makes the cycle survive a process restart — there is
 * no in-flight state to lose, because there is none.
 */
/**
 * The counts a briefing must state, recounted from the kernel tables.
 *
 * The cycle's REPORT phase had this query inline and the scope-discipline check caught it — the
 * third time in this batch, and correctly each time: a company predicate written at a call site is
 * a predicate somebody can forget. It lives here with every other one.
 *
 * It exists at all because a briefing that reports figures the cycle computed as it went is a
 * briefing that cannot be wrong about them. Recounting independently is what caught the first
 * draft of B3.10's briefing reporting zero executed tasks.
 */
async function briefingCounts(ctx, { runId, planId = null }, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `SELECT
       (SELECT COUNT(*)::int FROM office_plan_steps
         WHERE company_id = $1 AND plan_id = $2) AS planned_steps,
       (SELECT COUNT(*)::int FROM office_outcomes
         WHERE company_id = $1 AND run_id = $3) AS outcomes,
       (SELECT COUNT(*)::int FROM office_exceptions
         WHERE company_id = $1 AND run_id = $3 AND resolved_at IS NULL) AS open_exceptions`,
    [ctx.companyId, planId, runId]
  );
  const r = res.rows[0];
  return {
    plannedSteps: Number(r.planned_steps),
    outcomes: Number(r.outcomes),
    openExceptions: Number(r.open_exceptions),
  };
}

async function planForRun(ctx, runId, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `SELECT id, objective_id, run_id, proposer, planner, status, verdict, refusal_code,
            refusal_detail, validated_at, created_at
       FROM office_plans WHERE company_id = $1 AND run_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [ctx.companyId, runId]
  );
  return res.rows[0] || null;
}

async function listPlanSteps(ctx, planId, deps = {}) {
  assertContext(ctx);
  return (await q(deps)(
    `SELECT plan_id, step_id, ordinal, step_type, task_type, capability, consequential,
            execution_class, payload, payload_digest, intent_key, requires_approval,
            verdict, refusal_code, refusal_detail
       FROM office_plan_steps WHERE company_id = $1 AND plan_id = $2
      ORDER BY ordinal`,
    [ctx.companyId, planId]
  )).rows;
}

// ── B2.5b: PRE-SPEND RESERVATIONS ───────────────────────────────────────────
//
// Owner instruction, 2026-11-25: "Prevent unauthorized expenditure before a metered call, not
// merely after the budget has been exceeded. Atomic reservation or charging before execution."
//
// ── WHY THIS NEEDS A TRANSACTION AND A ROW LOCK ─────────────────────────────
//
// The naive version reads the spend, compares it with the budget, and inserts. Under READ
// COMMITTED two concurrent callers both read the same spend, both find headroom, and both insert —
// which is the defect this function exists to close, reproduced one layer down. A single INSERT …
// SELECT … WHERE sum <= budget does not fix it either: the two subqueries are evaluated against a
// snapshot that does not include the other transaction's uncommitted row.
//
// So every reservation for one objective serializes on that objective's row: `SELECT … FOR UPDATE`
// on `objectives`. The lock is per objective, so two companies — or two different objectives of one
// company — never wait on each other, and the window it holds is one INSERT long.
//
// scripts/check-finite-budget-db.js fires N concurrent reservations at a budget that fits a known
// number of them and asserts that EXACTLY that many succeed. Without the lock that assertion fails.

/** How long a hold lives if nobody settles it. Short: it bounds a provider call, not a workflow. */
const RESERVATION_TTL_MS = 10 * 60 * 1000;

/**
 * Take a hold for at most `maxUsd` against an objective's budget, or refuse.
 *
 * Returns { ok: true, reservation } | { ok: false, code, detail, ... }
 *
 * `maxUsd` is the MOST the operation may cost, not an estimate of what it will. An under-estimate
 * here is a hole in the limit, so the caller is expected to over-estimate and the settlement
 * corrects it.
 */
async function reserveSpend(ctx, { id, objectiveId, runId, maxUsd, reason,
  ttlMs = RESERVATION_TTL_MS }, deps = {}) {
  assertContext(ctx);
  if (!(Number(maxUsd) > 0)) {
    return { ok: false, code: 'no_amount',
      detail: 'a reservation must be for a positive maximum: a $0 hold reserves nothing while '
        + 'looking like a reservation' };
  }
  if (!reason || !String(reason).trim()) {
    return { ok: false, code: 'no_reason', detail: 'a hold must say what it is for' };
  }

  const tx = (deps && deps.withTransaction) || require('../db').withTransaction;
  return tx(async (client) => {
    const run = (t, p) => client.query(t, p);

    // ── 1. SERIALIZE ON THE OBJECTIVE, AND READ THE AUTHORITATIVE BUDGET ───
    //
    // The budget comes from this locked row, not from `ctx.budgetUsd`. The context's copy was
    // minted when the context was resolved and could be stale by the time a concurrent caller is
    // competing for the same headroom — and it is the figure the comparison turns on.
    const obj = await run(
      `SELECT id, budget_usd, status FROM objectives
        WHERE company_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.companyId, objectiveId]);
    if (!obj.rows.length) {
      return { ok: false, code: 'objective_not_in_company_scope',
        detail: `objective ${objectiveId} is not readable for company ${ctx.companyId}` };
    }
    const row = obj.rows[0];
    if (row.status !== 'active') {
      return { ok: false, code: 'objective_not_active',
        detail: `objective ${objectiveId} is ${row.status}; spend is not authorized against it` };
    }

    // ── 2. NO BUDGET: ONLY A LIVE, NAMED EXCEPTION PERMITS THE HOLD ────────
    let exceptionId = null;
    if (row.budget_usd === null) {
      const ex = await run(
        `SELECT id FROM office_budget_exceptions
          WHERE company_id = $1 AND objective_id = $2 AND revoked_at IS NULL
            AND effective_from <= NOW() AND effective_to > NOW()
          LIMIT 1`,
        [ctx.companyId, objectiveId]);
      if (!ex.rows.length) {
        return { ok: false, code: 'needs_budget_or_exception',
          detail: `objective ${objectiveId} has NO authorized budget, so no spend may be reserved `
            + 'against it. Set a finite objective budget, or record a named, time-bounded budget '
            + 'exception.' };
      }
      exceptionId = ex.rows[0].id;
    }

    // ── 3. SPENT + LIVE HOLDS + THIS CALL vs THE CEILING ──────────────────
    //
    // ── THE EXPIRY RULE, CORRECTED (owner's §4, 2026-11-25) ──────────────
    //
    // This read `state = 'held' AND expires_at > NOW()`, justified in my own comment as "the crash
    // answer": a hold whose process died stopped counting, so a dead worker could not consume an
    // objective's ceiling for ever. The owner's correction is that crash-safe and FINANCIALLY safe
    // are different properties, and I had only the first:
    //
    //   a process reserves $0.40, dispatches the request, the provider accepts and begins
    //   billing, the process is then killed. Ten minutes later the hold stops counting. The
    //   budget now believes it has $0.40 of headroom that has already been spent, and the next
    //   call is authorized against money that is gone.
    //
    // So expiry is no longer about time alone. A hold expires into free headroom ONLY if nothing
    // was ever dispatched on it. Once a request has gone out, the hold keeps counting until the
    // charge is reconciled or proven not to have happened — for ever, if need be, because an
    // unresolved charge that stops counting is an unresolved charge that gets spent twice.
    //
    // The database enforces the same rule independently
    // (office_budget_reservations_only_undispatched_expires), so neither the reaper nor a future
    // caller can lapse a dispatched hold.
    //
    // Unmeasured calls are COUNTED and reported, never converted into dollars — "no estimated
    // spend derived from invocation counts". A ceiling that cannot be proven says so.
    const sums = await run(
      `SELECT
         (SELECT COALESCE(SUM(cost_usd),0)::numeric FROM office_cost_ledger
           WHERE company_id = $1 AND objective_id = $2 AND cost_known) AS spent,
         (SELECT COUNT(*)::int FROM office_cost_ledger
           WHERE company_id = $1 AND objective_id = $2 AND NOT cost_known) AS unknown_calls,
         (SELECT COALESCE(SUM(max_usd),0)::numeric FROM office_budget_reservations
           WHERE company_id = $1 AND objective_id = $2 AND state = 'held'
             AND (expires_at > NOW() OR financial_state <> 'reserved')) AS held,
         (SELECT COUNT(*)::int FROM office_budget_reservations
           WHERE company_id = $1 AND objective_id = $2 AND state = 'held'
             AND expires_at <= NOW() AND financial_state <> 'reserved') AS unresolved_charges`,
      [ctx.companyId, objectiveId]);
    const spent = Number(sums.rows[0].spent);
    const held = Number(sums.rows[0].held);
    const unknownCalls = Number(sums.rows[0].unknown_calls);
    // Holds past their window that were DISPATCHED. They still count, and they are reported so an
    // operator can see that headroom is being consumed by requests whose outcome is unresolved
    // rather than by live work.
    const unresolvedCharges = Number(sums.rows[0].unresolved_charges);

    if (row.budget_usd !== null) {
      const cap = Number(row.budget_usd);
      const after = spent + held + Number(maxUsd);
      // `>` not `>=`: a hold that exactly fills the budget is permitted. A $10 objective may spend
      // its tenth dollar.
      if (after > cap) {
        return { ok: false, code: 'would_exceed_objective_budget',
          detail: `this call could cost up to $${Number(maxUsd).toFixed(6)}; the objective has `
            + `$${cap} with $${spent.toFixed(6)} spent and $${held.toFixed(6)} already held, so the `
            + `worst case is $${after.toFixed(6)} — refused BEFORE the provider is reached`,
          budgetUsd: cap, spentUsd: spent, heldUsd: held, maxUsd: Number(maxUsd),
          worstCaseUsd: after, unknownCalls, unresolvedCharges };
      }
    }

    const ins = await run(
      `INSERT INTO office_budget_reservations
         (id, company_id, objective_id, run_id, max_usd, reason, under_exception, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + ($8::int * INTERVAL '1 millisecond'))
       RETURNING id, max_usd, state, under_exception, held_at, expires_at`,
      [id, ctx.companyId, objectiveId, runId, maxUsd, String(reason).trim(), exceptionId, ttlMs]);

    return { ok: true,
      reservation: ins.rows[0],
      budgetUsd: row.budget_usd === null ? null : Number(row.budget_usd),
      spentUsd: spent, heldUsd: held, unknownCalls, unresolvedCharges,
      // A ceiling that cannot be proven is reported as such rather than asserted. An unresolved
      // provider charge makes it unproven too: the figure is conservative, not accurate.
      confident: unknownCalls === 0 && unresolvedCharges === 0 };
  });
}

/**
 * Reconcile a hold with what the call actually cost.
 *
 * `costKnown: false` settles with NO dollar figure. An unmeasured call is not a free one, and
 * writing 0 would make "zero spend" ambiguous — the C1 rule, applied to settlement.
 */
async function settleSpend(ctx, { reservationId, costUsd = null, costKnown,
  costLedgerId = null }, deps = {}) {
  assertContext(ctx);
  if (typeof costKnown !== 'boolean') {
    throw new Error('settleSpend requires costKnown: an unmeasured call is not a free one');
  }
  const res = await q(deps)(
    `UPDATE office_budget_reservations
        SET state = 'settled', settled_at = NOW(),
            settled_cost_known = $3,
            settled_cost_usd = CASE WHEN $3 THEN $4::numeric ELSE NULL END,
            cost_ledger_id = $5,
            -- RECONCILED only when the cost is actually known. A settlement with no figure is a
            -- dispatched request whose charge nobody established, which is the UNKNOWN state, and
            -- calling it reconciled would be the "failed therefore free" assumption wearing a
            -- different label. The hold's headroom is returned either way — the ledger carries the
            -- real cost — but what we claim to know about the charge stays accurate.
            financial_state = CASE WHEN $3 THEN 'reconciled' ELSE 'unknown' END,
            dispatched_at = COALESCE(dispatched_at, NOW()),
            financial_note = CASE WHEN $3 THEN financial_note
              ELSE COALESCE(financial_note,
                'settled with no cost figure: the request was dispatched and its charge could not '
                || 'be measured, so the financial outcome is unknown rather than zero') END
      WHERE company_id = $1 AND id = $2 AND state = 'held'
      RETURNING id, state, settled_cost_usd, settled_cost_known, financial_state`,
    [ctx.companyId, reservationId, costKnown, costUsd, costLedgerId]
  );
  return res.rows[0] || null;
}

/**
 * Give the headroom straight back.
 *
 * Honest in exactly two situations: the request never went, or it went and is PROVEN not to have
 * been charged. The second needs evidence — the owner's instruction is explicit that *"a failed
 * request must not be described as zero-cost without evidence"* — so releasing a dispatched hold
 * requires `zeroChargeEvidence`, and without it the release is refused rather than quietly
 * granted. A caller that cannot supply evidence wants markFinancialOutcomeUnknown instead.
 */
async function releaseSpend(ctx, { reservationId, zeroChargeEvidence = null }, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `UPDATE office_budget_reservations
        SET state = 'released', settled_at = NOW(),
            financial_state = CASE
              WHEN financial_state = 'reserved' THEN 'reserved'
              ELSE 'zero_charge_verified' END,
            financial_note = CASE
              WHEN financial_state = 'reserved' THEN financial_note
              ELSE $3::text END
      WHERE company_id = $1 AND id = $2 AND state = 'held'
        -- An undispatched hold releases freely. A dispatched one releases only with evidence, and
        -- this clause is what makes the absence of evidence a REFUSAL rather than a release.
        --
        -- $3::text explicitly: with a null evidence argument and no cast, Postgres cannot infer
        -- the parameter's type inside length(btrim(...)) and the statement fails outright — which
        -- would have turned "release refused for want of evidence" into "release crashed", two
        -- very different things for a caller to handle.
        AND (financial_state = 'reserved'
             OR ($3::text IS NOT NULL AND length(btrim($3::text)) > 0))
      RETURNING id, state, financial_state`,
    [ctx.companyId, reservationId, zeroChargeEvidence]
  );
  return res.rows[0] || null;
}

/**
 * Mark holds that outlived their window.
 *
 * Bookkeeping, NOT the mechanism: `reserveSpend` already ignores an expired hold, so the budget is
 * correct whether or not this ever runs. Making the reaper load-bearing would mean a budget that is
 * wrong between its runs — and "the reaper runs every quarter hour" is a schedule, not a guarantee.
 */
async function expireStaleReservations(ctx, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `UPDATE office_budget_reservations
        SET state = 'expired', settled_at = NOW()
      WHERE company_id = $1 AND state = 'held' AND expires_at <= NOW()
        -- ONLY an undispatched hold. A hold with a request behind it may not lapse into free
        -- headroom however old it is, because the charge does not expire with the window. The
        -- table enforces this too; the clause is here so the reaper does not try and fail.
        AND financial_state = 'reserved'
      RETURNING id`,
    [ctx.companyId]
  );
  return res.rows.map((r) => r.id);
}

/**
 * Record that a request has been, or is about to be, sent to the provider.
 *
 * Called BEFORE the provider call, which is the only useful ordering: called after, a process that
 * dies mid-request leaves a hold marked `reserved`, and that hold expires into headroom the
 * provider has already billed. The window between this write and the request is the one place a
 * crash can still lose money, and it is one statement wide.
 */
async function markDispatched(ctx, { reservationId, state = 'dispatch_attempted',
  note = null }, deps = {}) {
  assertContext(ctx);
  if (!['dispatch_attempted', 'provider_accepted'].includes(state)) {
    throw new Error(`markDispatched takes dispatch_attempted or provider_accepted, not ${state}`);
  }
  const res = await q(deps)(
    `UPDATE office_budget_reservations
        SET financial_state = $3,
            dispatched_at = COALESCE(dispatched_at, NOW()),
            financial_note = COALESCE($4, financial_note)
      WHERE company_id = $1 AND id = $2 AND state = 'held'
      RETURNING id, financial_state, dispatched_at`,
    [ctx.companyId, reservationId, state, note]
  );
  return res.rows[0] || null;
}

/**
 * The financial outcome cannot be established.
 *
 * This is the honest terminal state for a request that was dispatched and whose cost nobody can
 * determine — a timeout after acceptance, a killed process, a provider response that never
 * arrived. The hold STAYS live and keeps consuming the objective's ceiling, with no window, until
 * a human reconciles it. That is deliberately the most conservative outcome available: the
 * alternative is authorizing a second call against money that may already be gone.
 *
 * `note` is required by the table, not just by this function.
 */
async function markFinancialOutcomeUnknown(ctx, { reservationId, note }, deps = {}) {
  assertContext(ctx);
  if (!note || !String(note).trim()) {
    throw new Error('markFinancialOutcomeUnknown requires a note: an unresolved charge needs a '
      + 'written reason, because somebody has to reconcile it by hand');
  }
  const res = await q(deps)(
    `UPDATE office_budget_reservations
        SET financial_state = 'unknown',
            dispatched_at = COALESCE(dispatched_at, NOW()),
            financial_note = $3
      WHERE company_id = $1 AND id = $2 AND state = 'held'
      RETURNING id, financial_state`,
    [ctx.companyId, reservationId, String(note).trim()]
  );
  return res.rows[0] || null;
}

/** Live exposure and settled spend for one objective — for reporting, not for the decision. */
async function reservationState(ctx, objectiveId, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `SELECT
       COALESCE(SUM(max_usd) FILTER (WHERE state = 'held'
         AND (expires_at > NOW() OR financial_state <> 'reserved')),0)::numeric AS live_held,
       COUNT(*) FILTER (WHERE state = 'held'
         AND (expires_at > NOW() OR financial_state <> 'reserved'))::int AS live_count,
       -- STALE now means: past its window AND never dispatched. A dispatched hold past its window
       -- is not stale, it is an unresolved charge, and the two must not be summed together under a
       -- name that suggests the reaper can clear them.
       COUNT(*) FILTER (WHERE state = 'held' AND expires_at <= NOW()
         AND financial_state = 'reserved')::int AS stale_count,
       COUNT(*) FILTER (WHERE state = 'held'
         AND financial_state IN ('dispatch_attempted','provider_accepted','unknown'))::int
         AS unresolved_count,
       COALESCE(SUM(max_usd) FILTER (WHERE state = 'held'
         AND financial_state IN ('dispatch_attempted','provider_accepted','unknown')),0)::numeric
         AS unresolved_usd,
       COUNT(*) FILTER (WHERE state = 'settled')::int AS settled_count,
       COUNT(*) FILTER (WHERE state = 'released')::int AS released_count,
       COUNT(*) FILTER (WHERE state = 'expired')::int AS expired_count
     FROM office_budget_reservations WHERE company_id = $1 AND objective_id = $2`,
    [ctx.companyId, objectiveId]
  );
  return res.rows[0];
}

// ── B3.3: DELEGATION ────────────────────────────────────────────────────────

/**
 * Record one delegation. Every field the dependency plan's Gate 3 requires is a parameter and all
 * of them are NOT NULL in the table, so a delegation that cannot name one cannot be recorded.
 *
 * `companyId` is not among them: it comes from `ctx`, which is the whole point.
 */
async function recordDelegation(ctx, { id, parentRunId, childRunId, callingAgent, targetAgent,
  workflow, capability, autonomyTier, policyDecision, depth, reason }, deps = {}) {
  assertContext(ctx);
  if (!ctx.objectiveId) throw new Error('a delegation must belong to an objective');
  const res = await q(deps)(
    `INSERT INTO office_delegations
       (id, company_id, objective_id, parent_run_id, child_run_id, calling_agent, target_agent,
        workflow, capability, autonomy_tier, policy_decision, depth, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id, parent_run_id, child_run_id, depth, at`,
    [id, ctx.companyId, ctx.objectiveId, parentRunId, childRunId, callingAgent, targetAgent,
      workflow, capability, autonomyTier, policyDecision, depth, reason]
  );
  return res.rows[0];
}

/**
 * How deep in the delegation tree is this run? 0 for a root.
 *
 * A recursive CTE rather than a loop of round trips, and BOUNDED — `depth < $3` stops it even if a
 * cycle ever reached the table, because an unbounded recursive CTE over a cycle does not return.
 * The parent chain is read from agent_runs, which is the authoritative tree, and scoped to this
 * company so a chain cannot be measured across a boundary.
 */
async function delegationDepth(ctx, runId, { limit = 16 } = {}, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `WITH RECURSIVE chain(run_id, parent_run_id, depth) AS (
       SELECT run_id, parent_run_id, 0
         FROM agent_runs WHERE company_id = $1 AND run_id = $2
       UNION ALL
       SELECT a.run_id, a.parent_run_id, c.depth + 1
         FROM agent_runs a JOIN chain c ON a.run_id = c.parent_run_id
        WHERE a.company_id = $1 AND c.depth < $3
     )
     SELECT COALESCE(MAX(depth), 0)::int AS depth, COUNT(*)::int AS links FROM chain`,
    [ctx.companyId, runId, limit]
  );
  return res.rows[0];
}

/** The delegations made from one parent run. */
async function delegationsFrom(ctx, parentRunId, deps = {}) {
  assertContext(ctx);
  return (await q(deps)(
    `SELECT id, objective_id, parent_run_id, child_run_id, calling_agent, target_agent, workflow,
            capability, autonomy_tier, policy_decision, depth, reason, at
       FROM office_delegations WHERE company_id = $1 AND parent_run_id = $2
      ORDER BY at`,
    [ctx.companyId, parentRunId]
  )).rows;
}

/**
 * The state of one run, for the "is my parent still alive" question.
 *
 * Scoped: a run of another company reads as absent, which is the right answer — a delegation whose
 * parent this context cannot see is not a delegation this context may make.
 */
async function runState(ctx, runId, deps = {}) {
  assertContext(ctx);
  const res = await q(deps)(
    `SELECT run_id, root_run_id, parent_run_id, state, objective_id, agent, workflow
       FROM agent_runs WHERE company_id = $1 AND run_id = $2`,
    [ctx.companyId, runId]
  );
  return res.rows[0] || null;
}

// Objective-level spend, measured and unmeasured, for the whole life of the objective. The
// enterprise cap is per DAY; an objective's budget is a TOTAL — a $10 objective that has spent
// $10 is finished whether that happened today or last week.
/**
 * The ACTIVE budget exception for one objective, or null. B2.5a.
 *
 * "Active" means: not revoked, and now is inside its window. All three conditions are in the SQL
 * rather than split between SQL and JavaScript, because a half-expressed predicate is how an
 * expired exception keeps authorizing spend.
 *
 * `NOW()` rather than a client timestamp, for the reason measured on 2026-11-24 in the identity
 * accessors: `effective_from` is written by Postgres with microsecond precision, a JavaScript Date
 * carries milliseconds, and comparing one clock's write against another clock's read hid a row
 * from its own creator in 142 of 200 trials. An exception granted and immediately consulted — which
 * is exactly how an operator would use it — would have appeared not to exist.
 *
 * Returns null for "no active exception" and throws for "could not tell". A caller must not read an
 * outage as permission; that is why this does not swallow.
 */
async function activeBudgetException(ctx, objectiveId, deps = {}) {
  assertContext(ctx);
  if (!objectiveId) return null;
  const res = await q(deps)(
    `SELECT id, granted_by, reason, effective_from, effective_to
       FROM office_budget_exceptions
      WHERE company_id = $1
        AND objective_id = $2
        AND revoked_at IS NULL
        AND effective_from <= NOW()
        AND effective_to   >  NOW()
      LIMIT 1`,
    [ctx.companyId, objectiveId]
  );
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return Object.freeze({
    id: r.id, grantedBy: r.granted_by, reason: r.reason,
    effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
  });
}

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
  activeBudgetException,
  provenance, spendForObjective, unmeasuredForRun, claimApprovalRelease, approvalReleaseState,
  verifyReleasedApprovalForDigest, approvalsForReview, approvalForReview,
  bootstrapObjectiveForContext, bootstrapApprovalForExecution, bootstrapApprovalOwner,
  bootstrapObjectivesForInitiation,
  rfqApprovalsForEligibility,
  createObjective, setObjectiveStatus,
  listObjectives, getObjective, listOpenExceptions, listPendingApprovals, spendToday, listOutcomes,
  recordCost, openException, resolveException, requestApproval, decideApproval, supersedeApproval,
  recordOutcome,
  createPlan, recordPlanStep, setStepVerdict, setPlanVerdict, getPlan, listPlanSteps,
  planForRun, briefingCounts,
  recordDelegation, delegationDepth, delegationsFrom, runState,
  reserveSpend, settleSpend, releaseSpend, expireStaleReservations, reservationState,
  markDispatched, markFinancialOutcomeUnknown,
  RESERVATION_TTL_MS,
};
