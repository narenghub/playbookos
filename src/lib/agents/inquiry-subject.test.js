// Inquiry subject-line tests — run with:  node --test src/lib/agents/inquiry-subject.test.js
// The contract: a buyer who never named a molecule must never receive a subject or body
// containing the word "null". 26 real sends went out as "Re: Inquiry — null | Abiozen LLC".

const { test } = require('node:test');
const assert = require('node:assert');
const { moleculeLabel, inquirySubject, moleculePhrase } = require('./inquiry-agent');

test('moleculeLabel treats null, blank and the string "null" as unknown', () => {
  assert.equal(moleculeLabel(null), null);
  assert.equal(moleculeLabel(undefined), null);
  assert.equal(moleculeLabel(''), null);
  assert.equal(moleculeLabel('   '), null);
  assert.equal(moleculeLabel('null'), null);
  assert.equal(moleculeLabel('NULL'), null);
  assert.equal(moleculeLabel('undefined'), null);
  assert.equal(moleculeLabel('  Metformin Hydrochloride  '), 'Metformin Hydrochloride');
});

test('real regression: a null molecule no longer yields "Re: Inquiry — null"', () => {
  const subject = inquirySubject({ molecule_name: null });
  assert.doesNotMatch(subject, /null/i);
  assert.equal(subject, 'Re: Your API Inquiry | Abiozen LLC');
});

test('a named molecule keeps the original subject format', () => {
  assert.equal(
    inquirySubject({ molecule_name: '4-Aminopyridine' }),
    'Re: Inquiry — 4-Aminopyridine | Abiozen LLC');
});

test('suffix:false drops the company tail (escalation path)', () => {
  assert.equal(inquirySubject({ molecule_name: 'Metformin Hydrochloride' }, { suffix: false }), 'Re: Inquiry — Metformin Hydrochloride');
  assert.equal(inquirySubject({ molecule_name: null }, { suffix: false }), 'Re: Your API Inquiry');
});

test('inquirySubject tolerates a missing/odd inquiry object', () => {
  for (const arg of [undefined, null, {}, { molecule_name: 0 }]) {
    assert.doesNotMatch(inquirySubject(arg), /null|undefined/i);
  }
});

test('moleculePhrase reads correctly inside body copy', () => {
  assert.equal(`your ${moleculePhrase(null)} requirement`, 'your API requirement');
  assert.equal(`your ${moleculePhrase('Metformin HCl')} requirement`, 'your Metformin HCl requirement');
});
