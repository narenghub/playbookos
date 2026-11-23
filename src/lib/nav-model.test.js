// THE FINAL NAV MODEL.
//   node --test src/lib/nav-model.test.js
//
//   every user   the products they HOLD, plus Me
//   super admin  every product, plus Platform, plus Me
//   Platform     super admin only
//
// WHAT THIS REPLACED, and why it is worth a test file. The sidebar used to be derived from the ROLE:
// visibleProducts(role, tiers) showed any product with at least one role-visible page. That is how a
// recruitment_team account was shown Abiozen it does not hold, and how FIVE roles were shown Platform.
// Deriving products from the role is wrong fix #3 in docs/PRODUCT_DELEGATION_DESIGN.md — products are
// assigned per person, so the nav has to read what the person holds.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const { BUILT_IN_ROLES } = require('./roles');
const { GRANTABLE, PRODUCTS: SERVER_PRODUCTS } = require('./products/route-map');

const SRC = fs.readFileSync(__dirname + '/../../public/index.html', 'utf8');

function shell() {
  const g = (re, w) => { const m = SRC.match(re); if (!m) throw new Error('missing ' + w); return m[0]; };
  const code = [
    g(/const NAV_SECTIONS = \[[\s\S]*?\n\];/, 'NAV_SECTIONS'),
    g(/const NAV_FAMILIES = \{[\s\S]*?\n\};/, 'NAV_FAMILIES'),
    g(/const NAV_PAGE_REQS = \{.*?\};/, 'NAV_PAGE_REQS'),
    g(/function navSectionVisible\([\s\S]*?\n\}/, 'navSectionVisible'),
    g(/function passesPageReads\([\s\S]*?\n\}/, 'passesPageReads'),
    g(/function roleCanRead\([\s\S]*?\n\}/, 'roleCanRead'),
    g(/const PRODUCTS = \[[\s\S]*?\n\];/, 'PRODUCTS'),
    g(/const PAGE_SECTION = \([\s\S]*?\}\)\(\);/, 'PAGE_SECTION'),
    g(/function pageVisibleToRole\([\s\S]*?\n\}/, 'pageVisibleToRole'),
    g(/function productVisiblePages\([\s\S]*?\n\}/, 'productVisiblePages'),
    g(/function heldProductKeys\([\s\S]*?\n\}/, 'heldProductKeys'),
    g(/function visibleProducts\([\s\S]*?\n\}/, 'visibleProducts'),
    g(/function productNavEnabled\([\s\S]*?\n\}/, 'productNavEnabled'),
  ].join('\n');
  // URLSearchParams must be in the context: productNavEnabled reads location.search through it inside a
  // try/catch, so without it the flag check throws, is swallowed, and silently returns the default —
  // which would make the escape-hatch test pass for the wrong reason.
  const ctx = { window: {}, console, currentUser: null, location: { search: '' }, URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(code + `
    globalThis.tabs = (role, products) => {
      currentUser = { role, products, tiers: null };
      return visibleProducts(role, (globalThis.__tiers || {})[role] || {}).map(p => p.key);
    };
    globalThis.pagesOf = (key, role) => {
      const p = PRODUCTS.find(x => x.key === key);
      return productVisiblePages(p, role, (globalThis.__tiers || {})[role] || {});
    };
    globalThis.navOn = () => productNavEnabled();
    globalThis.SECTIONS = NAV_SECTIONS;
  `, ctx);
  ctx.__tiers = Object.fromEntries(Object.entries(BUILT_IN_ROLES).map(([k, v]) => [k, v.tiers]));
  return ctx;
}

const ALL = GRANTABLE;

// ── the model ───────────────────────────────────────────────────────────────────
test('a user sees the products they HOLD, plus Me — and nothing else', () => {
  const c = shell();
  // 'platform' rides along for an admin from 2026-11-23 — see "Platform is ADMIN AND SUPER ADMIN" below.
  assert.deepEqual(c.tabs('admin', ['abiozen', 'golfnex', 'internal']), ['abiozen', 'golfnex', 'platform', 'me']);
  assert.deepEqual(c.tabs('business_dev', ['abiozen', 'internal']), ['abiozen', 'me']);
  assert.deepEqual(c.tabs('partner', ['sitenex']), ['sitenex', 'me']);
});

test('holding a product is NOT enough if the role reaches none of its pages', () => {
  // An empty product tab is worse than no tab: it is a promise the app does not keep. The role still
  // filters the PAGES inside a product — this is the layer that stops a link that 403s.
  const c = shell();
  assert.ok(!c.tabs('recruitment_team', ['internal', 'linkabl']).includes('linkabl'),
    'recruitment_team reaches no linkabl page, so no linkabl tab');
  assert.deepEqual(c.tabs('recruitment_team', ['internal', 'linkabl']), ['me']);
});

