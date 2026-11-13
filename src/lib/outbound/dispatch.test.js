// ── CAN ANYTHING GET PAST dispatch()? ────────────────────────────────────────
//
//   node --test src/lib/outbound/dispatch.test.js
//
// Spec A milestone 5. Adversarial: every test tries to reach the provider by a different road and
// asserts a PROVIDER-INVOCATION COUNT, including the zeroes. "it returned ok:false" is not evidence
// that nothing left, and this project has twice mistaken one for the other.
//
// MOCKED TRANSPORTS ONLY. The transport under test is a counter.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const D = require('./dispatch');

const EXTERNAL = 'buyer@acme-pharma.test';
const INTERNAL = 'ops@abiozen.com';
const MSG = { to: EXTERNAL, subject: 'Quotation QT-9001', html: '<p>12 kg, USD 48,150</p>' };

// ── THE HARNESS ──────────────────────────────────────────────────────────────

function counter() {
  const sends = [];
  return {
    sends,
    impl: {
      send: async (m) => { sends.push(m.to); return { ok: true, id: `prov-${sends.length}` }; },
    },
  };
}

/** A ledger that records transitions and never blocks. */
function fakeLedger({ priorClaim = null, beginFails = false, throwOnBegin = false } = {}) {
  const rows = [];
  return {
    rows,
    beginAttempt: async (args) => {
      if (throwOnBegin) throw new Error('database unreachable');
      rows.push({ kind: 'begin', ...args });
      if (beginFails) return { ok: false, error: 'ledger schema not applied' };
      const id = `att-${rows.length}`;
      return {
        ok: true,
        id,
        blocked: async (reason, scope) => rows.push({ kind: 'blocked', id, reason, scope }),
        claim: async () => rows.push({ kind: 'claim', id }),
        accepted: async (pid) => rows.push({ kind: 'accepted', id, pid }),
        rejected: async (e) => rows.push({ kind: 'rejected', id, e }),
        unknown: async (e) => rows.push({ kind: 'unknown', id, e }),
      };
    },
    priorClaim: async () => priorClaim,
  };
}

const allow = { assertSendAllowed: async () => ({ allowed: true, reason: null }) };
const deny = {
  assertSendAllowed: async () => ({ allowed: false, reason: 'STOPPED_BY_POLICY: capability:email.send — all platform email held', scope: 'capability:email.send' }),
};
const gateThrows = { assertSendAllowed: async () => { throw new Error('kill state unknown'); } };

const ENV = { COMPANY_DOMAINS: 'abiozen.com,adificetechnologies.com' };

function harness(over = {}) {
  const c = counter();
  const deps = {
    env: ENV,
    gate: over.gate || allow,
    ledger: over.ledger || fakeLedger(),
    transports: { resend: c.impl, gmail: c.impl, ...(over.transports || {}) },
    ...(over.recipients ? { recipients: over.recipients } : {}),
  };
  return { c, deps };
}

const GOOD = (m = MSG) => ({
  message: m,
  transport: 'resend',
  idempotencyKey: 'inq-1001-quote-v1',
  approvalId: 'apv-1001',
  expectedDigest: D.payloadDigest(m),
  workflow: 'inquiry',
  agent: 'inquiry-agent',
});

// ═══ 1. THE HAPPY PATH EXISTS — or every refusal below proves nothing ═══════

test('1. a fully governed external send is dispatched exactly once', async () => {
  const { c, deps } = harness();
  const r = await D.dispatch(GOOD(), deps);
  assert.strictEqual(r.ok, true, `refused: ${r.error}`);
  assert.strictEqual(c.sends.length, 1);
  assert.strictEqual(c.sends[0], EXTERNAL);
  assert.strictEqual(r.phase, 'provider_accepted');
  assert.strictEqual(deps.ledger.rows.filter((x) => x.kind === 'claim').length, 1,
    'responsibility was not claimed before the provider call');
});

// ═══ 2. THE INVERSION: APPROVAL IS REQUIRED, NOT CHECKED-IF-SUPPLIED ═══════

test('2. an external send with NO approvalId is refused — 0 invocations', async () => {
  const { c, deps } = harness();
  const r = await D.dispatch({ ...GOOD(), approvalId: null }, deps);
  assert.strictEqual(c.sends.length, 0, 'an unapproved external message reached the provider');
  assert.strictEqual(r.needsApproval, true);
  assert.match(r.error, /requires BOTH an approvalId and an expectedDigest/);
});

