#!/usr/bin/env node
'use strict';
// ── VERSIONED MIGRATION RUNNER — REGISTRATIONS, BRANDS, CAPABILITY KINDS ────
//
// Ruling 12 item 4: prepare migration v2. **DO NOT APPLY IT YET.**
//
// Same shape as scripts/migrate-connectors.js, deliberately: ruling 10 item 3 approved the
// versioned operator-run runner as the architectural approach, and a second migration that worked
// differently would make the approved pattern a one-off. Nothing here runs on server startup.
//
//   node scripts/migrate-registrations.js                 usage; touches nothing
//   node scripts/migrate-registrations.js --check         preconditions + plan; WRITES NOTHING
//   node scripts/migrate-registrations.js --status        what is applied here now
//   node scripts/migrate-registrations.js --apply         apply, then self-verify
//   node scripts/migrate-registrations.js --rollback --i-understand-this-drops-tables
//
// ── WHY ROLLBACK IS MORE DANGEROUS HERE THAN IT WAS IN v1 ───────────────────
//
// v1 was purely additive: rollback dropped tables it had created, and nothing else could be
// affected. This migration has ONE non-additive step — it widens the `kind` CHECK on
// `verified_capabilities` from two permitted values to seven. Widening forward is safe, because
// every value the old constraint allowed the new one allows too.
//
// NARROWING BACK IS NOT. If any row has meanwhile been written with one of the five new kinds —
// a certification, a regulatory authorization, equipment — then restoring the two-value CHECK
// fails, and it fails PART WAY THROUGH a rollback that has already dropped tables. The obvious
// response at that point is to delete the offending rows, which is to say: destroy real capability
// records to make a rollback succeed.
//
// So the runner counts those rows FIRST and refuses the whole rollback if any exist, naming them.
// A rollback that would pressure the next person into deleting data is worse than no rollback.
//
// Exit: 0 did what was asked · 1 failed · 2 refused (preconditions, or an unsafe rollback)

const { Client } = require('pg');
const schema = require('../src/lib/office/registration-schema');

const {
  VERSION, DDL, ROLLBACK_ORDER, ROLLBACK_CAPABILITY_DDL,
  CREATED_TABLES, CAPABILITY_KINDS, CAPABILITY_KINDS_BEFORE, PRECONDITIONS,
} = schema;

const NEW_KINDS = CAPABILITY_KINDS.filter((k) => !CAPABILITY_KINDS_BEFORE.includes(k));
const ACK = '--i-understand-this-drops-tables';

function bar(ch = '─') { return ch.repeat(78); }
function h(t) { console.log(`\n${bar()}\n${t}\n${bar()}`); }

function usage() {
  console.log(`
Registration & capability-kind migration runner — version ${VERSION}

  --check      verify preconditions and print the plan. WRITES NOTHING.
  --status     report what this runner has applied to this database.
  --apply      apply the migration, then verify it.
  --rollback ${ACK}
               drop what this migration created and restore the previous CHECK.

No flag does nothing at all, on purpose: a migration runner that migrates when invoked bare is a
migration runner somebody runs by accident.
`);
}

