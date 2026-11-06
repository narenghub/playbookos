// ── THE BACKWARD-COMPATIBILITY CHECK MUST TELL "DROPPED" FROM "NEVER CREATED" ──
//
//   node --test scripts/readiness-column-classification.test.js
//
// On 2026-11-06 the first run of the readiness check against a real 25MB production dump reported:
//
//   FAIL  5 column(s) the application reads are GONE
//         federal_opportunities.solicitation_number, …, opportunity_bid_reviews.decision
//
// None of those five had been dropped. None had ever existed in that database: the migration chain
// had halted at the `outreach` step, so the steps that create them never ran. "GONE" describes a
// destructive migration — the single thing that check exists to detect — and it sent the reader
// looking for a DROP statement that was not in the chain.
//
// The cost of that wording is not the confusion. It is that the next person, having twice found this
// assertion crying wolf, stops believing it — and the one time a migration really does drop a column
// the application reads, the message will look the same as the two times it did not.
//
// The clean-build path never reaches either branch: every column is present, so the classifier is
// never asked a hard question. These are the negative controls. A classifier only ever run against a
// healthy database is one nobody has watched say no.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { classifyColumns, APP_COLUMNS } = require('./verify-migration-readiness');

test('a column present before and absent after is DROPPED', () => {
  const { dropped, notCreated } = classifyColumns(
    { 'users.email': true, 'users.role': true },
    { 'users.email': false, 'users.role': true });
  assert.deepStrictEqual(dropped, ['users.email'], 'this is the real backward-compatibility break');
  assert.deepStrictEqual(notCreated, []);
});

test('a column absent before and after was NEVER CREATED, not dropped', () => {
  // The exact production case: the chain halted, so these were never created.
  const cols = ['federal_opportunities.is_biddable', 'opportunity_bid_reviews.decision'];
  const before = {}; const after = {};
  for (const c of cols) { before[c] = false; after[c] = false; }
  const { dropped, notCreated } = classifyColumns(before, after);
  assert.deepStrictEqual(dropped, [], 'nothing was dropped — reporting a drop here is the false alarm');
  assert.deepStrictEqual(notCreated, cols);
});

test('a column the migration adds is neither dropped nor missing', () => {
  const { dropped, notCreated } = classifyColumns(
    { 'federal_opportunities.is_biddable': false },
    { 'federal_opportunities.is_biddable': true });
  assert.deepStrictEqual(dropped, []);
  assert.deepStrictEqual(notCreated, []);
});

test('the two findings are reported separately when both occur', () => {
  const { dropped, notCreated } = classifyColumns(
    { 'users.email': true, 'opportunity_bid_reviews.decision': false },
    { 'users.email': false, 'opportunity_bid_reviews.decision': false });
  assert.deepStrictEqual(dropped, ['users.email']);
  assert.deepStrictEqual(notCreated, ['opportunity_bid_reviews.decision']);
});

test('with no baseline reading, nothing is claimed to have been dropped', () => {
  // A missing before is not evidence of a drop. Guessing here is how the original defect read.
  const { dropped, notCreated } = classifyColumns(null, { 'users.email': false });
  assert.deepStrictEqual(dropped, [], 'without a before, a drop cannot be asserted');
  assert.deepStrictEqual(notCreated, ['users.email']);
});

test('the columns being checked include the ones the tracker reads', () => {
  const keys = APP_COLUMNS.map(([t, c]) => `${t}.${c}`);
  for (const must of ['users.email', 'users.role', 'companies.slug',
    'federal_opportunities.solicitation_number', 'opportunity_bid_reviews.decision']) {
    assert.ok(keys.includes(must), `${must} is not being checked for`);
  }
});

test('requiring the module does not start a Postgres cluster or run the check', () => {
  // The require above already happened. If main() were unguarded this file could not exist.
  assert.strictEqual(typeof classifyColumns, 'function');
});
