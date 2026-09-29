// ── Classic-nav parity proof (READ-ONLY) ──
//
// PRODUCT_NAV is flag-gated and the contract is that with the flag OFF the classic sidebar is
// BYTE-IDENTICAL to what it was before any pnav work. Every pnav change has to prove that, not
// claim it — the two paths live in the same function (buildNav) and share NAV_SECTIONS,
// navSectionVisible and passesPageReads, so a careless edit reaches both.
//
// This lifts the classic branch's inputs and its exact template out of public/index.html at two
// git revisions, runs them for all 13 roles, and byte-compares the resulting HTML. It parses the
// file rather than importing it because the SPA is one inline <script> that expects a DOM.
//
// Run:  node scripts/verify-classic-nav-parity.js [baseRef]        (default HEAD)

const { execSync } = require('child_process');
const vm = require('vm');
const { BUILT_IN_ROLES } = require('../src/lib/roles');

const BASE_REF = process.argv[2] || 'HEAD';
const FILE = 'public/index.html';

function grab(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error(`could not locate ${what} — the file shape changed, fix this script`);
  return m[0];
}

/**
 * Rebuild the classic nav for one revision of index.html.
 * Everything below is lifted verbatim from the file; nothing is re-implemented here, so the
 * proof cannot drift from the thing it is proving.
 */
function classicNavFor(src) {
  const navSections   = grab(src, /const NAV_SECTIONS = \[[\s\S]*?\n\];/, 'NAV_SECTIONS');
  const navFamilies   = grab(src, /const NAV_FAMILIES = \{[\s\S]*?\n\};/, 'NAV_FAMILIES');
  const navPageReqs   = grab(src, /const NAV_PAGE_REQS = \{.*?\};/, 'NAV_PAGE_REQS');
  const sectionVisible= grab(src, /function navSectionVisible\([\s\S]*?\n\}/, 'navSectionVisible');
  const pageReads     = grab(src, /function passesPageReads\([\s\S]*?\n\}/, 'passesPageReads');
  const canRead       = grab(src, /function roleCanRead\([\s\S]*?\n\}/, 'roleCanRead');

  // The classic branch of buildNav, verbatim. If this template ever changes the diff shows up
  // as a parity failure, which is exactly the alarm we want.
  const tpl = grab(src,
    /const html = NAV_SECTIONS\.map\(section => \{[\s\S]*?\}\)\.join\(''\);/, 'classic buildNav branch');

  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(`${navFamilies}\n${navSections}\n${navPageReqs}\n${sectionVisible}\n${pageReads}\n${canRead}
    globalThis.__render = function(role, tiers) { ${tpl} return html; };`, ctx);
  return ctx.__render;
}

function tiersFor(role) {
  const def = BUILT_IN_ROLES[role];
  return (def && def.tiers) || {};
}

// Roles that did not exist at the base ref cannot have a parity contract — there is nothing to be
// identical TO. They are reported as NEW with their nav printed in full, so a deliberately-added role
// shows what it added instead of failing as a regression, and a role added by accident is still loud.
const baseRoles = new Set(Object.keys(
  (() => { try { return require('vm').runInNewContext(
      execSync(`git show ${BASE_REF}:src/lib/roles.js`, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
        .match(/const BUILT_IN_ROLES = \{[\s\S]*?\n\};/)[0] + '\nBUILT_IN_ROLES;'); }
    catch (e) { console.warn(`(could not read roles.js at ${BASE_REF}: ${e.message}) — treating every role as pre-existing`); return null; }
  })() || BUILT_IN_ROLES));

const roles = Object.keys(BUILT_IN_ROLES);
const before = classicNavFor(execSync(`git show ${BASE_REF}:${FILE}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const after = classicNavFor(require('fs').readFileSync(FILE, 'utf8'));

console.log(`Classic nav (PRODUCT_NAV OFF) — ${BASE_REF} vs working tree`);
console.log(`${roles.length} roles\n`);

let mismatched = 0, added = 0;
for (const role of roles) {
  const t = tiersFor(role);
  const b = after(role, t);
  if (!baseRoles.has(role)) {
    added++;
    const links = [...b.matchAll(/navigate\('([^']+)'\)/g)].map(m => m[1]);
    console.log(`  NEW        ${role.padEnd(22)} ${b.length} bytes — ${links.length} page(s): ${links.join(', ')}`);
    continue;
  }
  const a = before(role, t);
  const same = a === b;
  if (!same) mismatched++;
  console.log(`  ${same ? 'IDENTICAL' : 'DIFFERENT'}  ${role.padEnd(22)} ${b.length} bytes`);
  if (!same) {
    console.log(`    before: ${a.slice(0, 200)}`);
    console.log(`    after : ${b.slice(0, 200)}`);
  }
}

console.log();
if (mismatched) { console.error(`FAIL — ${mismatched}/${roles.length} roles differ with the flag OFF`); process.exit(1); }
console.log(`PASS — classic nav is byte-identical for all ${roles.length - added} pre-existing role(s)` +
  (added ? `; ${added} new role(s) listed above — read their pages and confirm each one is intended` : ''));
