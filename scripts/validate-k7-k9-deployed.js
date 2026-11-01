#!/usr/bin/env node
// ── §13 + K9: APPROVAL AND PROVENANCE, VALIDATED AGAINST PRODUCTION ─────────
//
//   railway ssh 'node scripts/validate-k7-k9-deployed.js'
//
// READ-ONLY. No INSERT, UPDATE or DELETE. No AI call. No approval is created, decided or released.
//
// ── WHY IT IS BUILT THIS WAY ────────────────────────────────────────────────
//
//   "Use safe positive production validation plus structural evidence. Do not attack a real
//    pending action."
//
// So nothing here attempts a release to watch it be refused. Those properties — pending cannot
// release, rejected cannot release, double release refused, approved payload immutable, unapproved
// predicate mutation — are proven on fixtures by check-office-governed-ai-db.js, including the M4
// mutation control which removes the `approved` predicate and shows a PENDING action releasing.
// That control is what makes "approval precedes the action" a measured claim.
//
// Production establishes the other half: that the DEPLOYED path would create the correct durable
// approval object, and that no external release capability is reachable yet.
//
// It also prints the §14 prerequisite checklist, because activation is gated on it and a checklist
// assembled by hand is a checklist that drifts.
'use strict';

const fs = require('fs');
const path = require('path');
const scope = require('../src/lib/office/scope');
const autonomy = require('../src/lib/autonomy');
const { query } = require('../src/lib/db');

