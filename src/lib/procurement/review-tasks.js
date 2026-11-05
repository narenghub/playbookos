'use strict';
// ── PR-6b: REVIEW TASKS — ASSIGNMENT WITHOUT AUTHORITY ───────────────────────
//
// Owner, priority, due date, status. The ruling's constraint is the design: "Assignment must not
// grant approval or trigger external actions."
//
// ── WHY THIS MODULE IS SAFE TO GIVE PEOPLE ──────────────────────────────────
//
// A review queue that can assign work is one small step from a review queue that can approve it,
// and the step is usually taken by accident — a status called 'approved', a field called
// `authorised_by`, a "mark resolved" that something downstream reads as consent. So:
//
//   • There is no approval column, and no function here writes to office_approvals.
//   • The status vocabulary CANNOT EXPRESS A DECISION: open, in_progress, blocked, done,
//     cancelled. No 'approved', no 'rejected'. A word that is unstoreable cannot be misread.
//   • A task points at a blocked CRITERION — work to do — not at an action to take.
//   • Closing one requires a name and a note, because "done" with neither is how a queue looks
//     complete without anybody having looked.
//
// This module is the single exception to views.js being read-only, and it is deliberately a
// separate file so that "the view layer writes nothing" stays a true sentence.

const { CRITERIA } = require('./qualify');

const PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);
const STATUSES = Object.freeze(['open', 'in_progress', 'blocked', 'done', 'cancelled']);
const LIVE_STATUSES = Object.freeze(['open', 'in_progress', 'blocked']);
const CLOSED_STATUSES = Object.freeze(['done', 'cancelled']);
const SUBJECT_KINDS = Object.freeze(['procurement_opportunity', 'funding_opportunity', 'capability']);

// Words this module refuses to store, whatever a caller asks. Checked rather than assumed, because
// the failure is silent: a status of 'approved' would be accepted by a looser CHECK and then read
// as consent by the next thing that joins this table.
const FORBIDDEN_STATUS_WORDS = Object.freeze(['approved', 'approve', 'rejected', 'authorised',
  'authorized', 'granted', 'signed', 'submitted', 'sent']);

const { assertContext } = require('../office/context');
function lazyQuery() { return require('../db').query; }
function q(deps) { return (deps && deps.query) || lazyQuery(); }
const newId = () => require('crypto').randomUUID();

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = (v) => (typeof v === 'string' && ISO_DAY.test(v.trim()) ? v.trim() : null);

/**
 * Priority suggested by a blocked finding. Advisory only — a human may change it, and the function
 * exists so a queue of 40 items arrives ordered rather than alphabetical.
 *
 * It is NOT a score. Three bands, each with a stated reason.
 */
