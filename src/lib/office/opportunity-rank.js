// ── RANKING: WHAT TO LOOK AT NEXT, NOT WHAT WE WILL WIN ──────────────────────
//
// Ruling 23 item 8: rank by eligibility, technical fit, verified fulfilment capability, response
// deadline, estimated margin where supportable, and execution risk. "Missing evidence must produce
// NEEDS_REVIEW, not QUALIFIED."
//
// ── WHAT A RANK HERE IS, AND IS NOT ──────────────────────────────────────────
//
// It is an ordering of where a person's attention goes first. It is NOT a probability of winning,
// a forecast, or a recommendation to bid. Nothing in this file authorises anything, and the score
// is deliberately not rendered as a percentage, because a percentage invites being read as a
// likelihood.
//
// ── THE TWO RULES THAT SHAPE THE SCORE ───────────────────────────────────────
//
// 1. AN ELIGIBILITY BAR IS NOT A PENALTY, IT IS A FLOOR. A set-aside we cannot meet, or an
//    OEM-authorisation requirement we cannot satisfy, drops the opportunity below everything that
//    is merely unattractive. Weighting it as "minus thirty points" would let a large ceiling buy
//    its way back above an eligible contract, which is how a ranked list ends up recommending
//    something it is illegal for us to bid.
//
// 2. MARGIN IS SCORED ONLY WHERE IT IS SUPPORTABLE, AND IT ALMOST NEVER IS. Two facts make it
//    unsupportable today: the SAM search index does not carry estimated value at all, and we hold
//    no supplier quote for anything. A margin component computed from an absent price and an
//    absent cost would be a number with no measurement behind it, and the one thing worse than no
//    estimate is a confident one. So `margin` contributes 0 and reports WHY, rather than being
//    silently omitted.
'use strict';

const { isoDay } = require('./iso-day');
const { BIDDABLE_NOTICE_TYPES } = require('./opportunity-schema');

// Manufacturers whose consumables are routinely brand-locked in federal buys. Presence of the name
// in a title or description is a SIGNAL TO CHECK, never a conclusion — the finding that
// 36C25627Q0074 is unrestricted despite being a Roche buy is exactly why this cannot be a verdict.
const BRAND_LOCK_HINTS = [
  'roche', 'ventana', 'abbott', 'architect', 'beckman', 'siemens healthineers',
  'thermo fisher', 'bio-rad', 'sysmex', 'ortho clinical', 'cepheid', 'hologic',
];

// Language that means the Government has already chosen a supplier. A notice carrying this is not
// an opportunity to bid, whatever its notice type says — the first ranked run put "Notice of
// Intent to Sole Source" at the top of the WORK NOW tier, which is the sort of recommendation that
// wastes a day before anyone reads the title properly.
//
// "Brand name or equal" is deliberately NOT in this list: an "or equal" notice invites equivalents
// and is competed. It raises risk, it does not bar.
const SOLE_SOURCE_PATTERNS = [
  /notice of intent to sole[- ]source/i,
  /intent to (award|negotiate).{0,40}(sole[- ]source|non-?competitiv)/i,
  /\bsole[- ]source\b(?!.{0,30}\bor equal\b)/i,
  /only one responsible source/i,
  /FAR\s*6\.302/i,
  /non-?competitive (award|basis)/i,
  /intends to (award|negotiate) .{0,60}\bwithout\b.{0,30}competition/i,
];

const BAR_KINDS = Object.freeze({
  SET_ASIDE: 'set_aside_not_held',
  OEM_LETTER: 'oem_authorization_required',
  SOLE_SOURCE: 'sole_source_or_intent_to_award_stated',
  NOT_BIDDABLE: 'notice_type_not_biddable',
  DEADLINE_PASSED: 'deadline_passed',
});

/** Days until the deadline, or null when there is no usable deadline. */
function daysUntil(deadline, today) {
  const d = isoDay(deadline);
  if (!d) return null;
  return Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5);
}

/**
 * Score one opportunity.
 *
 * @param {object} opp      a tracker row, ideally with its latest assessment joined
 * @param {object} ctx      { today, verification }  — verification is the human-read findings,
 *                          keyed by solicitation number, when we have read the actual notice
 * @returns {{score, tier, bars, components, notes}}
 */
