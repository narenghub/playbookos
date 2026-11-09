// ── THE BENCHMARK FETCHER ────────────────────────────────────────────────────
//
//   node --test src/lib/connectors/usaspending-awards.test.js
//
// No network. The fetch is injected, so what is tested is the part that can be silently wrong:
// which position in the sorted list each percentile reads from, and whether a result that cannot
// be trusted is refused rather than stored.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const U = require('./usaspending-awards');

// A fake USAspending holding `total` awards whose amounts are 1..total. The award at zero-based
// position i is therefore i+1, which makes an off-by-one in the paging arithmetic visible as an
// off-by-one in the answer.
function fakeApi(total, { capture } = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    if (capture) capture.push({ url, body });
    if (url === U.COUNT_URL) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: { contracts: total } }) };
    }
    const { page, limit } = body;
    const start = (page - 1) * limit;
    const results = [];
    for (let i = start; i < Math.min(start + limit, total); i += 1) {
      results.push({ 'Award ID': `A${i}`, 'Award Amount': i + 1 });
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ results }) };
  };
}

test('percentiles are read from the right positions in the sorted list', async () => {
  // 1000 awards valued 1..1000. p25 sits at index 250, which holds 251.
  const b = await U.fetchBenchmark({ psc: 'Q301', fetchImpl: fakeApi(1000) });
  assert.strictEqual(b.n, 1000);
  assert.strictEqual(b.p25, 251);
  assert.strictEqual(b.median, 501);
  assert.strictEqual(b.p75, 751);
  assert.strictEqual(b.sufficient, true);
});

test('the paging arithmetic survives a position that is not on the first page', async () => {
  // The real case: Q301 has 9,824 awards, so the median lives on page 50 at offset 12. An
  // off-by-one here returns a plausible number from the wrong row and nothing ever complains.
  const cap = [];
  const b = await U.fetchBenchmark({ psc: 'Q301', fetchImpl: fakeApi(9824, { capture: cap }) });
  assert.strictEqual(b.median, 4913, 'median read from the wrong position');

  const medianCall = cap.find((c) => c.url === U.SEARCH_URL && c.body.page === 50);
  assert.ok(medianCall, `no request for page 50; pages asked: ${cap.map((c) => c.body.page)}`);
  assert.strictEqual(medianCall.body.order, 'asc', 'the sort must be ascending for positions to mean anything');
  assert.strictEqual(medianCall.body.sort, 'Award Amount');
});

test('fewer than five awards returns no percentiles AND makes no extra requests', async () => {
  const cap = [];
  const b = await U.fetchBenchmark({ psc: 'ZZ99', fetchImpl: fakeApi(4, { capture: cap }) });
  assert.strictEqual(b.n, 4);
  assert.strictEqual(b.sufficient, false);
  assert.strictEqual(b.median, null);
  assert.strictEqual(cap.filter((c) => c.url === U.SEARCH_URL).length, 0,
    'it paid for percentile requests it could not use');
});

test('a zero-award code is reported as zero, not as an error', async () => {
  const b = await U.fetchBenchmark({ psc: 'ZZ99', fetchImpl: fakeApi(0) });
  assert.strictEqual(b.n, 0);
  assert.strictEqual(b.sufficient, false);
});

test('percentiles that do not ascend are REFUSED, not stored', async () => {
  // If the upstream sort ever stops holding, the bid ladder inverts: "compete on price" above
  // "price on value". The figures are discarded and the reason is reported.
  const broken = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url === U.COUNT_URL) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: { contracts: 400 } }) };
    }
    // Descending amounts regardless of what was asked for.
    const start = (body.page - 1) * body.limit;
    const results = [];
    for (let i = start; i < start + body.limit; i += 1) results.push({ 'Award Amount': 1000 - i });
    return { ok: true, status: 200, text: async () => JSON.stringify({ results }) };
  };
  const b = await U.fetchBenchmark({ psc: 'Q301', fetchImpl: broken });
  assert.strictEqual(b.sufficient, false);
  assert.strictEqual(b.median, null);
  assert.match(b.error, /did not ascend/);
});

test('only contract award types are counted — not grants or loans', async () => {
  // Grants are not work anybody bid for, and including them would drag a bid benchmark toward
  // figures that were never competed.
  const cap = [];
  await U.fetchBenchmark({ psc: 'Q301', fetchImpl: fakeApi(1000, { capture: cap }) });
  const f = cap[0].body.filters;
  assert.deepStrictEqual(f.award_type_codes, ['A', 'B', 'C', 'D']);
  assert.strictEqual(f.subawards, undefined);
});

test('the time window is the requested number of years back from now', async () => {
  const cap = [];
  await U.fetchBenchmark({
    psc: 'Q301', years: 3, now: new Date('2026-11-09T00:00:00Z'), fetchImpl: fakeApi(1000, { capture: cap }),
  });
  const tp = cap[0].body.filters.time_period[0];
  assert.strictEqual(tp.start_date, '2023-11-09');
  assert.strictEqual(tp.end_date, '2026-11-09');
});

test('a naics can be supplied alongside or instead of a psc', async () => {
  const cap = [];
  await U.fetchBenchmark({ psc: 'Q301', naics: '621511', fetchImpl: fakeApi(1000, { capture: cap }) });
  assert.deepStrictEqual(cap[0].body.filters.psc_codes, ['Q301']);
  assert.deepStrictEqual(cap[0].body.filters.naics_codes, ['621511']);

  await assert.rejects(() => U.fetchBenchmark({ fetchImpl: fakeApi(10) }), /psc or a naics is required/);
});

test('an HTTP failure is raised, never silently treated as zero awards', async () => {
  // Zero awards and a broken upstream must not look the same: one means "nothing comparable
  // exists", the other means "we do not know", and only one of them is safe to show.
  const failing = async () => ({ ok: false, status: 502, text: async () => 'bad gateway' });
  await assert.rejects(() => U.fetchBenchmark({ psc: 'Q301', fetchImpl: failing }), /usaspending 502/);
});

test('a non-JSON response is raised rather than parsed into nothing', async () => {
  const html = async () => ({ ok: true, status: 200, text: async () => '<html>maintenance</html>' });
  await assert.rejects(() => U.fetchBenchmark({ psc: 'Q301', fetchImpl: html }), /non-JSON/);
});
