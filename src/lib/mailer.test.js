// Mailer — run with:  node --test src/lib/mailer.test.js
//
// Two things are pinned here, and the second is the one that mattered:
//   1. the default sender is on a domain the Resend key is authorized for
//   2. a domain-authorization failure RAISES AN ALARM instead of returning false quietly
//
// The eight-week outage (4 Aug → 29 Sep 2026, 1,113 lost emails) was not caused by a missing check.
// Every layer did the right local thing: sendEmail returned false, the row went to email_log, no caller
// crashed. Nobody looks at email_log. The aggregate of correct local behaviour was total silence.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const db = require('../lib/db');
let SQL = [];            // every query the mailer ran
let NOTIFS = [];         // rows it inserted into notifications
let DUP = false;         // does a recent alert already exist?

// ── THE APPROVAL GATE, SATISFIED EXACTLY RATHER THAN WAVED THROUGH ──────────
//
// email-gate.js now refuses any send that leaves the company unless a RELEASED approval exists
// whose frozen payload hashes to the bytes about to be transmitted (CEO decision 2026-11-11,
// priority 1). Every fixture below addresses a@b.com, which is outside the company, so without
// an approval all of them would refuse for a reason that has nothing to do with the transport
// mechanics they exist to test.
//
// Two wrong ways to fix that, both of which this avoids. Re-pointing them at an internal address
// would stop them exercising the external path at all. Having the stub answer "approved" for any
// digest would make the digest comparison untested here while it looked satisfied — and one
// fixture ('not-an-address') would then pass for the WRONG REASON, reporting false because of a
// missing approval rather than because the address is invalid.
//
// So the stub CAPTURES the real digest from the ledger's own INSERT, which happens before the
// gate runs, and serves it back. The comparison is performed against the true value.
let APPROVE = true;      // is a released approval in force for the message under test?
let LAST_DIGEST = null;  // payload_digest, as the ledger recorded it for this attempt

// WHO IS EMPLOYED. Since 2026-11-24 the gate decides "internal" by ACTIVE MEMBERSHIP rather than
// by domain, because a departed employee's address is still on the company domain — the hole that
// has had all company email stopped since 3 November at a cost of 369 refused sends. A fixture
// that answers nothing here is asserting that nobody is employed, so a colleague's address refuses
// as a deactivated account and a test about transport mechanics fails for a reason that has
// nothing to do with transport. Every fixture below addresses a@b.com, which is outside the
// company either way, so this list exists for the cc tests at the end of the file.
let MEMBERS = ['naren@abiozen.com'];

db.query = async (sql, params = []) => {
  SQL.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
  if (/INSERT INTO email_log/i.test(sql)) {
    // ledger.beginAttempt: (..., correlation_id, outcome, approval_id, payload_digest, claim_ref)
    // → payload_digest is the 12th placeholder, params[11].
    LAST_DIGEST = params[11] || null;
    return { rows: [] };
  }
  if (/released_at, action_payload/i.test(sql)) {
    if (!APPROVE) return { rows: [] };
    return { rows: [{ id: params[0], status: 'approved', released_at: new Date(),
      action_payload: { transport_digest: LAST_DIGEST } }] };
  }
  // THE LEDGER'S SCHEMA PROBE. mailer now opens an outbound-ledger attempt before the gate and
  // FAILS CLOSED when the ledger columns are absent — so a fixture that answers "no columns" makes
  // every consequential send refuse for a reason that has nothing to do with what is being tested.
  // A migrated database is the honest fixture; the absent-schema case has its own control in
  // scripts/check-outbound-ledger-db.js.
  if (/information_schema\.columns/i.test(sql)) {
    return { rows: [{ n: require('./outbound/ledger-schema').ADDED_COLUMNS.length }] };
  }
  // RETURNING id, as a real UPDATE of an existing row does. claim() is the arbitration point now
  // and reads the returned row to know whether IT won the claim, so a stub answering every UPDATE
  // with zero rows makes the mailer refuse every send for a reason unrelated to these tests.
  if (/FROM users\s+WHERE is_active = 1/.test(sql)) {
    const wanted = params[0] || [];
    return { rows: MEMBERS.filter((e) => wanted.includes(e)).map((email) => ({ email })) };
  }
  if (/UPDATE email_log/i.test(sql)) return { rows: [{ id: params[0] }] };
  if (/SELECT 1 FROM notifications/i.test(sql)) return { rows: DUP ? [{ '?column?': 1 }] : [] };
  if (/INSERT INTO notifications/i.test(sql)) { NOTIFS.push(params); return { rows: [] }; }
  return { rows: [] };
};