// One narrow question, asked one way. The first version of this had an unparenthesised OR/AND and
// then re-asked narrowly to correct for its own looseness, which is two chances to be wrong where
// one will do.
async function tableExists(q, name) {
  const r = await q(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`, [name],
  );
  return r.rows[0].n > 0;
}

async function constraintDef(q, name) {
  const r = await q(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [name],
  ).catch(() => ({ rows: [] }));
  return r.rows[0] ? r.rows[0].def : null;
}

async function preconditions(q) {
  h(`PRECONDITIONS — version ${VERSION}`);
  let bad = 0;
  for (const p of PRECONDITIONS) {
    const present = await tableExists(q, p.table);
    if (present) console.log(`  ok    ${p.name} ${p.what}\n          present`);
    else { bad++; console.log(`  FAIL  ${p.name} ${p.what}\n          ABSENT`); }
  }
  return bad;
}

function plan() {
  h('PLAN');
  console.log(`  ${DDL.length} DDL statements`);
  console.log(`  ${CREATED_TABLES.length} new tables: ${CREATED_TABLES.join(', ')}`);
  console.log(`  5 new indexes`);
  console.log(`  verified_capabilities.kind widened from ${CAPABILITY_KINDS_BEFORE.length} to `
    + `${CAPABILITY_KINDS.length} values`);
  console.log(`      adds: ${NEW_KINDS.join(', ')}`);
  console.log(`  verified_capabilities gains brand_id, composite-FK'd to company_brands`);
  console.log('');
  console.log('  additive EXCEPT the kind CHECK, which is widened (safe forward; see the header');
  console.log('  for why the reverse is guarded)');
  console.log(`  rollback: node scripts/migrate-registrations.js --rollback ${ACK}`);
}

async function status(q) {
  h(`STATUS — version ${VERSION}`);
  const recorded = await q(
    'SELECT version, applied_at, applied_by FROM schema_migrations ORDER BY applied_at',
  ).catch(() => ({ rows: null }));
  if (!recorded.rows) console.log('  schema_migrations: ABSENT (no runner has applied anything here)');
  else if (!recorded.rows.length) console.log('  schema_migrations: present, no versions recorded');
  else {
    for (const r of recorded.rows) {
      const mark = r.version === VERSION ? '→' : ' ';
      console.log(`  ${mark} ${r.version}  at ${new Date(r.applied_at).toISOString()}  by ${r.applied_by}`);
    }
  }
  console.log('');
  let present = 0;
  for (const t of CREATED_TABLES) {
    const e = await tableExists(q, t);
    if (e) present++;
    console.log(`  ${e ? 'present' : 'ABSENT '}  ${t}`);
  }
  console.log(`\n  ${present} of ${CREATED_TABLES.length} tables exist.`);
  const def = await constraintDef(q, 'verified_capabilities_kind_check');
  console.log(`\n  verified_capabilities_kind_check:`);
  console.log(`    ${def || 'ABSENT'}`);
  const widened = def && NEW_KINDS.every((k) => def.includes(`'${k}'`));
  console.log(`    → ${widened ? 'WIDENED (v2 applied)' : 'not widened'}`);
  return 0;
}

/**
 * Count capability rows using a kind that only exists after this migration.
 *
 * This is the rollback guard. Returns null if the table is absent (nothing to protect).
 */
async function newKindRows(q) {
  const exists = await tableExists(q, 'verified_capabilities');
  if (!exists) return null;
  const r = await q(
    `SELECT kind, COUNT(*)::int AS n FROM verified_capabilities
       WHERE kind = ANY($1) GROUP BY kind ORDER BY kind`, [NEW_KINDS],
  );
  return r.rows;
}

async function verify(q) {
  h('VERIFICATION');
  let fail = 0;
  const ok = (m) => console.log(`  ok    ${m}`);
  const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };

  let missing = [];
  for (const t of CREATED_TABLES) if (!(await tableExists(q, t))) missing.push(t);
  if (!missing.length) ok(`all ${CREATED_TABLES.length} tables exist`);
  else bad(`${missing.length} table(s) missing`, missing.join(', '));

  const def = await constraintDef(q, 'verified_capabilities_kind_check');
  if (def && NEW_KINDS.every((k) => def.includes(`'${k}'`))) {
    ok(`the kind CHECK accepts all ${CAPABILITY_KINDS.length} kinds`);
  } else bad('the kind CHECK was not widened', def || 'constraint absent');

  const brandCol = await q(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'verified_capabilities' AND column_name = 'brand_id'`);
  if (brandCol.rows[0].n === 1) ok('verified_capabilities.brand_id exists');
  else bad('verified_capabilities.brand_id is missing');

  for (const [c, what] of [
    ['company_brands_legal_entity_requires_evidence',
      'a brand cannot be declared a separate legal entity without evidence and an approval'],
    ['company_registrations_verified_requires_evidence',
      'a registration cannot be verified without evidence, an approval and an expiry'],
    ['company_registration_observations_tenant_fk',
      'observations cannot cross tenants (composite FK, MATCH FULL)'],
    ['verified_capabilities_brand_tenant_fk',
      'a capability cannot be attributed to another tenant\'s brand'],
  ]) {
    if (await constraintDef(q, c)) ok(what);
    else bad(`${c} is missing`, what);
  }

  // The migration must grant nothing. A migration that creates a verified row would be handing out
  // the very evidence these constraints exist to require.
  for (const [t, label] of [
    ['company_registrations', 'registrations'],
    ['company_brands', 'brands'],
  ]) {
    if (!(await tableExists(q, t))) continue;
    const n = (await q(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n;
    if (n === 0) ok(`zero ${label} — the migration records nothing and verifies nothing`);
    else bad(`${n} ${label} row(s) exist after migrating`, 'this migration must seed nothing');
  }
  return fail;
}

async function main() {
  const argv = process.argv.slice(2);
  const want = (f) => argv.includes(f);
  if (!argv.length || (!want('--check') && !want('--apply') && !want('--status') && !want('--rollback'))) {
    usage();
    return 0;
  }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); return 1; }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: /sslmode=disable/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  const q = (sql, params) => client.query(sql, params);

  try {
    if (want('--status')) return await status(q);

    if (want('--rollback')) {
      if (!want(ACK)) {
        h('ROLLBACK REFUSED');
        console.log(`  This drops ${CREATED_TABLES.length} tables and narrows a CHECK constraint.`);
        console.log(`  Re-run with ${ACK} if that is what you intend.`);
        return 2;
      }
      // THE GUARD. Counted before anything is dropped.
      const rows = await newKindRows(q);
      if (rows && rows.length) {
        h('ROLLBACK REFUSED — DATA WOULD HAVE TO BE DESTROYED');
        console.log('  verified_capabilities holds rows whose kind only exists after this');
        console.log('  migration. Restoring the previous CHECK would fail, and it would fail after');
        console.log('  the tables had already been dropped:\n');
        for (const r of rows) console.log(`    ${r.kind.padEnd(26)} ${r.n} row(s)`);
        console.log('\n  The next step at that point would be deleting those rows to make the');
        console.log('  rollback succeed — destroying real capability records for the sake of a');
        console.log('  revert. Refusing instead. Re-classify or remove them deliberately first.');
        return 2;
      }
      h('ROLLING BACK');
      for (const stmt of ROLLBACK_CAPABILITY_DDL) { await q(stmt); console.log(`  ran: ${stmt.split('\n')[0].trim().slice(0, 70)}`); }
      for (const t of ROLLBACK_ORDER) { await q(`DROP TABLE IF EXISTS ${t}`); console.log(`  dropped ${t}`); }
      await q('DELETE FROM schema_migrations WHERE version = $1', [VERSION]).catch(() => {});
      console.log(`\n  ${VERSION} rolled back. companies and verified_capabilities are intact.\n`);
      return 0;
    }

    const bad = await preconditions(q);
    plan();
    if (bad) {
      console.log(`\n  ${bad} precondition(s) failed. NOTHING WAS WRITTEN.`);
      console.log('  This is the wrong database, or an earlier migration has not run here.\n');
      return 2;
    }
    console.log('\n  all preconditions met.\n');

    if (want('--check')) {
      console.log('  --check only. NOTHING WAS WRITTEN. Re-run with --apply to proceed.\n');
      return 0;
    }

    const already = (await q(
      'SELECT version FROM schema_migrations WHERE version = $1', [VERSION],
    ).catch(() => ({ rows: [] }))).rows[0];

    h('APPLYING');
    if (already) console.log(`  version ${VERSION} is already recorded — re-running is idempotent.`);
    // Statement by statement, not one block. src/lib/db.js's migrateSchemas is a single
    // multi-statement query in one try/catch that only logs, and on an empty database one failing
    // ALTER aborted the whole block and silently skipped dozens of tables. Separate statements mean
    // a failure names itself.
    for (const stmt of DDL) await q(stmt);
    console.log('  applied.');

    await q(`CREATE TABLE IF NOT EXISTS schema_migrations (
               version TEXT PRIMARY KEY,
               applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
               applied_by TEXT)`);
    await q(
      `INSERT INTO schema_migrations (version, applied_by) VALUES ($1,$2)
         ON CONFLICT (version) DO NOTHING`,
      [VERSION, process.env.MIGRATION_OPERATOR || process.env.USER || 'unknown'],
    );

    const failures = await verify(q);
    if (failures) {
      console.log(`\n  ${failures} verification failure(s). The migration is PARTIAL.\n`);
      return 1;
    }
    console.log('\n  Migration complete and verified. Nothing is deployed by this command, no');
    console.log('  registration is recorded, and no capability is verified.\n');
    return 0;
  } finally {
    await client.end().catch(() => {});
  }
}

main()
  .then((c) => process.exit(c))
  .catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
