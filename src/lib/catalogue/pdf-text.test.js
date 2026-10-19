'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { joinItems } = require('./pdf-text');

// pdfjs text items, in the shape it actually emits them.
const it = (str, x, width, size = 9, y = 700) =>
  ({ str, width, height: size, transform: [size, 0, 0, size, x, y] });

// ── THE BUG THIS FILE EXISTS FOR ────────────────────────────────────────────
//
// The first version put a space between every pair of adjacent items, because separate items look
// like separate words. They are not: pdfjs splits a word wherever the font kerns. A live Reliance
// product list came back as "Product S tatus", "Co mmercialized" and — the damaging one —
// "205393 - 21 - 1", a CAS number broken apart, so the whole document reported zero products
// while appearing to parse cleanly.
test('a word split for kerning is put back together', () => {
  assert.deepEqual(joinItems([it('S', 50, 5), it('tatus', 55, 20)]), ['Status']);
  assert.deepEqual(joinItems([it('Co', 50, 10), it('mmercialized', 60, 60)]), ['Commercialized']);
});

test('a CAS number split across items keeps its digits together', () => {
  assert.deepEqual(
    joinItems([it('205393', 50, 30), it('-', 80, 3), it('21', 83, 10), it('-', 93, 3), it('1', 96, 5)]),
    ['205393-21-1']);
});

// pdfjs fills a column gap with a whitespace ITEM whose width spans it, which is why measuring
// the distance between consecutive items finds nothing.
test('a wide whitespace item becomes a column boundary', () => {
  assert.deepEqual(
    joinItems([it('1', 50, 5), it('  ', 55, 25), it('Temozolomide', 80, 60)]),
    ['1  Temozolomide']);
});

test('a narrow whitespace item is an ordinary space', () => {
  assert.deepEqual(
    joinItems([it('Metformin', 50, 45), it(' ', 95, 2.5), it('Hydrochloride', 98, 60)]),
    ['Metformin Hydrochloride']);
});

// Producers that emit no whitespace items leave a real gap instead.
test('a measurable gap with no whitespace item still separates words', () => {
  assert.deepEqual(joinItems([it('Metformin', 50, 45), it('Hydrochloride', 99, 60)]),
    ['Metformin Hydrochloride']);
  assert.deepEqual(joinItems([it('Paracetamol', 50, 55), it('103-90-2', 120, 40)]),
    ['Paracetamol  103-90-2']);
});

test('a vertical move starts a new line', () => {
  assert.deepEqual(
    joinItems([it('Aspirin', 50, 35, 9, 700), it('Ibuprofen', 50, 45, 9, 686)]),
    ['Aspirin', 'Ibuprofen']);
});

test('a small baseline shift is not a new line', () => {
  assert.deepEqual(joinItems([it('H', 50, 6, 9, 700), it('2', 56, 4, 6, 699)]), ['H2']);
});

test('empty input is handled', () => {
  assert.deepEqual(joinItems([]), []);
  assert.deepEqual(joinItems(null), []);
});
