// SiteNex — WHAT TO SAY on a call, and what to paste into an email. Pure: no DB, no I/O, no LLM.
//
// Generated ON OPEN for one prospect, never pre-computed for all 1,524 rows and never with a
// per-prospect model call. Everything here is a deterministic function of site_findings and the
// package row, which is also why it can be tested exhaustively.
//
// WORDING IS NOT DUPLICATED. Every sentence describing a site comes from
// src/lib/agents/prospecting/findings-text.js, which is the single place that translates a signal key
// into something speakable. A second copy would drift, and then the call sheet, the prospects screen
// and this would describe the same site three ways. What THIS module adds is structure — opening,
// cost, scope, exclusions, objections — not new descriptions of findings.
//
// ── THE FOUR THINGS THAT ARE EASY TO GET WRONG ────────────────────────────────
//
// 1. SIGNALS ARE SORTED BY PENALTY DESC, and the opening is built from the SAME top signal that then
//    leads the list. findingSentences() returns them in stored order, which is scan order, so using
//    it directly would open on "the footer says 2009" while the list led with "doesn't work on a
//    phone" — the call would contradict itself in two consecutive breaths.
//
// 2. A no_website ROW MUST NOT SAY "only a social page". `no_website` means the Places record carries
//    no website at all: we observed an ABSENCE. The social-page claim is only true when the
//    `social_as_website` signal is actually present, which requires a website that resolved to a
//    social host. Keyed off the signal, never off the bucket, so a data change cannot make it a lie.
//
// 3. NO "ONE OTHER THING" FOR no_website / unscannable. Those two buckets have exactly one finding by
//    construction, so a second paragraph would restate the sentence just said.
//
// 4. AN unscannable ROW MUST NOT SAY ANYTHING IS FIXABLE. Their server returned 403 and we saw
//    nothing. "This is fixable" asserts a defect we did not observe; the honest opening is that we
//    could not look, and the honest next step is to ask them to describe it.
//
// And one that applies throughout: NO OUTCOME CLAIMS. No ranking, no traffic, no leads, no revenue,
// no "more customers". We can describe what their site does today and what we would build; we cannot
// promise what it earns. outreach-content.test.js fails the build on that vocabulary.

const { findingSentence, findingSentences, bucketOf, packageLabel } =
  require('../agents/prospecting/findings-text');
const { PENALTY } = require('../agents/prospecting/site-score');

// ── openings, per signal ──────────────────────────────────────────────────────
//
// One per scored signal key, because the opening has to name the SAME thing the list leads with. A
// guard in the test file fails if PENALTY gains a key that has no entry here, so a new signal cannot
// ship with a silent fallback opening.
//
// Written as something a person can say in the first fifteen seconds, in the second person, and
// strictly observational. "I had a look at your site and X" is a fact. "Your site is costing you
// customers" is a guess dressed as one.
const OPENING = {
  social_as_website:
    "I was looking for your website and all I could find was your social page — is that right, there's no site?",
  site_unreachable:
    "I tried your website a couple of times this week and it didn't load at all — did you know it was down?",
  no_viewport:
    "I had a look at your website on my phone — it comes up at desktop size, so you have to pinch and zoom to read anything.",
  legacy_layout:
    "I had a look at your website — it's built the way sites were built about twenty years ago.",
  no_https:
    'I had a look at your website — it comes up with "Not secure" next to the address in the browser.',
  stale_copyright:
    "I had a look at your website — the footer still shows an old year, which makes it look like nobody's been near it.",
  missing_title_or_desc:
    "I had a look at how your website shows up in Google — there's no title or description on it, so the listing has nothing to show.",
  dated_builder:
    "I had a look at your website — it's on one of the DIY builders, and it's showing its age.",
  old_jquery:
    "I had a look at your website — it's still loading a very old version of one of its core libraries.",
};

// The two buckets where nothing was scored, so there is no signal to open on.
const BUCKET_OPENING = {
  // Absence, stated as an absence. No claim about a social page — see note 2.
  no_website:
    "I was trying to find a website for you and couldn't — is that right, you don't have one at the moment?",
  // Note 4: we saw NOTHING. No defect is asserted and nothing is called fixable.
  unscannable:
    "I tried to have a look at your website and your server blocked me, so I genuinely don't know what's on it — how are you finding it yourself?",
};

