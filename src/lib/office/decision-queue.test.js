// ── THE DECISION QUEUE ───────────────────────────────────────────────────────
//
//   node --test src/lib/office/decision-queue.test.js
//
// The assertions that matter most are not about ordering. They are about the one failure an
// aggregator is uniquely good at producing: a SHORTER list that looks correct.
//
// A person opens this screen to find out whether anything needs them. If a query throws and its
// rows are dropped, the answer is "no" and the answer is wrong — and unlike a blank page, nothing
// about a short list invites a second look. That is the 1,113-email failure in a new shape: every
// layer did the right local thing and the aggregate was silence.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const Q = require('./decision-queue');

const NOW = new Date('2026-11-10T00:00:00Z');
const inDays = (n) => new Date(NOW.getTime() + n * 86400000).toISOString();
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

const ok = (source, items) => ({ source, ok: true, items });

function item(over = {}) {
  return {
    id: 'x1', kind: 'task', title: 'A thing', where: { page: 'tasks' }, ...over,
  };
}

// ── THE SILENCE TESTS ───────────────────────────────────────────────────────

test('a failed source is reported, never dropped', () => {
  const r = Q.merge([
    ok('inquiries', [item({ id: 'a' })]),
    { source: 'office_approvals', ok: false, error: 'relation does not exist' },
  ], { now: NOW });

  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.complete, false, 'a run with a failed source claimed to be complete');
  assert.deepStrictEqual(r.degraded.map((d) => d.source), ['office_approvals']);
  assert.match(r.degraded[0].error, /relation does not exist/,
    'the degradation does not carry the reason, so nobody can fix it');
});

test('an EMPTY queue with a failed source does not say "you are clear"', () => {
  // The exact sentence this module exists to prevent.
  const r = Q.merge([
    { source: 'office_approvals', ok: false, error: 'timeout' },
    { source: 'inquiries', ok: false, error: 'timeout' },
    ok('daily_tasks', []),
  ], { now: NOW });

  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.trustworthy, false,
    'an empty queue with two unreadable sources was marked trustworthy — a person would be told they are clear');
  assert.match(r.headline, /NOT "you are clear"/,
    `the headline must refuse to imply all-clear; got: ${r.headline}`);
  assert.doesNotMatch(r.headline, /^Nothing is waiting/, 'the headline reads as an all-clear');
});

test('an empty queue with every source healthy DOES say "you are clear"', () => {
  // The negative control for the test above. If `trustworthy` were simply always false, the
  // assertion above would pass while the screen became useless — it could never report calm.
  const r = Q.merge([ok('office_approvals', []), ok('inquiries', []), ok('daily_tasks', [])], { now: NOW });
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.complete, true);
  assert.strictEqual(r.trustworthy, true);
  assert.strictEqual(r.headline, 'Nothing is waiting on you');
});

test('a source result with no ok flag at all counts as failed', () => {
  // A source that returns undefined, or an object shaped differently than expected, must not be
  // read as "healthy with no rows" — that is the silent path.
  for (const bad of [undefined, null, {}, { source: 's' }, { source: 's', ok: 'yes' }]) {
    const r = Q.merge([bad], { now: NOW });
    assert.strictEqual(r.complete, false, `${JSON.stringify(bad)} was treated as a healthy source`);
    assert.strictEqual(r.degraded.length, 1);
  }
});

test('one malformed row degrades that row, not the other six sources', () => {
  const r = Q.merge([
    ok('office_approvals', [item({ id: 'good', kind: 'approval', where: { page: 'approvals' } })]),
    ok('inquiries', [{ id: 'bad', kind: 'inquiry' }]),            // no title, no where
    ok('daily_tasks', [item({ id: 'also-good' })]),
  ], { now: NOW });

  assert.strictEqual(r.count, 2, 'a healthy row was lost because a different row was malformed');
  assert.strictEqual(r.complete, false, 'a dropped row was not reported as a degradation');
  assert.ok(r.degraded.some((d) => /bad/.test(d.error)), 'the dropped row is not named');
});

test('collect() turns a throwing source into a degradation, not an exception', async () => {
  const r = await Q.collect([
    { name: 'inquiries', run: async () => [item({ id: 'a' })] },
    { name: 'office_approvals', run: async () => { throw new Error('connection terminated'); } },
    { name: 'review_tasks', run: async () => 'not an array' },
  ], { now: NOW });

  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.complete, false);
  assert.strictEqual(r.degraded.length, 2);
  assert.ok(r.degraded.some((d) => /connection terminated/.test(d.error)));
  assert.ok(r.degraded.some((d) => /not an array|returned string/.test(d.error)),
    'a source returning a non-array was accepted');
});

test('collect() refuses to run over no sources', async () => {
  // An aggregator with an empty source list reports "all clear" forever and is indistinguishable
  // from a working one. It must not be constructible.
  await assert.rejects(() => Q.collect([], { now: NOW }), /at least one source/);
});

test('every source appears in the per-source report whether it worked or not', () => {
  const r = Q.merge([
    ok('a', [item({ id: '1' })]),
    { source: 'b', ok: false, error: 'x' },
    ok('c', []),
  ], { now: NOW });
  assert.deepStrictEqual(r.sources, [
    { source: 'a', ok: true, count: 1 },
    { source: 'b', ok: false, count: 0 },
    { source: 'c', ok: true, count: 0 },
  ]);
});

