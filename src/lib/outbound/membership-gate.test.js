// ── THE GATE MUST SEE EVERY RECIPIENT, AND JUDGE THEM BY EMPLOYMENT ─────────
//
//   node --test src/lib/outbound/membership-gate.test.js
//
// Two defects found on 2026-11-24, both at the same call site, both of the same class — a gate
// that is real and is not the only road:
//
//   1. `cc` WAS NEVER CLASSIFIED. sendEmailDetailed accepted it, deliverAuthorized put it in the
//      provider payload as body.cc, and assertSendAllowed was called with `to` alone. An email to
//      a colleague with an outside address in cc passed the approval boundary and the cc'd party
//      received it unapproved. Live, not hypothetical: sitenex-phase3.routes.js:536 cc's a partner
//      address, procurement-rfq.js cc's `copyTo` on supplier RFQs.
//
//   2. INTERNAL MEANT A FAMILIAR DOMAIN, NOT AN EMPLOYED PERSON. A departed employee's address is
//      still on the company domain, so it classified as internal and needed no approval. That is
//      the containment reason that has had all company email stopped since 3 November, at a cost
//      of 369 refused sends in 21 days — the briefings, the 8am assignments, the coaching mail and
//      every escalation among them.
//
// Every test here is paired with a control, because the failure mode of a stricter gate is that it
// refuses EVERYTHING and the operating loop stays as broken as the capability-wide stop leaves it.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const GATE = require('../email-gate');

// COMPANY_EMAIL_DOMAINS is what recipients.js actually reads; an earlier draft set
// WORKSPACE_DOMAINS, which it does not, so these tests passed via DEFAULT_COMPANY_DOMAINS.
const ENV = { COMPANY_EMAIL_DOMAINS: 'abiozen.com,adificetechnologies.com',
  ALERT_EMAIL: 'alert@abiozen.com' };
const ACTIVE = ['naren@abiozen.com', 'prasanthi@adificetechnologies.com'];
const DIGEST = 'd'.repeat(32);
const APPROVED = { approvalId: 'ap-1', digest: DIGEST };

const noStops = { checkStopped: async () => null, recordRefusal: () => {} };
const globalStop = {
  checkStopped: async (_s, opts) => (opts && opts.consequential === false
    ? null
    : { scope_type: 'global', scope_key: null, reason: 'CEO hold' }),
  recordRefusal: () => {},
};

/** A users table holding exactly these active addresses, plus an optional approval record. */
function members(activeEmails, { approval = null, unreadable = false } = {}) {
  return {
    query: async (sql, params = []) => {
      if (/FROM users\s+WHERE is_active = 1/.test(sql)) {
        if (unreadable) throw new Error('connection refused');
        const wanted = params[0] || [];
        return { rows: activeEmails
          .map((e) => e.toLowerCase())
          .filter((e) => wanted.includes(e))
          .map((email) => ({ email })) };
      }
      if (/released_at, action_payload/i.test(sql)) {
        return { rows: approval ? [{ id: params[0], status: 'approved',
          released_at: new Date(), action_payload: { transport_digest: approval } }] : [] };
      }
      return { rows: [] };
    },
  };
}

const deps = (opts = {}) => ({ env: ENV, autonomy: opts.autonomy || noStops,
  ...members(opts.active || ACTIVE, opts) });

const send = (args, opts) => GATE.assertSendAllowed(
  { capability: 'email.send', workflow: 'w', agent: 'a', ...args }, deps(opts));

// ── DEFECT 1: cc IS A RECIPIENT ─────────────────────────────────────────────

test('DECISIVE: an external address in cc requires an approval', async () => {
  const g = await send({ to: 'naren@abiozen.com', cc: 'buyer@acme.test' });
  assert.strictEqual(g.allowed, false, 'an outside party in cc must not ride out on an internal to');
  assert.match(g.reason, /EXTERNAL_WITHOUT_APPROVAL/);
  assert.deepStrictEqual(g.external, ['buyer@acme.test']);
});

test('CONTROL: an internal cc is still allowed — the ordinary copy-the-CEO case', async () => {
  // Without this, the test above is satisfied by a gate that refuses every send carrying a cc,
  // which would break inquiry-agent.js:1167 (`cc: 'naren@abiozen.com'`) and the RFQ copy lists.
  const g = await send({ to: 'prasanthi@adificetechnologies.com', cc: 'naren@abiozen.com' });
  assert.strictEqual(g.allowed, true);
});

test('an external cc IS allowed once an approval covers these bytes', async () => {
  const g = await send({ to: 'naren@abiozen.com', cc: 'buyer@acme.test', ...APPROVED },
    { approval: DIGEST });
  assert.strictEqual(g.allowed, true, 'the boundary asks for a human decision, not for silence');
});

test('bcc is classified too, before mailer ever forwards it', async () => {
  // sendEmailDetailed does not destructure bcc today, so nothing reaches the provider that way.
  // Callers already pass it (procurement-rfq.js:637), so one parameter in mailer.js is all that
  // separates today's safe accident from a third unjudged channel. The gate reads it now.
  const g = await send({ to: 'naren@abiozen.com', bcc: 'buyer@acme.test' });
  assert.strictEqual(g.allowed, false);
  assert.deepStrictEqual(g.external, ['buyer@acme.test']);
});

