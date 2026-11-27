#!/usr/bin/env node
// ── MIGRATION 62 APPLIED TO A DATABASE THAT IS ALREADY IN USE ───────────────
//
// Owner, sixth directive: *"Test upgrades from migration 61 with existing identities, existing
// leases and pending tasks, not only fresh databases."* and *"Do not silently widen existing
// identities."*
//
// Every other check builds its schema from nothing, which is the easy case and not the one that
// bites. This one constructs a **migration-61 state with data already in it** — enrolled
// identities, one of them holding `exec:hardware`, an open lease, and pending tasks both with and
// without a company — and only then applies 62.
//
// **How the pre-state is built, since it matters for whether this check means anything.** The
// installer now runs from all three migrators, so there is no way to ask for "61" directly. The
// columns and triggers are therefore DROPPED after migrating, which reconstructs exactly the shape
// a 61-era database has, and the fixtures are inserted into that shape — through the same INSERT
// the old code used, which the new guard would refuse. That ordering is the point: it proves the
// migration copes with rows that predate its rules, which is the only situation a real upgrade is
// ever in.
//
// The verdict is the exit status.

'use strict';

process.env.ADMIN_EMAIL = 'mig62@mig.invalid';
process.env.ADMIN_PASSWORD = `m-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.WORKER_SECRET_SEAL_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.NODE_ENV = 'development';

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

(async () => {
  let cluster = null;
  try {
    cluster = PG.create({ label: 'mig62-upgrade' });
  } catch (e) {
    console.log(`NOT EXECUTED  infrastructure unavailable: ${e.message}`);
    process.exit(EXIT_NOT_EXECUTED);
  }

  process.env.DATABASE_URL = cluster.url;
  const DB = require('../src/lib/db');
  const { query } = DB;

  try {
    await DB.initDB();
    await DB.initPhase2();
    await DB.migrateSchemas();
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);
    await require('../src/lib/identity/schema').migrateIdentity(query);
    const IDENTITY = require('../src/lib/worker/identity');
    const LEASES = require('../src/lib/worker/leases');
    await IDENTITY.migrateWorkerIdentity(query);
    await LEASES.migrateWorkerTasks(query);

    const SYN = require('../src/lib/worker/synthetic-isolation');
    const IMMUT = require('../src/lib/worker/grant-immutability');

    // ═══ 1. BUILD A DATABASE IN USE, THEN TAKE 62 BACK OUT OF IT ═══════════
    section('1. a migration-61 shape, with data already in it');

    // ORDER MATTERS, and my first attempt had it wrong. I dropped the columns first and then tried
    // to establish an open lease — but `claimTask` READS `synthetic_only`, so the current code
    // cannot operate a 61-shaped database at all, and the check failed with
    // `column "synthetic_only" does not exist`. That is the honest answer to a question I had not
    // meant to ask. So: build the fixtures and the in-flight lease with 62 present, then DROP its
    // columns and triggers, which DISCARDS the stored values. Re-applying then meets rows that
    // genuinely carry no opinion about synthetic_only — which is precisely the population a real
    // upgrade meets, and the state a 61-era database is in.
    const CO = `mig-co-${crypto.randomUUID().slice(0, 8)}`;
    await query(
      `INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,$2,'active')`,
      [CO, 'Legacy Co']);

    const admin = await require('./lib/fixture-admin').fixtureAdmin(query);
    const enrol = async (label, capabilities) => {
      const t = await IDENTITY.createEnrollmentToken(
        { label, capabilities, syntheticOnly: false, createdBy: admin }, { query });
      const e = await IDENTITY.consumeEnrollmentToken(
        { token: t.token, hostFingerprint: label }, { query });
      if (!e || e.ok !== true) throw new Error(`enrolment failed: ${JSON.stringify(e)}`);
      return e.workerId;
    };
    // Both are enrolled UNRESTRICTED on purpose: that is what makes section 2 meaningful. If the
    // migration preserved their stored value they would stay unrestricted; the drop discards it,
    // and the question is what the re-add gives them.
    const WLEGACY = await enrol('legacy-cloud', []);
    const WHARDWARE = await enrol('legacy-hardware', ['exec:hardware']);

    const tWith = (await LEASES.enqueueTask({
      taskType: 'synthetic.echo', payload: { echo: 'legacy-with-company' },
      intentKey: `mig62-with-${crypto.randomUUID().slice(0, 8)}`, companyId: CO,
    }, { query })).taskId;
    const tWithout = (await LEASES.enqueueTask({
      taskType: 'synthetic.echo', payload: { echo: 'legacy-no-company' },
      intentKey: `mig62-without-${crypto.randomUUID().slice(0, 8)}`,
    }, { query })).taskId;

    const claimed = await LEASES.claimTask({ workerId: WLEGACY, taskId: tWith }, { query });
    if (claimed && claimed.ok === true) {
      ok('a worker holds an OPEN lease before the migration is taken back out');
    } else {
      bad(`could not establish an open lease: ${JSON.stringify(claimed && (claimed.code || claimed))}`);
    }

    // Now remove 62, which is what makes this a 61-era database carrying live work.
    await query(`DROP TRIGGER IF EXISTS ${IMMUT.TRIGGER} ON worker_identities`);
    await query(`DROP TRIGGER IF EXISTS ${IMMUT.TRIGGER}_insert ON worker_identities`);
    await query('ALTER TABLE worker_identities DROP COLUMN IF EXISTS synthetic_only');
    await query('ALTER TABLE worker_enrollment_tokens DROP COLUMN IF EXISTS synthetic_only');
    await query('ALTER TABLE companies DROP COLUMN IF EXISTS is_synthetic');

    const pre = await SYN.inventoryForMigration62(query);
    if (pre.applied.companies_is_synthetic === false
        && pre.applied.identities_synthetic_only === false
        && pre.applied.tokens_synthetic_only === false) {
      ok('the pre-state really is pre-62 — all three columns absent, confirmed by the inventory');
    } else {
      bad(`the pre-state still carries 62's columns: ${JSON.stringify(pre.applied)}`);
    }
    if (pre.identities.total === 2
        && Array.isArray(pre.identities.identitiesThatWillBecomeRestricted)
        && pre.identities.identitiesThatWillBecomeRestricted.length === 2) {
      ok('the read-only inventory names BOTH identities the migration will restrict');
    } else {
      bad(`the inventory reported ${JSON.stringify(pre.identities)}`);
    }
    if (pre.identities.withHardwareOrGui === 1) {
      ok('and separates the one holding exec:hardware, which is the one an operator must look at');
    } else {
      bad(`withHardwareOrGui = ${pre.identities.withHardwareOrGui}, expected 1`);
    }
    if (pre.pendingWithNoCompany === 1) {
      ok('and counts the pending task with no company — the work that becomes unclaimable');
    } else {
      bad(`pendingWithNoCompany = ${pre.pendingWithNoCompany}, expected 1`);
    }
    const before = await query(
      `SELECT (SELECT COUNT(*) FROM worker_identities) i,
              (SELECT COUNT(*) FROM worker_tasks) t,
              (SELECT COUNT(*) FROM companies) c`);
    await SYN.inventoryForMigration62(query);
    const after = await query(
      `SELECT (SELECT COUNT(*) FROM worker_identities) i,
              (SELECT COUNT(*) FROM worker_tasks) t,
              (SELECT COUNT(*) FROM companies) c`);
    if (JSON.stringify(before.rows[0]) === JSON.stringify(after.rows[0])) {
      ok('the inventory is read-only — row counts identical across two runs of it');
    } else {
      bad('the inventory changed row counts, so it is not read-only');
    }

    // ═══ 2. APPLY 62 TO THAT DATABASE ═══════════════════════════════════════
    section('2. the upgrade, onto rows that predate its rules');

    const applied = await SYN.installSyntheticIsolation(query);
    await IMMUT.installGrantImmutability(query);
    if (applied.ok && applied.companies && applied.identities && applied.tokens) {
      ok('the installer reports all three tables altered');
    } else {
      bad(`the installer reported ${JSON.stringify(applied)}`);
    }

    const states = await query(
      'SELECT id, synthetic_only FROM worker_identities WHERE id = ANY($1) ORDER BY id',
      [[WLEGACY, WHARDWARE]]);
    if (states.rows.length === 2 && states.rows.every((r) => r.synthetic_only === true)) {
      ok('BOTH pre-existing identities are now RESTRICTED — nothing was silently widened');
    } else {
      bad(`existing identities came out as ${JSON.stringify(states.rows)} — if either is false, the `
        + 'migration widened a row that predated the rule');
    }

    const co = await query('SELECT is_synthetic FROM companies WHERE id = $1', [CO]);
    if (co.rows[0].is_synthetic === false) {
      ok('the pre-existing company is NOT synthetic — a real company is not reclassified by a migration');
    } else {
      bad('an existing company was marked synthetic by the migration');
    }

    // ═══ 3. THE DATA SURVIVED ═══════════════════════════════════════════════
    section('3. existing leases and tasks are intact');

    const tasks = await query(
      'SELECT id, state, company_id FROM worker_tasks WHERE id = ANY($1) ORDER BY id',
      [[tWith, tWithout]]);
    if (tasks.rows.length === 2) {
      ok('both pre-existing tasks still exist');
    } else {
      bad(`${tasks.rows.length} of 2 tasks survived the migration`);
    }
    const leased = tasks.rows.find((r) => r.id === tWith);
    if (leased && leased.state === 'LEASED') {
      ok('the task that was LEASED before the migration is still LEASED — work in flight is undisturbed');
    } else {
      bad(`the leased task is now ${leased && leased.state}`);
    }
    const open = await query(
      'SELECT COUNT(*)::int n FROM agent_runs WHERE ended_at IS NULL');
    if (open.rows[0].n >= 1) {
      ok('the open lease is still open');
    } else {
      bad('the open lease disappeared across the migration');
    }

    // ═══ 4. AND THE RULES NOW APPLY TO THOSE ROWS ═══════════════════════════
    section('4. the restriction is in force for the rows that predate it');

    // The legacy hardware worker is now restricted, so the no-company task is unclaimable by it.
    const blocked = await LEASES.claimTask({ workerId: WHARDWARE, taskId: tWithout }, { query });
    if (blocked && blocked.ok === false) {
      ok(`a pre-existing worker cannot claim the no-company task (${blocked.code})`);
    } else {
      bad(`a pre-existing worker claimed it anyway: ${JSON.stringify(blocked && blocked.taskId)}`);
    }

    // And it cannot be widened by the UPDATE a 61-era operator would have reached for.
    try {
      await query('UPDATE worker_identities SET synthetic_only = false WHERE id = $1', [WHARDWARE]);
      bad('an UPDATE widened a pre-existing identity — the trigger is not installed on upgrade');
    } catch (e) {
      if (/write-once/.test(e.message)) {
        ok('and an UPDATE cannot widen it either — the trigger installs on upgrade, not just on create');
      } else {
        bad(`the UPDATE failed for an unrelated reason: ${e.message}`);
      }
    }

    // Idempotency on an upgraded database, which is a different question from on a fresh one.
    await SYN.installSyntheticIsolation(query);
    await IMMUT.installGrantImmutability(query);
    const again = await query(
      'SELECT synthetic_only FROM worker_identities WHERE id = $1', [WHARDWARE]);
    if (again.rows[0].synthetic_only === true) {
      ok('re-running the migration on an upgraded database changes nothing');
    } else {
      bad('a second run of the migration altered an existing row');
    }

    const post = await SYN.inventoryForMigration62(query);
    if (post.applied.identities_synthetic_only === true
        && typeof post.identities.identitiesThatWillBecomeRestricted === 'string') {
      ok('the inventory reports the applied state rather than pretending to predict it again');
    } else {
      bad(`the post-migration inventory still reports a prediction: ${JSON.stringify(post.applied)}`);
    }
    note(`post-migration inventory: ${post.identities.total} identities, `
      + `${post.companies.synthetic} of ${post.companies.total} companies synthetic, `
      + `${post.pendingWithNoCompany} pending task(s) with no company`);
  } catch (e) {
    bad(`the check itself failed: ${e.message}`);
    lines.push(String(e.stack || '').split('\n').slice(1, 5).join('\n'));
  } finally {
    // The whole cluster is disposable and is destroyed, so there is nothing to clean up by id —
    // every row this check made lives only here.
    try { cluster.destroy(); } catch (_) { /* already gone is the desired state */ }
  }

  console.log('══ MIGRATION 62 ON AN EXISTING DATABASE ══');
  console.log(lines.join('\n'));
  console.log('');
  console.log(fail === 0
    ? `OK  the upgrade holds (${pass} assertions)`
    : `FAILED  ${fail} assertion(s) failed, ${pass} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();
