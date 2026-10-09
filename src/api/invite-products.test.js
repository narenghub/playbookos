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
let LOG = [];           // rows of user_product_grants_log
// An external-role invite must name the partner the account belongs to, so the fake db has to
// model `partners`. Without it the route 500s — which is how these tests first reported the change.
const PARTNERS = [
  { id: 1, name: 'ACBM Partners', status: 'active' },
  { id: 2, name: 'Dormant Partner', status: 'ended' },
];
function reset() {
  USERS = [{ id: 'u-super', email: 'super@abiozen.com', name: 'Super', role: 'super_admin', is_active: 1, joined_at: 'x' },
           { id: 'u-admin', email: 'admin@abiozen.com', name: 'Admin', role: 'admin', is_active: 1, joined_at: 'x' }];
  GRANTS = [];
  LOG = [];
}
reset();

const db = require('../lib/db');
db.query = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/UPDATE users SET last_login/i.test(s)) return { rows: [] };
  if (/FROM user_products WHERE user_id/i.test(s)) {
    return { rows: GRANTS.filter(g => g.user_id === params[0]).map(g => ({ product: g.product })) };
  }
  if (/FROM partners WHERE id = \$1/i.test(s)) {
    return { rows: PARTNERS.filter(p => p.id === params[0]) };
  }
  if (/FROM partners WHERE status = 'active'/i.test(s)) {
    return { rows: PARTNERS.filter(p => p.status === 'active').map(p => ({ id: p.id, name: p.name })) };
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
  if (/^INSERT INTO users \(id,email,name,role,github_username,whatsapp_number,invite_token,invited_at,invited_products,invited_by,excluded_from_scoring,invited_partner_id\)/i.test(s)) {
    const [id, email, name, role, gh, wa, token, invited_at, invited_products, invited_by, excluded_from_scoring, invited_partner_id] = params;
    USERS.push({ id, email, name, role, github_username: gh, whatsapp_number: wa, invite_token: token,
                 invited_at, invited_products, invited_by, excluded_from_scoring, invited_partner_id,
                 partner_id: null, is_active: 1, joined_at: null });
    return { rows: [] };
  }
  // `password_hash\s*=\s*\$1`, not `password_hash=$1`: accept-invite now writes a multi-line
  // UPDATE with spaces around the equals, and the tight pattern silently stopped matching — which
  // reported as "cannot read invite_token of undefined" three tests later rather than as a stub miss.
  if (/^UPDATE users SET password_hash\s*=\s*\$1/i.test(s)) {
    const u = USERS.find(x => x.id === params[3]);
    Object.assign(u, { password_hash: params[0], name: params[1], joined_at: params[2],
                       invite_token: null, invited_products: null });
    // COALESCE(invited_partner_id, partner_id), then clear — the real statement's behaviour.
    if (u.invited_partner_id != null) u.partner_id = u.invited_partner_id;
    u.invited_partner_id = null;
    return { rows: [] };
  }
  if (/INSERT INTO user_product_grants_log/i.test(s)) { LOG.push(params); return { rows: [] }; }
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
  const r = await invite({ email: 'partner@sitenex.test', role: 'business_dev', products: ['sitenex'] }, asAdmin);
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /Super admin only/);
  assert.equal(USERS.length, 2, 'and no row was created');
});

test('GET /products/grantable is super_admin only, and keeps internal out of the product row', async () => {
  assert.equal((await req('GET', '/api/products/grantable', asAdmin)).status, 403);
  const r = await req('GET', '/api/products/grantable', asSuper);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.products.some(p => p.key === 'sitenex'), 'the real products are listed');
  assert.ok(!j.products.some(p => p.key === 'internal'), "'internal' is not one of the products");
  assert.equal(j.internal.key, 'internal');
  assert.match(j.internal.warning, /Never grant this to an outside account/);
});

// ── validation ─────────────────────────────────────────────────────────────────
test('an unknown product is REJECTED, not silently dropped', async () => {
  const r = await invite({ email: 'x@y.test', role: 'business_dev', products: ['sitenex', 'golfnexx'] });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Unknown product\(s\): golfnexx/);
  assert.equal(USERS.length, 2, 'a rejected invite creates nothing — an account that looks granted and is not is the worst outcome');
});

test('products must be an array; omitting them is allowed and grants nothing', async () => {
  assert.equal((await invite({ email: 'x@y.test', role: 'business_dev', products: 'sitenex' })).status, 400);
  const r = await invite({ email: 'plain@abiozen.com', role: 'business_dev' });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).products, []);
});

