// ── WHAT SHOULD WE DO ABOUT THIS CONTRACT? ───────────────────────────────────
//
// The board computes a great deal per row — relevance and its reasons, feasibility checks,
// missing evidence, a bid benchmark, the Trade Agreements Act posture, a deadline. None of it
// said what to DO. The owner assembled the answer himself, every time, from eight fields.
//
// This produces the answer. By RULE, not by model:
//
//   BID NOW   everything needed is in hand and the clock is running
//   PREPARE   a real fit, blocked on something we can actually clear
//   WATCH     a real fit, blocked on something we cannot clear soon
//   SKIP      not our work, or barred
//
// ── WHY THE VERDICT IS DETERMINISTIC ─────────────────────────────────────────
//
// A language model writing "you should bid this" is a model that can be wrong confidently, about
// money, on a row the owner will act on. So the verdict and the ordered unblocking steps are
// computed here from facts. A model may later put the explanation into readable prose — fenced to
// these same facts, inventing nothing — which is the division of labour inquiry-triage.js uses
// for the same reason.
//
// ── WHY "PREPARE" EXISTS AND MATTERS MOST ────────────────────────────────────
//
// Measured on the live board, 2026-11-09: 120 contracts wait on a human confirming a response
// deadline, and 125 on a single piece of delivery evidence. An engine that answers only BID or
// SKIP would mark almost the whole board SKIP and be useless — and an engine that said BID on a
// row blocked by missing evidence would be a louder version of the blocker.
//
// So the most valuable output here is not the bid recommendation. It is `steps`: what would
// unblock this contract, in the order it has to happen. That is work somebody can do tomorrow.
//
// ── WHAT THIS WILL NOT DO ────────────────────────────────────────────────────
//
// It does not bid, submit, email a contracting officer or commit the company. BID NOW means "a
// person should now decide", and the decision is recorded through opportunity_bid_reviews like
// every other. No column here can be mistaken for authorization.
'use strict';

const { usd } = require('./award-comparables');

const VERDICTS = Object.freeze(['BID NOW', 'PREPARE', 'WATCH', 'SKIP']);

// Inside this many days a confirmed, unblocked contract is urgent rather than merely open.
const URGENT_DAYS = 14;

// A step somebody can actually take, in the order it has to happen. Each carries who it belongs
// to, because "someone should confirm the deadline" is how a blocker survives a quarter.
function step(action, owner, detail) { return { action, owner, detail }; }

function daysUntil(deadline, now) {
  if (!deadline) return null;
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - (now instanceof Date ? now : new Date()).getTime()) / 86400000);
}

/**
 * Advise on one contract.
 *
 * Takes the row AS THE BOARD ALREADY SHAPES IT — relevance, pricing, feasibility, missing
 * evidence, deadline — so there is one definition of each fact rather than two that drift.
 *
 * @returns {{verdict, headline, why:string[], steps:object[], urgency, blocked_by:string[]}}
 */
