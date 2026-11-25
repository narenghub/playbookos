// ── A WEAKER CREDENTIAL PATH MUST NOT BE REACHABLE WHERE THE STRONGER ONE IS ─
//
//   node --test src/worker-client/secret-source.test.js
//
// B4.2 needs a worker in a Linux container, where there is no Keychain. keychain.js refuses
// non-macOS deliberately and says why: a secret must not arrive through ambient deployment
// configuration. This module reads an environment variable, which is exactly the thing that rule
// guards against — so the tests that matter are the ones proving it cannot happen by accident.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const S = require('./secret-source');

const ID = `wkr_${'a'.repeat(32)}`;
const DEV = { PLAYNEXA_WORKER_ENV: 'development', PLAYNEXA_DEV_WORKER_SECRET: 'dev-secret-value' };

const keychainReadable = {
  STATE: { READABLE: 'READABLE' },
  probeSecret: () => ({ state: 'READABLE' }),
  readSecret: () => 'keychain-secret-value',
};
const keychainMissing = {
  STATE: { READABLE: 'READABLE' },
  probeSecret: () => ({ state: 'ABSENT' }),
  readSecret: () => { throw new Error('should not be called'); },
};

// ═══ 1. macOS USES THE KEYCHAIN AND CANNOT FALL BACK ═══════════════════════

test('1. on macOS the Keychain is the source', () => {
  const r = S.resolveSecretSource({ workerId: ID },
    { platform: 'darwin', env: {}, keychain: keychainReadable });
  assert.strictEqual(r.usable, true);
  assert.strictEqual(r.source, S.SOURCE.KEYCHAIN);
  assert.strictEqual(r.read(), 'keychain-secret-value');
});

test('1a. DECISIVE: on macOS the development variable is IGNORED, even when set', () => {
  // The weaker path must not be reachable where the stronger one exists. If a developer sets the
  // variable on their laptop it changes nothing — otherwise a Mac could silently authenticate from
  // ambient configuration, which is the accident keychain.js's rule exists to prevent.
  const r = S.resolveSecretSource({ workerId: ID },
    { platform: 'darwin', env: DEV, keychain: keychainMissing });
  assert.strictEqual(r.usable, false);
  assert.strictEqual(r.source, S.SOURCE.KEYCHAIN);
  assert.match(r.reason, /deliberately ignored/);
  assert.strictEqual(r.read, undefined, 'a refusal must not carry a reader');
});

// ═══ 2. THE CONTAINER PATH, AND THE FOUR CONDITIONS ════════════════════════

test('2. on Linux, with all four conditions, the development variable is the source', () => {
  const r = S.resolveSecretSource({ workerId: ID }, { platform: 'linux', env: DEV });
  assert.strictEqual(r.usable, true);
  assert.strictEqual(r.source, S.SOURCE.DEV_ENV);
  assert.strictEqual(r.read(), 'dev-secret-value');
});

test('2a. DECISIVE: a production environment is REFUSED', () => {
  // The condition that keeps a development credential path out of production. Asserted rather than
  // described, because the module's header claims it.
  for (const value of ['production', 'prod', 'staging', '', undefined]) {
    const env = { ...DEV, PLAYNEXA_WORKER_ENV: value };
    const r = S.resolveSecretSource({ workerId: ID }, { platform: 'linux', env });
    assert.strictEqual(r.usable, false, `${JSON.stringify(value)} was accepted as development`);
    assert.strictEqual(r.read, undefined);
  }
});

test('2b. the variable is NOT named WORKER_SECRET — a generic name invites an accident', () => {
  const r = S.resolveSecretSource({ workerId: ID }, {
    platform: 'linux',
    env: { PLAYNEXA_WORKER_ENV: 'development', WORKER_SECRET: 'something-from-another-tool' },
  });
  assert.strictEqual(r.usable, false);
  assert.match(r.reason, /deliberately NOT named WORKER_SECRET/);
  assert.strictEqual(S.DEV_SECRET_VAR, 'PLAYNEXA_DEV_WORKER_SECRET');
});

test('2c. a blank or whitespace secret is not a secret', () => {
  for (const v of ['', '   ', undefined]) {
    const r = S.resolveSecretSource({ workerId: ID },
      { platform: 'linux', env: { ...DEV, PLAYNEXA_DEV_WORKER_SECRET: v } });
    assert.strictEqual(r.usable, false);
  }
});

