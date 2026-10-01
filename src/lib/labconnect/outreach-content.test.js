// What the LabConnect Agent says.
//
//   node --test src/lib/labconnect/outreach-content.test.js
//
// The failure that matters here is not an awkward sentence. It is an email that OFFERS SOMETHING WE
// CANNOT PLACE — sterility testing when no active lab runs it — because the reply to that is a
// request we cannot fulfil, and the first reply is the only one we get from a firm that already has
// a provider.

const { test } = require('node:test');
const assert = require('node:assert');
const { emailContent, callContent, offerFor, OPENING, WHY_SECOND, OBJECTIONS, TEST_PHRASE } =
  require('./outreach-content');
const { SEGMENTS, likelyTests } = require('./buyers');

// What the directory can place. `labs` is the count of ACTIVE labs behind a test.
const cap = (over = []) => over;
const FULL = [
  { test_code: 'assay_hplc', labs: 6, min_price_cents: 28000, fastest_days: 5 },
  { test_code: 'related_subs', labs: 4, min_price_cents: 41000, fastest_days: 7 },
  { test_code: 'dissolution', labs: 3, min_price_cents: 52000, fastest_days: 8 },
  { test_code: 'elemental_imp', labs: 2, min_price_cents: null, fastest_days: null },
  { test_code: 'micro_limits', labs: 5, min_price_cents: 33000, fastest_days: 10 },
];
const BUYER = { firm_name: 'Lakeside Pharmaceuticals', segment: 'generic_manufacturer' };

// ── the rule that matters ────────────────────────────────────────────────────

test('IT NEVER OFFERS A TEST NO ACTIVE LAB RUNS', () => {
  const r = emailContent({ firm_name: 'X', segment: 'compounding_pharmacy' }, FULL);
  // A compounding pharmacy wants potency_797, sterility and endotoxin. None is in FULL.
  for (const absent of ['potency_797', 'sterility', 'endotoxin']) {
    assert.ok(!r.offered.includes(absent), `offered ${absent}, which no active lab runs`);
    assert.ok(!r.body.includes(TEST_PHRASE[absent]), `the body names ${absent}`);
  }
  // It still writes something useful, from what we CAN place.
  assert.equal(r.ok, true);
  assert.ok(r.offered.length > 0, 'it should fall back to what we can place, not go silent');
});

test('with NOTHING placeable it REFUSES and says what to onboard', () => {
  // A real state on day one: a directory full of discovered labs and nobody active. A vaguer email
  // would be worse than none — it would burn the one approach this firm will read.
  const r = emailContent(BUYER, []);
  assert.equal(r.ok, false);
  assert.ok(!r.body, 'nothing may be generated');
  assert.match(r.why, /no active lab/);
  assert.match(r.why, /Onboard a lab for one of/, 'and it must say what would fix it');
  assert.match(r.why, /assay by HPLC/, 'naming the actual tests, in words');
});

test('a test with labs but ZERO count is not placeable', () => {
  // The shape a LEFT JOIN produces for a catalogue entry nobody runs. Counting it as placeable
  // would offer a test backed by nothing at all.
  const r = emailContent(BUYER, cap([{ test_code: 'assay_hplc', labs: 0, min_price_cents: null }]));
  assert.equal(r.ok, false, 'zero labs is the same as no entry');
});

test('IT IS A DISPLACEMENT SALE — it never asks whether they need testing', () => {
  // Every one of these firms already sends its work somewhere. "Do you need analytical testing?" is
  // answered "no, we have a lab" and the conversation is over.
  for (const segment of Object.keys(SEGMENTS)) {
    const r = emailContent({ firm_name: 'X', segment }, FULL);
    if (!r.ok) continue;
    const body = r.body.toLowerCase();
    for (const bad of ['do you need', 'are you looking for', 'do you require', 'interested in']) {
      assert.ok(!body.includes(bad), `${segment}: the copy asks "${bad}", which invites a no`);
    }
  }
  // And the pitch is explicitly about a SECOND source.
  assert.match(emailContent(BUYER, FULL).body, /second/i);
});

// ── what it will not claim ───────────────────────────────────────────────────

