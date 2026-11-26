// ── COMPANY-SCOPED READS OF THE OPERATIONAL RECORDS (B7.21) ─────────────────
//
//   const OPS = require('./scoped-operations');
//   await OPS.employeesOf(ctx, deps);          // who this company may act on
//   await OPS.tasksFor(ctx, { date }, deps);   // and whose tasks those are
//
// THE ONLY ACCESSOR for the company_id columns B7.21 added, enforced by
// scripts/check-identity-accessor-discipline.js — the same discipline `user_companies`,
// `workflow_companies` and `agent_memory` already have, and for the same reason: a company filter
// written at the call site is a company filter somebody can forget.
//
// ── EVERY FUNCTION TAKES A CONTEXT; NONE TAKES A COMPANY ID ─────────────────
//
// As in office/memory.js. There is no `companyId` parameter on this surface — not optional, not
// overridable. The company in every statement is `ctx.companyId`, read off a context that
// office/context.js minted from stored state. A caller that wants another company's tasks has
// nothing to supply.
//
// ── THE PROPERTY THAT MATTERS MOST: NULL IS INVISIBLE, NOT UNIVERSAL ────────
//
// `company_id IS NULL` means "ownership not yet established". Every query below requires an
// EQUALITY match, so such a row is returned to NO company.
//
// That is the opposite of the usual instinct. An unscoped row feels like shared data, and the
// tempting predicate is `company_id = $1 OR company_id IS NULL` — "show me mine and the ones
// nobody has claimed". That predicate would hand every company every unattributed task, score and
// order in the platform, which is precisely the state the system is in today for all thirteen
// tables. Unattributed data is not shared data; it is data whose owner is unknown, and the safe
// reading of an unknown owner is nobody.
//
// The consequence is deliberate and must be stated plainly to whoever runs the backfill: until
// B7.21's attribution is applied, every function here returns NOTHING. A briefing built on them
// would be empty rather than wrong. An empty briefing is a visible failure; a briefing containing
// another company's numbers is an invisible one, and this system has spent three weeks learning
// what invisible failures cost.
//
// ── EMPLOYEE SELECTION GOES THROUGH THE MEMBERSHIP ACCESSOR ─────────────────
//
// `employeesOf` does not invent a roster query. It composes
// identity/company-membership.js — the module that owns the six-condition live predicate — because
// a second expression of "who is an active employee of this company" is how the two drift, and the
// owner's ruling was explicit that there must be no competing model.

'use strict';

const CTX = require('../office/context');

/** The company, from the context, after proving the context is one this process minted. */
function companyOf(ctx) {
  CTX.assertContext(ctx);
  return ctx.companyId;
}

function lazyQuery() {
  return require('../db').query;
}

function q(deps) {
  return (deps && deps.query) || lazyQuery();
}

function membership() {
  return require('./company-membership');
}

/** Sentinel for "the records could not be read", distinct from "there are none". */
const UNKNOWN = null;

// ── EMPLOYEE SELECTION ──────────────────────────────────────────────────────

/**
 * The people this company may act on: active members, external roles excluded, through the
 * membership accessor's own predicate.
 *
 * Returns UNKNOWN (null) when membership cannot be read. An outage is not an empty company, and a
 * caller that treats null as [] would score nobody and report that as a healthy quiet day.
 */
async function employeesOf(ctx, deps = {}) {
  // DELEGATED, not re-queried. company-membership.js owns the six-condition live predicate; a
  // roster query written here would be a second expression of "who is an active employee of this
  // company", and two expressions drift the day one is edited and the other is not.
  return membership().membersOfCompany(companyOf(ctx), deps);
}

// ── TASK ASSIGNMENT AND OWNERSHIP ───────────────────────────────────────────

/**
 * This company's tasks for a date.
 *
 * Scoped by the TASK's own company_id, not by its assignee's membership — which is the whole point
 * of B7.21. Deriving a task's company from whoever it is assigned to would mean a shared employee's
 * ABIOZEN task appears in Adifice's list, because the assignee is a member of both. The record
 * carries its own ownership.
 */
async function tasksFor(ctx, { date = null, userId = null } = {}, deps = {}) {
  const companyId = companyOf(ctx);
  const r = await q(deps)(
    `SELECT id, user_id, task_date, task_title, task_description, status, priority, created_at
       FROM daily_tasks
      WHERE company_id = $1
        AND ($2::text IS NULL OR task_date = $2)
        AND ($3::text IS NULL OR user_id = $3)
      ORDER BY task_date DESC, priority`,
    [companyId, date, userId],
  );
  return r.rows.map(shapeTask);
}

