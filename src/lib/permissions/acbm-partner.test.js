// acbm_partner — THE OUTSIDE ACCOUNT, pinned from every angle.
//   node --test src/lib/permissions/acbm-partner.test.js
//
// This is the first role in PlaybookOS for somebody who does not work here, so the interesting
// assertions are all negative: what it must NOT reach, stated once per layer, because the layers fail
// independently and a test that only checks one of them would pass while the account is wide open.
//
//   layer 1  the tier grid        roles.js      — does requireTier let the request in at all?
//   layer 2  the resolver         templates.js  — is the feature in this role's template?
//   layer 3  the product boundary user_products — does the account hold the route's product?
//   layer 4  the nav              index.html    — is the link even drawn? (never a security layer)

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');

const { BUILT_IN_ROLES, getRoleTier } = require('../roles');
const { TEMPLATES } = require('./templates');
const { FEATURES } = require('./registry');
const { resolve } = require('./resolve');
const { classifyRoute } = require('../products/route-map');

const PARTNER = { id: 'u-partner', role: 'acbm_partner', is_active: 1, permissions_version: 1 };
// `overrides: []` puts the resolver in INJECTED mode (no DB). Passing a stub `query` instead would put
// it in DB mode, where an empty users row means is_active=false and rule 3 denies EVERYTHING — which
// makes every "must not reach" assertion below pass for the wrong reason. The guard test right after
// this is what catches that, and it is why it exists.
const can = (key, user = PARTNER) => resolve(user, key, { overrides: [], env: process.env })
  .then(r => r.allowed);

test('GUARD: the resolver is actually resolving — a granted feature ALLOWs and an absent one DENIEs', async () => {
  assert.equal(await can('acbm.deals.list'), true, 'if this is false, every negative test below is vacuous');
  assert.equal(await can('admin.users.list'), false);
  const asStaff = { id: 'u-super', role: 'super_admin', is_active: 1, permissions_version: 1 };
  assert.equal(await can('acbm.prospects.list', asStaff), true, 'and staff DO hold the prospects list');
});

// ── layer 1: the tier grid ──────────────────────────────────────────────────────
test('the role exists and holds ONLY self + acbm, read-only', () => {
  const def = BUILT_IN_ROLES.acbm_partner;
  assert.ok(def, 'acbm_partner is a built-in role');
  assert.deepEqual(Object.keys(def.tiers).sort(), ['acbm', 'self']);
  assert.equal(def.tiers.acbm, 'r', "read-only: every acbm route is a GET, so 'rw' would pre-authorise a write route that does not exist yet");
  for (const tier of ['sales', 'procurement', 'revenue', 'technical', 'intelligence', 'goals', 'admin']) {
    assert.equal(getRoleTier('acbm_partner', tier), null, `must not hold the ${tier} tier`);
  }
});

test("the 'acbm' tier is held by exactly three roles", () => {
  const holders = Object.keys(BUILT_IN_ROLES).filter(r => getRoleTier(r, 'acbm'));
  assert.deepEqual(holders.sort(), ['acbm_partner', 'admin', 'super_admin']);
});

test('no OTHER role gained anything from the acbm tier being added', () => {
  // The tier is new, so the only way an existing role could be affected is by holding it. Nobody but
  // admin/super_admin does, and those two already passed adminOnly on these routes.
  for (const role of Object.keys(BUILT_IN_ROLES)) {
    if (['acbm_partner', 'admin', 'super_admin'].includes(role)) continue;
    assert.equal(getRoleTier(role, 'acbm'), null, `${role} must not hold acbm`);
  }
});

// ── layer 2: the resolver ───────────────────────────────────────────────────────
test('the partner holds Deals and Packages — page and route', async () => {
  for (const key of ['acbm.deals.list', 'acbm.packages.list', 'acbm.page_acbm_deals.view', 'acbm.page_acbm_packages.view']) {
    assert.equal(await can(key), true, `expected ALLOW for ${key}`);
  }
});

test('the partner does NOT hold ACBM Prospects — our scored lead list', async () => {
  assert.equal(await can('acbm.prospects.list'), false);
  assert.equal(await can('acbm.page_acbm_prospects.view'), false);
});

