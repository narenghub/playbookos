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
// ── THE FALSE POSITIVE THIS FILE ONCE REPORTED (2026-11-15) ──────────────────
//
// On the day of the production migration, `--status` printed:
//
//     columns expected 15 / columns present  15
//     APPLIED — the outbound ledger schema is in place.          exit 0
//
// while `idx_email_log_one_claim_per_ref` DID NOT EXIST. The uniqueness check said so explicitly,
// before and after. `--status` counted COLUMNS and never looked at indexes or constraints, so it
// answered confidently about the migration's least consequential half.
//
// Anyone trusting that report would have concluded there was nothing to do, and the claim
// arbitration would have stayed absent — the arbitration that is the difference between twelve
// concurrent dispatches putting FOUR messages through the provider and putting one.
//
// The post-`--apply` verdict had the same blind spot: it compared column counts, so an apply whose
// index creation had quietly not happened would still have printed PASS.
//
// ── SO THE EXPECTATION IS DERIVED FROM THE DDL, NOT RESTATED ─────────────────
//
// Everything this script requires is read out of SCHEMA.DDL — the same array `--apply` executes.
// A hard-coded list of index names would be the identical defect wearing a different hat: it would
// agree with the DDL on the day it was written and drift the first time a statement was added.
//
// Two things follow, and the second is the one that keeps this honest:
//
//   1. Adding an index or constraint to SCHEMA.DDL automatically makes it required here.
//   2. If the derivation finds NOTHING, that is a failure of the deriver, not a clean schema. A
//      derived expectation that silently derives nothing passes vacuously, which is the defect
//      class this whole file is a correction for. assertDerivable() refuses to continue.
//
// ── WHY PARTIAL IS EXIT 1 AND NOT 2 ─────────────────────────────────────────
//
// NOT APPLIED is genuinely information: the migration has not been run, the ledger fails closed,
// and consequential email is refused rather than sent unrecorded. That is a safe, expected state
// before a release, so it keeps exit 2.
//
// PARTIAL is not information. It is a schema nobody decided — some artifacts present, others
// missing or mismatched — and the ledger may be half-trusting it. It is exactly the state that
// hides, because every cheap summary of it looks fine. So it exits 1, and any automation that
// treats non-zero as a failure treats it as one.
//
// Exit 0 = applied, and every declared artifact verified · 1 = failure, INCLUDING partial
// application · 2 = --status found the schema not applied at all.

'use strict';

const SCHEMA = require('../src/lib/outbound/ledger-schema');

const MODE = process.argv.includes('--apply') ? 'apply'
  : process.argv.includes('--rollback') ? 'rollback' : 'status';

// ── WHAT THE DDL DECLARES ───────────────────────────────────────────────────

/**
 * Reads the required artifacts out of SCHEMA.DDL. Regex over SQL is fragile in general; it is
 * acceptable here because the input is this repository's own small, controlled DDL array and
 * because assertDerivable() fails loudly rather than quietly finding nothing.
 */
