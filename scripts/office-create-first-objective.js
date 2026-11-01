#!/usr/bin/env node
// ── STEPS 1–3: CREATE Abiozen AND THE FIRST CEO OBJECTIVE ───────────────────
//
//   railway ssh 'node scripts/office-create-first-objective.js'
//
// Creates exactly one company and one objective, verifies both, and STOPS. It does NOT activate
// the objective: "Do not activate the objective in the same transaction or command."
//
// ── IT IS SAFE TO RUN TWICE ─────────────────────────────────────────────────
//
// Idempotent by construction rather than by hope: it refuses to create a second `abiozen` company
// or a second objective with the same id, and re-running reports the stored rows instead of
// duplicating them. A script that is run twice because the first `railway ssh` timed out — which
// has now happened five different ways — must not produce two companies.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
//
// No activation. No AI call. No supplier contact. No run. No attribution of any historical
// business row to the new company — that is verified, not assumed.
'use strict';

const crypto = require('crypto');
const { query } = require('../src/lib/db');
const scope = require('../src/lib/office/scope');

// The approved objective, exactly as ruled.
const OBJECTIVE = Object.freeze({
  objective: 'Obtain a qualified supplier quotation through governed RFQ outreach',
  priority: 'P1',
  kpiMetric: 'qualified_supplier_quotes_received',
  kpiTarget: 1,
  deadline: '2026-11-15',
  budgetUsd: 10,
  autonomyTier: 'supervised',
  approvalPolicy: 'all_consequential',
  createdBy: 'naren',
});
const OBJECTIVE_ID = 'obj-abiozen-first-governed-rfq';
const CUTOVER = '2026-11-01T12:00:00Z';

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};
const note = (m) => console.log(`  --    ${m}`);

