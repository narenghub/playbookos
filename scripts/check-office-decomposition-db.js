#!/usr/bin/env node
// ── B3.2: A PLAN IS A PROPOSAL, NOT AN AUTHORIZATION ────────────────────────
//
//   node scripts/check-office-decomposition-db.js   exit 0 = every ruled property holds
//                                                   exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner instruction, 2026-11-24:
//
//   "Implement dynamic objective decomposition and governed multi-agent delegation. Agent-generated
//    plans are proposals, not authorization. Every proposed step must be independently validated
//    against company scope, capability permissions, execution eligibility, STOP controls, approval
//    requirements and budget. Do not permit arbitrary agent-generated code execution."
//
// ── WHAT WOULD MAKE THIS CHECK WORTHLESS ────────────────────────────────────
//
// A validator that refuses everything passes every negative case. So every refusal below is paired
// with a POSITIVE CONTROL on the same fixture: the same plan, the same objective, the same company,
// with only the thing under test changed. If the positive control does not produce a PERMITTED
// plan, the refusals prove nothing and the check says so.
//
// That is the lesson from check-execution-eligibility-db.js, where `autonomy_stops` was missing,
// the kill switch failed closed, every claim was refused, and a dozen assertions passed for
// entirely the wrong reason.
//
// NO URL OVERRIDE: this INSERTs companies, objectives, runs, plans and worker identities. Its own
// disposable cluster; fixtures deleted by id.

'use strict';

const crypto = require('node:crypto');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail++;
  console.log(`  FAIL  ${m}`);
  if (extra !== undefined) console.log(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
};
const note = (m) => console.log(`  --    ${m}`);

const DISPOSABLE = require('./lib/pg-disposable');
let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'decomp' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  decomposition not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
// These fixtures used to INSERT an identity directly, which is why this was never
// needed. They now go through the enrolment exchange — the only path that may create a
// widened identity — and the exchange seals the secret at rest. Generated per run: no
// real credential is read and none is needed.
process.env.WORKER_SECRET_SEAL_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.ADMIN_EMAIL = 'decomp-bootstrap@decomp.invalid';
process.env.ADMIN_PASSWORD = `decomp-${crypto.randomBytes(16).toString('hex')}`;

