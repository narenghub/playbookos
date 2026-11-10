// ── THE FEDERAL BOARD, BUILT IN ONE PLACE ────────────────────────────────────
//
// This is a pure MOVE out of src/api/prpa.routes.js. The pipeline — list, assess relevance, filter
// to the actionable window, load benchmarks, rank, shape, advise — lived inside the GET handler, so
// it was reachable only by making an HTTP request.
//
// ── WHY IT HAD TO COME OUT ───────────────────────────────────────────────────
//
// The decision queue needs to know which federal notices need action, and that is this pipeline's
// answer. Asking the question a second way — a simpler query against the tracker, say — would
// produce a SECOND definition of "needs action". Two definitions of the same thing on two screens
// is the drift this repository has already paid for: the board and the detail view used to shape
// rows separately and `r.decision` was read where the column is aliased `bid_decision`, so a
// recorded bid decision never appeared on the board while the API reported it saved.
//
// The route keeps everything that is about HTTP — query-string parsing, the dataset header, the
// response envelope. What is here is what decides.
//
// NOTHING ABOUT BEHAVIOUR CHANGED IN THE MOVE. Same order, same defaults (`actionable`, 90 days),
// same tolerance of a missing psc_award_benchmarks table, same `benchmarksArg instanceof Map`
// guard — that guard exists because `open.map(shapeForBoard)` passed Array.map's index as the
// second argument, the default never applied, and /review-queue answered 500.

'use strict';

const T = require('./opportunity-tracker');
const REG = require('./capability-registry');
const RANK = require('./opportunity-rank');
const ADVICE = require('./contract-advice');
const COMP = require('./award-comparables');
const { relevantLines } = require('./opportunity-qualify');
const { assessRelevance } = require('./opportunity-relevance');
const { isoDay } = require('./iso-day');

const DEFAULT_HORIZON_DAYS = 90;

// ── WHAT THEY PAY, AND WHAT WE SHOULD ASK ────────────────────────────────────
//
// `their_amount` is what the solicitation states, which on this board is almost never anything:
// of 149 harvested solicitations, ZERO carried an estimated value. So the usable figure is the
// benchmark — what the government has actually awarded for this product service code.
//
// The three positions are the owner's decision of 2026-11-09: compete on price, market rate,
// price on value. Below five comparable awards there are NO positions, only the reason.
function pricingFor(r, benchmarks) {
  const stated = r.estimated_value_usd == null ? null : Number(r.estimated_value_usd);
  const b = benchmarks.get(r.psc_code);

  if (!b || b.median_usd == null) {
    return {
      their_amount: stated,
      their_amount_published: stated != null,
      benchmark: b ? { psc: r.psc_code, n: b.award_count, as_of: b.computed_at } : null,
      bids: {
        available: false,
        strategies: [],
        why: b
          ? `insufficient comparable data — ${b.award_count} comparable award(s) for PSC ${r.psc_code}`
          : `no award benchmark cached for PSC ${r.psc_code || '(none)'}`,
      },
      // The regime still matters even with no price: a stated value can decide it on its own.
      trade_agreements: COMP.taaPosture(stated),
    };
  }

  const stats = {
    n: b.award_count,
    p25: Number(b.p25_usd),
    median: Number(b.median_usd),
    p75: Number(b.p75_usd),
    banded: false,
  };
  const bids = COMP.suggestBids(stats);

  // The regime is judged on the best figure available: what they stated if they stated it,
  // otherwise what this kind of work is actually awarded for.
  const forRegime = stated != null ? stated : stats.median;

  return {
    their_amount: stated,
    their_amount_published: stated != null,
    benchmark: {
      psc: r.psc_code,
      n: stats.n,
      p25: stats.p25,
      median: stats.median,
      p75: stats.p75,
      as_of: b.computed_at,
      source: 'usaspending',
    },
    bids,
    trade_agreements: {
      ...COMP.taaPosture(forRegime),
      judged_on: stated != null ? 'the stated value' : 'the median comparable award',
      // Stated plainly because it is displayed beside a dollar figure, where it reads as advice.
      disclaimer: 'Indicative only, not legal advice. Country of origin turns on substantial '
                + 'transformation and a non-availability exception exists.',
    },
  };
}

