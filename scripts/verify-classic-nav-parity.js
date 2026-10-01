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

// DECLARED, INTENDED CHANGES. A parity script that can only say "different" is a script somebody turns
// off the first time they change the nav on purpose. Each entry names a role and the exact pages it should
// gain or lose; the run passes if the real diff matches, and FAILS if it differs even slightly — so an
// intended change does not become cover for an unintended one.
// It compares against a REF (HEAD by default), so these describe the diff versus THAT — not a running
// history. Once a change is committed it becomes the baseline and its entry has to come out, or the script
// expects a diff that is no longer there. That caught me: the Platform entries below were left in after
// they had already landed, and every role failed.
//
// Previously declared and now part of the baseline, kept only as a record of what changed when:
//   2026-09-29  super_admin +decision-engine +data-pipeline +execution-graph   (Platform got its
//               three unreachable pages), admin −sku-economics −settings        (Platform → super-admin only)
//   2026-09-30  EVERY role +outreach  (the Outreach page went into OPERATIONS, access:'*')
//   2026-09-30  super_admin / admin / partner +sitenex-contracts  (SiteNex Phase 3)
//
// 2026-10-01, multi-partner SiteNex: PARTNER ONLY gains sitenex-prospects, because NAV_PAGE_REQS moved that
// page from [["intelligence"]] to [["sitenex"]]. Staff already held the intelligence tier and so already saw
// it — which is why this is one role and not three, and why a second role appearing here would mean the tier
// grid had changed rather than the nav.
//
// The page is not simply opened: territoryScopeSql decides the ROWS and fails closed, so a partner with no
// granted territory reaches the screen and sees nothing, with a sentence explaining why.
const EXPECTED = {
  partner: { gained: ['sitenex-prospects'], lost: [] },
};
// Retired to empty, because 'outreach' is now in the BASELINE. Left as-is it expected every unchanged
// role to gain a page it already has — which is harmless only while no role's nav differs at all, and
// becomes a wrong expectation the moment one does. EXPECTED[role] REPLACES this rather than merging, so
// the three entries above must each list their full gained set.
const DEFAULT_EXPECTED = { gained: [], lost: [] };
const linksOf = (html) => [...html.matchAll(/navigate\('([^']+)'\)/g)].map(m => m[1]);

let mismatched = 0, added = 0, accepted = 0;
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
  if (same) { console.log(`  IDENTICAL  ${role.padEnd(22)} ${b.length} bytes`); continue; }

  // Report the diff as PAGES, not as truncated HTML — 200 characters of identical markup told nobody
  // anything about what actually changed.
  const gained = linksOf(b).filter(x => !linksOf(a).includes(x));
  const lost = linksOf(a).filter(x => !linksOf(b).includes(x));
  const exp = EXPECTED[role] || DEFAULT_EXPECTED;
  const matches = exp && String(exp.gained.slice().sort()) === String(gained.slice().sort())
                      && String(exp.lost.slice().sort()) === String(lost.slice().sort());
  if (matches) {
    accepted++;
    console.log(`  EXPECTED   ${role.padEnd(22)} ${b.length} bytes` +
      (gained.length ? `  +${gained.join(', ')}` : '') + (lost.length ? `  −${lost.join(', ')}` : ''));
  } else {
    mismatched++;
    console.log(`  DIFFERENT  ${role.padEnd(22)} ${b.length} bytes`);
    console.log(`    gained : ${gained.join(', ') || '(none)'}`);
    console.log(`    lost   : ${lost.join(', ') || '(none)'}`);
    if (exp) console.log(`    EXPECTED gained ${exp.gained.join(', ') || '(none)'} / lost ${exp.lost.join(', ') || '(none)'}`);
    else console.log(`    no entry in EXPECTED — if this change is intended, declare it there`);
  }
}

console.log();
if (mismatched) { console.error(`FAIL — ${mismatched}/${roles.length} role(s) differ in a way nobody declared`); process.exit(1); }
console.log(`PASS — ${roles.length - added - accepted} role(s) byte-identical` +
  (accepted ? `, ${accepted} changed exactly as declared in EXPECTED` : '') +
  (added ? `, ${added} new role(s) listed above` : ''));
