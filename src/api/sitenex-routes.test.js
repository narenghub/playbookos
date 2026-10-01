// SiteNex route gates — run with:  node --test src/api/sitenex-routes.test.js
//
// sitenex-partner.test.js proves the tier GRID and the resolver. This proves the WIRING: that the gate I
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
db.query = async (sql, params = []) => {
  if (/UPDATE users SET last_login/i.test(sql)) return { rows: [] };
  // authMiddleware reads the caller's role from the DATABASE, not the token, so the fake has to answer
  // this or every request 401s. Ids here are 'u-<role>', which is where the role comes from.
  if (/^SELECT role, is_active FROM users WHERE id/i.test(sql.trim())) {
    return { rows: [{ role: String(params[0] || '').replace(/^u-/, ''), is_active: 1 }] };
  }
  if (/FROM user_products/i.test(sql)) return { rows: [] };
  if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ n: 0, total: 0 }] };
  return { rows: [], rowCount: 0 };
};

const { signToken } = require('../lib/core');
const router = require('./routes');
// BOTH routers, in the same order as server.js. GET /api/sitenex/deals now lives in the Phase 3 router,
// so mounting only the first one 404s it — and a 404 on a scoping test reads as "no rows visible", which
// is the shape of a passing scoping assertion. Mounting both is what keeps these tests about scoping.
const phase3 = require('./sitenex-phase3.routes');
const app = express(); app.use(express.json()); app.use('/api', router); app.use('/api', phase3);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const get = (path, role) => fetch(base() + path, {
  headers: { Authorization: 'Bearer ' + signToken({ id: 'u-' + role, email: role + '@x.com', role }) },
}).then(r => r.status);

const PROSPECTS = '/api/sitenex/prospects', DEALS = '/api/sitenex/deals', PACKAGES = '/api/sitenex/packages';

test('staff reach all three screens', async () => {
  for (const role of ['super_admin', 'admin']) {
    for (const p of [PROSPECTS, DEALS, PACKAGES]) {
      assert.notEqual(await get(p, role), 403, `${role} must reach ${p}`);
    }
  }
});

test('the partner reaches Deals and Packages', async () => {
  assert.notEqual(await get(DEALS, 'partner'), 403);
  assert.notEqual(await get(PACKAGES, 'partner'), 403);
});

test('the partner is REFUSED SiteNex Prospects — the route, not just the link', async () => {
  assert.equal(await get(PROSPECTS, 'partner'), 403);
});

test('no other role reaches any SiteNex screen', async () => {
  // The sitenex tier is what admits a request now, and only three roles hold it. Every other role must
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

// ── the prospect search the deal picker needs ──────────────────────────────────

test('GET /sitenex/prospects accepts ?q= and ?status=, for the New deal picker', () => {
  // Added to the EXISTING list rather than as a second lightweight endpoint: the four bucket definitions
  // and the agency-as-tiebreak ORDER BY live in this handler, and a parallel "list sitenex prospects"
  // query is exactly the thing that would drift away from them.
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/routes.js', 'utf8');
  const from = src.indexOf("router.get('/sitenex/prospects'");
  assert.notEqual(from, -1);
  const body = src.slice(from, src.indexOf('\n});\n', from));
  assert.match(body, /req\.query\.q/, 'a name search');
  assert.match(body, /name ILIKE/, 'matched on the business name');
  assert.match(body, /req\.query\.status/, 'and the qualifier verdict, so the picker can ask for qualified only');
  // Parameterised, not interpolated — this one takes free text from a search box.
  assert.ok(!/\$\{[^}]*req\.query\.q/.test(body), 'the search term must never be interpolated into SQL');
  assert.match(body, /params\.push\('%' \+ String\(req\.query\.q\)/, 'it is bound as a parameter');
});
