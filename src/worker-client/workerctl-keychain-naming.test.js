// ── DEFECT 5 — THE INSTALLER AND THE CLIENT MUST NAME THE SAME KEYCHAIN ITEM ─
//
// Found on the office iMac, 2026-11-17. `keychain.js` writes the secret as
//
//     -s ai.playnexa.worker   -a worker-secret:<wkr_id>
//
// and `installer/macos/workerctl` looked for it as
//
//     -s ai.playnexa.worker   -a ai.playnexa.worker:<wkr_id>
//
// A correct install therefore reported "there is NO Keychain secret for <id>. The worker will exit
// 2 on every launch" — while the worker was running normally with the secret correctly stored. An
// operator following that advice re-enrols, which spends a single-use token and changes nothing.
//
// ── WHY THIS IS A TEST AND NOT A SHARED CONSTANT ────────────────────────────
//
// One is bash, the other is JavaScript; there is no import that spans them. The next best thing is
// a test that FAILS when they drift, so the duplication cannot rot silently. It reads the shell
// script as text and compares what it would actually pass to `security` against the exported
// constant the writer uses.
//
// A unit test could not have caught the original defect — the installer is bash, and nothing
// executed it. That is exactly why this file exists.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const KEYCHAIN = require('./keychain');
const WORKERCTL = path.join(__dirname, '..', '..', 'installer', 'macos', 'workerctl');

const source = () => fs.readFileSync(WORKERCTL, 'utf8');

test('workerctl declares the account prefix the client actually writes', () => {
  const m = source().match(/^SECRET_ACCOUNT_PREFIX="([^"]+)"$/m);
  assert.ok(m, 'workerctl must declare SECRET_ACCOUNT_PREFIX once, at the top');
  assert.equal(m[1], KEYCHAIN.ACCOUNT_LABEL,
    `workerctl looks under "${m[1]}:" but keychain.js writes under `
    + `"${KEYCHAIN.ACCOUNT_LABEL}:" — a correctly enrolled worker would be reported as missing`);
});

test('workerctl declares the service the client actually writes', () => {
  const m = source().match(/^LABEL="([^"]+)"$/m);
  assert.ok(m, 'workerctl must declare LABEL once, at the top');
  assert.equal(m[1], KEYCHAIN.SERVICE,
    'the Keychain SERVICE must match between the installer and the client');
});

test('no Keychain lookup in workerctl uses the LABEL as the account prefix', () => {
  // The precise shape of the original defect. Anchored on `-a`, so a legitimate `-s "${LABEL}"`
  // is untouched while `-a "${LABEL}:..."` is refused.
  const offenders = source()
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /-a\s+"?\$\{LABEL\}:/.test(line));

  assert.deepEqual(offenders.map((o) => o.n), [],
    'the Keychain ACCOUNT is worker-secret:<id>, never the label: '
    + offenders.map((o) => `line ${o.n}: ${o.line.trim()}`).join(' | '));
});

test('every `security find-generic-password` in workerctl uses the prefix variable', () => {
  const lines = source().split('\n').filter((l) => l.includes('find-generic-password'));
  assert.ok(lines.length >= 2,
    'expected at least the install check and the doctor hint to perform a lookup');
  for (const l of lines) {
    assert.ok(l.includes('${SECRET_ACCOUNT_PREFIX}:'),
      `a lookup bypasses the declared prefix, so it can drift again: ${l.trim()}`);
  }
});

// ── ANTI-VACUITY ────────────────────────────────────────────────────────────
//
// Each assertion above is a claim about text. If the file were ever renamed, moved or emptied,
// `source()` would throw or the regexes would simply match nothing and some of these would pass
// for the wrong reason. This pins the fixture itself.

test('CONTROL: the fixture is the real installer and is non-trivial', () => {
  const s = source();
  assert.ok(s.length > 5_000, 'workerctl should be the real script, not a stub');
  assert.match(s, /cmd_enroll\(\)/, 'workerctl must still define cmd_enroll');
  assert.match(s, /cmd_install\(\)|cmd_doctor\(\)/, 'workerctl must still define its commands');
  assert.ok(KEYCHAIN.ACCOUNT_LABEL && KEYCHAIN.SERVICE,
    'keychain.js must export both names for these comparisons to mean anything');
  assert.notEqual(KEYCHAIN.ACCOUNT_LABEL, KEYCHAIN.SERVICE,
    'if these two were ever equal the comparisons above would pass vacuously');
});
