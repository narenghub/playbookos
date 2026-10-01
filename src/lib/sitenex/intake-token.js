// ── THE INTAKE LINK: a bearer credential, and everything that constrains it ────
//
// One deal, one link, no account. A client uses it across several sessions over several weeks to hand
// over a logo, copy and photos. It is the ONLY unauthenticated write surface in PlaybookOS, which is
// why the three properties below are in one file with their reasoning attached, rather than spread
// across a handler where the next person would have to infer them.
//
//   HASHED        the token is never stored. token_hash = sha256(token).
//   UPLOAD-ONLY   resolving a token yields { id, deal_id } and NOTHING ELSE. Not the price, not the
//                 contract, not the client's contact details, not another deal.
//   LIMITED       requests and bytes are capped per link, and the per-deal cap REFUSES rather than
//                 truncating.
//
// ── WHY sha256 AND NOT bcrypt ────────────────────────────────────────────────
//
// bcrypt/argon2 exist to make guessing a LOW-ENTROPY secret slow — a human-chosen password has maybe
// 30 bits and a fast hash lets an attacker try billions. This token is 32 bytes from
// crypto.randomBytes: 256 bits, uniformly distributed, with nothing to guess and no dictionary to try.
// A work factor buys nothing against that, and it COSTS something real: a deliberate 100ms per
// verification on an unauthenticated endpoint is a second denial-of-service lever, paid before the
// rate limiter gets to refuse the request. Fast hash, high entropy — the same reasoning as a GitHub
// personal access token.
//
// The hash also has to be DETERMINISTIC, because the lookup is by hash: a salted scheme would mean
// reading every live row and comparing one by one, which is both slower and a worse shape (it touches
// every other client's row to answer a question about one).
//
// ── WHY THE ALLOWLIST REFUSES, AND NAMES VIDEO SEPARATELY ────────────────────
//
// Anything not on the list is refused; the list is types a small-business website is actually built
// from. Video gets its OWN refusal message because it is the one a client will genuinely hit — a phone
// clip is 50-500MB and would go into Postgres, into every backup, forever — and a generic "that file
// type is not allowed" would leave them with no idea what to do. Told plainly, they send a link
// instead, which is what we want anyway.
//
// SVG is excluded ON PURPOSE even though a logo is often one: an SVG is a script-bearing document, and
// accepting one from an unauthenticated endpoint into a system that may one day display it inline is a
// stored-XSS primitive we would be installing ourselves. The message asks for a PNG.

const crypto = require('crypto');

const TOKEN_BYTES = 32;            // 256 bits. See the hash note above.
const LIFETIME_DAYS = 30;          // clients take weeks to gather a logo and copy; shorter means re-issuing

// CAPS — the BYTEA interim. Doubled once bytes live in a bucket (25MB/file, 250MB/deal).
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DEAL_BYTES = 50 * 1024 * 1024;

// REQUEST CAPS. Two of them, because they stop different things: the window stops a burst, the total
// stops a slow grind that a window alone would permit indefinitely.
const MAX_REQUESTS_PER_WINDOW = 60;
const WINDOW_MS = 60 * 60 * 1000;  // one hour
const MAX_REQUESTS_TOTAL = 600;    // ~a dozen sessions of heavy use; a client will never see this

const ALLOWED_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/rtf': 'rtf',
  'application/zip': 'zip',          // a brand folder arrives as one; the bytes are not inspected
};

// Matched on the FILENAME as well as the mime type, because a phone upload frequently arrives as
// application/octet-stream and the extension is then the only evidence of what it is.
const VIDEO_EXT = /\.(mov|mp4|m4v|avi|mkv|webm|wmv|flv|3gp|3g2|mpg|mpeg|hevc|mts|m2ts)$/i;
const AUDIO_EXT = /\.(mp3|wav|aac|m4a|flac|ogg|wma)$/i;

// ── token ─────────────────────────────────────────────────────────────────────

const hashToken = (token) => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');

function newToken() {
  // base64url so it survives a URL, an email client's linkifier and a copy-paste without encoding.
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashToken(token), tail: token.slice(-4) };
}

