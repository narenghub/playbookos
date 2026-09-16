// Research-institution parser tests — node --test src/lib/institutions/parse.test.js
// Fixtures are real shapes from clinical_studies.raw_json.

const { test } = require('node:test');
const assert = require('node:assert');
const { facilityType, isPlaceholder, isIcp, normalizeName, locationsOf, collectInstitutions } =
  require('./parse');

const study = (locations, start_date) => ({
  start_date,
  raw_json: { protocolSection: { contactsLocationsModule: { locations } } },
});

test('the anonymised placeholders are rejected — they are the most common names in the data', () => {
  // "Research Site" alone appears against 813 studies, more than any real institution.
  for (const n of ['Research Site', 'GSK Investigational Site', 'Clinical Trial Site',
                   'Clinical Study Site', 'Site 1042', 'Site #12', 'Local Institution',
                   'Investigator Site', 'Recruiting Site', 'Kailera Clinical Site']) {
    assert.equal(isPlaceholder(n), true, `${n} must be treated as a placeholder`);
    assert.equal(isIcp(n), false);
  }
});

test('real institutions are not mistaken for placeholders', () => {
  for (const n of ['Memorial Sloan Kettering Cancer Center', 'Northwestern University',
                   'Duke University Medical Center', 'Charite Universitaetsmedizin Berlin',
                   'Institut Gustave Roussy', 'Ospedale San Raffaele']) {
    assert.equal(isPlaceholder(n), false, `${n} must NOT be a placeholder`);
    assert.equal(isIcp(n), true);
  }
});

test('facility type is ordered — a university cancer centre is a CANCER CENTRE', () => {
  // The buying unit, and it holds its own budget. Order matters more than the regexes.
  assert.equal(facilityType('University of Texas MD Anderson Cancer Center'), 'cancer_centre');
  assert.equal(facilityType('Northwestern University'), 'academic');
  assert.equal(facilityType('Duke University Medical Center'), 'academic'); // university wins over "medical cent"
  assert.equal(facilityType('Mercy Hospital'), 'hospital');
  assert.equal(facilityType('Institut Gustave Roussy'), 'institute');
  assert.equal(facilityType('Max Planck Institute'), 'institute');
  assert.equal(facilityType('Acme Widgets Ltd'), 'other');
});

test('non-English institution names classify', () => {
  assert.equal(facilityType('Universitätsklinikum Heidelberg'), 'academic');
  assert.equal(facilityType('Hôpital Saint-Louis'), 'hospital');
  assert.equal(facilityType('Ospedale San Raffaele'), 'hospital');
  assert.equal(facilityType('Universidad de Navarra'), 'academic');
});

test('normalizeName keeps the identity-bearing words, unlike the DMF matcher', () => {
  // "University" and "Hospital" ARE the identity here. Stripping them would fold
  // "Boston University" into "Boston Children's Hospital".
  assert.equal(normalizeName('Duke University Medical Center'), 'duke university medical center');
  assert.notEqual(normalizeName('Boston University'), normalizeName("Boston Children's Hospital"));
  assert.equal(normalizeName('Memorial Sloan-Kettering Cancer Center'),
               normalizeName('Memorial Sloan Kettering Cancer Center'));
});

test('locationsOf reads the module, and survives junk', () => {
  assert.equal(locationsOf(study([{ facility: 'X' }]).raw_json).length, 1);
  assert.equal(locationsOf('not json').length, 0);
  assert.equal(locationsOf(null).length, 0);
  assert.equal(locationsOf({}).length, 0);
  // a JSON string round-trips
  assert.equal(locationsOf(JSON.stringify(study([{ facility: 'X' }]).raw_json)).length, 1);
});

test('collectInstitutions dedupes across studies and counts them', () => {
  const s = [
    study([{ facility: 'Northwestern University', city: 'Chicago', country: 'United States' }], '2024-01-01'),
    study([{ facility: 'Northwestern University', city: 'Chicago', country: 'United States' }], '2025-06-01'),
    study([{ facility: 'Research Site', city: 'Nowhere', country: 'United States' }], '2025-06-01'),
  ];
  const m = collectInstitutions(s);
  assert.equal(m.size, 1, 'the placeholder must not create a row');
  const nw = m.get('northwestern university');
  assert.equal(nw.study_count, 2);
  assert.equal(nw.facility_type, 'academic');
  assert.equal(nw.first_seen.getUTCFullYear(), 2024);
  assert.equal(nw.last_seen.getUTCFullYear(), 2025);
});

test('the kept contact is the first one carrying an EMAIL, not merely the first', () => {
  // Sites list several patient-recruitment contacts and the first often has only a phone.
  const m = collectInstitutions([study([{
    facility: 'Duke University Medical Center', city: 'Durham', country: 'United States',
    contacts: [ { name: 'Phone Only', phone: '555' },
                { name: 'Jane Roe', email: 'jane.roe@duke.edu', phone: '556' },
                { name: 'Later Still', email: 'nope@duke.edu' } ],
  }])]);
  const d = m.get('duke university medical center');
  assert.equal(d.contact_email, 'jane.roe@duke.edu');
  assert.equal(d.contact_name, 'Jane Roe');
});

test('an institution with no contacts still yields a row, with nulls', () => {
  const m = collectInstitutions([study([{ facility: 'Mercy Hospital', city: 'Cedar Rapids', country: 'United States' }])]);
  const r = m.get('mercy hospital');
  assert.equal(r.contact_email, null);
  assert.equal(r.contact_name, null);
  assert.equal(r.facility_type, 'hospital');
});

test('icpOnly:false keeps everything, so the filter can be measured rather than assumed', () => {
  const s = [study([{ facility: 'Research Site' }, { facility: 'Acme Widgets Ltd' }])];
  assert.equal(collectInstitutions(s).size, 0);
  assert.equal(collectInstitutions(s, { icpOnly: false }).size, 2);
});

test('empty and malformed input never throws', () => {
  assert.equal(collectInstitutions([]).size, 0);
  assert.equal(collectInstitutions(null).size, 0);
  assert.equal(collectInstitutions([{ raw_json: null }]).size, 0);
  assert.equal(collectInstitutions([study([{ facility: '   ' }])]).size, 0);
});
