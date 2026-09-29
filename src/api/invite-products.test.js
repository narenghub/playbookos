// Invite → product grant tests — run with:  node --test src/api/invite-products.test.js
// Real router, faked db.query matched by SQL shape, signed JWTs. No real DB, no email (sendEmail is
// stubbed, so nothing leaves the process).
//
// The property under test is WHEN a grant exists. Products are chosen at invite time and written to
// user_products only on ACCEPT, so an invite that is never used leaves nothing behind for the product
// boundary to read. And 'internal' is never implicit: it has to be asked for by name.

process.env.JWT_SECRET = 'test-secret';
process.env.BASE_URL = 'https://example.test';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const mailer = require('../lib/mailer');
mailer.sendEmail = async () => ({ skipped: true, reason: 'test' });

// ── the fake database ──────────────────────────────────────────────────────────
let USERS = [];         // rows of the users table
let GRANTS = [];        // rows of user_products
function reset() {
  USERS = [{ id: 'u-super', email: 'super@abiozen.com', name: 'Super', role: 'super_admin', is_active: 1, joined_at: 'x' },
           { id: 'u-admin', email: 'admin@abiozen.com', name: 'Admin', role: 'admin', is_active: 1, joined_at: 'x' }];
  GRANTS = [];
}
reset();

const db = require('../lib/db');
db.query = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/UPDATE users SET last_login/i.test(s)) return { rows: [] };
  if (/FROM user_products WHERE user_id/i.test(s)) {
    return { rows: GRANTS.filter(g => g.user_id === params[0]).map(g => ({ product: g.product })) };
  }
  if (/^SELECT id FROM users WHERE email/i.test(s)) {
    return { rows: USERS.filter(u => u.email === params[0]).map(u => ({ id: u.id })) };
  }
  if (/^SELECT \* FROM users WHERE invite_token/i.test(s)) {
    return { rows: USERS.filter(u => u.invite_token === params[0]) };
  }
  if (/^SELECT \* FROM users WHERE id/i.test(s)) {
    return { rows: USERS.filter(u => u.id === params[0]) };
  }
  if (/^INSERT INTO users \(id,email,name,role,github_username,whatsapp_number,invite_token,invited_at,invited_products,invited_by\)/i.test(s)) {
    const [id, email, name, role, gh, wa, token, invited_at, invited_products, invited_by] = params;
    USERS.push({ id, email, name, role, github_username: gh, whatsapp_number: wa, invite_token: token,
                 invited_at, invited_products, invited_by, is_active: 1, joined_at: null });
    return { rows: [] };
  }
  if (/^UPDATE users SET password_hash=\$1/i.test(s)) {
    const u = USERS.find(x => x.id === params[3]);
    Object.assign(u, { password_hash: params[0], name: params[1], joined_at: params[2], invite_token: null, invited_products: null });
    return { rows: [] };
  }
  if (/^INSERT INTO user_products \(user_id, product, granted_by\)/i.test(s)) {
    const [user_id, product, granted_by] = params;
    if (!GRANTS.some(g => g.user_id === user_id && g.product === product)) GRANTS.push({ user_id, product, granted_by });
    return { rows: [] };
  }
  // The users list, with its products sub-select.
  if (/FROM users u ORDER BY u.role, u.name/i.test(s)) {
    return { rows: USERS.map(u => ({ ...u, products: GRANTS.filter(g => g.user_id === u.id).map(g => g.product).sort() })) };
  }
  if (/FROM roles/i.test(s) || /role_name/i.test(s)) return { rows: [] };     // getAllRoles → falls back to the built-in catalog
  throw new Error('unexpected SQL in fake: ' + s);
};
// withTransaction in these handlers only needs a client that proxies to the same fake.
db.withTransaction = async (fn) => fn({ query: (sql, params) => db.query(sql, params) });

const { signToken } = require('../lib/core');
const router = require('./routes');
const app = express(); app.use(express.json()); app.use('/api', router);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
beforeEach(() => reset());

const tok = (id, role) => signToken({ id, email: id + '@abiozen.com', role });
function req(method, path, { as, role, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (as) headers.Authorization = 'Bearer ' + tok(as, role);
  return fetch(base() + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
const asSuper = { as: 'u-super', role: 'super_admin' };
const asAdmin = { as: 'u-admin', role: 'admin' };
const invite = (body, who = asSuper) => req('POST', '/api/users/invite', { ...who, body });

// ── who may create an account ──────────────────────────────────────────────────
test('inviting is super_admin only — admin is refused', async () => {
  const r = await invite({ email: 'partner@acbm.test', role: 'business_dev', products: ['acbm'] }, asAdmin);
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /Super admin only/);
  assert.equal(USERS.length, 2, 'and no row was created');
});

test('GET /products/grantable is super_admin only, and keeps internal out of the product row', async () => {
  assert.equal((await req('GET', '/api/products/grantable', asAdmin)).status, 403);
  const r = await req('GET', '/api/products/grantable', asSuper);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.products.some(p => p.key === 'acbm'), 'the real products are listed');
  assert.ok(!j.products.some(p => p.key === 'internal'), "'internal' is not one of the products");
  assert.equal(j.internal.key, 'internal');
  assert.match(j.internal.warning, /Never grant this to an outside account/);
});

// ── validation ─────────────────────────────────────────────────────────────────
test('an unknown product is REJECTED, not silently dropped', async () => {
  const r = await invite({ email: 'x@y.test', role: 'business_dev', products: ['acbm', 'golfnexx'] });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Unknown product\(s\): golfnexx/);
  assert.equal(USERS.length, 2, 'a rejected invite creates nothing — an account that looks granted and is not is the worst outcome');
});

