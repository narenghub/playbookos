// SiteNex outreach content — what gets said to a real business.
//
//   node --test src/lib/sitenex/outreach-content.test.js
//
// Two kinds of test here, and the second kind is the point:
//
//   • THE GUARD. Every scanner signal must have an opening, a subject and reachable cost wording. A signal
//     added to the scorer with no entry here would otherwise fall back to a generic line and nobody would
//     notice, because the fallback reads fine — it is just about a different website than the one in front
//     of you.
//   • THE PROHIBITION. No output may contain a ranking, traffic, lead or revenue claim. We can describe
//     what their site does today and what we would build. We cannot say what it earns, and a sentence that
//     does is a sentence a partner will be held to.

const { test } = require('node:test');
const assert = require('node:assert');
const { callContent, emailContent, OPENING, SUBJECT, BUCKET_OPENING, BUCKET_SUBJECT,
        OBJECTIONS, rankedSignals, costLine } = require('./outreach-content');
const { PENALTY } = require('../agents/prospecting/site-score');
const { findingSentence } = require('../agents/prospecting/findings-text');

const PKG = {
  code: 'P2', name: 'Renew', summary: 'Rebuild of an existing site.', typical_weeks: 3,
  included: ['Everything in Launch (P1)', 'content migration', '301 redirect map from old URLs'],
  not_included: ['content writing', 'photography', 'logo design', 'booking system'],
  setup_fee_cents: null, monthly_cents: null,
};
const sig = (key, penalty, evidence) => ({ key, penalty, evidence });
const scoredRow = (signals, name = 'Acme Machine') =>
  ({ name, website: 'http://acme.example', site_findings: { reachable: true, signals } });

// Evidence strings taken from the scorer's own templates, so the wording functions take their real inputs.
const EVIDENCE = {
  social_as_website: 'only web presence is facebook.com',
  site_unreachable: 'homepage unreachable (timeout)',
  no_viewport: 'no <meta name="viewport"> — not mobile-friendly',
  legacy_layout: 'legacy markup: <font>, layout <table>',
  no_https: 'served over plain http:// (http://acme.example)',
  stale_copyright: 'footer copyright reads 2009 (more than 2 years old)',
  missing_title_or_desc: 'no <title> and no meta description',
  dated_builder: 'built on weebly (script/iframe src ~ editmysite.com)',
  old_jquery: 'jQuery 1.8.3 (1.x is end-of-life)',
};

// ── THE GUARD ─────────────────────────────────────────────────────────────────

test('GUARD: every scanner signal has an opening, and it is a real sentence', () => {
  for (const key of Object.keys(PENALTY)) {
    const o = OPENING[key];
    assert.ok(o, `signal '${key}' has no opening — it would fall back to generic wording and nobody would notice`);
    assert.ok(o.length > 30, `${key}: opening is too short to be an opening: ${o}`);
    assert.doesNotMatch(o, /_/, `${key}: opening leaks an underscored key: ${o}`);
    assert.match(o, /[.?!]$/, `${key}: opening should read as a sentence: ${o}`);
  }
  // And nothing extra, so a retired signal cannot leave a dead opening behind.
  assert.deepEqual(Object.keys(OPENING).sort(), Object.keys(PENALTY).sort());
});

test('GUARD: every scanner signal has a subject line', () => {
  for (const key of Object.keys(PENALTY)) {
    const s = SUBJECT[key];
    assert.equal(typeof s, 'function', `signal '${key}' has no subject line`);
    const out = s('Acme Machine');
    assert.match(out, /Acme Machine/, `${key}: the subject must name the business: ${out}`);
    assert.ok(out.length > 8 && out.length < 80, `${key}: subject length is wrong: ${out}`);
    assert.doesNotMatch(out, /_/, `${key}: subject leaks a key: ${out}`);
  }
  assert.deepEqual(Object.keys(SUBJECT).sort(), Object.keys(PENALTY).sort());
});

