// ── DOES THE MIGRATION CONNECT AS THE MIGRATOR, OR AS WHATEVER DATABASE_URL HAPPENS TO SAY? ───────
//
//   node scripts/check-migrate-connection-ordering.js ; echo $?
//
// Ruling 58. On 2026-11-08 the production migration halted at step 2 with
// `getaddrinfo ENOTFOUND postgres.railway.internal`. scripts/migrate.js required
// ../src/lib/migrate-all at line 27, which requires ./db at line 30, which builds its Pool from
// process.env.DATABASE_URL AT REQUIRE TIME. The MIGRATION_DATABASE_URL override sat 38 lines
// further down, under a comment asserting it ran first. 44 of the 53 steps use that pool, so all
// of them connected to the wrong place — or in the post-cutover case, as the wrong role.
//
// WHY EVERY EXISTING TEST PASSED. verify-migration-readiness.js sets DATABASE_URL and the migration
// URL to the SAME local socket. An override that arrives late is then indistinguishable from one
// that arrives on time, because both names point at the same database. The bug lives entirely in
// the gap between those two values, and that gap only exists in production.
//
// So this file manufactures the gap. Two shapes, both real:
//
//   1. DATABASE_URL points at a host that does not resolve, MIGRATION_DATABASE_URL at the real
//      database. That is an operator running the migration from their machine, where Railway's
//      private hostname is meaningless.
//   2. DATABASE_URL points at a role with NO DDL rights, MIGRATION_DATABASE_URL at the migrator.
//      That is every deploy after the runtime credential cutover — the case that had not happened
//      yet, and which would have failed with "permission denied" on a deploy where nothing about
//      the migration had changed.
//
// In both, the migration must succeed, and it must do so as the MIGRATION identity. A test that
// only asserted "it ran" would pass if the migration quietly used the restricted role and the role
// happened to be a superuser in the fixture — so the identity is asserted too, from inside the
// database.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { pgBinCandidates, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const PGPORT = process.env.MIGORDER_PGPORT || '55493';

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

let temp = null;
function stop() {
  if (!temp) return;
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { stdio: 'pipe' });
  } catch { /* going away */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch { /* temp */ }
}

// A hostname that cannot resolve, standing in for postgres.railway.internal seen from a laptop.
const UNREACHABLE = 'postgresql://postgres:x@this-host-does-not-resolve.invalid:5432/railway';