const { sendEmail, defaultFrom, DEFAULT_FROM } = require('./mailer');
const { sendEmailDetailed: sendEmailDetailedX } = require('./mailer');

// Resend, faked at the fetch boundary.
let RESPONSES = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const next = RESPONSES.shift() || { id: 'ok-' + Math.random().toString(36).slice(2) };
  global.__lastSend = body;
  return { json: async () => next };
};

beforeEach(() => {
  SQL = []; NOTIFS = []; DUP = false; RESPONSES = []; APPROVE = true; LAST_DIGEST = null;
  delete process.env.MAIL_FROM;
});

test('the default sender is NOT abiozen.com — the key is not authorized for it', () => {
  assert.doesNotMatch(DEFAULT_FROM, /abiozen\.com/,
    'this is the exact value that failed 1,113 times; probed 2026-09-29: 403 from abiozen.com, 200 from adificetechnologies.com');
  assert.match(DEFAULT_FROM, /@adificetechnologies\.com>$/);
  assert.match(DEFAULT_FROM, /^[^<]+<[^@]+@[^>]+>$/, 'a display name plus an address, as Resend expects');
});

test('MAIL_FROM overrides it, so the domain is fixable without a deploy', () => {
  process.env.MAIL_FROM = 'X <y@example.com>';
  assert.equal(defaultFrom(), 'X <y@example.com>');
  delete process.env.MAIL_FROM;
  assert.equal(defaultFrom(), DEFAULT_FROM);
  assert.equal(defaultFrom({}), DEFAULT_FROM, 'an empty env still yields the default, never undefined');
});

test('a caller with no `from` gets the default; an explicit `from` is untouched', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  await sendEmail({ contentDay: 'timeless', to: 'a@b.com', subject: 's', html: '<p>h</p>', approvalId: 'ap-test' });
  assert.equal(global.__lastSend.from, DEFAULT_FROM);
  // The two customer-facing senders pass abiozen.com deliberately — a supplier must not receive an
  // Abiozen RFQ from another company's domain — so the override must not be rewritten.
  await sendEmail({ contentDay: 'timeless', to: 'a@b.com', subject: 's', html: 'h', approvalId: 'ap-test', from: 'Palash Das <palash@abiozen.com>' });
  assert.equal(global.__lastSend.from, 'Palash Das <palash@abiozen.com>');
});

// ── the alarm ───────────────────────────────────────────────────────────────────
test('a domain-authorization 403 RAISES a notification, not just a log row', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  RESPONSES = [{ statusCode: 403, message: 'This API key is not authorized to send emails from abiozen.com' }];
  const ok = await sendEmail({ contentDay: 'timeless', to: 'a@b.com', subject: 's', html: 'h', approvalId: 'ap-test', from: 'x@abiozen.com' });
  assert.equal(ok, false, 'the caller still sees a plain false — nothing throws');
  assert.equal(NOTIFS.length, 1, 'and somebody is told');
  assert.match(NOTIFS[0][0], /Email sending is broken for abiozen\.com/, 'the title names the domain');
  assert.match(NOTIFS[0][1], /will not recover on its own/, 'and says it is configuration, not a bad address');
  assert.ok(SQL.some(q => /INSERT INTO email_log/.test(q.sql)), 'the log row is still written');
});

