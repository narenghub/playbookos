#!/usr/bin/env node
// ── K2 PRODUCTION VALIDATION ─────────────────────────────────────────────────
//
//   railway ssh 'node scripts/validate-k2-deployed.js'  → exit 0 = the K2 chain holds on production
//
// Proves the ruled K2 chain against the real production schema and constraints:
//
//   CEO creates objective → company identity fixed → objective durable →
//   Executive Agent consumes objective → run references exact objective + company →
//   cross-company objective substitution refused
//
// and the standing boundary: no consequential Executive Agent action is reachable.
//
// ── IT WRITES NOTHING DURABLE, AND IT RUNS THE REAL AGENT ───────────────────
//
// Both at once, which is the point. Every module in the chain — context, scope, run,
// executive-agent, run-ledger — accepts an injected `query`, so the whole chain is run with a
// TRANSACTION CLIENT injected and the transaction is then deliberately rolled back by a sentinel
// throw. The code under test is the deployed code, not a re-implementation of it; the data it
// creates does not survive.
//
// That matters more here than in K1, because this validator does not merely attempt writes — it
// EXECUTES AN AGENT. Running an agent against production is only acceptable while it cannot do
// anything consequential, so that property is re-proven here rather than assumed from the local
// check: the require graph is inspected for any way out of the process, and global fetch is
// replaced by a spy that fails this validator if it fires.
//
// ── WHAT THIS DOES *NOT* DO ─────────────────────────────────────────────────
//
// It does not create the durable Abiozen company record or a real objective. That is the first
// real control-plane data in the system, a rollback cannot undo it, and it is a separate decision
// that needs its own ruling. This validator proves the machinery; it does not start the office.
'use strict';

const path = require('path');
const crypto = require('crypto');
const { query, withTransaction } = require('../src/lib/db');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};
const note = (m) => console.log(`  --    ${m}`);

const SENTINEL = '__k2_validation_rollback__';
const FORBIDDEN = ['mailer', 'whatsapp', 'llm', 'outbound', 'twilio', 'resend'];
// A refusal counts only if the SERVER refused for a real reason.
//   23503 foreign key · 23502 not null · 23514 check · 23505 unique
//   P0001 raise_exception — a plpgsql trigger's deliberate RAISE, which is how
//         office_runs_company_immutable() refuses a re-point or a promotion.
// P0001 was missing at first, so the immutability trigger's correct refusal was scored as
// "failed for an unrelated reason" and the validator went red on a healthy schema. Excluded on
// purpose: 25P02 (aborted transaction), which is what a missing SAVEPOINT looks like and must
// never be mistaken for a refusal.
const REAL_CONSTRAINT_CODES = new Set(['23503', '23502', '23514', '23505', 'P0001']);

