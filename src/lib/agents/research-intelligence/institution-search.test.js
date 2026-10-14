'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  classifyOrg, parseCollaborators, collaboratorRanking, distinctiveTokens,
  SEARCH_SQL, PROFILE_NAMES_SQL, PROFILE_TOTALS_SQL, PROFILE_SPONSORS_SQL,
  PROFILE_AREAS_SQL, PROFILE_PHASES_SQL, PROFILE_STUDIES_SQL, COUNTRIES_SQL, CENSUS_SQL,
  RELATED_SQL,
} = require('./institution-search');

const ALL_SQL = { SEARCH_SQL, PROFILE_NAMES_SQL, PROFILE_TOTALS_SQL, PROFILE_SPONSORS_SQL,
  PROFILE_AREAS_SQL, PROFILE_PHASES_SQL, PROFILE_STUDIES_SQL };

test('classifyOrg labels CROs, government, academic and industry', () => {
  assert.equal(classifyOrg('IQVIA Biotech'), 'cro');
  assert.equal(classifyOrg('Parexel International'), 'cro');
  assert.equal(classifyOrg('Syneos Health'), 'cro');
  assert.equal(classifyOrg('National Cancer Institute'), 'government');
  assert.equal(classifyOrg('Oxford University Hospitals NHS Foundation Trust'), 'academic');
  assert.equal(classifyOrg('Memorial Sloan Kettering Cancer Center'), 'academic');
  assert.equal(classifyOrg('Pfizer'), 'industry');
  assert.equal(classifyOrg('argenx'), 'industry');
  assert.equal(classifyOrg(''), 'unknown');
  assert.equal(classifyOrg(null), 'unknown');
});

// A government institute is also an "institute". If ACADEMIC_HINT were tested first, the NCI —
// the single most common non-industry sponsor in the data — would be labelled academic.
test('classifyOrg checks government before academic', () => {
  assert.equal(classifyOrg('National Institutes of Health Clinical Center'), 'government');
  assert.equal(classifyOrg('National Heart, Lung, and Blood Institute'), 'government');
});

test('parseCollaborators handles the shapes the column actually holds', () => {
  assert.deepEqual(parseCollaborators('Pfizer|Roche'), ['Pfizer', 'Roche']);
  assert.deepEqual(parseCollaborators('Pfizer; Roche'), ['Pfizer', 'Roche']);
  assert.deepEqual(parseCollaborators('["Pfizer","Roche"]'), ['Pfizer', 'Roche']);
  assert.deepEqual(parseCollaborators('[{"name":"Pfizer"},{"name":"Roche"}]'), ['Pfizer', 'Roche']);
  assert.deepEqual(parseCollaborators(['Pfizer', 'Roche']), ['Pfizer', 'Roche']);
  assert.deepEqual(parseCollaborators(''), []);
  assert.deepEqual(parseCollaborators(null), []);
});

// A comma is not a delimiter. "Hoffmann-La Roche, Inc." is one organisation, and splitting it
// invents a collaborator called "Inc."; "National Heart, Lung, and Blood Institute" is one
// government institute and splitting it invents three organisations that do not exist. A pipe
// still wins where both are present, because that IS a delimiter.
test('parseCollaborators never splits on a comma', () => {
  assert.deepEqual(parseCollaborators('Hoffmann-La Roche, Inc.'), ['Hoffmann-La Roche, Inc.']);
  assert.deepEqual(parseCollaborators('National Heart, Lung, and Blood Institute'),
    ['National Heart, Lung, and Blood Institute']);
  assert.deepEqual(parseCollaborators('Takeda, Ltd.|Pfizer'), ['Takeda, Ltd.', 'Pfizer']);
  assert.deepEqual(parseCollaborators('["Hoffmann-La Roche, Inc."]'), ['Hoffmann-La Roche, Inc.']);
});

test('collaboratorRanking counts each organisation once per trial', () => {
  const studies = [
    { collaborators: 'IQVIA|Pfizer' },
    { collaborators: 'IQVIA' },
    { collaborators: 'IQVIA|IQVIA' },   // the same name twice on one trial is still one trial
    { collaborators: null },
  ];
  const r = collaboratorRanking(studies);
  const iqvia = r.find((x) => /iqvia/i.test(x.name));
  assert.equal(iqvia.trials, 3);
  assert.equal(iqvia.kind, 'cro');
  assert.equal(r.find((x) => x.name === 'Pfizer').trials, 1);
  assert.equal(r.length, 2);
});