test('the notification is PLATFORM-WIDE, so a partner account never sees it', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  RESPONSES = [{ statusCode: 403, message: 'This API key is not authorized to send emails from abiozen.com' }];
  await sendEmail({ contentDay: 'timeless', to: 'a@b.com', subject: 's', html: 'h', approvalId: 'ap-test' });
  const insert = SQL.find(q => /INSERT INTO notifications/.test(q.sql));
  assert.match(insert.sql, /VALUES \(NULL, 'email_channel'/,
    "product NULL means platform-wide, which requires the 'internal' pseudo-product");
});

test('it is deduped — the 6pm agent must not write one row per recipient per evening', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  DUP = true;
  RESPONSES = [{ statusCode: 403, message: 'This API key is not authorized to send emails from abiozen.com' }];
  await sendEmail({ contentDay: 'timeless', to: 'a@b.com', subject: 's', html: 'h', approvalId: 'ap-test' });
  assert.equal(NOTIFS.length, 0, 'a recent alert already exists, so this one is suppressed');
});

test('an ORDINARY failure does not raise the alarm', async () => {
  // One bad address is not a channel outage. Raising on every failure would train people to ignore it,
  // which is the same outcome as not raising at all.
  process.env.RESEND_API_KEY = 'test-key';
  RESPONSES = [{ statusCode: 422, message: 'Invalid `to` field' }];
  const ok = await sendEmail({ contentDay: 'timeless', to: 'not-an-address', subject: 's', html: 'h', approvalId: 'ap-test' });
  assert.equal(ok, false);
  assert.equal(NOTIFS.length, 0);
});

test('a failure to raise the alarm cannot break the send path', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  const saved = db.query;
  db.query = async (sql) => {
    if (/notifications/i.test(sql)) throw new Error('notifications table missing');
    return { rows: [] };
  };
  RESPONSES = [{ statusCode: 403, message: 'This API key is not authorized to send emails from abiozen.com' }];
  const ok = await sendEmail({ contentDay: 'timeless', to: 'a@b.com', subject: 's', html: 'h', approvalId: 'ap-test' });
  assert.equal(ok, false, 'returns normally rather than throwing into the caller');
  db.query = saved;
});

test('a missing API key is still handled, and is still not an alarm', async () => {
  const saved = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  assert.equal(await sendEmail({ contentDay: 'timeless', to: 'a@b.com', subject: 's', html: 'h', approvalId: 'ap-test' }), false);
  assert.equal(NOTIFS.length, 0);
  process.env.RESEND_API_KEY = saved;
});

test('cleanup: the real fetch is restored', () => {
  global.fetch = realFetch;
  assert.equal(typeof global.fetch, 'function');
});

// ── ATTACHMENTS, and the detailed result ──────────────────────────────────────

test('attachments: a Buffer is base64-encoded for the raw API', () => {
  const { encodeAttachments } = require('./mailer');
  const buf = Buffer.from('PK\x03\x04 pretend docx');
  const r = encodeAttachments([{ filename: 'c.docx', content: buf }]);
  assert.equal(r.ok, true);
  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].filename, 'c.docx');
  // THE BUG THIS PREVENTS: Resend's SDK takes a Buffer, the raw JSON endpoint does not. Passing one
  // through JSON.stringify yields {"0":80,"1":75,...}, which arrives as a file that will not open.
  assert.equal(typeof r.list[0].content, 'string');
  assert.equal(Buffer.from(r.list[0].content, 'base64').toString(), buf.toString(), 'round trips exactly');
});

test('attachments: a base64 string is passed through unchanged, not double-encoded', () => {
  const { encodeAttachments } = require('./mailer');
  const b64 = Buffer.from('hello').toString('base64');
  const r = encodeAttachments([{ filename: 'a.txt', content: b64 }]);
  assert.equal(r.list[0].content, b64, 'double-encoding would arrive as the literal base64 text');
});

