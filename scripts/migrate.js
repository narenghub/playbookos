#!/usr/bin/env node
// ── THE MIGRATION PROCESS (ENG-003) ──────────────────────────────────────────
//
//   node scripts/migrate.js             # apply everything, then seed
//   node scripts/migrate.js --no-seeds  # schema only
//   node scripts/migrate.js --check     # report readiness, change nothing
//   node scripts/migrate.js --plan      # list the steps, connect to nothing
//
// Ruling 27 item 5: "Move boot-time DDL into a separate migration process." This is that process.
//
// ── WHICH CONNECTION IT USES ─────────────────────────────────────────────────
//
// MIGRATION_DATABASE_URL if set, otherwise DATABASE_URL. The point of the split is that the
// migrator connects as a role holding DDL while the APPLICATION connects as a restricted role that
// does not — two different URLs, two different roles, one database. Running this with only
// DATABASE_URL set works and is how a single-role deployment behaves today; it just does not
// deliver the separation, so the script says which one it used.
//
// Exit status is the verdict: 0 applied (or already applied), 1 a required step failed, 2 bad usage.
// The step list is diagnostics.

'use strict';

require('dotenv').config();

const { Pool } = require('pg');
const { runAll, SCHEMA_STEPS, SEED_STEPS } = require('../src/lib/migrate-all');
const schemaReady = require('../src/lib/schema-ready');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const log = (s) => process.stdout.write(`${s}\n`);
const bar = () => '─'.repeat(78);

if (has('--help') || has('-h')) {
  log('\nnode scripts/migrate.js [--no-seeds] [--check] [--plan]\n');
  log('  (default)    apply all schema steps, then the seeds');
  log('  --no-seeds   schema only');
  log('  --check      report whether the schema is ready; change nothing');
  log('  --plan       list the steps without connecting\n');
  process.exit(0);
}

if (has('--plan')) {
  log(`\n${bar()}\nMIGRATION PLAN — ${SCHEMA_STEPS.length} schema step(s) + ${SEED_STEPS.length} seed(s)\n${bar()}`);
  SCHEMA_STEPS.forEach((s, i) => log(`  ${String(i + 1).padStart(2)}. ${s.name}${s.required ? '' : '   (not required)'}`));
  log('      + the company row PRPA is welded to');
  SEED_STEPS.forEach((s, i) => log(`  s${i + 1}. ${s.name}   (not required)`));
  log('\nOrder is load-bearing: later steps ALTER tables earlier ones create.\n');
  process.exit(0);
}

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('migrate: neither MIGRATION_DATABASE_URL nor DATABASE_URL is set\n');
  process.exit(2);
}
const usingMigrationUrl = Boolean(process.env.MIGRATION_DATABASE_URL);

// The pool used for --check and for the role report. The migration steps themselves go through
// src/lib/db's own pool, because that is what initDB and the dozen other functions already use —
// changing every one of them to take a connection would be a far larger diff than this change is
// worth, and src/lib/db reads DATABASE_URL. So: when MIGRATION_DATABASE_URL is set, it is applied
// to process.env.DATABASE_URL for this process only, BEFORE src/lib/db is first required.
if (usingMigrationUrl) process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;

const pool = new Pool({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1|host=/.test(url) ? false : { rejectUnauthorized: false },
});

async function main() {
  const q = (sql, params) => pool.query(sql, params);

  log(`\n${bar()}`);
  log('PLAYBOOKOS MIGRATIONS');
  log(bar());

  // Which role is this, and can it actually do DDL? Reported rather than assumed: the most likely
  // failure of this script in production is being pointed at the application's restricted role.
  let who;
  try {
    who = (await q(
      `SELECT current_user AS role, current_database() AS db,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
              has_database_privilege(current_user, current_database(), 'CREATE') AS can_create`)).rows[0];
  } catch (e) {
    process.stderr.write(`migrate: cannot connect: ${e.message}\n`);
    process.exit(1);
  }
  log(`  connection: ${usingMigrationUrl ? 'MIGRATION_DATABASE_URL' : 'DATABASE_URL'}`);
  log(`  role: ${who.role}  ·  database: ${who.db}  ·  superuser: ${who.is_superuser ? 'YES' : 'no'}  ·  CREATE: ${who.can_create ? 'yes' : 'NO'}`);
  if (!usingMigrationUrl) {
    log('  note: MIGRATION_DATABASE_URL is not set, so the migrator and the application share a role.');
    log('        That works, but it is not the privilege separation ENG-003 asks for.');
  }
  if (!who.can_create) {
    process.stderr.write('\nmigrate: this role cannot CREATE in this database — it is not a migrator role.\n');
    process.stderr.write('         Point MIGRATION_DATABASE_URL at the role that owns the schema.\n\n');
    await pool.end();
    process.exit(1);
  }

  if (has('--check')) {
    const r = await schemaReady.check(q);
    log(`\n  schema ready: ${r.ready ? 'YES' : 'NO'}`);
    for (const t of r.missingTables) log(`    missing table:  ${t}`);
    for (const c of r.missingColumns) log(`    missing column: ${c}`);
    if (r.error) log(`    check error: ${r.error}`);
    log('');
    await pool.end();
    process.exit(r.ready ? 0 : 1);
  }

  log(`\n  applying ${SCHEMA_STEPS.length} schema step(s)${has('--no-seeds') ? '' : ` + ${SEED_STEPS.length} seed(s)`}\n`);
  const out = await runAll(q, { seeds: !has('--no-seeds'), log });

  // Readiness is checked AFTER applying, through the same code boot will run. A migration that
  // reports success while boot would refuse to start is the failure mode worth catching here.
  const ready = await schemaReady.check(q);

  log(`\n${bar()}`);
  if (!out.ok) {
    log(`FAIL  ${out.failed.length} required step(s) failed:`);
    for (const f of out.failed) log(`        ${f.name}: ${f.error}`);
    log('');
    await pool.end();
    process.exit(1);
  }
  if (!ready.ready) {
    log('FAIL  every step reported success, but the readiness check the SERVER runs still fails:');
    for (const t of ready.missingTables) log(`        missing table:  ${t}`);
    for (const c of ready.missingColumns) log(`        missing column: ${c}`);
    log('      That means a step is not creating what this check expects. Reconcile them before');
    log('      deploying — the server will refuse to start in this state.');
    log('');
    await pool.end();
    process.exit(1);
  }
  log(`PASS  schema applied and the server's own readiness check passes.`);
  log('      The application may now start as a role with NO DDL and NO superuser.');
  log('');
  await pool.end();
  process.exit(0);
}

main().catch(async (e) => {
  process.stderr.write(`\nmigrate: ${e.stack || e.message}\n\n`);
  try { await pool.end(); } catch { /* already closing */ }
  process.exit(1);
});
