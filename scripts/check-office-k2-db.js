#!/usr/bin/env node
// ── K2: THE CEO CONTROL OBJECT, AGAINST A REAL POSTGRES ─────────────────────
//
//   scripts/check-office-k2-db.js   → exit 0 = the ruled K2 chain holds
//
// The ruled chain, and nothing wider:
//
//   CEO creates objective → company identity fixed → objective durable →
//   Executive Agent consumes objective → run references exact objective + company →
//   cross-company objective substitution refused
//
// plus the standing boundary: "Do not enable consequential Executive Agent actions yet."
//
// ── WHY THIS NEEDS A SERVER ──────────────────────────────────────────────────
//
// Every guarantee in the chain is a server-side object: a composite FK with MATCH FULL, a
// BEFORE UPDATE transition guard, and company-scoped predicates evaluated by Postgres. A stubbed
// query would accept the cross-company substitution and report success.
//
// ── THE NON-CONSEQUENTIAL CLAIM IS PROVEN TWO WAYS ───────────────────────────
//
// "The agent sends nothing" is the kind of claim that passes for the wrong reason. On 31 Oct a
// stubbed LLM returned null, the RFQ email body came back null, dispatch treated it as a failed
// send, and every subject assertion read `undefined` while appearing to pass — absence of
// observed output is not proof the consequential path was not taken. So:
//
//   1. STRUCTURAL — the module's transitive require graph is inspected and must contain no
//      mailer, WhatsApp, LLM or outbound-HTTP module. The capability is absent, not unused.
//   2. BEHAVIOURAL — global fetch is replaced by a spy that records any call. If the agent
//      reaches the network by any route, the spy fires and this check goes red.
//
// Fixtures: two companies, recorded by id and deleted by exactly those ids in a finally. The
// post-condition is "my fixtures are gone", never "the table is empty".
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};
const note = (m) => console.log(`  --    ${m}`);

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { const p = path.join(d, 'initdb'); if (fs.existsSync(p)) return d; }
  return null;
}
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/office-k2-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55995' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55995 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55995`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.OFFICE_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set OFFICE_PG_URL or install initdb)');
  console.log('SKIP  K2 chain not executed against a server — this check needs one');
  process.exit(0);
}

// Forbidden capabilities, by module path fragment. These are the ways out of the process.
const FORBIDDEN = ['mailer', 'whatsapp', 'llm', 'outbound', 'twilio', 'resend'];

