// ── C-4: CAN A CALLER SKIP THE SEND GATE BY ASKING? ──────────────────────────
//
//   node --test scripts/mailer-authorization-bypass.test.js
//
// CEO authorization 2026-11-12, authorization 2: "Remove the caller-controlled bypass from the
// exported mailer API. Keep `deliverAuthorized` private. Preserve the existing ledger handle,
// approval/digest context, refusal behavior, and provider behavior. Add mocked tests for the
// original bypass, legitimate operator alerts, unauthorized recipients, STOP-store errors, and
// provider invocation counts."
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// `sendEmailDetailed` took a SECOND POSITIONAL ARGUMENT:
//
//     async function sendEmailDetailed({ ... }, internal = {}) {
//       const att  = await LEDGER.beginAttempt({ ..., consequential: !internal.alertAlreadyAuthorized });
//       const gate = internal.alertAlreadyAuthorized
//         ? { allowed: true, reason: null }
//         : await assertSendAllowed({ ... });
//
// `sendEmailDetailed` is exported and 22 modules import this file. Any of them — or anything they
// load — could append `, { alertAlreadyAuthorized: true }` to a call and transmit with:
//   · no kill-switch check            (the CEO's global STOP does not apply)
//   · no approval boundary            (no released approval, no digest comparison)
//   · no recipient restriction        (any address, not just the operator ones)
//   · a non-consequential ledger row  (so the attempt reads as observability traffic)
//
// The comment above it said the second argument was unreachable because the public contract is a
// single options object. That is an argument about what callers are LIKELY to pass, offered in the
// place where a check should have been — the fifth instance of this exact pattern in the repo, and
// the same shape as the `email.alert` capability parameter that CEO item B removed on 2026-11-10:
// documented as narrow, enforced nowhere.
//
// ── WHY THE PATCH EXTRACTS RATHER THAN HIDES ─────────────────────────────────
//
// A private `Symbol` as the key would still leave a bypass in the function, reachable by whatever
// holds the symbol, and would have to be audited for ever. Extracting the shared second half into
// a module-private `deliverAuthorized` means there is no bypass to reach, by any key: the gate is
// unconditional in the exported function, and the only way to the provider without it is a call
// that no module outside this file can make.
//
// MOCKED TRANSPORTS ONLY. Nothing here contacts a provider. Every assertion that matters is a
// PROVIDER INVOCATION COUNT, including the zeroes — "it returned ok:false" is not evidence that
// nothing left, and this project has twice mistaken one for the other.
'use strict';

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'preflight';
// Set BEFORE mailer is required: the gate reads operator addresses from the environment at call
// time, but RESEND_API_KEY is read at call time too and an absent key refuses before the request,
// which would make every "0 invocations" assertion below pass for the wrong reason.
process.env.RESEND_API_KEY = 'test-key-not-a-real-credential';

// ── THE FIXTURE ──────────────────────────────────────────────────────────────

const db = require('../src/lib/db');
const AUTONOMY = require('../src/lib/autonomy');
const LEDGER = require('../src/lib/outbound/ledger');
const { ADDED_COLUMNS } = require('../src/lib/outbound/ledger-schema');

let STOPS = [];          // rows the stop store returns
let STORE_THROWS = false; // the kill-state cannot be read
let APPROVE = false;      // is a released approval in force?
let LAST_DIGEST = null;   // the digest the ledger recorded for this attempt
let BLOCKED = [];         // every att.blocked() reason written to the ledger
let ATTEMPTS = [];        // the arguments each attempt was opened with

