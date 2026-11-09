// ── WHAT HAS THE GOVERNMENT ACTUALLY PAID FOR THIS KIND OF WORK? ─────────────
//
// A solicitation says what an agency wants. It rarely says what it expects to pay — of 149 live
// solicitations on the board, ZERO carried an estimated value. So the only honest answer to "how
// much should we bid" comes from what comparable work has actually been awarded for.
//
// This module is the arithmetic. It holds no network calls and no database, so the one thing that
// matters here — that a number put in front of the owner is defensible — can be tested directly.
//
// ── WHY NOT FPDS, WHICH IS THE OBVIOUS SOURCE ────────────────────────────────
//
// Measured 2026-11-09, FPDS Atom feed, PSC Q301, 2024-2026:
//
//     entries            10
//     base awards         1
//     modifications       9
//     negative amounts    6
//
// Nine in ten rows are contract MODIFICATIONS, and six carry NEGATIVE obligations — money handed
// back. An average over that feed returns something close to zero and looks entirely plausible on
// a dashboard. USAspending's award search returns base award values instead, which is why the
// fetcher uses it.
//
// ── WHY A DISTRIBUTION AND NOT AN AVERAGE ────────────────────────────────────
//
// PSC Q301 is "medical laboratory testing". Real awards under it, same code, same period:
//
//     $821,303,840   WALGREEN CO.          (pandemic pharmacy)
//     $133,905,814   AMERICAN TYPE CULTURE COLLECTION
//          $10,000   a single lab order
//
// A mean of those is a number that describes no contract that has ever existed. So: median and
// quartiles, never a mean; and where the target contract's own size is known, comparables are
// narrowed to the same order of magnitude before any of it is computed.
//
// ── THE REFUSAL ──────────────────────────────────────────────────────────────
//
// Below MIN_COMPARABLES awards, this returns no bid range at all — not a wider one, not a
// caveated one. A bid figure resting on two data points is a guess wearing a decimal point, and
// the owner would be pricing real work against it.
'use strict';

// Fewer than this and there is no range. Five is not statistical rigour; it is the floor below
// which a median is obviously meaningless to anyone who looks at the inputs.
const MIN_COMPARABLES = 5;

// Comparables are kept within this multiple of the target value, in both directions, when a
// target is known. An order of magnitude is deliberately generous — the point is to exclude the
// $800M pandemic contract from a $50k lab order's comparables, not to fine-tune.
const BAND_FACTOR = 10;

/**
 * Percentile by linear interpolation, on a sorted ascending array.
 * p is 0..1. Returns null for an empty array rather than NaN, because NaN formats as "NaN" on a
 * dashboard and null can be rendered as "unknown".
 */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Describe a set of comparable award amounts.
 *
 * @param {number[]} amounts  award values in USD
 * @param {object}   opts     { near } — the target contract's own value, when known
 * @returns {{n:number, median:number|null, p25:number|null, p75:number|null,
 *            min:number|null, max:number|null, banded:boolean, excluded:number}}
 */
function describeAwards(amounts, { near = null } = {}) {
  // A zero or negative award is not a comparable. Zeros appear where a value was never populated,
  // and treating "not recorded" as "$0" drags a median toward nothing.
  let usable = (amounts || [])
    .map((a) => (typeof a === 'string' ? Number(a) : a))
    .filter((a) => Number.isFinite(a) && a > 0);

  const beforeBand = usable.length;
  let banded = false;
  if (near && Number.isFinite(near) && near > 0) {
    const lo = near / BAND_FACTOR;
    const hi = near * BAND_FACTOR;
    const inBand = usable.filter((a) => a >= lo && a <= hi);
    // Only apply the band if it leaves enough to work with. A band that empties the set has told
    // us the target is unlike anything comparable, which is better reported as a wide distribution
    // than as no answer at all.
    if (inBand.length >= MIN_COMPARABLES) { usable = inBand; banded = true; }
  }

  const sorted = usable.slice().sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: percentile(sorted, 0.5),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    min: sorted.length ? sorted[0] : null,
    max: sorted.length ? sorted[sorted.length - 1] : null,
    banded,
    excluded: beforeBand - sorted.length,
  };
}

