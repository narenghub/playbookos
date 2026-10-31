#!/usr/bin/env node
// ── HOW MANY TRANSACTION ROWS CAN BE CANONICALLY IDENTIFIED? ─────────────────
//
//   railway ssh 'node scripts/gate2-measure-identity.js'
//
// READS ONLY. No INSERT, no UPDATE, no DELETE, no DDL. Run it against production.
//
// ── THIS IS A MEASUREMENT, NOT A CHECK ──────────────────────────────────────
//
// EXIT 0 MEANS "I MEASURED", NOT "ALL CLEAR". Every other script under scripts/ that prints a
// verdict exits non-zero when something is wrong; this one exits non-zero only when it could not
// take the measurement at all. Read the NUMBERS. A zero exit code here is not evidence of anything.
//
// ── WHY IT EXISTS ───────────────────────────────────────────────────────────
//
// Gate 2 adds canonical molecule identity to inquiries, inquiry_quotes and rfq_requests. The
// backfill strategy cannot be chosen before anyone knows how many existing rows actually resolve:
// a design that assumes "most will resolve" and meets a table where a third are truncated supplier
// strings is a design that will be loosened under pressure at exactly the wrong moment. So the
// numbers come first, and the design is written against them.
//
// ── THE RESOLUTION RULE, AND THE ONE THING IT WILL NOT DO ───────────────────
//
// Resolution is by normalised name only — moleculeKey(), the same function E1 uses, then the alias
// table. `cas_number` IS NEVER A KEY. It is used in one direction only: to VETO a name match whose
// CAS contradicts the molecule's canonical CAS.
//
// That asymmetry is the direct lesson of the 31 Oct pricing defect. `molecule_pricing` has a unique
// index on the name and NO constraint on cas_number, and matching on a shared CAS priced a
// correctly-named molecule at another substance's rate, 2.4x out, decided by physical row order. A
// registry number identifies a substance until two rows disagree about it, and 212 identities in
// this database are already contested. A CAS can therefore refute a match; it must never make one.
'use strict';

const fs = require('fs');
const { query } = require('../src/lib/db');
const { moleculeKey } = require('../src/lib/molecules/identity');

// stdout through fs.writeSync, not console.log. A checker printed nothing and exited 1 on 31 Oct
// because console.log to a pipe is an async write and process.exit discards what has not drained.
const out = (s) => fs.writeSync(1, s + '\n');

// The three tables Gate 2 covers, and the columns identity would be derived from.
const TABLES = [
  { table: 'inquiries', name: 'molecule_name', cas: 'cas_number' },
  { table: 'inquiry_quotes', name: 'molecule_name', cas: 'cas_number' },
  { table: 'rfq_requests', name: 'molecule_name', cas: 'cas_number' },
];

// Outcome vocabulary. Deliberately distinguishes the three kinds of "no id" that a single NULL
// would collapse — which is the defect shape this whole gate exists to remove.
const OUTCOMES = [
  'resolved',               // exactly one eligible canonical identity
  'resolved_deprecated',    // resolves, but the identity is deprecated (policy rule 6: history keeps it)
  'cas_contradiction',      // name resolves; the row's CAS disagrees with the molecule's canonical CAS
  'unresolved_no_match',    // normalises cleanly, nothing canonical answers to it
  'unresolved_unusable',    // the string does not yield an identity at all (empty, prose, fragment)
  'no_molecule_named',      // the row names no molecule — not a failure, just not a molecule row
];

function digits(cas) {
  return String(cas || '').replace(/[^0-9-]/g, '').trim();
}

async function loadCanonical() {
  // One pass over the canonical tables, held in memory. 2447 molecules and 44 aliases is small, and
  // a per-row query against a production database over a connection that failed three ways on
  // 31 Oct is how a measurement loses two thirds of its result and reports the rest as the answer.
  const byIdentity = new Map();
  for (const m of (await query(
    `SELECT id, molecule_ref, normalized_name, preferred_name, cas, deprecated_at
       FROM molecules`)).rows) {
    byIdentity.set(m.normalized_name, m);
  }
  for (const a of (await query(
    `SELECT a.alias, a.molecule_id FROM molecule_aliases a`)).rows) {
    if (byIdentity.has(a.alias)) continue;      // an identity of its own wins over an alias
    const m = [...byIdentity.values()].find((x) => String(x.id) === String(a.molecule_id));
    if (m) byIdentity.set(a.alias, m);
  }
  return byIdentity;
}

