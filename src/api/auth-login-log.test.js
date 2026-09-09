// Login-logging tests — run with:  node --test src/api/auth-login-log.test.js
// Asserts the branch a failure took is actually recorded, that the RESPONSE stays uniform
// (no user-enumeration oracle), and that the password never reaches the log.

process.env.JWT_SECRET = 'test-secret';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');

const HASH = bcrypt.hashSync('correct-horse', 10);
const USERS = [
  { id: 'u1', email: 'active@x.com',  name: 'A', role: 'admin', is_active: 1, password_hash: HASH },
  { id: 'u2', email: 'nohash@x.com',  name: 'B', role: 'admin', is_active: 1, password_hash: null },
];

const db = require('../lib/db');
db.query = async (sql, params = []) => {
  if (/UPDATE users SET last_login/i.test(sql)) return { rows: [] };
  if (/FROM users WHERE email=\$1 AND is_active=1/i.test(sql)) {
    return { rows: USERS.filter(u => u.email === params[0]) };
  }
  return { rows: [] };
};

const routes = require('./routes');
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api', routes);

let server, base;
async function boot() {
  if (base) return base;
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}

// The login route is rate-limited to 10 attempts per minute PER IP, and this file makes more
// calls than that. Each request therefore presents its own X-Forwarded-For so it lands in its
// own bucket — the app sets `trust proxy`, so req.ip follows the header. This keeps the limiter
// in the production path exactly as it ships; the alternative was exporting its internal store
// purely so a test could reach in and clear it.
let ipSeq = 0;
const nextIp = () => `10.${(++ipSeq >> 8) & 255}.${ipSeq & 255}.1`;

/** Capture console.warn/log/error for one request. */
async function loginCapturing(body) {
  const b = await boot();
  const lines = [];
  const warn = console.warn, log = console.log, err = console.error;
  console.warn = (...a) => lines.push(a.join(' '));
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const res = await fetch(b + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json(), lines };
  } finally { console.warn = warn; console.log = log; console.error = err; }
}

test('the rate limiter still bites when the SAME ip retries — the per-test ip is a test device, not a hole', async () => {
  const b = await boot();
  const ip = '203.0.113.99';
  const hit = () => fetch(b + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ email: 'active@x.com', password: 'wrong' }),
  }).then(r => r.status);
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push(await hit());
  assert.ok(codes.includes(429), `expected a 429 within 12 attempts, got ${codes.join(',')}`);
});

test('no such active user is logged as no_active_user', async () => {
  const r = await loginCapturing({ email: 'ghost@x.com', password: 'whatever' });
  assert.equal(r.status, 401);
  assert.ok(r.lines.some(l => /\[auth\] login FAILED \(no_active_user\)/.test(l)), r.lines.join('|'));
  assert.ok(r.lines.some(l => /email=ghost@x\.com/.test(l)));
});

test('a user with no password set is a DIFFERENT branch from a wrong password', async () => {
  const nohash = await loginCapturing({ email: 'nohash@x.com', password: 'whatever' });
  assert.ok(nohash.lines.some(l => /\(no_password_set\)/.test(l)), nohash.lines.join('|'));

  const wrong = await loginCapturing({ email: 'active@x.com', password: 'wrong-password' });
  assert.ok(wrong.lines.some(l => /\(password_mismatch\)/.test(l)), wrong.lines.join('|'));
});

test('a missing field is logged too, and answered 400', async () => {
  const r = await loginCapturing({ email: 'active@x.com' });
  assert.equal(r.status, 400);
  assert.ok(r.lines.some(l => /\(missing_field\)/.test(l)));
});

test('the RESPONSE never reveals which branch failed — no enumeration oracle', async () => {
  const ghost = await loginCapturing({ email: 'ghost@x.com', password: 'whatever' });
  const nohash = await loginCapturing({ email: 'nohash@x.com', password: 'whatever' });
  const wrong = await loginCapturing({ email: 'active@x.com', password: 'wrong-password' });
  for (const r of [ghost, nohash, wrong]) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: 'Invalid credentials' });
  }
});

test('the password is NEVER written to the log', async () => {
  const secret = 'sup3r-s3cret-pw-do-not-log';
  const r = await loginCapturing({ email: 'active@x.com', password: secret });
  assert.equal(r.status, 401);
  assert.ok(r.lines.length > 0, 'expected at least one log line');
  for (const l of r.lines) assert.ok(!l.includes(secret), `password leaked into log: ${l}`);
});

// ── the trailing-newline bug ────────────────────────────────────────────────
// A temporary password handed over in a text file carries the file's trailing newline. The
// paste brings it along, bcrypt sees a string one character longer than the one that was
// hashed, and the failure is logged as password_mismatch — indistinguishable from simply
// typing the wrong password. This cost a real outage; these pin the fix.

test('a password with a trailing newline authenticates', async () => {
  const r = await loginCapturing({ email: 'active@x.com', password: 'correct-horse\n' });
  assert.equal(r.status, 200, 'trailing newline must not defeat login');
  assert.ok(r.body.token);
});

test('trailing and leading whitespace of every shape is tolerated', async () => {
  for (const pw of ['correct-horse ', ' correct-horse', 'correct-horse\r\n', '  correct-horse\t\n']) {
    const r = await loginCapturing({ email: 'active@x.com', password: pw });
    assert.equal(r.status, 200, `should authenticate: ${JSON.stringify(pw)}`);
  }
});

test('trimming does NOT make a genuinely wrong password work', async () => {
  // The guard against over-reading the fix: only edge whitespace is forgiven. Interior
  // characters, case and any other difference must still fail.
  for (const pw of ['correct horse', 'Correct-Horse', 'correct-hors', 'correct-horse!']) {
    const r = await loginCapturing({ email: 'active@x.com', password: pw });
    assert.equal(r.status, 401, `must NOT authenticate: ${JSON.stringify(pw)}`);
    assert.ok(r.lines.some(l => /\(password_mismatch\)/.test(l)));
  }
});

test('a whitespace-only password is rejected, not trimmed into an empty match', async () => {
  const r = await loginCapturing({ email: 'active@x.com', password: '   \n' });
  assert.equal(r.status, 401);
});

test('a successful login is logged with role, and returns a token', async () => {
  const r = await loginCapturing({ email: 'active@x.com', password: 'correct-horse' });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  assert.ok(r.lines.some(l => /\[auth\] login ok email=active@x\.com role=admin/.test(l)), r.lines.join('|'));
  for (const l of r.lines) assert.ok(!l.includes('correct-horse'));
  server.close();
});
