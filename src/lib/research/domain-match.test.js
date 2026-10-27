// Does this address belong to that institution?
//
// The error worth catching is a plausible person attached to the wrong organisation, because that
// produces a confident, personalised email to a stranger — which discredits the channel faster
// than a bounce does.
//
// Every pairing below is real, from the 25 mailable contacts ingested on 26 October.
'use strict';

const assert = require('assert');
const { domainMatchesInstitution } = require('./domain-match');

let pass = 0; const fails = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const REAL = [
  ['scott.miller@yale.edu', 'YALE UNIVERSITY'],
  ['jonathan.ellman@yale.edu', 'Yale University'],
  ['nilay.hazari@yale.edu', 'Yale University New Haven CT'],
  ['stahl@chem.wisc.edu', 'UNIVERSITY OF WISCONSIN-MADISON'],      // subdomain
  ['dweix@wisc.edu', 'University of Wisconsin-Madison'],
  ['sdenmark@illinois.edu', 'UNIVERSITY OF ILLINOIS AT URBANA'],
  ['nicewicz@email.unc.edu', 'UNIV OF NORTH CAROLINA CHAPEL HILL'], // initials, subdomain
  ['nagorny@umich.edu', 'UNIVERSITY OF MICHIGAN AT ANN ARBOR'],     // u + truncated word
  ['michal.szostak@rutgers.edu', 'RUTGERS THE STATE UNIV OF NJ NEW'],
  ['hrenata@rice.edu', 'RICE UNIVERSITY'],
  ['bpaegel@uci.edu', 'UNIVERSITY OF CALIFORNIA-IRVINE'],           // initials
  ['porco@bu.edu', 'BOSTON UNIVERSITY (CHARLES RIVER'],             // two-letter initials
  ['mrivera@lsu.edu', 'LOUISIANA STATE UNIV A&M COL BATON ROUGE'],
  ['scastle@chem.byu.edu', 'BRIGHAM YOUNG UNIVERSITY'],
  ['nicholas.ball@pomona.edu', 'POMONA COLLEGE'],
  ['seiya.kitamura@einsteinmed.edu', 'ALBERT EINSTEIN COLLEGE OF MEDIC'],
  ['rudi.fasan@utdallas.edu', 'UNIVERSITY OF TEXAS DALLAS'],
  ['oleg.larionov@utsa.edu', 'UNIVERSITY OF TEXAS SAN ANTONIO'],
  ['tian.qin@utsouthwestern.edu', 'UT SOUTHWESTERN MEDICAL CENTER'],
  ['vetticatt@binghamton.edu', 'STATE UNIVERSITY OF NY,BINGHAMTON'],
];

t('every real pairing is recognised as a match', () => {
  // The first version dropped "University" before taking initials, so UNC became NCHH and eight
  // of twenty-five real addresses were reported as wrong. A false mismatch in this column teaches
  // the reader to ignore the column, which is worse than not having it.
  const bad = REAL.filter(([e, i]) => domainMatchesInstitution(e, i).verdict !== 'match');
  assert.strictEqual(bad.length, 0,
    `not matched:\n${bad.map(([e, i]) => `  ${e}  ←  ${i}`).join('\n')}`);
});

t('a brand acronym nobody can derive is "unverified", not "wrong"', () => {
  // umn.edu and umd.edu ARE the right institutions. No algorithm gets there from "University of
  // Minnesota". Calling them wrong beside a genuine error destroys the signal.
  for (const [e, i] of [['itonks@umn.edu', 'UNIVERSITY OF MINNESOTA'],
    ['lisaacs@umd.edu', 'UNIV OF MARYLAND, COLLEGE PARK']]) {
    assert.strictEqual(domainMatchesInstitution(e, i).verdict, 'unverified', `${e} ← ${i}`);
  }
});

t('a non-academic domain with no link is a mismatch', () => {
  // The real one: a search for Scott Miller at Yale matched sophie.miller@sahmri.com.
  assert.strictEqual(domainMatchesInstitution('sophie.miller@sahmri.com', 'YALE UNIVERSITY').verdict, 'mismatch');
  assert.strictEqual(domainMatchesInstitution('x@randomcorp.com', 'POMONA COLLEGE').verdict, 'mismatch');
});

t('a public mail provider is its own category', () => {
  // Plenty of real academics use one. It is not evidence either way, so it must not be counted as
  // a match or as an error.
  for (const d of ['gmail.com', 'yahoo.com', 'outlook.com', 'qq.com']) {
    assert.strictEqual(domainMatchesInstitution(`prof@${d}`, 'YALE UNIVERSITY').verdict, 'freemail');
  }
});

t('a missing institution is unknown, not a mismatch', () => {
  // An absent name is a gap in our data, not evidence against the address.
  assert.strictEqual(domainMatchesInstitution('a@yale.edu', '').verdict, 'unknown');
  assert.strictEqual(domainMatchesInstitution('a@yale.edu', null).verdict, 'unknown');
});

t('a malformed address is unknown', () => {
  for (const e of ['', 'not-an-address', '@yale.edu', null]) {
    assert.strictEqual(domainMatchesInstitution(e, 'YALE UNIVERSITY').verdict, 'unknown', String(e));
  }
});

t('one institution does not match another institution\'s domain', () => {
  // The cross-check that matters: yale.edu must not read as a match for Wisconsin. It lands in
  // "unverified" here, and the audit upgrades it to a mismatch by noticing the domain belongs to
  // a different institution in the same table.
  assert.notStrictEqual(
    domainMatchesInstitution('edward.miller@yale.edu', 'UNIVERSITY OF WISCONSIN-MADISON').verdict,
    'match');
  assert.notStrictEqual(
    domainMatchesInstitution('a@pomona.edu', 'RICE UNIVERSITY').verdict, 'match');
  assert.notStrictEqual(
    domainMatchesInstitution('a@byu.edu', 'YALE UNIVERSITY').verdict, 'match');
});

if (fails.length) {
  console.error(`FAIL  ${fails.length} of ${pass + fails.length}`);
  for (const f of fails) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`ok  domain match — ${pass} passed`);
