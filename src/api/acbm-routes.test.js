// ACBM route gates — run with:  node --test src/api/acbm-routes.test.js
//
// acbm-partner.test.js proves the tier GRID and the resolver. This proves the WIRING: that the gate I
// think is on each route is the gate that is actually on it. The three routes used to be identical
// (authMiddleware + adminOnly) and now they are not, so the difference has to be pinned at the HTTP
// layer or a future edit will quietly make them identical again.

process.env.JWT_SECRET = 'test-secret';

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

// Every query answers empty. These tests are about the gate, not the payload: a 200 with no rows still
// proves the request reached the handler, and a 403 proves it did not.
const db = require('../lib/db');
db.query = async (sql) => {
  if (/UPDATE users SET last_login/i.test(sql)) return { rows: [] };
  if (/FROM user_products/i.test(sql)) return { rows: [] };
  if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ n: 0, total: 0 }] };
  return { rows: [], rowCount: 0 };
};

const { signToken } = require('../lib/core');
const router = require('./routes');
const app = express(); app.use(express.json()); app.use('/api', router);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const get = (path, role) => fetch(base() + path, {
  headers: { Authorization: 'Bearer ' + signToken({ id: 'u-' + role, email: role + '@x.com', role }) },
}).then(r => r.status);

const PROSPECTS = '/api/acbm/prospects', DEALS = '/api/acbm/deals', PACKAGES = '/api/acbm/packages';

test('staff reach all three screens', async () => {
  for (const role of ['super_admin', 'admin']) {
    for (const p of [PROSPECTS, DEALS, PACKAGES]) {
      assert.notEqual(await get(p, role), 403, `${role} must reach ${p}`);
    }
  }
});

test('the partner reaches Deals and Packages', async () => {
  assert.notEqual(await get(DEALS, 'acbm_partner'), 403);
  assert.notEqual(await get(PACKAGES, 'acbm_partner'), 403);
});

test('the partner is REFUSED ACBM Prospects — the route, not just the link', async () => {
  assert.equal(await get(PROSPECTS, 'acbm_partner'), 403);
});

test('no other role reaches any ACBM screen', async () => {
  // The acbm tier is what admits a request now, and only three roles hold it. Every other role must
  // still be refused all three — adminOnly used to do this for prospects and requireTier does it for
  // the other two.
  for (const role of ['sales_director', 'sales_team', 'business_dev', 'dev_team', 'procurement_team',
                      'recruitment_team', 'seo_specialist', 'support_team', 'account_manager',
                      'procurement_director', 'recruitment_director']) {
    for (const p of [PROSPECTS, DEALS, PACKAGES]) {
      assert.equal(await get(p, role), 403, `${role} must NOT reach ${p}`);
    }
  }
});

test('an unknown role reaches nothing (a custom role holds no tiers)', async () => {
  for (const p of [PROSPECTS, DEALS, PACKAGES]) {
    assert.equal(await get(p, 'some_custom_role'), 403);
  }
});

test('no token at all → 401, not 403', async () => {
  assert.equal((await fetch(base() + DEALS)).status, 401);
});
