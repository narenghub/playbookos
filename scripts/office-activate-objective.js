#!/usr/bin/env node
// ── §14: ACTIVATE THE APPROVED OBJECTIVE ────────────────────────────────────
//
//   railway ssh 'node scripts/office-activate-objective.js'
//
// This is the ONE write it makes: obj-abiozen-first-governed-rfq goes from `draft` to `active`.
// It prepares no RFQ, contacts nobody, makes no AI call and creates no approval. §15 is a separate
// command, deliberately, so there is a human checkpoint between "the objective is live" and "a
// supplier communication exists".
//
// ── IT REFUSES TO ACTIVATE IF A PREREQUISITE IS NOT IN THE DEPLOYED BUILD ───
//
// §14 gates activation on seven things being deployed. validate-k7-k9-deployed.js reports them,
// but a report somebody read ten minutes ago is not the same as the state of the build that is
// running now — a redeploy in between would invalidate it silently. So the structural
// prerequisites are re-asserted HERE, against the bytes doing the activating, and a failure
// refuses the activation rather than warning about it.
//
// ── ACTIVATION IS NOT REVERTED ──────────────────────────────────────────────
//
// Once active it stays active. Flipping a real objective to active and back would be exactly the
// mutate-and-restore pattern Rule 7 prohibits, and the two status transitions would be the only
// evidence a reviewer had of something that was meant to be deliberate.
'use strict';

const fs = require('fs');
const path = require('path');
const scope = require('../src/lib/office/scope');
const autonomy = require('../src/lib/autonomy');
const { query } = require('../src/lib/db');

const APPROVED = Object.freeze({
  id: 'obj-abiozen-first-governed-rfq',
  objective: 'Obtain a qualified supplier quotation through governed RFQ outreach',
  priority: 'P1',
  kpi_metric: 'qualified_supplier_quotes_received',
  kpi_target: 1,
  budget_usd: 10,
  autonomy_tier: 'supervised',
  approval_policy: 'all_consequential',
  created_by: 'naren',
});

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};
const note = (m) => console.log(`  --    ${m}`);
const SRC = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', ...p), 'utf8');

