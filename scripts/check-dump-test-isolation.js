// ── CAN THE PRODUCTION-DUMP TEST REACH A DATABASE IT WAS NOT POINTED AT? ───────────────────────────
//
//   node scripts/check-dump-test-isolation.js ; echo $?
//
// Ruling 33 item 2: *"Verify that the production-dump test script uses only an isolated local database
// and cannot inherit production database credentials."*
//
// WHY THIS CANNOT BE ANSWERED BY READING THE SCRIPT. `scripts/verify-prod-dump.sh` contains no
// connection string, and `verify-migration-readiness.js` overwrites `process.env.DATABASE_URL` with
// its own disposable cluster before doing anything. Both true, and neither is the answer, because the
// protection is an ORDERING:
//
//   line 153   process.env.DATABASE_URL = urlFor('existing')      <- the local cluster
//   line 243   require('../src/lib/migrate-all')                  <- which requires src/lib/db
//
// `src/lib/db` builds its Pool from DATABASE_URL at require time, once. The overwrite protects
// everything only because it happens FIRST. Move either line, or add a top-level
// `require('../src/lib/db')` to that file, and 30 migrator steps marked `usesOwnPool: true` would run
// against whatever DATABASE_URL the operator happened to have exported — which, on the CEO's machine,
// is production. Nothing in the file says so, and nothing enforced it.
//
// An ordering that is load-bearing and invisible is one commit from being wrong. So this proves the
// property instead of the mechanism.
//
// HOW. A decoy database is created and filled with sentinel rows, and the environment is poisoned to
// point at it in every way a migration could inherit — DATABASE_URL, PGHOST, PGPORT, PGDATABASE,
// PGUSER, and MIGRATION_DATABASE_URL. The readiness harness is then run against a real dump. If it
// honours its own isolation, the decoy is untouched afterwards: same tables, same rows, no
// schema_migrations ledger, no 152-table migration landed in it.
//
// THE DECOY IS NOT PRODUCTION-SHAPED ON PURPOSE. It holds a sentinel table and nothing else, so any
// write at all is unmistakable. "It will be refused anyway" is the prediction CLAUDE.md names as not
// a safeguard; the decoy makes the prediction testable, and it is a fixture, so the one run where the
// isolation does not hold damages nothing.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { pgBinCandidates, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const PGPORT = process.env.ISOLATION_PGPORT || '55468';

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

let temp = null;
const sh = (cmd) => {
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  return execFileSync('sh', ['-c', temp.asPostgres ? `su postgres -c ${JSON.stringify(`PATH=${temp.dir}:$PATH ${cmd}`)}` : cmd],
    { env, encoding: 'utf8', stdio: 'pipe' });
};

function startCluster() {
  const dir = pgBinCandidates()[0];
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/dumpiso-');
  const asPostgres = process.getuid && process.getuid() === 0;
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, encoding: 'utf8', stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p ${PGPORT} -c listen_addresses=' start -w`);
  } catch (e) {
    console.error(`  (cluster start failed: ${e.message})`);
    return null;
  }
  temp = { base, dir, asPostgres };
  return base;
}

function stopCluster() {
  if (!temp) return;
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`],
    { env: { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` }, stdio: 'pipe' });
  } catch { /* going away anyway */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch { /* temp dir */ }
}