db.query = async (sql, params = []) => {
  if (/FROM autonomy_stops/i.test(sql)) {
    if (STORE_THROWS) throw new Error('database unreachable');
    return { rows: STOPS };
  }
  if (/INSERT INTO email_log/i.test(sql)) {
    // ledger.beginAttempt: payload_digest is the 12th placeholder. Captured so the approval stub
    // can answer with the TRUE digest rather than a value that makes the comparison vacuous.
    LAST_DIGEST = params[11] || null;
    return { rows: [] };
  }
  if (/released_at, action_payload/i.test(sql)) {
    if (!APPROVE) return { rows: [] };
    return { rows: [{ id: params[0], status: 'approved', released_at: new Date(),
      action_payload: { transport_digest: LAST_DIGEST } }] };
  }
  // A migrated database. The mailer fails closed when the ledger columns are absent, so an
  // unmigrated fixture would refuse every consequential send for a reason unrelated to C-4.
  if (/information_schema\.columns/i.test(sql)) return { rows: [{ n: ADDED_COLUMNS.length }] };
  if (/UPDATE email_log/i.test(sql)) {
    // EVERY string parameter, not the first one matching a pattern. The first draft of this stub
    // searched for /STOPPED_BY_POLICY/i and captured the `status` column ('stopped_by_policy')
    // rather than the reason beside it, so an assertion about WHICH scope refused the send was
    // reading a value that never contains a scope. The same mistake as measuring the wrong thing
    // in the test it was written to support.
    BLOCKED.push(params.filter((p) => typeof p === 'string').join(' | '));
    // RETURNING id, as a real UPDATE of an existing row does. claim() is now the ARBITRATION
    // POINT — it returns { ok:false } when no row came back, because that means responsibility was
    // not recorded — so a stub that answers every UPDATE with zero rows makes the mailer refuse
    // every send, for a reason that has nothing to do with what these tests measure.
    return { rows: [{ id: params[0] }] };
  }
  // The per-type daily ceiling on alerts counts previous sends. No previous sends.
  if (/count\(\*\)|COUNT\(\*\)/i.test(sql)) return { rows: [{ n: 0, count: '0' }] };
  return { rows: [] };
};

// ── THE consequential FLAG NEEDS ITS OWN SEAM ────────────────────────────────
//
// It is NOT a column: the ledger takes `consequential` to decide whether to fail closed, and does
// not record it. So it cannot be observed from the fixture's INSERT, and an assertion that tried
// would be inspecting a parameter index that holds something else. `mailer.js` looks the function
// up on the module object at call time, so wrapping the export captures the real argument and
// still runs the real ledger underneath.
const realBeginAttempt = LEDGER.beginAttempt;
LEDGER.beginAttempt = async (args = {}, deps) => {
  ATTEMPTS.push({ consequential: args.consequential, to: args.to, approvalId: args.approvalId,
    workflow: args.workflow, agent: args.agent, claimRef: args.claimRef });
  return realBeginAttempt(args, deps);
};

// ── THE PROVIDER, COUNTED ────────────────────────────────────────────────────
//
// Not just "was it called" — WHO it was called about. A test that counts invocations without
// recording recipients cannot tell a correctly delivered operator alert from a correctly counted
// message that went to a buyer.
let SENDS = [];
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  // Normalised: Resend takes `to` as an array, so a bare string comparison in a test would fail
  // on a correctly delivered message and invite someone to "fix" the assertion by loosening it.
  SENDS.push({ url: String(url), subject: body.subject,
    to: (Array.isArray(body.to) ? body.to : [body.to]).join(', ') });
  return { json: async () => ({ id: 'provider-id-' + SENDS.length }) };
};

const MAILER = require('../src/lib/mailer');

const GLOBAL_STOP = [{ scope_type: 'global', scope_key: null, reason: 'CEO hold 2026-11-10' }];
const OPERATOR = 'ops@abiozen.com';
const OUTSIDER = 'buyer@acme-pharma.test';

// ── A REAL ALERT TYPE, NOT AN INVENTED ONE ───────────────────────────────────
//
// The first draft of this file used `type: 'email_domain_unauthorized'`, which src/lib/alerts.js
// does not define. buildAlert() correctly refused it, the alert never reached a provider, and
// test 3 went red reporting "removing the bypass silenced the alert channel". It had not: the
// fixture was asking for a message that does not exist. Worth recording, because a false positive
// on the one test that proves alerts still work is a test that would later be "fixed" by relaxing
// it. `send_failure` is one of the two types alerts.js actually owns.
const ALERT = Object.freeze({
  type: 'send_failure',
  fields: { context: 'procurement weekly summary', phase: 'provider_rejected',
    reason: 'domain not authorized (403)' },
});

beforeEach(() => {
  SENDS = []; BLOCKED = []; ATTEMPTS = [];
  STOPS = []; STORE_THROWS = false; APPROVE = false; LAST_DIGEST = null;
  process.env.ALERT_EMAIL = OPERATOR;
  delete process.env.ADMIN_EMAIL;
  // The stop store is cached behind a TTL. Without this, a test that sets a stop inherits the
  // previous test's snapshot and passes or fails on the wrong state.
  AUTONOMY.resetForTests();
});

// ═══ 1. THE ORIGINAL BYPASS ══════════════════════════════════════════════════
//
// The decisive test. This is the call an external module could previously make, written exactly as
// it would have been written, and it must now be refused.

