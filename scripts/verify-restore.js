#!/usr/bin/env node
'use strict';
// ── RESTORE VERIFICATION — DOES A BACKUP ACTUALLY COME BACK? ────────────────
//
// Ruling 10 item 2: confirm that a full production backup can be restored successfully into an
// isolated fresh database, and record the results and the recovery procedure.
//
// ── WHAT THIS DOES ──────────────────────────────────────────────────────────
//
// Given a dump file, it creates its OWN disposable PostgreSQL cluster, restores into a fresh
// database there, boots the REAL application against the restored copy, and checks that the
// application comes up and stays up. It then reports what was restored.
//
// It never connects to production, never needs production credentials, and cannot write to the
// source of the dump — it only reads the file.
//
// ── WHY BOOTING THE APP IS THE POINT ────────────────────────────────────────
//
// A restore that reports "success" because pg_restore exited 0 proves the bytes moved. It does not
// prove the thing you actually need in a disaster, which is an application running on the restored
// data. Those came apart badly in this codebase once already: a migration ordering bug meant that
// on an EMPTY database the server bound its port, answered GET /health, and then exited — so a
// restore into a fresh database would have looked fine to any check that stopped at /health.
//
// So this waits, and asserts the process is STILL ALIVE afterwards. That ten seconds is the whole
// difference between "the server started" and "the application is running".
//
// ── USAGE ───────────────────────────────────────────────────────────────────
//
//   # 1. take the dump (on a machine that can reach production)
//   pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" -f prod-YYYYMMDD.dump
//
//   # 2. verify it comes back
//   node scripts/verify-restore.js prod-YYYYMMDD.dump
//   echo $?
//
// Accepts a custom-format dump (pg_restore) or a plain .sql / .sql.gz (psql).
//
// Exit: 0 restored and the application came up and stayed up · 1 it did not · 2 not executed

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');
// ONE implementation of toolchain selection, cluster start and restore, in scripts/lib/restore.js.
// It used to live here, and the migration-on-restore harness was about to become the second copy —
// the same shape as the 35 harnesses that each carried their own Postgres search path and drifted.
const R = require('./lib/restore');

const PORT = 3994;
const PGPORT = 55987;

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 700)}`); };
const note = (m) => console.log(`  note  ${m}`);
function bar(ch = '─') { return ch.repeat(78); }
function h(t) { console.log(`\n${bar()}\n${t}\n${bar()}`); }

const dumpPath = process.argv[2];
if (!dumpPath) {
  console.error(`
Usage: node scripts/verify-restore.js <dump-file>

Take the dump first, on a machine that can reach production:
  pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" -f prod-$(date +%Y%m%d).dump

