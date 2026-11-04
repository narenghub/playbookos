// ── A CAS ON THE ROW CAN NEVER PRODUCE "NONE ON RECORD" ─────────────────────
//
//   node --test src/lib/catalogue/sku-identity.test.js
//
// `sku-identity-decisions.js` reported `checksum-valid CAS on record: none` for all five active
// SKUs. The census, against the same database minutes later, reported 5 of 5 rows holding a
// CHECKSUM-VALID CAS. The aggregate omitted the SKU row's own column, and a hardcoded line printed
// "skus holds no CAS" two lines below a schema probe that said the column exists.
//
// A false NEGATIVE about identity is the dangerous direction: it says nobody knows what this is
// when a value exists, which invites someone to supply one.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { casEvidenceFor } = require('./sku-identity');
const { validCas } = require('./cas');

const call = (o) => casEvidenceFor({ validCas, ...o });

test('THE DEFECT: a checksum-valid CAS on the SKU row is never "none on record"', () => {
  const e = call({ skuRow: { cas_number: '910463-68-2' }, pricingRows: [], supplierRows: [] });
  assert.equal(e.on_sku_row, '910463-68-2');
  assert.equal(e.on_sku_row_checksum_valid, true);
  assert.deepEqual(e.all_checksum_valid, ['910463-68-2']);
  assert.ok(!e.unresolved.some((u) => /no checksum-valid CAS anywhere/.test(u)),
    `reported "none anywhere" while holding a valid CAS:\n${e.unresolved.join('\n')}`);
});

test('and it is still reported as UNSOURCEABLE, because skus has no provenance column', () => {
  // molecules carries cas_source_values and cas_suppressed_reason. skus carries neither, so a value
  // there cannot be traced to a decision — that is a property of the schema, not of the value.
  const e = call({ skuRow: { cas_number: '315-30-0' } });
  assert.match(e.on_sku_row_provenance, /NONE/);
  assert.ok(e.unresolved.some((u) => /CAS PROVENANCE/.test(u)),
    'a value with no possible provenance must say so');
  assert.match(e.caveat, /checksum-valid CAS copied from the wrong row is checksum-valid/);
});

test('provenance is flagged even when every source agrees', () => {
  // Agreement between unsourced values is not provenance. Three copies of the same unverified
  // number is one inference repeated, which is the name-match lesson in another costume.
  const e = call({
    skuRow: { cas_number: '315-30-0' },
    pricingRows: [{ cas_number: '315-30-0' }],
    supplierRows: [{ supplier: 'X', cas: '315-30-0', confidence: 'high' }],
  });
  assert.equal(e.agrees_across_sources, true);
  assert.deepEqual(e.all_checksum_valid, ['315-30-0']);
  assert.ok(e.unresolved.some((u) => /CAS PROVENANCE/.test(u)),
    'agreement must not suppress the provenance finding');
});

test('a value that FAILS the check digit is reported as failing, not as absent', () => {
  const e = call({ skuRow: { cas_number: '315-30-1' } });
  assert.equal(e.on_sku_row, '315-30-1', 'the bad value must still be shown');
  assert.equal(e.on_sku_row_checksum_valid, false);
  assert.ok(e.unresolved.some((u) => /FAILS the check digit: 315-30-1/.test(u)));
  assert.deepEqual(e.all_checksum_valid, []);
  // 368 rows in study_molecules hold checksum-invalid CAS values. "Absent" and "present but
  // malformed" need different handling: one needs sourcing, the other needs correcting.
  assert.ok(!e.unresolved.some((u) => /blank on the SKU row/.test(u)));
});

test('a missing column, a blank value and a bad value are three different findings', () => {
  const noCol = call({ skuRow: { name: 'x' } });
  assert.equal(noCol.has_cas_column, false);
  assert.ok(noCol.unresolved.some((u) => /no cas_number column/.test(u)));

  const blank = call({ skuRow: { cas_number: null } });
  assert.equal(blank.has_cas_column, true);
  assert.ok(blank.unresolved.some((u) => /blank on the SKU row/.test(u)));

  const bad = call({ skuRow: { cas_number: 'not-a-cas' } });
  assert.ok(bad.unresolved.some((u) => /FAILS the check digit/.test(u)));
});

test('conflicting valid values are surfaced as a decision, not resolved by preference', () => {
  // The census found 113 canonical groups holding conflicting valid CAS numbers — leuprolide
  // 53714-56-0 against leuprolide acetate 74381-53-6. Picking one is the merge the migration must
  // refuse.
  const e = call({
    skuRow: { cas_number: '53714-56-0' },
    supplierRows: [{ supplier: 'ZPC', cas: '74381-53-6', confidence: 'high' }],
  });
  assert.equal(e.all_checksum_valid.length, 2);
  assert.equal(e.agrees_across_sources, false);
  assert.ok(e.unresolved.some((u) => /2 DIFFERENT checksum-valid values/.test(u)));
  assert.ok(e.unresolved.some((u) => /a human must rule on/.test(u)));
});

test('an adjacent CAS is a candidate and never joins the valid set', () => {
  const e = call({
    skuRow: { cas_number: null },
    supplierRows: [
      { supplier: 'A', cas: '315-30-0', confidence: 'medium' },
      { supplier: 'B', cas: '66722-44-9', confidence: 'low' },
    ],
  });
  assert.deepEqual(e.all_checksum_valid, [], 'a nearby CAS must not be counted as identity');
  assert.equal(e.nearby_only_count, 2);
  assert.ok(e.unresolved.some((u) => /no checksum-valid CAS anywhere/.test(u)));
});

test('it refuses to run without the shipped validator', () => {
  // Rather than fall back to a local implementation, which is how a second CAS authority appears.
  assert.throws(() => casEvidenceFor({ skuRow: {} }), /requires the shipped validCas/);
});