test('GUARD: every signal produces a cost line, priced or honestly unpriced', () => {
  // The cost section is required by the call structure, so it must exist for every row — and when the
  // package has no price (which is every package today) it must SAY so rather than print a number.
  for (const key of Object.keys(PENALTY)) {
    const c = callContent(scoredRow([sig(key, PENALTY[key], EVIDENCE[key])]), PKG);
    assert.ok(c.what_it_costs && c.what_it_costs.length > 20, `${key}: no cost line`);
    assert.equal(c.priced, false, `${key}: PKG is unpriced, so priced must be false`);
    assert.doesNotMatch(c.what_it_costs, /\$\s*0\b|\$NaN|\$null|\$undefined/,
      `${key}: printed a fake price: ${c.what_it_costs}`);
  }
  // Unpriced is the standing state of every package, so that branch is the one that matters most.
  assert.equal(costLine({ setup_fee_cents: null, monthly_cents: null }).priced, false);
  assert.equal(costLine({}).priced, false);
  assert.equal(costLine(null).priced, false);
  assert.equal(costLine({ setup_fee_cents: 450000, monthly_cents: 9900 }).text,
    "It's $4,500 to build it, then $99 a month after that.");
  // Half-priced is still priced — a setup fee with no retainer is a real shape.
  assert.equal(costLine({ setup_fee_cents: 450000, monthly_cents: null }).text, "It's $4,500 to build it.");
});

test('GUARD: both override buckets have an opening and a subject', () => {
  for (const b of ['no_website', 'unscannable']) {
    assert.ok(BUCKET_OPENING[b] && BUCKET_OPENING[b].length > 30, `${b} needs an opening`);
    assert.equal(typeof BUCKET_SUBJECT[b], 'function', `${b} needs a subject`);
  }
});

test('GUARD: every bucket has hand-written objections, each with both halves', () => {
  for (const b of ['no_website', 'unscannable', 'dead_site', 'scored']) {
    const list = OBJECTIONS[b];
    assert.ok(Array.isArray(list) && list.length >= 4, `${b}: needs objections, got ${list && list.length}`);
    for (const o of list) {
      // "How much?" is nine characters and is the most common objection there is, so the floor is low on
      // purpose. The answer is where the length requirement belongs.
      assert.ok(o.they_say && o.they_say.length > 5, `${b}: an objection has no 'they_say'`);
      assert.ok(o.you_say && o.you_say.length > 30, `${b}: "${o.they_say}" has no answer`);
    }
  }
});

// ── THE PROHIBITION ───────────────────────────────────────────────────────────

// Outcome vocabulary. Each entry is a claim about a RESULT, which is the thing we cannot observe and
// therefore cannot state. "ranking", "traffic", "leads", "revenue", "customers", "sales", "conversions",
// "SEO" as a promise, and the comparatives that smuggle the same claim in without a noun.
const FORBIDDEN = [
  /\brank(s|ing|ings)?\b/i, /\bsearch results? position/i, /\bpage one\b/i, /\btop of google\b/i,
  // Scoped to the PROMISE, not the word. "the way any visitor would" describes how our scanner behaves
  // and is not a claim about anybody's visitors; a bare /visitors? would/ flagged it, which is how a
  // prohibition list starts generating noise and gets switched off.
  /\btraffic\b/i, /\bmore visitors?\b/i, /\bvisitors? will\b/i, /\bclicks?\b/i, /\bimpressions?\b/i,
  /\bleads?\b/i, /\benquir(y|ies)\b/i, /\bconversions?\b/i, /\bconversion rate\b/i,
  /\brevenue\b/i, /\bsales\b/i, /\bturnover\b/i, /\bROI\b/i, /\bpays? for itself\b/i,
  /\bmore customers?\b/i, /\bnew customers?\b/i, /\bwin (?:more|new) (?:work|business)\b/i,
  /\bgrow(th)? your business\b/i, /\bdouble\b/i, /\bincrease\b/i, /\bboost\b/i, /\bdrive\b/i,
  /\bguarantee(d|s)?\b/i, /\bbest\b/i, /\b\d+\s*%\s*(more|increase|uplift|better)/i,
];

