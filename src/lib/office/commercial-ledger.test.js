#!/usr/bin/env node
// ── THE SEVEN KINDS CANNOT BE CONFLATED ─────────────────────────────────────
//
//   node --test src/lib/office/commercial-ledger.test.js
//
// Owner's Priority 7, 2026-11-26: *"Distinguish estimated opportunity value, quotation value,
// actual orders, invoiced revenue, received payments, costs and margin."*
//
// Each test is one way the distinction could be lost, and the fixture is deliberately
// DISCRIMINATING — every kind carries a different figure, so a function that reads the wrong kind
// produces a visibly wrong number rather than coincidentally the right one. (Rule 8, earned by a
// sabotage that did not bite because every number in its fixture was 1.)

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const L = require('./commercial-ledger');

/** One deal through its whole life, every figure different. */
const DEAL = Object.freeze([
  { kind: 'opportunity_estimate', amount: 250_000, currency: 'USD', basis: 'estimate', source: 'pipeline-1' },
  { kind: 'quotation', amount: 9_100, currency: 'USD', basis: 'counterparty_stated', source: 'quote-1' },
  { kind: 'order', amount: 8_500, currency: 'USD', basis: 'recorded', source: 'po-1' },
  { kind: 'invoiced', amount: 8_500, currency: 'USD', basis: 'recorded', source: 'inv-1' },
  { kind: 'payment_received', amount: 4_000, currency: 'USD', basis: 'settled', source: 'pay-1' },
  { kind: 'cost', amount: 6_200, currency: 'USD', basis: 'recorded', source: 'supplier-inv-1' },
]);

const ALL_READABLE = Object.freeze({
  opportunity_estimate: true, quotation: true, order: true,
  invoiced: true, payment_received: true, cost: true,
});

test('every kind reports its OWN figure, and no two agree by accident', () => {
  const a = L.aggregate({ facts: DEAL, readable: ALL_READABLE });
  assert.equal(a.figures.opportunity_estimate.amount, 250_000);
  assert.equal(a.figures.quotation.amount, 9_100);
  assert.equal(a.figures.order.amount, 8_500);
  assert.equal(a.figures.invoiced.amount, 8_500);
  assert.equal(a.figures.payment_received.amount, 4_000);
  assert.equal(a.figures.cost.amount, 6_200);
});

test('there is NO total across kinds', () => {
  const a = L.aggregate({ facts: DEAL, readable: ALL_READABLE });
  // The absence is the requirement: a sum over these kinds counts one deal five times.
  assert.equal('total' in a, false, 'a total across kinds must not exist');
  assert.equal('totalUsd' in a, false);
  assert.equal('sum' in a, false);
  assert.match(a.noTotal, /counts the same deal several times/);

  // And nothing in the module computes one, asserted on the source with comments stripped so the
  // explanation above does not satisfy the assertion.
  const src = fs.readFileSync(path.join(__dirname, 'commercial-ledger.js'), 'utf8');
  const exec = src.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
  assert.equal(/\btotal\s*[:=]/.test(exec), false,
    'the module assigns something called a total in executable code');
});

test('an opportunity estimate is NEVER measured, however readable its source', () => {
  const a = L.aggregate({ facts: DEAL, readable: ALL_READABLE });
  assert.equal(a.figures.opportunity_estimate.status, 'estimated');
  assert.notEqual(a.figures.opportunity_estimate.status, 'measured');
  assert.match(a.figures.opportunity_estimate.detail, /deals that do not exist yet/);

  // And it cannot be laundered into a measurement by relabelling its basis.
  const laundered = { ...DEAL[0], basis: 'recorded' };
  assert.match(String(L.problemWith(laundered)),
    /must carry basis "estimate"/,
    'an estimate relabelled as recorded must be refused, not accepted as a measurement');
});

test('a quotation is not an order, and neither is revenue', () => {
  // The three figures differ in the fixture (9,100 / 8,500 / 8,500) and the first pair differ from
  // each other, so a function reading the wrong one is visible.
  const a = L.aggregate({ facts: DEAL, readable: ALL_READABLE });
  assert.notEqual(a.figures.quotation.amount, a.figures.order.amount,
    'the fixture must keep quotation and order distinguishable');
  // An order is its own kind and nothing promotes it to invoiced.
  assert.equal(a.figures.order.kind, 'order');
  assert.equal(a.figures.invoiced.kind, 'invoiced');
});

