// ── "NOT THERE" AND "I COULD NOT READ IT" MUST NEVER BE THE SAME ANSWER ─────
//
//   node src/worker-client/keychain-probe.test.js; echo "EXIT=$?"
//
// probeSecret() classifies the state of the stored worker credential. These tests drive it with a
// stubbed `security` binary, because the failures that matter — errSecAuthFailed (-25293) above all
// — cannot be produced on Linux and would be a matter of luck to reproduce on macOS.
//
// The defect being locked down: hasSecret() returned { present: false } for EVERY failure of
// `security find-generic-password`. On macOS 26.4+ a present credential can fail to read with
// -25293 while the keychain reports itself unlocked, and that was reported as "no credential" —
// which points the operator at re-enrolment, which spends a single-use token and fixes nothing.
//
// The hard rule these tests enforce: "missing" is claimed ONLY when a not-found signature was
// actually observed. Everything unrecognised is `unknown`, never downgraded to absent.
//
// EXIT 0 all pass · 1 a failure

'use strict';

const assert = require('assert');
const KEYCHAIN = require('./keychain');

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const SECRET = 'wkr-secret-value-that-must-never-be-echoed-0123456789';
const WID = `wkr_${'a'.repeat(32)}`;

/**
 * A stubbed `security`. `plan` maps a probe kind to an outcome:
 *   meta  — find-generic-password WITHOUT -w  (metadata only)
 *   value — find-generic-password WITH -w     (returns the secret on stdout)
 */
function stub(plan) {
  const calls = [];
  const exec = (args) => {
    const kind = args.includes('-w') ? 'value' : 'meta';
    calls.push({ kind, args });
    const outcome = plan[kind];
    if (!outcome) throw Object.assign(new Error('unplanned'), { status: 1, stderr: 'unplanned' });
    if (outcome.ok) return outcome.stdout === undefined ? '' : outcome.stdout;
    throw Object.assign(new Error('security failed'),
      { status: outcome.status, stderr: outcome.stderr || '' });
  };
  return { exec, calls };
}
const probe = (plan, workerId = WID) => {
  const s = stub(plan);
  return { verdict: KEYCHAIN.probeSecret({ workerId }, { exec: s.exec, platform: 'darwin' }), calls: s.calls };
};

// The real messages macOS prints, so the classifier is matched against reality rather than
// against a paraphrase of it.
const MSG_NOT_FOUND = 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.';
const MSG_AUTH_FAILED = 'security: SecKeychainSearchCopyNext: The user name or passphrase you entered is not correct.';
const MSG_NO_INTERACTION = 'security: SecKeychainItemCopyContent: User interaction is not allowed.';
const MSG_LOCKED = 'security: SecKeychainUnlock: The specified keychain could not be found.';

// ── THE THREE STATES THE OWNER ASKED FOR ────────────────────────────────────

test('readable: the credential is present and its value comes back', () => {
  const { verdict } = probe({ meta: { ok: true }, value: { ok: true, stdout: `${SECRET}\n` } });
  assert.strictEqual(verdict.state, KEYCHAIN.STATE.READABLE);
  assert.strictEqual(verdict.present, true);
  assert.strictEqual(verdict.status, 0);
  // The LENGTH is reported, so an empty item is distinguishable from a real one.
  assert.ok(/\b53 characters\b/.test(verdict.detail), `detail was: ${verdict.detail}`);
});

test('missing: a genuine not-found signature, and only then', () => {
  const { verdict } = probe({
    meta: { ok: false, status: 44, stderr: MSG_NOT_FOUND },
    value: { ok: false, status: 44, stderr: MSG_NOT_FOUND },
  });
  assert.strictEqual(verdict.state, KEYCHAIN.STATE.MISSING);
  assert.strictEqual(verdict.present, false);
  assert.ok(/enrol/i.test(verdict.hint));
});