// Every string a prospect can see, from every bucket and every signal, in both channels.
function everyProspectFacingString() {
  const out = [];
  const push = (where, s) => { if (s) out.push([where, String(s)]); };
  const rows = [
    ['no_website', { name: 'Bolt Co', website: null, site_findings: { no_website: true, signals: [] } }],
    ['unscannable', { name: 'Gate Ltd', website: 'http://g.example', site_findings: { unscannable: true, signals: [] } }],
    ['dead_site', { name: 'Dead Co', website: 'http://d.example', site_findings: { reachable: false, signals: [sig('site_unreachable', 35, EVIDENCE.site_unreachable)] } }],
  ];
  for (const key of Object.keys(PENALTY)) rows.push([key, scoredRow([sig(key, PENALTY[key], EVIDENCE[key])])]);
  // And a multi-signal row, which is the common real shape and the only one that emits "one other thing".
  rows.push(['multi', scoredRow([sig('no_viewport', 25, EVIDENCE.no_viewport),
                                 sig('no_https', 15, EVIDENCE.no_https),
                                 sig('stale_copyright', 10, EVIDENCE.stale_copyright)])]);

  for (const [label, row] of rows) {
    for (const pkg of [PKG, { ...PKG, setup_fee_cents: 450000, monthly_cents: 9900 }]) {
      const c = callContent(row, pkg);
      push(`${label} opening`, c.opening);
      c.what_they_have.forEach((s, i) => push(`${label} what_they_have[${i}]`, s));
      push(`${label} cost`, c.what_it_costs);
      push(`${label} one_other_thing`, c.one_other_thing);
      c.objections.forEach(o => { push(`${label} objection.they_say`, o.they_say); push(`${label} objection.you_say`, o.you_say); });
      const e = emailContent(row, pkg);
      push(`${label} subject`, e.subject);
      push(`${label} body`, e.body);
    }
  }
  return out;
}

test('PROHIBITION: no output contains a ranking, traffic, lead or revenue claim', () => {
  const hits = [];
  for (const [where, s] of everyProspectFacingString()) {
    for (const re of FORBIDDEN) if (re.test(s)) hits.push(`${where}: /${re.source}/ matched — ${s.slice(0, 120)}`);
  }
  assert.deepEqual(hits, [],
    'these promise an OUTCOME we cannot observe. Describe the site and the scope, never the result:\n'
    + hits.join('\n'));
});

test('PROHIBITION: the detector would catch a real violation', () => {
  // A prohibition list that matches nothing is indistinguishable from an empty one.
  const bad = ['You will rank higher on Google.', 'This will double your enquiries.',
               'Expect 30% more traffic.', 'It pays for itself in new customers.',
               'We guarantee more leads.', 'More visitors will find you.', 'Visitors will stay longer.'];
  for (const s of bad) {
    assert.ok(FORBIDDEN.some(re => re.test(s)), `the detector missed: ${s}`);
  }
  // And it must not fire on the copy we actually ship, or it gets deleted.
  assert.ok(!FORBIDDEN.some(re => re.test(BUCKET_OPENING.no_website)), 'false positive on real copy');
  // The exact phrase the first version of this list wrongly flagged.
  assert.ok(!FORBIDDEN.some(re => re.test('Only the homepage, the way any visitor would.')),
    'describing our own scanner is not a claim about their visitors');
});

test('and no scoring language leaks either — the score is a sorting device', () => {
  for (const [where, s] of everyProspectFacingString()) {
    assert.doesNotMatch(s, /\bsite_score\b|\bpenalt(y|ies)\b|\bscores? of\b|\b\d+\s*\/\s*100\b/i,
      `${where} leaks scoring internals: ${s.slice(0, 120)}`);
  }
});

// ── THE FOUR NON-OBVIOUS REQUIREMENTS ─────────────────────────────────────────

test('1. signals are ranked by penalty DESC, and the opening leads with that same finding', () => {
  // Stored order here is deliberately the REVERSE of penalty order: findingSentences() would return it
  // as-is, so the call would open on "the footer says 2009" and the list would lead with the phone problem.
  const row = scoredRow([sig('old_jquery', 5, EVIDENCE.old_jquery),
                         sig('stale_copyright', 10, EVIDENCE.stale_copyright),
                         sig('no_viewport', 25, EVIDENCE.no_viewport)]);
  assert.deepEqual(rankedSignals(row.site_findings).map(s => s.key),
                   ['no_viewport', 'stale_copyright', 'old_jquery']);
  const c = callContent(row, PKG);
  assert.equal(c.led_with, 'no_viewport', 'the opening must come from the heaviest finding');
  assert.equal(c.opening, OPENING.no_viewport);
  // THE CONTRADICTION THIS PREVENTS: the first thing said and the first thing listed are the same finding.
  assert.equal(c.what_they_have[0], findingSentence(row.site_findings.signals[2]));
  assert.match(c.what_they_have[0], /resize on a phone/);
});

