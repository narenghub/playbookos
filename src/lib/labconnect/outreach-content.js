// ── WHAT THE LABCONNECT AGENT SAYS ────────────────────────────────────────────
//
// Pure. Given one buyer and what the directory can actually deliver, it produces the email and the
// phone script. No database, no network, no model call — the wording is a decision, and a decision
// should be readable and testable rather than regenerated differently every time.
//
// ── THE TWO RULES THAT SHAPE EVERY LINE ───────────────────────────────────────
//
// 1. IT NEVER OFFERS A TEST NO ACTIVE LAB RUNS. `capability` is passed in — the catalogue codes that
//    have at least one active lab behind them — and the content is built from the intersection of
//    what this buyer needs and what we can actually place. A generated email that offers sterility
//    testing when no active lab runs it produces a reply we cannot answer, and the first reply is
//    the only one we get. If the intersection is empty the generator REFUSES and says why, rather
//    than writing something vaguer.
//
// 2. IT IS A DISPLACEMENT SALE AND THE COPY KNOWS IT. Every one of these firms already sends its
//    testing somewhere. "Do you need analytical testing?" is answered "no, we have a lab we use"
//    and the conversation is over. So the opening is about capacity, turnaround and a second source
//    — the reasons a firm that HAS a provider talks to a second one — and never about the need.
//
// WHAT IT WILL NOT CLAIM, because none of it is known at generation time: a turnaround we have not
// been quoted, a price we have not been given, an accreditation we have not recorded, or that we
// are cheaper. The directory holds real numbers for some tests and nothing for others, and the copy
// uses the real ones and stays silent otherwise.

const { SEGMENTS, likelyTests } = require('./buyers');

// The opening line per segment: why a firm that already has a lab would read the second sentence.
// Each is about capacity or risk, never about need.
const OPENING = {
  virtual_pharma: 'You are releasing product without a laboratory of your own, which means every '
    + 'batch waits on somebody else’s queue.',
  generic_manufacturer: 'Your site is registered to manufacture but not for analysis, so your '
    + 'release testing is going out of house — and when your provider is full, your batch waits.',
  cro_cdmo: 'You are running your clients’ work to their quality agreements, which means the tests '
    + 'you do not run in house are on somebody else’s schedule, not yours.',
  compounding_pharmacy: 'USP 797 and 800 testing is not optional and it does not pause when your '
    + 'lab is backed up.',
  research_biotech: 'Characterisation work tends to sit in a queue behind somebody’s commercial '
    + 'release testing, which is a slow way to answer a question you need answered now.',
  unknown: 'Your site is registered to make product but not to test it, so your analytical work is '
    + 'going somewhere outside.',
};

// The second-source argument, which is the actual offer. Also per segment, because what a
// compounding pharmacy fears is not what a CDMO fears.
const WHY_SECOND = {
  virtual_pharma: 'A second qualified lab means a batch is not held up because one laboratory is full.',
  generic_manufacturer: 'A second source is what stops a full queue at one lab becoming a late shipment.',
  cro_cdmo: 'A second source lets you quote a client a date you control rather than one you are given.',
  compounding_pharmacy: 'A second accredited lab means a recurring obligation does not depend on one provider.',
  research_biotech: 'A lab that is not clearing a release-testing backlog can usually start sooner.',
  unknown: 'A second qualified lab means a batch is not held up because one laboratory is full.',
};

const OBJECTIONS = [
  {
    they_say: 'We already have a lab we use.',
    you_say: 'Nearly everyone does — I am not asking you to move anything. The question is who runs '
      + 'it the week your lab says six weeks, and whether you want that sorted before you need it '
      + 'rather than during.',
  },
  {
    they_say: 'How do I know your labs are any good?',
    you_say: 'You do not take my word for it. Every lab is an FDA-registered establishment, and I '
      + 'will send you the specific lab, its registration and its accreditation scope before you '
      + 'send a sample. If the scope does not cover your method, it is not offered to you.',
  },
  {
    they_say: 'What does it cost?',
    you_say: 'The lab sets its own price, not us — we add a commission on top of their quote and '
      + 'you see the lab. I can get you a quote for a named test this week.',
  },
  {
    they_say: 'Send me something.',
    you_say: 'I will send the tests we can place today, with the labs behind them. If what you need '
      + 'is not on it, tell me the method and I will find out whether we have anyone for it rather '
      + 'than guess.',
  },
];

