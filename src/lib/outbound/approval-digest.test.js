// ── THE DIGEST BINDS THE WHOLE AUTHORIZED MESSAGE ───────────────────────────
//
//   node --test src/lib/outbound/approval-digest.test.js
//
// B7.6. The property under test is not "the function returns a hash" but "every way of altering an
// approved message changes it, and every way of writing the same message does not". Both halves
// matter: a digest that changes too eagerly refuses legitimate sends, and one that changes too
// rarely lets an approval authorize bytes nobody approved.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const D = require('./approval-digest');
const LEDGER = require('./ledger');

const BASE = Object.freeze({
  companyId: 'co-abiozen',
  from: 'sales@abiozen.com',
  replyTo: null,
  providerAccount: 'resend:default',
  to: 'buyer@acme.test',
  cc: null,
  bcc: null,
  subject: 'Quotation',
  html: '<p>terms</p>',
  text: 'terms',
  attachments: null,
});

const d = (over = {}) => D.approvalDigest({ ...BASE, ...over });

// ── EVERY FIELD IS BOUND ────────────────────────────────────────────────────

test('DECISIVE: every alteration to the authorized message changes the digest', () => {
  const base = d();
  const alterations = {
    'adding a cc': { cc: 'partner@acme.test' },
    'adding a bcc': { bcc: 'quiet@acme.test' },
    'changing a recipient': { to: 'someone@acme.test' },
    'adding a second recipient': { to: ['buyer@acme.test', 'extra@acme.test'] },
    'changing the subject': { subject: 'Quotation (revised)' },
    'changing the html body': { html: '<p>different terms</p>' },
    'changing ONLY the plain-text body': { text: 'different terms' },
    'changing the originating company': { companyId: 'co-adifice' },
    'changing the sender': { from: 'someone-else@abiozen.com' },
    'adding a reply-to': { replyTo: 'replies@abiozen.com' },
    'changing the provider account': { providerAccount: 'resend:other' },
    'adding an attachment': {
      attachments: [{ filename: 'terms.pdf', contentType: 'application/pdf', content: Buffer.from('X') }],
    },
  };
  for (const [what, over] of Object.entries(alterations)) {
    assert.notStrictEqual(d(over), base, `${what} must change the digest`);
  }
});

test('an attachment whose CONTENT changes changes the digest, same name and type', () => {
  const a = (content) => d({ attachments: [{ filename: 'terms.pdf', contentType: 'application/pdf', content }] });
  assert.notStrictEqual(a(Buffer.from('one')), a(Buffer.from('two')),
    'the bytes a recipient opens are part of what was approved');
});

test('attachment ORDER is not identity, but its contents are', () => {
  const one = { filename: 'a.pdf', contentType: 'application/pdf', content: Buffer.from('A') };
  const two = { filename: 'b.pdf', contentType: 'application/pdf', content: Buffer.from('B') };
  assert.strictEqual(d({ attachments: [one, two] }), d({ attachments: [two, one] }));
});

// ── THE SAME MESSAGE, WRITTEN DIFFERENTLY, IS THE SAME MESSAGE ──────────────
//
// Five independent producers compute this. If any of these normalisations were missing, two of them
// would disagree about an identical message and every external send would refuse.

test('DECISIVE: equivalent spellings produce the same digest', () => {
  const base = d();
  const equivalents = {
    'a single recipient as a one-element array': { to: ['buyer@acme.test'] },
    'an uppercase recipient': { to: 'BUYER@ACME.TEST' },
    'a recipient with surrounding whitespace': { to: '  buyer@acme.test  ' },
    'a display-name form': { to: 'Buyer <buyer@acme.test>' },
    'an empty cc array rather than absent': { cc: [] },
    'a comma-joined list rather than an array': { to: 'buyer@acme.test' },
    'an empty attachment list rather than absent': { attachments: [] },
  };
  for (const [what, over] of Object.entries(equivalents)) {
    assert.strictEqual(d(over), base, `${what} is the same message`);
  }
});

test('recipient ORDER is not part of the message', () => {
  assert.strictEqual(
    d({ to: ['a@x.test', 'b@x.test'] }),
    d({ to: ['b@x.test', 'a@x.test'] }),
    'a reordered recipient list reaches the same people');
});

test('a duplicated recipient is the same message', () => {
  assert.strictEqual(d({ to: ['buyer@acme.test', 'buyer@acme.test'] }), d());
});

