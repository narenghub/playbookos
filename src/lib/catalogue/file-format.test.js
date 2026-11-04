// ── IDENTIFYING A FILE BY ITS BYTES, AND OPENING AN ATTACHED EMAIL ──────────
//
//   node --test src/lib/catalogue/file-format.test.js
//
// The extractor routes attachments by filename extension, so `XNK-API-LIST-260924(2)(1).doc` was
// skipped on its name alone and three `.eml` attachments — holding Alivus's original product list,
// Chieron's unseen earlier reply, and ScinoPharm's product website — were reported as *"not a
// product list format"* and dropped.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { sniff, looksTextual } = require('./file-format');
const { partsOf, paramOf } = require('./rfc822');

const buf = (...bytes) => Buffer.from(bytes);

test('a file is identified by its bytes, not its name', () => {
  assert.equal(sniff(Buffer.from('%PDF-1.7\n...'), 'x.pdf').format, 'pdf');
  assert.equal(sniff(buf(0x50, 0x4b, 0x03, 0x04, 0, 0), 'x.xlsx').format, 'zip');
  assert.equal(sniff(buf(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0), 'x.doc').format, 'ole2');
  assert.equal(sniff(Buffer.from('{\\rtf1\\ansi'), 'x.doc').format, 'rtf');
  assert.equal(sniff(buf(0x89, 0x50, 0x4e, 0x47, 0x0d), 'x.png').format, 'png');
});

test('the Shanxi Tongda case: a .doc that is not a Word binary is caught', () => {
  // The reason to look before writing a parser. A supplier exporting from an unfamiliar tool
  // frequently produces RTF or HTML under a .doc name, and both are plain text.
  const asRtf = sniff(Buffer.from('{\\rtf1\\ansi\\deff0 Allopurinol 315-30-0}'), 'XNK-API-LIST.doc');
  assert.equal(asRtf.format, 'rtf');
  assert.equal(asRtf.readable, true, 'RTF is readable text and must not be reported as unreadable');
  assert.equal(asRtf.mismatch, true, 'a .doc holding RTF is exactly the mismatch worth reporting');

  const asHtml = sniff(Buffer.from('<html><body><table><tr><td>Allopurinol</td>'), 'list.doc');
  assert.equal(asHtml.format, 'html');
  assert.equal(asHtml.readable, true);
  assert.equal(asHtml.mismatch, true);

  // And a genuine Word binary is reported as such, NOT as readable — because this module
  // identifies and refuses to guess at extraction.
  const real = sniff(buf(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3), 'XNK-API-LIST.doc');
  assert.equal(real.format, 'ole2');
  assert.equal(real.readable, false, 'a legacy OLE2 binary must not be claimed readable');
  assert.equal(real.mismatch, false, '.doc holding OLE2 is exactly what the extension claims');
});

test('an image is unreadable and says so, without being confused for a skipped format', () => {
  const png = sniff(buf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a), 'InsertPic_82CA.png');
  assert.equal(png.readable, false);
  assert.equal(png.mismatch, false);
  assert.match(png.note, /screenshot|no text/i);
});

test('a NUL byte means binary, however much printable text surrounds it', () => {
  assert.equal(looksTextual(Buffer.from('Allopurinol\u0000315-30-0')), false);
  assert.equal(looksTextual(Buffer.from('Allopurinol,315-30-0\nBisoprolol,66722-44-9\n')), true);
  assert.equal(looksTextual(Buffer.alloc(0)), false, 'an empty buffer is not text');
});

test('an empty attachment is reported, not treated as an unknown format', () => {
  const r = sniff(Buffer.alloc(0), 'x.pdf');
  assert.equal(r.format, 'empty');
  assert.equal(r.readable, false);
});

// ── THE ATTACHED EMAIL ─────────────────────────────────────────────────────

// Shaped like the real thing: a forwarded message carrying a spreadsheet, which is what
// `RE: Book1.xlsx.eml` is.
const EML = [
  'From: Rakesh Singh <rakesh@alivus.com>',
  'To: palash@abiozen.com',
  'Cc: gautam.arora@alivus.com',
  'Subject: RE: Book1.xlsx',
  'Date: Mon, 15 Sep 2026 09:12:00 +0530',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="BOUND42"',
  '',
  '--BOUND42',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: 7bit',
  '',
  'Please find the entire product list attached.',
  '',
  '--BOUND42',
  'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="Book1.xlsx"',
  'Content-Disposition: attachment; filename="Book1.xlsx"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]).toString('base64'),
  '',
  '--BOUND42--',
  '',
].join('\r\n');