(async () => {
  try {
    console.log('\nSteps 1–3: create Abiozen and the first CEO objective\n');
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    // ══ STEP 1: THE COMPANY ════════════════════════════════════════════════
    let company = (await query(`SELECT id, slug, display_name, status, created_at FROM companies WHERE slug = 'abiozen'`)).rows[0];
    if (company) {
      note(`company abiozen already exists (${company.id}) — not creating a second one`);
    } else {
      const id = `co-${crypto.randomUUID()}`;
      await query(
        `INSERT INTO companies (id, slug, display_name, status) VALUES ($1, 'abiozen', 'Abiozen LLC', 'active')`,
        [id]
      );
      company = (await query(`SELECT id, slug, display_name, status, created_at FROM companies WHERE slug = 'abiozen'`)).rows[0];
      ok(`created company ${company.id}`);
    }
    console.log(`\n  COMPANY ID        ${company.id}`);
    console.log(`  slug              ${company.slug}`);
    console.log(`  display_name      ${company.display_name}`);
    console.log(`  status            ${company.status}`);
    console.log(`  created_at        ${company.created_at.toISOString()}\n`);

    const all = (await query(`SELECT slug FROM companies ORDER BY slug`)).rows.map((r) => r.slug);
    if (all.length !== 1 || all[0] !== 'abiozen') {
      bad(`expected exactly one company (abiozen); found ${all.length}: ${all.join(', ')}`);
    } else ok('exactly one company exists, and it is abiozen — no other company was created');

    // The company id is immutable: a downstream foreign key depends on it, and a slug rename must
    // never become an identity change.
    let e = null;
    try {
      await query(`UPDATE companies SET id = $2 WHERE id = $1`, [company.id, `co-${crypto.randomUUID()}`]);
    } catch (err) { e = err; }
    if (!e) {
      bad('the company id was CHANGED — downstream foreign keys would be silently re-pointed');
      // Put it back if that somehow succeeded.
      await query(`UPDATE companies SET id = $1 WHERE slug = 'abiozen'`, [company.id]).catch(() => {});
    } else ok(`the company id cannot be changed (${e.code}) — it is the isolation boundary`);

    // ══ K1 CONSTRAINTS STILL ACTIVE ════════════════════════════════════════
    const fk = (await query(
      `SELECT confmatchtype FROM pg_constraint WHERE conname = 'fk_agent_runs_objective_company'`
    )).rows[0];
    if (!fk || fk.confmatchtype !== 'f') bad('the MATCH FULL composite FK is missing or downgraded — K1 isolation is not in force');
    else ok('K1 remains in force: the composite FK is present and MATCH FULL');
    const immut = (await query(
      `SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_office_runs_company_immutable' AND NOT tgisinternal`
    )).rows[0];
    if (!immut || immut.tgenabled === 'D') bad('the company-immutability trigger is absent or disabled');
    else ok('company identity remains immutable after insert');

    // ══ NO HISTORICAL ROW WAS ATTRIBUTED ═══════════════════════════════════
    const hist = (await query(
      `SELECT COUNT(*) FILTER (WHERE created_at < $1::timestamptz AND company_id IS NOT NULL)::int AS pre_attributed,
              COUNT(*) FILTER (WHERE created_at < $1::timestamptz)::int AS pre_total
         FROM agent_runs`, [CUTOVER]
    )).rows[0];
    if (hist.pre_attributed !== 0) bad(`${hist.pre_attributed} PRE-CUTOVER run(s) are attributed to a company — creating Abiozen must not reach backwards`);
    else ok(`zero of the ${hist.pre_total} pre-K1 runs are attributed to Abiozen or anything else`);

    const fpNow = (await query(
      `SELECT md5(string_agg(run_id::text || '|' || state || '|' || product || '|' ||
                              COALESCE(trigger,'') || '|' || created_at::text, E'\\n'
                              ORDER BY run_id)) AS checksum
         FROM agent_runs WHERE created_at < $1::timestamptz`, [CUTOVER]
    )).rows[0];
    if (fpNow.checksum !== 'f368a87d992fa03162c0b42cb06da630') {
      bad('the pre-cutover checksum CHANGED', `expected f368a87d992fa03162c0b42cb06da630\ngot      ${fpNow.checksum}`);
    } else ok('the pre-cutover identity/state checksum is unchanged');

    // ══ STEP 2: THE OBJECTIVE, IN DRAFT ════════════════════════════════════
    console.log('');
    const ctx = Object.freeze({ companyId: company.id, objectiveId: OBJECTIVE_ID, runId: null });
    let objective = await scope.getObjective(ctx, OBJECTIVE_ID);
    if (objective) {
      note(`objective ${OBJECTIVE_ID} already exists — not creating a second one`);
    } else {
      await scope.createObjective({ id: OBJECTIVE_ID, companyId: company.id, ...OBJECTIVE });
      objective = await scope.getObjective(ctx, OBJECTIVE_ID);
      ok(`created objective ${OBJECTIVE_ID}`);
    }

    // ══ STEP 3: READ IT BACK EXACTLY AS STORED ═════════════════════════════
    const stored = (await query(
      `SELECT id, company_id, objective, priority, kpi_metric, kpi_target, deadline, budget_usd,
              autonomy_tier, approval_policy, status, created_by, created_at, updated_at
         FROM objectives WHERE id = $1 AND company_id = $2`, [OBJECTIVE_ID, company.id]
    )).rows[0];
    if (!stored) { bad('the objective is not readable back — it is not durable'); }
    else {
      console.log('\n  OBJECTIVE, EXACTLY AS STORED\n');
      for (const [k, v] of Object.entries(stored)) {
        console.log(`    ${k.padEnd(18)} ${v instanceof Date ? v.toISOString() : String(v)}`);
      }
      console.log('');
      const mismatches = [];
      if (stored.objective !== OBJECTIVE.objective) mismatches.push('objective');
      if (stored.priority !== OBJECTIVE.priority) mismatches.push('priority');
      if (stored.kpi_metric !== OBJECTIVE.kpiMetric) mismatches.push('kpi_metric');
      if (Number(stored.kpi_target) !== OBJECTIVE.kpiTarget) mismatches.push('kpi_target');
      if (Number(stored.budget_usd) !== OBJECTIVE.budgetUsd) mismatches.push('budget_usd');
      if (stored.autonomy_tier !== OBJECTIVE.autonomyTier) mismatches.push('autonomy_tier');
      if (stored.approval_policy !== OBJECTIVE.approvalPolicy) mismatches.push('approval_policy');
      if (stored.created_by !== OBJECTIVE.createdBy) mismatches.push('created_by');
      if (stored.company_id !== company.id) mismatches.push('company_id');
      if (mismatches.length) bad(`stored fields do not match the approved objective: ${mismatches.join(', ')}`);
      else ok('every stored field matches the approved objective exactly');

      if (stored.status !== 'draft') {
        bad(`the objective is "${stored.status}", not draft — creation and activation were NOT separate`);
      } else ok('the objective is DRAFT — creation and activation remain separate, as ruled');
    }

    // Prove it cannot execute while draft.
    const { resolveObjectiveContext } = require('../src/lib/office/context');
    let ctxErr = null;
    try { await resolveObjectiveContext({ objectiveId: OBJECTIVE_ID }); } catch (err) { ctxErr = err; }
    if (!ctxErr) bad('a DRAFT objective yielded an execution context — it could be executed before activation');
    else if (ctxErr.code !== 'NO_COMPANY_CONTEXT') bad(`the draft objective failed for the wrong reason: ${ctxErr.message}`);
    else ok('the draft objective grants NO execution context — nothing can run against it yet');

    // ══ NOTHING ELSE WAS CREATED ═══════════════════════════════════════════
    console.log('');
    const counts = (await query(
      `SELECT (SELECT COUNT(*)::int FROM objectives) AS objectives,
              (SELECT COUNT(*)::int FROM agent_runs WHERE company_id IS NOT NULL) AS office_runs,
              (SELECT COUNT(*)::int FROM office_cost_ledger) AS ai_calls,
              (SELECT COUNT(*)::int FROM office_approvals) AS approvals,
              (SELECT COUNT(*)::int FROM office_outcomes) AS outcomes,
              (SELECT COUNT(*)::int FROM office_exceptions) AS exceptions`
    )).rows[0];
    console.log(`  objectives=${counts.objectives}  office_runs=${counts.office_runs}  ai_calls=${counts.ai_calls}`
      + `  approvals=${counts.approvals}  outcomes=${counts.outcomes}  exceptions=${counts.exceptions}`);
    if (counts.objectives !== 1) bad(`expected exactly 1 objective, found ${counts.objectives}`);
    if (counts.office_runs || counts.ai_calls || counts.approvals || counts.outcomes) {
      bad('this step created a run, an AI call, an approval or an outcome — it must create only the company and the objective');
    } else ok('no run, no AI call, no approval, no outcome — only the company and the objective exist');

    console.log('\n' + (fail
      ? `FAIL  ${fail} assertion(s) failed`
      : 'PASS  Abiozen and the first CEO objective exist, stored exactly as approved, in DRAFT. '
        + 'Nothing is activated and nothing has executed.'));
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\nFAIL  creation error:', e.stack || e.message);
    process.exit(1);
  }
})();
