// LabConnect regions.
//
//   node --test src/lib/labconnect/region.test.js
//
// The thing being protected is a lab filed in the wrong half of the country, or — worse — a lab
// with no usable address filed somewhere anyway. A wrong region sends an order to a lab that
// cannot take it, and nothing downstream can tell that the region was a guess.

const { test } = require('node:test');
const assert = require('node:assert');
const { regionFor, regionLabel, isRegion, stateFromAddress, US_ZONE, US_ZONES, EUROPE } =
  require('./region');

// ── the address parse ─────────────────────────────────────────────────────────

test('the state comes out of a real FDA address tail', () => {
  assert.equal(stateFromAddress('2810 Charles St, Rockford, IL 61108'), 'IL');
  assert.equal(stateFromAddress('1333 Barclay Blvd, Suite 1333, Buffalo Grove, IL 60089'), 'IL');
  assert.equal(stateFromAddress('100 Main Street, Cambridge, MA 02142-1234'), 'MA');
  // Lower case in, upper case out — the register is not consistent about case.
  assert.equal(stateFromAddress('500 e 7th st, austin, tx 78701'), 'TX');
});

test('a two-letter token that is NOT a state is not mistaken for one', () => {
  // THE REASON THE ZIP IS PART OF THE PATTERN. Street abbreviations are two letters followed by a
  // comma all over this dataset, and a looser regex files a lab by the nearest street suffix.
  assert.equal(stateFromAddress('123 N ST, Chicago, IL 60601'), 'IL', 'the real state still wins');
  assert.equal(stateFromAddress('Unit 4, Industrial Estate, Dublin, IE'), null, 'no ZIP, no state');
  // A six-digit postcode does not match: \d{5} must be followed by a comma or the end of string,
  // and India's PIN has one digit too many. I expected this to be a false positive and it is not.
  assert.equal(stateFromAddress('Plot 12, MIDC, Pune, MH 411019'), null);
});

test('a FIVE-digit foreign postcode does look like a US tail — which is why country is checked first', () => {
  // Germany's postcodes are five digits, so this address parses as the state "BE". The parser
  // cannot tell the difference and is not asked to: regionFor only reaches stateFromAddress when
  // country is 'USA'. This test exists so that guard is never removed as redundant.
  assert.equal(stateFromAddress('Musterstrasse 1, Berlin, BE 10115'), 'BE');
  assert.equal(regionFor({ country: 'DEU', address: 'Musterstrasse 1, Berlin, BE 10115' }).region,
    'eu_deu', 'the country decides, and the address is never consulted');
  assert.equal(regionFor({ country: 'DEU', address: 'Musterstrasse 1, Berlin, BE 10115' }).state,
    null, 'and no US state is attached to a German lab');
});

test('a missing or unparseable address yields null, never a guess', () => {
  for (const a of [null, undefined, '', '   ', 'No. 9 Jianguo Road, Beijing', 'PO Box 12']) {
    assert.equal(stateFromAddress(a), null, `${JSON.stringify(a)} must not produce a state`);
  }
});

// ── the region decision ──────────────────────────────────────────────────────

test('a US lab lands in its zone, with the state kept alongside', () => {
  const us = (address) => regionFor({ country: 'USA', address });
  assert.deepEqual(us('2810 Charles St, Rockford, IL 61108'),
    { region: 'us_central', state: 'IL', country: 'USA', country_inferred: false, reason: null });
  assert.deepEqual(us('1 Infinite Loop, Cupertino, CA 95014'),
    { region: 'us_pacific', state: 'CA', country: 'USA', country_inferred: false, reason: null });
  assert.deepEqual(us('100 Main St, Cambridge, MA 02142'),
    { region: 'us_east', state: 'MA', country: 'USA', country_inferred: false, reason: null });
  assert.deepEqual(us('4 Kachina Way, Santa Fe, NM 87501'),
    { region: 'us_mountain', state: 'NM', country: 'USA', country_inferred: false, reason: null });
});

