// ── INTENT IDENTITY ──────────────────────────────────────────────────────────
//
// The database invariants (one active execution per intent, retry eligibility, terminal
// immutability) need a real Postgres and live in scripts/check-run-identity-db.js. What is testable
// here is the derivation — and it is worth testing precisely, because the first proposal for it was
// rejected for admitting a race that these tests now encode as a requirement.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const runs = require('./runs');
const { cronIntentKey, webhookIntentKey, httpIntentKey, parentIntentKey } = runs;

// node-cron hands the callback `timeMatcher.apply(date)`: a Date shifted so its LOCAL fields spell
// the wall-clock time in the cron's configured timezone. This builds one the same way, from the
// nominal wall clock the matcher matched.
const matched = (y, mo, d, h, mi, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms);

// ── THE RACE THE CEO REJECTED ────────────────────────────────────────────────

test('two workers on opposite sides of a minute boundary compute the SAME intent key', () => {
  // The rejected scheme truncated each container's own Date.now() at callback entry, so a firing
  // at 09:09:59.999 and one at 09:10:00.001 for the SAME scheduled occurrence produced two keys —
  // making a misidentified intent the cause of a duplicate rather than the thing that prevents it.
  //
  // Both workers here matched the same nominal minute; their sub-second positions differ, and one
  // is effectively a whole minute late.
  const workerA = matched(2026, 10, 27, 9, 10, 0, 1);
  const workerB = matched(2026, 10, 27, 9, 10, 59, 999);
  const name = 'weekday-910cst-outreach-agent';

  assert.strictEqual(cronIntentKey(name, workerA), cronIntentKey(name, workerB));
  assert.strictEqual(cronIntentKey(name, workerA), `cron:${name}:2026-10-27T09:10`);
});

