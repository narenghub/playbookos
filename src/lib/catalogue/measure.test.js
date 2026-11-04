// ── THE MEASUREMENT GETS MEASURED ───────────────────────────────────────────
//
//   node --test src/lib/catalogue/measure.test.js
//
// `508 product row(s) from 19 supplier(s)` was wrong because nine suppliers contributed all 508.
// Replacing one wrong number with nine unverified ones would be no improvement, so the fixtures
// below are the real shapes: the Sinopep duplicate, and the 19-examined/9-contributing split.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { makeDocRegistry, ladder, ladderKey } = require('./measure');

test('two files with identical content are one document, whatever they are called', () => {
  // The real case: same page count, same character count, same products, different filenames AND
  // different bytes, because the second is a re-export.
  const reg = makeDocRegistry();
  const content = 'Atorvastatin 134523-00-5\nEmpagliflozin 864070-44-0\n';
  const a = reg.register({
    supplier: 'Sinopep-Allsino Biopharmaceutical Co., Ltd',
    filename: 'Brochure_3.12.2026_Generic_APIs_Sinopep.pdf',
    content, buf: Buffer.from('pdf-bytes-version-one'), extent: '24 page(s), 37094 chars',
  });
  const b = reg.register({
    supplier: 'Sinopep-Allsino Biopharmaceutical Co., Ltd',
    filename: 'Brochure_Generic_APIs_--Sinopep 2026.pdf',
    content, buf: Buffer.from('pdf-bytes-version-two-different-length'), extent: '24 page(s), 37094 chars',
  });

  assert.equal(a.duplicate_of, null, 'the first occurrence must not be a duplicate of itself');
  assert.equal(b.duplicate_of, a.filename, 'the second file was not recognised as the same document');
  assert.equal(b.duplicate_of_index, a.index);
  assert.equal(a.content_sha256, b.content_sha256, 'identical content must hash identically');
  assert.notEqual(a.bytes_sha256, b.bytes_sha256,
    'the fixture must differ in bytes, or it does not test what filename and byte equality miss');
  // Both are kept. The supplier did send two files and that fact is evidence.
  assert.equal(reg.docs.length, 2, 'a duplicate was removed instead of being recorded');
});

test('whitespace differences do not make a new document, but a changed word does', () => {
  const reg = makeDocRegistry();
  const one = reg.register({ supplier: 'S', filename: 'a.pdf', content: 'Allopurinol  315-30-0\n\n' });
  const two = reg.register({ supplier: 'S', filename: 'b.pdf', content: ' Allopurinol 315-30-0 ' });
  assert.equal(two.duplicate_of, 'a.pdf', 'a re-export with different line breaks was treated as new');

  const three = reg.register({ supplier: 'S', filename: 'c.pdf', content: 'Allopurinol 315-30-1' });
  assert.equal(three.duplicate_of, null,
    'a different CAS is a different document — one digit is a different molecule');
  assert.equal(one.duplicate_of, null);
});

test('a duplicate of a duplicate still points at the first occurrence', () => {
  // Otherwise a chain of re-sends counts the second copy as the original and the third as unique.
  const reg = makeDocRegistry();
  reg.register({ supplier: 'S', filename: 'first.pdf', content: 'X 1' });
  const second = reg.register({ supplier: 'S', filename: 'second.pdf', content: 'X 1' });
  const third = reg.register({ supplier: 'S', filename: 'third.pdf', content: 'X 1' });
  assert.equal(second.duplicate_of, 'first.pdf');
  assert.equal(third.duplicate_of, 'first.pdf', 'the chain drifted off the first occurrence');
});

// ── THE LADDER ─────────────────────────────────────────────────────────────

// Nineteen threads examined; nine of them yielded rows. The shape that produced the wrong number.
const THREADS = ['Alivus', 'Biophore', 'ChemWerth', 'Chieron', 'Egis', 'Reliance', 'Kelun',
  'Sinopep', 'Synthon', 'Duorui', 'Emcure', 'Harbin', 'ZPC', 'Thinheal', 'Shanxi', 'ScinoPharm',
  'Suzhou Motif', 'Veranova', 'allpack'].map((company) => ({ company }));