test('A NULL COUNTRY FALLS THROUGH TO THE US ADDRESS — this is where the US labs were lost', () => {
  // THE BUG. `fda_establishments.country` is parsed from a trailing "(DEU)", which the FDA file
  // writes on FOREIGN addresses only. Every US establishment therefore has country NULL, and the
  // first version of regionFor refused on that — so the entire domestic directory, which is the
  // point of the product, landed in "region not determined":
  //
  //     (undetermined) region not determined        1,159
  //     row_ind        IND                            568
  //   … and no US row anywhere in the list.
  const r = regionFor({ country: null, address: '105 Church Rd, North Wales, PA 19454' });
  assert.equal(r.region, 'us_east');
  assert.equal(r.state, 'PA');
  assert.equal(r.country, 'USA', 'and the country is filled in, since the directory filters on it');
  assert.equal(r.country_inferred, true, 'flagged as inferred rather than passed off as parsed');
});

test('the inference needs a REAL US state, not just a US-shaped tail', () => {
  // The guard that makes the inference safe. German postcodes are five digits, so
  // "Berlin, BE 10115" satisfies stateFromAddress — and fails here because BE is not a state.
  // A foreign address that passed BOTH would have carried its own "(XXX)" and never reached this
  // branch at all.
  const r = regionFor({ country: null, address: 'Musterstrasse 1, Berlin, BE 10115' });
  assert.equal(r.region, null);
  assert.match(r.reason, /not a US state/);
  assert.equal(r.state, null, 'and no state is attached, since it is not one');
});

test('an explicit USA still works, and agrees with the inferred path', () => {
  const explicit = regionFor({ country: 'USA', address: '2810 Charles St, Rockford, IL 61108' });
  const inferred = regionFor({ country: null, address: '2810 Charles St, Rockford, IL 61108' });
  assert.equal(explicit.region, inferred.region);
  assert.equal(explicit.state, inferred.state);
  assert.equal(explicit.country_inferred, false, 'an explicit country is not an inference');
  assert.equal(inferred.country_inferred, true);
});

test('is_us_agent DOES NOT suppress the region — the earlier premise was wrong', () => {
  // It used to, on the grounds that "a US-agent row carries the AGENT'S address — a law office".
  // That is wrong about this dataset and the parser says so: isUsAgent reads
  // REGISTRANT_CONTACT_EMAIL, the agent's MAILBOX. The establishment's own address is in ADDRESS,
  // and the agent has a separate AGENT_DETAILS column. The flag describes who answers the email,
  // not where the laboratory is.
  //
  // It never bit, only because that branch was unreachable while every US row had a null country.
  const r = regionFor({ country: 'USA', address: '105 Church Rd, North Wales, PA 19454', is_us_agent: true });
  assert.equal(r.region, 'us_east', 'the lab is where its address says, whoever answers the email');
  assert.equal(r.state, 'PA');
});

test('an undetermined region is null and is NOT a bucket', () => {
  // A lab nobody can locate must not be filed anywhere. `region: null` is visible in the
  // directory under its own heading; a bucket called 'unknown' would quietly collect them and
  // then be routed to like any other region.
  assert.equal(regionFor({ country: null }).region, null);
  assert.equal(regionFor({}).region, null);
  assert.equal(regionFor({ country: 'USA', address: 'No. 9 Jianguo Road' }).region, null);
  assert.equal(regionFor({ country: 'USA', address: null }).region, null);
  assert.equal(regionFor({ country: null, address: 'No. 9 Jianguo Road, Beijing' }).region, null);
  // And each says WHY, because "no region" has several causes needing different fixes.
  assert.match(regionFor({ country: null }).reason, /no country and no US state/);
  assert.match(regionFor({ country: 'USA', address: 'nowhere' }).reason, /no state/);
});

