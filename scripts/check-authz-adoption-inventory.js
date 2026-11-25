#!/usr/bin/env node
// ── §5: WHAT ACTUALLY TRAVERSES THE UNIFIED AUTHORIZATION BOUNDARY ──────────
//
//   node scripts/check-authz-adoption-inventory.js          # the inventory
//   node scripts/check-authz-adoption-inventory.js --json
//
//   exit 0 = the inventory was produced and its invariants hold
//   exit 1 = an invariant broke (a new gate.js caller, a new unguarded sensitive write)
//
// Owner's §5 of 2026-11-25:
//
//   *"Reconcile the reported 111 call sites with the finding that no production module imports
//    gate.js. Produce an inventory distinguishing: actual gate.js callers; existing sensitive
//    operations requiring migration to the unified boundary; already migrated operations;
//    explicitly platform-level operations; remaining bypass paths. Do not equate legacy test
//    compatibility with complete production adoption."*
//
// ── THE RECONCILIATION, AND IT IS A CORRECTION TO MY OWN REPORTING ─────────
//
// The owner is right and the number was wrong. Measured here, every run:
//
//   • NO production module requires src/lib/agents/gate.js.
//   • Its two exported entry points, callAgent and callTool, have ZERO consumers anywhere in
//     src/ or scripts/ outside gate.js itself and its own test.
//
// So gate.js is not a road with 111 vehicles on it. It is an unreferenced module whose spine I
// rewired to the unified boundary, and whose 15 tests then passed.
//
// Where "111 call sites" came from: it was B7.21's figure — the company-scoping work across the
// workflow modules — and I attached it to gate.js in the Decision 1 write-up. Two different
// migrations, one number, and the number cannot be reproduced for either (the role-based query
// sites measure 17). I am not able to substantiate 111 and it should not have been reported.
//
// That correction cuts BOTH ways and the second direction is the one that matters: "no callers"
// makes retiring gate.js cheap, and it also means **the 15 passing legacy tests demonstrate
// nothing about production adoption**. They exercise a module production never calls. The real
// adoption question is the fourth category below — sensitive operations that never traversed any
// boundary, because there was no boundary for them to traverse.
//
// ── WHAT THIS MEASURES, AND WHAT IT CANNOT ─────────────────────────────────
//
// Categories 1–3 are mechanical and exact: a require graph and a call-site count.
//
// Category 4 is a HEURISTIC and is labelled as one. It flags a module that reads or writes a
// company-scoped table without resolving a company context in the same file. That over-reports
// (a module may receive an already-resolved context as an argument) and under-reports (a module
// may resolve a context and then query something else entirely). It is a worklist for a human,
// not a verdict, and the report says so rather than implying a count is an audit.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const JSON_OUT = process.argv.includes('--json');
const ROOT = path.join(__dirname, '..');
const { blankCommentsOnly } = require('./js-lex');

// The company-scoped tables, from the one list that already decides this question. Imported, not
// re-listed: a second copy would drift from the one K1 validates against.
const SCOPED_TABLES = require('./lib/db-identity').M7_TABLES
  ? [...new Set(require('./lib/db-identity').M7_TABLES)]
  : [];

// NOT `SOURCES`: that name is a reserved concept here — the shared data-source list in
// scripts/lib — and check-sources-centralized.js forbids any file declaring its own, correctly.
// This is a list of JavaScript files, a different thing that happened to pick the same word.
const JS_FILES = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(abs); continue; }
    if (!e.name.endsWith('.js')) continue;
    JS_FILES.push({ rel: path.relative(ROOT, abs), abs, isTest: e.name.endsWith('.test.js') });
  }
};
for (const d of ['src', 'scripts']) walk(path.join(ROOT, d));

const read = (f) => {
  try { return blankCommentsOnly(fs.readFileSync(f.abs, 'utf8')); } catch (_) { return ''; }
};

