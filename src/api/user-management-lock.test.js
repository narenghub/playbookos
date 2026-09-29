// USER MANAGEMENT IS super_admin ONLY — pinned at both layers, on every path.
//   node --test src/api/user-management-lock.test.js
//
// "Move it to super_admin" is easy to do to the four routes somebody names and still leave the
// capability reachable. Three ways it stayed reachable here before this test existed:
//   • PUT /api/users/:id had NO middleware — an inline `role !== 'admin'` check, and every one of the
//     13 role templates granted the feature, so the resolver permitted the call
//   • PUT /api/users/profile accepted a `user_id` override for admin — the same "edit another account"
//     capability by a different route
//   • the two product-grant routes had no registry feature at all, so enforce.js fell straight through
//     and the middleware was the only thing there
//
// So the test is written as "what is the complete set of ways to change another account, and is every
// one of them locked at BOTH layers" — not as a list of four routes.

process.env.JWT_SECRET = 'test-secret';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const fs = require('fs');

const { TEMPLATES } = require('../lib/permissions/templates');
const { FEATURES } = require('../lib/permissions/registry');
const { resolve } = require('../lib/permissions/resolve');

// Every route that changes ANOTHER account, and the feature that governs it. Adding a route to the
// user-management surface without adding it here is what the last test catches.
const LOCKED_ROUTES = [
  ['POST',   '/api/users/invite',                              'admin.users.invite'],
  ['PUT',    '/api/users/:id',                                 'admin.users.update'],
  ['DELETE', '/api/users/:id',                                 'admin.users.delete'],
  ['PUT',    '/api/users/:id/toggle-status',                   'admin.users_toggle_status.update'],
  ['POST',   '/api/admin/users/:user_id/reset-password',       'admin.admin_users.reset_password'],
  ['POST',   '/api/admin/users/:user_id/edit-name',            'admin.admin_users.edit_name'],
  ['GET',    '/api/users/:id/products',                        'admin.user_products.list'],
  ['PUT',    '/api/users/:id/products',                        'admin.user_products.update'],
];

// ── layer 1: the route gate ─────────────────────────────────────────────────────
let USERS = [], GRANTS = [];
function reset() {
  USERS = [
    { id: 'u-super', email: 'naren@abiozen.com', name: 'Naren', role: 'super_admin', is_active: 1, joined_at: 'x' },
    { id: 'u-admin', email: 'prasanthi@adificetechnologies.com', name: 'Prasanthi', role: 'admin', is_active: 1, joined_at: 'x' },
    { id: 'u-dev',   email: 'muni@adificetechnologies.com', name: 'Muni', role: 'dev_team', is_active: 1, joined_at: 'x' },
  ];
  GRANTS = [{ user_id: 'u-dev', product: 'abiozen' }];
}
reset();

const db = require('../lib/db');
db.query = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/UPDATE users SET last_login/i.test(s)) return { rows: [] };
  // authMiddleware reads role + is_active from the DATABASE, not the token. Ids here are 'u-<role>' for
  // the synthetic callers and real ids for the fixtures, so both shapes have to answer.
  if (/^SELECT role, is_active FROM users WHERE id =/i.test(s)) {
    const known = USERS.find(u => u.id === params[0]);
    if (known) return { rows: [{ role: known.role, is_active: 1 }] };
    return { rows: [{ role: String(params[0] || '').replace(/^u-/, ''), is_active: 1 }] };
  }
  if (/FROM users WHERE id=/i.test(s)) return { rows: USERS.filter(u => u.id === params[0]) };
  if (/COUNT\(\*\)::int n FROM users WHERE role='super_admin'/i.test(s)) {
    return { rows: [{ n: USERS.filter(u => u.role === 'super_admin' && u.is_active === 1).length }] };
  }
  if (/FROM user_products WHERE user_id/i.test(s)) {
    return { rows: GRANTS.filter(g => g.user_id === params[0]).map(g => ({ product: g.product })) };
  }
  if (/FROM user_product_grants_log/i.test(s)) return { rows: [] };
  if (/^SELECT id FROM users WHERE email/i.test(s)) return { rows: [] };
  if (/FROM roles/i.test(s) || /role_name/i.test(s)) return { rows: [] };
  if (/^UPDATE users SET/i.test(s)) return { rows: [] };
  if (/INSERT INTO|DELETE FROM/i.test(s)) return { rows: [], rowCount: 0 };
  return { rows: [] };
};
db.withTransaction = async (fn) => fn({ query: (sql, p) => db.query(sql, p) });