test('   ranking falls back to the PENALTY table when a stored row has no penalty', () => {
  // Older rows, or a hand-inserted one, may carry only {key, evidence}.
  const row = scoredRow([{ key: 'old_jquery', evidence: EVIDENCE.old_jquery },
                         { key: 'no_viewport', evidence: EVIDENCE.no_viewport }]);
  assert.deepEqual(rankedSignals(row.site_findings).map(s => s.key), ['no_viewport', 'old_jquery']);
});

test('   and ties keep their stored order, so the output is stable', () => {
  const row = scoredRow([sig('stale_copyright', 10, EVIDENCE.stale_copyright),
                         sig('missing_title_or_desc', 10, EVIDENCE.missing_title_or_desc),
                         sig('dated_builder', 10, EVIDENCE.dated_builder)]);
  assert.deepEqual(rankedSignals(row.site_findings).map(s => s.key),
                   ['stale_copyright', 'missing_title_or_desc', 'dated_builder']);
});

test('2. a no_website row does NOT claim a social page — we observed an absence', () => {
  // THE BUG THIS PREVENTS: no_website means the Places record carries no website. Saying "only a social
  // page" asserts a Facebook page we never saw.
  const c = callContent({ name: 'Bolt Co', website: null, site_findings: { no_website: true, signals: [] } }, PKG);
  assert.equal(c.bucket, 'no_website');
  assert.doesNotMatch(c.opening, /social|facebook|instagram/i, `claimed a social page: ${c.opening}`);
  const e = emailContent({ name: 'Bolt Co', website: null, site_findings: { no_website: true, signals: [] } }, PKG);
  assert.doesNotMatch(e.body, /social|facebook|instagram/i, `the email claimed a social page: ${e.body}`);
  assert.doesNotMatch(e.subject, /social/i);
});

test('   but a row that really HAS the social_as_website signal does say it', () => {
  // Keyed off the signal, not the bucket — the claim is made exactly when it is true.
  const row = { name: 'Rivet Inc', website: 'https://facebook.com/rivet',
                site_findings: { reachable: true, signals: [sig('social_as_website', 40, EVIDENCE.social_as_website)] } };
  const c = callContent(row, PKG);
  assert.match(c.opening, /social page/, 'the social claim is true here and should be made');
  assert.equal(c.led_with, 'social_as_website');
});

test('3. "one other thing" is suppressed for no_website and unscannable', () => {
  // Both buckets have exactly one finding by construction, so a second paragraph restates it.
  for (const findings of [{ no_website: true, signals: [] }, { unscannable: true, signals: [] }]) {
    const c = callContent({ name: 'X', website: findings.no_website ? null : 'http://x.example', site_findings: findings }, PKG);
    assert.equal(c.one_other_thing, null, `${c.bucket} must not get a second paragraph`);
  }
  // A single scored signal gets none either — there is no second finding to raise.
  assert.equal(callContent(scoredRow([sig('no_https', 15, EVIDENCE.no_https)]), PKG).one_other_thing, null);
  // Two or more does.
  const two = callContent(scoredRow([sig('no_viewport', 25, EVIDENCE.no_viewport),
                                     sig('no_https', 15, EVIDENCE.no_https)]), PKG);
  assert.ok(two.one_other_thing, 'with a second finding it should appear');
  assert.match(two.one_other_thing, /served over plain http/, 'and it is the SECOND-ranked one');
});

