// Routing an order to a lab.
//
//   node --test src/lib/labconnect/match.test.js
//
// Two failures are worth more than all the others and are tested hardest:
//
//   1. A GMP release test routed to a lab that is not qualified for it. The result goes into a
//      client's batch record and their filing, and surfaces at an inspection months later as their
//      problem. There is no "better than nothing" here.
//   2. An order routed to a lab that never agreed to receive one. Most of the directory came out of
//      the FDA register; those firms do not know they are listed. The failure is a physical
//      shipment of someone's material to a company that did not say yes.
//
// Everything else is ranking, which is a preference. Those two are correctness.

const { test } = require('node:test');
const assert = require('node:assert');
const { matchLabs, describeRouting, rejectReason, REJECT } = require('./match');

// A lab that qualifies for everything, as the baseline to deviate from one field at a time.
const lab = (over = {}) => ({
  id: 1, name: 'Baseline Labs', status: 'active', region: 'us_central', country: 'USA',
  gmp_capable: true, research_capable: true,
  tests: [{ test_code: 'dissolution', price_cents: 50000, turnaround_days: 7, accredited: true, gmp: true }],
  ...over,
});
const ORDER = { test_code: 'dissolution', gmp: true, region: 'us_central', country: 'USA' };

// ── the two that matter ──────────────────────────────────────────────────────

test('A GMP ORDER IS NEVER ROUTED TO A LAB THAT IS NOT GMP-CAPABLE', () => {
  const r = matchLabs(ORDER, [lab({ gmp_capable: false })]);
  assert.equal(r.routable, false, 'a non-GMP lab must not appear at all');
  assert.equal(r.matches.length, 0, 'not even as a lower-ranked option');
  assert.equal(r.rejected[0].code, REJECT.NOT_GMP_LAB);
});

test('nor to a lab that runs the test only for NON-GMP work', () => {
  // The narrower case, and the one a coarser check would miss: the lab is GMP-capable overall and
  // this particular method is development-only.
  const r = matchLabs(ORDER, [lab({ tests: [{ test_code: 'dissolution', price_cents: 1, turnaround_days: 1, accredited: true, gmp: false }] })]);
  assert.equal(r.routable, false);
  assert.equal(r.rejected[0].code, REJECT.NOT_GMP_TEST);
  // And note the lab was the cheapest and fastest possible. Ranking must never be able to rescue it.
});

test('a GMP order finds NOTHING rather than something unsuitable, even with no alternative', () => {
  // The temptation this guards: "there is one lab, it nearly qualifies, offer it with a warning".
  const r = matchLabs(ORDER, [lab({ id: 1, gmp_capable: false }), lab({ id: 2, gmp_capable: false })]);
  assert.equal(r.matches.length, 0);
  assert.match(r.why_not, /not routed to an unqualified lab under any circumstances/);
});

test('a NON-GMP order may go to a GMP lab — the constraint runs one way only', () => {
  // The mirror image. Over-restricting here would mean research work could not use the best labs.
  const r = matchLabs({ ...ORDER, gmp: false }, [lab()]);
  assert.equal(r.routable, true);
  assert.equal(r.matches.length, 1);
});

test('ONLY AN ACTIVE LAB IS ROUTABLE', () => {
  for (const status of ['discovered', 'invited', 'onboarding', 'paused', 'rejected']) {
    const r = matchLabs({ ...ORDER, gmp: false }, [lab({ status })]);
    assert.equal(r.routable, false, `'${status}' must not be routable`);
    assert.equal(r.rejected[0].code, REJECT.NOT_ACTIVE);
    assert.match(r.rejected[0].reason, new RegExp(status), 'and the reason names the actual status');
  }
});

test('status is checked BEFORE anything else, so a perfect non-active lab is still refused', () => {
  const r = matchLabs(ORDER, [lab({ status: 'discovered' })]);
  assert.equal(r.rejected[0].code, REJECT.NOT_ACTIVE,
    'a discovered lab that qualifies on every other count must still be rejected on status');
});

// ── the hard filters ─────────────────────────────────────────────────────────

test('a lab with no determined region cannot be shipped to', () => {
  // These are overwhelmingly US-agent rows, where the address on file is a law office rather than
  // the laboratory. "We know where it is" is a precondition for shipping a sample, not tidiness.
  const r = matchLabs({ ...ORDER, gmp: false }, [lab({ region: null })]);
  assert.equal(r.routable, false);
  assert.equal(r.rejected[0].code, REJECT.NO_REGION);
});

test('a lab that does not list the test is ruled out, and the message says so', () => {
  const r = matchLabs({ ...ORDER, gmp: false }, [lab({ tests: [{ test_code: 'sterility', gmp: true }] })]);
  assert.equal(r.rejected[0].code, REJECT.NO_SUCH_TEST);
  assert.match(r.why_not, /none lists this test/);
  assert.match(r.why_not, /price it with a lab/, 'and says what to do about it');
});