test('collaboratorRanking ranks by trial count and respects the limit', () => {
  const studies = [{ collaborators: 'A|B' }, { collaborators: 'B' }];
  assert.equal(collaboratorRanking(studies)[0].name, 'B');
  assert.equal(collaboratorRanking(studies, 1).length, 1);
  assert.deepEqual(collaboratorRanking([]), []);
  assert.deepEqual(collaboratorRanking(null), []);
});

// ── THE INVARIANTS THAT COST REAL MISTAKES ───────────────────────────────────

// Searching "Oxford" merged Oxford, England with Oxford, Mississippi — 20 of 35 trials belonged to
// Baptist Memorial in the wrong hemisphere. Country is part of the identity, not a display column,
// so every statement must carry it.
test('every query groups or filters by country', () => {
  for (const [name, sql] of Object.entries(ALL_SQL)) {
    assert.match(sql, /country/i, `${name} does not mention country`);
  }
  // The search groups on it; the profile scopes on it.
  assert.match(SEARCH_SQL, /GROUP BY key, country/, 'search must group on (key, country)');
  for (const name of ['PROFILE_NAMES_SQL', 'PROFILE_TOTALS_SQL', 'PROFILE_SPONSORS_SQL',
    'PROFILE_AREAS_SQL', 'PROFILE_PHASES_SQL', 'PROFILE_STUDIES_SQL']) {
    assert.match(ALL_SQL[name], /COALESCE\(ss\.country, ''\) = \$2/,
      `${name} must scope to one country`);
  }
});

// A NULL country in a GROUP BY or a JOIN silently drops the row. Those sites would disappear from
// search while still being counted in the census, so the two would disagree and neither would be
// obviously wrong.
test('country is coalesced, never compared as NULL', () => {
  for (const [name, sql] of Object.entries(ALL_SQL)) {
    if (!/\bss\.country\b/.test(sql)) continue;
    const bare = sql.match(/(?<!COALESCE\()\bss\.country\b(?!\s*,\s*'')/g) || [];
    // ss.country may appear inside COALESCE only.
    assert.equal(bare.length, 0, `${name} uses ss.country without COALESCE`);
  }
});

// 2,192 rows read "Novartis Investigative Site" and 1,836 read "Research Site". One of those at
// the top of an institution league table is the end of the page's credibility.
test('no query can return an anonymised placeholder as an institution', () => {
  for (const [name, sql] of Object.entries(ALL_SQL)) {
    assert.match(sql, /ss\.anonymised = FALSE/, `${name} does not exclude anonymised sites`);
  }
  assert.match(COUNTRIES_SQL, /ss\.anonymised = FALSE/);
});

// Grouping on the verbatim name fragments one hospital into ten spellings.
test('grouping is on the normalised key, not the verbatim facility', () => {
  assert.match(SEARCH_SQL, /ss\.facility_normalized AS key/);
  assert.doesNotMatch(SEARCH_SQL, /GROUP BY\s+facility\b/i);
});

// The census counts the whole table — including anonymised rows, deliberately, so the header can
// say how much of the data is placeholder. It must not be scoped to one institution.
test('the census is unscoped and separates named from total rows', () => {
  assert.match(CENSUS_SQL, /COUNT\(\*\)::int AS site_rows/);
  assert.match(CENSUS_SQL, /anonymised = FALSE\)::int AS named_rows/);
  assert.doesNotMatch(CENSUS_SQL, /\$1/);
});

// A limit that interpolates would be an injection point; a limit that is missing would ship 30,519
// rows to a browser.
test('search is bounded by a bound parameter', () => {
  assert.match(SEARCH_SQL, /LIMIT \$3/);
});