function rank(opp, ctx = {}) {
  const today = ctx.today || new Date().toISOString().slice(0, 10);
  const verified = (ctx.verification && ctx.verification[opp.solicitation_number]) || null;
  const bars = [];
  const notes = [];
  const components = {};

  // ── hard bars ────────────────────────────────────────────────────────────
  // A SOURCES SOUGHT IS NOT A BAR. Responding to one is how a company gets onto the list for the
  // RFP that follows, and it is often the only entry point into a recompete. Barring it conflates
  // "you cannot bid on this" with "there is nothing here to do" — and it buried the single best
  // custom-synthesis match on the whole board at position 198.
  //
  // It is not a bid either, so it gets its own tier rather than competing with solicitations.
  const marketEntry = opp.notice_type === 'sources_sought' || opp.notice_type === 'presolicitation';
  if (!BIDDABLE_NOTICE_TYPES.includes(opp.notice_type) && !marketEntry) {
    bars.push({ kind: BAR_KINDS.NOT_BIDDABLE, detail: `notice type is ${opp.notice_type}` });
  }
  if (marketEntry) {
    notes.push(opp.notice_type === 'sources_sought'
      ? 'SOURCES SOUGHT — a response is market research, not a bid, and is how you reach the RFP'
      : 'PRESOLICITATION — the RFP has not issued; this is advance warning');
  }
  const dleft = daysUntil(opp.response_deadline, today);
  if (dleft !== null && dleft < 0) {
    bars.push({ kind: BAR_KINDS.DEADLINE_PASSED, detail: `closed ${Math.abs(dleft)} day(s) ago` });
  }
  // A sole-source or intent-to-award notice. The Government has picked a supplier; responding is
  // not bidding. Detected from the notice's own words, and the matched phrase is reported so a
  // reader can check the call rather than trust it.
  const soleHay = `${opp.title || ''} ${opp.description || ''}`;
  const sole = SOLE_SOURCE_PATTERNS.find((re) => re.test(soleHay));
  if (sole) {
    const m = soleHay.match(sole);
    bars.push({ kind: BAR_KINDS.SOLE_SOURCE, detail: `the notice says: "${String(m[0]).slice(0, 70)}"` });
  }

  // A set-aside we do not hold. Taken from the human verification where we have one, because the
  // search index's set-aside text alone cannot tell us whether WE hold the certification.
  if (verified && verified.eligible === false) {
    bars.push({ kind: verified.bar && /OEM|authoriz/i.test(verified.bar) ? BAR_KINDS.OEM_LETTER : BAR_KINDS.SET_ASIDE,
      detail: verified.bar || 'verified as not eligible' });
  } else if (!verified && opp.set_aside && /set-aside|set aside/i.test(opp.set_aside)) {
    // Unverified: a restriction we have NOT yet checked is a reason to look sooner, not a bar.
    notes.push(`restricted: "${String(opp.set_aside).slice(0, 60)}" — eligibility NOT yet verified against the notice`);
  }

  // ── eligibility ──────────────────────────────────────────────────────────
  components.eligibility = bars.length ? 0 : (verified && verified.eligible ? 30 : 20);
  if (!verified) notes.push('eligibility not confirmed against the official notice');

  // ── technical fit: which Abiozen lines the engine matched ────────────────
  const lines = opp.business_lines || [];
  // Depth, not breadth. Matching one line squarely is worth more than brushing two, so the first
  // line scores most and further lines add little. Counting lines linearly ranked a lab-equipment
  // buy that touched two lines above the VA's reference-laboratory schedule that squarely hits one.
  components.technical_fit = lines.length ? 12 + Math.min(lines.length - 1, 2) * 2 : 0;
  if (!lines.length) notes.push('no Abiozen business line matched');

  // ── verified fulfilment capability ───────────────────────────────────────
  // The verdict is the engine's, and it is NEEDS_REVIEW for everything while the registry is
  // empty. QUALIFIED is the only state that scores here, and it is currently unreachable — which
  // is the correct representation of the company's position, not a defect in the ranking.
  components.verified_capability = opp.verdict === 'QUALIFIED' ? 25
    : opp.verdict === 'NEEDS_REVIEW' ? 5 : 0;
  if (opp.verdict !== 'QUALIFIED') {
    notes.push(`verdict ${opp.verdict || 'NOT ASSESSED'} — no verified capability supports this yet`);
  }

  // ── deadline: enough time to act, but not so far it is not yet real ──────
  if (dleft === null) { components.deadline = 0; notes.push('no usable response deadline'); }
  else if (dleft < 0) components.deadline = 0;
  else if (dleft <= 3) { components.deadline = 2; notes.push(`only ${dleft} day(s) left — too little time to assemble a compliant quote`); }
  else if (dleft <= 10) components.deadline = 12;
  else if (dleft <= 30) components.deadline = 15;
  else if (dleft <= 90) components.deadline = 10;
  else { components.deadline = 6; notes.push(`${dleft} days out — worth watching rather than working`); }

  // ── contract vehicle ─────────────────────────────────────────────────────
  // A Federal Supply Schedule, BPA, IDIQ or catalog programme is worth more than a one-off
  // purchase order of the same size, because one win yields recurring orders without re-competing
  // from scratch. The first ranked run put a UV laser slide printer above the VA's reference
  // laboratory testing schedule, which is the wrong way round for a company trying to establish a
  // federal presence.
  const vhay = `${opp.title || ''} ${opp.description || ''}`;
  if (/federal supply schedule|\bFSS\b|RFP-?797-?FSS|multiple award schedule|\bMAS\b/i.test(vhay)) {
    components.vehicle = 14; notes.push('Federal Supply Schedule — a standing vehicle, not a one-off buy');
  } else if (/blanket purchase agreement|\bBPA\b|electronic catalog|\bECAT\b|catalog program/i.test(vhay)) {
    components.vehicle = 12; notes.push('BPA or catalog programme — recurring orders once listed');
  } else if (/\bIDIQ\b|indefinite[- ]delivery|\bMATOC\b|multiple award task order/i.test(vhay)) {
    components.vehicle = 8; notes.push('IDIQ — multi-year ordering vehicle');
  } else components.vehicle = 0;

  // ── margin: scored only where supportable ────────────────────────────────
  components.margin = 0;
  if (opp.estimated_value_usd === null || opp.estimated_value_usd === undefined) {
    notes.push('MARGIN NOT SCORED: the SAM search index carries no estimated value for this notice');
  } else if (!ctx.haveSupplierQuote) {
    notes.push('MARGIN NOT SCORED: a contract value without a supplier quote gives revenue, not margin');
  }

  // ── execution risk ───────────────────────────────────────────────────────
  let risk = 0;
  const hay = `${opp.title || ''} ${opp.description || ''}`.toLowerCase();
  const brand = BRAND_LOCK_HINTS.find((b) => hay.includes(b));
  if (brand) {
    risk += 20;
    notes.push(`names "${brand}" — proprietary consumables usually need an OEM supply route; CHECK the notice, do not assume`);
  }
  if (verified && verified.open_questions && verified.open_questions.length) {
    risk += 10;
    notes.push(`${verified.open_questions.length} unresolved contradiction(s) in the solicitation text`);
  }
  if (verified && verified.deadline_conflict) {
    risk += 15;
    notes.push('the notice and its own amendment disagree about the deadline');
  }
  if (dleft !== null && dleft >= 0 && dleft <= 7) risk += 10;
  components.execution_risk = -Math.min(risk, 40);

  const score = Object.values(components).reduce((a, b) => a + b, 0);

  // Tiers, so a reader never has to interpret the number.
  let tier;
  if (bars.length) tier = 'BARRED';
  else if (marketEntry) tier = 'MARKET ENTRY';
  else if (score >= 55) tier = 'WORK NOW';
  else if (score >= 35) tier = 'REVIEW';
  else tier = 'WATCH';

  return { score, tier, bars, components, notes };
}

/** Rank a list. Barred items sort last regardless of score — see rule 1 above. */
function rankAll(rows, ctx = {}) {
  return rows
    .map((r) => ({ ...r, ranking: rank(r, ctx) }))
    .sort((a, b) => {
      const grade = (r) => (r.ranking.bars.length ? 2 : r.ranking.tier === 'MARKET ENTRY' ? 1 : 0);
      const ga = grade(a); const gb = grade(b);
      if (ga !== gb) return ga - gb;
      if (b.ranking.score !== a.ranking.score) return b.ranking.score - a.ranking.score;
      const da = daysUntil(a.response_deadline, ctx.today || new Date().toISOString().slice(0, 10));
      const db = daysUntil(b.response_deadline, ctx.today || new Date().toISOString().slice(0, 10));
      return (da === null ? 9999 : da) - (db === null ? 9999 : db);
    });
}

module.exports = { BAR_KINDS, BRAND_LOCK_HINTS, SOLE_SOURCE_PATTERNS, daysUntil, rank, rankAll };
