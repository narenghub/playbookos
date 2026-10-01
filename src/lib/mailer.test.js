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
db.query = async (sql, params = []) => {
  SQL.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
  if (/INSERT INTO email_log/i.test(sql)) return { rows: [] };
  if (/SELECT 1 FROM notifications/i.test(sql)) return { rows: DUP ? [{ '?column?': 1 }] : [] };
  if (/INSERT INTO notifications/i.test(sql)) { NOTIFS.push(params); return { rows: [] }; }
  return { rows: [] };
};

const { sendEmail, defaultFrom, DEFAULT_FROM } = require('./mailer');

// Resend, faked at the fetch boundary.
let RESPONSES = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const next = RESPONSES.shift() || { id: 'ok-' + Math.random().toString(36).slice(2) };
  global.__lastSend = body;
  return { json: async () => next };
};

beforeEach(() => { SQL = []; NOTIFS = []; DUP = false; RESPONSES = []; delete process.env.MAIL_FROM; });

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
  await sendEmail({ to: 'a@b.com', subject: 's', html: '<p>h</p>' });
  assert.equal(global.__lastSend.from, DEFAULT_FROM);
  // The two customer-facing senders pass abiozen.com deliberately — a supplier must not receive an
  // Abiozen RFQ from another company's domain — so the override must not be rewritten.
  await sendEmail({ to: 'a@b.com', subject: 's', html: 'h', from: 'Palash Das <palash@abiozen.com>' });
  assert.equal(global.__lastSend.from, 'Palash Das <palash@abiozen.com>');
});

// ── the alarm ───────────────────────────────────────────────────────────────────
test('a domain-authorization 403 RAISES a notification, not just a log row', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  RESPONSES = [{ statusCode: 403, message: 'This API key is not authorized to send emails from abiozen.com' }];
  const ok = await sendEmail({ to: 'a@b.com', subject: 's', html: 'h', from: 'x@abiozen.com' });
  assert.equal(ok, false, 'the caller still sees a plain false — nothing throws');
  assert.equal(NOTIFS.length, 1, 'and somebody is told');
  assert.match(NOTIFS[0][0], /Email sending is broken for abiozen\.com/, 'the title names the domain');
  assert.match(NOTIFS[0][1], /will not recover on its own/, 'and says it is configuration, not a bad address');
  assert.ok(SQL.some(q => /INSERT INTO email_log/.test(q.sql)), 'the log row is still written');
});

test('the notification is PLATFORM-WIDE, so a partner account never sees it', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  RESPONSES = [{ statusCode: 403, message: 'This API key is not authorized to send emails from abiozen.com' }];
  await sendEmail({ to: 'a@b.com', subject: 's', html: 'h' });
  const insert = SQL.find(q => /INSERT INTO notifications/.test(q.sql));
  assert.match(insert.sql, /VALUES \(NULL, 'email_channel'/,
    "product NULL means platform-wide, which requires the 'internal' pseudo-product");
});

test('it is deduped — the 6pm agent must not write one row per recipient per evening', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  DUP = true;
  RESPONSES = [{ statusCode: 403, message: 'This API key is not authorized to send emails from abiozen.com' }];
  await sendEmail({ to: 'a@b.com', subject: 's', html: 'h' });
  assert.equal(NOTIFS.length, 0, 'a recent alert already exists, so this one is suppressed');
});

test('an ORDINARY failure does not raise the alarm', async () => {
  // One bad address is not a channel outage. Raising on every failure would train people to ignore it,
  // which is the same outcome as not raising at all.
  process.env.RESEND_API_KEY = 'test-key';
  RESPONSES = [{ statusCode: 422, message: 'Invalid `to` field' }];
  const ok = await sendEmail({ to: 'not-an-address', subject: 's', html: 'h' });
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
  const ok = await sendEmail({ to: 'a@b.com', subject: 's', html: 'h' });
  assert.equal(ok, false, 'returns normally rather than throwing into the caller');
  db.query = saved;
});

test('a missing API key is still handled, and is still not an alarm', async () => {
  const saved = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  assert.equal(await sendEmail({ to: 'a@b.com', subject: 's', html: 'h' }), false);
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
    const r = await sendEmailDetailed({ to: 'a@b.com', subject: 's', html: 'h',
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
    assert.strictEqual(await sendEmail({ to: 'a@b.com', subject: 's', html: 'h' }), true);
  } finally { global.fetch = realFetch; }
  global.fetch = async () => ({ json: async () => ({ message: 'nope' }) });
  try {
    assert.strictEqual(await sendEmail({ to: 'a@b.com', subject: 's', html: 'h' }), false);
    const d = await sendEmailDetailed({ to: 'a@b.com', subject: 's', html: 'h' });
    assert.deepEqual([d.ok, d.id, d.error], [false, null, 'nope']);
  } finally { global.fetch = realFetch; }
});

test('a refused attachment is logged and sends NOTHING', async () => {
  const { sendEmailDetailed } = require('./mailer');
  const realFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; return { json: async () => ({ id: 'x' }) }; };
  try {
    const r = await sendEmailDetailed({ to: 'a@b.com', subject: 's', html: 'h',
      attachments: [{ filename: 'empty.docx', content: Buffer.alloc(0) }] });
    assert.equal(r.ok, false);
    assert.equal(called, false, 'the request must not be made at all');
  } finally { global.fetch = realFetch; }
});
