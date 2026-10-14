#!/usr/bin/env node
// ── EXECUTE THE INSTITUTION SEARCH AND PROFILE AGAINST A REAL POSTGRES. ───────
//
//   scripts/check-institution-search-sql.js   → exit 0 = the queries run AND answer correctly
//
// Seven statements, and the search alone is five CTEs with two DISTINCT ON picks, a FILTER
// aggregate and three LEFT JOINs on a composite key. Every one of those parses and then fails.
// `node --check` and the unit tests prove the SQL is a string containing the right words; only a
// server proves it runs, and only seeded data proves it returns the right rows.
//
// ── THE TRAP THIS CHECK EXISTS FOR ──────────────────────────────────────────
//
// Searching "Oxford" against production returned 35 trials, and 20 of them were Baptist Memorial
// Hospital and Cancer Center-Oxford — in Oxford, MISSISSIPPI. The NCI and cooperative-group trials
// belonged to the Mississippi site; the Roche, Pfizer and argenx trials to the English one.
// Reported as one institution's activity that is confidently wrong, and it is the first thing a
// buyer would notice.
//
// So the fixture contains both Oxfords, with sponsor profiles chosen to make a conflation visible:
// if the group key ever loses `country`, the English hospital's profile picks up an NCI trial it
// has nothing to do with and this check fails.
//
// Skips cleanly (exit 0) where no Postgres is available, so preflight still runs on a bare laptop.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const Q = require('../src/lib/agents/research-intelligence/institution-search');
const { normalizeFacility } = require('../src/lib/agents/research-intelligence/sites');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(String(d).split('\n').map((l) => '          ' + l).join('\n')); };

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
const findInitdb = () => BIN.find((d) => fs.existsSync(path.join(d, 'initdb'))) || null;

let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/instsearch-');
  const asRoot = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asRoot ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { stdio: 'pipe' });
  try {
    if (asRoot) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55997 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asRoot };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55997`;
}
function stopTemp() {
  if (!temp) return;
  try {
    execFileSync('sh', ['-c', temp.asRoot
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { stdio: 'pipe' });
  } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.MOLSEARCH_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set MOLSEARCH_PG_URL or install initdb)');
  console.log('SKIP  institution search not executed — this check needs a server');
  process.exit(0);
}

// The real column sets. study_sites as migrate-study-sites.js creates it; clinical_studies with the
// columns these queries touch — note last_update_post_date is TEXT, which is why MAX() on it works
// and why a date comparison on it would not.
const SCHEMA = `
CREATE TABLE clinical_studies (
  id BIGSERIAL PRIMARY KEY, nct_id TEXT, brief_title TEXT, overall_status TEXT, phase TEXT,
  lead_sponsor_name TEXT, sponsor_type TEXT, collaborators TEXT, institution TEXT,
  enrollment_count INT, locations_countries TEXT, start_date DATE,
  last_update_post_date TEXT, therapeutic_area TEXT, disease TEXT, sites_parsed_at TIMESTAMPTZ);
