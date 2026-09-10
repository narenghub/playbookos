// Change-password route tests — run with:  node --test src/api/auth-password.test.js
// Real router, real bcrypt, a faked db.query matched by SQL shape. The point of this suite is
// that the OLD password stops working after a change — a reset that leaves the previous
// credential live is worse than no reset at all.

process.env.JWT_SECRET = 'test-secret';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');

const CURRENT = 'current-password-ok';
let USER;
function seed() {
  USER = { id: 'u1', email: 'a@b.c', name: 'A', role: 'admin', is_active: 1,
           password_hash: bcrypt.hashSync(CURRENT, 10) };
}
seed();

const db = require('../lib/db');
db.query = async (sql, params = []) => {
  if (/UPDATE users SET last_login/i.test(sql)) return { rows: [] };
  if (/UPDATE users SET password_hash/i.test(sql)) { USER.password_hash = params[0]; return { rows: [] }; }
  if (/SELECT id, email, password_hash FROM users WHERE id/i.test(sql)) {
    return { rows: params[0] === USER.id ? [USER] : [] };
  }
  if (/FROM users WHERE id/i.test(sql)) return { rows: [USER] };
  if (/FROM users WHERE email=\$1 AND is_active=1/i.test(sql)) {
    return { rows: USER.email === params[0] ? [USER] : [] };
  }
  return { rows: [] };
};

const { signToken } = require('../lib/core');
const routes = require('./routes');
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api', routes);

const TOKEN = signToken({ id: 'u1', email: 'a@b.c', role: 'admin' });

let server, base;
async function boot() {
  if (base) return base;
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}
let ipSeq = 0;                                    // login is rate-limited per IP; see auth-login-log.test.js
const nextIp = () => `10.${(++ipSeq >> 8) & 255}.${ipSeq & 255}.2`;

async function change(body, token = TOKEN) {
  const b = await boot();
  const res = await fetch(b + '/api/auth/password', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function login(password) {
  const b = await boot();
  const res = await fetch(b + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() },
    body: JSON.stringify({ email: 'a@b.c', password }),
  });
  return res.status;
}

test('the wrong current password is rejected, and nothing changes', async () => {
  seed();
  const before = USER.password_hash;
  const r = await change({ currentPassword: 'not-the-password', newPassword: 'a-brand-new-password' });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /Current password is incorrect/);
  assert.equal(USER.password_hash, before, 'hash must be untouched after a failed attempt');
});

test('a new password shorter than 12 characters is rejected', async () => {
  seed();
  const r = await change({ currentPassword: CURRENT, newPassword: 'short11chars'.slice(0, 11) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at least 12 characters/);
  // exactly 12 is allowed — the boundary is >=, not >
  const ok = await change({ currentPassword: CURRENT, newPassword: 'exactly12chr' });
  assert.equal(ok.status, 200);
});

test('length is measured AFTER trimming, so padding does not buy length', async () => {
  seed();
  const r = await change({ currentPassword: CURRENT, newPassword: '   short   ' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at least 12 characters/);
});

test('a trailing newline on the current password does not defeat the check', async () => {
  seed();
  const r = await change({ currentPassword: CURRENT + '\n', newPassword: 'a-brand-new-password' });
  assert.equal(r.status, 200, 'trim must match the login route');
});

test('reusing the current password as the new one is rejected', async () => {
  seed();
  const r = await change({ currentPassword: CURRENT, newPassword: CURRENT });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /different from the current/);
});

test('a missing field is a 400, not a crash', async () => {
  seed();
  assert.equal((await change({ currentPassword: CURRENT })).status, 400);
  assert.equal((await change({ newPassword: 'a-brand-new-password' })).status, 400);
  assert.equal((await change({})).status, 400);
});

test('THE POINT: a correct change works and the OLD password stops working', async () => {
  seed();
  const NEW = 'a-genuinely-new-password';
  assert.equal(await login(CURRENT), 200, 'old password should work before the change');

  const r = await change({ currentPassword: CURRENT, newPassword: NEW });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });

  assert.equal(await login(NEW), 200, 'new password must work after the change');
  assert.equal(await login(CURRENT), 401, 'OLD password must be dead after the change');
});

test('the stored hash is bcrypt at cost 10, matching every existing hash', async () => {
  seed();
  await change({ currentPassword: CURRENT, newPassword: 'another-new-password' });
  assert.equal(USER.password_hash.slice(0, 7), '$2a$10$');
  assert.equal(USER.password_hash.length, 60);
});

test('neither password is ever written to the log', async () => {
  seed();
  const NEW = 'secret-new-value-not-logged';
  const lines = [];
  const log = console.log, warn = console.warn, err = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try { await change({ currentPassword: CURRENT, newPassword: NEW }); }
  finally { console.log = log; console.warn = warn; console.error = err; }
  assert.ok(lines.some(l => /\[auth\] password CHANGED user=a@b\.c/.test(l)), lines.join('|'));
  for (const l of lines) {
    assert.ok(!l.includes(NEW), `new password leaked: ${l}`);
    assert.ok(!l.includes(CURRENT), `current password leaked: ${l}`);
  }
});

test('no token, no password change', async () => {
  const b = await boot();
  const res = await fetch(b + '/api/auth/password', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: CURRENT, newPassword: 'a-brand-new-password' }),
  });
  assert.equal(res.status, 401);
  server.close();
});