test('2b. an external send with NO expectedDigest is refused — 0 invocations', async () => {
  const { c, deps } = harness();
  const r = await D.dispatch({ ...GOOD(), expectedDigest: null }, deps);
  assert.strictEqual(c.sends.length, 0);
  assert.strictEqual(r.needsApproval, true);
});

test('2c. an INTERNAL recipient needs no approval — alerts and ops mail still work', async () => {
  // The counter-control. If approval were required for everything, the operator alert channel and
  // the 6pm scores would be dead, and this module would be switched off within a week.
  const { c, deps } = harness();
  const m = { ...MSG, to: INTERNAL };
  const r = await D.dispatch({ message: m, transport: 'resend', idempotencyKey: 'ops-1' }, deps);
  assert.strictEqual(r.ok, true, `an internal send was refused: ${r.error}`);
  assert.strictEqual(c.sends.length, 1);
});

// ═══ 3. THE DIGEST MUST COVER THESE EXACT BYTES ════════════════════════════

test('3. a tampered body after approval is refused — 0 invocations', async () => {
  const { c, deps } = harness();
  const approvedFor = D.payloadDigest(MSG);
  const tampered = { ...MSG, html: '<p>12 kg, USD 4,815</p>' };   // one digit moved
  const r = await D.dispatch({ ...GOOD(tampered), expectedDigest: approvedFor }, deps);
  assert.strictEqual(c.sends.length, 0, 'a message altered after approval was transmitted');
  assert.strictEqual(r.phase, 'digest_mismatch');
  assert.strictEqual(r.stopped, true);
});

test('3b. a swapped recipient after approval is refused — 0 invocations', async () => {
  const { c, deps } = harness();
  const approvedFor = D.payloadDigest(MSG);
  const redirected = { ...MSG, to: 'someone-else@elsewhere.test' };
  const r = await D.dispatch({ ...GOOD(redirected), expectedDigest: approvedFor }, deps);
  assert.strictEqual(c.sends.length, 0, 'an approved message was redirected and still sent');
  assert.strictEqual(r.phase, 'digest_mismatch');
});

test('3c. the digest matches mailer.js, so one frozen message hashes the same on both roads', () => {
  // If these diverge, a message frozen by the approval boundary would be refused here as tampered.
  const mailer = require('../mailer');
  assert.strictEqual(typeof mailer.approvedDigestOf, 'function');
  assert.strictEqual(D.payloadDigest(MSG), mailer.approvedDigestOf(MSG),
    'dispatch and mailer compute different digests for identical bytes — an approved message '
    + 'would be refused on one road and accepted on the other');
});

// ═══ 4. THE GATE IS UNCONDITIONAL ══════════════════════════════════════════

test('4. a STOP refuses a fully approved send — 0 invocations', async () => {
  const { c, deps } = harness({ gate: deny });
  const r = await D.dispatch(GOOD(), deps);
  assert.strictEqual(c.sends.length, 0, 'a STOP was in force and the message went anyway');
  assert.strictEqual(r.stopped, true);
  assert.match(r.error, /STOPPED_BY_POLICY/);
  assert.ok(deps.ledger.rows.some((x) => x.kind === 'blocked' && x.scope === 'capability:email.send'),
    'the refusal was not recorded with the scope that caused it');
});

test('4b. an unreadable kill state fails CLOSED — 0 invocations', async () => {
  const { c, deps } = harness({ gate: gateThrows });
  const r = await D.dispatch(GOOD(), deps);
  assert.strictEqual(c.sends.length, 0, 'the kill state was unknown and the message went anyway');
  assert.match(r.error, /failing closed/);
});

test('4c. no parameter can skip the gate — the C-4 shapes, tried against dispatch', async () => {
  // Every spelling that worked once. The signature does not accept them, which is the point: there
  // is no second positional argument and no flag that reaches the gate decision.
  for (const extra of [
    { alertAlreadyAuthorized: true }, { internal: true }, { skipGate: true },
    { capability: 'email.alert' }, { consequential: false }, { allowed: true },
  ]) {
    const { c, deps } = harness({ gate: deny });
    const r = await D.dispatch({ ...GOOD(), ...extra }, deps);
    assert.strictEqual(c.sends.length, 0,
      `${JSON.stringify(extra)} reached the provider through an active STOP`);
    assert.strictEqual(r.stopped, true);
  }
});

