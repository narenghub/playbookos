'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { readBounce, bounceQuery, domainAcceptsMail } = require('./bounces');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const msg = ({ from = '', subject = '', text = '', headers = {}, parts = null }) => ({
  payload: {
    headers: [
      { name: 'From', value: from }, { name: 'Subject', value: subject },
      { name: 'Date', value: 'Tue, 13 Oct 2026 06:00:00 +0000' },
      ...Object.entries(headers).map(([name, value]) => ({ name, value })),
    ],
    ...(parts ? { parts } : { body: { data: b64(text) } }),
  },
});

// A real Google DSN, trimmed to the parts that matter.
const GOOGLE_HARD = msg({
  from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
  subject: 'Delivery Status Notification (Failure)',
  parts: [
    { mimeType: 'text/plain', body: { data: b64('Your message could not be delivered.') } },
    { mimeType: 'message/delivery-status', body: { data: b64(
      'Reporting-MTA: dns; googlemail.com\n'
      + 'Action: failed\n'
      + 'Final-Recipient: rfc822; laura.yang@scipharmtech.com\n'
      + 'Status: 5.1.1\n'
      + "Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.\n") } },
  ],
});

test('a hard bounce is read, with the address and the reason', () => {
  const r = readBounce(GOOGLE_HARD);
  assert.strictEqual(r.isBounce, true);
  assert.deepStrictEqual(r.recipients, ['laura.yang@scipharmtech.com']);
  assert.strictEqual(r.status, '5.1.1');
  assert.strictEqual(r.permanent, true);
  assert.match(r.diagnostic, /does not exist/);
});

test('a 4.x.x bounce is NOT permanent — the address may be perfectly fine', () => {
  // Greylisting and busy servers produce these, and Gmail retries for days. Calling it permanent
  // means re-typing an address off a business card that was always correct.
  const soft = msg({
    from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Delay)',
    text: 'Action: delayed\nFinal-Recipient: rfc822; ming.zhang@kelun.com\nStatus: 4.2.2\n'
      + 'Diagnostic-Code: smtp; 452 4.2.2 Mailbox full, will retry\n',
  });
  const r = readBounce(soft);
  assert.strictEqual(r.isBounce, true);
  assert.strictEqual(r.permanent, false);
  assert.strictEqual(r.status, '4.2.2');
});

test('an Exchange NDR with no DSN part is still read', () => {
  // Not every server speaks RFC 3464 cleanly. Outlook sends prose plus X-Failed-Recipients.
  const r = readBounce(msg({
    from: 'postmaster@hetero.com', subject: 'Undeliverable: Following up from CPHI Milan',
    headers: { 'X-Failed-Recipients': 'murty.mokkarala@hetero.com' },
    text: "Your message to murty.mokkarala@hetero.com couldn't be delivered.",
  }));
  assert.strictEqual(r.isBounce, true);
  assert.deepStrictEqual(r.recipients, ['murty.mokkarala@hetero.com']);
});

test('an ORDINARY REPLY is not a bounce', () => {
  // The expensive mistake in the other direction: marking a real supplier reply as a failure and
  // "correcting" an address that works.
  const r = readBounce(msg({
    from: 'Trevor Huang <trevor@formosalab.com>',
    subject: 'Re: Following up from CPHI Milan — how we work, and a question',
    text: 'Dear Naren, attached is our full product list. Our catalogue covers 43 molecules.',
  }));
  assert.strictEqual(r.isBounce, false);
});

test('a reply that merely mentions failure is not a bounce', () => {
  const r = readBounce(msg({
    from: 'Eva del Alamo <eva@moehs.com>', subject: 'Re: CPHI Milan follow-up',
    text: 'Our last delivery failed QC so we are re-testing. Undeliverable batches are quarantined.',
  }));
  assert.strictEqual(r.isBounce, false, 'the word "undeliverable" mid-body must not make it a bounce');
});

test('an out-of-office is not a bounce either', () => {
  const r = readBounce(msg({
    from: 'Sonia Raut <sonia@zyduslife.com>', subject: 'Automatic reply: Following up from CPHI Milan',
    headers: { 'Auto-Submitted': 'auto-replied' }, text: 'I am out of the office until 20 October.',
  }));
  assert.strictEqual(r.isBounce, false);
});

test('a bounce with no status code is not ASSUMED permanent unless it says so', () => {
  const vague = readBounce(msg({
    from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)',
    text: 'Delivery to the following recipient failed.\nsomebody@example.com\n',
  }));
  assert.strictEqual(vague.isBounce, true);
  assert.strictEqual(vague.permanent, false);

  const worded = readBounce(msg({
    from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)',
    text: 'No such user here. somebody@example.com\n',
  }));
  assert.strictEqual(worded.permanent, true);
});

test('the search query is time-bounded and covers Exchange wording', () => {
  const q = bounceQuery(14);
  assert.match(q, /newer_than:14d/);
  assert.match(q, /mailer-daemon/);
  assert.match(q, /Undeliverable/);
  assert.match(bounceQuery(0), /newer_than:1d/, 'a zero window must not become newer_than:0d');
});

// ── MX: KNOWABLE WITHOUT SENDING ANYTHING ─────────────────────────────────────

test('a domain with MX records accepts mail', async () => {
  const r = await domainAcceptsMail('someone@abiozen.com',
    { resolveMx: async () => [{ exchange: 'aspmx.l.google.com', priority: 1 }] });
  assert.strictEqual(r.ok, true);
});

