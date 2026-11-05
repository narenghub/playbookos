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

test('holder_count is RECOUNTED, and counts the EXACT substance and form', () => {
  const [row] = mergeMoleculeRows(LEUPROLIDE_ROWS);

  // THIS ASSERTION USED TO EXPECT 3, with the note: 'the page prints "SOLE holder worldwide" at 1 —
  // that would be a false scarcity claim to a buyer'. That reasoning was half right. Understating
  // holders overstates scarcity, which is a claim. But 3 was holders of `Leuprolide` AND
  // `Leuprolide Acetate` together — two substances with different registry numbers — printed under
  // the acetate's name as "competitive, low leverage". Overstating supply is equally a claim, and
  // in the direction that costs us the negotiation.
  //
  // So neither number was safe to print as a verdict. The row now carries both, and refuses the
  // verdict when the forms are mixed.
  assert.strictEqual(row.holder_count, 2, 'Sun and ScinoPharm hold the acetate');
  assert.strictEqual(row.holders.length, 2);
  assert.strictEqual(row.holder_count_basis, 'exact-substance-and-form');

  assert.strictEqual(row.related_form_holder_count, 1, 'Bachem holds the base, which is a related form');
  // Both base-form filings are listed under the names they were FILED under, not collapsed:
  // `Leuprorelin` is the INN of `Leuprolide` and its row carries no holders. Showing the filed
  // spellings is provenance — a buyer can see which name each number came from.
  assert.deepEqual(row.related_forms, ['Leuprolide', 'Leuprorelin']);

  assert.strictEqual(row.supply_claim_allowed, false,
    'the group spans forms, so no single leverage or scarcity sentence is supportable');
  assert.match(row.supply_claim_basis, /No single leverage verdict is supportable across distinct substances/);
});

test('a group with ONE form permits a supply claim', () => {
  const rows = [
    { molecule: 'Leuprolide Acetate', holders: [{ holder: 'Sun Pharmaceutical Industries' }] },
    { molecule: 'Leuprorelin Acetate', holders: [{ holder: 'ScinoPharm Taiwan' }] },
  ];
  const [row] = mergeMoleculeRows(rows);
  assert.strictEqual(row.supply_claim_allowed, true,
    'INN and USAN spellings of the SAME form are one substance, so the count is a fact about it');
  assert.strictEqual(row.holder_count, 2);
  assert.strictEqual(row.related_form_holder_count, 0);
});

test('a company holding both forms is not double-counted as breadth', () => {
  const rows = [
    { molecule: 'Leuprolide', holders: [{ holder: 'Sun Pharmaceutical Industries' }] },
    { molecule: 'Leuprolide Acetate', holders: [{ holder: 'Sun Pharmaceutical Industries' }] },
  ];
  const [row] = mergeMoleculeRows(rows);
  assert.strictEqual(row.holder_count, 1, 'Sun holds the acetate');
  assert.strictEqual(row.related_form_holder_count, 0,
    'Sun also holds the base, but it is the same company — counting it again would present one '
    + 'supplier as two sources');
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

test('on_floor counts only exhibiting holders OF THE EXACT FORM', () => {
  const [row] = mergeMoleculeRows(LEUPROLIDE_ROWS);
  assert.strictEqual(row.on_floor, 1,
    'ScinoPharm 5B14 holds the acetate. Bachem 3C22 is on the floor but holds the BASE — walking a '
    + "buyer to Bachem's booth for an acetate quote is the merge error as a physical journey.");
  // Bachem is still reachable: it appears in related_form_holders, which is discovery.
  assert.deepEqual(row.related_form_holders.map((h) => h.holder), ['Bachem AG']);
  assert.equal(row.related_form_holders[0].booth, '3C22');
});

// ── THE HALF THAT MATTERED MORE THAN THE COUNT ──────────────────────────────

test('a price never crosses a form boundary', () => {
  const rows = [
    { molecule: 'Leuprolide', holders: [{ holder: 'Bachem AG' }], price_per_kg_usd: 100, cas_number: '53714-56-0' },
    { molecule: 'Leuprolide Acetate', holders: [{ holder: 'Sun Pharmaceutical Industries' }], price_per_kg_usd: 900, cas_number: '74381-53-6' },
  ];
  const [row] = mergeMoleculeRows(rows);
  assert.equal(row.molecule, 'Leuprolide Acetate');
  assert.strictEqual(row.price_per_kg_usd, 900,
    'the old code took minNum across the group and returned 100 — the BASE\'s price, on a row '
    + 'labelled with the acetate. A quotable number for a substance nobody priced.');
  assert.strictEqual(row.cas_number, '74381-53-6',
    'and the CAS came from firstDefined across two substances with different registry numbers');
});

test('the exact substance having no price row yields null, not the related form\'s price', () => {
  const rows = [
    { molecule: 'Leuprolide', holders: [{ holder: 'Bachem AG' }], price_per_kg_usd: 100, lead_time_days: 14, gmp_certified: true },
    { molecule: 'Leuprolide Acetate', holders: [{ holder: 'Sun Pharmaceutical Industries' }] },
  ];
  const [row] = mergeMoleculeRows(rows);
  assert.strictEqual(row.price_per_kg_usd, null, 'silence is the safe failure');
  assert.strictEqual(row.lead_time_days, null);
  assert.strictEqual(row.gmp_certified, false,
    'one form\'s GMP certificate is not the other\'s');
  // Exactly the behaviour the inquiry agent already has: "A buyer writing 'Gemcitabine
  // hydrochloride' against a catalogue row for 'Gemcitabine' still gets no price."
});

test('controlled_substance stays ANY across the whole group, deliberately', () => {
  const rows = [
    { molecule: 'Leuprolide', holders: [{ holder: 'Bachem AG' }], controlled_substance: true },
    { molecule: 'Leuprolide Acetate', holders: [{ holder: 'Sun Pharmaceutical Industries' }] },
  ];
  const [row] = mergeMoleculeRows(rows);
  assert.strictEqual(row.controlled_substance, true,
    'a safety flag errs toward the restrictive answer — over-restricting costs a conversation, '
    + 'under-restricting ships a scheduled substance');
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
