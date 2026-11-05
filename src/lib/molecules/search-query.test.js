'use strict';
// Tests for the search-query boundary module (ruling 6 item 6).
//
// These are REGRESSION tests before they are anything else. The module was extracted out of
// routes.js to narrow an over-broad guard exemption, and an extraction that quietly changes
// behaviour is worse than the exemption it fixed — the search would still work, just differently,
// and nobody would know which results moved.
//
// So the first group asserts the new call produces EXACTLY what the old inline code produced, by
// comparing against synonyms.js directly.

const assert = require('assert');
const { expandForSearch, searchLikeSql, MIN_TERM_LENGTH } = require('./search-query');
// Imported here to compare the boundary against the thing it delegates to.
//
// I first wrote that this file was "covered by SELF_PATHS" — it was not, and the R2 guard refused
// it on the next run. It now carries its own allowlist entry with a stated reason. Worth recording:
// the comment was a guess about the guard's behaviour written as a statement of fact, and the guard
// disagreed.
const { expandMolecule, moleculeLikeSql, likePatterns } = require('./synonyms');

let pass = 0; let fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; } catch (e) {
    fail += 1;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}

// ── REGRESSION: the extraction changed nothing ─────────────────────────────

t('REGRESSION: expandForSearch returns the same terms as the old inline expandMolecule call', () => {
  for (const term of ['leuprolide', 'leuprorelin', 'gemcitabine', 'metformin hydrochloride',
    'testosterone enanthate', 'semaglutide']) {
    const expected = expandMolecule(term).terms;
    assert.deepStrictEqual(expandForSearch(term).terms, expected, `terms differ for "${term}"`);
  }
});

t('REGRESSION: the patterns are exactly what likePatterns produced inline', () => {
  for (const term of ['leuprolide', 'leuprorelin', 'gemcitabine hcl']) {
    const expected = likePatterns(expandMolecule(term).terms);
    assert.deepStrictEqual(expandForSearch(term).patterns, expected, `patterns differ for "${term}"`);
  }
});

t('REGRESSION: searchLikeSql emits exactly what moleculeLikeSql emits', () => {
  for (const [col, idx] of [['LOWER(sm.molecule_name)', 1], ['k', 2],
    ['LOWER(molecule_name)', 2], ['LOWER(m.molecule_name)', 7]]) {
    assert.strictEqual(searchLikeSql(col, idx), moleculeLikeSql(col, idx),
      `SQL differs for ${col} at $${idx}`);
  }
});

t('REGRESSION: the ok/not-ok boundary matches the old `molecule && trim().length >= 2` guard', () => {
  // The old call sites both gated on this expression. If the new one disagrees anywhere, a search
  // that used to run now returns a hint, or one that used to be refused now scans the register.
  const oldGuard = (v) => !!(v && String(v).trim().length >= 2);
  for (const v of [undefined, null, '', ' ', 'a', ' a ', 'ab', ' ab ', 'leuprolide', '  ',
    'x', 'xy', 0, 1, 12, 'a '.repeat(1)]) {
    assert.strictEqual(expandForSearch(v).ok, oldGuard(v),
      `disagreement on ${JSON.stringify(v)}: old ${oldGuard(v)}, new ${expandForSearch(v).ok}`);
  }
});

t('REGRESSION: the INN/USAN case that motivated the expansion still works', () => {
  // A customer asked for LEUPRORELIN (the INN) and got nothing, because every holder is filed
  // under LEUPROLIDE (the USAN). If this ever stops holding, the extraction broke the thing the
  // original code existed to fix.
  const r = expandForSearch('leuprorelin');
  assert.ok(r.ok);
  assert.ok(r.terms.some((x) => /leuprolide/i.test(x)),
    `expected a leuprolide term, got: ${r.terms.join(', ')}`);
});

// ── the short-term floor ───────────────────────────────────────────────────

t('a one-character term is refused with a reason, not thrown', () => {
  const r = expandForSearch('a');
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.terms, []);
  assert.deepStrictEqual(r.patterns, []);
  assert.ok(/at least 2 characters/.test(r.reason));
});

t('a missing term is refused rather than crashing on undefined', () => {
  for (const v of [undefined, null]) {
    const r = expandForSearch(v);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.term, '');
  }
});

t('whitespace is trimmed before the length check', () => {
  assert.strictEqual(expandForSearch('  a  ').ok, false, 'one real character is still too short');
  assert.strictEqual(expandForSearch('  ab  ').ok, true);
  assert.strictEqual(expandForSearch('  ab  ').term, 'ab', 'the term is the trimmed form');
});

t('MIN_TERM_LENGTH is exported so a caller cannot restate it and drift', () => {
  assert.strictEqual(MIN_TERM_LENGTH, 2);
});

// ── searchLikeSql refuses a bad parameter index ────────────────────────────

t('NEGATIVE CONTROL: a non-integer or zero parameter index is refused', () => {
  // An off-by-one here silently binds the wrong parameter. In Postgres that is usually a type
  // error, and occasionally a query that returns the wrong rows — which is the bad case.
  for (const bad of [0, -1, 1.5, '1', null, undefined, NaN]) {
    assert.throws(() => searchLikeSql('k', bad), /1-based parameter index/,
      `index ${JSON.stringify(bad)} should have been refused`);
  }
});

t('NEGATIVE CONTROL: a missing column expression is refused', () => {
  for (const bad of ['', null, undefined, 42, {}]) {
    assert.throws(() => searchLikeSql(bad, 1), /column expression/);
  }
});

// ── the boundary returns nothing commercial ────────────────────────────────

t('NEGATIVE CONTROL: the result carries no price, CAS, holder count or identity', () => {
  // The whole reason this module may import the search rule is that it returns only search
  // material. If a commercial field ever appears on this object, the exemption stops being narrow
  // and the guard is back to protecting nothing.
  const r = expandForSearch('leuprolide');
  const keys = Object.keys(r).sort();
  assert.deepStrictEqual(keys, ['ok', 'patterns', 'reason', 'term', 'terms'],
    `unexpected keys on the search result: ${keys.join(', ')}`);
  const forbidden = /price|cost|cas|holder|supplier|quote|identity|moleculeKey/i;
  for (const k of keys) {
    assert.ok(!forbidden.test(k), `"${k}" is a commercial field and must not be here`);
  }
});

t('the expansion is deliberately GENEROUS, which is why it may not price', () => {
  // Base and salt both come back for either query. Correct for FINDING a substance, wrong for
  // ORDERING one — they are different substances with different registry numbers and prices. This
  // test documents the property rather than guarding a number.
  const base = expandForSearch('leuprolide').terms.map((x) => x.toLowerCase());
  assert.ok(base.length >= 1);
  const salt = expandForSearch('leuprolide acetate').terms.map((x) => x.toLowerCase());
  assert.ok(salt.length >= 1);
  const overlap = base.filter((x) => salt.includes(x));
  assert.ok(overlap.length > 0,
    'base and salt queries are expected to overlap — that overlap is exactly why this module is '
    + 'forbidden from producing a price');
});

console.log(`\nsearch-query: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