test('Europe is bucketed by COUNTRY, not by a zone', () => {
  // A national regulator licenses each lab, so a German lab and a French lab are not
  // interchangeable the way Ohio and Pennsylvania are. Merging them into one "EU" region would
  // make the directory's filter useless the first time somebody needs an EU-GMP certificate.
  assert.deepEqual(regionFor({ country: 'DEU' }), { region: 'eu_deu', state: null, country: 'DEU', reason: null });
  assert.deepEqual(regionFor({ country: 'GBR' }), { region: 'eu_gbr', state: null, country: 'GBR', reason: null });
  assert.deepEqual(regionFor({ country: 'CHE' }), { region: 'eu_che', state: null, country: 'CHE', reason: null });
  for (const c of EUROPE) {
    assert.equal(regionFor({ country: c }).region, 'eu_' + c.toLowerCase(), `${c} must bucket by itself`);
  }
});

test('the rest of the world keeps its country instead of becoming one lump', () => {
  assert.equal(regionFor({ country: 'IND' }).region, 'row_ind');
  assert.equal(regionFor({ country: 'CHN' }).region, 'row_chn');
  assert.equal(regionFor({ country: 'CAN' }).region, 'row_can');
  assert.equal(regionFor({ country: 'JPN' }).region, 'row_jpn');
  // A 'rest of world' bucket is useless the first time somebody asks which country a lab is in.
  const regions = new Set(['IND', 'CHN', 'CAN', 'JPN'].map(c => regionFor({ country: c }).region));
  assert.equal(regions.size, 4, 'four countries must not collapse to one region');
});

test('country case and whitespace do not change the answer', () => {
  assert.equal(regionFor({ country: ' deu ' }).region, 'eu_deu');
  assert.equal(regionFor({ country: 'usa', address: '1 A St, Reno, NV 89501' }).region, 'us_pacific');
});

// ── the map itself ───────────────────────────────────────────────────────────

test('GUARD: every state and territory is mapped, and only to a real zone', () => {
  // A missing state silently produces region null, which looks like a bad address rather than a
  // gap in this file. So the 50 states, DC and the five territories are asserted present.
  const ALL = ('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE '
    + 'NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU AS MP').split(' ');
  assert.equal(ALL.length, 56, 'the list itself is wrong if this fails');
  for (const st of ALL) {
    assert.ok(US_ZONE[st], `${st} is not in US_ZONE — labs there would get no region`);
    assert.ok(US_ZONES.includes(US_ZONE[st]), `${st} maps to '${US_ZONE[st]}', which is not a zone`);
  }
  assert.equal(Object.keys(US_ZONE).length, 56, 'US_ZONE has entries that are not states');
});

test('all four zones are actually used', () => {
  // A map where everything lands in two zones is a map nobody finished.
  const used = new Set(Object.values(US_ZONE));
  for (const z of US_ZONES) assert.ok(used.has(z), `nothing maps to ${z}`);
});

// ── labels and validation ────────────────────────────────────────────────────

test('every region a lab can get has a label a person would read', () => {
  assert.equal(regionLabel('us_central'), 'US · Central');
  assert.equal(regionLabel('eu_deu'), 'EU · DEU');
  assert.equal(regionLabel('row_ind'), 'IND');
  assert.equal(regionLabel(null), 'region not determined');
  // No region key may render as its raw value — that is what a missing label looks like.
  for (const z of US_ZONES) assert.notEqual(regionLabel(z), z, `${z} has no label`);
});

test('isRegion rejects anything this module would not have produced', () => {
  for (const r of [...US_ZONES, 'eu_fra', 'row_chn']) assert.ok(isRegion(r), `${r} should be valid`);
  // A filter value arrives from a query string, so it is user input and gets validated rather
  // than interpolated.
  for (const r of ['', null, undefined, 'us_', 'eu_', 'eu_deutschland', 'US_EAST', 'unknown',
                   'row_in', "us_east' OR 1=1", 'eu_deu; DROP TABLE labs']) {
    assert.ok(!isRegion(r), `${JSON.stringify(r)} must be rejected`);
  }
});
