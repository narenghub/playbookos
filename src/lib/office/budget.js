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
// ── NO CALLER-CONTROLLED AUTONOMY CLASSIFICATION (B2.5b, owner 2026-11-25) ──
//
// This function used to take `autonomous = true`, and `consequentialReleaseGate` passed false to
// skip the finite-budget requirement. The owner's instruction is explicit: *"No caller-controlled
// autonomy classification that bypasses the finite-budget requirement."* A boolean argument is
// exactly that — any caller could pass it, and the one that most wanted to would be the one that
// should not.
//
// The flag has therefore moved OUT of the public surface. `hierarchy` is module-private and takes
// it as a third argument that no exported function forwards; the two exported entry points each
// fix it, and WHICH FUNCTION A CALLER NAMES is the declaration:
//
//   enforceHierarchy      — this operation may spend. No finite budget, no permission.
//   assessWithoutSpending — this operation spends NOTHING further; it authorizes no provider call
//                           and returns no reservation, so it cannot be used to make one.
//
// scripts/check-finite-budget-db.js asserts that neither exported signature mentions autonomy, and
// that `assessWithoutSpending` is called from exactly one place in the codebase.
async function hierarchy(ctx, { objectiveId, criticality = 'routine',
  capUsd = DAILY_CAP_USD, refuseOnUnmeasured = false } = {}, requireFiniteBudget = true,
  deps = {}) {
  assertContext(ctx);

  // ── THE BUDGET COMES FROM THE CONTEXT, NOT FROM A PARAMETER (B2.5a) ──────
  //
  // `objectiveBudgetUsd` used to be an argument. src/lib/office/ai.js passed `ctx.budgetUsd` and
  // its comment said "There is no parameter through which a caller could raise its own ceiling" —
  // which was true of that one caller and false of this function's signature. Any other caller,
  // including a delegated child agent, could simply pass a larger number.
  //
  // That is the owner's requirement in B2.5a: "A child agent must not create a new budget that
  // bypasses its parent's authorized spending limit." A promise in a comment does not stop it; a
  // missing parameter does. The budget is now READ off the resolved objective context, which
  // office/context.js minted from the objectives row, so a caller wanting a different budget must
  // resolve a context for an objective that actually has one — the same structural choice as the
  // company never being caller-supplied.
  const objectiveBudgetUsd = ctx.budgetUsd === undefined ? null : ctx.budgetUsd;

  const enterprise = await enforce(ctx, { criticality, capUsd, refuseOnUnmeasured }, deps);
  if (NEVER_REFUSED.includes(criticality)) return { allow: true, exempt: true, criticality, enterprise };
  if (!enterprise.allow) return { allow: false, scope: 'enterprise', criticality, enterprise, reason: enterprise.reason };

  // ── A MISSING BUDGET REFUSES AUTONOMOUS EXECUTION (B2.5a) ────────────────
  //
  // This block used to be skipped entirely when no objective budget was configured, returning
  // `{ allow: true, objective: null }`. So an autonomous run against an objective with no budget
  // was permitted and UNMETERED, bounded only by the enterprise daily cap — which is a shared
  // ceiling, not this objective's authorization. The tracker recorded "a null ceiling means
  // unmetered, not zero" as a passing assertion without noting that this is the consequence.
  //
  // Now: no budget, no autonomous spend — unless a named, time-bounded, audited exception says
  // otherwise. The exception is consulted through the kernel accessor, so it is company-scoped and
  // cannot be asserted by a caller.
  //
  // `autonomous` defaults to TRUE because that is the safe default for this function: everything
  // that reaches it today is a governed office run acting on its own. A human-initiated call that
  // genuinely should proceed without an objective budget must say so explicitly, and say it at a
  // call site a reviewer can see.
  if (objectiveId && objectiveBudgetUsd == null) {
    if (!requireFiniteBudget) {
      return { allow: true, criticality, enterprise, objective: null,
        note: 'no objective budget; this entry point authorizes no further spend, so the ceiling '
          + 'it would be judged against is not consulted' };
    }
    let exception = null;
    try {
      exception = await scope.activeBudgetException(ctx, objectiveId, deps);
    } catch (e) {
      // Could not tell. An outage is not permission — the same rule the membership accessor
      // follows when it returns UNKNOWN rather than "not a member".
      return { allow: false, scope: 'objective', criticality, enterprise, objective: null,
        reason: `objective ${objectiveId} has no budget and the exception record could not be read `
          + `(${e.message}) — an unreadable exception is not an exception` };
    }
    if (!exception) {
      return { allow: false, scope: 'objective', criticality, enterprise, objective: null,
        needsBudgetOrException: true,
        reason: `objective ${objectiveId} has NO authorized budget, so autonomous execution is `
          + 'refused. Set a finite objective budget, or record a named, time-bounded budget '
          + 'exception against it.' };
    }
    return { allow: true, criticality, enterprise, objective: null, budgetException: exception,
      note: `unmetered under budget exception ${exception.id}, granted by ${exception.grantedBy}, `
        + `expiring ${new Date(exception.effectiveTo).toISOString()}` };
  }

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
/**
 * The budget gate for an operation that MAY SPEND. Strict: an objective with no finite budget and
 * no live exception is refused.
 */
async function enforceHierarchy(ctx, opts = {}, deps = {}) {
  return hierarchy(ctx, opts, true, deps);
}

/**
 * The budget gate for an operation that spends NOTHING further.
 *
 * It still enforces the enterprise daily cap, the refuse-on-unmeasured rule and an objective cap
 * when one is configured — it drops only the requirement that a budget EXIST, because there is no
 * new charge for a ceiling to bound. It returns no reservation, so it cannot be used to reach a
 * provider: the only way to make a metered call is `authorizeSpend` below, which takes a hold.
 *
 * Exactly one caller: `consequentialReleaseGate`. Releasing an action a named human approved
 * transmits a message that costs nothing, and refusing it for want of a budget FIGURE would leave
 * "invent one" as the only way to send an approved email — a gate that pressures the next operator
 * toward a worse fix. Note what this does NOT say: a human approval is not financial authorization.
 * Any AI spend on that run was already reserved and charged under `authorizeSpend`, and the
 * approval does not widen it.
 */
async function assessWithoutSpending(ctx, opts = {}, deps = {}) {
  return hierarchy(ctx, opts, false, deps);
}

/**
 * ── THE ONLY ROAD TO A METERED CALL (B2.5b) ────────────────────────────────
 *
 * Policy gate, then an ATOMIC HOLD for the most this call is ALLOWED to cost, taken before the
 * provider is reached. Returns the reservation the caller must settle.
 *
 * ── WHAT THE HOLD DOES AND DOES NOT PREVENT ────────────────────────────────
 *
 * Owner's requirement 5, 2026-11-26: *"Atomic reservations prevent concurrent allocation beyond
 * configured limits, but an underestimated provider charge can still exceed its reservation.
 * Post-call settlement does not prevent that overspend. Do not call an estimated reservation a
 * proven worst-case charge."*
 *
 * This docstring said "the settlement corrects it downward, which is the safe direction". That is
 * true of an OVER-estimate and silently false of an under-estimate, which is the case that matters:
 * if the provider charges more than `maxUsd`, settlement records the excess AFTER the money is
 * spent. It is accounting, not a control.
 *
 * So, precisely:
 *
 *   PREVENTED — concurrent allocation beyond the configured limits. The hold is taken inside the
 *               transaction under a fixed lock order, so N callers cannot each be told there is
 *               room for the same dollar. This part is proven, by
 *               scripts/check-aggregate-spend-concurrency-db.js.
 *   PREVENTED — a call whose ALLOWED maximum would breach a ceiling. Refused before the provider
 *               is reached, so no request is sent.
 *   NOT PREVENTED — a single charge larger than the `maxUsd` its caller chose. Nothing here can
 *               prevent that: the figure is supplied by the caller before the provider has
 *               decided what to bill. It is DETECTED at settlement and is a FINANCIAL ANOMALY
 *               (see settleSpend), never a reconciliation.
 *
 * `maxUsd` is therefore an allowance, not a proven worst-case charge. An under-estimate is a hole
 * in the limit, which is why callers are expected to over-estimate — and why the per-call ceiling
 * exists as a second bound on how large that hole can be.
 */
async function authorizeSpend(ctx, { objectiveId, runId, maxUsd, reason,
  criticality = 'routine', capUsd = DAILY_CAP_USD, refuseOnUnmeasured = false,
  reservationId = null, ttlMs } = {}, deps = {}) {
  assertContext(ctx);

  const h = await hierarchy(ctx, { objectiveId, criticality, capUsd, refuseOnUnmeasured },
    true, deps);
  if (!h.allow) {
    return { allow: false, scope: h.scope || 'enterprise', reason: h.reason, hierarchy: h,
      needsBudgetOrException: h.needsBudgetOrException === true, reservation: null };
  }
  // Exempt work — critical, recovery, observability — is never refused, and that exemption is
  // deliberate (a budget that silences the reaper turns an accounting limit into an outage). It
  // still takes a hold when it can, so the exposure is VISIBLE rather than invisible; a refusal to
  // reserve does not stop it.
  if (!objectiveId) {
    return { allow: true, hierarchy: h, reservation: null,
      note: 'no objective: the enterprise cap is the only ceiling and there is nothing to hold '
        + 'against' };
  }

  const id = reservationId
    || `rsv-${runId || 'norun'}-${require('crypto').randomBytes(6).toString('hex')}`;
  const r = await scope.reserveSpend(ctx, {
    id, objectiveId, runId, maxUsd, reason, ...(ttlMs === undefined ? {} : { ttlMs }),
  }, deps);

  if (!r.ok) {
    if (h.exempt) {
      return { allow: true, exempt: true, hierarchy: h, reservation: null,
        unreservedBecause: r.code,
        note: `${criticality} work is never refused; the hold could not be taken (${r.code}) and `
          + 'the work proceeds unheld rather than being blocked' };
    }
    return { allow: false, scope: 'objective', reason: r.detail, code: r.code,
      needsBudgetOrException: r.code === 'needs_budget_or_exception',
      hierarchy: h, reservation: null, exposure: r };
  }
  return { allow: true, hierarchy: h, reservation: r.reservation, exposure: r };
}

async function consequentialReleaseGate(ctx, { runId, objectiveId = null,
  capUsd = DAILY_CAP_USD } = {}, deps = {}) {
  assertContext(ctx);

  const u = await scope.unmeasuredForRun(ctx, runId, deps);
  if (Number(u.unknown_calls) > 0) {
    return { allow: false, reason: 'unmeasured_ai_cost',
      detail: `${u.unknown_calls} of ${u.calls} AI call(s) on this run returned no provider usage, `
        + 'so the cost of this consequential action cannot be proven — release is blocked pending human review',
      unmeasured: Number(u.unknown_calls) };
  }

  // ── WHY THIS GATE SPENDS NOTHING, AND WHAT THAT DOES NOT MEAN ───────────
  //
  // Releasing an action a named human approved transmits a message. It makes no provider call and
  // incurs no new charge, so there is no ceiling for a new charge to be bounded by — which is why
  // it goes through `assessWithoutSpending` rather than the spending gate. Judging it by the
  // spending rule would refuse every release on an objective with no budget FIGURE, leaving
  // "invent one" as the only way to send an approved email: a gate that pressures the next
  // operator toward a worse fix (CLAUDE.md).
  //
  // What that does NOT mean (owner, 2026-11-25): *"Human approval of an action is not unlimited
  // financial authorization."* It is not treated as any financial authorization at all here. Every
  // dollar of AI spend on this run was already bounded by a HOLD taken before the call
  // (`authorizeSpend`), charged against this objective's own ceiling; the approval neither widens
  // that ceiling nor authorizes a further call. The enterprise daily cap and the
  // refuse-on-unmeasured rule still apply in full, so a release cannot happen while spend is over
  // cap or unproven.
  //
  // It is also not a boolean a caller may set: the distinction is which FUNCTION is named, and
  // `check-finite-budget-db.js` asserts that this is the only place in the codebase that names
  // the non-spending one.
  const h = await assessWithoutSpending(ctx, { objectiveId, criticality: 'routine', capUsd,
    refuseOnUnmeasured: true }, deps);
  if (!h.allow) return { allow: false, reason: `budget_${h.scope}`, detail: h.reason, hierarchy: h };

  return { allow: true, hierarchy: h };
}

module.exports = { assess, enforce, enforceHierarchy, assessWithoutSpending,
  authorizeSpend, consequentialReleaseGate,
  DAILY_CAP_USD, THRESHOLDS, TIERS, NEVER_REFUSED, tierFor, raiseOne };