test('the rejected wall-clock scheme WOULD have split that slot — kept as the contrast', () => {
  // Not testing production code: this is the shape that was rejected, written out so the reason is
  // visible rather than folklore. A worker whose callback starts 1ms before the minute rolls and
  // one that starts 2ms after would disagree.
  const truncateNow = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-`
    + `${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:`
    + `${String(d.getMinutes()).padStart(2, '0')}`;
  const a = new Date(2026, 9, 27, 9, 9, 59, 999);
  const b = new Date(2026, 9, 27, 9, 10, 0, 1);
  assert.notStrictEqual(truncateNow(a), truncateNow(b),
    'the contrast is void if these agree — the rejected scheme must actually differ here');
});

test('two genuinely different scheduled slots produce different intent keys', () => {
  const name = 'hourly-05-cphi-followup';
  const k1 = cronIntentKey(name, matched(2026, 10, 27, 9, 5));
  const k2 = cronIntentKey(name, matched(2026, 10, 27, 10, 5));   // next hour
  const k3 = cronIntentKey(name, matched(2026, 10, 28, 9, 5));    // next day
  assert.notStrictEqual(k1, k2);
  assert.notStrictEqual(k1, k3);
  assert.notStrictEqual(k2, k3);
});

test('different crons firing the same minute do not collide', () => {
  const at = matched(2026, 10, 26, 8, 0);
  assert.notStrictEqual(
    cronIntentKey('weekly-mon-8utc-goal-engine', at),
    cronIntentKey('weekly-mon-8utc-seo-agent', at),
  );
});

test('a missing or invalid firing context yields NULL rather than an invented identity', () => {
  // node-cron passes the string 'manual' for .now() and 'init' for runOnInit; a direct or test
  // invocation passes nothing. A NULL intent means "nobody declared what this run was for", which
  // leaves it unprotected against duplicate triggers — stated plainly rather than papered over
  // with a key that would be wrong.
  for (const bad of [undefined, null, 'manual', 'init', 0, new Date('nonsense')]) {
    assert.strictEqual(cronIntentKey('x', bad), null, `${String(bad)} must not produce a key`);
  }
});

// ── THE OTHER TRIGGERS ───────────────────────────────────────────────────────

test('a webhook intent key uses the provider event id, and is null without one', () => {
  assert.strictEqual(
    webhookIntentKey('/api/inquiry/stripe-webhook', 'evt_1ABCdef'),
    'webhook:/api/inquiry/stripe-webhook:evt_1ABCdef',
  );
  // No provider id means no identity to reuse. Inventing one would claim idempotency we lack.
  assert.strictEqual(webhookIntentKey('/x', null), null);
  assert.strictEqual(webhookIntentKey('/x', ''), null);
});

test('an HTTP intent key collapses a double-click inside the minute but not across it', () => {
  const base = new Date('2026-10-27T14:20:10.000Z');
  const sameMinute = new Date('2026-10-27T14:20:59.000Z');
  const nextMinute = new Date('2026-10-27T14:21:00.000Z');
  const k = (d) => httpIntentKey('POST', '/api/procurement/run', 'naren@abiozen.com', d);
  assert.strictEqual(k(base), k(sameMinute));
  assert.notStrictEqual(k(base), k(nextMinute));
});

test('an explicit client key wins, so a caller needing exactness can have it', () => {
  const k = httpIntentKey('POST', '/x', 'a', new Date(), 'client-supplied-123');
  assert.strictEqual(k, 'http:client-supplied-123');
  // and it does not vary with time
  assert.strictEqual(httpIntentKey('POST', '/x', 'a', new Date(0), 'client-supplied-123'), k);
});

test('different actors on the same route in the same minute are different intents', () => {
  const at = new Date('2026-10-27T14:20:00.000Z');
  assert.notStrictEqual(
    httpIntentKey('POST', '/api/procurement/run', 'naren@abiozen.com', at),
    httpIntentKey('POST', '/api/procurement/run', 'palash@abiozen.com', at),
  );
});

test('a parent intent key is deterministic per parent, child and ordinal', () => {
  const p = '11111111-2222-3333-4444-555555555555';
  assert.strictEqual(parentIntentKey(p, 'outreach', 0), `parent:${p}:outreach:0`);
  assert.notStrictEqual(parentIntentKey(p, 'outreach', 0), parentIntentKey(p, 'outreach', 1));
  assert.notStrictEqual(parentIntentKey(p, 'outreach', 0), parentIntentKey(p, 'seo', 0));
});

// ── THE DERIVATION'S STANDING ASSUMPTIONS ────────────────────────────────────

test('every cron registration is a 5-field expression, so the matcher granularity is one minute', () => {
  // The whole reason no cron-expression parsing is needed: a 5-field expression cannot fire twice
  // within a minute, so the matched minute IS the scheduled slot. A 6-field expression (with
  // seconds) would break that, and would make two firings in one minute collide on one intent key.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const exprs = [...src.matchAll(/cron\.schedule\(\s*'([^']+)'\s*,\s*withAlerts\(/g)].map((m) => m[1]);
  assert.ok(exprs.length >= 37, `expected at least 37 registrations, found ${exprs.length}`);
  const sixField = exprs.filter((e) => e.trim().split(/\s+/).length !== 5);
  assert.deepStrictEqual(sixField, [],
    `these expressions are not 5-field, so the matched minute is no longer the slot: ${sixField.join(', ')}`);
});

test('the state sets are disjoint and complete, and match the approved lifecycle', () => {
  assert.deepStrictEqual(runs.ACTIVE, ['CREATED', 'RUNNING']);
  assert.deepStrictEqual(runs.TERMINAL, ['SUCCEEDED', 'PARTIAL', 'FAILED', 'ABANDONED', 'STOPPED_BY_POLICY']);
  assert.strictEqual(runs.STATES.length, 7, 'the approved lifecycle is seven states');
  assert.strictEqual(new Set(runs.STATES).size, 7, 'no duplicates');
  // Omitted deliberately, because the system has no such behaviour to model.
  for (const absent of ['QUEUED', 'CANCELLED', 'TIMED_OUT']) {
    assert.ok(!runs.STATES.includes(absent), `${absent} must not exist until the behaviour does`);
  }
});

test('retry eligibility names only terminal states, and SUCCEEDED is not among them', () => {
  for (const s of runs.RETRYABLE) {
    assert.ok(runs.TERMINAL.includes(s), `${s} must be terminal to be retryable`);
  }
  assert.ok(!runs.RETRYABLE.includes('SUCCEEDED'), 'succeeded work must never be retried as the same intent');
  assert.ok(!runs.RETRYABLE.includes('RUNNING') && !runs.RETRYABLE.includes('CREATED'));
  // The override set is a subset of the retryable set, and STOPPED_BY_POLICY is NOT in it: the
  // kill switch re-evaluates before the retry runs, and a second policy mechanism could disagree.
  for (const s of runs.RETRY_NEEDS_OVERRIDE) assert.ok(runs.RETRYABLE.includes(s));
  assert.ok(!runs.RETRY_NEEDS_OVERRIDE.includes('STOPPED_BY_POLICY'));
});

test('run ids are distinct uuids generated by the application, not the database', () => {
  // Deliberate: gen_random_uuid() is built-in only from PG13 and the production server version is
  // not verifiable from here, while 26 files already generate ids this way.
  const ids = new Set(Array.from({ length: 500 }, () => runs.newRunId()));
  assert.strictEqual(ids.size, 500);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