test('a domain with no MX cannot receive mail — knowable before sending', async () => {
  const r = await domainAcceptsMail('someone@typo-domain.com', { resolveMx: async () => [] });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /no MX/);
});

test('NXDOMAIN means the domain does not exist — a transcription error', async () => {
  const r = await domainAcceptsMail('someone@granulespharna.com', {
    resolveMx: async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }); },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /does not exist/);
});

test('a FAILED LOOKUP is null, never false', async () => {
  // The critical distinction. `false` sends Naren re-typing addresses off business cards; `null`
  // says "I could not check". Railway may have no outbound DNS, and that must not look like 50
  // bad addresses.
  const r = await domainAcceptsMail('someone@abiozen.com', {
    resolveMx: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }); },
  });
  assert.strictEqual(r.ok, null);
  assert.match(r.reason, /lookup failed/);
});

test('a malformed address is refused without a lookup', async () => {
  let called = false;
  const spy = { resolveMx: async () => { called = true; return []; } };
  assert.strictEqual((await domainAcceptsMail('not-an-email', spy)).ok, false);
  assert.strictEqual((await domainAcceptsMail('a@b', spy)).ok, false);
  assert.strictEqual((await domainAcceptsMail('', spy)).ok, false);
  assert.strictEqual(called, false);
});

// ── THE NINE REAL CPHI BOUNCES, 13 OCT ───────────────────────────────────────
//
// Pinned from production, verbatim. The first version of the audit told Naren to "re-check the
// address against the business card" for all nine, and that was wrong for five of them — four
// ambiguous policy rejections and one explicit sender block. Acting on that advice would have
// meant re-typing correct addresses and sending to them again from the same blocked domain,
// burning the contact twice and making the reputation problem worse.

const { classifyBounce } = require('./bounces');
const REAL = [
  ['Zhu Yijun',        '5.1.1', 'smtp; 551 5.1.1 recipient is not exist',                                   'bad_mailbox'],
  ['Phoebe Zhang',     '5.1.1', 'smtp; 550 verify address failed, User not found tijun.zhang@hisunpharm.com','bad_mailbox'],
  ['Baffy Xu',         '5.1.2', "smtp; DNS Error: DNS type 'mx' lookup of ritbio.cn responded with code NXDOMAIN", 'no_such_domain'],
  ['Wu Minnan',        '5.1.2', "smtp; DNS Error: DNS type 'mx' lookup of polymedt.com responded with code NXDOMAIN", 'no_such_domain'],
  ['Nureddin Mansour', '5.7.1', 'smtp; 554 5.7.1 Service unavailable; Sender address [naren@abiozen.com] blocked', 'sender_blocked'],
  ['Sanjay Joseph',    '5.4.1', 'smtp; 550 5.4.1 Recipient address rejected: Access denied.',                'policy_reject'],
  ['Sonia Raut',       '5.4.1', 'smtp; 550 5.4.1 Recipient address rejected: Access denied.',                'policy_reject'],
  ['Eva del Alamo',    '5.7.0', 'smtp; 550 permanent failure for one or more recipients (edelalamo@moehs.es:550 5.4.1 Recipient address rejected: Access denied.)', 'policy_reject'],
  ['Swati Thakarda',   '5.7.0', 'smtp; 550 #5.1.0 Address rejected.',                                        'policy_reject'],
];

test('each of the nine real bounces is classified by its actual cause', () => {
  for (const [who, status, diagnostic, want] of REAL) {
    const got = classifyBounce({ status, diagnostic, subject: '' }).kind;
    assert.strictEqual(got, want, `${who}: expected ${want}, got ${got}`);
  }
});

test('an explicit sender block is NOT filed as ambiguous', () => {
  // Olon names our own address. The containing regex must allow dots, because the blocked address
  // has them — excluding dots put the clearest case in the ambiguous bucket.
  const c = classifyBounce({ status: '5.7.1',
    diagnostic: 'smtp; 554 5.7.1 Service unavailable; Sender address [naren@abiozen.com] blocked' });
  assert.strictEqual(c.kind, 'sender_blocked');
  assert.match(c.advice, /probably FINE/);
  assert.match(c.advice, /Re-typing it will not help/);
});

test('a dead domain tells him to check the domain, not the mailbox', () => {
  const c = classifyBounce({ status: '5.1.2', diagnostic: "DNS type 'mx' lookup of polymedt.com responded with code NXDOMAIN" });
  assert.strictEqual(c.kind, 'no_such_domain');
  assert.match(c.advice, /DOMAIN does not exist/);
});

test('ambiguous really says ambiguous, instead of guessing', () => {
  // Microsoft returns 5.4.1 Access denied both for a wrong address and for refusing the sender.
  // The two actions are opposite, so inventing a verdict is worse than naming the uncertainty.
  const c = classifyBounce({ status: '5.4.1', diagnostic: 'Recipient address rejected: Access denied.' });
  assert.strictEqual(c.kind, 'policy_reject');
  assert.match(c.advice, /AMBIGUOUS/);
});

test('a supplier reply mentioning "blocked" is not read as a sender block', () => {
  const c = classifyBounce({ status: null, diagnostic: 'Our shipment was blocked at customs', subject: 'Re: CPHI Milan' });
  assert.strictEqual(c.kind, 'unknown');
});