test('no price appears for a test no lab has quoted', () => {
  const r = emailContent({ firm_name: 'X', segment: 'generic_manufacturer' },
    cap([{ test_code: 'assay_hplc', labs: 3, min_price_cents: null, fastest_days: null }]));
  assert.equal(r.ok, true);
  assert.ok(!/\$/.test(r.body), 'a currency figure appeared for an unquoted test');
  assert.ok(!/\$0/.test(r.body), 'and certainly never $0');
  assert.match(r.body, /3 qualified labs/, 'but the depth we DO know is still stated');
});

test('no turnaround is promised that no lab has given', () => {
  const r = emailContent({ firm_name: 'X', segment: 'generic_manufacturer' },
    cap([{ test_code: 'assay_hplc', labs: 2, min_price_cents: 10000, fastest_days: null }]));
  assert.ok(!/\bdays\b/.test(r.body), 'the copy promised a turnaround it was not given');
  assert.match(r.body, /from \$100\b/, 'while the price it DOES have is used');
});

test('prices are a FROM, never a flat rate — the lab sets them and they differ', () => {
  const r = emailContent(BUYER, FULL);
  assert.match(r.body, /from \$280/);
  assert.match(r.body, /lab sets its own price|lab’s|laboratories/i);
  // The commercial model stated, because a buyer who thinks we are the lab asks us the wrong
  // questions and is surprised later.
  assert.match(callContent(BUYER, FULL).how_pricing_works, /lab sets the price/);
  assert.match(callContent(BUYER, FULL).how_pricing_works, /commission/);
});

test('it never claims to be cheaper or better', () => {
  for (const segment of Object.keys(SEGMENTS)) {
    const r = emailContent({ firm_name: 'X', segment }, FULL);
    if (!r.ok) continue;
    for (const bad of ['cheaper', 'lowest price', 'best lab', 'better than', 'guarantee', 'fastest in']) {
      assert.ok(!r.body.toLowerCase().includes(bad), `${segment}: claims "${bad}"`);
    }
  }
});

// ── GMP is not glossed over ─────────────────────────────────────────────────

test('a GMP segment is told the work is placed only with qualified labs', () => {
  const r = emailContent(BUYER, FULL);
  assert.match(r.body, /GMP work placed only with labs qualified for it/);
  assert.match(r.body, /You see which lab/, 'and that they see the lab before anything ships');
});

test('the research segment is NOT told it is GMP', () => {
  const r = emailContent({ firm_name: 'X', segment: 'research_biotech' },
    cap([{ test_code: 'characterisation', labs: 2, min_price_cents: 90000, fastest_days: 9 }]));
  assert.equal(r.ok, true);
  assert.match(r.body, /non-GMP/);
  assert.ok(!/All of it is GMP/.test(r.body));
});

// ── coverage of the segments ────────────────────────────────────────────────

test('GUARD: every segment has an opening and a second-source line', () => {
  // A missing entry renders the 'unknown' fallback, which is generic — and generic is exactly what
  // this copy exists not to be. Caught here rather than in somebody's inbox.
  for (const segment of Object.keys(SEGMENTS)) {
    assert.ok(OPENING[segment], `${segment} has no opening`);
    assert.ok(WHY_SECOND[segment], `${segment} has no second-source line`);
    assert.notEqual(OPENING[segment], OPENING.unknown, `${segment} reuses the generic opening`);
  }
  assert.ok(OPENING.unknown && WHY_SECOND.unknown, 'and the fallback itself must exist');
});

test('GUARD: every test a segment is likely to need has a phrase a person would say', () => {
  // Without one the email prints the catalogue code, e.g. "elemental_imp", in a sentence.
  for (const segment of [...Object.keys(SEGMENTS), 'unknown']) {
    for (const code of likelyTests(segment)) {
      assert.ok(TEST_PHRASE[code], `${code} (for ${segment}) has no spoken phrase`);
      assert.ok(!/_/.test(TEST_PHRASE[code]), `${TEST_PHRASE[code]} still looks like a code`);
    }
  }
});

test('each segment gets a DIFFERENT opening — this is not a mail merge', () => {
  const openings = new Set(Object.keys(SEGMENTS).map(s => OPENING[s]));
  assert.equal(openings.size, Object.keys(SEGMENTS).length, 'two segments share an opening line');
});

