#!/usr/bin/env node
// ── DOES --status NOTICE AN INDEX THAT ISN'T THERE? ──────────────────────────
//
//   node scripts/check-migration-status-completeness-db.js; echo "EXIT=$?"
//
// Regression test for the false positive of 2026-11-15. On the day of the production migration,
// `migrate-outbound-ledger.js --status` reported
//
//     columns expected 15 / columns present 15
//     APPLIED — the outbound ledger schema is in place.          exit 0
//
// while `idx_email_log_one_claim_per_ref` did not exist. It counted columns and never looked at
// indexes or constraints.
//
// ── THE TEST IS THE EXACT CONDITION, NOT AN APPROXIMATION ───────────────────
//
// Phase A builds precisely that database: every one of the 15 declared columns present, and no
// index and no constraint. Then it asserts two things in the same breath —
//
//   * the corrected logic reports PARTIAL and exits 1, and
//   * the OLD column-only rule would have reported APPLIED and exited 0
//
// The second assertion is what makes this a regression test rather than a feature test. A test that
// only checks the new behaviour cannot tell you whether the bug is still reachable; this one
// reproduces the bug's own input and shows the old rule still falling for it.
//
// ── AND EVERY MISMATCH IS EXERCISED SEPARATELY ──────────────────────────────
//
// An index can be absent, present but not UNIQUE, present without its predicate, or present with a
// predicate covering the wrong outcomes. The third and fourth are the dangerous ones, because the
// index EXISTS and a check that stops at `indexname` would pass. Each is built as a real index in a
// real cluster and asserted on its own.
//
// Nothing here touches production. A disposable cluster, created and destroyed.
//
// EXIT 0 all invariants hold · 1 at least one does not · 3 no Postgres, nothing was proven

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');
const M = require('./migrate-outbound-ledger');
const SCHEMA = require('../src/lib/outbound/ledger-schema');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n  ── ${m} ──\n`);

let temp = null;
function startTemp() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/mig-status-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55949' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55949 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55949`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = startTemp();
if (!url) {
  console.log('  skip  no Postgres available');
  console.log('SKIP  migration-status completeness was NOT exercised — this proved nothing.');
  process.exit(EXIT_NOT_EXECUTED);
}

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: false, max: 4 });
  const query = (sql, params) => pool.query(sql, params);

  const req = M.requiredArtifacts();
  const assess = async () => {
    const got = await M.observe(query, req);
    const cmp = M.compare(req, got);
    return { got, cmp, v: M.verdictFor(cmp, 'status') };
  };
  /** The rule as it was before this fix: all declared columns present ⇒ APPLIED. */
  const oldRule = (got) => (got.columns.length === SCHEMA.ADDED_COLUMNS.length
    ? { verdict: 'APPLIED', exit: 0 } : { verdict: 'NOT APPLIED', exit: 2 });

  console.log('\n══ MIGRATION STATUS COMPLETENESS — REAL POSTGRES ══');

  // ── 0. THE EXPECTATION IS DERIVED, AND THE DERIVER IS NOT VACUOUS ────────
  head('0. the required artifacts come from SCHEMA.DDL, and the deriver proves it found them');
  if (req.indexes.length === 4 && req.constraints.length === 3 && req.columns.length === 15) {
    ok(`derived ${req.columns.length} column(s), ${req.indexes.length} index(es), ${req.constraints.length} constraint(s) from the DDL`);
  } else {
    bad(`derivation found ${req.columns.length}/${req.indexes.length}/${req.constraints.length}`,
      'expected 15 columns, 4 indexes, 3 constraints from the current DDL');
  }
  const uniq = req.indexes.find((i) => i.unique);
  if (uniq && uniq.name === 'idx_email_log_one_claim_per_ref' && uniq.predicate) {
    ok('the UNIQUE index and its predicate were read out of the DDL, not restated here');
  } else {
    bad('the unique index was not derived with its predicate');
  }
  if (!M.assertDerivable(req).length) ok('assertDerivable: no problems against the real DDL');
  else bad('assertDerivable complains about the real DDL', M.assertDerivable(req).join('; '));

  // CONTROL: a DDL the regex cannot parse must be CAUGHT, not silently skipped.
  const unparseable = ['CREATE UNIQUE INDEX CONCURRENTLY weird_idx ON email_log USING btree (claim_ref)'];
  const badReq = M.requiredArtifacts(unparseable);
  const problems = M.assertDerivable(badReq, unparseable);
  if (problems.length) {
    ok('control: a CREATE INDEX the deriver cannot parse is reported, not ignored');
    note(problems[0]);
  } else {
    bad('THE ANTI-VACUITY GUARD DOES NOT FIRE',
      'an unparseable CREATE INDEX produced an empty expectation and no complaint — every '
      + 'comparison below would then pass against nothing, which is the defect this file corrects');
  }

  // ── 1. THE FALSE POSITIVE, REPRODUCED ────────────────────────────────────
  head('1. THE REGRESSION: every column present, no index, no constraint');

  await query(`CREATE TABLE email_log (
     id TEXT PRIMARY KEY, to_email TEXT, subject TEXT, status TEXT, sent_at TEXT DEFAULT NOW())`);
  // Only the ADD COLUMN statements — the exact shape production was in on 2026-11-15.
  for (const sql of SCHEMA.DDL.filter((s) => /ADD COLUMN/i.test(s))) await query(sql);

  let { got, cmp, v } = await assess();
  if (got.columns.length !== SCHEMA.ADDED_COLUMNS.length) {
    bad(`the fixture did not create all ${SCHEMA.ADDED_COLUMNS.length} columns`, `${got.columns.length} present`);
  } else ok(`fixture built: all ${got.columns.length} declared columns present`);

  const idxPresent = got.indexes.filter((i) => req.indexes.some((r) => r.name === i.name)).length;
  if (idxPresent === 0) ok('and none of the declared indexes exist — the 2026-11-15 condition');
  else bad(`the fixture has ${idxPresent} declared index(es); it must have none`);

  const old = oldRule(got);
  if (old.verdict === 'APPLIED' && old.exit === 0) {
    ok('CONFIRMED: the OLD column-only rule reports APPLIED, exit 0 — the false positive is real');
    note('this is the assertion that makes this a regression test and not a feature test');
  } else {
    bad('the old rule no longer reproduces the false positive',
      `it reported ${old.verdict} — if the column set changed, re-derive this control rather than `
      + 'deleting it, or the regression becomes untestable');
  }

  if (v.verdict === 'PARTIAL' && v.exit === 1) {
    ok(`CORRECTED: the new logic reports PARTIAL, exit 1 (${cmp.missing.length} artifact(s) missing)`);
  } else {
    bad(`the corrected logic reports ${v.verdict} exit ${v.exit} — expected PARTIAL exit 1`,
      `missing: ${cmp.missing.join(', ') || 'none'}`);
  }
  if (cmp.missing.length === 7) ok('all 4 indexes and 3 constraints are named as missing');
  else bad(`${cmp.missing.length} missing reported, expected 7`, cmp.missing.join(', '));

  // ── 2. PARTIAL IS NOT "NOT APPLIED" ─────────────────────────────────────
  head('2. an untouched database is NOT APPLIED (exit 2) — the benign state keeps its verdict');
  await query('DROP TABLE email_log');
  await query(`CREATE TABLE email_log (
     id TEXT PRIMARY KEY, to_email TEXT, subject TEXT, status TEXT, sent_at TEXT DEFAULT NOW())`);
  ({ cmp, v } = await assess());
  if (v.verdict === 'NOT APPLIED' && v.exit === 2) {
    ok('nothing applied → NOT APPLIED, exit 2');
    note('kept distinct from PARTIAL on purpose: an unmigrated ledger fails closed and is safe,');
    note('whereas a half-applied one is a schema nobody decided.');
  } else bad(`reported ${v.verdict} exit ${v.exit} — expected NOT APPLIED exit 2`);

  // ── 3. FULLY APPLIED ────────────────────────────────────────────────────
  head('3. the full DDL applies and verifies clean — including the predicate');
  for (const sql of SCHEMA.DDL) await query(sql);
  ({ got, cmp, v } = await assess());
  if (v.verdict === 'APPLIED' && v.exit === 0) ok(`APPLIED, exit 0 — ${cmp.present} of ${cmp.total} artifacts`);
  else bad(`a correctly applied schema reported ${v.verdict}`, `missing: ${cmp.missing.join(', ')}; mismatched: ${cmp.mismatched.join(', ')}`);

  if (!cmp.mismatched.length) {
    ok('the predicate comparison does NOT false-positive on Postgres\'s own rendering');
    const live = got.indexes.find((i) => i.name === 'idx_email_log_one_claim_per_ref');
    note(`declared : WHERE ${uniq.predicate.slice(0, 60)}…`);
    note(`database : ${String(live && live.predicate).slice(0, 60)}…`);
    note('the two strings differ; the comparison is over literal and identifier SETS, which is why');
    note('a correctly applied index is not reported as a mismatch.');
  } else bad('a correctly applied index was reported as mismatched', cmp.mismatched.join('; '));

  // ── 4. AN INDEX THAT EXISTS BUT IS WRONG ────────────────────────────────
  head('4. an index whose NAME is right and whose definition is wrong');

  const IDX = 'idx_email_log_one_claim_per_ref';
  const recreate = async (sql) => { await query(`DROP INDEX IF EXISTS ${IDX}`); await query(sql); };

  // (a) absent
  await query(`DROP INDEX IF EXISTS ${IDX}`);
  ({ cmp, v } = await assess());
  if (v.verdict === 'PARTIAL' && cmp.missing.some((m) => m.includes(IDX))) {
    ok('dropped → PARTIAL, and the index is named as missing');
  } else bad(`dropping the unique index gave ${v.verdict}`, cmp.missing.join(', '));

  // (b) present but NOT UNIQUE — the dangerous one. A name check passes; it refuses nothing.
  await recreate(`CREATE INDEX ${IDX} ON email_log (claim_ref)
     WHERE claim_ref IS NOT NULL AND outcome IN ('CLAIMED','PROVIDER_ACCEPTED','OUTCOME_UNKNOWN','RECONCILED')`);
  ({ cmp, v } = await assess());
  if (cmp.mismatched.some((m) => /NOT UNIQUE/.test(m)) && v.exit !== 0) {
    ok('present but not UNIQUE → MISMATCHED, exit non-zero');
    note('a check on indexname alone would have passed this, and it would refuse no duplicate');
  } else bad('a NON-UNIQUE index of the right name was accepted', JSON.stringify(cmp.mismatched));

  // (c) UNIQUE but with no predicate — covers every row, not just claimed ones.
  await recreate(`CREATE UNIQUE INDEX ${IDX} ON email_log (claim_ref)`);
  ({ cmp, v } = await assess());
  if (cmp.mismatched.some((m) => /NO predicate/.test(m)) && v.exit !== 0) {
    ok('UNIQUE but unconditional → MISMATCHED (no predicate)');
  } else bad('an index missing its predicate was accepted', JSON.stringify(cmp.mismatched));

  // (d) UNIQUE, predicated, but one outcome short — RECONCILED missing.
  await recreate(`CREATE UNIQUE INDEX ${IDX} ON email_log (claim_ref)
     WHERE claim_ref IS NOT NULL AND outcome IN ('CLAIMED','PROVIDER_ACCEPTED','OUTCOME_UNKNOWN')`);
  ({ cmp, v } = await assess());
  if (cmp.mismatched.some((m) => /predicate differs/.test(m)) && v.exit !== 0) {
    ok('one outcome missing from the predicate → MISMATCHED (predicate differs)');
    note('this is the subtlest case: the index exists, is unique, is predicated, and silently');
    note('stops arbitrating the moment a claim is RECONCILED.');
  } else bad('a predicate covering the wrong outcomes was accepted', JSON.stringify(cmp.mismatched));

  // (e) restored
  await recreate(SCHEMA.DDL.find((s) => s.includes(IDX)));
  ({ cmp, v } = await assess());
  if (v.verdict === 'APPLIED') ok('restored to the declared definition → APPLIED');
  else bad('the declared index did not restore cleanly', JSON.stringify(cmp));

  // ── 5. A MISSING CONSTRAINT IS ALSO NOTICED ─────────────────────────────
  head('5. constraints are required too, not only indexes');
  await query('ALTER TABLE email_log DROP CONSTRAINT email_log_accepted_needs_time');
  ({ cmp, v } = await assess());
  if (v.verdict === 'PARTIAL' && cmp.missing.some((m) => m.includes('email_log_accepted_needs_time'))) {
    ok('a dropped CHECK constraint → PARTIAL, named');
  } else bad(`dropping a constraint gave ${v.verdict}`, cmp.missing.join(', '));

  // ── 6. THE LIMIT, STATED ────────────────────────────────────────────────
  head('6. what this comparison does NOT establish');
  note('predicateAgrees compares the SETS of string literals and identifiers, not logical');
  note('equivalence. A predicate using the same literals and columns recombined with different');
  note('logic — OR where the DDL says AND — would pass. Postgres renders IN as = ANY(ARRAY[…]),');
  note('so a literal comparison would fail on every correct index, and normalising the declared');
  note('side would need a database to parse it. This is the honest middle, written down rather');
  note('than glossed as "the predicate is verified".');

  await pool.end();
})()
  .then(() => {
    console.log();
    if (fail) { console.log(`FAIL  ${fail} invariant(s) do not hold.`); process.exit(1); }
    console.log('PASS  --status notices a missing, non-unique, unpredicated or wrongly-predicated');
    console.log('      index, distinguishes PARTIAL from NOT APPLIED, and the old column-only rule');
    console.log('      still demonstrably falls for the 2026-11-15 condition.');
    process.exit(0);
  })
  .catch((e) => { console.log(`\nINCOMPLETE  ${(e && e.stack) || e}`); process.exit(EXIT_NOT_EXECUTED); })
  .finally(stopTemp);