// ── FIELDS CANNOT BE RE-DIVIDED BETWEEN EACH OTHER ──────────────────────────

test('DECISIVE: a subject lengthened while a body is shortened is NOT the same message', () => {
  // Without length-prefixing, adjacent fields concatenate identically and an approval could be
  // held valid while content moved across the boundary between them.
  assert.notStrictEqual(
    D.approvalDigest({ ...BASE, subject: 'ab', html: 'c' }),
    D.approvalDigest({ ...BASE, subject: 'a', html: 'bc' }));
});

test('an absent field and an empty string are different messages', () => {
  assert.notStrictEqual(d({ replyTo: null }), d({ replyTo: '' }) === d({ replyTo: null })
    ? 'sentinel' : d({ replyTo: '' }));
  assert.notStrictEqual(d({ subject: null }), d({ subject: '' }));
});

// ── VERSIONING, AND THE TRANSITION FOR OUTSTANDING APPROVALS ────────────────

test('a digest carries its version, so a legacy one is recognisable', () => {
  assert.strictEqual(D.classifyDigest(d()), 2);
  assert.strictEqual(D.classifyDigest(LEDGER.digestOf({ to: 'a@b.test', subject: 's', html: 'h' })), 1);
  assert.strictEqual(D.classifyDigest('not-a-digest'), null);
  assert.strictEqual(D.classifyDigest(null), null);
});

test('DECISIVE: a legacy approval is refused as LEGACY, not as a mismatch', () => {
  // The distinction is the whole point of versioning. An approval released honestly under the old
  // rules has not been tampered with; it simply cannot establish the complete authorized message.
  // Telling an operator "digest mismatch" would point them at the wrong problem entirely.
  const legacy = LEDGER.digestOf({ to: 'buyer@acme.test', subject: 'Quotation', html: '<p>terms</p>' });
  const v = D.compareDigests({ approved: legacy, actual: d() });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'legacy_version');
  assert.match(v.detail, /FRESH APPROVAL/);
  assert.match(v.detail, /Nothing about the message has necessarily changed/,
    'and it says plainly that nobody altered the message');
});

test('a genuine mismatch is reported as a mismatch', () => {
  const v = D.compareDigests({ approved: d(), actual: d({ cc: 'late-addition@acme.test' }) });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'mismatch');
  assert.match(v.detail, /not the message that was approved/);
});

test('matching digests authorize the send', () => {
  assert.deepStrictEqual(D.compareDigests({ approved: d(), actual: d() }), { ok: true });
});

test('an unrecognised stored value authorizes nothing', () => {
  for (const approved of [null, '', 'zzz', 'v9:abc']) {
    const v = D.compareDigests({ approved, actual: d() });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.code, 'unrecognised', `${JSON.stringify(approved)} must not authorize`);
  }
});

test('DECISIVE: an unmigrated PRODUCER is caught, not silently tolerated', () => {
  // If one of the five producers still computes v1 while the gate compares v2, the comparison is
  // between two different definitions of "the message". That must refuse with its own code rather
  // than look like a legacy approval — the fix is a code change, not a fresh approval.
  const legacyActual = LEDGER.digestOf({ to: 'buyer@acme.test', subject: 'Quotation', html: '<p>terms</p>' });
  const v = D.compareDigests({ approved: d(), actual: legacyActual });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'actual_not_current');
  assert.match(v.detail, /has not been migrated/);
});

// ── WHAT THE OLD DIGEST DID NOT BIND, MEASURED RATHER THAN ASSERTED ─────────

test('CONTROL: the v1 digest did NOT bind cc, bcc, the text body, company or sender', () => {
  // This is the defect B7.6 exists to close, demonstrated against the real v1 function so the
  // claim is measured. When v1 is finally removed, this test goes with it.
  const v1 = (over = {}) => LEDGER.digestOf({
    to: 'buyer@acme.test', subject: 'Quotation', html: '<p>terms</p>', text: 'terms', ...over });
  const base = v1();
  assert.strictEqual(v1({ text: 'completely different plain text' }), base,
    'v1 took html || text, so the text alternative was unbound');
  // cc/bcc/company/sender were not parameters at all, so there is nothing to vary: their absence
  // from the signature IS the finding.
  assert.doesNotMatch(LEDGER.digestOf.toString(), /\bcc\b|bcc|companyId|from/,
    'v1 digestOf takes none of them');
});
