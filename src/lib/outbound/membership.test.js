// ── INTERNAL MEANS AN ACTIVE PERSON, NOT A FAMILIAR DOMAIN ──────────────────
//
//   node --test src/lib/outbound/membership.test.js
//
// The defect this closes, in one line: a departed employee's address is still on the company
// domain, so the domain-based classifier calls it internal, so it needs no approval, so mail
// reaches somebody who should no longer receive it. The only control broad enough to catch that
// was a capability-wide stop on email.send — which has refused 369 sends in 21 days and taken the
// daily briefings, the 8am task assignments, the coaching mail and every escalation with it.
//
// Every test here is paired with a control, because the failure mode of a stricter classifier is
// that it classifies EVERYTHING as external and nobody notices until internal mail stops too.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const M = require('./membership');

const ENV = { WORKSPACE_DOMAINS: 'abiozen.com', INTERNAL_MAILBOXES: 'sales@abiozen.com' };

/** A users table holding exactly these active addresses. */
function usersStub(activeEmails) {
  return async (sql, params) => {
    assert.match(sql, /FROM users WHERE is_active = 1/, 'membership must read ACTIVE users only');
    const wanted = params[0];
    return { rows: activeEmails
      .map((e) => e.toLowerCase())
      .filter((e) => wanted.includes(e))
      .map((email) => ({ email })) };
  };
}

const ACTIVE = ['naren@abiozen.com', 'prasanthi@adificetechnologies.com'];

// ── THE DEFECT ──────────────────────────────────────────────────────────────

test('DECISIVE: a departed employee on the company domain is EXTERNAL', async () => {
  const r = await M.classifyByMembership('palash@abiozen.com', ENV, { query: usersStub(ACTIVE) });
  assert.deepEqual(r.internal, []);
  assert.deepEqual(r.external, ['palash@abiozen.com']);
  assert.deepEqual(r.departedOrUnknown, ['palash@abiozen.com'],
    'and it is named as the look-internal-but-is-not class, not lumped in with outsiders');
  assert.equal(r.allInternal, false);
});

test('CONTROL: an ACTIVE employee on the company domain is INTERNAL', async () => {
  // Without this, the test above is satisfied by a classifier that externalises everyone — which
  // would leave the operating loop exactly as broken as the capability-wide stop leaves it.
  const r = await M.classifyByMembership('naren@abiozen.com', ENV, { query: usersStub(ACTIVE) });
  assert.deepEqual(r.internal, ['naren@abiozen.com']);
  assert.deepEqual(r.external, []);
  assert.equal(r.allInternal, true);
  assert.deepEqual(r.departedOrUnknown, []);
});

test('an active employee on ANOTHER company domain is internal — membership, not domain', async () => {
  // Prasanthi is @adificetechnologies.com, which is not in WORKSPACE_DOMAINS. She is an active
  // member, so she is internal. This is the point: the question is the person, not the domain.
  const r = await M.classifyByMembership('prasanthi@adificetechnologies.com', ENV,
    { query: usersStub(ACTIVE) });
  assert.deepEqual(r.internal, ['prasanthi@adificetechnologies.com']);
  assert.equal(r.allInternal, true);
  assert.deepEqual(r.departedOrUnknown, [], 'not on a company domain, so not that class');
});

// ── SHARED MAILBOXES ────────────────────────────────────────────────────────

test('an allowlisted shared mailbox is internal without a user row', async () => {
  const r = await M.classifyByMembership('sales@abiozen.com', ENV, { query: usersStub(ACTIVE) });
  assert.deepEqual(r.internal, ['sales@abiozen.com']);
  assert.equal(r.allInternal, true);
});

test('DECISIVE: a role-shaped address NOT on the allowlist is external', async () => {
  // "It looks like a role address" is a guess. support@ was never allowlisted, so it is external.
  const r = await M.classifyByMembership('support@abiozen.com', ENV, { query: usersStub(ACTIVE) });
  assert.deepEqual(r.external, ['support@abiozen.com']);
  assert.deepEqual(r.departedOrUnknown, ['support@abiozen.com']);
});