test('an attached email yields its own attachments, which is where the Alivus list is', () => {
  const r = partsOf(Buffer.from(EML, 'binary'));
  assert.equal(r.ok, true, r.reason);
  assert.match(r.subject, /Book1\.xlsx/);
  assert.match(r.from, /rakesh@alivus\.com/);
  // The provenance that matters: this message was addressed to the departed employee, and we hold
  // it because the supplier forwarded it to us. No access to his mailbox is required.
  assert.match(r.to, /palash@abiozen\.com/);

  const attachments = r.parts.filter((p) => p.isAttachment);
  assert.equal(attachments.length, 1, 'the spreadsheet was not found inside the message');
  assert.equal(attachments[0].filename, 'Book1.xlsx');
  // Decoded, and identifiable: the nested file is a real ZIP container, i.e. a genuine xlsx.
  assert.equal(sniff(attachments[0].bytes, attachments[0].filename).format, 'zip');

  // The body text survives too — a supplier's explanation of their own columns is evidence.
  const body = r.parts.find((p) => p.contentType === 'text/plain');
  assert.match(body.bytes.toString('utf8'), /entire product list attached/);
});

test('quoted-printable and bare-LF messages parse — both occur in the wild', () => {
  const qp = [
    'Subject: =?utf-8?Q?test?=',
    'Content-Type: text/plain',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Allopurinol =E2=80=94 315-30-0',
  ].join('\n');                                   // bare LF, not CRLF
  const r = partsOf(Buffer.from(qp, 'binary'));
  assert.equal(r.ok, true, r.reason);
  assert.match(r.parts[0].bytes.toString('utf8'), /Allopurinol/);
});

test('an unparseable message returns NOTHING, never a partial list', () => {
  // A half-parsed message that yields one of three attachments is worse than a failure, because
  // the two it missed are invisible — the same shape as a check that passes without executing.
  for (const bad of [Buffer.alloc(0), Buffer.from('this is not a message at all')]) {
    const r = partsOf(bad);
    assert.equal(r.ok, false);
    assert.deepEqual(r.parts, []);
    assert.ok(r.reason, 'a failure must say why');
  }
});

test('a filename survives quoting, RFC 2231 encoding and header folding', () => {
  assert.equal(paramOf('attachment; filename="Product List - Oct 1 2026.pdf"', 'filename'),
    'Product List - Oct 1 2026.pdf');
  assert.equal(paramOf('attachment; filename=list.csv', 'filename'), 'list.csv');
  assert.equal(paramOf("attachment; filename*=UTF-8''%E4%BA%A7%E5%93%81.pdf", 'filename'), '产品.pdf');
  // Folded across lines — the real `产品册子2026.pdf` case arrives this way from some clients.
  const folded = 'Content-Disposition: attachment;\r\n\tfilename="custom peptide list.pdf"';
  const { 'content-disposition': d } = require('./rfc822').parseHeaders(folded);
  assert.equal(paramOf(d, 'filename'), 'custom peptide list.pdf');
});

test('a nested multipart does not lose the inner attachment', () => {
  const nested = [
    'Content-Type: multipart/mixed; boundary="OUT"',
    '',
    '--OUT',
    'Content-Type: multipart/alternative; boundary="IN"',
    '',
    '--IN',
    'Content-Type: text/plain',
    '',
    'hello',
    '--IN--',
    '--OUT',
    'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="deep.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4').toString('base64'),
    '--OUT--',
  ].join('\r\n');
  const r = partsOf(Buffer.from(nested, 'binary'));
  assert.equal(r.ok, true, r.reason);
  const found = r.parts.filter((p) => p.isAttachment).map((p) => p.filename);
  assert.deepEqual(found, ['deep.pdf'], `inner attachment lost: ${JSON.stringify(r.parts.map((p) => p.filename))}`);
});
