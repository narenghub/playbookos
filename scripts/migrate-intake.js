#!/usr/bin/env node
'use strict';
// ── VERSIONED MIGRATION RUNNER — MANUAL INTAKE (v3) ─────────────────────────
//
// Ruling 15 item 7: prepare the revised v3 migration, rollback guards, adversarial tests and
// production-restore verification. **DO NOT APPLY TO PRODUCTION.**
//
//   node scripts/migrate-intake.js                 usage; touches nothing
//   node scripts/migrate-intake.js --check         preconditions + plan; WRITES NOTHING
//   node scripts/migrate-intake.js --status        what is applied here now
//   node scripts/migrate-intake.js --apply         apply, then self-verify
//   node scripts/migrate-intake.js --rollback --i-understand-this-drops-tables
//
// Same shape as migrate-connectors.js and migrate-registrations.js, because ruling 10 item 3
// approved the versioned operator-run runner as the architecture and a third migration that worked
// differently would make that approval a one-off. Nothing here runs on server startup.
//
// ── THE ROLLBACK HAZARD IS A DIFFERENT ONE THIS TIME ────────────────────────
//
// v2's danger was a narrowed CHECK failing after tables had already been dropped. v3 is purely
// additive — no existing constraint changes — so that hazard is absent.
//
// The hazard here is worse in kind: **v3's tables hold human decisions.** A requirement somebody
// confirmed, a match somebody approved, an authorization somebody signed, and an append-only audit
// trail of all three. Dropping those is not reverting a schema change, it is destroying the record
// of what people decided — and an audit trail that can be removed by a revert was never an audit
// trail.
//
// So the guard counts human work FIRST and refuses the whole rollback if any exists, naming what it
// found. Same principle as v2: a rollback whose next step is "delete the decisions so the revert can
// finish" pressures the next person toward destroying data, and is worse than no rollback.
//
// Exit: 0 did what was asked · 1 failed · 2 refused (preconditions, or an unsafe rollback)

const { Client } = require('pg');
const schema = require('../src/lib/office/intake-schema');

const {
  VERSION, DDL, ROLLBACK_ORDER, ROLLBACK_EXTRA_DDL, CREATED_TABLES, PRECONDITIONS,
  INDICATIVE_CLASSES, SUFFICIENT_CLASSES,
} = schema;

const ACK = '--i-understand-this-drops-tables';

function bar(ch = '─') { return ch.repeat(78); }
function h(t) { console.log(`\n${bar()}\n${t}\n${bar()}`); }

function usage() {
  console.log(`
Manual-intake migration runner — version ${VERSION}

  --check      verify preconditions and print the plan. WRITES NOTHING.
  --status     report what this runner has applied to this database.
  --apply      apply the migration, then verify it.
  --rollback ${ACK}
               drop what this migration created — REFUSED if it holds human decisions.

No flag does nothing at all, on purpose: a migration runner that migrates when invoked bare is a
migration runner somebody runs by accident.
`);
}

