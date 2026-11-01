#!/usr/bin/env node
// ── §7 + §8: READ THE DURABLE OBJECTIVE, THEN ONE GOVERNED AI CALL ──────────
//
//   railway ssh 'node scripts/office-validate-governed-ai.js'
//
// Part A verifies the stored Abiozen company and objective against the approved proposal and
// STOPS on any material difference, before anything else happens and before any money is spent.
// Part B makes exactly ONE authorized, non-sending governed AI invocation through the kernel path
// and reports every field the ruling asks for.
//
// ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
//
// No supplier contact. No RFQ release. No fabricated outcome. No fabricated approval. No email,
// no WhatsApp, no outward call of any kind — `governedCall` reaches Anthropic and nothing else.
// It does not activate the approved objective (§14 puts that last). It does not correct production
// data: a mismatch is reported and the script exits.
//
// ── RULE 7 COMPLIANCE, EXPLICITLY ──────────────────────────────────────────
//
// Nothing here performs a mutation it predicts will be refused:
//   · the configured model is used, never a suspected-invalid one to watch it fail (§10)
//   · no budget threshold is consumed to watch it refuse (§11)
//   · no workflow is stopped to watch the kill switch bite (§5)
//   · no approval is attacked, no CAS is injected (§5, §13)
//   · the approved objective/company/run are not mutated to watch immutability hold (§5)
// Those are fixture properties and `check-office-governed-ai-db.js` already proves them with
// mutation controls. This script proves the DEPLOYED path performs a safe positive execution.
//
// ── THE ONE JUDGMENT CALL, STATED PLAINLY ──────────────────────────────────
//
// §9 wants objective attribution on the cost evidence. §14 says the approved objective is
// activated LAST, after K5/K6 is validated. A draft objective yields no execution context by
// design, and MATCH FULL means a run cannot carry a company without an objective — so the paid
// call cannot be attributed to the approved objective without activating it early, which §14
// forbids, or activating and reverting it, which Rule 7 now forbids.
//
// So the call is attributed to a CONTROLLED VALIDATION FIXTURE OBJECTIVE under the real Abiozen
// company, created for this purpose, named so it cannot be mistaken for the approved one, and
// CANCELLED at the end so nothing can execute against it again. The property under test is that
// the kernel attributes spend to whatever objective the run was opened against — not which
// objective that is. The approved objective is read and left in `draft`, untouched.
//
// The fixture row stays. It is not deleted, because the cost-ledger row references it and that
// evidence is the point of the exercise — deleting the fixture would delete the proof.
//
// ── SAFE TO RUN TWICE ───────────────────────────────────────────────────────
//
// `railway ssh` has now failed five distinct ways, so a re-run must not buy a second AI call. The
// run carries a stable intent key; a duplicate is detected and the existing evidence is read back
// and reported instead of spending again.
'use strict';

const llm = require('../src/lib/llm');
const autonomy = require('../src/lib/autonomy');
const scope = require('../src/lib/office/scope');
const ai = require('../src/lib/office/ai');
const { beginObjectiveRun } = require('../src/lib/office/run');
const { resolveObjectiveContext } = require('../src/lib/office/context');
const { query } = require('../src/lib/db');
const { ledger } = require('../src/lib/run-ledger');

// The approved objective, verbatim from the ruling. Part A compares production against this.
const APPROVED = Object.freeze({
  id: 'obj-abiozen-first-governed-rfq',
  objective: 'Obtain a qualified supplier quotation through governed RFQ outreach',
  priority: 'P1',
  kpi_metric: 'qualified_supplier_quotes_received',
  kpi_target: 1,
  deadline: '2026-11-15',
  budget_usd: 10,
  autonomy_tier: 'supervised',
  approval_policy: 'all_consequential',
  created_by: 'naren',
  status: 'draft',
});

// The validation fixture. Stable id, so a second run finds it rather than making another.
const FIXTURE_ID = 'obj-k5k6-governed-ai-validation';
const WORKFLOW = 'governed-ai-validation';
const AGENT = 'validation-agent';

// Stoppable, so the vocabulary stays honest: an operator can halt this workflow by name.
autonomy.registerScopes({ workflows: [WORKFLOW], agents: [AGENT] });

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};
const note = (m) => console.log(`  --    ${m}`);
const field = (k, v) => console.log(`    ${String(k).padEnd(20)} ${v === null || v === undefined ? '(null)' : v}`);

