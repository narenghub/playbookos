// ── AN APPROVAL BOUNDARY FOR OUTREACH AND CAMPAIGN MAIL ──────────────────────
//
//   const r = await prepareOutreachEmail(ctx, { ... });     // a human now has a decision
//   const d = await releaseOutreachEmail(ctx, { approvalId, releasedBy });
//   await dispatch({ message: d.message, approvalId, expectedDigest: d.expectedDigest, ... });
//
// Spec A milestone 6, item 2. outreach-agent and cphi-runner had NO approval lifecycle: before
// milestone 5 they simply sent, and after it they were refused by dispatch and silently moved on.
// Neither is a state a business can run on — the first is how 25 real people were written to
// between 3 and 10 November, and the second is a channel that looks alive and does nothing.
//
// So the agents now QUEUE a decision. A human sees it, approves or rejects it, and only then does
// anything leave.
//
// ── WHY THIS IS NOT buyer-email-approval.js ──────────────────────────────────
//
// That module governs quotations, and most of it is about COMMERCIAL terms: a price, a quantity, a
// CAS number, frozen and re-compared at release so an approved offer cannot become a different
// offer. Outreach mail has no commercial terms to freeze. Reusing that module would mean passing
// empty `commercial` through checks built to compare it, and a check that compares nothing to
// nothing passes for the wrong reason.
//
// What IS shared is the thing that matters, and it is shared by delegation rather than by copying:
// office/approval.js prepare() and release(), the same approval_queue table, the same approvals
// screen, the same single-release guarantee.
//
// ── WHAT THE DIGEST BINDS ────────────────────────────────────────────────────
//
// The RAW RFC822 BYTES. Not the subject, not a rendered body, not a description — the exact string
// handed to the transport. This matters more here than on the quotation path, because these
// messages are built as MIME before they are approved: binding to/subject/html would leave the
// transmitted artefact unbound, and `raw` could be altered after approval with the headers left
// consistent. That hole existed in dispatch() until milestone 6 and is why transmittedDigest()
// exists.
//
// The digest is computed with dispatch's own transmittedDigest, not a second implementation of it.
// Two implementations of one hash is how a binding check quietly stops binding.
//
// ── IMMUTABLE, AND REVALIDATED ANYWAY ────────────────────────────────────────
//
// The CEO's requirement is "immutable OR revalidated against the exact transmitted payload". This
// does both, because each covers a different failure:
//
//   IMMUTABLE    the frozen payload is stored in the approval and is what release() hands back.
//                The caller's current idea of the message is not an input.
//   REVALIDATED  dispatch recomputes the digest from the bytes it is about to transmit and refuses
//                on a mismatch. The sender service then does it again, from the request body.
//
// Immutability protects the approved artefact. Revalidation protects the joint between release and
// transmission — whatever carries the payload from one to the other could carry something else.

'use strict';

const ACTION_KIND = 'outreach.email.send';

// How long an approved outreach message may wait before it must be decided again. Shorter than a
// quotation's window: a campaign step approved last week and sent today arrives as a non-sequitur
// to whatever conversation has happened since.
const APPROVAL_TTL_MINUTES = 24 * 60;

function approvalOf(deps) { return (deps && deps.approval) || require('../office/approval'); }
function dispatchOf(deps) { return (deps && deps.dispatchModule) || require('../outbound/dispatch'); }

function recipientsString(to) {
  if (Array.isArray(to)) return to.join(', ');
  return String(to == null ? '' : to);
}

/**
 * Freeze an outreach message into the artefact a human approves.
 *
 * Throws on an incomplete payload. A partial message is not a draft to be filled in later — it is
 * a bug, and queueing it would put a decision in front of a person about something that cannot be
 * sent.
 */
function freezeOutreachEmail({ to, subject, raw, mailbox, transport, threadId = null,
  campaign = null, step = null, contactRef = null, preview = null }, deps = {}) {
  const missing = Object.entries({ to, subject, raw, mailbox, transport })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(`an outreach approval needs ${missing.join(', ')}`);
  }

  const payload = {
    to: recipientsString(to),
    subject: String(subject),
    raw: String(raw),
    mailbox: String(mailbox),
    transport: String(transport),
    thread_id: threadId,
    campaign,
    step,
    contact_ref: contactRef,
    // What the approver READS. The raw blob is base64 MIME and unreadable to a human, so a
    // rendered preview travels with it — clearly labelled as a preview, never as the artefact.
    // The digest covers `raw`, so changing the preview cannot change what is sent, and changing
    // what is sent cannot leave the preview looking approved.
    preview: preview ? String(preview).slice(0, 4000) : null,
  };

  const transportDigest = dispatchOf(deps).transmittedDigest({
    to: payload.to, subject: payload.subject, raw: payload.raw,
  });

  return { payload: { ...payload, transport_digest: transportDigest }, transportDigest };
}

