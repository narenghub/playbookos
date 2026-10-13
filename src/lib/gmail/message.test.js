'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildMessage, formatAddress, encodeHeaderWord, toBase64Url } = require('./message');

const FROM = { name: 'Naren Boda', email: 'naren@abiozen.com' };
const TO = { name: 'Quyen Nguyen', email: 'quyen.nguyen@tapi.com' };
const BASE = { from: FROM, to: TO, subject: 'Following up from CPHI Milan',
               html: '<p>Hello</p>', text: 'Hello' };

const decode = (m) => m.mime;

// ── THREADING, WHICH IS THE PART THAT GIVES IT AWAY ─────────────────────────────

test('a follow-up carries In-Reply-To AND References, not just one', () => {
  // Gmail groups by threadId, but every OTHER client in the thread — including the recipient's —
  // uses these headers. Setting only threadId threads correctly in Naresh's mailbox and
  // incorrectly in theirs, which is exactly the wrong way round.
  const first = buildMessage(BASE);
  const second = buildMessage({ ...BASE, subject: 'Re: Following up from CPHI Milan',
    inReplyTo: first.messageId });
  assert.strictEqual(second.headers['In-Reply-To'], first.messageId);
  assert.ok(second.headers.References.includes(first.messageId));
});

test('References carries the whole chain, oldest first, parent last', () => {
  // A client that cannot find the parent at the end of References starts a new thread.
  const a = '<a@abiozen.com>', b = '<b@abiozen.com>';
  const m = buildMessage({ ...BASE, inReplyTo: b, references: [a] });
  assert.strictEqual(m.headers.References, `${a} ${b}`);
});

test('a parent already present in References is not duplicated', () => {
  const a = '<a@abiozen.com>', b = '<b@abiozen.com>';
  const m = buildMessage({ ...BASE, inReplyTo: b, references: [a, b] });
  assert.strictEqual(m.headers.References, `${a} ${b}`);
});

test('the Message-ID is known BEFORE the send, so it can be stored', () => {
  // If Gmail assigns it, the only way to learn it is to read the sent message back — and a
  // follow-up that cannot cite the previous Message-ID cannot thread.
  const m = buildMessage(BASE);
  assert.match(m.messageId, /^<[^>]+@abiozen\.com>$/);
  assert.ok(m.mime.includes(`Message-ID: ${m.messageId}`));
  assert.notStrictEqual(buildMessage(BASE).messageId, m.messageId, 'must be unique per message');
});

// ── NOTHING THAT SAYS "A MACHINE SENT THIS" ─────────────────────────────────────

test('no bulk, tracking or unsubscribe headers are emitted', () => {
  const m = buildMessage({ ...BASE, attachments: [{ filename: 'x.pdf', content: Buffer.from('%PDF-1.4') }] });
  const mime = decode(m);
  for (const h of ['List-Unsubscribe', 'Precedence', 'X-Mailer', 'Auto-Submitted',
                   'X-Campaign', 'List-Id', 'Bulk']) {
    assert.ok(!new RegExp(`^${h}:`, 'mi').test(mime), `${h} must not be present`);
  }
});

// ── ENCODING, WHICH FAILS ON THE FIRST ACCENTED NAME ────────────────────────────

test('a non-ASCII display name is RFC 2047 encoded, not sent raw', () => {
  const m = buildMessage({ ...BASE, to: { name: 'José Álvarez', email: 'jose@example.com' } });
  assert.match(m.headers.To, /=\?UTF-8\?B\?/);
  assert.ok(!/José/.test(m.headers.To), 'raw UTF-8 in a header is not valid');
});

test('a multi-byte character is never split across two encoded-words', () => {
  // The bug this guards: slicing by characters-as-bytes produces two broken encoded-words and a
  // mojibake name in the recipient's client.
  const long = '日本語のとても長い会社名前'.repeat(4);
  const enc = encodeHeaderWord(long);
  const decoded = enc.split(/\r\n /).map((w) => {
    const m = /^=\?UTF-8\?B\?(.*)\?=$/.exec(w);
    return Buffer.from(m[1], 'base64');
  });
  assert.strictEqual(Buffer.concat(decoded).toString('utf8'), long, 'round trip must be exact');
});

test('an ASCII name is left alone — encoding everything looks machine-made', () => {
  assert.strictEqual(encodeHeaderWord('Naren Boda'), 'Naren Boda');
  assert.strictEqual(formatAddress('Naren Boda', 'naren@abiozen.com'), 'Naren Boda <naren@abiozen.com>');
});

test('a display name with a comma is quoted, or the address parses wrong', () => {
  assert.strictEqual(formatAddress('Boda, Naren', 'naren@abiozen.com'), '"Boda, Naren" <naren@abiozen.com>');
});

test('an accented body survives the round trip', () => {
  const text = 'Grüße aus Chicago — Québec';
  const m = buildMessage({ ...BASE, text, html: `<p>${text}</p>` });
  const parts = m.mime.split(/\r\n\r\n/);
  const decoded = parts.map((p) => {
    try { return Buffer.from(p.replace(/\r\n/g, ''), 'base64').toString('utf8'); } catch { return ''; }
  }).join('\n');
  assert.ok(decoded.includes(text), 'the body must decode back to the original');
});

// ── STRUCTURE ───────────────────────────────────────────────────────────────────

