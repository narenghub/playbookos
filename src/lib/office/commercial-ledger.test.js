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
  // THREE cost states, because they are not the same money (requirement 7, 2026-11-26). This deal
  // has a supplier quote of 6,400 that it did not take, an order placed at 6,200, that same 6,200
  // invoiced to us by the supplier, and 1,000 of it actually paid.
  { kind: 'cost_quoted', amount: 6_400, currency: 'USD', basis: 'counterparty_stated', source: 'supplier-quote-1' },
  { kind: 'cost_committed', amount: 6_200, currency: 'USD', basis: 'recorded', source: 'supplier-po-1' },
  { kind: 'cost_incurred', amount: 6_200, currency: 'USD', basis: 'recorded', source: 'supplier-inv-1' },
  { kind: 'cost_incurred', amount: 1_000, currency: 'USD', basis: 'settled', source: 'supplier-pay-1' },
]);

const ALL_READABLE = Object.freeze({
  opportunity_estimate: true, quotation: true, order: true,
  invoiced: true, payment_received: true,
  cost_quoted: true, cost_committed: true, cost_incurred: true,
});

test('every kind reports its OWN figure, and no two agree by accident', () => {
  const a = L.aggregate({ facts: DEAL, readable: ALL_READABLE });
  assert.equal(a.figures.opportunity_estimate.amount, 250_000);
  assert.equal(a.figures.quotation.amount, 9_100);
  assert.equal(a.figures.order.amount, 8_500);
  assert.equal(a.figures.invoiced.amount, 8_500);
  assert.equal(a.figures.payment_received.amount, 4_000);
  assert.equal(a.figures.cost_quoted.amount, 6_400);
  assert.equal(a.figures.cost_committed.amount, 6_200);
  // Both incurred facts sum: 6,200 recorded plus 1,000 settled.
  assert.equal(a.figures.cost_incurred.amount, 7_200);
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
  const a = L.aggregate({ facts: DEAL, readable: { ...ALL_READABLE, cost_incurred: false } });
  assert.equal(a.figures.cost_incurred.status, 'unavailable');
  assert.equal(a.figures.cost_incurred.amount, null);
  assert.match(a.figures.cost_incurred.detail, /company has no\s+costs/);
});

// ── THE THREE DERIVED FIGURES ──────────────────────────────────────────────

test('each derived figure names its own two sides and uses the right cost state', () => {
  const a = L.aggregate({ facts: DEAL, readable: ALL_READABLE });

  // Projected: the QUOTED price against the QUOTED cost. Nothing has happened.
  assert.equal(a.figures.projected_margin.status, 'measured');
  assert.equal(a.figures.projected_margin.amount, 9_100 - 6_400);
  assert.equal(a.figures.projected_margin.basis, 'quotation_minus_quoted_cost');
  assert.match(a.figures.projected_margin.detail, /PROJECTION on prices, not an outcome/);

  // Invoiced: the accrual view. Incurred costs are 6,200 recorded + 1,000 settled = 7,200.
  assert.equal(a.figures.invoiced_margin.status, 'measured');
  assert.equal(a.figures.invoiced_margin.amount, 8_500 - 7_200);
  assert.equal(a.figures.invoiced_margin.basis, 'invoiced_minus_incurred_cost');
  assert.match(a.figures.invoiced_margin.detail, /ACCRUAL view/);

  // Realized: cash in against cash out. Only the settled 1,000 counts on the cost side.
  assert.equal(a.figures.realized_result.status, 'measured');
  assert.equal(a.figures.realized_result.amount, 4_000 - 1_000);
  assert.equal(a.figures.realized_result.basis, 'received_minus_settled_cost');

  // And no two of them are the same number by accident — which is the whole reason there are three.
  const three = [a.figures.projected_margin.amount, a.figures.invoiced_margin.amount,
    a.figures.realized_result.amount];
  assert.equal(new Set(three).size, 3, `three distinct figures expected, got ${three.join(', ')}`);
});

test('A QUOTED COST CANNOT REACH THE INVOICED MARGIN — the original defect, structurally', () => {
  // The defect: a deal consisting of one supplier quotation for $6,200 of unordered work reported
  // margin −$6,200. The first repair refused the subtraction whenever revenue was zero, which
  // treated the symptom. The cause was that a quoted cost and an incurred expense were one kind.
  //
  // Now they are not, so this case cannot be constructed: there is no path by which a quoted cost
  // becomes part of an accrual margin.
  const quotedOnly = L.aggregate({
    facts: DEAL.filter((f) => f.kind === 'cost_quoted' || f.kind === 'quotation'),
    readable: ALL_READABLE,
  });
  assert.equal(quotedOnly.figures.cost_quoted.amount, 6_400);
  assert.equal(quotedOnly.figures.cost_incurred.status, 'measured_zero',
    'nothing has been incurred, and that is a measurement rather than an absence');
  assert.equal(quotedOnly.figures.invoiced.status, 'measured_zero');

  // The accrual margin is zero — nothing billed, nothing expensed — NOT a phantom −6,400.
  assert.equal(quotedOnly.figures.invoiced_margin.status, 'measured');
  assert.equal(quotedOnly.figures.invoiced_margin.amount, 0);
  assert.equal(quotedOnly.figures.invoiced_margin.isLoss, false);

  // The projection is where a quoted cost belongs, and it is positive here.
  assert.equal(quotedOnly.figures.projected_margin.amount, 9_100 - 6_400);
});

