// The report is the only thing anybody will read. These guards are about the ways a report can be
// technically accurate and still hide the thing that matters.
'use strict';

const assert = require('assert');
const { composeOutreachReport } = require('./outreach-report');

let pass = 0; const fails = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const RUN = {
  from: 'sales@abiozen.com', routed: 27, due: 19, batch: 8, sent: 2, failed: 0, unconfirmed: 0,
  skipped: { notDue: 11, done: 0, replied: 0, bounced: 0 },
  declined: [{ who: 'Brian M Paegel', org: 'UC Irvine', why: 'department is Department of Pharmacology' }],
  unfiled: [], repliedNow: [],
  sentTo: [
    { who: 'Scott J Miller', email: 'scott.miller@yale.edu', need: 'discovery', step: 1,
      subject: 'Site-selective catalysis — structure search',
      evidence: 'I came across your work on site-selective catalysis through 2R35GM132092-06 (running to May 2029).' },
    { who: 'Shannon S Stahl', email: 'stahl@chem.wisc.edu', need: 'discovery', step: 1,
      subject: 'Catalytic redox reactions — structure search',
      evidence: 'I came across your work on catalytic redox reactions through 2R35GM134929-06 (running to June 2030).' },
  ],
  bounceRate: 0, stopped: false,
};

const BOUNCE = { scanned: 3, found: [], recorded: 0, unmatched: 3, stopped: 0, rate: 0, sent: 10 };

t('the opening sentence of every sent email appears in the report', () => {
  // It is a factual claim made about a named person and the thing most likely to be wrong. A
  // report that says "2 sent" gives Naren no way to catch it.
  const r = composeOutreachReport({ run: RUN, bounce: BOUNCE });
  for (const s of RUN.sentTo) {
    assert.ok(r.html.includes(s.evidence.slice(0, 40)), `missing the claim made to ${s.who}`);
    assert.ok(r.html.includes(s.who), `missing ${s.who}`);
  }
});

t('skipped people are named, not just counted', () => {
  // "22 not routed" is what hid a broken department check for a day. A name and a reason would
  // have been obvious at a glance.
  const r = composeOutreachReport({ run: RUN, bounce: BOUNCE });
  assert.ok(r.html.includes('Brian M Paegel'), 'declined contact not named');
  assert.ok(/Pharmacology/.test(r.html), 'the reason is missing, so it is not actionable');
});

t('a zero bounce rate with nothing scanned is flagged as unproven', () => {
  // THE ONE THAT MATTERS. "0.0%" reads identically whether the list is clean or the scanner is
  // blind, and this campaign has already shipped the blind version twice.
  const r = composeOutreachReport({
    run: RUN, bounce: { ...BOUNCE, scanned: 0, found: [], rate: 0, sent: 8 },
  });
  assert.ok(/consistent with a clean list/i.test(r.html),
    'a 0% rate from an empty scan is presented as good news');
  assert.ok(/verify-bounce-detection/.test(r.html), 'does not say how to settle it');
});

t('a held run says plainly that nothing was sent', () => {
  const r = composeOutreachReport({
    run: { ...RUN, sent: 0, sentTo: [], stopped: 'bounce rate 12.5% is over the 5% limit' },
    bounce: BOUNCE,
  });
  assert.ok(/HELD/.test(r.subject), r.subject);
  assert.ok(/Nothing was sent/i.test(r.html));
  assert.ok(r.worthSending, 'a held run must always be reported');
});

t('unconfirmed sends are escalated in words a person can act on', () => {
  const r = composeOutreachReport({
    run: { ...RUN, failed: 1, unconfirmed: 1 }, bounce: BOUNCE,
  });
  assert.ok(/may or may not have gone/i.test(r.html), 'the ambiguous state is not explained');
  assert.ok(/Sent folder/i.test(r.html), 'does not say how to check');
});

t('an unfiled thread is explained by its consequence, not its name', () => {
  const r = composeOutreachReport({
    run: { ...RUN, unfiled: [{ who: 'X', threadId: 'abc', why: 'scope' }] }, bounce: BOUNCE,
  });
  assert.ok(/will not stop the sequence/i.test(r.html),
    '"1 unfiled" means nothing to a reader who does not know what filing is for');
});

t('replies are called out as the only thing that can become revenue', () => {
  const r = composeOutreachReport({ run: { ...RUN, repliedNow: ['Scott J Miller'] }, bounce: BOUNCE });
  assert.ok(/replied/i.test(r.subject), r.subject);
  assert.ok(/revenue/i.test(r.html));
});

t('a genuinely empty day is not emailed', () => {
  // A daily "0 sent" for a fortnight trains the reader to ignore the one that matters.
  const quiet = {
    ...RUN, sent: 0, failed: 0, sentTo: [], repliedNow: [], unfiled: [], unconfirmed: 0,
    declined: [], stopped: false,
  };
  const r = composeOutreachReport({ run: quiet, bounce: { ...BOUNCE, recorded: 0 } });
  assert.strictEqual(r.worthSending, false);
});

t('but a day with a new bounce IS emailed, even with no sends', () => {
  const quiet = { ...RUN, sent: 0, sentTo: [], repliedNow: [], unfiled: [], declined: [] };
  const r = composeOutreachReport({
    run: quiet, bounce: { ...BOUNCE, recorded: 1, found: [{ email: 'x@y.edu', kind: 'hard' }] },
  });
  assert.strictEqual(r.worthSending, true);
  assert.ok(/bounced/i.test(r.subject), r.subject);
});

t('nothing in the report is HTML-injectable from a contact name', () => {
  // Names come from NIH filings and buyer-submitted forms. One containing a tag would otherwise
  // break the report, or worse.
  const r = composeOutreachReport({
    run: {
      ...RUN,
      sentTo: [{ who: '<script>alert(1)</script>', email: 'a@b.c', need: 'discovery', step: 1,
        subject: '<b>x</b>', evidence: '<img src=x>' }],
    },
    bounce: BOUNCE,
  });
  assert.ok(!/<script>/.test(r.html), 'a contact name was rendered as markup');
  assert.ok(r.html.includes('&lt;script&gt;'), 'the name should appear, escaped');
});

if (fails.length) {
  console.error(`FAIL  ${fails.length} of ${pass + fails.length}`);
  for (const f of fails) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`ok  outreach report — ${pass} passed`);
