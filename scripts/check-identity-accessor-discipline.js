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
// Each company-scoped table, with the ONE module allowed to touch it. Generalised when
// workflow_companies arrived: a second copy of this check, differing only in a table name, is the
// duplication these single-accessor rules exist to prevent.
//
// `agent_memory` (B3.1) joined on that argument rather than getting a third copy of this file. It
// is not an identity table, but it is governed by the identical rule and fails the identical way:
// it is company-scoped, so a read that forgets `AND company_id = $n` is a cross-tenant disclosure
// with a primary-key index on it. What these tables have in common is not their subject — it is
// that one missing predicate crosses a company boundary.
const TABLES = Object.freeze({
  user_companies: 'src/lib/identity/company-membership.js',
  workflow_companies: 'src/lib/identity/workflow-company.js',
  agent_memory: 'src/lib/office/memory.js',
});

// Each exemption carries the reason it is one. A list of bare paths becomes a place to add a file
// rather than a decision somebody made.
const EXEMPT = new Map([
  ['scripts/check-autonomous-office-cycle-db.js',
    'the B3.10 cycle driver. It uses the real accessors everywhere it acts — grantMembership for '
    + 'the membership, office/memory for recall, scoped-operations for the task — and reaches the '
    + 'tables directly in exactly two places: its CLEANUP, and the briefing recount in step 13, '
    + 'which must come from an INDEPENDENT path or the briefing would be checked against itself. '
    + 'Its own disposable cluster; no URL override.'],
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
  ['scripts/propose-workflow-company-mappings.js',
    'NAMES the table in its report text and recommendation; reads live mappings only through '
    + 'workflow-company.js allMappings(). scripts/proposal-is-readonly.test.js asserts it cannot '
    + 'INSERT, UPDATE, DELETE or call the accessor\'s writers.'],
  ['scripts/check-workflow-company-scoping-db.js',
    'inserts the four approved mappings as FIXTURES to prove its tripwire fires, then removes them '
    + 'BY ID. It reads live mappings only through workflow-company.js allMappings(); the direct SQL '
    + 'is the fixture cleanup, which must not depend on the accessor it is testing around.'],
  ['scripts/check-office-memory-integration-db.js',
    'drives the REAL Executive Agent against a disposable cluster, so its raw SQL is fixture setup and cleanup for rows this run created: it counts memories and outcomes by the fixture COMPANY IDS it inserted, and forces failures by intercepting specific statements to prove a failed review writes nothing. The agent itself reaches the tables only through the accessors — that is what is being verified.'],
  ['scripts/check-office-k2-db.js',
    'deletes the agent_memory rows ITS OWN agent run produced, scoped to the fixture company ids '
    + 'it created, because agent_memory references companies ON DELETE RESTRICT and the company '
    + 'cleanup fails without it. Still by an id this run made: never by timestamp, never by '
    + 'pattern. It reads nothing from the table.'],
  ['scripts/validate-k1-deployed.js',
    'NAMES the three company-scoped tables in AUTHORIZED_COMPANY_ID_TABLES, which is a list of '
    + 'table names compared against information_schema — it is the authoritative record of which '
    + 'tables may carry company_id, not a query against any of them. A validator whose whole job '
    + 'is to notice an unauthorized company_id column must be allowed to name the authorized ones.'],
  ['scripts/validate-k2-deployed.js',
    'COUNTS leftover agent_memory rows for the fixture companies it created, as part of proving '
    + 'that nothing survived its rollback. The accessor cannot serve that: the question is whether '
    + 'ANY row remains, including one the live predicate would filter out as superseded or expired '
    + '— a leak the accessor would politely hide. It reads only a COUNT, writes nothing, and '
    + 'guards the table name with to_regclass so an unmigrated production database reads as zero.'],
  ['src/lib/identity/scoped-operations.js',
    'THE accessor for the company_id columns B7.21 added to the operational tables, and it reads '
    + 'the roster through company-membership.js rather than writing a second predicate. Every '
    + 'function takes a resolved context and none takes a company id.'],
  ['scripts/check-record-ownership-db.js',
    'asserts the DATABASE constraints directly and goes around the accessor on purpose: two '
    + 'partial unique indexes and the NULL-is-invisible property cannot be proved through code '
    + 'written to satisfy them, and the central assertion is that an UNATTRIBUTED row is returned '
    + 'to nobody — which requires inserting one. Disposable cluster; fixtures removed by id.'],
  ['src/lib/office/memory.js',
    'THE accessor for agent_memory, and its DDL. Its whole purpose is to own that table — and it '
    + 'is the only module that may, because every function it exports takes a resolved company '
    + 'context and reads the company off it rather than accepting one.'],
  ['scripts/check-office-memory-db.js',
    'asserts the DATABASE constraints directly, going around the accessor on purpose: a composite '
    + 'foreign key and a partial unique index cannot be proved through code written to satisfy '
    + 'them. Its fixtures are recorded and removed by id, and it reports leaks.'],
  ['scripts/proposal-is-readonly.test.js',
    'the table name appears inside the REGEXES that assert the proposal tool cannot write to it — '
    + 'a test whose whole subject is "no SQL against this table" must be allowed to quote the SQL '
    + 'it forbids.'],
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
