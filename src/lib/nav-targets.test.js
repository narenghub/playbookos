// EVERY NAV ID MUST HAVE A REGISTERED PAGE FUNCTION.
//
//   node --test src/lib/nav-targets.test.js
//
// THE GAP THIS FILLS. The existing reachability tests ask the OTHER question:
//   • inline-handlers.test.js   — is every handler NAMED by the HTML reachable?
//   • board-card.test.js        — does the thing a user clicks reach the form behind it?
// Both start from a handler and look for its target. Neither starts from a NAV ENTRY and asks whether the
// page it names exists at all — so a menu item pointing at nothing passed every one of them, and the symptom
// was navigate() throwing after the "Loading..." paint and the screen sitting there for ever.
//
// It found four, live: sku-economics, decision-engine, data-pipeline and execution-graph are in the nav and
// have no page function. They exist as pre-rendered `<div class="section">` markup, and NOTHING in the
// codebase ever sets those to display:block — so navigate() has been throwing on all four.
//
// Reading the shell is not enough either: some page functions now live in external scripts, and until
// 2026-10-01 index.html was no-store while .js was cached for an hour, so a commit adding a nav entry AND its
// page function shipped them to a browser up to an hour apart.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { blankHtmlComments, externalScriptPaths, registeredPages, navPageIds } = require('./spa-source');

const ROOT = path.resolve(__dirname, '../..');
const PUBLIC = path.join(ROOT, 'public');
const SHELL = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const EXTERNAL = externalScriptPaths(SHELL).map(rel => {
  const full = path.join(PUBLIC, rel);
  assert.ok(fs.existsSync(full), `index.html loads ${rel} but it does not exist`);
  return { rel, code: fs.readFileSync(full, 'utf8') };
});
const NAV = navPageIds(SHELL);
const REGISTERED = registeredPages(SHELL, EXTERNAL.map(e => e.code));
const ALL = [blankHtmlComments(SHELL), ...EXTERNAL.map(e => e.code)].join('\n');

// ── the two declared gaps, both PRE-EXISTING ─────────────────────────────────

// IN THE NAV, NO PAGE FUNCTION. Clicking any of these writes "Loading..." and throws — which is why the
// navigate() guard added alongside this file matters, and why these are listed rather than hidden.
//
// All four are pre-rendered `<div id="section-…" class="section" style="display:none">` blocks from an older
// design, and nothing shows a `.section`. The three Platform ones were ADDED TO THE NAV on 2026-09-29 as
// "the three unreachable Platform pages" — which made them reachable in the MENU and no more functional.
//
// Listed so the gap is visible and cannot grow. Fixing them means writing four pages or removing four menu
// items, and that is a decision, not a cleanup.
const NAV_WITHOUT_A_PAGE = ['data-pipeline', 'decision-engine', 'execution-graph', 'sku-economics'];

// REGISTERED, BUT NOTHING NAVIGATES TO THEM. Dead code a user cannot reach — the same shape as the SiteNex
// deal form, which was complete and unreachable for a week. Also pre-existing and also a decision to resolve.
const PAGE_WITHOUT_A_NAV = ['adoption', 'ai-insights', 'employee-activity', 'milestones', 'playbook',
                            's2-sequence', 's3-sequence', 's4-sequence'];