test('1. the original bypass argument no longer skips the gate — 0 provider invocations', async () => {
  STOPS = GLOBAL_STOP;

  const r = await MAILER.sendEmailDetailed(
    { to: OUTSIDER, subject: 'Quotation QT-9001', html: '<p>12 kg, USD 48,150</p>' },
    { alertAlreadyAuthorized: true });          // ← THE BYPASS, AS IT WAS REACHED

  assert.strictEqual(SENDS.length, 0,
    `the bypass still reaches the provider: ${SENDS.length} invocation(s) to `
    + `${SENDS.map((s) => s.to).join(', ')}`);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stopped, true, 'the result does not report the message as stopped');
  assert.strictEqual(r.providerResponded, false);
  assert.match(r.error, /STOPPED_BY_POLICY: global/,
    'refused, but not by the kill switch — check the refusal is for the right reason');
});

test('1b. and the ledger records the attempt as consequential, not observability', async () => {
  STOPS = GLOBAL_STOP;
  await MAILER.sendEmailDetailed({ to: OUTSIDER, subject: 'Q', html: '<p>x</p>' },
    { alertAlreadyAuthorized: true });

  assert.strictEqual(ATTEMPTS.length, 1, 'no ledger attempt was opened for a refused send');
  assert.strictEqual(ATTEMPTS[0].consequential, true,
    'the caller still downgraded the ledger\'s own classification of its send — a buyer-directed '
    + 'message filed as observability traffic is invisible to the containment evidence');
  assert.ok(BLOCKED.some((b) => /STOPPED_BY_POLICY: global/.test(b)),
    'the refusal was not written to the ledger — a refusal nobody can audit');
});

test('1c. the bypass fails even with an UNKNOWN second argument shape', async () => {
  // Not just the one key: the signature no longer accepts a second argument at all, so no spelling
  // of it can matter. If someone reintroduces `internal`, this catches the near-misses too.
  STOPS = GLOBAL_STOP;
  for (const arg of [{ alertAlreadyAuthorized: true }, { alreadyAuthorized: true },
    { internal: true }, { consequential: false }, true, 'yes']) {
    SENDS = [];
    const r = await MAILER.sendEmailDetailed({ to: OUTSIDER, subject: 'Q', html: '<p>x</p>' }, arg);
    assert.strictEqual(SENDS.length, 0,
      `a second argument of ${JSON.stringify(arg)} reached the provider`);
    assert.strictEqual(r.stopped, true);
  }
});

// ═══ 2. AN ORDINARY SEND UNDER THE STOP ═════════════════════════════════════

test('2. an ordinary send is refused under the global STOP — 0 provider invocations', async () => {
  STOPS = GLOBAL_STOP;
  const r = await MAILER.sendEmailDetailed({ to: OUTSIDER, subject: 'Hello', html: '<p>x</p>' });

  assert.strictEqual(SENDS.length, 0, 'an ordinary send reached the provider through a global STOP');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stopped, true);
  assert.match(r.error, /STOPPED_BY_POLICY: global/);
});

test('2b. with no stop and a released approval it DOES send — the control is not "always false"', async () => {
  // Without this, every assertion above would pass against a mailer that refuses everything, and
  // the suite would prove nothing about the gate. 1,113 emails were lost to exactly that silence.
  APPROVE = true;
  const r = await MAILER.sendEmailDetailed({ to: OUTSIDER, subject: 'Hello', html: '<p>x</p>',
    approvalId: 'ap-1' });

  assert.strictEqual(SENDS.length, 1, `expected exactly 1 provider invocation, got ${SENDS.length}`);
  assert.strictEqual(SENDS[0].to, OUTSIDER);
  assert.strictEqual(r.ok, true, `the control send was refused: ${r.error}`);
});

// ═══ 3. LEGITIMATE OPERATOR ALERTS STILL GO OUT ══════════════════════════════
//
// The patch's real risk. The alert path used to reach the provider THROUGH the bypass, so removing
// the bypass without rerouting it would silence operator alerts under exactly the hold during which
// they matter most — a containment improvement that blinds the operator is not an improvement.

test('3. an operator alert is delivered under the same global STOP — exactly 1 invocation', async () => {
  STOPS = GLOBAL_STOP;

  const r = await MAILER.sendOperatorAlert(ALERT);

  assert.strictEqual(SENDS.length, 1,
    `expected exactly 1 provider invocation for the operator alert, got ${SENDS.length}. `
    + 'If 0: removing the bypass silenced the alert channel under a hold.');
  assert.strictEqual(SENDS[0].to, OPERATOR,
    `the alert went to ${SENDS[0].to} instead of the configured operator address`);
  assert.strictEqual(r.ok, true, `the operator alert was refused: ${r.error}`);
});