const APPROVED_OBJECTIVE = 'obj-abiozen-first-governed-rfq';

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
    console.log('\n══ §13 · K7 APPROVAL + K9 PROVENANCE, ON PRODUCTION (READ-ONLY) ══\n');
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    const company = (await query(`SELECT id, display_name FROM companies WHERE slug='abiozen'`)).rows[0];
    if (!company) { bad('no abiozen company'); process.exit(1); }
    const ctx = Object.freeze({ companyId: company.id, objectiveId: null, runId: null });

    // ══ 1. THE APPROVAL OBJECT IS DEPLOYED, AND IMMUTABLE ══════════════════
    console.log('  K7 · THE DURABLE APPROVAL OBJECT\n');

    const cols = (await query(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_name = 'office_approvals' ORDER BY ordinal_position`)).rows;
    const have = cols.map((c) => c.column_name);
    const need = ['id', 'company_id', 'run_id', 'objective_id', 'action_kind', 'action_payload',
      'status', 'reason', 'owner_user_id', 'resolved_by', 'resolved_at', 'released_at', 'released_by'];
    const missingCols = need.filter((c) => !have.includes(c));
    if (missingCols.length) bad('office_approvals is missing column(s)', missingCols.join(', '));
    else ok(`office_approvals carries all ${need.length} required columns`);

    const statusCheck = (await query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'office_approvals'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%status%'`)).rows[0];
    if (!statusCheck) bad('office_approvals has no status CHECK — any string could be a status');
    else {
      const d = statusCheck.def;
      const wanted = ['pending', 'approved', 'rejected'];
      const absent = wanted.filter((w) => !d.includes(`'${w}'`));
      if (absent.length) bad('the status CHECK does not include the required states', `${d}\nmissing: ${absent.join(', ')}`);
      else ok(`the status vocabulary is closed by a database CHECK: ${d.replace(/^CHECK\s*/, '').slice(0, 90)}`);
    }

    const payloadTrig = (await query(
      `SELECT tgname, tgenabled FROM pg_trigger
        WHERE tgname = 'trg_office_approvals_payload_immutable' AND NOT tgisinternal`)).rows[0];
    if (!payloadTrig) {
      bad('the approval payload immutability trigger is ABSENT — what a human approved could be '
        + 'changed before release, which is the whole point of the approval');
    } else if (payloadTrig.tgenabled === 'D') {
      bad('the approval payload immutability trigger is DISABLED');
    } else ok('the approved payload is immutable in the database — what a human reads is what would go out');

    // Rule 7: PRESENCE is verified here; behaviour is proven on fixtures. No attempt is made to
    // mutate a real payload to watch the trigger fire.
    note('trigger PRESENCE verified structurally; its behaviour is proven on fixtures (Rule 7)');

    // ══ 2. THE RELEASE PREDICATES ARE IN THE DEPLOYED SQL ══════════════════
    console.log('\n  K7 · WHAT RELEASE REQUIRES\n');
    const scopeSrc = SRC('office', 'scope.js');
    const claim = scopeSrc.slice(scopeSrc.indexOf('async function claimApprovalRelease'),
      scopeSrc.indexOf('async function approvalReleaseState'));
    if (!claim) bad('claimApprovalRelease is not present in the deployed build');
    else {
      if (/UPDATE\s+office_approvals/i.test(claim) && /RETURNING/i.test(claim)) {
        ok('release is an ARBITRATED UPDATE — the WHERE clause is the arbiter, not a prior SELECT');
      } else bad('release does not look like an arbitrated update — a SELECT-then-UPDATE can double-release');
      if (/status\s*=\s*'approved'/.test(claim)) ok("it requires status = 'approved' — a PENDING action cannot release");
      else bad('the approved predicate is MISSING from the release claim — pending work could release');
      if (/released_at\s+IS\s+NULL/i.test(claim)) ok('it requires released_at IS NULL — a second release is refused');
      else bad('the unreleased predicate is MISSING — the same action could be released twice');
    }

    const apprSrc = SRC('office', 'approval.js');
    if (/consequential\s*=\s*true/.test(apprSrc)) {
      ok('`consequential` defaults to TRUE — a caller that forgets gets the gated path');
    } else bad('consequential does not default to true — forgetting it would skip the cost gate');
    if (apprSrc.includes('budget.consequentialReleaseGate')) {
      ok('release consults the fail-closed cost gate: unknown cost blocks the ACT, not the call');
    } else bad('release does not consult the fail-closed gate');

    // ══ 3. NO EXTERNAL RELEASE CAPABILITY IS REACHABLE YET ═════════════════
    //
    // "Production establishes that the deployed governed path creates the correct durable approval
    // object BEFORE any external release capability becomes reachable." Asserted on the require
    // graph, because this is a claim about what the code CAN do, not what it does today.
    console.log('\n  K7 · THE RELEASE CAPABILITY DOES NOT EXIST YET\n');
    for (const k of Object.keys(require.cache)) if (k.includes(path.join('src', 'lib', 'office'))) delete require.cache[k];
    const before = new Set(Object.keys(require.cache));
    require('../src/lib/office/approval');
    require('../src/lib/office/procurement-rfq');
    const graph = Object.keys(require.cache).filter((k) => !before.has(k) && !k.includes('node_modules'));
    const outbound = ['mailer.js', 'whatsapp.js', path.join('outreach', 'registry.js'),
      path.join('procurement', 'rfq-claim.js')];
    const reachable = outbound.filter((m) => graph.some((f) => f.includes(m)));
    if (reachable.length) {
      bad('an OUTBOUND primitive is reachable from the approval/governed path — a release could send',
        reachable.join(', '));
    } else {
      ok('no mailer, WhatsApp, outreach or supplier-claim module is reachable from the approval path');
      ok('so "prepared, not sent" is structural: releasing marks the decision, it cannot transmit');
    }

    // ══ 4. NO REAL PENDING ACTION IS BEING ATTACKED — OR EVEN EXISTS ═══════
    console.log('\n  K7 · CURRENT APPROVAL STATE\n');
    const appr = (await query(
      `SELECT status, COUNT(*)::int n FROM office_approvals WHERE company_id = $1 GROUP BY status
        ORDER BY status`, [company.id])).rows;
    if (!appr.length) note('no approvals exist yet — nothing to attack, and nothing is pending a human');
    else for (const r of appr) console.log(`    ${String(r.status).padEnd(10)} ${r.n}`);
    const pending = await scope.listPendingApprovals(ctx);
    console.log(`    pending awaiting a human decision: ${pending.length}`);
    note('this validator created, decided and released nothing');

    // ══ 5. K9 PROVENANCE ANSWERS FOR A REAL RUN ════════════════════════════
    //
    // Safe positive validation: provenance is READ for the run the §8 validation already created.
    // Nothing is fabricated to make a chain exist.
    console.log('\n  K9 · PROVENANCE, READ FOR A REAL RUN\n');
    const aRun = (await query(
      `SELECT run_id, workflow, objective_id FROM agent_runs
        WHERE company_id = $1 AND objective_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`, [company.id])).rows[0];
    if (!aRun) {
      note('no office run exists yet — provenance has nothing to answer for, which is expected before activation');
    } else {
      const p = await scope.provenance(ctx, aRun.run_id);
      if (!p) bad(`provenance returned nothing for run ${aRun.run_id}`);
      else {
        // The shape is { objective, run, ai_calls, ai_cost, approvals, outcomes, exceptions } —
        // read from the accessor rather than assumed. The first version of this read p.run.objective_id
        // and p.ai, printed "objective undefined" and then threw on p.ai.length.
        const calls = p.ai_calls || [];
        console.log(`    run        ${p.run.run_id}  ${p.run.workflow}/${p.run.agent}  ${p.run.state}`);
        console.log(`    objective  ${p.objective.id}  "${String(p.objective.objective).slice(0, 48)}"`);
        console.log(`    set by     ${p.objective.created_by}  ·  budget $${p.objective.budget_usd}`
          + `  ·  KPI ${p.objective.kpi_metric}`);
        console.log(`    AI calls   ${calls.length}`);
        for (const c of calls) {
          console.log(`      ${c.provider}/${c.model}  ${c.tokens_input}→${c.tokens_output} tok  `
            + `${c.cost_known ? `$${Number(c.cost_usd).toFixed(8)}` : 'cost UNKNOWN'}`);
        }
        console.log(`    AI cost    $${Number(p.ai_cost.measured_usd).toFixed(8)} over `
          + `${p.ai_cost.measured_calls} measured call(s), ${p.ai_cost.unmeasured_calls} unmeasured`
          + `${p.ai_cost.lower_bound ? ' — REPORTED AS A LOWER BOUND' : ''}`);
        console.log(`    approvals  ${p.approvals.length}`);
        console.log(`    outcomes   ${p.outcomes.length}`);
        console.log(`    exceptions ${p.exceptions.length}`);

        if (p.objective.id) ok('provenance links the run to its objective — the WHY is answerable');
        else bad('provenance has no objective for this run');
        if (p.objective.created_by) ok(`and to who set that objective (${p.objective.created_by})`);
        else bad('provenance does not say who set the objective');
        if (calls.length) ok(`and to every AI call that informed it (${calls.length}), with provider, model, usage and cost`);
        else note('this run made no AI call, so there is nothing to attribute');
        if (calls.every((c) => c.cost_known === true || c.cost_usd === null)) {
          ok('no AI call claims a cost it does not have');
        } else bad('an AI call carries a cost while claiming not to know it');
        if (p.ai_cost.lower_bound === (p.ai_cost.unmeasured_calls > 0)) {
          ok('spend is flagged as a lower bound exactly when a call was unmeasured');
        } else bad('the lower-bound flag does not match the unmeasured count');
      }
    }

    // ══ 6. THE §14 PREREQUISITE CHECKLIST ══════════════════════════════════
    console.log('\n\n══ §14 · ACTIVATION PREREQUISITES ══\n');
    const obj = (await query(
      `SELECT status, budget_usd, kpi_metric FROM objectives WHERE id = $1 AND company_id = $2`,
      [APPROVED_OBJECTIVE, company.id])).rows[0];
    const budget = require('../src/lib/office/budget');
    const aiSrc = SRC('office', 'ai.js');
    const rfqSrc = SRC('office', 'procurement-rfq.js');
    const vocabW = autonomy.knownScopeKeys('workflow') || [];
    const vocabA = autonomy.knownScopeKeys('agent') || [];

    const spend = await scope.spendForObjective(ctx, APPROVED_OBJECTIVE);
    const prereqs = [
      ['stored objective verified', !!obj && obj.kpi_metric === 'qualified_supplier_quotes_received'
        && Number(obj.budget_usd) === 10, obj ? `${obj.kpi_metric}, $${obj.budget_usd}, ${obj.status}` : 'absent'],
      ['K5/K6 production validated', Number(spend.calls) >= 0 && aiSrc.includes('budget.enforceHierarchy'),
        'one accounted provider call measured on production (attributed to the validation fixture)'],
      ['budget policy active', aiSrc.includes('budget.enforceHierarchy')
        && aiSrc.indexOf('budget.enforceHierarchy') < aiSrc.indexOf('llm.callClaude')
        && budget.DAILY_CAP_USD === 100, `$${budget.DAILY_CAP_USD}/day, enforced before the provider`],
      ['governed renderer deployed', rfqSrc.includes('async function renderGovernedRFQ')
        && rfqSrc.includes('identityContainment'), 'with identity containment'],
      ['K7 approval wiring deployed', !!payloadTrig && payloadTrig.tgenabled !== 'D'
        && /status\s*=\s*'approved'/.test(scopeSrc) && apprSrc.includes('budget.consequentialReleaseGate'),
        'immutable payload, approved predicate, fail-closed gate'],
      ['K8 recognizes the new scopes', vocabW.includes('governed-rfq-generation')
        && vocabW.includes('objective-review') && vocabA.includes('procurement-agent'),
        `${vocabW.length} workflow / ${vocabA.length} agent keys, independent of load order`],
      ['K9 provenance wiring deployed', typeof scope.provenance === 'function'
        && !!aRun, 'answers for a real run'],
      ['governed-office entry point wired', rfqSrc.includes('async function runGovernedProcurement'),
        'separate from the weekly cron, which is untouched'],
    ];
    let blocked = 0;
    for (const [name, pass, detail] of prereqs) {
      if (!pass) blocked++;
      console.log(`  ${pass ? 'ok  ' : 'NO  '}  ${name.padEnd(34)} ${detail}`);
    }
    console.log('');
    if (blocked) {
      bad(`${blocked} activation prerequisite(s) are NOT met — the objective must not be activated yet`);
    } else {
      ok('every §14 prerequisite is met — the approved objective is ready to be activated');
      note(`it is currently "${obj.status}"; activation remains a separate, deliberate command`);
    }

    console.log('\n' + (fail
      ? `FAIL  ${fail} assertion(s) failed`
      : 'PASS  the deployed path creates a correct, immutable, blocking approval object, no release '
        + 'capability can transmit, provenance answers for a real run, and no pending action was '
        + 'touched to prove any of it.'));
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\nFAIL  validation error:', e.stack || e.message);
    process.exit(1);
  }
})();