test('GUARD: the scanners found the nav and the pages at all', () => {
  // Every assertion below is a set comparison, and two empty sets are equal — so the sizes come first.
  assert.ok(NAV.size > 30, `only ${NAV.size} nav ids found — the nav scanner has stopped working`);
  assert.ok(REGISTERED.size > 30, `only ${REGISTERED.size} pages found — the page scanner has stopped working`);
  assert.ok(EXTERNAL.length >= 1, 'at least one external script is expected, and it must be read');
  for (const id of ['dashboard', 'sitenex-deals', 'sitenex-contracts', 'sitenex-partners', 'outreach']) {
    assert.ok(NAV.has(id), `${id} should be a nav id`);
    assert.ok(REGISTERED.has(id), `${id} should be a registered page`);
  }
  // Proves the external files were actually read: this one is registered ONLY there.
  const shellOnly = registeredPages(SHELL, []);
  assert.ok(!shellOnly.has('sitenex-partners') && REGISTERED.has('sitenex-partners'),
    'sitenex-partners is registered in an external file, so finding it proves that file was read');
  // And proves the unquoted column-0 method shorthand is understood — the shape that made the first version
  // of this test report 13 live pages as missing.
  assert.ok(REGISTERED.has('dashboard'), 'async dashboard() { } inside the literal must be recognised');
});

test('EVERY NAV ID HAS A REGISTERED PAGE FUNCTION, bar the declared gap', () => {
  const dead = [...NAV].filter(id => !REGISTERED.has(id)).sort();
  assert.deepEqual(dead, NAV_WITHOUT_A_PAGE.slice().sort(),
    'a menu item points at a page nothing registers, so clicking it leaves "Loading..." on screen:\n  '
    + dead.filter(d => !NAV_WITHOUT_A_PAGE.includes(d)).join('\n  '));
});