// Exactly the columns ruling 27 item 2 names, plus what is needed to act on a row. Shaped in one
// place so the board, the detail view, the export and now the decision queue cannot drift apart.
//
// `benchmarks` is a Map of psc_code → cached benchmark row. Callers that have no benchmarks pass
// nothing; the guard below tolerates that AND tolerates a caller that accidentally passes
// something else, because this function is used from several places and one of them already got it
// wrong once — see the note at the top of this file.
function shapeForBoard(r, benchmarksArg) {
  const benchmarks = benchmarksArg instanceof Map ? benchmarksArg : new Map();
  const feas = r.ranking.feasibility;
  return {
    id: r.id,
    solicitation_number: r.solicitation_number,
    notice_id: r.notice_id,
    title: r.title,
    agency: r.agency || null,
    // An unpopulated agency is reported as unconfirmed rather than blank: SAM's search index leaves
    // this empty for some notices, and a blank cell reads as "no agency" instead of "not stated".
    agency_confirmed: Boolean(r.agency),
    sub_agency: r.sub_agency || null,
    office: r.office || null,
    naics_code: r.naics_code || null,
    psc_code: r.psc_code || null,
    notice_type: r.notice_type,
    status: r.status,
    set_aside: r.set_aside || null,
    set_aside_stated: Boolean(r.set_aside),
    response_deadline: isoDay(r.response_deadline),
    deadline_confirmed: Boolean(r.deadline_confirmed_at),
    deadline_confirmed_at: r.deadline_confirmed_at || null,
    deadline_source_text: r.deadline_source_text || null,
    is_biddable: r.is_biddable,
    estimated_value_usd: r.estimated_value_usd || null,
    place_of_performance: r.place_of_performance || null,
    source_url: r.source_url || null,

    // "Required products/services" — what the notice asks for, as far as the notice says. The
    // product class IS the answer to that question when it resolves, and 'unknown' is reported as
    // unknown rather than dressed up.
    requested: {
      product_class: feas.product_class,
      basis: feas.basis,
      manufacturer: feas.manufacturer || null,
      description_available: Boolean(r.description && String(r.description).trim()),
      excerpt: r.description ? String(r.description).replace(/\s+/g, ' ').trim().slice(0, 400) : null,
    },

    feasibility: {
      verdict: feas.verdict,
      confidence: feas.confidence,
      blockers: feas.blockers,
      checks: feas.checks,
    },
    missing_evidence: feas.unknowns || [],

    // Why this row is on the board at all, carried with it so a reviewer can disagree with the
    // engine rather than wonder what it did.
    relevance: r.relevance ? {
      verdict: r.relevance.verdict,
      score: r.relevance.score,
      lines: r.relevance.lines,
      reasons: r.relevance.reasons,
      vetoes: r.relevance.vetoes,
    } : null,

    pricing: pricingFor(r, benchmarks),

    qualification: {
      verdict: r.verdict || null,
      evidence_basis: r.evidence_basis || null,
      business_lines: r.business_lines || [],
      reasons: r.reasons || [],
      missing_requirements: r.missing_requirements || [],
    },

    ranking: {
      score: r.ranking.score,
      tier: r.ranking.tier,
      bars: r.ranking.bars,
      flags: r.ranking.flags || [],
      notes: r.ranking.notes,
      components: r.ranking.components,
    },

    // listOpportunities ALIASES the review columns (bid_decision, bid_decided_by, …) because the
    // assessment join already supplies `verdict` and a bare `decision` would be ambiguous beside
    // it. Reading r.decision returned undefined for every row, so a recorded decision never
    // appeared on the board — the API said it was saved and the board showed nothing.
    review: r.bid_decision ? {
      decision: r.bid_decision,
      decided_by: r.bid_decided_by,
      decided_at: r.bid_decided_at,
      rationale: r.bid_rationale,
    } : null,
  };
}

/**
 * Load the award benchmarks for a set of PSC codes in ONE query rather than one per row.
 *
 * A database that has not run the connector migration has no psc_award_benchmarks table. A board
 * without prices is still a board; a board that 500s is not — so the failure is recorded in the
 * Map under `__error` and the caller decides what to say about it.
 */