const { signToken } = require('../lib/core');
const router = require('./routes');
const app = express(); app.use(express.json()); app.use('/api', router);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
beforeEach(() => reset());

const tokFor = (role) => signToken({ id: 'u-' + role, email: role + '@x.com', role });
const call = (method, path, role, body) => fetch(base() + path, {
  method, headers: { Authorization: 'Bearer ' + tokFor(role), 'Content-Type': 'application/json' },
  // fetch refuses a body on GET, and one of the locked routes is a GET.
  body: (body && method !== 'GET' && method !== 'HEAD') ? JSON.stringify(body) : undefined,
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const concrete = (p) => p.replace(/:user_id|:id/g, 'u-dev');

test('every locked route refuses ADMIN at the route gate', async () => {
  for (const [method, path] of LOCKED_ROUTES) {
    const r = await call(method, concrete(path), 'admin', { products: [], role: 'dev_team', name: 'x', email: 'a@b.c' });
    assert.equal(r.status, 403, `${method} ${path} must refuse admin (got ${r.status})`);
    assert.match(r.body.error || '', /Super admin only/, `${method} ${path}: ${r.body.error}`);
  }
});

test('every locked route refuses every OTHER role too', async () => {
  for (const role of ['dev_team', 'business_dev', 'sales_director', 'recruitment_team', 'support_team', 'acbm_partner']) {
    for (const [method, path] of LOCKED_ROUTES) {
      const r = await call(method, concrete(path), role, { products: [] });
      assert.equal(r.status, 403, `${method} ${path} must refuse ${role}`);
    }
  }
});

test('super_admin still reaches all of them WITH A STALE TOKEN', async () => {
  // The case that was missing, and the reason the Edit bug shipped. Every test in this file was a
  // negative — and a stale token is MORE restricted, never less, so all of them passed through the bug.
  // This one claims the role the account had BEFORE its promotion, which is what naren's browser was
  // sending: 178 requests on 2026-09-29 carried role 'admin' for an account the database says is
  // super_admin.
  const stale = signToken({ id: 'u-super', email: 'naren@abiozen.com', role: 'admin' });
  for (const [method, path] of LOCKED_ROUTES) {
    const body = method === 'PUT' && path.endsWith('/products') ? { products: ['abiozen'] }
      : { role: 'dev_team', name: 'Muni', email: 'new@abiozen.com' };
    const r = await fetch(base() + concrete(path), {
      method, headers: { Authorization: 'Bearer ' + stale, 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    assert.notEqual(r.status, 403,
      `${method} ${path} refused a super_admin holding a pre-promotion token (got ${r.status})`);
  }
});

test('super_admin still reaches all of them', async () => {
  for (const [method, path] of LOCKED_ROUTES) {
    const body = method === 'PUT' && path.endsWith('/products') ? { products: ['abiozen'] }
      : { role: 'dev_team', name: 'Muni', email: 'new@abiozen.com', new_name: 'Muni R' };
    const r = await call(method, concrete(path), 'super_admin', body);
    assert.notEqual(r.status, 403, `${method} ${path} must NOT refuse super_admin (got ${r.status}: ${JSON.stringify(r.body).slice(0, 120)})`);
  }
});

// ── the paths that are NOT obviously user management ─────────────────────────────
test('PUT /users/profile still lets anyone edit THEMSELVES', async () => {
  for (const role of ['dev_team', 'admin', 'acbm_partner']) {
    const r = await call('PUT', '/api/users/profile', role, { whatsapp_number: '+15555550000' });
    assert.equal(r.status, 200, `${role} must still edit their own profile`);
  }
});

test('but the user_id override on /users/profile is super_admin only — the back door', async () => {
  // Same capability as PUT /api/users/:id (edit another account's fields), different route. Locking one
  // and not the other would make the lock cosmetic.
  const asAdmin = await call('PUT', '/api/users/profile', 'admin', { user_id: 'u-dev', name: 'Renamed' });
  assert.equal(asAdmin.status, 403);
  assert.match(asAdmin.body.error, /Super admin only/);
  const asSuper = await call('PUT', '/api/users/profile', 'super_admin', { user_id: 'u-dev', name: 'Renamed' });
  assert.equal(asSuper.status, 200);
});

test('GET /users stays readable — Prasanthi can still SEE the team, just not change it', async () => {
  // Deliberately not locked: it is a read, it was not on the list, and taking the team list away would
  // break the page rather than the capability.
  const r = await call('GET', '/api/users', 'admin');
  assert.notEqual(r.status, 403);
});

test('a super_admin cannot demote THEMSELVES, and the last one cannot be demoted at all', async () => {
  const self = await fetch(base() + '/api/users/u-super', {
    method: 'PUT', headers: { Authorization: 'Bearer ' + signToken({ id: 'u-super', email: 'n@x.com', role: 'super_admin' }), 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'admin' }),
  });
  assert.equal(self.status, 403);
  assert.equal((await self.json()).code, 'self_demote');
});

// ── layer 2: the resolver ───────────────────────────────────────────────────────
const asUser = (role) => ({ id: 'u-' + role, role, is_active: 1, permissions_version: 1 });
const can = (role, key) => resolve(asUser(role), key, { overrides: [], env: process.env }).then(r => r.allowed);

test('GUARD: the resolver is resolving — super_admin holds these, so the denials below mean something', async () => {
  for (const [, , key] of LOCKED_ROUTES) {
    assert.equal(await can('super_admin', key), true, `super_admin must hold ${key}`);
  }
});

test('no NON-super_admin role resolves ALLOW for any locked feature', async () => {
  const leaked = [];
  for (const role of Object.keys(TEMPLATES)) {
    if (role === 'super_admin') continue;
    for (const [, , key] of LOCKED_ROUTES) {
      if (await can(role, key)) leaked.push(`${role} → ${key}`);
    }
  }
  assert.deepEqual(leaked, [],
    `\nthese roles still resolve ALLOW, so the resolver would permit the call even though the middleware\n` +
    `refuses it. Both layers must agree, or the next person who relaxes the middleware reopens it:\n  ` +
    leaked.join('\n  ') + '\n');
});

test('no template GRANTS a locked feature — including through implies', async () => {
  const keys = new Set(LOCKED_ROUTES.map(r => r[2]));
  const viaImplies = FEATURES.filter(f => (f.implies || []).some(k => keys.has(k)));
  for (const f of viaImplies) {
    for (const [role, t] of Object.entries(TEMPLATES)) {
      if (role === 'super_admin') continue;
      assert.ok(!(t.grants || []).includes(f.key),
        `${role} holds ${f.key}, which IMPLIES ${f.implies.filter(k => keys.has(k)).join(', ')}`);
    }
  }
});

test('the dangerous ones are defaultDeny, so even a per-user override has to be deliberate', () => {
  const byKey = new Map(FEATURES.map(f => [f.key, f]));
  for (const [method, path, key] of LOCKED_ROUTES) {
    const f = byKey.get(key);
    assert.ok(f, `${key} is not registered — enforce.js falls through for an unmapped route, leaving the middleware alone`);
    assert.equal(f.ref, `${method} ${path}`, `${key} points at ${f.ref}, not ${method} ${path}`);
    if (method !== 'GET') {
      assert.equal(f.defaultDeny, true, `${key} writes and must be defaultDeny`);
      assert.equal(f.dangerous, true, `${key} changes another account and must be flagged dangerous`);
    }
  }
});

// ── the completeness check ──────────────────────────────────────────────────────
test('SWEEP: every route that writes to the users table is locked or deliberately exempt', () => {
  // The list above is hand-kept, so this is what stops it drifting: any route handler that writes to
  // `users` must carry superAdminOnly, or be named here with a reason.
  const src = fs.readFileSync(__dirname + '/routes.js', 'utf8');
  const EXEMPT = {
    "router.post('/auth/accept-invite'": 'sets your own password from an invite token',
    "router.put('/auth/password'": 'changes your own password',
    "router.put('/users/profile'": 'self-service; the user_id override is checked inside the handler',
    "router.post('/auth/login'": 'writes last_login',
  };
  const offenders = [];
  const decls = [...src.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'[^)]*?\)?, async/g)];
  for (let i = 0; i < decls.length; i++) {
    const start = decls[i].index;
    const end = i + 1 < decls.length ? decls[i + 1].index : src.length;
    const body = src.slice(start, end);
    const decl = `router.${decls[i][1]}('${decls[i][2]}'`;
    const writesUsers = /(UPDATE users SET|INSERT INTO users|DELETE FROM users)/i.test(body);
    if (!writesUsers) continue;
    if (EXEMPT[decl]) continue;
    const header = body.slice(0, body.indexOf('async'));
    if (!/superAdminOnly/.test(header)) offenders.push(`${decls[i][1].toUpperCase()} ${decls[i][2]}`);
  }
  assert.deepEqual(offenders, [],
    `\nthese handlers write to the users table without superAdminOnly. Either add it, or add the route to\n` +
    `EXEMPT in this test with the reason it is self-service:\n  ` + offenders.join('\n  ') + '\n');
  assert.ok(decls.length > 150, `only ${decls.length} routes parsed — the scanner has stopped working`);
});