// ── objections: static, hand-written, per bucket ──────────────────────────────
//
// Deliberately not generated. These are the four or five things people actually say, and the answer
// to each is a position we have decided to hold — not something to improvise per prospect. Keyed by
// bucket because the honest answer genuinely differs: "we already have one" means something different
// to somebody whose site is down than to somebody who has none.
//
// Every answer stays inside what we can defend: scope, time, cost, and what we looked at. None of
// them promises a result.
const COMMON_OBJECTIONS = [
  { they_say: "We're too busy right now.",
    you_say: "That's fair. The build needs a couple of hours from you in total — mostly approving pages. "
           + "If now is wrong, tell me a month and I'll come back then." },
  { they_say: "Send me something in writing.",
    you_say: "Happy to. I'll send what's in it and what isn't, so you can see the edges of it before "
           + "you spend any time on a call." },
  { they_say: "How much?",
    you_say: "I'd rather scope it than guess — what I quote blind is always wrong. Give me the pages "
           + "you need and I'll come back with a number and a date." },
  { they_say: "My nephew / a friend built it.",
    you_say: "Understood, and I'm not here to tread on that. If they're still looking after it, say "
           + "so and I'll leave it. If they've moved on, that's usually when these go stale." },
];

const OBJECTIONS = {
  no_website: [
    { they_say: "We get everything by word of mouth.",
      you_say: "That's usually true of shops like yours, and I'm not suggesting you change it. The site "
             + "is for the person who's already been told your name and is checking you exist." },
    { they_say: "We're on Facebook, that's enough.",
      you_say: "It does a lot of the job. The gap is the person who won't make an account to look at a "
             + "page, and anything you want to control — hours, what you actually do, a contact form." },
    ...COMMON_OBJECTIONS,
  ],
  unscannable: [
    // Nothing here claims a problem. The whole bucket is "we could not look".
    { they_say: "There's nothing wrong with our site.",
      you_say: "You may well be right — I couldn't see it, your server turned me away. That's why I'm "
             + "asking rather than telling. What don't you like about it, if anything?" },
    { they_say: "Why are you trying to load our site?",
      you_say: "Only the homepage, the way any visitor would. Your server is set up to block anything "
             + "that isn't a browser, which is usually deliberate and fine." },
    ...COMMON_OBJECTIONS,
  ],
  dead_site: [
    { they_say: "It was working last week.",
      you_say: "It might be intermittent — I tried more than once. Worth checking with whoever holds "
             + "the hosting, because if it's expired the domain can go too." },
    { they_say: "We're already paying someone for it.",
      you_say: "Then the first thing to do is ask them, not me. If it's been down and nobody told you, "
             + "that's the conversation to have before you talk to anyone new." },
    ...COMMON_OBJECTIONS,
  ],
  scored: [
    { they_say: "We already have a website.",
      you_say: "You do, and I'm not saying scrap it for the sake of it. What I'm pointing at is the "
             + "specific thing I just described — if that doesn't bother you, it doesn't bother me." },
    { they_say: "We're already paying someone for it.",
      you_say: "Worth asking them about this, then. If they're on it, you've lost nothing by checking. "
             + "If what I described has been there a while, that tells you something." },
    { they_say: "Nobody looks at our website anyway.",
      you_say: "That may be true as it stands. I can only tell you what's on the page — whether it's "
             + "worth fixing is your call, not mine." },
    ...COMMON_OBJECTIONS,
  ],
};

// ── the package: scope, exclusions, cost ──────────────────────────────────────

// Signals sorted by penalty DESC. A missing/unknown penalty sorts last rather than throwing, and the
// original order breaks ties so the result is stable (Array#sort is stable in V8, but the explicit
// index keeps that from being load-bearing on an engine detail).
function rankedSignals(findings) {
  const sigs = (findings && findings.signals) || [];
  return sigs
    .map((s, i) => ({ s, i, p: typeof s.penalty === 'number' ? s.penalty : (PENALTY[s.key] || 0) }))
    .sort((a, b) => (b.p - a.p) || (a.i - b.i))
    .map(x => x.s);
}

