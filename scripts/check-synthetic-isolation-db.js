#!/usr/bin/env node
// ── SYNTHETIC ISOLATION, EXERCISED AGAINST A REAL DATABASE ──────────────────
//
// Migration 62, authorized 2026-11-27. The owner's Priority 2 correction was:
// *"Verify that the development API enforces synthetic objective and data isolation. Cloud
// eligibility and pure handlers alone do not establish synthetic-only authorization."*
//
// They were right: no synthetic marker existed in either schema. This check arranges the four
// states a restricted worker can meet and asserts each one is distinguished — and, critically, that
// an UNRESTRICTED worker claims the very same task, so every refusal below is measuring the
// isolation rather than a queue that happens to be empty.
//
// The verdict is the exit status.

'use strict';

process.env.ADMIN_EMAIL = 'syn-bootstrap@syn.invalid';
process.env.ADMIN_PASSWORD = `syn-${require('crypto').randomBytes(16).toString('hex')}`;
// Worker identities are sealed at rest, so enrolling one needs a seal key. Generated per run: this
// check never reads a real credential and never needs to.
process.env.WORKER_SECRET_SEAL_KEY = require('crypto').randomBytes(32).toString('hex');

const crypto = require('crypto');
const PG = require('./lib/pg-disposable');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0;
let fail = 0;
const lines = [];
const ok = (m) => { pass += 1; lines.push(`  ok    ${m}`); };
const bad = (m) => { fail += 1; lines.push(`  FAIL  ${m}`); };
const note = (m) => lines.push(`  --    ${m}`);
const section = (t) => lines.push('', `── ${t} ──`, '');

const made = { companies: [], tasks: [], workers: [] };

