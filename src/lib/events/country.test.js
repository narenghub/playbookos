'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isoOf, marketOfCountry, isUS, isEurope, europeFirstSql, europeFirstParams, EUROPE } = require('./country');

// ── THE BUG THIS FILE EXISTS FOR ────

test('"United States" is the US — the comparison that failed was country <> \'USA\'', () => {
  // research_institutions.country holds full names. The seed tested against 'USA', so every US row
  // passed as non-US, the EU-first ordering did nothing, and 80 American hospitals were stamped
  // market='eu' three days before a show in Barcelona.
  for (const v of ['United States', 'United States of America', 'USA', 'US', 'U.S.A.', 'america']) {
    assert.strictEqual(marketOfCountry(v), 'us', `${v} must be the US`);
    assert.ok(isUS(v));
    assert.ok(!isEurope(v), `${v} must NOT be Europe`);
  }
});

test('the real top-8 institutions classify correctly now', () => {
  // Taken verbatim from the live dry run that reported all of these as non-US.
  assert.strictEqual(marketOfCountry('United States'), 'us',
    'Memorial Sloan Kettering, Northwestern, Dana-Farber — all reported non-US before this fix');

  // "South Korea" comes back NULL, not 'row', and that is the deliberate choice. The name map
  // covers only the US and Europe, so an unmapped full name means "this module cannot place it" —
  // which is NOT the same as "it is elsewhere". If I have missed a European spelling, calling it
  // 'row' would HIDE a European institution from a Barcelona list, and that error is invisible.
  // Null is loud: the page shows it as unplaced and somebody looks.
  assert.strictEqual(marketOfCountry('South Korea'), null,
    'Seoul National University Hospital — unmapped name must be null, not a guess at row');
});

// ── BOTH CONVENTIONS ────

test('ISO-3 codes work, which is what labs.country holds', () => {
  assert.strictEqual(marketOfCountry('ESP'), 'eu');
  assert.strictEqual(marketOfCountry('DEU'), 'eu');
  assert.strictEqual(marketOfCountry('USA'), 'us');
  assert.strictEqual(marketOfCountry('JPN'), 'row');
});

test('full names work, which is what research_institutions.country holds', () => {
  assert.strictEqual(marketOfCountry('Spain'), 'eu');
  assert.strictEqual(marketOfCountry('Germany'), 'eu');
  assert.strictEqual(marketOfCountry('The Netherlands'), 'eu');
  assert.strictEqual(marketOfCountry('Czech Republic'), 'eu');
  // An unmapped full name is null, not 'row'. See the South Korea case above for why: a missed
  // European spelling called 'row' silently hides a European row from a European show.
  assert.strictEqual(marketOfCountry('Japan'), null);
  // An ISO code IS unambiguous, so the code path may safely answer 'row'.
  assert.strictEqual(marketOfCountry('JPN'), 'row');
});

test('every country in the EUROPE list classifies as eu by its code', () => {
  for (const iso of EUROPE) {
    assert.strictEqual(marketOfCountry(iso), 'eu', `${iso} is in EUROPE but did not classify as eu`);
  }
});

test('every European full name maps to a code that is actually in EUROPE', () => {
  // A name mapped to a code outside the list would classify as 'row' while looking handled.
  const { NAME_TO_ISO } = require('./country');
  const euSet = new Set(EUROPE);
  for (const [name, iso] of Object.entries(NAME_TO_ISO)) {
    if (iso === 'USA') continue;
    assert.ok(euSet.has(iso),
      `"${name}" maps to ${iso}, which is not in the EUROPE list — it would silently be 'row'`);
  }
});

test('the UK and its constituent countries are Europe, however written', () => {
  for (const v of ['United Kingdom', 'UK', 'Great Britain', 'England', 'Scotland', 'Wales']) {
    assert.strictEqual(marketOfCountry(v), 'eu', `${v} should be eu`);
  }
});

// ── "I CANNOT TELL" IS NOT "ELSEWHERE" ────

test('an unknown or missing country is null, never row', () => {
  // A page that renders an unplaceable row as 'row' is making a claim the data does not support.
  for (const v of [null, undefined, '', '   ', 'Mexico City', 'not a country at all']) {
    assert.strictEqual(marketOfCountry(v), null, `${JSON.stringify(v)} must be null`);
    assert.ok(!isUS(v) && !isEurope(v));
  }
});

test('a multi-word value is not misread as an ISO code', () => {
  assert.strictEqual(isoOf('Mexico City'), null, '"Mexico City" must not be read as a 3-letter code');
  assert.strictEqual(isoOf('New York'), null);
});

test('a genuine 3-letter code is accepted even if unmapped by name', () => {
  assert.strictEqual(isoOf('BRA'), 'BRA');
  assert.strictEqual(marketOfCountry('BRA'), 'row');
});

// ── SQL COMPOSITION ────

test('europeFirstSql takes two array parameters and sorts unknowns last', () => {
  const sql = europeFirstSql('country', 3);
  assert.match(sql, /\$3/);
  assert.match(sql, /\$4/, 'names and codes are two separate parameters');
  assert.match(sql, /IS NULL\) ASC/, 'a row we cannot place must sort LAST, not first');
});

test('europeFirstParams gives lowercase names and uppercase codes, matching the SQL', () => {
  const [names, codes] = europeFirstParams();
  assert.ok(names.includes('spain'), 'names must be folded lowercase to match LOWER(col)');
  assert.ok(!names.includes('Spain'));
  assert.ok(codes.includes('ESP'), 'codes must be uppercase to match UPPER(col)');
  // And no US spelling may leak into the Europe-first list.
  for (const n of names) assert.ok(!/united states|usa|^us$|america/.test(n), `"${n}" is not Europe`);
  assert.ok(!codes.includes('USA'));
});
