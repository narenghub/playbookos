// Shadow-mode tests — run with:  node --test src/lib/permissions/shadow.test.js
// No live DB and no real resolver: both are injected via deps. Proves the two invariants —
// the hook NEVER throws and NEVER alters the response — plus the mapping/disagreement logic.

process.env.PERMISSIONS_SHADOW_ENABLED = 'true'; // observe() defensively no-ops unless on

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const shadow = require('./shadow');

// a res that records every mutator call, so we can assert the shadow path touches none
function makeRes(statusCode = 200) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.touched = [];
  for (const m of ['status', 'json', 'send', 'end', 'write', 'setHeader', 'set', 'redirect']) {
    res[m] = (...a) => { res.touched.push(m); return res; };
  }
  return res;
}
const req = (over = {}) => ({ method: 'GET', originalUrl: '/api/reorder/dashboard', user: { id: 'u1', role: 'sales_team' }, ...over });
const okResolve = (allowed, rule = 7, explain = 'x') => async () => ({ allowed, rule, source: null, explain });
function capture() { const rows = []; return { query: (_sql, params) => { rows.push(params); return Promise.resolve({ rows: [] }); }, rows }; }

test('mapFeatureKey — literal, param, and unknown routes', () => {
  assert.ok(typeof shadow.mapFeatureKey('GET', '/api/reorder/dashboard') === 'string', 'known literal route maps');
  assert.ok(typeof shadow.mapFeatureKey('PUT', '/api/reorder/campaigns/123') === 'string', 'param route maps');
  assert.equal(shadow.mapFeatureKey('GET', '/api/does/not/exist'), null, 'unknown route maps to null');
  assert.equal(shadow.mapFeatureKey('POST', '/api/reorder/dashboard'), null, 'wrong method does not match a GET route');
});

test('disagreement (gate allow, resolver deny) IS logged', async () => {
  const cap = capture();
  await shadow.observe(req({ method: 'GET', originalUrl: '/api/reorder/dashboard' }), makeRes(200),
    { resolve: okResolve(false, 8, 'no rule matched'), query: cap.query });
  assert.equal(cap.rows.length, 1, 'one disagreement row written');
  const p = cap.rows[0];
  assert.equal(p[5], 'allow'); // gate_decision
  assert.equal(p[6], 'deny');  // resolver_decision
  assert.equal(p[7], 8);       // resolver_rule
});

test('agreement (both allow) is NOT logged', async () => {
  const cap = capture();
  await shadow.observe(req(), makeRes(200), { resolve: okResolve(true, 7), query: cap.query });
  assert.equal(cap.rows.length, 0, 'agreement writes nothing');
});

test('agreement (both deny: 403 + resolver deny) is NOT logged', async () => {
  const cap = capture();
  await shadow.observe(req(), makeRes(403), { resolve: okResolve(false, 8), query: cap.query });
  assert.equal(cap.rows.length, 0);
});

test('unmapped route with a user IS logged as its own case', async () => {
  const cap = capture();
  await shadow.observe(req({ originalUrl: '/api/totally/unknown/route' }), makeRes(200),
    { resolve: okResolve(true), query: cap.query });
  assert.equal(cap.rows.length, 1);
  assert.equal(cap.rows[0][2], null);            // feature_key
  assert.equal(cap.rows[0][6], 'unmapped_route'); // resolver_decision
});

test('no user → nothing observed', async () => {
  const cap = capture();
  await shadow.observe(req({ user: null }), makeRes(200), { resolve: okResolve(false), query: cap.query });
  assert.equal(cap.rows.length, 0);
});

test('NEVER THROWS — resolver throws', async () => {
  const cap = capture();
  await assert.doesNotReject(() => shadow.observe(req(), makeRes(200),
    { resolve: async () => { throw new Error('resolver boom'); }, query: cap.query }));
  assert.equal(cap.rows.length, 1);
  assert.equal(cap.rows[0][6], 'error'); // recorded as an error case, not crashed
});

test('NEVER THROWS — query throws synchronously', async () => {
  await assert.doesNotReject(() => shadow.observe(req(), makeRes(200),
    { resolve: okResolve(false), query: () => { throw new Error('db sync boom'); } }));
});

test('NEVER THROWS — query rejects asynchronously', async () => {
  await assert.doesNotReject(() => shadow.observe(req(), makeRes(200),
    { resolve: okResolve(false), query: () => Promise.reject(new Error('db async boom')) }));
});

test('NEVER THROWS — malformed req/res', async () => {
  await assert.doesNotReject(() => shadow.observe(null, null, {}));
  await assert.doesNotReject(() => shadow.observe({}, {}, {}));
  await assert.doesNotReject(() => shadow.observe(req(), {}, { resolve: okResolve(true), query: capture().query }));
});

test('NEVER ALTERS THE RESPONSE — middleware calls next() and touches no res mutator', async () => {
  const res = makeRes(200);
  let nextCalls = 0;
  shadow.shadowMiddleware(req(), res, () => { nextCalls++; });
  assert.equal(nextCalls, 1, 'next() called exactly once');
  // fire the finish event the way Express would, then let the async observe settle
  res.emit('finish');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(res.touched, [], 'shadow path never called status/json/send/end/write/setHeader/etc.');
});

test('mount() adds NOTHING when the flag is off (zero code paths)', () => {
  const prev = process.env.PERMISSIONS_SHADOW_ENABLED;
  process.env.PERMISSIONS_SHADOW_ENABLED = 'false';
  const uses = []; const fakeApp = { use: (...a) => uses.push(a) };
  const mounted = shadow.mount(fakeApp);
  assert.equal(mounted, false);
  assert.equal(uses.length, 0, 'no middleware registered when disabled');
  process.env.PERMISSIONS_SHADOW_ENABLED = prev;
});

test('mount() registers the observer when the flag is on', () => {
  const uses = []; const fakeApp = { use: (...a) => uses.push(a) };
  const mounted = shadow.mount(fakeApp);
  assert.equal(mounted, true);
  assert.equal(uses.length, 1);
  assert.equal(uses[0][0], '/api');
});
