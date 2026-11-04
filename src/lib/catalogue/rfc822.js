// ── OPENING AN EMAIL THAT ARRIVED AS AN ATTACHMENT ──────────────────────────
//
// Three of the CPHI replies carry a `.eml` attachment, and the extractor skipped all three because
// `.eml` is neither `isPdf` nor `isSheet`. They hold the most valuable evidence in the mailbox:
//
//   Alivus      `RE: Book1.xlsx.eml`   — Rakesh: "Please see the attached email which I had shared
//                                        with Palash earlier." The ORIGINAL product list, forwarded
//                                        to us, so it never needed Palash's mailbox at all.
//   Chieron     `RE: Following up…eml` — Sajan's earlier reply, which we never saw. He asked us to
//                                        check our spam folder. It was in the thread all along.
//   ScinoPharm  `RE: …_Abiozen.eml`    — Candice: "We have already shared our product list website
//                                        with you. Please refer to attached email."
//
// ── WHAT THIS DOES, AND WHAT IT REFUSES TO DO ──────────────────────────────
//
// It lists the parts of a MIME message and decodes the ones that are attachments, so a nested
// product list becomes readable by the parser that already exists. It is NOT a general mail client:
// it does not render, follow references, or interpret anything.
//
// When it cannot parse, it SAYS SO and returns nothing. A half-parsed message that yields one of
// three attachments is worse than a failure, because the missing two are invisible — the same shape
// as a check that passes without executing.
'use strict';

const DECODE_LIMIT = 40 * 1024 * 1024;        // a sanity bound; CPHI attachments are single-digit MB

// ── RFC 2047 ENCODED WORDS ──────────────────────────────────────────────────
//
// A header containing anything outside ASCII is transmitted encoded, and ScinoPharm's forwarded
// message printed as:
//
//   from =?utf-8?B?RXJpbiBDaGFuZy3lvLXlu7fljYk=?=
//
// which is unreadable, so the sender of the most important attached email in the mailbox looked
// like line noise. Decoded it is `Erin Chang-張廷卉`. Every CJK supplier on this campaign sends
// headers this way, so leaving them raw makes the probe useless for most of the list.
//
// The subtlety worth keeping: whitespace BETWEEN two adjacent encoded words is a transport artefact
// and must be dropped, or a subject split across two words reads "how we w ork".
function decodeWords(value) {
  if (value == null) return value;
  const s = String(value).replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1');
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, enc, text) => {
    try {
      const cs = /utf-?8/i.test(charset) ? 'utf8' : 'latin1';
      if (enc.toUpperCase() === 'B') return Buffer.from(text, 'base64').toString(cs);
      const bytes = text.replace(/_/g, ' ')
        .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      return Buffer.from(bytes, 'binary').toString(cs);
    } catch (_) { return whole; }           // an undecodable word stays as it arrived
  });
}

function headerBlock(buf) {
  // Headers end at the first blank line. Both CRLFCRLF and LFLF occur in the wild.
  for (const sep of ['\r\n\r\n', '\n\n']) {
    const i = buf.indexOf(sep);
    if (i !== -1) return { head: buf.subarray(0, i).toString('utf8'), body: buf.subarray(i + sep.length), sep };
  }
  return null;
}

// Unfold continuation lines (a header value wrapped onto an indented next line) then index by name.
function parseHeaders(head) {
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const out = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    out[k] = out[k] ? `${out[k]}, ${m[2]}` : m[2];
  }
  return out;
}

const paramOf = (value, name) => {
  if (!value) return null;
  // filename="x.xlsx" | filename=x.xlsx | filename*=UTF-8''x.xlsx
  const re = new RegExp(`${name}\\*?\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i');
  const m = String(value).match(re);
  if (!m) return null;
  let v = (m[1] || m[2] || '').trim();
  const enc = v.match(/^[^']*''(.*)$/);          // RFC 2231 filename*=UTF-8''name
  if (enc) { try { v = decodeURIComponent(enc[1]); } catch (_) { v = enc[1]; } }
  return v || null;
};

function decodePart(body, encoding) {
  const enc = String(encoding || '7bit').toLowerCase().trim();
  if (enc === 'base64') {
    const clean = body.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(clean, 'base64');
  }
  if (enc === 'quoted-printable') {
    const s = body.toString('ascii').replace(/=\r?\n/g, '');
    return Buffer.from(s.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
  }
  return body;                                    // 7bit, 8bit, binary — already the bytes
}

/**
 * Every part of a MIME message, flattened, with attachments decoded.
 *
 * Returns { ok, reason, subject, from, date, parts: [{ filename, contentType, bytes, isAttachment }] }
 * `ok: false` means nothing was parsed — never a partial result.
 */
function partsOf(buf) {
  if (!buf || !buf.length) return { ok: false, reason: 'empty message', parts: [] };
  if (buf.length > DECODE_LIMIT) return { ok: false, reason: `message is ${buf.length} bytes`, parts: [] };

  const top = headerBlock(buf);
  if (!top) return { ok: false, reason: 'no header/body separator — this is not an RFC822 message', parts: [] };

  const h = parseHeaders(top.head);
  const meta = {
    subject: decodeWords(h.subject) || null,
    from: decodeWords(h.from) || null,
    date: h.date || null,
    to: decodeWords(h.to) || null,
    cc: decodeWords(h.cc) || null,
  };

  const parts = [];
  const walk = (headers, body, depth) => {
    if (depth > 8) return;                        // a nesting bound, not an expectation
    const ctype = headers['content-type'] || 'text/plain';
    const boundary = paramOf(ctype, 'boundary');

    if (/^multipart\//i.test(ctype) && boundary) {
      const marker = `--${boundary}`;
      const text = body.toString('binary');
      const idx = [];
      let at = text.indexOf(marker);
      while (at !== -1) { idx.push(at); at = text.indexOf(marker, at + marker.length); }
      if (idx.length < 2) return;                 // a boundary that never repeats is not multipart
      for (let i = 0; i < idx.length - 1; i++) {
        const start = idx[i] + marker.length;
        if (text.startsWith('--', start)) break;  // the closing boundary
        const raw = body.subarray(start, idx[i + 1]);
        const sub = headerBlock(raw);
        if (!sub) continue;
        walk(parseHeaders(sub.head), trimTrailingCrlf(sub.body), depth + 1);
      }
      return;
    }

    const disp = headers['content-disposition'] || '';
    const filename = decodeWords(paramOf(disp, 'filename') || paramOf(ctype, 'name'));
    const isAttachment = Boolean(filename) || /^attachment/i.test(disp);
    parts.push({
      filename: filename || null,
      contentType: String(ctype).split(';')[0].trim().toLowerCase(),
      encoding: (headers['content-transfer-encoding'] || '7bit').toLowerCase().trim(),
      isAttachment,
      bytes: decodePart(body, headers['content-transfer-encoding']),
    });
  };

  try {
    walk(h, top.body, 0);
  } catch (e) {
    return { ok: false, reason: `parse failed: ${(e && e.message) || e}`, parts: [], ...meta };
  }
  if (!parts.length) return { ok: false, reason: 'no parts found', parts: [], ...meta };
  return { ok: true, reason: null, parts, ...meta };
}

const trimTrailingCrlf = (b) => {
  let end = b.length;
  while (end > 0 && (b[end - 1] === 0x0a || b[end - 1] === 0x0d)) end--;
  return b.subarray(0, end);
};

module.exports = { partsOf, parseHeaders, paramOf, decodeWords };
