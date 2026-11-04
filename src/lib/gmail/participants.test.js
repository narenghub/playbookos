// ── A DEPARTED COLLEAGUE IS EVIDENCE, NOT A CONTACT TO ADD ──────────────────
//
//   node --test src/lib/gmail/participants.test.js
//
// The evidence probe's first live run printed:
//
//     2 participant(s) on a thread who are NOT in our contacts
//        Alivus: Rakesh Pratap Singh <Rakesh.Singh@alivus.com>
//        Alivus: Palash Das <palash@abiozen.com>
//
// Both true. The heading was the defect: it reads as a list of people to add, and the second entry
// is a departed employee on our own domain, surfaced only because a supplier forwarded a message
// addressed to him. His presence there is real provenance — it is WHY we hold the Alivus
// catalogue — and it must never be read as an action.
//
//     Palash may exist in HISTORY. He must not exist as LIVE AUTHORITY.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { classifyParticipant, splitParticipants, domainOf } = require('./participants');

const OURS = ['abiozen.com'];

test('an address on our own domain is never addable, roster or no roster', () => {
  const p = classifyParticipant({ email: 'palash@abiozen.com', ourDomains: OURS });
  assert.equal(p.internal, true);
  assert.equal(p.addable, false, 'a departed colleague must never be offered as a contact to add');
  assert.match(p.reason, /our own domain/);
});

test('deliberately NO roster lookup — that is the point', () => {
  // A roster can be stale, and a departed colleague is precisely the case where it will be. The
  // classification is a statement about the address, so it holds whether or not a users row exists,
  // is active, or was deleted yesterday.
  for (const e of ['palash@abiozen.com', 'someone.who.never.existed@abiozen.com',
    'sales@abiozen.com', 'no-reply@abiozen.com']) {
    assert.equal(classifyParticipant({ email: e, ourDomains: OURS }).addable, false, e);
  }
});

test('a supplier-side address is addable', () => {
  const p = classifyParticipant({ email: 'Rakesh.Singh@alivus.com', ourDomains: OURS });
  assert.equal(p.internal, false);
  assert.equal(p.addable, true);
  assert.equal(p.email, 'rakesh.singh@alivus.com', 'the address should be normalised for comparison');
});

test('the two groups are reported separately and keep their order', () => {
  const { external, internal } = splitParticipants([
    { name: 'Rakesh Pratap Singh', email: 'Rakesh.Singh@alivus.com' },
    { name: 'Palash Das', email: 'palash@abiozen.com' },
    { name: 'Chi Zhang', email: 'zhangchi@motifbiotech.com' },
  ], OURS);

  assert.deepEqual(external.map((p) => p.name), ['Rakesh Pratap Singh', 'Chi Zhang']);
  assert.deepEqual(internal.map((p) => p.name), ['Palash Das']);
  // The real risk is a departed address leaking into the list a human acts on.
  assert.ok(!external.some((p) => /abiozen\.com$/i.test(p.email)),
    'an internal address reached the candidates-to-add list');
});

test('a sibling company domain is EXTERNAL, and that is correct', () => {
  // adificetechnologies.com is a related company, not Abiozen. Treating it as internal here would
  // repeat the recipient-authority defect from 2 Nov in reverse: platform administrative authority
  // is not the same boundary as the Abiozen communication boundary.
  const p = classifyParticipant({ email: 'prasanthi@adificetechnologies.com', ourDomains: OURS });
  assert.equal(p.internal, false);
  assert.equal(p.addable, true, 'a different company is external, whatever its platform role');
});

test('a malformed or missing address is not addable and does not throw', () => {
  for (const e of [null, undefined, '', 'not-an-address', 'missing-domain@']) {
    const p = classifyParticipant({ email: e, ourDomains: OURS });
    assert.equal(p.addable, false, JSON.stringify(e));
  }
  assert.equal(domainOf('a@b.com'), 'b.com');
  assert.equal(domainOf('nope'), null);
});

test('with no domains configured, nothing is classified internal — and nothing is hidden', () => {
  // Fail in the direction that keeps evidence visible. A missing configuration must not silently
  // suppress a participant; it should over-report, which a human notices.
  const p = classifyParticipant({ email: 'palash@abiozen.com', ourDomains: [] });
  assert.equal(p.internal, false);
  assert.equal(p.addable, true);
});

test('an @-prefixed or mixed-case domain is accepted as configured', () => {
  for (const d of [['@abiozen.com'], ['ABIOZEN.COM'], ['Abiozen.com']]) {
    assert.equal(classifyParticipant({ email: 'Palash@Abiozen.com', ourDomains: d }).addable, false,
      JSON.stringify(d));
  }
});
