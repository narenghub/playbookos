'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { replyState, isAutomated, addressOf } = require('./thread');

const SELF = 'naren@abiozen.com';
const msg = (from, subject, extraHeaders = {}, labelIds = []) => ({
  labelIds,
  payload: { headers: [
    { name: 'From', value: from },
    { name: 'Subject', value: subject },
    { name: 'Date', value: 'Mon, 12 Oct 2026 09:00:00 +0000' },
    ...Object.entries(extraHeaders).map(([name, value]) => ({ name, value })),
  ] },
});
const gmailWith = (messages) => ({ users: { threads: { get: async () => ({ data: { messages } }) } } });

test('our own message alone is not a reply', async () => {
  const s = await replyState(gmailWith([msg(`Naren Boda <${SELF}>`, 'Following up from CPHI Milan')]), 't1', SELF);
  assert.strictEqual(s.replied, false);
  assert.strictEqual(s.fromUs.length, 1);
});

test('a message from the recipient IS a reply, and halts the sequence', async () => {
  const s = await replyState(gmailWith([
    msg(`Naren Boda <${SELF}>`, 'Following up from CPHI Milan'),
    msg('Quyen Nguyen <quyen.nguyen@tapi.com>', 'Re: Following up from CPHI Milan'),
  ]), 't1', SELF);
  assert.strictEqual(s.replied, true);
  assert.strictEqual(s.fromThem.length, 1);
});

// ── THE QUIET FAILURE: AN OUT-OF-OFFICE SILENTLY KILLING A SEQUENCE ────────────

test('an "Automatic reply" is NOT a reply', async () => {
  // Somebody on leave until the 20th. Marking them replied means they are never followed up, and
  // from the outside that looks exactly like a sequence working correctly. Nobody finds out.
  const s = await replyState(gmailWith([
    msg(`Naren Boda <${SELF}>`, 'Following up from CPHI Milan'),
    msg('Quyen Nguyen <quyen.nguyen@tapi.com>', 'Automatic reply: Following up from CPHI Milan',
      { 'Auto-Submitted': 'auto-replied' }),
  ]), 't1', SELF);
  assert.strictEqual(s.replied, false, 'an auto-responder must not halt the sequence');
  assert.strictEqual(s.autoReplies.length, 1, 'but it must be recorded');
});

test('every auto-responder header shape is caught', async () => {
  for (const headers of [
    { 'Auto-Submitted': 'auto-replied' },
    { 'Auto-Submitted': 'auto-generated' },
    { 'X-Autoreply': 'yes' },
    { 'X-Autorespond': 'yes' },
    { 'Precedence': 'auto_reply' },
    { 'Precedence': 'bulk' },
    { 'X-Failed-Recipients': 'someone@example.com' },
  ]) {
    const s = await replyState(gmailWith([
      msg(`Naren <${SELF}>`, 'Following up'),
      msg('Someone <someone@tapi.com>', 'Re: Following up', headers),
    ]), 't1', SELF);
    assert.strictEqual(s.replied, false, `${JSON.stringify(headers)} should be automated`);
  }
});

test('a bounce is not a reply either', async () => {
  const s = await replyState(gmailWith([
    msg(`Naren <${SELF}>`, 'Following up'),
    msg('Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
      'Delivery Status Notification (Failure)'),
  ]), 't1', SELF);
  assert.strictEqual(s.replied, false);
  assert.strictEqual(s.autoReplies.length, 1);
});

test('the subject test is ANCHORED, so a real reply is never swallowed', async () => {
  // The cost of missing an auto-reply is one extra follow-up to somebody on holiday. The cost of
  // misreading a real one is silence towards somebody who answered. The test is narrow on purpose.
  assert.ok(isAutomated({ subject: 'Automatic reply: your note' }));
  assert.ok(isAutomated({ subject: 'Out of office until 20 October' }));
  assert.ok(!isAutomated({ subject: 'Re: your note — no automatic reply needed' }),
    'a person mentioning the words must not be classified as a machine');
  // The one that nearly got away: my first version of this assertion could not fail. "Automatic
  // quotes attached" STARTS with "Automatic" and is a person sending a price list — the anchored
  // pattern requires "automatic reply" or "automatic response", so this is correctly a reply.
  assert.strictEqual(isAutomated({ subject: 'Automatic quotes attached for your review' }), false,
    'a supplier sending quotes must not be classified as an auto-responder');
  assert.strictEqual(isAutomated({ subject: 'Re: CPHI follow-up' }), false);
});

test('a genuine reply whose subject merely starts with a trigger word still counts', async () => {
  // "Out of office" anchored is an auto-reply. But a supplier writing "Out of stock until March"
  // is a person with real information, and halting on it is correct — it must be read as a reply.
  const s = await replyState(gmailWith([
    msg(`Naren <${SELF}>`, 'Following up'),
    msg('Supplier <s@tapi.com>', 'Out of stock until March — can we talk in Q2?'),
  ]), 't1', SELF);
  assert.strictEqual(s.replied, true, 'that is a person answering, not a machine');
});

test('a third party joining the thread counts as a reply', async () => {
  // "I am glad to be pointed their way" is in the supplier email, so a colleague answering instead
  // is a SUCCESS, not something to follow up past.
  const s = await replyState(gmailWith([
    msg(`Naren <${SELF}>`, 'Following up'),
    msg('Colleague <colleague@tapi.com>', 'Re: Following up — I handle API supply'),
  ]), 't1', SELF);
  assert.strictEqual(s.replied, true);
});

test('the sending mailbox is matched by ADDRESS, not by display name', async () => {
  // Our own messages carry a display name that changes; the address does not.
  const s = await replyState(gmailWith([
    msg(`Abiozen CEO <${SELF.toUpperCase()}>`, 'Following up'),
  ]), 't1', SELF);
  assert.strictEqual(s.replied, false, 'case must not make our own message look like a reply');
  assert.strictEqual(addressOf('Naren Boda <NAREN@ABIOZEN.COM>'), 'naren@abiozen.com');
  assert.strictEqual(addressOf('plain@example.com'), 'plain@example.com');
});

// ── FAIL CLOSED ────────────────────────────────────────────────────────────────

test('a lookup that THROWS returns null, never false', async () => {
  // "I could not tell" must not read as "nobody replied, send the next one". The caller skips,
  // which costs a day and risks nothing.
  const broken = { users: { threads: { get: async () => { throw new Error('backendError'); } } } };
  const s = await replyState(broken, 't1', SELF);
  assert.strictEqual(s.replied, null);
  assert.match(s.error, /backendError/);
});

test('a missing threadId or mailbox is null, not false', async () => {
  assert.strictEqual((await replyState(gmailWith([]), null, SELF)).replied, null);
  assert.strictEqual((await replyState(gmailWith([]), 't1', '')).replied, null);
});

test('an empty thread is not a reply, but is not an error either', async () => {
  const s = await replyState(gmailWith([]), 't1', SELF);
  assert.strictEqual(s.replied, false);
  assert.strictEqual(s.messageCount, 0);
});