async function loadBenchmarks(queryFn, pscs) {
  const benchmarks = new Map();
  if (!pscs.length) return benchmarks;
  try {
    const b = await queryFn(
      `SELECT psc_code, award_count, p25_usd, median_usd, p75_usd, computed_at
         FROM psc_award_benchmarks
        WHERE psc_code = ANY($1) AND naics_code = '' AND window_years = 3`, [pscs]);
    for (const row of b.rows) benchmarks.set(row.psc_code, row);
  } catch (e) {
    benchmarks.set('__error', e.message);
  }
  return benchmarks;
}

/**
 * Build the board.
 *
 * ── THE BOARD SHOWS WORK, NOT EVERYTHING WE HARVESTED ──────────────────────
 *
 * Owner instruction 2026-11-09: "If you could fetch like 10, 20 high level actively the contract
 * active in a current market, it's purely fit with my business model."
 *
 * Of 149 harvested solicitations, 69 were R&D for defense systems — metal castings, test ranges,
 * ship simulators. A queue where seven in ten rows are noise is a queue nobody reads.
 *
 * Nothing is deleted or hidden: every row keeps its relevance verdict and reasons, and
 * scope 'all' returns the unfiltered board. The default is simply the work.
 *
 * @returns {{opportunities:Array, meta:Object}}
 */
async function buildBoard(queryFn, companyId, {
  filters = {},
  scope = 'actionable',
  horizonDays = DEFAULT_HORIZON_DAYS,
  now = new Date(),
} = {}) {
  if (!companyId) throw new Error('buildBoard requires a companyId: every kernel table is company-welded');

  const today = isoDay(now);
  const rows = await T.listOpportunities(queryFn, companyId, filters);
  const caps = await REG.activeCapabilities(queryFn, companyId, { today });
  const horizon = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

  const withRelevance = rows.map((r) => ({ ...r, relevance: assessRelevance(r) }));
  const onBoard = scope === 'all' ? withRelevance : withRelevance.filter((r) => {
    if (r.relevance.verdict !== 'RELEVANT') return false;
    if (r.status !== 'open') return false;
    // A deadline we do not know is kept: unknown is not expired, and dropping it would hide a live
    // contract because of a gap in OUR record rather than anything about the contract.
    if (!r.response_deadline) return true;
    const due = new Date(r.response_deadline);
    return due >= now && due <= horizon;
  });

  const pscs = [...new Set(onBoard.map((r) => r.psc_code).filter(Boolean))];
  const benchmarks = await loadBenchmarks(queryFn, pscs);

  // business_lines comes from the qualify engine's line matcher, not from the stored assessment:
  // assess() returns an empty line list for a sources-sought notice because there is nothing to bid
  // on, and feeding that to rank() would zero the fit score for the very notices that are the way
  // in to a recompete.
  const enriched = onBoard.map((r) => ({ ...r, business_lines: r.business_lines || relevantLines(r).lines }));
  const ranked = RANK.rankAll(enriched, { today, capabilities: caps, supplierQuotes: {} });

  // Shape first, then advise on the shaped row. The advice engine reads the board's own fields —
  // relevance, pricing, deadline_confirmed, missing_evidence — so there is ONE definition of each
  // fact rather than two that drift apart.
  const opportunities = ranked.map((r) => {
    const row = shapeForBoard(r, benchmarks);
    row.advice = ADVICE.adviseOnContract(row, { now });
    return row;
  });

  return {
    opportunities,
    meta: {
      today,
      verified_capabilities: caps.length,
      count: ranked.length,
      // What would unblock the MOST contracts ON THIS BOARD — the actionable window, not the whole
      // harvest. The single most useful number here and invisible from any one row: one recorded
      // purchase order is worth more than any amount of per-row scoring when it is the thing
      // holding back a dozen of them.
      leverage: ADVICE.unblockingLeverage(opportunities, { now }).slice(0, 6),
      scope,
      horizon_days: scope === 'all' ? null : horizonDays,
      harvested: rows.length,
      shown: ranked.length,
      filtered_out: rows.length - ranked.length,
      relevance_breakdown: withRelevance.reduce((acc, r) => {
        acc[r.relevance.verdict] = (acc[r.relevance.verdict] || 0) + 1;
        return acc;
      }, {}),
      benchmarks_loaded: benchmarks.size,
    },
  };
}

module.exports = { buildBoard, shapeForBoard, pricingFor, loadBenchmarks, DEFAULT_HORIZON_DAYS };
