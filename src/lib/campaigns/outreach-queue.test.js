// Guards for the shared outreach queue and the things that make a send safe.
//
// The queue is exercised against a fake `query` rather than Postgres, because what is being tested
// is the routing and the shape of what comes out — the SQL itself is covered by the checkers that
// run against a real server.
'use strict';

const assert = require('assert');
const { buildQueue, varsFor, firstName, lastName } = require('./outreach-queue');
const { NEED_CAMPAIGNS, renderNeed, needStepsOf } = require('./needs');
const { NEED_LABELS, labelForNeed } = require('../gmail/labels');

let pass = 0; const fails = [];
const tests = [];
const T = (n, f) => tests.push([n, f]);

// A `query` stand-in that answers by matching the SQL text, the way the real tables would.
function fakeQuery(data) {
  return async (sql) => {
    if (/FROM research_labs/.test(sql)) return { rows: data.labs || [] };
    if (/FROM inquiries/.test(sql)) return { rows: data.inquiries || [] };
    if (/FROM supplier_products/.test(sql)) return { rows: data.catalogue || [] };
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  };
}

const LAB = {
  id: 7,
  pi_name: 'Scott J Miller',
  full_name: 'Scott J Miller',
  institution_name: 'YALE UNIVERSITY',
  department: 'Department of Chemistry',
  focus: 'Site-Selective Catalysis',
  funding_id: '2R35GM132092-06',
  funding_end: new Date('2029-05-31T00:00:00Z'),
  source_url: 'https://reporter.nih.gov/project-details/2R35GM132092-06',
  email: 'scott.miller@yale.edu',
};

// ── EVERY NEED CAN BE FILED ──────────────────────────────────────────────────

T('every need has a Gmail label', () => {
  // An unlabelled thread is one whose reply never stops the sequence, because reply-sync finds
  // replies by walking the labelled threads. The person answers and gets chased anyway — which is
  // exactly what happened to the SCOPE demand_intel threads.
  for (const need of Object.keys(NEED_CAMPAIGNS)) {
    assert.ok(labelForNeed(need), `need "${need}" has no folder — its replies would be missed`);
  }
});

T('no label is defined for a need that does not exist', () => {
  for (const need of Object.keys(NEED_LABELS)) {
    assert.ok(NEED_CAMPAIGNS[need], `label "${need}" belongs to no campaign`);
  }
});

T('an unknown need files nowhere rather than guessing a folder', () => {
  assert.strictEqual(labelForNeed('not_a_need'), null);
  assert.strictEqual(labelForNeed(''), null);
  assert.strictEqual(labelForNeed(null), null);
});

// ── THE QUEUE ────────────────────────────────────────────────────────────────

T('a funded chemistry lab comes out routed, with a surname for the greeting', async () => {
  const rows = await buildQueue(fakeQuery({ labs: [LAB] }), { resolveLinks: false });
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.channel, 'research_lab');
  assert.strictEqual(r.ref, '7');
  assert.strictEqual(r.route.need, 'discovery');
  assert.strictEqual(r.first, 'Scott');
  assert.strictEqual(r.last, 'Miller');
  // The date must survive as a Date — pre-formatting it once produced "(running to March 2001)".
  assert.ok(/May 2029/.test(r.route.evidence), r.route.evidence);
});