function hasSignal(findings, key) {
  return ((findings && findings.signals) || []).some(s => s && s.key === key);
}

const money = (cents) => {
  const n = cents / 100;
  return '$' + (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2));
};

// WHAT IT COSTS. The packages table has setup_fee_cents and monthly_cents NULLABLE ON PURPOSE —
// nothing is priced yet — and the standing rule is to refuse a null price rather than print $0.
// So this returns the honest sentence instead of a number, and `priced` says which it did, so a
// caller can render the two differently without parsing prose.
function costLine(pkg) {
  const p = pkg || {};
  const setup = typeof p.setup_fee_cents === 'number' ? p.setup_fee_cents : null;
  const monthly = typeof p.monthly_cents === 'number' ? p.monthly_cents : null;
  if (setup == null && monthly == null) {
    return { priced: false,
      text: "I'm not going to quote you a number on this call — pricing for this package isn't set, and "
          + "a figure I invent now is one of us being wrong later. Let me take what you need and come "
          + "back with a price and a date." };
  }
  const bits = [];
  if (setup != null) bits.push(`${money(setup)} to build it`);
  if (monthly != null) bits.push(`${money(monthly)} a month after that`);
  return { priced: true, text: `It's ${bits.join(', then ')}.` };
}

// WHAT WE'D DO / WHAT THIS IS NOT. Both come from the package row, which is authoritative — the
// migration only seeds it. not_included is NOT NULL in the schema precisely because a package has to
// state its edges, and the channel agreement requires the caller to have them in hand: a partner who
// cannot say "content writing isn't in this" is the one who accidentally sells it.
function scopeOf(pkg) {
  const p = pkg || {};
  const asArray = (v) => Array.isArray(v) ? v.filter(Boolean).map(String) : [];
  return {
    code: p.code || null,
    label: packageLabel(p.code) || p.name || null,
    weeks: typeof p.typical_weeks === 'number' ? p.typical_weeks : null,
    summary: p.summary || null,
    included: asArray(p.included),
    not_included: asArray(p.not_included),
  };
}

// ── the call ──────────────────────────────────────────────────────────────────

function callContent(prospect, pkg) {
  const row = prospect || {};
  const findings = row.site_findings || {};
  const bucket = bucketOf(row);
  const ranked = rankedSignals(findings);

  // THE OPENING AND THE LIST MUST AGREE. For the two override buckets findings-text replaces the
  // signal list with one sentence, so there is nothing to rank; otherwise the opening is taken from
  // the top-ranked signal and the list is rendered in that same ranked order.
  let opening, whatTheyHave, lead = null;
  if (bucket === 'unscannable' || (bucket === 'no_website' && !hasSignal(findings, 'social_as_website'))) {
    opening = BUCKET_OPENING[bucket === 'unscannable' ? 'unscannable' : 'no_website'];
    whatTheyHave = findingSentences(findings);
  } else if (bucket === 'no_website') {
    // Reachable only if a no_website row somehow carries the social signal. Keyed off the SIGNAL, so
    // the social claim is made when it is true and not merely when the bucket looks similar.
    opening = OPENING.social_as_website;
    whatTheyHave = findingSentences(findings);
  } else {
    lead = ranked[0] || null;
    opening = (lead && OPENING[lead.key]) || BUCKET_OPENING.unscannable;
    whatTheyHave = ranked.map(findingSentence).filter(Boolean);
    if (!whatTheyHave.length) whatTheyHave = findingSentences(findings);
  }

  // "ONE OTHER THING" — the second-ranked finding, as a nudge after the main one has landed.
  // Suppressed for the single-finding buckets (note 3) and whenever there is no second finding.
  const singleFinding = bucket === 'no_website' || bucket === 'unscannable';
  const second = !singleFinding && ranked.length > 1 ? findingSentence(ranked[1]) : '';
  const oneOtherThing = second
    ? `While I've got you — one other thing I noticed: ${second[0].toLowerCase()}${second.slice(1)}`
    : null;

  const scope = scopeOf(pkg);
  const cost = costLine(pkg);

  return {
    bucket,
    prospect_name: row.name || null,
    package: scope,
    // what a person says, in order
    opening,
    what_they_have: whatTheyHave,
    what_it_costs: cost.text,
    priced: cost.priced,
    what_wed_do: scope.included,
    // The channel agreement's requirement: the caller HAS the exclusions, in the script, not in a PDF.
    what_this_is_not: scope.not_included,
    one_other_thing: oneOtherThing,
    objections: OBJECTIONS[bucket] || OBJECTIONS.scored,
    // Which signal the opening came from, so a UI can show the two are the same finding rather than
    // asking the reader to trust it.
    led_with: lead ? lead.key : null,
  };
}