// A trial lists the same hospital more than once across amendments, with different statuses. Any
// count of trials has to be DISTINCT on nct_id or every number on the page is inflated.
test('trial counts are distinct on nct_id', () => {
  for (const name of ['SEARCH_SQL', 'PROFILE_NAMES_SQL', 'PROFILE_TOTALS_SQL',
    'PROFILE_SPONSORS_SQL', 'PROFILE_AREAS_SQL', 'PROFILE_PHASES_SQL']) {
    assert.match(ALL_SQL[name], /COUNT\(DISTINCT (ss\.|)nct_id\)/,
      `${name} counts trials without DISTINCT`);
  }
  // The study list returns one row per trial for the same reason.
  assert.match(PROFILE_STUDIES_SQL, /DISTINCT ON \(ss\.nct_id\)/);
});

// ── RELATED INSTITUTIONS ─────────────────────────────────────────────────────

test('distinctiveTokens keeps the identifying words and drops the generic ones', () => {
  assert.deepEqual(distinctiveTokens('oxford university hospital nhs trust'), ['oxford']);
  // "memorial" stays: it is part of the proper name ("Baptist Memorial", "Memorial Hermann"), not a
  // generic descriptor like "hospital". It matches more widely than "sloan" does, which is handled
  // by ranking on the NUMBER of shared tokens rather than by discarding the word — a real sibling
  // shares two and sorts above anything sharing only "memorial".
  assert.deepEqual(distinctiveTokens('memorial sloan kettering cancer center'), ['memorial', 'sloan', 'kettering']);
  assert.deepEqual(distinctiveTokens('charite universitatsmedizin berlin'), ['charite', 'universitatsmedizin', 'berlin']);
});

// Without this, "hospital" becomes a match term and every hospital in the country is reported as
// related to every other.
test('distinctiveTokens returns nothing when the name is entirely generic', () => {
  assert.deepEqual(distinctiveTokens('university hospital'), []);
  assert.deepEqual(distinctiveTokens('national cancer centre'), []);
  assert.deepEqual(distinctiveTokens('research site'), []);
  assert.deepEqual(distinctiveTokens(''), []);
  assert.deepEqual(distinctiveTokens(null), []);
});

// Two-letter fragments and bare numbers match far too much to be identifying.
test('distinctiveTokens drops short fragments and bare numbers', () => {
  assert.deepEqual(distinctiveTokens('st jude children research hospital'), ['jude']);
  assert.deepEqual(distinctiveTokens('hospital 12 de octubre'), ['octubre']);
});

// A long name would otherwise send a dozen match terms to a regex over 84,608 rows, and the tail
// tokens are the least identifying ones anyway.
test('distinctiveTokens is capped', () => {
  assert.equal(distinctiveTokens('alpha bravo charlie delta echo foxtrot').length, 4);
  assert.equal(distinctiveTokens('alpha bravo charlie delta echo foxtrot', 2).length, 2);
});

test('RELATED_SQL excludes the institution itself and stays in one country', () => {
  assert.match(RELATED_SQL, /ss\.facility_normalized <> \$1/);
  assert.match(RELATED_SQL, /COALESCE\(ss\.country, ''\) = \$2/);
  assert.match(RELATED_SQL, /ss\.anonymised = FALSE/);
  assert.match(RELATED_SQL, /COUNT\(DISTINCT nct_id\)/);
  assert.match(RELATED_SQL, /LIMIT 12/);
});

// A substring match would make "oxford" hit "oxfordshire" and, worse, make a short token match
// inside unrelated words. \m and \M are Postgres word boundaries.
test('RELATED_SQL matches whole words, not substrings', () => {
  // The SQL string must contain a single backslash before m and M — Postgres word boundaries. The
  // source writes '\\m' in a template literal, which is '\m' in the string, so this regex looks for
  // one literal backslash.
  assert.match(RELATED_SQL, /'\\m' \|\| tok\.t \|\| '\\M'/);
  assert.ok(RELATED_SQL.includes("'\\m'"), 'the \\m boundary must survive into the SQL string');
});

// The site's own status is the one that answers "is Oxford recruiting today". The trial's overall
// status is a different question and using it here would report a site as recruiting when that
// site closed years ago.
test('recruiting-here is measured on the site status, not the trial status', () => {
  assert.match(PROFILE_TOTALS_SQL, /FILTER \(WHERE ss\.status ILIKE 'RECRUITING'\)::int AS recruiting_here/);
  assert.match(SEARCH_SQL, /FILTER \(WHERE m\.status ILIKE 'RECRUITING'\)/);
});
