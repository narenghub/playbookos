// PlayNexa AI Office — K5: the budget mechanism. ACTIVATED 1 Nov 2026.
//
// ── WIRED, AS OF ACTIVATION ─────────────────────────────────────────────────
//
// This header previously read "Nothing in this file is wired to a call path." That became false
// at activation, and a stale comment asserting an invariant that no longer holds is exactly the
// defect recorded as Defect 7 in the verification standard — so it is corrected here rather than
// left to be discovered.
//
//   enforceHierarchy        → office/ai.js governedCall, BEFORE the provider call. Every governed
//                             AI invocation is now refused when either cap is exhausted.
//   consequentialReleaseGate → office/approval.js release. Unknown cost fails closed THERE, not at
//                             the call, so the evidence a human reviews survives.
//
// Activation was authorized only after real cost capture succeeded in production, so the numbers
// these decisions are made on are measured rather than assumed.
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

// ── BUDGET HIERARCHY: A CALL MUST SATISFY BOTH ──────────────────────────────
//
// "Do not allow a $10 objective to consume $50 simply because enterprise budget remains."
//
// The two caps are different kinds of thing and are checked as such: the enterprise cap is PER DAY
// and resets; an objective's budget is a TOTAL for its whole life. A $10 objective that has spent
// $10 is finished even on a day when the enterprise has spent nothing.
async function enforceHierarchy(ctx, { objectiveId, criticality = 'routine',
  capUsd = DAILY_CAP_USD, objectiveBudgetUsd = null, refuseOnUnmeasured = false } = {}, deps = {}) {
  assertContext(ctx);

  const enterprise = await enforce(ctx, { criticality, capUsd, refuseOnUnmeasured }, deps);
  if (NEVER_REFUSED.includes(criticality)) return { allow: true, exempt: true, criticality, enterprise };
  if (!enterprise.allow) return { allow: false, scope: 'enterprise', criticality, enterprise, reason: enterprise.reason };

  if (objectiveId && objectiveBudgetUsd != null) {
    const o = await scope.spendForObjective(ctx, objectiveId, deps);
    const spent = Number(o.usd || 0);
    const unknown = Number(o.unknown_calls || 0);
    // A $0 OBJECTIVE BUDGET MEANS NO SPEND IS PERMITTED, NOT UNLIMITED SPEND.
    //
    // This read `fraction: budget > 0 ? spent / budget : 0`, so an objective explicitly given a
    // $0 budget produced fraction 0 — tier 'ok' — and could spend without limit. The guard against
    // the $10-objective-eating-$50 case was silently absent for the strictest budget a CEO can
    // set, which is the one most likely to be set deliberately.
    //
    // `objectiveBudgetUsd == null` still means "no objective budget configured" and skips this
    // block entirely (see the caller above). An explicit 0 is a decision, not an absence.
    const cap = Number(objectiveBudgetUsd);
    const objective = {
      budgetUsd: cap,
      spendKnownUsd: spent,
      unknownCalls: unknown,
      fraction: cap > 0 ? spent / cap : 1,
      confident: unknown === 0,
      lowerBound: true,
    };
    objective.measuredTier = tierFor(objective.fraction);
    objective.tier = objective.confident ? objective.measuredTier : raiseOne(objective.measuredTier);

    if (objective.fraction >= 1.0) {
      return { allow: false, scope: 'objective', criticality, enterprise, objective,
        reason: cap > 0
          ? `objective budget exhausted: $${spent.toFixed(4)} of $${cap} measured`
          : `objective budget is $0 — no AI spend is permitted against this objective` };
    }
    if (refuseOnUnmeasured && !objective.confident) {
      return { allow: false, scope: 'objective', criticality, enterprise, objective,
        reason: `objective spend cannot be proven under its budget: ${unknown} unmeasured call(s)` };
    }
    return { allow: true, criticality, enterprise, objective };
  }

  return { allow: true, criticality, enterprise, objective: null };
}

// ── THE FAIL-CLOSED RELEASE GATE ────────────────────────────────────────────
//
//   "For governed consequential work: unknown cost must fail closed. [...] If cost is unknown:
//    AI result may remain preserved as evidence, but consequential release is blocked →
//    exception → human/operator review."
//
// WHY THE GATE IS AT RELEASE AND NOT AT THE CALL. Blocking the AI call would destroy the evidence
// the ruling asks to preserve: the text and its cost row are what a human reviews. So the call
// proceeds, the unknown is recorded, and the CONSEQUENTIAL ACT is what refuses.
//
// It is also the right boundary for a second reason: a run may make several AI calls, and whether
// spend is provable is a property of the run as a whole at the moment it tries to act.
//
// Non-consequential observability and recovery work is not gated here — "unknown cost may be
// recorded without causing an outage".
async function consequentialReleaseGate(ctx, { runId, objectiveId = null,
  capUsd = DAILY_CAP_USD, objectiveBudgetUsd = null } = {}, deps = {}) {
  assertContext(ctx);

  const u = await scope.unmeasuredForRun(ctx, runId, deps);
  if (Number(u.unknown_calls) > 0) {
    return { allow: false, reason: 'unmeasured_ai_cost',
      detail: `${u.unknown_calls} of ${u.calls} AI call(s) on this run returned no provider usage, `
        + 'so the cost of this consequential action cannot be proven — release is blocked pending human review',
      unmeasured: Number(u.unknown_calls) };
  }

  const h = await enforceHierarchy(ctx, { objectiveId, criticality: 'routine', capUsd,
    objectiveBudgetUsd, refuseOnUnmeasured: true }, deps);
  if (!h.allow) return { allow: false, reason: `budget_${h.scope}`, detail: h.reason, hierarchy: h };

  return { allow: true, hierarchy: h };
}

module.exports = { assess, enforce, enforceHierarchy, consequentialReleaseGate,
  DAILY_CAP_USD, THRESHOLDS, TIERS, NEVER_REFUSED, tierFor, raiseOne };