test('3b. and it is filed as NON-consequential, so the exemption is visible in the ledger', async () => {
  STOPS = GLOBAL_STOP;
  await MAILER.sendOperatorAlert(ALERT);

  assert.strictEqual(ATTEMPTS.length, 1, 'the alert opened no ledger attempt — it is unaudited');
  assert.strictEqual(ATTEMPTS[0].consequential, false,
    'the operator alert was filed as a consequential send, which both misreports it and would '
    + 'make the global STOP apply to it');
});

test('3c. a deliberate capability:email.alert STOP still silences it — 0 invocations', async () => {
  // The exemption is from a GLOBAL hold, not from oversight of the alert channel itself. If this
  // goes green at 1 invocation, the alert path has become unstoppable.
  STOPS = [{ scope_type: 'capability', scope_key: 'email.alert', reason: 'alert storm 2026-11-12' }];

  const r = await MAILER.sendOperatorAlert(ALERT);

  assert.strictEqual(SENDS.length, 0, 'an explicit email.alert STOP did not stop the alert');
  assert.strictEqual(r.stopped, true);
  assert.match(r.error, /STOPPED_BY_POLICY: capability:email\.alert/);
});

// ═══ 4. THE EXEMPTION CANNOT BE BORROWED ═════════════════════════════════════

test('4. with no operator address configured the alert is refused before any request', async () => {
  delete process.env.ALERT_EMAIL;
  delete process.env.ADMIN_EMAIL;
  STOPS = GLOBAL_STOP;

  const r = await MAILER.sendOperatorAlert(ALERT);

  assert.strictEqual(SENDS.length, 0,
    'an alert with no verifiable destination reached the provider — the exemption was granted on '
    + 'the claim rather than on the address');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.providerResponded, false);
});

test('4b. a caller-supplied email.alert capability does NOT exempt an outside recipient', async () => {
  // The capability is an ordinary parameter of the exported function. Before CEO item B this alone
  // transmitted through a hold; it must now be downgraded to email.send and refused.
  STOPS = GLOBAL_STOP;
  const r = await MAILER.sendEmailDetailed({ to: OUTSIDER, subject: 'Alert', html: '<p>x</p>',
    capability: 'email.alert' });

  assert.strictEqual(SENDS.length, 0,
    'a message relabelled as an alert transmitted to an outside address through a global STOP');
  assert.strictEqual(r.stopped, true);
  assert.match(r.error, /STOPPED_BY_POLICY: global/);
});

test('4c. and the two cannot be combined — capability plus the old bypass argument', async () => {
  // The combination the patch has to be proof against: the relabel to get the exemption, plus the
  // second argument to skip the check that would catch the relabel.
  STOPS = GLOBAL_STOP;
  const r = await MAILER.sendEmailDetailed(
    { to: OUTSIDER, subject: 'Alert', html: '<p>x</p>', capability: 'email.alert' },
    { alertAlreadyAuthorized: true });

  assert.strictEqual(SENDS.length, 0, 'the combination of a relabel and the bypass still transmits');
  assert.strictEqual(r.stopped, true);
});

// ═══ 5. AN UNREADABLE KILL STATE FAILS CLOSED ════════════════════════════════

test('5. a STOP-store error refuses a consequential send — 0 provider invocations', async () => {
  STORE_THROWS = true;
  APPROVE = true;

  const r = await MAILER.sendEmailDetailed({ to: OUTSIDER, subject: 'Hello', html: '<p>x</p>',
    approvalId: 'ap-1' });

  assert.strictEqual(SENDS.length, 0,
    'the kill state could not be read and the message was transmitted anyway — an unreadable hold '
    + 'is the one state in which a send must never proceed');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stopped, true);
});

test('5b. and a STOP-store error cannot be bypassed by the second argument either', async () => {
  STORE_THROWS = true;
  const r = await MAILER.sendEmailDetailed({ to: OUTSIDER, subject: 'Hello', html: '<p>x</p>' },
    { alertAlreadyAuthorized: true });

  assert.strictEqual(SENDS.length, 0,
    'the bypass turned an unreadable kill state into a successful send');
  assert.strictEqual(r.stopped, true);
});

// ═══ 6. THE APPROVAL AND DIGEST CONTEXT SURVIVED THE REFACTOR ════════════════
//
// The authorization requires the patch to PRESERVE the approval/digest context. The extraction
// moved 65 lines; a digest check that silently stopped being reached would look exactly like a
// successful refactor.

