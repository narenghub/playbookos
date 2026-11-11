// ── IS THE APPROVAL BOUNDARY THE ONLY ROAD TO A BUYER? ───────────────────────
//
//   node --test scripts/buyer-email-boundary.test.js
//
// CEO authorization 2026-11-11 workstream B. The sibling file
// src/lib/agents/buyer-email-approval.test.js drives the approval logic through its refusals.
// These assertions are about STRUCTURE: that no other code in the inquiry agent can reach a
// provider, that the digest check sits at the transport ahead of the provider call, and that a
// released-but-undelivered message does not get recorded as delivered.
//
// ── WHY STRUCTURE NEEDS ITS OWN TESTS ────────────────────────────────────────
//
// The recurring defect in this repository is not a missing gate. It is a gate enforced at one
// chokepoint while other code reaches the provider by a different road — found four times: eight
// agents bypassing the llm.js meter, two Gmail transports bypassing the kill switch, a
// completeness test reading one of six routers, a containment report blind to two of four
// transports. The useful question is never "is there a gate" but "is the gate the only road, and
// can the evidence see every road".
//
// MOCKED TRANSPORTS ONLY. Nothing here contacts a provider.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'preflight';

const GATE = require('../src/lib/email-gate');
const MAILER = require('../src/lib/mailer');
const LEDGER = require('../src/lib/outbound/ledger');

const AGENT_FILE = path.join(__dirname, '..', 'src', 'lib', 'agents', 'inquiry-agent.js');
const MAILER_FILE = path.join(__dirname, '..', 'src', 'lib', 'mailer.js');
const agentSrc = fs.readFileSync(AGENT_FILE, 'utf8');
const mailerSrc = fs.readFileSync(MAILER_FILE, 'utf8');

// Comments are stripped before structural counting. A rule asserted against prose passes on a
// sentence that describes the code rather than on the code — which is precisely how the B6
// negative control came to scan for a literal using the function that erased literals.
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}
const agentCode = codeOnly(agentSrc);
const mailerCode = codeOnly(mailerSrc);

// ── ONE ROAD OUT OF THE INQUIRY AGENT ────────────────────────────────────────