test('attachments: the shapes that are refused', () => {
  const { encodeAttachments, MAX_ATTACH_BYTES } = require('./mailer');
  assert.deepEqual(encodeAttachments(undefined), { ok: true, list: null }, 'no attachments is fine');
  assert.equal(encodeAttachments('nope').ok, false);
  assert.match(encodeAttachments([{ content: Buffer.from('x') }]).error, /needs a filename/);
  assert.match(encodeAttachments([{ filename: 'a' }]).error, /needs a filename and content/);
  assert.match(encodeAttachments([{ filename: 'a', content: Buffer.alloc(0) }]).error, /is empty/,
    'an empty attachment means a client receives a 0-byte file');
  const big = encodeAttachments([{ filename: 'big', content: Buffer.alloc(MAX_ATTACH_BYTES + 1) }]);
  assert.equal(big.ok, false);
  assert.match(big.error, /over the \d+ MB limit/, 'refused here, because the provider error arrives after the upload');
});

test('attachments reach the request body, base64, under `attachments`', async () => {
  const { sendEmailDetailed } = require('./mailer');
  let sentBody = null;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { sentBody = JSON.parse(opts.body); return { json: async () => ({ id: 'msg_1' }) }; };
  try {
    const r = await sendEmailDetailed({ contentDay: 'timeless', to: 'a@b.com', subject: 's', html: 'h', approvalId: 'ap-test',
      attachments: [{ filename: 'SN-2026-0001.docx', content: Buffer.from('PK\x03\x04x') }] });
    assert.equal(r.ok, true);
    assert.equal(r.id, 'msg_1', 'the provider id is returned, so a caller can prove what it sent');
    assert.equal(sentBody.attachments.length, 1);
    assert.equal(sentBody.attachments[0].filename, 'SN-2026-0001.docx');
    assert.equal(Buffer.from(sentBody.attachments[0].content, 'base64').toString(), 'PK\x03\x04x');
  } finally { global.fetch = realFetch; }
});

test('sendEmail KEEPS its boolean contract — 55 callers depend on it', async () => {
  // Returning an object instead would make every `if (await sendEmail(...))` unconditionally true and
  // every failure path in the codebase go quiet, which is the exact shape of the eight-week outage this
  // file documents. So the detailed result is a SECOND function.
  const { sendEmail, sendEmailDetailed } = require('./mailer');
  const realFetch = global.fetch;
  global.fetch = async () => ({ json: async () => ({ id: 'msg_2' }) });
  try {
    assert.strictEqual(await sendEmail({ contentDay: 'timeless', to: 'a@b.com', subject: 's', html: 'h', approvalId: 'ap-test' }), true);
  } finally { global.fetch = realFetch; }
  global.fetch = async () => ({ json: async () => ({ message: 'nope' }) });
  try {
    assert.strictEqual(await sendEmail({ contentDay: 'timeless', to: 'a@b.com', subject: 's', html: 'h', approvalId: 'ap-test' }), false);
    const d = await sendEmailDetailed({ contentDay: 'timeless', to: 'a@b.com', subject: 's', html: 'h', approvalId: 'ap-test' });
    assert.deepEqual([d.ok, d.id, d.error], [false, null, 'nope']);
  } finally { global.fetch = realFetch; }
});

test('a refused attachment is logged and sends NOTHING', async () => {
  const { sendEmailDetailed } = require('./mailer');
  const realFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; return { json: async () => ({ id: 'x' }) }; };
  try {
    const r = await sendEmailDetailed({ contentDay: 'timeless', to: 'a@b.com', subject: 's', html: 'h', approvalId: 'ap-test',
      attachments: [{ filename: 'empty.docx', content: Buffer.alloc(0) }] });
    assert.equal(r.ok, false);
    assert.equal(called, false, 'the request must not be made at all');
  } finally { global.fetch = realFetch; }
});

