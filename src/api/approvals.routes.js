// ── THE ONE DOOR A HUMAN DECIDES THROUGH ─────────────────────────────────────
//
//   GET  /api/approvals            →  what is waiting, with enough to triage
//   GET  /api/approvals/:id        →  the exact message, the terms, and why it may be invalid
//   POST /api/approvals/:id/decide →  approve or reject THIS immutable payload
//
// CEO decision 2026-11-11 priority 2.
//
// ── APPROVING IS NOT SENDING, AND THIS ROUTE CANNOT SEND ─────────────────────
//
// There is no release here and no transmit. approve() moves office_approvals.status to 'approved'
// and stops. Something must then CLAIM that approval through approval.release(), recheck every
// STOP, and reach a provider — and today the external-email HOLD refuses that last step, so an
// approved buyer letter still goes nowhere.
//
// That separation is deliberate and worth keeping. A human decides whether the content is right;
// the platform decides whether sending is permitted right now. Collapsing the two would mean a
// click on a review screen was also an override of a containment hold.
//
// src/api/decisions.routes.js argues at length for having NO write route, and is right about
// itself: "a convenience approve here would be a second door into it." This is not that second
// door — it is the first one, dedicated, and the queue still only points at it.
//
// ── WHAT A REVIEWER MUST BE ABLE TO SEE ──────────────────────────────────────
//
// The frozen payload is the artefact, so the detail route serves THE RENDERED HTML ITSELF rather
// than a description of it. A reviewer approving a quotation must read the quotation, not a
// summary of one: the whole mechanism rests on the artefact a human read being the artefact that
// gets executed, and a summary would break that at the only point where it matters.
//
// It also serves the staleness and validity verdict. "Why can I not approve this" is a question
// the screen must answer on the screen; an operator who cannot see the reason concludes the
// system is broken and looks for a way around it.

'use strict';

const express = require('express');
const { query } = require('../lib/db');
const { authMiddleware, adminOnly } = require('../lib/core');
const SCOPE = require('../lib/office/scope');
const APPROVAL = require('../lib/agents/buyer-email-approval');
const { resolveCompanyForReadSession } = require('../lib/office/context');

const router = express.Router();

// ── SELF-APPROVAL ────────────────────────────────────────────────────────────
//
// The ruling says "prevent self-approval where the applicable policy prohibits it", and the
// honest position is that this company has no such policy yet AND one admin. Naresh is both the
// resolved signatory on a buyer letter and the only account that can approve one, so enforcing a
// block by default would make every approval impossible — a control that stops all work is
// removed within a week and teaches everyone that controls are obstacles.
//
// So self-approval is always DETECTED, always REPORTED on the screen, and always recorded in the
// stored resolution, and it is REFUSED only when APPROVAL_FORBID_SELF is set. The fact is never
// hidden; whether it blocks is a policy decision with a switch, and turning that switch on
// requires a second person to exist first.
const FORBID_SELF = () => String(process.env.APPROVAL_FORBID_SELF || '').toLowerCase() === 'true';

function isSelfApproval(row, actor) {
  const owner = String(row.owner_user_id || '').trim().toLowerCase();
  if (!owner) return false;
  const signed = String((row.action_payload || {}).signed_by_email || '').trim().toLowerCase();
  const signedId = String((row.action_payload || {}).signed_by_user_id || '').trim().toLowerCase();
  const me = [String(actor.id || '').trim().toLowerCase(), String(actor.email || '').trim().toLowerCase()]
    .filter(Boolean);
  return me.some((m) => m === owner || m === signed || m === signedId);
}

/**
 * Why this approval may not be actionable, from the row alone.
 *
 * Reported for a PENDING row too, because an approval that has already gone stale is exactly the
 * one a reviewer should not be nudged into granting.
 */
function validity(row, { now = new Date(), ttlMinutes = APPROVAL.APPROVAL_TTL_MINUTES } = {}) {
  const reasons = [];
  if (row.status === 'rejected') reasons.push({ code: 'rejected', detail: 'already rejected' });
  if (row.status === 'superseded') {
    reasons.push({ code: 'superseded',
      detail: 'superseded after approval and before any external execution; terminal, a new '
        + 'preparation is required' });
  }
  if (row.status === 'expired') reasons.push({ code: 'expired', detail: 'expired' });
  if (row.released_at) {
    reasons.push({ code: 'already_released',
      detail: `claimed for execution at ${new Date(row.released_at).toISOString()} — one decision `
        + 'authorises one send' });
  }
  if (row.status === 'approved' && row.resolved_at) {
    const age = (now.getTime() - new Date(row.resolved_at).getTime()) / 60000;
    if (age > ttlMinutes) {
      reasons.push({ code: 'stale',
        detail: `approved ${Math.round(age)} minutes ago, past the ${ttlMinutes}-minute limit; it `
          + 'will be refused at release and needs re-preparing' });
    }
  }
  const payload = row.action_payload || {};
  if (row.action_kind === APPROVAL.ACTION_KIND && !payload.transport_digest) {
    reasons.push({ code: 'no_digest',
      detail: 'this payload records no transport digest, so nothing can tie it to the bytes that '
        + 'would be sent; it will be refused at release' });
  }
  if (row.action_kind === APPROVAL.ACTION_KIND
      && !payload.signed_by_email && !payload.signed_by_user_id) {
    reasons.push({ code: 'no_signatory',
      detail: 'this payload records no signatory, so there is no way to verify that whoever the '
        + 'letter claims to be from still holds authority; it will be refused at release' });
  }
  return { actionable: row.status === 'pending' && reasons.length === 0, reasons };
}

