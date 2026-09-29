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
  assert.deepEqual(c.tabs('admin', ['abiozen', 'golfnex', 'internal']), ['abiozen', 'golfnex', 'me']);
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
  assert.deepEqual(tabs, ['abiozen', 'me']);
});

test('Me is unconditional — everybody has their own tasks', () => {
  const c = shell();
  for (const role of Object.keys(BUILT_IN_ROLES)) {
    assert.ok(c.tabs(role, []).includes('me'), `${role} must always see Me`);
  }
  assert.deepEqual(c.tabs('support_team', []), ['me'], 'holding nothing still leaves Me');
});

// ── Platform ────────────────────────────────────────────────────────────────────
test('Platform is SUPER ADMIN ONLY', () => {
  const c = shell();
  assert.ok(c.tabs('super_admin', ALL).includes('platform'));
  for (const role of Object.keys(BUILT_IN_ROLES)) {
    if (role === 'super_admin') continue;
    assert.ok(!c.tabs(role, ALL).includes('platform'),
      `${role} must not see Platform — five roles used to, through the admin short-circuit`);
  }
});

test("holding 'internal' does not buy Platform", () => {
  // The distinction the old model could not make: 'internal' is the staff flag for DATA, Platform is the
  // administration surface. Every staff account holds 'internal'.
  const c = shell();
  assert.ok(!c.tabs('admin', ALL).includes('platform'));
  assert.ok(!c.tabs('dev_team', ['internal']).includes('platform'));
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
  assert.deepEqual(c.tabs('admin', null), ['me']);
  assert.deepEqual(c.tabs('admin', undefined), ['me']);
});

test('an empty product list is respected, not treated as unknown', () => {
  const c = shell();
  assert.deepEqual(c.tabs('admin', []), ['me'], 'holding nothing is a real state');
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
