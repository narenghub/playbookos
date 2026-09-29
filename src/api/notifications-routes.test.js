// Notifications route tests — run with:  node --test src/api/notifications-routes.test.js
// Mounts the real router with a faked db.query (matched by SQL shape) + a signed JWT. No real DB.
//
// The fake models the `user_products` table and honours the product scope fragment, because the
// scoping is the thing under test: the route is shared, the TABLE is product-bearing, and an
// unscoped read handed every logged-in user every other product's alerts.

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
    { id: 4, product: 'sitenex',    kind: 'agent_failed',     severity: 'error', title: 'SiteNex prospecting: 3 errors',  body: 'w', link_page: 'sitenex-prospects',  read_at: null, created_at: 50 },
  ];
}
seed();

// Who holds what. Staff hold everything (that is the backfill); the partner holds one product and
// NOT 'internal', so platform-wide (NULL product) rows are invisible to them.
const HELD = {
  'u-business_dev': ['abiozen', 'golfnex', 'favly', 'linkabl', 'aros', 'sitenex', 'internal'],
  'u-dev_team':     ['abiozen', 'golfnex', 'favly', 'linkabl', 'aros', 'sitenex', 'internal'],
  'u-partner':      ['sitenex'],
};

// Apply the scope the way Postgres would: `product = ANY($n)` [ OR product IS NULL ].
function scopeFilter(sql, params, rows) {
  const m = /product = ANY\(\$(\d+)\)/.exec(sql);
  if (!m) throw new Error('scope fragment missing from SQL — the product filter was dropped: ' + sql);
  const held = params[+m[1] - 1] || [];
  const nullsToo = /product IS NULL/.test(sql);
  return rows.filter(r => held.includes(r.product) || (r.product === null && nullsToo));
}

const db = require('../lib/db');
db.query = async (sql, params = []) => {
  if (/UPDATE users SET last_login/i.test(sql)) return { rows: [] };                       // authMiddleware
  if (/FROM user_products WHERE user_id/i.test(sql)) {
    return { rows: (HELD[params[0]] || []).map(product => ({ product })) };
  }
  if (/COUNT\(\*\)::int n FROM notifications/i.test(sql)) {
    return { rows: [{ n: scopeFilter(sql, params, STORE).filter(r => r.read_at == null).length }] };
  }
  if (/FROM notifications/i.test(sql) && /ORDER BY created_at DESC/i.test(sql)) {
    let rows = scopeFilter(sql, params, STORE).sort((a, b) => b.created_at - a.created_at);
    if (/AND read_at IS NULL/i.test(sql)) rows = rows.filter(r => r.read_at == null);
    const lim = /LIMIT (\d+)/i.exec(sql); if (lim) rows = rows.slice(0, +lim[1]);
    return { rows };
  }
  if (/UPDATE notifications SET read_at = COALESCE\(read_at, NOW\(\)\)/i.test(sql)) {
    const row = scopeFilter(sql, params, STORE).find(r => String(r.id) === String(params[0]));
    if (!row) return { rows: [] };
    if (row.read_at == null) row.read_at = 999;
    return { rows: [row] };
  }
  if (/UPDATE notifications SET read_at = NOW\(\) WHERE read_at IS NULL/i.test(sql)) {
    const unread = scopeFilter(sql, params, STORE).filter(r => r.read_at == null);
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

// `as` lets a test act as a user id that is not derived from the role, so a partner account can hold
// business_dev's permissions while holding only one product.
const tok = (role, as) => signToken({ id: as || ('u-' + role), email: role + '@x.com', role });
function req(method, path, { role, body, as } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (role) headers.Authorization = 'Bearer ' + tok(role, as);
  return fetch(base() + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
const asPartner = { role: 'business_dev', as: 'u-partner' };

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
  assert.deepEqual(j.items.map(i => i.id), [1, 2, 3, 4]);   // created_at DESC
  assert.equal(j.unread, 3);                                 // ids 1, 3, 4
});
test('GET /notifications?unread=true filters to unread', async () => {
  seed();
  const j = await (await req('GET', '/api/notifications?unread=true', { role: 'business_dev' })).json();
  assert.deepEqual(j.items.map(i => i.id), [1, 3, 4]);
});
test('GET /notifications?limit=1 caps the list (unread count still total)', async () => {
  seed();
  const j = await (await req('GET', '/api/notifications?limit=1', { role: 'business_dev' })).json();
  assert.equal(j.items.length, 1); assert.equal(j.items[0].id, 1); assert.equal(j.unread, 3);
});

// ── mark read / read-all ────────────────────────────────────────────────────────
test('PUT /notifications/:id/read marks one read; 404 when missing', async () => {
  seed();
  const r = await req('PUT', '/api/notifications/1/read', { role: 'business_dev' });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).read_at != null);
  assert.equal((await req('GET', '/api/notifications?unread=true', { role: 'business_dev' }).then(x => x.json())).unread, 2);
  assert.equal((await req('PUT', '/api/notifications/999/read', { role: 'business_dev' })).status, 404);
});
test('POST /notifications/read-all marks every unread read', async () => {
  seed();
  const r = await req('POST', '/api/notifications/read-all', { role: 'business_dev' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).marked, 3);
  assert.equal((await req('GET', '/api/notifications', { role: 'business_dev' }).then(x => x.json())).unread, 0);
});

// ── product scoping — the reason the fake knows about user_products ─────────────
test('a single-product user sees ONLY their product, and no platform-wide rows', async () => {
  seed();
  const j = await (await req('GET', '/api/notifications', asPartner)).json();
  assert.deepEqual(j.items.map(i => i.id), [4], 'only the sitenex row');
  assert.equal(j.unread, 1, 'the badge count is scoped too — an unexplainable number is still a leak');
  assert.ok(!JSON.stringify(j).includes('golfnex'), 'no other product name reaches the response');
  assert.ok(!JSON.stringify(j).includes('cost fuse'), "NULL product is platform-wide and needs 'internal'");
});

test('marking a row of a product you do not hold reads as 404, not 403', async () => {
  seed();
  // 404 is deliberate: it is the same answer as a row that does not exist, so a prober learns nothing
  // about which ids are real.
  assert.equal((await req('PUT', '/api/notifications/1/read', asPartner)).status, 404);
  assert.equal(STORE.find(r => r.id === 1).read_at, null, 'and the row is genuinely untouched');
  assert.equal((await req('PUT', '/api/notifications/4/read', asPartner)).status, 200, 'their own row still works');
});

test('read-all marks only the products the caller holds', async () => {
  seed();
  const r = await req('POST', '/api/notifications/read-all', asPartner);
  assert.equal((await r.json()).marked, 1);
  assert.equal(STORE.find(r => r.id === 4).read_at, 999, 'their own row was marked');
  assert.deepEqual(STORE.filter(r => r.read_at == null).map(r => r.id), [1, 3],
    "everyone else's notifications stay unread — one click must not clear the org");
});

test('holding no products at all shows nothing rather than everything', async () => {
  seed();
  const j = await (await req('GET', '/api/notifications', { role: 'business_dev', as: 'u-nobody' })).json();
  assert.deepEqual(j.items, [], 'the failure direction is empty, not open');
  assert.equal(j.unread, 0);
  assert.equal((await req('POST', '/api/notifications/read-all', { role: 'business_dev', as: 'u-nobody' })
    .then(x => x.json())).marked, 0);
});