/**
 * What happened to this approval after it was granted. Read from the outbound ledger.
 *
 * An UNKNOWN transmission state is reported as unknown, never as "not sent" — ledger.js exists
 * because a crash between the claim and the provider's answer leaves a message that may have gone
 * and nobody knows, and folding that into failure is how a sent message is recorded as unsent.
 */
async function transmission(approvalId, deps = {}) {
  const q = deps.query || query;
  try {
    const rows = (await q(
      `SELECT id, to_email, subject, outcome, status, stop_scope, error_message,
              provider_message_id, provider_responded_at, claimed_at, sent_at
         FROM email_log WHERE approval_id = $1 ORDER BY sent_at`, [approvalId])).rows;
    if (!rows.length) {
      return { observed: false, state: 'NOT_ATTEMPTED',
        why: 'no outbound attempt carries this approval id' };
    }
    const MAY = new Set(require('../lib/outbound/ledger').MAY_HAVE_LEFT);
    const left = rows.filter((r) => MAY.has(r.outcome));
    return {
      observed: true,
      state: left.length ? 'MAY_HAVE_LEFT' : 'NOT_TRANSMITTED',
      attempts: rows,
    };
  } catch (e) {
    // A missing or unreadable ledger is not "nothing was sent".
    return { observed: false, state: 'UNKNOWN',
      why: `the outbound ledger could not be read (${e.message}) — this is NOT evidence that `
        + 'nothing was transmitted' };
  }
}

// Everything a reviewer needs to triage, and nothing they do not. The rendered html is served
// only by the detail route: a list carrying every message body is a copy of all correspondence.
function summarise(row) {
  const p = row.action_payload || {};
  return {
    id: row.id,
    action_kind: row.action_kind,
    status: row.status,
    reason: row.reason,
    created_at: row.created_at,
    owner_user_id: row.owner_user_id || null,
    company_id: row.company_id,
    run_id: row.run_id,
    workflow: p.workflow || null,
    from: p.from || null,
    to: p.to || null,
    cc: p.cc || null,
    subject: p.subject || null,
    display_name: p.display_name || null,
    signed_by: p.signed_by_email || p.signed_by_user_id || null,
    commercial: p.commercial || null,
    transport_digest: p.transport_digest || null,
    inquiry_id: p.inquiry_id || null,
  };
}

// Company from the kernel's own read-session resolver, keyed on the authenticated user. NOT a
// slug default: context.js refuses when two active companies exist rather than showing a person a
// tenant that may not be theirs, and a default here would be exactly that.
async function companyOr503(req, res) {
  try {
    return await resolveCompanyForReadSession({ userId: req.user && req.user.id }, { query });
  } catch (e) {
    res.status(503).json({ error: e.message, code: 'no_company_context',
      detail: 'approvals are company-scoped and the company for this session could not be '
        + 'established; this is NOT an empty queue' });
    return null;
  }
}

// ── LIST ─────────────────────────────────────────────────────────────────────
router.get('/approvals', authMiddleware, adminOnly, async (req, res) => {
  const ctx = await companyOr503(req, res);
  if (!ctx) return undefined;
  try {
    const want = String(req.query.status || 'pending').toLowerCase();
    const statuses = want === 'all'
      ? ['pending', 'approved', 'rejected', 'superseded', 'expired']
      : [want];
    // Through the accessor. The scope-discipline check refused the inline query within minutes,
    // and its message is the argument: a company predicate written here is one somebody can
    // forget, and forgetting it on THIS read would show one tenant another's held letters.
    const rows = await SCOPE.approvalsForReview(ctx, { statuses }, { query });

    return res.json({
      company_id: ctx.companyId,
      count: rows.length,
      // Stated on the response rather than only in this file, so a client cannot present this as
      // a send queue.
      note: 'Approving does not send. A released approval must still pass every STOP at the '
          + 'transport, and the external-email HOLD currently refuses that step.',
      approvals: rows.map((r) => ({
        ...summarise(r),
        self_approval: isSelfApproval(r, req.user || {}),
        validity: validity(r),
      })),
    });
  } catch (e) {
    const missing = /relation "office_approvals" does not exist/i.test(e.message);
    return res.status(missing ? 503 : 500).json({
      error: missing ? 'the office kernel has not been migrated — this is NOT an empty queue'
        : e.message,
      code: missing ? 'kernel_missing' : 'approvals_read_failed',
    });
  }
});

