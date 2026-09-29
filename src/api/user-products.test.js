// Product assignment for an existing user — run with:  node --test src/api/user-products.test.js
//
// Four guards, one test block each:
//   1. a super admin cannot narrow THEMSELVES, and the last super admin cannot be narrowed at all
//   2. the change is live on the next request, not the next login
//   3. every change is audited, and a REVOKE leaves a trace rather than a hole
//   4. the response says what changed, in routes

process.env.JWT_SECRET = 'test-secret';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');

let USERS = [], GRANTS = [], LOG = [];
function reset() {
  USERS = [
    { id: 'u-super',  email: 'naren@abiozen.com',  name: 'Naren',   role: 'super_admin',  is_active: 1 },
    { id: 'u-super2', email: 'second@abiozen.com', name: 'Second',  role: 'super_admin',  is_active: 1 },
    { id: 'u-mano',   email: 'mano@abiozen.com',   name: 'Manohar', role: 'admin',        is_active: 1 },
    { id: 'u-part',   email: 'p@sitenex.test',        name: 'Partner', role: 'partner', is_active: 1 },
  ];
  GRANTS = [];
  for (const u of ['u-super', 'u-super2', 'u-mano']) {
    for (const p of ['abiozen', 'golfnex', 'favly', 'linkabl', 'aros', 'sitenex', 'internal']) {
      GRANTS.push({ user_id: u, product: p, granted_by: 'backfill' });
    }
  }
  GRANTS.push({ user_id: 'u-part', product: 'sitenex', granted_by: 'u-super' });
  LOG = [];
}
reset();

const db = require('../lib/db');
db.query = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/UPDATE users SET last_login/i.test(s)) return { rows: [] };
  if (/^SELECT id, name, email, role, is_active FROM users WHERE id=/i.test(s)) {
    return { rows: USERS.filter(u => u.id === params[0]) };
  }
  if (/COUNT\(\*\)::int n FROM users WHERE role='super_admin'/i.test(s)) {
    return { rows: [{ n: USERS.filter(u => u.role === 'super_admin' && u.is_active === 1).length }] };
  }
  if (/^SELECT product, granted_at, granted_by FROM user_products WHERE user_id=/i.test(s)) {
    return { rows: GRANTS.filter(g => g.user_id === params[0]).map(g => ({ ...g, granted_at: 'then' })).sort((a, b) => a.product.localeCompare(b.product)) };
  }
  if (/^SELECT product FROM user_products WHERE user_id=/i.test(s)) {
    return { rows: GRANTS.filter(g => g.user_id === params[0]).map(g => ({ product: g.product })).sort((a, b) => a.product.localeCompare(b.product)) };
  }
  if (/INSERT INTO user_products/i.test(s)) {
    const [user_id, product, granted_by] = params;
    if (!GRANTS.some(g => g.user_id === user_id && g.product === product)) GRANTS.push({ user_id, product, granted_by });
    return { rows: [] };
  }
  if (/DELETE FROM user_products WHERE user_id=\$1 AND product = ANY\(\$2\)/i.test(s)) {
    const before = GRANTS.length;
    GRANTS = GRANTS.filter(g => !(g.user_id === params[0] && params[1].includes(g.product)));
    return { rows: [], rowCount: before - GRANTS.length };
  }
  if (/^SELECT id, role, email, name FROM users WHERE id=/i.test(s)) {
    return { rows: USERS.filter(u => u.id === params[0]) };
  }
  if (/^DELETE FROM users WHERE id=/i.test(s)) {
    USERS = USERS.filter(u => u.id !== params[0]);
    GRANTS = GRANTS.filter(g => g.user_id !== params[0]);   // ON DELETE CASCADE
    return { rows: [] };
  }
  if (/^UPDATE users SET is_active=0 WHERE id=/i.test(s)) {
    const u = USERS.find(x => x.id === params[0]); if (u) u.is_active = 0;
    return { rows: [] };
  }
  if (/INSERT INTO user_product_grants_log/i.test(s)) {
    // action and source are SQL LITERALS in some of these INSERTs and placeholders in others, so they are
    // read out of the statement rather than assumed to be at a fixed parameter position. Getting that
    // wrong is how a test asserts on the value of a different column and still looks green.
    const lit = (re) => { const m = re.exec(s); return m ? m[1] : null; };
    const litAction = lit(/'(grant|revoke)'/);
    const source = lit(/'(backfill|invite_accept|admin_edit|user_deleted)'/);
    const [user_id, user_email, product, ...rest] = params;
    // When action is a literal it is NOT in params, so the remaining values shift by one.
    const action = litAction || rest.shift();
    const [actor_id, actor_email] = rest;
    LOG.push({ user_id, user_email, product, action, actor_id, actor_email, source });
    return { rows: [] };
  }
  if (/FROM user_product_grants_log l/i.test(s)) {
    return { rows: LOG.filter(l => l.user_id === params[0]).map(l => ({ ...l, created_at: 'now', actor: l.actor_email })) };
  }
  throw new Error('unexpected SQL in fake: ' + s);
};
db.withTransaction = async (fn) => fn({ query: (sql, p) => db.query(sql, p) });