test('country is a HARD filter when the order sets one', () => {
  // Shipping across a border raises customs, import licensing and controlled-substance questions
  // this function has no business assuming away.
  const r = matchLabs({ ...ORDER, gmp: false, country: 'USA' }, [lab({ country: 'DEU', region: 'eu_deu' })]);
  assert.equal(r.routable, false);
  assert.equal(r.rejected[0].code, REJECT.WRONG_COUNTRY);
  assert.match(r.rejected[0].reason, /DEU/);
  assert.match(r.rejected[0].reason, /must stay in USA/);
});

test('with no country on the order, anywhere qualifies', () => {
  const { country, ...noCountry } = { ...ORDER, gmp: false };
  const r = matchLabs(noCountry, [lab({ country: 'DEU', region: 'eu_deu' })]);
  assert.equal(r.routable, true, 'omitting country must not silently restrict to one');
});

test('accreditation is only required when the order asks for it', () => {
  const unaccredited = lab({ tests: [{ test_code: 'dissolution', price_cents: 1, turnaround_days: 1, accredited: false, gmp: true }] });
  assert.equal(matchLabs({ ...ORDER }, [unaccredited]).routable, true, 'not required by default');
  const r = matchLabs({ ...ORDER, require_accredited: true }, [unaccredited]);
  assert.equal(r.routable, false, 'required when asked');
  assert.equal(r.rejected[0].code, REJECT.NOT_ACCREDITED);
});

// ── REGION IS A TIE-BREAK, NOT A FILTER ──────────────────────────────────────

test('a region no qualified lab serves does NOT empty the result', () => {
  // THE CORRECTION TO THE ORIGINAL BRIEF. "The order goes to the nearest region lab" would make
  // region a filter, and then an order from a region with no lab could not be placed at all — even
  // though the sample ships overnight.
  const r = matchLabs({ ...ORDER, gmp: false, region: 'us_mountain' },
    [lab({ id: 1, region: 'us_east' }), lab({ id: 2, region: 'us_pacific' })]);
  assert.equal(r.routable, true, 'out-of-region labs must still be offered');
  assert.equal(r.matches.length, 2);
  assert.equal(r.matches.every(m => m.same_region === false), true);
});

test('but the order’s own region wins among labs that already qualify', () => {
  const r = matchLabs({ ...ORDER, gmp: false, region: 'us_central' }, [
    lab({ id: 1, region: 'us_east', tests: [{ test_code: 'dissolution', price_cents: 100, turnaround_days: 1, gmp: true }] }),
    lab({ id: 2, region: 'us_central', tests: [{ test_code: 'dissolution', price_cents: 99999, turnaround_days: 30, gmp: true }] }),
  ]);
  // The in-region lab is slower AND dearer and still comes first: region outranks both.
  assert.equal(r.matches[0].lab.id, 2);
  assert.equal(r.matches[0].same_region, true);
});

test('then country, then turnaround, then price', () => {
  const t = (price, days) => [{ test_code: 'dissolution', price_cents: price, turnaround_days: days, gmp: true, accredited: true }];
  const r = matchLabs({ test_code: 'dissolution', gmp: false, region: 'us_east', country: 'USA' }, [
    lab({ id: 1, region: 'us_pacific', country: 'USA', tests: t(10000, 20) }),
    lab({ id: 2, region: 'us_east', country: 'USA', tests: t(90000, 20) }),
    lab({ id: 3, region: 'us_east', country: 'USA', tests: t(90000, 5) }),
    lab({ id: 4, region: 'us_east', country: 'USA', tests: t(20000, 5) }),
  ]);
  // in-region beats out-of-region; among in-region, fastest first; among equally fast, cheapest.
  assert.deepEqual(r.matches.map(m => m.lab.id), [4, 3, 2, 1]);
});

test('an unpriced test ranks LAST among equals, and still qualifies', () => {
  // A lab that will run the test but has not quoted needs a round trip before it can be offered.
  // That makes it a worse first choice, not an unusable one — and never a $0 one.
  const t = (price) => [{ test_code: 'dissolution', price_cents: price, turnaround_days: 7, gmp: true }];
  const r = matchLabs({ test_code: 'dissolution', gmp: false, region: 'us_east' }, [
    lab({ id: 1, region: 'us_east', tests: t(null) }),
    lab({ id: 2, region: 'us_east', tests: t(80000) }),
  ]);
  assert.deepEqual(r.matches.map(m => m.lab.id), [2, 1]);
  assert.equal(r.matches[1].needs_quote, true);
  assert.equal(r.matches[1].price_cents, null, 'and must not have become zero');
});

test('an unstated turnaround also ranks last rather than being treated as zero days', () => {
  const r = matchLabs({ test_code: 'dissolution', gmp: false, region: 'us_east' }, [
    lab({ id: 1, region: 'us_east', tests: [{ test_code: 'dissolution', price_cents: 1000, turnaround_days: null, gmp: true }] }),
    lab({ id: 2, region: 'us_east', tests: [{ test_code: 'dissolution', price_cents: 9000, turnaround_days: 14, gmp: true }] }),
  ]);
  assert.deepEqual(r.matches.map(m => m.lab.id), [2, 1],
    'null turnaround must not sort as the fastest, which is what a plain subtraction would do');
});

