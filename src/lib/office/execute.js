// PlayNexa AI Office — R1: THE RELEASE EXECUTOR. The only office module that can send anything.
//
// ── WHAT THIS IS, AND WHY IT IS ONE FILE ────────────────────────────────────
//
// Every other office module is deliberately unable to reach an outbound primitive, and an
// architectural check asserts that on the require graph. That assertion is what made the
// departed-signatory incident harmless: an incorrect letter was generated and could not leave.
//
// R1 necessarily breaks it, so it is NARROWED rather than deleted (ruling §14):
//
//   preparation (procurement-rfq.js, approval.js)  → NO outbound capability reachable
//   this file                                      → the mailer, reachable only via an approval
//
// A single module able to send, entered only through a human-approved action, is a materially
// different thing from a preparation path that could send. And module reachability is
// ARCHITECTURAL EVIDENCE, not the safety mechanism — the durable approval, the arbitrated release
// claim, the unique supplier claim, the kill switch and the budget are.
//
// ── THE API IS AN ACTION ID, NOT AN EMAIL (ruling §15) ──────────────────────
//
//   executeApprovedAction(approvalId)      ← what callers get
//   send({ to, subject, body })            ← what they must never get
//
// R1 loads the frozen payload itself from the authoritative store. There is no parameter for a
// destination, a subject or a body, so another office module cannot use this as a
// governed-looking mailer: the only way to make this send something is to get a human to approve
// it first.
//
// ── THE ORDER, AND WHY EACH STEP IS WHERE IT IS (rulings §5, §6, §10) ───────
//
//   1. kill switch on email.send          a policy stop must not consume the (rfq, supplier) slot,
//                                         so it happens BEFORE any claim is written
//   2. release eligibility + claim        approval valid · signatory still active · cost provable ·
//                                         objective budget · enterprise budget — then the
//                                         ARBITRATED release claim. All internal gates pass before
//                                         any external identity is consumed.
//   3. supplier claim                     UNIQUE (rfq_id, supplier_id), arbitrated by the database.
//                                         DURABLE CLAIM BEFORE EXTERNAL SIDE EFFECT — never the
//                                         reverse.
//   4. ACTION_ATTEMPTED                   throws if it cannot persist, and then NOTHING IS SENT.
//                                         No consequential external effect without prior durable
//                                         attempt evidence.
//   5. mailer                             the frozen payload, unmodified
//   6. confirm / markFailed / markUnknown by what the provider actually said
//   7. ACTION_SUCCEEDED                   only after provider acceptance
//
// ── WHAT IT NEVER DOES ──────────────────────────────────────────────────────
//
// No regeneration of the body. No second model call. No identity re-resolution. No CAS
// substitution. No change of quantity, destination, supplier, subject or signatory. No silent
// sanitisation. No automatic retry, ever — a retry is a decision about possibly contacting a
// supplier twice, and that belongs to a human. And it CANNOT touch the KPI: a send is an action
// fact, not a business outcome (ruling §17).
'use strict';

const scope = require('./scope');
const approvalMod = require('./approval');
const rfqClaim = require('../idempotency/supplier-rfq');
const { assertContext } = require('./context');

// ── THE OUTBOUND DEPENDENCY IS DECLARED AT THE TOP, DELIBERATELY ────────────
//
// Required here rather than lazily inside the function so that this module's ability to send is
// VISIBLE in the require graph. The architectural check asserts that preparation cannot reach the
// mailer and that this file can; a lazy require would make the second half unprovable and leave
// the office's only outbound capability invisible to the check that is supposed to locate it.
//
// Still overridable through `deps.mailer` for fixtures, which is how a test asserts the mailer was
// never called at all.
const defaultMailer = require('../mailer');

const WORKFLOW = 'governed-rfq-release';
const AGENT = 'release-executor';
const ACTION_KIND = 'send_rfq_email';

// Stoppable by name, declared statically in autonomy.js alongside the other office scopes.

/**
 * Execute one human-approved action. The ONLY entry point.
 *
 * @param {string} approvalId   the durable approved action
 * @param {object} opts         { releasedBy, expectedMode }
 * Returns a report object; never throws for a refusal, because a caller that treats an exception
 * as the only failure mode would act on an undefined result.
 */
