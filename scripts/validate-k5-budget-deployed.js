#!/usr/bin/env node
// ── §11: BUDGET ACTIVATION, VALIDATED AGAINST PRODUCTION ────────────────────
//
//   railway ssh 'node scripts/validate-k5-budget-deployed.js'
//
// READ-ONLY. It issues no INSERT, UPDATE or DELETE and makes no AI call.
//
// ── WHAT IT PROVES, AND WHY IT PROVES IT THIS WAY ───────────────────────────
//
//   "Do not intentionally consume the thresholds in production to prove them."
//
// So threshold and refusal BEHAVIOUR is not re-proven here — `check-office-governed-ai-db.js`
// proves it on fixtures, including the mutation control M5 which disables the gate and shows an
// exhausted objective budget buying AI calls again. That is what makes "the gate is active" a
// measured claim rather than a hopeful one.
//
// Production proves the other half, structurally and by reading real numbers:
//
//   · the policy is loaded, with the ruled figures
//   · real measured spend is included, cross-checked against raw SQL by a second path
//   · objective spend is included
//   · enterprise spend today is included
//   · the current tier is calculated correctly, recomputed independently from the raw numbers
//   · enforcement is wired into the governed path, BEFORE the provider is reached
//   · the ceiling is not caller-supplied
'use strict';

const fs = require('fs');
const path = require('path');
const budget = require('../src/lib/office/budget');
const scope = require('../src/lib/office/scope');
const { query } = require('../src/lib/db');

const APPROVED_OBJECTIVE = 'obj-abiozen-first-governed-rfq';

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};
const note = (m) => console.log(`  --    ${m}`);
const field = (k, v) => console.log(`    ${String(k).padEnd(24)} ${v === null || v === undefined ? '(null)' : v}`);

// Recomputed from the ruled figures, deliberately NOT by calling budget.tierFor — a check that
// uses the implementation to verify the implementation measures only that it is self-consistent.
function expectedTier(fraction) {
  if (fraction >= 1.00) return 'exceeded';
  if (fraction >= 0.90) return 'critical';
  if (fraction >= 0.75) return 'warning';
  if (fraction >= 0.50) return 'informational';
  return 'ok';
}
function raisedByOne(tier) {
  const order = ['ok', 'informational', 'warning', 'critical', 'exceeded'];
  return order[Math.min(order.indexOf(tier) + 1, order.length - 1)];
}

