// PRODUCT BOUNDARY — resolver + middleware. Run with:
//   node --test src/lib/products/boundary.test.js
//
// The contracts that matter:
//   • an intermediate marker ('param:product', 'param:agent') is NEVER the answer — nested
//     resolution must resolve THROUGH to a real product, or fail closed
//   • shadow mode never blocks, and logs EVERY request (denominator, not just blocks)
//   • enforce mode fails CLOSED on an unresolvable product
//   • 'internal' behaves as a held product, so a tier mistake alone exposes nothing

const { test } = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const { resolveProduct } = require('./resolve-product');
const { productBoundary, boundaryMode } = require('./boundary');

const SECRET = 'test-secret';
const token = (id, role) => 'Bearer ' + jwt.sign({ id, role }, SECRET);
const mkReq = (method, pattern, extra = {}) => ({
  method, route: { path: pattern.replace(/^\/api/, '') }, baseUrl: '/api',
  originalUrl: extra.url || pattern, url: extra.url || pattern,
  headers: { authorization: extra.auth || token('u1', 'admin') },
  query: extra.query || {}, body: extra.body || {}, params: extra.params || {}, path: pattern,
});
const mkRes = () => { const r = { statusCode: null, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

// ── resolver ──────────────────────────────────────────────────────────────────
test('a plain product route resolves to that product', async () => {
  const r = await resolveProduct(mkReq('GET', '/api/apollo/stats'));
  assert.equal(r.product, 'abiozen');
  assert.equal(r.unresolved, false);
});

test("'internal' and 'shared' resolve as themselves", async () => {
  assert.equal((await resolveProduct(mkReq('GET', '/api/users'))).product, 'internal');
  assert.equal((await resolveProduct(mkReq('GET', '/api/auth/me'))).product, 'shared');
  assert.equal((await resolveProduct(mkReq('GET', '/api/meetings'))).product, 'internal');
});

test('param:product reads the request, and an unknown product name fails closed', async () => {
  const named = await resolveProduct(mkReq('GET', '/api/prospects', { query: { product: 'sitenex' } }));
  assert.equal(named.product, 'sitenex');
  const dflt = await resolveProduct(mkReq('GET', '/api/prospects'));
  assert.equal(dflt.product, 'golfnex', 'documented default');
  const bogus = await resolveProduct(mkReq('GET', '/api/prospects', { query: { product: 'not-a-product' } }));
  assert.equal(bogus.product, null);
  assert.equal(bogus.unresolved, true);
});

// NOTE ON THE REQUEST SHAPE IN THESE TESTS. They pass a PATTERN url and an explicit `params`, which is
// not what the middleware sees — it gets a concrete path and an EMPTY params. That is deliberate here:
// these drive the resolver's BRANCHES one at a time. It is also exactly the assumption that hid a real
// bug, so the integration shape (bare request, params read out of the path) is covered separately and
// non-negotiably in route-sweep.test.js. Do not treat these as proof the production path works.
test('param:agent resolves a real agent key to its product', async () => {
  // Keys are the REAL MC_RUNNERS keys, suffixes included.
  const abiozenAgent = await resolveProduct(mkReq('POST', '/api/agent/mission-control/:key/run', { params: { key: 'sales-agent' } }));
  assert.equal(abiozenAgent.product, 'abiozen');
  const internalAgent = await resolveProduct(mkReq('POST', '/api/agent/mission-control/:key/run', { params: { key: 'ceo-agent' } }));
  assert.equal(internalAgent.product, 'internal');
});

test('param:agent resolves THROUGH a nested param:product — never the literal marker', async () => {
  // NO agent key maps to 'param:product' today (MC_RUNNERS has no per-product agent), so the
  // nested path is exercised with a temporary key rather than by pretending one exists. The
  // capability has to work before such an agent is added, because the failure mode is silent:
  // comparing the literal 'param:product' against user_products would let everything through.
  const { AGENT_PRODUCT } = require('./route-map');
  AGENT_PRODUCT['nested-test-agent'] = 'param:product';
  try {
    const nested = await resolveProduct(mkReq('POST', '/api/agent/mission-control/:key/run',
      { params: { key: 'nested-test-agent' }, body: { product: 'favly' } }));
    assert.equal(nested.product, 'favly', 'resolved through to a real product');
    assert.notEqual(nested.product, 'param:product', 'the marker is never the answer');
    assert.ok(nested.via.some(v => /agent:nested-test-agent=param:product/.test(v)), 'the hop is recorded');

    // With no product named and no documented default for this route, it is UNRESOLVED —
    // fail-closed — rather than the marker leaking through as a pseudo-product.
    const noProduct = await resolveProduct(mkReq('POST', '/api/agent/mission-control/:key/run', { params: { key: 'nested-test-agent' } }));
    assert.equal(noProduct.product, null);
    assert.equal(noProduct.unresolved, true);
  } finally { delete AGENT_PRODUCT['nested-test-agent']; }
});

test('an UNLISTED agent key fails closed', async () => {
  const r = await resolveProduct(mkReq('POST', '/api/agent/mission-control/:key/run', { params: { key: 'brand-new-agent' } }));
  assert.equal(r.product, null);
  assert.equal(r.unresolved, true);
  assert.ok(r.via.some(v => /UNLISTED/.test(v)));
});

test('row: lookup reads the product off the row — GET and PUT alike', async () => {
  const lookupRowProduct = async (table, column, id) => {
    assert.equal(table, 'prospects'); assert.equal(column, 'product');
    return id === '42' ? 'sitenex' : null;
  };
  for (const method of ['GET', 'PUT']) {
    const r = await resolveProduct(mkReq(method, '/api/prospects/:id', { params: { id: '42' } }), { lookupRowProduct });
    assert.equal(r.product, 'sitenex', `${method} resolves from the row`);
  }
});

test('row: a missing row, a failing lookup, or no lookup at all all fail closed', async () => {
  const missing = await resolveProduct(mkReq('GET', '/api/prospects/:id', { params: { id: '999' } }),
    { lookupRowProduct: async () => null });
  assert.equal(missing.product, null); assert.equal(missing.unresolved, true);

  const throws = await resolveProduct(mkReq('GET', '/api/prospects/:id', { params: { id: '1' } }),
    { lookupRowProduct: async () => { throw new Error('db down'); } });
  assert.equal(throws.product, null);
  assert.ok(throws.via.some(v => /lookup failed/.test(v)));

  const none = await resolveProduct(mkReq('GET', '/api/prospects/:id', { params: { id: '1' } }));
  assert.equal(none.product, null, 'no lookup provided → unresolved, not allowed');
});

test('an unclassified route is unresolved (fail closed), never shared', async () => {
  const r = await resolveProduct(mkReq('GET', '/api/nothing-mapped-here'));
  assert.equal(r.product, null);
  assert.equal(r.unresolved, true);
});

// ── middleware ────────────────────────────────────────────────────────────────
function harness(mode, { held = ['abiozen', 'internal'], lookupRowProduct } = {}) {
  const logged = [];
  const mw = productBoundary({
    env: { PRODUCT_BOUNDARY_MODE: mode, JWT_SECRET: SECRET },
    heldProducts: async () => held,
    logShadow: (row) => logged.push(row),
    lookupRowProduct: lookupRowProduct || (async () => 'sitenex'),
  });
  return { mw, logged };
}

test('off mode does nothing — no evaluation, no logging', async () => {
  const { mw, logged } = harness('off');
  const res = mkRes(); let nexted = false;
  await mw(mkReq('GET', '/api/apollo/stats'), res, () => { nexted = true; });
  assert.equal(nexted, true); assert.equal(res.statusCode, null); assert.equal(logged.length, 0);
});

test('shadow mode NEVER blocks, and logs allowed requests too (the denominator)', async () => {
  const { mw, logged } = harness('shadow');
  const res = mkRes(); let nexted = 0;
  await mw(mkReq('GET', '/api/apollo/stats'), res, () => nexted++);          // held
  await mw(mkReq('GET', '/api/sitenex/prospects'), res, () => nexted++);        // NOT held
  assert.equal(nexted, 2, 'both passed through');
  assert.equal(res.statusCode, null, 'nothing blocked');
  assert.equal(logged.length, 2, 'every evaluated request logged, not only would-blocks');
  assert.deepEqual(logged.map(l => l.would_block), [false, true]);
  assert.deepEqual(logged[1].user_products, ['abiozen', 'internal']);
});

test('enforce mode blocks a product the caller does not hold', async () => {
  const { mw } = harness('enforce');
  const res = mkRes(); let nexted = false;
  await mw(mkReq('GET', '/api/sitenex/prospects'), res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.reason, 'not_held');
  assert.equal(res.body.resolved_product, 'sitenex');
});

test('enforce mode FAILS CLOSED on an unresolvable product', async () => {
  const { mw, logged } = harness('enforce');
  const res = mkRes(); let nexted = false;
  await mw(mkReq('GET', '/api/nothing-mapped-here'), res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.reason, 'unresolved');
  assert.equal(logged[0].resolved_product, null);
});

test("'shared' is allowed without any grant; 'internal' requires the grant", async () => {
  const { mw } = harness('enforce', { held: [] });     // holds NOTHING
  const shared = mkRes();
  let nexted = false;
  await mw(mkReq('GET', '/api/auth/me'), shared, () => { nexted = true; });
  assert.equal(nexted, true, 'shared passes with no products at all');
  assert.equal(shared.statusCode, null);

  const internal = mkRes();
  await mw(mkReq('GET', '/api/users'), internal, () => {});
  assert.equal(internal.statusCode, 403, 'internal is NOT free — a tier mistake alone exposes nothing');
  assert.equal(internal.body.resolved_product, 'internal');
});

test('anonymous requests are not evaluated — authMiddleware owns the 401', async () => {
  const { mw, logged } = harness('enforce');
  const res = mkRes(); let nexted = false;
  await mw(mkReq('GET', '/api/sitenex/prospects', { auth: 'Bearer garbage' }), res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(res.statusCode, null);
  assert.equal(logged.length, 0);
});

test('an internal failure denies in enforce and no-ops in shadow', async () => {
  for (const [mode, expected] of [['enforce', 403], ['shadow', null]]) {
    const mw = productBoundary({
      env: { PRODUCT_BOUNDARY_MODE: mode, JWT_SECRET: SECRET },
      heldProducts: async () => { throw new Error('db exploded'); },
      logShadow: () => {},
    });
    const res = mkRes(); let nexted = false;
    await mw(mkReq('GET', '/api/apollo/stats'), res, () => { nexted = true; });
    assert.equal(res.statusCode, expected, `${mode} on internal error`);
    assert.equal(nexted, expected === null);
  }
});

test('mode defaults to shadow, and an unknown mode is treated as shadow', () => {
  assert.equal(boundaryMode({}), 'shadow');
  assert.equal(boundaryMode({ PRODUCT_BOUNDARY_MODE: 'ENFORCE' }), 'enforce');
  assert.equal(boundaryMode({ PRODUCT_BOUNDARY_MODE: 'banana' }), 'shadow');
  assert.equal(boundaryMode({ PRODUCT_BOUNDARY_MODE: 'off' }), 'off');
});