async function executeApprovedAction(approvalId, { releasedBy, requireExplicitRelease = true } = {}, deps = {}) {
  if (!approvalId) return { ok: false, refusal: 'no_approval_id' };
  if (!releasedBy) return { ok: false, refusal: 'no_releasing_actor' };

  const query = (deps && deps.query) || require('../db').query;
  const mailer = (deps && deps.mailer) || defaultMailer;
  const autonomy = (deps && deps.autonomy) || require('../autonomy');

  // ── load the approval and its company, from the authoritative store ──────
  // Through the accessor, which owns every kernel table name. A kernel predicate written here —
  // in the office's only outbound module — is the last predicate anyone should be able to forget.
  const row = await scope.bootstrapApprovalForExecution(approvalId, deps);
  if (!row) return { ok: false, refusal: 'no_such_approval', approvalId };
  if (row.action_kind !== ACTION_KIND) {
    return { ok: false, refusal: 'unsupported_action_kind', detail: row.action_kind,
      note: 'R1 executes supplier RFQ email only. Another action kind needs its own authorized executor.' };
  }

  const ctx = Object.freeze({
    companyId: row.company_id, objectiveId: row.objective_id, runId: row.run_id,
  });
  assertContext(ctx);

  const payload = row.action_payload || {};
  const report = {
    approvalId, objectiveId: row.objective_id, runId: row.run_id,
    actionKind: row.action_kind, releaseMode: row.release_mode,
    approvedBy: row.resolved_by, approvedAt: row.resolved_at,
    destination: payload.to || null, supplier: payload.supplier_name || null,
    signatory: payload.signed_by_name ? {
      name: payload.signed_by_name, title: payload.signed_by_title,
      email: payload.signed_by_email, userId: payload.signed_by_user_id || null,
    } : null,
  };

  if (row.status !== 'approved') {
    return { ...report, ok: false, refusal: 'not_approved', detail: `status is "${row.status}"` };
  }
  if (row.release_claimed_at || row.released_at) {
    return { ...report, ok: false, refusal: 'already_claimed',
      detail: 'an executor has already taken responsibility for this action; a second attempt is '
        + 'not permitted and the first attempt\'s outcome is what needs resolving' };
  }

  // ── §16: THE POLICY IS DURABLE, NOT THE ABSENCE OF A CALLER ──────────────
  //
  // 'explicit' means a human must separately authorize the release, so an autonomous caller is
  // refused here by STORED POLICY — visible in the objectives row, not inferred from the fact that
  // nothing happens to call this yet.
  if (row.release_mode === 'explicit' && !requireExplicitRelease) {
    return { ...report, ok: false, refusal: 'explicit_release_required',
      detail: `objective ${row.objective_id} has release_mode='explicit': approval authorizes this `
        + 'action but a separate human release is required. Promotion to on_approval is a '
        + 'deliberate policy change.' };
  }
  if (row.release_mode !== 'explicit' && row.release_mode !== 'on_approval') {
    return { ...report, ok: false, refusal: 'unknown_release_mode', detail: row.release_mode };
  }

  // ══ 1. KILL SWITCH, BEFORE ANY CLAIM IS WRITTEN (ruling §5) ═════════════
  //
  // A policy stop must not consume the (rfq_id, supplier_id) opportunity. If this ran after the
  // supplier claim, a stop would permanently burn the ability to contact that supplier about that
  // RFQ — a safety control causing the harm it exists to prevent.
  try {
    const blocked = await autonomy.checkStopped(
      { capability: 'email.send', workflow: WORKFLOW, agent: AGENT, company: row.company_id },
      { consequential: true });
    if (blocked) {
      const reason = `STOPPED_BY_POLICY: ${blocked.scope_type}`
        + `${blocked.scope_key ? `:${blocked.scope_key}` : ''} — ${blocked.reason}`;
      try { autonomy.recordRefusal({ stop: blocked, what: 'office/execute', detail: { approvalId } }); } catch (_) {}
      return { ...report, ok: false, refusal: 'stopped_by_policy', detail: reason, claimWritten: false };
    }
  } catch (e) {
    // An unreadable kill state is not permission to act on the outside world. This is the inverse
    // of llm.js, deliberately: thinking continues under an unreadable switch, acting does not.
    return { ...report, ok: false, refusal: 'killswitch_unreadable', detail: e.message, claimWritten: false };
  }

  // ── the external idempotency invariant must actually be enforced ─────────
  //
  // Claim-before-act is worthless without the UNIQUE index: the INSERT simply succeeds twice. No
  // invariant, no consequential action — the same rule the kill switch applies to an unreadable
  // kill state.
  if (!(await rfqClaim.isEnforced(query))) {
    return { ...report, ok: false, refusal: 'idempotency_not_enforced',
      detail: `UNIQUE (rfq_id, supplier_id) is absent, so a duplicate supplier email could not be `
        + 'refused by the database. Refusing to send.', claimWritten: false };
  }

  // ══ 2. RELEASE ELIGIBILITY + THE ARBITRATED CLAIM (rulings §4, §6) ══════
  //
  // approval.release performs, in order: signatory still active → cost provable → objective budget
  // → enterprise budget → arbitrated release claim. Every internal gate passes before any external
  // identity is consumed.
  const released = await approvalMod.release(ctx, {
    approvalId, releasedBy, consequential: true,
    objectiveId: row.objective_id,
    objectiveBudgetUsd: row.budget_usd === null ? null : Number(row.budget_usd),
  }, deps);

  if (!released.released) {
    return { ...report, ok: false, refusal: released.reason, detail: released.detail || null,
      exception_id: released.exception_id || null,
      needs_repreparation: released.needs_repreparation === true,
      claimWritten: false };
  }
  report.releaseClaimedBy = releasedBy;

  // The payload the human approved, taken from the release claim's own RETURNING — not re-read,
  // not re-rendered.
  const approved = released.actionPayload || payload;
  const to = approved.to;
  const subject = approved.subject;
  const body = approved.body;
  if (!to || !subject || !body) {
    return { ...report, ok: false, refusal: 'frozen_payload_incomplete',
      detail: 'the approved payload lacks a destination, subject or body; nothing is reconstructed',
      claimWritten: false };
  }

  // ══ 3. THE SUPPLIER CLAIM — DURABLE, BEFORE ANY EXTERNAL EFFECT ═════════
  const claimId = await rfqClaim.claim(query, {
    rfqId: approved.rfq_id,
    supplierId: approved.supplier_id,
    email: to,
    subject,
    approvalId,
    runId: row.run_id,
  });
  if (!claimId) {
    // The database refused a duplicate. This supplier/RFQ pair already has an external-attempt
    // identity, so whatever happened to that attempt is what needs resolving — NOT a second send,
    // and never by deleting the previous claim to make room.
    return { ...report, ok: false, refusal: 'already_claimed_externally',
      detail: `(${approved.rfq_id}, ${approved.supplier_id}) already holds an external-attempt `
        + 'identity. Resolve that attempt; do not send again.', claimWritten: false, sent: false };
  }
  report.claimId = claimId;

  // ══ 4. ACTION_ATTEMPTED — AND IF IT CANNOT PERSIST, DO NOT SEND ════════
  //
  // actionAttempted THROWS when it cannot be written, and the platform rule is that the caller
  // must not then perform the action. An external effect with no durable attempt evidence is
  // indistinguishable from one that never happened.
  const ledger = (deps && deps.ledger)
    || require('../run-ledger').ledger({ query: (deps && deps.query) || undefined });
  try {
    await ledger.actionAttempted(row.run_id, {
      actionKind: ACTION_KIND,
      subjectType: 'supplier_rfq',
      subjectRef: `${approved.rfq_id}:${approved.supplier_id}`,
      detail: { approval_id: approvalId, claim_id: claimId, to, released_by: releasedBy },
    });
    report.actionAttempted = true;
  } catch (e) {
    await rfqClaim.markUnknown(query, claimId,
      `ACTION_ATTEMPTED could not be persisted (${e.message}); no send was made`).catch(() => {});
    return { ...report, ok: false, refusal: 'attempt_evidence_not_persisted', detail: e.message,
      claimWritten: true, sent: false,
      note: 'the claim is kept as an unresolved external-attempt identity and will be reconciled' };
  }

  // ══ 5. THE SEND — THE FROZEN PAYLOAD, UNMODIFIED ═══════════════════════
  const mailResult = await mailer.sendEmailDetailed({
    to,
    subject,
    html: String(body).split('\n').map((l) => escapeHtml(l)).join('<br>\n'),
    replyTo: approved.signed_by_email || undefined,
    capability: 'email.send',
  });
  report.provider = mailResult.provider || 'resend';
  report.providerPhase = mailResult.phase || (mailResult.ok ? 'provider_accepted' : 'unknown');
  report.providerMessageId = mailResult.id || null;

  // ══ 6. RECORD WHAT THE PROVIDER ACTUALLY SAID (rulings §8, §9, §11) ════
  if (mailResult.ok) {
    await rfqClaim.confirm(query, claimId, {
      subject, body, provider: report.provider, providerMessageId: mailResult.id || null,
    });
    await ledger.actionSucceeded(row.run_id, {
      actionKind: ACTION_KIND,
      subjectType: 'supplier_rfq',
      subjectRef: `${approved.rfq_id}:${approved.supplier_id}`,
      detail: { approval_id: approvalId, claim_id: claimId,
        provider: report.provider, provider_message_id: mailResult.id || null },
    });
    return { ...report, ok: true, sent: true, claimWritten: true, providerAccepted: true,
      // Stated so nobody reads a send as a business result. The KPI is R2's, and it stays 0.
      kpiTouched: false,
      note: 'the provider ACCEPTED the message. That is not delivery, not a read, and not a quotation.' };
  }

  // A definite pre-acceptance failure: the provider responded and rejected it, or the request was
  // never made. Acceptance IS ruled out, so the claim can honestly be marked failed.
  const definite = mailResult.phase === 'provider_rejected'
    || mailResult.phase === 'refused_before_request'
    || mailResult.phase === 'stopped_by_policy';

  if (definite) {
    await rfqClaim.markFailed(query, claimId, mailResult.error || mailResult.phase);
    await ledger.actionFailed(row.run_id, {
      actionKind: ACTION_KIND, subjectType: 'supplier_rfq',
      subjectRef: `${approved.rfq_id}:${approved.supplier_id}`,
      error: mailResult.error || mailResult.phase,
    }).catch(() => {});
    const exId = await fileSendException(ctx, {
      approvalId, claimId, runId: row.run_id,
      reason: `supplier RFQ send DEFINITIVELY FAILED before provider acceptance `
        + `(${mailResult.phase}): ${mailResult.error}. The claim is kept so the (rfq, supplier) `
        + 'identity is not silently reopened. NO AUTOMATIC RETRY — retrying is a decision about '
        + 'possibly contacting this supplier twice.',
      severity: 'critical',
    }, deps);
    return { ...report, ok: false, refusal: 'send_failed_definitively', detail: mailResult.error,
      claimWritten: true, sent: false, providerAccepted: false, exception_id: exId, kpiTouched: false };
  }

  // ── THE KNOWN UNKNOWN (ruling §8 window B, §11) ─────────────────────────
  //
  // The transport failed in a way where provider acceptance cannot be ruled out. The claim STAYS
  // unresolved — not 'failed', which would assert nothing was sent, and not 'sent', which would
  // assert the opposite. The reconciler will report it as unresolved until a human resolves it.
  await rfqClaim.markUnknown(query, claimId, mailResult.error);
  const exId = await fileSendException(ctx, {
    approvalId, claimId, runId: row.run_id,
    reason: `supplier RFQ send outcome is UNKNOWN (${mailResult.phase}): ${mailResult.error}. The `
      + 'request may have reached the provider and been accepted before this failed, so it is '
      + 'neither a failure nor a success. NO AUTOMATIC RETRY. A human must establish what the '
      + 'supplier actually received.',
    severity: 'critical',
  }, deps);
  return { ...report, ok: false, refusal: 'send_outcome_unknown', detail: mailResult.error,
    claimWritten: true, sent: null, providerAccepted: null, knownUnknown: true,
    exception_id: exId, kpiTouched: false };
}

// Deterministic id, so a repeated attempt for the same claim does not multiply incidents (§13).
async function fileSendException(ctx, { approvalId, claimId, runId, reason, severity }, deps = {}) {
  const id = `ex-send-${claimId}`;
  try {
    await scope.openException(ctx, { id, runId, source: 'office/execute', reason, severity,
      slaHours: 4 }, deps);
    return id;
  } catch (e) {
    if (e && e.code === '23505') return id;   // already filed for this claim — the same incident
    console.error(`[office/execute] could not file exception for ${claimId}: ${e.message}`);
    return null;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { executeApprovedAction, WORKFLOW, AGENT, ACTION_KIND };
