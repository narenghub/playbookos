// ── THE SPEND REPORT ─────────────────────────────────────────────────────────
//
//   node --test src/lib/spend-report.test.js
//
// One rule runs through every assertion here: a dollar total must never be separable from the
// count of calls it could not measure. SUM(cost_usd) answers "what did we spend on the calls we
// could measure", and reporting it as "what did we spend" under-reports by exactly the amount it
// could not see — the same defect as a monitor that is green because it tested nothing.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const R = require('./spend-report');

const NOW = new Date('2026-11-10T12:00:00Z');

function fakeQuery(answers) {
  const calls = [];
  const fn = async (sql, params) => {
    calls.push({ sql, params });
    const key = Object.keys(answers).find((k) => new RegExp(k, 'i').test(sql));
    if (key === undefined) throw new Error(`no scripted answer for: ${sql.slice(0, 80)}`);
    return { rows: answers[key] };
  };
  fn.calls = calls;
  return fn;
}

// Overrides come FIRST: the matcher takes the first key whose pattern matches, and
// 'GROUP BY agent' matches the failures query's 'GROUP BY agent, model, error' too. Put the
// general patterns ahead of the specific ones and a test's own fixture is silently shadowed —
// which is what happened on the first run of this file.
const ANSWERS = (over = {}) => ({
  ...over,
  'GROUP BY 1': [], 'GROUP BY agent': [], 'GROUP BY model': [],
  'FROM llm_spend_log WHERE at >= \\$1\\s*$': [{}],
});

// ── THE UNMEASURED COUNT TRAVELS WITH THE MONEY ─────────────────────────────

test('a dollar figure always carries the calls it could not measure', () => {
  const t = R.shapeTotals({ calls: 10, usd: 4.2, unmeasured_calls: 3 });
  assert.strictEqual(t.usd, 4.2);
  assert.strictEqual(t.unmeasured_calls, 3);
  assert.match(t.confidence, /FLOOR/, 'a partial figure does not say it is a floor');
  assert.match(t.confidence, /3 of 10/);
});

test('unmeasured calls are NEVER folded into the dollar figure', () => {
  // The one way this could silently go wrong: adding an estimate for the unknowns so the total
  // "looks complete". An estimate presented as a measurement is the lie the column exists to stop.
  const t = R.shapeTotals({ calls: 5, usd: 1, unmeasured_calls: 4 });
  assert.strictEqual(t.usd, 1, 'the dollar figure moved to account for unmeasured calls');
});

test('a fully measured window says so, and does not cry floor', () => {
  // Negative control. If `confidence` always warned, the assertion above would pass while the
  // warning became noise nobody reads.
  const t = R.shapeTotals({ calls: 10, usd: 4.2, unmeasured_calls: 0 });
  assert.strictEqual(t.unmeasured_calls, 0);
  assert.doesNotMatch(t.confidence, /FLOOR/);
  assert.match(t.confidence, /every recorded call was measured/);
});

test('an empty window is distinguishable from a fully measured one', () => {
  const t = R.shapeTotals({});
  assert.strictEqual(t.calls, 0);
  assert.match(t.confidence, /no calls recorded/,
    'zero calls reads as "every call was measured", which sounds like a clean bill of health');
});

// ── THE SQL ─────────────────────────────────────────────────────────────────

test('measured dollars are summed with a cost_known filter, in every section', async () => {
  // Without the FILTER, Postgres sums NULLs as nothing and the figure looks identical — which is
  // exactly why this is asserted rather than eyeballed.
  const q = fakeQuery(ANSWERS());
  await R.spendReport(q, { now: NOW });
  const sums = q.calls.filter((c) => /SUM\(cost_usd\)/.test(c.sql));
  assert.ok(sums.length >= 4, `expected the totals block in several sections, saw ${sums.length}`);
  for (const c of sums) {
    assert.match(c.sql, /SUM\(cost_usd\) FILTER \(WHERE cost_known\)/,
      'a section sums cost_usd without filtering to measured rows');
    assert.match(c.sql, /COUNT\(\*\) FILTER \(WHERE NOT cost_known\)/,
      'a section reports dollars without reporting what it could not measure');
  }
});