const { signToken } = require('../lib/core');
const router = require('./routes');
const app = express(); app.use(express.json()); app.use('/api', router);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
beforeEach(() => reset());

const tok = (id) => { const u = USERS.find(x => x.id === id); return signToken({ id: u.id, email: u.email, role: u.role }); };
function req(method, path, { as, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (as) headers.Authorization = 'Bearer ' + tok(as);
  return fetch(base() + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
const setProducts = (targetId, products, as = 'u-super') =>
  req('PUT', `/api/users/${targetId}/products`, { as, body: { products } });
const heldBy = (id) => GRANTS.filter(g => g.user_id === id).map(g => g.product).sort();

// ── who may do this at all ──────────────────────────────────────────────────────
test('super_admin only — an admin cannot reassign products', async () => {
  const r = await setProducts('u-part', ['sitenex', 'internal'], 'u-mano');
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /Super admin only/);
  assert.deepEqual(heldBy('u-part'), ['sitenex'], 'nothing changed');
});

test('GET is super_admin only too — the history is not public', async () => {
  assert.equal((await req('GET', '/api/users/u-part/products', { as: 'u-mano' })).status, 403);
  assert.equal((await req('GET', '/api/users/u-part/products', { as: 'u-super' })).status, 200);
});

// ── GUARD 1: nobody narrows themselves; the last super admin is untouchable ──────
test('a super admin CANNOT remove their own products — refused by the server', async () => {
  const r = await setProducts('u-super', ['abiozen', 'golfnex', 'favly', 'linkabl', 'aros', 'sitenex']);  // drops internal
  assert.equal(r.status, 403);
  const j = await r.json();
  assert.equal(j.code, 'self_narrow');
  assert.match(j.error, /cannot remove your own products/);
  assert.match(j.error, /manual database change/, 'and says why it is refused rather than just refusing');
  assert.ok(heldBy('u-super').includes('internal'), 'internal is still held');
  assert.equal(LOG.length, 0, 'and nothing was logged, because nothing happened');
});

test('but a super admin CAN widen themselves — that is not an escalation', async () => {
  GRANTS = GRANTS.filter(g => !(g.user_id === 'u-super' && g.product === 'sitenex'));
  const r = await setProducts('u-super', ['abiozen', 'golfnex', 'favly', 'linkabl', 'aros', 'sitenex', 'internal']);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).added, ['sitenex']);
});

test('the LAST active super admin cannot be narrowed, even by another account', async () => {
  USERS.find(u => u.id === 'u-super2').is_active = 0;          // now u-super is the only one
  const r = await req('PUT', '/api/users/u-super/products', { as: 'u-super2', body: { products: ['abiozen'] } });
  assert.equal(r.status, 403);
  const j = await r.json();
  assert.equal(j.code, 'last_super_admin');
  assert.match(j.error, /only active super admin/);
  assert.equal(heldBy('u-super').length, 7);
});

