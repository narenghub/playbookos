// ── WHAT THE ADVICE MUST NEVER SAY ───────────────────────────────────────────
//
//   node --test src/lib/office/contract-advice.test.js
//
// This engine tells the owner what to do about a contract. The failures that matter are not
// crashes — they are confident, wrong, actionable advice: "bid this" on something barred, or
// "prepare this" for a certification he can never obtain.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const A = require('./contract-advice');

const NOW = new Date('2026-11-09T12:00:00Z');
const inDays = (n) => new Date(NOW.getTime() + n * 86400000).toISOString();

const row = (over = {}) => Object.assign({
  solicitation_number: 'S1',
  status: 'open',
  response_deadline: inDays(30),
  deadline_confirmed: true,
  missing_evidence: [],
  relevance: { verdict: 'RELEVANT', score: 95, lines: ['analytical_services'], reasons: [], vetoes: [] },
  pricing: {
    bids: {
      available: true,
      strategies: [
        { key: 'competitive', label: 'Compete on price', point: 14885, low: 14885, high: 14885 },
        { key: 'market', label: 'Market rate', point: 54900, low: 54900, high: 54900 },
        { key: 'value', label: 'Price on value', point: null, low: 54900, high: 227420 },
      ],
    },
    benchmark: { n: 7829, median: 54900 },
    trade_agreements: { regime: 'buy_american', note: 'below the threshold' },
  },
}, over);

test('a clean, confirmed, unblocked contract is BID NOW', () => {
  const a = A.adviseOnContract(row(), { now: NOW });
  assert.strictEqual(a.verdict, 'BID NOW');
  assert.deepStrictEqual(a.blocked_by, []);
  assert.match(a.steps[0].action, /Decide bid or no-bid/);
});

test('BID NOW never means submitted — the first step is a human decision', () => {
  // The whole system is under a standing hold on autonomous bidding. If this engine ever reads
  // as an instruction the machine carries out, that hold has been quietly lost.
  const a = A.adviseOnContract(row(), { now: NOW });
  assert.match(a.steps[0].detail, /Nothing is submitted by this system/);
  assert.strictEqual(a.steps[0].owner, 'Naresh');
});

test('an unconfirmed deadline blocks the bid and names who clears it', () => {
  // 120 of 149 live contracts are in exactly this state.
  const a = A.adviseOnContract(row({ deadline_confirmed: false }), { now: NOW });
  assert.strictEqual(a.verdict, 'PREPARE');
  assert.ok(a.blocked_by.some((b) => /deadline not confirmed/.test(b)));
  const s = a.steps.find((x) => /confirm the response deadline/i.test(x.action));
  assert.ok(s, JSON.stringify(a.steps));
  assert.strictEqual(s.owner, 'procurement');
});

test('a certification we cannot obtain is SKIP, never PREPARE', () => {
  // The failure this prevents: a to-do list for something that can never be done. Abiozen is not
  // veteran-owned and no amount of preparation changes that.
  for (const cert of [
    'Service-Disabled Veteran-Owned Small Business certification',
    'HUBZone certification',
    '8(a) certification',
  ]) {
    const a = A.adviseOnContract(row({ missing_evidence: [cert] }), { now: NOW });
    assert.strictEqual(a.verdict, 'SKIP', cert);
    assert.deepStrictEqual(a.steps, [], `${cert} produced busywork`);
  }
});

test('above the TAA threshold is WATCH, and says why — not BID NOW', () => {
  // A $1.1M contract where India/China origin is barred. Recommending a bid on it costs a week.
  const a = A.adviseOnContract(row({
    pricing: { ...row().pricing, trade_agreements: { regime: 'taa', note: 'generally barred' } },
  }), { now: NOW });
  assert.strictEqual(a.verdict, 'WATCH');
  assert.ok(a.why.some((w) => /India or China/.test(w)), JSON.stringify(a.why));
  assert.ok(a.steps.some((s) => /country of origin/i.test(s.action)));
});

test('a missing capability names the ONE document that would unlock it', () => {
  const a = A.adviseOnContract(row({
    deadline_confirmed: false,
    missing_evidence: ['custom_synthesis: any verified capability at all'],
  }), { now: NOW });
  const s = a.steps.find((x) => /delivery evidence/i.test(x.action));
  assert.ok(s, JSON.stringify(a.steps));
  assert.match(s.detail, /purchase order/);
  assert.match(s.detail, /unlocks every contract blocked on this line/);
});