(async () => {
  const fixtures = { companies: [], objectives: [], runs: [] };

  // The network spy goes in BEFORE the agent is required.
  const netCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    netCalls.push(String(args[0]));
    return Promise.reject(new Error('validate-k2-deployed: network access is not permitted'));
  };

  try {
    // ══ 1. THE AGENT HAS NO WAY OUT OF THE PROCESS ═════════════════════════
    console.log('\n1. Executive Agent capability boundary (structural)\n');
    for (const k of Object.keys(require.cache)) {
      if (k.includes(path.join('src', 'lib', 'office')) || k.includes(path.join('src', 'lib', 'run-ledger'))) {
        delete require.cache[k];
      }
    }
    const before = new Set(Object.keys(require.cache));
    const exec = require('../src/lib/office/executive-agent');
    const scope = require('../src/lib/office/scope');
    const { resolveObjectiveContext } = require('../src/lib/office/context');
    const { beginObjectiveRun } = require('../src/lib/office/run');

    const graph = Object.keys(require.cache)
      .filter((k) => !before.has(k) && !k.includes('node_modules'))
      .map((k) => path.relative(path.join(__dirname, '..'), k));
    const smuggled = graph.filter((f) => FORBIDDEN.some((x) => f.toLowerCase().includes(x)));
    if (smuggled.length) bad('the DEPLOYED Executive Agent can reach a consequential capability', smuggled.join('\n'));
    else ok(`deployed require graph (${graph.length} module(s)) contains no mailer, WhatsApp, LLM or outbound module`);

    if (beginObjectiveRun.length > 2) bad('beginObjectiveRun has extra parameters — re-audit for a company argument');
    else ok('beginObjectiveRun takes no company parameter (structural, not defensive)');

    // ══ 2. THE CHAIN, AGAINST PRODUCTION, ROLLED BACK ══════════════════════
    console.log('\n2. The K2 chain against production constraints\n');
    note('the whole chain runs with a transaction client injected, and is deliberately ROLLED BACK');

    const A = `k2val-co-a-${crypto.randomUUID()}`;
    const B = `k2val-co-b-${crypto.randomUUID()}`;
    const OA = `k2val-obj-a-${crypto.randomUUID()}`;
    const OB = `k2val-obj-b-${crypto.randomUUID()}`;
    fixtures.companies.push(A, B);
    fixtures.objectives.push(OA, OB);

    let observed = null;
    try {
      await withTransaction(async (c) => {
        // Inject the transaction client. The deployed modules are used as-is.
        const deps = { query: (t, p) => c.query(t, p) };
        let n = 0;
        const attempt = async (fn) => {
          const sp = `k2sp_${++n}`;
          await c.query(`SAVEPOINT ${sp}`);
          try { await fn(); await c.query(`RELEASE SAVEPOINT ${sp}`); return null; }
          catch (e) { await c.query(`ROLLBACK TO SAVEPOINT ${sp}`); return e; }
        };
        const refusal = (label, e) => {
          if (!e) { bad(`${label} was ACCEPTED by production`); return; }
          if (e.code === '25P02') { bad(`${label} reported 25P02 — this check is BROKEN, not passing`, e.message); return; }
          // An application-level refusal is legitimate but is NOT a database refusal, so it is
          // labelled distinctly rather than folded into the SQLSTATE set — the two are different
          // guarantees and a reader must be able to tell which one fired. NoCompanyContext
          // carries code='NO_COMPANY_CONTEXT' (not an absent code), which an earlier version of
          // this function missed, so a correct refusal read as "not a constraint violation".
          if (e.code === 'NO_COMPANY_CONTEXT' || !e.code) {
            ok(`${label} — refused by the application (${e.code || e.name || 'Error'})`);
            return;
          }
          if (!REAL_CONSTRAINT_CODES.has(e.code)) { bad(`${label} failed with ${e.code}, which is neither a constraint violation nor a guard RAISE`, e.message); return; }
          ok(`${label} — refused by production (${e.code})`);
        };

        for (const id of [A, B]) {
          await c.query(`INSERT INTO companies (id, slug, display_name) VALUES ($1,$1,$1)`, [id]);
        }

        // ── CEO creates an objective ──
        const createdA = await scope.createObjective({
          id: OA, companyId: A, objective: 'k2 production validation fixture', priority: 'P3',
          kpiMetric: 'revenue', kpiTarget: 1, deadline: '2026-12-31', budgetUsd: 100,
          autonomyTier: 'supervised', approvalPolicy: 'all_consequential', createdBy: 'validate-k2',
        }, deps);
        await scope.createObjective({
          id: OB, companyId: B, objective: 'k2 other company fixture', priority: 'P3',
          autonomyTier: 'none', approvalPolicy: 'none', createdBy: 'validate-k2',
        }, deps);

        if (createdA.company_id !== A) bad(`the objective did not fix its company (${createdA.company_id})`);
        else ok('CEO creates an objective and its company identity is fixed at creation');
        if (createdA.status !== 'draft') bad(`a new objective is '${createdA.status}', not draft`);
        else ok('a new objective is draft — creating one is not an authorization to execute');

        // ── a draft grants no execution context ──
        refusal('a run against a DRAFT objective',
          await attempt(() => beginObjectiveRun({ objectiveId: OA, trigger: 'office' }, deps)));

        // ── activation, then durability through the scoped accessor ──
        const ctxA = Object.freeze({ companyId: A, objectiveId: OA, runId: null });
        const ctxB = Object.freeze({ companyId: B, objectiveId: OB, runId: null });
        const act = await scope.setObjectiveStatus(ctxA, { id: OA, status: 'active' }, deps);
        if (!act || act.status !== 'active') bad('the CEO could not activate the objective');
        else ok('the CEO activates the objective as a separate, deliberate act');

        const readBack = await scope.getObjective(ctxA, OA, deps);
        if (!readBack) bad('the objective is not readable through the scoped accessor');
        else if (Number(readBack.budget_usd) !== 100 || readBack.autonomy_tier !== 'supervised'
                 || readBack.approval_policy !== 'all_consequential') {
          bad('the objective did not persist its control identity', JSON.stringify(readBack));
        } else ok('the objective is durable with its full control identity (budget, autonomy tier, approval policy)');

        if (await scope.getObjective(ctxB, OA, deps)) bad('company B read company A objective by id');
        else ok('company B cannot read company A objective by substituting its id');
        if (await scope.setObjectiveStatus(ctxB, { id: OA, status: 'paused' }, deps)) bad('company B PAUSED company A objective');
        else ok('company B cannot change the status of company A objective');

        // ── the DEPLOYED Executive Agent consumes the objective ──
        const r = await exec.runObjectiveReview({ objectiveId: OA }, deps);
        if (!r.ran) bad(`the deployed Executive Agent did not run: ${r.reason}`);
        else ok('the deployed Executive Agent consumes the objective and completes a governed run');
        if (r.runId) fixtures.runs.push(r.runId);
        observed = r.observation || null;

        const runRow = (await c.query(
          `SELECT company_id, objective_id, state, workflow, agent FROM agent_runs WHERE run_id=$1`, [r.runId]
        )).rows[0];
        if (!runRow) bad('the run was not persisted');
        else if (runRow.company_id !== A || runRow.objective_id !== OA) {
          bad(`the run does not reference the exact pair (company=${runRow.company_id}, objective=${runRow.objective_id})`);
        } else ok(`the run references the exact objective and company (${runRow.workflow}/${runRow.agent})`);
        if (runRow && runRow.state !== 'SUCCEEDED') {
          bad(`the run is ${runRow.state}, not SUCCEEDED — success was reported over an incomplete run`);
        } else if (runRow) ok('the run reached SUCCEEDED — the reported success and the ledger agree');

        const outcome = (await c.query(
          `SELECT company_id, outcome FROM office_outcomes WHERE run_id=$1`, [r.runId]
        )).rows[0];
        if (!outcome) bad('no durable workflow outcome was recorded');
        else if (outcome.company_id !== A) bad('the outcome was filed against the wrong company');
        else if (outcome.outcome !== 'no_effect') bad(`the outcome claims '${outcome.outcome}' — a non-consequential agent must record no effect`);
        else ok('a company-welded workflow outcome is recorded, honestly stating no business effect');
        if (runRow && runRow.state === 'SUCCEEDED' && outcome && outcome.outcome === 'no_effect') {
          ok('execution success and business effect are recorded separately (SUCCEEDED run, no_effect outcome)');
        }

        // ── cross-company objective substitution ──
        refusal('cross-company objective substitution (B run on A objective)', await attempt(() => c.query(
          `INSERT INTO agent_runs (run_id, root_run_id, trigger, product, state, objective_id, company_id)
           VALUES ($1,$1,'office','internal','CREATED',$2,$3)`, [crypto.randomUUID(), OA, B])));

        // ── company derived, never chosen ──
        await scope.setObjectiveStatus(ctxB, { id: OB, status: 'active' }, deps);
        const bRun = await beginObjectiveRun({ objectiveId: OB, trigger: 'office' }, deps);
        if (bRun.runId) fixtures.runs.push(bRun.runId);
        const bRow = (await c.query(`SELECT company_id FROM agent_runs WHERE run_id=$1`, [bRun.runId])).rows[0];
        if (!bRow || bRow.company_id !== B) bad('beginObjectiveRun did not derive the company from the objective');
        else ok('beginObjectiveRun derives the company from the objective — the agent cannot choose it');

        // ── company identity immutable after insert, on production ──
        refusal('re-pointing a run to another company by UPDATE',
          await attempt(() => c.query(`UPDATE agent_runs SET company_id=$1 WHERE run_id=$2`, [B, r.runId])));
        refusal('promoting a legacy companyless run into the kernel by UPDATE',
          await attempt(async () => {
            const leg = crypto.randomUUID();
            await c.query(`INSERT INTO agent_runs (run_id, root_run_id, trigger, product, state) VALUES ($1,$1,'office','internal','CREATED')`, [leg]);
            fixtures.runs.push(leg);
            await c.query(`UPDATE agent_runs SET company_id=$1, objective_id=$2 WHERE run_id=$3`, [A, OA, leg]);
          }));

        throw new Error(SENTINEL);
      });
      bad('the validation transaction COMMITTED — it was supposed to roll back');
    } catch (e) {
      if (e.message === SENTINEL) ok('validation transaction deliberately ROLLED BACK — nothing durable was written');
      else throw e;
    }

    if (observed) {
      console.log('\n3. What a CEO view would have shown (from the rolled-back run)\n');
      console.log(`  ${JSON.stringify(observed)}`);
      if (observed.budget_fraction_used !== null && observed.budget_fraction_used > 0) {
        note('budget fraction is REPORTED, not enforced: K5 refusal is a separate authorization');
      }
    }

    // ══ 4. NOTHING WENT OUT ════════════════════════════════════════════════
    console.log('\n4. Consequential-action boundary (behavioural)\n');
    if (netCalls.length) bad(`the agent attempted ${netCalls.length} network call(s) on production`, netCalls.join('\n'));
    else ok('the network spy recorded zero calls — the deployed agent attempted no outward action');
    // The spy must be able to fire, or its silence means nothing.
    try { await globalThis.fetch('https://example.invalid/k2-spy-probe'); } catch (_) {}
    if (!netCalls.some((c) => c.includes('k2-spy-probe'))) bad('the network spy did not record a deliberate call — its silence above proves nothing');
    else ok('the network spy records a deliberate call, so its silence above is meaningful');

    // ══ 5. FIXTURE ABSENCE, BY EXACT ID ════════════════════════════════════
    console.log('\n5. Fixture cleanup proof (by exact id)\n');
    const gone = async (table, col, list) => {
      if (!list.length) { ok(`${table}: no fixture ids to check`); return; }
      const n = (await query(`SELECT COUNT(*)::int n FROM ${table} WHERE ${col} = ANY($1)`, [list])).rows[0].n;
      if (n) bad(`${n} of my fixture rows REMAIN in ${table}`);
      else ok(`${table}: all ${list.length} fixture id(s) absent`);
    };
    await gone('companies', 'id', fixtures.companies);
    await gone('objectives', 'id', fixtures.objectives);
    await gone('agent_runs', 'run_id', fixtures.runs);
    const strays = (await query(
      `SELECT (SELECT COUNT(*)::int FROM objectives WHERE created_by='validate-k2') AS o,
              (SELECT COUNT(*)::int FROM office_outcomes WHERE company_id = ANY($1)) AS oc`,
      [fixtures.companies]
    )).rows[0];
    if (strays.o || strays.oc) bad(`validation artefacts survived: objectives=${strays.o} outcomes=${strays.oc}`);
    else ok('no validation artefact of any kind survived the rollback');

    const post = (await query(
      `SELECT COUNT(*)::int n FROM agent_runs WHERE created_at >= '2026-11-01T12:00:00Z'::timestamptz AND company_id IS NOT NULL`
    )).rows[0].n;
    console.log(`  durable post-cutover office runs on production = ${post}`);
    note('0 is expected and correct: this validator proves the machinery and starts no office.');
    note('Creating the durable company record and the first real objective is a separate decision.');

  } catch (e) {
    bad('unexpected error', e.stack || e.message);
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(fail
    ? `\nFAIL  ${fail} K2 production assertion(s) failed`
    : '\nPASS  K2 holds on production: the CEO control object governs a run welded to one company, '
      + 'the deployed agent reached nothing consequential, and nothing durable was written');
  process.exit(fail ? 1 : 0);
})();
