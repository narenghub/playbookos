// CLIENT NAV MUST DEGRADE CLOSED.
//   node --test src/lib/nav-degradation.test.js
//
// THE BUG THIS EXISTS FOR. /api/roles was classified 'internal'. Under enforce that 403s for a partner.
// buildNav fetched it inside a try/catch that swallowed the error, so tiers were null, so
// passesPageReads() returned true, so EVERY page in a visible section was drawn — including SiteNex
// Prospects, which the partner cannot open. A tighter server gate produced a LOOSER client UI.
//
// The property, stated generally: nav computed from a server fetch must not become more permissive when
// that fetch fails. Only /api/roles had this shape, and the fix was to remove the dependency rather
// than harden the fallback — tiers now arrive on /auth/me, whose failure logs you out. These tests
// check both halves: that the fallback is closed, and that the fetch is gone.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const { BUILT_IN_ROLES } = require('./roles');

const SRC = fs.readFileSync(__dirname + '/../../public/index.html', 'utf8');

// The classic nav branch, lifted and run the way scripts/verify-classic-nav-parity.js does it.
function navRenderer() {
  const grab = (re, what) => { const m = SRC.match(re); if (!m) throw new Error('could not find ' + what); return m[0]; };
  const code = [
    grab(/const NAV_FAMILIES = \{[\s\S]*?\n\};/, 'NAV_FAMILIES'),
    grab(/const NAV_SECTIONS = \[[\s\S]*?\n\];/, 'NAV_SECTIONS'),
    grab(/const NAV_PAGE_REQS = \{.*?\};/, 'NAV_PAGE_REQS'),
    grab(/function navSectionVisible\([\s\S]*?\n\}/, 'navSectionVisible'),
    grab(/function passesPageReads\([\s\S]*?\n\}/, 'passesPageReads'),
    grab(/function roleCanRead\([\s\S]*?\n\}/, 'roleCanRead'),
    grab(/function roleTiersFor\([\s\S]*?\n\}/, 'roleTiersFor'),
  ].join('\n');
  const ctx = { window: {}, console, currentUser: null };
  vm.createContext(ctx);
  vm.runInContext(`${code}
    globalThis.__pages = function(role, tiers) {
      const out = [];
      for (const s of NAV_SECTIONS) {
        if (!navSectionVisible(s.access, role)) continue;
        for (const it of s.items) if (passesPageReads(it.id, role, tiers)) out.push(it.id);
      }
      return out;
    };
    globalThis.__tiersFor = (role) => roleTiersFor(role);
    globalThis.__setUser = (u) => { currentUser = u; };
    globalThis.__setCatalog = (c) => { window._roleCatalog = c; };
    globalThis.__reqs = NAV_PAGE_REQS;`, ctx);
  return ctx;
}

const TIER_GATED = (ctx) => new Set(Object.keys(ctx.__reqs));

// ── the fallback is closed ──────────────────────────────────────────────────────
test('with tiers UNKNOWN, no tier-gated page is drawn for any non-admin role', () => {
  const ctx = navRenderer();
  const gated = TIER_GATED(ctx);
  const offenders = [];
  for (const role of Object.keys(BUILT_IN_ROLES)) {
    if (role === 'admin' || role === 'super_admin') continue;   // both short-circuit; see the test below
    for (const id of ctx.__pages(role, null)) {
      if (gated.has(id)) offenders.push(`${role} → ${id}`);
    }
  }
  assert.deepEqual(offenders, [],
    `\nthese pages are drawn when tiers are unknown, i.e. a FAILED FETCH widened the nav:\n  ` +
    offenders.join('\n  ') + '\n');
});

test('with tiers unknown, a role still keeps the pages that need no tier at all', () => {
  // The fail-closed must not be a blunt "render nothing": My Tasks has no NAV_PAGE_REQS entry, so no
  // read is being guessed at, and hiding it would turn a blip into an apparent outage.
  const ctx = navRenderer();
  const pages = ctx.__pages('sales_team', null);
  assert.ok(pages.includes('my-tasks'), 'My Tasks has no tier requirement and must survive');
  assert.ok(pages.length > 0, 'not blank');
});