(async () => {
  try {
    console.log('\n══ §11 · BUDGET ACTIVATION, ON PRODUCTION (READ-ONLY) ══\n');
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    // ══ 1. THE POLICY IS LOADED, WITH THE RULED FIGURES ════════════════════
    console.log('  POLICY AS DEPLOYED');
    field('enterprise cap', `$${budget.DAILY_CAP_USD}/day`);
    const th = budget.THRESHOLDS.map((t) => `${(t.at * 100).toFixed(0)}% ${t.tier}`).join(' · ');
    field('thresholds', th);
    field('never refused', budget.NEVER_REFUSED.join(', '));
    console.log('');

    if (budget.DAILY_CAP_USD === 100) ok('enterprise daily cap is $100, as ruled');
    else bad(`enterprise daily cap is $${budget.DAILY_CAP_USD}, not $100`);

    const want = [[1.0, 'exceeded'], [0.9, 'critical'], [0.75, 'warning'], [0.5, 'informational']];
    const got = budget.THRESHOLDS.map((t) => [t.at, t.tier]);
    if (JSON.stringify(got) === JSON.stringify(want)) ok('thresholds are 50% / 75% / 90% / 100%, as ruled');
    else bad('the thresholds do not match the ruling', JSON.stringify(got));

    if (JSON.stringify([...budget.NEVER_REFUSED].sort()) === JSON.stringify(['critical', 'observability', 'recovery'])) {
      ok('critical, recovery and observability are exempt — an accounting limit cannot become an outage');
    } else bad('the never-refused list is wrong', budget.NEVER_REFUSED.join(','));

    // ══ 2. ENFORCEMENT IS WIRED, AND WIRED BEFORE THE PROVIDER ═════════════
    //
    // The ORDER is the property. A budget consulted after the provider call would be an audit
    // log, not a limit — the money would already be spent.
    console.log('');
    const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'office', 'ai.js'), 'utf8');
    const iGate = aiSrc.indexOf('budget.enforceHierarchy');
    const iCall = aiSrc.indexOf('llm.callClaude');
    const iRefuse = aiSrc.indexOf('if (!budgetDecision.allow)');
    if (iGate === -1) bad('governedCall does NOT consult the budget — K5 is not activated in this build');
    else if (iRefuse === -1) bad('the budget is assessed but its refusal is not acted on');
    else if (iGate < iCall && iRefuse < iCall) {
      ok('governedCall consults the budget and acts on a refusal BEFORE reaching the provider');
    } else bad('the budget is consulted AFTER the provider call — that is an audit log, not a limit');

    const apprSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'office', 'approval.js'), 'utf8');
    if (apprSrc.includes('budget.consequentialReleaseGate')) {
      ok('consequential release consults the fail-closed gate — unknown cost blocks the ACT, not the call');
    } else bad('approval release does not consult the release gate — unknown cost would not fail closed');

    // The ceiling must not be expressible by a caller: no cap parameter in the spec at all.
    const specBlock = aiSrc.slice(aiSrc.indexOf('async function governedCall'), iGate);
    if (/capUsd|objectiveBudgetUsd|budgetUsd/.test(specBlock)) {
      bad('governedCall accepts a budget parameter — an agent could raise its own ceiling');
    } else ok('governedCall exposes NO cap parameter — the ceiling comes from the stored objective');

    // ══ 3. REAL SPEND IS INCLUDED — CROSS-CHECKED BY A SECOND PATH ═════════
    console.log('\n  MEASURED SPEND, FROM PRODUCTION\n');
    const company = (await query(`SELECT id, display_name FROM companies WHERE slug='abiozen'`)).rows[0];
    if (!company) { bad('no abiozen company — nothing to assess'); process.exit(1); }
    const ctx = Object.freeze({ companyId: company.id, objectiveId: null, runId: null });

    const a = await budget.assess(ctx, {});
    field('company', `${company.display_name} (${company.id})`);
    field('cap', `$${a.capUsd}`);
    field('measured spend today', `$${Number(a.spendKnownUsd).toFixed(8)}`);
    field('calls today', a.calls);
    field('unmeasured calls today', a.unknownCalls);
    field('fraction of cap', a.fraction);
    field('tier', a.tier);
    field('confident', a.confident);
    field('lower bound', a.lowerBound);

    // Independent path: raw SQL, not the accessor the assessment uses.
    const raw = (await query(
      `SELECT COALESCE(SUM(cost_usd) FILTER (WHERE cost_known), 0)::float8 AS known,
              COUNT(*)::int AS calls,
              COUNT(*) FILTER (WHERE NOT cost_known)::int AS unknown
         FROM office_cost_ledger
        WHERE company_id = $1 AND at >= date_trunc('day', NOW())`, [company.id]
    )).rows[0];
    console.log('');
    if (Math.abs(Number(raw.known) - Number(a.spendKnownUsd)) < 1e-9) {
      ok(`measured spend agrees with raw SQL by an independent path ($${Number(raw.known).toFixed(8)})`);
    } else bad('the assessment disagrees with raw SQL', `assess=${a.spendKnownUsd} sql=${raw.known}`);
    if (raw.calls === a.calls) ok(`call count agrees (${raw.calls})`); else bad('call count disagrees', `${a.calls} vs ${raw.calls}`);
    if (raw.unknown === a.unknownCalls) ok(`unmeasured-call count agrees (${raw.unknown})`);
    else bad('unmeasured-call count disagrees', `${a.unknownCalls} vs ${raw.unknown}`);

    if (Number(a.spendKnownUsd) > 0) ok('the budget is reading REAL measured production spend, not zero');
    else note('measured spend today is $0 — no AI call has been accounted today');

    // ══ 4. THE TIER IS CALCULATED CORRECTLY ════════════════════════════════
    const base = expectedTier(Number(a.fraction));
    const shouldBe = a.unknownCalls > 0 ? raisedByOne(base) : base;
    if (a.tier === shouldBe) {
      ok(`tier "${a.tier}" is correct for fraction ${a.fraction}`
        + (a.unknownCalls > 0 ? ` raised one level for ${a.unknownCalls} unmeasured call(s)` : ''));
    } else bad(`tier is "${a.tier}" but the ruled thresholds give "${shouldBe}"`);

    if (a.unknownCalls > 0 && a.confident) bad('unmeasured calls exist yet the assessment claims confidence');
    else if (a.unknownCalls === 0 && !a.confident) bad('no unmeasured calls yet the assessment is not confident');
    else ok(`confidence reflects measurability (${a.unknownCalls} unmeasured)`);

    // ══ 5. OBJECTIVE SPEND IS INCLUDED ═════════════════════════════════════
    console.log('\n  OBJECTIVE SPEND\n');
    const objs = (await query(
      `SELECT id, status, budget_usd FROM objectives WHERE company_id = $1 ORDER BY created_at`, [company.id]
    )).rows;
    for (const o of objs) {
      const s = await scope.spendForObjective(ctx, o.id);
      const cap = o.budget_usd === null ? null : Number(o.budget_usd);
      const frac = cap && cap > 0 ? Number(s.usd) / cap : (cap === 0 ? 1 : 0);
      console.log(`    ${o.id}`);
      console.log(`      status ${o.status}  budget ${cap === null ? '(none)' : `$${cap.toFixed(2)}`}`
        + `  spent $${Number(s.usd).toFixed(8)}  calls ${s.calls}  unmeasured ${s.unknown_calls}`
        + `  → ${cap === null ? 'no objective cap' : `${(frac * 100).toFixed(4)}% of budget, tier ${expectedTier(frac)}`}`);
    }
    const approved = objs.find((o) => o.id === APPROVED_OBJECTIVE);
    if (!approved) bad(`the approved objective ${APPROVED_OBJECTIVE} is not present`);
    else {
      const s = await scope.spendForObjective(ctx, APPROVED_OBJECTIVE);
      if (Number(s.usd) === 0 && Number(s.calls) === 0) {
        ok('the approved objective has spent nothing yet — its $10 budget is wholly intact');
      } else note(`the approved objective has already spent $${Number(s.usd).toFixed(8)} over ${s.calls} call(s)`);
      if (Number(approved.budget_usd) === 10) ok('its budget is $10, as ruled');
      else bad(`its budget is $${approved.budget_usd}, not $10`);
    }

    // ══ 6. WHAT THE HIERARCHY WOULD DECIDE RIGHT NOW ═══════════════════════
    //
    // A DECISION, NOT AN ACTION: enforceHierarchy is read-only. It is asked what it would permit
    // for routine work against the approved objective, which is exactly the question the governed
    // path will ask when the objective is activated — and it is asked WITHOUT spending anything.
    console.log('\n  WHAT ENFORCEMENT WOULD DECIDE NOW (asked, not consumed)\n');
    if (approved) {
      const h = await budget.enforceHierarchy(ctx, {
        objectiveId: APPROVED_OBJECTIVE, criticality: 'routine',
        objectiveBudgetUsd: approved.budget_usd === null ? null : Number(approved.budget_usd),
      });
      field('routine work', h.allow ? 'ALLOWED' : `REFUSED (${h.scope}): ${h.reason}`);
      field('enterprise tier', h.enterprise && h.enterprise.assessment && h.enterprise.assessment.tier);
      field('objective tier', h.objective ? h.objective.tier : '(no objective cap)');
      field('enterprise headroom', `$${(Number(budget.DAILY_CAP_USD) - Number(a.spendKnownUsd)).toFixed(6)} of $${budget.DAILY_CAP_USD} today`);
      if (h.allow) ok('routine governed work against the approved objective would be permitted');
      else note('routine work would be refused — that is the correct report, not a failure of this check');

      const crit = await budget.enforceHierarchy(ctx, { objectiveId: APPROVED_OBJECTIVE,
        criticality: 'critical', objectiveBudgetUsd: Number(approved.budget_usd) });
      if (crit.allow && crit.exempt) ok('critical work is exempt from both caps, as ruled');
      else bad('critical work is not exempt', JSON.stringify(crit));
    }

    // ══ 7. NOTHING WAS WRITTEN ═════════════════════════════════════════════
    console.log('');
    note('this validator issued no INSERT, UPDATE or DELETE and made no AI call');
    note('threshold and refusal BEHAVIOUR is proven on fixtures by check-office-governed-ai-db.js,');
    note('including M5, which disables the gate and shows an exhausted budget buying calls again');

    console.log('\n' + (fail
      ? `FAIL  ${fail} assertion(s) failed`
      : 'PASS  the budget policy is loaded with the ruled figures, reads real measured production '
        + 'spend at both levels, calculates its tier correctly, and is wired into the governed path '
        + 'ahead of the provider. No threshold was consumed to prove it.'));
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\nFAIL  validation error:', e.stack || e.message);
    process.exit(1);
  }
})();
