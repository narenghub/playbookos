// ── TWO TABLES, TWO COUNTRY CONVENTIONS, ONE FALSE CLAIM. ────────────────────
//
// On 2026-10-10 the SCOPE delegate seed reported "institutions: 80 non-US, 80 with a contact on
// file" and the list it printed underneath was Memorial Sloan Kettering (New York), Northwestern
// (Chicago), Washington University (St Louis), Dana-Farber (Boston). All American.
//
// The test was `country <> 'USA'`. But `research_institutions.country` holds FULL NAMES — "United
// States", "South Korea" — while `labs.country` holds ISO-3 codes, and src/lib/labconnect/region.js
// defines EUROPE as ISO-3. So every institution passed the non-US test, the EU-first ordering did
// nothing, and `market = 'eu'` was stamped on 80 US rows. Three days before a show in Barcelona
// that list was the wrong 80 companies, presented as the right ones.
//
// A string comparison against one spelling of one country is not a country check. This is: it takes
// whatever either table holds and answers the only question the event pages ask — us, eu, or
// elsewhere — and it is deliberately the ONE place that knows both conventions, so the next table
// with a third convention gets fixed here rather than in whichever script notices.
'use strict';

const { EUROPE } = require('../labconnect/region');

// Fold to a comparable key: lowercase, no punctuation, single spaces. "U.S.A." and "USA" and
// "united states of america" all have to land somewhere predictable.
function fold(v) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .replace(/[.,'’()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Full-name spellings seen in the registry data, mapped to the ISO-3 code the rest of the platform
// uses. Only the countries that matter to us/eu classification — everything else is 'row' and does
// not need a mapping to be correctly classified.
const NAME_TO_ISO = {
  // ── United States ────
  'united states': 'USA', 'united states of america': 'USA', 'usa': 'USA', 'us': 'USA',
  'u s': 'USA', 'u s a': 'USA', 'america': 'USA',
  // ── Europe, matching the EUROPE ISO-3 list in labconnect/region.js ────
  'united kingdom': 'GBR', 'great britain': 'GBR', 'england': 'GBR', 'scotland': 'GBR',
  'wales': 'GBR', 'northern ireland': 'GBR', 'uk': 'GBR',
  'switzerland': 'CHE', 'norway': 'NOR', 'iceland': 'ISL', 'liechtenstein': 'LIE',
  'austria': 'AUT', 'belgium': 'BEL', 'bulgaria': 'BGR', 'croatia': 'HRV', 'cyprus': 'CYP',
  'czechia': 'CZE', 'czech republic': 'CZE', 'denmark': 'DNK', 'estonia': 'EST',
  'finland': 'FIN', 'france': 'FRA', 'germany': 'DEU', 'greece': 'GRC', 'hungary': 'HUN',
  'ireland': 'IRL', 'republic of ireland': 'IRL', 'italy': 'ITA', 'latvia': 'LVA',
  'lithuania': 'LTU', 'luxembourg': 'LUX', 'malta': 'MLT', 'netherlands': 'NLD',
  'the netherlands': 'NLD', 'holland': 'NLD', 'poland': 'POL', 'portugal': 'PRT',
  'romania': 'ROU', 'slovakia': 'SVK', 'slovak republic': 'SVK', 'slovenia': 'SVN',
  'spain': 'ESP', 'sweden': 'SWE',
};

const EUROPE_SET = new Set(EUROPE);

/**
 * The ISO-3 code for whatever either table holds, or null when it cannot be told.
 * Accepts an ISO-3 code unchanged, a known full name, or nothing.
 */
function isoOf(value) {
  const f = fold(value);
  if (!f) return null;
  if (NAME_TO_ISO[f]) return NAME_TO_ISO[f];
  // Already an ISO-3 code? Only accept it as one if it is three letters, so a stray "Mexico City"
  // cannot be read as a code.
  const up = f.toUpperCase().replace(/\s/g, '');
  if (/^[A-Z]{3}$/.test(up)) return up;
  return null;
}

/**
 * us | eu | row | null  —  null meaning "we could not tell", which is NOT the same as "elsewhere"
 * and must not be rendered as a market. A page showing a row as 'row' when the truth is unknown is
 * making a claim the data does not support.
 */
function marketOfCountry(value) {
  const iso = isoOf(value);
  if (!iso) return null;
  if (iso === 'USA') return 'us';
  if (EUROPE_SET.has(iso)) return 'eu';
  return 'row';
}

const isUS = (v) => marketOfCountry(v) === 'us';
const isEurope = (v) => marketOfCountry(v) === 'eu';

/**
 * SQL ordering fragment for "the market this event is in, first". Barcelona means European rows
 * lead; an unknown country sorts last, because a row we cannot place is the weakest guess on the
 * page and should not sit above one we can.
 *
 * Takes the Europe names AND codes as a parameter rather than inlining a list into SQL, so the two
 * conventions stay in this file.
 */
function europeFirstSql(col, index) {
  return `(LOWER(${col}) = ANY($${index}) OR UPPER(${col}) = ANY($${index + 1})) DESC, (${col} IS NULL) ASC`;
}

/** The two parameters europeFirstSql expects, in order. */
function europeFirstParams() {
  const names = Object.entries(NAME_TO_ISO)
    .filter(([, iso]) => EUROPE_SET.has(iso))
    .map(([name]) => name);
  return [names, EUROPE.slice()];
}

module.exports = {
  fold, isoOf, marketOfCountry, isUS, isEurope,
  europeFirstSql, europeFirstParams,
  NAME_TO_ISO, EUROPE: EUROPE.slice(),
};
