'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validCas, findCas } = require('./cas');

// Real CAS numbers for molecules that appear on these suppliers' lists.
test('validCas accepts real registry numbers', () => {
  for (const cas of [
    '50-78-2',        // aspirin
    '103-90-2',       // paracetamol
    '1115-70-4',      // metformin HCl
    '57-27-2',        // morphine
    '7732-18-5',      // water
    '910463-68-2',    // this one is 6+2+1 — long body
    '53-03-2',        // prednisone
    '154229-19-3',    // abiraterone
  ]) {
    assert.ok(validCas(cas), `${cas} should be valid`);
  }
});

// A single transposed or wrong digit must fail. This is the whole reason the checksum is used:
// a wrong CAS on a listing is a different molecule, not a typo.
test('validCas rejects a number with one digit wrong', () => {
  assert.ok(!validCas('50-78-3'), 'aspirin with a wrong check digit');
  assert.ok(!validCas('103-90-3'));
  assert.ok(!validCas('1115-70-5'));
  // Transposition inside the body changes the sum.
  assert.ok(!validCas('130-90-2'));
});

test('validCas rejects malformed input', () => {
  for (const bad of ['', null, undefined, 'abc', '1-2-3', '12345678-12-1', '50-7-2', '50-78-23']) {
    assert.ok(!validCas(bad), `${JSON.stringify(bad)} should be rejected`);
  }
});

test('findCas pulls every valid number out of a block of text', () => {
  const text = `
    1  Paracetamol        103-90-2    DMF
    2  Metformin HCl      1115-70-4   CEP
    3  Aspirin            50-78-2     GMP
  `;
  assert.deepEqual(findCas(text).map((x) => x.cas), ['103-90-2', '1115-70-4', '50-78-2']);
});

// ── THE FALSE POSITIVES THIS EXISTS TO STOP ─────────────────────────────────
//
// A supplier brochure is full of digit groups shaped like a CAS number. Shape-only matching on a
// 40-page document would invent dozens of products out of phone numbers and document codes.
test('findCas ignores digit groups that are not CAS numbers', () => {
  const text = `
    Tel: 86-21-5566  Fax: 86-21-5567
    Document ref 2026-10-19, revision 12-04-1
    DMF 31245-08-7 filed      ← shape matches but the checksum does not
  `;
  const hits = findCas(text).map((x) => x.cas);
  assert.ok(!hits.includes('86-21-5566'));
  assert.ok(!hits.includes('2026-10-19'));
  // Every surviving hit must genuinely validate.
  for (const h of hits) assert.ok(validCas(h), `${h} survived but is not a valid CAS`);
});

// Without boundary guards, a longer digit run yields a spurious match from its middle.
test('findCas does not match inside a longer digit run', () => {
  assert.deepEqual(findCas('order 12345678-90-12 shipped').map((x) => x.cas), []);
  assert.deepEqual(findCas('ref 999103-90-2').map((x) => x.cas), []);
});

test('findCas reports the position so a caller can read around it', () => {
  const text = 'Paracetamol 103-90-2 API';
  const [hit] = findCas(text);
  assert.equal(hit.cas, '103-90-2');
  assert.equal(text.slice(hit.index, hit.index + 8), '103-90-2');
});

test('findCas on empty or junk input returns nothing', () => {
  assert.deepEqual(findCas(''), []);
  assert.deepEqual(findCas(null), []);
  assert.deepEqual(findCas('no numbers here at all'), []);
});