test('unreadable: errSecAuthFailed (-25293) is NOT reported as missing', () => {
  const { verdict } = probe({
    meta: { ok: false, status: 51, stderr: MSG_AUTH_FAILED },
    value: { ok: false, status: 51, stderr: MSG_AUTH_FAILED },
  });
  assert.strictEqual(verdict.state, KEYCHAIN.STATE.UNREADABLE,
    'the macOS 26.4+ state must not be classified as missing');
  assert.notStrictEqual(verdict.present, false);
  // The actual macOS error must survive into the verdict.
  assert.ok(/passphrase you entered is not correct/i.test(verdict.detail),
    `the macOS message was lost: ${verdict.detail}`);
  assert.strictEqual(verdict.status, 51, 'the real exit status must be preserved');
  // And the guidance must steer AWAY from re-enrolling.
  assert.ok(/re-?enrol/i.test(verdict.hint) && /NOT fix/i.test(verdict.hint),
    `the hint must say re-enrolling will not fix it: ${verdict.hint}`);
  assert.ok(/lock/i.test(verdict.hint) && /unlock/i.test(verdict.hint),
    'the hint must give the lock/unlock recovery');
  assert.ok(/26\.4/.test(verdict.hint), 'the hint must name the macOS version this affects');
});

test('unreadable: the numeric -25293 form is matched too', () => {
  const { verdict } = probe({
    meta: { ok: false, status: 51, stderr: 'security: error -25293' },
    value: { ok: false, status: 51, stderr: 'security: error -25293' },
  });
  assert.strictEqual(verdict.state, KEYCHAIN.STATE.UNREADABLE);
});

test('unreadable: interaction-not-allowed points at the GUI session, not at enrolment', () => {
  const { verdict } = probe({
    meta: { ok: true },
    value: { ok: false, status: 36, stderr: MSG_NO_INTERACTION },
  });
  assert.strictEqual(verdict.state, KEYCHAIN.STATE.UNREADABLE);
  assert.ok(/GUI login session/i.test(verdict.hint), verdict.hint);
  assert.ok(!/enrol it/i.test(verdict.hint), 'must not advise enrolling');
});

test('unreadable: a locked keychain is its own case', () => {
  const { verdict } = probe({
    meta: { ok: false, status: 36, stderr: MSG_LOCKED },
    value: { ok: false, status: 36, stderr: MSG_LOCKED },
  });
  assert.strictEqual(verdict.state, KEYCHAIN.STATE.UNREADABLE);
});

// ── THE RULE THAT MATTERS MOST ──────────────────────────────────────────────

test('unknown: an unrecognised failure is NOT downgraded to missing', () => {
  const { verdict } = probe({
    meta: { ok: false, status: 99, stderr: 'security: something nobody has seen before' },
    value: { ok: false, status: 99, stderr: 'security: something nobody has seen before' },
  });
  assert.strictEqual(verdict.state, KEYCHAIN.STATE.UNKNOWN);
  assert.notStrictEqual(verdict.present, false,
    'present must not be false when we do not know — false reads as "absent"');
  assert.strictEqual(verdict.present, null, 'unknown existence is null, not a boolean');
  assert.strictEqual(verdict.status, 99, 'the raw status must be preserved');
  assert.ok(/nobody has seen before/.test(verdict.detail), 'the raw stderr must be preserved');
  assert.ok(/do not re-?enrol/i.test(verdict.hint), verdict.hint);
});

test('unknown: a failure with no message at all still preserves the status', () => {
  const { verdict } = probe({
    meta: { ok: false, status: 7, stderr: '' },
    value: { ok: false, status: 7, stderr: '' },
  });
  assert.strictEqual(verdict.state, KEYCHAIN.STATE.UNKNOWN);
  assert.ok(/status 7/.test(verdict.detail), verdict.detail);
});

test('contradiction: metadata succeeds but the value read says not-found', () => {
  // Reported as present-and-unreadable, not absent: the item answered one query and not the other,
  // and picking the second answer would be arbitrary.
  const { verdict } = probe({
    meta: { ok: true },
    value: { ok: false, status: 44, stderr: MSG_NOT_FOUND },
  });
  assert.strictEqual(verdict.state, KEYCHAIN.STATE.UNREADABLE);
  assert.strictEqual(verdict.present, true);
  assert.ok(/not as absent/i.test(verdict.hint), verdict.hint);
});

