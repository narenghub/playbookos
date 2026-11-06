// ── WRITING AND READING THE PRPA AUDIT TRAIL ─────────────────────────────────
//
// Two functions. `record` appends one event; `history` assembles everything known about one
// opportunity from the four places it is kept.
//
// `record` NEVER THROWS. An audit write that fails must not take the operation down with it — a
// deadline confirmed but unlogged is a smaller problem than a deadline that could not be confirmed
// because the log was full. But it must not fail SILENTLY either, so a failure is returned and the
// caller reports it. The one thing it may not do is pretend to have written.

'use strict';

const crypto = require('crypto');
const { AUDIT_ACTIONS } = require('./opportunity-audit-schema');
const { isoDay } = require('./iso-day');

const id = (p) => `${p}-${crypto.randomBytes(8).toString('hex')}`;

/**
 * Append one audit event.
 *
 * @returns {{ok: true, id: string} | {ok: false, error: string}}
 */
async function record(q, {
  companyId, opportunityId = null, action, actor, actorRole = null, detail = {},
}) {
  // Validated here as well as in the CHECK constraint. The constraint is the thing that holds, but
  // a bad action name should be a legible error at the call site rather than a Postgres violation
  // surfacing from three frames down.
  if (!AUDIT_ACTIONS.includes(action)) {
    return { ok: false, error: `unknown audit action "${action}" — add it to AUDIT_ACTIONS and the CHECK constraint together` };
  }
  if (!companyId) return { ok: false, error: 'companyId is required' };
  if (!actor || !String(actor).trim()) return { ok: false, error: 'actor is required' };

  try {
    const r = await q(
      `INSERT INTO opportunity_audit_events (id, company_id, opportunity_id, action, actor, actor_role, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
      [id('audit'), companyId, opportunityId, action, String(actor).trim(), actorRole,
        JSON.stringify(detail || {})],
    );
    return { ok: true, id: r.rows[0].id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Everything known about one opportunity, for the detail view and for a reviewer reconstructing a
 * verdict. Four queries rather than one join: a join across three one-to-many histories multiplies
 * rows, and the row counts here are small.
 */
async function history(q, companyId, opportunityId) {
  const current = (await q(
    `SELECT * FROM federal_opportunities WHERE company_id = $1 AND id = $2`,
    [companyId, opportunityId])).rows[0] || null;
  if (!current) return null;

  // Every version of this solicitation, superseded ones included — that is the point of keeping them.
  const versions = (await q(
    `SELECT id, version_seq, is_current, title, response_deadline, deadline_confirmed_at,
            status, notice_type, set_aside, content_hash, first_seen_at, observed_at
       FROM federal_opportunities
      WHERE company_id = $1 AND solicitation_number = $2
      ORDER BY version_seq`,
    [companyId, current.solicitation_number])).rows;

  const assessments = (await q(
    `SELECT id, assessed_by, verdict, evidence_basis, business_lines, reasons,
            missing_requirements, assessed_at
       FROM opportunity_assessments
      WHERE company_id = $1 AND opportunity_id = ANY($2)
      ORDER BY assessed_at DESC`,
    [companyId, versions.map((v) => v.id)])).rows;

  const reviews = (await q(
    `SELECT id, decision, decided_by, decided_at, rationale
       FROM opportunity_bid_reviews
      WHERE company_id = $1 AND opportunity_id = ANY($2)
      ORDER BY decided_at DESC`,
    [companyId, versions.map((v) => v.id)])).rows;

  const events = (await q(
    `SELECT id, action, actor, actor_role, at, detail
       FROM opportunity_audit_events
      WHERE company_id = $1 AND opportunity_id = ANY($2)
      ORDER BY at DESC`,
    [companyId, versions.map((v) => v.id)])).rows;

  const duplicates = (await q(
    `SELECT * FROM opportunity_duplicate_candidates
      WHERE company_id = $1 AND (opportunity_id = ANY($2) OR other_id = ANY($2))`,
    [companyId, versions.map((v) => v.id)])).rows;

  return {
    opportunity: current,
    versions: versions.map((v) => ({
      ...v,
      response_deadline: isoDay(v.response_deadline),
      deadline_confirmed: Boolean(v.deadline_confirmed_at),
    })),
    assessments,
    reviews,
    audit_events: events,
    duplicate_candidates: duplicates,
  };
}

/** Recent activity across the whole tracker, for the dashboard's activity strip. */
async function recent(q, companyId, limit = 50) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return (await q(
    `SELECT e.id, e.action, e.actor, e.actor_role, e.at, e.detail,
            e.opportunity_id, o.solicitation_number, o.title
       FROM opportunity_audit_events e
       LEFT JOIN federal_opportunities o
              ON o.id = e.opportunity_id AND o.company_id = e.company_id
      WHERE e.company_id = $1
      ORDER BY e.at DESC
      LIMIT $2`,
    [companyId, n])).rows;
}

module.exports = { record, history, recent, AUDIT_ACTIONS };