async function tableExists(q, name) {
  const r = await q(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`, [name]);
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
  console.log(`  ${DDL.length} statements`);
  console.log(`  ${CREATED_TABLES.length} new tables: ${CREATED_TABLES.join(', ')}`);
  console.log('  8 new indexes');
  console.log("  1 seed row: source_connectors('manual')");
  console.log('');
  console.log('  PURELY ADDITIVE — no existing table is altered, no constraint is widened,');
  console.log('  nothing is dropped or rewritten.');
  console.log('');
  console.log('  The three concepts ruling 15 item 1 separates:');
  console.log('    evidence sufficiency  → requirement_matches.evidence_sufficient  (computed)');
  console.log('    eligibility           → qualify.js, from sufficiency              (computed)');
  console.log('    authorization to bid  → fulfillment_authorizations                (HUMAN ONLY)');
  console.log('');
  console.log(`  never sufficient : ${INDICATIVE_CLASSES.join(', ')}`);
  console.log(`  can be sufficient: ${SUFFICIENT_CLASSES.join(', ')}`);
  console.log('  ...and NONE of them authorizes a bid.');
  console.log('');
  console.log(`  rollback: node scripts/migrate-intake.js --rollback ${ACK}`);
  console.log('            REFUSED while any human decision exists in these tables.');
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
      console.log(`  ${r.version === VERSION ? '→' : ' '} ${r.version}  at ${new Date(r.applied_at).toISOString()}  by ${r.applied_by}`);
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
  if (await tableExists(q, 'source_connectors')) {
    const m = await q(`SELECT activated, kind FROM source_connectors WHERE source_key = 'manual'`);
    console.log(`\n  source_connectors('manual'): ${m.rows[0]
      ? `present, kind=${m.rows[0].kind}, activated=${m.rows[0].activated}` : 'ABSENT'}`);
  }
  return 0;
}

/**
 * Human decisions that a rollback would destroy. Returns [] when there are none.
 *
 * Counted BEFORE anything is dropped. A confirmed requirement, an approved match, an
 * authorization and the audit trail are all records of what a person decided — not derived data
 * that can be regenerated.
 */
async function humanWork(q) {
  const found = [];
  const probe = async (table, sql, label) => {
    if (!(await tableExists(q, table))) return;
    const n = (await q(sql)).rows[0].n;
    if (n > 0) found.push({ label, n });
  };
  await probe('solicitation_requirements',
    `SELECT COUNT(*)::int n FROM solicitation_requirements WHERE confirmed_by IS NOT NULL`,
    'requirements confirmed by a person');
  await probe('requirement_matches',
    `SELECT COUNT(*)::int n FROM requirement_matches WHERE approval_id IS NOT NULL`,
    'evidence matches carrying an approval');
  await probe('fulfillment_authorizations',
    `SELECT COUNT(*)::int n FROM fulfillment_authorizations`,
    'fulfillment authorizations (including revoked ones — the record of a revocation is itself history)');
  await probe('intake_audit',
    `SELECT COUNT(*)::int n FROM intake_audit`,
    'audit entries');
  // A manual solicitation is also human work: somebody entered it.
  if (await tableExists(q, 'solicitations')) {
    const n = (await q(`SELECT COUNT(*)::int n FROM solicitations WHERE source_key = 'manual'`)).rows[0].n;
    if (n > 0) found.push({ label: 'manually entered solicitations', n });
  }
  return found;
}

async function verify(q) {
  h('VERIFICATION');
  let fail = 0;
  const ok = (m) => console.log(`  ok    ${m}`);
  const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };

  const missing = [];
  for (const t of CREATED_TABLES) if (!(await tableExists(q, t))) missing.push(t);
  if (!missing.length) ok(`all ${CREATED_TABLES.length} tables exist`);
  else bad(`${missing.length} table(s) missing`, missing.join(', '));

  for (const [c, what] of [
    ['requirement_matches_indicative_never_sufficient',
      'a catalog listing, synthesis prediction or supplier relationship can NEVER be sufficient'],
    ['requirement_matches_sufficient_requires_evidence',
      'sufficiency requires a reference, an approval and a date'],
    ['requirement_matches_validity_window', 'a quote cannot be valid before it was issued'],
    ['fulfillment_authorizations_authorizer_present',
      'an authorization requires a person, an approval id and a stated scope'],
    ['intake_documents_clean_requires_storage',
      'a clean document must say where it is and when it was scanned'],
    ['intake_audit_decisions_have_approval',
      'a confirm, authorize or revoke entry must carry its approval'],
    ['solicitation_requirements_method_attributed',
      'a model-extracted requirement must name the model'],
    ['solicitation_requirements_tenant_fk', 'requirements cannot cross tenants (MATCH FULL)'],
    ['requirement_matches_tenant_fk', 'matches cannot cross tenants (MATCH FULL)'],
    ['fulfillment_authorizations_tenant_fk', 'authorizations cannot cross tenants (MATCH FULL)'],
  ]) {
    if (await constraintDef(q, c)) ok(what);
    else bad(`${c} is missing`, what);
  }

  // AUTHORIZATION MUST NOT BE DERIVABLE. There is no column anywhere outside
  // fulfillment_authorizations that could hold it, and that absence is the control.
  const strays = (await q(
    `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name <> 'fulfillment_authorizations'
         AND (column_name LIKE '%authorized_to_bid%' OR column_name LIKE '%bid_authorized%'
              OR column_name LIKE '%guaranteed%')`)).rows;
  if (!strays.length) {
    ok('no table outside fulfillment_authorizations has a bid-authorization or guarantee column');
  } else {
    bad(`${strays.length} stray authorization-like column(s)`,
      strays.map((r) => `${r.table_name}.${r.column_name}`).join(', '));
  }

  const manual = await q(`SELECT kind, activated FROM source_connectors WHERE source_key = 'manual'`);
  if (manual.rows[0] && manual.rows[0].kind === 'manual') {
    ok(`source_connectors('manual') seeded with kind='manual' (not 'procurement')`);
  } else bad(`the manual source row is absent or has the wrong kind`,
    manual.rows[0] ? `kind=${manual.rows[0].kind}` : 'absent');

  // The migration must grant nothing.
  for (const t of CREATED_TABLES) {
    if (!(await tableExists(q, t))) continue;
    const n = (await q(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
    if (n === 0) ok(`zero rows in ${t} — the migration records nothing`);
    else bad(`${n} row(s) in ${t} after migrating`, 'this migration must seed no records');
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
        console.log(`  This drops ${CREATED_TABLES.length} tables, including the audit trail.`);
        console.log(`  Re-run with ${ACK} if that is what you intend.`);
        return 2;
      }
      const work = await humanWork(q);
      if (work.length) {
        h('ROLLBACK REFUSED — HUMAN DECISIONS WOULD BE DESTROYED');
        console.log('  These tables hold what people decided, not data that can be regenerated:\n');
        for (const w of work) console.log(`    ${String(w.n).padStart(6)}  ${w.label}`);
        console.log('\n  Dropping them is not reverting a schema change. An audit trail that a');
        console.log('  revert can remove was never an audit trail, and the next step after a');
        console.log('  half-finished rollback would be deleting those rows so it could complete.');
        console.log('\n  Export or reassign them deliberately first, then re-run.');
        return 2;
      }
      h('ROLLING BACK');
      for (const t of ROLLBACK_ORDER) { await q(`DROP TABLE IF EXISTS ${t}`); console.log(`  dropped ${t}`); }
      for (const stmt of ROLLBACK_EXTRA_DDL) {
        await q(stmt);
        console.log(`  ran: ${stmt.split('\n')[0].trim().slice(0, 70)}`);
      }
      await q('DELETE FROM schema_migrations WHERE version = $1', [VERSION]).catch(() => {});
      console.log(`\n  ${VERSION} rolled back. Nothing else was touched.\n`);
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

    h('APPLYING');
    // Statement by statement, not one block: src/lib/db.js's migrateSchemas is a single
    // multi-statement query in one try/catch that only logs, and on an empty database one failing
    // ALTER aborted the whole block and silently skipped dozens of tables.
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
    console.log('\n  Migration complete and verified. Nothing is deployed, no document is stored,');
    console.log('  no requirement is confirmed, and nothing is authorized to bid.\n');
    return 0;
  } finally {
    await client.end().catch(() => {});
  }
}

main()
  .then((c) => process.exit(c))
  .catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