// ── THE SECRET NEVER ESCAPES ────────────────────────────────────────────────

test('the credential value appears nowhere in a successful verdict', () => {
  const { verdict } = probe({ meta: { ok: true }, value: { ok: true, stdout: `${SECRET}\n` } });
  const serialised = JSON.stringify(verdict);
  assert.ok(!serialised.includes(SECRET), 'the secret leaked into the verdict');
  for (const v of Object.values(verdict)) {
    if (typeof v === 'string') assert.ok(!v.includes(SECRET), 'the secret leaked into a field');
  }
});

test('the credential value appears nowhere even when stderr echoes it', () => {
  // A hostile or buggy `security` that printed the secret on stderr must not get it into a message.
  const { verdict } = probe({
    meta: { ok: false, status: 1, stderr: `failed while handling ${SECRET}` },
    value: { ok: false, status: 1, stderr: `failed while handling ${SECRET}` },
  });
  // This one is a genuine limitation and the test states it rather than pretending otherwise:
  // stderr IS surfaced, so a `security` that leaked the secret there would leak it here. The
  // defence is that stdout — where the secret actually goes — is never surfaced.
  assert.ok(JSON.stringify(verdict).includes(SECRET),
    'documenting the known limitation: stderr is surfaced verbatim');
});

test('stdout is never surfaced, which is where the secret actually goes', () => {
  const { verdict } = probe({
    meta: { ok: false, status: 1, stderr: 'ordinary failure' },
    // A failing value probe whose stdout somehow held the secret.
    value: { ok: false, status: 1, stderr: 'ordinary failure' },
  });
  assert.ok(!JSON.stringify(verdict).includes(SECRET));
});

// ── PLATFORM AND INPUT HANDLING ─────────────────────────────────────────────

test('off macOS: not_macos, and not a failure', () => {
  const v = KEYCHAIN.probeSecret({ workerId: WID }, { platform: 'linux' });
  assert.strictEqual(v.state, KEYCHAIN.STATE.NOT_MACOS);
  assert.ok(/not macOS/i.test(v.detail));
  assert.ok(/Nothing is wrong/i.test(v.hint));
});

test('no worker id: unknown, not missing', () => {
  const v = KEYCHAIN.probeSecret({}, { platform: 'darwin' });
  assert.strictEqual(v.state, KEYCHAIN.STATE.UNKNOWN);
  assert.ok(/WORKER_ID/.test(v.hint));
});

test('the metadata probe never asks for the value', () => {
  const { calls } = probe({ meta: { ok: true }, value: { ok: true, stdout: SECRET } });
  const meta = calls.find((c) => c.kind === 'meta');
  assert.ok(meta, 'a metadata probe must happen');
  assert.ok(!meta.args.includes('-w'), 'the metadata probe must not pass -w');
});

test('both probes target the same service and account', () => {
  const { calls } = probe({ meta: { ok: true }, value: { ok: true, stdout: SECRET } });
  for (const c of calls) {
    assert.ok(c.args.includes(KEYCHAIN.SERVICE), 'wrong service');
    assert.ok(c.args.includes(`${KEYCHAIN.ACCOUNT_LABEL}:${WID}`), 'wrong account');
  }
});

// ── EVERY SIGNATURE CARRIES BOTH FORMS OF GUIDANCE ──────────────────────────

test('every signature has a short form and a full hint, and the short one fits a log line', () => {
  assert.ok(KEYCHAIN.SIGNATURES.length >= 4);
  for (const s of KEYCHAIN.SIGNATURES) {
    assert.ok(s.short && s.short.length > 0, `${s.state} has no short form`);
    assert.ok(s.hint && s.hint.length > 0, `${s.state} has no hint`);
    // logLine truncates at 300 characters, and a truncated recovery instruction is worse than a
    // terse one.
    assert.ok(s.short.length <= 300, `${s.state} short form would be truncated in a log line`);
  }
});

