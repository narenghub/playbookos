// ── WHAT A BID NUMBER MUST NEVER DO ──────────────────────────────────────────
//
//   node --test src/lib/office/award-comparables.test.js
//
// This module produces the one figure on the board the owner could lose money by trusting. The
// tests are therefore mostly about refusing: refusing thin data, refusing zeros, refusing to let
// an $800M pandemic contract set the price of a $50k lab order.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const C = require('./award-comparables');

// Real amounts, measured from USAspending for PSC Q301 on 2026-11-09.
const Q301_REAL = [821303840, 427810496, 133905814, 92645361, 82832395];

test('a mean would describe no contract that has ever existed — the median does', () => {
  const s = C.describeAwards([10000, 12000, 15000, 18000, 821303840]);
  assert.strictEqual(s.median, 15000);
  // The mean here is over $164 million. Every real contract but one is under $20k.
  const mean = [10000, 12000, 15000, 18000, 821303840].reduce((a, b) => a + b, 0) / 5;
  assert.ok(mean > 164000000, 'sanity: the mean really is that distorted');
});

test('fewer than five comparables produces NO strategies, not cautious ones', () => {
  for (const n of [0, 1, 2, 3, 4]) {
    const amounts = Array.from({ length: n }, (_, i) => 10000 * (i + 1));
    const bid = C.suggestBids(C.describeAwards(amounts));
    assert.strictEqual(bid.available, false, `${n} comparables produced a bid`);
    assert.match(bid.why, /insufficient comparable data/);
    assert.deepStrictEqual(bid.strategies, []);
  }
});

test('exactly five comparables is enough', () => {
  const bid = C.suggestBids(C.describeAwards(Q301_REAL));
  assert.strictEqual(bid.available, true);
  assert.strictEqual(bid.n, 5);
});

test('three strategies, positioned where the owner asked', () => {
  const s = C.describeAwards([100, 200, 300, 400, 500]);
  const bid = C.suggestBids(s);
  const by = Object.fromEntries(bid.strategies.map((x) => [x.key, x]));

  assert.deepStrictEqual(Object.keys(by), ['competitive', 'market', 'value']);
  // Competitive: the lower quartile, as a single figure.
  assert.strictEqual(by.competitive.low, s.p25);
  assert.strictEqual(by.competitive.point, s.p25);
  // Market: the median, as a single figure.
  assert.strictEqual(by.market.point, s.median);
  // Value: median up to the upper quartile — the only one that is a range.
  assert.strictEqual(by.value.low, s.median);
  assert.strictEqual(by.value.high, s.p75);
  assert.strictEqual(by.value.point, null);
});

test('the three positions never cross each other', () => {
  // Rendering them as a ladder is only honest if they actually ascend.
  for (const amounts of [[100, 200, 300, 400, 500], Q301_REAL, [1, 1, 1, 1, 1, 9999]]) {
    const by = Object.fromEntries(
      C.suggestBids(C.describeAwards(amounts)).strategies.map((x) => [x.key, x]));
    assert.ok(by.competitive.low <= by.market.low, JSON.stringify(amounts));
    assert.ok(by.market.low <= by.value.low, JSON.stringify(amounts));
    assert.ok(by.value.low <= by.value.high, JSON.stringify(amounts));
  }
});

test('every strategy carries low and high, so a caller never branches on shape', () => {
  for (const st of C.suggestBids(C.describeAwards(Q301_REAL)).strategies) {
    assert.ok(Number.isFinite(st.low), `${st.key} low`);
    assert.ok(Number.isFinite(st.high), `${st.key} high`);
    assert.ok(st.note && st.note.length > 10, `${st.key} has no explanation`);
  }
});

test('zero and negative awards are excluded, not counted as cheap contracts', () => {
  // A zero is "never populated", not "awarded for nothing". Counting them drags the median down,
  // and a bid priced off that median would be unwinnably low.
  const s = C.describeAwards([0, 0, -5000, 10000, 20000, 30000, 40000, 50000]);
  assert.strictEqual(s.n, 5);
  assert.strictEqual(s.min, 10000);
  assert.strictEqual(s.median, 30000);
});