// ── DETAIL: THE ARTEFACT ITSELF ──────────────────────────────────────────────
router.get('/approvals/:id', authMiddleware, adminOnly, async (req, res) => {
  const ctx = await companyOr503(req, res);
  if (!ctx) return undefined;
  try {
    const row = await SCOPE.approvalForReview(ctx, req.params.id, { query });

    // Company-scoped, so "another company's approval" and "no such approval" are the same answer.
    if (!row) return res.status(404).json({ error: 'no such approval for this company' });

    const p = row.action_payload || {};
    return res.json({
      ...summarise(row),
      resolved_at: row.resolved_at, resolved_by: row.resolved_by, resolution: row.resolution,
      released_at: row.released_at, released_by: row.released_by,
      self_approval: isSelfApproval(row, req.user || {}),
      validity: validity(row),
      // THE ARTEFACT. A reviewer approving a quotation must read the quotation.
      html: p.html || null,
      body_text: p.body_text || null,
      attachments: p.attachments || [],
      transmission: await transmission(row.id),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, code: 'approval_read_failed' });
  }
});

// ── DECIDE ───────────────────────────────────────────────────────────────────
router.post('/approvals/:id/decide', authMiddleware, adminOnly, async (req, res) => {
  const ctx = await companyOr503(req, res);
  if (!ctx) return undefined;

  const decision = String((req.body || {}).decision || '').toLowerCase();
  const resolution = String((req.body || {}).resolution || '').trim();
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
  }
  // A decision nobody can account for later is worth little more than no decision, and this is
  // the operator-facing surface the scope.js note had in mind when it said the script requires one.
  if (!resolution) {
    return res.status(400).json({ error: 'a resolution is required: it is the record of WHY this '
      + 'was approved or rejected, and it is what an audit reads' });
  }

  try {
    const row = await SCOPE.approvalForReview(ctx, req.params.id, { query });
    if (!row) return res.status(404).json({ error: 'no such approval for this company' });

    const self = isSelfApproval(row, req.user || {});
    if (self && decision === 'approved' && FORBID_SELF()) {
      return res.status(403).json({
        error: 'self-approval is forbidden by policy (APPROVAL_FORBID_SELF)',
        code: 'self_approval_forbidden', self_approval: true,
        detail: 'this approval names you as its owner or as the signatory of the letter; another '
          + 'authorised person must decide it',
      });
    }

    const v = validity(row);
    if (!v.actionable) {
      return res.status(409).json({
        error: 'this approval is not in a state that can be decided',
        code: 'not_actionable', status: row.status, validity: v,
      });
    }

    // Arbitrated in ONE statement on status='pending'. A prior SELECT the caller is trusted to
    // have done is not arbitration: two reviewers clicking at once would both see 'pending'.
    const decided = await SCOPE.decideApproval(ctx, {
      id: row.id,
      decision,
      resolvedBy: (req.user && (req.user.email || req.user.id)) || 'unknown',
      // The self-approval fact is stored with the verdict, not merely displayed. A screen can be
      // changed; the record is what an audit reads.
      resolution: self ? `${resolution}  [self-approval: decided by the owner/signatory]` : resolution,
    });

    if (!decided) {
      // The WHERE clause refused it, which means somebody else decided it first.
      const now = await SCOPE.approvalForReview(ctx, row.id, { query });
      // Three fields, not the row. The accessor returns the full record including the rendered
      // message, and spreading that into a 409 would put the most disclosing payload in this
      // platform into an error body — which is the sort of place nobody thinks to look for it.
      return res.status(409).json({ error: 'this approval was already decided',
        code: 'already_decided',
        current: now
          ? { status: now.status, resolved_by: now.resolved_by, resolved_at: now.resolved_at }
          : null });
    }

    return res.json({
      ...decided,
      self_approval: self,
      // Said on every successful decision, because this is the moment a person is most likely to
      // believe the message has gone.
      sent: false,
      note: decision === 'approved'
        ? 'Approved. NOTHING HAS BEEN SENT. The approval must still be claimed through release, '
          + 'which rechecks every STOP — and the external-email HOLD currently refuses that step.'
        : 'Rejected. Nothing was sent and this payload is now terminal.',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, code: 'approval_decide_failed' });
  }
});

module.exports = router;
module.exports.validity = validity;
module.exports.isSelfApproval = isSelfApproval;
module.exports.summarise = summarise;