async function main() {
  h('DUMP-TEST ISOLATION — CAN IT WRITE TO AN INHERITED DATABASE_URL?');

  const base = startCluster();
  if (!base) {
    console.log('\nSKIP  no PostgreSQL server toolchain (initdb/pg_ctl). This proved NOTHING.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }

  // ── 0. the static half: the wrapper names no database ──────────────────────────────────────────
  h('1. THE WRAPPER ITSELF');
  {
    const src = fs.readFileSync(path.join(__dirname, 'verify-prod-dump.sh'), 'utf8');
    // A connection string anywhere in it. The DATABASE_PUBLIC_URL in the usage text is the NAME of a
    // Railway variable inside single quotes, interpolated by `railway run` on the operator's machine,
    // never by this script — so a bare mention is fine and a postgres:// literal is not.
    const literal = src.match(/postgres(?:ql)?:\/\/[^\s'"]+/g) || [];
    if (!literal.length) ok('verify-prod-dump.sh contains no connection string literal');
    else bad(`verify-prod-dump.sh contains ${literal.length} connection string literal(s)`, literal.join(' | '));

    if (!/\bpsql\s+["']?\$\{?DATABASE_URL/.test(src) && !/-d\s+["']?\$\{?DATABASE_URL/.test(src)) {
      ok('it never passes DATABASE_URL to a client');
    } else {
      bad('it passes DATABASE_URL to a database client');
    }

    // The ordering that actually protects everything, asserted so a future edit cannot quietly undo it.
    const rsrc = fs.readFileSync(path.join(__dirname, 'verify-migration-readiness.js'), 'utf8');
    const lines = rsrc.split('\n');
    const setAt = lines.findIndex((l) => /process\.env\.DATABASE_URL\s*=/.test(l));
    const reqAt = lines.findIndex((l) => /require\(['"]\.\.\/src\/lib\/(db|migrate-all)['"]\)/.test(l));
    if (setAt >= 0 && reqAt > setAt) {
      ok(`readiness sets DATABASE_URL (line ${setAt + 1}) before first requiring the migrator (line ${reqAt + 1})`);
    } else {
      bad('the migrator is required before DATABASE_URL is overwritten',
        `set at line ${setAt + 1}, required at line ${reqAt + 1} — src/lib/db binds its Pool at require time, `
        + 'so 30 steps would run against the inherited DATABASE_URL');
    }
    // And no top-level require of either, which would make the line numbers above meaningless.
    const topLevel = lines.slice(0, 60).some((l) => /^const .*require\(['"]\.\.\/src\/lib\/(db|migrate-all)['"]\)/.test(l));
    if (!topLevel) ok('neither src/lib/db nor migrate-all is required at the top of the file');
    else bad('src/lib/db or migrate-all is required at the top of the file', 'the Pool binds before DATABASE_URL is set');
  }

  // ── 2. the decoy ────────────────────────────────────────────────────────────────────────────────
  h('2. A DECOY DATABASE, AND THE ENVIRONMENT POISONED TO POINT AT IT');
  const decoyUrl = `postgresql://postgres@localhost/decoy_production?host=${base}&port=${PGPORT}&sslmode=disable`;
  {
    const admin = new Client({ connectionString: `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable` });
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS decoy_production');
    await admin.query('CREATE DATABASE decoy_production');
    await admin.end();

    const d = new Client({ connectionString: decoyUrl });
    await d.connect();
    await d.query(`CREATE TABLE do_not_touch (id SERIAL PRIMARY KEY, note TEXT)`);
    await d.query(`INSERT INTO do_not_touch (note) VALUES ('a real row'), ('another real row')`);
    const n = (await d.query(`SELECT COUNT(*)::int n FROM pg_tables WHERE schemaname='public'`)).rows[0].n;
    await d.end();
    if (n === 1) ok('decoy created: exactly 1 table, 2 sentinel rows — any write at all will show');
    else bad(`decoy has ${n} tables, expected 1`);
  }

  // ── 3. a dump for the harness to legitimately work on ───────────────────────────────────────────
  h('3. A DUMP FOR IT TO WORK ON — minimal, with the sentinels its own check requires');
  const dump = `${temp.base}/subject.dump`;
  {
    const admin = new Client({ connectionString: `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable` });
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS subject_src');
    await admin.query('CREATE DATABASE subject_src');
    await admin.end();
    const s = new Client({ connectionString: `postgresql://postgres@localhost/subject_src?host=${base}&port=${PGPORT}&sslmode=disable` });
    await s.connect();
    // users, targets and activity_logs are the sentinels verify-migration-readiness.js requires before
    // it will accept a dump as PlaybookOS's. Minimal shapes; the migrator fills in the rest.
    await s.query(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, role TEXT, password_hash TEXT);
      CREATE TABLE targets (id SERIAL PRIMARY KEY, name TEXT);
      CREATE TABLE activity_logs (id SERIAL PRIMARY KEY, note TEXT);
      INSERT INTO users (id, email, name, role, password_hash)
        VALUES ('iso-1','iso@example.invalid','Iso','admin','x');`);
    await s.end();
    sh(`pg_dump -h ${temp.base} -p ${PGPORT} -U postgres --format=custom --file=${dump} subject_src`);
    if (fs.statSync(dump).size > 1000) ok(`subject dump written (${fs.statSync(dump).size.toLocaleString()} bytes)`);
    else bad('the subject dump is suspiciously small');
  }

  // ── 4. run it with the poisoned environment ─────────────────────────────────────────────────────
  h('4. RUNNING THE READINESS HARNESS WITH EVERY INHERITABLE CREDENTIAL POINTED AT THE DECOY');
  {
    const poisoned = {
      ...process.env,
      DATABASE_URL: decoyUrl,
      MIGRATION_DATABASE_URL: decoyUrl,
      DATABASE_PUBLIC_URL: decoyUrl,
      PGHOST: base,
      PGPORT,
      PGDATABASE: 'decoy_production',
      PGUSER: 'postgres',
      PGPORT_READINESS: '55470',
    };
    let code = 0; let out = '';
    try {
      out = execFileSync(process.execPath, [path.join(__dirname, 'verify-migration-readiness.js'), dump],
        { encoding: 'utf8', stdio: 'pipe', env: poisoned, maxBuffer: 32 * 1024 * 1024 });
    } catch (e) {
      code = e.status === undefined ? 1 : e.status;
      out = `${e.stdout || ''}${e.stderr || ''}`;
    }
    console.log(`        (readiness exited ${code}; its own verdict is not what is being tested here)`);

    // It must have done real work — an isolation check that passes because nothing ran proves nothing.
    // This is the EXIT_NOT_EXECUTED lesson: non-execution reported as success.
    if (/step\(s\) applied to a populated database|step\(s\) failed/.test(out)) {
      ok('it really ran the migration — the isolation below is not vacuous');
    } else {
      bad('it does not appear to have run the migration at all',
        'then this proves nothing about isolation; see scripts/lib/pg-cluster.js on non-execution');
    }

    // THE ASSERTION.
    const d = new Client({ connectionString: decoyUrl });
    await d.connect();
    const tables = (await d.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows.map((r) => r.tablename);
    const rows = (await d.query(`SELECT COUNT(*)::int n FROM do_not_touch`)).rows[0].n;
    const notes = (await d.query(`SELECT note FROM do_not_touch ORDER BY id`)).rows.map((r) => r.note);

    if (tables.length === 1 && tables[0] === 'do_not_touch') {
      ok('the decoy still has exactly its one table — nothing was created in it');
    } else {
      bad(`the decoy now has ${tables.length} table(s)`,
        `${tables.slice(0, 12).join(', ')}${tables.length > 12 ? ', …' : ''} — the harness wrote to the inherited DATABASE_URL`);
    }
    if (rows === 2 && notes.join('|') === 'a real row|another real row') {
      ok('its 2 sentinel rows are byte-for-byte intact');
    } else {
      bad(`its sentinel rows changed: ${rows} row(s)`, JSON.stringify(notes));
    }
    const ledger = (await d.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS t`)).rows[0].t;
    if (!ledger) ok('no schema_migrations ledger was written to the decoy');
    else bad('a schema_migrations ledger exists in the decoy', 'the migrator ran against the inherited credential');
    await d.end();
  }

  h(`  ${pass} assertion(s) passed · ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  the dump test can reach a database it was not pointed at.\n'
      + '      Do not run it on a machine where DATABASE_URL points at production.\n');
    stopCluster();
    process.exit(1);
  }
  console.log('\nPASS  with DATABASE_URL, MIGRATION_DATABASE_URL, PGHOST, PGPORT, PGDATABASE and PGUSER all\n'
    + '      pointed at a live decoy, the dump test migrated its own disposable cluster and left the\n'
    + '      decoy untouched — same table, same rows, no ledger.\n');
}

main().then(() => {
  stopCluster();
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  stopCluster();
  console.error(`\nFAIL  harness error: ${e.message}`);
  process.exit(1);
});
