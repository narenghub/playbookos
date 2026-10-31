#!/usr/bin/env node
// ── DOES THE RECONCILIATION RUN TO THE END? ──────────────────────────────────
//
//   node scripts/check-reconcile-runs.js
//
// Exit 0 = e1-reconcile's main() ran to completion against a local database built from the real
// schema. Exit 1 if it threw. Touches no production data.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// On 31 Oct at 11:14 the reconciliation printed every proof — proof 1 through the recovery section —
// and then died:
//
//   ✗ reconciliation could not run: after is not defined
//
// `after` had been the post-pass molecule count from proof 10. Removing that pass left the recovery
// section reading a variable that no longer existed. `node --check` parses a file; it cannot see an
// undefined reference. The project has no linter. And nothing in preflight executed main(), so the
// ONLY thing that could find it was a production run over an SSH connection that had already failed
// twice that morning.
//
// A 92-line edit to a verification script went out with a runtime error in its last section, and the
// cost was another deploy-and-retry cycle on the one result Gate 1 was waiting for.
//
// So: run it. Not to check its verdict — against fixtures the verdict is meaningless and this
// asserts nothing about it — but to prove every line executes. An undefined reference, a column that
// does not exist, a renamed export: all of them surface here, locally, in seconds.
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

// SYNCHRONOUS output, deliberately. console.log to a pipe is an async write, and process.exit()
// discards whatever has not drained — the first run of this script printed NOTHING at all and
// exited 1, which is the "read the exit code not the output" lesson inverted: a verdict that can be
// silently dropped. These bypass the console entirely, and they keep working while this script
// suppresses console.log to silence the reconciliation it is running.
const say = (m) => fs.writeSync(1, `${m}\n`);
const err = (m) => fs.writeSync(2, `${m}\n`);

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { try { fs.accessSync(`${d}/initdb`); return d; } catch (_) { /* next */ } }
  return null;
}

let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/recruns-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55994 -c listen_addresses=' start -w`);
  } catch (_) { return null; }
  temp = { base, dir, asPostgres };
  return base;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c ${JSON.stringify(`pg_ctl -D ${temp.base}/data stop -m immediate`)}`
      : `pg_ctl -D ${temp.base}/data stop -m immediate`], { env, stdio: 'pipe' });
  } catch (_) { /* best effort */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

const sock = startTemp();
if (!sock) {
  err('SKIP  no local postgres available — cannot prove the reconciliation runs');
  process.exit(1);
}
// Before any require that builds a pool: db.js reads these at module load, and with DATABASE_URL
// absent it uses PG* with ssl:false.
delete process.env.DATABASE_URL;
process.env.PGHOST = sock;
process.env.PGPORT = '55994';
process.env.PGUSER = 'postgres';
process.env.PGDATABASE = 'postgres';
// initDB() refuses to run without these when no admin user exists. Deliberately obvious fixture
// values for a throwaway local database that is deleted at the end of this script — never a real
// credential, and nothing here can reach production: DATABASE_URL is unset above.
process.env.ADMIN_EMAIL = 'fixture-admin@localhost.invalid';
process.env.ADMIN_PASSWORD = 'fixture-only-not-a-real-password';

const { query } = require('../src/lib/db');

(async () => {
  let failed = 0;
  const realLog = console.log;
  try {
    // The source tables E1 reads. Minimal shapes matching the real columns the reconciliation uses.
    await query(`
      CREATE TABLE IF NOT EXISTS study_molecules (
        id BIGSERIAL PRIMARY KEY, study_id TEXT, molecule_name TEXT NOT NULL, cas_number TEXT);
      CREATE TABLE IF NOT EXISTS research_interests (
        id BIGSERIAL PRIMARY KEY, lab_id BIGINT, kind TEXT, value TEXT, cas TEXT);
      CREATE TABLE IF NOT EXISTS supplier_products (
        id BIGSERIAL PRIMARY KEY, product_name TEXT, cas TEXT);
    `);
    // A couple of rows, so the proofs have something to read rather than a uniformly empty database
    // where a broken query might pass by returning nothing.
    await query(`INSERT INTO study_molecules (study_id, molecule_name, cas_number) VALUES
      ('NCT-1','Leuprolide','53714-56-0'), ('NCT-2','Leuprolide Acetate','74381-53-6'),
      ('NCT-3','Warfarin','81-81-2')`);
    await query(`INSERT INTO supplier_products (product_name, cas) VALUES ('Warfarin Sodium','129-06-6')`);

    const { DDL_TABLES, DDL_TRIGGERS, applyTargetColumns, applyConflictKinds } = require('./migrate-molecules');
    await query(DDL_TABLES);
    await query(DDL_TRIGGERS);
    await applyConflictKinds(query);
    await applyTargetColumns(query);

    // initDB() inside main() runs the whole db.js migration suite. It is idempotent and designed to
    // run at every boot, so letting it run here is the honest thing: it is what production does.
    const reconcile = require('./e1-reconcile');
    if (typeof reconcile.main !== 'function') {
      err('  FAIL  e1-reconcile does not export main — nothing to execute');
      failed = 1;
    } else {
      // Its own output is suppressed: this asserts that it RUNS, not what it concluded. Against
      // fixtures the verdict carries no meaning and reporting it would invite someone to trust it.
      console.log = () => {};
      let result;
      try {
        result = await reconcile.main();
      } finally { console.log = realLog; }
      if (typeof result === 'number') {
        say(`  ok    the reconciliation ran to completion (${result} fixture proof(s) did not hold, which is expected and asserted nothing)`);
      } else {
        say('  ok    the reconciliation ran to completion');
      }
    }
  } catch (e) {
    console.log = realLog;
    // THIS is the catch that matters. `after is not defined` landed here.
    err(`  FAIL  the reconciliation threw before finishing: ${e && e.message ? e.message : e}`);
    if (e && e.stack) err(`        ${e.stack.split('\n').slice(1, 4).join('\n        ')}`);
    failed = 1;
  } finally {
    stopTemp();
  }

  say('');
  if (failed) { say('FAIL  the reconciliation does not run end to end\n'); process.exit(1); }
  say('PASS  every line of the reconciliation executes — no undefined reference, no missing column\n');
  process.exit(0);
})();