test('THE ORDER IS STABLE — two identical calls rank identically', () => {
  // An unstable sort means the same order routes differently on two runs and nobody can reproduce a
  // routing decision afterwards, which is exactly the question asked when one goes wrong.
  const labs = [5, 3, 9, 1, 7].map(id => lab({ id, tests: [{ test_code: 'dissolution', price_cents: 5000, turnaround_days: 5, gmp: true }] }));
  const once = matchLabs(ORDER, labs).matches.map(m => m.lab.id);
  const twice = matchLabs(ORDER, [...labs].reverse()).matches.map(m => m.lab.id);
  assert.deepEqual(once, twice, 'input order must not change the result');
  assert.deepEqual(once, [1, 3, 5, 7, 9], 'and the tie-break is the id, ascending');
});

// ── empty results explain themselves ────────────────────────────────────────

test('an empty directory says so rather than blaming the order', () => {
  const r = matchLabs(ORDER, []);
  assert.equal(r.routable, false);
  assert.match(r.why_not, /no labs in the directory at all/);
});

test('"nobody is active yet" is its own diagnosis', () => {
  // The commonest state on day one, and the one most likely to be misread as a broken router.
  const r = matchLabs(ORDER, [lab({ id: 1, status: 'discovered' }), lab({ id: 2, status: 'invited' })]);
  assert.match(r.why_not, /none of the 2 labs is active/);
  assert.match(r.why_not, /discovered, invited or onboarding/);
});

test('an order with no test named is refused before any lab is examined', () => {
  const r = matchLabs({ region: 'us_east' }, [lab()]);
  assert.equal(r.routable, false);
  assert.equal(r.rejected.length, 0, 'no lab should be blamed for an incomplete order');
  assert.match(r.why_not, /does not name a test/);
});

test('every rejection carries a key AND a sentence', () => {
  // The key is for callers to branch on; the sentence is for the person who has to fix it. A code
  // with no sentence sends somebody to the source to find out what happened.
  const r = matchLabs(ORDER, [
    lab({ id: 1, status: 'discovered' }),
    lab({ id: 2, region: null }),
    lab({ id: 3, tests: [] }),
    lab({ id: 4, gmp_capable: false }),
  ]);
  assert.equal(r.rejected.length, 4);
  for (const rej of r.rejected) {
    assert.ok(Object.values(REJECT).includes(rej.code), `${rej.code} is not a known reject code`);
    assert.ok(rej.reason && rej.reason.length > 10, `${rej.code} has no readable reason`);
    assert.notEqual(rej.reason, rej.code, 'the sentence must not just be the key');
  }
});

test('GUARD: every reject code has a sentence', () => {
  // A new code added to REJECT without text would render as a bare key in the UI.
  for (const code of Object.values(REJECT)) {
    const s = rejectReason(code, lab({ status: 'paused' }), ORDER);
    assert.notEqual(s, code, `${code} has no entry in REJECT_TEXT`);
  }
});

// ── the summary line ────────────────────────────────────────────────────────

test('the summary names the first choice and why it won', () => {
  const r = matchLabs(ORDER, [lab({ name: 'Keystone Analytical' })]);
  const s = describeRouting(r, ORDER);
  assert.match(s, /Keystone Analytical/);
  assert.match(s, /same region/);
  assert.match(s, /7 days/);
  assert.match(s, /\$500/);
  assert.match(s, /GMP/);
});

test('and an unroutable order gets the reason, not a count of zero', () => {
  const s = describeRouting(matchLabs(ORDER, [lab({ status: 'discovered' })]), ORDER);
  assert.match(s, /^Cannot route:/);
  assert.match(s, /none of the 1 labs is active/);
  assert.ok(!/^0 lab/.test(s), '"0 labs can take it" is not an explanation');
});

test('the summary never prints a price for an unquoted test', () => {
  const r = matchLabs({ ...ORDER, gmp: false },
    [lab({ tests: [{ test_code: 'dissolution', price_cents: null, turnaround_days: 7, gmp: true }] })]);
  const s = describeRouting(r, ORDER);
  assert.match(s, /needs a quote/);
  assert.ok(!/\$/.test(s), 'no currency figure may appear for an unpriced test');
});

// ── purity ──────────────────────────────────────────────────────────────────

test('it does not mutate what it is given', () => {
  // The engine gets rows straight off a query; mutating them would corrupt whatever the caller does
  // with the same array next.
  const labs = [lab({ id: 2 }), lab({ id: 1 })];
  const snapshot = JSON.stringify(labs);
  matchLabs(ORDER, labs);
  assert.equal(JSON.stringify(labs), snapshot, 'the input array and its rows must be untouched');
});
