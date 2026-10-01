// ── THE ONLY UNAUTHENTICATED WRITE SURFACE IN PLAYBOOKOS ───────────────────────
//
// A client with the link uploads their logo, copy and photos against ONE deal. No account, no
// password, no session. Everything in this file exists to keep that sentence true.
//
// ── MOUNTED BEFORE THE GATES, DELIBERATELY ───────────────────────────────────
//
// server.js mounts this router BEFORE the permissions resolver, the permissions enforcer and the
// product boundary. It has to: all three resolve a product and a template from req.user, and there is
// no req.user here — the boundary would classify /api/intake/* as unresolvable and FAIL CLOSED, which
// is the correct behaviour for an authenticated route and a 403 for every client we send a link to.
//
// That bypass is the most dangerous thing about this file, so it is TESTED rather than trusted:
// src/lib/sitenex/intake-scope.test.js reads server.js and asserts this mount sits above all three
// gates, AND — the one that actually matters — that every path declared in this router begins with
// '/intake/'. Adding '/sitenex/deals/:id' to this router would be a complete authentication bypass,
// and it is the kind of edit that looks harmless in a diff.
//
// ── THE TOKEN TRAVELS IN A HEADER, NOT IN THE PATH ───────────────────────────
//
// The link we email is BASE_URL/intake#<token>. The fragment is never sent to a server, so the
// credential does not appear in Railway's access logs, in any proxy log, or in a Referer header if the
// client clicks something on the page. public/intake.html reads location.hash and sends the token as
// X-Intake-Token. This router reads ONLY that header — there is no path-based form to fall back to,
// because a fallback that logs the credential is the same as not having done this.
//
// ── UPLOAD-ONLY SCOPE ────────────────────────────────────────────────────────
//
// consume() returns { id, deal_id } and nothing else: the token resolves to a DEAL ID, never to a deal.
// The one deal column read in this file is company_name, and the reason is written at the SELECT. No
// price, no payment schedule, no contract, no contact details, no partner, no prospect, and no row
// belonging to any other client. Asserted NEGATIVELY in intake-scope.test.js against the response body
// and against this source, rather than left to depend on nobody adding a column later.

const express = require('express');
const multer = require('multer');
const { query, withTransaction } = require('../lib/db');
const {
  consume, classifyUpload, MAX_FILE_BYTES, MAX_DEAL_BYTES, mb,
} = require('../lib/sitenex/intake-token');
const { completeIntake } = require('../lib/sitenex/intake-complete');
const { missingItems } = require('../lib/sitenex/intake-required');
const { fireBrief } = require('../lib/sitenex/intake-brief');

const router = express.Router();

// withTransaction hands back a pg client. Every helper in here takes a FUNCTION instead, because
// passing client.query detaches it from its `this` — that cost us a contract email that sent while
// nothing was logged.
const txFn = (client) => (sql, params) => client.query(sql, params);

const tokenFrom = (req) => req.get('X-Intake-Token') || '';

// Nothing here is cacheable and nothing here should be indexed, framed, or sniffed. Applied to the
// whole router so a route added later cannot forget it.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

// ── the multipart reader ──────────────────────────────────────────────────────
//
// fileSize is enforced by multer itself, which aborts the stream rather than buffering past the limit —
// so a 2GB POST costs us 10MB of memory and a connection, not 2GB. That is the per-request bound, and
// it is in place BEFORE any of our code runs.
//
// The per-DEAL cap cannot be enforced here (it needs a query), so a file that is under 10MB but over
// the deal's remaining quota is read into memory and then refused. Bounded and deliberate: the rate
// limiter caps a token at 60 requests an hour, so the worst a single link can make us read and discard
// is ~600MB/hour, which is not a lever worth more code than this paragraph.
const readFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 4, parts: 8 },
}).single('file');

function withFile(req, res, next) {
  readFile(req, res, (err) => {
    if (!err) return next();
    const tooBig = err && (err.code === 'LIMIT_FILE_SIZE');
    return res.status(tooBig ? 413 : 400).json({
      error: tooBig
        ? `That file is larger than the ${mb(MAX_FILE_BYTES)}MB limit. If it is a photo, your phone can usually export a smaller copy.`
        : 'We could not read that upload. Please try again.',
      code: tooBig ? 'file_too_large' : 'unreadable_upload',
    });
  });
}

