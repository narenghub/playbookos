// ── IS THE RECONCILIATION SCRIPT ACTUALLY READ-ONLY? ─────────────────────────
//
//   node --test scripts/reconcile-breach-gmail.test.js
//
// CEO decision 2026-11-11 priority 5 asks for the script plus "test results and scope controls
// for review". These are those controls. NO MAILBOX IS CONTACTED by this file or by the script
// under default flags.
//
// The claim being tested is not "the author intended read-only". It is that the script REFUSES TO
// RUN if it ever stops being read-only, and that its self-scan can be shown to fail — a guard
// that cannot go red is the shape this repository has found in itself five times.

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const R = require('./reconcile-breach-gmail');

const FILE = path.join(__dirname, 'reconcile-breach-gmail.js');
const src = fs.readFileSync(FILE, 'utf8');

// ── THE SELF-SCAN, AND PROOF THAT IT CAN FAIL ────────────────────────────────

test('the shipped script passes its own self-scan', () => {
  assert.deepStrictEqual(R.selfScan(), { ok: true });
});

test('NEGATIVE: a planted send is detected', () => {
  // The control that matters. If this does not go red, the self-scan is decoration and the
  // read-only claim rests on nothing but the author's intention.
  const planted = `${src}\nasync function oops(g) { return g.users.messages.send({ userId: 'me' }); }\n`;
  const r = R.selfScan(FILE, planted);
  assert.strictEqual(r.ok, false, 'a planted messages.send was not detected');
  assert.ok(r.found.includes('messages.send'));
});

test('NEGATIVE: every mutating method in the list is individually detected', () => {
  // A list is only as good as the weakest entry. One name that cannot be matched is one mutation
  // that would pass, and the list would still LOOK thorough.
  for (const m of R.MUTATING) {
    const planted = `${src}\nfunction x(g){ return g.users.${m}; }\n`;
    const r = R.selfScan(FILE, planted);
    assert.strictEqual(r.ok, false, `${m} is in MUTATING but a use of it is not detected`);
    assert.ok(r.found.includes(m), `${m} was not the name reported`);
  }
});

test('the method names in the header and in the list do not trip it', () => {
  // The false-positive direction. If discussing these names in a comment tripped the scan, the
  // next person would delete the scan rather than the comment.
  assert.ok(/messages\.send/.test(src), 'the header no longer discusses the mutating methods');
  assert.deepStrictEqual(R.selfScan(), { ok: true });
});

test('comment blanking preserves line numbers', () => {
  // Blanked, not removed. A scan that reported a line number counted in stripped text would point
  // at the wrong line — which is the mistake the scope-discipline checker made this same day.
  const code = R.codeOf(src);
  assert.strictEqual(code.split('\n').length, src.split('\n').length);
});

// ── IDENTIFIERS ONLY: THERE IS NO SEARCH HERE ────────────────────────────────

test('the only Gmail query shape is an exact Message-Id lookup', () => {
  assert.strictEqual(R.identifierQuery('<a@b.test>'), 'rfc822msgid:a@b.test');
  assert.strictEqual(R.identifierQuery('a@b.test'), 'rfc822msgid:a@b.test',
    'a header without angle brackets must produce the same lookup');
});

