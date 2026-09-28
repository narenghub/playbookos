// Site-quality scorer tests — run with:  node --test src/lib/agents/prospecting/site-score.test.js
// The contract that matters: the score is a SUM OF NAMED PENALTIES with evidence for each, it
// never contains rating_count, and P3 is never recommended automatically.

const { test } = require('node:test');
const assert = require('node:assert');
const { scoreSite, recommendPackage, PENALTY, P2_THRESHOLD } = require('./site-score');

const MODERN = `<html><head><title>Acme Machining</title>
  <meta name="viewport" content="width=device-width">
  <meta name="description" content="CNC machining in Rockford">
  <script src="/js/jquery-3.6.0.min.js"></script></head>
  <body><p>© ${new Date().getFullYear()} Acme</p></body></html>`;

test('a modern site scores 0 with no signals', () => {
  const r = scoreSite({ html: MODERN, finalUrl: 'https://acme.com/', website: 'https://acme.com', reachable: true });
  assert.equal(r.score, 0);
  assert.deepEqual(r.signals, []);
});

test('every penalty carries evidence — the score must be quotable', () => {
  const bad = `<html><head></head><body bgcolor="#fff">
    <font size="2">Welcome</font><center>Since 1994</center>
    <table width="600" border="1"><tr><td>x</td></tr></table>
    <script src="/jquery-1.7.2.min.js"></script>
    <p>© 2011 Old Machine Co</p></body></html>`;
  const r = scoreSite({ html: bad, finalUrl: 'http://old.com/', website: 'http://old.com', reachable: true });
  const keys = r.signals.map(s => s.key).sort();
  assert.deepEqual(keys, ['legacy_layout', 'missing_title_or_desc', 'no_https', 'no_viewport', 'old_jquery', 'stale_copyright']);
  assert.ok(r.signals.every(s => typeof s.evidence === 'string' && s.evidence.length > 3), 'every signal explains itself');
  assert.equal(r.score, PENALTY.no_viewport + PENALTY.legacy_layout + PENALTY.no_https + PENALTY.stale_copyright + PENALTY.missing_title_or_desc + PENALTY.old_jquery);
});

test('social-only presence scores 40 and does NOT fetch-score anything else', () => {
  const r = scoreSite({ website: 'https://www.facebook.com/share/abc', reachable: true, html: MODERN });
  assert.deepEqual(r.signals.map(s => s.key), ['social_as_website']);
  assert.equal(r.score, 40);
});

test('unreachable scores 35, but a 403 scores only 5 (bot protection, not a bad site)', () => {
  const dead = scoreSite({ website: 'https://deadshop.com', reachable: false, unreachableReason: 'dns' });
  assert.equal(dead.score, 35);
  assert.match(dead.signals[0].evidence, /unreachable \(dns\)/);
  const blocked = scoreSite({ website: 'https://deadshop.com', reachable: false, unreachableReason: '403' });
  assert.equal(blocked.score, 5);
  assert.match(blocked.signals[0].evidence, /treated as unknown/);
});

test('https is judged on the FINAL url, so http → https redirect is not penalised', () => {
  const redirected = scoreSite({ html: MODERN, website: 'http://acme.com', finalUrl: 'https://acme.com/', reachable: true });
  assert.ok(!redirected.signals.some(s => s.key === 'no_https'));
  const httpOnly = scoreSite({ html: MODERN, website: 'http://acme.com', finalUrl: 'http://acme.com/', reachable: true });
  assert.ok(httpOnly.signals.some(s => s.key === 'no_https'));
});

test('copyright: takes the LATEST year, so a range is not a false positive', () => {
  const now = new Date('2026-09-28');
  const range = scoreSite({ html: '<title>t</title><meta name="viewport"><meta name="description" content="d"><p>© 2005-2026 Co</p>', finalUrl: 'https://plainshop.com', reachable: true, now });
  assert.ok(!range.signals.some(s => s.key === 'stale_copyright'), '2005-2026 is current');
  const old = scoreSite({ html: '<title>t</title><meta name="viewport"><meta name="description" content="d"><p>© 2016 Co</p>', finalUrl: 'https://plainshop.com', reachable: true, now });
  assert.ok(old.signals.some(s => s.key === 'stale_copyright'));
});

test('a dated builder is penalised; a modern platform is recorded but not penalised', () => {
  const base = { html: MODERN, finalUrl: 'https://plainshop.com', website: 'https://plainshop.com', reachable: true };
  const weebly = scoreSite({ ...base, builderHits: [{ platform: 'weebly', confidence: 'high', evidence: 'script/iframe src ~ editmysite.com' }] });
  assert.equal(weebly.builder, 'weebly');
  assert.ok(weebly.signals.some(s => s.key === 'dated_builder'));
  const wix = scoreSite({ ...base, builderHits: [{ platform: 'wix', confidence: 'high', evidence: 'script/iframe src ~ parastorage.com' }] });
  assert.equal(wix.builder, 'wix', 'recorded for the outreach');
  assert.ok(!wix.signals.some(s => s.key === 'dated_builder'), 'Wix alone is not a datedness claim');
});

test('score is clamped at 100', () => {
  const awful = `<font>x</font><center>y</center><table width="1"><tr><td>z</td></tr></table><script src="jquery-1.4.js"></script><p>© 2004</p>`;
  const r = scoreSite({ html: awful, website: 'http://awful.com', finalUrl: 'http://awful.com', reachable: true,
    builderHits: [{ platform: 'frontpage', confidence: 'low', evidence: 'text mention ~ vti_cnf' }] });
  assert.ok(r.score <= 100);
});

test('rating_count can never reach the score — the function has no input for it', () => {
  const a = scoreSite({ html: MODERN, finalUrl: 'https://plainshop.com', reachable: true });
  const b = scoreSite({ html: MODERN, finalUrl: 'https://plainshop.com', reachable: true, rating_count: 5000, ratingCount: 5000 });
  assert.deepEqual(a, b, 'passing review counts changes nothing');
});

test('recommendPackage: no site → P1, score ≥ threshold → P2, below → null, never P3', () => {
  assert.equal(recommendPackage({ hasWebsite: false }), 'P1');
  assert.equal(recommendPackage({ hasWebsite: true, score: P2_THRESHOLD }), 'P2');
  assert.equal(recommendPackage({ hasWebsite: true, score: 100 }), 'P2');
  assert.equal(recommendPackage({ hasWebsite: true, score: P2_THRESHOLD - 1 }), null);
  assert.equal(recommendPackage({ hasWebsite: true, score: 0 }), null);
  for (const args of [{ hasWebsite: false }, { hasWebsite: true, score: 100 }, { hasWebsite: true, score: 0 }]) {
    assert.notEqual(recommendPackage(args), 'P3');
  }
});

test('x.com and twitter.com ARE social hosts (pinned — it is X, not a placeholder domain)', () => {
  for (const u of ['https://x.com/acmeshop', 'https://twitter.com/acmeshop', 'https://www.instagram.com/acme', 'https://linkedin.com/company/acme']) {
    const r = scoreSite({ website: u, reachable: true, html: MODERN });
    assert.deepEqual(r.signals.map(s => s.key), ['social_as_website'], `${u} should be social-only`);
  }
  // ...and a normal domain that merely CONTAINS those letters is not.
  for (const u of ['https://matrixx.com', 'https://xmachine.com', 'https://facebookmarketing.co']) {
    const r = scoreSite({ website: u, finalUrl: u, reachable: true, html: MODERN });
    assert.ok(!r.signals.some(s => s.key === 'social_as_website'), `${u} must NOT be social`);
  }
});
