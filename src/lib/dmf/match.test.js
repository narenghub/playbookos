// Molecule -> DMF matching tests — run with:  node --test src/lib/dmf/match.test.js
// No network, no DB. Every fixture below is a real string pair from the 2Q2026 FDA file and
// the live study_molecules table.

const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeMolecule,
  annotationCandidates,
  isSaltFormOf,
  buildSubjectIndex,
  matchMolecule,
} = require('./match');

// A miniature DMF table. status/dmf_type are exercised deliberately.
const ROWS = [
  { dmf_number: 1, status: 'A', dmf_type: 'II', holder: 'ATUL BIOSCIENCE LTD', subject: 'FLUCONAZOLE' },
  { dmf_number: 2, status: 'A', dmf_type: 'II', holder: 'HENAN PURUI', subject: 'FLUCONAZOLE' },
  { dmf_number: 3, status: 'A', dmf_type: 'II', holder: 'DR REDDYS LABORATORIES LTD', subject: 'GEMCITABINE HYDROCHLORIDE' },
  { dmf_number: 4, status: 'A', dmf_type: 'II', holder: 'CF PHARMA LTD', subject: 'LEUCOVORIN CALCIUM' },
  { dmf_number: 5, status: 'A', dmf_type: 'II', holder: 'EXCELLA GMBH', subject: 'CAPECITABINE' },
  { dmf_number: 6, status: 'A', dmf_type: 'II', holder: 'J M HUBER MICROPOWDERS INC', subject: 'CALCIUM CARBONATE' },
  { dmf_number: 7, status: 'A', dmf_type: 'II', holder: 'SOME CHEM CO', subject: 'CALCIUM' },
  { dmf_number: 8, status: 'A', dmf_type: 'II', holder: 'IMAGING FIRM LLC', subject: 'DARATUMUMAB CONJUGATE INTERMEDIATE' },
  // Must never be reachable: inactive, and a packaging type.
  { dmf_number: 9, status: 'I', dmf_type: 'II', holder: 'DEFUNCT API CO', subject: 'IBUPROFEN' },
  { dmf_number: 10, status: 'A', dmf_type: 'III', holder: 'CARTON SUPPLIER SA', subject: 'IBUPROFEN' },
  { dmf_number: 11, status: 'A', dmf_type: 'IV', holder: 'EXCIPIENT CO', subject: 'LACTOSE MONOHYDRATE' },
];
const INDEX = buildSubjectIndex(ROWS);

test('scope: only ACTIVE TYPE II rows enter the index', () => {
  // 8 of the 11 fixtures are A/II.
  assert.equal(INDEX.considered, 8);
  // Ibuprofen exists twice - once inactive, once as packaging - and must not be matchable.
  assert.equal(matchMolecule('Ibuprofen', INDEX), null);
  // An excipient DMF must never surface as a drug substance.
  assert.equal(matchMolecule('Lactose monohydrate', INDEX), null);
});

test('tier exact: normalized equality, case and punctuation insensitive', () => {
  const m = matchMolecule('Fluconazole', INDEX);
  assert.equal(m.tier, 'exact');
  assert.deepEqual(m.dmfNumbers, [1, 2]);
  assert.deepEqual(m.holders, ['ATUL BIOSCIENCE LTD', 'HENAN PURUI']);
  // Same molecule, noisier input.
  assert.equal(matchMolecule('  FLUCONAZOLE  ', INDEX).tier, 'exact');
});

test('tier salt_form: registry files the salt, the trial names the base', () => {
  const m = matchMolecule('Gemcitabine', INDEX);
  assert.equal(m.tier, 'salt_form');
  assert.deepEqual(m.dmfNumbers, [3]);
  assert.equal(m.matchedSubject, 'gemcitabine hydrochloride');
});

test('salt_form does NOT swallow a different molecule that merely shares a prefix', () => {
  // "CALCIUM CARBONATE" starts with "CALCIUM", but carbonate is not a salt token, so
  // "Calcium" must resolve to its own exact row (7), never to the carbonate row (6).
  const m = matchMolecule('Calcium', INDEX);
  assert.equal(m.tier, 'exact');
  assert.deepEqual(m.dmfNumbers, [7]);
  assert.ok(!isSaltFormOf('calcium carbonate', 'calcium'));
  assert.ok(isSaltFormOf('gemcitabine hydrochloride', 'gemcitabine'));
  assert.ok(isSaltFormOf('leucovorin calcium', 'leucovorin'));
});