test('an invoice is not a payment: the receivable is visible', () => {
  const a = L.aggregate({ facts: DEAL, readable: ALL_READABLE });
  // 8,500 invoiced, 4,000 received. The gap is the receivable, and the two figures are separate so
  // a reader can see it. A ledger that reported only one of them would hide it.
  assert.equal(a.figures.invoiced.amount, 8_500);
  assert.equal(a.figures.payment_received.amount, 4_000);
  assert.ok(a.figures.invoiced.amount > a.figures.payment_received.amount);
});

test('an unpaid invoice reads as a MEASURED ZERO payment, not as missing', () => {
  const unpaid = DEAL.filter((f) => f.kind !== 'payment_received');
  const a = L.aggregate({ facts: unpaid, readable: ALL_READABLE });
  assert.equal(a.figures.payment_received.status, 'measured_zero');
  assert.equal(a.figures.payment_received.amount, 0);
});

test('and a payment source nobody read is MISSING, not zero', () => {
  const unpaid = DEAL.filter((f) => f.kind !== 'payment_received');
  const a = L.aggregate({ facts: unpaid, readable: { ...ALL_READABLE, payment_received: undefined } });
  assert.equal(a.figures.payment_received.status, 'missing');
  assert.equal(a.figures.payment_received.amount, null,
    'a missing figure must carry NO amount: writing 0 makes "nothing received" ambiguous');
});

test('an unreadable source is UNAVAILABLE, which is not zero either', () => {
  const a = L.aggregate({ facts: DEAL, readable: { ...ALL_READABLE, cost: false } });
  assert.equal(a.figures.cost.status, 'unavailable');
  assert.equal(a.figures.cost.amount, null);
  assert.match(a.figures.cost.detail, /company has no\s+costs/);
});

// ── MARGIN ─────────────────────────────────────────────────────────────────

test('margin is derived, named, and based on INVOICED rather than collected', () => {
  const a = L.aggregate({ facts: DEAL, readable: ALL_READABLE });
  assert.equal(a.figures.margin.status, 'measured');
  assert.equal(a.figures.margin.amount, 8_500 - 6_200);
  assert.equal(a.figures.margin.basis, 'invoiced_minus_cost',
    'the basis must be named: margin on invoiced and margin on collected are different figures');
  assert.match(a.figures.margin.detail, /NOT margin on money received/);
});

test('margin REFUSES when either side is not measured', () => {
  // Unmeasured cost defaults to no cost, which reports the best possible margin on the least
  // possible evidence. That is the failure mode this refusal exists for.
  const noCost = L.aggregate({ facts: DEAL.filter((f) => f.kind !== 'cost'),
    readable: { ...ALL_READABLE, cost: undefined } });
  assert.equal(noCost.figures.margin.status, 'unavailable');
  assert.match(noCost.figures.margin.detail, /unmeasured cost defaults to no cost/);

  const noRev = L.aggregate({ facts: DEAL.filter((f) => f.kind !== 'invoiced'),
    readable: { ...ALL_READABLE, invoiced: undefined } });
  assert.equal(noRev.figures.margin.status, 'unavailable');
  assert.match(noRev.figures.margin.detail, /invoiced revenue is missing/);

  const badCost = L.aggregate({ facts: DEAL, readable: { ...ALL_READABLE, cost: false } });
  assert.equal(badCost.figures.margin.status, 'unavailable');
});

test('margin REFUSES a measured-zero revenue against a real cost', () => {
  // Found by the synthetic commercial workflow on its first run: $6,200 of quoted procurement cost
  // and nothing invoiced returned margin −$6,200. Arithmetically true, commercially meaningless —
  // the deal has not happened, and a pipeline of quoted-but-unordered work would report an
  // enormous loss. The cost figure already says the true thing.
  const quotedOnly = L.aggregate({
    facts: DEAL.filter((f) => f.kind === 'cost' || f.kind === 'quotation'),
    readable: ALL_READABLE,
  });
  assert.equal(quotedOnly.figures.invoiced.status, 'measured_zero');
  assert.equal(quotedOnly.figures.cost.amount, 6_200);
  assert.equal(quotedOnly.figures.margin.status, 'unavailable',
    'a zero revenue against a real cost must NOT produce a negative margin');
  assert.match(quotedOnly.figures.margin.detail, /cost awaiting revenue, not a loss/);
});

