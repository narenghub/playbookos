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
// ── THE SIX STATES THE SCREEN SHOWS ─────────────────────────────────────────
//
// pending · approved · dispatching · delivered_to_provider · blocked · failed
//
// `dispatching` is the only one that is not a property of the row: it exists for the window
// between the click and the answer, and it is the browser's to hold. Everything else is decided
// here, from the row, so the screen renders a verdict rather than computing one.
//
// delivered_to_provider is named for what it means. The provider acknowledged and returned an id;
// that is acknowledgement, NOT proof that anybody received anything, and a state called "sent"
// would quietly claim more than is known.
function uiStateOf(row) {
  if (row.status === 'pending') return 'pending';
  if (row.status === 'rejected' || row.status === 'superseded' || row.status === 'expired') return 'blocked';
  if (row.released_at) return 'delivered_or_unknown';
  if (row.status === 'approved') return 'approved';
  return 'blocked';
}

/**
 * May this screen dispatch this artefact?
 *
 * Only an approved, unreleased OUTREACH approval. A buyer quotation is excluded deliberately: the
 * inquiry agent releases those after re-comparing the commercial terms against current figures,
 * and releasing one from here would skip that comparison — approving one offer and sending another
 * with extra steps.
 */
function canDispatch(row) {
  const OUTREACH = require('../lib/agents/outreach-approval');
  if (row.action_kind !== OUTREACH.ACTION_KIND) return false;
  if (row.status !== 'approved') return false;
  if (row.released_at) return false;
  return true;
}

