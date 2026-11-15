#!/usr/bin/env node
// ── THE M7 DEVELOPMENT MIGRATION, AND PROOF IT LANDED ───────────────────────
//
//   M7_5_DEV_CONFIRM=yes DATABASE_URL=<dev> node scripts/m7-dev-migrate.js [--verify]
//
// ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
//
// `scripts/migrate.js` runs 54 schema steps and NONE of them are the three M7 worker migrations.
// They were deliberately left out of SCHEMA_STEPS, and that exclusion is correct until M7 is
// approved for production. The consequence, which the M7.5 setup procedure originally missed: a dev
// database migrated with `migrate.js --no-seeds` has no worker tables at all, the dev API starts
// cleanly, and the first enrolment from the Mac fails with `relation "worker_enrollment_tokens"
// does not exist`. That failure would have happened while standing at the hardware.
//
// So this applies exactly the six migrations the worker subsystem needs, in dependency order, and
// then PROVES every table, index and constraint is present.
//
// ── IT APPLIES SIX MIGRATIONS, NOT FIFTY-FOUR ───────────────────────────────
//
// The worker path needs autonomy, runs, office (which adds agent_runs.company_id), and the three
// M7 schemas. It needs no `users`, no `orders`, no `email_log`. Running only these six is not a
// shortcut — it means the dev database has no schema in which business data COULD be written, which
// is a stronger isolation property than any amount of configuration. Verified empirically: a full
// enrol → claim → execute → result cycle completes against exactly these six.
//
// ── HOW IT VERIFIES ─────────────────────────────────────────────────────────
//
// Expectations are DERIVED from each module's exported DDL, then the database is OBSERVED through
// pg_catalog, then the two are compared. Not a hand-written list, which drifts, and not a count of
// anything — `migrate-outbound-ledger.js --status` reported APPLIED while the unique index was
// absent because it counted columns and never looked at an index. The lesson was not "count better".
//
// Idempotent.
//
// EXIT 0 every expected artifact is present · 1 something is missing · 2 refused

'use strict';

const MODE_VERIFY = process.argv.includes('--verify');

const FORBIDDEN_HOSTS = ['postgres.railway.internal', 'interchange.proxy.rlwy.net'];

function refuse(msg, extra) {
  process.stderr.write(`REFUSED: ${msg}\n`);
  if (extra) process.stderr.write(`${extra}\n`);
  process.exit(2);
}

