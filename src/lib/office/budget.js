// PlayNexa AI Office — K5: the budget mechanism. BUILT AND TESTED; ACTIVATION IS A SEPARATE RULING.
//
// Nothing in this file is wired to a call path. `enforce()` has no production caller, so no
// autonomous work is refused today. That is deliberate: "Build and adversarially test it now.
// Activation remains the separate decision."
//
// ── THE POLICY ──────────────────────────────────────────────────────────────
//
//   $100/day enterprise · 50% informational · 75% warning · 90% critical · 100% refuse
//   noncritical autonomous AI.
//
// ── THE HARD PART: UNKNOWN COST MAY NOT BECOME A NUMBER ─────────────────────
//
// Two instructions constrain each other.
//
//   "Unknown cost must not silently bypass future budget enforcement."
//   "No estimated 'daily spend' derived from invocation counts."
//
// So an unmeasured call can neither be ignored NOR converted into dollars. Charging unknown calls
// a guessed ceiling would satisfy the first and violate the second, and would put a fabricated
// figure into the one number the CEO is meant to trust.
//
// The resolution: the measured spend is reported as what it is — A LOWER BOUND — and the presence
// of unmeasured calls is carried as a first-class property (`confident: false`) rather than folded
// into the total. A budget that cannot prove it is under its cap says so instead of asserting it.
//
//   • `spendKnownUsd` is the sum of measured costs. It is never inflated by an estimate.
//   • `unknownCalls` is counted and surfaced beside it.
//   • when unknownCalls > 0 the assessment is NOT confident, and the tier is RAISED BY ONE level,
//     because unmeasured spend is a reason for more caution and not less. No dollar figure is
//     invented to achieve that.
//   • `refuseOnUnmeasured` (default false) is the knob for the stricter policy — refuse
//     noncritical autonomous AI whenever spend cannot be proven. It is exposed rather than chosen,
//     because that is an operating decision.
//
// ── WHAT IS NEVER REFUSED ───────────────────────────────────────────────────
//
// Critical work, recovery and observability. A budget that silences the reaper or the alerting
// path when spend is high would turn an accounting limit into an outage, and the K4 deadlock would
// return exactly when nobody could see it.

const scope = require('./scope');
const { assertContext } = require('./context');

const DAILY_CAP_USD = 100;

// Ordered, so "raise by one" is meaningful.
const TIERS = Object.freeze(['ok', 'informational', 'warning', 'critical', 'exceeded']);
const THRESHOLDS = Object.freeze([
  { at: 1.00, tier: 'exceeded' },
  { at: 0.90, tier: 'critical' },
  { at: 0.75, tier: 'warning' },
  { at: 0.50, tier: 'informational' },
]);

// Work that a spend limit must never stop.
const NEVER_REFUSED = Object.freeze(['critical', 'recovery', 'observability']);

function tierFor(fraction) {
  for (const t of THRESHOLDS) if (fraction >= t.at) return t.tier;
  return 'ok';
}
function raiseOne(tier) {
  const i = TIERS.indexOf(tier);
  if (i < 0) return tier;
  return TIERS[Math.min(i + 1, TIERS.length - 1)];
}

/**
 * Measure today's position for a company. Read-only; refuses nothing.
 *
 * Returns { capUsd, spendKnownUsd, unknownCalls, calls, fraction, tier, confident, lowerBound }.
 */
async function assess(ctx, { capUsd = DAILY_CAP_USD } = {}, deps = {}) {
  assertContext(ctx);
  const s = await scope.spendToday(ctx, deps);

  const spendKnownUsd = Number(s.usd || 0);
  const unknownCalls = Number(s.unknown_calls || 0);
  const calls = Number(s.calls || 0);
  const fraction = capUsd > 0 ? spendKnownUsd / capUsd : 0;

  const baseTier = tierFor(fraction);
  const confident = unknownCalls === 0;

  return {
    capUsd,
    spendKnownUsd,
    unknownCalls,
    calls,
    fraction: Number(fraction.toFixed(6)),
    // `tier` is the operative one; `measuredTier` is what the measured spend alone would say, so
    // an operator can see that the escalation came from unmeasured calls rather than from dollars.
    measuredTier: baseTier,
    tier: confident ? baseTier : raiseOne(baseTier),
    confident,
    // Naming it a lower bound is the honest description: it is the least this day can have cost.
    lowerBound: true,
    reason: confident ? null
      : `${unknownCalls} AI call(s) today returned no provider usage, so $${spendKnownUsd.toFixed(6)} is a LOWER BOUND, not the spend`,
  };
}

/**
 * Would this AI invocation be permitted? NOT WIRED — activation is a separate ruling.
 *
 * criticality: 'routine' (default, refusable) | 'critical' | 'recovery' | 'observability'
 */
async function enforce(ctx, { criticality = 'routine', capUsd = DAILY_CAP_USD,
  refuseOnUnmeasured = false } = {}, deps = {}) {
  assertContext(ctx);
  const a = await assess(ctx, { capUsd }, deps);

  if (NEVER_REFUSED.includes(criticality)) {
    return { allow: true, exempt: true, criticality, assessment: a,
      note: 'critical, recovery and observability work is never refused by a spend limit — an accounting limit must not become an outage' };
  }

  if (a.fraction >= 1.0) {
    return { allow: false, criticality, assessment: a,
      reason: `daily AI budget exceeded: $${a.spendKnownUsd.toFixed(4)} of $${capUsd} measured` };
  }

  if (refuseOnUnmeasured && !a.confident) {
    return { allow: false, criticality, assessment: a,
      reason: `spend cannot be proven under the cap: ${a.unknownCalls} unmeasured call(s) today` };
  }

  return { allow: true, criticality, assessment: a };
}

module.exports = { assess, enforce, DAILY_CAP_USD, THRESHOLDS, TIERS, NEVER_REFUSED, tierFor, raiseOne };