test('with tiers UNKNOWN the partner is shown NOTHING tier-gated — including Prospects', () => {
  // The original bug was that a FAILED tier fetch widened the nav. SiteNex Prospects was the example,
  // because the partner could not open it; from 2026-10-01 they can, scoped to territory, so the example
  // had to change shape. The PROPERTY is unchanged and is what this asserts: unknown tiers draw nothing
  // tier-gated, so a degraded nav is narrower than a healthy one and never wider.
  const ctx = navRenderer();
  assert.ok(!ctx.__pages('partner', null).includes('sitenex-prospects'),
    'tiers unknown must not draw a tier-gated page');
  // With tiers KNOWN it IS drawn — which is what makes the line above a statement about degradation rather
  // than about this page.
  assert.ok(ctx.__pages('partner', BUILT_IN_ROLES.partner.tiers).includes('sitenex-prospects'),
    'and with tiers known the partner holds the sitenex tier, so it appears');
});

test('admin and super_admin are unaffected — they short-circuit before tiers are consulted', () => {
  // Deliberate: their role comes from /auth/me, which is trusted and fails closed by logging out. They
  // would be the ones locked out of everything by a blunt fail-closed, and they can open every route
  // anyway, so there is nothing to protect them from.
  const ctx = navRenderer();
  for (const role of ['admin', 'super_admin']) {
    const withTiers = ctx.__pages(role, BUILT_IN_ROLES[role].tiers);
    const without = ctx.__pages(role, null);
    assert.deepEqual(without, withTiers, `${role}'s nav must not change when tiers are unknown`);
    assert.ok(without.includes('sitenex-prospects'));
  }
});

test('EVERY role: unknown tiers can only NARROW the nav, never widen it', () => {
  // The property in one assertion, over the whole role table: the degraded nav is a SUBSET of the
  // correct one. This is what "degrades closed" means, and it is the thing that would catch a new
  // fallback added somewhere else in the chain.
  const ctx = navRenderer();
  for (const role of Object.keys(BUILT_IN_ROLES)) {
    const correct = new Set(ctx.__pages(role, BUILT_IN_ROLES[role].tiers));
    const degraded = ctx.__pages(role, null);
    const extra = degraded.filter(id => !correct.has(id));
    assert.deepEqual(extra, [], `${role}: unknown tiers ADDED ${extra.join(', ')}`);
  }
});