// ── THE GATE MUST BE GIVEN THE cc, NOT MERELY BE CAPABLE OF JUDGING IT ──────
//
// Until 2026-11-24 sendEmailDetailed accepted `cc`, forwarded it to the provider as body.cc, and
// called assertSendAllowed with `to` ALONE — so an outside address in cc was transmitted without
// ever being classified, and the external-approval boundary never saw it.
//
// These two tests sit HERE, driving the real sendEmailDetailed, rather than in the gate's own
// suite, because every behavioural test of the gate passes while this bug is present: such a test
// hands the gate the very parameter the caller was forgetting to hand it. What has to be proved is
// the wiring. scripts/check-email-gate-recipient-coverage.js proves the same property at the call
// site, which catches a field added tomorrow; this proves it end to end today.

test('DECISIVE: an external cc is refused — the gate is actually given it', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  const realFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; return { json: async () => ({ id: 'x' }) }; };
  const saved = APPROVE;
  APPROVE = false;                       // no approval in force for anybody
  try {
    // contentDay is required even here — in fact ESPECIALLY here. B7.13's check runs BEFORE the
    // recipient gate (the cheaper, blunter question first), so a message with both problems
    // reports the day, and without this declaration this test would assert the gate's refusal and
    // be handed the day's instead: a true-sounding refusal for the wrong reason.
    const r = await sendEmailDetailedX({ contentDay: 'timeless',
      to: 'naren@abiozen.com', subject: 's', html: 'h',
      cc: 'buyer@acme.test' });
    assert.equal(r.ok, false, 'an outside party in cc must not ride out on an internal to');
    assert.equal(r.stopped, true);
    assert.match(r.error, /EXTERNAL_WITHOUT_APPROVAL/);
    assert.equal(called, false, 'and the provider is never called');
  } finally { global.fetch = realFetch; APPROVE = saved; }
});

// ── THE BINDING HOLE, NOW CLOSED (B7.6) ─────────────────────────────────────
//
// This replaces a test called "KNOWN LIMITATION: the approval digest does not bind cc, so an
// approved send can widen", which asserted the gap on purpose and said: "when that change lands,
// this test should FAIL and be rewritten as the positive assertion." It landed, it failed, and
// this is that assertion.
//
// v1 hashed `[to, subject, html || text || '']`. Each case below changes something that REACHES
// THE RECIPIENT and left that hash untouched, so a released approval authorized all of them.
test('the approval digest binds every field that reaches the recipient', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  const D = require('./mailer').approvedDigestOf;
  const base = { to: 'buyer@acme.test', subject: 's', html: 'h',
    from: 'A <a@adificetechnologies.com>', companyId: 'co-abiozen' };
  const b = D(base);

  const widened = [
    ['a cc nobody approved', { ...base, cc: 'someone-else@acme.test' }],
    ['a bcc nobody approved', { ...base, bcc: 'quiet@acme.test' }],
    ['a different company making the same send', { ...base, companyId: 'co-adifice' }],
    ['a different sender identity', { ...base, from: 'B <b@adificetechnologies.com>' }],
    ['a reply-to pointing somewhere else', { ...base, replyTo: 'elsewhere@acme.test' }],
    ['a text alternative swapped under an unchanged html part', { ...base, text: 'different' }],
    ['an attachment added', { ...base, attachments: [{ filename: 'x.pdf', content: Buffer.from('x') }] }],
    ['an attachment\'s CONTENT changed under the same filename',
      { ...base, attachments: [{ filename: 'x.pdf', content: Buffer.from('y') }] }],
    ['a second recipient added to to', { ...base, to: ['buyer@acme.test', 'extra@acme.test'] }],
  ];
  for (const [label, variant] of widened) {
    assert.notEqual(D(variant), b, `${label} must change the digest — v1 did not notice it`);
  }

  // And the binding must be STABLE, or every external send refuses for a reason unrelated to
  // authorization: address order and letter case are not part of the message.
  assert.equal(
    D({ ...base, to: ['buyer@acme.test', 'extra@acme.test'] }),
    D({ ...base, to: ['EXTRA@acme.test', 'Buyer@Acme.test'] }),
    'recipient order and case must not change the binding',
  );
  assert.match(b, /^v2:[0-9a-f]{64}$/, 'and it is the canonical versioned digest');
});

