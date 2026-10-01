// ── ROUTING AN ORDER TO A LAB ─────────────────────────────────────────────────
//
// Pure. No database, no network, no clock. Given an order and a list of labs, it answers which labs
// could take it, in what order to offer it to them, and — for every lab it ruled out — why.
//
// ── WHY REGION IS NOT THE FIRST QUESTION ──────────────────────────────────────
//
// The brief was "the order goes to the nearest region lab". That is the wrong primary key and it
// matters enough to say in code rather than in a meeting. A QC sample ships overnight; whether a lab
// can take an order is decided by whether it runs that method, under the right accreditation, for the
// right regulatory purpose. A dissolution test and an elemental impurities test may share no
// qualified lab anywhere in the country, so "nearest" can easily mean "nearest lab that cannot do
// it". Capability is a HARD filter; region is the first tie-break among labs that already qualify,
// which is where it genuinely earns its place — cold chain, short hold times, and the simple fact
// that a lab in your own time zone answers the phone.
//
// ── THE ONE INVARIANT THAT IS SAFETY-CRITICAL ─────────────────────────────────
//
// A GMP ORDER NEVER FALLS BACK TO A NON-GMP LAB. Not as a lower-ranked option, not with a warning,
// not when there is nothing else. A release test run by an unqualified lab produces a result that
// goes into a client's batch record and their regulatory filing; the failure surfaces at an
// inspection, months later, as their problem. There is no version of "better than nothing" here, so
// the GMP check is a filter and the function returns NOTHING rather than something unsuitable.
//
// ── AND IT FAILS CLOSED ON STATUS ─────────────────────────────────────────────
//
// Only an 'active' lab is routable. Most rows in the directory came out of the FDA register and have
// never been contacted — they have agreed to nothing and do not know they are listed. Routing a
// client's sample to one of those is the worst thing this product could do, so status is checked
// here as well as in the route that assigns work. Two checks, because the consequence is a physical
// shipment to a firm that never said yes.

// Hard-filter reasons, as stable keys. The UI renders the sentence; callers compare the key.
const REJECT = {
  NOT_ACTIVE: 'not_active',
  NO_SUCH_TEST: 'no_such_test',
  NOT_GMP_TEST: 'not_gmp_test',
  NOT_GMP_LAB: 'not_gmp_lab',
  NOT_ACCREDITED: 'not_accredited',
  NO_REGION: 'no_region',
  WRONG_COUNTRY: 'wrong_country',
};

const REJECT_TEXT = {
  [REJECT.NOT_ACTIVE]: (l) => `status is '${l.status}' — only an active lab may receive an order`,
  [REJECT.NO_SUCH_TEST]: () => 'does not list this test in its catalogue',
  [REJECT.NOT_GMP_TEST]: () => 'lists this test but not for GMP work',
  [REJECT.NOT_GMP_LAB]: () => 'is not set up for GMP release testing',
  [REJECT.NOT_ACCREDITED]: () => 'is not accredited for this test',
  [REJECT.NO_REGION]: () => 'has no determined location, so an order cannot be shipped to it',
  [REJECT.WRONG_COUNTRY]: (l, o) => `is in ${l.country || 'an unknown country'}, and this order must stay in ${o.country}`,
};

/** The sentence a person reads next to a ruled-out lab. */
function rejectReason(code, lab, order) {
  const f = REJECT_TEXT[code];
  return f ? f(lab || {}, order || {}) : code;
}

// `null` sorts LAST for both price and turnaround, and the two nulls mean different things:
// an unpriced test needs a quote before it can be offered, and an unstated turnaround cannot be
// promised to a client. Neither disqualifies a lab — both make it a worse first choice than a lab
// that has committed to a number.
const nullsLast = (a, b) => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
};

/**
 * Which labs can take this order, best first.
 *
 *   matchLabs(
 *     { test_code: 'dissolution', gmp: true, region: 'us_central', country: 'USA' },
 *     labs
 *   )
 *   → { routable: true, matches: [{ lab, test, score... }], rejected: [{ lab, code, reason }], why_not: null }
 *
 * `order.gmp` is the regulatory purpose of the ORDER, not a preference. True means a GMP release
 * test and the filter above applies. False means research or development work, where a GMP-capable
 * lab is perfectly acceptable — the constraint only runs one way.
 *
 * `order.require_accredited` is separate from gmp on purpose. A lab can be GMP-registered and still
 * have a particular method outside its ISO 17025 scope, and some clients require the accreditation
 * specifically. Defaults false so an ordinary order is not silently narrowed.
 *
 * `order.country`, when given, is a HARD filter. Shipping a sample across a border raises customs,
 * import licensing and (for some materials) controlled-substance questions that are not this
 * function's to assume away. Omit it to allow anywhere.
 *
 * `order.region` is NOT a filter — it is the first tie-break. A region that no qualified lab serves
 * must not empty the result, because the sample can ship.
 */
