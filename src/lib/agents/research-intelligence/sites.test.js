'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sitesOf, normalizeFacility, isAnonymised, stripSiteId } = require('./sites');

// ── ANONYMISED PLACEHOLDERS: KEPT AS DATA, EXCLUDED FROM INSTITUTION COUNTS ───
//
// Every string below is verbatim from the live data on 14 Oct. Without the flag, "Research Site"
// (1,836 rows) and "Novartis Investigative Site" (2,192) would top every institution league table.

test('sponsor placeholders are recognised, verbatim from production', () => {
  for (const s of [
    'Novartis Investigative Site', 'Research Site', 'Clinical Trial Site',
    'Akero Clinical Study Site', 'GSK Investigational Site', 'Clinical Site',
    'Kailera Clinical Site', 'Ascendis Pharma Investigational Site',
    'Alkermes Investigational Site', 'Clinical Study Site',
    'TG Therapeutics Investigational Trial Site', 'ADARx Clinical Site',
    'Cinical Study Site',   // the registry's own typo, 86 rows of it
  ]) {
    assert.strictEqual(isAnonymised(s), true, `"${s}" should be anonymised`);
  }
});

test('REAL institutions are not mistaken for placeholders', () => {
  // The expensive error in the other direction: flagging a real hospital hides its trials.
  for (const s of [
    'Oxford University Hospitals NHS Foundation Trust',
    'Churchill Hospital, Oxford University Hospitals NHS Foundation Trust',
    'Oxford Health NHS Foundation Trust (OHFT)',
    'Baptist Memorial Hospital and Cancer Center-Oxford',
    'Memorial Sloan Kettering Cancer Center',
    'National Institutes of Health Clinical Center',
    'Oxford Centre for Clinical Magnetic Resonance Research (Ocmr)',  // contains "Research"
    'Oxford University Hospitals NHS Foundation Trust - John Radcliffe Hospital',
    'GenesisCare - Oxford ( Site 2607)',
    'University of Oxford - The Kennedy Institute',
  ]) {
    assert.strictEqual(isAnonymised(s), false, `"${s}" is a real institution`);
  }
});

// ── PER-TRIAL SITE IDS INSIDE THE NAME ───────────────────────────────────────

test('a site identifier embedded in the name is stripped', () => {
  assert.strictEqual(stripSiteId('Oxford University Hospitals Nhs Foundation Trust /ID# 272486'),
    'Oxford University Hospitals Nhs Foundation Trust');
  assert.strictEqual(stripSiteId('GenesisCare - Oxford ( Site 2607)'), 'GenesisCare - Oxford');
  assert.strictEqual(stripSiteId('Some Clinic - Site 123'), 'Some Clinic');
  assert.strictEqual(stripSiteId('Some Clinic, Site 45'), 'Some Clinic');
  assert.strictEqual(stripSiteId('Mayo Clinic'), 'Mayo Clinic', 'a clean name is untouched');
});

// ── NORMALISATION: TEN OXFORD ROWS SHOULD NOT BE TEN INSTITUTIONS ────────────

test('the NHS trust spellings of one body collapse together', () => {
  const a = normalizeFacility('Oxford University Hospitals NHS Foundation Trust');
  const b = normalizeFacility('Oxford University Hospitals NHS Trust');
  const c = normalizeFacility('Oxford University Hospitals Nhs Foundation Trust /ID# 272486');
  const d = normalizeFacility('Oxford University Hospital NHS Trust');
  assert.strictEqual(a, b);
  assert.strictEqual(a, c);
  assert.strictEqual(a, d, 'singular/plural "Hospital(s)" is the same body');
});

test('legal suffixes and punctuation fold away', () => {
  assert.strictEqual(normalizeFacility('Avalyn Pharma Inc.'), normalizeFacility('Avalyn Pharma'));
  assert.strictEqual(normalizeFacility('Merit Medical Systems, Inc.'), normalizeFacility('Merit Medical Systems'));
  assert.strictEqual(normalizeFacility('Smith & Nephew'), normalizeFacility('Smith and Nephew'));
});

test('it does NOT merge a hospital into its parent trust', () => {
  // A real-world hierarchy decision, not a string operation. Guessing it would attribute one
  // hospital's trials to another, which is worse than leaving them separate and visible.
  assert.notStrictEqual(
    normalizeFacility('Churchill Hospital'),
    normalizeFacility('Oxford University Hospitals NHS Foundation Trust'));
  assert.notStrictEqual(
    normalizeFacility('University of Oxford'),
    normalizeFacility('Oxford University Hospitals NHS Foundation Trust'));
});

// ── PARSING A STORED RECORD ──────────────────────────────────────────────────

const study = (locations) => JSON.stringify({
  protocolSection: { contactsLocationsModule: { locations } },
});

test('sites are extracted with city, country and recruiting status', () => {
  const s = sitesOf(study([
    { facility: 'Oxford University Hospitals NHS Foundation Trust', city: 'Oxford',
      country: 'United Kingdom', status: 'RECRUITING', zip: 'OX3 9DU' },
    { facility: 'Novartis Investigative Site', city: 'Basel', country: 'Switzerland' },
  ]));
  assert.strictEqual(s.length, 2);
  assert.strictEqual(s[0].anonymised, false);
  assert.strictEqual(s[0].status, 'RECRUITING');
  assert.strictEqual(s[0].zip, 'OX3 9DU');
  assert.strictEqual(s[1].anonymised, true);
  assert.strictEqual(s[1].city, 'Basel');
});

test('an UNNAMED site is kept when it has a place', () => {
  // "a trial recruits in Oxford" is useful even with no hospital named — that IS the anonymised
  // case, and dropping it would understate activity exactly where industry trials run.
  const s = sitesOf(study([{ city: 'Oxford', country: 'United Kingdom' }]));
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].facility, null);
  assert.strictEqual(s[0].anonymised, true);
});

test('a row with no facility, city or country is dropped', () => {
  assert.strictEqual(sitesOf(study([{ status: 'RECRUITING' }])).length, 0);
});

test('malformed or absent raw_json yields an empty list, never a throw', () => {
  assert.deepStrictEqual(sitesOf('{"broken'), []);
  assert.deepStrictEqual(sitesOf(null), []);
  assert.deepStrictEqual(sitesOf(''), []);
  assert.deepStrictEqual(sitesOf('{}'), []);
});

test('the legacy snake_case module shape is read too', () => {
  const s = sitesOf(JSON.stringify({
    contacts_locations_module: { locations: [{ facility: 'Mayo Clinic', city: 'Rochester', country: 'United States' }] },
  }));
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].facility, 'Mayo Clinic');
});
