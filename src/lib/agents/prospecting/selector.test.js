// WHAT DEFINES THE SEGMENT, AND WHAT MERELY ORDERS IT.
//   node --test src/lib/agents/prospecting/selector.test.js
//
// DECIDED 2026-09-30. The primary selector is what the SITE says: no website, or a site that scores badly.
// Both are measured directly from the site, so they mean the same thing in Rockford and in Phoenix. The
// agency signal is a TIEBREAK — it downweights a row, it does not define the segment.
//
// The distinction lives in one place and can be checked mechanically: agency belongs in the ORDER BY and
// must never appear in the WHERE.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const ROUTES = fs.readFileSync(__dirname + '/../../../api/routes.js', 'utf8');
const handler = (() => {
  const i = ROUTES.indexOf("router.get('/sitenex/prospects'");
  assert.notEqual(i, -1, 'could not find the SiteNex prospects route');
  const rest = ROUTES.slice(i);
  const end = rest.search(/\nrouter\.(get|post|put|patch|delete)\(/);
  return rest.slice(0, end === -1 ? undefined : end);
})();

test('the agency signal is in the ORDER BY', () => {
  const order = handler.slice(handler.indexOf('ORDER BY'));
  assert.match(order, /agency_signals/, 'an agency-flagged row must sort below an equivalent unflagged one');
});

test('the agency signal is NOT in the WHERE — it does not define the segment', () => {
  // Everything before ORDER BY is selection. A filter on agency would turn a tiebreak back into a selector.
  const selection = handler.slice(0, handler.indexOf('ORDER BY'));
  const clauses = [...selection.matchAll(/clauses\.push\(`([^`]+)`\)/g)].map(m => m[1]);
  assert.ok(clauses.length >= 4, `expected the bucket filters, found ${clauses.length}`);
  for (const c of clauses) {
    assert.ok(!/agency/i.test(c), `a WHERE clause selects on agency: ${c}`);
  }
});

test('the buckets are all measured FROM THE SITE, so they travel between states', () => {
  const selection = handler.slice(0, handler.indexOf('ORDER BY'));
  for (const bucket of ['no_website', 'unscannable', 'dead_site', 'scored']) {
    assert.ok(selection.includes(`'${bucket}'`), `the ${bucket} bucket must exist`);
  }
  // website IS NULL and site_score are site measurements; neither depends on a reseller detector.
  assert.match(selection, /website IS NULL/);
  assert.match(selection, /site_score IS NOT NULL/);
});

test('agency is the WEAKEST ordering term — after site_score, before review count', () => {
  const order = handler.slice(handler.indexOf('ORDER BY'));
  const iScore = order.indexOf('site_score DESC');
  const iAgency = order.indexOf('agency_signals');
  const iReviews = order.indexOf('rating_count');
  assert.ok(iScore >= 0 && iAgency > iScore,
    'site_score must win: a badly scoring agency-tracked site still outranks a decent unmanaged one');
  assert.ok(iReviews > iAgency, 'and agency must outrank review count, which is the weakest signal of all');
});

test('the agency signal is never part of the SCORE', () => {
  // The score answers "how bad is the site". Agency answers "is the seat taken". Mixing them would make the
  // primary selector depend on the proxy.
  const score = fs.readFileSync(__dirname + '/site-score.js', 'utf8');
  assert.match(score, /never a penalty/i, 'site-score.js must say so');
  const finish = score.slice(score.indexOf('function finish('));
  assert.ok(!/agencySignals\.length/.test(finish.slice(0, 400)),
    'finish() must not let agency evidence move the score');
});

test('the decision not to broaden the duda detector is written down', () => {
  // 77 of 114 signals are duda, so "agency-tracked" is largely one reseller platform. Adding more platforms
  // would be investing in the proxy instead of the measurement.
  assert.match(handler, /NOT to be strengthened by broadening the duda detector/,
    'the route must record why the detector is deliberately not being widened');
});
