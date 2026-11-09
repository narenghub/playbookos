// ── WHAT TRIAGE MUST NOT DO ──────────────────────────────────────────────────
//
//   node --test src/lib/agents/inquiry-triage.test.js
//
// The whole value of this module is a promise: it reads, labels and drafts, and it does not send.
// A promise in a comment is not a control, so the first test reads this module's own source and
// asserts the absence of every way Gmail can send. It is deliberately crude — a string search —
// because the thing it is defending against is somebody adding a convenience later and nobody
// noticing. The rest covers the classifier and the draft rules, where a confident wrong answer is
// the failure that matters.

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./inquiry-triage');

const RAW = fs.readFileSync(path.join(__dirname, 'inquiry-triage.js'), 'utf8');

// COMMENTS ARE STRIPPED BEFORE SCANNING. The header of the module under test explains that it
// never calls /messages/send — and the first version of this test matched that sentence and failed
// on the prose describing the rule it was enforcing. Four source-reading tests in this repository
// have now been broken the same way. Blanked rather than deleted, so line numbers in any failure
// message still line up with the file.
const SOURCE = RAW
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

test('the module contains no way to send mail — asserted against its own source', () => {
  // Gmail sends through /messages/send or /drafts/send. Neither may appear.
  assert.ok(!/messages\/send/.test(SOURCE), 'a messages/send endpoint is present');
  assert.ok(!/drafts\/[^'"`]*\/send|drafts\/send/.test(SOURCE), 'a drafts send endpoint is present');
  // The mailer is the other route out. It must not be imported.
  assert.ok(!/require\(['"][^'"]*mailer['"]\)/.test(SOURCE), 'the mailer is imported');
  assert.ok(!/sendEmail|sendWhatsApp/.test(SOURCE), 'a send helper is referenced');
  // And the token must not request the send scope. A token that cannot send is a stronger
  // guarantee than code that chooses not to.
  assert.ok(!/gmailSend/.test(SOURCE), 'the gmail send scope is requested');
});

test('every category the owner asked for exists, plus spam', () => {
  assert.deepStrictEqual([...T.CATEGORIES].sort(),
    ['buyer', 'inquiry', 'rfq', 'spam', 'supplier']);
});

test('labels are namespaced so they cannot collide with an existing label', () => {
  assert.strictEqual(T.labelFor('rfq'), 'PlayNexa/rfq');
});

test('a manufacturer selling TO Abiozen is a supplier, not a buyer inquiry', () => {
  // The category most often got wrong: these messages are full of product nouns and read like
  // demand. The Dideu message that prompted this feature was the opposite case — a manufacturer
  // ASKING to buy — which is why the rule keys on the selling phrase, not on the word "supplier".
  const c = T.heuristicCategory({
    from: 'sales@example.cn',
    subject: 'Cooperation proposal',
    body: 'We are a leading manufacturer of pharmaceutical intermediates and we can supply you '
      + 'with competitive prices.',
  });
  assert.strictEqual(c, 'supplier');
});

test('an explicit quotation request is an rfq', () => {
  assert.strictEqual(T.heuristicCategory({
    from: 'purchase17@example.com',
    subject: 'Inquiry for 1KG of CAS 119838-38-9',
    body: 'Kindly quote us your best CIF price and advise the shortest lead time.',
  }), 'rfq');
});

test('a purchase order is a buyer', () => {
  assert.strictEqual(T.heuristicCategory({
    from: 'ap@customer.com', subject: 'PO 44821', body: 'Please find our purchase order attached.',
  }), 'buyer');
});

test('marketing is spam', () => {
  assert.strictEqual(T.heuristicCategory({
    from: 'growth@seoagency.com', subject: 'Guest post opportunity',
    body: 'We offer high quality backlink and guest post services. Unsubscribe here.',
  }), 'spam');
});

test('the heuristics ABSTAIN rather than guess', () => {
  // Abstaining is the correct answer most of the time. A rule set that always produces a category
  // is a rule set that mislabels, and a mislabelled message gets a confidently wrong draft.
  assert.strictEqual(T.heuristicCategory({
    from: 'dr.smith@university.edu',
    subject: 'Question',
    body: 'Do you have any experience with peptide coupling reagents?',
  }), null);
});

test('internal mail is left alone', () => {
  assert.strictEqual(T.heuristicCategory({
    from: 'manohar@adificetechnologies.com', subject: 'deploy', body: 'pushed',
  }), null);
});

test('a classifier failure leaves the message UNLABELLED, it does not default to inquiry', () => {
  // The failure mode worth preventing: an outage that silently files everything as one category
  // and drafts replies to all of it.
  return T.classify(
    { from: 'a@b.com', subject: 'hello', body: 'what do you do' },
    { claude: async () => ({ error: 'ANTHROPIC_API_KEY not configured' }) },
  ).then((r) => {
    assert.strictEqual(r.category, null);
    assert.strictEqual(r.confidence, 'failed');
  });
});

test('a category the model invents is rejected', async () => {
  const r = await T.classify(
    { from: 'a@b.com', subject: 'hello', body: 'hi' },
    { claude: async () => ({ json: { category: 'partnership', why: 'made this up' } }) },
  );
  assert.strictEqual(r.category, null, 'an unknown category was accepted');
});

test('spam is never drafted a reply', async () => {
  let called = false;
  const r = await T.draftReply({ from: 'x@y.com', subject: 'buy links', body: 'seo' }, 'spam',
    { claude: async () => { called = true; return { text: 'Dear sir' }; } });
  assert.ok(r.skip, 'a draft was produced for spam');
  assert.strictEqual(called, false, 'the model was called for spam');
});

test('a failed draft is skipped, not replaced with something invented', async () => {
  const r = await T.draftReply({ from: 'a@b.com', subject: 'q', body: 'hi' }, 'rfq',
    { claude: async () => ({ error: 'timeout' }) });
  assert.ok(r.skip);
  assert.match(r.reason, /draft failed/);
});

test('the drafting rules forbid quoting a price or a lead time', () => {
  // These are the two things a plausible-sounding draft would get wrong in a way that costs money,
  // and the two the owner has no price list to support.
  assert.match(T.DRAFTING_RULES, /NEVER state a price/);
  assert.match(T.DRAFTING_RULES, /lead time/);
  assert.match(T.DRAFTING_RULES, /100% advance payment by T\/T/);
});

test('the drafting rules forbid claiming accreditations Abiozen does not hold', () => {
  assert.match(T.DRAFTING_RULES, /Does NOT hold ISO\/IEC 17025, GLP or GCP/);
  assert.match(T.DRAFTING_RULES, /Does NOT hold FDA establishment registration/);
  assert.match(T.DRAFTING_RULES, /partner's, never Abiozen's/);
});

test('the drafting rules refuse an invented signatory', () => {
  // inquiry-agent.js signs as "Sarah Chen, Business Development Manager", who does not exist.
  // Drafts are signed by the person who will send them.
  assert.match(T.DRAFTING_RULES, /Do not invent a signatory/);
  assert.ok(!/Sarah Chen/.test(T.DRAFTING_RULES));
});

test('a reply keeps the thread: In-Reply-To and References are set', () => {
  const raw = T.buildRawReply({
    to: 'buyer@example.com', subject: 'Inquiry for 1KG', inReplyTo: '<abc@mail>',
    references: '<root@mail>', bodyTextOut: 'Hello',
  });
  const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(decoded, /^To: buyer@example\.com$/m);
  assert.match(decoded, /^Subject: Re: Inquiry for 1KG$/m);
  assert.match(decoded, /^In-Reply-To: <abc@mail>$/m);
  assert.match(decoded, /^References: <root@mail>$/m);
});

test('a subject already starting Re: is not double-prefixed', () => {
  const raw = T.buildRawReply({ to: 'a@b.com', subject: 'Re: Quote', bodyTextOut: 'x' });
  const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(decoded, /^Subject: Re: Quote$/m);
  assert.ok(!/Re: Re:/.test(decoded));
});

test('the body reader prefers text/plain and falls back to stripped html', () => {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');
  assert.strictEqual(T.bodyText({
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/html', body: { data: b64('<p>html version</p>') } },
      { mimeType: 'text/plain', body: { data: b64('plain version') } },
    ],
  }), 'plain version');

  assert.strictEqual(T.bodyText({
    mimeType: 'text/html', body: { data: b64('<p>only <b>html</b></p>') },
  }), 'only html');
});