test('the partner does not hold anything internal', async () => {
  const mustDeny = [
    'admin.users.list',            // the staff directory
    'admin.users.invite',
    'admin.targets.list',          // our revenue targets
    'admin.page_agent_control.view',
    'team.performance_team.list',  // other people's performance
    'team.employee_activity.get',
    'revenue.prospects.list',      // the other products' prospect lists
    'revenue.orders.list',
    'intelligence.page_market_intelligence.view',
    'growth.page_seo_intelligence.view',
    'personal.milestones.list',    // company milestones
    'personal.page_playbook.view',
  ];
  for (const key of mustDeny) {
    assert.equal(await can(key), false, `expected DENY for ${key}`);
  }
  // admin.roles.list is the ONE 'admin' feature it does hold, and only because the client-side nav
  // cannot compute this role's tiers without it. Asserted positively so the exception is visible here
  // rather than looking like an oversight in the list above.
  assert.equal(await can('admin.roles.list'), true, 'the role catalog — the nav needs it; see the template comment');
});

test('the partner reaches nothing beyond its listed features', async () => {
  const granted = new Set(TEMPLATES.acbm_partner.grants);
  const leaked = [], unreachable = [];
  for (const f of FEATURES) {
    const allowed = await can(f.key);
    if (granted.has(f.key)) { if (!allowed) unreachable.push(f.key); continue; }
    if (allowed) leaked.push(f.key);
  }
  // Both directions, so neither half can pass by accident: everything granted must resolve, and
  // nothing else may.
  assert.deepEqual(unreachable, [], `granted but not reachable: ${unreachable.join(', ')}`);
  // `implies` can legitimately allow an unlisted feature through a granted parent, so this asserts the
  // SET, not the count: anything reachable must be reachable from something in the list on purpose.
  assert.deepEqual(leaked, [],
    `\n${leaked.length} feature(s) resolve ALLOW without being in the template — check their 'implies' parents:\n` +
    leaked.map(k => '  ' + k).join('\n') + '\n');
});

test('the template grants nothing that writes outside the account itself', () => {
  const byKey = new Map(FEATURES.map(f => [f.key, f]));
  for (const key of TEMPLATES.acbm_partner.grants) {
    const f = byKey.get(key);
    assert.ok(f, `${key} is not in the registry`);
    const isWrite = f.surface === 'api_route' && !/^GET /.test(f.ref);
    if (isWrite) {
      assert.match(key, /^(personal|platform)\./,
        `${key} (${f.ref}) writes and is not personal/platform — an outside account should not hold it`);
    }
    assert.deepEqual(f.spend || [], [], `${key} can spend money`);
  }
});

// ── layer 3: the product boundary ───────────────────────────────────────────────
test("every acbm route classifies as the 'acbm' product, so holding ['acbm'] is what admits it", () => {
  for (const path of ['/api/acbm/prospects', '/api/acbm/deals', '/api/acbm/packages']) {
    assert.equal(classifyRoute('GET', path), 'acbm', path);
  }
});

test('every route the partner needs resolves to a product it holds', () => {
  // The third layer has to agree with the other two, and this is where they can silently disagree:
  // GET /api/roles was classified 'internal', so under enforce the boundary would 403 the one route
  // buildNav needs — the resolver would say yes and the nav would still break.
  const held = ['acbm'];              // NOT 'internal'
  const needed = [
    ['GET', '/api/acbm/deals'], ['GET', '/api/acbm/packages'],
    ['GET', '/api/roles'], ['GET', '/api/auth/me'], ['PUT', '/api/auth/password'],
    ['PUT', '/api/users/profile'], ['GET', '/api/agent/tasks/my'], ['GET', '/api/activity/my'],
    ['POST', '/api/activity'], ['GET', '/api/goals/my-week'], ['GET', '/api/performance/my'],
  ];
  const refused = needed.filter(([m, p]) => {
    const prod = classifyRoute(m, p);
    return !(prod === 'shared' || held.includes(prod));
  }).map(([m, p]) => `${m} ${p} → ${classifyRoute(m, p)}`);
  assert.deepEqual(refused, [], `the product boundary would 403 these for the partner:\n  ${refused.join('\n  ')}`);
});