// ═══ 5. IDEMPOTENCY — A REPEAT IS REFUSED, NEVER RESENT ════════════════════

test('5. a duplicate idempotencyKey is refused — 0 invocations', async () => {
  const { c, deps } = harness({
    ledger: fakeLedger({ priorClaim: { id: 'att-earlier', outcome: 'PROVIDER_ACCEPTED' } }),
  });
  const r = await D.dispatch(GOOD(), deps);
  assert.strictEqual(c.sends.length, 0, 'a message that may already have been sent was sent again');
  assert.strictEqual(r.phase, 'refused_duplicate');
  assert.strictEqual(r.duplicateOf, 'att-earlier');
});

test('5b. a missing idempotencyKey is refused — 0 invocations', async () => {
  const { c, deps } = harness();
  const r = await D.dispatch({ ...GOOD(), idempotencyKey: null }, deps);
  assert.strictEqual(c.sends.length, 0);
  assert.match(r.error, /idempotencyKey/);
});

test('5c. a ledger with no priorClaim() refuses — 0 invocations', async () => {
  // The regression this encodes was real and mine. dispatch() guarded the duplicate check with
  // `if (typeof ledger.priorClaim === 'function')`, and the production ledger had no priorClaim —
  // so the control passed here, where the fake supplies one, and did nothing at all in production.
  const ledger = fakeLedger();
  delete ledger.priorClaim;
  const { c, deps } = harness({ ledger });
  const r = await D.dispatch(GOOD(), deps);
  assert.strictEqual(c.sends.length, 0, 'duplicates could not be detected and the message went anyway');
  assert.match(r.error, /no priorClaim/);
});

test('5d. the PRODUCTION ledger implements priorClaim — not just the double', () => {
  // The other half of 5c, and the half that actually catches the defect: 5c proves dispatch fails
  // closed without it; this proves the module dispatch really loads has it.
  const real = require('./ledger');
  assert.strictEqual(typeof real.priorClaim, 'function',
    'src/lib/outbound/ledger.js has no priorClaim(), so dispatch would refuse every send in production');
  // And that the refusing set is derived, not hand-listed: an outcome added later must be unsafe
  // by default rather than silently permitted.
  const SCHEMA = require('./ledger-schema');
  for (const o of SCHEMA.OUTCOMES) {
    assert.strictEqual(real.UNSAFE_TO_REPEAT.includes(o), !SCHEMA.DEFINITELY_NOT_SENT.includes(o),
      `outcome ${o} is classified inconsistently between DEFINITELY_NOT_SENT and UNSAFE_TO_REPEAT`);
  }
  assert.ok(real.UNSAFE_TO_REPEAT.includes('CLAIMED'),
    'a crash mid-send (CLAIMED) must block a repeat: something may have left and nobody knows');
});

test('5e. an unresolvable duplicate check fails CLOSED — 0 invocations', async () => {
  const ledger = fakeLedger();
  ledger.priorClaim = async () => { throw new Error('index unavailable'); };
  const { c, deps } = harness({ ledger });
  const r = await D.dispatch(GOOD(), deps);
  assert.strictEqual(c.sends.length, 0,
    'whether this was already sent could not be established, and it was sent');
  assert.match(r.error, /already sent could not be established/);
});

// ═══ 6. NO TRANSPORT BY DEFAULT, AND NO CREDENTIAL IN THIS MODULE ══════════

test('6. an unknown transport is refused — 0 invocations', async () => {
  const { c, deps } = harness();
  const r = await D.dispatch({ ...GOOD(), transport: 'smtp-direct' }, deps);
  assert.strictEqual(c.sends.length, 0);
  assert.match(r.error, /unknown transport/);
});

test('6b. an absent transport name is refused, never defaulted', async () => {
  const { c, deps } = harness();
  for (const t of [undefined, null, '', 0]) {
    const r = await D.dispatch({ ...GOOD(), transport: t }, deps);
    assert.strictEqual(c.sends.length, 0, `transport ${JSON.stringify(t)} was defaulted`);
    assert.match(r.error, /unknown transport/);
  }
});

