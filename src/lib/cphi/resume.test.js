const test = require('node:test');
const assert = require('node:assert');
const { newCandidates } = require('./resume');

const c = (k) => ({ holder_normalized: k, holder: k.toUpperCase() });

test('already-checked companies are skipped', () => {
  const out = newCandidates([c('a'), c('b'), c('d')], new Set(['b']), 10);
  assert.deepEqual(out.map(x => x.holder_normalized), ['a', 'd']);
});

test('two spellings of one company cost one lookup, not two', () => {
  // The real case: "LABORATORIOS FARMACEUTICOS ROVI S.A." and "Laboratorios Farmacéuticos Rovi, S.A."
  // are two rows in the register and one company to normalizeCompany, so a run wrote 120 and only 118
  // rows existed afterwards.
  const scope = [
    { holder: 'LABORATORIOS FARMACEUTICOS ROVI S.A.', holder_normalized: 'laboratorios farmaceuticos rovi' },
    { holder: 'Laboratorios Farmacéuticos Rovi, S.A.', holder_normalized: 'laboratorios farmaceuticos rovi' },
    c('other'),
  ];
  const out = newCandidates(scope, new Set(), 10);
  assert.equal(out.length, 2);
  // And the SURVIVOR is the first one, because the scope is ordered by how much each is worth checking.
  assert.equal(out[0].holder, 'LABORATORIOS FARMACEUTICOS ROVI S.A.');
});

test('the page is filled to the limit, not cut short by duplicates', () => {
  // The reason the caller over-fetches. If duplicates shortened the page, a partial run would look
  // like a finished list.
  const scope = [c('a'), c('a'), c('b'), c('b'), c('d'), c('e')];
  assert.equal(newCandidates(scope, new Set(), 4).length, 4);
});

test('the limit is respected exactly', () => {
  assert.equal(newCandidates([c('a'), c('b'), c('d')], new Set(), 2).length, 2);
  assert.equal(newCandidates([c('a')], new Set(), 0).length, 0);
});

test('an exhausted list returns nothing rather than repeating itself', () => {
  assert.deepEqual(newCandidates([c('a'), c('b')], new Set(['a', 'b']), 10), []);
});

test('a candidate with no fold is dropped, not re-checked forever', () => {
  // It could never be matched against `checked`, so it would come back on every single run.
  const out = newCandidates([{ holder: 'X', holder_normalized: '' }, c('a')], new Set(), 10);
  assert.deepEqual(out.map(x => x.holder_normalized), ['a']);
});

test('missing or empty inputs do not throw', () => {
  assert.deepEqual(newCandidates(null, new Set(), 5), []);
  assert.deepEqual(newCandidates([], new Set(), 5), []);
  assert.equal(newCandidates([c('a')], null, 5).length, 1);
});