test("'internal' is what the boundary requires for platform routes, and the partner must never hold it", () => {
  // Stated here as well as in the invite tests, because it is the assumption the other two layers lean
  // on: even if a tier or a template were widened by mistake, an account without 'internal' cannot
  // reach the platform surface at all.
  //
  // Every route named here is a REAL mounted route — an earlier version of this test asserted
  // `classifyRoute('GET','/api/settings') || 'internal'`, and /api/settings does not exist, so the
  // fallback made a nonexistent route look protected.
  for (const [m, p] of [['GET', '/api/users'], ['POST', '/api/users/invite'], ['GET', '/api/roles'],
                        ['POST', '/api/roles'], ['GET', '/api/products/grantable']]) {
    const prod = classifyRoute(m, p);
    assert.ok(prod !== null, `${m} ${p} is unclassified — under enforce it 403s for everyone`);
    if (p === '/api/roles' && m === 'GET') continue;           // deliberately shared, see the map
    assert.equal(prod, 'internal', `${m} ${p}`);
  }
});

// ── layer 4: the nav ────────────────────────────────────────────────────────────
// Parsed out of the SPA the same way scripts/verify-classic-nav-parity.js does it, because the nav is
// one inline <script> that expects a DOM. The nav is NOT a security layer — it is checked so nobody is
// shown a link that 403s, which is the failure this file's own template comment is about.
function navFor(role) {
  const src = fs.readFileSync(__dirname + '/../../../public/index.html', 'utf8');
  const grab = (re, what) => { const m = src.match(re); if (!m) throw new Error('could not find ' + what); return m[0]; };
  const code = [
    grab(/const NAV_FAMILIES = \{[\s\S]*?\n\};/, 'NAV_FAMILIES'),
    grab(/const NAV_SECTIONS = \[[\s\S]*?\n\];/, 'NAV_SECTIONS'),
    grab(/const NAV_PAGE_REQS = \{.*?\};/, 'NAV_PAGE_REQS'),
    grab(/function navSectionVisible\([\s\S]*?\n\}/, 'navSectionVisible'),
    grab(/function passesPageReads\([\s\S]*?\n\}/, 'passesPageReads'),
    grab(/function roleCanRead\([\s\S]*?\n\}/, 'roleCanRead'),
  ].join('\n');
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(`${code}
    globalThis.__pages = function(role, tiers) {
      const out = [];
      for (const s of NAV_SECTIONS) {
        if (!navSectionVisible(s.access, role)) continue;
        for (const it of s.items) if (passesPageReads(it.id, role, tiers)) out.push(it.id);
      }
      return out;
    };`, ctx);
  return ctx.__pages(role, BUILT_IN_ROLES[role].tiers);
}

test('the partner is shown Deals and Packages, and NOT ACBM Prospects', () => {
  const pages = navFor('acbm_partner');
  assert.ok(pages.includes('acbm-deals'), 'acbm-deals in the nav');
  assert.ok(pages.includes('acbm-packages'), 'acbm-packages in the nav');
  assert.ok(!pages.includes('acbm-prospects'), 'acbm-prospects must NOT be drawn for the partner');
  assert.ok(!pages.includes('team'), 'no team page');
  assert.ok(!pages.includes('settings'), 'no settings page');
});

test('staff still see all three ACBM pages', () => {
  for (const role of ['admin', 'super_admin']) {
    const pages = navFor(role);
    for (const id of ['acbm-prospects', 'acbm-deals', 'acbm-packages']) {
      assert.ok(pages.includes(id), `${role} must still see ${id}`);
    }
  }
});

test('every page drawn for the partner is a page it actually holds', () => {
  // The exact pairing that produces a 403 link if it drifts: a nav item with no matching nav_page
  // feature in the template.
  const granted = new Set(TEMPLATES.acbm_partner.grants);
  const pageFeature = new Map(FEATURES.filter(f => f.surface === 'nav_page').map(f => [f.ref, f.key]));
  const missing = navFor('acbm_partner').filter(id => {
    const key = pageFeature.get(id);
    return key && !granted.has(key);
  });
  assert.deepEqual(missing, [], `these pages are in the nav but not granted, so the link 403s: ${missing.join(', ')}`);
});
