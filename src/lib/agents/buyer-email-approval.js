// ── THE APPROVAL BOUNDARY FOR BUYER-DIRECTED EMAIL ───────────────────────────
//
//   prep = await prepareBuyerEmail(ctx, { inquiry, message, commercial, signatory })
//   ... a human approves office_approvals row prep.approvalId ...
//   rel  = await releaseBuyerEmail(ctx, { approvalId, releasedBy, currentCommercial })
//   if (rel.released) → send rel.message VERBATIM with rel.expectedDigest
//
// CEO authorization 2026-11-11, workstream B.
//
// ── WHAT `needsApproval` WAS ─────────────────────────────────────────────────
//
// A local boolean in generateQuote. It did not gate anything. It selected the wording of a
// WhatsApp notice that was sent AFTER the quotation had already reached the buyer — "💰 Large
// quote sent … (>10kg — review pricing)". A human was told, in the past tense, about a priced
// commercial offer they had never seen. inquiry-agent.js says so itself: "needsApproval only
// fires a WhatsApp notice after the mail has gone, and on quantity, not on pricing confidence."
//
// It also fired on quantity alone, so the case the pricing-identity work found — a buyer priced at
// another substance's rate, 2.4x out, because two molecules shared a CAS — produced no notice at
// all if the order was small.
//
// ── WHY THE FROZEN ARTEFACT IS THE RENDERED HTML ─────────────────────────────
//
// The obvious design freezes the inputs (molecule, quantity, price) and re-renders the email at
// send time. That leaves a gap the width of the renderer: approve a payload, change a template or
// a pricing row, release, and a different letter goes out over the same approval. The ruling asks
// for "the exact sender, recipients, subject, body, attachments, product identity, quantity,
// price, currency and commercial terms" to be frozen, and the only way to freeze what the buyer
// will actually read is to freeze the bytes.
//
// So prepare() renders ONCE and stores the finished html. release() returns those bytes and the
// digest of them. The transport recomputes the digest from what it is about to transmit and
// refuses on any difference (src/lib/mailer.js). Three parties, one hash, no re-rendering.
//
// ── AND WHY THE SIGNATORY MUST BE A REAL ACTIVE USER ─────────────────────────
//
// office/approval.js release() revalidates the frozen signatory and refuses if that person is no
// longer active — the control that exists because two approved letters were signed by a
// Procurement Director who had left. That control needs a signatory it can look up, so a payload
// here records an ACCOUNTABLE USER (id and email, verifiable in `users`) separately from the
// display name the buyer sees. If no active accountable user can be resolved, this refuses to
// prepare. An external commercial offer that nobody in the company is answerable for does not get
// an approval row to sit in.

'use strict';

const crypto = require('crypto');
const LEDGER = require('../outbound/ledger');

// The office kernel, reached through a seam. Not for convenience: the controls below must be able
// to drive release() through every refusal it can produce — stale, superseded, already-released,
// digest-mismatched — and a module-scoped require cannot be stood up with a database. The same
// mistake in reverse cost this session a check that stubbed `window.API` when `API` was a
// module-scoped const, so the test exercised the happy path it was written to avoid.
function approvalOf(deps) { return (deps && deps.approval) || require('../office/approval'); }

const ACTION_KIND = 'buyer_email';

// How long a human decision stays actionable. An approval granted three weeks ago and released
// today is not the decision that was made: prices move, the buyer's situation moves, and the
// approver was looking at a quotation valid for 30 days. Stale is REFUSED, not refreshed — there
// is no path here that revives an expired decision without a new human one.
const APPROVAL_TTL_MINUTES = Number(process.env.BUYER_EMAIL_APPROVAL_TTL_MINUTES || 1440);

// The commercial fields that are compared at release. Named explicitly rather than derived from
// whatever happens to be on the object: a field added to the quote later must be added here
// DELIBERATELY, and until it is, this list is an honest statement of what is being checked rather
// than an implicit claim to check everything.
const COMMERCIAL_FIELDS = Object.freeze([
  'product_name', 'cas_number', 'product_type', 'quantity', 'quantity_unit',
  'unit_price', 'total', 'currency', 'payment_terms', 'lead_time_days',
  'valid_until', 'quote_ref', 'incoterms',
]);

function recipientsString(to) {
  return Array.isArray(to) ? to.join(', ') : String(to == null ? '' : to);
}

/**
 * The commercial terms, reduced to exactly the declared fields, in a stable order.
 *
 * Stable order matters: this feeds a hash, and JSON.stringify follows insertion order, so two
 * objects with the same terms built in a different sequence would otherwise disagree.
 */
function canonicalCommercial(commercial = {}) {
  const out = {};
  for (const k of COMMERCIAL_FIELDS) {
    const v = commercial[k];
    out[k] = v === undefined ? null : v;
  }
  return out;
}

function commercialDigest(commercial) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalCommercial(commercial)))
    .digest('hex').slice(0, 32);
}

/**
 * Which declared commercial fields differ. Returns [] when they agree.
 *
 * Reported field by field rather than as a single boolean, because "the quotation changed" is not
 * an actionable statement and "total went from 48,000 to 61,500" is.
 */
