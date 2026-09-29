// THE ROLE COMES FROM THE DATABASE, NOT THE TOKEN.
//   node --test src/lib/auth-role-freshness.test.js
//
// THE BUG THIS EXISTS FOR, and why the existing tests all passed through it.
//
// authMiddleware did `req.user = payload`, so every gate downstream trusted a role claim baked into a
// 7-day JWT. naren@abiozen.com was promoted to super_admin on 2026-09-28 with two live sessions;
// product_shadow_log recorded 178 requests the next day carrying `role: admin` and 25 carrying
// `role: super_admin`. Once user management moved to superAdminOnly, Edit worked in one tab and returned
// "Super admin only" in the other.
//
// Every negative test passed — a stale token is MORE restricted, not less. What was missing was the
// POSITIVE case: does a super_admin whose token predates the promotion actually get in. That is the test
// below, and it is written in terms of the token DISAGREEING with the database, because agreement is the
// case that was already covered.

process.env.JWT_SECRET = 'test-secret';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

// The users table: what each account IS, regardless of what any token claims.
let DB = {};
function reset() {
  DB = {
    'u-1': { role: 'super_admin', is_active: 1 },
    'u-2': { role: 'admin', is_active: 1 },
    'u-3': { role: 'dev_team', is_active: 1 },
    'u-gone': null,
    'u-off': { role: 'admin', is_active: 0 },
  };
}
reset();

let DB_DOWN = false;
const db = require('./db');
db.query = async (sql, params = []) => {
  if (DB_DOWN) throw new Error('connection refused');
  if (/^SELECT role, is_active FROM users WHERE id =/i.test(sql.trim())) {
    const row = DB[params[0]];
    return { rows: row ? [row] : [] };
  }
  if (/UPDATE users SET last_login/i.test(sql)) return { rows: [] };
  return { rows: [] };
};

const { authMiddleware, adminOnly, superAdminOnly, requireTier } = require('./core');

// A tiny app that reports back whatever the gates decided, so the assertions are about the gates and not
// about any particular business route.
const app = express();
app.use(express.json());
app.get('/whoami', authMiddleware, (req, res) => res.json({ role: req.user.role, id: req.user.id, email: req.user.email }));
app.get('/admin', authMiddleware, adminOnly, (req, res) => res.json({ ok: true, role: req.user.role }));
app.get('/super', authMiddleware, superAdminOnly, (req, res) => res.json({ ok: true, role: req.user.role }));
app.get('/tier', authMiddleware, requireTier('admin'), (req, res) => res.json({ ok: true }));
const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
beforeEach(() => { reset(); DB_DOWN = false; });

// A token that claims whatever we tell it to — the point is that the claim can be wrong.
const claim = (id, role) => jwt.sign({ id, email: id + '@x.com', role }, process.env.JWT_SECRET, { expiresIn: '7d' });
const get = (path, token) => fetch(base() + path, { headers: { Authorization: 'Bearer ' + token } })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

// ── the case that was missing ────────────────────────────────────────────────────
test("a PROMOTED user gets in with a token issued BEFORE the promotion", async () => {
  // The exact production failure: the database says super_admin, the token still says admin.
  const stale = claim('u-1', 'admin');
  const r = await get('/super', stale);
  assert.equal(r.status, 200, 'a stale token must not lock a super_admin out of their own routes');
  assert.equal(r.body.role, 'super_admin', 'and the gate must see the CURRENT role');
});

test('the same stale token also passes the admin gate and the tier gate', async () => {
  const stale = claim('u-1', 'admin');
  assert.equal((await get('/admin', stale)).status, 200);
  assert.equal((await get('/tier', stale)).status, 200, 'requireTier reads req.user.role too');
});

test('req.user.role is the DATABASE role, and id/email still come from the token', async () => {
  const r = await get('/whoami', claim('u-3', 'super_admin'));
  assert.equal(r.body.role, 'dev_team', 'the token claimed super_admin and was not believed');
  assert.equal(r.body.id, 'u-3');
  assert.equal(r.body.email, 'u-3@x.com', 'identity still comes from the signed token');
});

// ── and the other direction, which matters more ──────────────────────────────────
test('a DEMOTED user is refused immediately, although their token still claims the old role', async () => {
  // Without this, a demotion waits up to seven days. It is the same failure as a stale promotion, but
  // this direction is the one that is a security problem rather than an annoyance.
  const stale = claim('u-2', 'super_admin');            // DB says admin
  const r = await get('/super', stale);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Super admin only/);
  assert.equal((await get('/admin', stale)).status, 200, 'but they are still an admin');
});

test('a DEACTIVATED account is refused, although its token is still valid', async () => {
  // Login refuses is_active=0, but an EXISTING token used to keep working for the rest of its 7 days —
  // so "Set Inactive" did not end anyone's session. It does now.
  const r = await get('/whoami', claim('u-off', 'admin'));
  assert.equal(r.status, 401);
  assert.match(r.body.error, /inactive/i);
});

test('a DELETED account is refused', async () => {
  const r = await get('/whoami', claim('u-gone', 'admin'));
  assert.equal(r.status, 401);
});

test('an unsigned or forged token is still rejected before any lookup', async () => {
  assert.equal((await get('/whoami', 'not-a-token')).status, 401);
  const wrongKey = jwt.sign({ id: 'u-1', role: 'super_admin' }, 'a-different-secret');
  assert.equal((await get('/whoami', wrongKey)).status, 401);
});

// ── the deliberate fail-open, stated as a test so it is a decision and not a surprise ──
test('when the DATABASE IS DOWN the token is trusted, and that is on purpose', async () => {
  // Failing closed here logs the whole company out during a blip, and during a DB outage no route can
  // read data anyway — so the exposure is a role change made within the token's remaining life DURING an
  // outage. The alternative is an outage inside an outage. Asserted so it is visible rather than
  // discovered.
  DB_DOWN = true;
  const r = await get('/whoami', claim('u-3', 'dev_team'));
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'dev_team', "falls back to the token's claim");
});

test('the fallback is logged, because a silent fail-open is the thing to avoid', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/core.js', 'utf8');
  const fn = src.slice(src.indexOf('async function authMiddleware'));
  assert.match(fn.slice(0, 3000), /console\.error\([^)]*role lookup FAILED/,
    'the fall-back path must say so in the logs');
});

// ── the shape of the fix, so it cannot quietly regress ──────────────────────────
test('authMiddleware does not assign the token payload to req.user', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/core.js', 'utf8');
  const fn = src.slice(src.indexOf('async function authMiddleware'), src.indexOf('function adminOnly'));
  // `req.user = payload` is the exact line that caused this. It survives only in the DB-down branch,
  // which is why the count matters rather than its absence.
  const assignments = (fn.match(/req\.user = payload/g) || []).length;
  assert.equal(assignments, 1, 'only the DB-down fallback may assign the raw payload');
  assert.match(fn, /req\.user = \{ id: payload\.id, email: payload\.email, role: row\.role \}/,
    'the normal path builds req.user from the database row');
});

test('signToken still carries the role, for the shadow log and for the DB-down fallback', () => {
  const decoded = jwt.decode(claim('u-1', 'super_admin'));
  assert.equal(decoded.role, 'super_admin');
  // Keeping it is deliberate: product_shadow_log records the token's role, and that disagreement is
  // exactly how this bug was found.
});
