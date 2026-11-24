// ── ONE CANONICAL, VERSIONED DIGEST OF THE AUTHORIZED MESSAGE ───────────────
//
//   const d = DIGEST.approvalDigest({ companyId, from, replyTo, providerAccount,
//                                     to, cc, bcc, subject, html, text, attachments });
//   → 'v2:<64 hex>'
//
// B7.6. Owner requirement: "Create one canonical, versioned approval digest implementation shared
// by every approval producer and dispatcher", binding originating company, authorized sender
// identity, provider account, TO/CC/BCC, FROM/REPLY-TO, subject, HTML and plain-text content, and
// attachments.
//
// ── WHAT THE PREVIOUS DIGEST DID NOT BIND ───────────────────────────────────
//
// outbound/ledger.js digestOf hashes `[to, subject, html || text || '']`. Three consequences, each
// a way an approved message could be altered without the approval noticing:
//
//   1. CC AND BCC WERE ABSENT. A released approval authorised the same bytes sent to additional
//      recipients, because adding them did not change the hash. The classification hole was closed
//      on 2026-11-24; this is the binding hole underneath it.
//   2. THE PLAIN-TEXT BODY WAS NOT BOUND when HTML was present — `html || text` takes one. A
//      recipient whose client prefers text/plain could be shown content nobody approved.
//   3. COMPANY, SENDER AND PROVIDER ACCOUNT were absent, so an approval for an ABIOZEN send could
//      authorise the identical bytes sent as another company, from another mailbox, through
//      another provider account.
//
// ── WHY THE VERSION PREFIX IS THE IMPORTANT PART ────────────────────────────
//
// A v1 digest and a v2 digest of the same message simply differ, and "digest mismatch" is what a
// caller would see — indistinguishable from a tampered payload. That is the wrong message for an
// approval that was released honestly under the old rules and merely cannot establish the complete
// authorized message.
//
// So digests carry their version. `classifyDigest` tells a caller WHICH it holds, and the approval
// gate can then say "this approval predates complete-message binding and requires fresh approval"
// instead of implying somebody changed the bytes. Owner requirement: "Prepare a safe transition for
// outstanding approvals. Legacy approvals that cannot establish the complete authorized message
// must require fresh approval."
//
// ── CANONICALISATION, AND WHY IT IS STRICT ──────────────────────────────────
//
// Two producers must hash identical bytes for the same message or every external send refuses, and
// five independent call sites compute this. So the serialisation is explicit rather than
// convenient: fixed field order, address lists lowercased and SORTED (so a reordered cc is the same
// message), empty and absent both normalised to null (so `cc: []` and no cc agree), and attachments
// reduced to name, type, byte length and content hash — never raw bytes, because a 10MB PDF should
// not pass through a hash function twice on every send.
//
// Strings are length-prefixed before hashing. Without that, { subject: 'ab', html: 'c' } and
// { subject: 'a', html: 'bc' } concatenate identically, and a subject could be lengthened while a
// body is shortened to keep an approval valid.

'use strict';

const crypto = require('node:crypto');

/** The current version. Bump ONLY with a transition plan: every producer must move together. */
const VERSION = 2;
const PREFIX = `v${VERSION}:`;

/** A v1 digest is 32 hex characters with no prefix — outbound/ledger.js digestOf. */
const V1_SHAPE = /^[0-9a-f]{32}$/;
const V2_SHAPE = /^v2:[0-9a-f]{64}$/;

/**
 * Which kind of digest is this? Returns 1, 2, or null for "not a digest we recognise".
 *
 * The approval gate uses this to distinguish "legacy, needs fresh approval" from "mismatch, the
 * bytes are not what was approved" — two refusals an operator must not confuse.
 */
function classifyDigest(d) {
  if (typeof d !== 'string') return null;
  if (V2_SHAPE.test(d)) return 2;
  if (V1_SHAPE.test(d)) return 1;
  return null;
}

/** Addresses, lowercased, de-duplicated and sorted. Order is not identity; the SET is. */
function addrSet(v) {
  if (v === null || v === undefined) return null;
  const out = [];
  const push = (x) => {
    if (x === null || x === undefined) return;
    if (Array.isArray(x)) { x.forEach(push); return; }
    for (const piece of String(x).split(',')) {
      const s = piece.trim();
      if (!s) continue;
      const m = s.match(/<([^>]+)>/);
      out.push((m ? m[1] : s).trim().toLowerCase());
    }
  };
  push(v);
  if (!out.length) return null;                 // `[]` and absent are the same message
  return [...new Set(out)].sort();
}

/** One address, normalised. A display name is not identity; the address is. */
function addr(v) {
  const s = addrSet(v);
  return s ? s.join(',') : null;
}

function str(v) {
  if (v === null || v === undefined) return null;
  return String(v);
}

/**
 * Attachments reduced to what identifies them: name, declared type, byte length, content hash.
 *
 * Content is hashed here rather than carried into the outer hash, so the outer serialisation stays
 * small and a large attachment is read once. Sorted by the resulting triple, because attachment
 * ORDER is not part of the message's identity but its contents are.
 */
