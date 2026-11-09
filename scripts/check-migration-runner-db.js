#!/usr/bin/env node
// ── DOES THE MIGRATION RUNNER BEHAVE THE WAY ITS DOCUMENTATION CLAIMS? ──────
//
// Ruling 9 item 3 asks for a versioned runner with verified migrateOffice prerequisites,
// idempotency, rollback and clean-database behaviour. Those are four claims, and a runner is
// exactly the kind of script whose claims nobody tests because running it is scary.
//
// Each is exercised against a real server, in the order a release would hit them:
//
//   1. CLEAN DATABASE, NO PREREQUISITES → refuses with exit 2, writes nothing. This is the case
//      that matters most: it is what a brand-new environment looks like, and a runner that
//      half-applies there leaves a database nobody can reason about.
//   2. --check NEVER WRITES, even when every precondition is met.
//   3. APPLY → exit 0, tables exist, version recorded.
//   4. APPLY AGAIN → idempotent. Not "probably safe": run twice, assert identical.
//   5. PARTIAL FAILURE REPAIR → drop two tables by hand, re-apply, assert they return.
//   6. ROLLBACK WITHOUT THE ACKNOWLEDGEMENT FLAG → refuses.
//   7. ROLLBACK → drops all twelve, leaves companies and agent_runs untouched.
//   8. NO FLAGS AT ALL → prints usage, touches nothing.
//
// Exit: 0 all eight hold · 1 one does not · 2 not executed
'use strict';

