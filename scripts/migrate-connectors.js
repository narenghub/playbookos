#!/usr/bin/env node
'use strict';
// ── VERSIONED MIGRATION RUNNER FOR THE CONNECTOR SCHEMA ─────────────────────
//
// Ruling 9 item 3: a dedicated, versioned runner rather than executing the migration on every
// server startup. Verify migrateOffice prerequisites, idempotency, rollback and clean-database
// behaviour.
//
// ── WHY NOT IN THE BOOT CHAIN ───────────────────────────────────────────────
//
// It would have been one line in server.js, and that is precisely the problem:
//
//   1. A MIGRATION WOULD RUN ON EVERY RESTART, INCLUDING EVERY CRASH LOOP. A container that
//      restarts five times in a minute runs DDL five times in a minute, against a database that
//      may be mid-recovery.
//   2. NOBODY WOULD DECIDE TO APPLY IT. The schema would arrive in production because a deploy
//      happened, which means the decision to change the database gets made by whoever merged
//      something unrelated. Ruling 8 asked for migration and deployment to be separate approvals;
//      a boot-chain migration welds them together permanently.
//   3. A FAILURE WOULD TAKE THE APP DOWN. server.js's boot chain ends in process.exit(1), and
//      that is exactly how a fresh deploy was found to be unbootable: one out-of-order ALTER in
//      migrateSchemas aborted the block, and the server answered /health and then died. Adding
//      more DDL to that chain adds more ways for the application to fail to start.
//   4. A ROLLBACK WOULD HAVE NO OPERATOR. Re-deploying the previous image does not drop tables.
//
// So: an explicit command, run by a person, recorded by version, reversible by another command.
//
// ── USAGE ───────────────────────────────────────────────────────────────────
//
//   node scripts/migrate-connectors.js --check      preconditions + plan. NO WRITE. Safe anywhere.
//   node scripts/migrate-connectors.js --apply      applies, records the version, verifies
//   node scripts/migrate-connectors.js --status     what is recorded and what exists
//   node scripts/migrate-connectors.js --rollback --i-understand-this-drops-tables
//
// With no flag it prints this usage and exits 0 WITHOUT touching the database. A runner whose
// default behaviour is to migrate is a runner somebody will trigger by accident.
//
// Exit: 0 success · 1 refused or failed · 2 preconditions not met

const { Pool } = require('pg');
const { DDL, CONNECTOR_SEED, CONNECTOR_TABLES, GLOBAL_TABLES } = require('../src/lib/connectors/schema');

const VERSION = '2026-11-05.connectors.v1';
const ALL_TABLES = [...GLOBAL_TABLES, ...CONNECTOR_TABLES];

// Children before parents. Tested by check-connector-schema-db.js, not merely written down.
const ROLLBACK_ORDER = [
  'solicitation_amendments', 'solicitations', 'review_tasks', 'capability_scope_items',
  'verified_capabilities', 'eligibility_findings', 'eligibility_assessments',
  'funding_opportunity_versions', 'funding_opportunities', 'federal_awards',
  // No foreign keys at all — it holds public market data keyed by product service code — so it
  // drops anywhere. Listed before source_connectors to keep the file reading children-first.
  'psc_award_benchmarks',
  'source_sync_runs', 'source_connectors',
];

function bar(ch = '─') { return ch.repeat(78); }
function h(t) { console.log(`\n${bar()}\n${t}\n${bar()}`); }

function usage() {
  console.log(`
Connector schema migration runner — version ${VERSION}

  --check      verify preconditions and print the plan. Makes NO change.
  --apply      apply the migration, record the version, run verification
  --status     show what is recorded and what exists
  --rollback --i-understand-this-drops-tables
               drop the 13 tables in dependency order

Nothing happens without one of these. This runner is deliberately NOT wired into
server.js: a migration in a boot chain runs on every restart including a crash
loop, welds the migrate and deploy decisions together, and has no operator when
it needs to be reversed.
`);
}

async function preconditions(q) {
  const out = [];
  const exists = async (t) => (await q(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name=$1) p`, [t])).rows[0].p;

  // P1 — companies must exist. Eleven of the twelve tables carry
  // company_id NOT NULL REFERENCES companies(id); without it every CREATE fails.
  const hasCompanies = await exists('companies');
  out.push({
    id: 'P1', ok: hasCompanies,
    label: 'companies exists (migrateOffice has run)',
    detail: hasCompanies ? 'present' : 'ABSENT — 11 of 13 tables reference it; run migrateOffice first',
  });

  // P2 — THE ONE THAT IS EASY TO MISS. source_sync_runs gets a composite FK onto
  // agent_runs (run_id, company_id), which requires a UNIQUE constraint on that PAIR. It is added
  // by migrateOffice, not by runs.js, so a database with agent_runs but without migrateOffice
  // looks ready and is not.
  const uq = (await q(
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_agent_runs_run_company') p`)).rows[0].p;
  out.push({
    id: 'P2', ok: uq,
    label: 'uq_agent_runs_run_company exists (the composite FK target)',
    detail: uq ? 'present' : 'ABSENT — ALTER TABLE source_sync_runs ... MATCH FULL will fail. '
      + 'agent_runs alone is not enough; this constraint comes from migrateOffice.',
  });

  const hasRuns = await exists('agent_runs');
  out.push({
    id: 'P3', ok: hasRuns, label: 'agent_runs exists', detail: hasRuns ? 'present' : 'ABSENT',
  });

  return out;
}

