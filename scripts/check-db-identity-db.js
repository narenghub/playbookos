#!/usr/bin/env node
// ── THE DATABASE IS ASKED WHAT IT IS, AND MUST ANSWER CONVINCINGLY ──────────
//
//   node scripts/check-db-identity-db.js; echo "EXIT=$?"
//
// scripts/lib/db-identity.js replaced a hostname blocklist that was wrong in both directions:
// it blocked `postgres.railway.internal`, which inside the dev Railway project is the DEVELOPMENT
// database (private DNS is project-scoped) — and it would have waved through a dev database
// restored from a production dump, because a dump does not change the hostname.
//
// This builds real databases in each of those shapes and checks the verdict.
//
// The rule being locked down: `development` is claimed ONLY for an empty database or one holding
// nothing but M7's own tables. Anything else is a refusal — including a shape nobody anticipated,
// because the default for unrecognised must be stop, not proceed.
//
// EXIT 0 the gate holds · 1 it does not · 3 no Postgres, nothing proven

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 240)}`); };
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n  ── ${m} ──\n`);

// ── THE DISPOSABLE CLUSTER COMES FROM THE VERIFIED LIFECYCLE UTILITY (B7.20b) ──
//
// This file used to carry its own copy of `startTemp`/`stopTemp`: a fixed port, a `/var/tmp`
// directory, and `.finally(stopTemp)` for cleanup. That pair leaks, and not because somebody forgot
// a `finally`: these checks call `process.exit()` on both pass and fail, so a promise `finally`
// never runs, and a SIGTERM does not reach it at all. A leaked legacy cluster also carries no
// ownership record, so `pg-cleanup.js` correctly refuses to remove it — leaving it to accumulate.
// Measured: 66 orphaned directories, 28 GB, which filled the disk mid-gate and made several checks
// report `SKIP infrastructure unavailable` — a full disk presenting as a missing database.
//
// `scripts/lib/pg-legacy-harness.js` presents this exact contract and is backed by
// `pg-disposable`: signal and exit handlers, a random port, and an `OWNER.json` that makes a dead
// run's cluster positively identifiable and therefore removable.
const { startTemp: __startTemp, stopTemp } = require('./lib/pg-legacy-harness');
const startTemp = () => __startTemp('m7-identity');

const url = startTemp();
if (!url) {
  console.log('  skip  no Postgres available');
  console.log('SKIP  database identification was NOT exercised — this proved nothing.');
  process.exit(EXIT_NOT_EXECUTED);
}