test('products must be an array; omitting them is allowed and grants nothing', async () => {
  assert.equal((await invite({ email: 'x@y.test', role: 'business_dev', products: 'acbm' })).status, 400);
  const r = await invite({ email: 'plain@abiozen.com', role: 'business_dev' });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).products, []);
});

// ── the grant is written on ACCEPT, not on SEND ─────────────────────────────────
test('sending an invite parks the choice and grants NOTHING yet', async () => {
  const r = await invite({ email: 'partner@acbm.test', role: 'business_dev', products: ['acbm'] });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).products, ['acbm']);
  const row = USERS.find(u => u.email === 'partner@acbm.test');
  assert.deepEqual(row.invited_products, ['acbm'], 'parked on the row');
  assert.equal(row.invited_by, 'u-super', 'and who chose it is recorded');
  assert.deepEqual(GRANTS, [], 'NO grant exists until the invite is accepted');
});

test('accepting writes exactly the chosen grants, and clears the pending choice', async () => {
  await invite({ email: 'partner@acbm.test', role: 'business_dev', products: ['acbm'] });
  const token = USERS.find(u => u.email === 'partner@acbm.test').invite_token;
  const r = await fetch(base() + '/api/auth/accept-invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, name: 'ACBM Partner', password: 'hunter2hunter2' }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.products, ['acbm']);
  assert.deepEqual(GRANTS.map(g => g.product), ['acbm']);
  assert.equal(GRANTS[0].granted_by, 'u-super', 'granted_by is the inviter, not the acceptor');
  assert.equal(USERS.find(u => u.email === 'partner@acbm.test').invited_products, null, 'consumed');
});

test("an ACBM partner never receives 'internal' — it is not implicit in anything", async () => {
  await invite({ email: 'partner@acbm.test', role: 'business_dev', products: ['acbm'] });
  const token = USERS.find(u => u.email === 'partner@acbm.test').invite_token;
  await fetch(base() + '/api/auth/accept-invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, name: 'P', password: 'hunter2hunter2' }),
  });
  const held = GRANTS.filter(g => g.user_id === USERS.find(u => u.email === 'partner@acbm.test').id).map(g => g.product);
  assert.deepEqual(held, ['acbm']);
  assert.ok(!held.includes('internal'), "'internal' must be asked for by name, never inherited");
});

test('accepting an invite that chose nothing grants nothing (and still logs in)', async () => {
  await invite({ email: 'plain@abiozen.com', role: 'business_dev' });
  const token = USERS.find(u => u.email === 'plain@abiozen.com').invite_token;
  const r = await fetch(base() + '/api/auth/accept-invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, name: 'Plain', password: 'hunter2hunter2' }),
  });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).token, 'the account works');
  assert.deepEqual(GRANTS, [], 'it just holds nothing — which is the safe direction, not an error');
});

test('a replayed accept-invite token cannot double-grant or resurrect the account', async () => {
  await invite({ email: 'partner@acbm.test', role: 'business_dev', products: ['acbm', 'golfnex'] });
  const token = USERS.find(u => u.email === 'partner@acbm.test').invite_token;
  const accept = () => fetch(base() + '/api/auth/accept-invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, name: 'P', password: 'hunter2hunter2' }),
  });
  assert.equal((await accept()).status, 200);
  assert.deepEqual(GRANTS.map(g => g.product).sort(), ['acbm', 'golfnex']);
  // The token is cleared, so the replay is rejected outright — and even if it were not, the insert is
  // ON CONFLICT DO NOTHING.
  assert.equal((await accept()).status, 400);
  assert.equal(GRANTS.length, 2, 'still exactly two grants');
});

// ── visibility: a grant you cannot see is a grant nobody audits ─────────────────
test('GET /users reports what each account holds', async () => {
  await invite({ email: 'partner@acbm.test', role: 'business_dev', products: ['acbm'] });
  const before = await (await req('GET', '/api/users', asSuper)).json();
  const pendingRow = before.find(u => u.email === 'partner@acbm.test');
  assert.deepEqual(pendingRow.products, [], 'holds nothing yet');
  assert.deepEqual(pendingRow.invited_products, ['acbm'], 'chosen, shown separately from held');

  const token = USERS.find(u => u.email === 'partner@acbm.test').invite_token;
  await fetch(base() + '/api/auth/accept-invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, name: 'P', password: 'hunter2hunter2' }),
  });
  const after_ = await (await req('GET', '/api/users', asSuper)).json();
  assert.deepEqual(after_.find(u => u.email === 'partner@acbm.test').products, ['acbm']);
});