/**
 * Assign a task to an employee OF THIS COMPANY. B3.10 step 10.
 *
 * ── WHY THIS IS A WRITER IN THE SCOPED MODULE ──────────────────────────────
 *
 * Every other function here reads. This one writes, and it belongs here for the reason the whole
 * module exists: the owner's instruction that *"filtering employees alone is insufficient — the
 * underlying tasks must also belong to the authorized company."* A task written anywhere else
 * would be written without a company, which is how `daily_tasks` came to have 0 `company_id`
 * references in the first place.
 *
 * ── AND WHY IT VERIFIES MEMBERSHIP RATHER THAN TRUSTING THE CALLER ─────────
 *
 * The assignee must be an ACTIVE MEMBER of this company at the moment of assignment, checked
 * through identity/company-membership.js — the single accessor — rather than by this function
 * writing its own predicate. Assigning work to somebody who is not a member is how a cross-company
 * task appears, and "the caller passed a user id" is not evidence that they may be given work.
 *
 * An unreadable membership REFUSES. An outage is not a membership.
 */
async function assignTask(ctx, { id, userId, title, description = null, taskDate,
  priority = 'MEDIUM', assignedBy, reasoning = null }, deps = {}) {
  const companyId = companyOf(ctx);
  if (!userId) return { ok: false, code: 'no_assignee', detail: 'a task must name an employee' };
  if (!title || !String(title).trim()) {
    return { ok: false, code: 'no_title', detail: 'a task must say what to do' };
  }
  if (!assignedBy) {
    return { ok: false, code: 'no_assigner',
      detail: 'a task must record who or what assigned it — the audit trail is the point' };
  }
  // `daily_tasks.task_date` is TEXT NOT NULL and this function declared `taskDate` with no default,
  // so an omitted day reached Postgres as NULL and came back as a raw 23502. B3.17 found the
  // autonomous cycle doing exactly that at its employee-assignment phase: EVERY assignment failed,
  // and because that caller catches anything which is not a 23505 into `{ok:false}`, the briefing
  // reported only that the employee was not assigned. A missing required argument must refuse BY
  // NAME here, like every other one above, so the next caller to omit it reads why.
  if (!taskDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(taskDate))) {
    return { ok: false, code: 'no_task_date',
      detail: 'a task must name the business day it belongs to, as YYYY-MM-DD — the column is '
        + 'NOT NULL and a task with no day cannot appear on anybody\'s list' };
  }

  const MEMBERSHIP = require('./company-membership');
  let members;
  try {
    members = await MEMBERSHIP.membersOfCompany(companyId, deps);
  } catch (e) {
    return { ok: false, code: 'membership_unreadable',
      detail: `membership could not be read (${e.message}) — an outage is not a membership` };
  }
  // membersOfCompany shapes its rows with `id`, not `userId` — read off the accessor rather than
  // assumed. Accepting either keeps this correct if that shape is ever widened, and matching
  // neither would have made EVERY assignment refuse while looking like a membership problem.
  const isMember = (members || []).some((m) => m.id === userId || m.userId === userId);
  if (!isMember) {
    return { ok: false, code: 'not_a_member',
      detail: `user ${userId} is not an active member of company ${companyId}, so work may not be `
        + 'assigned to them under it' };
  }

  // THE REAL COLUMNS, read off the live schema. `priority` is TEXT with a CHECK on
  // ('HIGH','MEDIUM','LOW') — not an integer — and there is no `assigned_by`: who assigned it goes
  // in `agent_name`, and why in `reasoning`. The first version of this function guessed an integer
  // priority and an `assigned_by` column, which is the mistake this module's own header records
  // against `title` and `completed_at`. Guessing a schema twice in one file would be a pattern.
  if (!['HIGH', 'MEDIUM', 'LOW'].includes(priority)) {
    return { ok: false, code: 'bad_priority',
      detail: `priority must be HIGH, MEDIUM or LOW — the column has a CHECK on it` };
  }
  const r = await q(deps)(
    `INSERT INTO daily_tasks
       (id, company_id, user_id, task_date, task_title, task_description, priority, status,
        agent_name, reasoning)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)
     RETURNING id, user_id, task_date, task_title, task_description, status, priority, created_at`,
    [id, companyId, userId, taskDate, String(title).trim(), description, priority, assignedBy,
      reasoning],
  );
  return { ok: true, task: shapeTask(r.rows[0]) };
}

/** Mark an assigned task complete. Company-scoped, so one company cannot close another's work. */
async function completeTask(ctx, { id }, deps = {}) {
  const companyId = companyOf(ctx);
  const r = await q(deps)(
    `UPDATE daily_tasks SET status = 'completed'
      WHERE company_id = $1 AND id = $2 AND status <> 'completed'
      RETURNING id, status`,
    [companyId, id],
  );
  return r.rows[0] || null;
}

function shapeTask(t) {
  // `task_title`, not `title`, and there is no `completed_at` — the real columns, read off the
  // live schema rather than assumed. The first version of this query guessed both and failed with
  // `column "title" of relation "daily_tasks" does not exist`.
  return Object.freeze({
    id: t.id, userId: t.user_id, taskDate: t.task_date,
    title: t.task_title, description: t.task_description,
    status: t.status, priority: t.priority, createdAt: t.created_at,
  });
}