test('a v1 approval cannot authorize a send — it asks for fresh approval instead', async () => {
  // The security decision in this change. A stored v1 digest bound TO, the subject and one body,
  // so it cannot establish the company, sender, provider account, CC/BCC, both bodies or the
  // attachments of the message it supposedly approved. Honouring it would mean honouring a binding
  // that does not bind.
  //
  // Refusing is safe to do strictly because capability/email.send has been STOPPED in production
  // since 2026-11-03, so no live approval sits behind this: a stored v1 approval becomes a
  // re-approval request, not a lost send.
  process.env.RESEND_API_KEY = 'test-key';
  const realFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; return { json: async () => ({ id: 'x' }) }; };
  try {
    const legacy = require('./outbound/ledger').digestOf(
      { to: 'buyer@acme.test', subject: 's', html: 'h' });
    assert.match(legacy, /^[0-9a-f]{32}$/, 'the fixture really is a v1 digest');
    const r = await sendEmailDetailedX({ to: 'buyer@acme.test', subject: 's', html: 'h',
      approvalId: 'ap-legacy', expectedDigest: legacy });
    assert.equal(r.ok, false);
    assert.equal(r.digestVerdict, 'legacy_version');
    assert.equal(r.needsFreshApproval, true,
      'the caller is told this needs re-approval, not that the bytes changed');
    assert.equal(called, false, 'and nothing was transmitted');
  } finally { global.fetch = realFetch; }
});

// ── B7.13 AT THE SINK, NOT ONLY IN THE MODULE ───────────────────────────────
//
// content-day.test.js proves the control's logic. These two prove it is WIRED — that
// sendEmailDetailed consults it, refuses before the provider, and files the refusal where somebody
// looking for a send will find it. A control with perfect logic and no call site is rule 11.

test('B7.13: sendEmailDetailed refuses a message that declares no business day', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  const realFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; return { json: async () => ({ id: 'x' }) }; };
  try {
    const r = await sendEmailDetailedX({ to: 'naren@abiozen.com', subject: 's', html: 'h' });
    assert.equal(r.ok, false, 'an undeclared business day must not send');
    assert.equal(r.phase, 'content_day_not_declared');
    assert.equal(called, false, 'and the provider is never reached');
    assert.equal(r.providerResponded, false);
  } finally { global.fetch = realFetch; }
});

test('B7.13: a STALE business day is refused, and names the day it concerned', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  const realFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; return { json: async () => ({ id: 'x' }) }; };
  try {
    // The 2026-11-03 incident shape: content from three weeks ago released today.
    const r = await sendEmailDetailedX({ to: 'naren@abiozen.com', subject: 's', html: 'h',
      contentDay: '2026-11-05' });
    assert.equal(r.ok, false);
    assert.equal(r.phase, 'content_day_stale');
    assert.match(r.error, /2026-11-05/);
    assert.equal(called, false);
    // CONTROL: the identical send with TODAY declared is NOT refused by this gate. Without it,
    // the two assertions above would pass against a function that refuses everything.
    const ok = await sendEmailDetailedX({ to: 'naren@abiozen.com', subject: 's', html: 'h',
      contentDay: require('./agent-core').businessToday() });
    assert.notEqual(ok.phase, 'content_day_stale',
      'today was also refused as stale, so the comparison is not against the current day');
    assert.notEqual(ok.phase, 'content_day_not_declared');
  } finally { global.fetch = realFetch; }
});