test('a comma-joined cc string is split, not treated as one address', async () => {
  const g = await send({ to: 'naren@abiozen.com', cc: 'naren@abiozen.com, buyer@acme.test' });
  assert.strictEqual(g.allowed, false);
  assert.deepStrictEqual(g.external, ['buyer@acme.test']);
});

// ── DEFECT 2: INTERNAL MEANS EMPLOYED ───────────────────────────────────────

test('DECISIVE: a departed employee on the company domain is refused', async () => {
  const g = await send({ to: 'palash@abiozen.com' });
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.membershipRefusal, 'not_active_member');
  assert.match(g.reason, /not an active member/);
  assert.deepStrictEqual(g.addresses, ['palash@abiozen.com']);
});

test('DECISIVE: a released approval does NOT reinstate a deactivated employee', async () => {
  // CEO instruction 2026-11-24: "Departed employees must be denied internal operational
  // communications. Do not treat external approval as an automatic override of employee
  // deactivation." A departed address would otherwise be sendable exactly as any outside party is.
  const g = await send({ to: 'palash@abiozen.com', ...APPROVED }, { approval: DIGEST });
  assert.strictEqual(g.allowed, false, 'an approval must not function as a reinstatement');
  assert.strictEqual(g.membershipRefusal, 'not_active_member');
});

test('a departed address in cc is caught as well as in to', async () => {
  const g = await send({ to: 'naren@abiozen.com', cc: 'palash@abiozen.com' });
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.membershipRefusal, 'not_active_member');
});

test('CONTROL: an active employee is allowed, with no approval needed', async () => {
  const g = await send({ to: 'naren@abiozen.com' });
  assert.strictEqual(g.allowed, true, 'the briefings and scores must still go out');
});

test('CONTROL: an active employee on another company domain is internal', async () => {
  const g = await send({ to: 'prasanthi@adificetechnologies.com' });
  assert.strictEqual(g.allowed, true, 'membership decides, not the domain');
});

// ── FAIL CLOSED, AND THE HONESTY OF THE STATED CAUSE ────────────────────────

test('DECISIVE: an unreadable users table refuses an internal send', async () => {
  const g = await send({ to: 'naren@abiozen.com' }, { unreadable: true });
  assert.strictEqual(g.allowed, false,
    'falling back to domain matching would restore the behaviour this replaces');
  assert.match(g.reason, /EXTERNAL_WITHOUT_APPROVAL/);
});

test('DECISIVE: an outage must not be reported as a departure', async () => {
  // With membership unreadable EVERY company address lands in departedOrUnknown. An unguarded
  // branch would refuse all internal mail with the reason "a deactivated account" — naming a
  // departure that never happened and sending whoever reads the refusal looking for one.
  const g = await send({ to: 'naren@abiozen.com' }, { unreadable: true });
  assert.notStrictEqual(g.membershipRefusal, 'not_active_member');
  assert.doesNotMatch(g.reason, /deactivated|not an active member/);
});

test('DECISIVE: an outage does NOT revoke a decision already made by a human', async () => {
  // The first draft of this gate refused outright when membership was unreadable. That was worse
  // than no branch: it blocked a buyer email carrying a validly released approval for exactly
  // these bytes, over a database fault that could not have changed the answer. Fail closed means
  // refusing what cannot be established — not refusing what is established by other means.
  const g = await send({ to: 'buyer@acme.test', ...APPROVED },
    { unreadable: true, approval: DIGEST });
  assert.strictEqual(g.allowed, true);
});

// ── THE OBSERVABILITY EXEMPTION CANNOT CARRY A PASSENGER ────────────────────

test('DECISIVE: an alert with an external cc loses the exemption', async () => {
  const g = await GATE.assertSendAllowed(
    { capability: 'email.alert', to: 'alert@abiozen.com', cc: 'buyer@acme.test' },
    deps({ autonomy: globalStop }));
  assert.strictEqual(g.allowed, false,
    'an alert addressed partly outside the company is not an alert');
  assert.strictEqual(g.exempt, false);
});

test('CONTROL: an alert to the operator address keeps its exemption under a global stop', async () => {
  const g = await GATE.assertSendAllowed(
    { capability: 'email.alert', to: 'alert@abiozen.com' },
    deps({ autonomy: globalStop }));
  assert.strictEqual(g.allowed, true);
  assert.strictEqual(g.exempt, true);
});

// ── ORDER OF REFUSALS ───────────────────────────────────────────────────────

test('a kill switch outranks a membership refusal', async () => {
  // When both would refuse, "a CEO hold is in force" is the useful answer; a caller that fixed the
  // membership problem would still be stopped.
  const g = await send({ to: 'palash@abiozen.com' }, { autonomy: globalStop });
  assert.strictEqual(g.allowed, false);
  assert.match(g.reason, /STOPPED_BY_POLICY: global/);
});