function commercialDiff(frozen = {}, current = {}) {
  const a = canonicalCommercial(frozen);
  const b = canonicalCommercial(current);
  return COMMERCIAL_FIELDS
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .map((k) => ({ field: k, approved: a[k], now: b[k] }));
}

/**
 * Build the immutable payload. Pure — no I/O, so the controls can exercise it without a database.
 *
 * `transport_digest` is computed with the LEDGER's own digestOf, not a local hash, so the value
 * stored here and the value recomputed inside the mailer come from one function. Two
 * implementations of "the same" hash is how a binding check quietly stops binding.
 */
function freezeBuyerEmail({
  inquiry, to, cc = null, from, replyTo, subject, body, html,
  commercial = {}, displayName = null, signatory,
}) {
  if (!inquiry || !inquiry.id) throw new Error('freezeBuyerEmail requires the inquiry');
  if (!to) throw new Error('freezeBuyerEmail requires a recipient');
  if (!subject) throw new Error('freezeBuyerEmail requires a subject');
  if (!html) throw new Error('freezeBuyerEmail requires the rendered html — the frozen artefact is '
    + 'what the buyer will read, not the inputs it was built from');
  if (!signatory || !signatory.email || !signatory.id) {
    throw new Error('freezeBuyerEmail requires an accountable signatory with an id and email: '
      + 'office/approval.js release() revalidates it and refuses a payload that records none');
  }

  const recipients = recipientsString(to);
  const ccList = cc == null ? null : (Array.isArray(cc) ? cc : [cc]);

  const payload = {
    kind: ACTION_KIND,
    inquiry_id: inquiry.id,
    buyer_email: inquiry.buyer_email || null,
    buyer_company: inquiry.buyer_company || null,

    // Exactly what leaves, and from whom.
    from,
    reply_to: replyTo || null,
    to: recipients,
    cc: ccList,
    subject,
    body_text: body || null,
    html,
    // There is no attachment path on buyer email today. Recorded as an explicit empty rather than
    // omitted, so a future caller that adds one changes a frozen field instead of filling a hole.
    attachments: [],

    commercial: canonicalCommercial(commercial),
    commercial_digest: commercialDigest(commercial),

    // The name in the signature block, which is a persona, kept SEPARATE from the human the
    // company is answerable through. Conflating them is how a letter goes out over a name that
    // cannot be held to it.
    display_name: displayName || null,
    signed_by_user_id: signatory.id,
    signed_by_email: signatory.email,
    signed_by_name: signatory.name || null,

    transport_digest: LEDGER.digestOf({ to: recipients, subject, html }),
    frozen_at: new Date().toISOString(),
  };

  return { payload, transportDigest: payload.transport_digest };
}

/**
 * Record a buyer-directed email for approval. SENDS NOTHING.
 *
 * Returns { prepared:true, approvalId, transportDigest } or { prepared:false, reason }.
 * Never throws for a refusal: a caller that treated an exception as the only failure mode would
 * read a refusal as a send.
 */
async function prepareBuyerEmail(ctx, {
  inquiry, to, cc, from, replyTo, subject, body, html, commercial, displayName, signatory,
  reason, ownerUserId = null, approvalId = null,
}, deps = {}) {
  if (!ctx || !ctx.runId) {
    return { prepared: false, reason: 'no_governed_context',
      detail: 'buyer email requires a run carrying a company identity; see buyerEmailContext()' };
  }

  let frozen;
  try {
    frozen = freezeBuyerEmail({ inquiry, to, cc, from, replyTo, subject, body, html,
      commercial, displayName, signatory });
  } catch (e) {
    return { prepared: false, reason: 'payload_incomplete', detail: e.message };
  }

  // One approval per (run, inquiry, artefact). The digest is in the id so that re-preparing a
  // CHANGED message is a new approval rather than a collision with the old one — and so that
  // re-preparing an identical message is idempotent rather than queueing a second decision for
  // the same letter.
  const id = approvalId
    || `ap-${ctx.runId}-${ACTION_KIND}-${inquiry.id}-${frozen.transportDigest.slice(0, 12)}`;

  try {
    const row = await approvalOf(deps).prepare(ctx, {
      id,
      actionKind: ACTION_KIND,
      actionPayload: frozen.payload,
      reason: reason || `external email to ${frozen.payload.to} regarding inquiry ${inquiry.id}`,
      ownerUserId,
    }, deps);
    return { prepared: true, approvalId: row.approvalId, status: row.status,
      transportDigest: frozen.transportDigest, commercialDigest: frozen.payload.commercial_digest };
  } catch (e) {
    // A duplicate id means this exact letter is already waiting on a human. That is the desired
    // state, not an error, and reporting it as a failure would invite a caller to retry with a
    // fresh id and queue the same decision twice.
    if (/duplicate key|unique constraint/i.test(e.message || '')) {
      return { prepared: true, approvalId: id, status: 'pending', alreadyPending: true,
        transportDigest: frozen.transportDigest };
    }
    return { prepared: false, reason: 'prepare_failed', detail: e.message };
  }
}

