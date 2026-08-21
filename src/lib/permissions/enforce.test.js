// Enforcement tests — run with:  node --test src/lib/permissions/enforce.test.js
// Hermetic: resolver, token-verify, and (mostly) the route matcher are injected via deps.
// Proves the staged per-role contract: enrolled roles are resolver-decided, everyone else
// (and the empty list) keeps the gate, and the path NEVER throws / fails open on resolver error.

const { test } = require('node:test');
const assert = require('node:assert');
const enforce = require('./enforce');
const { mapFeatureKey } = require('./shadow'); // the real matcher, for the integration case

// ── fakes ─────────────────────────────────────────────────────────────────────
function makeRes() {
  const res = { statusCode: null, body: null, _sent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res._sent = true; return res; };
  return res;
}
function makeNext() { const n = (...a) => { n.called = true; n.args = a; }; n.called = false; return n; }
// req whose token decodes (via injected verifyToken) to the given role
const req = (over = {}) => ({ method: 'GET', originalUrl: '/api/x', headers: { authorization: 'Bearer t' }, ...over });
const verifyAs = (role) => () => (role ? { id: 'u1', email: 'u@x', role } : null);
const resolveTo = (allowed, rule, explain = 'x') => async () => ({ allowed, rule, source: null, explain });
// a query() that records the denial-insert params so we can assert on the row written
function capture() { const rows = []; return { query: (_sql, params) => { rows.push(params); return Promise.resolve({ rows: [] }); }, rows }; }

// The six granted pairs (admin=Mohan, business_dev=Vinitha) — all now resolver-ALLOW via rule 5.
const GRANTED = [
  ['admin',        'intelligence.research_intelligence_studies.find_contacts'],
  ['admin',        'intelligence.research_intelligence_studies.resolve_org'],
  ['admin',        'growth.linkedin.regenerate_image'],
  ['admin',        'intelligence.research_intelligence.run'],
  ['business_dev', 'intelligence.research_intelligence_studies.find_contacts'],
  ['business_dev', 'intelligence.research_intelligence_studies.resolve_org'],
];

// ── 1. role IN the list is resolver-decided ────────────────────────────────────
test('enrolled role — resolver DENY → 403 (handler never runs)', async () => {
  const cap = capture();
  const res = makeRes(), next = makeNext();
  await enforce.enforceMiddleware(req(), res, next, {
    env: { PERMISSIONS_ENFORCE_ROLES: 'admin' },
    verifyToken: verifyAs('admin'),
    mapFeatureKey: () => 'intelligence.some.feature',
    resolve: resolveTo(false, 8, 'no rule matched'),
    query: cap.query,
  });
  assert.equal(next.called, false, 'resolver deny must NOT call next()');
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.feature_key, 'intelligence.some.feature');
  assert.equal(res.body.rule, 8);
});

test('enrolled role — resolver ALLOW → next() (gate still runs after)', async () => {
  const res = makeRes(), next = makeNext();
  await enforce.enforceMiddleware(req(), res, next, {
    env: { PERMISSIONS_ENFORCE_ROLES: 'admin' },
    verifyToken: verifyAs('admin'),
    mapFeatureKey: () => 'intelligence.some.feature',
    resolve: resolveTo(true, 5),
  });
  assert.equal(next.called, true, 'resolver allow must call next()');
  assert.equal(res._sent, false, 'allow must not send a response');
});

// ── 2. resolver throwing → fall back to the gate, never a 500 ───────────────────
test('resolver throws → FAIL OPEN to gate (next, no throw, no 500)', async () => {
  const res = makeRes(), next = makeNext();
  await assert.doesNotReject(() => enforce.enforceMiddleware(req(), res, next, {
    env: { PERMISSIONS_ENFORCE_ROLES: 'admin' },
    verifyToken: verifyAs('admin'),
    mapFeatureKey: () => 'intelligence.some.feature',
    resolve: async () => { throw new Error('resolver boom'); },
  }));
  assert.equal(next.called, true, 'a resolver error must fall through to the existing gate');
  assert.equal(res._sent, false, 'must not emit a 403/500 on resolver error');
});

