'use strict';
// ── A NAV ITEM NO PRODUCT CLAIMS IS INVISIBLE. ────────────────────────────────
//
// On 2026-10-09 the SCOPE Europe page shipped, deployed, and could not be found. The entry was in
// NAV_SECTIONS, it was gated correctly in NAV_PAGE_REQS, scripts/verify-classic-nav-parity.js
// declared the seven roles that gain it and passed — and the sidebar showed nothing, in a fresh
// incognito window, for a super admin.
//
// The cause: buildNav has TWO shells. The classic one renders NAV_SECTIONS filtered by tier. The
// product-first one — which is what is actually enabled — renders the same sections filtered to
// `PRODUCTS[].pages`, an explicit per-product allowlist. A page absent from every product's list is
// invisible in that shell no matter how correct everything else is.
//
// So the parity checker was green about a shell nobody was looking at. That is worse than a failing
// check: it is a check that produces confidence without coverage. This file closes the gap, and the
// rule it encodes is the one that was missing — EVERY nav item must be claimed by some product, and
// must have a title, or it cannot be reached and its header renders blank.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');

function grab(re, name) {
  const m = re.exec(HTML);
  assert.ok(m, `${name} not found in public/index.html`);
  return m[0];
}

// Evaluate the three literals in a sandbox rather than regexing their contents: they are long,
// nested, and a parse by regex is how a guard quietly stops guarding.
const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  grab(/const NAV_SECTIONS = \[[\s\S]*?\n\];/, 'NAV_SECTIONS') + '\n' +
  grab(/const PRODUCTS = \[[\s\S]*?\n\];/, 'PRODUCTS') + '\n' +
  grab(/const NAV_PAGE_REQS = \{.*?\};/, 'NAV_PAGE_REQS') + '\n' +
  'globalThis.__sections = NAV_SECTIONS; globalThis.__products = PRODUCTS; globalThis.__reqs = NAV_PAGE_REQS;',
  ctx);

const SECTIONS = ctx.__sections;
const PRODUCTS = ctx.__products;
const REQS = ctx.__reqs;

const navIds = [];
for (const s of SECTIONS) for (const it of s.items || []) navIds.push(it.id);

const claimed = new Set();
for (const p of PRODUCTS) for (const pg of p.pages || []) claimed.add(pg);

// The page-title map, which the header reads. A page missing from it renders an empty title.
const TITLES = (() => {
  const m = /const titles = \{[\s\S]*?\};/.exec(HTML);
  assert.ok(m, 'the page-title map was not found');
  const c = {};
  vm.createContext(c);
  vm.runInContext(m[0] + '\nglobalThis.__t = titles;', c);
  return c.__t;
})();

// Items that are deliberately not on a product tab. `platform` and `me` render to the RIGHT of the
// product tabs and are not products, so their pages are reachable without being claimed. Anything
// else listed here is an exemption that must be argued for in this comment, not just added.
const NOT_PRODUCT_SCOPED = new Set([
  'my-tasks', 'my-kpis', 'my-activity', 'my-performance', 'playbook', 'milestones', 'outreach',
  'ai-insights', 'team', 'agent-control', 'decision-engine', 'employee-activity',
  'sku-economics', 'data-pipeline', 'execution-graph', 'settings',
]);

test('every nav item is claimed by a product or explicitly exempt', () => {
  const orphans = navIds.filter((id) => !claimed.has(id) && !NOT_PRODUCT_SCOPED.has(id));
  assert.deepStrictEqual(orphans, [],
    'these nav items are in NAV_SECTIONS but in no PRODUCTS[].pages list, so the product-first ' +
    'sidebar — the shell that is actually enabled — will not render them: ' + orphans.join(', '));
});

test('SCOPE Europe specifically is claimed, next to CPHI Milan', () => {
  // The regression this file exists for. Both are Abiozen event pages and belong to the same tab.
  const abiozen = PRODUCTS.find((p) => p.key === 'abiozen');
  assert.ok(abiozen, 'the abiozen product is gone');
  assert.ok(abiozen.pages.includes('cphi-milan'), 'cphi-milan left the abiozen product');
  assert.ok(abiozen.pages.includes('scope-europe'),
    'scope-europe is not in the abiozen product — it will be invisible in the product shell');
});