/**
 * Queue an outreach message for human approval.
 *
 * Returns { prepared: true, approvalId, status, transportDigest } or { prepared: false, reason }.
 * `alreadyPending: true` means this exact message is already waiting on somebody — the desired
 * state, not an error.
 */
async function prepareOutreachEmail(ctx, {
  to, subject, raw, mailbox, transport, threadId = null,
  campaign = null, step = null, contactRef = null, preview = null,
  reason, ownerUserId = null, approvalId = null,
}, deps = {}) {
  if (!ctx || !ctx.runId) {
    return { prepared: false, reason: 'no_governed_context',
      detail: 'an outreach approval requires a run carrying a company identity' };
  }

  let frozen;
  try {
    frozen = freezeOutreachEmail({ to, subject, raw, mailbox, transport, threadId,
      campaign, step, contactRef, preview }, deps);
  } catch (e) {
    return { prepared: false, reason: 'payload_incomplete', detail: e.message };
  }

  // The digest is IN THE ID. Two consequences, both wanted: re-preparing an identical message is
  // idempotent rather than queueing a second decision for the same letter, and re-preparing a
  // CHANGED message is a new approval rather than a silent collision with the old one.
  const id = approvalId
    || `ap-${ctx.runId}-${ACTION_KIND}-${contactRef || 'anon'}-${frozen.transportDigest.slice(0, 12)}`;

  try {
    const row = await approvalOf(deps).prepare(ctx, {
      id,
      actionKind: ACTION_KIND,
      actionPayload: frozen.payload,
      // The recipient and the campaign are ALWAYS in the reason, and a caller-supplied reason is
      // APPENDED rather than substituted. `reason` is what the approver reads, and a caller that
      // passed "follow-up" would otherwise produce an approval request that does not say who it is
      // addressed to — which is approving an unaddressed letter. Found by a control that asserted
      // the recipient was visible and then failed on a caller-supplied reason.
      reason: `outreach email to ${frozen.payload.to}`
        + `${campaign ? ` (${campaign}${step ? ` step ${step}` : ''})` : ''}`
        + `${reason ? ` — ${reason}` : ''}`,
      ownerUserId,
    }, deps);
    return { prepared: true, approvalId: row.approvalId, status: row.status,
      transportDigest: frozen.transportDigest };
  } catch (e) {
    if (/duplicate key|unique constraint/i.test(e.message || '')) {
      return { prepared: true, approvalId: id, status: 'pending', alreadyPending: true,
        transportDigest: frozen.transportDigest };
    }
    return { prepared: false, reason: 'prepare_failed', detail: e.message };
  }
}

/**
 * Obtain an approved outreach message for transmission. THE ONLY ROUTE.
 *
 * Returns { released: true, message, expectedDigest, approvalId, transport } or
 * { released: false, reason }. Never throws for a refusal: a caller that treats an exception as
 * the only failure mode would act on an undefined payload.
 */