const WATCHDOG_MS = Number(process.env.DECOMP_CHECK_TIMEOUT_MS || 240_000);
const watchdog = setTimeout(() => {
  console.log(`\n  FAIL  no progress in ${Math.round(WATCHDOG_MS / 1000)}s — a stall is a failure.`);
  try { cluster.destroy(); } catch (_) {}
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: cluster.url, ssl: false });
  const q = (t, p) => P.query(t, p);
  const deps = { query: q };
  const ids = { companies: [], objectives: [], runs: [], plans: [], workers: [] };
  const uid = (p) => `decomp-${p}-${crypto.randomUUID().slice(0, 8)}`;

  try {
    await require('../src/lib/db').initDB();
    await require('../src/lib/runs').migrateRuns(q);
    await require('../src/lib/office/schema').migrateOffice(q);
    await require('../src/lib/autonomy').migrateAutonomy(q);
    await require('../src/lib/worker/identity').migrateWorkerIdentity(q);
    console.log('  ..    schema up\n');

    const DEC = require('../src/lib/office/decomposition');
    const scope = require('../src/lib/office/scope');
    const CTX = require('../src/lib/office/context');
    const autonomy = require('../src/lib/autonomy');
    const door = CTX.contextForTests__TEST_ONLY;

    const A = uid('co-a');
    const B = uid('co-b');
    for (const c of [A, B]) {
      await q(`INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,$1,'active')`, [c]);
      ids.companies.push(c);
    }

    const mkObjective = async (company, { budgetUsd = 100, tier = 'supervised',
      policy = 'all_consequential', status = 'active', kpi = 'x' } = {}) => {
      const id = uid('obj');
      await scope.createObjective({
        id, companyId: company, objective: `decomposition fixture ${id}`, priority: 'P2',
        kpiMetric: kpi, kpiTarget: 1, deadline: '2026-12-31', budgetUsd,
        autonomyTier: tier, approvalPolicy: policy, createdBy: 'ceo',
      }, deps);
      await q(`UPDATE objectives SET status = $2 WHERE id = $1`, [id, status]);
      ids.objectives.push(id);
      return id;
    };

    const mkRun = async (company, objectiveId) => {
      const runId = crypto.randomUUID();
      await q(
        `INSERT INTO agent_runs (run_id, root_run_id, company_id, objective_id, trigger, product,
                                 state, workflow, agent)
         VALUES ($1,$1,$2,$3,'office','internal','RUNNING','objective-decomposition','executive-agent')`,
        [runId, company, objectiveId]);
      ids.runs.push(runId);
      return runId;
    };

    const ctxFor = (company, objectiveId, extra = {}) => door({
      companyId: company, objectiveId, runId: null, budgetUsd: 100, autonomyTier: 'supervised',
      approvalPolicy: 'all_consequential', ...extra });

    // The plan every case starts from: one read, one worker round trip, one governed-AI summary.
    const BASE = [
      { stepType: 'observe.objective_state', args: {} },
      { stepType: 'operations.liveness_checkpoint', args: {} },
      { stepType: 'intelligence.summarise_state', args: { focus: 'spend' } },
    ];

    const decompose = async (ctx, candidates, opts = {}) => {
      const runId = opts.runId || await mkRun(ctx.companyId, ctx.objectiveId);
      const r = await DEC.decompose(ctx, {
        candidates, runId, proposer: opts.proposer || 'deterministic',
        workflow: 'objective-decomposition', agent: 'executive-agent',
        consultedMemoryIds: opts.consultedMemoryIds || [],
      }, opts.deps || deps);
      if (r.plan) ids.plans.push(r.plan.planId);
      return r;
    };

    // ══ 1. THE POSITIVE CONTROL — WITHOUT IT NOTHING BELOW MEANS ANYTHING ══
    console.log('── 1. a well-formed plan is PERMITTED, and every gate answered ──\n');

    const objOk = await mkObjective(A);
    const ctxOk = ctxFor(A, objOk);
    const good = await decompose(ctxOk, BASE);
    if (good.ok && good.validation.verdict === 'validated') {
      ok('POSITIVE CONTROL: a well-formed three-step plan is VALIDATED');
    } else bad('the positive control was refused — every refusal below is now meaningless',
      JSON.stringify({ refused: good.refused, detail: good.detail }));

    const everyGate = (good.validation.steps || []).every(
      (s) => DEC.GATES.every((g) => g in s.gates));
    if (everyGate) {
      ok(`all six gates produced an answer for every step (${DEC.GATES.join(', ')})`);
      note('a step with an unanswered gate is refused `gate_not_evaluated` — a gate that stops '
        + 'being consulted is not allowed to look like one that passed');
    } else bad('a step was permitted with a gate that never answered',
      JSON.stringify(good.validation.steps));

    // ══ 2. THE PROPOSAL CANNOT AUTHORIZE ITSELF ═══════════════════════════
    console.log('\n── 2. a proposal that states its own authorization ──\n');

    for (const [label, field, value] of [
      ['a capability', 'capability', 'email.send'],
      ['a company', 'companyId', A],
      ['an approval', 'approved', true],
      ['a budget', 'budgetUsd', 1000],
      ['a task type', 'taskType', 'synthetic.echo'],
      ['an autonomy tier', 'autonomyTier', 'bounded'],
    ]) {
      const hostile = [{ stepType: 'observe.objective_state', args: {}, [field]: value }];
      const r = await decompose(ctxOk, hostile);
      if (!r.ok && r.refused === 'proposal_asserted_authorization') {
        ok(`a proposal supplying ${label} (${field}) is REFUSED BY NAME, not sanitised`);
      } else bad(`a proposal supplying ${field} was not refused`, JSON.stringify(r.refused || r.ok));
    }
    note('refused rather than stripped: stripping lets the attempt succeed minus its effect, and '
      + 'the fact that it was made is the thing a reviewer needs');

    // ══ 3. THE VOCABULARY IS CLOSED, AND A PLAN IS REFUSED WHOLE ══════════
    console.log('\n── 3. the closed vocabulary ──\n');

    const unknown = await decompose(ctxOk, BASE.concat([{ stepType: 'shell.run', args: {} }]));
    if (!unknown.ok && unknown.refused === 'unknown_step_type') {
      ok('an unknown step type refuses the WHOLE plan, not just that step');
    } else bad('an unknown step type did not refuse the plan', JSON.stringify(unknown.refused));
    if (!unknown.plan) {
      ok('and no plan was produced at all, so there is nothing a caller could execute three steps of');
    } else bad('a plan was produced despite an unknown step', unknown.plan.planId);

    const badArg = await decompose(ctxOk,
      [{ stepType: 'operations.daily_report', args: { asOf: 'tomorrow' } }]);
    if (!badArg.ok && badArg.refused === 'bad_argument') {
      ok('a typed argument that fails its schema refuses the plan');
    } else bad('a malformed argument was accepted', JSON.stringify(badArg.refused));

    const extraArg = await decompose(ctxOk,
      [{ stepType: 'observe.objective_state', args: { cmd: 'rm -rf /' } }]);
    if (!extraArg.ok && extraArg.refused === 'unknown_argument') {
      ok('an argument the step does not declare refuses the plan — no undeclared value reaches a payload');
    } else bad('an undeclared argument was accepted', JSON.stringify(extraArg.refused));

    const tooMany = await decompose(ctxOk,
      Array.from({ length: DEC.MAX_STEPS + 1 }, () => ({ stepType: 'observe.objective_state', args: {} })));
    if (!tooMany.ok && tooMany.refused === 'too_many_steps') {
      ok(`a plan over the ${DEC.MAX_STEPS}-step bound is refused`);
    } else bad('the step bound did not hold', JSON.stringify(tooMany.refused));

    // ══ 4. A MODEL'S OUTPUT IS DATA ═══════════════════════════════════════
    console.log('\n── 4. a model-proposed plan goes through the same gates ──\n');

    const fromModel = DEC.candidatesFromModelText(
      'Here is my plan:\n```json\n[{"stepType":"observe.objective_state","args":{}},'
      + '{"stepType":"operations.liveness_checkpoint","args":{}}]\n```\nHope that helps!');
    if (fromModel.ok && fromModel.candidates.length === 2) {
      ok('a model reply wrapped in prose and a code fence is PARSED, not evaluated');
    } else bad('the model reply did not parse', JSON.stringify(fromModel));

    const modelPlan = await decompose(ctxOk, fromModel.candidates, { proposer: 'model:haiku' });
    if (modelPlan.ok) ok('and the model-proposed plan is validated by the same code path');
    else bad('the model-proposed plan was refused', JSON.stringify(modelPlan.refused));
    const modelRow = await scope.getPlan(ctxOk, modelPlan.plan.planId, deps);
    if (modelRow && modelRow.proposer === 'model:haiku') {
      ok('and the record says WHAT proposed it, so an AI-proposed plan is findable later');
    } else bad('the proposer was not recorded', JSON.stringify(modelRow));

    const hostileModel = DEC.candidatesFromModelText(
      '[{"stepType":"outreach.prepare_rfq","args":{"supplierId":"s1","moleculeName":"X"},'
      + '"capability":"email.send","approved":true,"requiresApproval":false}]');
    const hostileResult = await decompose(ctxOk, hostileModel.candidates, { proposer: 'model:haiku' });
    if (!hostileResult.ok && hostileResult.refused === 'proposal_asserted_authorization') {
      ok('a model claiming its own capability and pre-approval is refused like any other proposal');
    } else bad('a hostile model proposal was not refused', JSON.stringify(hostileResult.refused));

    for (const [label, text] of [
      ['prose with no step list', 'I think you should send some emails.'],
      ['an object instead of an array', '{"stepType":"observe.objective_state"}'],
      ['truncated JSON', '[{"stepType":"observe.objective_state", "args"'],
    ]) {
      const r = DEC.candidatesFromModelText(text);
      if (!r.ok) ok(`${label} produces no candidates (${r.refused})`);
      else bad(`${label} produced candidates`, JSON.stringify(r.candidates));
    }

    // ══ 5. GATE: COMPANY SCOPE ════════════════════════════════════════════
    console.log('\n── 5. gate 1 — company scope ──\n');

    const objB = await mkObjective(B);
    const runB = await mkRun(B, objB);
    // A context for A, a plan naming B's objective. The context is what decides.
    const crossPlan = DEC.propose(ctxFor(A, objB), { candidates: BASE });
    if (crossPlan.ok) {
      const crossVerdict = await DEC.validate(ctxFor(A, objB), crossPlan.plan, deps);
      if (!crossVerdict.ok && crossVerdict.refused === 'objective_not_in_company_scope') {
        ok('company A cannot validate a plan against company B\'s objective — the scoped read '
          + 'returns nothing and nothing is a refusal, not an empty success');
      } else bad('a cross-company plan was validated', JSON.stringify(crossVerdict.refused));
    } else bad('the cross-company plan could not even be proposed', JSON.stringify(crossPlan.refused));

    // And the database refuses it even if the accessor were written wrongly.
    let dbRefusedCross = null;
    try {
      await q(`INSERT INTO office_plans (id, company_id, objective_id, run_id, proposer, planner)
               VALUES ($1,$2,$3,$4,'x','x')`, [uid('plan'), A, objB, runB]);
    } catch (e) { dbRefusedCross = e.code; }
    if (dbRefusedCross === '23503') {
      ok('and the DATABASE refuses a plan whose objective belongs to another company (composite FK)');
    } else bad('the database accepted a cross-company plan', dbRefusedCross);

    // A payload naming a company is refused even though this file's payloads never contain one.
    const planWithCompany = DEC.propose(ctxOk, { candidates: BASE });
    planWithCompany.plan.steps[0].payload = { company_id: B };
    planWithCompany.plan.steps[0].payloadDigest = DEC.digestOf({ company_id: B });
    const companyFieldVerdict = await DEC.validate(ctxOk, planWithCompany.plan, deps);
    if (!companyFieldVerdict.ok && companyFieldVerdict.refused === 'step_names_a_company') {
      ok('a step payload that names a company is refused — scope comes from the context, and a '
        + 'step that supplies one is asserting its own');
    } else bad('a step naming a company was permitted', JSON.stringify(companyFieldVerdict.refused));

    // ══ 6. GATE: CAPABILITY PERMISSION (THE AUTONOMY TIER) ════════════════
    console.log('\n── 6. gate 2 — capability permission ──\n');

    const CONSEQUENTIAL = [{ stepType: 'outreach.prepare_rfq',
      args: { supplierId: 's-fix', moleculeName: 'Candidatium' } }];

    const objSup = await mkObjective(A, { tier: 'supervised' });
    const supervised = await decompose(ctxFor(A, objSup), CONSEQUENTIAL);
    if (supervised.ok) {
      ok('POSITIVE CONTROL: a supervised objective may PREPARE a consequential step');
    } else bad('a supervised objective could not prepare', JSON.stringify(supervised.refused));

    const objNone = await mkObjective(A, { tier: 'none' });
    const tierNone = await decompose(ctxFor(A, objNone), CONSEQUENTIAL);
    if (!tierNone.ok && tierNone.refused === 'tier_forbids_consequential') {
      ok('tier `none` may observe and report — a consequential step is refused');
    } else bad('tier none permitted a consequential step', JSON.stringify(tierNone.refused));
    const tierNoneRead = await decompose(ctxFor(A, objNone), BASE);
    if (tierNoneRead.ok) {
      ok('and the SAME objective still validates a read-only plan, so the refusal is about the '
        + 'step and not about the objective');
    } else bad('tier none refused a read-only plan too', JSON.stringify(tierNoneRead.refused));

    const objBounded = await mkObjective(A, { tier: 'bounded' });
    const bounded = await decompose(ctxFor(A, objBounded), BASE);
    if (!bounded.ok && bounded.refused === 'autonomy_tier_not_authorized') {
      ok('tier `bounded` is NOT AUTHORIZED and fails closed — it is not read as the most '
        + 'permissive tier');
    } else bad('a bounded objective was permitted', JSON.stringify(bounded.refused));

    // An unknown tier turned out to be unreachable: the objectives table has a CHECK on
    // autonomy_tier, so the DATABASE refuses one before the planner is ever asked. That is a
    // stronger guarantee than the planner's own fail-closed branch, so it is asserted here and the
    // branch is kept for the case this constraint is ever relaxed.
    let tierRefusedByDb = null;
    try {
      await q(`UPDATE objectives SET autonomy_tier = 'whatever-comes-next' WHERE id = $1`, [objBounded]);
    } catch (e) { tierRefusedByDb = e.code; }
    if (tierRefusedByDb === '23514') {
      ok('an UNKNOWN tier cannot even be stored — the objectives table refuses it (23514), so the '
        + 'planner\'s fail-closed branch is a second line rather than the only one');
    } else bad('an unknown autonomy tier could be written to an objective', tierRefusedByDb);

    // ══ 7. GATE: EXECUTION ELIGIBILITY ════════════════════════════════════
    console.log('\n── 7. gate 3 — execution eligibility ──\n');

    const HARDWARE = BASE.concat([{ stepType: 'operations.hardware_rehearsal', args: {} }]);
    const objHw = await mkObjective(A);
    const noWorker = await decompose(ctxFor(A, objHw), HARDWARE);
    if (noWorker.ok && noWorker.validation.verdict === 'validated_with_queued_steps') {
      ok('a HARDWARE_REQUIRED step with no capable worker enrolled is QUEUED, not refused');
      note('"hardware-only work must queue safely without consuming retry attempts or being '
        + 'claimed by cloud workers" — refusing here would make a correct plan fail because a '
        + 'machine is currently offline, and the obvious next fix would be to let cloud take it');
    } else bad('the hardware step was not queued', JSON.stringify(noWorker.validation));
    const queuedStep = (noWorker.validation.queuedSteps || [])[0];
    if (queuedStep && queuedStep.awaiting === 'exec:hardware') {
      ok('and the verdict NAMES the capability it is waiting for, so a stalled plan is visible');
    } else bad('the queued step did not name its capability', JSON.stringify(noWorker.validation.queuedSteps));

    let W = uid('worker');
        // Migration 62: a FIXTURE identity inserted DIRECTLY, which is why the mechanical sweep over
    // `createEnrollmentToken({` call sites could not reach it — a third enrolment shape, found by
    // running the population rather than by trusting the sweep. Declared unrestricted because this
    // check's subject is the cycle, not synthetic isolation.
    // Migration 62 and the INSERT-path guard: a widened identity — exec:hardware, or
    // synthetic_only false — may now only be created by the enrolment exchange, which stamps
    // enrolled_by as `enrollment:<digest>` and requires a verified administrator on the token.
    // This fixture was a direct INSERT: the third enrolment shape, and the one that bypassed every
    // check on the mint. Going the authorized way is also what keeps the guard non-vacuous — if the
    // exchange ever stopped stamping provenance, this check would fail rather than quietly pass.
    const _wid = require('../src/lib/worker/identity');
    const _wtok = await _wid.createEnrollmentToken({
      label: W, capabilities: ['exec:hardware'], syntheticOnly: false,
      createdBy: await require('./lib/fixture-admin').fixtureAdmin(q),
    }, { query: q });
    const _wenr = await _wid.consumeEnrollmentToken(
      { token: _wtok.token, hostFingerprint: 'decomp-check' }, { query: q });
    if (!_wenr || _wenr.ok !== true) {
      throw new Error(`fixture enrolment failed: ${JSON.stringify(_wenr)}`);
    }
    W = _wenr.workerId;
    ids.workers.push(W);
    const withWorker = await decompose(ctxFor(A, objHw), HARDWARE);
    if (withWorker.ok && withWorker.validation.verdict === 'validated') {
      ok('with a worker declaring exec:hardware the same plan validates with nothing queued');
    } else bad('the hardware step stayed queued with a capable worker enrolled',
      JSON.stringify(withWorker.validation));

    await q(`UPDATE worker_identities SET revoked_at = NOW(), revoked_by = 'decomp-check',
                                          revoked_reason = 'fixture'
              WHERE id = $1`, [W]);
    const revokedWorker = await decompose(ctxFor(A, objHw), HARDWARE);
    if (revokedWorker.ok && revokedWorker.validation.verdict === 'validated_with_queued_steps') {
      ok('a REVOKED worker\'s capabilities are not the fleet\'s capabilities — the step queues again');
      note('a machine taken out of service once declared exec:hardware; counting it would report '
        + 'a hardware step as executable by a worker that may never come back');
    } else bad('a revoked worker still satisfied execution eligibility',
      JSON.stringify(revokedWorker.validation));

    const classLie = DEC.propose(ctxFor(A, objHw), { candidates: HARDWARE });
    classLie.plan.steps[3].executionClass = 'cloud_eligible';
    const classVerdict = await DEC.validate(ctxFor(A, objHw), classLie.plan, deps);
    if (!classVerdict.ok && classVerdict.refused === 'execution_class_mismatch') {
      ok('a step claiming to be cloud-eligible when the registry says hardware is refused');
    } else bad('an execution-class claim was believed', JSON.stringify(classVerdict.refused));

    // ══ 8. GATE: STOP CONTROLS ════════════════════════════════════════════
    console.log('\n── 8. gate 4 — STOP controls ──\n');

    autonomy.resetForTests?.();
    // THE RETURN VALUE IS CHECKED. The first version of this block called stop() with camelCase
    // keys, autonomy.validate() rejected them, stop() returned { ok: false } — and because nothing
    // read that, the assertion below reported "a deliberate stop did not refuse the plan" when no
    // stop had ever been set. A fixture that silently does not happen is the same defect class as
    // a measurement standing in for the property.
    const setStop = await autonomy.stop({ scope_type: 'capability', scope_key: 'llm.call',
      reason: 'decomposition check: deliberate stop on the governed AI capability',
      actor: 'decomp-check' }, { deps });
    if (setStop && setStop.ok !== false) ok('the fixture stop was ACCEPTED (checked, not assumed)');
    else bad('the fixture stop was refused, so the next assertion would measure nothing',
      JSON.stringify(setStop));
    autonomy.resetForTests?.();
    const stopped = await decompose(ctxOk, BASE);
    if (!stopped.ok && stopped.refused === 'stopped_by_policy') {
      ok('a stop on llm.call refuses the step that consumes it');
    } else bad('a deliberate stop did not refuse the plan', JSON.stringify(stopped.refused));
    const stillFine = await decompose(ctxOk, [
      { stepType: 'observe.objective_state', args: {} },
      { stepType: 'operations.liveness_checkpoint', args: {} }]);
    if (stillFine.ok) {
      ok('and a plan consuming NO stopped capability still validates — the stop is matched per '
        + 'capability, not applied to everything');
    } else bad('the stop refused an unrelated plan', JSON.stringify(stillFine.refused));
    const lifted = await autonomy.resume({ scope_type: 'capability', scope_key: 'llm.call',
      reason: 'decomposition check: fixture cleanup', actor: 'decomp-check' }, { deps });
    if (lifted && lifted.ok !== false) ok('the resume was accepted');
    else bad('the resume was refused, so the next assertion would measure a stale stop',
      JSON.stringify(lifted));
    autonomy.resetForTests?.();

    const afterResume = await decompose(ctxOk, BASE);
    if (afterResume.ok) ok('after the resume the same plan validates again');
    else bad('the plan stayed refused after the resume', JSON.stringify(afterResume.refused));

    // A stop on the WORKFLOW refuses a read-only plan. checkStopped's own read-only path ignores
    // every scope but `capability` — "thinking is not acting" — and that concession is wrong for
    // minting new authorization, which is what a validated plan is. So this gate asks as a
    // consequential caller, and this assertion is what proves it does.
    autonomy.resetForTests?.();
    const wfStop = await autonomy.stop({ scope_type: 'workflow',
      scope_key: 'objective-decomposition',
      reason: 'decomposition check: no new plans may be minted for this workflow',
      actor: 'decomp-check' }, { deps });
    if (wfStop && wfStop.ok !== false) ok('a workflow-scoped stop was accepted by name');
    else bad('the workflow scope key is not registered, so it could not be stopped by name',
      JSON.stringify(wfStop));
    autonomy.resetForTests?.();
    const readOnlyUnderWorkflowStop = await decompose(ctxOk, [
      { stepType: 'observe.objective_state', args: {} }]);
    if (!readOnlyUnderWorkflowStop.ok && readOnlyUnderWorkflowStop.refused === 'stopped_by_policy') {
      ok('and it refuses a plan of READ-ONLY steps — producing a plan is new authorization, not '
        + 'analysis, so a workflow stop prevents it');
    } else bad('a workflow stop did not prevent planning',
      JSON.stringify(readOnlyUnderWorkflowStop.refused));
    await autonomy.resume({ scope_type: 'workflow', scope_key: 'objective-decomposition',
      reason: 'decomposition check: fixture cleanup', actor: 'decomp-check' }, { deps });
    autonomy.resetForTests?.();

    autonomy.resetForTests?.();
    const blindDeps = { query: async (t, p) => {
      if (/autonomy_stops/i.test(t)) throw new Error('stops unreadable (fixture)');
      return q(t, p);
    } };
    const unreadableStop = await decompose(ctxOk, BASE, { deps: blindDeps });
    if (!unreadableStop.ok && unreadableStop.refused === 'killswitch_unreadable') {
      ok('an UNREADABLE stop state refuses — the absence of an answer is not a clear one');
    } else bad('an unreadable kill switch was treated as clear', JSON.stringify(unreadableStop.refused));
    autonomy.resetForTests?.();

    // ══ 9. GATE: APPROVAL REQUIREMENT ═════════════════════════════════════
    console.log('\n── 9. gate 5 — approval requirement ──\n');

    const consequentialPlan = await decompose(ctxFor(A, objSup), CONSEQUENTIAL);
    const consequentialStep = (consequentialPlan.validation.steps || [])[0];
    if (consequentialStep && consequentialStep.requiresApproval === true) {
      ok('a consequential step is recomputed as REQUIRING a human approval, from the objective\'s '
        + 'stored policy');
    } else bad('the approval requirement was not recomputed', JSON.stringify(consequentialStep));

    const tampered = DEC.propose(ctxFor(A, objSup), { candidates: CONSEQUENTIAL });
    tampered.plan.steps[0].requiresApproval = false;
    const tamperVerdict = await DEC.validate(ctxFor(A, objSup), tampered.plan, deps);
    if (!tamperVerdict.ok && tamperVerdict.refused === 'approval_requirement_contradicted') {
      ok('a plan claiming a consequential step needs NO approval is refused, and the disagreement '
        + 'is recorded rather than quietly corrected');
    } else bad('an approval-skipping claim was accepted', JSON.stringify(tamperVerdict.refused));

    // A PLAN CANNOT RELEASE ANYTHING — asserted on the data and the dependency graph, not on the
    // prose. The first version of this grepped each step's summary for "release", and passed or
    // failed on wording: the prepare-only step's own summary said "never releases", which made it
    // look like a releasing step. Text about a property is not the property.
    const consequentialSteps = Object.entries(DEC.STEP_VOCABULARY).filter(([, d]) => d.consequential);
    const notPrepareOnly = consequentialSteps.filter(([, d]) => d.prepareOnly !== true);
    if (consequentialSteps.length > 0 && notPrepareOnly.length === 0) {
      ok(`every consequential step (${consequentialSteps.length}) declares prepareOnly, and a step `
        + 'that did not would fail at module load');
    } else bad('a consequential step does not declare prepareOnly',
      notPrepareOnly.map(([k]) => k).join(', ') || 'no consequential step exists to test the branch');

    // ══ 10. GATE: BUDGET ═════════════════════════════════════════════════
    console.log('\n── 10. gate 6 — budget ──\n');

    const objNoBudget = await mkObjective(A, { budgetUsd: null });
    const noBudget = await decompose(door({ companyId: A, objectiveId: objNoBudget, runId: null }),
      BASE);
    if (!noBudget.ok && noBudget.refused === 'budget_refused') {
      ok('an objective with NO authorized budget refuses the whole plan (B2.5a, applied to planning)');
    } else bad('a budgetless objective was planned for', JSON.stringify(noBudget.refused));

    const objTiny = await mkObjective(A, { budgetUsd: 0.01 });
    const tinyRun = await mkRun(A, objTiny);
    await q(`INSERT INTO office_cost_ledger
               (company_id, run_id, objective_id, provider, model, tokens_input, tokens_output,
                cost_usd, cost_known, agent, workflow)
             VALUES ($1,$2,$3,'anthropic','m',10,10,0.02,TRUE,'a','w')`, [A, tinyRun, objTiny]);
    const exhausted = await decompose(
      door({ companyId: A, objectiveId: objTiny, runId: null, budgetUsd: 0.01 }), BASE);
    if (!exhausted.ok && exhausted.refused === 'budget_refused') {
      ok('an EXHAUSTED objective budget refuses the plan before any step is dispatched');
    } else bad('an exhausted budget permitted a plan', JSON.stringify(exhausted.refused));

    // ══ 11. A PLAN IS A RECORD, AND THE RECORD SAYS WHAT HAPPENED ═════════
    console.log('\n── 11. the durable record ──\n');

    const refusedRow = await scope.getPlan(ctxFor(A, objSup), tampered.plan.planId, deps);
    if (refusedRow === null) {
      ok('a plan refused before persistence leaves no row (it was never created)');
    } else if (refusedRow.status === 'refused' && refusedRow.refusal_code) {
      ok(`a refused plan is RECORDED with its reason (${refusedRow.refusal_code})`);
    } else bad('a refused plan was not recorded as refused', JSON.stringify(refusedRow));

    const okRow = await scope.getPlan(ctxOk, good.plan.planId, deps);
    if (okRow && okRow.status === 'validated' && okRow.validated_at) {
      ok('a validated plan carries its verdict AND the time it was reached, from the database clock');
    } else bad('the validated plan record is incomplete', JSON.stringify(okRow));

    const stepRows = await scope.listPlanSteps(ctxOk, good.plan.planId, deps);
    if (stepRows.length === 3 && stepRows.every((r) => r.verdict === 'permitted')) {
      ok('every step carries its own verdict, in order');
    } else bad('the step verdicts were not recorded', JSON.stringify(stepRows.map((r) => r.verdict)));

    const refusedSteps = await scope.listPlanSteps(ctxOk, stopped.plan.planId, deps);
    const refusedOne = refusedSteps.find((r) => r.refusal_code === 'stopped_by_policy');
    if (refusedOne) {
      ok('and a refused step keeps its refusal code — the refusals ARE the evidence that '
        + 'validation ran');
    } else bad('a refused step lost its reason', JSON.stringify(refusedSteps.map((r) => r.refusal_code)));

    // The constraints, asserted rather than assumed.
    const planRun = await mkRun(A, objOk);
    let cannotPreApprove = null;
    try {
      await q(`INSERT INTO office_plans (id, company_id, objective_id, run_id, proposer, planner,
                                         status, verdict, validated_at)
               VALUES ($1,$2,$3,$4,'x','x','proposed','validated',NOW())`,
        [uid('plan'), A, objOk, planRun]);
    } catch (e) { cannotPreApprove = e.code; }
    if (cannotPreApprove === '23514') {
      ok('the DATABASE refuses a row that is `proposed` and already carries a verdict');
    } else bad('a proposed plan could be born carrying a verdict', cannotPreApprove);

    let cannotHideReason = null;
    try {
      await q(`INSERT INTO office_plans (id, company_id, objective_id, run_id, proposer, planner,
                                         status, verdict, validated_at)
               VALUES ($1,$2,$3,$4,'x','x','refused','refused',NOW())`,
        [uid('plan'), A, objOk, planRun]);
    } catch (e) { cannotHideReason = e.code; }
    if (cannotHideReason === '23514') {
      ok('and refuses a `refused` plan with no refusal code — a refusal must say why');
    } else bad('a refusal could be recorded without a reason', cannotHideReason);

    // ══ 12. MEMORY IS PROVENANCE, NOT PERMISSION ══════════════════════════
    console.log('\n── 12. recalled memory is an input, never an authorization ──\n');

    const srcText = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'lib', 'office', 'decomposition.js'), 'utf8');
    const requires = [...srcText.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    if (!requires.some((r) => /approval|execute|mailer|whatsapp/i.test(r))) {
      ok('and it requires no approval, execution, mailer or WhatsApp module — there is no release '
        + 'path reachable from a plan, by absence rather than by discipline');
    } else bad('the planner can reach a release path',
      requires.filter((r) => /approval|execute|mailer|whatsapp/i.test(r)).join(', '));

    if (!requires.some((r) => /memory/i.test(r))) {
      ok('decomposition.js does not require the memory module at all — there is no body for an '
        + 'adversarial memory to put in front of it');
      note(`its whole dependency set: ${[...new Set(requires)].join(', ')}`);
    } else bad('the planner reads memory directly', requires.filter((r) => /memory/i.test(r)).join(', '));

    const withMemory = await decompose(ctxOk, BASE,
      { consultedMemoryIds: ['mem-1', 'mem-2'] });
    if (withMemory.ok && withMemory.plan.consultedMemoryIds.length === 2) {
      ok('consulted memory ids travel as PROVENANCE and change no verdict');
    } else bad('consulted memory ids were not carried', JSON.stringify(withMemory.plan));

    // ══ 13. NO AGENT-GENERATED CODE ═══════════════════════════════════════
    console.log('\n── 13. no arbitrary agent-generated execution ──\n');

    if (!/\beval\s*\(|new Function|child_process|vm\.|require\([^')]/.test(srcText)) {
      ok('no eval, no Function constructor, no child_process, no vm, and no dynamic require — the '
        + 'vocabulary cannot grow at runtime');
    } else bad('the planner contains a dynamic execution path');

    const everyStepDeclared = Object.entries(DEC.STEP_VOCABULARY).every(([, d]) =>
      d.taskType === null || require('../src/lib/worker/task-types').isKnown(d.taskType));
    if (everyStepDeclared) {
      ok('every worker step maps to a task type the worker registry declares');
    } else bad('a step maps to an undeclared task type');

    const digestPlan = DEC.propose(ctxOk, { candidates: BASE });
    digestPlan.plan.steps[1].payload = { hello: 'something-else' };
    const digestVerdict = await DEC.validate(ctxOk, digestPlan.plan, deps);
    if (!digestVerdict.ok && digestVerdict.refused === 'payload_digest_mismatch') {
      ok('a payload altered after proposal is refused — the plan that runs is the plan that was '
        + 'validated, or nothing runs');
    } else bad('an altered payload was permitted', JSON.stringify(digestVerdict.refused));

    // ══ 14. AN INACTIVE OBJECTIVE IS NOT A PLANNABLE ONE ══════════════════
    console.log('\n── 14. the objective itself ──\n');

    const objDraft = await mkObjective(A, { status: 'draft' });
    const draft = await decompose(ctxFor(A, objDraft), BASE);
    if (!draft.ok && draft.refused === 'objective_not_active') {
      ok('a draft objective cannot be decomposed — planning is not a way to start work the CEO '
        + 'has not activated');
    } else bad('a draft objective was planned for', JSON.stringify(draft.refused));

    console.log('');
  } catch (e) {
    bad('the check itself threw', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  } finally {
    try {
      for (const id of ids.plans) {
        await q(`DELETE FROM office_plan_steps WHERE plan_id = $1`, [id]).catch(() => {});
        await q(`DELETE FROM office_plans WHERE id = $1`, [id]).catch(() => {});
      }
      await q(`DELETE FROM office_plan_steps WHERE company_id = ANY($1)`, [ids.companies]).catch(() => {});
      await q(`DELETE FROM office_plans WHERE company_id = ANY($1)`, [ids.companies]).catch(() => {});
      await q(`DELETE FROM office_cost_ledger WHERE company_id = ANY($1)`, [ids.companies]).catch(() => {});
      for (const id of ids.runs) await q(`DELETE FROM agent_runs WHERE run_id = $1`, [id]).catch(() => {});
      for (const id of ids.objectives) await q(`DELETE FROM objectives WHERE id = $1`, [id]).catch(() => {});
      for (const id of ids.workers) await q(`DELETE FROM worker_identities WHERE id = $1`, [id]).catch(() => {});
      for (const id of ids.companies) await q(`DELETE FROM companies WHERE id = $1`, [id]).catch(() => {});
      // My fixtures are gone — NOT "the table is empty".
      const leftPlans = (await q(`SELECT COUNT(*)::int n FROM office_plans WHERE id = ANY($1)`,
        [ids.plans])).rows[0].n;
      const leftObjs = (await q(`SELECT COUNT(*)::int n FROM objectives WHERE id = ANY($1)`,
        [ids.objectives])).rows[0].n;
      if (leftPlans === 0 && leftObjs === 0) ok('cleanup: my fixtures are gone');
      else bad('cleanup leaked fixtures', { plans: leftPlans, objectives: leftObjs });
    } catch (e) {
      bad('cleanup itself failed', e && e.message);
    }
    await P.end().catch(() => {});
    clearTimeout(watchdog);
    cluster.destroy();
  }

  console.log(`\n  ${pass} ok, ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  decomposition does not yet treat a plan as a proposal.');
    process.exit(1);
  }
  console.log('\nPASS  B3.2: an objective decomposes into a bounded plan from a closed vocabulary; '
    + 'every step is independently validated against company scope, capability permission, '
    + 'execution eligibility, STOP controls, approval requirement and budget; a proposal that '
    + 'states any of those is refused by name rather than sanitised; a model\'s output is parsed '
    + 'data on the same code path; one refused step refuses the whole plan; hardware-only work '
    + 'queues instead of failing; and both the proposal and the verdict are durable.');
  process.exit(0);
})();