test('6c. dispatch holds no credential and reads none — the isolation precondition', () => {
  // Structural. When the sender service lands, the credential lives there and the application
  // cannot reach a provider even if every other control fails. That is only true if this module
  // never touches a key.
  const src = fs.readFileSync(path.join(__dirname, 'dispatch.js'), 'utf8');
  const code = require('../../../scripts/js-lex').blankNonCode(src);
  for (const secret of ['RESEND_API_KEY', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_CLIENT_SECRET',
    'TWILIO_AUTH_TOKEN', 'Authorization', 'Bearer']) {
    assert.ok(!code.includes(secret), `dispatch.js references ${secret} — it must hold no credential`);
  }
  assert.ok(!/process\.env\.[A-Z_]*KEY/.test(code), 'dispatch.js reads a key from the environment');
  assert.ok(!/fetch\s*\(/.test(code), 'dispatch.js calls a provider directly instead of a transport');
});

// ═══ 7. THE LEDGER IS NOT OPTIONAL ═════════════════════════════════════════

test('7. an unavailable ledger refuses the send — 0 invocations', async () => {
  const { c, deps } = harness({ ledger: fakeLedger({ beginFails: true }) });
  const r = await D.dispatch(GOOD(), deps);
  assert.strictEqual(c.sends.length, 0, 'nothing could be recorded and the message went anyway');
  assert.match(r.error, /ledger refused the attempt/);
});

test('7b. an unreachable ledger refuses the send — 0 invocations', async () => {
  const { c, deps } = harness({ ledger: fakeLedger({ throwOnBegin: true }) });
  const r = await D.dispatch(GOOD(), deps);
  assert.strictEqual(c.sends.length, 0);
  assert.match(r.error, /ledger could not be reached/);
});

test('7c. a refusal is recorded as durably as a send', async () => {
  const { deps } = harness({ gate: deny });
  await D.dispatch(GOOD(), deps);
  assert.ok(deps.ledger.rows.some((x) => x.kind === 'begin'), 'no attempt row for a refused send');
  assert.ok(deps.ledger.rows.some((x) => x.kind === 'blocked'), 'the refusal left no record');
});

// ═══ 8. A PROVIDER THAT THREW IS "UNKNOWN", NOT "FAILED" ═══════════════════

test('8. a transport that throws yields OUTCOME_UNKNOWN, never a clean failure', async () => {
  const { deps } = harness({ transports: { resend: { send: async () => { throw new Error('socket hang up'); } } } });
  const r = await D.dispatch(GOOD(), deps);
  assert.strictEqual(r.phase, 'transport_unknown');
  assert.strictEqual(r.providerResponded, false);
  assert.ok(deps.ledger.rows.some((x) => x.kind === 'unknown'),
    'a possible send was recorded as something other than unknown');
  assert.ok(!deps.ledger.rows.some((x) => x.kind === 'rejected'),
    'a request that may have arrived was recorded as definitely rejected');
});

// ═══ 9. A MALFORMED MESSAGE IS A BUG, NOT A DRAFT ══════════════════════════

test('9. a partial message is refused — 0 invocations', async () => {
  const { c, deps } = harness();
  for (const m of [{}, { to: EXTERNAL }, { to: EXTERNAL, subject: 'x' },
    { subject: 'x', html: '<p>y</p>' }, null]) {
    const r = await D.dispatch({ ...GOOD(), message: m }, deps);
    assert.strictEqual(c.sends.length, 0, `${JSON.stringify(m)} reached the provider`);
    assert.strictEqual(r.ok, false);
  }
});

test('9b. an unclassifiable recipient is refused — 0 invocations', async () => {
  const { c, deps } = harness({
    recipients: { isExternal: () => { throw new Error('no company domains configured'); } },
  });
  const r = await D.dispatch(GOOD(), deps);
  assert.strictEqual(c.sends.length, 0,
    'it could not be determined whether this leaves the company, and it was sent');
  assert.match(r.error, /could not be classified/);
});

// ═══ 10. THE GMAIL PATH: THE DIGEST MUST BIND THE BYTES THAT LEAVE ═════════

test('10. a tampered raw with consistent headers is refused — 0 invocations', async () => {
  // The hole this closes was mine and was found while writing the Gmail transport. The digest
  // covered to/subject/html, which for the Resend path IS the message — but on the Gmail path the
  // transmitted bytes are `raw`, so altering `raw` while keeping the headers consistent passed the
  // binding check and sent a different message.
  const { c, deps } = harness();
  const approved = { to: EXTERNAL, subject: 'Quotation QT-9001', html: '<p>12 kg</p>',
    mailbox: 'sales@abiozen.com', raw: 'UkFXLU9SSUdJTkFM' };
  const expectedDigest = D.transmittedDigest(approved);
  const tampered = { ...approved, raw: 'UkFXLVRBTVBFUkVE' };   // same headers, different bytes

  const r = await D.dispatch({ message: tampered, transport: 'gmail',
    idempotencyKey: 'cphi-1', approvalId: 'apv-1', expectedDigest }, deps);

  assert.strictEqual(c.sends.length, 0, 'the raw payload was altered after approval and still went');
  assert.strictEqual(r.phase, 'digest_mismatch');
});

test('10b. with no raw, transmittedDigest is byte-identical to the mailer digest', () => {
  // So migrating the Gmail path did not quietly change the binding on the inquiry path.
  const mailer = require('../mailer');
  assert.strictEqual(D.transmittedDigest(MSG), mailer.approvedDigestOf(MSG));
  assert.strictEqual(D.transmittedDigest(MSG), D.payloadDigest(MSG));
});

test('10c. a raw message and its description do NOT hash the same', () => {
  const base = { to: EXTERNAL, subject: 'x', html: '<p>y</p>' };
  assert.notStrictEqual(D.transmittedDigest({ ...base, raw: 'Ymx1cmI' }), D.transmittedDigest(base),
    'adding raw did not change the digest, so raw is not covered by it');
});

test('10d. the transport result\'s meta reaches the caller', async () => {
  // The agents need the Gmail threadId to thread the next follow-up onto. If dispatch swallowed
  // it, the migration would silently break threading.
  const deps = {
    env: ENV, gate: allow, ledger: fakeLedger(),
    transports: { gmail: { send: async () => ({ ok: true, id: 'm-1', meta: { threadId: 't-99' } }) } },
  };
  const m = { to: INTERNAL, subject: 's', html: '<p>b</p>', mailbox: 'a@abiozen.com', raw: 'Ug' };
  const r = await D.dispatch({ message: m, transport: 'gmail', idempotencyKey: 'k-1' }, deps);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.meta.threadId, 't-99');
});

