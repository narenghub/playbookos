#!/usr/bin/env node
// ── AN INDEPENDENT READ OF THE CONSTRAINT ────────────────────────────────────
//
//   node scripts/verify-inquiry-direction-constraint.js
//
// READ-ONLY. No ALTER, no INSERT, no UPDATE, no DELETE. Exits 0 when the constraint admits
// 'outbound_pending', 1 when it does not, 2 when it cannot tell.
//
// ── WHY THIS IS A SECOND FILE AND NOT A FLAG ─────────────────────────────────
//
// CEO ruling 2026-11-11: "independently inspect the PostgreSQL constraint using a separate
// read-only query rather than relying solely on the migration script."
//
// That is right, and my runbook had it wrong. Step C-6 re-ran the migration script and accepted
// "ALREADY APPLIED" as verification — which asks the thing that performed the change whether the
// change happened. If its definition-matching logic were wrong, it would be wrong in both
// directions and report success either way.
//
// So this file SHARES NO CODE with migrate-inquiry-direction-check.js. It requires none of its
// modules, writes the catalog query in its own words, and parses the result with its own logic.
// Two independent readings that agree are evidence; one reading taken twice is not.
//
// ── WHAT IT CHECKS, AND WHAT THAT PROVES ─────────────────────────────────────
//
// pg_constraint is where PostgreSQL stores the predicate it actually enforces, so reading it is
// not an approximation of the behaviour — it IS the behaviour. The test is on the PARSED value
// list, not on a substring: `CHECK (direction <> 'outbound_pending')` also contains the word and
// means the opposite.

'use strict';

const TABLE = 'inquiry_messages';
const CONSTRAINT = 'inquiry_messages_direction_check';
const MUST_ADMIT = 'outbound_pending';
const EXPECTED = ['inbound', 'outbound', 'outbound_pending'];

/**
 * The values a `CHECK (col = ANY (ARRAY[...]))` or `CHECK (col IN (...))` predicate allows.
 *
 * Returns null when the shape is not recognised — reported as UNDETERMINED rather than as a
 * failure. "I do not understand this predicate" and "this predicate forbids the value" are
 * different findings and must not share an exit code.
 */
function allowedValues(def) {
  if (!def) return null;
  // Postgres normalises `IN (…)` to `= ANY (ARRAY[…])`, but accept both spellings.
  const anyArray = /=\s*ANY\s*\(\s*ARRAY\s*\[([^\]]*)\]/i.exec(def);
  const inList = /\bIN\s*\(([^)]*)\)/i.exec(def);
  const body = (anyArray && anyArray[1]) || (inList && inList[1]);
  if (!body) return null;
  const vals = [];
  const re = /'((?:[^']|'')*)'/g;
  let m;
  while ((m = re.exec(body)) !== null) vals.push(m[1].replace(/''/g, "'"));
  return vals.length ? vals : null;
}

async function main() {
  const { Pool } = require('pg');
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('no MIGRATION_DATABASE_URL or DATABASE_URL');
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url });

  let code = 2;
  try {
    // Declared read-only at the session level. Belt and braces on a file whose entire contract is
    // that it writes nothing: the server would refuse a write even if this code changed.
    await pool.query('SET default_transaction_read_only = on');

    const who = (await pool.query(
      'SELECT current_user AS role, current_database() AS db, current_schema() AS schema')).rows[0];

    const r = await pool.query(
      `SELECT c.conname, c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS def,
              pg_get_userbyid(rel.relowner) AS owner
         FROM pg_constraint c
         JOIN pg_class rel ON rel.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = current_schema() AND rel.relname = $1 AND c.conname = $2`,
      [TABLE, CONSTRAINT]);

    console.log('\n── independent constraint verification (read-only)\n');
    console.log(`   database ${who.db} · schema ${who.schema} · role ${who.role}`);

    if (!r.rows.length) {
      console.log(`\n   UNDETERMINED — no constraint ${CONSTRAINT} on ${TABLE} in this schema.`);
      console.log('   Either the migration has not run, or the table or constraint is named');
      console.log('   differently here than this check expects.\n');
      await pool.end();
      process.exit(2);
    }

    const row = r.rows[0];
    console.log(`   table owner ${row.owner}`);
    console.log(`   type ${row.contype} · validated ${row.convalidated}`);
    console.log(`\n   ${row.def}\n`);

    const vals = allowedValues(row.def);
    if (!vals) {
      console.log('   UNDETERMINED — the predicate is not a recognised value list, so this check');
      console.log('   cannot say what it admits. Read it by eye; do not treat this as a pass.\n');
      await pool.end();
      process.exit(2);
    }

    console.log(`   admits: ${vals.join(', ')}`);

    // NOT VALID is a real distinction: such a constraint is enforced for new rows but was never
    // checked against existing ones, so reporting it as simply "present" would overstate it.
    if (row.convalidated === false) {
      console.log('\n   WARNING — this constraint is NOT VALID: enforced for new rows, never');
      console.log('   validated against the existing ones.');
    }

    const admits = vals.includes(MUST_ADMIT);
    const unexpected = vals.filter((v) => !EXPECTED.includes(v));
    const missing = EXPECTED.filter((v) => !vals.includes(v));

    if (admits && !unexpected.length && !missing.length) {
      console.log(`\n   PASS — the constraint admits exactly ${EXPECTED.join(', ')}.\n`);
      code = 0;
    } else if (admits) {
      console.log(`\n   PASS WITH DIFFERENCES — '${MUST_ADMIT}' is admitted, but the value set is`);
      console.log('   not exactly what was expected.'
        + `${unexpected.length ? `\n   unexpected: ${unexpected.join(', ')}` : ''}`
        + `${missing.length ? `\n   missing: ${missing.join(', ')}` : ''}\n`);
      code = 0;
    } else {
      console.log(`\n   FAIL — the constraint does NOT admit '${MUST_ADMIT}'. A held buyer draft`);
      console.log('   cannot be recorded, and the application will refuse to start.\n');
      code = 1;
    }
  } catch (e) {
    console.error(`\n   UNDETERMINED — the catalog could not be read: ${(e && e.message) || e}\n`);
    code = 2;
  }

  await pool.end().catch(() => {});
  process.exit(code);
}

module.exports = { allowedValues, TABLE, CONSTRAINT, MUST_ADMIT, EXPECTED };

if (require.main === module) {
  main().catch((e) => {
    console.error('verify-inquiry-direction-constraint failed:', (e && e.message) || e);
    process.exit(2);
  });
}