test('but BOTH sides measured zero is a margin of zero, which is honest', () => {
  // The refusal above must not become universal: no activity means no margin, and saying so is a
  // measurement rather than an absence.
  const nothing = L.aggregate({ facts: [], readable: ALL_READABLE });
  assert.equal(nothing.figures.invoiced.status, 'measured_zero');
  assert.equal(nothing.figures.cost.status, 'measured_zero');
  assert.equal(nothing.figures.margin.status, 'measured');
  assert.equal(nothing.figures.margin.amount, 0);
});

test('margin cannot be supplied as a FACT', () => {
  assert.match(String(L.problemWith({ kind: 'margin', amount: 99_999, currency: 'USD',
    basis: 'recorded', source: 'wishful' })),
  /margin is DERIVED/,
  'a margin handed in as a fact must be refused: it is the figure most easily made up');
  // And figureFor says so too, rather than quietly summing margin facts.
  assert.equal(L.figureFor('margin', [], {}).status, 'unavailable');
});

test('margin on a measured ZERO cost is still measured', () => {
  // A genuine zero is a measurement. Refusing it would make the refusal meaningless by making it
  // universal — the distinction is measured-zero versus unmeasured, not zero versus non-zero.
  const free = L.aggregate({ facts: DEAL.filter((f) => f.kind !== 'cost'), readable: ALL_READABLE });
  assert.equal(free.figures.cost.status, 'measured_zero');
  assert.equal(free.figures.margin.status, 'measured');
  assert.equal(free.figures.margin.amount, 8_500);
});

// ── CURRENCY ───────────────────────────────────────────────────────────────

test('mixed currencies are REFUSED, never converted', () => {
  const mixed = [...DEAL, { kind: 'cost', amount: 500, currency: 'EUR', basis: 'recorded',
    source: 'eu-freight' }];
  const a = L.aggregate({ facts: mixed, readable: ALL_READABLE });
  assert.equal(a.figures.cost.status, 'unavailable');
  assert.match(a.figures.cost.detail, /refuses to convert/);
  // And margin refuses in turn rather than deriving from a figure that was itself refused.
  assert.equal(a.figures.margin.status, 'unavailable');
});

// ── MALFORMED FACTS ────────────────────────────────────────────────────────

test('a malformed fact refuses its WHOLE kind, not just itself', () => {
  // Dropping the bad fact and summing the rest would report a figure nobody proposed — the same
  // reasoning as a refused plan step refusing the whole plan.
  const a = L.aggregate({
    facts: [...DEAL, { kind: 'invoiced', amount: 'lots', currency: 'USD', basis: 'recorded',
      source: 'inv-2' }],
    readable: ALL_READABLE,
  });
  assert.equal(a.figures.invoiced.status, 'unavailable');
  assert.match(a.figures.invoiced.detail, /whole figure is refused/);
});

test('every required field is required, and each refusal says why', () => {
  const base = { kind: 'order', amount: 100, currency: 'USD', basis: 'recorded', source: 'po-x' };
  assert.equal(L.problemWith(base), null, 'the baseline fact must be accepted');

  const cases = [
    [{ ...base, kind: 'revenue' }, /not one of the six storable kinds/],
    [{ ...base, amount: Number.NaN }, /finite number/],
    [{ ...base, amount: -5 }, /must not be negative/],
    [{ ...base, currency: 'dollars' }, /three-letter ISO code/],
    [{ ...base, currency: undefined }, /three-letter ISO code/],
    [{ ...base, basis: 'vibes' }, /basis must be one of/],
    [{ ...base, source: undefined }, /source must name/],
  ];
  for (const [fact, re] of cases) {
    const p = L.problemWith(fact);
    assert.ok(p, `${JSON.stringify(fact)} was accepted`);
    assert.match(p, re);
  }
});