This script never connects to production. It reads the dump, restores it into a
disposable cluster it creates itself, boots the real application against the
restored copy, and checks the application is still running afterwards.
`);
  process.exit(1);
}
if (!fs.existsSync(dumpPath)) {
  // The placeholder case is diagnosed in scripts/lib/restore.js; the exit code stays here.
  if (!R.reportPlaceholder(dumpPath, process.argv[1])) {
    console.error(`dump file not found: ${dumpPath}`);
  }
  process.exit(1);
}

// Toolchain selection, cluster lifecycle and the restore itself are in scripts/lib/restore.js,
// along with the three lessons they encode: every client call names its role, the toolchain is
// chosen by what can read the dump rather than by search order, and initdb's presence does not
// mean a server is installed.
let cluster = null;
function stopCluster() { R.stopCluster(cluster); cluster = null; }

async function main() {
  const stat = fs.statSync(dumpPath);
  h('RESTORE VERIFICATION');
  console.log(`  dump      : ${path.resolve(dumpPath)}`);
  console.log(`  size      : ${(stat.size / 1048576).toFixed(2)} MiB`);
  console.log(`  modified  : ${stat.mtime.toISOString()}`);
  console.log(`  started   : ${new Date().toISOString()}`);
  console.log('');
  console.log('  This script does not connect to production. It reads the dump only.');

  // The format and the archive version are properties OF THE FILE, so they are read before any
  // toolchain is chosen — the file decides which Postgres is fit to read it, not the other way round.
  const archive = R.archiveVersion(dumpPath);
  const isCustom = archive !== null;
  const isGz = /\.gz$/i.test(dumpPath);
  console.log(`  format    : ${isCustom ? `custom (PGDMP, archive ${archive}) → pg_restore` : isGz ? 'gzipped SQL → gunzip | psql' : 'plain SQL → psql'}`);

  const chosen = R.toolchainFor(dumpPath, isCustom);
  if (!chosen.dir) {
    const clientOnly = chosen.clientOnly || [];
    if (!chosen.tried.length && !clientOnly.length) {
      console.log('\nSKIP  no Postgres available');
      process.exit(EXIT_NOT_EXECUTED);
    }
    // NOT a skip. Postgres is installed in some form; no complete server toolchain here can read
    // this backup. That is a real, actionable finding about this machine's ability to recover from
    // it, so it exits 1, not 3.
    h('TOOLCHAIN');
    bad(`no PostgreSQL server install here can restore this dump (archive version ${archive})`,
      'a custom-format dump can only be read by a pg_restore at least as new as the pg_dump that '
      + 'wrote it, and the restore also needs a SERVER of that version to restore into');
    if (chosen.tried.length) {
      console.log('\n  server installs found, none able to read this archive:');
      for (const t of chosen.tried) console.log(`    ${t}`);
    } else {
      console.log('\n  server installs found: NONE');
    }
    if (clientOnly.length) {
      // This is the half that is easy to miss: the newest tools on the machine may be client-only,
      // which is exactly how a dump gets written in a format nothing here can restore.
      console.log('\n  client-only directories (psql/pg_dump/pg_restore but NO server) — these can');
      console.log('  WRITE a dump this machine cannot then restore, which is how you got here:');
      for (const d of clientOnly) console.log(`    ${d}  ${toolVersion(d, 'pg_restore')}`);
    }
    console.log('\n  FIX: install a PostgreSQL SERVER at least as new as the client that wrote the');
    console.log('  dump. On macOS with Homebrew: brew install postgresql@18');
    console.log('  (installing the server does not disturb libpq or the client tools on PATH.)');
    console.log(`\n  THE BACKUP IS NOT NECESSARILY BAD — this machine cannot currently restore it,`);
    console.log(`  which for disaster recovery is the same problem and is worth knowing now.\n`);
    process.exit(1);
  }
  // BOTH versions, because they can differ IN THE SAME DIRECTORY. /opt/homebrew/bin holds symlinks
  // placed by whichever formula was linked last, so pg_restore can come from one major version and
  // initdb from another. A cluster initialised by one and addressed by the other is a failure whose
  // cause is invisible unless both numbers are on the page.
  const initdbVersion = chosen.initdbVersion;
  console.log(`  toolchain : ${chosen.dir}`);
  console.log(`              ${chosen.version}`);
  console.log(`              ${initdbVersion}`);
  const major = (s) => (s.match(/\)\s+(\d+)/) || [])[1] || null;
  const mixed = major(initdbVersion) && major(chosen.version) && major(initdbVersion) !== major(chosen.version);
  if (mixed) {
    note(`initdb is PostgreSQL ${major(initdbVersion)} but pg_restore is ${major(chosen.version)} — same`);
    note('directory, different major versions. That is a broken install, not a broken backup.');
  }

  cluster = R.startCluster(chosen.dir, { port: PGPORT });
  if (cluster.error) {
    const clusterError = cluster.error;
    // Postgres IS installed — it was selected by probing this very dump a moment ago. So this is a
    // failure, not an absence, and it exits 1 with the reason rather than 3 with a wrong one.
    h('CLUSTER');
    bad(`the selected PostgreSQL could not start a disposable cluster`, `failed at: ${clusterError.step}`);
    if (clusterError.output) {
      console.log('\n  command output:');
      for (const line of clusterError.output.split('\n').slice(-25)) console.log(`    ${line}`);
    }
    if (clusterError.log) {
      console.log('\n  server log:');
      for (const line of clusterError.log.split('\n').slice(-25)) console.log(`    ${line}`);
    }
    if (!clusterError.output && !clusterError.log) console.log(`\n  (no output captured)  ${clusterError.message}`);
    if (mixed) {
      console.log(`\n  LIKELY CAUSE: initdb (${major(initdbVersion)}) and pg_restore (${major(chosen.version)}) in`);
      console.log(`  ${chosen.dir} are different major versions.`);
    }
    console.log(`\n  data directory left in place for inspection: ${clusterError.base}`);
    console.log('\n  THE BACKUP IS UNVERIFIED. This is not a statement about the dump.\n');
    process.exit(1);
  }
  const base = cluster.base;
  const dir = cluster.dir;
  const asPostgres = cluster.asPostgres;
  const sock = base;
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  // EVERY psql / pg_restore BELOW PASSES -U postgres, and that is not decoration.
  //
  // pg-cluster's INITDB_FLAGS is '-A trust -U postgres', so the cluster's only superuser is
  // `postgres`. In a container running as root this script wraps commands in `su postgres`, so the
  // OS user happened to match and the omission was invisible. On an ordinary developer machine the
  // commands run as that person, psql defaults the role to their username, and every call dies
  // with `role "<username>" does not exist`. The script only ever worked as root — found when it
  // was run on a Mac, which is exactly the environment it is meant for.
  const sh = (cmd, quiet) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, encoding: 'utf8', stdio: quiet ? 'pipe' : ['pipe', 'pipe', 'pipe'] });

  const url = `postgresql://postgres@localhost/restored?host=${sock}&port=${PGPORT}&sslmode=disable`;
  let server = null;

  try {
    // ── 1. restore into a FRESH database ───────────────────────────────────
    h('1. RESTORE');
    // One implementation, in scripts/lib/restore.js: it creates the database, picks pg_restore or
    // psql by the dump's own header, passes -U postgres on every call, and runs strict
    // (--exit-on-error / ON_ERROR_STOP) because a restore that reports success while skipping
    // objects is the failure this whole exercise exists to catch.
    const restored = R.restoreDump(cluster, dumpPath);
    if (restored.error) { bad('THE RESTORE FAILED', restored.error.slice(0, 900)); return; }
    ok('created a fresh database and restored into it with no error (strict mode)');

    // ── 2. what came back ──────────────────────────────────────────────────
    h('2. WHAT CAME BACK');
    const q = (sql) => sh(`PATH=${dir}:$PATH psql -tAq -U postgres -h ${sock} -p ${PGPORT} -d restored -c ${JSON.stringify(sql)}`, true).trim();
    const tables = Number(q("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'"));
    console.log(`  tables restored : ${tables}`);
    if (tables > 0) ok(`${tables} tables present`);
    else { bad('the restored database has NO tables — the dump restored nothing'); return; }

    // Row counts for the tables a person would actually miss.
    for (const t of ['users', 'companies', 'orders', 'skus', 'daily_tasks']) {
      const present = q(`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='${t}')`);
      if (present === 't') {
        const n = q(`SELECT COUNT(*) FROM "${t}"`);
        console.log(`    ${t.padEnd(16)} ${n} row(s)`);
      } else {
        console.log(`    ${t.padEnd(16)} ABSENT`);
      }
    }

    // ── 3. THE TENANCY ANSWER, from the restored copy ──────────────────────
    //
    // This is ruling 10 item 1's question, answerable from a backup without touching production.
    // If the dump is a production backup, this IS the production company count.
    h('3. ACTIVE COMPANY COUNT (ruling 10 item 1)');
    const hasCompanies = q("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='companies')");
    if (hasCompanies !== 't') {
      note('companies table is ABSENT in this dump — the office kernel was never applied here.');
      note('The PRPA dashboard would refuse with "no active company exists".');
    } else {
      const active = Number(q("SELECT COUNT(*) FROM companies WHERE status='active'"));
      const total = Number(q('SELECT COUNT(*) FROM companies'));
      console.log(`  active companies: ${active}   (total rows: ${total})`);
      const rows = q("SELECT id || ' | ' || slug || ' | ' || display_name || ' | ' || status FROM companies ORDER BY created_at, id");
      if (rows) for (const line of rows.split('\n')) console.log(`    ${line}`);
      console.log('');
      if (active === 1) {
        ok('EXACTLY ONE active company — the read-session resolver resolves, and the release proceeds');
      } else if (active === 0) {
        bad('ZERO active companies — every PRPA endpoint will refuse with "no active company exists"',
          'this is a configuration gap, not an empty result');
      } else {
        bad(`${active} ACTIVE COMPANIES — STOP`,
          'the read-session resolver refuses when the answer is ambiguous, so the dashboard would '
          + 'ship refusing. Ruling 10 item 1: prepare an authenticated company-context design first.');
      }
    }

    // ── 4. BOOT THE REAL APPLICATION ON THE RESTORED COPY ──────────────────
    h('4. DOES THE APPLICATION RUN ON THE RESTORED DATA?');
    note('pg_restore exiting 0 proves the bytes moved. This proves the thing you need in a disaster.');
    server = spawn('node', ['server.js'], {
      env: {
        ...process.env,
        DATABASE_URL: url,
        PORT: String(PORT),
        NODE_ENV: 'development',
        // These fall back to OBVIOUS placeholders, and the spelling is the point. They reach only
        // the throwaway cluster this script creates and destroys, so no real value is involved —
        // but the committed-credential guard flagged the previous wording ("restore-verification-
        // only", "RestoreCheckOnly123") because it could not tell those from real secrets, and
        // neither could a person skim-reading the file. A scanner that cries wolf gets ignored, so
        // the fix belongs here rather than in an exemption.
        JWT_SECRET: process.env.JWT_SECRET || 'REPLACE_ME_NOT_A_SECRET',
        ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'restore-check@example.invalid',
        ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'REPLACE_ME_NOT_A_SECRET',
      },
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    server.stdout.on('data', (d) => { log += d; });
    server.stderr.on('data', (d) => { log += d; });

    let healthy = false;
    for (let i = 0; i < 150; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) { healthy = true; break; } } catch (_) { /* wait */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!healthy) { bad('the application never answered /health on the restored data', log); return; }
    ok('the application answered GET /health on the restored database');

    // THE ASSERTION THAT MATTERS.
    await new Promise((r) => setTimeout(r, 10000));
    if (server.exitCode === null) {
      ok('STILL RUNNING 10 seconds later — the boot chain completed, not just the listener');
    } else {
      bad(`the application EXITED with code ${server.exitCode} after answering /health`,
        `${log.split('\n').filter((l) => /error|CRITICAL|exit/i.test(l)).slice(0, 6).join(' | ')}`);
      return;
    }

    if (/DB init error|CRITICAL/.test(log)) {
      bad('the boot log contains an init error or a CRITICAL line',
        log.split('\n').filter((l) => /DB init error|CRITICAL/.test(l)).slice(0, 4).join(' | '));
    } else ok('no DB init error and no CRITICAL line in the boot log');

    const anon = await fetch(`http://127.0.0.1:${PORT}/api/prpa/opportunities`);
    if (anon.status === 401) ok('an unauthenticated request to a protected endpoint is refused (401)');
    else bad(`unauthenticated request returned ${anon.status}, expected 401`);
  } finally {
    if (server) server.kill('SIGKILL');
    stopCluster();
  }
}

main()
  .then(() => {
    h('RESULT');
    if (fail) {
      console.log(`  ${fail} failure(s). THE BACKUP DID NOT VERIFY. Do not rely on it.\n`);
    } else {
      console.log('  The backup restores into a fresh database and the application runs on it.');
      console.log('  Recorded: dump path, size, timestamp, table count and the company count above.\n');
    }
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => { stopCluster(); console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