// ── 3. the six granted pairs still ALLOW under enforcement ──────────────────────
test('the six granted pairs still allow (resolver rule 5 → next)', async () => {
  for (const [role, feature] of GRANTED) {
    const res = makeRes(), next = makeNext();
    await enforce.enforceMiddleware(req(), res, next, {
      env: { PERMISSIONS_ENFORCE_ROLES: 'admin,business_dev' },
      verifyToken: verifyAs(role),
      mapFeatureKey: () => feature,
      resolve: resolveTo(true, 5, 'explicit allow override'),
    });
    assert.equal(next.called, true, `${role} ${feature} should pass`);
    assert.equal(res._sent, false, `${role} ${feature} should not be blocked`);
  }
});

// ── 4. enforced role hitting a defaultDeny feature gets 403 w/ the feature key ───
test('enforced role hits a defaultDeny feature → 403 carrying the mapped feature key', async () => {
  // Use the REAL matcher on a real admin route so the key in the body is genuine.
  const path = '/api/reorder/dashboard';
  const realKey = mapFeatureKey('GET', path);
  assert.ok(realKey, 'precondition: the route maps to a real feature key');
  const res = makeRes(), next = makeNext();
  await enforce.enforceMiddleware(req({ method: 'GET', originalUrl: path }), res, next, {
    env: { PERMISSIONS_ENFORCE_ROLES: 'admin' },
    verifyToken: verifyAs('admin'),
    resolve: resolveTo(false, 8), // resolver denies a defaultDeny feature for admin
    query: capture().query,
    // mapFeatureKey omitted → real matcher used
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.feature_key, realKey, 'the 403 body names exactly the denied feature');
  assert.equal(res.body.rule, 8);
  assert.equal(next.called, false);
});

// ── 5. empty list → zero behaviour change ───────────────────────────────────────
test('empty PERMISSIONS_ENFORCE_ROLES → next() always, resolver never consulted', async () => {
  let resolverCalls = 0;
  const res = makeRes(), next = makeNext();
  await enforce.enforceMiddleware(req(), res, next, {
    env: { PERMISSIONS_ENFORCE_ROLES: '' },
    verifyToken: verifyAs('admin'),
    mapFeatureKey: () => 'intelligence.some.feature',
    resolve: async () => { resolverCalls++; return { allowed: false, rule: 8 }; },
  });
  assert.equal(next.called, true, 'empty list must always call next()');
  assert.equal(res._sent, false);
  assert.equal(resolverCalls, 0, 'empty list must not even consult the resolver');
});

// ── unenrolled role keeps the gate (not resolver-decided) ───────────────────────
test('role ABSENT from the list is gate-decided (resolver never consulted)', async () => {
  let resolverCalls = 0;
  const res = makeRes(), next = makeNext();
  await enforce.enforceMiddleware(req(), res, next, {
    env: { PERMISSIONS_ENFORCE_ROLES: 'admin' },
    verifyToken: verifyAs('sales_team'), // not in the list
    mapFeatureKey: () => 'intelligence.some.feature',
    resolve: async () => { resolverCalls++; return { allowed: false, rule: 8 }; },
  });
  assert.equal(next.called, true, 'unenrolled role must fall through to the gate');
  assert.equal(res._sent, false);
  assert.equal(resolverCalls, 0, 'unenrolled role must not consult the resolver');
});

// ── anonymous / bad token → gate handles 401, enforcement no-ops ─────────────────
test('no decodable user → next() (downstream authMiddleware handles 401)', async () => {
  const res = makeRes(), next = makeNext();
  await enforce.enforceMiddleware(req({ headers: {} }), res, next, {
    env: { PERMISSIONS_ENFORCE_ROLES: 'admin' },
    verifyToken: verifyAs(null),
    mapFeatureKey: () => 'intelligence.some.feature',
    resolve: resolveTo(false, 8),
  });
  assert.equal(next.called, true, 'anonymous request falls through; the gate returns 401');
  assert.equal(res._sent, false);
});

// ── unmapped route → gate decides (resolver can't reason) ───────────────────────
test('unmapped route for an enrolled role → next() (not blocked)', async () => {
  let resolverCalls = 0;
  const res = makeRes(), next = makeNext();
  await enforce.enforceMiddleware(req({ originalUrl: '/api/totally/unknown' }), res, next, {
    env: { PERMISSIONS_ENFORCE_ROLES: 'admin' },
    verifyToken: verifyAs('admin'),
    mapFeatureKey: () => null, // unmapped
    resolve: async () => { resolverCalls++; return { allowed: false, rule: 8 }; },
  });
  assert.equal(next.called, true, 'unmapped route must fall through to the gate');
  assert.equal(resolverCalls, 0, 'unmapped route must not consult the resolver');
});

// ── deny instrumentation (permission_enforce_denials) ───────────────────────────
test('a deny WRITES a denial row and still returns 403', async () => {
  const cap = capture();
  const res = makeRes(), next = makeNext();
  await enforce.enforceMiddleware(req({ method: 'POST', originalUrl: '/api/foo/bar?x=1' }), res, next, {
    env: { PERMISSIONS_ENFORCE_ROLES: 'admin' },
    verifyToken: () => ({ id: 'u42', email: 'u@x', role: 'admin' }),
    mapFeatureKey: () => 'intelligence.some.feature',
    resolve: resolveTo(false, 8, 'no rule matched'),
    query: cap.query,
  });
  assert.equal(res.statusCode, 403, 'deny still returns 403');
  assert.equal(next.called, false);
  assert.equal(cap.rows.length, 1, 'exactly one denial row written');
  const p = cap.rows[0];
  assert.equal(p[0], 'u42');                          // user_id
  assert.equal(p[1], 'admin');                        // role
  assert.equal(p[2], 'intelligence.some.feature');    // feature_key
  assert.equal(p[3], 'POST');                         // method
  assert.equal(p[4], '/api/foo/bar');                 // path (query string stripped)
  assert.equal(p[5], 8);                              // resolver_rule
  assert.equal(p[6], 'no rule matched');              // resolver_explain
});

test('a FAILING denial write does not break the response (still 403, no throw)', async () => {
  const res = makeRes(), next = makeNext();
  // query throws synchronously — fireDenial must swallow it
  const throwingSync = { query: () => { throw new Error('db down'); } };
  await assert.doesNotReject(() => enforce.enforceMiddleware(req(), res, next, {
    env: { PERMISSIONS_ENFORCE_ROLES: 'admin' },
    verifyToken: verifyAs('admin'),
    mapFeatureKey: () => 'intelligence.some.feature',
    resolve: resolveTo(false, 8),
    query: throwingSync.query,
  }));
  assert.equal(res.statusCode, 403, 'a failed write must not change the 403');
  assert.equal(next.called, false);
});

test('a FAILING async denial write (rejected promise) does not break the response', async () => {
  const res = makeRes(), next = makeNext();
  const rejecting = { query: () => Promise.reject(new Error('write timeout')) };
  await assert.doesNotReject(() => enforce.enforceMiddleware(req(), res, next, {
    env: { PERMISSIONS_ENFORCE_ROLES: 'admin' },
    verifyToken: verifyAs('admin'),
    mapFeatureKey: () => 'intelligence.some.feature',
    resolve: resolveTo(false, 8),
    query: rejecting.query,
  }));
  assert.equal(res.statusCode, 403);
  assert.equal(next.called, false);
});

test('an ALLOW writes nothing to the denial log', async () => {
  const cap = capture();
  const res = makeRes(), next = makeNext();
  await enforce.enforceMiddleware(req(), res, next, {
    env: { PERMISSIONS_ENFORCE_ROLES: 'admin' },
    verifyToken: verifyAs('admin'),
    mapFeatureKey: () => 'intelligence.some.feature',
    resolve: resolveTo(true, 5),
    query: cap.query,
  });
  assert.equal(next.called, true, 'allow calls next()');
  assert.equal(res._sent, false);
  assert.equal(cap.rows.length, 0, 'allow must write no denial row');
});

// ── parseRoles helper ───────────────────────────────────────────────────────────
test('parseRoles trims, drops blanks, and treats empty/unset as no roles', () => {
  assert.deepEqual([...enforce.parseRoles('admin, business_dev ,,')], ['admin', 'business_dev']);
  assert.equal(enforce.parseRoles('').size, 0);
  assert.equal(enforce.parseRoles(undefined).size, 0);
});