// ── the dependency is gone ──────────────────────────────────────────────────────
test('buildNav fetches NOTHING — the nav has no request that can fail', () => {
  const fn = SRC.slice(SRC.indexOf('async function buildNav()'));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const calls = [...body.matchAll(/API\(\s*['"`]([^'"`]+)/g)].map(m => m[1]);
  assert.deepEqual(calls, [],
    `buildNav fetches ${calls.join(', ')} — whatever it fetches can fail, and the nav must not be ` +
    `computed from something that can fail. Pass it on /auth/me instead.`);
  assert.ok(!/_roleCatalog/.test(body), 'buildNav must not depend on the role catalog either');
});

test('tiers come from currentUser, which comes from the call that gates the whole app', () => {
  const ctx = navRenderer();
  ctx.__setUser({ role: 'partner', tiers: { self: 'rw', sitenex: 'r' } });
  assert.deepEqual(ctx.__tiersFor('partner'), { self: 'rw', sitenex: 'r' });
  // A different role than the current user's falls back to the catalog, and to null when absent —
  // never to {} , which would read as "this role holds no tiers" and quietly hide pages.
  assert.equal(ctx.__tiersFor('sales_team'), null);
  ctx.__setCatalog([{ role_name: 'sales_team', tiers: { self: 'rw', sales: 'rw' } }]);
  assert.deepEqual(ctx.__tiersFor('sales_team'), { self: 'rw', sales: 'rw' });
});

test('/auth/me and /auth/login both return tiers, or the nav has nothing to read', () => {
  const routes = fs.readFileSync(__dirname + '/../api/routes.js', 'utf8');
  // One handler, delimited by the NEXT route declaration rather than a character count. A fixed slice
  // broke the moment the accept-invite handler grew by a few lines, which is a test failing for a reason
  // that has nothing to do with what it is testing.
  const handler = (decl) => {
    const start = routes.indexOf(decl);
    assert.notEqual(start, -1, `could not find ${decl}`);
    const rest = routes.slice(start + decl.length);
    const end = rest.search(/\nrouter\.(get|post|put|patch|delete)\(/);
    return rest.slice(0, end === -1 ? undefined : end);
  };
  assert.match(handler("router.get('/auth/me'"), /roleTiers\(/, '/auth/me must return tiers');
  assert.match(handler("router.post('/auth/login'"), /tiers: roleTiers\(/, '/auth/login must return them on the user object');
  assert.match(handler("router.post('/auth/accept-invite'"), /tiers: roleTiers\(/,
    'accept-invite too — the first paint after accepting is a nav');
});

// ── is anything ELSE in the client gated on a fetch that can fail? ──────────────
test('AUDIT: no other client-side visibility check reads a swallowed fetch', () => {
  // The generalisation the /api/roles bug asks for. Every call to the two visibility functions is
  // listed, so a new caller passing something fetch-derived has to be looked at rather than slipping
  // in. navSectionVisible takes only (access, role) — role comes from currentUser — so the risk is
  // entirely in what is passed as `tiers`.
  const callers = [...SRC.matchAll(/(passesPageReads|navSectionVisible)\(([^)]*)\)/g)]
    .map(m => `${m[1]}(${m[2].replace(/\s+/g, ' ')})`);
  const allowed = new Set([
    'passesPageReads(pageId, role, tiers)',        // the definition
    'navSectionVisible(access, role)',             // the definition
    'navSectionVisible(sec.access, role)',         // pageVisibleToRole
    'passesPageReads(pageId, role, tiers)',
    'navSectionVisible(section.access, role)',     // buildNav + buildProductSidebar
    'passesPageReads(it.id, role, tiers)',
    'navSectionVisible(s.access, role)',           // activeProductFor
  ]);
  const unknown = [...new Set(callers)].filter(c => !allowed.has(c));
  assert.deepEqual(unknown, [],
    `\nnew call site(s) for the nav visibility functions — check where 'tiers' comes from, and that a\n` +
    `failed fetch cannot make it null in a way that WIDENS the result:\n  ` + unknown.join('\n  ') + '\n');
  assert.ok(callers.length >= 5, `only ${callers.length} call sites found — the scanner has stopped working`);
});

test('AUDIT: tiers are never derived from a fetch outside /auth', () => {
  // roleTiersFor is the single source. If a second reader of window._roleCatalog appears that feeds a
  // visibility decision, it reintroduces the bug somewhere new — so the readers are enumerated, not
  // counted loosely. Comment lines are dropped: they are prose about the catalog, not a use of it.
  const lines = SRC.split('\n')
    .map((l, i) => ({ n: i + 1, t: l.trim() }))
    .filter(x => /_roleCatalog/.test(x.t) && !x.t.startsWith('//'));
  const KNOWN = [
    /^const cat = \(typeof window !== 'undefined' && window\._roleCatalog\)/,  // roleTiersFor fallback
    /^window\._roleCatalog = rolesResp\.roles \|\| \[\];$/,                    // pages.team() populates it
    /^if \(sel && window\._roleCatalog && window\._roleCatalog\.length\)/,     // invite-form dropdown
    /^sel\.innerHTML = window\._roleCatalog$/,                                //   "
  ];
  const unknown = lines.filter(x => !KNOWN.some(re => re.test(x.t)));
  assert.deepEqual(unknown.map(x => `${x.n}: ${x.t.slice(0, 110)}`), [],
    '\nnew use(s) of the role catalog. If any of these feeds a visibility decision, it can be null from a\n' +
    'failed fetch and must not widen anything:\n');
  assert.ok(lines.length >= 4, `only ${lines.length} reference(s) found — the scanner has stopped working`);
});