test('sendEmailDetailed is called from exactly one place in the inquiry agent', () => {
  const calls = agentCode.match(/\bsendEmailDetailed\s*\(/g) || [];
  assert.strictEqual(calls.length, 1,
    `sendEmailDetailed is called ${calls.length} times. Every buyer-directed message must go `
    + 'through sendApprovedBuyerEmail; a second call site is a second road.');
});

test('that one call passes an approvalId AND an expectedDigest', () => {
  const i = agentCode.indexOf('sendEmailDetailed(');
  const window = agentCode.slice(i, i + 700);
  assert.ok(/approvalId/.test(window), 'the send does not carry an approval id');
  assert.ok(/expectedDigest:\s*rel\.expectedDigest/.test(window),
    'the send does not carry the digest from the released approval, so nothing binds the bytes '
    + 'that leave to the bytes a human approved');
});

test('the digest it passes comes from the RELEASED approval, not recomputed at send time', () => {
  // Recomputing here would make the check compare the message against itself and always pass.
  const i = agentCode.indexOf('sendEmailDetailed(');
  const window = agentCode.slice(i, i + 700);
  assert.ok(!/approvedDigestOf|digestOf\(/.test(window),
    'the send site computes a digest locally — it must carry the approved one');
});

test('sendAndLog prepares and reports ok:false, so no caller can read it as a send', () => {
  const start = agentCode.indexOf('async function sendAndLog(');
  assert.ok(start > 0, 'sendAndLog is gone — this guard points at a function that no longer exists');
  const end = agentCode.indexOf('\nasync function sendApprovedBuyerEmail', start);
  const body = agentCode.slice(start, end > start ? end : start + 4000);

  assert.ok(/prepareBuyerEmail/.test(body), 'sendAndLog no longer prepares an approval');
  assert.ok(!/sendEmail\s*\(|sendEmailDetailed\s*\(/.test(body),
    'sendAndLog reaches a provider directly — it must only prepare');
  assert.ok(!/ok:\s*true/.test(body),
    'sendAndLog can return ok:true. It transmits nothing, so a truthy result would make each of '
    + 'its eleven call sites silently claim a send — the exact defect this work removes.');
});

test('quote_sent is written in exactly one place, and only after delivery', () => {
  const writes = agentCode.match(/status\s*=\s*'quote_sent'/g) || [];
  assert.strictEqual(writes.length, 1,
    `'quote_sent' is assigned ${writes.length} times; it must be written once, after the provider accepts`);

  const i = agentCode.indexOf("status='quote_sent'");
  const before = agentCode.slice(Math.max(0, i - 900), i);
  assert.ok(/if\s*\(!r\.ok\)[\s\S]*return r;/.test(before),
    'the quote_sent write is not guarded by an early return on a failed send');
});

test('the delivered-email counters are not incremented on a prepared message', () => {
  const start = agentCode.indexOf('async function recordDeliveredBuyerEmail(');
  assert.ok(start > 0, 'recordDeliveredBuyerEmail is gone');
  const prepStart = agentCode.indexOf('async function sendAndLog(');
  const prepEnd = agentCode.indexOf('\nasync function sendApprovedBuyerEmail', prepStart);
  const prepBody = agentCode.slice(prepStart, prepEnd);
  assert.ok(!/total_emails_sent/.test(prepBody),
    'the prepare path still increments total_emails_sent, which the follow-up logic and the daily '
    + 'summary read as "we have written to this buyer"');
});

test('a drafted letter is logged as outbound_pending, never as outbound', () => {
  const prepStart = agentCode.indexOf('async function sendAndLog(');
  const prepEnd = agentCode.indexOf('\nasync function sendApprovedBuyerEmail', prepStart);
  const prepBody = agentCode.slice(prepStart, prepEnd);
  assert.ok(/direction:\s*'outbound_pending'/.test(prepBody),
    'the draft is recorded as a delivered outbound message');
});

// ── THE DIGEST CHECK, AT THE TRANSPORT ───────────────────────────────────────

test('the mailer digest check sits before the provider call', () => {
  const check = mailerCode.indexOf('expectedDigest');
  const provider = mailerCode.search(/RESEND_EMAILS_URL\s*,/);
  assert.ok(check > 0, 'the mailer no longer checks an expected digest');
  assert.ok(provider > 0, 'the provider call site could not be located — update this guard');
  assert.ok(check < provider,
    'the digest comparison now sits AFTER the provider call, which means it cannot prevent anything');
});

test('a digest mismatch has no mode in which it proceeds', () => {
  const i = mailerCode.indexOf('if (expectedDigest)');
  assert.ok(i > 0);
  const block = mailerCode.slice(i, i + 900);
  assert.ok(/return\s*\{\s*ok:\s*false/.test(block), 'a mismatch does not return a refusal');
  assert.ok(/att\.blocked\(/.test(block), 'a mismatch is not recorded in the ledger');
  assert.ok(!/process\.env\.[A-Z_]*DIGEST/.test(block),
    'the digest check is switchable by an environment variable — a control with an off switch in '
    + 'the environment is not a control');
});

test('the approval boundary and the transport compute the same digest', () => {
  const msg = { to: 'buyer@acme.test', subject: 'Quotation QT-1', html: '<div>$48,150</div>' };
  // Three expressions of one hash must agree, or the binding is decorative.
  assert.strictEqual(MAILER.approvedDigestOf(msg), LEDGER.digestOf(msg));
  assert.strictEqual(
    MAILER.approvedDigestOf({ ...msg, to: ['buyer@acme.test'] }),
    LEDGER.digestOf(msg),
    'an array recipient must hash identically to the same single recipient');
});

test('NEGATIVE: the digest functions disagree when the message differs', () => {
  // The mutation control for the test above. Equal hashes prove agreement only if unequal
  // messages produce unequal hashes.
  const a = MAILER.approvedDigestOf({ to: 'b@acme.test', subject: 'S', html: '<p>48150</p>' });
  const b = MAILER.approvedDigestOf({ to: 'b@acme.test', subject: 'S', html: '<p>61500</p>' });
  const c = MAILER.approvedDigestOf({ to: 'other@acme.test', subject: 'S', html: '<p>48150</p>' });
  assert.notStrictEqual(a, b, 'a changed total hashes the same');
  assert.notStrictEqual(a, c, 'a changed recipient hashes the same');
});

// ── STOP ENFORCEMENT ON THE BUYER WORKFLOW ───────────────────────────────────

function fakeAutonomy(stops = [], { throws = false } = {}) {
  return {
    checkStopped: async (scopes, opts) => {
      if (throws) throw new Error('database unreachable');
      for (const s of stops) {
        if (s.scope_type === 'global') {
          if (opts && opts.consequential === false) continue;
          return s;
        }
        if (s.scope_type === 'capability' && s.scope_key === scopes.capability) return s;
        if (s.scope_type === 'workflow' && s.scope_key === scopes.workflow) return s;
        if (s.scope_type === 'agent' && s.scope_key === scopes.agent) return s;
      }
      return null;
    },
    recordRefusal: () => {},
  };
}

const BUYER_SEND = { capability: 'email.send', workflow: 'legacy-inquiry-buyer-email',
  agent: 'inquiry-agent', to: 'buyer@acme.test' };

test('STOP: the buyer workflow stop refuses a released quotation', async () => {
  const g = await GATE.assertSendAllowed(BUYER_SEND, {
    autonomy: fakeAutonomy([{ scope_type: 'workflow', scope_key: 'legacy-inquiry-buyer-email',
      reason: 'CEO external-email HOLD' }]) });
  assert.strictEqual(g.allowed, false);
  assert.match(g.reason, /STOPPED_BY_POLICY: workflow:legacy-inquiry-buyer-email/);
});

test('STOP: a global stop refuses it', async () => {
  const g = await GATE.assertSendAllowed(BUYER_SEND, {
    autonomy: fakeAutonomy([{ scope_type: 'global', reason: 'containment' }]) });
  assert.strictEqual(g.allowed, false);
});

test('STOP: an unreadable kill switch refuses it — a buyer quote is never observability', async () => {
  const g = await GATE.assertSendAllowed(BUYER_SEND, { autonomy: fakeAutonomy([], { throws: true }) });
  assert.strictEqual(g.allowed, false);
  assert.match(g.reason, /AUTHORIZATION_UNDETERMINED/);
});

test('STOP: a quotation cannot relabel itself as an operator alert to escape the hold', async () => {
  // The relabel bypass. An exemption honoured on a claimed capability rather than a verified
  // recipient would let the most consequential message in the system through a global stop.
  const g = await GATE.assertSendAllowed(
    { ...BUYER_SEND, capability: 'email.alert' },
    { autonomy: fakeAutonomy([{ scope_type: 'global', reason: 'containment' }]),
      env: { ALERT_EMAIL: 'naren@abiozen.com' } });
  assert.strictEqual(g.allowed, false, 'a buyer-addressed message claiming to be an alert was allowed');
  assert.strictEqual(g.exempt, false);
});

test('STOP: with no stop in force, the buyer workflow is allowed — the control has an inside', async () => {
  const g = await GATE.assertSendAllowed(BUYER_SEND, { autonomy: fakeAutonomy([]) });
  assert.strictEqual(g.allowed, true);
});

// ── PROVIDER TIMEOUT AND UNKNOWN OUTCOMES ────────────────────────────────────

test('a provider that never answers is OUTCOME_UNKNOWN, and that counts as may-have-left', () => {
  assert.ok(LEDGER.MAY_HAVE_LEFT.includes('OUTCOME_UNKNOWN'),
    'an unanswered provider call must be treated as possibly transmitted; folding it into failure '
    + 'is how a message that went is recorded as one that did not');
  assert.ok(!LEDGER.DEFINITELY_NOT_SENT.includes('OUTCOME_UNKNOWN'));
});

test('the transport records an unknown outcome rather than retrying', () => {
  const i = mailerCode.indexOf("phase: 'transport_unknown'");
  assert.ok(i > 0, 'the transport no longer has an unknown-outcome path');
  const block = mailerCode.slice(Math.max(0, i - 600), i + 200);
  assert.ok(/att\.unknown\(/.test(block), 'an unanswered provider call is not recorded as unknown');
});

test('a released-but-undelivered quotation does not advance the inquiry', () => {
  const start = agentCode.indexOf('async function releaseQuote(');
  assert.ok(start > 0, 'releaseQuote is gone');
  const body = agentCode.slice(start, start + 900);
  const guard = body.indexOf('if (!r.ok)');
  const write = body.indexOf("status='quote_sent'");
  assert.ok(guard > 0 && write > guard,
    'releaseQuote writes quote_sent without first returning on a failed send — a provider timeout '
    + 'would then leave the inquiry marked as quoted with nothing delivered');
});
