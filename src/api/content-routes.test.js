// Content Studio route tests — run with:  node --test src/api/content-routes.test.js
// Mounts the real router with a faked db.query (patched before require) and a signed JWT,
// then drives the 4 /content endpoints over HTTP. No real DB, no network.

process.env.JWT_SECRET = 'test-secret';
process.env.CONTENT_PIPELINE_ENABLED = ''; // OFF → /content/run is a safe no-op (no I/O)

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

// ── in-memory content_queue behind a fake db.query (matched by SQL shape) ──────
let STORE = [];
function seed() {
  STORE = [
    { id: 1, product: 'golfnex', source_ref: 'https://ex.com/1', topic: 'equipment', segment: 'player', headline: 'H1', body: 'B1', original_headline: null, original_body: null, status: 'draft', reviewed_by: null, reviewed_at: null, edited: false, cost_usd: '0.01', created_at: 100 },
    { id: 2, product: 'golfnex', source_ref: 'https://ex.com/2', topic: 'tournaments', segment: 'facility_owner', headline: 'H2', body: 'B2', original_headline: null, original_body: null, status: 'approved', reviewed_by: 'x', reviewed_at: 1, edited: false, cost_usd: '0.02', created_at: 200 },
    { id: 3, product: 'abiozen', source_ref: 'https://ex.com/3', topic: null, segment: null, headline: 'H3', body: 'B3', original_headline: null, original_body: null, status: 'draft', reviewed_by: null, reviewed_at: null, edited: false, cost_usd: null, created_at: 300 },
  ];
}
seed();

const db = require('../lib/db');
db.query = async (sql, params = []) => {
  if (/UPDATE users SET last_login/i.test(sql)) return { rows: [] }; // authMiddleware fire-and-forget
  if (/FROM content_queue WHERE id = \$1/i.test(sql)) {
    return { rows: STORE.filter(r => String(r.id) === String(params[0])) };
  }
  if (/FROM content_queue/i.test(sql) && /ORDER BY created_at/i.test(sql)) {
    let rows = STORE.slice(), pi = 0;
    if (/product = \$\d/i.test(sql)) { const p = params[pi++]; rows = rows.filter(r => r.product === p); }
    if (/status = \$\d/i.test(sql))  { const s = params[pi++]; rows = rows.filter(r => r.status === s); }
    rows.sort((a, b) => b.created_at - a.created_at);
    return { rows };
  }
  if (/UPDATE content_queue SET status = \$1/i.test(sql)) {
    const [status, reviewer, id] = params;
    const row = STORE.find(r => String(r.id) === String(id));
    if (!row) return { rows: [] };
    row.status = status; row.reviewed_by = reviewer; row.reviewed_at = 1;
    return { rows: [row] };
  }
  if (/UPDATE content_queue\s+SET original_headline/i.test(sql)) {
    const [headline, body, id] = params;
    const row = STORE.find(r => String(r.id) === String(id));
    if (!row) return { rows: [] };
    // COALESCE semantics: capture the original ONCE (from the pre-update row), then apply new.
    row.original_headline = row.original_headline != null ? row.original_headline : row.headline;
    row.original_body = row.original_body != null ? row.original_body : row.body;
    if (headline != null) row.headline = headline;
    if (body != null) row.body = body;
    row.edited = true;
    return { rows: [row] };
  }
  throw new Error('unexpected SQL in fake: ' + sql);
};

const { signToken } = require('../lib/core');
const router = require('./routes');