test('a product NOT held is never shown, however permissive the role', () => {
  const c = shell();
  // admin's role would admit every page of every product. Only the grants decide.
  const tabs = c.tabs('admin', ['abiozen']);
  for (const p of ['golfnex', 'favly', 'linkabl', 'aros', 'sitenex']) {
    assert.ok(!tabs.includes(p), `admin does not hold ${p} and must not see it`);
  }
  // 'platform' is not a held PRODUCT and never was — it is role-gated, and admin now passes that gate.
  // The property under test is about grants, so it is asserted against the product tabs only.
  assert.deepEqual(tabs.filter(t => t !== 'platform' && t !== 'me'), ['abiozen']);
  assert.deepEqual(tabs, ['abiozen', 'platform', 'me']);
});

test('Me is unconditional — everybody has their own tasks', () => {
  const c = shell();
  for (const role of Object.keys(BUILT_IN_ROLES)) {
    assert.ok(c.tabs(role, []).includes('me'), `${role} must always see Me`);
  }
  assert.deepEqual(c.tabs('support_team', []), ['me'], 'holding nothing still leaves Me');
});

// ── Platform ────────────────────────────────────────────────────────────────────
//
// Until 2026-11-23 this tab was super-admin-only, and the test below asserted it role by role. That
// rule had a hole nobody had looked through: Agent Control is the only surface carrying MANUAL TASK
// ASSIGNMENT, its endpoint `POST /agent/tasks/assign` is `adminOnly`, and the tab is the only route to
// the page under the product nav. So an `admin` account was admitted by the API and refused by the
// sidebar, and the only assignment that could happen was the Google Meet agent's automatic one.
//
// Admin is now admitted to the TAB. The assertions that matter are the two below it: an admin's
// Platform holds exactly the two pages the classic sidebar already gave them, and every role beneath
// admin is still refused — the "five roles were shown Platform" regression, which is what the old test
// was really protecting and is still protected.
test('Platform is ADMIN AND SUPER ADMIN — and nobody else', () => {
  const c = shell();
  assert.ok(c.tabs('super_admin', ALL).includes('platform'));
  assert.ok(c.tabs('admin', ALL).includes('platform'),
    'an admin must reach Platform: Agent Control is the only manual-assignment surface');
  for (const role of Object.keys(BUILT_IN_ROLES)) {
    if (role === 'super_admin' || role === 'admin') continue;
    assert.ok(!c.tabs(role, ALL).includes('platform'),
      `${role} must not see Platform — five roles used to, through the admin short-circuit`);
  }
});

test('DECISIVE: an admin reaches Team Management and Agent Control, and NOTHING else in Platform', () => {
  // The whole safety of the change. Admitting a role to the tab must not admit it to the tab's
  // CONTENTS: the five administration pages sit in a NAV_SECTION whose access is ['superadmin'], a
  // value navSectionVisible checks before the admin short-circuit. If somebody ever "simplifies" that
  // section's access to ['admin'], or moves one of those pages into an admin-visible section, this
  // fails — which is the only reason the list is written out literally rather than derived.
  const c = shell();
  assert.deepEqual(c.pagesOf('platform', 'admin').sort(), ['agent-control', 'team']);
  for (const id of ['settings', 'sku-economics', 'decision-engine', 'data-pipeline', 'execution-graph']) {
    assert.ok(!c.pagesOf('platform', 'admin').includes(id),
      `${id} is a super-admin page and must stay out of an admin's Platform`);
  }
  // and the super admin still gets all seven
  assert.equal(c.pagesOf('platform', 'super_admin').length, 7);
});

test('the two pages an admin gains were ALREADY theirs in the classic sidebar', () => {
  // So this closes a gap between the two navs rather than granting anything new. If it were a genuine
  // grant, it would belong in the permissions template, not in the sidebar.
  const c = shell();
  const team = c.SECTIONS.find(s => s.title === 'TEAM');
  assert.ok(team, 'a TEAM section exists');
  assert.deepEqual(team.items.map(i => i.id).sort(), ['agent-control', 'team']);
  assert.ok(team.access.includes('admin'),
    'the classic TEAM section already admitted admin — the product nav was the one disagreeing');
});

test("holding 'internal' does not buy Platform", () => {
  // The distinction the old model could not make: 'internal' is the staff flag for DATA, Platform is the
  // administration surface. Every staff account holds 'internal'. Unchanged by the admin admission:
  // what buys Platform is the ROLE, and dev_team is not one of the two roles that do.
  const c = shell();
  assert.ok(!c.tabs('dev_team', ['internal']).includes('platform'));
  assert.ok(!c.tabs('sales_director', ALL).includes('platform'),
    'a director holds plenty and administers nothing');
});

