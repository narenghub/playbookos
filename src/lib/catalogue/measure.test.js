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
  assert.equal(get(l, 'suppliers with a MACHINE-READABLE catalogue'), 9,
    'the contributing count has collapsed back into the examined count — the original defect');
  assert.notEqual(get(l, 'suppliers with a MACHINE-READABLE catalogue'), get(l, 'supplier threads examined'),
    'these two must be separately computed, not aliases');
});

test('duplicate rows are counted and excluded from distinct products, not deleted', () => {
  const dup = { supplier: 'Sinopep', name: 'Atorvastatin', cas: '134523-00-5', confidence: 'high',
    duplicate_of_file: 'Brochure_3.12.2026_Generic_APIs_Sinopep.pdf' };
  const l = ladder({ threads: THREADS, rows: [...ROWS, dup, { ...dup }] });

  assert.equal(get(l, 'extracted candidate rows'), 11, 'duplicates must still be counted as extracted');
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
  assert.equal(get(l, 'commercially qualified products'), 0,
    'clearance cannot be derived from extraction — it is per molecule, per jurisdiction, by a human');
  assert.equal(get(l, 'published marketplace products'), 0);
  // They are inputs, not constants, so a later system that really does clear or publish can report
  // it — but nothing in the extractor may set them.
  const l2 = ladder({ threads: THREADS, rows: ROWS, cleared: 7, published: 3 });
  assert.equal(get(l2, 'commercially qualified products'), 7);
  assert.equal(get(l2, 'published marketplace products'), 3);
});

test('the ladder has all twelve levels, in order, and each is a distinct question', () => {
  const l = ladder({ threads: THREADS, rows: ROWS });
  assert.equal(l.length, 12, 'a level has been added or dropped');
  assert.deepEqual(l.map(([k]) => ladderKey(k)), [
    'supplier_threads_examined',
    'suppliers_who_replied',
    'suppliers_who_sent_a_catalogue',
    'suppliers_with_a_machine_readable_catalogue',
    'source_documents_received',
    'distinct_source_documents',
    'extracted_candidate_rows',
    'duplicate_rows_identical_document_content',
    'distinct_candidate_products',
    'identity_verified_same_line_checksum_cas',
    'commercially_qualified_products',
    'published_marketplace_products',
  ]);
});

test('sending a catalogue and sending a READABLE catalogue are separate levels', () => {
  // The real 4 Nov shape: 19 replied, 15 attached something, 9 of those could be read. Collapsing
  // the middle two is what let fifteen catalogues sound like nine — or nine sound like nineteen.
  const l = ladder({
    threads: THREADS,
    rows: ROWS,
    suppliersWithCatalogue: new Set(['Alivus', 'Biophore', 'ChemWerth', 'Chieron', 'Egis',
      'Reliance', 'Kelun', 'Sinopep', 'Synthon', 'Duorui', 'Emcure', 'Harbin', 'ZPC', 'Thinheal',
      'Shanxi']),
  });
  assert.equal(get(l, 'suppliers who replied'), 19);
  assert.equal(get(l, 'suppliers who sent a catalogue'), 15);
  assert.equal(get(l, 'suppliers with a MACHINE-READABLE catalogue'), 9);
  // Each strictly below the one above it. If any pair is equal by construction rather than by the
  // data, a level has become an alias again.
  assert.ok(get(l, 'suppliers who sent a catalogue') < get(l, 'suppliers who replied'));
  assert.ok(get(l, 'suppliers with a MACHINE-READABLE catalogue') < get(l, 'suppliers who sent a catalogue'));
});

test('without a catalogue count, the level is a floor and never an estimate', () => {
  // A supplier whose file parsed certainly sent one, so the parseable count is a safe lower bound.
  // It must never be inflated by guessing.
  const l = ladder({ threads: THREADS, rows: ROWS });
  assert.equal(get(l, 'suppliers who sent a catalogue'), 9);
  assert.equal(get(l, 'suppliers with a MACHINE-READABLE catalogue'), 9);
});

