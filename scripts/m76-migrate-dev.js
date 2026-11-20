#!/usr/bin/env node
// ── M7.6 PILOT TABLES, DEVELOPMENT ONLY ─────────────────────────────────────
//
//   node scripts/m76-migrate-dev.js                 # print the DDL, change nothing
//   M7_6_DEV_CONFIRM=yes node scripts/m76-migrate-dev.js --apply
//   M7_6_DEV_CONFIRM=yes node scripts/m76-migrate-dev.js --rollback
//   echo $?
//
// ── WHY THIS IS NOT IN migrate-all.js ───────────────────────────────────────
//
// It would run against production on the next deploy. The authorization for this work is explicit
// — "Do not modify production" — and a pilot's tables appearing in the production schema because
// somebody added them to the shared migration list is exactly how that happens without anyone
// deciding it. So the pilot's schema is applied deliberately, to a named development database, by
// a human, and it can be removed the same way.
//
// The refusals below are the same ones m7-5-dev-driver.js uses, for the same reason: this script
// creates tables, and the one run where it is pointed at the wrong database is the run nobody is
// expecting.

'use strict';

const SCHEMA = require('../src/lib/m76/schema');

const APPLY = process.argv.includes('--apply');
const ROLLBACK = process.argv.includes('--rollback');

const PRODUCTION_HOSTS = [
  'postgres.railway.internal',
  'interchange.proxy.rlwy.net',
];

function refuseUnlessDevelopment() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error('REFUSED: DATABASE_URL is not set. Point it at the DEVELOPMENT database.');
    process.exit(2);
  }
  let host = '';
  let name = '';
  try {
    const u = new URL(raw);
    host = u.hostname;
    name = u.pathname.replace(/^\//, '');
  } catch (_) {
    console.error('REFUSED: DATABASE_URL is not a URL this script can inspect.');
    process.exit(2);
  }
  for (const bad of PRODUCTION_HOSTS) {
    if (host === bad || host.endsWith(`.${bad}`)) {
      console.error(`REFUSED: ${host} is a production host. This script creates and drops tables.`);
      process.exit(2);
    }
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('REFUSED: NODE_ENV=production.');
    process.exit(2);
  }
  if ((APPLY || ROLLBACK) && process.env.M7_6_DEV_CONFIRM !== 'yes') {
    console.error('REFUSED: set M7_6_DEV_CONFIRM=yes to confirm this is the development database.');
    console.error(`         host=${host} database=${name || '(unnamed)'}`);
    process.exit(2);
  }
  return { host, name };
}

async function main() {
  const stmts = ROLLBACK ? SCHEMA.ROLLBACK : SCHEMA.DDL;
  const label = ROLLBACK ? 'ROLLBACK' : 'DDL';

  if (!APPLY && !ROLLBACK) {
    console.log(`\n── M7.6 pilot ${label} (${stmts.length} statement(s)) — NOTHING WAS APPLIED ──\n`);
    for (const s of stmts) console.log(`${s.replace(/\s+/g, ' ').trim()};\n`);
    console.log('Re-run with --apply (and M7_6_DEV_CONFIRM=yes) to execute.\n');
    return 0;
  }

  const { host, name } = refuseUnlessDevelopment();
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const query = (sql, params) => pool.query(sql, params);

  try {
    console.log(`\n── applying M7.6 ${label} to ${host}/${name} ──\n`);
    for (const s of stmts) {
      await query(s);
      console.log(`  ok    ${s.replace(/\s+/g, ' ').trim().slice(0, 90)}`);
    }

    // Verified by asking the catalog, not by the absence of an exception.
    const r = await query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name`,
      [SCHEMA.TABLES]);
    const present = r.rows.map((x) => x.table_name);
    console.log('');
    if (ROLLBACK) {
      if (present.length) {
        console.log(`FAIL  ${present.length} pilot table(s) still present: ${present.join(', ')}\n`);
        return 1;
      }
      console.log('OK  every M7.6 pilot table is gone.\n');
      return 0;
    }
    const missing = SCHEMA.TABLES.filter((t) => !present.includes(t));
    if (missing.length) {
      console.log(`FAIL  ${missing.length} table(s) were not created: ${missing.join(', ')}\n`);
      return 1;
    }
    console.log(`OK  all ${present.length} M7.6 pilot tables exist: ${present.join(', ')}\n`);
    return 0;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => { console.error(`\nERROR ${(e && e.stack) || e}\n`); process.exit(2); });
}

module.exports = { PRODUCTION_HOSTS };