// ── PERFORMANCE SCORING, COACHING AND ESCALATION ────────────────────────────

/** This company's performance scores for a date. */
async function scoresFor(ctx, { date = null, userId = null } = {}, deps = {}) {
  const companyId = companyOf(ctx);
  const r = await q(deps)(
    `SELECT id, user_id, score_date, score_0_to_100
       FROM performance_scores
      WHERE company_id = $1
        AND ($2::text IS NULL OR score_date = $2)
        AND ($3::text IS NULL OR user_id = $3)
      ORDER BY score_date DESC`,
    [companyId, date, userId],
  );
  return r.rows.map((s) => Object.freeze({
    id: s.id, userId: s.user_id, scoreDate: s.score_date, score: s.score_0_to_100,
  }));
}

// ── OBJECTIVES AND MILESTONES ───────────────────────────────────────────────

/** This company's milestones. */
async function milestonesFor(ctx, { status = null } = {}, deps = {}) {
  const companyId = companyOf(ctx);
  const r = await q(deps)(
    `SELECT id, name, target_date, actual_date, status, owner_id
       FROM milestones
      WHERE company_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY target_date`,
    [companyId, status],
  );
  return r.rows.map((m) => Object.freeze({
    id: m.id, name: m.name, targetDate: m.target_date, actualDate: m.actual_date,
    status: m.status, ownerId: m.owner_id,
  }));
}

// ── ORDERS AND REVENUE METRICS ──────────────────────────────────────────────

/**
 * This company's revenue over a date range.
 *
 * Returns `{ usd, orderCount }` for ATTRIBUTED orders only. Unattributed orders — which today is
 * all of them, because an order row names no company by any route — are excluded, so this returns
 * zero rather than the platform total. A company's revenue figure that silently includes another
 * company's orders is worse than a zero, and the attribution proposal is what fixes it.
 */
async function revenueFor(ctx, { from, to } = {}, deps = {}) {
  const companyId = companyOf(ctx);
  const r = await q(deps)(
    `SELECT COALESCE(SUM(amount), 0)::float AS usd, COUNT(*)::int AS n
       FROM orders
      WHERE company_id = $1
        AND ($2::text IS NULL OR order_date::text >= $2)
        AND ($3::text IS NULL OR order_date::text <= $3)`,
    [companyId, from || null, to || null],
  );
  return Object.freeze({ usd: Number(r.rows[0].usd), orderCount: r.rows[0].n });
}

// ── HISTORICAL RECORDS AND REPORTING ────────────────────────────────────────

/** This company's activity log entries. */
async function activityFor(ctx, { from = null, to = null, limit = 200 } = {}, deps = {}) {
  const companyId = companyOf(ctx);
  const n = Number.isInteger(limit) && limit > 0 && limit <= 1000 ? limit : 200;
  const r = await q(deps)(
    `SELECT id, user_id, log_date, metric, value, source
       FROM activity_logs
      WHERE company_id = $1
        AND ($2::text IS NULL OR log_date >= $2)
        AND ($3::text IS NULL OR log_date <= $3)
      ORDER BY log_date DESC LIMIT $4`,
    [companyId, from, to, n],
  );
  return r.rows.map((a) => Object.freeze({
    id: a.id, userId: a.user_id, logDate: a.log_date, metric: a.metric,
    value: Number(a.value), source: a.source,
  }));
}

// ── WHAT IS NOT YET ATTRIBUTED, STATED RATHER THAN HIDDEN ───────────────────

/**
 * How many rows in each scoped table have no company ownership.
 *
 * Exported because the honest answer to "why is this briefing empty" has to be available to the
 * briefing itself and to an operator, not buried in a migration note. A caller that reports a zero
 * without reporting that 4,000 rows are unattributed is reporting a number it cannot support.
 *
 * Deliberately NOT company-scoped — it counts NULLs, which belong to nobody — so it takes a context
 * only to prove the caller has one.
 */
async function unattributedCounts(ctx, deps = {}) {
  companyOf(ctx);
  const tables = ['daily_tasks', 'performance_scores', 'weekly_kpis', 'activity_logs',
    'milestones', 'targets', 'orders'];
  const out = {};
  for (const t of tables) {
    // The table name comes from this module's own frozen list, never from a caller.
    const r = await q(deps)(`SELECT COUNT(*)::int n FROM ${t} WHERE company_id IS NULL`);
    out[t] = r.rows[0].n;
  }
  return Object.freeze(out);
}

module.exports = {
  employeesOf,
  tasksFor,
  assignTask,
  completeTask,
  scoresFor,
  milestonesFor,
  revenueFor,
  activityFor,
  unattributedCounts,
  UNKNOWN,
};