function validity(row, { now = new Date(), ttlMinutes = APPROVAL.APPROVAL_TTL_MINUTES } = {}) {
  const reasons = [];
  if (row.status === 'rejected') {
    reasons.push({ code: 'rejected',
      detail: 'already rejected; rejection is terminal and a new preparation is required' });
  }
  if (row.status === 'superseded') {
    reasons.push({ code: 'superseded',
      detail: 'superseded after approval and before any external execution; terminal, a new '
        + 'preparation is required' });
  }
  if (row.status === 'expired') {
    reasons.push({ code: 'expired',
      detail: 'this action expired before anyone decided it; it is terminal and the work needs '
        + 're-preparing with current figures' });
  }
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
      // ── THE STATE, NAMED BY THE SERVER ─────────────────────────────────────
      //
      // Not inferred by the browser from status + released_at + action_kind. Two readers of the
      // same row would otherwise disagree about which of the six states it is in, and this screen
      // is where an operator forms their belief about whether a message went out.
      ui_state: uiStateOf(row),
      can_dispatch: canDispatch(row),
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

// ── DISPATCH ─────────────────────────────────────────────────────────────────
//
//   POST /api/approvals/:id/dispatch
//
// Spec A milestone 6 last mile: the action that connects an approved decision to the frozen payload
// and the governed dispatch path.
//
// ── WHY THIS IS A SECOND ACT AND NOT PART OF /decide ─────────────────────────
//
// The header of this file argues that approving is not sending, and that collapsing the two would
// make a click on a review screen an override of a containment hold. That argument still holds, so
// this does NOT fold dispatch into the approve decision. It is a separate, deliberate request
// against an ALREADY approved artefact.
//
// What it is not: an override. Every gate still runs underneath it, and the STOPs still refuse.
// With capability:email.send held, pressing this button reports STOPPED_BY_POLICY and transmits
// nothing — which is the correct and observable behaviour, not a failure of the button.
//
// ── WHAT GUARANTEES WHAT ─────────────────────────────────────────────────────
//
// ONE-TIME RELEASE     approval.release() claims the row in one arbitrated statement; a second
//                      request gets already_released and never reaches a provider. Two reviewers
//                      clicking at once is the case that statement exists for, and it is why no
//                      prior SELECT here is treated as arbitration.
// DIGEST               release recomputes it from the stored payload and compares with the frozen
//                      value; dispatch recomputes it from the bytes it is about to transmit; the
//                      sender service recomputes it a third time from the request body.
// IDEMPOTENCY          the key is derived from the APPROVAL ID, so a duplicate click, a retried
//                      request and a double-submitted form all collapse onto one ledger claim and
//                      the second is refused rather than resent.
// STOPS                dispatch's gate, then the sender service's own read of autonomy_stops.
// CONCURRENCY          the release claim is the serialisation point. Nothing here depends on the
//                      UI disabling a button — that is a courtesy to the operator, not a control.
router.post('/approvals/:id/dispatch', authMiddleware, adminOnly, async (req, res) => {
  const ctx = await companyOr503(req, res);
  if (!ctx) return undefined;

  const actor = (req.user && (req.user.email || req.user.id)) || null;
  if (!actor) {
    return res.status(401).json({ error: 'a releasing actor is required', code: 'no_actor' });
  }

  let row;
  try {
    row = await SCOPE.approvalForReview(ctx, req.params.id, { query });
  } catch (e) {
    return res.status(500).json({ error: e.message, code: 'approval_read_failed' });
  }
  if (!row) return res.status(404).json({ error: 'no such approval for this company' });

  // Only an APPROVED artefact may be dispatched. Reported with the state so the screen can say
  // which of the six it is in rather than "failed".
  if (row.status !== 'approved') {
    return res.status(409).json({
      error: `this approval is ${row.status}, so there is nothing to dispatch`,
      code: 'not_approved', status: row.status, ui_state: row.status === 'pending' ? 'pending' : 'blocked',
      validity: validity(row), provider_invocations: 0,
    });
  }
  const v = validity(row);
  if (v.reasons.some((r) => r.code === 'already_released')) {
    // The courteous answer to a duplicate click that arrives before the first has finished. The
    // actual guarantee is the release claim below; this is only a clearer message.
    return res.status(409).json({
      error: 'this approval has already been claimed for execution — one decision authorises one send',
      code: 'already_released', ui_state: 'delivered_or_unknown', validity: v, provider_invocations: 0,
    });
  }

  // ── WHICH LIFECYCLE OWNS THIS ARTEFACT ────────────────────────────────────
  //
  // Two action kinds, two modules, and the wrong one must not be able to release the other's
  // payload: each release() checks the action kind it was handed, and an approval for anything
  // else is refused rather than coerced.
  const OUTREACH = require('../lib/agents/outreach-approval');
  const kind = row.action_kind;
  const lifecycle = kind === OUTREACH.ACTION_KIND ? OUTREACH : null;
  if (!lifecycle) {
    return res.status(400).json({
      error: `this screen cannot dispatch an approval of kind ${JSON.stringify(kind)}`,
      code: 'unsupported_action_kind', action_kind: kind, provider_invocations: 0,
      detail: kind && kind.startsWith('buyer.email')
        ? 'buyer quotations are released by the inquiry agent, which re-checks the commercial terms '
          + 'against current figures — releasing one from here would skip that comparison'
        : undefined,
    });
  }

  // ── RELEASE: ONE DECISION, ONE SEND ───────────────────────────────────────
  let released;
  try {
    released = await lifecycle.releaseOutreachEmail(ctx, { approvalId: row.id, releasedBy: actor },
      { query });
  } catch (e) {
    return res.status(500).json({ error: e.message, code: 'release_failed', provider_invocations: 0 });
  }
  if (!released.released) {
    const blocked = ['approved_payload_altered', 'wrong_action_kind', 'approval_stale'];
    return res.status(409).json({
      error: `the approved message could not be released: ${released.reason}`,
      code: released.reason, detail: released.detail || null,
      ui_state: blocked.includes(released.reason) ? 'blocked' : 'failed',
      provider_invocations: 0,
    });
  }

  // ── DISPATCH: EVERY GATE, UNDERNEATH ──────────────────────────────────────
  //
  // The idempotency key is derived from the APPROVAL, not from this request, so a duplicate click
  // and a retry collapse onto one claim.
  const { dispatch } = require('../lib/outbound/dispatch');
  let sent;
  try {
    sent = await dispatch({
      message: released.message,
      transport: released.transport,
      idempotencyKey: `approval:${row.id}`,
      approvalId: released.approvalId,
      expectedDigest: released.expectedDigest,
      workflow: row.workflow || null,
      agent: row.agent || null,
      companyId: ctx.companyId || null,
    });
  } catch (e) {
    // A throw out of dispatch means nothing is known about whether the provider received it.
    return res.status(502).json({
      error: `the outcome is unknown: ${e.message}`, code: 'outcome_unknown',
      ui_state: 'failed', provider_responded: false, dispatched: true,
      detail: 'the message may or may not have been transmitted; the ledger row is the authority '
        + 'and this will never be retried automatically',
    });
  }

  // ── THE SIX UI STATES, NAMED HERE RATHER THAN INFERRED BY THE SCREEN ──────
  //
  // The browser must not be deciding what a phase means: two readers of the same response would
  // then disagree, and the screen is where an operator forms their belief about whether a message
  // went out.
  if (sent.ok) {
    return res.json({
      ok: true, ui_state: 'delivered_to_provider',
      approval_id: row.id, provider_id: sent.id, digest: sent.digest,
      transport: sent.transport, meta: sent.meta || null,
      provider_invocations: 1,
      detail: 'the provider acknowledged and returned an id. That is acknowledgement, NOT proof of '
        + 'inbox delivery, and the state name says so.',
    });
  }
  if (sent.stopped) {
    return res.status(409).json({
      ok: false, ui_state: 'blocked', code: 'stopped_by_policy', error: sent.error,
      approval_id: row.id, provider_invocations: 0,
      detail: 'a STOP refused this. The approval is spent either way — one decision authorises one '
        + 'attempt — so lifting the stop requires a fresh preparation and a fresh decision.',
    });
  }
  if (sent.phase === 'refused_duplicate') {
    return res.status(409).json({
      ok: false, ui_state: 'delivered_or_unknown', code: 'refused_duplicate', error: sent.error,
      approval_id: row.id, duplicate_of: sent.duplicateOf || null, provider_invocations: 0,
      detail: 'a message under this approval already claimed responsibility, so this was not sent '
        + 'again. Check the ledger row for what became of the first attempt.',
    });
  }
  if (sent.dispatched) {
    return res.status(502).json({
      ok: false, ui_state: 'failed', code: sent.phase, error: sent.error,
      approval_id: row.id, provider_responded: !!sent.providerResponded,
      detail: sent.providerResponded
        ? 'the provider answered and refused it; nothing was transmitted'
        : 'the outcome is unknown and will never be retried automatically',
    });
  }
  return res.status(409).json({
    ok: false, ui_state: 'blocked', code: sent.phase, error: sent.error,
    approval_id: row.id, provider_invocations: 0,
  });
});

module.exports = router;
module.exports.validity = validity;
module.exports.isSelfApproval = isSelfApproval;
module.exports.summarise = summarise;
module.exports.uiStateOf = uiStateOf;
module.exports.canDispatch = canDispatch;
