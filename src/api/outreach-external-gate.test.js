// OUTREACH IS INTERNAL. An external account may not read it or write it.
//
//   node --test src/api/outreach-external-gate.test.js
//
// THE LEAK THIS CLOSES (found 2026-09-30, before ACBM Partners had a login): /api/outreach is classified
// 'shared' in the route map, which is correct — every list has outreach status and the route is safe for
// anyone who works here. But 'shared' means "admitted to everyone with a login", and the data scoping
// underneath is by PRODUCT. A partner holding 'sitenex' therefore saw every SiteNex outreach row, and
// could set a status on a prospect they had never worked — including overwriting a note somebody here
// had just written after a call.
//
// Neither existing layer could fix it. Product scoping cannot: they legitimately hold the product.
// Partner scoping cannot: outreach rows have no partner_id, and giving them one would assert that an
// outreach note belongs to a partner rather than to us, which is the opposite of true. So the gate is
// the ROLE, in middleware — not in a permissions template, which decides nothing for a role absent from
// PERMISSIONS_ENFORCE_ROLES.

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'outreach-gate-test';

const USERS = {
  'u-admin': { role: 'admin' }, 'u-super': { role: 'super_admin' },
  'u-bd': { role: 'business_dev' }, 'u-partner': { role: 'partner' },
};

const db = require('../lib/db');
const realQuery = db.query, realTxn = db.withTransaction;
db.query = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/UPDATE users SET last_login/i.test(s)) return { rows: [] };
  // The role comes from the DB per request, not from the token — an empty row here means "deleted or
  // inactive" and authMiddleware correctly 401s, which is not what this file is testing.
  if (/^SELECT role, is_active FROM users WHERE id =/i.test(s)) {
    const u = USERS[params[0]];
    return { rows: u ? [{ role: u.role, is_active: 1 }] : [] };
  }
  if (/FROM user_products WHERE user_id/i.test(s)) return { rows: [{ product: 'sitenex' }] };
  return { rows: [], rowCount: 0 };
};
db.withTransaction = async (fn) => fn({ query: db.query });
after(() => { db.query = realQuery; db.withTransaction = realTxn; });

const { signToken } = require('../lib/core');
const app = express(); app.use(express.json()); app.use('/api', require('./routes'));
const server = app.listen(0);
after(() => server.close());
const base = () => `http://127.0.0.1:${server.address().port}`;
const call = (method, path, who, body) => fetch(base() + path, {
  method, headers: { Authorization: 'Bearer ' + signToken({ id: who, email: who + '@x.example', role: USERS[who].role }),
                     'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const READS = [
  '/api/outreach?entity_type=prospect&ids=1',
  '/api/outreach/summary?entity_type=prospect&total=10',
  '/api/outreach/activity?days=7',
  '/api/outreach/overview?days=7',
  '/api/outreach/history?entity_type=prospect&entity_id=1',
];

test('a PARTNER is refused every outreach read', async () => {
  for (const p of READS) {
    const r = await call('GET', p, 'u-partner');
    assert.equal(r.status, 403, `${p} must be refused for a partner, got ${r.status}`);
    assert.equal(r.body.code, 'external_role', `${p} should say why`);
  }
});

test('and refused the WRITE — the half that could overwrite our own note', async () => {
  const r = await call('PUT', '/api/outreach', 'u-partner',
    { entity_type: 'prospect', entity_id: 1, status: 'won' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'external_role');
});

test('while STAFF are unaffected — this is a gate, not a lockout', async () => {
  // Asserted for three internal roles, because a gate written with isExternalRole could in principle
  // catch an internal one and this is the only place that would notice.
  for (const who of ['u-admin', 'u-super', 'u-bd']) {
    for (const p of READS) {
      const r = await call('GET', p, who);
      assert.notEqual(r.status, 403, `${who} must still reach ${p}`);
    }
    const w = await call('PUT', '/api/outreach', who, { entity_type: 'prospect', entity_id: 1, status: 'contacted' });
    assert.notEqual(w.status, 403, `${who} must still be able to write`);
  }
});

test('the VOCABULARY stays open to any login, deliberately', async () => {
  // It returns constants — ten status keys, five channels, the entity types. No row, no count, nothing
  // about anybody's data. Gating it would only stop a partner's page labelling its own dropdowns.
  const r = await call('GET', '/api/outreach/vocabulary', 'u-partner');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.status_keys) && r.body.status_keys.length === 10);
});

test('every outreach route except /vocabulary carries staffOnly, at the source level', () => {
  // The HTTP tests above can only check the paths they know. This one fails when a new outreach route is
  // added without the gate, which is the case nobody remembers.
  const src = require('fs').readFileSync(__dirname + '/routes.js', 'utf8');
  const decls = [...src.matchAll(/router\.(get|put|post|patch|delete)\('(\/outreach[^']*)',([^\n]*)/g)];
  assert.ok(decls.length >= 7, `only ${decls.length} outreach routes found — the scanner has stopped working`);
  for (const [, method, path, rest] of decls) {
    if (path === '/outreach/vocabulary') {
      assert.ok(!/staffOnly/.test(rest), 'the vocabulary is deliberately open; if that changed, update this test');
      continue;
    }
    assert.ok(/staffOnly/.test(rest), `${method.toUpperCase()} ${path} has no staffOnly`);
  }
});

test('staffOnly keys off the ROLE LIST, so a new external role is covered without an edit', () => {
  const { EXTERNAL_ROLES, isExternalRole } = require('../lib/roles');
  assert.ok(EXTERNAL_ROLES.includes('partner'), 'partner must be an external role');
  assert.ok(EXTERNAL_ROLES.length >= 1);
  for (const r of ['admin', 'super_admin', 'business_dev']) {
    assert.equal(isExternalRole(r), false, `${r} must not be external`);
  }
  // And the middleware reads that function rather than its own copy of the list.
  const src = require('fs').readFileSync(__dirname + '/../lib/core.js', 'utf8');
  const fn = src.slice(src.indexOf('function staffOnly('), src.indexOf('// super_admin ONLY'));
  assert.match(fn, /isExternalRole/, 'staffOnly must use the shared role list, not a second copy');
});