(async () => {
  let cluster = null;
  try {
    cluster = PG.create({ label: 'synthetic-isolation' });
  } catch (e) {
    console.log(`NOT EXECUTED  infrastructure unavailable: ${e.message}`);
    process.exit(EXIT_NOT_EXECUTED);
  }

  process.env.DATABASE_URL = cluster.url;
  process.env.NODE_ENV = 'development';

  const DB = require('../src/lib/db');
  const { query } = DB;

  try {
    await DB.initDB();
    await DB.initPhase2();
    await DB.migrateSchemas();
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);
    await require('../src/lib/identity/schema').migrateIdentity(query);
    const LEASES = require('../src/lib/worker/leases');
    const IDENTITY = require('../src/lib/worker/identity');
    // The order existing worker harnesses use: identities BEFORE tasks. migrateWorkerIdentity is
    // what creates worker_identities, and migration 62's installer runs from all three migrators.
    await IDENTITY.migrateWorkerIdentity(query);
    await LEASES.migrateWorkerTasks(query);
    const SYN = require('../src/lib/worker/synthetic-isolation');
    const TYPES = require('../src/lib/worker/task-types');

    // ═══ 1. THE MIGRATION, AND ITS TWO DELIBERATELY OPPOSITE DEFAULTS ═══════
    section('1. migration 62 — the columns exist and fail closed in opposite directions');

    const cols = await query(
      `SELECT table_name, column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE (table_name = 'companies' AND column_name = 'is_synthetic')
           OR (table_name = 'worker_identities' AND column_name = 'synthetic_only')
        ORDER BY table_name`);
    if (cols.rows.length === 2) {
      ok('both columns exist after the migrator runs');
    } else {
      bad(`migration 62 produced ${cols.rows.length} of 2 columns: `
        + JSON.stringify(cols.rows.map((r) => `${r.table_name}.${r.column_name}`)));
    }
    const byTable = Object.fromEntries(cols.rows.map((r) => [r.table_name, r]));
    if (byTable.companies && /false/.test(byTable.companies.column_default || '')) {
      ok('companies.is_synthetic defaults FALSE — a company is real unless somebody says otherwise');
    } else {
      bad(`companies.is_synthetic default is ${byTable.companies && byTable.companies.column_default}`);
    }
    if (byTable.worker_identities && /true/.test(byTable.worker_identities.column_default || '')) {
      ok('worker_identities.synthetic_only defaults TRUE — a worker is restricted unless widened');
    } else {
      bad('worker_identities.synthetic_only does not default true, so every identity enrolled '
        + 'before the column existed would be unrestricted and the column vacuous');
    }
    for (const r of cols.rows) {
      if (r.is_nullable !== 'NO') {
        bad(`${r.table_name}.${r.column_name} is nullable — a third value meaning "exempt" is the `
          + 'quiet permission this column exists to remove');
      }
    }
    if (cols.rows.every((r) => r.is_nullable === 'NO')) ok('neither column admits a NULL third state');

    // Idempotency: re-running the migrator must not fail or change anything.
    await require('../src/lib/office/schema').migrateOffice(query);
    await IDENTITY.migrateWorkerIdentity(query);
    await LEASES.migrateWorkerTasks(query);
    ok('the migration is idempotent across all three of its call sites');

    // ═══ 2. THE FIXTURES ════════════════════════════════════════════════════
    section('2. four tasks: synthetic company, real company, no company, and a control');

    const SYNCO = `syn-co-${crypto.randomUUID().slice(0, 8)}`;
    const REALCO = `real-co-${crypto.randomUUID().slice(0, 8)}`;
    for (const [id, name] of [[SYNCO, 'Synthetic Fixture Co'], [REALCO, 'A Real Company']]) {
      await query(
        `INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$2,$3,'active')`,
        [id, id, name]);
      made.companies.push(id);
    }
    const marked = await SYN.setCompanySynthetic(SYNCO, true, { query });
    if (marked.is_synthetic === true) ok('setCompanySynthetic marks one company and returns the row');
    else bad(`setCompanySynthetic returned ${JSON.stringify(marked)}`);

    let refusedTruthy = false;
    try { await SYN.setCompanySynthetic(REALCO, 'yes', { query }); } catch (_) { refusedTruthy = true; }
    if (refusedTruthy) ok('a truthy value is refused — which data a worker may see is not a coercion');
    else bad('setCompanySynthetic accepted a string, so a truthy value can mark a company synthetic');

    const CLOUD_TYPE = TYPES.KNOWN.find((t) => /synthetic\.echo/.test(t)) || 'synthetic.echo';
    const enq = async (companyId, label) => {
      const r = await LEASES.enqueueTask({
        taskType: CLOUD_TYPE,
        payload: { echo: label },
        intentKey: `syn-iso-${label}-${crypto.randomUUID().slice(0, 8)}`,
        companyId,
        createdBy: 'check-synthetic-isolation',
      }, { query });
      if (!r || !r.ok) throw new Error(`could not enqueue ${label}: ${JSON.stringify(r)}`);
      made.tasks.push(r.taskId);
      return r.taskId;
    };
    const tSyn = await enq(SYNCO, 'synthetic');
    const tReal = await enq(REALCO, 'real');
    const tNull = await enq(null, 'nocompany');
    note(`enqueued three tasks of type ${CLOUD_TYPE}: synthetic, real, no-company`);

    // ═══ 3. A RESTRICTED WORKER ═════════════════════════════════════════════
    section('3. a restricted worker claims the synthetic task and nothing else');

    const enrol = async (label) => {
      const t = await IDENTITY.createEnrollmentToken({ label }, { query });
      const r = await IDENTITY.consumeEnrollmentToken(
        { token: t.token, hostFingerprint: `fixture-${label}` }, { query });
      if (!r || r.ok !== true) throw new Error(`enrolment failed: ${JSON.stringify(r)}`);
      made.workers.push(r.workerId);
      return r.workerId;
    };

    const restricted = await enrol('restricted-cloud');
    const defaulted = await query(
      `SELECT synthetic_only FROM worker_identities WHERE id = $1`, [restricted]);
    if (defaulted.rows[0].synthetic_only === true) {
      ok('a NEWLY enrolled worker is restricted by default — it did not have to be asked for');
    } else {
      bad('a newly enrolled worker is unrestricted, so the default fails open');
    }

    const c1 = await LEASES.claimTask({ workerId: restricted }, { query });
    if (c1 && c1.ok === true && c1.taskId === tSyn) {
      ok('it claims the SYNTHETIC company\'s task');
    } else {
      bad(`the restricted worker claimed ${JSON.stringify(c1 && (c1.taskId || c1.code))} instead `
        + 'of the synthetic task');
    }

    // With the synthetic task taken, the only PENDING work is the real company's and the
    // no-company one. Both must be refused, and the refusal must NAME the reason.
    const c2 = await LEASES.claimTask({ workerId: restricted }, { query });
    if (c2 && c2.ok === false && c2.code === 'nothing_claimable_synthetic_isolation') {
      ok('the real company\'s and no-company tasks are refused BY NAME, not drawn as an idle queue');
    } else {
      bad(`expected nothing_claimable_synthetic_isolation, got ${JSON.stringify(c2 && (c2.code || c2))}`);
    }
    if (c2 && c2.blockedBySyntheticIsolation === 2) {
      ok('and it counts BOTH of them — the real company and the one with no company at all');
    } else {
      bad(`the blocked count was ${JSON.stringify(c2 && c2.blockedBySyntheticIsolation)}, `
        + `expected 2 — if it is 0 the `
        + 'complement predicate disagrees with the pick about a NULL company');
    }

    // Asking for the refused tasks BY ID must still refuse: a named task must not bypass the gate.
    for (const [id, what] of [[tReal, 'the real company\'s task'], [tNull, 'the no-company task']]) {
      const byId = await LEASES.claimTask({ workerId: restricted, taskId: id }, { query });
      if (byId && byId.ok === false) ok(`naming ${what} by id does not bypass the isolation`);
      else bad(`claiming ${what} by id SUCCEEDED: ${JSON.stringify(byId && byId.task)}`);
    }

    // And the attempts were not consumed, which is the whole reason the filter is in the pick.
    const attempts = await query(
      `SELECT id, state FROM worker_tasks WHERE id = ANY($1)`, [[tReal, tNull]]);
    if (attempts.rows.every((r) => r.state === 'PENDING')) {
      ok('both refused tasks are still PENDING with their attempts unconsumed');
    } else {
      bad(`a refused task changed state: ${JSON.stringify(attempts.rows)}`);
    }

    // ═══ 4. CONTROL — AN UNRESTRICTED WORKER TAKES THE SAME TASKS ═══════════
    section('4. control — the refusals above measure the isolation, not an empty queue');

    const unrestricted = await enrol('widened-hardware');
    await query(
      `UPDATE worker_identities SET synthetic_only = false WHERE id = $1`, [unrestricted]);

    const u1 = await LEASES.claimTask({ workerId: unrestricted, taskId: tReal }, { query });
    if (u1 && u1.ok === true && u1.taskId === tReal) {
      ok('a WIDENED worker claims the real company\'s task — so section 3 was measuring the gate');
    } else {
      bad(`the widened worker could not claim the real task: ${JSON.stringify(u1 && (u1.code || u1))}`);
    }
    const u2 = await LEASES.claimTask({ workerId: unrestricted, taskId: tNull }, { query });
    if (u2 && u2.ok === true && u2.taskId === tNull) {
      ok('and the no-company task too — which is exactly why the M7.6 hardware pilot needs widening');
    } else {
      bad(`the widened worker could not claim the no-company task: ${JSON.stringify(u2 && (u2.code || u2))}`);
    }

    // ═══ 5. AN UNKNOWN WORKER IS RESTRICTED, NOT EXEMPT ═════════════════════
    section('5. an identity that does not exist reads as restricted');

    const ghost = `wkr_${crypto.randomBytes(16).toString('hex')}`;
    const g = await LEASES.claimTask({ workerId: ghost }, { query });
    if (g && g.ok === false) {
      ok(`an unenrolled worker claims nothing (${g.code})`);
    } else {
      bad(`an unenrolled worker claimed ${JSON.stringify(g && g.taskId)}`);
    }

    // ═══ 6. UNMARKING CLOSES IT AGAIN ═══════════════════════════════════════
    section('6. the marker is the thing being read, not a cached decision');

    const tSyn2 = await enq(SYNCO, 'synthetic-second');
    await SYN.setCompanySynthetic(SYNCO, false, { query });
    const afterUnmark = await LEASES.claimTask({ workerId: restricted }, { query });
    if (afterUnmark && afterUnmark.ok === false) {
      ok('unmarking the company closes the restricted worker out of its next task immediately');
    } else {
      bad(`after unmarking, the restricted worker still claimed ${JSON.stringify(afterUnmark && afterUnmark.taskId)}`);
    }
    await SYN.setCompanySynthetic(SYNCO, true, { query });
    const reMarked = await LEASES.claimTask({ workerId: restricted }, { query });
    if (reMarked && reMarked.ok === true && reMarked.taskId === tSyn2) {
      ok('and re-marking reopens it — the gate reads the row every time');
    } else {
      bad(`after re-marking, the claim returned ${JSON.stringify(reMarked && (reMarked.code || reMarked))}`);
    }
  } catch (e) {
    bad(`the check itself failed: ${e.message}`);
    lines.push(String(e.stack || '').split('\n').slice(1, 5).join('\n'));
  } finally {
    try {
      const { query } = require('../src/lib/db');
      for (const id of made.tasks) {
        await query('DELETE FROM worker_results WHERE run_id IN (SELECT run_id FROM worker_leases WHERE task_id = $1)', [id]).catch(() => {});
        await query('DELETE FROM worker_leases WHERE task_id = $1', [id]).catch(() => {});
        await query('DELETE FROM worker_tasks WHERE id = $1', [id]);
      }
      for (const id of made.workers) await query('DELETE FROM worker_identities WHERE id = $1', [id]);
      for (const id of made.companies) await query('DELETE FROM companies WHERE id = $1', [id]);
      const mine = (await query(
        'SELECT count(*)::int n FROM worker_tasks WHERE id = ANY($1)', [made.tasks])).rows[0].n;
      if (mine === 0) note('fixtures removed by id; none of mine remain');
      else bad(`${mine} of my fixture tasks survived cleanup`);
    } catch (e) { note(`cleanup could not complete: ${e.message}`); }
    try { cluster.destroy(); } catch (_) { /* already gone is the desired state */ }
  }

  console.log('══ SYNTHETIC ISOLATION (MIGRATION 62) ══');
  console.log(lines.join('\n'));
  console.log('');
  console.log(fail === 0
    ? `OK  synthetic isolation holds (${pass} assertions)`
    : `FAILED  ${fail} assertion(s) failed, ${pass} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();
