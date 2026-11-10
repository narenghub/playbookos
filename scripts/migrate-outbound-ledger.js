#!/usr/bin/env node
// ── OUTBOUND LEDGER MIGRATION — PREPARED, NOT EXECUTED ───────────────────────
//
//   node scripts/migrate-outbound-ledger.js --status     report, change nothing   (default)
//   node scripts/migrate-outbound-ledger.js --apply      apply the DDL
//   node scripts/migrate-outbound-ledger.js --rollback   remove exactly what --apply added
//
// CEO authorization 2026-11-10, S1.1 item 6: "If a production migration is required, prepare it
// but do not execute it." So the DEFAULT IS A REPORT. Applying takes an explicit flag, and the
// flag is not something a deploy can supply — db.js's boot block deliberately does not contain
// this DDL, because a migration that runs by the act of deploying is a migration nobody decided.
//
// Exit 0 = the reported state is as expected. Exit 1 = a failure. Exit 2 = --status found the
// schema NOT applied, which is information rather than an error, and distinguishable from both.

'use strict';

const SCHEMA = require('../src/lib/outbound/ledger-schema');

const MODE = process.argv.includes('--apply') ? 'apply'
  : process.argv.includes('--rollback') ? 'rollback' : 'status';

async function main() {
  const { query } = require('../src/lib/db');

  const applied = async () => {
    const r = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = $1 AND column_name = ANY($2)`,
      [SCHEMA.TABLE, SCHEMA.ADDED_COLUMNS]);
    return r.rows.map((x) => x.column_name);
  };

  const have = await applied();
  const missing = SCHEMA.ADDED_COLUMNS.filter((c) => !have.includes(c));

  console.log(`\n  table            ${SCHEMA.TABLE}`);
  console.log(`  columns expected ${SCHEMA.ADDED_COLUMNS.length}`);
  console.log(`  columns present  ${have.length}`);
  if (missing.length) console.log(`  missing          ${missing.join(', ')}`);

  if (MODE === 'status') {
    if (!missing.length) {
      console.log('\nAPPLIED — the outbound ledger schema is in place.\n');
      process.exit(0);
    }
    console.log('\nNOT APPLIED — this is a report, nothing was changed.');
    console.log('  The ledger FAILS CLOSED: with the schema absent, consequential email is');
    console.log('  refused rather than sent unrecorded. Apply with --apply when authorized.\n');
    process.exit(2);
  }

  const stmts = MODE === 'apply' ? SCHEMA.DDL : SCHEMA.ROLLBACK;
  console.log(`\n  ${MODE}: ${stmts.length} statement(s)\n`);
  for (const sql of stmts) {
    try {
      await query(sql);
      console.log(`  ok    ${sql.replace(/\s+/g, ' ').slice(0, 96)}`);
    } catch (e) {
      // Idempotent by construction, but a genuine failure must stop rather than be summarised at
      // the end — the next statement may depend on this one.
      console.log(`  FAIL  ${sql.replace(/\s+/g, ' ').slice(0, 96)}\n        ${e.message}`);
      process.exit(1);
    }
  }

  const after = await applied();
  const ok = MODE === 'apply'
    ? after.length === SCHEMA.ADDED_COLUMNS.length
    : after.length === 0;
  console.log(ok
    ? `\nPASS  ${MODE} complete — ${after.length} of this migration's column(s) present.\n`
    : `\nFAIL  ${MODE} left ${after.length} column(s) present, which is not the expected end state.\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('migrate-outbound-ledger failed:', e && e.message); process.exit(1); });