test('with TWO super admins, one can narrow the other — they can rescue each other', async () => {
  const r = await req('PUT', '/api/users/u-super2/products', { as: 'u-super', body: { products: ['abiozen', 'internal'] } });
  assert.equal(r.status, 200);
  assert.deepEqual(heldBy('u-super2'), ['abiozen', 'internal']);
});

test('an unknown product is refused, and refusal changes nothing', async () => {
  const r = await setProducts('u-part', ['sitenex', 'not_a_product']);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'unknown_product');
  assert.deepEqual(heldBy('u-part'), ['sitenex']);
});

test('the body must be a complete array, not a delta', async () => {
  assert.equal((await setProducts('u-part', 'sitenex')).status, 400);
  assert.equal((await req('PUT', '/api/users/u-part/products', { as: 'u-super', body: {} })).status, 400);
});

test('an unknown user is 404, not a silent success', async () => {
  assert.equal((await setProducts('u-nobody', ['sitenex'])).status, 404);
});

// ── GUARD 2: immediately, not at next login ─────────────────────────────────────
test('the JWT carries NO products, so a revoke cannot wait for a token to expire', () => {
  const decoded = JSON.parse(Buffer.from(tok('u-mano').split('.')[1], 'base64').toString());
  assert.deepEqual(Object.keys(decoded).sort().filter(k => !['exp', 'iat'].includes(k)), ['email', 'id', 'role']);
  assert.equal(decoded.products, undefined, 'products in the token would mean a 7-day revocation lag');
});

test('the boundary reads user_products per request, with no cache', () => {
  const fs = require('fs');
  const boundary = fs.readFileSync(__dirname + '/../lib/products/boundary.js', 'utf8');
  assert.match(boundary, /SELECT product FROM user_products WHERE user_id = \$1/,
    'held products come from the table on every evaluated request');
  assert.doesNotMatch(boundary, /_cache|Map\(\)|memo/i, 'and nothing memoises them');
  const held = fs.readFileSync(__dirname + '/../lib/products/held.js', 'utf8');
  assert.doesNotMatch(held, /_cache|Map\(\)|memo/i);
});

test('the response says so, because the person clicking needs to know', async () => {
  const j = await (await setProducts('u-part', ['sitenex', 'golfnex'])).json();
  assert.match(j.takes_effect, /immediately/);
  assert.match(j.takes_effect, /nothing is cached in the token/);
});

// ── GUARD 3: every change is audited, including revokes ─────────────────────────
test('a grant writes the row AND the log entry, with who did it', async () => {
  await setProducts('u-part', ['sitenex', 'golfnex']);
  assert.deepEqual(heldBy('u-part'), ['sitenex', 'golfnex'].sort());
  const grants = LOG.filter(l => l.action === 'grant');
  assert.equal(grants.length, 1);
  assert.deepEqual({ p: grants[0].product, who: grants[0].actor_email, src: grants[0].source },
    { p: 'golfnex', who: 'naren@abiozen.com', src: 'admin_edit' });
  assert.equal(grants[0].user_email, 'p@sitenex.test', 'the log records the email too, so it survives a deleted user');
  assert.equal(GRANTS.find(g => g.user_id === 'u-part' && g.product === 'golfnex').granted_by, 'u-super',
    'and user_products.granted_by is written, not left null');
});

test('a REVOKE leaves a trace — the row is gone but the history is not', async () => {
  // This is the whole reason the log table exists. user_products has granted_at/granted_by, but a revoke
  // deletes the row and its history with it: "Manohar lost abiozen at some point and nobody knows when".
  await setProducts('u-mano', ['golfnex', 'internal']);
  assert.deepEqual(heldBy('u-mano'), ['golfnex', 'internal'], 'the rows really are deleted');
  const revokes = LOG.filter(l => l.action === 'revoke').map(l => l.product).sort();
  assert.deepEqual(revokes, ['abiozen', 'sitenex', 'aros', 'favly', 'linkabl'].sort());
  for (const l of LOG) {
    assert.equal(l.actor_email, 'naren@abiozen.com');
    assert.equal(l.source, 'admin_edit');
  }
});