test('with an attachment: multipart/mixed wrapping multipart/alternative', () => {
  const m = buildMessage({ ...BASE, attachments: [
    { filename: 'abiozen-model.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 test') },
  ] });
  assert.match(m.mime, /Content-Type: multipart\/mixed; boundary="/);
  assert.match(m.mime, /Content-Type: multipart\/alternative; boundary="/);
  assert.match(m.mime, /Content-Type: application\/pdf; name="abiozen-model\.pdf"/);
  assert.match(m.mime, /Content-Disposition: attachment; filename="abiozen-model\.pdf"/);
  // Both boundaries must be closed, or clients show the message as truncated.
  const mix = /boundary="(----=_mix_[a-f0-9]+)"/.exec(m.mime)[1];
  const alt = /boundary="(----=_alt_[a-f0-9]+)"/.exec(m.mime)[1];
  assert.ok(m.mime.includes(`--${mix}--`), 'mixed boundary must be closed');
  assert.ok(m.mime.includes(`--${alt}--`), 'alternative boundary must be closed');
  assert.notStrictEqual(mix, alt, 'nested parts need distinct boundaries');
});

test('without an attachment: multipart/alternative at the top, no empty mixed wrapper', () => {
  const m = buildMessage(BASE);
  assert.match(m.mime, /^Content-Type: multipart\/alternative/m);
  assert.ok(!/multipart\/mixed/.test(m.mime));
});

test('both a text and an HTML part are always present', () => {
  const m = buildMessage(BASE);
  assert.match(m.mime, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(m.mime, /Content-Type: text\/html; charset="UTF-8"/);
});

test('an HTML-only message is REFUSED rather than silently given a stripped text part', () => {
  // Auto-generating the text part by removing tags produces something that reads like a machine
  // wrote it — which is what a reader on a watch or in a text client actually sees.
  assert.throws(() => buildMessage({ ...BASE, text: '' }), /text is required/);
});

test('headers use CRLF and the body is base64url for the Gmail API', () => {
  const m = buildMessage(BASE);
  assert.ok(m.mime.includes('\r\n'), 'RFC 5322 requires CRLF');
  assert.ok(!/[+/=]/.test(m.raw), 'base64url has no +, / or padding');
  assert.strictEqual(Buffer.from(m.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').slice(0, 5), 'From:');
});

test('base64 body lines are wrapped at 76 columns, as RFC 2045 requires', () => {
  const m = buildMessage({ ...BASE, text: 'x'.repeat(500), html: '<p>' + 'y'.repeat(500) + '</p>' });
  for (const line of m.mime.split('\r\n')) {
    assert.ok(line.length <= 998, 'no line may exceed the RFC 5322 hard limit');
  }
  const b64Lines = m.mime.split('\r\n').filter((l) => /^[A-Za-z0-9+/]{40,}={0,2}$/.test(l));
  assert.ok(b64Lines.length > 1, 'a long body must be wrapped across lines');
  for (const l of b64Lines) assert.ok(l.length <= 76, `line of ${l.length} exceeds 76`);
});

test('missing required fields fail loudly rather than sending something malformed', () => {
  assert.throws(() => buildMessage({ ...BASE, from: null }), /from\.email/);
  assert.throws(() => buildMessage({ ...BASE, to: {} }), /to\.email/);
  assert.throws(() => buildMessage({ ...BASE, html: '' }), /html is required/);
  assert.throws(() => buildMessage({ ...BASE, attachments: [{ filename: 'a.pdf' }] }), /filename and content/);
});

// ── Cc ───────────────────────────────────────────────────────────────────────

test('Cc is written, deduplicated, and never contains us or the To address', () => {
  const m = buildMessage({
    from: { name: 'Naren Boda', email: 'naren@abiozen.com' },
    to: { name: 'Viktoria Sebők', email: 'sebok.viktoria@egis.hu' },
    cc: [
      { name: 'Head of API Sales', email: 'apisales@egis.hu' },
      'rakesh@alivus.com',
      'SEBOK.VIKTORIA@egis.hu',     // the To address again, different case
      'naren@abiozen.com',          // ourselves
      { name: 'Dup', email: 'APISALES@egis.hu' },
    ],
    subject: 'Re: CPHI Milan', text: 'Hi Viktoria,\n\nThanks.', html: '<p>Hi Viktoria,</p>',
  });
  const raw = Buffer.from(m.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const cc = raw.split('\n').find((l) => /^Cc:/i.test(l));
  assert.ok(cc, 'no Cc header was written');
  assert.match(cc, /apisales@egis\.hu/);
  assert.match(cc, /rakesh@alivus\.com/);
  assert.ok(!/sebok\.viktoria/i.test(cc), 'the To recipient must not also be Cc\'d');
  assert.ok(!/naren@abiozen\.com/i.test(cc), 'we must never Cc ourselves');
  assert.strictEqual((cc.match(/@/g) || []).length, 2, 'duplicates must collapse');
});

test('no Cc means no Cc header at all', () => {
  const m = buildMessage({
    from: { name: 'Naren Boda', email: 'naren@abiozen.com' },
    to: { name: 'Lina', email: 'lina@hrbjxl.cn' },
    subject: 'Re: CPHI', text: 'Hi Lina,\n\nThanks.', html: '<p>Hi Lina,</p>',
  });
  const raw = Buffer.from(m.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.ok(!/^Cc:/im.test(raw), 'an empty Cc header must not be emitted');
});