(async () => {
  const { Pool } = require('pg');
  const IDENTITY = require('./lib/db-identity');
  const admin = new Pool({ connectionString: url, ssl: false, max: 4 });

  console.log('\n══ DATABASE IDENTITY ══');

  /** Each case gets its own database, so no case can be contaminated by the one before. */
  let n = 0;
  async function inDatabase(label, build) {
    n += 1;
    const name = `idcheck_${n}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const p = new Pool({ connectionString: url.replace('/postgres?', `/${name}?`), ssl: false, max: 4 });
    const q = (sql, params) => p.query(sql, params);
    try {
      await build(q);
      const lines = [];
      const res = await IDENTITY.assertDevelopmentDatabase(q, { log: (m) => lines.push(m) });
      return { ...res, lines: lines.join('\n'), label };
    } finally { await p.end().catch(() => {}); }
  }

  // ── 1. THE SHAPES THAT MUST BE ACCEPTED ───────────────────────────────────
  head('1. identified as development');

  const empty = await inDatabase('empty', async () => {});
  if (empty.ok && empty.verdict === IDENTITY.VERDICT.DEVELOPMENT) {
    ok(`an empty database is identified as development — ${empty.detail}`);
  } else bad('an empty database was not identified as development', JSON.stringify(empty.verdict));

  const m7Only = await inDatabase('m7-only', async (q) => {
    await require('../src/lib/autonomy').migrateAutonomy(q);
    await require('../src/lib/runs').migrateRuns(q);
    await require('../src/lib/office/schema').migrateOffice(q);
    await require('../src/lib/worker/identity').migrateWorkerIdentity(q);
    await require('../src/lib/worker/leases').migrateWorkerTasks(q);
    await require('../src/lib/worker/audit').migrateWorkerAudit(q);
  });
  if (m7Only.ok && m7Only.verdict === IDENTITY.VERDICT.DEVELOPMENT) {
    ok(`a database holding only M7's own tables is development — ${m7Only.detail}`);
    note('this is the re-run case: migrate, then migrate again');
  } else {
    bad('an M7-only database was not identified as development',
      `${m7Only.verdict}: ${m7Only.detail}`);
  }

  // ── THE LIST CANNOT DRIFT SILENTLY ────────────────────────────────────────
  //
  // M7_TABLES is hand-written, and its first version was short by seven tables — found here, not in
  // production. This compares the list against what the migrations ACTUALLY create, so adding a
  // table to a migration without adding it to the list fails right here rather than making every
  // future migration refuse to run.
  const uncovered = (m7Only.tables || []).filter((t) => !IDENTITY.M7_TABLES.includes(t));
  if (uncovered.length === 0) {
    ok(`M7_TABLES covers all ${(m7Only.tables || []).length} tables the six migrations create`);
  } else {
    bad(`${uncovered.length} table(s) created by the migrations are missing from M7_TABLES`,
      `${uncovered.join(', ')} — add them, or a freshly migrated database reads as unidentified`);
  }
  const phantom = IDENTITY.M7_TABLES.filter((t) => !(m7Only.tables || []).includes(t));
  if (phantom.length === 0) ok('and lists no table the migrations do not create');
  else note(`M7_TABLES lists ${phantom.length} table(s) not created here: ${phantom.join(', ')}`);

  // ── 2. PRODUCTION'S FINGERPRINT ───────────────────────────────────────────
  head('2. refused: production, or a restore of it');

  for (const [label, build, expectIn] of [
    ['one of the three production STOP rows', async (q) => {
      await require('../src/lib/autonomy').migrateAutonomy(q);
      await q(`INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
               VALUES ('capability','email.send','production containment','owner')`);
    }, /email\.send/],
    ['all three production STOP rows', async (q) => {
      await require('../src/lib/autonomy').migrateAutonomy(q);
      await q(`INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by) VALUES
               ('capability','email.send','x','o'),
               ('workflow','legacy-inquiry-buyer-email','x','o'),
               ('workflow','legacy-supplier-rfq-email','x','o')`);
    }, /3 of production/],
    ['a populated users table', async (q) => {
      await q(`CREATE TABLE users (id serial primary key, email text)`);
      await q(`INSERT INTO users (email) VALUES ('someone@example.com')`);
    }, /users exists and contains data/],
    ['a populated orders table', async (q) => {
      await q(`CREATE TABLE orders (id serial primary key, total numeric)`);
      await q(`INSERT INTO orders (total) VALUES (8500)`);
    }, /orders exists and contains data/],
    ['a populated email_log', async (q) => {
      await q(`CREATE TABLE email_log (id serial primary key, recipient text)`);
      await q(`INSERT INTO email_log (recipient) VALUES ('a@b.c')`);
    }, /email_log exists and contains data/],
    ['M7 tables AND production data together', async (q) => {
      await require('../src/lib/autonomy').migrateAutonomy(q);
      await require('../src/lib/runs').migrateRuns(q);
      await q(`CREATE TABLE users (id serial primary key, email text)`);
      await q(`INSERT INTO users (email) VALUES ('real@abiozen.com')`);
    }, /users exists and contains data/],
  ]) {
    const r = await inDatabase(label, build);
    if (!r.ok && r.verdict === IDENTITY.VERDICT.PRODUCTION_FINGERPRINT && expectIn.test(r.lines)) {
      ok(`refuses ${label}`);
    } else {
      bad(`did NOT refuse ${label}`, `${r.verdict}: ${r.detail}`);
    }
  }

  // ── 3. THE DISTINCTION A HOSTNAME COULD NEVER MAKE ────────────────────────
  head('3. the case the hostname check could never have caught');

  note('A development database restored from a production dump has a development hostname.');
  const restored = await inDatabase('restored-from-production', async (q) => {
    await require('../src/lib/autonomy').migrateAutonomy(q);
    await q(`INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by) VALUES
             ('capability','email.send','x','o'),
             ('workflow','legacy-inquiry-buyer-email','x','o'),
             ('workflow','legacy-supplier-rfq-email','x','o')`);
    await q(`CREATE TABLE users (id serial primary key, email text)`);
    await q(`INSERT INTO users (email) VALUES ('naren@abiozen.com')`);
  });
  if (!restored.ok && restored.verdict === IDENTITY.VERDICT.PRODUCTION_FINGERPRINT) {
    ok('a dev-hosted database restored from production is REFUSED');
    note('the hostname was never going to say anything about this');
  } else bad('a restore of production was accepted', restored.verdict);

  // ── 4. UNRECOGNISED IS A REFUSAL, NOT PERMISSION ──────────────────────────
  head('4. an unfamiliar shape stops rather than proceeds');

  const stranger = await inDatabase('somebody else\'s schema', async (q) => {
    await q(`CREATE TABLE invoices (id serial primary key)`);
    await q(`CREATE TABLE customers (id serial primary key)`);
  });
  if (!stranger.ok && stranger.verdict === IDENTITY.VERDICT.UNIDENTIFIED) {
    ok('a database of unrelated tables is UNIDENTIFIED, and refused');
    note('empty tables, no production fingerprint — and still not identified as development');
  } else bad('an unfamiliar database was accepted', stranger.verdict);

  const emptyBusiness = await inDatabase('business tables, no rows', async (q) => {
    await q(`CREATE TABLE users (id serial primary key)`);
    await q(`CREATE TABLE orders (id serial primary key)`);
  });
  if (!emptyBusiness.ok) {
    ok(`empty business tables are still refused (${emptyBusiness.verdict})`);
    note('created by scripts/migrate.js perhaps, but not an M7 scratch database either way');
  } else bad('a database with business tables was identified as development');

  // ── 5. A DATABASE THAT CANNOT BE READ IS NOT PERMISSION ───────────────────
  head('5. cannot_tell is a refusal');

  const broken = await IDENTITY.identifyDatabase(async () => { throw new Error('connection reset'); });
  if (broken.verdict === IDENTITY.VERDICT.CANNOT_TELL) {
    ok('a database that cannot be inspected is cannot_tell, never development');
  } else bad(`an unreadable database returned ${broken.verdict}`);

  const brokenGate = await IDENTITY.assertDevelopmentDatabase(
    async () => { throw new Error('connection reset'); }, { log: () => {} });
  if (brokenGate.ok === false) ok('and the gate refuses on it');
  else bad('the gate passed a database it could not read');

  // ── 6. IT WRITES NOTHING ──────────────────────────────────────────────────
  head('6. the check itself is read-only');

  const src = fs.readFileSync(`${__dirname}/lib/db-identity.js`, 'utf8')
    .replace(/^\s*\/\/.*$/gm, '');
  // Word-anchored. An earlier version used /CREATE /i, which matched the word "recreate" in this
  // module's own guidance text — a scanner tripping over prose about itself.
  const mutations = ['INSERT\\s+INTO', 'UPDATE\\s+\\w', 'DELETE\\s+FROM', 'DROP\\s+TABLE',
    'CREATE\\s+TABLE', 'ALTER\\s+TABLE', 'TRUNCATE'];
  const found = mutations.filter((m) => new RegExp(`\\b${m}`, 'i').test(src));
  if (found.length === 0) ok('db-identity.js contains no mutating SQL');
  else bad(`db-identity.js contains mutating SQL: ${found.join(', ')}`);

  const before = await (async () => {
    const p = new Pool({ connectionString: url.replace('/postgres?', '/idcheck_2?'), ssl: false, max: 2 });
    const r = await p.query(`SELECT COUNT(*)::int n FROM pg_tables WHERE schemaname=current_schema()`);
    const s = await p.query(`SELECT COUNT(*)::int n FROM autonomy_stops`);
    await IDENTITY.identifyDatabase((sql, params) => p.query(sql, params));
    const r2 = await p.query(`SELECT COUNT(*)::int n FROM pg_tables WHERE schemaname=current_schema()`);
    const s2 = await p.query(`SELECT COUNT(*)::int n FROM autonomy_stops`);
    await p.end();
    return { t: [r.rows[0].n, r2.rows[0].n], s: [s.rows[0].n, s2.rows[0].n] };
  })();
  if (before.t[0] === before.t[1] && before.s[0] === before.s[1]) {
    ok(`and changes nothing when run (tables ${before.t[0]}, stop rows ${before.s[0]}, unchanged)`);
  } else bad('running the identity check changed the database', JSON.stringify(before));

  await admin.end();
})()
  .then(() => {
    console.log();
    if (fail) { console.log(`FAIL  ${fail} identification problem(s).`); process.exit(1); }
    console.log('PASS  an empty or M7-only database is identified as development; production\'s');
    console.log('      STOP rows or populated business tables are refused — including a dev-hosted');
    console.log('      restore of production, which no hostname check could ever have caught; an');
    console.log('      unfamiliar shape and an unreadable database are both refusals rather than');
    console.log('      permission; and the check writes nothing.');
    process.exit(0);
  })
  .catch((e) => {
    console.log(`\nINCOMPLETE  ${(e && e.stack) || e}`);
    process.exit(EXIT_NOT_EXECUTED);
  })
  .finally(stopTemp);