function suggestedPriority({ criterionKey, deadline, asOf }) {
  const day = isoDay(asOf);
  const dl = isoDay(deadline);
  if (dl && day) {
    const days = Math.round((Date.parse(`${dl}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 864e5);
    if (days <= 7) return { priority: 'urgent', reason: `the deadline is ${days} day(s) away` };
    if (days <= 21) return { priority: 'high', reason: `the deadline is ${days} day(s) away` };
  }
  // A registration gate blocks EVERY opportunity, so it outranks a per-opportunity gap even with a
  // distant deadline.
  if (criterionKey === 'sam_registration') {
    return { priority: 'high', reason: 'registration blocks every opportunity, not just this one' };
  }
  return { priority: 'normal', reason: 'no deadline pressure recorded' };
}

/**
 * Open a review task for a blocked finding. Idempotent by the partial unique index: a second live
 * task for the same subject and criterion is refused by the database rather than created, so two
 * people cannot be assigned the same work and discover it afterwards.
 */
async function openTask(ctx, spec, deps = {}) {
  assertContext(ctx);
  const {
    subjectKind, subjectId, criterionKey = null, assessmentId = null, approvalId = null,
    title, detail = null, ownerUserId = null, priority = 'normal', dueDate = null,
  } = spec || {};

  if (!SUBJECT_KINDS.includes(subjectKind)) {
    throw new Error(`openTask: subjectKind must be one of ${SUBJECT_KINDS.join(', ')}; got ${subjectKind}`);
  }
  if (!subjectId) throw new Error('openTask: subjectId is required');
  if (!title || !String(title).trim()) throw new Error('openTask: title is required');
  if (!PRIORITIES.includes(priority)) {
    throw new Error(`openTask: priority must be one of ${PRIORITIES.join(', ')}; got ${priority}`);
  }
  if (dueDate && !isoDay(dueDate)) throw new Error('openTask: dueDate must be YYYY-MM-DD');
  if (criterionKey && !CRITERIA.some((c) => c.key === criterionKey)) {
    // A task naming a criterion that does not exist would never close, because nothing would ever
    // report it as resolved.
    throw new Error(`openTask: "${criterionKey}" is not a qualification criterion`);
  }

  const id = newId();
  const { rows } = await q(deps)(
    `INSERT INTO review_tasks
       (id, company_id, subject_kind, subject_id, criterion_key, assessment_id, approval_id,
        title, detail, owner_user_id, priority, due_date, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open')
     RETURNING id, status, priority, owner_user_id, due_date`,
    [id, ctx.companyId, subjectKind, subjectId, criterionKey, assessmentId, approvalId,
      String(title).trim(), detail, ownerUserId, priority, isoDay(dueDate)]);
  return rows[0];
}

/**
 * Change owner, priority, due date or status. Deliberately the ONLY mutation surface, and it
 * cannot reach a column that confers authority — there is no such column.
 */
async function updateTask(ctx, taskId, patch, deps = {}) {
  assertContext(ctx);
  const sets = [];
  const values = [taskId, ctx.companyId];
  const add = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

  if ('ownerUserId' in patch) add('owner_user_id', patch.ownerUserId || null);
  if ('priority' in patch) {
    if (!PRIORITIES.includes(patch.priority)) throw new Error(`updateTask: bad priority ${patch.priority}`);
    add('priority', patch.priority);
  }
  if ('dueDate' in patch) {
    if (patch.dueDate && !isoDay(patch.dueDate)) throw new Error('updateTask: dueDate must be YYYY-MM-DD');
    add('due_date', isoDay(patch.dueDate));
  }
  if ('status' in patch) {
    const s = String(patch.status || '').toLowerCase();
    if (FORBIDDEN_STATUS_WORDS.includes(s)) {
      throw new Error(`updateTask: "${patch.status}" is not a task status and never will be. `
        + 'Assignment grants no approval; approval lives in office_approvals behind the gate.');
    }
    if (!STATUSES.includes(patch.status)) {
      throw new Error(`updateTask: status must be one of ${STATUSES.join(', ')}; got ${patch.status}`);
    }
    add('status', patch.status);
    if (CLOSED_STATUSES.includes(patch.status)) {
      if (!patch.closedBy || !String(patch.closedBy).trim()) {
        throw new Error('updateTask: closing a task requires closedBy — "done" with no name is an audit gap');
      }
      if (!patch.closureNote || !String(patch.closureNote).trim()) {
        throw new Error('updateTask: closing a task requires closureNote — the reason is the record');
      }
      add('closed_by', String(patch.closedBy).trim());
      add('closure_note', String(patch.closureNote).trim());
      sets.push('closed_at = NOW()');
    } else {
      // Reopening clears the closure, so a reopened task never carries a stale "resolved by".
      sets.push('closed_at = NULL', 'closed_by = NULL', 'closure_note = NULL');
    }
  }
  if (!sets.length) throw new Error('updateTask: nothing to change');
  sets.push('updated_at = NOW()');

  const { rows } = await q(deps)(
    `UPDATE review_tasks SET ${sets.join(', ')}
      WHERE id = $1 AND company_id = $2
      RETURNING id, status, priority, owner_user_id, due_date, closed_by, closure_note`,
    values);
  if (!rows.length) throw new Error(`updateTask: no task ${taskId} for this company`);
  return rows[0];
}

/** Live tasks, optionally for one owner. Read-only. */
async function listTasks(ctx, { ownerUserId = null, includeClosed = false, limit = 200 } = {}, deps = {}) {
  assertContext(ctx);
  const values = [ctx.companyId];
  let filter = includeClosed ? '' : ` AND status = ANY($${values.push(LIVE_STATUSES)})`;
  if (ownerUserId) filter += ` AND owner_user_id = $${values.push(ownerUserId)}`;
  values.push(Math.max(1, Math.min(1000, limit)));
  const { rows } = await q(deps)(
    `SELECT id, subject_kind, subject_id, criterion_key, assessment_id, approval_id,
            title, detail, owner_user_id, priority, due_date, status,
            created_at, updated_at, closed_at, closed_by, closure_note
       FROM review_tasks
      WHERE company_id = $1${filter}
      ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               (due_date IS NULL), due_date, created_at
      LIMIT $${values.length}`, values);
  return rows;
}

module.exports = {
  PRIORITIES,
  STATUSES,
  LIVE_STATUSES,
  CLOSED_STATUSES,
  SUBJECT_KINDS,
  FORBIDDEN_STATUS_WORDS,
  suggestedPriority,
  openTask,
  updateTask,
  listTasks,
};