test('no date-range, label or keyword query appears anywhere', () => {
  const code = R.codeOf(src);
  // rfc822msgid: resolves the single message bearing that header and cannot return another. A
  // date or keyword query would read mail outside the authorised 25, which is not permitted — so
  // the absence of these operators is the scope control, and it is asserted rather than promised.
  for (const op of ['after:', 'before:', 'newer_than:', 'older_than:', 'label:', 'in:', 'has:',
    'subject:', 'from:', 'to:', 'filename:', 'is:']) {
    assert.ok(!code.includes(`q: \`${op}`) && !code.includes(`q: '${op}`) && !code.includes(`"${op}`),
      `the script can issue a ${op} query, which would read mail outside the authorised messages`);
  }
  const queries = code.match(/q:\s*[^,\n]+/g) || [];
  assert.strictEqual(queries.length, 1, `expected exactly one query site, found ${queries.length}`);
  assert.match(queries[0], /identifierQuery\(/,
    'the single query site does not use the identifier lookup');
});

test('message ids come from our own tables, never from a search', () => {
  assert.match(src, /FROM cphi_followup_sends/);
  assert.match(src, /FROM outreach_sends/);
  assert.match(src, /gmail_message_id/);
  assert.match(src, /rfc822/);
});

// ── BODIES ARE CLASSIFIED, NOT STORED ───────────────────────────────────────

test('a body produces a verdict and a digest, and the text is not written out', () => {
  const code = R.codeOf(src);
  const i = code.indexOf('const lines = [');
  assert.ok(i > 0, 'the output builder is gone');
  const out = code.slice(i, code.indexOf('fs.appendFileSync', i));
  assert.ok(!/body_text|\btext\b|bodyTextOf/.test(out),
    'the appended record contains the message text — a reconciliation of a breach must not become '
    + 'a second copy of it');
  assert.match(out, /body_digest/);
  assert.match(out, /verdict/);
});

test('the three verdicts are distinct, and an unreadable body is UNKNOWN', () => {
  assert.strictEqual(R.classify('').verdict, 'UNKNOWN');
  assert.strictEqual(R.classify(null).verdict, 'UNKNOWN');
  assert.strictEqual(R.classify('   ').verdict, 'UNKNOWN');
  assert.strictEqual(R.classify('Your quotation: $4,000 per kg').verdict, 'COMMERCIAL');
  assert.strictEqual(R.classify('I read your paper on catalysis with interest.').verdict,
    'NON_COMMERCIAL');
});

test('NON_COMMERCIAL is claimed only for a body that was actually read', () => {
  // The error the register made, in the place it would matter most. "No commercial language" must
  // never be a conclusion about a body nobody has seen.
  const c = R.classify('');
  assert.strictEqual(c.verdict, 'UNKNOWN');
  assert.match(R.classify('hello').why, /full body was read/);
});

test('the commercial pattern catches the language these messages actually used', () => {
  for (const s of ['our price per kg', 'MOQ is 5kg', 'attached is our quotation',
    'payment terms 50% advance', 'lead time 45 days', 'we can supply this API',
    'happy to send an RFQ', 'USD 48,150', '$9,000']) {
    assert.strictEqual(R.classify(s).verdict, 'COMMERCIAL', `missed: ${s}`);
  }
});

test('the pattern does not fire on ordinary academic prose', () => {
  // The false-positive direction again: a pattern that matches everything would report all 25 as
  // commercial and prove nothing.
  for (const s of ['I came across your work on site-selective catalysis.',
    'Congratulations on the grant renewal running to May 2029.',
    'Would you be open to a short conversation about your research?']) {
    assert.strictEqual(R.classify(s).verdict, 'NON_COMMERCIAL', `false positive: ${s}`);
  }
});

// ── THE DEFAULT CONTACTS NOTHING ─────────────────────────────────────────────

test('nothing happens without --execute', () => {
  const code = R.codeOf(src);
  assert.match(code, /if \(!EXECUTE\) \{/);
  const i = code.indexOf('if (!EXECUTE) {');
  const block = code.slice(i, i + 900);
  assert.match(block, /process\.exit\(0\)/, 'the plan-only path does not stop');
  // The Gmail client is required AFTER that exit, so the default path cannot even construct one.
  assert.ok(code.indexOf("require('../src/lib/gmail/client')") > i,
    'the Gmail client is loaded before the plan-only exit');
});

test('it asks for a token that cannot send', () => {
  assert.match(src, /scopeSets: READONLY_ONLY/,
    'the script uses the agents\' default token, which carries gmailSend or gmailModify — '
    + '"this script never calls send" would then be a property of the code, not of the grant');
  const C = require('../src/lib/gmail/client');
  assert.deepStrictEqual(C.READONLY_ONLY.map((s) => s.scopes).flat(),
    ['https://www.googleapis.com/auth/gmail.readonly']);
});

test('a caller-supplied scope set cannot be widened by the cache', () => {
  // gmailClientFor caches the scope set that worked per mailbox. A cached send-capable set must
  // not be handed to a caller that asked for read-only.
  const client = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'gmail', 'client.js'), 'utf8');
  assert.match(client, /const preferred = sets \? null : resolved\.get\(subject\)/);
  assert.match(client, /if \(!sets\) resolved\.set\(subject, set\)/,
    'a caller-supplied read-only set is cached as this mailbox\'s resolved set, which would then '
    + 'be reused by a sender');
});

test('the record is appended, never rewritten', () => {
  assert.match(src, /appendFileSync/);
  assert.ok(!/writeFileSync|truncate/.test(R.codeOf(src)),
    'the evidence file can be overwritten, so its history could not be audited');
});

test('an incomplete run exits non-zero', () => {
  assert.match(src, /if \(failed\) \{[\s\S]*?process\.exit\(1\)/,
    'a run with failed lookups exits 0, so a partial reconciliation would read as a complete one');
});
