// ── WHAT A SUPPLIER ACTUALLY SENT BACK ────────────────────────────────────────
//
// Eight CPHI suppliers replied within a day of the follow-up going out, and the valuable part is
// not that they replied — it is what came attached. A product catalogue in an xlsx is the supply
// data the marketplace is short of; a two-line "please contact my colleague" is a routing note.
// Those need different handling and the queue has to tell them apart at a glance.
//
// ── WHY THE BODY IS TRIMMED THE WAY IT IS ────────────────────────────────────
//
// A reply carries the entire thread quoted underneath it — our original message, the signature,
// the legal footer. Printed raw, every entry in the queue is three screens of our own words with
// one new sentence at the top. So the quoted tail is cut at the first quote marker, and what is
// left is what the person actually typed.
//
// The cut is conservative: if no marker is found, the text is truncated rather than discarded,
// because showing too much is a nuisance and showing nothing could hide the one line that matters.
'use strict';

const { allParts, headerOf } = require('./bounces');

const decode = (b64) => {
  if (!b64) return '';
  try { return Buffer.from(String(b64).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
  catch (_) { return ''; }
};

// Where a client starts quoting. Gmail, Outlook, Apple Mail and the mobile clients each have their
// own, and suppliers in this list use all of them.
const QUOTE_MARKERS = [
  /^On .{10,80}wrote:\s*$/m,                    // Gmail / Apple Mail
  /^-{2,}\s*Original Message\s*-{2,}/im,        // Outlook, older
  /^_{10,}\s*$/m,                               // Outlook, newer (a rule of underscores)
  /^From:\s.+\nSent:\s/im,                      // Outlook header block
  /^\s*>{1,2}\s/m,                              // plain quoting
  /^发件人:/m,                                   // Outlook, Simplified Chinese
  /^差出人:/m,                                   // Japanese
];

/** The part the person typed, with the quoted thread removed. */
function newText(raw) {
  let t = String(raw || '').replace(/\r\n/g, '\n');
  let cut = t.length;
  for (const re of QUOTE_MARKERS) {
    const m = t.match(re);
    if (m && m.index != null && m.index < cut) cut = m.index;
  }
  t = t.slice(0, cut);
  // Signature block: cut at a standalone "-- " line, which is the RFC convention.
  const sig = t.match(/^-- \s*$/m);
  if (sig && sig.index != null) t = t.slice(0, sig.index);
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

/** The plain-text body of a message, preferring text/plain over a stripped HTML part. */
function plainBody(payload) {
  const parts = allParts(payload).filter((p) => !p.parts);
  const plain = parts.filter((p) => /^text\/plain/i.test(p.mimeType || ''));
  const html = parts.filter((p) => /^text\/html/i.test(p.mimeType || ''));
  const pick = plain.length ? plain : html;
  let body = pick.map((p) => decode(p.body && p.body.data)).filter(Boolean).join('\n');
  if (!plain.length && body) {
    // Only when there was no text/plain at all. Tag-stripping is a last resort, not a preference.
    //
    // <blockquote> is where HTML mail puts the quoted thread, so it goes FIRST and whole — that is
    // a structural signal, far better than pattern-matching "On ... wrote:" in the flattened text.
    //
    // And every block-level close has to become a newline. Without that, a reply built from
    // <div>s flattens to ONE line, and the quote markers below — which are anchored to line
    // starts — can never match. That cost a test: our own quoted words came through into the
    // queue because there were no line breaks left to find them by.
    body = body.replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|table|section)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"');
  }
  return body;
}

/**
 * Every attachment on a message: { filename, mimeType, size, attachmentId }.
 *
 * Inline images are excluded — a signature logo is not a catalogue, and a queue that reports
 * "3 attachments" for a message carrying only a logo and a QR code trains you to ignore the
 * column that matters.
 */
function attachmentsOf(payload) {
  return allParts(payload)
    .filter((p) => p.filename && p.body && p.body.attachmentId)
    .filter((p) => {
      const disp = (p.headers || []).find((h) => /^content-disposition$/i.test(h.name));
      const inline = disp && /inline/i.test(disp.value || '');
      const isImage = /^image\//i.test(p.mimeType || '');
      return !(inline && isImage);
    })
    .map((p) => ({
      filename: p.filename,
      mimeType: p.mimeType || 'application/octet-stream',
      size: (p.body && p.body.size) || 0,
      attachmentId: p.body.attachmentId,
    }));
}

// A catalogue is the thing worth acting on, and its file type is the cheapest signal there is.
const CATALOGUE_RE = /\.(xlsx?|xlsm|csv|pdf|docx?)$/i;
const looksLikeCatalogue = (a) => CATALOGUE_RE.test(a.filename || '');

/**
 * One inbound message, reduced to what the queue needs.
 * Returns { from, fromEmail, date, subject, text, attachments, hasCatalogue }.
 */
function readIncoming(msg) {
  const payload = (msg && msg.payload) || {};
  const from = headerOf(payload, 'From');
  const fromEmail = (String(from).match(/[^<\s]+@[^>\s]+/) || [])[0] || '';
  const attachments = attachmentsOf(payload);
  return {
    from,
    fromEmail: fromEmail.toLowerCase(),
    date: headerOf(payload, 'Date'),
    subject: headerOf(payload, 'Subject'),
    text: newText(plainBody(payload)),
    attachments,
    hasCatalogue: attachments.some(looksLikeCatalogue),
  };
}


// ── PARSING AN ADDRESS LIST WITHOUT BREAKING ON QUOTED COMMAS ────────────────
//
// A To or Cc header is comma-separated, except that a display name may itself contain a comma and
// then it is quoted: `"Rakesh, K" <rakesh@alivus.com>`. Splitting on every comma turns that into
// two items — one with a broken name and one that is not an address at all. The address survived,
// but the name became "K", which is the sort of thing a recipient notices in a greeting line.
//
// So items are MATCHED rather than split: a run of non-comma characters, or anything inside
// quotes. Items with no @ are dropped, because a half-parsed fragment is not an address.
function parseAddressList(value) {
  const raw = String(value == null ? '' : value);
  const items = raw.match(/(?:"[^"]*"|[^,])+/g) || [];
  return items
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => {
      const m = a.match(/^(.*?)\s*<([^>]+)>$/);
      if (m) return { name: m[1].replace(/^"|"$/g, '').trim(), email: m[2].trim() };
      return { email: a.replace(/^<|>$/g, '').trim() };
    })
    .filter((a) => a.email && a.email.includes('@'));
}

/**
 * Everyone on a message other than `self` — the sender's To and Cc.
 * Used so a reply keeps the colleagues they deliberately brought into the thread.
 */
function otherParticipants(payload, self) {
  const me = String(self || '').toLowerCase();
  const all = [...parseAddressList(headerOf(payload, 'To')), ...parseAddressList(headerOf(payload, 'Cc'))];
  const seen = new Set();
  return all.filter((a) => {
    const k = a.email.toLowerCase();
    if (k === me || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = { readIncoming, parseAddressList, otherParticipants, newText, plainBody, attachmentsOf, looksLikeCatalogue };