test('the three previously-unreachable pages are now IN Platform', () => {
  // They were listed under the platform product tab but belonged to no NAV_SECTION, so
  // pageVisibleToRole returned false and they could not be reached at all.
  const c = shell();
  const platform = c.SECTIONS.find(s => s.title === 'PLATFORM');
  assert.ok(platform, 'a PLATFORM section exists');
  const ids = platform.items.map(i => i.id);
  for (const id of ['decision-engine', 'data-pipeline', 'execution-graph']) {
    assert.ok(ids.includes(id), `${id} must have a nav entry`);
  }
  assert.deepEqual(platform.access, ['superadmin'], 'and the section is super-admin only');
  assert.deepEqual(c.pagesOf('platform', 'super_admin').sort(),
    ['agent-control', 'data-pipeline', 'decision-engine', 'execution-graph', 'settings', 'sku-economics', 'team'].sort());
});

// ── the super admin ─────────────────────────────────────────────────────────────
test('a super admin sees every product, without holding a row for each', () => {
  const c = shell();
  // The server sends effectiveProducts, which is GRANTABLE for super_admin — so this is what the client
  // will actually be given once the 7 user_products rows are removed.
  const tabs = c.tabs('super_admin', ALL);
  for (const p of SERVER_PRODUCTS) assert.ok(tabs.includes(p), `super_admin must see ${p}`);
  assert.ok(tabs.includes('platform') && tabs.includes('me'));
});

test('the client list and the server list agree on what the products ARE', () => {
  // A product in the map with no tab is unreachable; a tab for a product the boundary does not know about
  // is a link that 403s. Either way the two lists must not drift.
  const c = shell();
  const clientProducts = c.tabs('super_admin', ALL).filter(k => k !== 'platform' && k !== 'me');
  assert.deepEqual(clientProducts.slice().sort(), SERVER_PRODUCTS.slice().sort());
});

// ── failure modes ───────────────────────────────────────────────────────────────
test('products UNKNOWN shows no product tabs, never all of them', () => {
  // currentUser.products missing means /auth/me has not answered yet or answered oddly. The same
  // fail-closed rule as tiers: a nav computed from missing data must narrow.
  const c = shell();
  assert.deepEqual(c.tabs('super_admin', null), ['platform', 'me'],
    'even a super admin gets no PRODUCT tabs from missing data — Platform is role-based, so it stays');
  // Same for an admin, and for the same reason: Platform is role-based, so missing PRODUCT data cannot
  // take it away. A role with no administration claim still gets nothing but Me.
  assert.deepEqual(c.tabs('admin', null), ['platform', 'me']);
  assert.deepEqual(c.tabs('admin', undefined), ['platform', 'me']);
  assert.deepEqual(c.tabs('sales_director', null), ['me'],
    'missing products must not become a free product tab for a non-administrator');
});

test('an empty product list is respected, not treated as unknown', () => {
  const c = shell();
  assert.deepEqual(c.tabs('admin', []), ['platform', 'me'], 'holding nothing is a real state');
  assert.deepEqual(c.tabs('sales_team', []), ['me']);
});

test('the product shell is ON by default, with ?productNav=0 as the escape hatch', () => {
  const c = shell();
  assert.equal(c.navOn(), true, 'the product shell is the nav now');
  c.location.search = '?productNav=0';
  assert.equal(c.navOn(), false, 'and can be turned off per-request with no deploy');
  c.location.search = '';
  c.window.PRODUCT_NAV_ENABLED = false;
  assert.equal(c.navOn(), false, 'or globally');
});

test('products arrive on /auth/me, /auth/login and accept-invite', () => {
  const routes = fs.readFileSync(__dirname + '/../api/routes.js', 'utf8');
  const handler = (decl) => {
    const i = routes.indexOf(decl);
    assert.notEqual(i, -1, `could not find ${decl}`);
    const rest = routes.slice(i + decl.length);
    const end = rest.search(/\nrouter\.(get|post|put|patch|delete)\(/);
    return rest.slice(0, end === -1 ? undefined : end);
  };
  for (const decl of ["router.get('/auth/me'", "router.post('/auth/login'", "router.post('/auth/accept-invite'"]) {
    assert.match(handler(decl), /effectiveProducts\(/, `${decl} must return products`);
  }
  // And nothing fetches them separately — that was the /api/roles mistake.
  assert.ok(!/API\('\/products\/mine/.test(SRC), 'no separate products fetch');
});