(async () => {
  try {
    console.log('\n══ §7 · THE DURABLE CONTROL-PLANE DATA, READ FROM PRODUCTION ══\n');
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    // ══ PART A: READ AND COMPARE. NOTHING ELSE HAPPENS UNTIL THIS PASSES ════
    const company = (await query(
      `SELECT id, slug, display_name, status, created_at FROM companies WHERE slug = 'abiozen'`
    )).rows[0];
    if (!company) {
      bad('no company with slug "abiozen" — nothing to validate against. STOPPING.');
      process.exit(1);
    }
    console.log('  COMPANY');
    field('id', company.id);
    field('slug', company.slug);
    field('display_name', company.display_name);
    field('status', company.status);
    field('created_at', company.created_at.toISOString());

    const obj = (await query(
      `SELECT id, company_id, objective, priority, kpi_metric, kpi_target, deadline, budget_usd,
              autonomy_tier, approval_policy, status, created_by, created_at, updated_at
         FROM objectives WHERE id = $1`, [APPROVED.id]
    )).rows[0];
    if (!obj) {
      bad(`objective ${APPROVED.id} does not exist in production. STOPPING — it is not to be recreated here.`);
      process.exit(1);
    }
    console.log('\n  OBJECTIVE, EXACTLY AS STORED');
    for (const [k, v] of Object.entries(obj)) field(k, v instanceof Date ? v.toISOString() : v);

    console.log('\n  COMPARED TO THE APPROVED PROPOSAL');
    const diffs = [];
    const cmp = (k, got, want) => {
      const same = String(got) === String(want);
      if (!same) diffs.push(`${k}: stored "${got}" ≠ approved "${want}"`);
      console.log(`    ${same ? 'ok  ' : 'DIFF'}  ${k.padEnd(18)} ${got}`);
    };
    cmp('objective', obj.objective, APPROVED.objective);
    cmp('priority', obj.priority, APPROVED.priority);
    cmp('kpi_metric', obj.kpi_metric, APPROVED.kpi_metric);
    cmp('kpi_target', Number(obj.kpi_target), APPROVED.kpi_target);
    cmp('deadline', obj.deadline instanceof Date ? obj.deadline.toISOString().slice(0, 10) : obj.deadline, APPROVED.deadline);
    cmp('budget_usd', Number(obj.budget_usd), APPROVED.budget_usd);
    cmp('autonomy_tier', obj.autonomy_tier, APPROVED.autonomy_tier);
    cmp('approval_policy', obj.approval_policy, APPROVED.approval_policy);
    cmp('created_by', obj.created_by, APPROVED.created_by);
    cmp('status', obj.status, APPROVED.status);
    cmp('company_id', obj.company_id, company.id);

    if (diffs.length) {
      console.log('\n  ══ STOP ══\n');
      console.log('  The stored objective differs materially from the approved proposal:\n');
      diffs.forEach((d) => console.log(`    · ${d}`));
      console.log('\n  Production data is NOT being corrected here. No AI call was made and nothing');
      console.log('  was spent. This needs a human decision about which version is right.\n');
      process.exit(1);
    }
    ok('every stored field matches the approved proposal — proceeding to the governed AI call');

    // ══ PART B: ONE NON-SENDING GOVERNED AI CALL ═══════════════════════════
    console.log('\n\n══ §8 · ONE AUTHORIZED NON-SENDING GOVERNED AI INVOCATION ══\n');
    note('attributed to a controlled validation fixture objective, NOT to the approved objective');
    note('the approved objective stays in draft and is not activated here (§14 puts that last)');
    console.log('');

    // The fixture, under the real company. Idempotent.
    let fx = await query(`SELECT id, status FROM objectives WHERE id = $1 AND company_id = $2`,
      [FIXTURE_ID, company.id]);
    if (!fx.rows[0]) {
      await scope.createObjective({
        id: FIXTURE_ID,
        companyId: company.id,
        objective: 'VALIDATION FIXTURE — K5/K6 governed AI invocation proof. Not a business objective.',
        priority: 'P3',
        kpiMetric: 'governed_ai_calls_validated',
        kpiTarget: 1,
        deadline: '2026-11-30',
        budgetUsd: 1,
        autonomyTier: 'none',
        approvalPolicy: 'all_consequential',
        createdBy: 'validation',
      });
      ok(`created validation fixture objective ${FIXTURE_ID}`);
    } else {
      note(`validation fixture ${FIXTURE_ID} already exists (${fx.rows[0].status}) — reusing it`);
    }

    const fxCtxForStatus = Object.freeze({ companyId: company.id, objectiveId: FIXTURE_ID, runId: null });
    await scope.setObjectiveStatus(fxCtxForStatus, { id: FIXTURE_ID, status: 'active' });

    // The run. Company is DERIVED from the fixture objective; there is no parameter for it.
    const begun = await beginObjectiveRun({
      objectiveId: FIXTURE_ID,
      trigger: 'manual',
      triggerDetail: 'office-validate-governed-ai.js (§8 non-sending validation)',
      workflow: WORKFLOW,
      agent: AGENT,
      maxRuntimeMinutes: 5,
    });

    const L = ledger({ query });
    let callResult = null;
    let providerMs = null;
    let runId = begun.runId;

    if (begun.duplicate) {
      note(`a run for this intent already exists (${begun.intentKey}) — NOT buying a second AI call`);
      const prior = (await query(
        `SELECT run_id FROM agent_runs WHERE intent_key = $1 ORDER BY created_at DESC LIMIT 1`,
        [begun.intentKey]
      )).rows[0];
      runId = prior && prior.run_id;
      ok('re-run is idempotent: the existing evidence is reported below instead of spending again');
    } else {
      ok(`run ${runId} created — company derived from the objective, not supplied`);
      if (begun.context.companyId !== company.id) {
        bad('the run was attributed to the wrong company', begun.context.companyId);
      } else ok('the run carries the Abiozen company id, derived from the fixture objective');

      // CREATED → RUNNING before any work. The K2 defect: skipping this leaves a run in CREATED
      // while `finish` (operational — logs, does not throw) reports success.
      await L.startRun(runId);
      ok('run started: CREATED → RUNNING');

      // ── THE CALL ─────────────────────────────────────────────────────────
      // Inert prompt, tiny budget, configured capability alias — never a literal model pin, and
      // never a suspected-invalid model to watch it fail (§10).
      const t0 = Date.now();
      callResult = await ai.governedCall(begun.context, {
        capability: 'fast',
        prompt: 'Reply with exactly the two characters: OK',
        maxTokens: 16,
        workflow: WORKFLOW,
        agent: AGENT,
        purpose: 'K5/K6 production validation — non-sending governed AI invocation',
      });
      providerMs = Date.now() - t0;

      console.log('');
      if (callResult.ok) ok(`the provider call completed and was accounted (${providerMs}ms)`);
      else if (!callResult.accounted) {
        bad('FAIL CLOSED: the call was made but its cost evidence could not be persisted, so the '
          + 'text was withheld', callResult.error);
      } else bad('the governed call did not succeed', callResult.error);

      const fin = await L.finish(runId);
      ok(`run finished → ${fin.state}`);
    }

    // ══ §8 / §9 EVIDENCE, READ BACK FROM THE DATABASE ══════════════════════
    console.log('\n\n══ §8 · CAPTURED FIELDS ══\n');
    const run = (await query(
      `SELECT run_id, company_id, objective_id, workflow, agent, state, trigger,
              intent_key, max_runtime_minutes, started_at, ended_at
         FROM agent_runs WHERE run_id = $1`, [runId]
    )).rows[0];
    const cost = (await query(
      `SELECT id, company_id, objective_id, run_id, workflow, agent, provider, model,
              tokens_input, tokens_output, cost_usd, cost_known, at
         FROM office_cost_ledger WHERE run_id = $1 ORDER BY at DESC LIMIT 1`, [runId]
    )).rows[0];

    field('company', run ? run.company_id : '(no run)');
    field('objective', run ? run.objective_id : '(no run)');
    field('run', runId || '(none)');
    field('workflow', run && run.workflow);
    field('agent', run && run.agent);
    field('provider', cost && cost.provider);
    field('model (literal)', cost && cost.model);
    // The capability alias is what the agent requested; the ledger stores the resolved literal
    // model, which is the thing that has to stay explicable. Reported from the call, not the row.
    field('capability', callResult ? (callResult.capability || 'fast') : 'fast (prior run)');
    // Measured around governedCall, so it is the provider round trip plus the accounting write —
    // not the run's wall clock, which would also include everything this script did around it.
    field('latency', providerMs !== null ? `${providerMs} ms (provider call + accounting)`
      : (run && run.started_at && run.ended_at
        ? `${new Date(run.ended_at) - new Date(run.started_at)} ms (run wall clock, prior run)` : '(unknown)'));
    field('input tokens', cost && cost.tokens_input);
    field('output tokens', cost && cost.tokens_output);
    field('cost_known', cost && cost.cost_known);
    field('cost_usd', cost && (cost.cost_known ? `$${Number(cost.cost_usd).toFixed(8)}` : 'UNKNOWN — deliberately not $0'));
    field('timeout policy', `${llm.DEFAULT_LLM_TIMEOUT_MS} ms default, ${llm.MIN_LLM_TIMEOUT_MS} ms floor; unbounded not expressible`);
    field('terminal run state', run && run.state);
    field('max_runtime_minutes', run && run.max_runtime_minutes);
    field('intent_key', run && run.intent_key);

    // ══ §9 · SUCCESS CRITERIA, ASSERTED ════════════════════════════════════
    console.log('\n\n══ §9 · PRODUCTION SUCCESS CRITERIA ══\n');
    if (!run) { bad('no run row — nothing to assert'); }
    else {
      if (!cost) bad('NO COST EVIDENCE ROW — the invocation left no durable accounting');
      else {
        ok('durable cost evidence exists in office_cost_ledger');
        if (cost.company_id === company.id) ok('company attribution: Abiozen'); else bad('wrong company on the cost row', cost.company_id);
        if (cost.objective_id === FIXTURE_ID) ok('objective attribution: the validation fixture'); else bad('wrong objective on the cost row', cost.objective_id);
        if (cost.run_id === runId) ok('run attribution'); else bad('wrong run on the cost row', cost.run_id);
        if (cost.workflow === WORKFLOW) ok(`workflow attribution: ${WORKFLOW}`); else bad('workflow missing from the cost row', cost.workflow);
        if (cost.agent === AGENT) ok(`agent attribution: ${AGENT}`); else bad('agent missing from the cost row', cost.agent);
        if (cost.provider === 'anthropic') ok('provider identity recorded'); else bad('provider identity wrong', cost.provider);
        if (cost.model && /^claude-/.test(cost.model)) ok(`literal model id recorded: ${cost.model}`);
        else bad('the literal model id was not recorded — a past decision is not explicable', cost.model);

        // Usage, and the rule that matters most: unknown is never zero.
        const haveUsage = Number.isInteger(cost.tokens_input) && Number.isInteger(cost.tokens_output)
          && (cost.tokens_input > 0 || cost.tokens_output > 0);
        if (haveUsage) ok(`usage normalized: ${cost.tokens_input} in / ${cost.tokens_output} out`);
        else note('provider usage absent — then cost MUST be unknown, asserted next');

        if (cost.cost_known === true && cost.cost_usd !== null) {
          ok(`cost known and durable: $${Number(cost.cost_usd).toFixed(8)}`);
          if (!haveUsage) bad('cost is claimed KNOWN with no usage to derive it from — that is a fabricated number');
        } else if (cost.cost_known === false && cost.cost_usd === null) {
          ok('cost UNKNOWN and recorded as unknown — not $0, so consequential release stays fail-closed');
        } else {
          bad('the cost_known/cost_usd pair is in an impossible state', `cost_known=${cost.cost_known} cost_usd=${cost.cost_usd}`);
        }
      }
      if (['SUCCEEDED', 'PARTIAL', 'FAILED', 'ABANDONED', 'STOPPED_BY_POLICY'].includes(run.state)) {
        if (run.state === 'SUCCEEDED') ok('correct terminal run state: SUCCEEDED');
        else bad(`the run ended ${run.state}, not SUCCEEDED`);
      } else bad(`the run is not in a terminal state: ${run.state}`);
      if (run.started_at && run.ended_at) ok('both run timestamps are durable');
      else bad('run timestamps incomplete');
    }

    // ══ NOTHING CONSEQUENTIAL HAPPENED ═════════════════════════════════════
    console.log('\n\n══ NOTHING CONSEQUENTIAL HAPPENED ══\n');
    const after = (await query(
      `SELECT (SELECT COUNT(*)::int FROM office_approvals) AS approvals,
              (SELECT COUNT(*)::int FROM office_outcomes) AS outcomes,
              (SELECT COUNT(*)::int FROM office_exceptions WHERE resolved_at IS NULL) AS open_exceptions`
    )).rows[0];
    console.log(`  approvals=${after.approvals}  outcomes=${after.outcomes}`
      + `  open_exceptions=${after.open_exceptions}`);
    if (after.approvals || after.outcomes) {
      bad('this validation created an approval or an outcome — it must create neither');
    } else ok('no approval, no outcome — no claim that a business action occurred');

    // Separate, and defensive: this script does not own supplier_outreach_log's shape, and an
    // unexpected column name here must not abort the evidence report above it.
    try {
      const sent = (await query(
        `SELECT COUNT(*)::int n FROM supplier_outreach_log WHERE created_at > NOW() - INTERVAL '1 hour'`
      )).rows[0].n;
      if (sent) bad(`${sent} supplier outreach row(s) in the last hour — investigate`);
      else ok('no supplier was contacted');
    } catch (e) {
      note(`supplier_outreach_log not countable here (${e.message.slice(0, 60)}) — reported, not assumed`);
      note('the stronger guarantee is structural: this script requires no mailer and no outbound module');
    }

    // ══ SPEND, AS THE BUDGET WILL SEE IT ═══════════════════════════════════
    // The FROZEN context, not a look-alike literal: assertContext refuses an object that merely
    // has the right shape, which is the point of it — and it caught this script's first version.
    const objSpend = await scope.spendForObjective(fxCtxForStatus, FIXTURE_ID);
    const daySpend = await scope.spendToday(fxCtxForStatus);
    console.log('\n  SPEND');
    field('fixture objective', JSON.stringify(objSpend));
    field('enterprise today', JSON.stringify(daySpend));

    // ══ K8 RECOGNIZES THE NEW SCOPES ═══════════════════════════════════════
    console.log('\n  K8 SCOPE VOCABULARY');
    const wf = autonomy.knownScopeKeys('workflow') || [];
    const ag = autonomy.knownScopeKeys('agent') || [];
    if (wf.includes(WORKFLOW)) ok(`K8 recognizes workflow:${WORKFLOW} — an operator can stop it by name`);
    else bad(`K8 does not recognize workflow:${WORKFLOW}`);
    if (ag.includes(AGENT)) ok(`K8 recognizes agent:${AGENT}`); else bad(`K8 does not recognize agent:${AGENT}`);

    // ══ CLOSE THE FIXTURE ══════════════════════════════════════════════════
    // Cancelled, so nothing can open another run against it. The ROW stays: the cost-ledger
    // evidence references it, and deleting the fixture would delete the proof.
    console.log('');
    await scope.setObjectiveStatus(fxCtxForStatus, { id: FIXTURE_ID, status: 'cancelled' });
    const closed = (await query(`SELECT status FROM objectives WHERE id = $1`, [FIXTURE_ID])).rows[0];
    if (closed && closed.status === 'cancelled') ok('validation fixture CANCELLED — nothing can execute against it again');
    else bad('the fixture was not closed', closed && closed.status);

    // A read, not a probe: a cancelled objective must yield no execution context.
    let ctxErr = null;
    try { await resolveObjectiveContext({ objectiveId: FIXTURE_ID }); } catch (e) { ctxErr = e; }
    if (ctxErr && ctxErr.code === 'NO_COMPANY_CONTEXT') ok('the cancelled fixture grants no execution context');
    else bad('a cancelled objective still yields an execution context', ctxErr && ctxErr.message);

    // And the approved objective is exactly where it was.
    const stillDraft = (await query(`SELECT status FROM objectives WHERE id = $1`, [APPROVED.id])).rows[0];
    if (stillDraft && stillDraft.status === 'draft') ok('the APPROVED objective is still draft — untouched by this validation');
    else bad(`the approved objective is now "${stillDraft && stillDraft.status}" — this validation changed it`);

    console.log('\n' + (fail
      ? `FAIL  ${fail} assertion(s) failed`
      : 'PASS  one governed AI invocation executed on production, bounded and fully accounted. '
        + 'Nothing was sent. The approved objective remains draft.'));
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\nFAIL  validation error:', e.stack || e.message);
    process.exit(1);
  }
})();