test('A LEGITIMATE LOSS IS REPORTED, not suppressed because revenue is zero', () => {
  // Requirement 7, 2026-11-26: *"Do not suppress legitimate losses merely because revenue is
  // zero."* The removed rule would have returned `unavailable` here with "a cost awaiting revenue,
  // not a loss". This is a loss: the expense is on the books and nothing was ever billed.
  const writeOff = L.aggregate({
    facts: [{ kind: 'cost_incurred', amount: 6_200, currency: 'USD', basis: 'recorded',
      source: 'supplier-inv-1' }],
    readable: ALL_READABLE,
  });
  assert.equal(writeOff.figures.invoiced.status, 'measured_zero');
  assert.equal(writeOff.figures.invoiced_margin.status, 'measured',
    'a readable zero revenue against an incurred expense is a measurement, not an absence');
  assert.equal(writeOff.figures.invoiced_margin.amount, -6_200);
  assert.equal(writeOff.figures.invoiced_margin.isLoss, true,
    'isLoss is its own field so a negative cannot be skimmed past in a table of positives');
  assert.match(writeOff.figures.invoiced_margin.detail, /a LOSS of USD 6200\.00/);
});

test('an UNMEASURED side is an absence, and is never reported as a loss', () => {
  // The distinction the removed rule destroyed: "we billed nothing" and "we did not look" are not
  // the same, and only the first can be a loss.
  const notAsked = L.aggregate({
    facts: [{ kind: 'cost_incurred', amount: 6_200, currency: 'USD', basis: 'recorded', source: 'i' }],
    readable: { cost_incurred: true },           // invoiced deliberately absent from `readable`
  });
  assert.equal(notAsked.figures.invoiced.status, 'missing');
  assert.equal(notAsked.figures.invoiced_margin.status, 'unavailable');
  assert.equal(notAsked.figures.invoiced_margin.isLoss, null,
    'an unknown result must not answer the is-this-a-loss question either way');
  assert.match(notAsked.figures.invoiced_margin.detail,
    /absence of data, not a loss/);
});

test('a derived figure REFUSES when either side is not measured', () => {
  // An unmeasured cost defaults to no cost, which reports the best possible result on the least
  // possible evidence. That is the failure mode this refusal exists for.
  const noCost = L.aggregate({ facts: DEAL.filter((f) => !f.kind.startsWith('cost_')),
    readable: { ...ALL_READABLE, cost_incurred: undefined } });
  assert.equal(noCost.figures.invoiced_margin.status, 'unavailable');
  assert.match(noCost.figures.invoiced_margin.detail, /unmeasured cost defaults to no cost/);

  const noRev = L.aggregate({ facts: DEAL.filter((f) => f.kind !== 'invoiced'),
    readable: { ...ALL_READABLE, invoiced: undefined } });
  assert.equal(noRev.figures.invoiced_margin.status, 'unavailable');
  assert.match(noRev.figures.invoiced_margin.detail, /invoiced revenue is missing/);

  const badCost = L.aggregate({ facts: DEAL, readable: { ...ALL_READABLE, cost_incurred: false } });
  assert.equal(badCost.figures.invoiced_margin.status, 'unavailable');
});

test('both sides measured zero is a result of zero, which is honest', () => {
  const nothing = L.aggregate({ facts: [], readable: ALL_READABLE });
  assert.equal(nothing.figures.invoiced.status, 'measured_zero');
  assert.equal(nothing.figures.cost_incurred.status, 'measured_zero');
  for (const k of ['projected_margin', 'invoiced_margin', 'realized_result']) {
    assert.equal(nothing.figures[k].status, 'measured', `${k} should be a measured zero`);
    assert.equal(nothing.figures[k].amount, 0);
    assert.equal(nothing.figures[k].isLoss, false);
  }
});

test('none of the three derived figures can be supplied as a FACT', () => {
  for (const k of L.DERIVED_KINDS) {
    assert.match(String(L.problemWith({ kind: k, amount: 99_999, currency: 'USD',
      basis: 'recorded', source: 'wishful' })),
    /is DERIVED and may never be supplied/,
    `${k} handed in as a fact must be refused: it is the figure most easily made up`);
    assert.equal(L.figureFor(k, [], {}).status, 'unavailable');
  }
});

