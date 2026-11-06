#!/usr/bin/env node
'use strict';
// ── 125 → 138: WHERE DID THE THIRTEENTH TABLE COME FROM? ────────────────────
//
//   node scripts/reconcile-table-baseline.js prod-YYYYMMDD-HHMM.dump
//   echo $?
//
// Ruling item 4: reconcile the reported 138-table migration baseline against the previously
// recorded 137, and identify the additional table BEFORE Gate 3 approval.
//
// ── THE DISCREPANCY, AND WHOSE IT IS ────────────────────────────────────────
//
// On 2026-11-05 production measured **125** public tables, directly, before any connector
// migration. `2026-11-05.connectors.v1` creates **12** tables. I therefore predicted **137** and
// wrote that figure into the Gate 3 checklist. The restored dump reads **138**.
//
// The error is mine and it is arithmetic, not a stray object: I counted the twelve tables the
// migration creates and forgot the table the RUNNER creates to record that it ran —
// `schema_migrations`. 125 + 12 + 1 = 138.
//
// ── WHY THIS IS A SCRIPT AND NOT A SENTENCE ─────────────────────────────────
//
// Because "I know where the extra table came from" is exactly the kind of claim that has been
// wrong twice in this release already — the 137, and the "~66 tables" in ENG-001 that had to be
// withdrawn for having no measurement behind it. An explanation that sounds right is not a
// reconciliation. This one closes the identity against the dump:
//
//     tables in the dump  −  the 13 this migration is responsible for  =  125
//
// If that subtraction does not land on the independently measured baseline, something ELSE is in
// there and Gate 3 should not proceed. The script exits non-zero in that case and says so, rather
// than printing a number for a person to eyeball.
//
// It also names all thirteen, so "the additional table" is identified by name and not by count.
//
// ── READ-ONLY, AND NEVER AGAINST PRODUCTION ─────────────────────────────────
//
// No production connection is opened: the dump is read from disk and restored into a cluster this
// script creates and destroys. Every statement it runs is a SELECT.
//
// Exit: 0 the arithmetic closes · 1 it does not, or an expected table is missing · 3 did not execute

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');
const R = require('./lib/restore');
const { CONNECTOR_TABLES, GLOBAL_TABLES } = require('../src/lib/connectors/schema');

const PGPORT = 55997;

// The figure measured directly against production on 2026-11-05, before connectors.v1, by
// `SELECT count(*) FROM information_schema.tables WHERE table_schema='public'`. It is the anchor
// this reconciliation is checked against, so it is named rather than recomputed.
const DEFAULT_BASELINE = 125;

// --expect-baseline=N exists so the SUCCESS path of this check can be exercised against a
// non-production dump. Handing over a script whose green branch has never run is its own kind of
// unverified claim. A production run omits it, and the report says which anchor was used, so a
// reconciliation done against an invented baseline cannot be mistaken for one done against the
// measured figure.
const baselineArg = (process.argv.find((a) => /^--expect-baseline=/.test(a)) || '').split('=')[1];
const MEASURED_BASELINE = baselineArg ? Number(baselineArg) : DEFAULT_BASELINE;
const BASELINE_IS_MEASURED = !baselineArg;

// ── THE PREDICATE HAS TO MATCH THE ONE THE BASELINE WAS COUNTED WITH ───────
//
// The 125 was measured on production with
//
//     SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
//
// and that view — information_schema.tables — INCLUDES VIEWS. The first version of this script
// counted `AND table_type = 'BASE TABLE'`, got 137 where verify-restore.js had reported 138 for
// the same dump, and reported a phantom surplus of one.
//
// Both numbers were right. 138 total relations = 137 base tables + 1 view. The error was comparing
// a base-tables-only count against a baseline that counted views too — two numbers arrived at by
// different predicates, which is the same mistake as the 137 it was written to investigate.
//
// So the reconciliation is done on the baseline's own predicate, and the composition is printed
// so the difference between the two figures is visible rather than confusing.

// What connectors.v1 is responsible for: the tables it creates, plus the one its runner creates to
// record itself. The runner's table is the whole discrepancy and is listed separately so it cannot
// be quietly folded into the migration's own count again.
const V1_TABLES = [...GLOBAL_TABLES, ...CONNECTOR_TABLES];
const RUNNER_TABLES = ['schema_migrations'];

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 400)}`); };
const bar = () => '─'.repeat(78);
const h = (t) => console.log(`\n${bar()}\n${t}\n${bar()}`);

const dumpPath = process.argv[2];
if (!dumpPath) {
  console.error(`
Usage: node scripts/reconcile-table-baseline.js <production-dump>

  DUMP=$(ls -t prod-*.dump | head -1)
  node scripts/reconcile-table-baseline.js "$DUMP"