test('documents received and distinct documents are counted separately', () => {
  const docs = [
    { filename: 'a.pdf', duplicate_of: null },
    { filename: 'b.pdf', duplicate_of: null },
    { filename: 'b-copy.pdf', duplicate_of: 'b.pdf' },
  ];
  const l = ladder({ threads: THREADS, rows: ROWS, docs });
  assert.equal(get(l, 'source documents received'), 3,
    'both Sinopep sends must remain in the evidence trail');
  assert.equal(get(l, 'distinct source documents'), 2, 'the duplicate was counted as distinct');
});

test('an empty run reports zeroes rather than throwing', () => {
  // The dry run reads whatever has replied. A quiet week must not break the report.
  const l = ladder({});
  for (const [, n] of l) assert.equal(n, 0);
});

// ── THE ORDER-DEPENDENT COMPARISON THAT GOT THE ANSWER WRONG ────────────────

const { linkIdenticalAttachments } = require('./measure');

// The real Alivus thread, in the real order: the .eml comes FIRST, and the covering message's own
// spreadsheet is collected after it. The digests are the real ones from the 4 Nov probe run.
const EML_FIRST = () => [
  {
    filename: 'RE: Book1.xlsx.eml',
    sha256: '7c8be27abeb47599742ca1ecf1f7b74d',
    nested: {
      ok: true,
      attachments: [
        { filename: 'image001.jpg', sha256: '0bea2cd9ba8d60401605b53648e8cf80' },
        { filename: 'Abiozen - Samples - Revised.xlsx', sha256: '9d235a5be378fe1c7cbf3c46e84b2bbc' },
      ],
    },
  },
  { filename: 'Abiozen - Samples - Revised.xlsx', sha256: '9d235a5be378fe1c7cbf3c46e84b2bbc', nested: null },
];

test('a nested file is matched against attachments collected AFTER it', () => {
  // The defect: comparing inside the read loop searched a list the match was not in yet, so this
  // reported "NOT seen elsewhere" for two files whose digests were identical three lines apart.
  const [eml, outer] = linkIdenticalAttachments(EML_FIRST());
  const xlsx = eml.nested.attachments.find((a) => a.filename.endsWith('.xlsx'));
  assert.equal(xlsx.identical_to, outer.filename,
    'the nested spreadsheet is byte-for-byte the one attached beside it and must say so');
});

test('a nested file with no twin is reported as unique, not as a duplicate', () => {
  const [eml] = linkIdenticalAttachments(EML_FIRST());
  const jpg = eml.nested.attachments.find((a) => a.filename.endsWith('.jpg'));
  assert.equal(jpg.identical_to, null, 'a file seen only inside the attached email must stay flagged');
});

test('a file is not a duplicate of the envelope that carried it', () => {
  // A degenerate case worth pinning: if a .eml somehow shares a digest with its own payload, the
  // container must not be offered as the match.
  const same = 'aaaa1111';
  const [eml] = linkIdenticalAttachments([
    { filename: 'x.eml', sha256: same, nested: { ok: true, attachments: [{ filename: 'inner', sha256: same }] } },
  ]);
  assert.equal(eml.nested.attachments[0].identical_to, null);
});

test('resolution is order-independent — the reversed thread gives the same answer', () => {
  const reversed = EML_FIRST().reverse();
  linkIdenticalAttachments(reversed);
  const eml = reversed.find((a) => a.filename.endsWith('.eml'));
  const xlsx = eml.nested.attachments.find((a) => a.filename.endsWith('.xlsx'));
  assert.equal(xlsx.identical_to, 'Abiozen - Samples - Revised.xlsx',
    'the verdict changed with the order, which is the bug this replaced');
});

test('an unparseable or absent nested message is skipped without throwing', () => {
  assert.doesNotThrow(() => linkIdenticalAttachments([
    { filename: 'a.eml', sha256: 'x', nested: { ok: false, reason: 'no parts found' } },
    { filename: 'b.pdf', sha256: 'y', nested: null },
    { filename: 'c.pdf' },
    null,
  ]));
  assert.doesNotThrow(() => linkIdenticalAttachments(undefined));
});