// ── the email ─────────────────────────────────────────────────────────────────
//
// NO GREETING AND NO SIGN-OFF, by design. The partner pastes this between their own, from their own
// address. The platform sends nothing: there is no mailer here, no address, no send button, and that
// is deliberate — an email that leaves our infrastructure carries our deliverability and our name.

const SUBJECT = {
  social_as_website: (n) => `Couldn't find a website for ${n}`,
  site_unreachable:  (n) => `${n} — your website isn't loading`,
  no_viewport:       (n) => `${n} on a phone`,
  legacy_layout:     (n) => `Your website, ${n}`,
  no_https:          (n) => `${n} — "Not secure" on your website`,
  stale_copyright:   (n) => `Quick note on the ${n} website`,
  missing_title_or_desc: (n) => `How ${n} shows up in Google`,
  dated_builder:     (n) => `Your website, ${n}`,
  old_jquery:        (n) => `Quick note on the ${n} website`,
};
const BUCKET_SUBJECT = {
  no_website:  (n) => `Couldn't find a website for ${n}`,
  unscannable: (n) => `Couldn't load the ${n} website`,
};

function emailContent(prospect, pkg) {
  const row = prospect || {};
  const name = row.name || 'your business';
  const call = callContent(row, pkg);
  const scope = call.package;

  const subject = call.led_with
    ? (SUBJECT[call.led_with] || BUCKET_SUBJECT.unscannable)(name)
    : (BUCKET_SUBJECT[call.bucket] || BUCKET_SUBJECT.unscannable)(name);

  const paras = [];
  paras.push(call.opening);

  // A SINGLE finding is NOT restated. findings-text writes in the THIRD PERSON, because it was built for
  // a call sheet a rep reads ("They have no website at all"), and that is right there and wrong in an email
  // addressed to the business itself. The opening already says the same thing in the second person, so for
  // a one-finding row — every no_website, every unscannable, every social_as_website, and any scored row
  // with one signal — repeating it would be both redundant and oddly worded. Only the SUPPORTING findings
  // get listed, where third person reads as description of the site rather than talk about its owner.
  if (call.what_they_have.length > 1) {
    const rest = call.what_they_have.slice(1);
    paras.push(rest.length === 1
      ? `One other thing on it: ${rest[0][0].toLowerCase()}${rest[0].slice(1)}`
      : 'A couple of other things on it:\n' + rest.map(s => `  • ${s}`).join('\n'));
  }

  if (scope.included.length) {
    const weeks = scope.weeks ? ` It usually takes about ${scope.weeks} weeks.` : '';
    paras.push(`What we'd do: ${scope.included.join(', ')}.${weeks}`);
  }
  if (scope.not_included.length) {
    // In the email too, not just the call. The exclusions are the part that prevents an argument in
    // week three, so they travel with every version of the pitch.
    paras.push(`What it doesn't cover: ${scope.not_included.join(', ')}.`);
  }
  paras.push(call.what_it_costs);
  paras.push("If it's worth a look, tell me a time and I'll call you. If it isn't, say so and I won't chase you.");

  return { subject, body: paras.join('\n\n'), priced: call.priced, bucket: call.bucket, led_with: call.led_with };
}

module.exports = { callContent, emailContent, OPENING, BUCKET_OPENING, SUBJECT, BUCKET_SUBJECT,
                   OBJECTIONS, COMMON_OBJECTIONS, rankedSignals, costLine, scopeOf };
