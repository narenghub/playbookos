// Notifications route tests — run with:  node --test src/api/notifications-routes.test.js
// Mounts the real router with a faked db.query (matched by SQL shape) + a signed JWT. No real DB.

process.env.JWT_SECRET = 'test-secret';

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

let STORE = [];
function seed() {
  STORE = [
    { id: 1, product: 'golfnex', kind: 'approval_pending', severity: 'info',  title: '2 drafts awaiting approval', body: 'x', link_page: 'content-studio', read_at: null, created_at: 300 },
    { id: 2, product: 'golfnex', kind: 'agent_failed',     severity: 'error', title: 'Prospecting: 1 error',         body: 'y', link_page: 'prospects',      read_at: 1,    created_at: 200 },
    { id: 3, product: null,      kind: 'budget',           severity: 'warning', title: 'RI cost fuse hit',          body: 'z', link_page: 'clinical-demand-intelligence', read_at: null, created_at: 100 },
  ];
}
seed();

const db = require('../lib/db');
db.query = async (sql, params = []) => {
  if (/UPDATE users SET last_login/i.test(sql)) return { rows: [] };                       // authMiddleware
  if (/COUNT\(\*\)::int n FROM notifications WHERE read_at IS NULL/i.test(sql)) {
    return { rows: [{ n: STORE.filter(r => r.read_at == null).length }] };
  }
  if (/FROM notifications/i.test(sql) && /ORDER BY created_at DESC/i.test(sql)) {
    let rows = STORE.slice().sort((a, b) => b.created_at - a.created_at);
    if (/WHERE read_at IS NULL/i.test(sql)) rows = rows.filter(r => r.read_at == null);
    const lim = /LIMIT (\d+)/i.exec(sql); if (lim) rows = rows.slice(0, +lim[1]);
    return { rows };
  }
  if (/UPDATE notifications SET read_at = COALESCE\(read_at, NOW\(\)\) WHERE id = \$1/i.test(sql)) {
    const row = STORE.find(r => String(r.id) === String(params[0]));
    if (!row) return { rows: [] };
    if (row.read_at == null) row.read_at = 999;
    return { rows: [row] };
  }
  if (/UPDATE notifications SET read_at = NOW\(\) WHERE read_at IS NULL/i.test(sql)) {
    const unread = STORE.filter(r => r.read_at == null);
    unread.forEach(r => { r.read_at = 999; });
    return { rowCount: unread.length, rows: [] };
  }
  throw new Error('unexpected SQL in fake: ' + sql);
};

const { signToken } = require('../lib/core');
const router = require('./routes');
const app = express(); app.use(express.json()); app.use('/api', router);
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
test('GET /notifications without a token → 401', async () => {
  assert.equal((await fetch(base() + '/api/notifications')).status, 401);
});
test('GET /notifications without intelligence tier (sales_team) → 403', async () => {
  assert.equal((await req('GET', '/api/notifications', { role: 'sales_team' })).status, 403);
});
test('PUT read with intelligence READ but not WRITE (dev_team) → 403', async () => {
  // dev_team has intelligence:'r' → can GET but not write
  assert.equal((await req('GET', '/api/notifications', { role: 'dev_team' })).status, 200);
  assert.equal((await req('PUT', '/api/notifications/1/read', { role: 'dev_team' })).status, 403);
  assert.equal((await req('POST', '/api/notifications/read-all', { role: 'dev_team' })).status, 403);
});

// ── list / filter / limit ──────────────────────────────────────────────────────
test('GET /notifications lists newest first + unread count', async () => {
  seed();
  const j = await (await req('GET', '/api/notifications', { role: 'business_dev' })).json();
  assert.deepEqual(j.items.map(i => i.id), [1, 2, 3]);   // created_at DESC
  assert.equal(j.unread, 2);                              // ids 1 + 3
});
test('GET /notifications?unread=true filters to unread', async () => {
  seed();
  const j = await (await req('GET', '/api/notifications?unread=true', { role: 'business_dev' })).json();
  assert.deepEqual(j.items.map(i => i.id), [1, 3]);
});
test('GET /notifications?limit=1 caps the list (unread count still total)', async () => {
  seed();
  const j = await (await req('GET', '/api/notifications?limit=1', { role: 'business_dev' })).json();
  assert.equal(j.items.length, 1); assert.equal(j.items[0].id, 1); assert.equal(j.unread, 2);
});

// ── mark read / read-all ────────────────────────────────────────────────────────
test('PUT /notifications/:id/read marks one read; 404 when missing', async () => {
  seed();
  const r = await req('PUT', '/api/notifications/1/read', { role: 'business_dev' });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).read_at != null);
  assert.equal((await req('GET', '/api/notifications?unread=true', { role: 'business_dev' }).then(x => x.json())).unread, 1);
  assert.equal((await req('PUT', '/api/notifications/999/read', { role: 'business_dev' })).status, 404);
});
test('POST /notifications/read-all marks every unread read', async () => {
  seed();
  const r = await req('POST', '/api/notifications/read-all', { role: 'business_dev' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).marked, 2);
  assert.equal((await req('GET', '/api/notifications', { role: 'business_dev' }).then(x => x.json())).unread, 0);
});
