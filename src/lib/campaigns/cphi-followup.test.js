'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { CAMPAIGNS, ROLE_TO_CAMPAIGN, render, stepDef } = require('./cphi-followup');

const VARS = { first: 'Quyen', company: 'TAPI' };

test('the HTML is typographic, NOT a marketing template', () => {
  // The trap in "make it HTML": a logo, a hero band, a coloured button, social icons. Any of those
  // undoes the reason for sending from Naren's own mailbox rather than a sequencer — a person
  // following up on a handshake does not send a newsletter.
  for (const key of Object.keys(CAMPAIGNS)) {
    for (const s of CAMPAIGNS[key].steps) {
      const html = s.html(VARS);
      assert.ok(!/<img/i.test(html), `${key} step ${s.step}: no images — nothing to block, nothing that looks like a tracking pixel`);
      assert.ok(!/background(-color)?\s*:/i.test(html), `${key} step ${s.step}: no background colours`);
      assert.ok(!/border-radius|box-shadow/i.test(html), `${key} step ${s.step}: no button styling`);
      assert.ok(!/<(table)[^>]*>(?![\s\S]*role="presentation")/i.test(html.replace(/role="presentation"[\s\S]*/, '')),
        `${key} step ${s.step}: no layout tables`);
      assert.ok(!/fonts\.googleapis|@font-face/i.test(html), `${key} step ${s.step}: no web fonts`);
      assert.ok(!/unsubscribe|opt.?out|view in browser/i.test(html), `${key} step ${s.step}: no newsletter furniture`);
    }
  }
});

test('every step has a hand-written text part, not one stripped from the HTML', () => {
  for (const key of Object.keys(CAMPAIGNS)) {
    for (const s of CAMPAIGNS[key].steps) {
      const text = s.text(VARS);
      const html = s.html(VARS);
      assert.ok(text.length > 80, `${key} step ${s.step}: text part is too short to be real`);
      assert.ok(!/<[a-z]/i.test(text), `${key} step ${s.step}: the text part contains markup`);
      // Not identical to a tag-stripped HTML: the wording differs because it was written, not derived.
      const stripped = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      assert.notStrictEqual(text.replace(/\s+/g, ' ').trim(), stripped);
    }
  }
});

test('no molecule is named and no volume is promised in any template', () => {
  // Availability and price belong in a human reply. "One or two studies a day" was said across a
  // table; printed in a template it is a commitment.
  const banned = /semaglutide|leuprolide|metformin|cabazitaxel|per day|per month|studies a day|guarantee/i;
  for (const key of Object.keys(CAMPAIGNS)) {
    for (const s of CAMPAIGNS[key].steps) {
      assert.ok(!banned.test(s.text(VARS)), `${key} step ${s.step} text`);
      assert.ok(!banned.test(s.html(VARS)), `${key} step ${s.step} html`);
    }
  }
});

test('nothing describes how the platform is built', () => {
  const banned = /\b(AI|LLM|agent|automation|algorithm|platform we built|open.?source|API key)\b/i;
  for (const key of Object.keys(CAMPAIGNS)) {
    for (const s of CAMPAIGNS[key].steps) {
      assert.ok(!banned.test(s.text(VARS)), `${key} step ${s.step} mentions the build`);
    }
  }
});

test('step 1 carries the attachment, follow-ups do not', () => {
  // The one-pager answers the question every supplier asked on the floor. Sending the ask without
  // the answer repeats that failure in writing — so it goes on the FIRST message, not a later one.
  for (const key of Object.keys(CAMPAIGNS)) {
    assert.strictEqual(stepDef(key, 1).attach, true, `${key} step 1 must attach the one-pager`);
    for (const s of CAMPAIGNS[key].steps.slice(1)) {
      assert.ok(!s.attach, `${key} step ${s.step} must not re-attach`);
    }
  }
});

test('follow-up steps have no subject, so they reply in-thread', () => {
  // A second message titled "Re: ..." arriving as a NEW conversation is the clearest tell that
  // software sent it. A null subject means the sender threads it instead.
  for (const key of Object.keys(CAMPAIGNS)) {
    assert.ok(CAMPAIGNS[key].steps[0].subject, `${key} step 1 needs a subject`);
    for (const s of CAMPAIGNS[key].steps.slice(1)) {
      assert.strictEqual(s.subject, null, `${key} step ${s.step} must reply in-thread`);
    }
  }
});

test('delays increase and the first step is immediate', () => {
  for (const key of Object.keys(CAMPAIGNS)) {
    const days = CAMPAIGNS[key].steps.map((s) => s.delayDays);
    assert.strictEqual(days[0], 0, `${key} step 1 should be immediate`);
    for (let i = 1; i < days.length; i += 1) {
      assert.ok(days[i] > days[i - 1], `${key}: delays must increase`);
    }
  }
});

test('the buyer sequence stops at two — asking three times for nothing is a nuisance', () => {
  assert.strictEqual(CAMPAIGNS.buyer.steps.length, 2);
  assert.strictEqual(CAMPAIGNS.supplier.steps.length, 3, 'the supplier ask is worth a third try');
});