// Resolve + rate-limit, then run `fn({ dealId, linkId, tx })` inside the SAME transaction.
//
// One transaction for the check and the work, so a request that is refused leaves nothing behind and a
// request that is accepted has already paid for its own rate-limit accounting.
async function viaToken(req, res, { bytes = 0 } = {}, fn) {
  try {
    const out = await withTransaction(async (client) => {
      const tx = txFn(client);
      const gate = await consume(tx, { token: tokenFrom(req), bytes });
      if (!gate.ok) return { refused: gate };
      const body = await fn({ dealId: gate.deal_id, linkId: gate.id, tx });
      return { body };
    });
    if (out.refused) {
      const g = out.refused;
      if (g.retry_after_s) res.set('Retry-After', String(g.retry_after_s));
      return res.status(g.status).json({ error: g.message, code: g.code });
    }
    // A handler may ask for a side effect AFTER the commit — the brief, which must not be inside a
    // transaction and must not delay the response.
    const after = out.body && out.body.__after;
    if (after) delete out.body.__after;
    res.json(out.body);
    if (after) after();
  } catch (e) {
    console.error('[intake]', e.message);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again in a moment.', code: 'server_error' });
  }
}

// What the client sees. Enumerated by hand, and short on purpose.
async function statusFor(tx, dealId) {
  // ── THE ONE DEAL COLUMN THIS FILE READS ─────────────────────────────────────
  //
  // company_name AND NOTHING ELSE. Not value_cents, not monthly_cents, not contact_email, not
  // client_address, not terms_note, not partner_id, not prospect_id.
  //
  // Why company_name is in and not out: the page has to say whose project it is, or a client who was
  // sent a bare "upload your files" page by a studio they spoke to once will reasonably assume it is
  // phishing and not use it. It is their OWN name, shown to somebody we emailed the link to, so the
  // worst case for a forwarded link is that the holder learns a business is having a site built.
  // Everything a leak would actually cost — the price, the terms, the contact — is excluded.
  //
  // If you are adding a column here: do not. Add it to the staff route instead.
  const deal = (await tx(`SELECT company_name FROM sitenex_deals WHERE id = $1`, [dealId])).rows[0];
  const intake = (await tx(
    `SELECT fields, required, completed_at FROM sitenex_intake WHERE deal_id = $1`, [dealId])).rows[0];
  const files = (await tx(
    `SELECT id, file_name, field, file_size, uploaded_at FROM sitenex_intake_files
      WHERE deal_id = $1 ORDER BY uploaded_at`, [dealId])).rows;

  const used = files.reduce((n, f) => n + Number(f.file_size || 0), 0);
  const fields = (intake && intake.fields && typeof intake.fields === 'object') ? intake.fields : {};
  const required = Array.isArray(intake && intake.required) ? intake.required : [];

  return {
    company_name: (deal && deal.company_name) || null,
    complete: !!(intake && intake.completed_at),
    completed_at: (intake && intake.completed_at) || null,
    // Echoed back because this is a form a client returns to across several weeks, and a form that
    // forgets what they typed last Tuesday is a form they abandon.
    fields,
    required,
    missing: missingItems(required, fields, files),
    files: files.map(f => ({ id: f.id, name: f.file_name, field: f.field,
                             size: Number(f.file_size), uploaded_at: f.uploaded_at })),
    quota: { used_bytes: used, limit_bytes: MAX_DEAL_BYTES,
             remaining_bytes: Math.max(0, MAX_DEAL_BYTES - used),
             per_file_bytes: MAX_FILE_BYTES },
  };
}

// ── GET /api/intake — what do we still need? ───────────────────────────────────
router.get('/intake', (req, res) =>
  viaToken(req, res, {}, async ({ dealId, tx }) => statusFor(tx, dealId)));

// ── POST /api/intake/fields — the text answers ─────────────────────────────────
//
// Merged into sitenex_intake.fields rather than replacing it, so a client answering two boxes in a
// second session does not wipe the four they answered in the first.
router.post('/intake/fields', async (req, res) => {
  const patch = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!patch) return res.status(400).json({ error: 'Nothing to save.', code: 'bad_body' });

  const keys = Object.keys(patch);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to save.', code: 'bad_body' });
  if (keys.length > 40) return res.status(400).json({ error: 'That is more fields than this form has.', code: 'too_many_fields' });
  const clean = {};
  for (const k of keys) {
    if (String(k).length > 64) return res.status(400).json({ error: 'Unexpected field name.', code: 'bad_field' });
    const v = patch[k];
    if (v != null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean' && !Array.isArray(v)) {
      return res.status(400).json({ error: 'Unexpected value.', code: 'bad_value' });
    }
    // A cap per value, because an unauthenticated endpoint that accepts unbounded text into JSONB is a
    // storage-bloat surface with no file attached to it.
    const s = Array.isArray(v) ? v.map(x => String(x).slice(0, 2000)) : (v == null ? null : String(v).slice(0, 20000));
    clean[k] = s;
  }

  return viaToken(req, res, {}, async ({ dealId, tx }) => {
    const done = (await tx(`SELECT completed_at FROM sitenex_intake WHERE deal_id = $1`, [dealId])).rows[0];
    if (done && done.completed_at) {
      return { closed: true, message: 'Your intake is already complete, so there is nothing more to send.' };
    }
    await tx(
      `INSERT INTO sitenex_intake (deal_id, fields, required)
       VALUES ($1, $2::jsonb, '[]'::jsonb)
       ON CONFLICT (deal_id) DO UPDATE SET fields = sitenex_intake.fields || $2::jsonb`,
      [dealId, JSON.stringify(clean)]);
    return { saved: keys.length, ...(await statusFor(tx, dealId)) };
  });
});