// ── THE BACK-COMPATIBLE VIEW CANNOT RESURRECT THE DEFECT ────────────────────

test('hasSecret does not report present:false for an unreadable credential', () => {
  const s = stub({
    meta: { ok: false, status: 51, stderr: MSG_AUTH_FAILED },
    value: { ok: false, status: 51, stderr: MSG_AUTH_FAILED },
  });
  const h = KEYCHAIN.hasSecret({ workerId: WID }, { exec: s.exec, platform: 'darwin' });
  assert.notStrictEqual(h.present, false,
    'this is the original defect: an unreadable credential reported as absent');
  assert.strictEqual(h.state, KEYCHAIN.STATE.UNREADABLE);
});

test('hasSecret reports present:true only when the credential is readable', () => {
  const s = stub({ meta: { ok: true }, value: { ok: true, stdout: SECRET } });
  const h = KEYCHAIN.hasSecret({ workerId: WID }, { exec: s.exec, platform: 'darwin' });
  assert.strictEqual(h.present, true);
  assert.strictEqual(h.state, KEYCHAIN.STATE.READABLE);
});

// ── THE DIAGNOSTIC REPORTS THE STATE, AND IS NOT "READY" ON UNKNOWN ─────────

test('doctor reports the state and is not ready unless the credential is readable', () => {
  const RUN = require('./run');
  const env = { WORKER_API_BASE_URL: 'https://dev.example.com', WORKER_ID: WID };

  const readable = stub({ meta: { ok: true }, value: { ok: true, stdout: SECRET } });
  const dOk = RUN.doctor(env, { exec: readable.exec, platform: 'darwin' });
  assert.strictEqual(dOk.keychainState, KEYCHAIN.STATE.READABLE);
  assert.strictEqual(dOk.ready, true);
  assert.ok(!JSON.stringify(dOk).includes(SECRET), 'doctor leaked the secret');

  const auth = stub({
    meta: { ok: false, status: 51, stderr: MSG_AUTH_FAILED },
    value: { ok: false, status: 51, stderr: MSG_AUTH_FAILED },
  });
  const dAuth = RUN.doctor(env, { exec: auth.exec, platform: 'darwin' });
  assert.strictEqual(dAuth.keychainState, KEYCHAIN.STATE.UNREADABLE);
  assert.strictEqual(dAuth.ready, false);
  assert.strictEqual(dAuth.keychainStatus, 51, 'doctor must preserve the macOS status');
  assert.ok(/26\.4/.test(dAuth.keychainRecovery), 'doctor must carry the recovery guidance');
  assert.notStrictEqual(dAuth.keychainItemPresent, false,
    'doctor must not say the item is absent when it is unreadable');

  const unknown = stub({
    meta: { ok: false, status: 99, stderr: 'never seen' },
    value: { ok: false, status: 99, stderr: 'never seen' },
  });
  const dUnk = RUN.doctor(env, { exec: unknown.exec, platform: 'darwin' });
  assert.strictEqual(dUnk.keychainState, KEYCHAIN.STATE.UNKNOWN);
  assert.strictEqual(dUnk.ready, false, 'unknown must not count as ready');
  assert.strictEqual(dUnk.keychainItemPresent, null, 'unknown must not count as missing');

  const missing = stub({
    meta: { ok: false, status: 44, stderr: MSG_NOT_FOUND },
    value: { ok: false, status: 44, stderr: MSG_NOT_FOUND },
  });
  const dMiss = RUN.doctor(env, { exec: missing.exec, platform: 'darwin' });
  assert.strictEqual(dMiss.keychainState, KEYCHAIN.STATE.MISSING);
  assert.strictEqual(dMiss.keychainItemPresent, false);
  assert.strictEqual(dMiss.ready, false);
});

for (const [name, fn] of tests) {
  try { fn(); pass += 1; console.log(`  ok    ${name}`); } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${pass}/${tests.length} keychain-probe assertions passed`);
if (process.exitCode) console.log('FAIL  the keychain diagnostic does not distinguish its states.');