test('the subject names something concrete, not "our services"', () => {
  assert.match(emailContent(BUYER, FULL).subject, /assay by HPLC|second source/i);
  assert.match(emailContent({ segment: 'compounding_pharmacy' },
    cap([{ test_code: 'potency_797', labs: 1 }])).subject, /USP 797/);
  for (const segment of Object.keys(SEGMENTS)) {
    const r = emailContent({ segment }, FULL);
    if (!r.ok) continue;
    assert.ok(r.subject.length < 60, `${segment}: subject is too long to survive an inbox`);
    assert.ok(!/service|solution|partner/i.test(r.subject), `${segment}: subject is marketing filler`);
  }
});

// ── the call ────────────────────────────────────────────────────────────────

test('the call script says what we CANNOT place, not just what we can', () => {
  // A caller who cannot say "we have nobody for that yet" is the one who promises it.
  const c = callContent({ segment: 'compounding_pharmacy' },
    cap([{ test_code: 'assay_hplc', labs: 2, fastest_days: 4 }]));
  assert.equal(c.ok, true);
  assert.ok(c.what_we_cannot.length > 0, 'the gaps must be stated');
  assert.ok(c.what_we_cannot.includes(TEST_PHRASE.sterility));
  assert.ok(c.what_we_can_place.every(s => !/sterility/i.test(s)));
});

test('and the objections cover the two that actually come up', () => {
  const says = OBJECTIONS.map(o => o.they_say.toLowerCase()).join(' | ');
  assert.match(says, /already have a lab/, 'the displacement objection');
  assert.match(says, /any good/, 'the trust objection');
  for (const o of OBJECTIONS) {
    assert.ok(o.you_say.length > 60, `the answer to "${o.they_say}" is too thin to be useful`);
    assert.ok(!/just|simply/i.test(o.you_say), 'an answer that says "just" is dismissing the objection');
  }
});

test('the trust answer offers evidence rather than assurance', () => {
  const trust = OBJECTIONS.find(o => /any good/.test(o.they_say));
  assert.match(trust.you_say, /registration|accreditation/i);
  assert.match(trust.you_say, /before you send a sample/i, 'evidence arrives BEFORE the commitment');
});

// ── offerFor ────────────────────────────────────────────────────────────────

test('offerFor matches the segment first, then fills from what else we have', () => {
  const o = offerFor('generic_manufacturer', FULL);
  const matched = o.matched.map(c => c.test_code);
  assert.deepEqual(matched, ['assay_hplc', 'related_subs', 'dissolution', 'elemental_imp'],
    'and in the segment’s own order of importance, not the capability list’s');
  assert.ok(o.extra.every(c => !matched.includes(c.test_code)), 'no test appears twice');
});

test('the filler is ranked by DEPTH, because depth is what lets us promise a date', () => {
  const o = offerFor('research_biotech', FULL);
  const counts = o.extra.map(c => c.labs);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a), 'extras must be deepest-first');
  assert.ok(o.extra.length <= 3, 'and a handful, not the whole catalogue');
});

test('it does not mutate the capability list it is given', () => {
  const snapshot = JSON.stringify(FULL);
  emailContent(BUYER, FULL); callContent(BUYER, FULL); offerFor('generic_manufacturer', FULL);
  assert.equal(JSON.stringify(FULL), snapshot);
});

// ── THE DEFECT A PASSING SUITE MISSED ────────────────────────────────────────
//
// Found by reading a generated email, not by any assertion above. With no 797 capability, a
// compounding pharmacy received the subject "A second lab for your USP 797 testing" and an opening
// about USP 797 and 800 — then an offer of assay by HPLC and microbial limits. `offerFor` had
// correctly excluded the tests we cannot place; the copy AROUND the list had not been told.
//
// The "never offers a test no active lab runs" test passed, because it checked the offered codes
// and the body's test phrases. The promise was in the subject and the first sentence.

test('THE SUBJECT NEVER PROMISES A SPECIALTY THE LIST CANNOT DELIVER', () => {
  const r = emailContent({ firm_name: 'Greenfield Compounding Pharmacy', segment: 'compounding_pharmacy' },
    cap([{ test_code: 'assay_hplc', labs: 6, min_price_cents: 28000, fastest_days: 5 }]));
  assert.equal(r.ok, true);
  assert.equal(r.on_topic, false, 'none of this segment’s own tests is placeable');
  assert.ok(!/797|800/.test(r.subject), `the subject promised USP 797: "${r.subject}"`);
  assert.ok(!/797|800/.test(r.body), 'and the opening promised it too');
});