test('the partner email ASKS which capability rather than assuming it', () => {
  // Naren wants QC and facilities treated as two segments. Nobody has told us which firms do
  // which — Almac, Thermo Fisher and Cambrex spoke only about their analytical units. Splitting
  // the list before that fact exists means guessing, in the first follow-up after a handshake.
  const t = CAMPAIGNS.partner.steps[0].text(VARS);
  assert.match(t, /analytical quality control/i);
  assert.match(t, /repackag|relabel/i);
  assert.match(t, /storage/i);
  // And the geography asymmetry is stated, because it is real and shapes their answer.
  assert.match(t, /near the material/i);
  assert.match(t, /reviewers sit/i);
  // Both follow-ups must keep the question open rather than presuming an answer.
  assert.match(CAMPAIGNS.partner.steps[1].text(VARS), /or both/i);
});

test('rendering without a first name is FATAL, not defaulted', () => {
  // "Hi ," or "Hi {{first_name}}," on a follow-up to somebody met four days ago is worse than not
  // sending at all. Three of the day-1 cards cannot be split safely, so this path is real.
  assert.throws(() => render('supplier', 1, { first: '', company: 'TAPI' }), /first name is required/);
  assert.throws(() => render('supplier', 1, {}), /first name is required/);
  assert.throws(() => render('supplier', 1, { first: '   ' }), /first name is required/);
});

test('no rendered output contains an unreplaced placeholder', () => {
  for (const key of Object.keys(CAMPAIGNS)) {
    for (const s of CAMPAIGNS[key].steps) {
      const out = render(key, s.step, VARS);
      for (const body of [out.text, out.html, out.subject || '']) {
        assert.ok(!/\{\{|\}\}|\$\{/.test(body), `${key} step ${s.step} has a placeholder left in it`);
      }
      assert.ok(out.text.includes('Quyen'), `${key} step ${s.step}: the greeting did not render`);
    }
  }
});

test('every CPHI partner role maps to a campaign', () => {
  for (const role of ['supplier', 'buyer', 'qc_lab', 'platform_partner']) {
    assert.ok(ROLE_TO_CAMPAIGN[role], `${role} has no campaign`);
    assert.ok(CAMPAIGNS[ROLE_TO_CAMPAIGN[role]], `${role} maps to a campaign that does not exist`);
  }
  assert.strictEqual(ROLE_TO_CAMPAIGN.qc_lab, 'partner');
  assert.strictEqual(ROLE_TO_CAMPAIGN.platform_partner, 'partner');
});

test('the signature is on the first message of every sequence', () => {
  for (const key of Object.keys(CAMPAIGNS)) {
    const out = render(key, 1, VARS);
    assert.match(out.html, /Naren Boda/);
    assert.match(out.html, /Chief Executive Officer/);
    assert.match(out.html, /naren@abiozen\.com/);
    assert.match(out.html, /Barclay/, 'the facility address, as asked');
    assert.match(out.text, /Naren Boda/);
  }
});

// ── WHAT NAREN ASKED EACH SEQUENCE TO SAY, 12 OCT ─────────────────────────────
//
// Pinned because these are requirements, not phrasing. He described the three emails as three
// different conversations, and a later edit that smooths the copy must not quietly drop one.

test('the buyer email says WHAT we cover: research chemicals and generic APIs', () => {
  // "We will help you what type of molecules you are lacking with. The research chemical, generic
  // API. Any therapeutic area." A buyer reading "several hundred products" cannot tell whether we
  // hold the kind of thing they buy.
  const s = CAMPAIGNS.buyer.steps.find((x) => x.step === 1);
  for (const body of [s.text(VARS), s.html(VARS)]) {
    assert.match(body, /research chemicals/i);
    assert.match(body, /generic APIs/i);
    assert.match(body, /therapeutic area/i);
  }
});

test('the buyer email does not claim labs we do not have', () => {
  // The analytical network is BEING ONBOARDED — that is what the one-pager says, and the email may
  // not outrun it. "Analytical testing can be arranged through the partner laboratories we are
  // onboarding" is true; "our labs in Europe and the US" would not be.
  const s = CAMPAIGNS.buyer.steps.find((x) => x.step === 1);
  for (const body of [s.text(VARS), s.html(VARS)]) {
    assert.match(body, /partner laboratories we are onboarding/i);
    assert.ok(!/\bour (own )?labs?\b/i.test(body), 'claims labs we do not own');
    assert.ok(!/end-to-end compliance\b/i.test(body),
      'compliance is AROS, which is in early release — do not print it as a finished guarantee');
  }
});

test('the partner email opens the commercial conversation, asking rather than promising', () => {
  // "How are we gonna bring the business? How many clients we going to accommodate? We need to
  // talk about price model, contract." The topic must be raised — and raised as a question, since
  // a printed client number from the CEO is a commitment a partner will hold him to.
  const s = CAMPAIGNS.partner.steps.find((x) => x.step === 1);
  for (const body of [s.text(VARS), s.html(VARS)]) {
    assert.match(body, /pricing/i);
    assert.match(body, /agreement|contract/i);
    assert.match(body, /volume your site could absorb/i);   // their capacity, not our forecast
    // No number of clients, studies or units anywhere near the commercial paragraph.
    assert.ok(!/\b\d+\s*(clients?|customers?|studies|orders?)\b/i.test(body),
      'a printed volume is a commitment, not a conversation');
  }
});