// A constant-time comparison of two hex digests.
//
// The lookup in resolve() is BY hash against a unique index, so the comparison that matters happens
// inside Postgres and this is not on the critical path today. It is here, and used, so that the shape
// stays right: if somebody later changes the lookup to fetch a row and compare in JS — which is what
// introducing a salt would force — the comparison they reach for is already the safe one.
function sameDigest(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// Is this even shaped like one of our tokens? Checked before touching the database so a scanner
// spraying /api/intake/wp-admin costs one regex instead of one query.
const PLAUSIBLE = /^[A-Za-z0-9_-]{40,64}$/;
const looksLikeToken = (t) => PLAUSIBLE.test(String(t || ''));

const expiryFrom = (now = new Date(), days = LIFETIME_DAYS) =>
  new Date(now.getTime() + days * 86400000);

// ── what a file may be ────────────────────────────────────────────────────────
//
// Returns { ok: true, ext } or { ok: false, code, message }. The message is written to be read by the
// CLIENT — a small-business owner on a phone — not by us.
function classifyUpload({ name = '', type = '', size = 0 } = {}) {
  const fn = String(name || '');
  const mt = String(type || '').toLowerCase().split(';')[0].trim();

  if (/^video\//.test(mt) || VIDEO_EXT.test(fn)) {
    return { ok: false, code: 'video_not_accepted', message:
      'We cannot accept video here — a single clip is larger than this whole form allows. Please upload a photo instead, ' +
      'and if you have a video, reply to our email with a YouTube, Vimeo or Google Drive link and we will use it from there.' };
  }
  if (/^audio\//.test(mt) || AUDIO_EXT.test(fn)) {
    return { ok: false, code: 'audio_not_accepted', message:
      'We cannot accept audio files here. Please reply to our email with a link to it instead.' };
  }
  if (mt === 'image/svg+xml' || /\.svgz?$/i.test(fn)) {
    return { ok: false, code: 'svg_not_accepted', message:
      'We cannot accept SVG files. Please send your logo as a PNG — ideally at least 1000 pixels wide, with a transparent background if you have one.' };
  }
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_TYPES, mt)) {
    return { ok: false, code: 'type_not_accepted', message:
      `We cannot accept "${fn || 'that file'}". Images (PNG, JPG), PDFs, Word and Excel documents, and ZIP folders are fine.` };
  }
  if (!(size > 0)) {
    return { ok: false, code: 'empty_file', message: 'That file appears to be empty. Please try again.' };
  }
  if (size > MAX_FILE_BYTES) {
    return { ok: false, code: 'file_too_large', message:
      `That file is ${mb(size)}MB and the limit is ${mb(MAX_FILE_BYTES)}MB per file. If it is a photo, your phone can usually export a smaller copy.` };
  }
  return { ok: true, ext: ALLOWED_TYPES[mt] };
}

const mb = (b) => Math.round((b / 1048576) * 10) / 10;