/**
 * Obtain an approved buyer email for transmission. THE ONLY ROUTE TO A BUYER.
 *
 * Returns { released:true, message, expectedDigest, approvalId } or { released:false, reason }.
 *
 * `currentCommercial`, when supplied, is compared against the frozen terms. The payload is NOT
 * rewritten to match — that would be approving one offer and sending another with extra steps.
 * A difference is terminal for this approval and needs a new preparation and a new decision.
 */
async function releaseBuyerEmail(ctx, {
  approvalId, releasedBy, currentCommercial = null, now = new Date(),
  ttlMinutes = APPROVAL_TTL_MINUTES,
}, deps = {}) {
  if (!ctx || !ctx.runId) return { released: false, reason: 'no_governed_context' };
  if (!approvalId) return { released: false, reason: 'no_approval_id' };
  if (!releasedBy) return { released: false, reason: 'no_releasing_actor' };

  // ── THE QUOTATION CHECK RUNS BEFORE THE CLAIM ─────────────────────────────
  //
  // Deliberately. release() claims the approval atomically and marks it released; a single release
  // is all an approval ever gets. If the terms had changed and we discovered it after claiming,
  // the approval would be spent and the human decision destroyed without anything being sent.
  //
  // Reading the pending state first is a wider window, and that is the correct trade: the risk of
  // reading stale state here is a refusal that did not need to happen, while the risk of claiming
  // first is a valid approval burned. Nothing is transmitted on this path either way.
  if (currentCommercial) {
    const scope = deps.scope || require('../office/scope');
    const pending = await scope.approvalReleaseState(ctx, approvalId, deps).catch(() => null);
    if (!pending) return { released: false, reason: 'no_such_approval_for_this_company' };
    const diff = commercialDiff(pending.action_payload && pending.action_payload.commercial,
      currentCommercial);
    if (diff.length) {
      return { released: false, reason: 'quotation_changed', changed: diff,
        detail: 'the commercial terms differ from the ones that were approved; the frozen payload '
          + 'is not rewritten — re-prepare and obtain a new decision' };
    }
  }

  const rel = await approvalOf(deps).release(ctx, { approvalId, releasedBy, consequential: true }, deps);
  if (!rel.released) return { released: false, ...rel };

  const p = rel.actionPayload || {};

  // ── STALENESS IS CHECKED AFTER THE CLAIM, AND THAT IS NOT A BUG ───────────
  //
  // approvedAt is only known from the released row. A stale approval that gets claimed and then
  // refused is spent, which is the right outcome: an expired decision must not remain available,
  // and leaving it releasable so a later caller could try again is how an expiry becomes a
  // suggestion. Nothing is transmitted.
  const approvedAt = rel.approvedAt ? new Date(rel.approvedAt) : null;
  if (!approvedAt || Number.isNaN(approvedAt.getTime())) {
    return { released: false, reason: 'approval_time_unknown', approvalId,
      detail: 'the released approval carries no usable decision time, so its age cannot be '
        + 'established; an unbounded approval is not released' };
  }
  const ageMinutes = (now.getTime() - approvedAt.getTime()) / 60000;
  if (ageMinutes > ttlMinutes) {
    return { released: false, reason: 'approval_stale', approvalId,
      age_minutes: Math.round(ageMinutes), ttl_minutes: ttlMinutes,
      detail: `approved ${Math.round(ageMinutes)} minutes ago, past the ${ttlMinutes}-minute limit; `
        + 're-preparation and a new decision are required' };
  }

  // ── THE PAYLOAD MUST STILL HASH TO WHAT IT CLAIMS ─────────────────────────
  //
  // The database trigger makes action_payload immutable, so this should be impossible. It is
  // checked anyway, because "should be impossible" is the category every defect in this
  // repository has come from, and the cost of checking is one hash.
  const recomputed = LEDGER.digestOf({ to: p.to, subject: p.subject, html: p.html });
  if (!p.transport_digest || recomputed !== p.transport_digest) {
    return { released: false, reason: 'payload_digest_mismatch', approvalId,
      detail: `the released payload hashes to ${recomputed} but records ${p.transport_digest || 'nothing'} — `
        + 'the approved artefact and the stored artefact are not the same bytes' };
  }

  return {
    released: true,
    approvalId: rel.approvalId,
    approvedBy: rel.approvedBy,
    approvedAt: rel.approvedAt,
    expectedDigest: p.transport_digest,
    inquiryId: p.inquiry_id || null,
    commercial: p.commercial || null,
    message: {
      to: p.to, cc: p.cc || undefined, from: p.from, replyTo: p.reply_to || undefined,
      subject: p.subject, html: p.html, body: p.body_text || null,
    },
  };
}

module.exports = {
  ACTION_KIND, APPROVAL_TTL_MINUTES, COMMERCIAL_FIELDS,
  freezeBuyerEmail, prepareBuyerEmail, releaseBuyerEmail,
  canonicalCommercial, commercialDigest, commercialDiff, recipientsString,
};