test('6. a digest mismatch still refuses at the transport — 0 provider invocations', async () => {
  APPROVE = true;
  const r = await MAILER.sendEmailDetailed({ to: OUTSIDER, subject: 'Hello', html: '<p>x</p>',
    approvalId: 'ap-1', expectedDigest: 'f'.repeat(64) });

  assert.strictEqual(SENDS.length, 0, 'a message whose digest did not match was transmitted');
  assert.strictEqual(r.phase, 'digest_mismatch', `phase was ${r.phase}`);
  assert.strictEqual(r.stopped, true);
});

test('6b. an external send with NO released approval is refused', async () => {
  APPROVE = false;
  const r = await MAILER.sendEmailDetailed({ to: OUTSIDER, subject: 'Hello', html: '<p>x</p>',
    approvalId: 'ap-missing' });

  assert.strictEqual(SENDS.length, 0, 'an unapproved external message was transmitted');
  assert.strictEqual(r.ok, false);
});

// ═══ 7. THE STRUCTURAL GUARD ═════════════════════════════════════════════════
//
// The behavioural tests above all exercise the CURRENT shape of the function. If someone
// reintroduces a parameter-controlled gate under a different name, every test above could still
// pass — they only probe the spellings they know. These assertions are about the SHAPE: the gate
// call must not be conditional on anything a caller can supply, and the private half must stay
// private. This is the ratchet.

const MAILER_FILE = path.join(__dirname, '..', 'src', 'lib', 'mailer.js');
const mailerSrc = fs.readFileSync(MAILER_FILE, 'utf8');

// Comments stripped before structural counting. Without this the guard passes on prose that
// DESCRIBES the bypass — and this file's own header describes it at length.
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}
const mailerCode = codeOnly(mailerSrc);

