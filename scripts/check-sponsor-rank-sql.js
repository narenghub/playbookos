#!/usr/bin/env node
// ── EXECUTE THE SPONSOR RANKING AGAINST A REAL POSTGRES. ──────────────────────
//
//   scripts/check-sponsor-rank-sql.js      → exit 0 = the query runs and ranks correctly
//
// Same reasoning as scripts/check-molecule-search-sql.js: the parsers cannot tell whether a query
// RUNS, and this one is harder than most — four CTEs, a json_agg with an ORDER BY inside it, a
// SUM(DISTINCT), and a numeric cast. Every one of those is a thing that parses and then fails.
//
// It also checks the RANKING, not just execution. The score decides which company Naresh walks up
// to first on a two-day floor, so "it returned rows" is not the test. The test is that a sponsor
// running trials on molecules we stock outranks one running more trials on molecules we do not.
//
// Skips cleanly (exit 0) where no Postgres is available, so preflight still runs on a bare laptop.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { sponsorRankSql, attachExhibitors, onlyBuyers } = require('../src/lib/events/sponsor-rank');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(String(d).split('\n').map((l) => '          ' + l).join('\n')); };

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
const findInitdb = () => BIN.find((d) => fs.existsSync(path.join(d, 'initdb'))) || null;

let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/sponsorrank-');
  const asRoot = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asRoot ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { stdio: 'pipe' });
  try {
    if (asRoot) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55998 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asRoot };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55998`;
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
  console.log('SKIP  sponsor ranking not executed — this check needs a server');
  process.exit(0);
}

// Real table shapes. Three sponsors chosen to separate the things the score is supposed to separate.
const SCHEMA = `
CREATE TABLE clinical_studies (
  id BIGSERIAL PRIMARY KEY, nct_id TEXT, brief_title TEXT, overall_status TEXT, phase TEXT,
  lead_sponsor_name TEXT, sponsor_type TEXT, collaborators TEXT, institution TEXT,
  enrollment_count INT, locations_countries TEXT, start_date DATE, therapeutic_area TEXT, disease TEXT);
CREATE TABLE study_molecules (
  id BIGSERIAL PRIMARY KEY, study_id BIGINT, molecule_name TEXT, catalog_match_status TEXT);
CREATE TABLE molecule_dmf_matches (
  id BIGSERIAL PRIMARY KEY, dmf_number TEXT, molecule_name TEXT, review_status TEXT);
CREATE TABLE molecule_pricing (
  id BIGSERIAL PRIMARY KEY, molecule_name TEXT, active INT, gmp_certified INT, price_per_kg_usd NUMERIC);
CREATE TABLE cphi_exhibitor_matches (
  id BIGSERIAL PRIMARY KEY, event_slug TEXT, holder TEXT, holder_normalized TEXT,
  exhibitor_name TEXT, booth TEXT, hall TEXT, exhibiting BOOLEAN, role TEXT, review_status TEXT);

-- SOURCEABLE SPONSOR: fewer studies, but on molecules we can quote today.
INSERT INTO clinical_studies (nct_id, lead_sponsor_name, sponsor_type, phase, overall_status, enrollment_count, therapeutic_area) VALUES
  ('NCT1001','Takeda Development Center Americas, Inc.','INDUSTRY','Phase 3','RECRUITING',400,'Oncology'),
  ('NCT1002','Takeda Development Center Americas, Inc.','INDUSTRY','Phase 2','RECRUITING',120,'Oncology');
-- BUSY SPONSOR: more studies, more patients, but nothing we stock.
INSERT INTO clinical_studies (nct_id, lead_sponsor_name, sponsor_type, phase, overall_status, enrollment_count, therapeutic_area) VALUES
  ('NCT2001','Novo Nordisk A/S','INDUSTRY','Phase 3','RECRUITING',900,'Metabolic'),
  ('NCT2002','Novo Nordisk A/S','INDUSTRY','Phase 3','RECRUITING',800,'Metabolic'),
  ('NCT2003','Novo Nordisk A/S','INDUSTRY','Phase 1','COMPLETED',40,'Metabolic');
-- NOT A BUYER: classed INDUSTRY but a government institute.
INSERT INTO clinical_studies (nct_id, lead_sponsor_name, sponsor_type, phase, overall_status, enrollment_count) VALUES
  ('NCT3001','National Cancer Institute','INDUSTRY','Phase 2','RECRUITING',200);