test('every nav item has a page title', () => {
  // A page absent from the title map renders a blank header, which reads as a broken page.
  const untitled = navIds.filter((id) => !TITLES[id]);
  assert.deepStrictEqual(untitled, [], 'nav items with no entry in the title map: ' + untitled.join(', '));
});

test('every nav item has a page function somewhere', () => {
  // A page is registered in one of FOUR ways, and a guard that knows only one is a guard that
  // reports fourteen false positives — which is how this test read on its first run, and six on
  // its second:
  //   1. pages['x'] = async function ...         assigned after the literal
  //   2. 'x': async function ...                 a key inside the const pages = { ... } literal
  //   3. async 'x'() { ... }                     ES6 shorthand method in that same literal
  //   4. in an external bundle                   public/sitenex-phase3.js, public/labconnect.js
  const EXTERNAL = ['public/sitenex-phase3.js', 'public/labconnect.js']
    .map((p) => path.join(__dirname, '../..', p))
    .filter((p) => fs.existsSync(p))
    .map((p) => fs.readFileSync(p, 'utf8'))
    .join('\n');
  const ALL = HTML + '\n' + EXTERNAL;

  const registered = (id) => {
    const q = id.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    return ALL.includes(`pages['${id}']`) || ALL.includes(`pages["${id}"]`) ||
      new RegExp(`['"]${q}['"]\\s*:\\s*(async\\s+)?function`).test(ALL) ||   // 'x': async function
      new RegExp(`['"]${q}['"]\\s*:\\s*(async\\s*)?\\(`).test(ALL) ||        // 'x': async (…) =>
      new RegExp(`(async\\s+)?['"]${q}['"]\\s*\\(`).test(ALL) ||             // async 'x'() {
      // Unquoted shorthand, for ids that happen to be valid identifiers: `async revenue() {`.
      // Anchored to a line start so a call site like `settings(…)` elsewhere cannot satisfy it.
      (/^[A-Za-z_$][\w$]*$/.test(id) &&
        new RegExp(`^\\s*(async\\s+)?${q}\\s*\\(\\s*\\)\\s*\\{`, 'm').test(ALL));
  };

  const missing = navIds.filter((id) => !registered(id));
  assert.deepStrictEqual(missing, [],
    'nav items with no page function in any of the three registration forms — clicking them does ' +
    'nothing: ' + missing.join(', '));
});

test('no product claims a page that is not in the nav', () => {
  // The reverse drift: a product listing a page that was renamed or removed silently widens
  // nothing, but it hides the rename, and the next person reads the list as current.
  const navSet = new Set(navIds);
  const ghosts = [];
  for (const p of PRODUCTS) {
    for (const pg of p.pages || []) {
      if (!navSet.has(pg) && !NOT_PRODUCT_SCOPED.has(pg)) ghosts.push(`${p.key}:${pg}`);
    }
  }
  assert.deepStrictEqual(ghosts, [], 'products claiming pages that are not nav items: ' + ghosts.join(', '));
});

test('a gated nav item is gated in NAV_PAGE_REQS, not left to fail open', () => {
  // A page with no NAV_PAGE_REQS entry has NO tier requirement: it shows to anyone who can see the
  // section. That is how scope-europe first shipped, and it happened to produce the right roles by
  // accident. Event and intelligence pages must be gated explicitly.
  //
  // The exemptions are the pages that are deliberately open to every signed-in user.
  const OPEN_BY_DESIGN = new Set([
    'my-tasks', 'my-kpis', 'my-activity', 'my-performance', 'playbook', 'milestones', 'outreach',
    'dashboard', 'apollo-outreach', 'ai-insights', 'team', 'settings', 'performance',
    'employee-activity', 'decision-engine', 'data-pipeline', 'execution-graph',
  ]);
  const ungated = navIds.filter((id) => !REQS[id] && !OPEN_BY_DESIGN.has(id));
  assert.deepStrictEqual(ungated, [],
    'nav items with no tier requirement, so they fail OPEN to anyone holding the section: ' +
    ungated.join(', '));
});