test('an expired or closed contract is SKIP with no steps', () => {
  for (const over of [{ response_deadline: inDays(-1) }, { status: 'closed' }, { status: 'awarded' }]) {
    const a = A.adviseOnContract(row(over), { now: NOW });
    assert.strictEqual(a.verdict, 'SKIP', JSON.stringify(over));
    assert.deepStrictEqual(a.steps, []);
  }
});

test('NOT_RELEVANT is SKIP and carries the veto, not a lecture', () => {
  const a = A.adviseOnContract(row({
    relevance: { verdict: 'NOT_RELEVANT', score: 0, lines: [], reasons: ['no line'], vetoes: ['marine or vessel work'] },
  }), { now: NOW });
  assert.strictEqual(a.verdict, 'SKIP');
  assert.deepStrictEqual(a.why, ['marine or vessel work']);
});

test('no benchmark is stated as no defensible figure, not as a cheap contract', () => {
  const a = A.adviseOnContract(row({
    pricing: { bids: { available: false, strategies: [] }, trade_agreements: { regime: 'unknown', note: '' } },
  }), { now: NOW });
  assert.ok(a.why.some((w) => /no defensible bid figure/.test(w)), JSON.stringify(a.why));
});

test('urgency is derived from the deadline, and unknown stays unknown', () => {
  assert.strictEqual(A.adviseOnContract(row({ response_deadline: inDays(3) }), { now: NOW }).urgency, 'this week');
  assert.strictEqual(A.adviseOnContract(row({ response_deadline: inDays(10) }), { now: NOW }).urgency, 'two weeks');
  assert.strictEqual(A.adviseOnContract(row({ response_deadline: inDays(200) }), { now: NOW }).urgency, 'later');
  assert.strictEqual(A.adviseOnContract(row({ response_deadline: null }), { now: NOW }).urgency, 'unknown');
});

test('the board is ordered by what to work, not by contract value', () => {
  // The largest contract on a board is routinely the one we are least able to deliver.
  const rows = [
    row({ solicitation_number: 'FAR', response_deadline: inDays(80) }),
    row({ solicitation_number: 'BLOCKED', deadline_confirmed: false, response_deadline: inDays(2) }),
    row({ solicitation_number: 'SOON', response_deadline: inDays(5) }),
    row({ solicitation_number: 'DEAD', status: 'closed' }),
  ];
  const order = A.prioritise(rows, { now: NOW }).map((x) => x.row.solicitation_number);
  assert.deepStrictEqual(order, ['SOON', 'FAR', 'BLOCKED', 'DEAD']);
});

test('leverage counts what would unblock the MOST contracts', () => {
  // The single most useful number on the board, and invisible from any one row.
  const rows = [
    ...Array.from({ length: 5 }, () => row({
      deadline_confirmed: false,
      missing_evidence: ['custom_synthesis: any verified capability at all'],
    })),
    ...Array.from({ length: 2 }, () => row({ deadline_confirmed: false })),
    row({ missing_evidence: ['SAM.gov entity registration renewed beyond 2027-09-30'] }),
    row({ missing_evidence: ['SAM.gov entity registration renewed beyond 2029-03-06'] }),
  ];
  const lev = A.unblockingLeverage(rows, { now: NOW });
  assert.strictEqual(lev[0].blocker, 'response deadline not confirmed by a person');
  assert.strictEqual(lev[0].contracts, 7);
  // Registration blockers differ only by date and must be counted as ONE piece of work.
  const reg = lev.find((l) => /registration/.test(l.blocker));
  assert.strictEqual(reg.contracts, 2, JSON.stringify(lev));
});

test('a SKIP contributes nothing to leverage', () => {
  // Otherwise the top of the list fills with work that would unlock nothing biddable.
  const lev = A.unblockingLeverage([
    row({ missing_evidence: ['Service-Disabled Veteran-Owned Small Business certification'] }),
    row({ status: 'closed', missing_evidence: ['whatever'] }),
  ], { now: NOW });
  assert.deepStrictEqual(lev, []);
});

test('every verdict is one of the four, and every step has an owner', () => {
  for (const over of [{}, { deadline_confirmed: false }, { status: 'closed' },
    { missing_evidence: ['HUBZone certification'] }, { response_deadline: null }]) {
    const a = A.adviseOnContract(row(over), { now: NOW });
    assert.ok(A.VERDICTS.includes(a.verdict), a.verdict);
    assert.ok(a.headline && a.headline.length > 5);
    for (const s of a.steps) {
      assert.ok(s.action && s.owner, JSON.stringify(s));
    }
  }
});
