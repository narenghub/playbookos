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
// Employment ANYWHERE in the group. The gate resolves this as well as company membership, because
// it is the only thing that separates a departed account from an active colleague at a sister
// company — and those get opposite answers: a hard refusal versus "external, approvable".
// Keep it consistent with EMPLOYED below: somebody employed at a company must appear here too.
const ACTIVE = ['naren@abiozen.com', 'prasanthi@adificetechnologies.com',
  'someone-else@adificetechnologies.com', 'shared@abiozen.com'];
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

// ── A TRUSTED COMPANY, AND A COMPANY-SCOPED MEMBERSHIP ACCESSOR ─────────────
//
// Since the gate became company-scoped, "internal" means an active member OF THIS COMPANY — so a
// test asserting an internal send must supply both a trusted company context and a membership
// accessor that answers for that company. Stubbing SQL is no longer the right level: the gate
// talks to identity/company-membership.js, so that is what is injected.
//
// The context comes from office/context.js's marked test door, not from a hand-built object: the
// gate requires a BRANDED context and refuses anything else, which is the point of requirement 7.
const CTX = require('../office/context');
const COMPANY = 'co-abiozen';
const trusted = (companyId = COMPANY) =>
  CTX.contextForTests__TEST_ONLY({ companyId, source: 'test' });

/** Membership scoped to one company: `byCompany` maps companyId → the addresses employed there. */
function companyMembers(byCompany, { unreadable = false } = {}) {
  return {
    UNKNOWN: null,
    activeMemberAddresses: async (addresses, { companyId } = {}) => {
      if (unreadable) return null;
      if (!companyId) return null;
      const here = (byCompany[companyId] || []).map((e) => e.toLowerCase());
      return new Set(addresses.map((a) => String(a).toLowerCase()).filter((a) => here.includes(a)));
    },
  };
}

const EMPLOYED = {
  [COMPANY]: ['naren@abiozen.com', 'prasanthi@adificetechnologies.com'],
  'co-adifice': ['someone-else@adificetechnologies.com'],
};

const deps = (opts = {}) => ({
  env: ENV,
  autonomy: opts.autonomy || noStops,
  membership: companyMembers(opts.employed || EMPLOYED, opts),
  ...members(opts.active || ACTIVE, opts),
});

const send = (args, opts = {}) => GATE.assertSendAllowed(
  { capability: 'email.send',
    workflow: 'w',
    agent: 'a',
    // A trusted context by default, because most of these tests are about recipients. The tests
    // that are specifically about an ABSENT or untrusted company pass companyContext explicitly.
    companyContext: 'companyContext' in opts ? opts.companyContext : trusted(),
    ...args },
  deps(opts));

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

// ── COMPANY SCOPE: AN EMPLOYEE OF ANOTHER COMPANY IS NOT INTERNAL HERE ──────
//
// Owner requirement 6: "Shared employees operate only within their assigned company scopes." The
// classifier previously asked "is this an active employee" with no company at all, so an active
// employee of Adifice counted as internal to a send ABIOZEN was making — which is the
// cross-tenant leak B7.8 exists to close, arriving through the email path.

test('DECISIVE: an active employee of ANOTHER company is external to this company\'s send', async () => {
  const g = await send({ to: 'someone-else@adificetechnologies.com' });
  assert.strictEqual(g.allowed, false, 'employment elsewhere is not internal here');
  assert.match(g.reason, /EXTERNAL_WITHOUT_APPROVAL/);
  assert.deepStrictEqual(g.external, ['someone-else@adificetechnologies.com']);
});

test('CONTROL: that same person IS internal when the send is made for THEIR company', async () => {
  // Without this, the test above is satisfied by a gate that treats everybody as external — which
  // would leave the operating loop as broken as the capability-wide stop leaves it.
  const g = await send(
    { to: 'someone-else@adificetechnologies.com' },
    { companyContext: CTX.contextForTests__TEST_ONLY({ companyId: 'co-adifice' }) });
  assert.strictEqual(g.allowed, true);
});

test('a shared employee is internal to BOTH companies that employ them', async () => {
  const employed = {
    [COMPANY]: ['shared@abiozen.com'],
    'co-adifice': ['shared@abiozen.com'],
  };
  for (const companyId of [COMPANY, 'co-adifice']) {
    const g = await send({ to: 'shared@abiozen.com' },
      { employed, companyContext: CTX.contextForTests__TEST_ONLY({ companyId }) });
    assert.strictEqual(g.allowed, true, `${companyId} employs them, so they are internal there`);
  }
});

// ── NO TRUSTED COMPANY MEANS NOTHING IS INTERNAL ────────────────────────────

test('DECISIVE: with NO company context, an internal-looking send still needs an approval', async () => {
  // This is the fail-closed half, and it is what an unmapped cron hits. It must refuse loudly
  // rather than send as whichever company it happened to name.
  const g = await send({ to: 'naren@abiozen.com' }, { companyContext: null });
  assert.strictEqual(g.allowed, false);
  assert.match(g.reason, /EXTERNAL_WITHOUT_APPROVAL/);
});

test('DECISIVE: a FORGED company context is not trusted, so nothing is internal', async () => {
  // A frozen object with the right companyId is exactly what a caller wanting to send as another
  // company would construct. It is not a resolved context, so it buys nothing.
  const g = await send({ to: 'naren@abiozen.com' },
    { companyContext: Object.freeze({ companyId: COMPANY }) });
  assert.strictEqual(g.allowed, false, 'provenance, not shape, decides whether a company is known');
});

test('the legacy `company` STRING does not make anybody internal either', async () => {
  // dispatch.js has always accepted a caller-supplied `company` string. It still scopes STOPs,
  // which is what it was for — but it cannot establish who is internal.
  const g = await GATE.assertSendAllowed(
    { capability: 'email.send', workflow: 'w', agent: 'a', company: COMPANY,
      to: 'naren@abiozen.com' },
    deps());
  assert.strictEqual(g.allowed, false,
    'a company named by the caller is not a company the system has established');
});

test('a departed colleague is STILL refused when no company is established', async () => {
  // The departed refusal is about the PERSON, not the tenancy, so it must not be lost on the
  // no-trusted-company path — otherwise the fix for one hole opens the other.
  const g = await send({ to: 'palash@abiozen.com' }, { companyContext: null });
  assert.strictEqual(g.allowed, false);
  assert.ok(/not an active member|EXTERNAL_WITHOUT_APPROVAL/.test(g.reason),
    `refused for a stated reason, got: ${g.reason}`);
});

test('an unreadable membership table refuses even with a trusted company', async () => {
  const g = await send({ to: 'naren@abiozen.com' }, { unreadable: true });
  assert.strictEqual(g.allowed, false,
    'unknowable membership is not an empty one, company context notwithstanding');
});
