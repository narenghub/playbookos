#!/usr/bin/env node
// ── CREATE A READ-ONLY DATABASE ROLE, ONCE ───────────────────────────────────
//
//   railway ssh 'node scripts/grant-readonly-access.js'
//
// Prints a connection string. Safe to re-run: it rotates the password rather than failing.
//
// ── WHY READ-ONLY AND NOT A RAILWAY TOKEN ───────────────────────────────────
//
// `railway ssh` authenticates against a USER account and a registered SSH key, so a project token
// cannot drive it — and `railway run` would only inject DATABASE_URL, which points at
// postgres.railway.internal and is unreachable from outside the Railway network. The workable path
// is a direct Postgres connection over the public TCP proxy.
//
// So the credential is scoped as narrowly as the job needs: SELECT on the public schema, nothing
// else. It can run every preview, census and reconciliation query. It CANNOT run the E1 migration,
// cannot write a molecule, cannot alter a table and cannot resolve a quarantine. That matches
// exactly where the governance currently stands — the migration is not authorised — and it means
// the credential cannot be used to do the one thing nobody has approved yet.
//
// This is the ONLY write this script performs, and it touches no application data: it creates a
// role and grants SELECT. No table, row, index or trigger is altered.
//
// ── ROTATE IT AFTERWARDS ────────────────────────────────────────────────────
//
// The string this prints will sit in a chat transcript. That is a real exposure, however narrow
// the grant, and this repo spent P0.1 getting plaintext credentials out of a handoff document.
// When the identity work is finished, revoke it:
//
//   railway ssh 'node scripts/grant-readonly-access.js --revoke'
'use strict';

const crypto = require('crypto');
const { initDB, query } = require('../src/lib/db');

const ROLE = 'playnexa_ro';
const args = process.argv.slice(2);
const REVOKE = args.includes('--revoke');
for (const a of args) {
  if (!['--revoke'].includes(a)) { console.error(`unknown flag ${a}`); process.exit(2); }
}

async function main() {
  await initDB();

  if (REVOKE) {
    // Order matters: privileges first, then the role itself, or the DROP is refused.
    await query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ROLE}`).catch(() => {});
    await query(`REVOKE ALL ON SCHEMA public FROM ${ROLE}`).catch(() => {});
    await query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM ${ROLE}`).catch(() => {});
    await query(`DROP ROLE IF EXISTS ${ROLE}`);
    console.log(`\n✅ ${ROLE} revoked and dropped. Any connection string for it is now dead.\n`);
    return;
  }

  // 32 bytes of CSPRNG, base64url. Generated here rather than typed, so a weak or reused password
  // is not possible and it never passes through a shell history.
  const pw = crypto.randomBytes(32).toString('base64url');

  const exists = await query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [ROLE]);
  if (exists.rowCount) {
    await query(`ALTER ROLE ${ROLE} WITH LOGIN PASSWORD '${pw}'`);
    console.log(`\n   ${ROLE} already existed — password rotated, old string is now dead.`);
  } else {
    await query(`CREATE ROLE ${ROLE} WITH LOGIN PASSWORD '${pw}'`);
    console.log(`\n   ${ROLE} created.`);
  }

  const db = (await query(`SELECT current_database() d`)).rows[0].d;
  await query(`GRANT CONNECT ON DATABASE ${db} TO ${ROLE}`);
  await query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  await query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
  // So tables created later (the molecules spine, for one) are readable without re-granting.
  await query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${ROLE}`);

  // Prove the grant is actually read-only rather than asserting it. A role whose writes are only
  // "expected" to fail is a role nobody has tested.
  const canWrite = (await query(`
    SELECT has_table_privilege($1, 'public.clinical_studies', 'INSERT') ins,
           has_table_privilege($1, 'public.clinical_studies', 'UPDATE') upd,
           has_table_privilege($1, 'public.clinical_studies', 'DELETE') del,
           has_table_privilege($1, 'public.clinical_studies', 'SELECT') sel`, [ROLE])).rows[0];
  const ok = canWrite.sel === true && canWrite.ins === false
    && canWrite.upd === false && canWrite.del === false;

  const host = process.env.RAILWAY_TCP_PROXY_DOMAIN || null;
  const port = process.env.RAILWAY_TCP_PROXY_PORT || null;

  console.log(`\n   privileges on a sample table: SELECT=${canWrite.sel} INSERT=${canWrite.ins} `
    + `UPDATE=${canWrite.upd} DELETE=${canWrite.del}`);
  console.log(`   ${ok ? '✅ read-only confirmed by the database itself' : '✗ NOT read-only — do not share this string'}`);
  if (!ok) process.exit(1);

  console.log('\n── the connection string ──\n');
  if (host && port) {
    console.log(`   postgresql://${ROLE}:${pw}@${host}:${port}/${db}?sslmode=require\n`);
  } else {
    console.log(`   postgresql://${ROLE}:${pw}@HOST:PORT/${db}?sslmode=require\n`);
    console.log('   Replace HOST:PORT with the Postgres service\'s public proxy, which this');
    console.log('   container cannot see from the app service. In Railway: open the Postgres');
    console.log('   service -> Variables, and use RAILWAY_TCP_PROXY_DOMAIN and');
    console.log('   RAILWAY_TCP_PROXY_PORT (or copy the host and port out of DATABASE_PUBLIC_URL).\n');
  }
  console.log('   This role can run every preview, census and reconciliation query.');
  console.log('   It CANNOT run the E1 migration, write a molecule, alter a table or resolve a');
  console.log('   quarantine — so handing it over does not authorise the migration.\n');
  console.log('   When the identity work is done:');
  console.log('     railway ssh \'node scripts/grant-readonly-access.js --revoke\'\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`\n✗ could not grant: ${e && e.message ? e.message : e}\n`);
  process.exit(1);
});