-- Non-industry sponsor: must never appear at all.
INSERT INTO clinical_studies (nct_id, lead_sponsor_name, sponsor_type, phase, overall_status, enrollment_count) VALUES
  ('NCT4001','University of Barcelona','OTHER','Phase 2','RECRUITING',60);

INSERT INTO study_molecules (study_id, molecule_name) VALUES
  (1,'Leuprolide Acetate'), (1,'Cabazitaxel'), (2,'Leuprolide Acetate'),
  (3,'Semaglutide'), (4,'Semaglutide'), (5,'Obscure Peptide X'),
  (6,'Cabazitaxel'), (7,'Metformin');

-- We can quote leuprolide (DMF) and cabazitaxel (price list). Semaglutide and the rest: nothing.
INSERT INTO molecule_dmf_matches (dmf_number, molecule_name, review_status) VALUES
  ('DMF-1','Leuprolide Acetate','auto_confirmed'),
  ('DMF-2','Unrelated Molecule','auto_confirmed'),
  ('DMF-3','Semaglutide','entity_review');          -- NOT auto_confirmed: must not count
INSERT INTO molecule_pricing (molecule_name, active, gmp_certified, price_per_kg_usd) VALUES
  ('Cabazitaxel', 1, 1, 410000),
  ('Semaglutide', 0, 1, 90000);                      -- inactive: must not count

-- The SCOPE floor: Takeda is there under its trading name, Novo Nordisk is not listed.
INSERT INTO cphi_exhibitor_matches (event_slug, holder, holder_normalized, exhibitor_name, booth, hall, exhibiting, role, review_status) VALUES
  ('scope-europe-2026','Takeda','takeda','Takeda','P14','Exhibit Hall',true,'abiozen','confirmed');
