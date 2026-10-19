'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rowsFromText, rowsFromSheet, cleanName } = require('./extract');

// ── THE LAYOUTS THAT ACTUALLY ARRIVED ───────────────────────────────────────

test('a numbered table: name before the CAS on the same line', () => {
  const { rows } = rowsFromText(`
Sr No   Product Name                CAS No.       Status
1       Paracetamol                 103-90-2      US DMF
2       Metformin Hydrochloride     1115-70-4     CEP
3       Abiraterone Acetate         154229-19-3   GMP
`);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.name),
    ['Paracetamol', 'Metformin Hydrochloride', 'Abiraterone Acetate']);
  assert.deepEqual(rows.map((r) => r.cas), ['103-90-2', '1115-70-4', '154229-19-3']);
  assert.ok(rows.every((r) => r.confidence === 'high'));
  assert.deepEqual(rows[0].markers, ['DMF']);
  assert.deepEqual(rows[1].markers, ['CEP']);
});

// The header row must not become a product.
test('the header row is not a product', () => {
  const { rows } = rowsFromText('Product Name   CAS No.   Status\nAspirin   50-78-2   USP');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Aspirin');
});

test('a labelled form: "CAS No.: 103-90-2"', () => {
  const { rows } = rowsFromText('Paracetamol BP/EP  CAS No.: 103-90-2');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Paracetamol BP/EP');
});