async function refused(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: url, ssl: false });
  const q = (t, p) => P.query(t, p);
  const deps = { query: q };

  const ids = { companies: [], objectives: [], runs: [] };
  const uid = (p) => `${p}-${crypto.randomUUID()}`;

  const { migrateRuns } = require('../src/lib/runs');
  const { migrateOffice } = require('../src/lib/office/schema');

  // ── THE NETWORK SPY. Installed before the agent is ever required. ────────
  const netCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    netCalls.push(String(args[0]));
    return Promise.reject(new Error('check-office-k2-db: network access is not permitted in K2'));
  };

  try {
    await migrateRuns(q);
    await migrateOffice(q);
    ok('schema applied (runs + office)');

    // ── 1. STRUCTURAL: the Executive Agent has no way out of the process ──
    for (const k of Object.keys(require.cache)) {
      if (k.includes(path.join('src', 'lib', 'office')) || k.includes(path.join('src', 'lib', 'run-ledger'))) {
        delete require.cache[k];
      }
    }
    const before = new Set(Object.keys(require.cache));
    const exec = require('../src/lib/office/executive-agent');
    const graph = Object.keys(require.cache)
      .filter((k) => !before.has(k) && !k.includes('node_modules'))
      .map((k) => path.relative(path.join(__dirname, '..'), k));
    const smuggled = graph.filter((f) => FORBIDDEN.some((x) => f.toLowerCase().includes(x)));
    if (smuggled.length) {
      bad('the Executive Agent can reach a consequential capability — it must not be able to yet', smuggled.join('\n'));
    } else {
      ok(`Executive Agent require graph (${graph.length} module(s)) contains no mailer, WhatsApp, LLM or outbound module`);
    }

    // ── 2. CEO creates an objective; company identity is fixed ────────────
    const scope = require('../src/lib/office/scope');
    const { resolveObjectiveContext, NoCompanyContext } = require('../src/lib/office/context');
    const { beginObjectiveRun } = require('../src/lib/office/run');

    const A = uid('co-a'), B = uid('co-b');
    for (const id of [A, B]) {
      await q(`INSERT INTO companies (id, slug, display_name) VALUES ($1,$1,$1)`, [id]);
      ids.companies.push(id);
    }

    const OA = uid('obj-a'), OB = uid('obj-b');
    const createdA = await scope.createObjective({
      id: OA, companyId: A, objective: 'Abiozen revenue to $10M', priority: 'P0',
      kpiMetric: 'revenue', kpiTarget: 10000000, deadline: '2026-12-31', budgetUsd: 100,
      autonomyTier: 'supervised', approvalPolicy: 'all_consequential', createdBy: 'ceo',
    }, deps);
    ids.objectives.push(OA);
    const createdB = await scope.createObjective({
      id: OB, companyId: B, objective: 'other company objective', priority: 'P2',
      autonomyTier: 'none', approvalPolicy: 'none', createdBy: 'ceo',
    }, deps);
    ids.objectives.push(OB);

    if (createdA.company_id !== A) bad(`objective did not fix its company (${createdA.company_id})`);
    else ok('CEO creates an objective and its company identity is fixed at creation');
    if (createdA.status !== 'draft') bad(`a new objective is '${createdA.status}', not 'draft' — creation would itself authorize execution`);
    else ok('a new objective is draft: creating one is not an authorization to execute');

    // A company that does not exist cannot hold an objective.
    let e = await refused(() => scope.createObjective({
      id: uid('obj-ghost'), companyId: 'no-such-company', objective: 'x', priority: 'P3',
      autonomyTier: 'none', approvalPolicy: 'none', createdBy: 'ceo',
    }, deps));
    if (!e) bad('an objective was created for a company that does not exist');
    else ok(`an objective cannot name a non-existent company — refused (${e.code})`);

    // ── 3. A draft objective grants no execution context ──────────────────
    e = await refused(() => resolveObjectiveContext({ objectiveId: OA }, deps));
    if (!e) bad('a DRAFT objective yielded an execution context');
    else if (e.code !== 'NO_COMPANY_CONTEXT') bad(`draft objective failed for the wrong reason: ${e.message}`);
    else ok('a draft objective grants no execution context');

    e = await refused(() => beginObjectiveRun({ objectiveId: OA, trigger: 'office' }, deps));
    if (!e) bad('a run was opened against a DRAFT objective');
    else ok('no run can be opened against a draft objective');

    // ── 4. Activation, and durability ─────────────────────────────────────
    const ctxA = Object.freeze({ companyId: A, objectiveId: OA, runId: null });
    const activated = await scope.setObjectiveStatus(ctxA, { id: OA, status: 'active' }, deps);
    if (!activated || activated.status !== 'active') bad('the CEO could not activate the objective');
    else ok('the CEO activates the objective as a separate, deliberate act');

    // Durable: read back through the company-scoped accessor, in a fresh query.
    const readBack = await scope.getObjective(ctxA, OA, deps);
    if (!readBack) bad('the objective is not readable through the scoped accessor — it is not durable');
    else if (Number(readBack.budget_usd) !== 100 || readBack.autonomy_tier !== 'supervised'
             || readBack.approval_policy !== 'all_consequential') {
      bad('the objective did not persist its control fields', JSON.stringify(readBack));
    } else ok('the objective is durable with its full control identity (budget, autonomy tier, approval policy)');

    // Cross-company read of the objective: the substitution attack on the READ side.
    const ctxB = Object.freeze({ companyId: B, objectiveId: OB, runId: null });
    if (await scope.getObjective(ctxB, OA, deps)) bad('company B read company A objective by id');
    else ok('company B cannot read company A objective by substituting its id');
    // And B cannot activate or pause A's objective.
    if (await scope.setObjectiveStatus(ctxB, { id: OA, status: 'paused' }, deps)) {
      bad('company B PAUSED company A objective');
    } else ok('company B cannot change the status of company A objective');

    // ── 5. The Executive Agent consumes the objective ─────────────────────
    const r = await exec.runObjectiveReview({ objectiveId: OA }, deps);
    if (!r.ran) bad(`the Executive Agent did not run: ${r.reason}`);
    else ok('the Executive Agent consumes the objective and completes a governed run');
    if (r.runId) ids.runs.push(r.runId);

    // ── 6. The run references the EXACT objective and company ─────────────
    const runRow = (await q(
      `SELECT run_id, company_id, objective_id, state, workflow, agent FROM agent_runs WHERE run_id = $1`,
      [r.runId]
    )).rows[0];
    if (!runRow) bad('the run was not persisted');
    else if (runRow.company_id !== A || runRow.objective_id !== OA) {
      bad(`the run does not reference the exact pair (company=${runRow.company_id}, objective=${runRow.objective_id})`);
    } else ok(`the run references the exact objective and company (${runRow.workflow}/${runRow.agent})`);

    // ASSERT THE TERMINAL STATE, not just the pair. The first version of this check asserted only
    // company/objective and passed while the run sat in CREATED: the agent had skipped
    // CREATED -> RUNNING, `finish` degraded (it LOGS rather than throws, by durability class), and
    // "ran: true" was returned over a run that never completed. A reported success whose ledger
    // says otherwise is the exact shape of a false green.
    if (runRow && runRow.state !== 'SUCCEEDED') {
      bad(`the run is in state ${runRow.state}, not SUCCEEDED — the agent reported success over an incomplete run`);
    } else if (runRow) ok('the run reached SUCCEEDED — the reported success and the ledger agree');

    // The outcome is welded to the same company, and says it changed nothing.
    const outcome = (await q(
      `SELECT company_id, run_id, outcome, business_effect FROM office_outcomes WHERE run_id = $1`, [r.runId]
    )).rows[0];
    if (!outcome) bad('no durable workflow outcome was recorded');
    else if (outcome.company_id !== A) bad('the outcome was filed against the wrong company');
    else if (outcome.outcome !== 'no_effect') bad(`the outcome claims '${outcome.outcome}' — a non-consequential agent must record no effect`);
    else ok('a durable workflow outcome is recorded, company-welded, and honestly states no business effect');

    // Execution state is not business outcome: the run SUCCEEDED while the outcome is no_effect.
    if (runRow && runRow.state === 'SUCCEEDED' && outcome && outcome.outcome === 'no_effect') {
      ok('execution success and business effect are recorded separately (SUCCEEDED run, no_effect outcome)');
    }

    // ── 7. Cross-company objective substitution, refused by the database ──
    e = await refused(() => q(
      `INSERT INTO agent_runs (run_id, root_run_id, trigger, product, state, objective_id, company_id)
       VALUES ($1,$1,'office','internal','CREATED',$2,$3)`, [crypto.randomUUID(), OA, B]
    ));
    if (!e) bad('a run under company B attached to company A objective');
    else ok(`cross-company objective substitution refused by the database (${e.code})`);

    // And through the real entry point: an agent naming another company's objective gets THAT
    // objective's company, never its own choice — there is no parameter to express a preference.
    // B's objective has to be activated first: a draft grants no context, which the earlier
    // assertions already established and which an earlier version of this check forgot.
    await scope.setObjectiveStatus(ctxB, { id: OB, status: 'active' }, deps);
    const bRun = await beginObjectiveRun({ objectiveId: OB, trigger: 'office' }, deps);
    if (bRun.runId) ids.runs.push(bRun.runId);
    const bRow = (await q(`SELECT company_id FROM agent_runs WHERE run_id = $1`, [bRun.runId])).rows[0];
    if (!bRow || bRow.company_id !== B) bad('beginObjectiveRun did not derive the company from the objective');
    else ok('beginObjectiveRun derives the company from the objective, so the agent cannot choose it');
    if (beginObjectiveRun.length > 2) bad('beginObjectiveRun grew extra parameters — re-audit for a company argument');
    else ok('beginObjectiveRun takes no company parameter (structural, not defensive)');

    // ── 8. Company identity is immutable after the insert ─────────────────
    e = await refused(() => q(`UPDATE agent_runs SET company_id = $1 WHERE run_id = $2`, [B, r.runId]));
    if (!e) bad('a run was RE-POINTED to another company by UPDATE — the pair is defeasible after the fact');
    else ok('company_id cannot be changed after insert (transition guard)');

    e = await refused(() => q(`UPDATE agent_runs SET objective_id = $1 WHERE run_id = $2`, [OB, r.runId]));
    if (!e) bad('a run was re-pointed to another objective by UPDATE');
    else ok('objective_id cannot be changed after insert');

    // The promotion attack: a legacy both-NULL run being upgraded into the kernel later.
    const legacy = crypto.randomUUID();
    await q(`INSERT INTO agent_runs (run_id, root_run_id, trigger, product, state) VALUES ($1,$1,'cron','internal','CREATED')`, [legacy]);
    ids.runs.push(legacy);
    e = await refused(() => q(`UPDATE agent_runs SET company_id=$1, objective_id=$2 WHERE run_id=$3`, [A, OA, legacy]));
    if (!e) bad('a legacy companyless run was PROMOTED into the kernel by UPDATE');
    else ok('a legacy run cannot be promoted into the kernel by a later UPDATE');

    // ── 9. BEHAVIOURAL: nothing went out ──────────────────────────────────
    if (netCalls.length) bad(`the Executive Agent attempted ${netCalls.length} network call(s)`, netCalls.join('\n'));
    else ok('the network spy recorded zero calls — the agent attempted no outward action');

    // ── 10. MUTATION CONTROLS ─────────────────────────────────────────────
    note('mutation controls: disable each mechanism, prove the attack then succeeds');

    // M1 — neuter the transition guard and prove the promotion attack then succeeds.
    //
    // It must be isolated on a run with NO kernel children. The first version of this control used
    // the Executive Agent's run, and it was STILL refused with the guard neutered — by
    // fk_office_outcomes_run_company, because the outcome row references (run_id, company_id) and
    // moving the run's company would orphan it. That is a SECOND, INDEPENDENT mechanism, recorded
    // as M1b below, and it is why the guard has to be isolated on a childless run to be measured
    // at all. Both halves matter: the child FK only protects a run that already has kernel
    // records, and the guard is what protects one that does not — which is every run at the
    // moment it is created.
    await q(`CREATE OR REPLACE FUNCTION office_runs_company_immutable() RETURNS trigger AS $fn$
             BEGIN RETURN NEW; END; $fn$ LANGUAGE plpgsql`);

    const promoted = await refused(() => q(
      `UPDATE agent_runs SET company_id=$1, objective_id=$2 WHERE run_id=$3`, [A, OA, legacy]));
    if (promoted) bad('M1a with the guard neutered a childless legacy run was still refused — the guard is not what protects promotion', promoted.message);
    else ok('M1a neutering the guard lets a childless legacy run be PROMOTED into the kernel — the guard is load-bearing');

    const childGuarded = await refused(() => q(
      `UPDATE agent_runs SET company_id=$1, objective_id=$2 WHERE run_id=$3`, [B, OB, r.runId]));
    if (!childGuarded) bad('M1b a run WITH kernel children was re-pointed even though its outcome references (run_id, company_id)');
    else ok(`M1b independent of the guard, a run with kernel children cannot be re-pointed — its child records' composite FK refuses it (${childGuarded.code})`);

    // Restore: put the legacy run back to legacy by explicit id, then reinstate the real guard.
    await q(`UPDATE agent_runs SET company_id=NULL, objective_id=NULL WHERE run_id=$1`, [legacy]);
    await migrateOffice(q);
    const restored = (await q(`SELECT company_id, objective_id FROM agent_runs WHERE run_id=$1`, [legacy])).rows[0];
    if (!restored || restored.company_id !== null || restored.objective_id !== null) {
      bad('M1 restore failed — the legacy run is not back to unattributed', JSON.stringify(restored));
    } else ok('M1 restore: the immutability guard is reinstated and the legacy run is unattributed again');
    e = await refused(() => q(`UPDATE agent_runs SET company_id=$1, objective_id=$2 WHERE run_id=$3`, [A, OA, legacy]));
    if (!e) bad('after restore the promotion was still accepted');
    else ok('after restore the promotion is refused again');

    // M2 — the forbidden-capability scan must be able to catch one.
    const planted = graph.concat(['src/lib/mailer.js']);
    const caught = planted.filter((f) => FORBIDDEN.some((x) => f.toLowerCase().includes(x)));
    if (!caught.length) bad('M2 the forbidden-capability scan cannot detect a planted mailer require — section 1 proves nothing');
    else ok('M2 the forbidden-capability scan detects a planted mailer require');

    // M3 — the network spy must be able to fire, or section 9 is vacuous.
    const probe = await refused(() => globalThis.fetch('https://example.invalid/k2-spy-probe'));
    if (!probe || !netCalls.some((c) => c.includes('k2-spy-probe'))) {
      bad('M3 the network spy did not record a deliberate call — section 9 proves nothing');
    } else ok('M3 the network spy records a deliberate call, so its silence in section 9 is meaningful');

  } catch (e) {
    bad('unexpected error', e.stack || e.message);
  } finally {
    globalThis.fetch = realFetch;
    try {
      for (const id of ids.runs) await q(`DELETE FROM office_outcomes WHERE run_id = $1`, [id]);
      await q(`ALTER TABLE agent_run_events DISABLE TRIGGER trg_agent_run_events_append_only`);
      try {
        for (const id of ids.runs) await q(`DELETE FROM agent_run_events WHERE run_id = $1`, [id]);
        for (const id of ids.runs) await q(`DELETE FROM agent_runs WHERE run_id = $1`, [id]);
      } finally {
        await q(`ALTER TABLE agent_run_events ENABLE TRIGGER trg_agent_run_events_append_only`);
      }
      const trg = (await q(`SELECT tgenabled FROM pg_trigger WHERE tgname='trg_agent_run_events_append_only'`)).rows[0];
      if (!trg || trg.tgenabled === 'D') bad('the append-only trigger was left DISABLED after cleanup');
      else ok('the append-only trigger is enabled again after cleanup');

      for (const id of ids.objectives) await q(`DELETE FROM objectives WHERE id = $1`, [id]);
      for (const id of ids.companies) await q(`DELETE FROM companies WHERE id = $1`, [id]);

      const leaks = [];
      const mine = async (table, col, list) => {
        if (!list.length) return;
        const n = (await q(`SELECT COUNT(*)::int n FROM ${table} WHERE ${col} = ANY($1)`, [list])).rows[0].n;
        if (n) leaks.push(`${table}: ${n} of my rows remain`);
      };
      await mine('companies', 'id', ids.companies);
      await mine('objectives', 'id', ids.objectives);
      await mine('agent_runs', 'run_id', ids.runs);
      if (leaks.length) bad('fixture cleanup leaked', leaks.join('\n'));
      else ok('cleanup: every fixture row I created is gone (by id)');
    } catch (e) {
      bad('cleanup failed', e.message);
    }
    try { await P.end(); } catch (_) {}
    stopTemp();
  }

  console.log(fail
    ? `\nFAIL  ${fail} K2 assertion(s) failed`
    : '\nPASS  K2: the CEO sets an objective, the Executive Agent consumes it under a run welded to '
      + 'that company, and no consequential action is reachable');
  process.exit(fail ? 1 : 0);
})();
