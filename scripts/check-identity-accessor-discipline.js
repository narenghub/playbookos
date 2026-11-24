#!/usr/bin/env node
// ── ONE MODULE OWNS `user_companies`, AND A CHECK KEEPS IT THAT WAY ─────────
//
//   node scripts/check-membership-accessor-discipline.js
//     exit 0 = no module outside the accessor touches the membership table in SQL
//
// `user_companies` decides who may act for which company. The predicate that makes it safe is six
// conditions long — global account status, scoped revocation, effective dates, company status and
// two separate external-role screens — and the K1 ruling already said what happens to a rule like
// that when it is left to discipline:
//
//   "If the proposed enforcement only works because every developer remembers to write
//    WHERE company_id = ?, K1 is not complete."
//
// So callers never write the predicate, because they are never given the table name. This check is
// the difference between "every developer remembers" and "a check fails if they don't".
//
// The membership table is deliberately NOT in office/schema.js KERNEL_TABLES: that list routes a
// table through src/lib/office/scope.js, whose predicate IS the company scope, and this is the
// table that decides company scope. Reading it through the thing it authorizes is circular. Same
// discipline, separate accessor, separate check.
//
// ── COMMENTS ARE NOT CODE ───────────────────────────────────────────────────
//
// Source is stripped of comments and strings before matching. Five guards in this repository have
// fired on their own documentation — a forbidden verb inside a list of forbidden verbs, an
// identifier inside the comment explaining why it was removed — and each time the fix was to match
// statements rather than words. A file explaining why it must not query `user_companies` must not
// fail for containing that sentence.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { blankNonCode } = require('./js-lex');

const ROOT = path.join(__dirname, '..');
// Both identity tables, each with the ONE module allowed to touch it. Generalised when
// workflow_companies arrived: a second copy of this check, differing only in a table name, is the
// duplication these single-accessor rules exist to prevent.
const TABLES = Object.freeze({
  user_companies: 'src/lib/identity/company-membership.js',
  workflow_companies: 'src/lib/identity/workflow-company.js',
});

// Each exemption carries the reason it is one. A list of bare paths becomes a place to add a file
// rather than a decision somebody made.
const EXEMPT = new Map([
  ['src/lib/identity/company-membership.js',
    'THE accessor for user_companies. Its whole purpose is to own that table.'],
  ['src/lib/identity/workflow-company.js',
    'THE accessor for workflow_companies — which company a scheduled workflow acts for.'],
  ['src/lib/identity/schema.js',
    'the DDL that creates the table and its indexes.'],
  ['scripts/check-company-membership-db.js',
    'asserts the DATABASE constraints directly — a CHECK constraint cannot be proved through an '
    + 'accessor that is written to satisfy it, and its fixtures are removed by id.'],
  ['scripts/check-identity-accessor-discipline.js',
    'this file.'],
  ['src/lib/identity/company-membership.test.js',
    'unit tests for the accessor itself.'],
  ['src/lib/identity/workflow-company.test.js',
    'unit tests for the accessor itself.'],
]);

const violations = [];
const checked = [];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { yield* walk(abs); continue; }
    if (e.name.endsWith('.js')) yield abs;
  }
}

for (const dir of ['src', 'scripts']) {
  const base = path.join(ROOT, dir);
  if (!fs.existsSync(base)) continue;
  for (const abs of walk(base)) {
    const rel = path.relative(ROOT, abs);
    if (EXEMPT.has(rel)) { checked.push(`exempt  ${rel} — ${EXEMPT.get(rel)}`); continue; }
    const raw = fs.readFileSync(abs, 'utf8');
    const present = Object.keys(TABLES).filter((t) => raw.includes(t));
    if (!present.length) continue;                 // cheap path: most files never mention it
    // Comments AND string literals blanked: a SQL string is where the table name would actually
    // appear, so this would hide the violation — hence the second pass below on raw lines that
    // survive comment-stripping only.
    const codeOnly = blankNonCode(raw);
    const commentsStripped = require('./js-lex').blankCommentsOnly(raw);
    for (const table of present) {
      if (codeOnly.includes(table) || commentsStripped.includes(table)) {
        const lines = commentsStripped.split('\n')
          .map((l, i) => (l.includes(table) ? `${rel}:${i + 1}` : null))
          .filter(Boolean);
        violations.push(`${rel} queries ${table} outside its accessor (${lines.join(', ') || 'in code'}). `
          + `Use ${TABLES[table]}: the live predicate is several conditions long and a second copy `
          + 'of it will drift from this one.');
      } else {
        checked.push(`ok      ${rel} mentions ${table} only in comments`);
      }
    }
  }
}

for (const line of checked) console.log(`  ${line}`);
if (violations.length) {
  console.error(`\nFAIL — ${violations.length} module(s) reach past the membership accessor:\n`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`\nOK: ${Object.keys(TABLES).join(' and ')} are reached only through their accessors.`);
process.exit(0);
