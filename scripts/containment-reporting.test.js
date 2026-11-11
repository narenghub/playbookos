// ── THE CONTAINMENT REPORT MUST NOT BE ABLE TO LIE AGAIN ─────────────────────
//
//   node --test scripts/containment-reporting.test.js
//
// CEO Authorization D, 2026-11-10. On 10 November, scripts/confirm-legacy-email-state.js printed
// "NO email reached an address outside the company during remediation" while 25 messages had. The
// sentence was TRUE of email_log and FALSE of reality: email_log is written only by the Resend
// path, so the strongest line in the containment report was structurally incapable of seeing two
// of the four transports.
//
// These assertions are about the REPORT, not the senders. A gate that works and a report that
// cannot see it are two different kinds of safe, and only one of them is.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, 'confirm-legacy-email-state.js');
const src = fs.readFileSync(FILE, 'utf8');

// Section 9 only. Scoping matters: the file discusses these tables elsewhere, and an assertion
// that passes on a mention in a comment two hundred lines away is the shape of guard this
// repository has been burned by five times.
function sectionNine() {
  const start = src.indexOf('── 9. EXTERNAL EMAIL DURING THE REMEDIATION WINDOW');
  assert.ok(start > 0, 'section 9 is gone — this guard is pointing at a report that no longer exists');
  const end = src.indexOf('PASS  no blocking finding', start);
  return src.slice(start, end > start ? end : src.length);
}

test('the all-clear requires EVERY transport claim source, not just email_log', () => {
  const s9 = sectionNine();
  for (const table of ['email_log', 'cphi_followup_sends', 'outreach_sends']) {
    assert.ok(s9.includes(table),
      `section 9 does not read ${table}. The Gmail senders write their own claim tables and `
      + 'nothing else — a report that reads only email_log cannot see them, which is exactly how '
      + '25 messages left while it printed an all-clear.');
  }
});

test('the all-clear is conditional on the Gmail count, not only on email_log', () => {
  const s9 = sectionNine();
  const allClear = s9.match(/ok\('NO email reached[^']*'\)/);
  assert.ok(allClear, 'the all-clear line is gone or reworded — re-point this guard deliberately');

  // The condition guarding it must mention the Gmail tally. Without that, the sentence is back to
  // being true of one transport and asserted of four.
  const guard = s9.slice(Math.max(0, s9.indexOf(allClear[0]) - 400), s9.indexOf(allClear[0]));
  assert.match(guard, /gmailSent/,
    'the all-clear is not conditioned on the Gmail transports');
  assert.match(guard, /gmailSent === 0/,
    'the all-clear does not require the Gmail count to be exactly zero');
});

test('an unreadable or absent source yields UNKNOWN, and UNKNOWN blocks the all-clear', () => {
  const s9 = sectionNine();
  assert.match(s9, /UNKNOWN, not zero/,
    'an absent claim table is not reported as UNKNOWN — absence of evidence would read as evidence of absence');
  assert.match(s9, /gmailSent = -1/,
    'an unreadable source does not force the count negative, so a read failure could pass as clean');
  // -1 is not 0, so `gmailSent === 0` cannot hold. The sentinel is what makes UNKNOWN dominate.
  assert.ok(s9.includes('gmailSent === 0'),
    'the all-clear does not test for exactly zero, so the UNKNOWN sentinel would not block it');
});

test('flag state is reported separately from the kill-switch decision', () => {
  // DISABLED and STOPPED are different facts. Conflating them is how "contained" and "never ran"
  // became indistinguishable — and both flags turned out to be TRUE the whole time.
  const start = src.indexOf('── 7b. EXECUTION FLAGS AND OBSERVED EXECUTION');
  assert.ok(start > 0, 'section 7b is gone');
  const s7b = src.slice(start, src.indexOf('── 8.', start));

  for (const flag of ['CPHI_FOLLOWUP_ENABLED', 'OUTREACH_ENABLED']) {
    assert.ok(s7b.includes(flag), `section 7b does not report ${flag}`);
  }
  for (const state of ['DISABLED', 'ENABLED_BUT_STOPPED', 'ENABLED_AND_ALLOWED', 'UNKNOWN']) {
    assert.ok(s7b.includes(state), `section 7b cannot report ${state}`);
  }
  assert.match(s7b, /NOT evidence that the/,
    'section 7b does not warn that a disabled flag is not proof the kill switch was exercised');
});

test('the gate DECISION is probed, not inferred from an empty queue', () => {
  // The Gmail gate sits inside the per-message loop. No due work, no gate call, no ledger row —
  // so observed execution stayed UNKNOWN for six hours after the fix shipped. Waiting for a queue
  // is not a verification strategy; 25 messages left on the strength of an unexercised gate.
  const start = src.indexOf('── 7b. EXECUTION FLAGS AND OBSERVED EXECUTION');
  const s7b = src.slice(start, src.indexOf('── 8.', start));
  assert.match(s7b, /assertSendAllowed/,
    'section 7b does not probe the gate decision directly');
  assert.match(s7b, /WOULD BE PERMITTED TO SEND RIGHT NOW/,
    'a permitted sender would not be reported as a finding');
  for (const agent of ['cphi-runner', 'outreach-agent', 'bounce-probe']) {
    assert.ok(s7b.includes(agent), `the gate probe does not cover ${agent}`);
  }
});

test('the incident register and the audit are read-only', () => {
  // Both run against production. A write in either would be the most dangerous code in the repo,
  // for the reason CLAUDE.md gives: cleanup is the part nobody reads.
  for (const f of ['audit-gmail-during-containment.js', 'incident-register-2026-11.js']) {
    const code = fs.readFileSync(path.join(__dirname, f), 'utf8')
      // comments necessarily name the forbidden verbs while promising not to use them
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const verb of ['INSERT INTO', 'UPDATE ', 'DELETE FROM', 'messages.send', 'drafts.create']) {
      assert.ok(!code.includes(verb), `${f} contains "${verb}" in live code — it must be read-only`);
    }
  }
});
