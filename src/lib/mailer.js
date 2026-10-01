const crypto = require('crypto');
const { query } = require('./db');

// ── THE SENDER DOMAIN ─────────────────────────────────────────────────────────
//
// The default sender was `PlayNexa <naren@abiozen.com>` and it had been FAILING SINCE 4 AUGUST 2026.
// The Resend key is alive and restricted to sending; it is authorized for adificetechnologies.com and
// NOT for abiozen.com:
//
//   403  This API key is not authorized to send emails from abiozen.com
//
// 1,113 internal emails were lost to that over eight weeks — the 6pm score, the coaching emails, the
// briefings — and nothing surfaced it, because sendEmail() returns false and writes a row to email_log
// that nobody reads. The silence was the worse half of the bug; see alertSendFailure below.
//
// MAIL_FROM overrides this. Keep it on a domain the key is actually authorized for, or the same
// failure returns.
const DEFAULT_FROM = 'PlayNexa <no-reply@adificetechnologies.com>';
function defaultFrom(env = process.env) {
  return env.MAIL_FROM || DEFAULT_FROM;
}

// STILL BROKEN, and it needs the Resend dashboard rather than code: the two senders that speak to
// people OUTSIDE the company are on abiozen.com, deliberately, because they are Abiozen's —
//   procurement-agent.js  supplier RFQs as palash@abiozen.com
//   inquiry-agent.js      buyer replies as sales@abiozen.com
// Those keep 403ing until abiozen.com is authorized for this key. Changing THEIR sender would be
// wrong: a supplier should not receive an Abiozen RFQ from a different company's domain.

