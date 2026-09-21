// Spam gate tests — run with:  node --test src/lib/agents/inquiry-spam.test.js
// Fixtures are the REAL messages from sales@abiozen.com (2026-09-21 triage): 9 reply-bait
// spam threads the agent answered, and the 2 genuine inquiries it must never block.

const { test } = require('node:test');
const assert = require('node:assert');
const { classifyInquirySpam, nameMatchesAddress, greetedName } = require('./inquiry-spam');

const STAFF = ['Naren Boda', 'Palash Das', 'Prasanthi', 'Sarah Chen'];

// The 9, verbatim from the mailbox.
const SPAM = [
  { subject: 'Re: Handle your inquiry - wbx nks', fromName: 'Jennifer Daniels', fromEmail: 'tracydixon995@gmail.com',
    body: "Greetings,\n\nThanks for getting in touch, I'd like to know more about this.\nCould you please call me today morning?\n\nBest wishes,\nJennifer Daniels" },
  { subject: 'Re: Inquiry concerning Schultz, Cook and Waters - wbx gbq', fromName: 'Joel Miller', fromEmail: 'wargunundefined7678@gmail.com',
    body: "Hi William Myers,\n\nThanks for getting back to me, I'd like to know more about this.\nCould you please remind me tomorrow morning?\n\nYours sincerely,\nJoel Miller" },
  { subject: 'Re: Inquiry concerning Hudson, Alexander and Murphy - wbx rcm', fromName: 'Jennifer Ward', fromEmail: 'fannymar145@gmail.com',
    body: "Hi Gregory Mcbride,\n\nThank you for your help, I'd like to know more about this.\nCould you please write me today afternoon?\n\nWarm wishes,\nJennifer Ward" },
  { subject: 'Re: Handle your inquiry - wbx xap', fromName: 'Bethany Hanna', fromEmail: 'bpierce296@gmail.com',
    body: "Greetings,\n\nI appreciate your quick response, I'd like to know more about this.\nCould you please call me tomorrow morning?\n\nRegards,\nBethany Hanna" },
  { subject: 'Re: Response to your inquiry - wbx eqx', fromName: 'James Banks', fromEmail: 'chelsey.collier@vividucks.com',
    body: "Hi everyone,\n\nThanks for your message,\nI'll call you back later,\nI have some questions to ask you as I'm happy with my current solution but yours seems more powerful,\ncall to you today morning then.\n\nBest regards,\nJames Banks" },
  { subject: 'Re: Inquiry addressed to Kevin - wbx hrg', fromName: 'Elijah Ortega', fromEmail: 'juihandri.williams@gmail.com',
    body: "Greetings,\n\nThanks for getting in touch, I'd like to know more about this.\nCould you please write me today morning?\n\nWarmly,\nElijah Ortega" },
  { subject: 'Re: Handle your inquiry - wbx uky', fromName: 'Brandon Crane', fromEmail: 'kirillovoleg663@gmail.com',
    body: "Greetings,\n\nI appreciate your quick response, I'd like to know more about this.\nCould you please write me tomorrow afternoon?\n\nCheers,\nBrandon Crane" },
  // Raw mail no longer in the mailbox; classified on the stored fields.
  { subject: 'Inquiry: GMP API', fromName: 'RobertFilub', fromEmail: 'gregoryj8tl2g@gmail.com',
    body: 'Buyer asking about pricing but no specific product mentioned.' },
  { subject: 'Inquiry: GMP API', fromName: 'Jesse Bailey', fromEmail: 'claptonedgar9@gmail.com',
    body: 'Buyer requests more information and asks for a call this evening regarding a previous inquiry.' },
];

test('all 9 real spam threads are blocked', () => {
  for (const m of SPAM) {
    const v = classifyInquirySpam({ ...m, weEverEmailed: false, employeeNames: STAFF });
    assert.equal(v.spam, true, `should be spam: ${m.fromEmail} — signals ${JSON.stringify(v.signals)}`);
  }
});

