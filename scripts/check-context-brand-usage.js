#!/usr/bin/env node
// ── NOBODY BUT context.js MENTIONS THE BRAND KEY ────────────────────────────
//
//   node scripts/check-context-brand-usage.js   exit 0 = the brand cannot be minted elsewhere
//
// src/lib/office/context.js marks every company context with `Symbol.for('playnexa.office
// .companyContext.v1')`, and `assertContext` accepts nothing without it. That closed a real hole:
// the guard previously required `Object.isFrozen` plus a `companyId`, so
// `assertContext(Object.freeze({ companyId: 'co-someone-elses-company' }))` was ACCEPTED, and four
// production modules were fabricating contexts that passed their own assertion.
//
// A REGISTRY symbol is used rather than a module-private one for a mechanical reason: several
// verification harnesses clear the office modules from require.cache to exercise a mutated copy,
// and a private symbol does not survive that — the reloaded instance mints a new one and refuses
// contexts created moments earlier.
//
// The cost is that any in-process code holding the key can mint the brand. That is what this check
// removes: the key appears in exactly one file, so minting a context outside the resolvers is not
// something a reviewer has to notice.
//
// WHAT THIS DOES NOT CLAIM. It is a repository check, not a runtime one. It cannot stop code that
// is already running from calling Symbol.for itself, and it protects this repository rather than
// the process. What it is proof against is the thing owner requirement 7 names — an agent cannot
// manufacture a context, because an agent produces text, and text cannot carry a Symbol at all.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { blankCommentsOnly } = require('./js-lex');

const ROOT = path.join(__dirname, '..');
const KEY = 'playnexa.office.companyContext';

const ALLOWED = new Set([
  path.join('src', 'lib', 'office', 'context.js'),      // defines and stamps it
  path.join('scripts', 'check-context-brand-usage.js'), // this file
]);

const violations = [];
let scanned = 0;

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
    scanned++;
    if (ALLOWED.has(rel)) continue;
    const raw = fs.readFileSync(abs, 'utf8');
    if (!raw.includes(KEY)) continue;
    // Comments stripped: a file explaining the brand must not fail for naming it.
    if (!blankCommentsOnly(raw).includes(KEY)) continue;
    violations.push(`${rel} references the context brand key. A context must come from a resolver `
      + 'in src/lib/office/context.js — minting the brand elsewhere reintroduces exactly the '
      + 'forgery that branding removed.');
  }
}

console.log(`  ${scanned} file(s) scanned; the brand key appears only where it is defined.`);
if (violations.length) {
  console.error(`\nFAIL — ${violations.length} file(s) reference the brand key:\n`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log('\nOK: only src/lib/office/context.js can mint a company context.');
process.exit(0);