test('an agent with no measured spend but many unmeasured calls does not sort to the bottom', async () => {
  // It is the most suspicious row on the page: something is calling the model and nothing can say
  // what it costs. Ordering by usd alone would bury it.
  const q = fakeQuery(ANSWERS());
  await R.spendReport(q, { now: NOW });
  const byAgent = q.calls.find((c) => /GROUP BY agent\b/.test(c.sql) && !/GROUP BY agent, model/.test(c.sql));
  assert.match(byAgent.sql, /ORDER BY usd DESC, unmeasured_calls DESC/,
    'unmeasured calls do not break the tie upward');
});

test('the window is bounded and a nonsense value falls back rather than throwing', () => {
  assert.strictEqual(R.windowDays(7), 7);
  assert.strictEqual(R.windowDays('7'), 7);
  assert.strictEqual(R.windowDays(0), R.DEFAULT_DAYS);
  assert.strictEqual(R.windowDays(-5), R.DEFAULT_DAYS);
  assert.strictEqual(R.windowDays('abc'), R.DEFAULT_DAYS);
  assert.strictEqual(R.windowDays(99999), R.MAX_DAYS, 'an unbounded window would scan the whole table');
  assert.strictEqual(R.windowDays(7.9), 7);
});

test('the report is assembled from the window, not from the whole table', async () => {
  const q = fakeQuery(ANSWERS());
  const rep = await R.spendReport(q, { days: 7, now: NOW });
  assert.strictEqual(rep.window_days, 7);
  for (const c of q.calls) {
    assert.match(c.sql, /at >= \$1/, 'a section reads the table without a time bound');
    assert.strictEqual(c.params[0], rep.since);
  }
  // 7 days before noon on the 10th.
  assert.strictEqual(rep.since, '2026-11-03T12:00:00.000Z');
});

test('failures are reported separately — they cost tokens and barely move the total', async () => {
  const q = fakeQuery(ANSWERS({
    'NOT ok AND error IS NOT NULL': [
      { agent: 'sales-agent', model: 'm', error: 'Claude 529: overloaded', n: 44, last_at: NOW },
    ],
  }));
  const rep = await R.spendReport(q, { now: NOW });
  assert.strictEqual(rep.recent_failures.length, 1);
  assert.strictEqual(rep.recent_failures[0].n, 44);
  assert.strictEqual(rep.recent_failures[0].agent, 'sales-agent');
});

// ── THE PROJECTION ──────────────────────────────────────────────────────────

test('a projection is refused on too little data rather than extrapolated from one day', () => {
  const p = R.monthlyProjection({ by_day: [{ day: 'a' }], total: { usd: 10, unmeasured_calls: 0 } });
  assert.strictEqual(p.available, false);
  assert.match(p.why, /too few/);
  assert.ok(!('usd_per_30_days' in p), 'a number was produced anyway');
});

test('a projection states its own arithmetic and whether it is a floor', () => {
  const p = R.monthlyProjection({
    by_day: [{ day: 'a' }, { day: 'b' }, { day: 'c' }, { day: 'd' }],
    total: { usd: 8, unmeasured_calls: 5 },
  });
  assert.strictEqual(p.available, true);
  assert.strictEqual(p.usd_per_day, 2);
  assert.strictEqual(p.usd_per_30_days, 60);
  assert.match(p.basis, /measured mean across 4 day\(s\)/,
    'the projection does not say what it is, so it reads as a forecast');
  assert.match(p.caveat, /FLOOR/);
});

test('a projection over fully measured data does not warn', () => {
  const p = R.monthlyProjection({
    by_day: [{ day: 'a' }, { day: 'b' }, { day: 'c' }],
    total: { usd: 3, unmeasured_calls: 0 },
  });
  assert.match(p.caveat, /every call in this window was measured/);
});

test('this module measures and never caps', () => {
  // Spend CEILINGS are a separate decision with a separate failure mode — a cap that trips
  // silently mid-briefing is worse than no cap. llm.js says the same about itself.
  const verbs = /^(cap|limit|enforce|refuse|block|throttle|halt|stop)/i;
  const offenders = Object.keys(R).filter((k) => verbs.test(k));
  assert.deepStrictEqual(offenders, [], `the spend report exports a control: ${offenders.join(', ')}`);
});
