#!/usr/bin/env node
// ── WHAT COULD THIS MIGRATION DO TO PRODUCTION DATA? ─────────────────────────
//
//   node scripts/analyze-migration-risks.js [--json out.json]
//
// Ruling 29 item 4: "Report any schema differences, migration risks, destructive operations, and
// recovery limitations."
//
// This is a STATIC analysis of every statement the migrator would execute. It connects to nothing
// and changes nothing, so it can be run before any decision about production is made. It answers
// one question: if `node scripts/migrate.js` were pointed at the production database, which
// statements could destroy or alter data that is already there?
//
// ── WHY STATIC, WHEN A RESTORE TEST EXISTS ───────────────────────────────────
//
// scripts/verify-migration-readiness.js runs the migration for real, but until a production dump is
// supplied it runs against a database this repository built — and ruling 29 item 4 says plainly
// that a production-like test is not sufficient. A static scan has the opposite bias: it cannot
// tell whether a statement will match any rows, but it cannot be fooled by a fixture either. The
// two are complementary and neither replaces the other.
//
// ── WHAT COUNTS AS DESTRUCTIVE ───────────────────────────────────────────────
//
// Anything that can remove or overwrite data that exists before the migration runs:
//   DROP TABLE / DROP COLUMN / DROP CONSTRAINT / DROP INDEX / DROP FUNCTION / DROP TRIGGER
//   TRUNCATE
//   DELETE
//   UPDATE                      (an existing row's value is replaced)
//   ALTER COLUMN ... TYPE       (a cast can fail or silently round)
//   ALTER COLUMN ... SET NOT NULL  (fails outright if any existing row is null)
//   RENAME                      (not data loss, but it breaks running code mid-deploy)
//
// `IF EXISTS` is reported but does NOT make a statement safe: `DROP COLUMN IF EXISTS referred_by`
// drops the column wherever it exists, which is precisely where the data is.
//
// Exit status: 0 = the analysis completed. It is a REPORT, not a gate — a destructive statement
// may be entirely correct. Reading it is the point.

'use strict';

const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');
const JSON_OUT = (() => { const i = process.argv.indexOf('--json'); return i === -1 ? null : process.argv[i + 1]; })();

