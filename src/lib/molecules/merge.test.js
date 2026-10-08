'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mergeMoleculeRows, mergeHolders, preferredLabel } = require('./merge');
const { canonicalMolecule } = require('./synonyms');

// The exact three rows the CPHI search returned for `leuprorelin` against real Postgres.
const LEUPROLIDE_ROWS = [
  { molecule: 'Leuprolide', holder_count: 1, on_floor: 1, studies: null, ph3: null, ph2: null, patients: null,
    holders: [{ holder: 'Bachem AG', booth: '3C22', hall: '3', exhibiting: true }] },
  { molecule: 'Leuprolide Acetate', holder_count: 2, on_floor: 1, studies: 1, ph3: 1, ph2: null, patients: 420,
    holders: [{ holder: 'Sun Pharmaceutical Industries', booth: null, hall: null, exhibiting: false },
              { holder: 'ScinoPharm Taiwan', booth: '5B14', hall: '5', exhibiting: true }] },
  { molecule: 'Leuprorelin', holder_count: 0, on_floor: 0, studies: 1, ph3: null, ph2: 1, patients: 160,
    holders: [] },
];

// ── THE FALSE SCARCITY CLAIM ────

test('three alias rows become one substance', () => {
  const merged = mergeMoleculeRows(LEUPROLIDE_ROWS);
  assert.strictEqual(merged.length, 1, 'one substance, one row');
});

test('holder_count is RECOUNTED, not carried from the first row', () => {
  const [row] = mergeMoleculeRows(LEUPROLIDE_ROWS);
  assert.strictEqual(row.holder_count, 3,
    'the page prints "SOLE holder worldwide" at 1 — that would be a false scarcity claim to a buyer');
  assert.strictEqual(row.holders.length, 3);
});

test('the holder count equals the distinct holders, always', () => {
  // These two numbers drive different parts of the page. If they can disagree, one of them lies.
  for (const rows of [LEUPROLIDE_ROWS, LEUPROLIDE_ROWS.slice(0, 2), LEUPROLIDE_ROWS.slice(2)]) {
    for (const row of mergeMoleculeRows(rows)) {
      assert.strictEqual(row.holder_count, row.holders.length,
        `holder_count ${row.holder_count} vs ${row.holders.length} holders on ${row.molecule}`);
    }
  }
});

test('on_floor counts only holders with a booth', () => {
  const [row] = mergeMoleculeRows(LEUPROLIDE_ROWS);
  assert.strictEqual(row.on_floor, 2, 'Bachem 3C22 and ScinoPharm 5B14; Sun is not exhibiting');
});

test('demand sums across aliases', () => {
  const [row] = mergeMoleculeRows(LEUPROLIDE_ROWS);
  assert.strictEqual(row.studies, 2, 'a trial under the USAN and one under the INN are two trials');
  assert.strictEqual(row.patients, 580);
  assert.strictEqual(row.ph3, 1);
  assert.strictEqual(row.ph2, 1);
});

test('the label keeps the orderable salt form', () => {
  const [row] = mergeMoleculeRows(LEUPROLIDE_ROWS);
  assert.strictEqual(row.molecule, 'Leuprolide Acetate',
    'the name a buyer puts on a purchase order, not the bare stem');
});

test('filed_as shows every name so the merge is visible', () => {
  const [row] = mergeMoleculeRows(LEUPROLIDE_ROWS);
  assert.deepStrictEqual(row.filed_as, ['Leuprolide', 'Leuprolide Acetate', 'Leuprorelin']);
});

test('filed_as is null when there was nothing to merge', () => {
  const [row] = mergeMoleculeRows([{ molecule: 'Cabazitaxel', holder_count: 2, holders: [
    { holder: 'A', exhibiting: false }, { holder: 'B', exhibiting: false }] }]);
  assert.strictEqual(row.filed_as, null, 'no banner for a single-name substance');
  assert.strictEqual(row.holder_count, 2);
});

// ── NOTHING UNRELATED GETS MERGED ────

test('two different substances stay two rows', () => {
  const merged = mergeMoleculeRows([
    { molecule: 'Metformin Hydrochloride', holder_count: 1, holders: [{ holder: 'Sun', exhibiting: false }] },
    { molecule: 'Cabazitaxel', holder_count: 1, holders: [{ holder: 'Bachem', exhibiting: false }] },
  ]);
  assert.strictEqual(merged.length, 2);
});

test('no two substances in the synonym table share a canonical key', () => {
  // If two unrelated substances canonicalised the same way, this merge would pool their suppliers —
  // which is the failure that sends a buyer to a company that does not make what they asked for.
  const { SYNONYM_GROUPS } = require('./synonyms');
  const seen = new Map();
  for (const g of SYNONYM_GROUPS) {
    const key = canonicalMolecule(g[0]);
    if (seen.has(key)) {
      assert.fail(`"${key}" is the canonical name of both ${JSON.stringify(seen.get(key))} and ${JSON.stringify(g)}`);
    }
    seen.set(key, g);
  }
});