test('7. the gate call in the mailer is not conditional on any parameter', () => {
  // The defect's exact shape was `const gate = <predicate> ? {allowed:true} : await assertSend…`.
  // Generalised: no ternary, and no `if`/`&&`/`||` guard, may stand between a parameter and the
  // gate call. Checked by taking the text immediately before each call and refusing a conditional
  // operator in it.
  const calls = [...mailerCode.matchAll(/assertSendAllowed\s*\(/g)];
  assert.ok(calls.length >= 2,
    `expected the gate to be called from both sendEmailDetailed and transmitAlert, found ${calls.length}`);

  for (const m of calls) {
    // ── THE WINDOW IS THE STATEMENT, NOT THE LINE ──────────────────────────
    //
    // The first draft of this guard read only the text on the SAME LINE before the call. Run
    // against the real pre-patch source on 2026-11-12 it passed, because the defect was written
    // across three lines and the `?` sat on the first of them:
    //
    //     const gate = internal.alertAlreadyAuthorized
    //       ? { allowed: true, reason: null }
    //       : await assertSendAllowed({ ... });          ← the line this guard was reading
    //
    // A ratchet that does not fire on the exact defect it was written for is worse than no
    // ratchet: it reports the property as held. So the window now runs back to the previous
    // statement boundary and takes in however many lines the expression spans.
    // Nor are braces a usable boundary: the SECOND draft of this guard also walked back to the
    // nearest `{` or `}`, and the defect's own true-branch is an object literal —
    // `? { allowed: true, reason: null }` — whose closing brace sits two characters before the
    // call. The window it computed was "\n    : await ", which is the single-line bug again by a
    // different route. The anchors are therefore `;` (the previous statement) and the enclosing
    // `function` keyword, whichever is nearer; neither can appear inside an expression.
    const head = mailerCode.slice(0, m.index);
    const boundary = Math.max(head.lastIndexOf(';'), head.lastIndexOf('function '));
    const stmt = head.slice(boundary + 1);

    assert.ok(!/\?/.test(stmt.replace(/\?\./g, '')),
      `a gate call is inside a conditional expression:\n        ${stmt.trim().replace(/\s+/g, ' ')}`);
    assert.ok(!/\|\||&&/.test(stmt),
      `a gate call is short-circuited by a boolean operator:\n        ${stmt.trim().replace(/\s+/g, ' ')}`);
    assert.ok(!/\bif\s*\(/.test(stmt),
      `a gate call sits inside an if-guard on the same statement:\n        ${stmt.trim().replace(/\s+/g, ' ')}`);
  }
});

test('7b. sendEmailDetailed accepts exactly one parameter', () => {
  // The bypass was a SECOND POSITIONAL ARGUMENT. A one-parameter signature is the thing that makes
  // every spelling in test 1c impossible rather than merely untested.
  const m = mailerCode.match(/async function sendEmailDetailed\(([\s\S]*?)\)\s*\{/);
  assert.ok(m, 'sendEmailDetailed could not be located — update this guard');
  const params = m[1];
  // One destructured options object: the brace pair closes, and nothing follows but whitespace.
  assert.ok(/^\s*\{[\s\S]*\}\s*$/.test(params),
    `sendEmailDetailed takes more than a single options object:\n        ${params.replace(/\s+/g, ' ').trim()}`);
  assert.ok(!/\binternal\b/.test(params),
    'the `internal` parameter is back in the signature');
});

test('7c. deliverAuthorized is private — it appears in no export', () => {
  assert.ok(/async function deliverAuthorized\s*\(/.test(mailerCode),
    'deliverAuthorized is gone — if the provider half was re-inlined, the gate is conditional again');
  const exportLines = (mailerCode.match(/module\.exports[\s\S]*?;/g) || []).join('\n')
    + (mailerCode.match(/exports\.\w+\s*=.*/g) || []).join('\n');
  assert.ok(!/deliverAuthorized/.test(exportLines),
    'deliverAuthorized is exported — the ungated provider half is reachable by name from all 22 '
    + 'modules that import this file, which is the bypass again with a different spelling');
});

test('7d. transmitAlert does not route through the exported function', () => {
  // If it did, its send would be gated as email.send (the alert capability is downgraded there) and
  // refused by the global STOP — test 3 covers that behaviourally, this says why.
  const i = mailerCode.indexOf('async function transmitAlert(');
  assert.ok(i > 0, 'transmitAlert could not be located — update this guard');
  const body = mailerCode.slice(i, i + 1600);
  assert.ok(!/sendEmailDetailed\s*\(/.test(body),
    'transmitAlert calls sendEmailDetailed, whose gate will refuse it under a global STOP');
  assert.ok(/deliverAuthorized\s*\(/.test(body),
    'transmitAlert no longer reaches the shared provider half — it may have grown a second transport');
});

// ══ PROVENANCE ON THE ALERT PATH ═══════════════════════════════════════════

test('an operator alert records WHICH alert it was, and still bypasses only the global hold', async () => {
  // CEO direction 2026-11-13 item 4. Found during containment verification: the single
  // PROVIDER_ACCEPTED row in production carried null workflow and null agent, so an alert was
  // attributable only by transport — and an alert is the one send that still happens under a total
  // hold, which makes it the one whose provenance matters most.
  //
  // Uses this file's OWN GLOBAL_STOP and ALERT fixtures. My first version invented its own, with
  // scope_key '' where the shared one uses null, and the gate's breadth logic treats those
  // differently — so it failed for a reason that had nothing to do with provenance.
  STOPS = GLOBAL_STOP;

  const r = await MAILER.sendOperatorAlert(ALERT);
  assert.strictEqual(r.ok, true, `the alert was not delivered under a global STOP: ${r.error}`);

  const att = ATTEMPTS[ATTEMPTS.length - 1];
  assert.ok(att, 'the alert opened no ledger attempt');
  assert.strictEqual(att.workflow, 'operator-alert',
    'the alert row carries no workflow, so it is attributable only by transport');
  assert.strictEqual(att.agent, `alert:${ALERT.type}`,
    'the alert row does not record WHICH alert it was');

  // UNCHANGED, asserted rather than assumed: still non-consequential, still no claimRef.
  assert.strictEqual(att.consequential, false,
    'the alert became consequential — the channel that reports breakage must not be taken out by it');
  assert.ok(!att.claimRef,
    'the alert was given a claimRef: the claim-uniqueness index would then make a SECOND alert of '
    + 'the same kind collide with the first and be refused, silencing the channel');
});

test('…and a deliberate email.alert stop still silences it', async () => {
  // The other half of "the exemption is unchanged": it exempts alerts from a GLOBAL hold, never
  // from oversight of the alert channel itself.
  STOPS = [{ scope_type: 'capability', scope_key: 'email.alert', reason: 'alert channel held' }];
  const before = SENDS.length;
  const r = await MAILER.sendOperatorAlert(ALERT);
  assert.strictEqual(r.ok, false, 'a capability:email.alert stop did not silence the alert path');
  assert.strictEqual(SENDS.length, before, 'the provider was invoked despite the alert stop');
});