function adviseOnContract(row, { now = new Date() } = {}) {
  const r = row || {};
  const rel = r.relevance || null;
  const pricing = r.pricing || null;
  const days = daysUntil(r.response_deadline, now);
  const why = [];
  const steps = [];
  const blocked = [];

  // ── 1. IS IT OUR WORK AT ALL ───────────────────────────────────────────
  if (rel && rel.verdict === 'NOT_RELEVANT') {
    return {
      verdict: 'SKIP',
      headline: 'Not our line of work.',
      why: rel.vetoes && rel.vetoes.length ? rel.vetoes.slice(0, 2) : (rel.reasons || []).slice(0, 2),
      steps: [],
      urgency: 'none',
      blocked_by: [],
      days_to_deadline: days,
    };
  }
  if (rel && rel.lines && rel.lines.length) {
    why.push(`Fits ${rel.lines.join(' and ').replace(/_/g, ' ')} (relevance ${rel.score}/100).`);
  }

  // ── 2. IS IT STILL LIVE ────────────────────────────────────────────────
  if (r.status && r.status !== 'open') {
    return {
      verdict: 'SKIP',
      headline: `Closed — status is ${r.status}.`,
      why: ['A contract that is no longer open cannot be bid, whatever it is worth.'],
      steps: [],
      urgency: 'none',
      blocked_by: [],
      days_to_deadline: days,
    };
  }
  if (days !== null && days < 0) {
    return {
      verdict: 'SKIP',
      headline: 'The response deadline has passed.',
      why: [`Closed ${Math.abs(days)} day(s) ago.`],
      steps: [],
      urgency: 'none',
      blocked_by: [],
      days_to_deadline: days,
    };
  }

  // ── 3. WHAT BARS US OUTRIGHT ───────────────────────────────────────────
  // A set-aside we cannot obtain is permanent. Saying "prepare" about it would be a lie with a
  // to-do list attached.
  const missing = r.missing_evidence || [];
  const unobtainable = missing.filter((m) => /Service-Disabled Veteran|SDVOSB|8\(a\)|HUBZone|Women-Owned/i.test(m));
  if (unobtainable.length) {
    return {
      verdict: 'SKIP',
      headline: 'Reserved for a certification Abiozen cannot obtain.',
      why: unobtainable.slice(0, 2),
      steps: [],
      urgency: 'none',
      blocked_by: unobtainable,
      days_to_deadline: days,
    };
  }

  // ── 4. THE TRADE AGREEMENTS ACT LINE ───────────────────────────────────
  const taa = pricing && pricing.trade_agreements;
  if (taa && taa.regime === 'taa') {
    blocked.push('Trade Agreements Act — non-designated origin');
    why.push('Above the TAA threshold, where product from India or China is generally barred.');
    steps.push(step(
      'Confirm country of origin and substantial transformation before investing in a proposal',
      'Naresh + government-contracts counsel',
      taa.note));
  }

  // ── 5. WHAT BLOCKS US THAT WE CAN CLEAR ────────────────────────────────
  const deadlineUnconfirmed = !r.deadline_confirmed;
  if (deadlineUnconfirmed) {
    blocked.push('response deadline not confirmed by a person');
    steps.push(step(
      'Open the notice and confirm the response deadline',
      'procurement',
      'Nothing is biddable until a named person confirms the closing date — an amendment resets it.'));
  }

  const evidenceGaps = missing.filter((m) => !unobtainable.includes(m));
  for (const gap of evidenceGaps.slice(0, 4)) {
    blocked.push(gap);
    if (/SAM\.gov entity registration/i.test(gap)) {
      steps.push(step('Renew the SAM.gov entity registration', 'Naresh', gap));
    } else if (/any verified capability at all/i.test(gap)) {
      const line = gap.split(':')[0];
      steps.push(step(
        `Record one piece of delivery evidence for ${line.replace(/_/g, ' ')}`,
        'Naresh',
        'A purchase order, an analytical services contract or a distribution agreement. One '
        + 'document unlocks every contract blocked on this line.'));
    } else {
      steps.push(step(`Close the gap: ${gap}`, 'procurement', gap));
    }
  }

  // ── 6. WHAT IT IS WORTH, AND WHAT TO ASK ───────────────────────────────
  if (pricing && pricing.bids && pricing.bids.available) {
    const byKey = Object.fromEntries(pricing.bids.strategies.map((s) => [s.key, s]));
    const comp = byKey.competitive;
    const mkt = byKey.market;
    why.push(
      `Comparable work is awarded around ${usd(mkt && mkt.point)} `
      + `(${pricing.benchmark.n.toLocaleString('en-US')} awards). `
      + `A competitive bid is ${usd(comp && comp.point)}.`);
  } else if (pricing) {
    why.push('No comparable award history yet, so there is no defensible bid figure for this one.');
  }

  // ── 7. THE VERDICT ─────────────────────────────────────────────────────
  let verdict;
  let headline;
  if (!blocked.length) {
    verdict = 'BID NOW';
    headline = days !== null && days <= URGENT_DAYS
      ? `Ready to bid and closing in ${days} day(s).`
      : 'Ready to bid.';
    steps.unshift(step(
      'Decide bid or no-bid and record the rationale',
      'Naresh',
      'Recorded on the board. Nothing is submitted by this system.'));
  } else if (taa && taa.regime === 'taa' && blocked.length === 1) {
    verdict = 'WATCH';
    headline = 'A real fit, but the supply chain may bar it.';
  } else if (blocked.some((b) => /registration/i.test(b)) && blocked.length === 1) {
    verdict = 'PREPARE';
    headline = 'One renewal away from biddable.';
  } else {
    verdict = 'PREPARE';
    headline = blocked.length === 1
      ? 'One thing stands between this and a bid.'
      : `${blocked.length} things stand between this and a bid.`;
  }

  const urgency = days === null ? 'unknown'
    : days <= 7 ? 'this week'
      : days <= URGENT_DAYS ? 'two weeks'
        : days <= 45 ? 'this month' : 'later';

  return { verdict, headline, why, steps, urgency, blocked_by: blocked, days_to_deadline: days };
}

/**
 * The board, ordered the way a person should work it: what is ready and closing soonest, then
 * what is nearly ready, then the rest. Deliberately NOT ordered by contract value — the largest
 * contract on a board is routinely the one we are least able to deliver.
 */
const VERDICT_RANK = Object.freeze({ 'BID NOW': 0, PREPARE: 1, WATCH: 2, SKIP: 3 });

function prioritise(rows, { now = new Date() } = {}) {
  return (rows || [])
    .map((r) => ({ row: r, advice: adviseOnContract(r, { now }) }))
    .sort((a, b) => {
      const v = VERDICT_RANK[a.advice.verdict] - VERDICT_RANK[b.advice.verdict];
      if (v !== 0) return v;
      const ad = a.advice.days_to_deadline;
      const bd = b.advice.days_to_deadline;
      if (ad === null && bd === null) return 0;
      if (ad === null) return 1;
      if (bd === null) return -1;
      return ad - bd;
    });
}

/**
 * What would unblock the MOST contracts, counted across the whole board.
 *
 * The single most useful number here. One recorded purchase order is worth more than any amount
 * of per-row scoring when it is the thing holding back a hundred rows, and that is invisible
 * looking at any single contract.
 */
function unblockingLeverage(rows, { now = new Date() } = {}) {
  const counts = new Map();
  for (const r of rows || []) {
    const a = adviseOnContract(r, { now });
    if (a.verdict === 'SKIP') continue;
    for (const b of a.blocked_by) {
      // Group registration-renewal blockers, which differ only by the date each contract needs.
      const key = /SAM\.gov entity registration/i.test(b)
        ? 'SAM.gov entity registration must be renewed'
        : b;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([blocker, contracts]) => ({ blocker, contracts }))
    .sort((a, b) => b.contracts - a.contracts);
}

module.exports = {
  adviseOnContract,
  prioritise,
  unblockingLeverage,
  VERDICTS,
  URGENT_DAYS,
};
