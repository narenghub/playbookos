// partner — THE OUTSIDE ACCOUNT, pinned from every angle.
//   node --test src/lib/permissions/partner-role.test.js
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

const PARTNER = { id: 'u-partner', role: 'partner', is_active: 1, permissions_version: 1 };
// `overrides: []` puts the resolver in INJECTED mode (no DB). Passing a stub `query` instead would put
// it in DB mode, where an empty users row means is_active=false and rule 3 denies EVERYTHING — which
// makes every "must not reach" assertion below pass for the wrong reason. The guard test right after
// this is what catches that, and it is why it exists.
const can = (key, user = PARTNER) => resolve(user, key, { overrides: [], env: process.env })
  .then(r => r.allowed);

test('GUARD: the resolver is actually resolving — a granted feature ALLOWs and an absent one DENIEs', async () => {
  assert.equal(await can('sitenex.deals.list'), true, 'if this is false, every negative test below is vacuous');
  assert.equal(await can('admin.users.list'), false);
  const asStaff = { id: 'u-super', role: 'super_admin', is_active: 1, permissions_version: 1 };
  assert.equal(await can('sitenex.prospects.list', asStaff), true, 'and staff DO hold the prospects list');
});

// ── layer 1: the tier grid ──────────────────────────────────────────────────────
test('the role exists and holds ONLY self + sitenex, read-only', () => {
  const def = BUILT_IN_ROLES.partner;
  assert.ok(def, 'partner is a built-in role');
  assert.deepEqual(Object.keys(def.tiers).sort(), ['self', 'sitenex'].sort());
  assert.equal(def.tiers.sitenex, 'r', "read-only: every sitenex route is a GET, so 'rw' would pre-authorise a write route that does not exist yet");
  for (const tier of ['sales', 'procurement', 'revenue', 'technical', 'intelligence', 'goals', 'admin']) {
    assert.equal(getRoleTier('partner', tier), null, `must not hold the ${tier} tier`);
  }
});

test("the 'sitenex' tier is held by exactly three roles", () => {
  const holders = Object.keys(BUILT_IN_ROLES).filter(r => getRoleTier(r, 'sitenex'));
  assert.deepEqual(holders.sort(), ['partner', 'admin', 'super_admin'].sort());
});

test('no OTHER role gained anything from the sitenex tier being added', () => {
  // The tier is new, so the only way an existing role could be affected is by holding it. Nobody but
  // admin/super_admin does, and those two already passed adminOnly on these routes.
  for (const role of Object.keys(BUILT_IN_ROLES)) {
    if (['partner', 'admin', 'super_admin'].includes(role)) continue;
    assert.equal(getRoleTier(role, 'sitenex'), null, `${role} must not hold sitenex`);
  }
});

// ── layer 2: the resolver ───────────────────────────────────────────────────────
test('the partner holds Deals and Packages — page and route', async () => {
  for (const key of ['sitenex.deals.list', 'sitenex.packages.list', 'sitenex.page_sitenex_deals.view', 'sitenex.page_sitenex_packages.view']) {
    assert.equal(await can(key), true, `expected ALLOW for ${key}`);
  }
});

test('the partner DOES hold SiteNex Prospects now — scoped to its territory', async () => {
  // Was `false` on both, as the second of three refusals keeping a partner out of our scored lead list.
  // Reversed 2026-10-01: a partner sees the patch we granted them, enforced by territoryScopeSql in the
  // query rather than by withholding the feature. The feature is the door; the territory is the room.
  assert.equal(await can('sitenex.prospects.list'), true);
  assert.equal(await can('sitenex.page_sitenex_prospects.view'), true);
});

test('but holding the feature is NOT holding the rows — the scope fails closed', () => {
  // The refusal that replaced the old one, asserted here so the two halves are read together: a partner can
  // reach the list and still see nothing, because an empty territory grant means nobody decided.
  const src = require('fs').readFileSync(__dirname + '/../products/territory-scope.js', 'utf8');
  // No territory rows → OUR leads are excluded entirely; what remains is their own book, which is theirs by a
  // different right. The thing that must never appear is a bare TRUE.
  assert.match(src, /sql: `\$\{col\('source_partner_id'\)\} = \$\$\{startIndex\}`/,
    'no territory rows must narrow to their own book, never widen to everything');
  assert.ok(!/no territories granted'\), partnerId \}[\s\S]{0,80}sql: 'TRUE'/.test(src));
  // And a lookup that throws is FALSE: "I could not tell" is not "show everything".
  assert.match(src, /catch \(e\) \{ return none\('territory lookup failed'\); \}/);
}),

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
  // admin.roles.list was granted here for one release, because buildNav fetched /api/roles to learn the
  // caller's tiers. The tiers now arrive on /auth/me, so the partner does not see our role catalog.
  assert.equal(await can('admin.roles.list'), false, 'the nav no longer needs it — see roleTiersFor');
});

