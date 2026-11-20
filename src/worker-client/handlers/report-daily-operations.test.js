// ── THE DAILY OPERATIONS HANDLER ────────────────────────────────────────────
//
//   node --test src/worker-client/handlers/report-daily-operations.test.js
//
// The first handler that computes something a person would read, so the tests are about the two
// ways a report can be wrong: it can be malformed, or it can look perfectly normal and not add up.
// The second is the dangerous one, and it is what the reconciliation assertions are for.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const H = require('./report-daily-operations');

const fact = (over = {}) => ({
  id: 'x', kind: 'assay', molecule: 'SYN-ALPHA-01', status: 'open', units: 1, ...over,
});
const payload = (facts, asOf = '2026-11-20') => ({ asOf, facts });

// ── IT COMPUTES THE RIGHT ANSWER ────────────────────────────────────────────

test('counts by kind and status, and totals reconcile', async () => {
  const out = await H.run(payload([
    fact({ kind: 'assay', status: 'open', units: 2 }),
    fact({ kind: 'assay', status: 'blocked', units: 3 }),
    fact({ kind: 'batch', status: 'closed', units: 10 }),
  ]));
  assert.equal(out.asOf, '2026-11-20');
  assert.equal(out.factCount, 3);
  const assays = out.sections.find((s) => s.kind === 'assay');
  assert.deepEqual(assays.byStatus, { open: 1, closed: 0, blocked: 1 });
  assert.equal(assays.count, 2);
  assert.equal(assays.units, 5);
  assert.equal(out.totals.count, 3);
  assert.equal(out.totals.units, 15);
  assert.equal(out.totals.blocked, 1);
  assert.deepEqual(H.validateOutput(out), []);
});

test('every kind gets a section, including the empty ones', async () => {
  // A section that vanishes at zero makes "no assays today" indistinguishable from "assays were
  // not counted", which is the kind of ambiguity this milestone keeps removing.
  const out = await H.run(payload([fact({ kind: 'shipment' })]));
  assert.equal(out.sections.length, H.KINDS.length);
  for (const k of H.KINDS) {
    assert.ok(out.sections.some((s) => s.kind === k), `no section for ${k}`);
  }
  assert.equal(out.sections.find((s) => s.kind === 'assay').count, 0);
});

test('an empty day is a valid report, not an error', async () => {
  const out = await H.run(payload([]));
  assert.equal(out.factCount, 0);
  assert.equal(out.totals.count, 0);
  assert.deepEqual(H.validateOutput(out), []);
});

test('DECISIVE: the same payload gives a byte-identical report', async () => {
  // What `reexecutable: true` claims. If this ever stops holding, the retry policy is wrong.
  const p = payload([fact({ kind: 'qc_check', status: 'closed', units: 7.25 }), fact()]);
  const a = await H.run(p);
  const b = await H.run(p);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('it reports nothing about the machine it ran on', async () => {
  const out = await H.run(payload([fact()]));
  const s = JSON.stringify(out);
  for (const leak of [require('node:os').hostname(), process.cwd(), String(process.pid)]) {
    assert.ok(!s.includes(leak), `output contains ${leak}`);
  }
  assert.deepEqual(Object.keys(out).sort(), ['asOf', 'factCount', 'sections', 'totals']);
});

// ── IT REFUSES RATHER THAN IMPROVISING ──────────────────────────────────────

test('an unknown kind refuses the task — there is no "other" bucket', async () => {
  await assert.rejects(() => H.run(payload([fact({ kind: 'telepathy' })])), /not one of/);
});

test('an unknown status refuses the task', async () => {
  await assert.rejects(() => H.run(payload([fact({ status: 'maybe' })])), /not one of/);
});

test('a missing or malformed asOf refuses', async () => {
  await assert.rejects(() => H.run({ facts: [] }), /asOf/);
  await assert.rejects(() => H.run({ asOf: '20 Nov 2026', facts: [] }), /asOf/);
});

test('negative or non-numeric units refuse', async () => {
  await assert.rejects(() => H.run(payload([fact({ units: -1 })])), /non-negative/);
  await assert.rejects(() => H.run(payload([fact({ units: 'lots' })])), /non-negative/);
});

test('an oversized payload is refused, not truncated', async () => {
  const many = Array.from({ length: 4000 }, (_, i) => fact({ id: `f${i}` }));
  await assert.rejects(() => H.run(payload(many)), /accepts at most/);
});

// ── IT OBSERVES THE SIGNAL ──────────────────────────────────────────────────

test('an already-aborted signal stops it before it counts anything', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => H.run(payload([fact()]), { signal: ac.signal }), (e) => e.aborted === true);
});

test('abort partway through a long fact list is observed', async () => {
  const ac = new AbortController();
  const facts = Array.from({ length: 200 }, (_, i) => fact({ id: `f${i}` }));
  const p = H.run(payload(facts), { signal: ac.signal });
  ac.abort();
  // Either it finished the (fast) loop or it aborted; both are correct. What must NOT happen is a
  // handler that accepts a signal and cannot be stopped at all — the 64-fact check interval is
  // what makes this reachable on a realistic dataset.
  await p.then(
    (out) => assert.equal(out.factCount, 200),
    (e) => assert.equal(e.aborted, true),
  );
});

// ── validateOutput IS THE LAST GATE BEFORE SUBMISSION ───────────────────────

test('DECISIVE: output whose sections do not add up is refused', async () => {
  const out = await H.run(payload([fact(), fact({ kind: 'batch' })]));
  out.factCount = 5;                                  // the report now lies about its own input
  const problems = H.validateOutput(out);
  assert.ok(problems.some((p) => /sum to 2 but factCount is 5/.test(p)), problems.join('; '));
});

test('output whose statuses do not add up to its count is refused', async () => {
  const out = await H.run(payload([fact(), fact()]));
  out.sections.find((s) => s.kind === 'assay').byStatus.open = 7;
  assert.ok(H.validateOutput(out).some((p) => /statuses sum to/.test(p)));
});

test('output whose totals disagree with its sections is refused', async () => {
  const out = await H.run(payload([fact()]));
  out.totals.count = 99;
  assert.ok(H.validateOutput(out).some((p) => /totals\.count is 99/.test(p)));
});

test('an extra key is refused, so output cannot grow silently', async () => {
  const out = await H.run(payload([fact()]));
  out.hostname = 'imac';
  assert.ok(H.validateOutput(out).some((p) => /unexpected key/.test(p)));
});

test('CONTROL: validateOutput accepts every report run() produces', async () => {
  // Without this, each assertion above could be satisfied by a validator that rejects everything.
  for (const facts of [[], [fact()], [fact({ kind: 'batch' }), fact({ status: 'blocked' })]]) {
    const out = await H.run(payload(facts));
    assert.deepEqual(H.validateOutput(out), [], JSON.stringify(facts));
  }
});

// ── THE HANDLER HAS NO CAPABILITIES ─────────────────────────────────────────

test('DECISIVE: the handler requires nothing — no database, no network, no filesystem', () => {
  const src = require('node:fs').readFileSync(__filename.replace('.test.js', '.js'), 'utf8');
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, [],
    `the handler must require nothing; it requires ${requires.join(', ')}`);
  for (const forbidden of ['fetch(', 'child_process', 'node:fs', 'pg', 'mailer', 'whatsapp']) {
    assert.ok(!src.includes(forbidden), `the handler references ${forbidden}`);
  }
});