async function recordTable(q) {
  // The runner owns its own ledger. One row per applied version, append-only in practice.
  await q(`CREATE TABLE IF NOT EXISTS schema_migrations (
             version     TEXT PRIMARY KEY,
             applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
             applied_by  TEXT
           )`);
}

async function status(q) {
  h(`STATUS — version ${VERSION}`);
  const recorded = (await q(
    'SELECT version, applied_at, applied_by FROM schema_migrations ORDER BY applied_at')
    .catch(() => ({ rows: null })));
  if (!recorded.rows) console.log('  schema_migrations: ABSENT (this runner has never applied anything here)');
  else if (!recorded.rows.length) console.log('  schema_migrations: present, no versions recorded');
  else for (const r of recorded.rows) console.log(`  recorded: ${r.version}  at ${r.applied_at.toISOString()}  by ${r.applied_by || 'UNKNOWN'}`);

  console.log('');
  let present = 0;
  for (const t of ALL_TABLES) {
    const p = (await q(`SELECT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name=$1) p`, [t])).rows[0].p;
    if (p) present += 1;
    console.log(`  ${p ? 'present' : 'ABSENT '}  ${t}`);
  }
  console.log(`\n  ${present} of ${ALL_TABLES.length} tables exist.`);
  // Recorded-but-absent is the state worth naming: it means somebody dropped tables without
  // rolling back the version, and a re-apply would be the only way out.
  const isRecorded = !!(recorded.rows && recorded.rows.some((r) => r.version === VERSION));
  if (isRecorded && present < ALL_TABLES.length) {
    console.log('  WARNING: this version is RECORDED but tables are missing. The ledger and the');
    console.log('  database disagree; investigate before applying anything.');
  }
  return { present, isRecorded };
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help')) { usage(); return 0; }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); return 1; }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /sslmode=disable/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  });
  const q = (sql, vals) => pool.query(sql, vals);

  try {
    if (argv.includes('--status')) { await status(q); return 0; }

    if (argv.includes('--rollback')) {
      if (!argv.includes('--i-understand-this-drops-tables')) {
        console.error('\nREFUSED: --rollback DROPS 13 TABLES AND EVERY ROW IN THEM.');
        console.error('Re-run with --i-understand-this-drops-tables if that is what you intend.\n');
        return 1;
      }
      h('ROLLBACK — dropping in dependency order');
      for (const t of ROLLBACK_ORDER) {
        await q(`DROP TABLE IF EXISTS ${t}`);
        console.log(`  dropped (if present)  ${t}`);
      }
      await q('DELETE FROM schema_migrations WHERE version = $1', [VERSION]).catch(() => {});
      console.log('\n  version record removed. companies and agent_runs are untouched.');
      return 0;
    }

    // ── --check and --apply both start here ────────────────────────────────
    h(`PRECONDITIONS — version ${VERSION}`);
    const pre = await preconditions(q);
    for (const p of pre) console.log(`  ${p.ok ? 'ok  ' : 'FAIL'}  ${p.id} ${p.label}\n          ${p.detail}`);
    const blocked = pre.filter((p) => !p.ok);

    h('PLAN');
    console.log(`  ${DDL.length} DDL statements`);
    console.log(`  ${ALL_TABLES.length} tables (${GLOBAL_TABLES.length} global, ${CONNECTOR_TABLES.length} tenant-scoped)`);
    console.log(`  ${CONNECTOR_SEED.length} connector seed rows`);
    console.log('  additive: no existing table is altered, nothing is dropped or rewritten');
    console.log(`  rollback: node scripts/migrate-connectors.js --rollback --i-understand-this-drops-tables`);

    if (blocked.length) {
      console.error(`\nNOT MET: ${blocked.length} precondition(s) failed. Nothing was applied.`);
      return 2;
    }
    console.log('\n  all preconditions met.');

    if (!argv.includes('--apply')) {
      console.log('\n  --check only. NOTHING WAS WRITTEN. Re-run with --apply to proceed.\n');
      return 0;
    }

    // ── apply ──────────────────────────────────────────────────────────────
    h('APPLYING');

    // SNAPSHOT BEFORE, SO THE VERIFICATION CAN COMPARE A DELTA RATHER THAN AN ABSOLUTE.
    //
    // This block exists because the verification below used to assert that the capability registry
    // held ZERO verified rows and that ZERO sync runs existed. Both were true only while the
    // product was unused. On 2026-11-09 Abiozen verified its first capability — a real ISO 9001
    // certificate — and the next deploy FAILED at the pre-deploy step with "1 capability row(s)
    // already read as verified". Nothing was wrong with the database; the migration was asserting
    // that the business had not started.
    //
    // CLAUDE.md states the rule this broke: "Never assert a table is empty. Assert *my fixtures
    // are gone*." and "Where a count has to be compared, compare a DELTA against what was already
    // there, not an absolute." The thing this check genuinely needs to prove is that MIGRATING
    // granted no evidence and ingested nothing — which is a before/after comparison, and stays
    // true for the life of the product.
    //
    // Counted with to_regclass so a fresh database, where these tables do not exist yet, reads 0
    // rather than raising — the first apply must not fail on the absence it is about to fix.
    const countIfExists = async (table, where) => {
      const present = (await q('SELECT to_regclass($1) IS NOT NULL AS p', [`public.${table}`])).rows[0].p;
      if (!present) return 0;
      return (await q(`SELECT COUNT(*)::int n FROM ${table}${where ? ` WHERE ${where}` : ''}`)).rows[0].n;
    };
    const before = {
      verified: await countIfExists('verified_capabilities', "verification_status='verified'"),
      syncs: await countIfExists('source_sync_runs'),
    };
    console.log(`  before: ${before.verified} verified capabilit${before.verified === 1 ? 'y' : 'ies'}, `
      + `${before.syncs} sync run(s) — the migration must not change either`);

    await recordTable(q);
    const already = (await q('SELECT version FROM schema_migrations WHERE version = $1', [VERSION])).rows[0];
    if (already) {
      console.log(`  version ${VERSION} is already recorded.`);
      console.log('  Re-applying anyway: every statement is IF NOT EXISTS / ADD CONSTRAINT-guarded,');
      console.log('  so this is idempotent. The point of continuing is that a PARTIAL apply — some');
      console.log('  tables created, then a failure — is repaired by running it again.');
    }

    const { migrateConnectors } = require('../src/lib/connectors/schema');
    await migrateConnectors(q);
    await q(
      `INSERT INTO schema_migrations (version, applied_by) VALUES ($1,$2)
       ON CONFLICT (version) DO NOTHING`,
      [VERSION, process.env.USER || process.env.MIGRATION_OPERATOR || 'unknown'],
    );
    console.log('  applied.');

    // ── verify, and read the result rather than assuming it ────────────────
    h('VERIFICATION');
    let failures = 0;
    const missing = [];
    for (const t of ALL_TABLES) {
      const p = (await q(`SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name=$1) p`, [t])).rows[0].p;
      if (!p) missing.push(t);
    }
    if (!missing.length) console.log(`  ok    all ${ALL_TABLES.length} tables exist`);
    else { console.log(`  FAIL  missing: ${missing.join(', ')}`); failures += 1; }

    const gen = (await q(`SELECT is_generated FROM information_schema.columns
      WHERE table_name='solicitations' AND column_name='response_open'`)).rows[0];
    if (gen && gen.is_generated === 'ALWAYS') console.log('  ok    solicitations.response_open is GENERATED — the biddability gate is not writable');
    else { console.log(`  FAIL  response_open is_generated = ${gen ? gen.is_generated : 'MISSING'}`); failures += 1; }

    const ev = (await q(`SELECT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname='verified_capabilities_verified_requires_evidence') p`)).rows[0].p;
    if (ev) console.log('  ok    the capability evidence constraint exists');
    else { console.log('  FAIL  verified_capabilities_verified_requires_evidence is MISSING'); failures += 1; }

    const sam = (await q("SELECT activated, daily_call_ceiling FROM source_connectors WHERE source_key='sam_gov'")).rows[0];
    if (sam && sam.activated === false && sam.daily_call_ceiling === null) {
      console.log('  ok    sam_gov landed INERT (activated=false, ceiling NULL) — ruling 9 item 7');
    } else { console.log(`  FAIL  sam_gov: ${JSON.stringify(sam)}`); failures += 1; }

    // DELTAS, NOT ABSOLUTES. "The migration granted no evidence" is a statement about what this
    // run did; "the registry is empty" is a statement about the business, and the migration has no
    // business asserting that. See the snapshot above for what asserting the absolute cost.
    const verified = (await q("SELECT COUNT(*)::int n FROM verified_capabilities WHERE verification_status='verified'")).rows[0].n;
    if (verified === before.verified) {
      console.log(`  ok    verified capabilities unchanged at ${verified} — the migration grants no evidence`);
    } else {
      console.log(`  FAIL  verified capabilities went ${before.verified} → ${verified}: MIGRATING CREATED EVIDENCE`);
      failures += 1;
    }

    const syncs = (await q('SELECT COUNT(*)::int n FROM source_sync_runs')).rows[0].n;
    if (syncs === before.syncs) {
      console.log(`  ok    sync runs unchanged at ${syncs} — nothing was ingested by migrating`);
    } else {
      console.log(`  FAIL  sync runs went ${before.syncs} → ${syncs}: MIGRATING INGESTED SOMETHING`);
      failures += 1;
    }

    console.log('');
    if (failures) {
      console.error(`  ${failures} verification failure(s). Consider rolling back.`);
      return 1;
    }
    console.log('  Migration complete and verified. The application is NOT deployed by this command,');
    console.log('  and SAM.gov remains inactive.\n');
    return 0;
  } finally {
    await pool.end();
  }
}

main()
  .then((c) => process.exit(c))
  .catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