const TEST_PHRASE = {
  // `identification` was missing from this map on the first pass, and likelyTests('research_biotech')
  // asks for it — so the email would have printed "identification" fine but the GUARD below exists
  // because the next omission might be `elemental_imp`, which reads as a code in a sentence.
  identification: 'identification',
  assay_hplc: 'assay by HPLC',
  related_subs: 'related substances',
  residual_solvents: 'residual solvents',
  elemental_imp: 'elemental impurities to ICH Q3D',
  water_content: 'water content by Karl Fischer',
  dissolution: 'dissolution to USP <711>',
  uniformity: 'uniformity of dosage units',
  particle_size: 'particle size distribution',
  micro_limits: 'microbial limits',
  sterility: 'sterility to USP <71>',
  endotoxin: 'bacterial endotoxins',
  potency_797: 'potency for compounded preparations',
  stability_icha: 'ICH stability studies',
  characterisation: 'molecule characterisation',
};

/** "a, b and c" — an Oxford-free list, because this is read aloud as well as sent. */
function list(items) {
  const a = items.filter(Boolean);
  if (!a.length) return '';
  if (a.length === 1) return a[0];
  return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}

/**
 * What we can offer THIS buyer: the tests their segment needs, narrowed to the ones an active lab
 * actually runs. The narrowing is the whole point and is done here rather than in the template, so
 * a template change can never reintroduce an offer we cannot place.
 *
 * `capability` is [{ test_code, labs, min_price_cents, fastest_days }] for ACTIVE labs only — the
 * caller builds it from the directory, and the caller is responsible for the 'active' part because
 * only the database knows it.
 */
function offerFor(segment, capability) {
  const want = likelyTests(segment);
  const have = new Map((capability || []).filter(c => c && c.labs > 0).map(c => [c.test_code, c]));
  const matched = want.filter(code => have.has(code)).map(code => have.get(code));
  // Anything else we can place, so a buyer whose usual set we cannot cover still gets a real offer
  // rather than nothing. Ranked by how many labs stand behind it: depth is what lets us promise a
  // date, and it is the honest way to order a list we did not tailor.
  const extra = [...have.values()]
    .filter(c => !want.includes(c.test_code))
    .sort((a, b) => b.labs - a.labs)
    .slice(0, 3);
  return { matched, extra, total: matched.length + extra.length };
}

/**
 * The email, as subject and body. Returns `{ ok: false, why }` when there is nothing we can
 * honestly offer — which is a real outcome early on, when the directory is full of labs nobody has
 * onboarded yet.
 */
function emailContent(buyer, capability, opts = {}) {
  const segment = (buyer && buyer.segment) || 'unknown';
  const offer = offerFor(segment, capability);

  if (!offer.total) {
    return {
      ok: false,
      why: 'no active lab runs any test this buyer is likely to need, so there is nothing to offer '
         + 'them yet. Onboard a lab for one of: ' + list(likelyTests(segment).map(c => TEST_PHRASE[c] || c)),
    };
  }

  const name = (buyer && buyer.firm_name) || 'your team';
  const lines = [];

  // ── THE SUBJECT AND OPENING MAY ONLY PROMISE WHAT THE LIST DELIVERS ─────────
  //
  // Found by reading the generated email rather than by a test. With no 797 capability, a
  // compounding pharmacy was getting the subject "A second lab for your USP 797 testing" and an
  // opening about USP 797 and 800 — followed by an offer of assay by HPLC and microbial limits. The
  // offer list was correct, because `offerFor` had already excluded the tests we cannot place; the
  // subject and the opening had not been told.
  //
  // That is the exact failure this module exists to prevent, arriving through the one route the
  // "never offer what we cannot place" test did not cover: the copy AROUND the list. A reply asking
  // for 797 potency is a reply we cannot answer, and from a firm that already has a provider it is
  // the only reply we get.
  //
  // So the segment-specific framing is used only when at least one of the segment's OWN tests is
  // placeable. Otherwise the opening is the generic one — true of every one of these firms — and the
  // email leads with the test we can actually place, which is a weaker approach and an honest one.
  const onTopic = offer.matched.length > 0;

  lines.push(onTopic ? (OPENING[segment] || OPENING.unknown) : OPENING.unknown);
  lines.push('');
  lines.push('We run a network of FDA-registered testing laboratories and place work with the one '
    + 'qualified for the specific method — not the nearest one. '
    + (onTopic ? (WHY_SECOND[segment] || WHY_SECOND.unknown) : WHY_SECOND.unknown));
  lines.push('');

  // THE CONCRETE PART. Named tests with real numbers where we have them and silence where we do
  // not. A range rather than a figure, because the price is the lab's and it differs between them.
  lines.push('What we can place today:');
  for (const c of [...offer.matched, ...offer.extra]) {
    const phrase = TEST_PHRASE[c.test_code] || c.test_code;
    const bits = [];
    if (c.labs) bits.push(c.labs + ' qualified lab' + (c.labs === 1 ? '' : 's'));
    // Only stated when a lab has actually quoted it. No figure invented, and never "$0".
    if (c.min_price_cents != null) bits.push('from $' + Math.round(c.min_price_cents / 100).toLocaleString('en-US'));
    if (c.fastest_days != null) bits.push('from ' + c.fastest_days + ' days');
    lines.push('  • ' + phrase + (bits.length ? ' — ' + bits.join(', ') : ''));
  }
  lines.push('');

  if (SEGMENTS[segment] && SEGMENTS[segment].gmp) {
    lines.push('All of it is GMP work placed only with labs qualified for it. You see which lab '
      + 'before anything ships, with its registration and accreditation scope.');
  } else {
    lines.push('This is non-GMP development work, which is usually the fastest to start.');
  }
  lines.push('');
  lines.push('If one of those is worth a quote, tell me the method and the matrix and I will come '
    + 'back with a named lab and their price.');

  return {
    ok: true,
    subject: subjectFor(onTopic ? segment : 'unknown', offer),
    // Whether the framing is this buyer's own specialty or the generic one. The agent screen shows
    // it, because an off-topic approach is worth knowing about before it goes out — it usually means
    // a lab needs onboarding for that segment rather than that this buyer should be emailed.
    on_topic: onTopic,
    body: lines.join('\n'),
    offered: [...offer.matched, ...offer.extra].map(c => c.test_code),
    segment,
    firm_name: name,
  };
}