test('the history is readable back, newest first', async () => {
  await setProducts('u-part', ['sitenex', 'aros']);
  await setProducts('u-part', ['sitenex']);
  const j = await (await req('GET', '/api/users/u-part/products', { as: 'u-super' })).json();
  assert.deepEqual(j.products, ['sitenex']);
  assert.equal(j.history.length, 2);
  assert.deepEqual(j.history.map(h => `${h.action} ${h.product}`).sort(), ['grant aros', 'revoke aros']);
});

test('a no-op change writes nothing at all', async () => {
  const r = await setProducts('u-part', ['sitenex']);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual([j.added, j.removed], [[], []]);
  assert.equal(LOG.length, 0, 'an audit log full of "changed nothing" is an audit log nobody reads');
  assert.match(j.summary, /no change/);
});

test('duplicates in the request are collapsed, not double-logged', async () => {
  await setProducts('u-part', ['sitenex', 'golfnex', 'golfnex']);
  assert.equal(LOG.filter(l => l.product === 'golfnex').length, 1);
  assert.deepEqual(heldBy('u-part'), ['sitenex', 'golfnex'].sort());
});

// ── a deleted user is the largest permission removal there is ───────────────────
test('a PERMANENT delete logs every grant it destroys, before destroying it', async () => {
  // This route used to record nothing at all: no console line, no activity_log row, and user_products
  // cascades — so a hard delete took the account AND the entire history of what it could reach. Seven
  // accounts went that way on 2026-09-29 and there is no way to say who did it.
  const r = await req('DELETE', '/api/users/u-mano?permanent=true', { as: 'u-super' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.deleted, 'permanent');
  assert.deepEqual(j.products_lost.sort(), ['abiozen', 'sitenex', 'aros', 'favly', 'golfnex', 'internal', 'linkabl'].sort());
  const revokes = LOG.filter(l => l.action === 'revoke');
  assert.equal(revokes.length, 7, 'one log row per grant destroyed');
  assert.equal(revokes[0].user_email, 'mano@abiozen.com', 'the email is on the row, so it survives the user');
  assert.equal(revokes[0].actor_email, 'naren@abiozen.com', 'and who did it');
});

test('a SOFT delete keeps the grants, so there is nothing to revoke', async () => {
  const r = await req('DELETE', '/api/users/u-mano', { as: 'u-super' });
  assert.equal((await r.json()).deleted, 'soft');
  assert.equal(LOG.length, 0, 'reactivating restores the account as it was — no permission was removed');
  assert.equal(heldBy('u-mano').length, 7);
});

// ── GUARD 4: show what changed ──────────────────────────────────────────────────
test('the summary names the products AND what they cost in routes', async () => {
  const j = await (await setProducts('u-mano', ['golfnex', 'favly', 'linkabl', 'sitenex', 'internal'])).json();
  assert.deepEqual(j.removed.sort(), ['abiozen', 'aros']);
  assert.match(j.summary, /Manohar lost abiozen, aros/);
  assert.match(j.summary, /403 on \d+ routes/);
  assert.match(j.summary, /shared routes are unaffected/,
    'without this the number reads as "everything is gone"');
  assert.ok(j.route_counts.abiozen > 100, 'the counts come from the real mounted route table');
  assert.equal(j.route_counts.unclassified, 0,
    'a route the map cannot classify would 403 for EVERYONE under enforce');
});

test('before and after are both returned, so the change is checkable', async () => {
  const j = await (await setProducts('u-part', ['sitenex', 'aros'])).json();
  assert.deepEqual(j.before, ['sitenex']);
  assert.deepEqual(j.after.sort(), ['sitenex', 'aros'].sort());
});

test("removing 'internal' says what that means in words, not just a count", async () => {
  const j = await (await setProducts('u-mano', ['abiozen'])).json();
  assert.match(j.summary, /Removing 'internal' also hides every platform-wide alert/);
  assert.match(j.summary, /team, settings, agent control/);
});