async function logEmail({ to, subject, status, errorMessage }) {
  try {
    await query(
      `INSERT INTO email_log (id, to_email, subject, status, error_message) VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), to, subject, status, errorMessage || null]
    );
  } catch(e) { console.error('email_log write failed:', e.message); }
}

// A send failure that is CONFIGURATION, not one bad address, must be visible.
//
// This is the actual lesson of the eight-week outage: every layer did the right local thing (return
// false, log the row, do not crash the caller) and the aggregate was silence. A domain authorization
// failure will never fix itself and affects EVERY email, so it goes to the notifications bell where
// somebody sees it.
//
// product NULL = platform-wide, which requires the 'internal' pseudo-product (see products/held.js) —
// so staff see it and a partner account never does. Deduped to one per kind per day: the 6pm agent
// alone would otherwise write a row per recipient per evening.
async function alertSendFailure({ domain, detail }) {
  try {
    const title = `Email sending is broken for ${domain}`;
    const dup = await query(
      `SELECT 1 FROM notifications WHERE kind = 'email_channel' AND title = $1
         AND created_at > NOW() - INTERVAL '20 hours' LIMIT 1`, [title]);
    if (dup.rows.length) return;
    await query(
      `INSERT INTO notifications (product, kind, severity, title, body, link_page, created_at)
       VALUES (NULL, 'email_channel', 'error', $1, $2, 'settings', NOW())`,
      [title, `Resend refused every send from ${domain}. This is an API-key authorization problem, not a `
        + `bad recipient — no email from this domain is being delivered, and it will not recover on its own. `
        + `Authorize the domain on the Resend key, or point MAIL_FROM at a domain that is. Resend said: ${detail}`]);
    console.error(`[mailer] ALERT RAISED — sending from ${domain} is unauthorized: ${detail}`);
  } catch (e) {
    // An alert that cannot be written must not break the send path. Logged loudly instead.
    console.error(`[mailer] could not raise the send-failure alert: ${e.message}`);
  }
}

// ── ATTACHMENTS ───────────────────────────────────────────────────────────────
//
// Resend takes `attachments: [{ filename, content }]` with `content` BASE64 over the JSON API. A Buffer
// is accepted by their SDK but not by the raw endpoint, which is what this uses, so a Buffer is encoded
// here rather than at every call site — a caller that forgot would send `{"0":80,"1":75,...}`, which
// arrives as a file that will not open.
//
// 25 MB is Resend's documented limit for the whole message, and base64 inflates by a third. A send that
// would exceed it is refused HERE with a clear reason, because the provider's own error for an oversized
// message is generic and arrives after the upload.
const MAX_ATTACH_BYTES = 18 * 1024 * 1024;

function encodeAttachments(attachments) {
  if (!attachments) return { ok: true, list: null };
  if (!Array.isArray(attachments)) return { ok: false, error: 'attachments must be an array' };
  const list = [];
  let total = 0;
  for (const a of attachments) {
    if (!a || !a.filename || a.content == null) {
      return { ok: false, error: 'every attachment needs a filename and content' };
    }
    const buf = Buffer.isBuffer(a.content) ? a.content
      : (typeof a.content === 'string' ? Buffer.from(a.content, 'base64') : null);
    if (!buf) return { ok: false, error: `attachment ${a.filename}: content must be a Buffer or base64` };
    if (!buf.length) return { ok: false, error: `attachment ${a.filename} is empty` };
    total += buf.length;
    list.push({ filename: String(a.filename), content: buf.toString('base64') });
  }
  if (total > MAX_ATTACH_BYTES) {
    return { ok: false, error: `attachments total ${(total / 1048576).toFixed(1)} MB, over the ${MAX_ATTACH_BYTES / 1048576} MB limit` };
  }
  return { ok: true, list };
}

// `from` / `replyTo` are optional overrides. Any address on an AUTHORIZED domain works, because the
// domain (not the individual address) is what Resend authorizes — verified by probe: both
// no-reply@ and playnexa@adificetechnologies.com were accepted with the same key.
//
// RETURNS { ok, id, error }. sendEmail() below keeps the boolean contract its 55 callers rely on; this
// exists because a caller that has to PROVE what it sent needs the provider's message id, and a boolean
// cannot carry one. Deliberately NOT done by changing sendEmail's return type to an object: every
// existing `if (await sendEmail(...))` would then be unconditionally true and every failure path in the
// codebase would go quiet — which is the exact shape of the eight-week outage this file already documents.
async function sendEmailDetailed({ to, subject, html, from, replyTo, cc, attachments }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log('No RESEND_API_KEY');
    await logEmail({ to, subject, status: 'failed', errorMessage: 'RESEND_API_KEY not configured' });
    return { ok: false, id: null, error: 'RESEND_API_KEY not configured' };
  }
  const enc = encodeAttachments(attachments);
  if (!enc.ok) {
    // Refused before the request, and still logged: an attachment problem is a send that did not happen,
    // and email_log is where somebody looks for that.
    await logEmail({ to, subject, status: 'failed', errorMessage: enc.error });
    return { ok: false, id: null, error: enc.error };
  }
  try {
    const sender = from || defaultFrom();
    const body = { from: sender, to, subject, html };
    if (replyTo) body.reply_to = replyTo;
    if (cc) body.cc = cc;
    if (enc.list) body.attachments = enc.list;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    const ok = !!data.id;
    // The attachment CONTENT is never logged — it is base64 of a document, it would be megabytes, and the
    // interesting facts are the filename and the size.
    console.log('Email result:', JSON.stringify(data),
      enc.list ? `(${enc.list.length} attachment(s): ${enc.list.map(a => a.filename).join(', ')})` : '');
    await logEmail({ to, subject, status: ok ? 'sent' : 'failed', errorMessage: ok ? null : JSON.stringify(data) });
    if (!ok) {
      // "not authorized to send emails from X" is the one failure that is about the CHANNEL rather than
      // the message, so it is the one that gets escalated out of the log.
      const m = /not authorized to send emails from ([^"'\s]+)/i.exec(String(data.message || ''));
      if (m) await alertSendFailure({ domain: m[1], detail: JSON.stringify(data) });
    }
    return { ok, id: data.id || null, error: ok ? null : (data.message || JSON.stringify(data)) };
  } catch(e) {
    console.error('Email error:', e.message);
    await logEmail({ to, subject, status: 'failed', errorMessage: e.message });
    return { ok: false, id: null, error: e.message };
  }
}

// The original contract, unchanged: a boolean. Every existing caller keeps working.
async function sendEmail(opts) {
  const r = await sendEmailDetailed(opts);
  return r.ok;
}

module.exports = { sendEmail, sendEmailDetailed, encodeAttachments, MAX_ATTACH_BYTES,
                   defaultFrom, DEFAULT_FROM, alertSendFailure };