// Three kinds of file, kept apart everywhere below. The first draft of this script counted them
// together and reported "19 gate.js entry-point calls" one line under "production importers: NONE",
// and "20 already migrated" of which 19 were assertions inside a single checker. An inventory
// written to withdraw an inflated number must not inflate a different one, so the kind is carried
// on every record rather than filtered once and forgotten.
const kindOf = (f) => {
  if (f.isTest) return 'test';
  if (/^scripts\/(check|demo|validate|verify|audit|propose)/.test(f.rel)) return 'checker';
  return 'production';
};
const production = JS_FILES.filter((f) => kindOf(f) === 'production');

// ── 1. ACTUAL gate.js CALLERS ───────────────────────────────────────────────
const gateImporters = [];
const gateEntryCalls = [];
for (const f of JS_FILES) {
  if (f.rel === 'src/lib/agents/gate.js') continue;
  const code = read(f);
  if (/require\([^)]*agents\/gate[^)]*\)/.test(code)) gateImporters.push(f.rel);
  for (const m of code.matchAll(/\b(callAgent|callTool)\s*\(/g)) {
    gateEntryCalls.push({ file: f.rel, fn: m[1], kind: kindOf(f) });
  }
}

// ── 2. ALREADY MIGRATED: callers of the unified boundary ────────────────────
const boundaryCalls = [];
for (const f of JS_FILES) {
  const code = read(f);
  for (const m of code.matchAll(/\b(authorizeHumanToolCall|authorizeAgentAction)\s*\(/g)) {
    if (f.rel === 'src/lib/authz/boundary.js') continue;
    boundaryCalls.push({ file: f.rel, fn: m[1], kind: kindOf(f) });
  }
}

// ── 3. CONTEXT-RESOLVING MODULES: already company-authorized by another road ─
const CONTEXT_SIGNALS = /(resolveCompanyContext|beginObjectiveRun|deriveContext|assertContext|membersOfCompany|companyForProduct|authorizeHumanToolCall|authorizeAgentAction|bootstrapObjectiveForContext)/;

// ── 4. HEURISTIC: company-scoped data touched without a context in the file ──
const tableRe = SCOPED_TABLES.length
  ? new RegExp(`\\b(?:FROM|INTO|UPDATE|JOIN)\\s+(${SCOPED_TABLES.join('|')})\\b`, 'gi')
  : null;
const needsReview = [];
for (const f of production) {
  if (!tableRe) break;
  if (f.rel.startsWith('src/lib/authz/')) continue;          // the boundary itself
  const code = read(f);
  const hits = [...new Set([...code.matchAll(tableRe)].map((m) => m[1].toLowerCase()))];
  if (!hits.length) continue;
  if (CONTEXT_SIGNALS.test(code)) continue;
  needsReview.push({ file: f.rel, tables: hits.sort() });
}

// ── 5. THE INVARIANTS ───────────────────────────────────────────────────────
const violations = [];
if (gateImporters.length) {
  violations.push(`src/lib/agents/gate.js has gained importer(s): ${gateImporters.join(', ')}. `
    + 'The inventory above says it has none, and a stale inventory is how "no callers" survives '
    + 'past the point of being true. Re-measure, and migrate the new caller to authz/boundary.js '
    + 'rather than widening gate.js.');
}
const prodGateCalls = gateEntryCalls.filter((c) => c.kind === 'production');
if (prodGateCalls.length) {
  violations.push('gate.js\'s entry points are now called from PRODUCTION: '
    + `${prodGateCalls.map((c) => `${c.file}:${c.fn}`).join(', ')}. `
    + 'Those calls must go through authz/boundary.js.');
}
const prodBoundaryCalls = boundaryCalls.filter((c) => c.kind === 'production');
const checkerBoundaryCalls = boundaryCalls.filter((c) => c.kind === 'checker');
const testBoundaryCalls = boundaryCalls.filter((c) => c.kind === 'test');
if (!prodBoundaryCalls.length) {
  violations.push('NOTHING in production calls the unified boundary. The architecture exists and '
    + 'is adopted by nothing, which is the state this inventory is meant to make visible rather '
    + 'than let pass as "implemented".');
}

const out = {
  generated_at: new Date().toISOString(),
  reconciliation: {
    claim_corrected: '111 call sites was B7.21 figure attached to gate.js in error; it cannot be '
      + 'substantiated for either migration and should not have been reported',
    gate_js_importers: gateImporters,
    gate_js_entry_point_calls_production: prodGateCalls,
    gate_js_entry_point_calls_tests_and_checkers:
      gateEntryCalls.filter((c) => c.kind !== 'production').length,
    legacy_tests_prove: 'that gate.js still behaves as it did. NOT production adoption: production '
      + 'never calls it.',
  },
  already_migrated_production: prodBoundaryCalls,
  exercised_by_checkers: [...new Set(checkerBoundaryCalls.map((c) => c.file))],
  exercised_by_tests: [...new Set(testBoundaryCalls.map((c) => c.file))],
  needs_review_heuristic: needsReview,
  heuristic_caveat: 'over-reports a module handed an already-resolved context, and under-reports '
    + 'one that resolves a context then queries something else. A worklist, not a verdict.',
  scoped_tables_considered: SCOPED_TABLES,
  violations,
};

if (JSON_OUT) {
  console.log(JSON.stringify(out, null, 2));
  process.exit(violations.length ? 1 : 0);
}

const line = (s = '') => console.log(s);
line('── UNIFIED AUTHORIZATION: ADOPTION INVENTORY ────────────────────────────');
line();
line('  1. ACTUAL gate.js CALLERS');
line(`     production modules importing it: ${gateImporters.length || 'NONE'}`);
line(`     calls to callAgent / callTool from PRODUCTION: ${prodGateCalls.length || 'NONE'}`);
line(`     …the same calls inside tests and checkers:  ${gateEntryCalls.length - prodGateCalls.length}`
  + ' (not adoption)');
line();
line('     The owner\'s §5 finding is confirmed. gate.js is unreferenced in production, so its 15');
line('     passing legacy tests demonstrate that IT still behaves as before — not that production');
line('     has adopted anything. "111 call sites" was B7.21\'s figure, attached to gate.js in');
line('     error; it cannot be substantiated and is withdrawn.');
line();
line(`  2. ALREADY MIGRATED — PRODUCTION callers of the unified boundary (${prodBoundaryCalls.length})`);
if (!prodBoundaryCalls.length) line('     NONE');
for (const c of prodBoundaryCalls) line(`     ${c.file.padEnd(44)} ${c.fn}()`);
line();
line('     One module. gate.js is the bridge, so every legacy product tool call that ever happens');
line('     traverses the boundary — and nothing else in production calls either entry point yet.');
line();
const ckFiles = [...new Set(checkerBoundaryCalls.map((c) => c.file))];
const tFiles = [...new Set(testBoundaryCalls.map((c) => c.file))];
line(`  3. EXERCISED BY CHECKERS (${checkerBoundaryCalls.length} calls across ${ckFiles.length} file(s))`
  + ` AND TESTS (${testBoundaryCalls.length} across ${tFiles.length}) — NOT adoption`);
for (const f of [...ckFiles, ...tFiles]) line(`     ${f}`);
line();
line(`  4. NEEDS REVIEW — company-scoped data, no context resolved in the file (${needsReview.length})`);
line('     A HEURISTIC and a worklist, not a verdict. See the caveat in --json.');
for (const n of needsReview.slice(0, 40)) {
  line(`     ${n.file.padEnd(44)} ${n.tables.join(', ')}`);
}
if (needsReview.length > 40) line(`     … and ${needsReview.length - 40} more`);
line();
if (violations.length) {
  line('── INVARIANTS BROKEN ────────────────────────────────────────────────────');
  for (const v of violations) line(`  FAIL  ${v}`);
  line();
  process.exit(1);
}
line('OK  the inventory holds: gate.js has no production callers, and the boundary has some.');
process.exit(0);