function subjectFor(segment, offer) {
  // `segment` arrives as 'unknown' when none of the segment's own tests is placeable, so the
  // specialty lines below cannot fire on a list that does not contain that specialty.
  const first = offer.matched[0] || offer.extra[0];
  const phrase = first ? (TEST_PHRASE[first.test_code] || first.test_code) : 'analytical testing';
  if (segment === 'compounding_pharmacy') return 'A second lab for your USP 797 testing';
  if (segment === 'research_biotech') return 'Lab capacity for ' + phrase;
  return 'A second source for ' + phrase;
}

/** The phone version. Same facts, said in the order a call goes. */
function callContent(buyer, capability) {
  const segment = (buyer && buyer.segment) || 'unknown';
  const offer = offerFor(segment, capability);
  if (!offer.total) {
    return { ok: false, why: 'nothing can be placed for this buyer yet — see emailContent' };
  }
  const placeable = [...offer.matched, ...offer.extra];
  // THE SAME RULE AS THE EMAIL, and it was missing here. The email's subject and opening were fixed
  // to stop promising a specialty the list cannot deliver; the CALL SCRIPT was not, so a caller
  // phoning a compounding pharmacy opened with "USP 797 and 800 testing is not optional" directly
  // above a section listing the 797 tests under "what we cannot place". Found by reading the
  // rendered screen, not by a test — the email tests passed throughout.
  const onTopic = offer.matched.length > 0;
  return {
    ok: true,
    segment,
    on_topic: onTopic,
    opening: onTopic ? (OPENING[segment] || OPENING.unknown) : OPENING.unknown,
    // SAID OUT LOUD BEFORE THE PITCH, because a caller who does not know this gets caught by the
    // first objection and starts improvising about labs we do not have.
    what_we_can_place: placeable.map(c => {
      const phrase = TEST_PHRASE[c.test_code] || c.test_code;
      const n = c.labs + ' lab' + (c.labs === 1 ? '' : 's');
      return phrase + ' — ' + n + (c.fastest_days != null ? ', from ' + c.fastest_days + ' days' : '');
    }),
    // THE EXCLUSIONS ARE NOT OPTIONAL. A caller who cannot say "we have nobody for that yet" is the
    // one who promises it.
    what_we_cannot: likelyTests(segment)
      .filter(code => !placeable.some(p => p.test_code === code))
      .map(code => TEST_PHRASE[code] || code),
    why_second_source: onTopic ? (WHY_SECOND[segment] || WHY_SECOND.unknown) : WHY_SECOND.unknown,
    how_pricing_works: 'The lab sets the price. We add a commission on top of their quote, and you '
      + 'see which lab it is before anything ships.',
    objections: OBJECTIONS,
  };
}

module.exports = { emailContent, callContent, offerFor, OPENING, WHY_SECOND, OBJECTIONS, TEST_PHRASE };