test('2d. a malformed WORKER_ID refuses before any source is consulted', () => {
  // A half-configured service must not attempt to authenticate as nothing.
  for (const id of [undefined, '', 'wkr_short', 'not-an-id', `wkr_${'z'.repeat(32)}`]) {
    const r = S.resolveSecretSource({ workerId: id }, { platform: 'linux', env: DEV });
    assert.strictEqual(r.usable, false, `${id} was accepted as a worker id`);
    assert.strictEqual(r.source, S.SOURCE.NONE);
  }
});

// ═══ 3. THE SECRET NEVER LEAKS THROUGH THE DESCRIPTION ═════════════════════

test('3. describeSecretSource carries no part of the secret', () => {
  // doctor() prints this. A credential in a readiness report is a credential in a log file.
  const d = S.describeSecretSource({ workerId: ID }, { platform: 'linux', env: DEV });
  const text = JSON.stringify(d);
  assert.doesNotMatch(text, /dev-secret-value/);
  assert.strictEqual(d.usable, true);
  assert.ok(d.source && d.reason);
  assert.strictEqual(d.read, undefined, 'the description must not carry a reader either');
});

test('3a. the resolved source holds no secret value as a property', () => {
  // `read` is a function on purpose: nothing holds the credential until it is needed, and a caller
  // that logs the object cannot log the secret.
  const r = S.resolveSecretSource({ workerId: ID }, { platform: 'linux', env: DEV });
  const shallow = JSON.stringify(r);
  assert.doesNotMatch(shallow, /dev-secret-value/);
  assert.strictEqual(typeof r.read, 'function');
});

// ═══ 4. THE FINGERPRINT PATH (owner's Priority 1, 2026-11-25) ══════════════

test('4. a fingerprint identifies the credential and reconstructs none of it', () => {
  // The owner forbids secrets in transcripts, logs, documentation or chat — and the enrolment
  // procedure I first wrote had the operator read the secret off their terminal and paste it
  // onward, making the human the transport. A fingerprint is what replaces that: it lets them
  // confirm the paste landed without ever seeing what they pasted.
  const crypto = require('node:crypto');
  const secret = 'a-32-byte-random-value-stand-in';
  const fp = crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12);

  assert.strictEqual(fp.length, 12, 'twelve hex characters');
  assert.doesNotMatch(fp, /a-32-byte/, 'the fingerprint must not contain the value');
  // Two different secrets must not share a fingerprint in any practical sense.
  const other = crypto.createHash('sha256').update(`${secret}x`).digest('hex').slice(0, 12);
  assert.notStrictEqual(fp, other);
});

test('4a. doctor() reports the fingerprint and never the secret', () => {
  // Asserted on the real doctor output rather than on the idea of it.
  const { execFileSync } = require('node:child_process');
  const env = {
    PATH: process.env.PATH,
    PLAYNEXA_WORKER_ENV: 'development',
    PLAYNEXA_DEV_WORKER_SECRET: 'UNIQUE-SENTINEL-VALUE-9f3a',
    WORKER_ID: `wkr_${'b'.repeat(32)}`,
    WORKER_API_BASE_URL: 'https://example.invalid',
  };
  // `--doctor` exits NON-ZERO when the worker is not operationally ready, which it is not here —
  // there is no server at example.invalid. That is correct behaviour and not a crash, so the
  // output has to be read either way. My first version let execFileSync throw on it and reported
  // "doctor crashed" for a doctor doing its job.
  let out;
  try {
    out = execFileSync(process.execPath, [require.resolve('./run.js'), '--doctor'],
      { env, encoding: 'utf8' });
  } catch (e) {
    out = String(e.stdout || '');
    assert.ok(out.length, `--doctor produced no stdout: ${String(e.stderr || '').slice(0, 300)}`);
  }
  assert.doesNotMatch(out, /UNIQUE-SENTINEL-VALUE-9f3a/,
    'the credential appeared in the readiness report, which is a credential in a log file');
  assert.match(out, /"credentialFingerprint": "sha256:[0-9a-f]{12}"/,
    'no fingerprint was reported, so an operator cannot confirm the paste without seeing the value');
});
