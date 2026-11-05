#!/usr/bin/env node
'use strict';
// ── READ-ONLY TRIAGE OF THE CONFLICTING-CAS GROUPS ──────────────────────────
//
// Ruling 6 item 5: investigate the single-name conflicting-CAS groups in read-only mode, produce
// an evidence report, change no molecule identities or listings.
//
// ── WHAT READ-ONLY MEANS HERE, CONCRETELY ───────────────────────────────────
//
// This script issues SELECT statements and nothing else. There is no INSERT, UPDATE, DELETE or
// DDL in it, and no fixture to clean up — so the cleanup rules in CLAUDE.md have no subject here,
// which is the safest possible state for a script pointed at production. assertReadOnly() below
// re-checks every statement at the call site rather than trusting that claim, because "I only
// wrote SELECTs" is a statement about my intentions and the check is a statement about the code.
//
// ── WHY THE GROUPING IS COPIED FROM THE CENSUS ──────────────────────────────
//
// It rebuilds groups with canonicalMolecule() + validCas() exactly as molecule-identity-census.js
// section 4 does. If it grouped differently its counts would not be comparable to the census
// output, and reconciling two disagreeing measurements of the same thing is the work this program
// has already paid for twice (113 vs 102).
//
// Usage:
//   DATABASE_URL=<disposable or production, read-only> node scripts/cas-conflict-triage.js
//   railway ssh 'node scripts/cas-conflict-triage.js'        # against production
//
// Exit: 0 report produced. 1 could not produce it (no table, bad connection, invariant broken).

const { Pool } = require('pg');
const { canonicalMolecule, normalize } = require('../src/lib/molecules/synonyms');
const { validCas } = require('../src/lib/catalogue/cas');
const { triage, summarise } = require('../src/lib/molecules/cas-triage');

const FORBIDDEN = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy)\b/i;

/** Refuse at the call site, not in review. A read-only script that can mutate is not read-only. */
function assertReadOnly(sql) {
  if (FORBIDDEN.test(sql)) {
    throw new Error(`REFUSED: statement is not read-only:\n${sql}`);
  }
  return sql;
}

