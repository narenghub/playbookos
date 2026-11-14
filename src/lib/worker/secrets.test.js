// ── SEALING: THE THREE THINGS THAT MUST BE TRUE ──────────────────────────────
//
// 1. A sealed secret round-trips.
// 2. A TAMPERED sealed secret throws rather than returning plausible bytes. This is why GCM and
//    not CBC: a verifier handed quietly-corrupted key material would compute a wrong signature and
//    report "bad signature", sending the next person to debug the worker instead of the database.
// 3. With no sealing key, nothing works at all — rather than falling back to plaintext, which is
//    how a development shortcut becomes the production shape.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const SECRETS = require('./secrets');

const ENV = { WORKER_SECRET_SEAL_KEY: '1a'.repeat(32) };
const OTHER = { WORKER_SECRET_SEAL_KEY: '2b'.repeat(32) };

test('1. a sealed secret round-trips, and the ciphertext is not the plaintext', () => {
  const secret = SECRETS.newSecret();
  const sealed = SECRETS.seal(secret, ENV);

  assert.strictEqual(SECRETS.open(sealed, ENV), secret);
  assert.ok(!sealed.includes(secret), 'the plaintext secret appears in the sealed value');
  assert.match(sealed, /^v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);

  // Sealing the same secret twice must differ — a fresh IV each time, so the stored value does not
  // leak that two workers share a secret (they never should, but the storage must not reveal it).
  assert.notStrictEqual(SECRETS.seal(secret, ENV), SECRETS.seal(secret, ENV));
});

test('2. tampering is detected, not absorbed', () => {
  const secret = SECRETS.newSecret();
  const sealed = SECRETS.seal(secret, ENV);
  const [v, iv, tag, ct] = sealed.split(':');

  const flip = (hex) => {
    const b = Buffer.from(hex, 'hex');
    b[0] ^= 0xff;
    return b.toString('hex');
  };

  for (const [what, bad] of [
    ['ciphertext', [v, iv, tag, flip(ct)].join(':')],
    ['auth tag', [v, iv, flip(tag), ct].join(':')],
    ['iv', [v, flip(iv), tag, ct].join(':')],
    ['version', ['v2', iv, tag, ct].join(':')],
    ['shape', 'not-even-close'],
    ['empty', ''],
    ['null', null],
  ]) {
    assert.throws(() => SECRETS.open(bad, ENV), `a tampered ${what} did not throw`);
  }

  // A different key is also a failure, not a different answer.
  assert.throws(() => SECRETS.open(sealed, OTHER), /unable to authenticate|unsupported|bad decrypt/i);
});

test('3. a missing or malformed sealing key fails closed and says which variable', () => {
  assert.throws(() => SECRETS.seal('x', {}), /WORKER_SECRET_SEAL_KEY is not set/);
  assert.throws(() => SECRETS.open('v1:00:00:00', {}), /WORKER_SECRET_SEAL_KEY is not set/);

  for (const wrong of ['abc', 'f'.repeat(63), 'f'.repeat(65), 'z'.repeat(64)]) {
    assert.throws(() => SECRETS.seal('x', { WORKER_SECRET_SEAL_KEY: wrong }),
      /64 hex characters/, `'${wrong.slice(0, 8)}…' was accepted as a sealing key`);
  }
});

test('4. secrets and enrollment tokens are full-entropy and distinct', () => {
  const secrets = new Set(Array.from({ length: 300 }, () => SECRETS.newSecret()));
  assert.strictEqual(secrets.size, 300, 'worker secrets collided');
  for (const s of secrets) assert.match(s, /^[0-9a-f]{64}$/);

  const tokens = new Set(Array.from({ length: 300 }, () => SECRETS.newEnrollmentToken()));
  assert.strictEqual(tokens.size, 300, 'enrollment tokens collided');
  for (const t of tokens) assert.match(t, /^wet_[0-9a-f]{64}$/);

  // The digest is deterministic (so a lookup works) and one-way (so a database read cannot enrol).
  const t = SECRETS.newEnrollmentToken();
  assert.strictEqual(SECRETS.digestOfToken(t), SECRETS.digestOfToken(t));
  assert.notStrictEqual(SECRETS.digestOfToken(t), t);
  assert.ok(!SECRETS.digestOfToken(t).includes(t.slice(4)));
});
