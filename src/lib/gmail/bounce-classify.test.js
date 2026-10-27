// The bounce classifier, kept honest against real postmaster wording.
//
// This exists because the gate it feeds was decorative for one batch: send-outreach refuses to
// start above a 5% bounce rate and computed that rate from a table nothing wrote to, so it read
// 0.0% and would have read 0.0% if every address had failed. A check that cannot fail looks
// exactly like a check that passes.
//
// The patterns live in scripts/scan-bounces.js and are read from it rather than copied, so a
// change there is tested here instead of silently diverging.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../agents/outreach-agent.js'), 'utf8');

// The patterns are built from two raw pieces plus a phrase list, so they are evaluated here with
// those pieces in scope rather than pulled out as a single literal.
function patterns() {
  const take = (name) => {
    const m = SRC.match(new RegExp(`^const ${name} = String\\.raw\`([^\`]*)\`;$`, 'm'));
    if (!m) throw new Error(`${name} not found in outreach-agent.js — did it move or get renamed?`);
    return m[1];
  };
  const line = (name) => {
    const m = SRC.match(new RegExp(`^const ${name} = new RegExp\\(\`(.*)\`, 'i'\\);$`, 'm'));
    if (!m) throw new Error(`${name} not found in outreach-agent.js`);
    return m[1];
  };
  const CODE_HARD = take('CODE_HARD');
  const CODE_SOFT = take('CODE_SOFT');
  const build = (tpl) => new RegExp(
    tpl.replace('${CODE_HARD}', CODE_HARD).replace('${CODE_SOFT}', CODE_SOFT), 'i');
  return { HARD: build(line('HARD')), SOFT: build(line('SOFT')) };
}

const { HARD, SOFT } = patterns();
const classify = (t) => (HARD.test(t) ? 'hard' : (SOFT.test(t) ? 'soft' : 'unknown'));

let pass = 0; const fails = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); } };

t('real hard bounces are classified hard', () => {
  // A hard bounce means the address is wrong and the sequence must stop. These are the wordings
  // Google, Microsoft and university mail systems actually send.
  for (const s of [
    '550 5.1.1 The email account that you tried to reach does not exist',
    'Your message to prof@uni.edu was not delivered: user unknown',
    '550 5.1.1 <someone@example.edu>: Recipient address rejected: User unknown',
    'Remote server returned: 550 No such user here',
    'The account has been disabled',
    'This person is no longer with the university',
    '551 Mailbox unavailable',
  ]) assert.strictEqual(classify(s), 'hard', s.slice(0, 50));
});

t('soft bounces are not treated as hard', () => {
  // A full mailbox clears. Marking it hard would permanently drop a real contact who is simply
  // over quota this week.
  for (const s of [
    '452 4.2.2 The email account that you tried to reach is over quota',
    'Delivery delayed: temporary failure, will retry',
    '450 4.2.0 Greylisted, try again later',
    'Mailbox full',
  ]) assert.strictEqual(classify(s), 'soft', s.slice(0, 50));
});

t('an out-of-office is not a bounce', () => {
  // THE ONE THAT MATTERS MOST. Academics set these constantly, and counting them would inflate
  // the rate until the gate stopped a healthy campaign — or, worse, mark a live address hard and
  // drop a professor who was simply on sabbatical.
  for (const s of [
    'Out of office: I am travelling until June',
    'Automatic reply: I am on sabbatical and will respond on my return',
    'I am currently away from my desk with limited access to email',
    'Thank you for your message. I will reply when I am back in the lab.',
  ]) assert.strictEqual(classify(s), 'unknown', s.slice(0, 50));
});

t('an ordinary reply is never a bounce', () => {
  for (const s of [
    'Thanks for reaching out — could you send me the pricing?',
    'Please remove me from this list',
    'Not interested, but try my colleague in the chemistry department',
  ]) assert.strictEqual(classify(s), 'unknown', s.slice(0, 50));
});

t('a plain three-digit number is not a status code', () => {
  // "550" inside a quantity would otherwise classify a real reply as a hard bounce and stop that
  // person's sequence — a reply, read as a failure.
  assert.strictEqual(classify('We need 550 grams of the compound'), 'unknown');
  assert.strictEqual(classify('Our budget is 4500 dollars'), 'unknown');
});

if (fails.length) {
  console.error(`FAIL  ${fails.length} of ${pass + fails.length}`);
  for (const f of fails) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`ok  bounce classifier — ${pass} passed`);
