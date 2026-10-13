'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { readIncoming, newText, attachmentsOf, looksLikeCatalogue } = require('./incoming');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const mk = (parts, headers = {}) => ({
  payload: {
    headers: [
      { name: 'From', value: headers.From || 'Trevor Huang <trevor@formosalab.com>' },
      { name: 'Subject', value: headers.Subject || 'Re: Following up from CPHI Milan' },
      { name: 'Date', value: 'Tue, 13 Oct 2026 04:12:00 +0000' },
    ],
    parts,
  },
});
const textPart = (s) => ({ mimeType: 'text/plain', body: { data: b64(s) } });

// ── THE QUOTED THREAD IS THE NOISE, NOT THE MESSAGE ──────────────────────────

test('Gmail quoting is cut — only what they typed remains', () => {
  const body = `Dear Naren,

Please find attached our full product list, 43 molecules.

Best regards
Trevor

On Mon, 12 Oct 2026 at 17:08, Naren Boda <naren@abiozen.com> wrote:
> It was a real pleasure meeting you at CPHI in Milan
> One thing would help us move quickly: your full product list.`;
  const t = newText(body);
  assert.match(t, /43 molecules/);
  assert.ok(!/pleasure meeting you/.test(t), 'our own words must not be in the queue');
});

test('Outlook quoting is cut too — several clients, several markers', () => {
  const t = newText(`We can supply 12 of the molecules listed.

_______________________________
From: Naren Boda <naren@abiozen.com>
Sent: Monday, October 12, 2026 5:08 PM
Subject: Following up from CPHI Milan`);
  assert.strictEqual(t, 'We can supply 12 of the molecules listed.');
});

test('a Chinese Outlook header block is cut', () => {
  // Several suppliers on this list are in China and reply from Simplified Chinese clients.
  const t = newText(`您好，附件是我们的产品目录。\n\n发件人: Naren Boda\n主题: Following up`);
  assert.match(t, /产品目录/);
  assert.ok(!/发件人/.test(t));
});

test('a message with NO quote marker is kept, not discarded', () => {
  // Showing too much is a nuisance; showing nothing could hide the one line that matters.
  const t = newText('Send me the molecule list please.');
  assert.strictEqual(t, 'Send me the molecule list please.');
});

test('the signature block is trimmed at the RFC marker', () => {
  const t = newText('Noted, I will revert tomorrow.\n\n-- \nTrevor Huang\nFormosa Laboratories');
  assert.strictEqual(t, 'Noted, I will revert tomorrow.');
});

// ── ATTACHMENTS: THE CATALOGUE IS THE POINT ──────────────────────────────────