// PDF text order routinely breaks a row apart, putting the name on its own line.
test('the name on the line above the number', () => {
  const { rows } = rowsFromText(`
Ibuprofen
    15687-27-1    API
`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Ibuprofen');
  assert.equal(rows[0].confidence, 'low');
  assert.equal(rows[0].name_source, 'line-1-above');
});

// A flattened two-column table puts two products on one line. The text between the first number
// and the second belongs to the SECOND product — pairing it with the first is the classic error.
test('two products flattened onto one line are split at the numbers', () => {
  const { rows } = rowsFromText('Paracetamol 103-90-2   Metformin Hydrochloride 1115-70-4');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Paracetamol');
  assert.equal(rows[0].cas, '103-90-2');
  assert.equal(rows[1].name, 'Metformin Hydrochloride');
  assert.equal(rows[1].cas, '1115-70-4');
});

test('a Chinese-English export list', () => {
  const { rows } = rowsFromText('1  对乙酰氨基酚 Paracetamol  103-90-2  原料药 API');
  assert.equal(rows.length, 1);
  assert.match(rows[0].name, /Paracetamol/);
  assert.equal(rows[0].grade, 'api');
});

test('grade and regulatory markers are picked up from the row', () => {
  const { rows } = rowsFromText(`
Semaglutide         910463-68-2   peptide, GMP
Atorvastatin KSM    134523-03-8   key starting material
`);
  assert.equal(rows[0].grade, 'peptide');
  assert.ok(rows[0].markers.includes('GMP'));
  assert.equal(rows[1].grade, 'ksm');
});

// ── THE NOISE A 40-PAGE BROCHURE IS FULL OF ─────────────────────────────────

test('contact details and page furniture do not become products', () => {
  const { rows, unanchored } = rowsFromText(`
Egis Pharmaceuticals PLC
H-1106 Budapest, Keresztúri út 30-38
Tel: 36-1-803-5555   Fax: 36-1-803-5556
email: sales@egis.hu     www.egis.hu
Page 4 of 48
Copyright 2026. All rights reserved.
`);
  assert.equal(rows.length, 0, 'no CAS numbers here, so no products');
  for (const u of unanchored) {
    assert.ok(!/@|www\.|tel|fax|copyright|page \d/i.test(u), `"${u}" should have been filtered`);
  }
});

// A document reference shaped like a CAS number must not create a product.
test('a shape-matching reference with a bad checksum creates nothing', () => {
  const { rows } = rowsFromText('Revision 31245-08-7 approved by QA');
  assert.equal(rows.length, 0);
});

test('the same product listed twice in one document is one row', () => {
  const { rows } = rowsFromText('Aspirin 50-78-2 API\nAspirin 50-78-2 API');
  assert.equal(rows.length, 1);
});

// ── UNANCHORED LINES: REPORTED, NEVER LISTED ────────────────────────────────

test('names with no CAS are collected separately, not as products', () => {
  const { rows, unanchored } = rowsFromText(`
Custom Peptide Services
Semaglutide
Tirzepatide
Liraglutide
`);
  assert.equal(rows.length, 0, 'no CAS, so nothing is a product row');
  assert.ok(unanchored.includes('Semaglutide'));
  assert.ok(unanchored.includes('Tirzepatide'));
});

test('prose is not mistaken for a product name', () => {
  const { unanchored } = rowsFromText(
    'We are a leading manufacturer of active pharmaceutical ingredients serving global markets');
  assert.deepEqual(unanchored, [], 'a long sentence is not a product name');
});

// ── cleanName ───────────────────────────────────────────────────────────────

test('cleanName strips row numbers, bullets and separators', () => {
  assert.equal(cleanName('12.  Paracetamol'), 'Paracetamol');
  assert.equal(cleanName('(3) Metformin HCl'), 'Metformin HCl');
  assert.equal(cleanName('• Aspirin —'), 'Aspirin');
  assert.equal(cleanName('  Ibuprofen  |  '), 'Ibuprofen');
});

// A flattened PDF table separates the row number from its bracket: "  7 )  Atorvastatin".
// The first version left the ")" on the front of every such name.
test('cleanName handles a row number spaced away from its punctuation', () => {
  assert.equal(cleanName('  7 )  Atorvastatin Calcium Trihydrate'), 'Atorvastatin Calcium Trihydrate');
  assert.equal(cleanName('12 .  Paracetamol'), 'Paracetamol');
  assert.equal(cleanName('( 3 ) Metformin'), 'Metformin');
});

// Molecule names legitimately begin with a digit, so a bare number may only be stripped when
// punctuation or a column-width gap proves it is a row index.
test('cleanName does not eat a digit that is part of the molecule name', () => {
  assert.equal(cleanName('5-Fluorouracil'), '5-Fluorouracil');
  assert.equal(cleanName('6-Mercaptopurine'), '6-Mercaptopurine');
  assert.equal(cleanName('2 Chloroadenosine'), '2 Chloroadenosine', 'one space is not a column gap');
  assert.equal(cleanName('4    Ibuprofen'), 'Ibuprofen', 'a wide gap is a column');
});

test('cleanName rejects what is not a name', () => {
  for (const bad of ['', '  ', '12', '(4)', 'CAS No.', 'Product Name', 'Status', '---', 'No']) {
    assert.equal(cleanName(bad), null, `${JSON.stringify(bad)} should be rejected`);
  }
});

// ── SPREADSHEETS ────────────────────────────────────────────────────────────

test('a sheet with a header row maps its columns', () => {
  const { rows, stats } = rowsFromSheet([
    ['Abiozen sample request', '', ''],
    ['Sr', 'Product Name', 'CAS Number', 'Grade'],
    ['1', 'Paracetamol', '103-90-2', 'API'],
    ['2', 'Metformin Hydrochloride', '1115-70-4', 'API'],
  ]);
  assert.equal(stats.header_row, 1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Paracetamol');
  assert.equal(rows[0].cas, '103-90-2');
  assert.equal(rows[0].confidence, 'high');
});

// A column headed CAS regularly holds blanks and notes. The checksum still decides.
test('a sheet CAS column containing junk is validated, not trusted', () => {
  const { rows } = rowsFromSheet([
    ['Product', 'CAS No'],
    ['Paracetamol', '103-90-2'],
    ['Something New', 'to be confirmed'],
    ['Wrong Digit', '103-90-3'],
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].cas, '103-90-2');
  assert.equal(rows[1].cas, null, '"to be confirmed" is not a CAS');
  assert.equal(rows[2].cas, null, 'a failed checksum is not a CAS');
  assert.equal(rows[1].confidence, 'medium');
});

test('a sheet with no recognisable header still yields rows', () => {
  const { rows } = rowsFromSheet([['Aspirin', '50-78-2'], ['Ibuprofen', '15687-27-1']]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Aspirin');
});

test('empty input is handled', () => {
  assert.equal(rowsFromText('').rows.length, 0);
  assert.equal(rowsFromText(null).rows.length, 0);
  assert.equal(rowsFromSheet([]).rows.length, 0);
  assert.equal(rowsFromSheet(null).rows.length, 0);
});

// Every row carries where it came from, so a wrong row can be traced to its file and line.
test('every row records its source', () => {
  const { rows } = rowsFromText('Aspirin 50-78-2', { file: 'egis.pdf', supplier: 'Egis' });
  assert.equal(rows[0].source_file, 'egis.pdf');
  assert.equal(rows[0].supplier, 'Egis');
  assert.match(rows[0].line, /Aspirin/);
});