test("and the gap cannot grow quietly", () => {
  assert.equal(NAV_WITHOUT_A_PAGE.length, 4,
    'if this list changes, say so out loud: either four broken menu items were fixed, or a fifth was added');
  // Each one really is a static section rather than a forgotten page function — the reason they are listed
  // rather than treated as a regression.
  for (const id of NAV_WITHOUT_A_PAGE) {
    assert.match(SHELL, new RegExp(`id="section-${id}"`),
      `${id} is in the nav with no page AND no static section — that is a plain bug, not the known gap`);
  }
  // And nothing shows a .section, which is why they do not work.
  const code = blankHtmlComments(SHELL);
  assert.ok(!/\.section[^\n]*display\s*:\s*['"]?block/.test(code),
    'if something now SHOWS a .section, these four may work and this gap should be re-measured');
});

test("every navigate('x') literal names a registered page or the declared gap", () => {
  // Buttons and links elsewhere also navigate — a "back to the board" button pointing at a page that no
  // longer exists is the same dead end, reached from inside a screen rather than from the menu.
  const lits = new Set([...ALL.matchAll(/navigate\(\\?'([a-z0-9-]+)\\?'\)/g)].map(m => m[1]));
  // Only a HANDFUL are literals — nearly every navigation is built dynamically (`navigate('${it.id}')`,
  // `navigate(target)`), which is exactly why the runtime guard in navigate() carries the weight here and a
  // static check cannot. The floor is low on purpose; the canary is that it finds any at all.
  assert.ok(lits.size >= 2, `only ${lits.size} navigate() literals found — the scanner has stopped working`);
  assert.ok(lits.has('outreach'), 'a known literal, so the regex is matching the right shape');
  const dead = [...lits].filter(id => !REGISTERED.has(id) && !NAV_WITHOUT_A_PAGE.includes(id)).sort();
  assert.deepEqual(dead, [], `navigate() is called with ids that have no page:\n  ${dead.join('\n  ')}`);
});

test('every REGISTERED page is reachable, bar the declared gap', () => {
  // The other direction, and not symmetry for its own sake: an unreachable page is code a user cannot get to,
  // which is exactly what the SiteNex deal form was for a week while every server test passed.
  const reachedByCode = new Set([...ALL.matchAll(/pages\[['"]([a-z0-9-]+)['"]\]\(\)/g)].map(m => m[1]));
  const orphans = [...REGISTERED]
    .filter(id => !NAV.has(id) && !reachedByCode.has(id))
    .sort();
  assert.deepEqual(orphans, PAGE_WITHOUT_A_NAV.filter(id => !reachedByCode.has(id)).sort(),
    'these pages are registered but nothing reaches them:\n  '
    + orphans.filter(o => !PAGE_WITHOUT_A_NAV.includes(o)).join('\n  '));
});

test('no page id is registered by a COMMENT', () => {
  // My own comment in sitenex-phase3.js wrote `pages['x'] = fn` as an example and duly registered a page
  // called 'x'. A guard that counts an example as a fact will later count a missing page as present.
  for (const id of REGISTERED) {
    assert.match(id, /^[a-z][a-z0-9-]{2,}$/,
      `'${id}' does not look like a page id — probably an example in a comment`);
  }
});

// ── navigate() must not throw into nothing ────────────────────────────────────

const NAV_FN = (() => {
  const from = SHELL.indexOf("content.innerHTML = '<p style=\"color:#888;padding:20px\">Loading...</p>'");
  assert.notEqual(from, -1, 'the loading paint must be findable');
  return SHELL.slice(from, from + 2200);
})();

test('navigate() GUARDS a missing page instead of throwing after the loading paint', () => {
  assert.match(NAV_FN, /typeof fn !== 'function'/, 'the page function must be checked before it is called');
  assert.match(NAV_FN, /navMissingPage/, 'and a card rendered instead of an exception');
  assert.ok(!/\n\s*pages\[page\]\(\);/.test(NAV_FN), 'an unguarded pages[page]() call is the original bug');
});

test('a page that THROWS or REJECTS gets a card too, not a stuck "Loading..."', () => {
  // Most pages are async, so a rejected promise is as invisible as a thrown error and leaves the same stuck
  // screen. Both paths are handled.
  assert.match(NAV_FN, /catch \(e\)/, 'a synchronous throw');
  assert.match(NAV_FN, /out\.catch\(/, 'and a rejected promise');
  assert.match(NAV_FN, /navPageFailed/);
});

test('the error card NAMES the page id, escaped, and the reload advice is the right advice', () => {
  // "Something went wrong" cannot be reported; "sitenex-partners did not load" can. And reload IS the fix for
  // the likely cause — a browser holding older code than the menu it is showing.
  const card = SHELL.slice(SHELL.indexOf('function navMissingPage'), SHELL.indexOf('function navPageFailed'));
  assert.ok(card.length > 200, 'navMissingPage must be findable');
  assert.match(card, /replace\(\/\[&<>"'\]\/g/, 'the id is escaped, because it reaches innerHTML');
  assert.match(card, /Reload the page/);
  assert.match(card, /older copy of the app than the/, 'and it explains WHY reloading would help');
  assert.match(card, /location\.reload\(\)/, 'with a button that does it');
});

// ── the cache header that made this reachable ────────────────────────────────

test("the SPA's own code is served no-store — .js as well as .html", () => {
  // THE LIVE BUG: public/sitenex-phase3.js came back `max-age=3600` while index.html came back `no-store`, so
  // a commit adding a nav entry and its page function shipped them to a browser up to an hour apart. The nav
  // arrived first and pointed at a page the cached script had not registered.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const stat = server.slice(server.indexOf('app.use(express.static'), server.indexOf('// Serve the SPA shell'));
  assert.ok(stat.length > 200, 'the static middleware must be findable');
  assert.match(stat, /endsWith\('\.html'\) \|\| filePath\.endsWith\('\.js'\)/,
    'both .html and .js must be no-store — they are the application, not assets');
  assert.match(stat, /'Cache-Control', 'no-store'/);
  // Images keep the cache: this is about code, not about bytes in general.
  assert.match(stat, /maxAge: "1h"/, 'other assets should still be cached');
});

// ── RUNNING navigate(), not just reading it ───────────────────────────────────
//
// The assertions above are textual. These execute the guard, because "the source checks typeof" and "a
// missing page produces a card instead of a hang" are different claims and only the second is the one that
// was broken.

function runNavigate(pagesObj) {
  const vm = require('node:vm');
  const from = SHELL.indexOf('function navigate(page) {');
  const to = SHELL.indexOf('// ── PAGES ──');
  assert.ok(from !== -1 && to > from, 'navigate() and its end must be findable');

  const els = {};
  const el = (id) => (els[id] || (els[id] = { id, innerHTML: '', textContent: '', classList: { add() {}, remove() {} } }));
  const logged = [];
  const sandbox = {
    pages: pagesObj,
    closeMobileSidebar() {},
    productNavEnabled: () => false,
    updateBreadcrumb() {},
    currentUser: { role: 'admin' },
    currentPage: null,
    location: { reload() {} },
    document: {
      getElementById: (id) => el(id),
      querySelectorAll: () => ({ forEach() {} }),
    },
    console: { error: (...a) => logged.push(a.join(' ')) },
  };
  vm.runInNewContext(SHELL.slice(from, to) + '\nglobalThis.__nav = navigate;', sandbox);
  return { nav: sandbox.__nav, content: () => el('content').innerHTML, logged };
}

test('a MISSING page renders a card naming it, not a stuck "Loading..."', () => {
  const { nav, content, logged } = runNavigate({});
  nav('sitenex-partners');
  const html = content();
  assert.ok(!/Loading\.\.\./.test(html), 'the loading paint must be replaced, not left on screen');
  assert.match(html, /This page did not load/);
  assert.match(html, /sitenex-partners/, 'the card NAMES the page, so it can be reported');
  assert.match(html, /Reload/);
  assert.ok(logged.some(l => /no page function registered for sitenex-partners/.test(l)),
    'and it says so in the console for whoever is looking');
});

test('a page id with HTML in it is ESCAPED into the card', () => {
  // The id reaches innerHTML. It comes from the nav today, but navigate() is also called with a value from
  // the hash and from buttons, so it is not ours to trust.
  const { nav, content } = runNavigate({});
  nav('<img src=x onerror=alert(1)>');
  assert.ok(!/<img/.test(content()), `unescaped id reached the card: ${content().slice(0, 160)}`);
  assert.match(content(), /&lt;img/);
});

test('a page that THROWS synchronously gets a card, and the id is still named', () => {
  const { nav, content, logged } = runNavigate({ boom() { throw new Error('kaboom'); } });
  nav('boom');
  assert.match(content(), /boom failed to render/);
  assert.match(content(), /kaboom/, 'the real message, not a generic one');
  assert.ok(!/Loading\.\.\./.test(content()));
  assert.ok(logged.some(l => /threw/.test(l)));
});

test('a page whose PROMISE rejects gets one too — the invisible half', async () => {
  const { nav, content, logged } = runNavigate({ async slow() { throw new Error('async kaboom'); } });
  nav('slow');
  // The rejection is handled in a .catch, so the card appears on a later tick.
  await new Promise(r => setTimeout(r, 10));
  assert.match(content(), /slow failed to render/);
  assert.match(content(), /async kaboom/);
  assert.ok(logged.some(l => /failed/.test(l)));
});

test('a page that WORKS is left alone — the guard is not a wrapper that swallows', () => {
  let called = 0;
  const { nav, content } = runNavigate({ fine() { called++; return undefined; } });
  nav('fine');
  assert.equal(called, 1, 'the page function must actually run');
  // navigate() painted "Loading..."; a real page overwrites it. The guard must not have replaced it.
  assert.ok(!/did not load|failed to render/.test(content()), 'no error card for a page that worked');
});

test('every one of the four KNOWN-BROKEN nav ids now fails VISIBLY', () => {
  // The practical value of the guard, measured on the four that are actually broken in production today.
  for (const id of NAV_WITHOUT_A_PAGE) {
    const { nav, content } = runNavigate({});
    nav(id);
    assert.match(content(), /This page did not load/, `${id} must fail visibly`);
    assert.ok(content().includes(id), `${id} must be named in its own card`);
  }
});
