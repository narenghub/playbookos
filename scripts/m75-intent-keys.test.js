// ── PER-RUN INTENT KEYS ─────────────────────────────────────────────────────
//
//   node --test scripts/m75-intent-keys.test.js
//
// The property: two acceptance invocations can never share an intent key, so one run's ABANDONED
// residue can never become another run's predecessor. Within a run the key is STABLE, because
// scenario 6's duplicate-submission test needs both submissions to land on the same intent.
//
// This file tests the generator and the driver's use of it by reading its source. The dynamic half
// — that a prior ABANDONED run genuinely does not block a new invocation's claim, and genuinely
// DOES still block a reused key — needs a real Postgres and lives in check-worker-leasing-db.js.
// Neither half is sufficient alone: this one cannot prove the database's behaviour, and that one
// cannot prove the driver stopped hardcoding keys.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const KEYS = require('./lib/m75-intent-keys');
const DRIVER = path.join(__dirname, 'm7-5-dev-driver.js');

test('keys carry the m75- prefix, so existing LIKE inspection still finds them', () => {
  const id = KEYS.newRunId();
  const k = KEYS.intentKey(id, 'cancel');
  assert.ok(k.startsWith('m75-'), k);
  assert.equal(KEYS.LIKE_PATTERN, 'm75-%');
  // The property the report, the stale gate and the containment queries all depend on.
  const likeRe = new RegExp(`^${KEYS.LIKE_PATTERN.replace('%', '.*')}$`);
  assert.match(k, likeRe);
});

test('the key is STABLE within a run — idempotency testing depends on it', () => {
  const id = KEYS.newRunId();
  assert.equal(KEYS.intentKey(id, 'dup'), KEYS.intentKey(id, 'dup'));
});

test('DECISIVE: two invocations never share a key', () => {
  const keys = new Set();
  for (let i = 0; i < 2_000; i++) keys.add(KEYS.intentKey(KEYS.newRunId(), 'cancel'));
  assert.equal(keys.size, 2_000, 'a collision here is a run inheriting another run\'s history');
});

test('two runs starting in the same millisecond still differ', () => {
  // What a retried run after an immediate failure looks like. A timestamp alone would collide.
  const frozen = 1_795_000_000_000;
  const a = KEYS.newRunId(frozen);
  const b = KEYS.newRunId(frozen);
  assert.notEqual(a, b);
});

test('CONTROL: a timestamp-only generator WOULD collide, which is why there is a random part', () => {
  const frozen = 1_795_000_000_000;
  const noRandom = () => '';
  assert.equal(KEYS.newRunId(frozen, noRandom), KEYS.newRunId(frozen, noRandom),
    'proves the randomness is load-bearing rather than decorative');
});

test('malformed run ids and scenario names are refused, not silently interpolated', () => {
  assert.throws(() => KEYS.intentKey('', 'cancel'), /run id/);
  assert.throws(() => KEYS.intentKey("x'; DROP TABLE", 'cancel'), /run id/);
  assert.throws(() => KEYS.intentKey('abc123', "cancel'--"), /scenario name/);
  assert.throws(() => KEYS.intentKey('abc123', ''), /scenario name/);
});

// ── THE DRIVER MUST ACTUALLY USE IT ────────────────────────────────────────

test('DECISIVE: the driver hardcodes no scenario intent key', () => {
  const src = fs.readFileSync(DRIVER, 'utf8');
  // Comments explain the history and legitimately name the old keys, so they are stripped first.
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

  const literals = code.match(/'m75-[a-z][a-z0-9-]*'/g) || [];
  assert.deepEqual(literals, [],
    `every intent key must go through IK(): found ${literals.join(', ')}`);
});

test('the driver mints exactly one run id per invocation, at module scope', () => {
  const src = fs.readFileSync(DRIVER, 'utf8');
  const mints = src.match(/KEYS\.newRunId\(/g) || [];
  assert.equal(mints.length, 1,
    'a second mint would give two scenarios different namespaces inside one run');
  assert.match(src, /const RUN_ID = KEYS\.newRunId\(\)/);
  assert.match(src, /const IK = \(scenario\) => KEYS\.intentKey\(RUN_ID, scenario\)/);
});

test('the driver reports its run id and its exact fixture ids', () => {
  const src = fs.readFileSync(DRIVER, 'utf8');
  assert.match(src, /run id \$\{RUN_ID\}/, 'the run id must be printed before anything is created');
  assert.match(src, /intent keys :/, 'and the exact intent keys at the end');
  assert.match(src, /task ids {4}:/, 'and the exact task ids');
});

test('DECISIVE: no overrideReason anywhere in the driver', () => {
  // The forbidden shortcut. Passing one would make the acceptance run pass by reaching around the
  // governance guard, and would exercise a path real work never takes.
  //
  // Comments are stripped first. The first version of this test failed on the driver's own comment
  // saying "no overrideReason is passed anywhere" — a guard tripping over the sentence that
  // documents it, which is the second time that shape has appeared today (the state report's
  // read-only self-check did the same thing with the word INSERT).
  const code = fs.readFileSync(DRIVER, 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/overrideReason/.test(code), 'the driver must not pass overrideReason');
  assert.ok(!/retry_override_reason/.test(code), 'nor write the column directly');
});

test('the stale-fixture gate still uses the shared prefix, not its own copy', () => {
  const src = fs.readFileSync(DRIVER, 'utf8');
  assert.match(src, /KEYS\.LIKE_PATTERN/, 'the gate must match every run\'s keys, not just its own');
});
