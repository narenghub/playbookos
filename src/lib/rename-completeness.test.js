// acbm → sitenex: NOTHING LEFT BEHIND.
//   node --test src/lib/rename-completeness.test.js
//
// A rename that is 95% done is worse than one not started: the leftovers look like deliberate exceptions.
// This fails on any surviving 'acbm' outside a short list of places where it is CORRECT for it to
// survive — history, and prose about the partner company.
//
// SiteNex is the service line. ACBM Partners is one referral partner inside it, so the string "ACBM"
// has a legitimate future in this codebase — as a partner NAME, in the partners table and in sentences
// about it. What must not survive is acbm as a product key, table, route, page id, role or registry key.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// Files where 'acbm' is correct and must be left alone.
const EXEMPT_FILES = new Set([
  // The migration that CREATED the acbm_* tables. Renaming a historical migration would make it a lie
  // about what it did.
  'scripts/migrate-acbm.js',
  // The migration that renames them. It has to name both sides.
  'scripts/migrate-sitenex-rename.js',
  // This test.
  'src/lib/rename-completeness.test.js',
]);
const EXEMPT_PREFIX = [
  'docs/acbm-call-sheet',      // generated artifacts, dated
];

// Lines where 'acbm' survives as the PARTNER, not the product.
const ALLOWED_LINE = [
  /ACBM Partners/,                    // the partner's name
  /acbm@acbmpartners\.com/,           // their shared mailbox
  /not about ACBM/,                   // the comment in partner-deal-scope.test.js saying exactly that
  /'acbm'/,                           // a literal being renamed FROM, in a migration or a comment about one
  // referred_by, but ONLY IN PROSE. The unrestricted form of this entry hid a live bug for a day: the
  // deals board read `d.referred_by`, a column the rename DROPPED, so the "via <partner>" credit never
  // rendered — silently, because `undefined ? x : ''` is a perfectly good expression. Restricting it to
  // comment lines means the next read of a dropped column is an offender again.
  /^\s*(\/\/|\/\*|\*)[^\n]*referred_by/,
  /\/api\/acbm\//,                    // a check that the OLD routes are gone has to name them
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|html|md)$/.test(e.name)) out.push(full);
  }
  return out;
}

test('no acbm survives as a product key, table, route, page, role or registry key', () => {
  const offenders = [];
  let scanned = 0;
  for (const full of walk(ROOT)) {
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (EXEMPT_FILES.has(rel) || EXEMPT_PREFIX.some(p => rel.startsWith(p))) continue;
    scanned++;
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (!/acbm/i.test(l)) return;
      if (ALLOWED_LINE.some(re => re.test(l))) return;
      offenders.push(`${rel}:${i + 1}  ${l.trim().slice(0, 110)}`);
    });
  }
  assert.ok(scanned > 50, `only ${scanned} files scanned — the walker has stopped working`);
  assert.deepEqual(offenders, [],
    `\n${offenders.length} surviving reference(s) to acbm. Either rename it, or — if it genuinely means the\n` +
    `PARTNER rather than the product — add the pattern to ALLOWED_LINE in this test with the reason:\n\n  ` +
    offenders.join('\n  ') + '\n');
});

test('the product key, role and route prefix are all sitenex', () => {
  const { PRODUCTS, GRANTABLE, classifyRoute } = require('./products/route-map');
  assert.ok(PRODUCTS.includes('sitenex'), 'sitenex is a product');
  assert.ok(!PRODUCTS.includes('acbm'), 'acbm is not');
  assert.ok(GRANTABLE.includes('sitenex'));
  for (const p of ['/api/sitenex/prospects', '/api/sitenex/deals', '/api/sitenex/packages']) {
    assert.equal(classifyRoute('GET', p), 'sitenex', p);
  }
  // The old routes must be gone, not merely unclassified: an unmapped /api GET now fails closed, so a
  // leftover would 403 rather than serve — but it would still be a live route.
  const routes = fs.readFileSync(path.join(__dirname, '..', 'api', 'routes.js'), 'utf8');
  assert.ok(!/router\.(get|post|put|delete)\('\/acbm\//.test(routes), 'no /acbm/* route may remain mounted');

  const { BUILT_IN_ROLES, EXTERNAL_ROLES } = require('./roles');
  assert.ok(BUILT_IN_ROLES.partner, "the role is 'partner', generic and reusable");
  assert.ok(!BUILT_IN_ROLES.acbm_partner, 'acbm_partner is gone');
  assert.ok(!BUILT_IN_ROLES.sitenex_partner, 'and it did not become sitenex_partner either');
  assert.deepEqual(EXTERNAL_ROLES, ['partner']);
});

test('the registry and templates use sitenex.* keys', () => {
  const { FEATURES } = require('./permissions/registry');
  const { TEMPLATES } = require('./permissions/templates');
  const sitenex = FEATURES.filter(f => f.key.startsWith('sitenex.'));
  // This test is about the RENAME, not about the feature count, so it asserts the SHAPE rather than a
  // number that every new route has to come back and bump. Phase 3 took it from 6 to 16 and the only
  // thing that told me was "expected 6, actual 16", which says nothing about acbm.
  assert.ok(sitenex.length >= 6, `expected the sitenex features to exist, found ${sitenex.length}`);
  assert.equal(sitenex.filter(f => f.surface === 'nav_page').length,
               sitenex.filter(f => f.surface === 'nav_page' && /^sitenex-/.test(f.ref)).length,
               'every sitenex page feature points at a sitenex-* page key');
  assert.equal(sitenex.filter(f => f.surface === 'api_route' && !/^\w+ \/api\/sitenex\//.test(f.ref)).length, 0,
               'every sitenex route feature points at /api/sitenex/*');
  assert.equal(FEATURES.filter(f => /acbm/i.test(f.key)).length, 0);
  assert.ok(TEMPLATES.partner, 'the partner template exists under its new name');
  assert.ok(!TEMPLATES.acbm_partner);
  for (const key of TEMPLATES.partner.grants) assert.ok(!/acbm/i.test(key), `${key} still says acbm`);
});

test('the SPA page ids are sitenex-*', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  for (const id of ['sitenex-prospects', 'sitenex-deals', 'sitenex-packages']) {
    assert.ok(src.includes(`pages['${id}']`), `${id} page function`);
    assert.ok(src.includes(`id:'${id}'`), `${id} nav item`);
  }
  assert.ok(!/acbm-(prospects|deals|packages)/.test(src), 'no acbm-* page id survives');
});