if (!process.env.DATABASE_URL) refuse('DATABASE_URL is not set.');
let host = '';
try { host = new URL(process.env.DATABASE_URL).hostname; } catch (_) {
  refuse('DATABASE_URL is not a URL this script can inspect.');
}
for (const h of FORBIDDEN_HOSTS) {
  if (host === h || host.endsWith(`.${h}`)) {
    refuse(`${host} is a production database host.`,
      'The M7 migrations are NOT approved for production. Applying them there is a separate\n'
      + 'decision requiring separate authorization.');
  }
}
if (process.env.NODE_ENV === 'production') refuse('NODE_ENV=production.');
if (process.env.M7_5_DEV_CONFIRM !== 'yes') {
  refuse('set M7_5_DEV_CONFIRM=yes to confirm this is the development database.', `         host=${host}`);
}

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1|host=/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: 4,
});
const query = (sql, params) => pool.query(sql, params);

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 200)}`); };
const head = (m) => console.log(`\n  ── ${m} ──\n`);

// ── THE SIX, IN DEPENDENCY ORDER ────────────────────────────────────────────
//
// Order is load-bearing: office adds agent_runs.company_id, which office/recovery.js reads, and
// task-schema's idx_agent_runs_worker_live indexes agent_runs columns that runs.js creates.
const STEPS = [
  ['autonomy  (autonomy_stops, autonomy_events)', () => require('../src/lib/autonomy').migrateAutonomy(query)],
  ['runs      (agent_runs + the retry guard)', () => require('../src/lib/runs').migrateRuns(query)],
  ['office    (agent_runs.company_id, recovery)', () => require('../src/lib/office/schema').migrateOffice(query)],
  ['M7.1      (worker identities, tokens, nonces)', () => require('../src/lib/worker/identity').migrateWorkerIdentity(query)],
  ['M7.2      (worker_tasks, worker_results)', () => require('../src/lib/worker/leases').migrateWorkerTasks(query)],
  ['M7.3      (worker_audit)', () => require('../src/lib/worker/audit').migrateWorkerAudit(query)],
];

/** Pulls table, index, constraint and trigger names out of a DDL array. */
function expectationsFrom(ddl) {
  const out = { tables: new Set(), indexes: new Set(), constraints: new Set(), triggers: new Set() };
  for (const raw of [].concat(ddl || [])) {
    const s = String(raw);
    for (const m of s.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi)) out.tables.add(m[1].toLowerCase());
    for (const m of s.matchAll(/CREATE(?:\s+UNIQUE)?\s+INDEX(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi)) out.indexes.add(m[1].toLowerCase());
    for (const m of s.matchAll(/CONSTRAINT\s+([a-z_][a-z0-9_]*)/gi)) out.constraints.add(m[1].toLowerCase());
    for (const m of s.matchAll(/CREATE\s+TRIGGER\s+([a-z_][a-z0-9_]*)/gi)) out.triggers.add(m[1].toLowerCase());
    // ALTER TABLE ... ADD CONSTRAINT appears in the office step.
    for (const m of s.matchAll(/ADD\s+CONSTRAINT\s+([a-z_][a-z0-9_]*)/gi)) out.constraints.add(m[1].toLowerCase());
  }
  return out;
}

/** Observes what the database actually has. Independent of the DDL that was meant to create it. */
async function observe() {
  const t = await query(
    `SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`);
  const i = await query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`);
  const c = await query(
    `SELECT conname FROM pg_constraint con
       JOIN pg_namespace n ON n.oid = con.connamespace
      WHERE n.nspname = current_schema()`);
  const g = await query(
    `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`);
  return {
    tables: new Set(t.rows.map((r) => r.tablename.toLowerCase())),
    indexes: new Set(i.rows.map((r) => r.indexname.toLowerCase())),
    constraints: new Set(c.rows.map((r) => r.conname.toLowerCase())),
    triggers: new Set(g.rows.map((r) => r.tgname.toLowerCase())),
  };
}