const app = express();
app.use(express.json());
app.use('/api', router);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const tok = (role) => signToken({ id: 'u-' + role, email: role + '@x.com', role });
function req(method, path, { role, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (role) headers.Authorization = 'Bearer ' + tok(role);
  return fetch(base() + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

// ── auth gates ─────────────────────────────────────────────────────────────────
test('GET /content without a token → 401', async () => {
  const r = await fetch(base() + '/api/content');
  assert.equal(r.status, 401);
});

test('GET /content without intelligence tier (sales_team) → 403', async () => {
  const r = await req('GET', '/api/content', { role: 'sales_team' });
  assert.equal(r.status, 403);
});

test('POST /content/run as non-admin (business_dev) → 403 (adminOnly)', async () => {
  const r = await req('POST', '/api/content/run', { role: 'business_dev', body: {} });
  assert.equal(r.status, 403);
});

// ── list / get ───────────────────────────────────────────────────────────────
test('GET /content lists newest first', async () => {
  seed();
  const r = await req('GET', '/api/content', { role: 'admin' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.items.length, 3);
  assert.deepEqual(j.items.map(i => i.id), [3, 2, 1]); // created_at DESC
});

test('GET /content?product=&status= filters', async () => {
  seed();
  const r = await req('GET', '/api/content?product=golfnex&status=draft', { role: 'admin' });
  const j = await r.json();
  assert.deepEqual(j.items.map(i => i.id), [1]); // only golfnex + draft
});

test('GET /content/:id returns one; 404 when missing', async () => {
  seed();
  const ok = await req('GET', '/api/content/2', { role: 'admin' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).id, 2);
  const missing = await req('GET', '/api/content/999', { role: 'admin' });
  assert.equal(missing.status, 404);
});

// ── approve / reject set status only ───────────────────────────────────────────
test('PUT approve sets status=approved + reviewer, no publish field', async () => {
  seed();
  const r = await req('PUT', '/api/content/1', { role: 'admin', body: { action: 'approve' } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, 'approved');
  assert.equal(j.reviewed_by, 'admin@x.com');
  assert.equal(j.edited, false); // approve is not an edit
});

test('PUT reject sets status=rejected', async () => {
  seed();
  const j = await (await req('PUT', '/api/content/1', { role: 'admin', body: { action: 'reject' } })).json();
  assert.equal(j.status, 'rejected');
});

// ── edit preserves the original, sets edited=true, does not overwrite on 2nd edit ──
test('PUT edit sets edited=true and PRESERVES the original (captured once)', async () => {
  seed();
  const j1 = await (await req('PUT', '/api/content/1', { role: 'admin', body: { action: 'edit', headline: 'NEW H', body: 'NEW B' } })).json();
  assert.equal(j1.edited, true);
  assert.equal(j1.headline, 'NEW H');
  assert.equal(j1.original_headline, 'H1', 'original headline preserved');
  assert.equal(j1.original_body, 'B1', 'original body preserved');
  // a SECOND edit must NOT overwrite the captured original
  const j2 = await (await req('PUT', '/api/content/1', { role: 'admin', body: { action: 'edit', headline: 'NEWER H' } })).json();
  assert.equal(j2.headline, 'NEWER H');
  assert.equal(j2.original_headline, 'H1', 'original still the very first value, not overwritten');
  assert.equal(j2.original_body, 'B1');
});

test('PUT with no/invalid action → 400', async () => {
  seed();
  assert.equal((await req('PUT', '/api/content/1', { role: 'admin', body: { action: 'nope' } })).status, 400);
  assert.equal((await req('PUT', '/api/content/1', { role: 'admin', body: { action: 'edit' } })).status, 400); // edit with no fields
});

test('business_dev (intelligence rw) can approve', async () => {
  seed();
  const r = await req('PUT', '/api/content/1', { role: 'business_dev', body: { action: 'approve' } });
  assert.equal(r.status, 200);
});

// ── run route: never hangs, returns the summary (flag OFF → no-op) ──────────────
test('POST /content/run as admin returns the summary; flag OFF → enabled:false', async () => {
  const r = await req('POST', '/api/content/run', { role: 'admin', body: { product: 'golfnex' } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.enabled, false, 'flag off → no-op summary, request did not hang');
  assert.equal(j.product, 'golfnex');
});