test('the 2 genuine inquiries are NOT blocked', () => {
  const david = classifyInquirySpam({
    subject: 'Inquiry: 4-Aminopyridine', fromName: null, fromEmail: 'david@mytrapp.com',
    body: 'Bulk quote request for 4-Aminopyridine (CAS 504-24-5), quantity 1, for research institution use.',
    molecule: '4-Aminopyridine', quantity: 1, company: 'mytrapp', weEverEmailed: false, employeeNames: STAFF });
  assert.equal(david.spam, false);

  const debayan = classifyInquirySpam({
    subject: 'Inquiry: Metformin Hydrochloride', fromName: 'Debayan Saha', fromEmail: 'medebayan@gmail.com',
    body: 'need minimal quantity, but urgently. 5-10 gms maybe. I am an individual customer. You can call me at 2673371116.',
    molecule: 'Metformin Hydrochloride', quantity: 1, company: 'Individual', weEverEmailed: false, employeeNames: STAFF });
  assert.equal(debayan.spam, false);
});

test('SAFETY: substance always wins, even with every spam signal present', () => {
  const v = classifyInquirySpam({
    subject: 'Re: Handle your inquiry - wbx nks', fromName: 'Jennifer Daniels', fromEmail: 'tracydixon995@gmail.com',
    body: 'Hi William Myers, I need a quote.', molecule: 'Metformin HCl', quantity: 5, company: 'Acme Pharma',
    weEverEmailed: false, employeeNames: STAFF });
  assert.equal(v.spam, false);
  assert.ok(v.signals.length >= 2, 'signals still reported for audit');
});

test('a vague but clean inquiry is NOT spam (no hard signal)', () => {
  const v = classifyInquirySpam({
    subject: 'API supply question', fromName: 'Maria Gomez', fromEmail: 'm.gomez@novartis.com',
    body: 'Hello,\n\nDo you supply GMP APIs to the EU? Happy to share details on a call.\n\nMaria',
    weEverEmailed: false, employeeNames: STAFF });
  assert.equal(v.spam, false, 'no tracker code, name matches address, greets nobody by name');
});

test('a genuine reply to our own outreach is NOT flagged as an unsolicited Re:', () => {
  const v = classifyInquirySpam({
    subject: 'Re: Your API Inquiry | Abiozen LLC', fromName: 'David Kim', fromEmail: 'david@mytrapp.com',
    body: 'Thanks — can you send the COA?', weEverEmailed: true, employeeNames: STAFF });
  assert.equal(v.signals.includes('reply_to_thread_we_never_sent'), false);
  assert.equal(v.spam, false);
});

test('greeting one of our own people is not a signal', () => {
  const v = classifyInquirySpam({
    subject: 'Re: quote - abc def', fromName: 'Chris Reed', fromEmail: 'creed@lab.edu',
    body: 'Hi Sarah Chen,\n\nAny update?', weEverEmailed: false, employeeNames: STAFF });
  assert.equal(v.signals.some(s => s.startsWith('greets_non_employee')), false);
});

test('nameMatchesAddress handles initial+surname and personal-prefix addresses', () => {
  assert.equal(nameMatchesAddress('Debayan Saha', 'medebayan@gmail.com'), true);
  assert.equal(nameMatchesAddress('Brian Pierce', 'bpierce296@gmail.com'), true);
  assert.equal(nameMatchesAddress('Jennifer Daniels', 'tracydixon995@gmail.com'), false);
  assert.equal(nameMatchesAddress(null, 'x@y.com'), true, 'unknown name is not evidence');
  assert.equal(nameMatchesAddress('Anything', null), true, 'unknown address is not evidence');
});

test('greetedName ignores generic openers', () => {
  assert.equal(greetedName('Hi there,\n\nhello'), null);
  assert.equal(greetedName('Hi everyone,'), null);
  assert.equal(greetedName('Greetings,'), null);
  assert.equal(greetedName('Hi William Myers,\n\nThanks'), 'William Myers');
  assert.equal(greetedName('Dear Sarah,'), 'Sarah');
});

test('no signals and no substance is not spam on its own', () => {
  const v = classifyInquirySpam({ subject: 'Question', fromName: 'Ann Lee', fromEmail: 'alee@corp.com', body: 'Can you help?', weEverEmailed: true, employeeNames: STAFF });
  assert.equal(v.spam, false);
});