test('nor does the OPENING, which is where the specialty was asserted', () => {
  for (const segment of Object.keys(SEGMENTS)) {
    // One test, chosen so it is in no segment's own likelyTests list — so every segment comes out
    // off-topic and must fall back.
    const r = emailContent({ segment }, cap([{ test_code: 'particle_size', labs: 2 }]));
    if (!r.ok) continue;
    assert.equal(r.on_topic, false, `${segment} should be off-topic for particle size`);
    assert.equal(r.body.split('\n')[0], OPENING.unknown,
      `${segment}: the opening still claims its specialty on a list that does not contain it`);
  }
});

test('and the framing IS used when the list does deliver the specialty', () => {
  // The mirror image: the fallback must not swallow the tailoring when it is earned, or every
  // email becomes generic and the segmentation is decorative.
  const r = emailContent({ segment: 'compounding_pharmacy' },
    cap([{ test_code: 'potency_797', labs: 2, min_price_cents: 40000, fastest_days: 6 },
         { test_code: 'sterility', labs: 1, min_price_cents: 90000, fastest_days: 14 }]));
  assert.equal(r.on_topic, true);
  assert.match(r.subject, /USP 797/);
  assert.equal(r.body.split('\n')[0], OPENING.compounding_pharmacy);
});

test('on_topic is reported, so an off-topic approach can be seen before it is sent', () => {
  // It usually means a lab needs onboarding for that segment, not that this buyer should be mailed.
  const on = emailContent({ segment: 'generic_manufacturer' }, FULL);
  assert.equal(on.on_topic, true);
  assert.equal(typeof emailContent({ segment: 'compounding_pharmacy' }, FULL).on_topic, 'boolean');
});

test('THE CALL SCRIPT’S OPENING FOLLOWS THE SAME RULE AS THE EMAIL’S', () => {
  // The second half of the same defect, and it survived the first fix. A caller phoning a
  // compounding pharmacy was opening with "USP 797 and 800 testing is not optional" immediately
  // above a section listing the 797 tests under "what we cannot place". The email tests all passed
  // while this was true, because they only ever read emailContent.
  const c = callContent({ segment: 'compounding_pharmacy' },
    cap([{ test_code: 'assay_hplc', labs: 6, min_price_cents: 28000, fastest_days: 5 }]));
  assert.equal(c.ok, true);
  assert.equal(c.on_topic, false);
  assert.ok(!/797|800/.test(c.opening), `the opening promised USP 797: "${c.opening}"`);
  assert.equal(c.opening, OPENING.unknown);
  assert.equal(c.why_second_source, WHY_SECOND.unknown);
  // And the gaps it lists must be the ones it stopped claiming.
  assert.ok(c.what_we_cannot.some(x => /potency/.test(x)));
});

test('the call script DOES use the specialty when the list delivers it', () => {
  const c = callContent({ segment: 'compounding_pharmacy' },
    cap([{ test_code: 'potency_797', labs: 2, min_price_cents: 40000, fastest_days: 6 }]));
  assert.equal(c.on_topic, true);
  assert.equal(c.opening, OPENING.compounding_pharmacy);
  assert.equal(c.why_second_source, WHY_SECOND.compounding_pharmacy);
});

test('GUARD: email and call agree about on_topic for the same inputs', () => {
  // Two code paths deciding the same thing is how they drifted in the first place. If they ever
  // disagree, one of them is promising something the other is not.
  const caps = [
    [],
    cap([{ test_code: 'assay_hplc', labs: 1 }]),
    cap([{ test_code: 'potency_797', labs: 1 }]),
    FULL,
  ];
  for (const segment of Object.keys(SEGMENTS)) {
    for (const capability of caps) {
      const e = emailContent({ segment }, capability);
      const c = callContent({ segment }, capability);
      assert.equal(e.ok, c.ok, `${segment}: email and call disagree about whether anything is placeable`);
      if (!e.ok) continue;
      assert.equal(e.on_topic, c.on_topic, `${segment}: email says on_topic=${e.on_topic}, call says ${c.on_topic}`);
    }
  }
});