test('an $800M pandemic contract does not price a $50k lab order', () => {
  // The failure this prevents, with real numbers: Q301 covers both.
  const amounts = [...Q301_REAL, 40000, 45000, 50000, 55000, 60000, 65000];
  const wide = C.describeAwards(amounts);
  const banded = C.describeAwards(amounts, { near: 50000 });

  assert.ok(banded.banded, 'the band was not applied');
  assert.strictEqual(banded.n, 6, 'the band kept the wrong rows');
  assert.ok(banded.median < 100000, `banded median was ${banded.median}`);
  // NOT an assertion about the unbanded MEDIAN. A first draft asserted the unbanded median was
  // enormous and failed: with six small awards and five huge ones the median is 65,000, because a
  // median is robust — which is the whole reason this module uses one. What the band actually
  // changes is the SET, and therefore the quartiles and the extremes.
  assert.ok(wide.max > 100000000, 'sanity: the unbanded set really does contain the giants');
  assert.ok(banded.max < 100000, `the band left a giant in: ${banded.max}`);
  assert.ok(wide.p75 > banded.p75, 'the band should pull the upper quartile down');

  const bid = C.suggestBids(banded);
  for (const st of bid.strategies) {
    assert.ok(st.high < 1000000, `${st.key} priced a $50k order at ${st.high}`);
  }
  assert.match(bid.basis, /similar size/);
});

test('the band is NOT applied when it would leave too little to work with', () => {
  // Better a wide distribution, clearly labelled, than a confident number from two rows.
  const s = C.describeAwards([...Q301_REAL, 100], { near: 100 });
  assert.strictEqual(s.banded, false);
  assert.strictEqual(s.n, 6);
});

test('percentiles interpolate rather than snapping to a member', () => {
  const sorted = [100, 200, 300, 400];
  assert.strictEqual(C.percentile(sorted, 0.5), 250);
  assert.strictEqual(C.percentile(sorted, 0), 100);
  assert.strictEqual(C.percentile(sorted, 1), 400);
});

test('an empty set yields null, never NaN', () => {
  // NaN renders as "NaN" on a dashboard; null can be rendered as "unknown".
  const s = C.describeAwards([]);
  assert.strictEqual(s.n, 0);
  for (const k of ['median', 'p25', 'p75', 'min', 'max']) {
    assert.strictEqual(s[k], null, `${k} was not null`);
  }
  assert.strictEqual(C.usd(s.median), null);
});

test('string amounts from an API are coerced, junk is dropped', () => {
  const s = C.describeAwards(['10000', '20000', 30000, 'not a number', null, undefined, '40000', '50000']);
  assert.strictEqual(s.n, 5);
  assert.strictEqual(s.median, 30000);
});

test('the basis always states how many awards it rests on', () => {
  // A number without its evidence is the thing this whole module exists to prevent.
  const bid = C.suggestBids(C.describeAwards([1, 2, 3, 4, 5, 6, 7]));
  assert.match(bid.basis, /7 comparable award/);
  assert.strictEqual(bid.n, 7);
  for (const st of bid.strategies) assert.match(st.basis, /7 comparable award/);
});

test('formatting is whole dollars with separators', () => {
  assert.strictEqual(C.usd(1234567.89), '$1,234,568');
  assert.strictEqual(C.usd(0), '$0');
  assert.strictEqual(C.usd(null), null);
});

// ── THE TRADE AGREEMENTS ACT LINE ────────────────────────────────────────────

test('a contract at or above the TAA threshold is flagged, not waved through', () => {
  // Abiozen sources from India and China; neither is TAA-designated. Above the threshold that is
  // a bar, not a preference, and a row that failed to say so would cost a week of proposal work.
  const over = C.taaPosture(C.TAA_SUPPLY_THRESHOLD_USD);
  assert.strictEqual(over.regime, 'taa');
  assert.match(over.note, /India and China/);
  assert.match(over.note, /barred/);
});

test('below the threshold is Buy American — a preference, not a prohibition', () => {
  const under = C.taaPosture(C.TAA_SUPPLY_THRESHOLD_USD - 1);
  assert.strictEqual(under.regime, 'buy_american');
  assert.match(under.note, /not a prohibition/);
});

test('an unknown value yields unknown, never a reassuring default', () => {
  // Of 149 live solicitations, zero carried an estimated value. Defaulting those to "fine" would
  // mislabel the entire board.
  for (const v of [null, undefined, NaN, 'abc']) {
    assert.strictEqual(C.taaPosture(v).regime, 'unknown', String(v));
  }
});

test('the threshold is one constant, and the real 2026-27 figure', () => {
  assert.strictEqual(C.TAA_SUPPLY_THRESHOLD_USD, 174000);
  // A $50,000 median lab contract sits below it; a large API supply contract does not.
  assert.strictEqual(C.taaPosture(50000).regime, 'buy_american');
  assert.strictEqual(C.taaPosture(500000).regime, 'taa');
});