(async () => {
  try {
    console.log('\n══ §14 · ACTIVATE THE APPROVED OBJECTIVE ══\n');
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    const company = (await query(`SELECT id, display_name FROM companies WHERE slug='abiozen'`)).rows[0];
    if (!company) { bad('no abiozen company'); process.exit(1); }

    const obj = (await query(
      `SELECT id, company_id, objective, priority, kpi_metric, kpi_target, deadline, budget_usd,
              autonomy_tier, approval_policy, status, created_by
         FROM objectives WHERE id = $1 AND company_id = $2`, [APPROVED.id, company.id])).rows[0];
    if (!obj) { bad(`objective ${APPROVED.id} does not exist — it is not to be recreated here`); process.exit(1); }

    // ══ 1. IT IS STILL THE APPROVED OBJECTIVE ══════════════════════════════
    const diffs = [];
    const cmp = (k, got, want) => { if (String(got) !== String(want)) diffs.push(`${k}: "${got}" ≠ approved "${want}"`); };
    cmp('objective', obj.objective, APPROVED.objective);
    cmp('priority', obj.priority, APPROVED.priority);
    cmp('kpi_metric', obj.kpi_metric, APPROVED.kpi_metric);
    cmp('kpi_target', Number(obj.kpi_target), APPROVED.kpi_target);
    cmp('budget_usd', Number(obj.budget_usd), APPROVED.budget_usd);
    cmp('autonomy_tier', obj.autonomy_tier, APPROVED.autonomy_tier);
    cmp('approval_policy', obj.approval_policy, APPROVED.approval_policy);
    cmp('created_by', obj.created_by, APPROVED.created_by);
    if (diffs.length) {
      console.log('  ══ STOP ══\n');
      console.log('  The stored objective no longer matches the approved proposal:\n');
      diffs.forEach((d) => console.log(`    · ${d}`));
      console.log('\n  Nothing was activated. This needs a human decision about which version is right.\n');
      process.exit(1);
    }
    ok('the stored objective still matches the approved proposal exactly');

    // ══ 2. ALREADY ACTIVE? ═════════════════════════════════════════════════
    if (obj.status === 'active') {
      note(`${APPROVED.id} is ALREADY active — nothing to do, and it is not re-activated`);
      console.log(`\nPASS  already active. Next: scripts/office-prepare-first-rfq.js\n`);
      process.exit(0);
    }
    if (obj.status !== 'draft') {
      bad(`the objective is "${obj.status}", not draft — activating from here is not what §14 describes`);
      process.exit(1);
    }
    ok('it is currently draft, as expected');

    // ══ 3. THE PREREQUISITES, AGAINST THE BYTES DOING THE ACTIVATING ═══════
    console.log('\n  PREREQUISITES, RE-ASSERTED AGAINST THIS BUILD\n');
    const aiSrc = SRC('office', 'ai.js');
    const rfqSrc = SRC('office', 'procurement-rfq.js');
    const scopeSrc = SRC('office', 'scope.js');
    const apprSrc = SRC('office', 'approval.js');
    const budget = require('../src/lib/office/budget');
    const vocabW = autonomy.knownScopeKeys('workflow') || [];
    const vocabA = autonomy.knownScopeKeys('agent') || [];
    const payloadTrig = (await query(
      `SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_office_approvals_payload_immutable'
         AND NOT tgisinternal`)).rows[0];
    const fkMatch = (await query(
      `SELECT confmatchtype FROM pg_constraint WHERE conname = 'fk_agent_runs_objective_company'`)).rows[0];

    const gate = [
      ['K1 company isolation in force', !!fkMatch && fkMatch.confmatchtype === 'f'],
      ['budget enforced before the provider', aiSrc.includes('budget.enforceHierarchy')
        && aiSrc.indexOf('budget.enforceHierarchy') < aiSrc.indexOf('llm.callClaude')
        && budget.DAILY_CAP_USD === 100],
      ['governed renderer with containment', rfqSrc.includes('async function renderGovernedRFQ')
        && rfqSrc.includes('identityContainment')],
      ['governed-office entry point wired', rfqSrc.includes('async function runGovernedProcurement')],
      ['approval payload immutable', !!payloadTrig && payloadTrig.tgenabled !== 'D'],
      ['release requires approved + unreleased', /status\s*=\s*'approved'/.test(scopeSrc)
        && /released_at\s+IS\s+NULL/i.test(scopeSrc)],
      ['fail-closed cost gate on release', apprSrc.includes('budget.consequentialReleaseGate')],
      ['K8 recognizes the governed scopes', vocabW.includes('governed-rfq-generation')
        && vocabA.includes('procurement-agent')],
      ['K9 provenance available', typeof scope.provenance === 'function'],
    ];
    let blocked = 0;
    for (const [name, pass] of gate) {
      if (!pass) blocked++;
      console.log(`    ${pass ? 'ok  ' : 'NO  '}  ${name}`);
    }
    if (blocked) {
      console.log('');
      bad(`${blocked} prerequisite(s) are NOT in this build — REFUSING to activate`);
      console.log('\n  Nothing was activated.\n');
      process.exit(1);
    }
    console.log('');
    ok('every structural prerequisite is present in the build performing this activation');

    // ══ 4. ACTIVATE ════════════════════════════════════════════════════════
    const ctx = Object.freeze({ companyId: company.id, objectiveId: APPROVED.id, runId: null });
    const res = await scope.setObjectiveStatus(ctx, { id: APPROVED.id, status: 'active' });
    if (!res || res.status !== 'active') { bad('the activation did not take effect', JSON.stringify(res)); process.exit(1); }

    const after = (await query(
      `SELECT status, updated_at FROM objectives WHERE id = $1 AND company_id = $2`,
      [APPROVED.id, company.id])).rows[0];
    if (after.status !== 'active') { bad(`read-back says "${after.status}"`); process.exit(1); }
    console.log('');
    ok(`ACTIVATED — ${APPROVED.id} is now active (updated ${after.updated_at.toISOString()})`);

    // It can now yield an execution context. A read, not a probe.
    const { resolveObjectiveContext } = require('../src/lib/office/context');
    const octx = await resolveObjectiveContext({ objectiveId: APPROVED.id });
    if (octx.companyId === company.id && octx.objectiveId === APPROVED.id) {
      ok('it now yields an execution context, carrying the Abiozen company and a $'
        + `${octx.budgetUsd} budget — derived from the row, not supplied`);
    } else bad('the active objective does not yield the expected context', JSON.stringify(octx));

    // ══ 5. AND NOTHING ELSE HAPPENED ═══════════════════════════════════════
    console.log('');
    const counts = (await query(
      `SELECT (SELECT COUNT(*)::int FROM agent_runs WHERE objective_id = $1) AS runs,
              (SELECT COUNT(*)::int FROM office_cost_ledger WHERE objective_id = $1) AS ai,
              (SELECT COUNT(*)::int FROM office_approvals WHERE objective_id = $1) AS approvals,
              (SELECT COUNT(*)::int FROM office_outcomes WHERE objective_id = $1) AS outcomes`,
      [APPROVED.id])).rows[0];
    console.log(`  for this objective: runs=${counts.runs}  ai_calls=${counts.ai}`
      + `  approvals=${counts.approvals}  outcomes=${counts.outcomes}`);
    if (counts.runs || counts.ai || counts.approvals || counts.outcomes) {
      bad('activation created work — it must only change the status');
    } else ok('activation created no run, no AI call, no approval and no outcome');

    console.log('\n' + (fail ? `FAIL  ${fail} assertion(s) failed` :
      'PASS  the approved objective is ACTIVE. Nothing has executed against it.\n\n'
      + '  Next, and separately — prepare exactly one governed supplier RFQ, which STOPS before\n'
      + '  approval and before any send:\n\n'
      + "    railway ssh 'node scripts/office-prepare-first-rfq.js --rfq=<id> --supplier=<id>'"));
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\nFAIL  activation error:', e.stack || e.message);
    process.exit(1);
  }
})();