// ── the grant is written on ACCEPT, not on SEND ─────────────────────────────────
test('sending an invite parks the choice and grants NOTHING yet', async () => {
  const r = await invite({ email: 'partner@sitenex.test', role: 'business_dev', products: ['sitenex'] });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).products, ['sitenex']);
  const row = USERS.find(u => u.email === 'partner@sitenex.test');
  assert.deepEqual(row.invited_products, ['sitenex'], 'parked on the row');
  assert.equal(row.invited_by, 'u-super', 'and who chose it is recorded');
  assert.deepEqual(GRANTS, [], 'NO grant exists until the invite is accepted');
});

test('accepting writes exactly the chosen grants, and clears the pending choice', async () => {
  await invite({ email: 'partner@sitenex.test', role: 'business_dev', products: ['sitenex'] });
  const token = USERS.find(u => u.email === 'partner@sitenex.test').invite_token;
  const r = await fetch(base() + '/api/auth/accept-invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, name: 'Partner', password: 'hunter2hunter2' }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.products, ['sitenex']);
  assert.deepEqual(GRANTS.map(g => g.product), ['sitenex']);
  assert.equal(GRANTS[0].granted_by, 'u-super', 'granted_by is the inviter, not the acceptor');
  assert.equal(USERS.find(u => u.email === 'partner@sitenex.test').invited_products, null, 'consumed');
});

test("a partner never receives 'internal' — it is not implicit in anything", async () => {
  await invite({ email: 'partner@sitenex.test', role: 'business_dev', products: ['sitenex'] });
  const token = USERS.find(u => u.email === 'partner@sitenex.test').invite_token;
  await fetch(base() + '/api/auth/accept-invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, name: 'P', password: 'hunter2hunter2' }),
  });
  const held = GRANTS.filter(g => g.user_id === USERS.find(u => u.email === 'partner@sitenex.test').id).map(g => g.product);
  assert.deepEqual(held, ['sitenex']);
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
  await invite({ email: 'partner@sitenex.test', role: 'business_dev', products: ['sitenex', 'golfnex'] });
  const token = USERS.find(u => u.email === 'partner@sitenex.test').invite_token;
  const accept = () => fetch(base() + '/api/auth/accept-invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, name: 'P', password: 'hunter2hunter2' }),
  });
  assert.equal((await accept()).status, 200);
  assert.deepEqual(GRANTS.map(g => g.product).sort(), ['sitenex', 'golfnex'].sort());
  // The token is cleared, so the replay is rejected outright — and even if it were not, the insert is
  // ON CONFLICT DO NOTHING.
  assert.equal((await accept()).status, 400);
  assert.equal(GRANTS.length, 2, 'still exactly two grants');
});

// ── visibility: a grant you cannot see is a grant nobody audits ─────────────────
test('GET /users reports what each account holds', async () => {
  await invite({ email: 'partner@sitenex.test', role: 'business_dev', products: ['sitenex'] });
  const before = await (await req('GET', '/api/users', asSuper)).json();
  const pendingRow = before.find(u => u.email === 'partner@sitenex.test');
  assert.deepEqual(pendingRow.products, [], 'holds nothing yet');
  assert.deepEqual(pendingRow.invited_products, ['sitenex'], 'chosen, shown separately from held');

  const token = USERS.find(u => u.email === 'partner@sitenex.test').invite_token;
  await fetch(base() + '/api/auth/accept-invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, name: 'P', password: 'hunter2hunter2' }),
  });
  const after_ = await (await req('GET', '/api/users', asSuper)).json();
  assert.deepEqual(after_.find(u => u.email === 'partner@sitenex.test').products, ['sitenex']);
});

// ── external roles are excluded from scoring AT INVITE TIME ─────────────────────
test('inviting an external role sets excluded_from_scoring on the row', async () => {
  const r = await invite({ email: 'partner@sitenex.test', role: 'partner', products: ['sitenex'], partner_id: 1 });
  assert.equal(r.status, 200);
  assert.equal(USERS.find(u => u.email === 'partner@sitenex.test').excluded_from_scoring, true,
    'otherwise the 6pm agent scores them at 0 and the escalation ladder emails a partner');
});

test('inviting an internal role does NOT set it', async () => {
  await invite({ email: 'staff@abiozen.com', role: 'business_dev', products: ['abiozen'] });
  assert.equal(USERS.find(u => u.email === 'staff@abiozen.com').excluded_from_scoring, false);
});