// ═══ 11. CREDENTIAL ISOLATION (milestone 5, item 3) ════════════════════════

test('11. the agents cannot obtain a send-capable Gmail client', () => {
  const T = require('./transports/gmail');
  assert.strictEqual(typeof T.sendCapableClient, 'undefined',
    'the send-capable client factory is exported, so an agent can get a token that sends');
  const src = fs.readFileSync(path.join(__dirname, 'transports', 'gmail.js'), 'utf8');
  const code = require('../../../scripts/js-lex').blankNonCode(src);
  assert.ok(/function sendCapableClient/.test(code), 'the private factory is gone — check this test');
  assert.ok(!/module\.exports[\s\S]*sendCapableClient/.test(code),
    'sendCapableClient appears in the export list');
});

test('11b. readOnlyClientFor forces READONLY_ONLY — the grant refuses the write, not the code', async () => {
  const T = require('./transports/gmail');
  const { READONLY_ONLY } = require('../gmail/client');
  let askedFor = null;
  await T.readOnlyClientFor('naren@abiozen.com', {
    gmailClientFor: async (subject, d) => { askedFor = d.scopeSets; return { gmail: {} }; },
  });
  assert.deepStrictEqual(askedFor, READONLY_ONLY,
    'the agent was handed something other than a read-only scope set');
});

test('11c. a missing send credential is PROVIDER_REJECTED, never OUTCOME_UNKNOWN', async () => {
  // Nothing was transmitted because nothing could be. Recording that as "unknown" would leave a
  // row a human must chase, for a send that provably never happened.
  const T = require('./transports/gmail');
  T._resetSenders();
  const r = await T.send({ mailbox: 'x@abiozen.com', raw: 'Ug' },
    { gmailClientFor: async () => ({ error: 'no usable Gmail scope' }) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.providerResponded, false);
  assert.match(r.error, /no send-capable Gmail credential/);
});

test('11d. the transport makes no authorization decision', () => {
  const src = fs.readFileSync(path.join(__dirname, 'transports', 'gmail.js'), 'utf8');
  const code = require('../../../scripts/js-lex').blankNonCode(src);
  for (const t of ['assertSendAllowed', 'autonomy_stops', 'approvalId', 'expectedDigest']) {
    assert.ok(!code.includes(t),
      `the gmail transport references ${t} — authorization belongs to dispatch, in one place`);
  }
});