const CONTRIBUTORS = ['Alivus', 'Biophore', 'ChemWerth', 'Chieron', 'Egis', 'Reliance', 'Kelun',
  'Sinopep', 'Synthon'];

const ROWS = CONTRIBUTORS.map((supplier, i) => ({
  supplier, name: `Molecule ${i}`, cas: '315-30-0', confidence: 'high', duplicate_of_file: null,
}));

const get = (l, label) => l.find(([k]) => k === label)[1];

test('the ladder never reports the examined set as the contributing set', () => {
  const l = ladder({ threads: THREADS, rows: ROWS });
  assert.equal(get(l, 'supplier threads examined'), 19);
  assert.equal(get(l, 'suppliers who replied'), 19);
  assert.equal(get(l, 'suppliers with parseable product data'), 9,
    'the contributing count has collapsed back into the examined count — the original defect');
  assert.notEqual(get(l, 'suppliers with parseable product data'), get(l, 'supplier threads examined'),
    'these two must be separately computed, not aliases');
});

test('duplicate rows are counted and excluded from distinct products, not deleted', () => {
  const dup = { supplier: 'Sinopep', name: 'Atorvastatin', cas: '134523-00-5', confidence: 'high',
    duplicate_of_file: 'Brochure_3.12.2026_Generic_APIs_Sinopep.pdf' };
  const l = ladder({ threads: THREADS, rows: [...ROWS, dup, { ...dup }] });

  assert.equal(get(l, 'extracted product rows'), 11, 'duplicates must still be counted as extracted');
  assert.equal(get(l, 'duplicate rows (identical document content)'), 2);
  assert.equal(get(l, 'distinct candidate products'), 9, 'a duplicate row reached the distinct count');
});

test('identity verification refuses an adjacent CAS, a dictionary name and a neighbouring line', () => {
  const rows = [
    { supplier: 'A', name: 'Allopurinol', cas: '315-30-0', confidence: 'high', name_source: 'same-line' },
    { supplier: 'A', name: 'Bisoprolol', cas: '66722-44-9', confidence: 'medium', name_source: 'after-cas' },
    { supplier: 'A', name: 'Duloxetine', cas: '116539-59-4', confidence: 'low', name_source: 'line-2-above' },
    { supplier: 'A', name: 'Ezetimibe', cas: null, confidence: 'medium', name_source: 'dictionary' },
  ];
  const l = ladder({ threads: THREADS, rows });
  assert.equal(get(l, 'identity-verified (same-line checksum CAS)'), 1,
    'identity was inferred from adjacency or similarity — the one thing the ruling forbids');
  assert.equal(get(l, 'distinct candidate products'), 4,
    'unverified rows are still candidates; they are just not verified');
});

test('cleared and published are zero unless something actually cleared or published', () => {
  const l = ladder({ threads: THREADS, rows: ROWS });
  assert.equal(get(l, 'commercially cleared products'), 0,
    'clearance cannot be derived from extraction — it is per molecule, per jurisdiction, by a human');
  assert.equal(get(l, 'published marketplace products'), 0);
  // They are inputs, not constants, so a later system that really does clear or publish can report
  // it — but nothing in the extractor may set them.
  const l2 = ladder({ threads: THREADS, rows: ROWS, cleared: 7, published: 3 });
  assert.equal(get(l2, 'commercially cleared products'), 7);
  assert.equal(get(l2, 'published marketplace products'), 3);
});

test('the ladder has all nine levels, in order, and each is a distinct question', () => {
  const l = ladder({ threads: THREADS, rows: ROWS });
  assert.equal(l.length, 9, 'a level has been added or dropped');
  assert.deepEqual(l.map(([k]) => ladderKey(k)), [
    'supplier_threads_examined',
    'suppliers_who_replied',
    'suppliers_with_parseable_product_data',
    'extracted_product_rows',
    'duplicate_rows_identical_document_content',
    'distinct_candidate_products',
    'identity_verified_same_line_checksum_cas',
    'commercially_cleared_products',
    'published_marketplace_products',
  ]);
});

test('an empty run reports zeroes rather than throwing', () => {
  // The dry run reads whatever has replied. A quiet week must not break the report.
  const l = ladder({});
  for (const [, n] of l) assert.equal(n, 0);
});