function classify(row, canonical, cols) {
  const filed = row[cols.name];
  if (filed === null || filed === undefined || String(filed).trim() === '') {
    return { outcome: 'no_molecule_named', molecule: null };
  }
  const identity = moleculeKey(filed);
  if (!identity) return { outcome: 'unresolved_unusable', molecule: null };

  const m = canonical.get(identity);
  if (!m) return { outcome: 'unresolved_no_match', molecule: null, identity };

  // CAS as a veto, never as a key. Only a disagreement between two PRESENT values counts: a row
  // with no CAS contradicts nothing, and a molecule with a withheld canonical CAS (Decision 1 is
  // already suppressing it) is not evidence against the name.
  const rowCas = digits(row[cols.cas]);
  const molCas = digits(m.cas);
  if (rowCas && molCas && rowCas !== molCas) {
    return { outcome: 'cas_contradiction', molecule: m, identity, rowCas, molCas };
  }
  return {
    outcome: m.deprecated_at ? 'resolved_deprecated' : 'resolved',
    molecule: m,
    identity,
  };
}

async function main() {
  const canonical = await loadCanonical();
  const activeCount = (await query(
    `SELECT COUNT(*)::int n FROM molecules WHERE deprecated_at IS NULL`)).rows[0].n;
  const deprecatedCount = (await query(
    `SELECT COUNT(*)::int n FROM molecules WHERE deprecated_at IS NOT NULL`)).rows[0].n;

  out('');
  out('── GATE 2 IDENTITY MEASUREMENT ─────────────────────────────────────────');
  out(`canonical identities resolvable (incl. aliases)   ${canonical.size}`);
  out(`  of which molecules active                       ${activeCount}`);
  out(`  of which molecules deprecated                   ${deprecatedCount}`);
  out('');
  out('A zero exit code below means the measurement RAN. It is not a verdict.');

  const totals = {};
  for (const o of OUTCOMES) totals[o] = 0;
  let grand = 0;

  for (const cols of TABLES) {
    // A missing table is reported, not fatal — these three exist in production, but a measurement
    // that dies on the first absent table measures nothing and tells you about one problem.
    let rows;
    try {
      rows = (await query(
        `SELECT id, ${cols.name}, ${cols.cas} FROM ${cols.table}`)).rows;
    } catch (e) {
      out('');
      out(`── ${cols.table}: COULD NOT READ — ${e.message}`);
      continue;
    }

    const counts = {};
    for (const o of OUTCOMES) counts[o] = 0;
    const samples = {};
    for (const o of OUTCOMES) samples[o] = [];

    for (const r of rows) {
      const c = classify(r, canonical, cols);
      counts[c.outcome] += 1;
      totals[c.outcome] += 1;
      if (samples[c.outcome].length < 8) {
        samples[c.outcome].push(
          c.outcome === 'cas_contradiction'
            ? `${JSON.stringify(r[cols.name])} row CAS ${c.rowCas} vs ${c.molecule.molecule_ref} CAS ${c.molCas}`
            : JSON.stringify(r[cols.name])
        );
      }
    }
    grand += rows.length;

    out('');
    out(`── ${cols.table}  (${rows.length} rows)`);
    for (const o of OUTCOMES) {
      const n = counts[o];
      const pct = rows.length ? ` ${((n / rows.length) * 100).toFixed(1)}%` : '';
      out(`   ${o.padEnd(22)} ${String(n).padStart(6)}${pct}`);
    }
    for (const o of ['cas_contradiction', 'unresolved_no_match', 'unresolved_unusable']) {
      if (!samples[o].length) continue;
      out(`   sample — ${o}:`);
      for (const s of samples[o]) out(`     ${s}`);
    }
  }

  out('');
  out('── ALL THREE TABLES ───────────────────────────────────────────────────');
  for (const o of OUTCOMES) out(`   ${o.padEnd(22)} ${String(totals[o]).padStart(6)}`);
  out(`   ${'TOTAL ROWS'.padEnd(22)} ${String(grand).padStart(6)}`);

  const resolvable = totals.resolved + totals.resolved_deprecated;
  const needRuling = totals.cas_contradiction;
  const noId = totals.unresolved_no_match + totals.unresolved_unusable;
  out('');
  out('── WHAT THIS MEANS FOR THE BACKFILL ───────────────────────────────────');
  out(`   rows a backfill could resolve without judgement   ${resolvable}`);
  out(`   rows requiring a ruling (CAS contradiction)       ${needRuling}`);
  out(`   rows that would stay unidentified                 ${noId}`);
  out(`   rows naming no molecule                           ${totals.no_molecule_named}`);
  out('');
  out('A CAS contradiction is NOT a row to resolve by majority or by preferring either value. The');
  out('row says one substance and the catalogue says another; picking one writes a guess into');
  out('commercial history. Those rows get a status and a review record, never an id.');

  // One line that survives being copy-pasted out of a terminal whose connection dropped.
  out('');
  out(`DIGEST resolvable=${resolvable} ruling=${needRuling} unidentified=${noId} `
    + `none=${totals.no_molecule_named} total=${grand}`);
  return 0;
}

// Returns its verdict; never exits its caller. `main()` calling process.exit on 31 Oct killed the
// test harness that imported it.
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => { fs.writeSync(2, `MEASUREMENT FAILED: ${e.message}\n${e.stack}\n`); process.exit(2); });
}

module.exports = { main, classify, loadCanonical, OUTCOMES };
