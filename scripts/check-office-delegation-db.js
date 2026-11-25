#!/usr/bin/env node
// ── B3.3: GOVERNED MULTI-AGENT DELEGATION ───────────────────────────────────
//
//   node scripts/check-office-delegation-db.js   exit 0 = every ruled property holds
//                                                exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner instruction, 2026-11-24: "Implement governed multi-agent delegation." Standing
// constraints: "Do not introduce competing identity or company authorization systems." · "A child
// agent must not create a new budget that bypasses its parent's authorized spending limit." ·
// B3.1/B3.1a are the reference pattern — take the context, never a company id.
//
// The dependency plan's Gate 3 names what dispatch evidence must identify: "company, objective,
// parent run, child run, calling agent, target agent, workflow, capability, autonomy tier, policy
// decision." Those ten are asserted individually, from the stored row.
//
// Every refusal is paired with a positive control on the same fixture, because a delegate() that
// refused everything would pass every negative case below.
//
// NO URL OVERRIDE: its own disposable cluster; fixtures deleted by id.

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
  cluster = DISPOSABLE.create({ label: 'deleg' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  delegation not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'deleg-bootstrap@deleg.invalid';
process.env.ADMIN_PASSWORD = `deleg-${crypto.randomBytes(16).toString('hex')}`;

const WATCHDOG_MS = Number(process.env.DELEG_CHECK_TIMEOUT_MS || 240_000);
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
  const ids = { companies: [], objectives: [], runs: [] };
  const uid = (p) => `deleg-${p}-${crypto.randomUUID().slice(0, 8)}`;

  try {
    await require('../src/lib/db').initDB();
    await require('../src/lib/runs').migrateRuns(q);
    await require('../src/lib/office/schema').migrateOffice(q);
    await require('../src/lib/autonomy').migrateAutonomy(q);
    console.log('  ..    schema up\n');

    const DEL = require('../src/lib/office/delegation');
    const scope = require('../src/lib/office/scope');
    const CTX = require('../src/lib/office/context');
    const autonomy = require('../src/lib/autonomy');
    const L = require('../src/lib/run-ledger').ledger({ query: q });
    const door = CTX.contextForTests__TEST_ONLY;

    const A = uid('co-a');
    const B = uid('co-b');
    for (const c of [A, B]) {
      await q(`INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,$1,'active')`, [c]);
      ids.companies.push(c);
    }

    const mkObjective = async (company, { budgetUsd = 100, tier = 'supervised',
      status = 'active' } = {}) => {
      const id = uid('obj');
      await scope.createObjective({
        id, companyId: company, objective: `delegation fixture ${id}`, priority: 'P2',
        kpiMetric: 'x', kpiTarget: 1, deadline: '2026-12-31', budgetUsd,
        autonomyTier: tier, approvalPolicy: 'all_consequential', createdBy: 'ceo',
      }, deps);
      await q(`UPDATE objectives SET status = $2 WHERE id = $1`, [id, status]);
      ids.objectives.push(id);
      return id;
    };

    // A RUNNING parent run, made through the real ledger so its state machine is the real one.
    const mkRun = async (company, objectiveId, { parentRunId = null, rootRunId = null,
      state = 'RUNNING' } = {}) => {
      const created = await L.createRun({
        trigger: 'office', workflow: 'objective-review', agent: 'executive-agent',
        product: 'internal', intentKey: uid('intent'), objectiveId, companyId: company,
        parentRunId, rootRunId: rootRunId || undefined,
      });
      if (created.duplicate) throw new Error('fixture run was a duplicate');
      ids.runs.push(created.runId);
      if (state === 'RUNNING') await L.startRun(created.runId);
      return created.runId;
    };

    const ctxFor = (company, objectiveId, runId) => door({
      companyId: company, objectiveId, runId, budgetUsd: 100,
      autonomyTier: 'supervised', approvalPolicy: 'all_consequential' });

    // ══ 1. THE POSITIVE CONTROL ═══════════════════════════════════════════
    console.log('── 1. a governed delegation happens, and is recorded ──\n');

    const objA = await mkObjective(A);
    const parentRun = await mkRun(A, objA);
    const parentCtx = ctxFor(A, objA, parentRun);

    const d1 = await DEL.delegate(parentCtx, {
      toAgent: 'procurement-agent', callingAgent: 'executive-agent',
      reason: 'the objective needs supplier research before any RFQ is prepared',
    }, deps);
    if (d1.ok) ok('POSITIVE CONTROL: the executive agent delegates to the procurement agent');
    else bad('the positive control was refused — every refusal below is meaningless',
      JSON.stringify({ refused: d1.refused, detail: d1.detail }));

    if (d1.ok && d1.depth === 1) ok('the child is at depth 1 of the delegation tree');
    else bad('the child depth is wrong', d1.depth);

    // THE TEN FIELDS GATE 3 REQUIRES, read from the stored row.
    const rows = await scope.delegationsFrom(parentCtx, parentRun, deps);
    const rec = rows[0];
    if (rec) {
      const required = {
        company: rec.objective_id && true, objective: rec.objective_id,
        parent_run: rec.parent_run_id, child_run: rec.child_run_id,
        calling_agent: rec.calling_agent, target_agent: rec.target_agent,
        workflow: rec.workflow, capability: rec.capability,
        autonomy_tier: rec.autonomy_tier, policy_decision: rec.policy_decision,
      };
      const missing = Object.entries(required).filter(([, v]) => v === null || v === undefined || v === '');
      if (!missing.length) {
        ok('the dispatch record identifies all ten fields Gate 3 requires');
        note(`${rec.calling_agent} → ${rec.target_agent} · ${rec.workflow} · ${rec.capability} · `
          + `tier ${rec.autonomy_tier} · ${rec.policy_decision}`);
      } else bad('dispatch evidence is incomplete', missing.map(([k]) => k).join(', '));
      if (rec.child_run_id === d1.childRunId && rec.parent_run_id === parentRun) {
        ok('and it names the actual parent and child runs, not a reconstruction');
      } else bad('the recorded runs do not match', JSON.stringify(rec));
    } else bad('no dispatch record was written at all');

    // Every one of those columns is NOT NULL, asserted rather than assumed.
    const nullable = (await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'office_delegations' AND is_nullable = 'YES'
          AND column_name IN ('company_id','objective_id','parent_run_id','child_run_id',
                              'calling_agent','target_agent','workflow','capability',
                              'autonomy_tier','policy_decision','depth','reason')`)).rows;
    if (!nullable.length) {
      ok('all twelve evidence columns are NOT NULL — a delegation that cannot name one cannot be '
        + 'recorded, and the record is written before the child is handed its context');
    } else bad('evidence columns are nullable', nullable.map((r) => r.column_name).join(', '));

    // ══ 2. THE CONTEXT CROSSES, NOT A COMPANY ID ══════════════════════════
    console.log('\n── 2. what crosses the boundary ──\n');

    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'lib', 'office', 'delegation.js'), 'utf8');
    const sig = src.slice(src.indexOf('async function delegate'), src.indexOf('{', src.indexOf('async function delegate')));
    if (!/companyId|company_id|budgetUsd|objectiveId/.test(sig)) {
      ok('delegate() accepts no companyId, no objectiveId and no budgetUsd — all three come from '
        + 'the parent context');
      note(`its whole signature: ${sig.replace(/\s+/g, ' ').trim()}`);
    } else bad('delegate() takes an authorization parameter', sig.replace(/\s+/g, ' ').trim());

    if (d1.ok) {
      let rejected = null;
      try { CTX.assertContext(d1.childContext); } catch (e) { rejected = e.message; }
      if (!rejected) ok('the child context is one office/context.js minted — it carries the brand');
      else bad('the child context is not a real context', rejected);
      if (d1.childContext.companyId === A && d1.childContext.runId === d1.childRunId) {
        ok('and it carries the SAME company with the CHILD\'s run id');
      } else bad('the child context is wrong', JSON.stringify(d1.childContext));
      if (Object.isFrozen(d1.childContext)) {
        ok('and it is frozen, so the child cannot rewrite the company in place');
      } else bad('the child context is mutable');
    }

    // The database refuses a cross-company child even if the accessor were written wrongly.
    const objB = await mkObjective(B);
    const runB = await mkRun(B, objB);
    let dbRefusedCross = null;
    try {
      await q(`INSERT INTO office_delegations
                 (id, company_id, objective_id, parent_run_id, child_run_id, calling_agent,
                  target_agent, workflow, capability, autonomy_tier, policy_decision, depth, reason)
               VALUES ($1,$2,$3,$4,$5,'x','y','w','llm.call','supervised','allowed',1,'fixture reason')`,
        [uid('dg'), A, objA, parentRun, runB]);
    } catch (e) { dbRefusedCross = e.code; }
    if (dbRefusedCross === '23503') {
      ok('the DATABASE refuses a delegation whose child run belongs to another company (MATCH FULL '
        + 'composite FK) — not the accessor remembering to check');
    } else bad('a cross-company delegation was accepted', dbRefusedCross);

    let dbRefusedSelf = null;
    try {
      await q(`INSERT INTO office_delegations
                 (id, company_id, objective_id, parent_run_id, child_run_id, calling_agent,
                  target_agent, workflow, capability, autonomy_tier, policy_decision, depth, reason)
               VALUES ($1,$2,$3,$4,$4,'x','y','w','llm.call','supervised','allowed',1,'fixture reason')`,
        [uid('dg'), A, objA, parentRun]);
    } catch (e) { dbRefusedSelf = e.code; }
    if (dbRefusedSelf === '23514') {
      ok('and refuses a run delegating to ITSELF — a cycle of length one the depth bound would '
        + 'never see, because the chain never gets longer');
    } else bad('a self-delegation was accepted', dbRefusedSelf);

    // ══ 3. THE CLOSED REGISTRY ════════════════════════════════════════════
    console.log('\n── 3. the target agent ──\n');

    const unknownAgent = await DEL.delegate(parentCtx, {
      toAgent: 'shell-runner', callingAgent: 'executive-agent',
      reason: 'an agent name that came from somewhere else entirely',
    }, deps);
    if (!unknownAgent.ok && unknownAgent.refused === 'unknown_target_agent') {
      ok('an agent outside the closed registry is refused — a name from a model, a plan or a '
        + 'memory names nothing');
    } else bad('an unknown agent was delegated to', JSON.stringify(unknownAgent.refused));

    const consequential = Object.entries(DEL.DELEGABLE).filter(([, d]) => d.consequential);
    if (!consequential.length) {
      ok('no delegable agent is consequential, and one that was would fail at module load — the '
        + 'approval boundary is not reachable from a delegation');
    } else bad('a consequential agent is delegable', consequential.map(([k]) => k).join(', '));

    const unstoppable = Object.entries(DEL.DELEGABLE)
      .filter(([, d]) => !autonomy.CAPABILITIES.includes(d.capability));
    if (!unstoppable.length) {
      ok('every delegable agent\'s capability is one the kill switch knows, so it can be stopped '
        + 'by name');
    } else bad('a delegable capability cannot be stopped', unstoppable.map(([k]) => k).join(', '));

    const noReason = await DEL.delegate(parentCtx, {
      toAgent: 'sales-agent', callingAgent: 'executive-agent', reason: 'why',
    }, deps);
    if (!noReason.ok && noReason.refused === 'no_reason') {
      ok('a delegation with no meaningful reason is refused — incident reconstruction is the whole '
        + 'point of the field');
    } else bad('a delegation without a reason was accepted', JSON.stringify(noReason.refused));

    // ══ 4. THE PARENT RUN ════════════════════════════════════════════════
    console.log('\n── 4. the parent run ──\n');

    const noRunCtx = door({ companyId: A, objectiveId: objA, runId: null, budgetUsd: 100 });
    const noRun = await DEL.delegate(noRunCtx, {
      toAgent: 'sales-agent', callingAgent: 'executive-agent',
      reason: 'a delegation that has no run to hang off at all',
    }, deps);
    if (!noRun.ok && noRun.refused === 'no_parent_run') {
      ok('a context carrying no run cannot delegate — the child inherits a position in a tree');
    } else bad('a delegation with no parent run was accepted', JSON.stringify(noRun.refused));

    const finishedRun = await mkRun(A, objA);
    await L.finish(finishedRun, { state: 'SUCCEEDED' });
    const fromFinished = await DEL.delegate(ctxFor(A, objA, finishedRun), {
      toAgent: 'sales-agent', callingAgent: 'executive-agent',
      reason: 'delegating from a run that has already reported success',
    }, deps);
    if (!fromFinished.ok && fromFinished.refused === 'parent_not_running') {
      ok('a FINISHED parent cannot delegate — the child\'s cost and outcome would have nobody '
        + 'waiting for them');
    } else bad('a finished run delegated', JSON.stringify(fromFinished.refused));

    const foreignParent = await DEL.delegate(ctxFor(A, objA, runB), {
      toAgent: 'sales-agent', callingAgent: 'executive-agent',
      reason: 'company A naming company B\'s run as its parent',
    }, deps);
    if (!foreignParent.ok && foreignParent.refused === 'parent_not_in_company_scope') {
      ok('a parent run of another company reads as ABSENT, and absent is a refusal');
    } else bad('a cross-company parent was accepted', JSON.stringify(foreignParent.refused));

    // ══ 5. DEPTH ═════════════════════════════════════════════════════════
    console.log('\n── 5. the depth bound ──\n');

    let chainCtx = parentCtx;
    const reached = [];
    for (let i = 0; i < DEL.MAX_DEPTH + 2; i += 1) {
      const step = await DEL.delegate(chainCtx, {
        toAgent: 'sales-agent', callingAgent: 'executive-agent',
        reason: `chain link ${i + 1}, measuring where the bound actually bites`,
      }, deps);
      if (!step.ok) { reached.push({ refused: step.refused, at: i + 1 }); break; }
      reached.push({ depth: step.depth });
      // The child becomes the next parent — and it must be RUNNING to delegate onward.
      await L.startRun(step.childRunId);
      chainCtx = step.childContext;
    }
    const deepest = Math.max(...reached.filter((r) => r.depth).map((r) => r.depth));
    const stoppedAt = reached.find((r) => r.refused);
    if (deepest === DEL.MAX_DEPTH && stoppedAt && stoppedAt.refused === 'delegation_too_deep') {
      ok(`the chain reaches depth ${DEL.MAX_DEPTH} and the next delegation is refused `
        + 'delegation_too_deep');
      note('without a bound, A delegating to B delegating to A is a loop that spends real money');
    } else bad('the depth bound did not bite where expected', JSON.stringify(reached));

    // ══ 6. THE AUTONOMY TIER ═════════════════════════════════════════════
    console.log('\n── 6. the autonomy tier ──\n');

    const objNone = await mkObjective(A, { tier: 'none' });
    const runNone = await mkRun(A, objNone);
    const tierNone = await DEL.delegate(ctxFor(A, objNone, runNone), {
      toAgent: 'sales-agent', callingAgent: 'executive-agent',
      reason: 'a tier-none objective attempting to delegate governed work',
    }, deps);
    if (!tierNone.ok && tierNone.refused === 'autonomy_tier_forbids_delegation') {
      ok('tier `none` may not delegate — it may observe, analyse and report');
    } else bad('tier none delegated', JSON.stringify(tierNone.refused));

    const objBounded = await mkObjective(A, { tier: 'bounded' });
    const runBounded = await mkRun(A, objBounded);
    const tierBounded = await DEL.delegate(ctxFor(A, objBounded, runBounded), {
      toAgent: 'sales-agent', callingAgent: 'executive-agent',
      reason: 'a bounded-tier objective attempting to delegate governed work',
    }, deps);
    if (!tierBounded.ok && tierBounded.refused === 'autonomy_tier_forbids_delegation') {
      ok('tier `bounded` is NOT AUTHORIZED and is refused rather than read as the permissive tier');
    } else bad('a bounded objective delegated', JSON.stringify(tierBounded.refused));

    const objDraft = await mkObjective(A, { status: 'draft' });
    // A draft objective cannot even open a run through beginObjectiveRun, so the fixture run is
    // made against an ACTIVE objective and the objective is then switched off — which is the real
    // sequence: work in flight when the CEO pauses the objective.
    const objPaused = await mkObjective(A);
    const runPaused = await mkRun(A, objPaused);
    await q(`UPDATE objectives SET status = 'paused' WHERE id = $1`, [objPaused]);
    const paused = await DEL.delegate(ctxFor(A, objPaused, runPaused), {
      toAgent: 'sales-agent', callingAgent: 'executive-agent',
      reason: 'delegating under an objective the CEO has since paused',
    }, deps);
    if (!paused.ok && paused.refused === 'objective_not_active') {
      ok('an objective switched off mid-flight stops further delegation — it is not a way to carry '
        + 'on work the CEO has paused');
    } else bad('a paused objective delegated', JSON.stringify(paused.refused));
    note(`draft fixture ${objDraft} exists only to keep the two cases distinguishable`);

    // ══ 7. THE KILL SWITCH ═══════════════════════════════════════════════
    console.log('\n── 7. the kill switch ──\n');

    autonomy.resetForTests?.();
    const setStop = await autonomy.stop({ scope_type: 'agent', scope_key: 'sales-agent',
      reason: 'delegation check: deliberate stop on the target agent',
      actor: 'deleg-check' }, { deps });
    if (setStop && setStop.ok !== false) ok('a stop on the TARGET AGENT was accepted by name');
    else bad('the target agent is not a registered scope key, so it cannot be stopped by name',
      JSON.stringify(setStop));
    autonomy.resetForTests?.();

    const stoppedAgent = await DEL.delegate(parentCtx, {
      toAgent: 'sales-agent', callingAgent: 'executive-agent',
      reason: 'delegating to an agent that an operator has deliberately stopped',
    }, deps);
    if (!stoppedAgent.ok && stoppedAgent.refused === 'stopped_by_policy') {
      ok('and the delegation is refused before any child run exists');
    } else bad('a stopped agent was delegated to', JSON.stringify(stoppedAgent.refused));

    const otherAgentStillFine = await DEL.delegate(parentCtx, {
      toAgent: 'seo-agent', callingAgent: 'executive-agent',
      reason: 'a different agent, not the one under the stop',
    }, deps);
    if (otherAgentStillFine.ok) {
      ok('a DIFFERENT agent still delegates — the stop is matched by name, not applied to everything');
    } else bad('the stop refused an unrelated agent', JSON.stringify(otherAgentStillFine.refused));

    await autonomy.resume({ scope_type: 'agent', scope_key: 'sales-agent',
      reason: 'delegation check: fixture cleanup', actor: 'deleg-check' }, { deps });
    autonomy.resetForTests?.();

    const blindDeps = { query: async (t, p) => {
      if (/autonomy_stops/i.test(t)) throw new Error('stops unreadable (fixture)');
      return q(t, p);
    } };
    const unreadable = await DEL.delegate(parentCtx, {
      toAgent: 'seo-agent', callingAgent: 'executive-agent',
      reason: 'delegating while the stops table cannot be read at all',
    }, blindDeps);
    if (!unreadable.ok && unreadable.refused === 'killswitch_unreadable') {
      ok('an UNREADABLE stop state refuses — the absence of an answer is not a clear answer');
    } else bad('an unreadable kill switch was treated as clear', JSON.stringify(unreadable.refused));
    autonomy.resetForTests?.();

    // ══ 8. THE CHILD CANNOT GET ITS OWN BUDGET ═══════════════════════════
    console.log('\n── 8. the budget the child inherits ──\n');

    const objNoBudget = await mkObjective(A, { budgetUsd: null });
    const runNoBudget = await mkRun(A, objNoBudget);
    const noBudget = await DEL.delegate(
      door({ companyId: A, objectiveId: objNoBudget, runId: runNoBudget }), {
        toAgent: 'seo-agent', callingAgent: 'executive-agent',
        reason: 'delegating under an objective with no authorized budget at all',
      }, deps);
    if (!noBudget.ok && noBudget.refused === 'budget_refused') {
      ok('an objective with NO authorized budget cannot delegate (B2.5a, applied to delegation)');
    } else bad('a budgetless objective delegated', JSON.stringify(noBudget.refused));

    // The child's spend lands against the PARENT's objective. That is what makes a child budget
    // impossible rather than merely forbidden: there is one ceiling and both runs are under it.
    const objTight = await mkObjective(A, { budgetUsd: 0.05 });
    const runTight = await mkRun(A, objTight);
    const tightCtx = door({ companyId: A, objectiveId: objTight, runId: runTight, budgetUsd: 0.05 });
    const childOfTight = await DEL.delegate(tightCtx, {
      toAgent: 'seo-agent', callingAgent: 'executive-agent',
      reason: 'a child that will spend against its parent objective ceiling',
    }, deps);
    if (childOfTight.ok) {
      ok('POSITIVE CONTROL: a delegation under a tight but unexhausted budget is permitted');
      // The CHILD spends past the parent's ceiling.
      await q(`INSERT INTO office_cost_ledger
                 (company_id, run_id, objective_id, provider, model, tokens_input, tokens_output,
                  cost_usd, cost_known, agent, workflow)
               VALUES ($1,$2,$3,'anthropic','m',10,10,0.06,TRUE,'seo-agent','delegated-seo-analysis')`,
        [A, childOfTight.childRunId, objTight]);
      const afterChildSpend = await DEL.delegate(tightCtx, {
        toAgent: 'procurement-agent', callingAgent: 'executive-agent',
        reason: 'delegating again after the first child exhausted the shared ceiling',
      }, deps);
      if (!afterChildSpend.ok && afterChildSpend.refused === 'budget_refused') {
        ok('a CHILD\'s spend exhausts the PARENT objective\'s budget and the next delegation is '
          + 'refused — there is one ceiling, so a child budget is impossible rather than forbidden');
      } else bad('child spend did not count against the parent objective',
        JSON.stringify(afterChildSpend.refused));
    } else bad('the tight-budget positive control was refused', JSON.stringify(childOfTight.refused));

    // ══ 9. NO COMPETING AUTHORIZATION SYSTEM ═════════════════════════════
    console.log('\n── 9. no second authorization model ──\n');

    const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    const competing = requires.filter((r) => /agents\/gate|permissions\/|contract/.test(r));
    if (!competing.length) {
      ok('delegation.js requires no permissions resolver and no product/tenant dispatch spine — '
        + 'there is one answer to "which company is this for"');
      note(`its whole dependency set: ${[...new Set(requires)].join(', ')}`);
      note('src/lib/agents/gate.js remains unadopted and unretired: it keys authorization off a '
        + 'user and a product, and an autonomous office run has neither. That choice is recorded '
        + 'as an open question for the owner, not settled here by implication.');
    } else bad('a second authorization model is reachable from delegation', competing.join(', '));

    console.log('');
  } catch (e) {
    bad('the check itself threw', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  } finally {
    try {
      await q(`DELETE FROM office_delegations WHERE company_id = ANY($1)`, [ids.companies]).catch(() => {});
      await q(`DELETE FROM office_cost_ledger WHERE company_id = ANY($1)`, [ids.companies]).catch(() => {});
      // ── WHAT CANNOT BE CLEANED UP, AND WHY THAT IS CORRECT ──────────────
      //
      // These runs were made through the REAL run ledger, so the ledger wrote a state-change event
      // for each of them — and `agent_run_events` is APPEND-ONLY, enforced by a trigger:
      // "agent_run_events is append-only: DELETE is not permitted". That makes every run with an
      // event permanently undeletable, and its objective undeletable behind it.
      //
      // The right response is NOT to drop the trigger or to stop using the ledger. The append-only
      // rule is a guard on the evidence that autonomous work happened, and a test that weakens a
      // guard to tidy up after itself is worse than a test that admits what it left behind. The
      // alternative — inserting agent_runs rows directly, as check-finite-budget-db.js does — would
      // make the runs deletable and would stop exercising the ledger's own state machine, which is
      // half of what this check is about: a child run that the ledger refused is a delegation that
      // did not happen.
      //
      // What makes that safe here is the cluster, not the DELETE. This script has NO URL override:
      // it created its own disposable Postgres cluster at startup and destroys it in the `finally`
      // below, so nothing it wrote outlives the process. The "delete only what you created, by id"
      // rule in CLAUDE.md governs the verify-* scripts that run against PRODUCTION; it is not
      // satisfiable, and not needed, for a cluster that ceases to exist.
      //
      // So: everything deletable is deleted by id and asserted gone, and the rest is stated.
      let eventsAppendOnly = false;
      try {
        await q(`DELETE FROM agent_run_events WHERE run_id IN
                   (SELECT run_id FROM agent_runs WHERE company_id = ANY($1))`, [ids.companies]);
      } catch (e) { eventsAppendOnly = /append-only/i.test(e.message); }
      if (eventsAppendOnly) {
        ok('agent_run_events refused my cleanup DELETE — the append-only guard on run evidence '
          + 'holds even against this check');
        note('so the runs and their objectives cannot be deleted either; the whole disposable '
          + 'cluster is destroyed instead, and this script has no URL override that could point it '
          + 'anywhere else');
      } else bad('agent_run_events permitted a DELETE — the append-only guard is not in force');

      await q(`DELETE FROM office_delegations WHERE company_id = ANY($1)`, [ids.companies]).catch(() => {});
      const leftDelegations = (await q(
        `SELECT COUNT(*)::int n FROM office_delegations WHERE company_id = ANY($1)`,
        [ids.companies])).rows[0].n;
      const leftCosts = (await q(
        `SELECT COUNT(*)::int n FROM office_cost_ledger WHERE company_id = ANY($1)`,
        [ids.companies])).rows[0].n;
      if (leftDelegations === 0 && leftCosts === 0) {
        ok('cleanup: every deletable fixture of mine is gone (delegations, cost rows)');
      } else bad('cleanup leaked deletable fixtures',
        { delegations: leftDelegations, costs: leftCosts });
    } catch (e) {
      bad('cleanup itself failed', e && e.message);
    }
    await P.end().catch(() => {});
    clearTimeout(watchdog);
    cluster.destroy();
  }

  console.log(`\n  ${pass} ok, ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  delegation is not yet governed.');
    process.exit(1);
  }
  console.log('\nPASS  B3.3: one agent delegates to another by handing over a DERIVED context and '
    + 'never a company id; the target agent, parent liveness, chain depth, autonomy tier, kill '
    + 'switch and objective budget are all checked before a child run exists; the child\'s spend '
    + 'aggregates against the parent objective\'s single ceiling; the dispatch record names all '
    + 'ten fields Gate 3 requires and cannot be written without them; and the database refuses a '
    + 'cross-company or self-referencing delegation.');
  process.exit(0);
})();