function bar(ch = '─') { return ch.repeat(78); }
function h(title) { console.log(`\n${bar()}\n${title}\n${bar()}`); }

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    return 1;
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /sslmode=disable/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  });
  const q = (sql, vals) => pool.query(assertReadOnly(sql), vals);

  try {
    const exists = await q(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'study_molecules'
      ) AS present`);
    if (!exists.rows[0].present) {
      console.error('study_molecules does not exist in this database — nothing to triage.');
      return 1;
    }

    // Same source and same shape as census section 4.
    const names = await q(`
      SELECT molecule_name, cas_number, COUNT(*)::int n
        FROM study_molecules
       GROUP BY molecule_name, cas_number`);

    const groups = new Map();
    for (const r of names.rows) {
      const canon = canonicalMolecule(r.molecule_name) || normalize(r.molecule_name);
      const g = groups.get(canon) || { names: new Set(), cas: new Set(), rows: 0 };
      g.names.add(normalize(r.molecule_name));
      if (r.cas_number && validCas(r.cas_number)) g.cas.add(String(r.cas_number).trim());
      g.rows += r.n;
      groups.set(canon, g);
    }

    // Sorted deterministically. The GROUP BY has no ORDER BY and Sets keep insertion order, so
    // without this two runs over IDENTICAL data print the numbers in different orders — and a
    // report a human diffs across runs would show changes that are not changes.
    const conflicts = [...groups.entries()]
      .filter(([, g]) => g.cas.size > 1)
      .map(([canonical, g]) => ({
        canonical,
        names: [...g.names].sort(),
        cas: [...g.cas].sort(),
        rows: g.rows,
      }))
      .sort((a, b) => a.canonical.localeCompare(b.canonical));

    h('CAS CONFLICT TRIAGE  (read-only — no identity or listing is changed)');
    console.log(`  database        : ${String(process.env.DATABASE_URL).replace(/:[^:@/]*@/, ':***@')}`);
    console.log(`  generated       : ${new Date().toISOString()}`);
    console.log(`  grouping rule   : canonicalMolecule() || normalize(), as census section 4`);
    console.log(`  source table    : study_molecules`);
    console.log(`  conflict test   : >1 checksum-valid CAS inside one canonical group`);
    console.log('');
    console.log(`  conflicting groups found : ${conflicts.length}`);
    console.log(`  rows inside them         : ${conflicts.reduce((a, g) => a + g.rows, 0)}`);
    console.log('');
    console.log('  SCOPE: this counts groups under canonicalMolecule(), which de-salts and does');
    console.log('  not strip grade phrases. Both behaviours MANUFACTURE conflicts that identityOf()');
    console.log('  would not produce. The triage below separates those from the rest; the headline');
    console.log('  count above is therefore an upper bound on real defects, not an estimate.');

    const triaged = triage(conflicts);
    const sum = summarise(triaged);

    h('CLASSIFICATION');
    const order = ['form_pair', 'grade_duplicate', 'cross_attached', 'digit_adjacent', 'unexplained'];
    const label = {
      form_pair: 'form_pair       (manufactured by de-salting — nothing wrong with the data)',
      grade_duplicate: 'grade_duplicate (a grade variant carrying its parent\'s pair)',
      cross_attached: 'cross_attached  (a number shared with another group)',
      digit_adjacent: 'digit_adjacent  (two valid numbers one character apart)',
      unexplained: 'unexplained     (no structural story — a person must rule)',
    };
    for (const c of order) {
      console.log(`  ${String(sum.byClass[c] || 0).padStart(4)}  ${label[c]}`);
    }
    console.log(`  ${bar(' ').slice(0, 4)}`);
    console.log(`  ${String(sum.total).padStart(4)}  total`);
    console.log(`  ${String(sum.needsHuman).padStart(4)}  NEED A HUMAN RULING`);

    // Single-name groups: the subject of item 5 specifically.
    const singleName = triaged.filter((g) => g.names.length === 1);
    h(`SINGLE-NAME CONFLICTING GROUPS  (${singleName.length})`);
    console.log('  One filed name carrying two or more checksum-valid numbers. These cannot be');
    console.log('  explained by de-salting two names into one group, so the de-salting defence');
    console.log('  does not apply to any of them.\n');
    for (const c of order) {
      const inClass = singleName.filter((g) => g.class === c);
      if (!inClass.length) continue;
      console.log(`  ── ${c} (${inClass.length}) ${bar('─').slice(0, Math.max(0, 60 - c.length))}`);
      for (const g of inClass) {
        console.log(`\n    canonical : ${g.canonical}`);
        console.log(`    filed as  : ${g.names.join(' | ')}`);
        console.log(`    CAS       : ${g.cas.join(' | ')}`);
        console.log(`    rows      : ${g.rows}`);
        console.log(`    verdict   : ${g.needsHuman ? 'NEEDS HUMAN RULING' : 'no action — explained'}`);
        for (const e of g.evidence) console.log(`    evidence  : ${e}`);
      }
      console.log('');
    }

    h('MULTI-NAME CONFLICTING GROUPS  (summary only)');
    const multiName = triaged.filter((g) => g.names.length > 1);
    console.log(`  ${multiName.length} groups hold more than one filed name.`);
    const multiNeeding = multiName.filter((g) => g.needsHuman);
    console.log(`  ${multiName.length - multiNeeding.length} are explained by de-salting (form_pair).`);
    console.log(`  ${multiNeeding.length} still need a ruling:\n`);
    for (const g of multiNeeding) {
      console.log(`    ${g.canonical}  [${g.class}]`);
      console.log(`      filed as : ${g.names.join(' | ')}`);
      console.log(`      CAS      : ${g.cas.join(' | ')}`);
    }

    h('WHAT THIS REPORT DOES NOT ESTABLISH');
    console.log('  · which number is correct for any group. That is a chemistry question against an');
    console.log('    external registry; no class above answers it and none should be read as doing so.');
    console.log('  · that a cross_attached pair is a defect. A shared number is equally consistent');
    console.log('    with one substance split across groups by a missing synonym.');
    console.log('  · that a digit_adjacent pair is a transcription slip. Both numbers pass the');
    console.log('    checksum; distinct substances sometimes hold adjacent numbers.');
    console.log('  · anything about listings, prices or supplier counts. Nothing was read from them.');
    console.log('');
    console.log('  No identity was changed. No row was written. R3 groups remain quarantined and');
    console.log('  R4 migrations remain on HOLD.');
    console.log('');

    // Invariants: a report that silently loses groups is worse than no report.
    if (sum.total !== conflicts.length) {
      console.error(`INVARIANT BROKEN: triaged ${sum.total} of ${conflicts.length} groups.`);
      return 1;
    }
    const unclassified = triaged.filter((g) => !g.class);
    if (unclassified.length) {
      console.error(`INVARIANT BROKEN: ${unclassified.length} groups left unclassified.`);
      return 1;
    }
    if (singleName.length + multiName.length !== sum.total) {
      console.error('INVARIANT BROKEN: single-name + multi-name != total.');
      return 1;
    }
    return 0;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(1);
  });
