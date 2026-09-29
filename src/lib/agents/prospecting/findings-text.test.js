// Findings wording tests — run with:  node --test src/lib/agents/prospecting/findings-text.test.js
// The contract: a human-facing string never contains a signal key, a penalty, or the score. This
// module is the ONLY place that wording lives, so these tests guard the call sheet and the
// sitenex-prospects screen at once.

const { test } = require('node:test');
const assert = require('node:assert');
const { findingSentence, findingSentences, agencyNote, pageSpeedNote, bucketOf, BUCKET_LABEL, packageLabel } = require('./findings-text');
const { PENALTY } = require('./site-score');

test('every scorer signal key has a sentence — no key can reach a prospect unworded', () => {
  for (const key of Object.keys(PENALTY)) {
    const s = findingSentence({ key, evidence: 'x' });
    assert.ok(s && s.length > 10, `${key} has no sentence`);
    assert.doesNotMatch(s, /_/, `${key} sentence leaks an underscored key: ${s}`);
    assert.match(s, /[.!]$/, `${key} sentence should read as a sentence: ${s}`);
  }
});

test('no sentence ever mentions points or a score', () => {
  const all = Object.keys(PENALTY).map(key => findingSentence({ key, evidence: 'built on weebly / jQuery 1.8.3 / reads 2009' }));
  for (const s of all) {
    assert.doesNotMatch(s, /\bscore\b|\bpoints?\b|\+\d/i, `leaks scoring language: ${s}`);
  }
});

test('specifics are carried through from the evidence string', () => {
  assert.match(findingSentence({ key: 'stale_copyright', evidence: 'footer copyright reads 2009 (more than 2 years old)' }), /still says 2009\./);
  assert.match(findingSentence({ key: 'old_jquery', evidence: 'jQuery 1.8.3 (1.x is end-of-life)' }), /jQuery 1\.8\.3/);
  assert.match(findingSentence({ key: 'dated_builder', evidence: 'built on weebly (script/iframe src ~ editmysite.com)' }), /Weebly's DIY site builder/);
  assert.match(findingSentence({ key: 'dated_builder', evidence: 'built on frontpage (text mention ~ vti_cnf)' }), /discontinued in 2006/);
});

test('legacy layout names only the parts actually found, and is speakable', () => {
  const tables = findingSentence({ key: 'legacy_layout', evidence: 'legacy markup: layout <table>' });
  assert.match(tables, /layout is built out of tables/);
  assert.doesNotMatch(tables, /hard-coded/, 'does not claim font tags that were not found');
  const both = findingSentence({ key: 'legacy_layout', evidence: 'legacy markup: <font>, layout <table>' });
  assert.match(both, /tables, and the text styling is hard-coded/);
  const flash = findingSentence({ key: 'legacy_layout', evidence: 'legacy markup: Flash' });
  assert.match(flash, /no browser has run since 2020/);
});

test('missing title/description has three distinct wordings', () => {
  const both = findingSentence({ key: 'missing_title_or_desc', evidence: 'no <title> and no meta description' });
  const title = findingSentence({ key: 'missing_title_or_desc', evidence: 'no <title>' });
  const desc = findingSentence({ key: 'missing_title_or_desc', evidence: 'no meta description' });
  assert.equal(new Set([both, title, desc]).size, 3);
  assert.match(title, /URL instead of a name/);
});

test('unscannable and no-website findings replace the signal list entirely', () => {
  const blocked = findingSentences({ unscannable: true, unscannable_reason: '403 — bot protection', signals: [] });
  assert.equal(blocked.length, 1);
  assert.match(blocked[0], /could not load this site|blocked us/);
  assert.match(blocked[0], /nothing here has been assessed/, 'must not imply the site is fine');
  assert.deepEqual(findingSentences({ no_website: true }), ['They have no website at all.']);
});

test('an unknown future key degrades to its evidence, never to a raw key', () => {
  assert.equal(findingSentence({ key: 'some_new_signal', evidence: 'the contact form is broken' }), 'the contact form is broken');
  assert.equal(findingSentence({ key: 'some_new_signal' }), 'some new signal');
});

test('agencyNote is a caution, and absent when there is nothing to caution about', () => {
  assert.equal(agencyNote({ agency_signals: [] }), null);
  assert.equal(agencyNote({}), null);
  assert.match(agencyNote({ agency_signals: [{ key: 'reseller_builder' }] }), /may already be looking after it/);
  assert.match(agencyNote({ agency_signals: [{ key: 'campaign_tracking' }] }), /already be running campaigns/);
  assert.match(agencyNote({ agency_signals: [{ key: 'reseller_builder' }, { key: 'campaign_tracking' }] }), /; /);
});

test('pageSpeedNote appears only once a psi score exists', () => {
  assert.equal(pageSpeedNote({}), null);
  assert.equal(pageSpeedNote({ psi: { error: 'HTTP 429' } }), null);
  assert.equal(pageSpeedNote({ psi: { mobile_score: 31 } }), 'Google rates this site 31/100 on mobile.');
});

test('bucketOf splits the four honest states', () => {
  assert.equal(bucketOf({ website: null }), 'no_website');
  assert.equal(bucketOf({ website: 'https://a.com', site_findings: { unscannable: true } }), 'unscannable');
  assert.equal(bucketOf({ website: 'https://a.com', site_findings: { reachable: false } }), 'dead_site');
  assert.equal(bucketOf({ website: 'https://a.com', site_findings: { reachable: true, signals: [] } }), 'scored');
  for (const k of Object.keys(BUCKET_LABEL)) assert.ok(BUCKET_LABEL[k].length > 3);
  assert.match(BUCKET_LABEL.unscannable, /not assessed/i, 'the label must not read as clean');
});

test('packageLabel spells out what P1/P2 mean and returns null for none', () => {
  assert.match(packageLabel('P1'), /Launch/);
  assert.match(packageLabel('P2'), /Renew/);
  assert.equal(packageLabel(null), null);
  assert.equal(packageLabel('P9'), null);
});