function requiredArtifacts(ddl = SCHEMA.DDL) {
  const indexes = [];
  const constraints = [];

  for (const raw of ddl) {
    const sql = String(raw).replace(/\s+/g, ' ').trim();

    const idx = sql.match(
      /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)\s+ON\s+([A-Za-z0-9_."]+)\s*\(([^)]*)\)(.*)$/i);
    if (idx) {
      const [, uniq, name, , cols, tail] = idx;
      const where = (tail.match(/\bWHERE\b(.*)$/i) || [, ''])[1].trim();
      indexes.push({
        name,
        unique: Boolean(uniq),
        columns: cols.split(',').map((c) => c.trim().replace(/"/g, '')).filter(Boolean),
        predicate: where,
        // The comparison basis for the predicate — see predicateAgrees().
        literals: literalsIn(where),
        refs: identifiersIn(where),
      });
      continue;
    }

    // Only ADD CONSTRAINT is a requirement. The paired DROP CONSTRAINT IF EXISTS that precedes
    // each one is how the DDL stays idempotent, and is not an artifact to look for.
    const con = sql.match(/\bADD\s+CONSTRAINT\s+([A-Za-z0-9_]+)\s+(CHECK|UNIQUE|FOREIGN|PRIMARY)\b/i);
    if (con) constraints.push({ name: con[1], kind: con[2].toUpperCase() });
  }

  return { columns: [...SCHEMA.ADDED_COLUMNS], indexes, constraints };
}

const literalsIn = (s) => [...String(s).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]).sort();
const identifiersIn = (s) => [...new Set(
  [...String(s).matchAll(/\b([a-z_][a-z0-9_]*)\b/gi)]
    .map((m) => m[1].toLowerCase())
    .filter((w) => !['where', 'and', 'or', 'not', 'is', 'null', 'in', 'any', 'array', 'text', 'true', 'false'].includes(w)),
)].sort();

/**
 * The anti-vacuity guard. If the DDL plainly contains CREATE INDEX / ADD CONSTRAINT statements and
 * the deriver extracted none, every comparison below would pass against an empty expectation.
 */
function assertDerivable(req, ddl = SCHEMA.DDL) {
  const problems = [];
  const ddlText = ddl.join('\n');
  const idxInDdl = (ddlText.match(/CREATE\s+(UNIQUE\s+)?INDEX/gi) || []).length;
  const conInDdl = (ddlText.match(/ADD\s+CONSTRAINT/gi) || []).length;

  if (idxInDdl !== req.indexes.length) {
    problems.push(`the DDL contains ${idxInDdl} CREATE INDEX statement(s) but the deriver found `
      + `${req.indexes.length} — the expectation would be incomplete`);
  }
  if (conInDdl !== req.constraints.length) {
    problems.push(`the DDL contains ${conInDdl} ADD CONSTRAINT statement(s) but the deriver found `
      + `${req.constraints.length}`);
  }
  if (!req.columns.length) problems.push('SCHEMA.ADDED_COLUMNS is empty');
  return problems;
}

// ── WHAT THE DATABASE ACTUALLY HAS ──────────────────────────────────────────

/**
 * The indexed column list, read out of the definition Postgres prints for the index.
 * `CREATE UNIQUE INDEX x ON public.email_log USING btree (claim_ref) WHERE (…)` → ['claim_ref'].
 * The first parenthesised group after USING is the key list; the predicate follows it.
 */
function indexedColumns(indexdef) {
  const m = String(indexdef || '').match(/USING\s+\w+\s*\(([^)]*)\)/i);
  if (!m) return [];
  return m[1].split(',')
    .map((c) => c.trim().replace(/"/g, '').replace(/\s+(ASC|DESC|NULLS\s+(FIRST|LAST))\b/gi, '').trim())
    .filter(Boolean);
}

async function observe(query, req) {
  const cols = await query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = $1 AND column_name = ANY($2)`,
    [SCHEMA.TABLE, req.columns]);

  // indisunique and the normalised predicate come from the CATALOGUE, not from the index's name —
  // the whole point is that a name proves nothing about a definition.
  //
  // The column list comes from pg_get_indexdef rather than from indkey. `indkey` is an int2vector,
  // not a true array, so generate_subscripts() over it does not yield subscripts the way an array
  // would; the first version of this query crashed with "(have.columns || []).map is not a
  // function" because the subquery returned something that was not an array at all. indexdef is a
  // string Postgres builds itself, which is both portable and self-evidently what the index is.
  const idx = await query(
    `SELECT c.relname                          AS name,
            i.indisunique                      AS unique,
            pg_get_expr(i.indpred, i.indrelid) AS predicate,
            pg_get_indexdef(i.indexrelid)      AS indexdef
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
      WHERE t.relname = $1`,
    [SCHEMA.TABLE]);

  const con = await query(
    `SELECT conname AS name FROM pg_constraint WHERE conrelid = $1::regclass`,
    [SCHEMA.TABLE]);

  return {
    columns: cols.rows.map((r) => r.column_name),
    indexes: idx.rows.map((r) => ({ ...r, columns: indexedColumns(r.indexdef) })),
    constraints: con.rows.map((r) => r.name),
  };
}

/**
 * Compares the declared predicate against the one Postgres reports.
 *
 * NOT full logical equivalence, and saying so matters. Postgres renders
 * `outcome IN ('A','B')` as `outcome = ANY (ARRAY['A'::text, 'B'::text])`, so a literal string
 * comparison would report a mismatch on every correctly-applied index. What is compared is the SET
 * of string literals and the SET of referenced identifiers, in both directions — which catches a
 * missing outcome, an extra one, a different column, or a predicate dropped entirely.
 *
 * What it would NOT catch: the same literals and columns recombined with different logic, e.g. OR
 * where the DDL says AND. That is a real gap. It is written down rather than glossed, because the
 * alternative — claiming equivalence this does not establish — is the defect this file exists to
 * correct.
 */
function predicateAgrees(expected, actual) {
  const a = { literals: literalsIn(actual || ''), refs: identifiersIn(actual || '') };
  const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  return same(expected.literals, a.literals) && same(expected.refs, a.refs);
}

function compare(req, got) {
  const missing = [];
  const mismatched = [];

  for (const c of req.columns) if (!got.columns.includes(c)) missing.push(`column ${c}`);

  for (const want of req.indexes) {
    const have = got.indexes.find((i) => i.name === want.name);
    if (!have) { missing.push(`index ${want.name}`); continue; }
    if (want.unique && !have.unique) {
      mismatched.push(`index ${want.name} exists but is NOT UNIQUE — it would not refuse a duplicate`);
    }
    const haveCols = (have.columns || []).map(String);
    if (haveCols.join(',') !== want.columns.join(',')) {
      mismatched.push(`index ${want.name} covers (${haveCols.join(', ')}), declared (${want.columns.join(', ')})`);
    }
    if (want.predicate && !have.predicate) {
      mismatched.push(`index ${want.name} has NO predicate; declared WHERE ${want.predicate}`);
    } else if (want.predicate && !predicateAgrees(want, have.predicate)) {
      mismatched.push(`index ${want.name} predicate differs — declared WHERE ${want.predicate}; `
        + `database reports ${have.predicate}`);
    }
  }

  for (const want of req.constraints) {
    if (!got.constraints.includes(want.name)) missing.push(`constraint ${want.name}`);
  }

  const total = req.columns.length + req.indexes.length + req.constraints.length;
  const present = total - missing.length;
  return { missing, mismatched, total, present };
}

// ── REPORT ──────────────────────────────────────────────────────────────────

/**
 * The verdict, as a pure function of the comparison, so the exit codes are testable without a
 * database. The false positive this file corrects was a verdict chosen from the wrong input; making
 * the choice itself inspectable is most of the fix.
 */
function verdictFor(cmp, mode = 'status') {
  const clean = !cmp.missing.length && !cmp.mismatched.length;
  if (mode === 'rollback') {
    return cmp.present === 0
      ? { verdict: 'PASS', exit: 0 }
      : { verdict: 'FAIL', exit: 1 };
  }
  if (clean) return { verdict: 'APPLIED', exit: 0 };
  if (mode === 'apply') return { verdict: 'FAIL', exit: 1 };
  if (cmp.present === 0) return { verdict: 'NOT APPLIED', exit: 2 };
  return { verdict: 'PARTIAL', exit: 1 };
}

function report(req, got, cmp) {
  console.log(`\n  table              ${SCHEMA.TABLE}`);
  console.log(`  declared artifacts ${cmp.total}  `
    + `(${req.columns.length} column(s), ${req.indexes.length} index(es), ${req.constraints.length} constraint(s))`);
  console.log(`  present            ${cmp.present}`);
  if (cmp.missing.length) {
    console.log(`\n  MISSING (${cmp.missing.length}):`);
    for (const m of cmp.missing) console.log(`    - ${m}`);
  }
  if (cmp.mismatched.length) {
    console.log(`\n  MISMATCHED (${cmp.mismatched.length}):`);
    for (const m of cmp.mismatched) console.log(`    - ${m}`);
  }
}

async function main() {
  const { query } = require('../src/lib/db');

  const req = requiredArtifacts();
  const derivationProblems = assertDerivable(req);
  if (derivationProblems.length) {
    console.log('\nFAIL  the required-artifact list could not be derived from SCHEMA.DDL:');
    for (const p of derivationProblems) console.log(`        ${p}`);
    console.log('\n      Refusing to report on a schema against an expectation that may be empty.\n');
    process.exit(1);
  }

  const assess = async () => {
    const got = await observe(query, req);
    return { got, cmp: compare(req, got) };
  };

  if (MODE === 'status') {
    const { got, cmp } = await assess();
    report(req, got, cmp);

    const v = verdictFor(cmp, 'status');
    if (v.verdict === 'APPLIED') {
      console.log('\nAPPLIED — every artifact the DDL declares is present and matches.\n');
      process.exit(v.exit);
    }
    if (v.verdict === 'NOT APPLIED') {
      console.log('\nNOT APPLIED — this is a report, nothing was changed.');
      console.log('  The ledger FAILS CLOSED: with the schema absent, consequential email is');
      console.log('  refused rather than sent unrecorded. Apply with --apply when authorized.\n');
      process.exit(v.exit);
    }
    console.log('\nPARTIAL — some declared artifacts are present and others are missing or do not match.');
    console.log('  This is NOT the benign "not yet applied" state. It is a schema nobody decided,');
    console.log('  and the half that is missing may be the half that enforces something.');
    console.log('  Re-run --apply (it is idempotent) and read THIS report again afterwards.\n');
    process.exit(v.exit);
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

  // The END STATE is verified against the full declared set, not against a column count. An apply
  // whose index creation had quietly not happened used to print PASS.
  const { got, cmp } = await assess();
  report(req, got, cmp);

  const end = verdictFor(cmp, MODE);
  const ok = end.exit === 0;
  console.log(ok
    ? `\nPASS  ${MODE} complete — ${cmp.present} of ${cmp.total} declared artifact(s) present, all matching.\n`
    : `\nFAIL  ${MODE} did not reach its expected end state: `
      + `${cmp.missing.length} missing, ${cmp.mismatched.length} mismatched.\n`);
  process.exit(end.exit);
}

module.exports = {
  requiredArtifacts, assertDerivable, observe, compare, verdictFor, indexedColumns,
  predicateAgrees, literalsIn, identifiersIn,
};

if (require.main === module) {
  main().catch((e) => { console.error('migrate-outbound-ledger failed:', e && e.message); process.exit(1); });
}