function runMigrate(env) {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, 'migrate.js'), '--no-seeds'],
      { env: { ...process.env, ...env }, encoding: 'utf8', stdio: 'pipe',
        maxBuffer: 32 * 1024 * 1024, timeout: 300000 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

async function main() {
  h('MIGRATION CONNECTION ORDERING — the gap between DATABASE_URL and MIGRATION_DATABASE_URL');

  const dir = pgBinCandidates()[0];
  if (!dir) {
    console.log('\nSKIP  no PostgreSQL server toolchain. This proved NOTHING.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }
  const base = fs.mkdtempSync('/var/tmp/migorder-');
  const asPostgres = process.getuid && process.getuid() === 0;
  temp = { base, dir, asPostgres };
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, encoding: 'utf8', stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p ${PGPORT} -c listen_addresses=' start -w`);
  } catch (e) {
    bad('could not start a cluster', String(e.message).split('\n').slice(-2).join(' '));
    stop(); process.exit(1);
  }

  const urlFor = (db, user = 'postgres') =>
    `postgresql://${user}@localhost/${db}?host=${base}&port=${PGPORT}&sslmode=disable`;
  const admin = new Client({ connectionString: urlFor('postgres') });
  await admin.connect();

  // ── 1. UNREACHABLE DATABASE_URL, REACHABLE MIGRATION_DATABASE_URL ───────────────────────────────
  h('1. DATABASE_URL does not resolve — the 2026-11-08 production failure');
  await admin.query('DROP DATABASE IF EXISTS mig_a');
  await admin.query('CREATE DATABASE mig_a');

  const r1 = runMigrate({
    DATABASE_URL: UNREACHABLE,
    MIGRATION_DATABASE_URL: urlFor('mig_a'),
    ADMIN_EMAIL: 'fixture-admin@example.invalid',
    ADMIN_PASSWORD: 'fixture-only-not-a-real-password-12345',
  });
  if (r1.code === 0) ok('the migration succeeds with an UNRESOLVABLE DATABASE_URL — the override lands before the pool is built');
  else {
    bad(`the migration failed (exit ${r1.code})`,
      /ENOTFOUND|EAI_AGAIN/.test(r1.out)
        ? 'it tried to resolve DATABASE_URL — the override is arriving after src/lib/db is required'
        : r1.out.trim().split('\n').slice(-4).join(' | '));
  }
  const c1 = new Client({ connectionString: urlFor('mig_a') });
  await c1.connect();
  const t1 = (await c1.query(`SELECT COUNT(*)::int n FROM pg_tables WHERE schemaname='public'`)).rows[0].n;
  if (t1 > 100) ok(`…and it really built the schema there — ${t1} tables in the database MIGRATION_DATABASE_URL named`);
  else bad(`only ${t1} table(s) were created`, 'the migration reported success without building the schema');
  await c1.end();

  // ── 2. DATABASE_URL IS THE RESTRICTED RUNTIME ROLE ──────────────────────────────────────────────
  //
  // Reachable, so nothing fails on DNS. It simply cannot perform DDL — which is the whole point of
  // the runtime role, and which is what every deploy after the cutover will hand to migrate.js.
  h('2. DATABASE_URL is the runtime role with no DDL — every deploy after the cutover');
  await admin.query('DROP DATABASE IF EXISTS mig_b');
  await admin.query('CREATE DATABASE mig_b');
  const b = new Client({ connectionString: urlFor('mig_b') });
  await b.connect();
  await b.query(`
    CREATE ROLE runtime_norole LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    REVOKE ALL ON SCHEMA public FROM runtime_norole;
    GRANT USAGE ON SCHEMA public TO runtime_norole;`);
  const denied = await (async () => {
    const rc = new Client({ connectionString: urlFor('mig_b', 'runtime_norole') });
    await rc.connect();
    let msg = null;
    try { await rc.query('CREATE TABLE ordering_probe (x int)'); } catch (e) { msg = e.message; }
    await rc.end();
    return msg;
  })();
  if (denied && /permission denied/i.test(denied)) ok('the stand-in runtime role genuinely cannot create tables');
  else bad('the fixture runtime role can create tables', denied || 'CREATE TABLE succeeded — the fixture proves nothing');

  const r2 = runMigrate({
    DATABASE_URL: urlFor('mig_b', 'runtime_norole'),
    MIGRATION_DATABASE_URL: urlFor('mig_b'),
    ADMIN_EMAIL: 'fixture-admin@example.invalid',
    ADMIN_PASSWORD: 'fixture-only-not-a-real-password-12345',
  });
  if (r2.code === 0) ok('the migration succeeds while DATABASE_URL names a role that cannot do DDL');
  else {
    bad(`the migration failed (exit ${r2.code})`,
      /permission denied/i.test(r2.out)
        ? 'it connected as the RUNTIME role — the override is arriving after src/lib/db is required'
        : r2.out.trim().split('\n').slice(-4).join(' | '));
  }

  // And it must have done the work as the MIGRATOR, not merely have done it. Tables created by
  // runtime_norole would be owned by runtime_norole; these must be owned by the migration identity.
  const owners = (await b.query(
    `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname='public' ORDER BY 1`)).rows
    .map((r) => r.tableowner);
  if (owners.length && !owners.includes('runtime_norole')) {
    ok(`every table is owned by the migration identity (${owners.join(', ')}) — not by the runtime role`);
  } else bad(`tables owned by ${owners.join(', ') || '(none)'}`, 'the migration used the wrong identity');
  await b.end();

  // ── 3. FAIL CLOSED ──────────────────────────────────────────────────────────────────────────────
  h('3. FAIL CLOSED when the migration credentials are missing or wrong');
  const r3 = runMigrate({ DATABASE_URL: '', MIGRATION_DATABASE_URL: '' });
  if (r3.code !== 0 && /neither MIGRATION_DATABASE_URL nor DATABASE_URL/i.test(r3.out)) {
    ok('with neither variable set it refuses, naming both');
  } else bad(`no connection variable did not fail closed (exit ${r3.code})`, r3.out.slice(0, 160));

  await admin.query('DROP DATABASE IF EXISTS mig_c');
  await admin.query('CREATE DATABASE mig_c');
  const r4 = runMigrate({
    DATABASE_URL: urlFor('mig_c'),
    MIGRATION_DATABASE_URL: 'postgresql://nosuchrole:wrong@localhost/mig_c'
      + `?host=${base}&port=${PGPORT}&sslmode=disable`,
  });
  if (r4.code !== 0) ok(`invalid MIGRATION_DATABASE_URL credentials fail closed (exit ${r4.code})`);
  else bad('an invalid MIGRATION_DATABASE_URL was accepted', 'it must not silently fall back to DATABASE_URL');
  const c4 = new Client({ connectionString: urlFor('mig_c') });
  await c4.connect();
  const t4 = (await c4.query(`SELECT COUNT(*)::int n FROM pg_tables WHERE schemaname='public'`)).rows[0].n;
  if (t4 === 0) ok('…and it built nothing through the fallback — a bad migrator credential is not a licence to use the other one');
  else bad(`${t4} table(s) were created despite invalid migration credentials`, 'it fell back to DATABASE_URL');
  await c4.end();

  // ── 4. THE ORDERING ITSELF, STATICALLY ──────────────────────────────────────────────────────────
  //
  // The behavioural checks above are the real ones. This one exists so that a reviewer moving the
  // assignment back down — which is exactly what happened — fails immediately and by name, rather
  // than discovering it from a halted production migration.
  h('4. THE ASSIGNMENT IS ABOVE THE REQUIRE, IN THE FILE');
  const src = fs.readFileSync(path.join(__dirname, 'migrate.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const iAssign = code.indexOf('process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL');
  const iRequire = code.indexOf("require('../src/lib/migrate-all')");
  if (iAssign === -1) bad('the DATABASE_URL override is gone from migrate.js');
  else if (iRequire === -1) bad('migrate.js no longer requires migrate-all — this check needs updating');
  else if (iAssign < iRequire) ok('the override is assigned before migrate-all is required');
  else {
    bad('the override is assigned AFTER migrate-all is required',
      'src/lib/db builds its pool at require time; the override would have no effect on the 44 '
      + 'steps that use it — this is the 2026-11-08 production failure, reintroduced');
  }

  await admin.end();
  h(`  ${pass} assertion(s) passed · ${fail} failed`);
  stop();
  if (fail) {
    console.log('\nFAIL  the migration does not reliably connect as the migration identity.\n');
    process.exit(1);
  }
  console.log('\nPASS  the migration runs as the migration identity even when DATABASE_URL is\n'
    + '      unreachable or powerless, fails closed without valid migration credentials, and\n'
    + '      never falls back to the runtime connection.\n');
}

main().catch((e) => {
  console.error(`\ncheck-migrate-connection-ordering: ${e.message}\n${e.stack || ''}`);
  stop();
  process.exit(1);
});
process.on('exit', stop);