// ── THE LADDER ──────────────────────────────────────────────────────────────

test('something already waiting on an outsider outranks every deadline', () => {
  const r = Q.merge([ok('s', [
    item({ id: 'closes-tomorrow', kind: 'contract', deadline: inDays(1), where: { page: 'federal' } }),
    item({ id: 'buyer-waiting', kind: 'inquiry', blocks_external: true, where: { page: 'inquiries' } }),
  ])], { now: NOW });

  assert.strictEqual(r.items[0].id, 'buyer-waiting');
  assert.strictEqual(r.items[0].rung, 'blocking');
  assert.match(r.items[0].rung_why, /already waiting/);
});

test('rungs are urgent / soon / open by days left', () => {
  const r = Q.merge([ok('s', [
    item({ id: 'open', kind: 'task' }),
    item({ id: 'soon', kind: 'contract', deadline: inDays(25), where: { page: 'federal' } }),
    item({ id: 'urgent', kind: 'contract', deadline: inDays(5), where: { page: 'federal' } }),
  ])], { now: NOW });

  assert.deepStrictEqual(r.items.map((i) => i.id), ['urgent', 'soon', 'open']);
  assert.deepStrictEqual(r.items.map((i) => i.rung), ['urgent', 'soon', 'open']);
});

test('within a rung, the nearer deadline comes first, then the older item', () => {
  const r = Q.merge([ok('s', [
    item({ id: 'd10', kind: 'contract', deadline: inDays(10), where: { page: 'f' } }),
    item({ id: 'd2', kind: 'contract', deadline: inDays(2), where: { page: 'f' } }),
  ])], { now: NOW });
  assert.deepStrictEqual(r.items.map((i) => i.id), ['d2', 'd10']);

  const u = Q.merge([ok('s', [
    item({ id: 'new', created_at: daysAgo(1) }),
    item({ id: 'old', created_at: daysAgo(30) }),
  ])], { now: NOW });
  assert.deepStrictEqual(u.items.map((i) => i.id), ['old', 'new'],
    'undated work is ordered by how long it has waited, oldest first');
});

test('the order is total — equal items do not shuffle between calls', () => {
  const rows = [item({ id: 'b' }), item({ id: 'a' }), item({ id: 'c' })];
  const first = Q.merge([ok('s', rows)], { now: NOW }).items.map((i) => i.id);
  const again = Q.merge([ok('s', [...rows].reverse())], { now: NOW }).items.map((i) => i.id);
  assert.deepStrictEqual(first, again, 'the same set in a different input order produced a different queue');
});

test('an overdue deadline is urgent, not "open"', () => {
  // A negative days_left must not fall through the <= ladder into OPEN, which would sort a notice
  // that closed last week below one closing next month.
  const r = Q.merge([ok('s', [
    item({ id: 'past', kind: 'contract', deadline: inDays(-3), where: { page: 'f' } }),
    item({ id: 'future', kind: 'contract', deadline: inDays(20), where: { page: 'f' } }),
  ])], { now: NOW });
  assert.strictEqual(r.items[0].id, 'past');
  assert.strictEqual(r.items[0].rung, 'urgent');
  assert.strictEqual(r.items[0].days_left, -3);
});

// ── THE ITEM CONTRACT ───────────────────────────────────────────────────────

test('an item with nowhere to go is refused', () => {
  // This queue performs nothing, so `where.page` is the entire value of a row. An item without it
  // is a notification the person cannot act on.
  assert.throws(() => Q.makeItem(item({ where: undefined }), NOW), /where\.page/);
  assert.throws(() => Q.makeItem(item({ where: {} }), NOW), /where\.page/);
});

test('an unrecognised kind is refused rather than rendered blank', () => {
  assert.throws(() => Q.makeItem(item({ kind: 'invoice' }), NOW), /unknown decision kind "invoice"/);
});

test('an item with no id is refused', () => {
  assert.throws(() => Q.makeItem(item({ id: undefined }), NOW), /needs an id/);
});

test('by_kind reports every kind, including the zeroes', () => {
  // A kind missing from the object renders as `undefined` in a count row rather than 0.
  const r = Q.merge([ok('s', [item({ id: 'a', kind: 'inquiry', where: { page: 'i' } })])], { now: NOW });
  for (const k of Q.KINDS) {
    assert.strictEqual(typeof r.by_kind[k], 'number', `by_kind.${k} is missing`);
  }
  assert.strictEqual(r.by_kind.inquiry, 1);
  assert.strictEqual(r.by_kind.approval, 0);
});

test('the internal sort key does not leak into the response', () => {
  const r = Q.merge([ok('s', [item()])], { now: NOW });
  assert.ok(!('_rank' in r.items[0]), '_rank leaked to the API surface');
});

// ── THE RULE THAT MUST NOT ERODE ────────────────────────────────────────────

test('this module exposes no way to act on a decision', () => {
  // The queue aggregates across the email HOLD and the capability STOPs. Those guards sit on the
  // execution paths; a decide/approve/send exported from here would be a second door into them.
  const verbs = /^(approve|reject|decide|release|send|submit|bid|execute|act|resolve|dismiss|complete)/i;
  const offenders = Object.keys(Q).filter((k) => verbs.test(k));
  assert.deepStrictEqual(offenders, [],
    `the decision queue exports an action: ${offenders.join(', ')}. It is a view — every item carries `
    + `\`where\` and the decision is made on the page that owns it, behind that page's guards.`);
});
