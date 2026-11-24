#!/usr/bin/env node
// ── THE TEST-ONLY CONTEXT DOOR STAYS TEST-ONLY ──────────────────────────────
//
//   node scripts/check-test-context-usage.js   exit 0 = only tests open the door
//
// `src/lib/office/context.js` brands every company context with a module-private Symbol, so a
// caller cannot forge one — owner requirement 7, "AI agents cannot manufacture or expand company
// context". Before the brand, `assertContext(Object.freeze({ companyId: 'co-someone-elses' }))` was
// ACCEPTED: the guard checked frozen-ness, which any caller can supply, while its own comment
// claimed it checked provenance.
//
// `contextForTests__TEST_ONLY` exists because branding broke 24 assertions that built a context
// by hand. It is the one function that stamps the brand on caller-supplied fields, so it is the one
// thing that could put the forgery back — not by being called from production code deliberately,
// but by someone reaching for it while debugging and leaving it there.
//
// So: only `*.test.js` files may reference it. This check is the whole reason a door is acceptable
// instead of rewriting those 24 tests — the production guarantee is not "nobody would do that", it
// is "the build fails if anybody does".
//
// Comments and strings are stripped before matching, because five guards in this repository have
// fired on their own documentation. A file explaining why it must not call this must not fail for
// containing the sentence.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { blankCommentsOnly } = require('./js-lex');

const ROOT = path.join(__dirname, '..');
const DOOR = 'contextForTests__TEST_ONLY';

// The module that defines and exports it, and this check. Everything else must be a test.
const DEFINING_FILES = new Set([
  'src/lib/office/context.js',
  'scripts/check-test-context-usage.js',
]);

const violations = [];
let testUsers = 0;

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
    const raw = fs.readFileSync(abs, 'utf8');
    if (!raw.includes(DOOR)) continue;
    if (DEFINING_FILES.has(rel)) continue;

    const code = blankCommentsOnly(raw);
    if (!code.includes(DOOR)) continue;          // mentioned only in a comment

    // ── WHERE THE BOUNDARY ACTUALLY IS ──────────────────────────────────────
    //
    // Tests and scripts/ may open the door; src/ may not, with context.js itself the only
    // exception. That is not a convenience: a file under scripts/ holds a Postgres connection and
    // can INSERT a row for any company directly, so a fabricated context grants it nothing it did
    // not already have. The forgery that matters is in shipped application code, where the caller
    // is an agent or an HTTP request and the database is reached only through modules that demand
    // a resolved context.
    //
    // Checked by path rather than by filename suffix, because the verification harnesses are
    // `check-*.js` and `validate-*.js`, not `*.test.js`, and six of them broke on the brand.
    if (rel.endsWith('.test.js') || rel.startsWith(`scripts${path.sep}`)) { testUsers++; continue; }
    const lines = code.split('\n')
      .map((l, i) => (l.includes(DOOR) ? `${rel}:${i + 1}` : null)).filter(Boolean);
    violations.push(`${rel} calls ${DOOR} (${lines.join(', ')}). Application code under src/ must RESOLVE a `
      + 'context — from a run, an objective, or an authenticated read session — so the company is '
      + 'read from stored state rather than chosen by the caller. This door exists only so tests '
      + 'need not stub three queries to get one.');
  }
}

console.log(`  ${testUsers} test/harness file(s) use the door; no src/ file does.`);
if (violations.length) {
  console.error(`\nFAIL — ${violations.length} production file(s) open the test-only door:\n`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`\nOK: ${DOOR} is reached only from tests and harnesses, never from src/.`);
process.exit(0);