CREATE TABLE study_sites (
  id BIGSERIAL PRIMARY KEY, nct_id TEXT NOT NULL, facility TEXT, facility_normalized TEXT,
  anonymised BOOLEAN NOT NULL DEFAULT FALSE, city TEXT, state TEXT, country TEXT, zip TEXT,
  status TEXT, parsed_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
`;

// ── THE FIXTURE ──────────────────────────────────────────────────────────────
// Two Oxfords, one hospital under three spellings, one anonymised placeholder, and one site with
// no country at all.
const OX_UK = 'Oxford University Hospitals NHS Foundation Trust';
const OX_UK_2 = 'Oxford University Hospitals NHS Trust';              // same body, two spellings
const OX_UK_3 = 'Oxford University Hospitals Nhs Foundation Trust /ID# 272486'; // + a site id
const OX_US = 'Baptist Memorial Hospital and Cancer Center-Oxford';

const STUDIES = [
  // The English hospital: industry sponsors, one recruiting here now.
  ['NCT0001', 'Roche study', 'RECRUITING', 'Phase 3', 'Hoffmann-La Roche', 'INDUSTRY', '["IQVIA"]', 'Oncology', '2026-09-01'],
  ['NCT0002', 'argenx study', 'RECRUITING', 'Phase 2', 'argenx', 'INDUSTRY', '["Parexel International"]', 'Immunology', '2026-08-01'],
  ['NCT0003', 'Pfizer study', 'COMPLETED', 'Phase 1', 'Pfizer', 'INDUSTRY', '[]', 'Oncology', '2026-07-01'],
  ['NCT0004', 'Academic study', 'RECRUITING', 'Phase 2', 'University of Oxford', 'OTHER', '[]', 'Cardiovascular', '2026-06-01'],
  // The Mississippi site: NCI, cooperative group. Must NEVER appear under the UK profile.
  ['NCT9001', 'NCI study one', 'RECRUITING', 'Phase 3', 'National Cancer Institute', 'NIH', '[]', 'Oncology', '2026-09-15'],
  ['NCT9002', 'NCI study two', 'RECRUITING', 'Phase 2', 'National Cancer Institute', 'NIH', '[]', 'Oncology', '2026-09-10'],
  // A trial whose site publishes no country.
  ['NCT5001', 'Nowhere study', 'RECRUITING', 'Phase 1', 'Sponsor Without A Country', 'INDUSTRY', '[]', 'Oncology', '2026-05-01'],
  // The sibling sites. Their sponsors differ from the trust's so a leak between them is visible.
  ['NCT0005', 'Churchill study', 'RECRUITING', 'Phase 2', 'BeOne Medicines', 'INDUSTRY', '[]', 'Oncology', '2026-04-01'],
  ['NCT0006', 'GenesisCare study', 'RECRUITING', 'Phase 3', 'Cytokinetics', 'INDUSTRY', '[]', 'Cardiovascular', '2026-03-01'],
  ['NCT0007', 'Oxford Health study', 'RECRUITING', 'Phase 2', 'Oxford Health NHS Foundation Trust', 'OTHER', '[]', 'Neurology/CNS', '2026-02-01'],
  ['NCT0008', 'Marsden study', 'RECRUITING', 'Phase 1', 'Royal Marsden', 'OTHER', '[]', 'Oncology', '2026-01-15'],
  ['NCT0009', 'Oxfordshire study', 'RECRUITING', 'Phase 1', 'Oxfordshire CDP', 'OTHER', '[]', 'Other', '2026-01-10'],
];

const SITES = [
  // One institution, three spellings, one of them repeated on a second trial.
  ['NCT0001', OX_UK, 'Oxford', 'United Kingdom', 'RECRUITING'],
  ['NCT0002', OX_UK_2, 'Oxford', 'United Kingdom', 'RECRUITING'],
  ['NCT0003', OX_UK, 'Oxford', 'United Kingdom', 'COMPLETED'],
  ['NCT0004', OX_UK_3, 'Oxford', 'United Kingdom', 'COMPLETED'],
  // The same trial listing the same hospital twice across amendments: must not double-count.
  ['NCT0001', OX_UK_2, 'Oxford', 'United Kingdom', 'COMPLETED'],
  // ── THE SIBLINGS THE STRICT KEY SPLITS OFF ────
  // All real spellings from production. The Churchill sits in Headington, not Oxford, which is why
  // the related lookup cannot be scoped to one city. GenesisCare is a private chain and Oxford
  // Health is a different NHS trust — both must appear (they look related) without anything in the
  // system claiming they are the same body.
  ['NCT0005', 'Churchill Hospital, Oxford University Hospitals NHS Foundation Trust', 'Headington', 'United Kingdom', 'RECRUITING'],
  ['NCT0006', 'GenesisCare - Oxford ( Site 2607)', 'Oxford', 'United Kingdom', 'RECRUITING'],
  ['NCT0007', 'Oxford Health NHS Foundation Trust (OHFT)', 'Oxford', 'United Kingdom', 'RECRUITING'],
  // Same country, no shared distinctive word: must NOT be called related.
  ['NCT0008', 'Royal Marsden Hospital', 'London', 'United Kingdom', 'RECRUITING'],
  // Shares "oxford" as a SUBSTRING only. A substring match would wrongly pull this in.
  ['NCT0009', 'Oxfordshire Community Diagnostics Partnership', 'Banbury', 'United Kingdom', 'RECRUITING'],
  // Mississippi.
  ['NCT9001', OX_US, 'Oxford', 'United States', 'RECRUITING'],
  ['NCT9002', OX_US, 'Oxford', 'United States', 'RECRUITING'],
  // A placeholder that must never be an institution.
  ['NCT0001', 'Novartis Investigative Site', 'Oxford', 'United Kingdom', 'RECRUITING'],
  // No country published.
  ['NCT5001', 'Hospital With No Country', 'Someplace', null, 'RECRUITING'],
];

(async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query(SCHEMA);

    for (const [nct, title, status, phase, sponsor, type, collab, ta, upd] of STUDIES) {
      await client.query(
        `INSERT INTO clinical_studies (nct_id, brief_title, overall_status, phase, lead_sponsor_name,
           sponsor_type, collaborators, therapeutic_area, last_update_post_date, start_date, enrollment_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'2026-01-01',100)`,
        [nct, title, status, phase, sponsor, type, collab, ta, upd]);
    }
    for (const [nct, facility, city, country, status] of SITES) {
      // anonymised and facility_normalized are written by sites.js at parse time, so the fixture
      // uses the real functions rather than hand-written values — otherwise this check could pass
      // against a normalisation rule that production does not use.
      const { isAnonymised } = require('../src/lib/agents/research-intelligence/sites');
      await client.query(
        `INSERT INTO study_sites (nct_id, facility, facility_normalized, anonymised, city, country, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [nct, facility, normalizeFacility(facility), isAnonymised(facility), city, country, status]);
    }
    ok('built the real table shapes and seeded two Oxfords, three spellings and a placeholder');

    const run = async (label, sql, params) => {
      try { return (await client.query(sql, params)).rows; }
      catch (e) { bad(`execute ${label}`, e.message + (e.position ? ` (position ${e.position})` : '')); throw e; }
    };

    // ── SEARCH ────
    const hits = await run('SEARCH_SQL', Q.SEARCH_SQL, ['Oxford', '', 50]);
    ok(`SEARCH_SQL runs — ${hits.length} institution(s) for "Oxford"`);

    // The trust's own row, found by KEY — "the UK row" is no longer unique now that the siblings
    // are in the fixture, which is the whole point of the related lookup below.
    const OX_KEY = normalizeFacility(OX_UK);
    const uk = hits.filter((h) => h.country === 'United Kingdom' && h.key === OX_KEY);
    const us = hits.filter((h) => h.country === 'United States');

    if (uk.length !== 1 || us.length !== 1) {
      bad('the two Oxfords come back as two separate institutions',
        JSON.stringify(hits.map((h) => [h.name, h.country, h.trials])));
    } else ok('the two Oxfords are two rows, each carrying its own country');

    if (uk.length === 1) {
      // Four UK trials across three spellings, and NCT0001 listed twice — 4, not 5.
      if (uk[0].trials !== 4) {
        bad('three spellings of one hospital group into one institution, counted once per trial',
          `trials=${uk[0].trials}, expected 4`);
      } else ok('UK Oxford: trials=4 — three spellings folded, the duplicate amendment not double-counted');

      if (uk[0].industry_trials !== 3) {
        bad('industry_trials counts only INDUSTRY sponsors', `got ${uk[0].industry_trials}, expected 3`);
      } else ok('UK Oxford: industry_trials=3 — the academic sponsor excluded');

      // Two sites are RECRUITING here (NCT0001, NCT0002); NCT0001 also appears as COMPLETED on a
      // second row, which must not remove it.
      if (uk[0].recruiting !== 2) {
        bad('recruiting counts trials recruiting AT THIS SITE', `got ${uk[0].recruiting}, expected 2`);
      } else ok('UK Oxford: recruiting=2 — measured on the site status, not the trial status');

      // The display name must be a real spelling, and never the one carrying a site id.
      if (/ID#/.test(uk[0].name)) {
        bad('the display name is a clean spelling', uk[0].name);
      } else ok(`UK Oxford display name: "${uk[0].name}"`);
    }

    if (hits.some((h) => /Investigative Site/i.test(h.name))) {
      bad('an anonymised placeholder reached the institution list',
        hits.filter((h) => /Investigative Site/i.test(h.name)).map((h) => h.name).join(', '));
    } else ok('"Novartis Investigative Site" excluded from the institution list');

    // A site with no country must still be findable. If country were compared as NULL rather than
    // COALESCEd, this row would vanish from search while still counting in the census.
    const nocountry = await run('SEARCH_SQL (no country)', Q.SEARCH_SQL, ['No Country', '', 50]);
    if (nocountry.length !== 1 || nocountry[0].country !== '') {
      bad('a site with no published country is still searchable',
        JSON.stringify(nocountry.map((h) => [h.name, h.country])));
    } else ok('a site with no published country is still searchable (country coalesced to "")');

    // An empty query lists everything, which is what the page does on first load.
    const all = await run('SEARCH_SQL (empty query)', Q.SEARCH_SQL, ['', '', 50]);
    if (all.length < 3) bad('an empty query lists every institution', `got ${all.length}`);
    else ok(`an empty query lists every institution — ${all.length} rows`);

    // The country filter.
    const filtered = await run('SEARCH_SQL (country filter)', Q.SEARCH_SQL, ['Oxford', 'United States', 50]);
    if (filtered.length !== 1 || filtered[0].country !== 'United States') {
      bad('the country filter narrows to one country', JSON.stringify(filtered.map((h) => h.country)));
    } else ok('the country filter narrows to one country');

    // ── PROFILE ────
    const key = normalizeFacility(OX_UK);
    if (normalizeFacility(OX_UK_2) !== key || normalizeFacility(OX_UK_3) !== key) {
      bad('all three spellings normalise to one key',
        [OX_UK, OX_UK_2, OX_UK_3].map(normalizeFacility).join(' | '));
    } else ok('all three spellings normalise to one key');

    const p = ['United Kingdom'];
    const names = await run('PROFILE_NAMES_SQL', Q.PROFILE_NAMES_SQL, [key, ...p]);
    if (names.length !== 3) bad('the profile lists every spelling it merged', JSON.stringify(names.map((n) => n.name)));
    else ok(`PROFILE_NAMES_SQL runs — ${names.length} spellings shown, so a merge is visible`);

    const totals = (await run('PROFILE_TOTALS_SQL', Q.PROFILE_TOTALS_SQL, [key, ...p]))[0];
    ok('PROFILE_TOTALS_SQL runs');
    if (Number(totals.trials) !== 4) bad('profile trials=4', `got ${totals.trials}`);
    else ok(`profile: trials=${totals.trials}, industry=${totals.industry_trials}, recruiting here=${totals.recruiting_here}`);
    if (Number(totals.industry_trials) !== 3) bad('profile industry_trials=3', `got ${totals.industry_trials}`);
    if (Number(totals.recruiting_here) !== 2) bad('profile recruiting_here=2', `got ${totals.recruiting_here}`);
    if (totals.last_update !== '2026-09-01') {
      bad('MAX() on a TEXT date column returns the real maximum', `got ${totals.last_update}, expected 2026-09-01`);
    } else ok('MAX(last_update_post_date) returns the real maximum on a TEXT column');

    const sponsors = await run('PROFILE_SPONSORS_SQL', Q.PROFILE_SPONSORS_SQL, [key, ...p]);
    ok(`PROFILE_SPONSORS_SQL runs — ${sponsors.length} sponsors`);
    // THE CONFLATION TEST. If the group key loses country, the NCI arrives here from Mississippi.
    if (sponsors.some((s) => /National Cancer Institute/i.test(s.sponsor))) {
      bad('the Mississippi site\'s sponsors must not appear under the English hospital',
        'National Cancer Institute came back — the two Oxfords have been merged');
    } else ok('no Mississippi sponsor under the English hospital — the two Oxfords stay apart');
    if (sponsors.length !== 4) bad('four distinct sponsors', JSON.stringify(sponsors.map((s) => s.sponsor)));
    if (sponsors[0] && Number(sponsors[0].trials) !== 1) {
      bad('sponsor rows are per-trial counts', JSON.stringify(sponsors.map((s) => [s.sponsor, s.trials])));
    }

    const areas = await run('PROFILE_AREAS_SQL', Q.PROFILE_AREAS_SQL, [key, ...p]);
    ok(`PROFILE_AREAS_SQL runs — ${areas.length} therapeutic areas`);
    const onc = areas.find((a) => a.area === 'Oncology');
    if (!onc || Number(onc.trials) !== 2) {
      bad('therapeutic areas count trials at this site', JSON.stringify(areas.map((a) => [a.area, a.trials])));
    } else ok('Oncology=2 at this site');

    const phases = await run('PROFILE_PHASES_SQL', Q.PROFILE_PHASES_SQL, [key, ...p]);
    ok(`PROFILE_PHASES_SQL runs — ${phases.length} phases`);

    const studies = await run('PROFILE_STUDIES_SQL', Q.PROFILE_STUDIES_SQL, [key, ...p]);
    ok(`PROFILE_STUDIES_SQL runs — ${studies.length} trials`);
    if (studies.length !== 4) {
      bad('one row per trial even where a trial lists the site twice',
        JSON.stringify(studies.map((s) => [s.nct_id, s.site_status])));
    } else ok('one row per trial — the duplicated amendment collapsed');
    if (studies.some((s) => /NCT9/.test(s.nct_id))) {
      bad('a Mississippi trial reached the English hospital\'s trial list',
        studies.filter((s) => /NCT9/.test(s.nct_id)).map((s) => s.nct_id).join(', '));
    } else ok('no Mississippi trial in the English hospital\'s trial list');

    // The collaborator ranking runs in JS over these rows; check it against real column values
    // rather than hand-made fixtures, because the column is JSON text and the parser has to cope.
    const collab = Q.collaboratorRanking(studies);
    const iqvia = collab.find((c) => /IQVIA/i.test(c.name));
    const parexel = collab.find((c) => /Parexel/i.test(c.name));
    if (!iqvia || iqvia.kind !== 'cro' || !parexel || parexel.kind !== 'cro') {
      bad('collaborators parse out of the JSON column and label as CROs', JSON.stringify(collab));
    } else ok('collaborators parsed from the JSON column and labelled: IQVIA, Parexel → cro');

    // ── RELATED INSTITUTIONS: THE SIBLINGS THE STRICT KEY SPLITS OFF ────
    const tokens = Q.distinctiveTokens(key);
    if (tokens.length !== 1 || tokens[0] !== 'oxford') {
      bad('the trust reduces to one distinctive token', JSON.stringify(tokens));
    } else ok('distinctive tokens for the trust: ["oxford"]');

    const related = await run('RELATED_SQL', Q.RELATED_SQL, [key, 'United Kingdom', tokens]);
    ok(`RELATED_SQL runs — ${related.length} related institution(s)`);
    const relNames = (related || []).map((r) => r.name);

    // The Churchill is in HEADINGTON, not Oxford. If this lookup were scoped to the city it would
    // miss the one sibling most obviously part of the same trust.
    if (!relNames.some((n) => /Churchill/i.test(n))) {
      bad('a sibling in a neighbouring town is still found', JSON.stringify(relNames));
    } else ok('the Churchill (Headington, not Oxford) is found — the lookup is not city-scoped');
    if (!relNames.some((n) => /GenesisCare/i.test(n)) || !relNames.some((n) => /Oxford Health/i.test(n))) {
      bad('all plausibly related institutions are offered', JSON.stringify(relNames));
    } else ok('GenesisCare and Oxford Health both offered — related, not merged');

    // The institution must never appear in its own related list.
    if (related.some((r) => r.key === key)) bad('the institution appears in its own related list');
    else ok('the institution is excluded from its own related list');

    // No shared distinctive word: not related, however close geographically.
    if (relNames.some((n) => /Marsden/i.test(n))) {
      bad('an unrelated hospital in the same country must not be called related', JSON.stringify(relNames));
    } else ok('Royal Marsden excluded — no shared distinctive word');

    // THE SUBSTRING TRAP. "Oxfordshire Community Diagnostics Partnership" contains "oxford" as a
    // substring and is a different organisation. \m\M word boundaries are what keep it out, and a
    // regex that silently fails to anchor would let it in.
    if (relNames.some((n) => /Oxfordshire/i.test(n))) {
      bad('a substring match leaked in — the \\m \\M word boundaries are not anchoring',
        JSON.stringify(relNames));
    } else ok('"Oxfordshire …" excluded — the word boundaries anchor, so no substring match');

    // Each sibling keeps its own count rather than being folded into the parent.
    const churchill = related.find((r) => /Churchill/i.test(r.name));
    if (churchill && Number(churchill.trials) !== 1) {
      bad('a related row carries its OWN trial count', `Churchill trials=${churchill.trials}, expected 1`);
    } else ok('each related row carries its own trial count, not the parent\'s');

    // A generic name must not trigger the lookup at all: "hospital" as a match term would return
    // every hospital in the country under the heading "related".
    if (Q.distinctiveTokens('university hospital').length !== 0) {
      bad('a wholly generic name yields no match terms');
    } else ok('a wholly generic name yields no match terms, so the lookup is skipped');

    // ── THE FILTER FEED AND THE CENSUS ────
    const countries = await run('COUNTRIES_SQL', Q.COUNTRIES_SQL, []);
    ok(`COUNTRIES_SQL runs — ${countries.length} countries`);
    if (countries.some((c) => !c.country)) {
      bad('the country dropdown never offers a blank', JSON.stringify(countries));
    } else ok('the country dropdown offers no blank option');
    // Every country offered must return something — a dropdown entry that yields nothing is a bug
    // report from the person using it.
    for (const c of countries) {
      const r = await run('SEARCH_SQL (dropdown country)', Q.SEARCH_SQL, ['', c.country, 5]);
      if (!r.length) { bad(`country "${c.country}" is offered but returns nothing`); break; }
    }
    ok('every country offered in the filter returns at least one institution');

    const census = (await run('CENSUS_SQL', Q.CENSUS_SQL, []))[0];
    ok(`CENSUS_SQL runs — ${census.site_rows} rows, ${census.institutions} institutions, ${census.countries} countries`);
    if (Number(census.site_rows) !== SITES.length) {
      bad('the census counts every site row, placeholders included', `got ${census.site_rows}, expected ${SITES.length}`);
    } else ok('the census counts every row, placeholders included — so the header can say how many are placeholder');
    if (Number(census.named_rows) !== SITES.length - 1) {
      bad('named_rows excludes the placeholder', `got ${census.named_rows}`);
    } else ok('named_rows excludes the placeholder');
  } catch (e) {
    if (!fail) bad('unexpected failure', (e && e.stack) || String(e));
  } finally {
    try { await client.end(); } catch (_) {}
    stopTemp();
  }

  if (fail) {
    console.log(`\nFAIL  ${fail} problem(s) in the institution search SQL`);
    process.exit(1);
  }
  console.log('\nPASS  institution search and profile run on Postgres and answer correctly');
  process.exit(0);
})();