`;

(async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query(SCHEMA);
    ok('built the real table shapes and seeded three sponsor profiles');

    const SQL = sponsorRankSql({ limit: 50, minStudies: 1 });
    let rows;
    try {
      rows = (await client.query(SQL)).rows;
      ok(`the ranking SQL runs — ${rows.length} sponsors returned`);
    } catch (e) {
      bad('execute the sponsor ranking SQL', e.message + (e.position ? ` (position ${e.position})` : ''));
      throw e;
    }

    const by = (n) => rows.find((r) => r.sponsor === n);

    // ── ONLY INDUSTRY SPONSORS ────
    if (by('University of Barcelona')) {
      bad('non-INDUSTRY sponsors are excluded', 'University of Barcelona came back — that is an academic sponsor, not a buyer');
    } else ok('non-INDUSTRY sponsors excluded (academic sponsor absent)');

    // ── SOURCEABLE COUNTS ONLY WHAT WE CAN ACTUALLY QUOTE ────
    const tak = by('Takeda Development Center Americas, Inc.');
    const novo = by('Novo Nordisk A/S');
    if (!tak || !novo) {
      bad('both industry sponsors returned', `takeda=${!!tak} novo=${!!novo}`);
    } else {
      if (tak.sourceable !== 2) {
        bad('sourceable counts leuprolide (DMF) and cabazitaxel (price)', `got ${tak.sourceable}, expected 2`);
      } else ok('Takeda: sourceable=2 — one via DMF, one via the price list');

      if (novo.sourceable !== 0) {
        bad('an entity_review DMF and an inactive price row do NOT make a molecule sourceable',
          `Novo sourceable=${novo.sourceable}, expected 0 — semaglutide has only a non-confirmed DMF and an inactive price`);
      } else ok('Novo Nordisk: sourceable=0 — review-gated DMF and inactive price correctly ignored');

      if (novo.unsourced !== 2) {
        bad('unsourced counts the demand we cannot serve', `got ${novo.unsourced}, expected 2`);
      } else ok('Novo Nordisk: unsourced=2 — demand we cannot serve yet, counted separately');

      // ── THE RANKING CLAIM ────
      // Novo has more studies (3 vs 2), more Phase 3 (2 vs 1) and far more patients (1740 vs 520).
      // Takeda must still outrank it, because Takeda is running trials on material we hold. If this
      // fails, the list sends Naresh to the booth where he has nothing to offer.
      if (Number(tak.score) <= Number(novo.score)) {
        bad('a sponsor we can supply outranks a busier one we cannot',
          `Takeda ${tak.score} vs Novo ${novo.score} — sourceable molecules are not weighted enough`);
      } else ok(`Takeda ${tak.score} > Novo ${novo.score} — what we can supply beats raw trial volume`);
    }

    // ── THE MOLECULE LIST, WHICH IS THE THING SAID AT A BOOTH ────
    if (tak) {
      const ml = tak.molecule_list;
      if (!Array.isArray(ml) || !ml.length) {
        bad('every row carries its molecules', JSON.stringify(ml));
      } else {
        if (!ml[0].sourceable) {
          bad('quotable molecules sort first in the drawer', JSON.stringify(ml.map((m) => [m.molecule, m.sourceable])));
        } else ok(`molecule drawer leads with a quotable one: ${ml[0].molecule}`);
        const names = ml.map((m) => m.molecule).sort();
        if (names.length !== 2) {
          bad('molecules are deduplicated per sponsor', `got ${JSON.stringify(names)} — leuprolide appears in two studies and must count once`);
        } else ok(`molecules deduplicated across studies: ${names.join(', ')}`);
      }
    }

    // ── DOUBLE-COUNTING ────
    if (tak && tak.studies !== 2) bad('studies are distinct', `got ${tak.studies}, expected 2`);
    else if (tak) ok('study counts are distinct, not multiplied by the molecule join');
    if (tak && tak.patients !== 520) {
      bad('patients sum each study once', `got ${tak.patients}, expected 520 — the molecule join would double it to 1040`);
    } else if (tak) ok('patients=520 — the molecule join did not inflate enrolment');

    // ── NOT-A-BUYER FILTER (JS) ────
    const filtered = onlyBuyers(rows);
    if (filtered.some((r) => /national cancer institute/i.test(r.sponsor))) {
      bad('onlyBuyers drops government institutes', 'National Cancer Institute survived the filter');
    } else ok('onlyBuyers drops the government institute classed as INDUSTRY');
    if (!filtered.some((r) => /takeda/i.test(r.sponsor))) {
      bad('onlyBuyers keeps real companies', 'Takeda was filtered out');
    } else ok('onlyBuyers keeps the real companies');

    // ── THE SHOW-FLOOR TIE-IN (JS) ────
    const exhibitors = (await client.query(
      `SELECT id, holder, holder_normalized, exhibitor_name, booth, hall, exhibiting
         FROM cphi_exhibitor_matches WHERE event_slug = $1 AND role = $2`,
      ['scope-europe-2026', 'abiozen'])).rows;
    const attached = attachExhibitors(filtered, exhibitors);

    const atak = attached.find((r) => /takeda/i.test(r.sponsor));
    if (!atak || !atak.exhibiting) {
      bad('"Takeda Development Center Americas, Inc." matches the stand reading "Takeda"',
        JSON.stringify(atak && { exhibiting: atak.exhibiting, tier: atak.match_tier }));
    } else {
      ok(`Takeda tied to booth ${atak.booth} via a ${atak.match_tier} match`);
      if (!atak.review_status) bad('a match carries its review gate', 'review_status is empty');
      else ok(`review gate carried through: ${atak.review_status}`);
    }

    const anovo = attached.find((r) => /novo/i.test(r.sponsor));
    if (!anovo) {
      bad('a high-ranking sponsor NOT on the floor still appears', 'Novo Nordisk vanished');
    } else if (anovo.exhibiting) {
      bad('a sponsor absent from the exhibitor list is not marked exhibiting', 'Novo Nordisk marked exhibiting');
    } else ok('Novo Nordisk still listed, exhibiting=false — a gap to research, not a row to hide');

    if (attached.length && !attached[0].exhibiting && attached.some((r) => r.exhibiting)) {
      bad('whoever is on the floor sorts first', attached.map((r) => `${r.sponsor} exhibiting=${r.exhibiting}`).join('\n'));
    } else ok('the floor sorts above the ranking — two days, so presence wins');

  } catch (e) {
    if (!fail) bad('unexpected error', e.message);
  } finally {
    try { await client.end(); } catch (_) {}
    stopTemp();
  }

  if (fail) { console.error(`FAIL  ${fail} check(s) failed`); process.exit(1); }
  console.log('PASS  the sponsor ranking runs on real Postgres and ranks what we can supply first');
})();