test('the partner reaches nothing beyond its listed features', async () => {
  const granted = new Set(TEMPLATES.partner.grants);
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

// The ONE non-personal write a partner holds, named so it is a decision rather than an omission.
//
// The out-of-territory design requires it: a partner CAN claim a business outside their patch, and a human
// then decides. A partner who could not register could not use the system for what it is for.
//
// It is safe to grant because the HANDLER decides the outcome, not the caller — partner_id comes from the
// caller's own row, the territory verdict is computed server-side from partner_territories, and an
// out-of-territory claim lands pending_approval where only sitenex.lead_registrations.decide (staff, and
// adminOnly on the route) can move it. A partner can create a REQUEST; they cannot create an approval.
const PARTNER_WRITE_EXCEPTIONS = ['sitenex.lead_registrations.create'];

test('the template grants nothing that writes outside the account itself, bar one named exception', () => {
  const byKey = new Map(FEATURES.map(f => [f.key, f]));
  const writes = [];
  for (const key of TEMPLATES.partner.grants) {
    const f = byKey.get(key);
    assert.ok(f, `${key} is not in the registry`);
    if (f.surface === 'api_route' && !/^GET /.test(f.ref) && !/^(personal|platform)\./.test(key)) {
      writes.push(key);
    }
    assert.deepEqual(f.spend || [], [], `${key} can spend money`);
  }
  // An ALLOWLIST, so a second write cannot arrive by being added one line below the first.
  assert.deepEqual(writes.sort(), PARTNER_WRITE_EXCEPTIONS.slice().sort(),
    'a write was granted to an outside account without being declared in PARTNER_WRITE_EXCEPTIONS');
  assert.equal(PARTNER_WRITE_EXCEPTIONS.length, 1,
    'if this grows, "partners read, staff write" has stopped being the rule and that needs saying out loud '
    + 'rather than passing as another line here');
});

test('the one write exception cannot produce an approval', () => {
  // Why it is safe. The decision feature is separate and is NOT granted to the partner.
  assert.ok(!TEMPLATES.partner.grants.includes('sitenex.lead_registrations.decide'),
    'a partner must not be able to approve its own out-of-territory claim');
  assert.ok(!TEMPLATES.partner.grants.includes('sitenex.territories.grant'),
    'nor grant itself a territory');
  assert.ok(!TEMPLATES.partner.grants.includes('sitenex.territories.revoke'));
});

// ── layer 3: the product boundary ───────────────────────────────────────────────
test("every sitenex route classifies as the 'sitenex' product, so holding ['sitenex'] is what admits it", () => {
  for (const path of ['/api/sitenex/prospects', '/api/sitenex/deals', '/api/sitenex/packages']) {
    assert.equal(classifyRoute('GET', path), 'sitenex', path);
  }
});

test('every route the partner needs resolves to a product it holds', () => {
  // The third layer has to agree with the other two, and this is where they can silently disagree. It
  // did once: GET /api/roles is 'internal', and the nav used to need it, so the boundary would have
  // 403'd the one route buildNav depended on — the resolver saying yes and the nav breaking anyway.
  // /api/roles is deliberately NOT in this list any more; the nav gets tiers from /auth/me instead.
  const held = ['sitenex'];              // NOT 'internal'
  const needed = [
    ['GET', '/api/sitenex/deals'], ['GET', '/api/sitenex/packages'],
    ['GET', '/api/auth/me'], ['PUT', '/api/auth/password'],
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

test('the partner is shown Deals, Packages and now SiteNex Prospects', () => {
  const pages = navFor('partner');
  assert.ok(pages.includes('sitenex-deals'), 'sitenex-deals in the nav');
  assert.ok(pages.includes('sitenex-packages'), 'sitenex-packages in the nav');
  // Drawn from 2026-10-01. The screen shows their territory, and shows a sentence explaining itself when
  // they have none — which is better than a hidden page nobody can ask about.
  assert.ok(pages.includes('sitenex-prospects'), 'sitenex-prospects is now a partner screen, scoped to territory');
  assert.ok(!pages.includes('team'), 'no team page');
  assert.ok(!pages.includes('settings'), 'no settings page');
});

// Derived from the registry rather than listed, so a new SiteNex page is covered the moment it exists.
// The hardcoded three-id version silently stopped covering anything new — Phase 3 added a fourth page and
// every assertion here stayed green.
const SITENEX_PAGE_IDS = FEATURES
  .filter(f => f.surface === 'nav_page' && f.domain === 'sitenex')
  .map(f => f.ref);

test('the SiteNex page list is derived from the registry, not hand-listed', () => {
  assert.ok(SITENEX_PAGE_IDS.length >= 4, `expected 4+ sitenex pages, found ${SITENEX_PAGE_IDS.join(', ')}`);
  assert.ok(SITENEX_PAGE_IDS.includes('sitenex-contracts'), 'the Contracts page must be registered');
});

test('staff see EVERY SiteNex page', () => {
  for (const role of ['admin', 'super_admin']) {
    const pages = navFor(role);
    for (const id of SITENEX_PAGE_IDS) {
      assert.ok(pages.includes(id), `${role} must still see ${id}`);
    }
  }
});

test('a partner sees the SiteNex pages it holds and NOT the prospect list', () => {
  const pages = navFor('partner');
  for (const id of ['sitenex-deals', 'sitenex-packages', 'sitenex-contracts']) {
    assert.ok(pages.includes(id), `a partner should see ${id}`);
  }
  // Prospects joined this list on 2026-10-01, scoped to territory. The nav was never the thing protecting
  // it — a link to a page that 403s is a bug, and so is a page withheld from somebody entitled to it.
  assert.ok(pages.includes('sitenex-prospects'), 'scoped to territory, so it is now theirs to open');
});

test('every page drawn for the partner is a page it actually holds', () => {
  // The exact pairing that produces a 403 link if it drifts: a nav item with no matching nav_page
  // feature in the template.
  const granted = new Set(TEMPLATES.partner.grants);
  const pageFeature = new Map(FEATURES.filter(f => f.surface === 'nav_page').map(f => [f.ref, f.key]));
  const missing = navFor('partner').filter(id => {
    const key = pageFeature.get(id);
    return key && !granted.has(key);
  });
  assert.deepEqual(missing, [], `these pages are in the nav but not granted, so the link 403s: ${missing.join(', ')}`);
});