function matchLabs(order, labs) {
  const o = order || {};
  const matches = [];
  const rejected = [];

  if (!o.test_code) {
    return {
      routable: false, matches: [], rejected: [],
      why_not: 'the order does not name a test, so no lab can be matched to it',
    };
  }

  for (const lab of (labs || [])) {
    const reject = (code) => rejected.push({ lab, code, reason: rejectReason(code, lab, o) });

    // 1. STATUS. First, and unconditional.
    if (lab.status !== 'active') { reject(REJECT.NOT_ACTIVE); continue; }

    // 2. A location we can ship to. A lab whose region could not be determined is usually a
    //    US-agent row, where the address on file is a law office — so "we know where it is" is a
    //    real precondition and not a tidiness check.
    if (!lab.region) { reject(REJECT.NO_REGION); continue; }
    if (o.country && lab.country !== o.country) { reject(REJECT.WRONG_COUNTRY); continue; }

    // 3. Does it run the test at all?
    const test = (lab.tests || []).find(t => t && t.test_code === o.test_code);
    if (!test) { reject(REJECT.NO_SUCH_TEST); continue; }

    // 4. GMP, in both directions: the lab as a whole, and this test specifically. A lab can be
    //    GMP-capable and run a given method only for development work.
    if (o.gmp) {
      if (!lab.gmp_capable) { reject(REJECT.NOT_GMP_LAB); continue; }
      if (!test.gmp) { reject(REJECT.NOT_GMP_TEST); continue; }
    }

    // 5. Accreditation, only when the order asks for it.
    if (o.require_accredited && !test.accredited) { reject(REJECT.NOT_ACCREDITED); continue; }

    matches.push({
      lab, test,
      same_region: lab.region === o.region,
      same_country: !!(o.country && lab.country === o.country),
      price_cents: test.price_cents == null ? null : test.price_cents,
      turnaround_days: test.turnaround_days == null ? null : test.turnaround_days,
      needs_quote: test.price_cents == null,
    });
  }

  // THE RANKING, in order, each tier only breaking ties left by the one above:
  //   1. the order's own region, because that is where distance actually matters
  //   2. then the same country, which is the next coarsest shipping reality
  //   3. then turnaround, because a client asks "when" before "how much"
  //   4. then price, with unpriced last — an unpriced lab needs a quote before it can be offered
  //   5. then id, so the order is STABLE: an unstable sort means the same order routes differently
  //      on two identical calls, and nobody could reproduce a routing decision afterwards
  matches.sort((a, b) =>
    (b.same_region - a.same_region)
    || (b.same_country - a.same_country)
    || nullsLast(a.turnaround_days, b.turnaround_days)
    || nullsLast(a.price_cents, b.price_cents)
    || (a.lab.id - b.lab.id));

  return {
    routable: matches.length > 0,
    matches,
    rejected,
    // WHY NOT, in words, built from what actually happened. "No lab available" on its own sends
    // somebody to the code; this says whether the problem is that nobody is active, nobody runs the
    // test, or nobody runs it under GMP — three different things to go and fix.
    why_not: matches.length ? null : explainEmpty(o, labs || [], rejected),
  };
}

function explainEmpty(order, labs, rejected) {
  if (!labs.length) return 'there are no labs in the directory at all';
  const count = (code) => rejected.filter(r => r.code === code).length;
  const active = labs.filter(l => l.status === 'active').length;

  if (!active) {
    return `none of the ${labs.length} labs is active — every one is still discovered, invited or `
         + 'onboarding, so no order can be routed to any of them yet';
  }
  if (count(REJECT.NO_SUCH_TEST) === active) {
    return `all ${active} active labs were ruled out because none lists this test — somebody has to `
         + 'price it with a lab before an order for it can be taken';
  }
  const gmpBlocked = count(REJECT.NOT_GMP_LAB) + count(REJECT.NOT_GMP_TEST);
  if (order.gmp && gmpBlocked) {
    return `${gmpBlocked} lab(s) run this test but not under GMP. A GMP release test is not routed `
         + 'to an unqualified lab under any circumstances, so this order cannot be placed as it stands';
  }
  if (order.country && count(REJECT.WRONG_COUNTRY)) {
    return `no qualified lab is in ${order.country}, and this order is restricted to that country`;
  }
  if (count(REJECT.NOT_ACCREDITED)) {
    return 'labs run this test but none is accredited for it, and this order requires accreditation';
  }
  return 'no active lab satisfies every requirement of this order';
}

/**
 * The one-line summary for a human, from a match result. Separate from matchLabs so the engine
 * stays free of presentation and can be tested on its decisions rather than its prose.
 */
function describeRouting(result, order) {
  if (!result.routable) return `Cannot route: ${result.why_not}.`;
  const best = result.matches[0];
  const where = best.same_region ? 'in the same region'
    : best.same_country ? `in ${best.lab.country}` : 'out of region';
  const when = best.turnaround_days == null ? 'turnaround not stated' : `${best.turnaround_days} days`;
  const what = best.needs_quote ? 'needs a quote'
    : '$' + (best.price_cents / 100).toLocaleString('en-US');
  return `${result.matches.length} lab(s) can take it. First choice ${best.lab.name} — `
       + `${where}, ${when}, ${what}.`
       + (order && order.gmp ? ' GMP.' : '');
}

module.exports = { matchLabs, describeRouting, rejectReason, REJECT };