function attachmentDigests(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const rows = list.map((a) => {
    const content = a && a.content;
    let bytes = null;
    let sha = null;
    if (content !== null && content !== undefined) {
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
      bytes = buf.length;
      sha = crypto.createHash('sha256').update(buf).digest('hex');
    }
    return [str(a && (a.filename || a.name)), str(a && a.contentType), bytes, sha];
  });
  rows.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  return rows;
}

/** Length-prefixed so adjacent fields cannot be re-divided between them. */
function encode(parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) {
    if (p === null || p === undefined) { h.update('N:'); continue; }
    const s = typeof p === 'string' ? p : JSON.stringify(p);
    h.update(`${Buffer.byteLength(s, 'utf8')}:`);
    h.update(s, 'utf8');
  }
  return h.digest('hex');
}

/**
 * The digest of a complete authorized message.
 *
 * Every field is bound. A caller that omits one is not producing a shorter digest of a smaller
 * message — it is producing the digest of a message whose field is ABSENT, which is a different
 * message from one where it is set. That is deliberate: it means an approval cannot be satisfied by
 * a send that quietly adds a cc, a reply-to, or an attachment.
 */
function approvalDigest({
  companyId = null, from = null, replyTo = null, providerAccount = null,
  to = null, cc = null, bcc = null, subject = null, html = null, text = null,
  attachments = null, raw = null,
} = {}) {
  return PREFIX + encode([
    `version=${VERSION}`,
    'company', str(companyId),
    'from', addr(from),
    'replyTo', addr(replyTo),
    'provider', str(providerAccount),
    'to', addrSet(to),
    'cc', addrSet(cc),
    'bcc', addrSet(bcc),
    'subject', str(subject),
    // BOTH bodies, independently. `html || text` was the old rule, and it meant the text
    // alternative could be changed without changing the digest.
    'html', str(html),
    'text', str(text),
    'attachments', attachmentDigests(attachments),
    // RAW RFC822, for the Gmail path, where the bytes transmitted ARE `raw` and to/subject/html
    // are only a description of them. Binding the description would leave the thing itself
    // unbound: alter `raw`, keep the headers consistent, and a check over the description passes
    // while a different message goes out.
    //
    // Always present in the encoding even when null, so there is exactly ONE definition of a
    // message rather than a with-raw definition and a without-raw one. Two encodings would mean a
    // producer and a consumer could each be internally consistent and still disagree, which is the
    // failure mode this whole module exists to remove.
    'raw', str(raw),
  ]);
}

/**
 * Do these two digests authorize the same message?
 *
 * Returns a structured verdict rather than a boolean, because the three ways this can fail need
 * three different operator actions:
 *
 *   match            → proceed
 *   legacy_version   → the approval predates complete-message binding. FRESH APPROVAL required;
 *                      nobody tampered with anything.
 *   mismatch         → the bytes about to be sent are not the bytes that were approved.
 *   unrecognised     → the stored value is not a digest this system produces at all.
 */
/**
 * WHICH PROVIDER ACCOUNT SENDS THIS — one definition, because two is how producers disagree.
 *
 * Added after the cross-layer test caught exactly that. dispatch.js was computing
 * `resend:<from>` while the sender service — a SEPARATE PROCESS recomputing the same binding —
 * was computing the bare transport name. Both were defensible; both were v2; and every external
 * send over that road refused with a digest mismatch that looked like tampering. That is the
 * failure B7.6 exists to prevent, reproduced inside B7.6 by leaving one field's meaning to each
 * call site.
 *
 * The account is the transport plus the mailbox or sender identity it sends as, because that pair
 * is what actually determines whose name is on the message. Binding it means an approval to send
 * from the CPHI mailbox cannot be redeemed by the direct SMTP transport, or from another mailbox.
 */
function providerAccountOf({ transport = null, mailbox = null, from = null } = {}) {
  const who = mailbox || from || '';
  return `${String(transport || 'unknown').toLowerCase()}:${String(who).toLowerCase()}`;
}

function compareDigests({ approved, actual }) {
  const a = classifyDigest(approved);
  const b = classifyDigest(actual);

  if (a === null) {
    return { ok: false, code: 'unrecognised',
      detail: 'the stored approval carries no digest this system recognises, so it cannot be shown '
        + 'to authorize these bytes' };
  }
  if (b !== VERSION) {
    return { ok: false, code: 'actual_not_current',
      detail: `the digest computed for this send is not v${VERSION}; a producer has not been `
        + 'migrated to the canonical digest, and a send must not be authorized by comparing two '
        + 'different definitions of the message' };
  }
  if (a !== VERSION) {
    return { ok: false, code: 'legacy_version',
      detail: `this approval carries a v${a} digest, which bound only the recipients in TO, the `
        + 'subject and one body. It cannot establish the complete authorized message — company, '
        + 'sender identity, provider account, CC/BCC, both bodies and attachments — so it requires '
        + 'FRESH APPROVAL. Nothing about the message has necessarily changed.' };
  }
  if (approved !== actual) {
    return { ok: false, code: 'mismatch',
      detail: 'the message about to be sent is not the message that was approved' };
  }
  return { ok: true };
}

module.exports = {
  approvalDigest,
  providerAccountOf,
  compareDigests,
  classifyDigest,
  VERSION,
  PREFIX,
};