T('every routed row renders every step of its sequence', async () => {
  // A contact who can be queued but not rendered is one the sender discovers mid-batch, after
  // some of the batch has already gone out.
  const rows = await buildQueue(fakeQuery({ labs: [LAB] }), { resolveLinks: false });
  for (const r of rows.filter((x) => x.route)) {
    for (const step of needStepsOf(r.route.need)) {
      const m = renderNeed(r.route.need, step, varsFor(r));
      assert.ok(m.text && m.text.length > 50, `${r.who} step ${step} rendered almost nothing`);
      assert.ok(!/\{\{|undefined|\[object/.test(m.text), `${r.who} step ${step}: ${m.text.slice(0, 80)}`);
    }
  }
});

T('a lab with no usable department is returned unrouted, with the reason named', async () => {
  const rows = await buildQueue(fakeQuery({
    labs: [{ ...LAB, department: 'Department of Pharmacology' }],
  }), { resolveLinks: false });
  assert.strictEqual(rows[0].route, null);
  assert.ok(/pharmacolog/i.test(rows[0].why), rows[0].why);
});

T('a lab with no grant number says so specifically', async () => {
  const rows = await buildQueue(fakeQuery({ labs: [{ ...LAB, funding_id: null }] }), { resolveLinks: false });
  assert.strictEqual(rows[0].route, null);
  // "no need detected" is not actionable. This tells somebody which field to fill.
  assert.ok(/grant number/i.test(rows[0].why), rows[0].why);
});

T('an inquiry splits on whether the catalogue has it', async () => {
  const q = fakeQuery({
    inquiries: [
      { id: 1, buyer_name: 'Can Gundogan', buyer_email: 'c@example.com', molecule_name: 'Yttrium oxide', status: 'in_conversation' },
      { id: 2, buyer_name: 'Ada Lovelace', buyer_email: 'a@example.com', molecule_name: 'Methylene Blue', status: 'new' },
    ],
    catalogue: [{ product_name: 'Methylene Blue', cas: '61-73-4', review_status: 'approved' }],
  });
  const rows = await buildQueue(q, { resolveLinks: false });
  const byWho = Object.fromEntries(rows.map((r) => [r.who, r]));
  assert.strictEqual(byWho['Can Gundogan'].route.need, 'custom_synthesis');
  assert.strictEqual(byWho['Ada Lovelace'].route.need, 'catalogue_api');
  // Approval travels with the row, because an unapproved product must never carry a link.
  assert.strictEqual(byWho['Ada Lovelace'].approved, true);
  assert.strictEqual(byWho['Can Gundogan'].approved, false);
});

T('buyers get a first name, academics get a surname', async () => {
  const rows = await buildQueue(fakeQuery({
    labs: [LAB],
    inquiries: [{ id: 1, buyer_name: 'Can Gundogan', buyer_email: 'c@example.com', molecule_name: 'Yttrium oxide', status: 'new' }],
  }), { resolveLinks: false });
  for (const r of rows.filter((x) => x.route)) {
    const m = renderNeed(r.route.need, 1, varsFor(r));
    if (NEED_CAMPAIGNS[r.route.need].formal) {
      assert.ok(m.text.startsWith(`Dear Professor ${r.last},`), m.text.slice(0, 40));
    } else {
      assert.ok(m.text.startsWith(`Hi ${r.first},`), m.text.slice(0, 40));
    }
  }
});

// ── NAME HANDLING, AGAINST THE REAL FILINGS ──────────────────────────────────

T('names are split the way RePORTER actually files them', () => {
  const cases = [
    ['Nicholas D Ball', 'Nicholas', 'Ball'],
    ['Pavel  Nagorny', 'Pavel', 'Nagorny'],          // two spaces
    ['JONATHAN A ELLMAN', 'Jonathan', 'Ellman'],      // ALL CAPS
    ['Margaret A. Phillips', 'Margaret', 'Phillips'],
    ['JOHN A. PORCO', 'John', 'Porco'],
    ['Jean-Pierre  Vilardaga', 'Jean-Pierre', 'Vilardaga'],
    ['Vy M van Dong', 'Vy', 'van Dong'],              // particle stays attached
  ];
  for (const [full, first, last] of cases) {
    assert.strictEqual(firstName(full), first, `first of "${full}"`);
    assert.strictEqual(lastName(full), last, `last of "${full}"`);
  }
});

T('an ALL-CAPS filing never produces "Dear Professor ELLMAN"', () => {
  const m = renderNeed('discovery', 1, {
    first: firstName('JONATHAN A ELLMAN'), last: lastName('JONATHAN A ELLMAN'),
    topic: 'C-H functionalization', evidence: 'I came across your work.',
  });
  assert.ok(m.text.startsWith('Dear Professor Ellman,'), m.text.slice(0, 40));
});

(async () => {
  for (const [n, f] of tests) {
    try { await f(); pass++; } catch (e) { fails.push(`${n}: ${e.message}`); }
  }
  if (fails.length) {
    console.error(`FAIL  ${fails.length} of ${pass + fails.length}`);
    for (const f of fails) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`ok  outreach queue — ${pass} passed`);
})();