// ── POST /api/intake/files — one upload ────────────────────────────────────────
router.post('/intake/files', withFile, async (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: 'No file was attached.', code: 'no_file' });

  // Type and size are decided BEFORE the token is spent, so a client sending a video does not burn a
  // request against their rate limit for a refusal that had nothing to do with the link.
  const verdict = classifyUpload({ name: f.originalname, type: f.mimetype, size: f.size });
  if (!verdict.ok) {
    return res.status(verdict.code === 'file_too_large' ? 413 : 415)
              .json({ error: verdict.message, code: verdict.code });
  }

  const field = typeof (req.body && req.body.field) === 'string' ? req.body.field.slice(0, 64) : null;

  return viaToken(req, res, { bytes: f.size }, async ({ dealId, linkId, tx }) => {
    const done = (await tx(`SELECT completed_at FROM sitenex_intake WHERE deal_id = $1`, [dealId])).rows[0];
    // THE LINK STOPS ACCEPTING UPLOADS ONCE INTAKE IS COMPLETE. Completion revokes the token, so this
    // is normally unreachable — it is the second belt for the case where somebody un-completes an
    // intake by hand without re-issuing.
    if (done && done.completed_at) {
      return { closed: true, message: 'Your intake is already complete, so we are no longer accepting files. Reply to our email if you need to send something else.' };
    }
    // Filename is stored, never used as a path. There is no filesystem in this path at all — the bytes
    // go to a BYTEA column — so traversal has nowhere to go; it is trimmed because it is displayed.
    const name = String(f.originalname || 'upload').replace(/[\r\n\t]/g, ' ').slice(0, 255);
    const row = (await tx(
      `INSERT INTO sitenex_intake_files (deal_id, link_id, field, file_name, content_type, file_size, file_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [dealId, linkId, field, name, f.mimetype, f.size, f.buffer])).rows[0];
    return { uploaded: { id: row.id, name, size: f.size }, ...(await statusFor(tx, dealId)) };
  });
});

// ── DELETE /api/intake/files/:id — they sent the wrong one ─────────────────────
//
// Scoped by deal_id in the WHERE, not by the id alone: without it a client could delete another
// client's upload by guessing an integer, which is the same mistake as an unscoped GET /:id.
router.delete('/intake/files/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Unknown file.', code: 'bad_id' });
  return viaToken(req, res, {}, async ({ dealId, tx }) => {
    const done = (await tx(`SELECT completed_at FROM sitenex_intake WHERE deal_id = $1`, [dealId])).rows[0];
    if (done && done.completed_at) {
      return { closed: true, message: 'Your intake is already complete, so it can no longer be changed.' };
    }
    const r = await tx(`DELETE FROM sitenex_intake_files WHERE id = $1 AND deal_id = $2`, [id, dealId]);
    return { deleted: r.rowCount, ...(await statusFor(tx, dealId)) };
  });
});

// ── POST /api/intake/complete — "I'm finished" ─────────────────────────────────
//
// Creates the developer's task from the RAW intake, inside the transaction. The brief is fired after
// the response, by fireBrief, and the task does not depend on it.
router.post('/intake/complete', async (req, res) =>
  viaToken(req, res, {}, async ({ dealId, tx }) => {
    const r = await completeIntake(tx, { dealId, by: null });
    if (!r.ok) return { error: r.message, code: r.code };
    return {
      complete: true,
      message: r.message,
      // Runs after res.json, so the client is answered first and an LLM call cannot make them wait or
      // show them a failure. Already-complete intakes do not re-fire it.
      __after: r.already ? null : () => fireBrief({ dealId, taskId: r.task_id }),
    };
  }));

module.exports = router;
module.exports.MOUNT_NOTE = 'must be mounted BEFORE permissions/shadow, permissions/enforce and productBoundary — see intake-scope.test.js';