Never connects to production. Restores the dump into a cluster it creates and destroys,
and runs SELECTs only.
`);
  process.exit(1);
}
if (!fs.existsSync(dumpPath)) {
  if (!R.reportPlaceholder(dumpPath, process.argv[1])) {
    console.error(`dump file not found: ${dumpPath}`);
  }
  process.exit(1);
}

async function main() {
  const stat = fs.statSync(dumpPath);
  h('TABLE BASELINE RECONCILIATION — 125 → 138');
  console.log(`  dump      : ${path.resolve(dumpPath)}`);
  console.log(`  size      : ${(stat.size / 1048576).toFixed(2)} MiB`);
  console.log(`  taken     : ${stat.mtime.toISOString()}`);
  console.log(`  baseline  : ${MEASURED_BASELINE} tables${BASELINE_IS_MEASURED
    ? ', measured directly on production 2026-11-05'
    : ' — SUPPLIED VIA --expect-baseline, NOT the measured production figure'}`);
  console.log('');
  console.log('  SELECTs only, against a restored copy. Production is never connected to.');

  const archive = R.archiveVersion(dumpPath);
  const chosen = R.toolchainFor(dumpPath, archive !== null);
  if (!chosen.dir) {
    if (!chosen.tried.length && !(chosen.clientOnly || []).length) {
      console.log('\nSKIP  no PostgreSQL available. This asserted NOTHING; it is not a pass.\n');
      process.exit(EXIT_NOT_EXECUTED);
    }
    h('TOOLCHAIN');
    bad(`no installed PostgreSQL server can read this dump (archive ${archive})`);
    for (const t of chosen.tried) console.log(`    server install, cannot read it: ${t}`);
    for (const d of chosen.clientOnly || []) console.log(`    client-only, no server:        ${d}`);
    console.log('\n  On macOS: brew install postgresql@18\n');
    process.exit(1);
  }
  console.log(`  toolchain : ${chosen.dir} — ${chosen.version}`);

  const cluster = R.startCluster(chosen.dir, { port: PGPORT, prefix: 'baseline-' });
  if (cluster.error) {
    h('CLUSTER');
    bad('the selected PostgreSQL could not start a cluster', `failed at: ${cluster.error.step}`);
    if (cluster.error.output) console.log(`\n  output:\n    ${cluster.error.output.split('\n').slice(-10).join('\n    ')}`);
    process.exit(1);
  }

  let client = null;
  try {
    const res = R.restoreDump(cluster, dumpPath);
    if (res.error) { bad('THE RESTORE FAILED', res.error); return; }
    client = new Client({ connectionString: res.url });
    await client.connect();
    const q = (sql, p) => client.query(sql, p);

    // Exactly the baseline's predicate: every relation information_schema.tables reports.
    const all = (await q(
      `SELECT table_name, table_type FROM information_schema.tables
         WHERE table_schema = 'public'
         ORDER BY table_type, table_name`)).rows;
    const baseTables = all.filter((r) => r.table_type === 'BASE TABLE');
    const views = all.filter((r) => r.table_type !== 'BASE TABLE');
    const rows = all.map((r) => r.table_name);
    const present = new Set(rows);

    h('WHAT IS IN THE DUMP');
    console.log(`  relations counted by information_schema.tables : ${all.length}   ← the baseline's predicate`);
    console.log(`    of which BASE TABLE                          : ${baseTables.length}`);
    console.log(`    of which views                               : ${views.length}`);
    if (views.length) {
      for (const v of views) console.log(`      ${v.table_name}  (${v.table_type})`);
      console.log('');
      console.log('  The two figures reported elsewhere differ by exactly this: verify-restore.js');
      console.log('  and the migration harness count relations (views included), so they say');
      console.log(`  ${all.length}. A base-tables-only count says ${baseTables.length}. Neither is wrong; they must not be`);
      console.log('  compared with each other, and the baseline below is the relation count.');
    }

    // ── the thirteen, by name ─────────────────────────────────────────────
    h('THE 13 TABLES connectors.v1 IS RESPONSIBLE FOR');
    const missing = [];
    for (const t of V1_TABLES) {
      const here = present.has(t);
      console.log(`  ${here ? 'present' : 'ABSENT '}  ${t}   (created by the migration)`);
      if (!here) missing.push(t);
    }
    for (const t of RUNNER_TABLES) {
      const here = present.has(t);
      console.log(`  ${here ? 'present' : 'ABSENT '}  ${t}   ← CREATED BY THE RUNNER, NOT THE MIGRATION`);
      if (!here) missing.push(t);
    }
    if (!missing.length) ok(`all ${V1_TABLES.length + RUNNER_TABLES.length} are present`);
    else bad(`${missing.length} expected table(s) absent`, missing.join(', '));

    // ── schema_migrations is the discrepancy: show what it holds ──────────
    h('WHY schema_migrations EXISTS, FROM ITS OWN CONTENTS');
    if (present.has('schema_migrations')) {
      const recorded = (await q('SELECT version, applied_at, applied_by FROM schema_migrations ORDER BY applied_at')).rows;
      if (!recorded.length) {
        bad('schema_migrations is present but empty',
          'it exists without recording a migration, which does not match the runner\'s behaviour');
      }
      for (const r of recorded) {
        console.log(`  ${r.version}  at ${new Date(r.applied_at).toISOString()}  by ${r.applied_by}`);
      }
      const onlyV1 = recorded.length === 1 && recorded[0].version === '2026-11-05.connectors.v1';
      if (onlyV1) {
        ok('it records exactly one migration, connectors.v1 — so it was created by that run');
      } else {
        console.log('  note  it records more than connectors.v1; the arithmetic below still decides.');
      }
    } else {
      bad('schema_migrations is absent, so it cannot be the extra table', 'the discrepancy is unexplained');
    }

    // ── THE IDENTITY ──────────────────────────────────────────────────────
    h('THE ARITHMETIC');
    const accountedFor = [...V1_TABLES, ...RUNNER_TABLES].filter((t) => present.has(t));
    const derived = rows.length - accountedFor.length;
    console.log(`  relations in the dump                   ${String(rows.length).padStart(5)}`);
    console.log(`  less the migration's own tables         ${String(-V1_TABLES.filter((t) => present.has(t)).length).padStart(5)}`);
    console.log(`  less the runner's bookkeeping table     ${String(-RUNNER_TABLES.filter((t) => present.has(t)).length).padStart(5)}`);
    console.log(`                                          ${'-'.repeat(5)}`);
    console.log(`  derived pre-migration baseline          ${String(derived).padStart(5)}`);
    console.log(`  measured pre-migration baseline         ${String(MEASURED_BASELINE).padStart(5)}`);
    console.log('');

    if (derived === MEASURED_BASELINE) {
      ok(`the identity closes: ${rows.length} − ${accountedFor.length} = ${MEASURED_BASELINE}`);
      ok('NOTHING UNEXPLAINED. The additional table beyond the migration\'s 12 is schema_migrations,');
      ok('created by the runner to record its own version. My 137 was an arithmetic error, not an');
      ok('unaccounted object.');
      console.log('');
      console.log(`  After migration v2 (+3 tables) production should read ${rows.length + 3} relations`);
      console.log(`  (${baseTables.length + 3} base tables + ${views.length} view${views.length === 1 ? '' : 's'}).`);
    } else {
      const diff = derived - MEASURED_BASELINE;
      bad(`THE IDENTITY DOES NOT CLOSE — derived ${derived}, measured ${MEASURED_BASELINE} (${diff > 0 ? '+' : ''}${diff})`,
        'something is in this database that neither the measured baseline nor connectors.v1 '
        + 'accounts for. DO NOT PROCEED TO GATE 3 until it is identified.');
      console.log('');
      console.log('  The reconciliation cannot name it from a count alone — the 125 was recorded as');
      console.log('  a number, not a list. To identify it, compare this dump against an earlier');
      console.log('  pre-migration backup:');
      console.log('');
      console.log('    pg_restore -l <older.dump> | grep "TABLE " | awk \'{print $NF}\' | sort > before.txt');
      console.log('    pg_restore -l <this.dump>  | grep "TABLE " | awk \'{print $NF}\' | sort > after.txt');
      console.log('    comm -13 before.txt after.txt');
      console.log('');
      console.log('  Recording the 125 as a count rather than a list is what made this awkward;');
      console.log('  the fix for next time is to keep the list.');
    }
  } finally {
    if (client) await client.end().catch(() => {});
    R.stopCluster(cluster);
  }
}

function result() {
  h('RESULT');
  if (fail) {
    console.log(`  ${fail} failure(s). The baseline is NOT reconciled — Gate 3 should not proceed.\n`);
  } else if (BASELINE_IS_MEASURED) {
    console.log('  Baseline reconciled against the MEASURED production figure. The 138 is 125 + 12');
    console.log('  migration tables + schema_migrations, and no table is unaccounted for.\n');
  } else {
    console.log('  The identity closes, but against a baseline supplied on the command line rather');
    console.log('  than the measured production figure. This exercises the check; it does not');
    console.log('  reconcile production.\n');
  }
  return fail ? 1 : 0;
}

// The exit code is computed here and not inside main(), because main() returns early on a failed
// restore — the same shape that made verify-prod-dashboard.js print FAIL and exit 0.
main()
  .then(() => process.exit(result()))
  .catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