test('salt_form covers halides, fused di-/tri- spellings and numeric hydrates', () => {
  // Each of these matched only by substring (the untrustworthy `contained` tier) until the
  // halide and fused-prefix spellings were added to SALT_TOKENS.
  assert.ok(isSaltFormOf('elacestrant dihydrochloride', 'elacestrant'));
  assert.ok(isSaltFormOf('trospium chloride', 'trospium'));
  assert.ok(isSaltFormOf('fostamatinib disodium hexahydrate', 'fostamatinib'));
  assert.ok(isSaltFormOf('zinc sulfate 7 hydrate', 'zinc sulfate'));
  assert.ok(isSaltFormOf('magnesium chloride hexahydrate', 'magnesium chloride'));
});

test('salt_form tolerates grade qualifiers but still rejects a real second molecule', () => {
  assert.ok(isSaltFormOf('probenecid usp', 'probenecid'));
  assert.ok(isSaltFormOf('arginine sterile bulk', 'arginine'));
  assert.ok(isSaltFormOf('meperidine hydrochloride usp', 'meperidine hydrochloride'));
  // Still must not fire when the tail names a different substance.
  assert.ok(!isSaltFormOf('calcium carbonate', 'calcium'));
  assert.ok(!isSaltFormOf('89 zr daratumumab', 'daratumumab'));      // prefix, not suffix
  assert.ok(!isSaltFormOf('isavuconazole intermediate m8', 'isavuconazole'));
  assert.ok(!isSaltFormOf('nicotinamide adenine dinucleotide', 'nicotinamide'));
});

test('tier annotated: parenthetical synonym is the name the registry uses', () => {
  // The registry knows "LEUCOVORIN CALCIUM"; the trial record says "Folinic acid (leucovorin)".
  const m = matchMolecule('Folinic acid (leucovorin)', INDEX);
  assert.equal(m.tier, 'annotated');
  assert.deepEqual(m.dmfNumbers, [4]);
});

test('tier annotated: pharmacopoeia / reference-standard suffixes are stripped', () => {
  for (const name of [
    'Capecitabine USP/EP Reference Standard',
    'Capecitabine USP',
    'Capecitabine (reference standard)',
    'Capecitabine, sterile',
  ]) {
    const m = matchMolecule(name, INDEX);
    assert.ok(m, `no match for ${name}`);
    assert.equal(m.tier, 'annotated', name);
    assert.deepEqual(m.dmfNumbers, [5], name);
  }
});

test('tier annotated: bracketed isotope labels and free-base qualifiers', () => {
  assert.deepEqual(annotationCandidates('[1-13C]capecitabine')[0], 'capecitabine');
  const m = matchMolecule('Capecitabine (free base)', INDEX);
  assert.equal(m.tier, 'annotated');
  // "(free base)" is a qualifier, not an alternative name - it must not become a candidate.
  assert.ok(!annotationCandidates('Capecitabine (free base)').includes('free base'));
});

test('annotated never fires when the plain name already matched', () => {
  // Fluconazole matches exactly; the annotated tier must not downgrade it.
  assert.equal(matchMolecule('Fluconazole (antifungal)', INDEX).tier, 'annotated');
  assert.equal(matchMolecule('Fluconazole', INDEX).tier, 'exact');
});

test('tier contained: reproduces the known-spurious Daratumumab hit', () => {
  // This is the false positive that motivated reporting this tier separately. The test pins
  // the behaviour so it stays visible rather than silently changing.
  const m = matchMolecule('Daratumumab', INDEX);
  assert.equal(m.tier, 'contained');
  assert.deepEqual(m.holders, ['IMAGING FIRM LLC']);
});

test('contained is length-guarded so short names cannot spray', () => {
  // 6 characters or fewer never reaches the contained tier.
  assert.equal(matchMolecule('Sodium', INDEX), null);
  assert.equal(matchMolecule('Conjugate', INDEX).tier, 'contained'); // 9 chars, does reach it
});

test('unmatched molecules return null, never a guess', () => {
  assert.equal(matchMolecule('ABBV-291', INDEX), null);
  assert.equal(matchMolecule('LY4405094', INDEX), null);
  assert.equal(matchMolecule('', INDEX), null);
  assert.equal(matchMolecule(null, INDEX), null);
});

test('normalizeMolecule folds case, punctuation and whitespace only', () => {
  assert.equal(normalizeMolecule('Gemcitabine  HCl'), 'gemcitabine hcl');
  assert.equal(normalizeMolecule("2',2'-Difluorodeoxyuridine"), '2 2 difluorodeoxyuridine');
  // It must NOT drop tokens - the salt name is meaningful at this stage.
  assert.equal(normalizeMolecule('LEUCOVORIN CALCIUM'), 'leucovorin calcium');
});
