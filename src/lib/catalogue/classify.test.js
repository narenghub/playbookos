'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classifyRow, classifyAll } = require('./classify');

const row = (over = {}) => ({
  name: 'Paracetamol', cas: '103-90-2', grade: 'api', markers: [], confidence: 'high',
  name_source: 'same-line', line: 'Paracetamol 103-90-2 API', ...over,
});

test('a new product with no signal is listable but not a priority', () => {
  const r = classifyRow(row());
  assert.equal(r.decision, 'list');
  assert.ok(r.priority < 50);
});

test('a filed DMF or CEP raises it', () => {
  assert.ok(classifyRow(row({ markers: ['DMF'] })).priority >
            classifyRow(row()).priority);
  assert.ok(classifyRow(row({ markers: ['CEP'] })).priority > 50);
});

// ── THE OUTCOME THAT MATTERS MOST COMMERCIALLY ──────────────────────────────
//
// A molecule already on abiozen.com is not a duplicate to throw away. It is a second supplier for
// something already sold, which is the difference between accepting a price and negotiating one.
test('a molecule already in the catalogue is a SECOND SOURCE, not a duplicate', () => {
  const r = classifyRow(row(), { catalogueCas: new Set(['103-90-2']) });
  assert.equal(r.decision, 'second_source');
  assert.ok(r.priority >= 70, 'a second source must outrank an ordinary new listing');
  assert.match(r.reason, /price|second supplier/i);
});

test('a name match with no CAS match is a second source to confirm', () => {
  const r = classifyRow(row({ cas: '51-21-8' }), { catalogueNames: new Set(['paracetamol']) });
  assert.equal(r.decision, 'second_source');
  assert.match(r.reason, /confirm/i);
});

test('evidenced demand beats everything else', () => {
  const wanted = classifyRow(row(), { demandCas: new Set(['103-90-2']) });
  assert.equal(wanted.decision, 'list');
  assert.ok(wanted.priority > classifyRow(row({ markers: ['DMF'] })).priority);

  const both = classifyRow(row({ markers: ['DMF'] }), { demandCas: new Set(['103-90-2']) });
  assert.equal(both.priority, 100, 'demand plus a DMF is the top of the list');
});

test('demand can be matched on the name when the CAS differs', () => {
  const r = classifyRow(row({ cas: '51-21-8' }), { demandNames: new Set(['paracetamol']) });
  assert.equal(r.decision, 'list');
  assert.ok(r.priority >= 85);
});

// ── THE ONES THAT MUST NEVER LAND IN "LIST" ─────────────────────────────────

test('the GLP-1s are held, not listed', () => {
  for (const n of ['Semaglutide', 'Tirzepatide', 'Liraglutide', 'semaglutide acetate']) {
    const r = classifyRow(row({ name: n, cas: '910463-68-2', markers: ['GMP'] }));
    assert.equal(r.decision, 'hold', `${n} must be held`);
    assert.match(r.reason, /GLP-1/);
  }
});

// Demand and a DMF must not override the hold. A held molecule is held.
test('a restricted molecule stays held even with demand and a DMF', () => {
  const r = classifyRow(
    row({ name: 'Semaglutide', cas: '910463-68-2', markers: ['DMF'] }),
    { demandCas: new Set(['910463-68-2']) });
  assert.equal(r.decision, 'hold');
});

test('controlled substances and precursors are held', () => {
  for (const n of ['Fentanyl Citrate', 'Oxycodone HCl', 'Pseudoephedrine Sulphate', 'Ketamine']) {
    assert.equal(classifyRow(row({ name: n })).decision, 'hold', `${n} must be held`);
  }
});

test('cosmetic-grade peptides are held pending a decision about that market', () => {
  const r = classifyRow(row({ name: 'Acetyl Hexapeptide-8', line: 'cosmetic peptide list' }));
  assert.equal(r.decision, 'hold');
  assert.match(r.reason, /cosmetic/i);
});

// ── EXTRACTION UNCERTAINTY IS NOT HIDDEN ────────────────────────────────────

test('a row whose name came from a neighbouring line is held for checking', () => {
  const r = classifyRow(row({ confidence: 'low', name_source: 'line-1-above' }));
  assert.equal(r.decision, 'hold');
  assert.match(r.reason, /line-1-above|uncertain/);
});

test('a CAS with no readable name is rejected', () => {
  assert.equal(classifyRow(row({ name: null })).decision, 'reject');
});

test('a name with no CAS is held, not listed', () => {
  const r = classifyRow(row({ cas: null }));
  assert.equal(r.decision, 'hold');
  assert.match(r.reason, /CAS/);
});

// ── SORTING ─────────────────────────────────────────────────────────────────

test('classifyAll ranks what to read first and counts the outcomes', () => {
  const { rows, counts } = classifyAll([
    row({ name: 'Nothing Special', cas: '51-21-8' }),
    row({ name: 'Semaglutide', cas: '910463-68-2' }),
    row({ name: 'Paracetamol', cas: '103-90-2' }),
    row({ name: 'Ibuprofen', cas: '15687-27-1', markers: ['DMF'] }),
  ], { catalogueCas: new Set(['103-90-2']) });

  assert.equal(rows[0].name, 'Paracetamol', 'the second source leads');
  assert.equal(rows[0].decision, 'second_source');
  assert.equal(counts.second_source, 1);
  assert.equal(counts.hold, 1);
  assert.equal(counts.list, 2);
});

test('classifyAll copes with nothing', () => {
  assert.deepEqual(classifyAll([]).rows, []);
  assert.deepEqual(classifyAll(null).rows, []);
});

// ── A MISSING CAS IS NOT AN UNIDENTIFIED MOLECULE ───────────────────────────
//
// The first live run held all 158 molecules on Alivus's spreadsheet because it has no CAS column.
// "Apixaban" is not ambiguous. The test is whether the molecule was identified, not whether a CAS
// was printed.
test('a molecule identified by name is listable without a CAS', () => {
  const r = classifyRow(row({ cas: null, dictionary: true, confidence: 'medium', name_source: 'dictionary' }));
  assert.equal(r.decision, 'list');
  assert.match(r.reason, /no CAS on the document/);
});

test('a name matching nothing, with no CAS, is still held', () => {
  const r = classifyRow(row({ name: 'Unknown Thing 7', cas: null, dictionary: false }));
  assert.equal(r.decision, 'hold');
  assert.match(r.reason, /matches no molecule/);
});

// A name match is a weaker claim than a checksum, and the ranking should say so.
test('an identical row with a CAS outranks one identified by name alone', () => {
  const withCas = classifyRow(row({ markers: ['DMF'] }));
  const byName = classifyRow(row({ cas: null, dictionary: true, markers: ['DMF'] }));
  assert.ok(withCas.priority > byName.priority);
  assert.ok(byName.priority > 0);
});

test('the holds still hold when identified only by name', () => {
  const r = classifyRow(row({ name: 'Semaglutide', cas: null, dictionary: true }));
  assert.equal(r.decision, 'hold');
  assert.match(r.reason, /GLP-1/);
});
