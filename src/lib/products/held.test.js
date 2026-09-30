// Product data-scoping tests — run with:  node --test src/lib/products/held.test.js
//
// The property: a handler that narrows by product must FAIL SAFE. Holding nothing matches nothing;
// a NULL product (platform-wide) needs 'internal'; and the fragment must compose with a query that
// already has parameters, because the id comes first in the read/write routes.

const { test } = require('node:test');
const assert = require('node:assert');
const { heldProducts, productScopeSql } = require('./held');

test('heldProducts returns the rows, and [] rather than throwing when the DB fails', async () => {
  const ok = await heldProducts('u1', { query: async () => ({ rows: [{ product: 'sitenex' }, { product: 'internal' }] }) });
  assert.deepEqual(ok, ['sitenex', 'internal']);
  const broken = await heldProducts('u1', { query: async () => { throw new Error('db down'); } });
  assert.deepEqual(broken, [], 'an error must narrow to nothing, never widen');
  assert.deepEqual(await heldProducts(null), [], 'no user id → nothing');
});

test('holding nothing matches NOTHING — the direction that fails safe', () => {
  const s = productScopeSql([], '', 1);
  assert.equal(s.sql, '(product = ANY($1))');
  assert.deepEqual(s.params, [[]]);
  assert.equal(s.hasInternal, false);
  // `= ANY('{}')` is false for every row, including rows with a NULL product.
});

test("a NULL product is platform-wide and needs 'internal'", () => {
  const withInternal = productScopeSql(['sitenex', 'internal'], '', 1);
  assert.match(withInternal.sql, /product IS NULL/);
  const without = productScopeSql(['sitenex'], '', 1);
  assert.doesNotMatch(without.sql, /product IS NULL/, 'a partner must not see un-attributed platform alerts');
});

test('the fragment composes after an existing parameter (id first, then products)', () => {
  const s = productScopeSql(['sitenex'], '', 2);
  assert.equal(s.sql, '(product = ANY($2))');
  assert.equal(s.nextIndex, 3);
});

test('an alias qualifies the column for a joined query', () => {
  assert.match(productScopeSql(['sitenex'], 'n', 1).sql, /^\(n\.product = ANY\(\$1\)\)$/);
});

// ── the behaviour the three notification routes now have ────────────────────────
// Simulated against the same SQL shape, so the intent is pinned even though the handlers live in
// routes.js: today's staff hold everything and see everything; a partner sees only their product.
function rowsVisibleTo(held, rows) {
  const s = productScopeSql(held, '', 1);
  return rows.filter(r => (held.includes(r.product)) || (r.product === null && s.hasInternal));
}
const ROWS = [
  { id: 1, product: 'abiozen', title: 'Apollo sequence failed' },
  { id: 2, product: 'sitenex', title: 'Prospecting: 3 errors for sitenex' },
  { id: 3, product: null, title: 'Cron failure: daily briefing' },
  { id: 4, product: 'golfnex', title: 'Content Studio drafts ready' },
];

test('a staff user holding everything still sees every notification (no behaviour change today)', () => {
  const staff = ['abiozen', 'golfnex', 'favly', 'linkabl', 'aros', 'sitenex', 'internal'];
  assert.deepEqual(rowsVisibleTo(staff, ROWS).map(r => r.id), [1, 2, 3, 4]);
});

test('a SiteNex user sees their OWN product alerts and nothing else', () => {
  const visible = rowsVisibleTo(['sitenex'], ROWS);
  assert.deepEqual(visible.map(r => r.id), [2], 'their own agent failures — which is the point of not reclassifying');
  assert.ok(!visible.some(r => /Apollo|Content Studio/.test(r.title)), 'no other product leaks');
  assert.ok(!visible.some(r => r.product === null), 'no platform-wide staff alerts');
});

test('read-all marks only what the caller holds', () => {
  const marked = rowsVisibleTo(['sitenex'], ROWS).map(r => r.id);
  assert.deepEqual(marked, [2]);
  const staffMarked = rowsVisibleTo(['abiozen', 'sitenex', 'internal'], ROWS).map(r => r.id);
  assert.deepEqual(staffMarked, [1, 2, 3], 'still org-wide for staff, but only across what they hold');
});

// ── THE TWO DEFINITIONS MUST NOT BE MIXED UP ────────────────────────────────────
//
// heldProducts reads the table. effectiveProducts adds the super_admin bypass. Once the super admin's 7
// explicit rows were removed, any handler still calling heldProducts saw [] for him — which silently made
// the notification feed empty and every outreach write 403 for the one account meant to see everything.
//
// Nothing caught it: every test fake returns rows for `FROM user_products`, so both functions agree in a
// test and disagree only in production. Hence a source-level assertion.
test('effectiveProducts gives a super admin everything; heldProducts gives him what is in the table', async () => {
  const { effectiveProducts } = require('./held');
  const { GRANTABLE } = require('./route-map');
  const empty = { query: async () => ({ rows: [] }) };
  assert.deepEqual(await effectiveProducts({ id: 'u', role: 'super_admin' }, empty), GRANTABLE,
    'the bypass is by ROLE, so no rows are needed');
  assert.deepEqual(await heldProducts('u', empty), [], 'while the raw read is honest about the table');
  assert.deepEqual(await effectiveProducts({ id: 'u', role: 'admin' }, empty), [],
    'and no other role gets the bypass');
});

test('no route handler scopes data with heldProducts — they must all use effectiveProducts', () => {
  const routes = require('fs').readFileSync(__dirname + '/../../api/routes.js', 'utf8');
  const bad = [...routes.matchAll(/heldProducts\(req\.user[^)]*\)/g)].map(m => m[0]);
  assert.deepEqual(bad, [],
    `\nthese handlers read the raw user_products table instead of the effective set, so the super admin\n` +
    `(who holds ZERO rows) gets [] and sees nothing:\n  ${bad.join('\n  ')}\n`);
  // Non-vacuity: there must actually be scoped handlers to check.
  assert.ok((routes.match(/effectiveProducts\(req\.user\)/g) || []).length >= 5,
    'expected several product-scoped handlers');
});