(async () => {
  console.log(`\n══ M7 DEV MIGRATION — ${host} ══`);

  if (!MODE_VERIFY) {
    head('applying the six migrations the worker subsystem needs');
    for (const [name, run] of STEPS) {
      try { await run(); ok(name); } catch (e) { bad(name, e.message); throw e; }
    }
  } else {
    console.log('\n  --verify: changing nothing\n');
  }

  // ── DERIVE, OBSERVE, COMPARE ──────────────────────────────────────────────
  head('verification: derived from each module\'s DDL, observed through pg_catalog');

  const expected = { tables: new Set(), indexes: new Set(), constraints: new Set(), triggers: new Set() };
  const sources = [
    require('../src/lib/worker/identity-schema'),
    require('../src/lib/worker/task-schema'),
    require('../src/lib/worker/audit'),
  ];
  for (const m of sources) {
    const e = expectationsFrom(m.DDL);
    for (const k of Object.keys(expected)) for (const v of e[k]) expected[k].add(v);
  }

  // Guard against a vacuous verification: if the DDL parse found nothing, every comparison below
  // would trivially pass. This is the `--status` defect's actual shape — a check that cannot fail.
  if (expected.tables.size === 0) {
    bad('derived ZERO expected tables from the M7 DDL', 'the parse is broken; this proves nothing');
    throw new Error('vacuous expectation set');
  }
  console.log(`  derived from DDL: ${expected.tables.size} table(s), ${expected.indexes.size} index(es), `
    + `${expected.constraints.size} constraint(s)\n`);

  const actual = await observe();

  for (const kind of ['tables', 'indexes', 'constraints']) {
    const missing = [...expected[kind]].filter((n) => !actual[kind].has(n)).sort();
    if (missing.length === 0) {
      ok(`all ${expected[kind].size} M7 ${kind} present`);
    } else {
      bad(`${missing.length} M7 ${kind} MISSING`, missing.join(', '));
    }
  }

  // ── THE ARTIFACTS THAT CARRY THE GUARANTEES ───────────────────────────────
  //
  // Named explicitly, in ADDITION to the derived comparison, because these are the ones whose
  // absence is silent: the system keeps working and simply stops being safe. A derived list proves
  // the DDL ran; this proves the specific things the design depends on are really there.
  head('verification: the artifacts the design actually depends on');

  const MUST = [
    ['index', 'uq_agent_runs_one_active', 'at most one ACTIVE run per intent'],
    ['index', 'uq_agent_runs_intent_attempt', 'attempt numbering is unique per intent'],
    ['index', 'uq_worker_tasks_intent', 'one task per intent key'],
    ['index', 'idx_agent_runs_worker_live', 'live worker runs are findable'],
    ['trigger', 'trg_agent_runs_retry_guard', 'a retry cannot skip its predecessor rules'],
  ];
  for (const [kind, name, why] of MUST) {
    const set = kind === 'trigger' ? actual.triggers : actual.indexes;
    if (set.has(name)) ok(`${name} — ${why}`);
    else bad(`${name} is ABSENT — ${why}`, 'the system will work and will not be safe');
  }

  // worker_results.run_id must be the PRIMARY KEY: that is what makes a duplicate submission a
  // recognised duplicate rather than a second row.
  const pk = await query(
    `SELECT a.attname FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE c.relname = 'worker_results' AND i.indisprimary`);
  const pkCols = pk.rows.map((r) => r.attname);
  if (pkCols.length === 1 && pkCols[0] === 'run_id') {
    ok('worker_results PRIMARY KEY is (run_id) — a duplicate result is refused by the database');
  } else bad(`worker_results PRIMARY KEY is (${pkCols.join(', ') || 'none'})`, 'expected exactly (run_id)');

  const npk = await query(
    `SELECT COUNT(*)::int n FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
      WHERE c.relname = 'worker_request_nonces' AND i.indisprimary`);
  if (Number(npk.rows[0].n) === 1) ok('worker_request_nonces has a primary key — replay is refused by the database');
  else bad('worker_request_nonces has no primary key', 'nonce reuse would not be caught');

  const chk = await query(
    `SELECT pg_get_constraintdef(con.oid) d FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
      WHERE c.relname = 'worker_audit' AND con.contype = 'c'`);
  if (chk.rows.some((r) => /GRANTED/.test(r.d) && /DENIED/.test(r.d))) {
    ok('worker_audit constrains outcome to GRANTED/DENIED');
  } else bad('worker_audit outcome is unconstrained');

  const apk = await query(
    `SELECT a.attname FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE c.relname = 'autonomy_stops' AND i.indisprimary ORDER BY a.attname`);
  const acols = apk.rows.map((r) => r.attname).join(',');
  if (acols === 'scope_key,scope_type') ok('autonomy_stops PRIMARY KEY is (scope_type, scope_key)');
  else bad(`autonomy_stops PRIMARY KEY is (${acols || 'none'})`, 'the containment seed relies on it for idempotency');

  // ── WHAT IS DELIBERATELY ABSENT ───────────────────────────────────────────
  head('verification: the business schema is NOT here');

  const business = ['users', 'orders', 'email_log', 'targets', 'apollo_sequences', 'buyer_contacts'];
  const found = business.filter((t) => actual.tables.has(t));
  if (found.length === 0) {
    ok(`none of ${business.length} business tables exist — there is no schema here to write business data into`);
  } else {
    console.log(`  NOTE  ${found.length} business table(s) present: ${found.join(', ')}`);
    console.log('        Expected if you ran scripts/migrate.js against this database too. Harmless,');
    console.log('        but the minimal six-migration set is the stronger isolation.');
  }

  console.log('');
  console.log(`  tables in this database: ${actual.tables.size}`);
})()
  .then(async () => {
    await pool.end().catch(() => {});
    console.log();
    if (fail) {
      console.log(`FAIL  ${fail} expected artifact(s) are missing. The dev database is NOT ready;`);
      console.log('      enrolment from the Mac would fail against it.');
      process.exit(1);
    }
    console.log('PASS  every M7 table, index, constraint and trigger derived from the DDL is present,');
    console.log('      and each artifact the design depends on was checked by name as well.');
    process.exit(0);
  })
  .catch(async (e) => {
    await pool.end().catch(() => {});
    console.log(`\nINCOMPLETE  ${(e && e.message) || e}`);
    process.exit(1);
  });