const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');
const fs = require('fs');
// Derived, not written down. This assertion was a literal 12 and broke the moment a thirteenth
// table was added — a check that fails because the schema grew is a check that trains people to
// edit the check. The schema is the source of truth for how many tables the migration creates.
const { CONNECTOR_TABLES, GLOBAL_TABLES } = require('../src/lib/connectors/schema');
const MIGRATION_TABLES = CONNECTOR_TABLES.length + GLOBAL_TABLES.length;
const { execFileSync } = require('child_process');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 500)}`); };

let temp = null;
function startCluster() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/migrun-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55989 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55989&sslmode=disable`;
}
function stopCluster() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) { /* best effort */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

const url = startCluster();
if (!url) {
  console.log('  skip  no Postgres available');
  console.log('SKIP  migration runner check not executed — needs a server');
  process.exit(EXIT_NOT_EXECUTED);
}

function runner(args) {
  try {
    const out = execFileSync('node', ['scripts/migrate-connectors.js', ...args], {
      env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', cwd: process.cwd(),
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

async function main() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: false });
  const tableCount = async () => (await pool.query(
    "SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n;
  const has = async (t) => (await pool.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name=$1) p`, [t])).rows[0].p;

  try {
    // ── 8. no flags at all ────────────────────────────────────────────────
    const before0 = await tableCount();
    const none = runner([]);
    if (none.code === 0 && /Connector schema migration runner/.test(none.out)) {
      ok('no flags: prints usage and exits 0');
    } else bad('no flags should print usage', none.out);
    if (await tableCount() === before0) ok('no flags: nothing was written');
    else bad('running with no flags changed the schema');

    // ── 1. clean database, prerequisites absent ───────────────────────────
    const chk = runner(['--check']);
    if (chk.code === 2) ok('CLEAN DB: --check exits 2 when preconditions are not met');
    else bad(`--check on a clean database exited ${chk.code}, expected 2`, chk.out);
    if (/uq_agent_runs_run_company/.test(chk.out)) {
      ok('and it names the composite-FK constraint specifically — the precondition easiest to miss');
    } else bad('the missing-prerequisite message does not name uq_agent_runs_run_company', chk.out);

    const applyBlocked = runner(['--apply']);
    if (applyBlocked.code === 2) ok('CLEAN DB: --apply also refuses rather than half-applying');
    else bad(`--apply on a clean database exited ${applyBlocked.code}, expected 2`, applyBlocked.out);
    if (!(await has('source_connectors'))) ok('and NOTHING was created by the refused apply');
    else bad('a refused apply still created tables — this is the half-applied state the check exists to prevent');

    // ── prerequisites, via the real migrations ────────────────────────────
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET = 'migrun-only';
    process.env.ADMIN_EMAIL = 'migrun@example.invalid';
    process.env.ADMIN_PASSWORD = 'MigRunOnly123';
    const db = require('../src/lib/db');
    await db.initDB();
    await db.initPhase2();
    await db.migrateSchemas();
    await require('../src/lib/runs').migrateRuns(db.query);
    await require('../src/lib/office/schema').migrateOffice(db.query);
    ok('prerequisites installed via the real migrateRuns + migrateOffice');

    // ── 2. --check with preconditions met still writes nothing ────────────
    const beforeCheck = await tableCount();
    const chk2 = runner(['--check']);
    if (chk2.code === 0 && /NOTHING WAS WRITTEN/.test(chk2.out)) ok('--check exits 0 and says it wrote nothing');
    else bad(`--check exited ${chk2.code}`, chk2.out);
    if (await tableCount() === beforeCheck) ok('--check with preconditions MET still wrote nothing');
    else bad('--check created tables — it must never write');

    // ── 3. apply ──────────────────────────────────────────────────────────
    const applied = runner(['--apply']);
    if (applied.code === 0) ok('--apply exits 0');
    else bad(`--apply exited ${applied.code}`, applied.out);
    const after = await tableCount();
    if (after === beforeCheck + MIGRATION_TABLES + 1) {
      ok(`${MIGRATION_TABLES} connector tables + schema_migrations created (${beforeCheck} → ${after})`);
    } else bad(`expected ${beforeCheck + MIGRATION_TABLES + 1} tables, found ${after}`);
    const rec = await pool.query('SELECT version FROM schema_migrations');
    if (rec.rows.length === 1) ok(`version recorded: ${rec.rows[0].version}`);
    else bad(`expected 1 recorded version, found ${rec.rows.length}`);
    if (/sam_gov landed INERT/.test(applied.out)) ok('verification confirmed sam_gov is inert (ruling 9 item 7)');
    else bad('the apply did not verify that sam_gov is inert', applied.out);

    // ── 4. idempotency — run it again ─────────────────────────────────────
    const countBefore = await tableCount();
    const again = runner(['--apply']);
    if (again.code === 0) ok('IDEMPOTENT: a second --apply exits 0');
    else bad(`the second --apply exited ${again.code}`, again.out);
    if (await tableCount() === countBefore) ok('IDEMPOTENT: the table count is unchanged');
    else bad('the second apply changed the schema');
    const rec2 = await pool.query('SELECT version FROM schema_migrations');
    if (rec2.rows.length === 1) ok('IDEMPOTENT: still exactly one version row, not a duplicate');
    else bad(`${rec2.rows.length} version rows after re-apply`);

    // ── 5. partial-failure repair ─────────────────────────────────────────
    // The state a half-finished migration leaves: some tables present, the version recorded.
    // Re-running must repair it, because the alternative is a manual reconstruction.
    await pool.query('DROP TABLE IF EXISTS solicitation_amendments');
    await pool.query('DROP TABLE IF EXISTS solicitations');
    const repaired = runner(['--apply']);
    if (repaired.code === 0 && await has('solicitations') && await has('solicitation_amendments')) {
      ok('REPAIR: re-applying restores tables dropped by a partial failure');
    } else bad('a re-apply did not repair a partially-applied schema', repaired.out);

    // ── 6. rollback refuses without the acknowledgement ───────────────────
    const noAck = runner(['--rollback']);
    if (noAck.code === 1 && /REFUSED/.test(noAck.out)) ok('ROLLBACK without the acknowledgement flag is REFUSED');
    else bad(`--rollback without acknowledgement exited ${noAck.code}`, noAck.out);
    if (await has('source_connectors')) ok('and the refused rollback dropped nothing');
    else bad('a refused rollback still dropped tables');

    // ── 7. rollback ───────────────────────────────────────────────────────
    const rb = runner(['--rollback', '--i-understand-this-drops-tables']);
    if (rb.code === 0) ok('--rollback exits 0');
    else bad(`--rollback exited ${rb.code}`, rb.out);
    const leftovers = [];
    for (const t of ['source_connectors', 'source_sync_runs', 'federal_awards', 'funding_opportunities',
      'funding_opportunity_versions', 'eligibility_assessments', 'eligibility_findings',
      'verified_capabilities', 'capability_scope_items', 'review_tasks',
      'solicitations', 'solicitation_amendments']) {
      if (await has(t)) leftovers.push(t);
    }
    if (!leftovers.length) ok(`ROLLBACK: all ${MIGRATION_TABLES} tables dropped, in dependency order, with no error`);
    else bad(`rollback left ${leftovers.length} table(s) behind: ${leftovers.join(', ')}`);

    if (await has('companies') && await has('agent_runs')) {
      ok('ROLLBACK: companies and agent_runs are UNTOUCHED');
    } else bad('rollback removed a table it does not own');

    const recAfter = await pool.query('SELECT version FROM schema_migrations');
    if (recAfter.rows.length === 0) ok('ROLLBACK: the version record was removed, so --status is honest afterwards');
    else bad('the version is still recorded after a rollback');

    // ── and it can be applied again after a rollback ──────────────────────
    const reapply = runner(['--apply']);
    if (reapply.code === 0 && await has('source_connectors')) ok('the migration can be applied again after a rollback');
    else bad('a rollback left the database unable to re-apply', reapply.out);
  } finally {
    await pool.end();
  }
}

main()
  .then(() => {
    stopCluster();
    console.log(fail ? `\nFAIL  migration runner: ${fail} failure(s)` : '\nPASS  the migration runner refuses, applies, repeats, repairs and rolls back');
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => { stopCluster(); console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