const PATTERNS = [
  { kind: 'DROP TABLE', severity: 'destructive', re: /\bDROP\s+TABLE\b[^;'"`]*/gi },
  { kind: 'DROP COLUMN', severity: 'destructive', re: /\bDROP\s+COLUMN\b[^;'"`]*/gi },
  { kind: 'TRUNCATE', severity: 'destructive', re: /\bTRUNCATE\b[^;'"`]*/gi },
  { kind: 'DELETE', severity: 'destructive', re: /\bDELETE\s+FROM\b[^;'"`]*/gi },
  { kind: 'UPDATE', severity: 'mutating', re: /\bUPDATE\s+[a-z_][\w."]*\s+SET\b[^;'"`]*/gi },
  { kind: 'ALTER COLUMN TYPE', severity: 'mutating', re: /\bALTER\s+(?:COLUMN\s+)?[\w"]+\s+(?:SET\s+DATA\s+)?TYPE\b[^;'"`]*/gi },
  { kind: 'SET NOT NULL', severity: 'mutating', re: /\bSET\s+NOT\s+NULL\b/gi },
  { kind: 'RENAME', severity: 'breaking', re: /\bRENAME\s+(?:TO|COLUMN|CONSTRAINT)\b[^;'"`]*/gi },
  { kind: 'DROP CONSTRAINT', severity: 'weakening', re: /\bDROP\s+CONSTRAINT\b[^;'"`]*/gi },
  { kind: 'DROP INDEX', severity: 'weakening', re: /\bDROP\s+INDEX\b[^;'"`]*/gi },
  { kind: 'DROP FUNCTION', severity: 'weakening', re: /\bDROP\s+FUNCTION\b[^;'"`]*/gi },
  { kind: 'DROP TRIGGER', severity: 'weakening', re: /\bDROP\s+TRIGGER\b[^;'"`]*/gi },
];

// Statements that are part of a CREATE OR REPLACE / idempotent guard rather than a change to
// existing data. DROP TRIGGER immediately followed by CREATE TRIGGER is the standard way to make a
// trigger definition idempotent, and reporting it as a risk would bury the ones that matter.
function isIdempotentGuard(kind, text, whole, index) {
  if (kind === 'DROP TRIGGER' || kind === 'DROP INDEX' || kind === 'DROP FUNCTION') {
    const after = whole.slice(index, index + 600);
    if (/CREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|INDEX|FUNCTION)/i.test(after)) return true;
  }
  return false;
}

// ── FORWARD PATH, OR A ROLLBACK THE MIGRATOR NEVER TAKES? ───────────────────
//
// Several of these scripts carry a --rollback branch that drops a dozen tables — behind a second
// flag, --i-understand-this-drops-tables. `node scripts/migrate.js` passes no arguments, so none of
// that ever runs. Reporting those DROPs beside the statements that DO run would bury the one that
// matters, and a risk report nobody trusts is worse than none.
//
// Decided by looking BACKWARD from the statement for the nearest rollback marker that is still open
// — a ROLLBACK_* constant it sits inside, or an `if (argv.includes('--rollback'))` branch.
function pathOf(whole, index) {
  const before = whole.slice(0, index);
  const markers = [
    /ROLLBACK_(?:EXTRA_)?DDL\s*=\s*\[/g,
    /ROLLBACK_ORDER\s*=\s*\[/g,
    /argv\.includes\(['"]--rollback['"]\)/g,
    /--i-understand-this-drops-tables/g,
  ];
  let lastMarker = -1;
  for (const re of markers) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(before)) !== null) lastMarker = Math.max(lastMarker, m.index);
  }
  if (lastMarker === -1) return 'forward';
  // A rollback section ends at the next top-level `];` or `return` after its marker. If the
  // statement is past that, it is back in the forward path.
  const tail = whole.slice(lastMarker, index);
  const closed = /\n\]\s*;|\n\s{0,4}return\s|\nconst\s+[A-Z_]+\s*=/.test(tail);
  return closed ? 'forward' : 'rollback';
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
    .replace(/^\s*--.*$/gm, ' ');
}

function scanFile(rel) {
  const abs = path.join(repo, rel);
  if (!fs.existsSync(abs)) return null;
  const raw = fs.readFileSync(abs, 'utf8');
  const code = stripComments(raw);
  const found = [];
  for (const { kind, severity, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const text = m[0].replace(/\s+/g, ' ').trim().slice(0, 120);
      if (isIdempotentGuard(kind, text, code, m.index)) continue;
      const line = code.slice(0, m.index).split('\n').length;
      found.push({
        kind,
        severity,
        guarded: /IF\s+EXISTS/i.test(text),
        path: pathOf(code, m.index),
        line,
        text,
      });
    }
  }
  return found;
}

// Every file the migrator executes, in order.
function migrationSources() {
  const { SCHEMA_STEPS } = require('../src/lib/migrate-all');
  const out = [];
  for (const step of SCHEMA_STEPS) {
    const src = String(step.run);
    const m = src.match(/runScript\('([^']+)'/);
    if (m) { out.push({ step: step.name, file: m[1] }); continue; }
    // Steps that go through a module rather than a script.
    if (/migrateOffice/.test(src)) out.push({ step: step.name, file: 'src/lib/office/schema.js' });
    else if (/migrateConnectors/.test(src)) out.push({ step: step.name, file: 'src/lib/connectors/schema.js' });
    else if (/migrateAutonomy/.test(src)) out.push({ step: step.name, file: 'src/lib/autonomy.js' });
    else if (/migrateRuns/.test(src)) out.push({ step: step.name, file: 'src/lib/runs.js' });
    else if (/supplier-rfq/.test(src)) out.push({ step: step.name, file: 'src/lib/idempotency/supplier-rfq.js' });
    else if (/rfq-identity-guard/.test(src)) out.push({ step: step.name, file: 'src/lib/procurement/rfq-identity-guard.js' });
    else if (/intake-schema/.test(src)) out.push({ step: step.name, file: 'src/lib/office/intake-schema.js' });
    else if (/opportunity-schema/.test(src)) out.push({ step: step.name, file: 'src/lib/office/opportunity-schema.js' });
    else if (/opportunity-audit-schema/.test(src)) out.push({ step: step.name, file: 'src/lib/office/opportunity-audit-schema.js' });
    else if (/db\.init|db\.migrate/.test(src)) out.push({ step: step.name, file: 'src/lib/db.js' });
    else out.push({ step: step.name, file: null });
  }
  return out;
}

const bar = (c = '─') => c.repeat(78);
const h = (t) => console.log(`\n${bar()}\n${t}\n${bar()}`);

const sources = migrationSources();
const seenFiles = new Set();
const report = [];

for (const s of sources) {
  if (!s.file || seenFiles.has(s.file)) continue;
  seenFiles.add(s.file);
  const found = scanFile(s.file);
  if (found === null) { report.push({ ...s, missing: true, findings: [] }); continue; }
  if (found.length) report.push({ ...s, findings: found });
}

console.log(`\n${bar()}`);
console.log('MIGRATION RISK ANALYSIS — static, connects to nothing, changes nothing');
console.log(bar());
console.log(`  ${sources.length} migration step(s) · ${seenFiles.size} distinct source file(s) scanned`);

const bySeverity = { destructive: [], mutating: [], breaking: [], weakening: [] };
const rollbackOnly = [];
for (const r of report) {
  for (const f of r.findings) {
    const entry = { ...f, step: r.step, file: r.file };
    if (f.path === 'rollback') rollbackOnly.push(entry);
    else bySeverity[f.severity].push(entry);
  }
}

const LABEL = {
  destructive: 'DESTRUCTIVE — can remove data that exists before the migration',
  mutating: 'MUTATING — can change or reject existing rows',
  breaking: 'BREAKING — renames an object the running application may be using',
  weakening: 'WEAKENING — removes a constraint, index, function or trigger',
};

for (const sev of ['destructive', 'mutating', 'breaking', 'weakening']) {
  const list = bySeverity[sev];
  h(`${LABEL[sev]} — ${list.length} statement(s)`);
  if (!list.length) { console.log('  none'); continue; }
  for (const f of list) {
    console.log(`  ${f.file}:${f.line}  [${f.kind}${f.guarded ? ', IF EXISTS' : ''}]`);
    console.log(`      step: ${f.step}`);
    console.log(`      ${f.text}`);
  }
}

h(`ROLLBACK-ONLY — ${rollbackOnly.length} statement(s) the migrator never executes`);
if (!rollbackOnly.length) console.log('  none');
else {
  console.log('  These sit in a --rollback branch or a ROLLBACK_* constant. `node scripts/migrate.js`');
  console.log('  passes no arguments, and several additionally demand --i-understand-this-drops-tables.');
  console.log('  Listed so they are known, NOT counted as migration risk:');
  const byFile = {};
  for (const f of rollbackOnly) (byFile[f.file] = byFile[f.file] || []).push(`${f.kind}:${f.line}`);
  for (const [file, items] of Object.entries(byFile)) console.log(`      ${file}  ${items.join(', ')}`);
}

h('WHAT THIS MEANS FOR A PRODUCTION RUN');
const d = bySeverity.destructive.length;
const m = bySeverity.mutating.length;
const b = bySeverity.breaking.length;
console.log(`  ${d} destructive · ${m} mutating · ${b} breaking · ${bySeverity.weakening.length} weakening`);
console.log('');
console.log('  IF EXISTS does NOT make a statement safe. "DROP COLUMN IF EXISTS referred_by" drops');
console.log('  the column wherever it exists, which is exactly where the data is.');
console.log('');
console.log('  A statement listed here may be entirely correct. This is a report to read before');
console.log('  pointing the migrator at production, not a verdict on the migration.');
console.log('');
console.log('  It CANNOT tell you whether any of these match rows in YOUR database. Only a restore');
console.log('  of the real dump can (scripts/verify-migration-readiness.js <dump>).');

if (JSON_OUT) {
  fs.writeFileSync(path.resolve(JSON_OUT), `${JSON.stringify({
    generated_at: new Date().toISOString(),
    steps: sources.length,
    files_scanned: [...seenFiles],
    counts: Object.fromEntries(Object.entries(bySeverity).map(([k, v]) => [k, v.length])),
    findings: bySeverity,
  }, null, 2)}\n`);
  console.log(`\n  wrote ${JSON_OUT}`);
}
console.log('');
process.exit(0);
