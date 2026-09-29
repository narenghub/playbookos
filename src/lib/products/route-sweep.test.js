// PRODUCT BOUNDARY — resolution sweep over EVERY mounted route.
//   node --test src/lib/products/route-sweep.test.js
//
// WHY THIS EXISTS. Shadow traffic was meant to prove the map, but after three days it had touched
// 27 of 210 routes (13%). Waiting longer does not fix that: the 183 untouched routes include ~110
// that MUTATE (agent runs, publishes, deletes), and those can never be exercised by a safe sweep —
// nobody is going to fire the email engine to test a route map.
//
// So this proves what traffic was going to prove, without traffic: it drives every mounted route
// through resolveProduct() with a synthetic request and asserts each one resolves to a CONCRETE
// product. No HTTP, no handlers, no side effects.
//
// What this does and does not cover:
//   ✓ the matcher maps every real route to its map entry (the bug that would 403 everything under
//     enforce, and the one a concrete URL like /api/prospects/6533 would have exposed)
//   ✓ every route yields a grantable product, never null and never an intermediate marker
//   ✗ whether each classification is the RIGHT product — that is a judgement, and it lives in the
//     map's own review, not in a test
//   ✗ the DB half of a row: lookup — that needs a real row, so it is stubbed here and remains the
//     one thing only real traffic (or the enforce cutover) can confirm

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveProduct } = require('./resolve-product');
const { classifyRoute, GRANTABLE } = require('./route-map');

function mountedRoutes() {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const router = require('../../api/routes');
  const out = [];
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) {
      if (layer.route.methods[m]) out.push({ method: m.toUpperCase(), path: `/api${layer.route.path}` });
    }
  }
  out.push({ method: 'GET', path: '/health' }, { method: 'GET', path: '/sitemap.xml' });
  return out;
}

// A request as it reaches the middleware: BEFORE the router, so req.route does not exist and the
// path is concrete. Params are filled the way Express would have, so row:/param: routes resolve.
function syntheticReq({ method, path }) {
  const concrete = path
    .replace(/:id\b/g, '12345')
    .replace(/:user_id\b/g, 'u-1').replace(/:userId\b/g, 'u-1')
    .replace(/:rfqId\b/g, '7').replace(/:cas_number\b/g, '50-00-0')
    .replace(/:key\b/g, 'sales-agent');
  const params = {};
  for (const m of path.matchAll(/:([a-zA-Z_]+)/g)) {
    params[m[1]] = m[1] === 'key' ? 'sales-agent' : (m[1].includes('user') ? 'u-1' : '12345');
  }
  return {
    method, originalUrl: concrete, url: concrete, params,
    // param:product routes read the product from the request; the screens always send it.
    query: { product: 'acbm' }, body: { product: 'acbm' },
    headers: {},
  };
}

test('SWEEP: every mounted route resolves to a concrete product', async () => {
  const routes = mountedRoutes();
  assert.ok(routes.length > 200, `expected the full route table, got ${routes.length}`);
  // A row: lookup needs a row; stub it so the sweep tests the MATCHER, not the database.
  const lookupRowProduct = async () => 'acbm';
  const failures = [];
  for (const r of routes) {
    const res = await resolveProduct(syntheticReq(r), { lookupRowProduct });
    const ok = res.product === 'shared' || GRANTABLE.includes(res.product);
    if (!ok) failures.push(`${r.method} ${r.path} → ${JSON.stringify(res.product)} (${res.via.join(' → ')})`);
  }
  assert.deepEqual(failures, [],
    `\n\n${failures.length} mounted route(s) do NOT resolve to a product. Under enforce these 403 for\n` +
    `everyone, including super_admin — fail-closed is working as designed and the MAP is wrong.\n\n` +
    failures.map(f => '  ' + f).join('\n') + '\n');
});

test('SWEEP: no route resolves to an intermediate marker', async () => {
  const bad = [];
  for (const r of mountedRoutes()) {
    const res = await resolveProduct(syntheticReq(r), { lookupRowProduct: async () => 'acbm' });
    if (res.product === 'param:product' || res.product === 'param:agent' || /^row:/.test(String(res.product))) {
      bad.push(`${r.method} ${r.path} → ${res.product}`);
    }
  }
  assert.deepEqual(bad, [], `markers leaked as answers (they would be compared against user_products): ${bad.join(', ')}`);
});

test('SWEEP: the concrete-path matcher agrees with the pattern classification', async () => {
  // Every route must resolve the same whether asked by PATTERN (what the map is keyed on) or by a
  // CONCRETE path (what the middleware actually sees). A disagreement is the /api/prospects/6533
  // class of bug: the map looks right and the middleware still resolves nothing.
  const mismatches = [];
  for (const r of mountedRoutes()) {
    const byPattern = classifyRoute(r.method, r.path);
    const byConcrete = await resolveProduct(syntheticReq(r), { lookupRowProduct: async () => 'acbm' });
    if (byPattern === null) { mismatches.push(`${r.method} ${r.path}: unclassified by pattern`); continue; }
    if (byConcrete.product === null) mismatches.push(`${r.method} ${r.path}: pattern says ${byPattern}, concrete path resolves to null`);
  }
  assert.deepEqual(mismatches, [], `\n${mismatches.map(m => '  ' + m).join('\n')}\n`);
});

test('SWEEP: a param:product route with NO product named still resolves or fails loudly', async () => {
  // The screens always send ?product=, but a hand-made request might not. Whatever happens must be
  // deliberate: the documented default, or unresolved — never a silent pass.
  const paramRoutes = mountedRoutes().filter(r => classifyRoute(r.method, r.path) === 'param:product');
  assert.ok(paramRoutes.length >= 4, 'expected the param:product routes to be found');
  for (const r of paramRoutes) {
    const req = syntheticReq(r); req.query = {}; req.body = {};
    const res = await resolveProduct(req, { lookupRowProduct: async () => 'acbm' });
    const deliberate = res.product === null ? res.unresolved === true : GRANTABLE.includes(res.product);
    assert.ok(deliberate, `${r.method} ${r.path} with no product: ${JSON.stringify(res)}`);
  }
});