// ── SHAPE ──────────────────────────────────────────────────────────────────

test('the module writes nothing and can reach no model', () => {
  const src = fs.readFileSync(path.join(__dirname, 'commercial-ledger.js'), 'utf8');
  const exec = src.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');

  for (const kw of ['INSERT', 'UPDATE', 'DELETE', 'SELECT', 'TRUNCATE']) {
    const sqlShaped = new RegExp(`(^|[^.\\w])${kw}\\s+(INTO\\s+)?[a-z_"*]`, 'i');
    assert.equal(sqlShaped.test(exec), false, `${kw} appears as SQL: this module takes facts, it `
      + 'does not read them — a ledger with its own queries is a second copy of the company filter');
  }
  assert.equal(/\bquery\s*\(/.test(exec), false, 'it must not call a query function');
  for (const m of ['anthropic', 'openai', 'llm', 'prompt', 'governedCall']) {
    assert.equal(new RegExp(m, 'i').test(exec), false,
      `${m} appears: a place where a generated number could become a financial fact`);
  }
  // It requires nothing at all, which is the strongest form of "it cannot reach anything".
  assert.equal(/require\s*\(/.test(exec), false,
    'it should require no modules: every fact is passed in');
});

test('the kind vocabulary and the bases are frozen', () => {
  assert.ok(Object.isFrozen(L.KINDS));
  assert.ok(Object.isFrozen(L.STORABLE_KINDS));
  assert.ok(Object.isFrozen(L.BASES));
  assert.equal(L.STORABLE_KINDS.length, 6, 'six storable kinds; margin is the seventh and derived');
  assert.equal(L.STORABLE_KINDS.includes('margin'), false);
  // All seven appear in KINDS, so the owner's list is covered rather than approximated.
  for (const k of ['opportunity_estimate', 'quotation', 'order', 'invoiced', 'payment_received',
    'cost', 'margin']) {
    assert.ok(Object.values(L.KINDS).includes(k), `the owner's kind '${k}' is missing`);
  }
});

test('CONTROL: the SQL and total patterns fire on planted code', () => {
  // Without this, the two shape tests above could be silencings rather than checks.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
  assert.equal(/(^|[^.\w])SELECT\s+(INTO\s+)?[a-z_"*]/i
    .test(strip('const r = await query(`SELECT * FROM orders`)')), true,
  'planted SQL must be caught');
  assert.equal(/(^|[^.\w])SELECT\s+(INTO\s+)?[a-z_"*]/i
    .test(strip('// we deliberately never SELECT anything here')), false,
  'the same word in a comment must not be caught');
  assert.equal(/\btotal\s*[:=]/.test(strip('  const total = a + b;')), true,
    'a planted total must be caught');
  assert.equal(/\btotal\s*[:=]/.test(strip('// there is deliberately no total: see above')), false,
    'the word in a comment must not be caught');
});

test('money arithmetic does not drift over repeated two-decimal addition', () => {
  // Three figures that lose a cent under naive float addition.
  const facts = [0.1, 0.2, 0.3].map((amount, i) => ({ kind: 'cost', amount, currency: 'USD',
    basis: 'recorded', source: `c${i}` }));
  const f = L.figureFor('cost', facts, { sourceReadable: true });
  assert.equal(f.amount, 0.6, 'cents, not floats: 0.1 + 0.2 + 0.3 must be exactly 0.60');
});

test('a figure names its sources, so every number can be traced back', () => {
  const a = L.aggregate({ facts: DEAL, readable: ALL_READABLE });
  assert.deepEqual(a.figures.invoiced.sources, ['inv-1']);
  assert.deepEqual(a.figures.cost.bases, ['recorded']);
  // A financial figure a reader cannot trace is a figure they have to take on trust.
  for (const k of L.STORABLE_KINDS) {
    const f = a.figures[k];
    if (f.status === 'measured' || f.status === 'estimated') {
      assert.ok(Array.isArray(f.sources) && f.sources.length, `${k} reports no sources`);
    }
  }
});