test('a cost state and its basis must agree', () => {
  // The structural half of the fix: a supplier's quotation is counterparty_stated by nature, and an
  // incurred expense is recorded or settled. Filing one as the other requires lying about the basis
  // too, and that is refused — so the mislabel is not a matter of remembering.
  assert.match(String(L.problemWith({ kind: 'cost_incurred', amount: 6_200, currency: 'USD',
    basis: 'counterparty_stated', source: 'supplier-quote-1' })),
  /may not carry basis 'counterparty_stated'/,
  'a supplier quote must not be fileable as an incurred expense');
  assert.match(String(L.problemWith({ kind: 'cost_quoted', amount: 6_200, currency: 'USD',
    basis: 'settled', source: 'x' })), /may not carry basis 'settled'/);
  // And the legitimate combinations are accepted.
  assert.equal(L.problemWith({ kind: 'cost_quoted', amount: 1, currency: 'USD',
    basis: 'counterparty_stated', source: 'q' }), null);
  assert.equal(L.problemWith({ kind: 'cost_incurred', amount: 1, currency: 'USD',
    basis: 'settled', source: 'p' }), null);
});

test('a result on a measured ZERO cost is still measured', () => {
  const free = L.aggregate({ facts: DEAL.filter((f) => !f.kind.startsWith('cost_')),
    readable: ALL_READABLE });
  assert.equal(free.figures.cost_incurred.status, 'measured_zero');
  assert.equal(free.figures.invoiced_margin.status, 'measured');
  assert.equal(free.figures.invoiced_margin.amount, 8_500);
});

// ── CURRENCY ───────────────────────────────────────────────────────────────

test('mixed currencies are REFUSED, never converted', () => {
  const mixed = [...DEAL, { kind: 'cost_incurred', amount: 500, currency: 'EUR', basis: 'recorded',
    source: 'eu-freight' }];
  const a = L.aggregate({ facts: mixed, readable: ALL_READABLE });
  assert.equal(a.figures.cost_incurred.status, 'unavailable');
  assert.match(a.figures.cost_incurred.detail, /refuses to convert/);
  // And the derived figure refuses in turn rather than deriving from a figure already refused.
  assert.equal(a.figures.invoiced_margin.status, 'unavailable');
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
    [{ ...base, kind: 'revenue' }, /not one of the 8 storable kinds/],
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
  assert.equal(L.STORABLE_KINDS.length, 8,
    'eight storable kinds: five revenue-side moments and three cost COMMITMENT STATES');
  assert.equal(L.DERIVED_KINDS.length, 3,
    'three derived figures — projected, invoiced and realized. There is deliberately no kind '
    + 'called "margin": that single word is what let one number be read three ways.');
  for (const d of L.DERIVED_KINDS) assert.equal(L.STORABLE_KINDS.includes(d), false);
  assert.equal(L.STORABLE_KINDS.includes('margin'), false);
  assert.equal(L.STORABLE_KINDS.includes('cost'), false,
    'the undifferentiated `cost` kind is gone: it is what made a quoted price reportable as an '
    + 'incurred expense');
  // ── THE OWNER'S OWN LIST, MAPPED RATHER THAN QUIETLY DROPPED ────────────
  //
  // The original instruction asked for "opportunity estimates, quotations, actual orders, invoiced
  // revenue, received payments, costs and margin". Five of those seven are kinds under their own
  // names. The last two were SPLIT, by requirement 7 of 2026-11-26, and this test pins the mapping
  // so that splitting them cannot become losing them: every concept the owner named must be
  // answerable, and the ones that became several must say which several.
  for (const k of ['opportunity_estimate', 'quotation', 'order', 'invoiced', 'payment_received']) {
    assert.ok(Object.values(L.KINDS).includes(k), `the owner's kind '${k}' is missing`);
  }
  const MAPPED = {
    cost: ['cost_quoted', 'cost_committed', 'cost_incurred'],
    margin: ['projected_margin', 'invoiced_margin', 'realized_result'],
  };
  for (const [owners, now] of Object.entries(MAPPED)) {
    assert.equal(Object.values(L.KINDS).includes(owners), false,
      `'${owners}' must not survive as a kind of its own: a reader who can ask for it will not `
      + 'learn which of the three they were given');
    for (const k of now) {
      assert.ok(Object.values(L.KINDS).includes(k),
        `'${owners}' was split into ${now.join(', ')} and '${k}' is missing`);
    }
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
  const facts = [0.1, 0.2, 0.3].map((amount, i) => ({ kind: 'cost_incurred', amount, currency: 'USD',
    basis: 'recorded', source: `c${i}` }));
  const f = L.figureFor('cost_incurred', facts, { sourceReadable: true });
  assert.equal(f.amount, 0.6, 'cents, not floats: 0.1 + 0.2 + 0.3 must be exactly 0.60');
});

test('a figure names its sources, so every number can be traced back', () => {
  const a = L.aggregate({ facts: DEAL, readable: ALL_READABLE });
  assert.deepEqual(a.figures.invoiced.sources, ['inv-1']);
  // Two bases on the incurred side, both named: one recorded supplier invoice, one settled payment.
  assert.deepEqual(a.figures.cost_incurred.bases, ['recorded', 'settled']);
  // A financial figure a reader cannot trace is a figure they have to take on trust.
  for (const k of L.STORABLE_KINDS) {
    const f = a.figures[k];
    if (f.status === 'measured' || f.status === 'estimated') {
      assert.ok(Array.isArray(f.sources) && f.sources.length, `${k} reports no sources`);
    }
  }
});