test('4. an unscannable row never says anything is fixable, or names a defect', () => {
  // Their server returned 403 and we saw NOTHING. Asserting a problem would be inventing an observation.
  const row = { name: 'Gate Ltd', website: 'http://g.example',
                site_findings: { unscannable: true, unscannable_reason: '403 — bot protection blocked the fetch; site NOT assessed', signals: [] } };
  const c = callContent(row, PKG);
  const e = emailContent(row, PKG);
  const said = [c.opening, ...c.what_they_have, c.what_it_costs, ...c.objections.map(o => o.you_say), e.subject, e.body].join('\n');
  for (const re of [/fixable/i, /\bbroken\b/i, /out of date/i, /\boutdated\b/i, /needs? (?:fixing|work|rebuilding)/i,
                    /\bproblem(s)? with your (?:site|website)\b/i, /\bwrong with\b/i]) {
    assert.doesNotMatch(said, re, `unscannable must not assert a defect — matched /${re.source}/`);
  }
  // What it SHOULD do is say we could not look, and ask.
  assert.match(c.opening, /blocked|could ?n[o']t|don't know/i);
  assert.match(c.opening, /\?$/, 'it ends in a question, because the next move is to ask');
});

// ── the email's shape ─────────────────────────────────────────────────────────

test('the email has NO greeting and NO sign-off — the partner pastes it between their own', () => {
  for (const row of [scoredRow([sig('no_viewport', 25, EVIDENCE.no_viewport)]),
                     { name: 'Bolt Co', website: null, site_findings: { no_website: true, signals: [] } }]) {
    const { body } = emailContent(row, PKG);
    assert.doesNotMatch(body, /^(hi|hello|dear|hey|good (morning|afternoon))\b/i, `has a greeting: ${body.slice(0, 60)}`);
    for (const re of [/\bkind regards\b/i, /\bbest regards\b/i, /\bregards,/i, /\bthanks,\s*$/i,
                      /\bsincerely\b/i, /\bcheers,/i, /\bbest,\s*$/i]) {
      assert.doesNotMatch(body, re, `has a sign-off: /${re.source}/`);
    }
    // And no sender identity of any kind — it goes out from the partner's own address.
    assert.doesNotMatch(body, /SiteNex|PlaybookOS|Abiozen|@/i, `leaks our identity or an address: ${body}`);
  }
});

test("the email states what it does NOT cover, not just what it does", () => {
  // The exclusions are what stop a client expecting content writing in week three, so they travel with
  // every version of the pitch — the call AND the email, not a PDF nobody opens.
  const e = emailContent(scoredRow([sig('no_viewport', 25, EVIDENCE.no_viewport)]), PKG);
  assert.match(e.body, /doesn't cover/i);
  for (const x of PKG.not_included) assert.ok(e.body.includes(x), `exclusion missing from the email: ${x}`);
});

test('the call hands the caller the exclusions, because the channel agreement requires it', () => {
  const c = callContent(scoredRow([sig('no_viewport', 25, EVIDENCE.no_viewport)]), PKG);
  assert.deepEqual(c.what_this_is_not, PKG.not_included);
  assert.deepEqual(c.what_wed_do, PKG.included);
  // A package row with no exclusions yields an empty list rather than throwing — but it is still a list,
  // so a UI renders "none stated" instead of silently omitting the section.
  assert.deepEqual(callContent(scoredRow([]), { code: 'P1' }).what_this_is_not, []);
});

test('nothing throws on a malformed or empty row — content is generated on open', () => {
  // Generated when somebody opens a prospect, so a half-populated row must degrade rather than 500.
  for (const row of [undefined, null, {}, { name: 'X' }, { name: 'X', site_findings: null },
                     { name: 'X', website: 'http://x.example', site_findings: { signals: null } },
                     { name: 'X', website: 'http://x.example', site_findings: { signals: [{}] } },
                     { name: 'X', website: 'http://x.example', site_findings: { signals: [{ key: 'brand_new_signal' }] } }]) {
    const c = callContent(row, PKG);
    assert.ok(c.opening && c.opening.length > 20, `no opening for ${JSON.stringify(row)}`);
    assert.ok(Array.isArray(c.objections) && c.objections.length, 'objections must always be present');
    const e = emailContent(row, PKG);
    assert.ok(e.subject && e.body, `no email for ${JSON.stringify(row)}`);
    assert.doesNotMatch(e.subject, /undefined|null|NaN/, `subject leaks a placeholder: ${e.subject}`);
    assert.doesNotMatch(e.body, /undefined|null|NaN/, `body leaks a placeholder: ${e.body}`);
  }
});

test('it is PURE — no DB, no network, no clock in the output', () => {
  // Called on open, per prospect, so it must not reach for anything. Two identical calls must agree
  // exactly; a timestamp or a random pick would make the content un-reviewable.
  const row = scoredRow([sig('no_viewport', 25, EVIDENCE.no_viewport), sig('no_https', 15, EVIDENCE.no_https)]);
  assert.deepEqual(callContent(row, PKG), callContent(row, PKG));
  assert.deepEqual(emailContent(row, PKG), emailContent(row, PKG));
  const src = require('fs').readFileSync(__dirname + '/outreach-content.js', 'utf8');
  for (const re of [/require\(['"]\.\.\/db['"]\)/, /\bquery\(/, /\bfetch\(/, /Date\.now\(\)/, /new Date\(/,
                    /Math\.random/, /require\(['"].*llm/]) {
    assert.doesNotMatch(src, re, `outreach-content must stay pure — found /${re.source}/`);
  }
});