test('every member of a group canonicalises identically', () => {
  const { SYNONYM_GROUPS } = require('./synonyms');
  for (const g of SYNONYM_GROUPS) {
    const keys = new Set(g.map(canonicalMolecule));
    assert.strictEqual(keys.size, 1,
      `${JSON.stringify(g)} canonicalises to ${JSON.stringify([...keys])} — the group would not merge`);
  }
});

test('a salt form canonicalises with its base', () => {
  assert.strictEqual(canonicalMolecule('Leuprolide Acetate'), canonicalMolecule('leuprorelin'));
  assert.strictEqual(canonicalMolecule('Metformin Hydrochloride'), canonicalMolecule('metformin'));
});

// ── HOLDER DEDUPE ────

test('the same company from two alias rows is one holder, keeping its booth', () => {
  const holders = mergeHolders([
    [{ holder: 'ScinoPharm Taiwan', booth: null, exhibiting: false }],
    [{ holder: 'ScinoPharm Taiwan', booth: '5B14', exhibiting: true }],
  ]);
  assert.strictEqual(holders.length, 1);
  assert.strictEqual(holders[0].booth, '5B14', 'the row that knows where they are standing wins');
});

test('a booth already found is not lost to a later blank', () => {
  const holders = mergeHolders([
    [{ holder: 'ScinoPharm Taiwan', booth: '5B14', exhibiting: true }],
    [{ holder: 'scinopharm taiwan', booth: null, exhibiting: false }],
  ]);
  assert.strictEqual(holders.length, 1, 'case difference is the same company');
  assert.strictEqual(holders[0].booth, '5B14');
});

test('holders without a name are dropped, not counted', () => {
  const holders = mergeHolders([[{ holder: null }, { holder: '' }, { holder: 'Bachem AG' }], null]);
  assert.deepStrictEqual(holders.map(h => h.holder), ['Bachem AG']);
});

// ── PRICE AND SAFETY FIELDS ────

test('the best price and shortest lead time win', () => {
  const [row] = mergeMoleculeRows([
    { molecule: 'Leuprolide', holders: [], price_per_kg_usd: 42000, lead_time_days: 90, min_quantity_g: 100 },
    { molecule: 'Leuprorelin', holders: [], price_per_kg_usd: 38000, lead_time_days: 45, min_quantity_g: 50 },
  ]);
  assert.strictEqual(row.price_per_kg_usd, 38000);
  assert.strictEqual(row.lead_time_days, 45);
  assert.strictEqual(row.min_quantity_g, 50);
});

test('controlled_substance is true if ANY filing says so', () => {
  // Never averaged, never majority-voted. One filing calling it controlled makes it controlled, and
  // getting this wrong is a shipment seized at a border.
  const [row] = mergeMoleculeRows([
    { molecule: 'Leuprolide', holders: [], controlled_substance: 0 },
    { molecule: 'Leuprorelin', holders: [], controlled_substance: 1 },
  ]);
  assert.strictEqual(row.controlled_substance, true);
});

test('gmp_certified is true if any alias has a certified price row', () => {
  const [row] = mergeMoleculeRows([
    { molecule: 'Leuprolide', holders: [], gmp_certified: false },
    { molecule: 'Leuprorelin', holders: [], gmp_certified: true, gmp_grade: 'USP' },
  ]);
  assert.strictEqual(row.gmp_certified, true);
  assert.strictEqual(row.gmp_grade, 'USP');
});

test('absent numbers stay null and never become zero', () => {
  // A zero price reads as free and a zero study count reads as no demand. Both are claims; null is not.
  const [row] = mergeMoleculeRows([{ molecule: 'Cabazitaxel', holders: [] }]);
  assert.strictEqual(row.price_per_kg_usd, null);
  assert.strictEqual(row.studies, null);
  assert.strictEqual(row.patients, null);
  assert.strictEqual(row.lead_time_days, null);
});

test('holder_count is 0 and not null when there are no holders', () => {
  // The UI switches on === 0 to print "No DMF holder at all".
  const [row] = mergeMoleculeRows([{ molecule: 'Cabazitaxel', holders: [] }]);
  assert.strictEqual(row.holder_count, 0);
});

// ── ORDERING AND JUNK ────

test('query order is preserved by first appearance', () => {
  const merged = mergeMoleculeRows([
    { molecule: 'Zoledronic Acid', holders: [] },
    { molecule: 'Leuprolide', holders: [] },
    { molecule: 'Leuprorelin', holders: [] },
    { molecule: 'Abiraterone', holders: [] },
  ]);
  assert.deepStrictEqual(merged.map(r => r.canonical),
    ['zoledronic acid', 'leuprolide', 'abiraterone'],
    'the SQL ORDER BY still decides what is read first');
});

test('junk input does not throw', () => {
  assert.deepStrictEqual(mergeMoleculeRows(null), []);
  assert.deepStrictEqual(mergeMoleculeRows([]), []);
  assert.deepStrictEqual(mergeMoleculeRows([null, undefined]), []);
  const merged = mergeMoleculeRows([{ molecule: null, holders: null }]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].holder_count, 0);
});

test('preferredLabel is deterministic on ties', () => {
  assert.strictEqual(preferredLabel(['BBBB', 'AAAA']), 'AAAA');
  assert.strictEqual(preferredLabel([]), '');
});