test('a spreadsheet attachment is found and flagged as a catalogue', () => {
  const m = readIncoming(mk([
    textPart('Attached, our product list.'),
    { filename: 'Formosa API list 2026.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: { attachmentId: 'ATT1', size: 84213 } },
  ]));
  assert.strictEqual(m.attachments.length, 1);
  assert.strictEqual(m.hasCatalogue, true);
  assert.strictEqual(m.attachments[0].size, 84213);
});

test('an inline signature logo is NOT counted as an attachment', () => {
  // A queue that reports "2 attachments" for a message carrying a logo and a QR code teaches you
  // to ignore the one column that matters.
  const m = readIncoming(mk([
    textPart('Please contact my colleague.'),
    { filename: 'logo.png', mimeType: 'image/png',
      headers: [{ name: 'Content-Disposition', value: 'inline; filename="logo.png"' }],
      body: { attachmentId: 'ATT9', size: 4096 } },
  ]));
  assert.strictEqual(m.attachments.length, 0);
  assert.strictEqual(m.hasCatalogue, false);
});

test('a genuine image attachment still counts', () => {
  // A photographed price list is a real answer, even though it is an image.
  const m = readIncoming(mk([
    textPart('Photo of our list.'),
    { filename: 'pricelist.jpg', mimeType: 'image/jpeg',
      headers: [{ name: 'Content-Disposition', value: 'attachment; filename="pricelist.jpg"' }],
      body: { attachmentId: 'ATT2', size: 220000 } },
  ]));
  assert.strictEqual(m.attachments.length, 1);
  assert.strictEqual(m.hasCatalogue, false, 'an image is an attachment but not a parseable catalogue');
});

test('catalogue detection covers the formats suppliers actually send', () => {
  for (const f of ['list.xlsx', 'list.xls', 'a.csv', 'catalogue.pdf', 'products.docx']) {
    assert.strictEqual(looksLikeCatalogue({ filename: f }), true, f);
  }
  for (const f of ['signature.png', 'card.vcf', 'archive.zip']) {
    assert.strictEqual(looksLikeCatalogue({ filename: f }), false, f);
  }
});

test('an HTML-only reply is readable, and our own quoted words still removed', () => {
  const m = readIncoming(mk([
    { mimeType: 'text/html', body: { data: b64(
      '<div>Dear Naren,<br><br>We supply <b>Metformin</b> and 20 others.</div>'
      + '<div>On Mon, 12 Oct 2026 at 17:08, Naren Boda wrote:</div><blockquote>your full product list</blockquote>') } },
  ]));
  assert.match(m.text, /Metformin/);
  assert.ok(!/your full product list/.test(m.text));
});

test('the sender address is extracted for matching against the contact', () => {
  const m = readIncoming(mk([textPart('ok')], { From: 'Zhu Jiang <Jiang.Zhu@XIANJUPHARM.com>' }));
  assert.strictEqual(m.fromEmail, 'jiang.zhu@xianjupharm.com', 'lowercased so it can be matched');
});

// ── A REPLY MUST NOT DROP THE PEOPLE THEY ADDED ──────────────────────────────

const { parseAddressList, otherParticipants } = require('./incoming');

test('a quoted display name containing a comma stays one address', () => {
  // Alivus copied in "Rakesh, K". Splitting on every comma made that two items — one with the
  // name mangled to "K" and one that was not an address at all.
  const list = parseAddressList('"Rakesh, K" <rakesh@alivus.com>, apisales@egis.hu');
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].name, 'Rakesh, K');
  assert.strictEqual(list[0].email, 'rakesh@alivus.com');
  assert.strictEqual(list[1].email, 'apisales@egis.hu');
});

test('fragments that are not addresses are dropped', () => {
  assert.deepStrictEqual(parseAddressList('not an address, , <>'), []);
  assert.deepStrictEqual(parseAddressList(''), []);
  assert.deepStrictEqual(parseAddressList(null), []);
});

test('the colleagues they copied in are kept, and we are not', () => {
  // Egis copied their Head of API Sales; Alivus named Rakesh the primary contact for the product
  // list. Replying to the sender alone cuts out the person who is going to send the catalogue.
  const payload = { headers: [
    { name: 'To', value: 'Naren Boda <naren@abiozen.com>' },
    { name: 'Cc', value: 'Head of API Sales <apisales@egis.hu>, Rakesh <rakesh@alivus.com>' },
  ] };
  const p = otherParticipants(payload, 'naren@abiozen.com');
  assert.deepStrictEqual(p.map((x) => x.email), ['apisales@egis.hu', 'rakesh@alivus.com']);
});

test('our own address is removed whatever its case, and duplicates collapse', () => {
  const payload = { headers: [
    { name: 'To', value: 'NAREN@ABIOZEN.COM, someone@x.com' },
    { name: 'Cc', value: 'Someone <SOMEONE@x.com>, other@y.com' },
  ] };
  const p = otherParticipants(payload, 'naren@abiozen.com');
  assert.deepStrictEqual(p.map((x) => x.email), ['someone@x.com', 'other@y.com']);
});

test('no Cc at all yields an empty list rather than throwing', () => {
  const p = otherParticipants({ headers: [{ name: 'To', value: 'naren@abiozen.com' }] }, 'naren@abiozen.com');
  assert.deepStrictEqual(p, []);
});