// ── resolve + rate-limit, in one locked read ──────────────────────────────────
//
// MUST be called with a transaction client, because the whole point is that the read of the counters
// and the write of the counters cannot be separated: two uploads arriving together would otherwise
// both read 49MB, both decide they fit, and both commit.
//
// RETURNS { id, deal_id } FROM THE LINK AND NOTHING ELSE — this is the upload-only scope, expressed as
// the narrowest possible SELECT rather than as a promise that the caller will be careful. There is no
// join to sitenex_deals here and there must never be one: the handler cannot leak a price it was never
// given. A test asserts that negatively.
//
// `bytes` is the size of the upload this request carries, 0 for a read. The per-deal cap is checked
// against the SUM of what is actually stored, not against the link's own counter, because a deal can
// have had two links and the 50MB is a property of the DEAL.
async function consume(tx, { token, bytes = 0, now = new Date() } = {}) {
  // A FUNCTION, not a client with a .query property — `logSend(tx.query, …)` detached pg's method once
  // already and an email sent while nothing was recorded. Failing loudly here beats racing quietly:
  // called outside a transaction, the read of the counters and the write of them come apart and two
  // concurrent uploads can both pass the last byte of a cap.
  if (typeof tx !== 'function') {
    throw new Error('intake-token.consume: pass (sql, params) => client.query(sql, params) from withTransaction, not the client');
  }
  const deny = (status, code, message, extra) => ({ ok: false, status, code, message, ...extra });

  if (!looksLikeToken(token)) {
    // The SAME message as a revoked or expired link, deliberately: distinguishing "no such token" from
    // "that token is dead" tells somebody enumerating that they found a real one.
    return deny(404, 'invalid_link', 'This link is not valid. Please ask for a new one.');
  }
  const hash = hashToken(token);

  const { rows } = await tx(
    `SELECT id, deal_id, token_hash, expires_at, revoked_at,
            request_count, bytes_uploaded, window_started_at, window_requests
       FROM sitenex_intake_links
      WHERE token_hash = $1
      FOR UPDATE`, [hash]);
  const link = rows[0];
  if (!link) return deny(404, 'invalid_link', 'This link is not valid. Please ask for a new one.');
  // Belt, and the reason sameDigest exists. The index already decided this.
  if (!sameDigest(link.token_hash, hash)) {
    return deny(404, 'invalid_link', 'This link is not valid. Please ask for a new one.');
  }
  if (link.revoked_at) {
    return deny(410, 'link_revoked', 'This link has been replaced. Please use the most recent link we sent you, or ask us for a new one.');
  }
  if (new Date(link.expires_at).getTime() <= now.getTime()) {
    return deny(410, 'link_expired', 'This link has expired. Reply to our email and we will send you a fresh one.');
  }

  // ── the window ────────────────────────────────────────────────────────────
  const windowOpen = link.window_started_at &&
    (now.getTime() - new Date(link.window_started_at).getTime()) < WINDOW_MS;
  const windowRequests = windowOpen ? link.window_requests : 0;
  if (windowRequests >= MAX_REQUESTS_PER_WINDOW) {
    const retryMs = WINDOW_MS - (now.getTime() - new Date(link.window_started_at).getTime());
    return deny(429, 'rate_limited',
      'That is a lot of requests in a short time. Please wait a few minutes and try again.',
      { retry_after_s: Math.max(60, Math.ceil(retryMs / 1000)) });
  }
  if (link.request_count >= MAX_REQUESTS_TOTAL) {
    return deny(429, 'link_exhausted',
      'This link has been used too many times. Reply to our email and we will send you a fresh one.');
  }

  // ── the bytes, measured against the DEAL ──────────────────────────────────
  if (bytes > 0) {
    const stored = (await tx(
      `SELECT COALESCE(SUM(file_size), 0)::bigint AS total FROM sitenex_intake_files WHERE deal_id = $1`,
      [link.deal_id])).rows[0].total;
    const used = Number(stored);
    // REFUSE, NOT TRUNCATE. A half-written logo is worse than no logo, because it looks like a
    // success to everybody downstream and like a corrupt file only to the person who opens it.
    if (used + bytes > MAX_DEAL_BYTES) {
      const left = Math.max(0, MAX_DEAL_BYTES - used);
      return deny(413, 'deal_quota_exceeded',
        left < 51200
          ? `You have reached the ${mb(MAX_DEAL_BYTES)}MB total for this project. Please reply to our email and we will make room.`
          : `That file does not fit — you have ${mb(left)}MB of ${mb(MAX_DEAL_BYTES)}MB left for this project. Try a smaller copy, or reply to our email and we will make room.`,
        { used_bytes: used, limit_bytes: MAX_DEAL_BYTES, remaining_bytes: left });
    }
  }

  await tx(
    `UPDATE sitenex_intake_links
        SET request_count     = request_count + 1,
            bytes_uploaded    = bytes_uploaded + $2,
            last_used_at      = $3,
            window_started_at = CASE WHEN $4::boolean THEN window_started_at ELSE $3 END,
            window_requests   = CASE WHEN $4::boolean THEN window_requests + 1 ELSE 1 END
      WHERE id = $1`,
    [link.id, bytes, now, !!windowOpen]);

  // NOTHING ELSE. See the note above the function.
  return { ok: true, id: link.id, deal_id: link.deal_id };
}

module.exports = {
  newToken, hashToken, sameDigest, looksLikeToken, expiryFrom, classifyUpload, consume, mb,
  TOKEN_BYTES, LIFETIME_DAYS, MAX_FILE_BYTES, MAX_DEAL_BYTES,
  MAX_REQUESTS_PER_WINDOW, MAX_REQUESTS_TOTAL, WINDOW_MS, ALLOWED_TYPES,
};
