// PRODUCT BOUNDARY — route-map completeness. Run with:
//   node --test src/lib/products/route-map.test.js
//
// THE COMPLETENESS TEST asserts that EVERY MOUNTED EXPRESS ROUTE appears in the map. Not "every
// product-scoped route": you cannot know which those are without the map, so that version is
// circular and passes vacuously.
//
// It enumerates the routes from the live router (src/api/routes.js) plus the app-level routes in
// server.js, so adding a route without classifying it fails here — and the failure NAMES the
// unmapped routes, so the fix is obvious rather than a hunt.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROUTE_PRODUCT, AGENT_PRODUCT, PARAM_DEFAULT, ROW_PRODUCT, VALUES, PRODUCTS, GRANTABLE, classifyRoute, PARAM_PRODUCT } = require('./route-map');

// Routes mounted directly on the app in server.js, outside the /api router. Parsed from the file
// rather than hard-coded, so a new app.get() is caught too.
function appLevelRoutes() {
  const src = fs.readFileSync(path.join(__dirname, '../../../server.js'), 'utf8');
  const out = [];
  for (const m of src.matchAll(/\bapp\.(get|post|put|delete)\(\s*['"]([^'"]+)['"]/g)) {
    out.push(`${m[1].toUpperCase()} ${m[2]}`);
  }
  return out;
}

function mountedRoutes() {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const router = require('../../api/routes');
  const out = [];
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) {
      if (layer.route.methods[m]) out.push(`${m.toUpperCase()} /api${layer.route.path}`);
    }
  }
  return [...out, ...appLevelRoutes()].sort();
}

test('COMPLETENESS: every mounted route is classified in ROUTE_PRODUCT', () => {
  const routes = mountedRoutes();
  assert.ok(routes.length > 150, `expected the full route table, got ${routes.length}`);
  const unmapped = routes.filter(r => {
    const [method, ...rest] = r.split(' ');
    return classifyRoute(method, rest.join(' ')) === null;
  });
  assert.deepEqual(unmapped, [],
    `\n\n${unmapped.length} route(s) are NOT classified in src/lib/products/route-map.js.\n` +
    `Add each one with an EXPLICIT value — 'shared' if this gate should not constrain it.\n` +
    `Absence must never mean neutral.\n\n` +
    unmapped.map(r => `  '${r}': '???',`).join('\n') + '\n');
});

test('every map value is a legal value', () => {
  for (const [route, value] of Object.entries(ROUTE_PRODUCT)) {
    assert.ok(VALUES.has(value), `${route} has illegal value ${JSON.stringify(value)}`);
  }
});

test('no route is classified twice with different answers', () => {
  // ROUTE_PRODUCT is built by assignment, so a duplicate would be silently overwritten. Catch it
  // by rebuilding from the source lists and counting.
  const { SHARED, INTERNAL, ABIOZEN, GOLFNEX, AROS, ACBM } = require('./route-map');
  const all = [...SHARED, ...INTERNAL, ...ABIOZEN, ...GOLFNEX, ...AROS, ...ACBM, ...PARAM_PRODUCT, ...Object.keys(ROW_PRODUCT)];
  const seen = new Map();
  const dupes = [];
  for (const r of all) { if (seen.has(r)) dupes.push(r); seen.set(r, true); }
  assert.deepEqual(dupes, [], `these routes appear in more than one product list: ${dupes.join(', ')}`);
});

test('exact keys beat wildcards, and the longest wildcard wins', () => {
  // /api/events is a MIXED prefix: cphi is abiozen, ingest reads the product from the request.
  assert.equal(classifyRoute('GET', '/api/events/cphi/exhibitors'), 'abiozen');
  assert.equal(classifyRoute('POST', '/api/events/ingest'), 'param:product');
  // an exact prospects entry is not swallowed by any wildcard
  assert.equal(classifyRoute('GET', '/api/prospects'), 'param:product');
  // ...and the :id routes resolve by ROW LOOKUP, not by request param: the id identifies the row
  // and the row knows its product. PUT especially — a guessed id would otherwise MODIFY another
  // product's prospect, not merely read it.
  assert.equal(classifyRoute('GET', '/api/prospects/:id'), 'row:prospects.product');
  assert.equal(classifyRoute('PUT', '/api/prospects/:id'), 'row:prospects.product');
  // wildcards do cover their prefix
  assert.equal(classifyRoute('GET', '/api/apollo/stats'), 'abiozen');
  assert.equal(classifyRoute('GET', '/api/acbm/prospects'), 'acbm');
});

test('an unclassified route resolves to null, never to shared', () => {
  assert.equal(classifyRoute('GET', '/api/something-nobody-mapped'), null);
  assert.equal(classifyRoute('DELETE', '/api/apollo/stats'), null, 'a different METHOD is not covered by a GET wildcard');
});

test('AGENT_PRODUCT covers every agent key mission-control accepts', () => {
  // Reads the handler's OWN key list so the two cannot drift. It parses MC_RUNNERS specifically —
  // an earlier version of this test scanned the text AFTER the route definition, but MC_RUNNERS is
  // defined ABOVE it, so it matched nothing and passed vacuously while the map held invented keys
  // ('sales' instead of 'sales-agent'). Hence the explicit count assertion below: a test that can
  // find zero keys must fail, not pass.
  const src = fs.readFileSync(path.join(__dirname, '../../api/routes.js'), 'utf8');
  const start = src.indexOf('const MC_RUNNERS = {');
  assert.ok(start > -1, 'MC_RUNNERS not found — this test needs updating, not deleting');
  const block = src.slice(start, src.indexOf('\n};', start));
  const keys = [...block.matchAll(/^\s+'([a-z0-9-]+)':/gm)].map(m => m[1]);
  assert.ok(keys.length >= 8, `expected to parse the agent keys, found ${keys.length}`);

  const known = new Set(Object.keys(AGENT_PRODUCT));
  const missing = keys.filter(k => !known.has(k));
  assert.deepEqual(missing, [], `agent keys not in AGENT_PRODUCT (they would fail closed): ${missing.join(', ')}`);

  // ...and nothing invented in the other direction either.
  const invented = [...known].filter(k => !keys.includes(k));
  assert.deepEqual(invented, [], `AGENT_PRODUCT lists keys mission-control does not accept: ${invented.join(', ')}`);
});

test('every param:product route documents its default', () => {
  for (const r of PARAM_PRODUCT) {
    assert.ok(Object.prototype.hasOwnProperty.call(PARAM_DEFAULT, r),
      `${r} is param:product but has no PARAM_DEFAULT entry — the no-product case would be undefined`);
    const d = PARAM_DEFAULT[r];
    assert.ok(d === null || PRODUCTS.includes(d), `${r} default ${JSON.stringify(d)} is not a product or null`);
  }
});

test('the prospects defaults match what the handlers actually do', () => {
  // The boundary must agree with the code, not guess: routes.js defaults product to 'golfnex'.
  const src = fs.readFileSync(path.join(__dirname, '../../api/routes.js'), 'utf8');
  const defaults = [...src.matchAll(/req\.(?:query|body)(?:\s*&&\s*req\.body)?\.product\s*\)?\s*\|\|\s*'([a-z]+)'/g)].map(m => m[1]);
  assert.ok(defaults.length >= 3, 'expected to find the handlers\' product defaults');
  for (const d of new Set(defaults)) {
    assert.equal(d, 'golfnex', `a handler defaults product to '${d}' — update PARAM_DEFAULT to match`);
  }
});
