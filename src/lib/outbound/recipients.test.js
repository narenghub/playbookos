// ── THE FACT THE APPROVAL BOUNDARY IS KEYED ON ───────────────────────────────
//
//   node --test src/lib/outbound/recipients.test.js
//
// email-gate.js refuses any consequential send with an external recipient unless a released
// approval authorises those exact bytes. Everything therefore rests on getting "external" right,
// in both directions:
//
//   a false INTERNAL  → a commercial message reaches a stranger with no human decision behind it
//   a false EXTERNAL  → the 6pm scores, the briefings and the team tasks stop arriving
//
// The first is unrecoverable and the second is loud, which is why the unparseable case resolves
// to external. Both directions are tested; a classifier that answered "external" to everything
// would be safe and useless, and the internal cases are what stop this file shipping that.

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const R = require('./recipients');

const ENV = {}; // no override — the built-in company domains

test('company addresses are internal', () => {
  for (const to of ['naren@abiozen.com', 'NAREN@ABIOZEN.COM', '  sales@abiozen.com  ',
    'dev@adificetechnologies.com', 'hello@playnexa.ai']) {
    assert.strictEqual(R.isExternal(to, ENV), false, `${to} was treated as external`);
  }
});

test('anyone else is external', () => {
  for (const to of ['buyer@acme-pharma.test', 'purchase17@dideu.com', 'prof@yale.edu',
    'someone@abiozen.com.evil.test', 'x@notabiozen.com']) {
    assert.strictEqual(R.isExternal(to, ENV), true, `${to} was treated as internal`);
  }
});

test('a lookalike domain does not pass as internal', () => {
  // abiozen.com.evil.test ends with nothing useful; the check is on the FULL domain, not a suffix.
  const r = R.classifyRecipients('x@abiozen.com.evil.test', ENV);
  assert.deepStrictEqual(r.external, ['x@abiozen.com.evil.test']);
  assert.deepStrictEqual(r.internal, []);
});

test('the display-name form the mailer already uses is parsed', () => {
  assert.strictEqual(R.isExternal('Sarah Chen · Abiozen <sales@abiozen.com>', ENV), false);
  assert.strictEqual(R.isExternal('A Buyer <buyer@acme.test>', ENV), true);
});

test('arrays and comma-joined strings are both flattened', () => {
  const a = R.classifyRecipients(['naren@abiozen.com', 'buyer@acme.test'], ENV);
  const b = R.classifyRecipients('naren@abiozen.com, buyer@acme.test', ENV);
  assert.deepStrictEqual(a.external, ['buyer@acme.test']);
  assert.deepStrictEqual(b.external, ['buyer@acme.test']);
});

test('one external recipient makes the whole message external', () => {
  const r = R.classifyRecipients(['naren@abiozen.com', 'ops@abiozen.com', 'buyer@acme.test'], ENV);
  assert.strictEqual(r.allInternal, false);
  assert.strictEqual(r.internal.length, 2);
});

test('an unparseable address is external, not internal', () => {
  const r = R.classifyRecipients('not-an-address', ENV);
  assert.deepStrictEqual(r.unparseable, ['not-an-address']);
  assert.deepStrictEqual(r.external, ['not-an-address']);
  assert.strictEqual(r.allInternal, false);
});

test('an empty recipient list is NOT internal', () => {
  // A send with no recipient is not an internal send — it is one whose destination cannot be
  // established, and the safe reading of that asks a human rather than proceeding.
  for (const empty of [null, undefined, '', [], ['', '  ']]) {
    assert.strictEqual(R.classifyRecipients(empty, ENV).allInternal, false);
    assert.strictEqual(R.isExternal(empty, ENV), true);
  }
});

test('the domain list is configurable', () => {
  const env = { COMPANY_EMAIL_DOMAINS: 'example.test, @other.test' };
  assert.strictEqual(R.isExternal('a@example.test', env), false);
  assert.strictEqual(R.isExternal('b@other.test', env), false, 'a leading @ is tolerated');
  assert.strictEqual(R.isExternal('c@abiozen.com', env), true,
    'an override REPLACES the defaults rather than adding to them');
});

test('an empty override falls back instead of making everything internal', () => {
  // The one misconfiguration that would silently remove the boundary: an empty or whitespace
  // COMPANY_EMAIL_DOMAINS producing an empty set, under which every recipient is internal.
  for (const raw of ['', '   ', ',', ' , , ']) {
    const env = { COMPANY_EMAIL_DOMAINS: raw };
    assert.strictEqual(R.isExternal('buyer@acme.test', env), true,
      `COMPANY_EMAIL_DOMAINS=${JSON.stringify(raw)} made an outside address internal`);
    assert.strictEqual(R.isExternal('naren@abiozen.com', env), false,
      'the fallback should still recognise the real company domains');
  }
});

test('the default domains are exactly the three this platform uses', () => {
  // Pinned so that adding a domain is a deliberate act with a test change beside it.
  assert.deepStrictEqual([...R.DEFAULT_COMPANY_DOMAINS].sort(),
    ['abiozen.com', 'adificetechnologies.com', 'playnexa.ai']);
});