// ── MIXED AND MALFORMED ─────────────────────────────────────────────────────

test('DECISIVE: a mixed list is not internal — one outsider makes the whole send external', async () => {
  const r = await M.classifyByMembership(
    ['naren@abiozen.com', 'buyer@someclient.com'], ENV, { query: usersStub(ACTIVE) });
  assert.deepEqual(r.internal, ['naren@abiozen.com']);
  assert.deepEqual(r.external, ['buyer@someclient.com']);
  assert.equal(r.allInternal, false, 'a mixed send must require approval');
});

test('an unparseable address is external and reported', async () => {
  const r = await M.classifyByMembership(['not-an-address', 'naren@abiozen.com'], ENV,
    { query: usersStub(ACTIVE) });
  assert.deepEqual(r.unparseable, ['not-an-address']);
  assert.ok(r.external.includes('not-an-address'));
  assert.equal(r.allInternal, false);
});

test('an empty recipient list is NOT internal', async () => {
  // A send with no destination is not an internal send; it is a send whose destination cannot be
  // established, and the safe reading asks a human.
  const r = await M.classifyByMembership([], ENV, { query: usersStub(ACTIVE) });
  assert.equal(r.allInternal, false);
});

// ── FAIL CLOSED ─────────────────────────────────────────────────────────────

test('DECISIVE: when membership cannot be read, NOTHING is internal', async () => {
  const broken = async () => { throw new Error('connection refused'); };
  const r = await M.classifyByMembership('naren@abiozen.com', ENV, { query: broken });
  assert.equal(r.membershipUnknown, true);
  assert.deepEqual(r.internal, []);
  assert.deepEqual(r.external, ['naren@abiozen.com']);
  assert.equal(r.allInternal, false,
    'falling back to domain matching would silently restore the behaviour this replaces');
});

test('DECISIVE: activeMembers returns null on failure, never an empty set', async () => {
  // The distinction that keeps this fail-closed. [] means "asked, none are members"; null means
  // "could not ask". Collapsing them is how a fail-closed control becomes fail-open.
  const broken = async () => { throw new Error('nope'); };
  assert.equal(await M.activeMembers(['a@b.com'], { query: broken }), null);
  const none = await M.activeMembers(['nobody@abiozen.com'], { query: usersStub(ACTIVE) });
  assert.ok(none instanceof Set, 'a successful query with no hits is a Set, not null');
  assert.equal(none.size, 0);
});

test('an inactive user is not a member', async () => {
  // is_active = 0 is the departure record. The stub asserts the query filters on it; this asserts
  // the behaviour that filter produces.
  const r = await M.classifyByMembership('palash@abiozen.com', ENV,
    { query: usersStub(['naren@abiozen.com']) });   // palash absent from the active set
  assert.deepEqual(r.external, ['palash@abiozen.com']);
});

// ── CASE AND WHITESPACE ─────────────────────────────────────────────────────

test('membership is case-insensitive', async () => {
  const r = await M.classifyByMembership('NAREN@Abiozen.COM', ENV, { query: usersStub(ACTIVE) });
  assert.equal(r.allInternal, true, 'address case must not decide authorization');
});

test('the mailbox allowlist tolerates spacing and case', async () => {
  const env = { ...ENV, INTERNAL_MAILBOXES: '  Sales@Abiozen.com ,  ops@abiozen.com ' };
  const boxes = M.internalMailboxes(env);
  assert.ok(boxes.has('sales@abiozen.com'));
  assert.ok(boxes.has('ops@abiozen.com'));
  assert.equal(boxes.size, 2);
});

test('no allowlist configured means no shared mailbox is internal', async () => {
  const r = await M.classifyByMembership('sales@abiozen.com',
    { WORKSPACE_DOMAINS: 'abiozen.com' }, { query: usersStub(ACTIVE) });
  assert.deepEqual(r.external, ['sales@abiozen.com'], 'an absent allowlist grants nothing');
});