// The three positions, owner decision 2026-11-09. Presented together rather than as one
// recommendation, because which one fits is a judgement about the specific contract — incumbency,
// how badly the work is wanted, what else is in the pipeline that quarter — and none of that is
// visible from an award history.
//
// Every strategy carries `low` and `high`. A single-point position sets them equal, so a caller
// renders one shape and never has to branch on which kind of strategy it received.
const STRATEGIES = Object.freeze([
  {
    key: 'competitive',
    label: 'Compete on price',
    at: (s) => [s.p25, s.p25],
    note: 'Three in four comparable awards went for more than this. Priced to displace an '
        + 'incumbent; thinnest margin.',
  },
  {
    key: 'market',
    label: 'Market rate',
    at: (s) => [s.median, s.median],
    note: 'The midpoint of what this work is actually awarded for. Neither cheap nor a stretch.',
  },
  {
    key: 'value',
    label: 'Price on value',
    at: (s) => [s.median, s.p75],
    note: 'Above the midpoint, inside the normal range. Wins on capability rather than cost, and '
        + 'needs evidence to carry it.',
  },
]);

/**
 * The three bid positions, or an honest refusal.
 *
 * @returns {{available:true, n:number, banded:boolean, basis:string, strategies:object[]}
 *          |{available:false, why:string, n:number, strategies:[]}}
 */
function suggestBids(stats) {
  if (!stats || stats.n < MIN_COMPARABLES) {
    const n = (stats && stats.n) || 0;
    return {
      available: false,
      n,
      strategies: [],
      why: `insufficient comparable data — ${n} comparable award(s), ${MIN_COMPARABLES} needed`,
    };
  }
  const basis = `${stats.n} comparable award(s)`
    + (stats.banded ? ', narrowed to awards of similar size' : '');
  return {
    available: true,
    n: stats.n,
    banded: stats.banded,
    basis,
    strategies: STRATEGIES.map((s) => {
      const [low, high] = s.at(stats);
      return {
        key: s.key,
        label: s.label,
        low,
        high,
        point: low === high ? low : null,
        note: s.note,
        basis,
      };
    }),
  };
}

// ── THE TRADE AGREEMENTS ACT LINE ────────────────────────────────────────────
//
// Abiozen sources molecules from India and China. NEITHER is a TAA-designated country: India has
// observer status at the WTO Government Procurement Agreement and never joined; China is not a
// party and has no qualifying FTA.
//
// Above the TAA threshold, end products from non-designated countries are generally BARRED, not
// merely disfavoured. Below it the Buy American Act applies instead — a price preference, which
// foreign-origin product can still win against.
//
// So this single number decides whether a contract is even bid-able with the current supply
// chain, and it belongs on the row beside the price. A week spent writing a proposal that was
// ineligible from the first day is the waste this prevents.
//
// $174,000 is the 2026-27 supply threshold under FAR 25.402(b). It is adjusted periodically — if
// it is wrong, the fix is this constant, and it is deliberately one constant rather than a
// literal scattered through the rendering code.
//
// NOT LEGAL ADVICE, and the code says so where it is displayed. Country of origin turns on
// substantial transformation, services originate where they are performed, and a non-availability
// exception exists. This flags the question; it does not answer it.
const TAA_SUPPLY_THRESHOLD_USD = 174000;

/**
 * Which regime a contract of this size falls under, given Abiozen's non-designated sourcing.
 * A null value yields 'unknown' — never a reassuring default.
 */
function taaPosture(valueUsd) {
  if (valueUsd == null || !Number.isFinite(valueUsd)) {
    return {
      regime: 'unknown',
      threshold: TAA_SUPPLY_THRESHOLD_USD,
      note: 'no value known for this contract, so the applicable regime cannot be determined',
    };
  }
  if (valueUsd >= TAA_SUPPLY_THRESHOLD_USD) {
    return {
      regime: 'taa',
      threshold: TAA_SUPPLY_THRESHOLD_USD,
      note: 'at or above the Trade Agreements Act threshold — end products from India and China '
          + 'are generally barred. Confirm origin and substantial transformation before bidding.',
    };
  }
  return {
    regime: 'buy_american',
    threshold: TAA_SUPPLY_THRESHOLD_USD,
    note: 'below the Trade Agreements Act threshold — Buy American applies as a price preference, '
        + 'not a prohibition. Non-designated origin can still win.',
  };
}

/** Whole dollars, with separators. Null-safe: returns null so a caller can render "unknown". */
function usd(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

module.exports = {
  describeAwards,
  suggestBids,
  taaPosture,
  TAA_SUPPLY_THRESHOLD_USD,
  STRATEGIES,
  percentile,
  usd,
  MIN_COMPARABLES,
  BAND_FACTOR,
};
