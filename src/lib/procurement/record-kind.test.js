'use strict';
// Tests for the SAM.gov notice-type mapping (ruling 7 item 1).
//
// The mapping is pinned against the PUBLISHED ptype table at
// open.gsa.gov/api/get-opportunities-public-api/ (read 2026-11-05), because the map was written
// from memory and testing it against the documented labels found a typo: the key read
// 'dod- funded', with a space after the hyphen, so the real label never matched.
//
// It failed SAFE — an unrecognised type returns null and the caller sends it to review rather
// than defaulting — but it sent work to a human for no reason, and "safe" is not the same as
// "right". These tests exist so the next such drift is caught by a run rather than by someone
// wondering why the review queue is full of bundling notices.
//
// NOTE ON WHAT IS STILL UNVERIFIED: the documentation lists the ptype REQUEST codes and their
// labels, but never the `type` STRINGS the response carries. The labels below are the documented
// ones; the API may return different spellings. That is on VERIFY_ON_FIRST_CALL in sam-gov.js.

const assert = require('assert');
const { kindFromSamNoticeType, RECORD_KINDS, biddability } = require('./record-kind');

let pass = 0; let fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; } catch (e) { fail += 1; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

// Every ptype in the published table, with the kind it must map to.
const DOCUMENTED = [
  ['Justification (J&A)', 'historical_award'],          // u
  ['Pre solicitation', null],                            // p — see the spelling test below
  ['Presolicitation', 'forecast'],                       // p, the spelling we already carried
  ['Award Notice', 'historical_award'],                  // a
  ['Sources Sought', 'sources_sought'],                  // r
  ['Special Notice', 'rfi'],                             // s
  ['Solicitation', 'solicitation'],                      // o
  ['Sale of Surplus Property', 'rfi'],                   // g
  ['Combined Synopsis/Solicitation', 'solicitation'],    // k
  ['Intent to Bundle Requirements (DoD-Funded)', 'rfi'], // i
];

t('every documented notice type maps as expected', () => {
  for (const [label, want] of DOCUMENTED) {
    assert.strictEqual(kindFromSamNoticeType(label), want,
      `${JSON.stringify(label)} mapped to ${JSON.stringify(kindFromSamNoticeType(label))}, expected ${JSON.stringify(want)}`);
  }
});

t('the DoD-Funded label matches — this is the typo that was found', () => {
  assert.strictEqual(kindFromSamNoticeType('Intent to Bundle Requirements (DoD-Funded)'), 'rfi');
  // The old misspelling is kept in case a stored row was normalised with it.
  assert.strictEqual(kindFromSamNoticeType('Intent to Bundle Requirements (DoD- Funded)'), 'rfi');
});

t('both plausible Justification spellings map to historical_award', () => {
  assert.strictEqual(kindFromSamNoticeType('Justification (J&A)'), 'historical_award');
  assert.strictEqual(kindFromSamNoticeType('Justification'), 'historical_award');
  assert.strictEqual(kindFromSamNoticeType('Justification and Approval (J&A)'), 'historical_award');
});

t('RECORDED GAP: "Pre solicitation" (the documented spelling, with a space) does NOT map', () => {
  // The table spells code `p` as "Pre solicitation"; we carry "Presolicitation". Which one the
  // RESPONSE uses is undocumented. Rather than guess a second spelling into the map and claim
  // coverage, the gap is recorded here: it returns null, which sends the notice to review.
  //
  // Deliberately NOT "fixed" by adding the spelling — a presolicitation maps to `forecast`, and
  // mapping an unverified string to a kind that suppresses review is the wrong direction to guess
  // in. Confirm the real string, then add it.
  assert.strictEqual(kindFromSamNoticeType('Pre solicitation'), null,
    'if this now maps, the real spelling was confirmed and this test should record that instead');
});

t('matching ignores case and surrounding whitespace', () => {
  assert.strictEqual(kindFromSamNoticeType('  SOLICITATION  '), 'solicitation');
  assert.strictEqual(kindFromSamNoticeType('sources sought'), 'sources_sought');
});

t('an unrecognised type returns null and is NEVER defaulted', () => {
  // A default of `solicitation` would make every new notice type biddable, which is the failure
  // in the expensive direction: it spends a supplier quote and an approval on an impossibility.
  for (const junk of ['Totally New Notice Type', '', null, undefined, 'o', 'k', 'r', 42, {}]) {
    assert.strictEqual(kindFromSamNoticeType(junk), null, `${JSON.stringify(junk)} must not map`);
  }
});

t('the single-letter ptype CODES do not map — they are request filters, not response values', () => {
  // ptype is what you SEND. `type` is what comes back. Mapping 'o' to solicitation would mean a
  // stray code in a data feed silently became biddable.
  for (const code of ['u', 'p', 'a', 'r', 's', 'o', 'g', 'k', 'i']) {
    assert.strictEqual(kindFromSamNoticeType(code), null);
  }
});

t('exactly one mapped kind is biddable, and it is solicitation', () => {
  const kinds = new Set(DOCUMENTED.map(([, k]) => k).filter(Boolean));
  const biddable = [...kinds].filter((k) => RECORD_KINDS[k] && RECORD_KINDS[k].biddable);
  assert.deepStrictEqual(biddable, ['solicitation'],
    'if a second kind ever becomes biddable, that is a ruling, not a mapping change');
});

t('a mapped sources_sought is not biddable even with a perfect deadline', () => {
  // The category error must survive complete data: a sources-sought notice can never be bid
  // however well-formed the record is.
  const b = biddability({ recordKind: 'sources_sought', responseDeadline: '2027-01-01' });
  assert.strictEqual(b.biddable, false);
  assert.strictEqual(b.determinable, true, 'this is a category error, not a data gap');
});

console.log(`\nrecord-kind (SAM mapping): ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