test('a WhatsApp number on an external invite is ignored, not messaged', async () => {
  const r = await invite({ email: 'partner@sitenex.test', role: 'partner', products: ['sitenex'], partner_id: 1, whatsapp_number: '+15555550123' });
  const j = await r.json();
  assert.equal(j.whatsapp_status, 'skipped:external_role',
    'WhatsApp is our escalation channel — a partner has no business in it');
});

test('accepting an invite writes the audit log too, not just the grant rows', async () => {
  // Every way a grant comes into being goes through the same log. Otherwise "who granted this?" has no
  // answer for every account that got its products at signup — which, at the start, is all of them.
  await invite({ email: 'partner@sitenex.test', role: 'partner', products: ['sitenex'], partner_id: 1 });
  const token = USERS.find(u => u.email === 'partner@sitenex.test').invite_token;
  await fetch(base() + '/api/auth/accept-invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, name: 'P', password: 'hunter2hunter2' }),
  });
  assert.equal(LOG.length, 1);
  // 'grant' and 'invite_accept' are SQL literals in that INSERT, so the params are
  // (user_id, user_email, product, actor_id) — checked positionally rather than assumed.
  const [user_id, user_email, product, actor_id] = LOG[0];
  assert.equal(user_id, USERS.find(u => u.email === 'partner@sitenex.test').id);
  assert.equal(user_email, 'partner@sitenex.test');
  assert.equal(product, 'sitenex');
  assert.equal(actor_id, 'u-super', 'the inviter, not the acceptor');
});

// ── THE PARTNER LINK. THE BUG THESE EXIST FOR. ────────────────────────────────
//
// The ACBM Partners account accepted its invite, set a password, logged in — and saw an empty
// board. Every layer was behaving correctly: partnerScopeSql returns FALSE for an external role
// with a NULL partner_id, which is the right call, because the alternative is showing one partner
// every other partner's pipeline. But the invite had no way to SAY which partner, so nothing ever
// set the column. A guard that is intact plus a value that is never written is still a broken
// product, and no test covered the gap between them.

const acceptInvite = (token, name = 'P', password = 'hunter2hunter2') =>
  fetch(base() + '/api/auth/accept-invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, name, password }),
  });

test('an external role CANNOT be invited without a partner — it would see nothing', async () => {
  const r = await invite({ email: 'orphan@sitenex.test', role: 'partner', products: ['sitenex'] });
  assert.equal(r.status, 400, 'an external invite with no partner_id must be refused, not accepted');
  const err = (await r.json()).error;
  assert.match(err, /partner_id is required/i);
  // And the error has to say which partners exist, or the caller is left guessing at an integer.
  assert.match(err, /ACBM Partners/, 'the error must name the available partners');
  assert.ok(!USERS.some(u => u.email === 'orphan@sitenex.test'), 'no half-made account may be left behind');
});

test('an unknown or inactive partner is refused rather than silently ignored', async () => {
  const unknown = await invite({ email: 'a@sitenex.test', role: 'partner', products: ['sitenex'], partner_id: 999 });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /No partner with id 999/);

  // Partner 2 exists but its status is 'ended'. Linking a new account to it would produce an
  // account scoped to a relationship that is over.
  const ended = await invite({ email: 'b@sitenex.test', role: 'partner', products: ['sitenex'], partner_id: 2 });
  assert.equal(ended.status, 400);
  assert.match((await ended.json()).error, /not active/i);
});

test('a STAFF role may not be given a partner_id — it would hide their own data from them', async () => {
  const r = await invite({ email: 'staff@abiozen.com', role: 'sales_team', products: ['abiozen'], partner_id: 1 });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /internal/i);
});

test('the partner link is PARKED on invite and lands only on accept', async () => {
  // Same rule as the product grants, for the same reason: an invite nobody accepts must leave
  // nothing behind that a scoping query can read.
  await invite({ email: 'linked@sitenex.test', role: 'partner', products: ['sitenex'], partner_id: 1 });
  const parked = USERS.find(u => u.email === 'linked@sitenex.test');
  assert.equal(parked.invited_partner_id, 1, 'the choice must be parked on the row');
  assert.equal(parked.partner_id, null, 'but partner_id must still be NULL before acceptance');

  const r = await acceptInvite(parked.invite_token, 'Linked Person', 'pw-1234567');
  assert.equal(r.status, 200);

  const live = USERS.find(u => u.email === 'linked@sitenex.test');
  assert.equal(live.partner_id, 1, 'ACCEPTING is what links the account to the partner — this is the fix');
  assert.equal(live.invited_partner_id, null, 'and the parked choice is cleared');
  assert.ok(live.joined_at, 'joined_at is what the Status badge reads: without it the row says Invited forever');
});