async function releaseOutreachEmail(ctx, {
  approvalId, releasedBy, now = new Date(), ttlMinutes = APPROVAL_TTL_MINUTES,
}, deps = {}) {
  if (!ctx || !ctx.runId) return { released: false, reason: 'no_governed_context' };
  if (!approvalId) return { released: false, reason: 'no_approval_id' };
  if (!releasedBy) return { released: false, reason: 'no_releasing_actor' };

  const out = await approvalOf(deps).release(ctx, { approvalId, releasedBy, consequential: true }, deps);
  if (!out || !out.released) {
    return { released: false, reason: (out && out.reason) || 'release_refused',
      status: out && out.status };
  }
  if (out.actionKind !== ACTION_KIND) {
    // An approval for something else must not be spendable as an outreach send. Without this, any
    // approved action id would be a licence to mail somebody.
    return { released: false, reason: 'wrong_action_kind', detail: out.actionKind };
  }

  const p = out.actionPayload || {};
  if (!p.raw || !p.to || !p.transport) {
    return { released: false, reason: 'approved_payload_incomplete' };
  }

  // ── STALENESS ─────────────────────────────────────────────────────────────
  //
  // Checked AFTER the release rather than before, unlike the quotation path's terms check — and
  // for the opposite reason. There, re-reading first protects a human decision from being spent on
  // a message that cannot go. Here the TTL is a property of the approval itself, not of changing
  // state elsewhere, so there is nothing to race: an expired approval is expired whether it is
  // read before or after, and claiming it first means it cannot be released twice while the clock
  // is being consulted.
  const releasedAt = out.releasedAt ? new Date(out.releasedAt) : now;
  const createdAt = p.created_at ? new Date(p.created_at) : null;
  if (createdAt && (releasedAt - createdAt) > ttlMinutes * 60000) {
    return { released: false, reason: 'approval_stale',
      detail: `approved ${Math.round((releasedAt - createdAt) / 60000)} minutes ago; the limit is ${ttlMinutes}` };
  }

  // The payload is handed back AS APPROVED. It is not re-derived from current state and not
  // rewritten — that would be approving one message and sending another with extra steps.
  const message = {
    to: p.to,
    subject: p.subject,
    raw: p.raw,
    mailbox: p.mailbox,
    ...(p.thread_id ? { threadId: p.thread_id } : {}),
  };

  // Recomputed here from the payload being handed over, and compared with what was frozen. This is
  // belt and braces — dispatch checks it again, and the sender service a third time from the
  // request body — but each check covers a different joint, and this one covers the approval store
  // itself: a payload altered in the database between prepare and release would otherwise travel
  // with its own stale digest and satisfy every later check.
  const expectedDigest = dispatchOf(deps).transmittedDigest(message);
  if (p.transport_digest && expectedDigest !== p.transport_digest) {
    return { released: false, reason: 'approved_payload_altered',
      detail: `the stored payload hashes to ${expectedDigest} but was approved as ${p.transport_digest}` };
  }

  return { released: true, message, expectedDigest, approvalId, transport: p.transport,
    campaign: p.campaign || null, step: p.step || null, contactRef: p.contact_ref || null };
}

/**
 * A governed run context, which prepare() and release() both require.
 *
 * Modelled on inquiry-agent's buyerEmailContext() and built from the same office/run primitives,
 * so there is one notion of "a run that carries a company identity" rather than a second one here.
 *
 * Returns { ok: true, ctx, runId } or { ok: false, reason, detail }. NEVER throws, and never
 * returns a context it could not establish: an approval without a run cannot be attached to the
 * actor that will act on it, and a prepare() that quietly failed would leave the agent reporting
 * "nothing to send" while messages piled up nowhere.
 */
async function outreachApprovalContext({ workflow, agent, intentName }, deps = {}) {
  const env = deps.env || process.env;
  const objectiveId = env.OUTREACH_APPROVAL_OBJECTIVE_ID;
  if (!objectiveId) {
    return { ok: false, reason: 'no_objective_configured',
      detail: 'OUTREACH_APPROVAL_OBJECTIVE_ID is unset, so no company context can be derived and '
        + 'no outreach email can be queued for approval' };
  }
  try {
    const { beginObjectiveRun } = deps.run || require('../office/run');
    const { cronIntentKey } = deps.runs || require('../runs');
    const begun = await beginObjectiveRun({
      objectiveId,
      trigger: 'cron',
      triggerDetail: `${agent} outreach approval`,
      workflow,
      agent,
      product: 'sales',
      // Per FIRING, not per day — the same correction inquiry-agent records: a day-slot key would
      // give this agent one run every 24 hours and refuse every later cycle, and a refused context
      // means a contact never hears back, which is a failure dressed as safety.
      intentKey: cronIntentKey(intentName, new Date()),
    }, deps);
    if (begun.duplicate || !begun.runId) {
      return { ok: false, reason: 'run_not_created',
        detail: 'another run already holds this intent key' };
    }
    return { ok: true, ctx: begun.context, runId: begun.runId };
  } catch (e) {
    return { ok: false, reason: 'context_unavailable', detail: e.message };
  }
}

module.exports = {
  prepareOutreachEmail, releaseOutreachEmail, freezeOutreachEmail, outreachApprovalContext,
  ACTION_KIND, APPROVAL_TTL_MINUTES,
};
