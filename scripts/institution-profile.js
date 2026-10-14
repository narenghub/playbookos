#!/usr/bin/env node
// ── ONE INSTITUTION, AND WHO IT ACTUALLY WORKS WITH ───────────────────────────
//
//   railway ssh 'node scripts/institution-profile.js --name=Oxford'
//   railway ssh 'node scripts/institution-profile.js --name=Oxford --ta=Oncology'
//   railway ssh 'node scripts/institution-profile.js --country=GB --top=20'   → the country list
//
// Read-only.
//
// ── WHAT NAREN ASKED FOR ────────────────────────────────────────────────────
//
// "Oxford doing 150 studies. In one therapeutic area among all therapeutic areas. To whom are they
// giving these studies to develop the molecules, to whom for CRO clinical studies. Country-wise,
// with a proper search."
//
// Three of those four are answerable from data already ingested, and one is not. Being clear about
// which is which is the whole point of running this before building a page around it.
//
//   ANSWERABLE  how many studies, and the split by therapeutic area
//   ANSWERABLE  which SPONSORS fund their trials (lead_sponsor_name)
//   ANSWERABLE  which organisations they CO-SPONSOR with (collaborators) — this is the
//               partnership graph, and it is where the pharma relationships show up
//   NOT IN THE REGISTRY  which CRO they contracted, and which eClinical software they use
//
// That last line matters commercially, so it is stated in the output rather than left for somebody
// to discover after promising it. A sponsor is not required to disclose its CRO, and the vast
// majority do not. Where a CRO IS named it is usually because it was listed as a collaborator —
// so the CRO column here is "CROs visible as collaborators", which is a floor, not a count.
'use strict';

const { initDB, query } = require('../src/lib/db');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const NAME = arg('name', null);
const COUNTRY = arg('country', null);
const TA = arg('ta', null);
const TOP = Math.max(1, Math.min(100, parseInt(arg('top', '15'), 10) || 15));

// Names that read like a contract research organisation or a testing lab. Used only to LABEL a
// collaborator, never to filter one out — a wrong guess should mis-tag a row, not hide it.
const CRO_HINT = /\b(cro|contract research|clinical research|quintiles|iqvia|parexel|icon plc|syneos|covance|labcorp|ppd\b|medpace|fortrea|thermo fisher|charles river|wuxi|novotech|veristat|emmes|rho\b|worldwide clinical)\b/i;
const ACADEMIC_HINT = /\b(universit|college|institut|hospital|clinic|school|centre|center|trust|nhs|foundation|academy|cancer cent)/i;


// A DATE column arrives as a JS Date, and interpolating it raw printed
// "Fri Sep 26 2014 00:00:00 GMT+0000 (Coordinated Universal Time)" in a table of site activity.
// Nobody reads a profile for the timezone.
const day = (v) => {
  if (!v) return '?';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

const parseList = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  const s = String(v).trim();
  if (s.startsWith('[')) { try { return (JSON.parse(s) || []).filter(Boolean); } catch (_) { /* fall through */ } }
  return s.split(/[;,|]/).map((x) => x.trim()).filter(Boolean);
};

const tally = (rows, fn) => {
  const m = new Map();
  for (const r of rows) for (const k of fn(r)) {
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

const show = (label, pairs, limit = TOP) => {
  if (!pairs.length) { console.log(`   ${label}: none recorded`); return; }
  console.log(`   ${label}:`);
  for (const [k, n] of pairs.slice(0, limit)) {
    console.log(`      ${String(n).padStart(4)}  ${k}`);
  }
  if (pairs.length > limit) console.log(`      … and ${pairs.length - limit} more`);
};

async function countryList() {
  const rows = (await query(
    `SELECT name, city, country, facility_type, study_count, first_seen, last_seen,
            contact_email IS NOT NULL AS has_contact
       FROM research_institutions
      ${COUNTRY ? 'WHERE country ILIKE $1' : ''}
      ORDER BY study_count DESC
      LIMIT ${TOP}`, COUNTRY ? [`%${COUNTRY}%`] : [])).rows;

  console.log(`\n── research institutions${COUNTRY ? ` · ${COUNTRY}` : ' · worldwide'} · top ${rows.length} by activity\n`);
  for (const r of rows) {
    console.log(`   ${String(r.study_count).padStart(4)} studies  ${r.name}`);
    console.log(`              ${[r.city, r.country].filter(Boolean).join(', ') || '(location unknown)'}`
      + ` · ${r.facility_type}`
      + ` · ${day(r.first_seen)} → ${day(r.last_seen)}`
      + ` · ${r.has_contact ? 'contact on file' : 'no contact'}`);
  }
  const agg = (await query(
    `SELECT country, COUNT(*)::int sites, SUM(study_count)::int studies
       FROM research_institutions GROUP BY country ORDER BY studies DESC NULLS LAST LIMIT 12`)).rows;
  console.log(`\n   by country:`);
  for (const a of agg) {
    console.log(`      ${String(a.studies).padStart(6)} studies  ${String(a.sites).padStart(4)} sites  ${a.country || '(unknown)'}`);
  }
  console.log(`\n   Profile one:  node scripts/institution-profile.js --name="<part of the name>"\n`);
}

async function profile() {
  // The institution row(s), if the site is in the curated table.
  const sites = (await query(
    `SELECT name, city, state, country, facility_type, study_count, first_seen, last_seen,
            contact_name, contact_email
       FROM research_institutions
      WHERE name ILIKE $1 OR normalized_name ILIKE $1
      ORDER BY study_count DESC LIMIT 10`, [`%${NAME}%`])).rows;

  // The studies. Matched on three fields, because an institution appears as the PI's affiliation,
  // as the lead sponsor, or as a collaborator — and which one depends on who ran the trial.
  const params = [`%${NAME}%`];
  let taClause = '';
  if (TA) { params.push(`%${TA}%`); taClause = ` AND therapeutic_area ILIKE $${params.length}`; }
  const studies = (await query(
    `SELECT nct_id, brief_title, phase, overall_status, therapeutic_area, disease,
            lead_sponsor_name, sponsor_type, collaborators, institution,
            locations_countries, enrollment_count, start_date, last_update_post_date
       FROM clinical_studies
      WHERE (institution ILIKE $1 OR lead_sponsor_name ILIKE $1 OR collaborators ILIKE $1)
        ${taClause}
      ORDER BY last_update_post_date DESC NULLS LAST`, params)).rows;

  // ── AS A RECRUITING SITE ────
  // The join that institution-profile could not make before study_sites existed. Oxford is the PI
  // affiliation or sponsor on 4 trials and a RECRUITING SITE on 46 — and the 42 are the
  // commercially interesting ones, because they name the sponsor Oxford is running trials for.
  // Anonymised placeholders are excluded here: "Novartis Investigative Site" is not an institution.
  let siteStudies = [];
  let siteTableMissing = false;
  try {
    const sp = [`%${NAME}%`];
    let sTa = '';
    if (TA) { sp.push(`%${TA}%`); sTa = ` AND cs.therapeutic_area ILIKE $${sp.length}`; }
    // ── COUNTRY, BECAUSE A NAME IS NOT AN INSTITUTION ────
    // "Oxford" returned 35 trials, and 20 of them were Baptist Memorial Hospital and Cancer
    // Center-Oxford — in Oxford, MISSISSIPPI. A substring search merges unrelated hospitals on
    // opposite sides of the Atlantic, and the merged total reads as one institution's activity.
    // The NCI trials in that list belong to the Mississippi site; the Roche, Pfizer, Janssen and
    // argenx trials belong to the English one. Reporting them together is worse than useless.
    let sCountry = '';
    if (COUNTRY) { sp.push(`%${COUNTRY}%`); sCountry = ` AND ss.country ILIKE $${sp.length}`; }
    siteStudies = (await query(
      `SELECT DISTINCT cs.nct_id, cs.brief_title, cs.phase, cs.overall_status, cs.therapeutic_area,
              cs.lead_sponsor_name, cs.sponsor_type, cs.last_update_post_date,
              ss.facility, ss.facility_normalized, ss.city, ss.country, ss.status AS site_status
         FROM study_sites ss
         JOIN clinical_studies cs ON cs.nct_id = ss.nct_id
        WHERE ss.anonymised = FALSE
          AND (ss.facility ILIKE $1 OR ss.facility_normalized ILIKE $1)
          ${sTa}${sCountry}
        ORDER BY cs.last_update_post_date DESC NULLS LAST`, sp)).rows;
  } catch (e) {
    // The table may not exist yet. That is a state to report, not to crash on.
    if (/study_sites/.test((e && e.message) || '')) siteTableMissing = true; else throw e;
  }

  console.log(`\n── ${NAME}${TA ? ` · ${TA}` : ''}\n`);

  if (sites.length) {
    console.log(`   in the curated institution table:`);
    for (const s of sites) {
      console.log(`      ${s.name}`);
      console.log(`         ${[s.city, s.state, s.country].filter(Boolean).join(', ') || '(location unknown)'}`
        + ` · ${s.facility_type} · ${s.study_count} studies on file`);
      console.log(`         active ${day(s.first_seen)} → ${day(s.last_seen)}`
        + ` · ${s.contact_email ? `contact: ${s.contact_name || 'unnamed'}` : 'no contact on file'}`);
    }
    console.log();
  } else {
    console.log(`   not in the curated institution table (that table holds academic, hospital,`);
    console.log(`   cancer-centre and institute sites only).\n`);
  }

  if (!studies.length) {
    console.log(`   no studies match "${NAME}". Try a shorter fragment — the match runs against the`);
    console.log(`   PI's affiliation, the lead sponsor and the collaborator list.\n`);
    return;
  }

  // ── THE NUMBERS HE ASKED FOR ────
  const recruiting = studies.filter((s) => /RECRUIT/i.test(s.overall_status || '')).length;
  const industry = studies.filter((s) => /INDUSTRY/i.test(s.sponsor_type || '')).length;
  console.log(`   ${studies.length} studies${TA ? ` in ${TA}` : ''}`
    + ` · ${recruiting} recruiting · ${industry} industry-sponsored\n`);

  show('therapeutic areas', tally(studies, (s) => [s.therapeutic_area || '(unclassified)']));
  console.log();
  show('phases', tally(studies, (s) => [s.phase || '(not stated)']), 8);
  console.log();

  // WHO FUNDS THEM — the sponsor is the money and the decision.
  show('sponsors funding their trials', tally(studies, (s) => [s.lead_sponsor_name]));
  console.log();

  // WHO THEY PARTNER WITH — collaborators, split by what the name looks like. The split is a
  // label on a guess: a name is tagged, never dropped, so a bad guess mis-files a row rather
  // than hiding it.
  const collabs = tally(studies, (s) => parseList(s.collaborators)
    .filter((c) => !new RegExp(NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(c)));
  const pharma = collabs.filter(([c]) => !CRO_HINT.test(c) && !ACADEMIC_HINT.test(c));
  const cros = collabs.filter(([c]) => CRO_HINT.test(c));
  const academic = collabs.filter(([c]) => ACADEMIC_HINT.test(c) && !CRO_HINT.test(c));

  show('co-sponsors that look like COMPANIES (pharma, biotech, device)', pharma);
  console.log();
  show('co-sponsors that look like CROs or testing labs', cros);
  console.log();
  show('co-sponsors that look like academic or hospital partners', academic, 8);
  console.log();

  show('countries the trials run in', tally(studies, (s) => parseList(s.locations_countries)));
  console.log();

  // ── THE SITE VIEW ────
  if (siteTableMissing) {
    console.log(`   study_sites does not exist yet — the "as a recruiting site" view is unavailable.`);
    console.log(`     node scripts/migrate-study-sites.js && node scripts/backfill-study-sites.js --execute\n`);
  } else if (!siteStudies.length) {
    console.log(`   as a RECRUITING SITE: no trials found. If study_sites has not been backfilled,`);
    console.log(`   run:  node scripts/backfill-study-sites.js --execute\n`);
  } else {
    console.log(`── as a RECRUITING SITE: ${siteStudies.length} trial(s)`
      + `${COUNTRY ? ` · ${COUNTRY} only` : ''}`);
    console.log(`   (vs ${studies.length} where the name is the PI's affiliation, sponsor or collaborator)\n`);

    // FIRST, before any sponsor list: is this one institution or several that share a word?
    const byPlace = tally(siteStudies, (r) => [`${r.country || '?'}${r.city ? ` — ${r.city}` : ''}`]);
    if (byPlace.length > 1 && !COUNTRY) {
      console.log(`   ⚠ "${NAME}" matches sites in ${byPlace.length} different places. These are`);
      console.log(`     probably NOT one institution, and the totals below merge them:`);
      for (const [place, n] of byPlace.slice(0, 8)) console.log(`        ${String(n).padStart(4)}  ${place}`);
      console.log(`     Narrow it:  --country="United Kingdom"\n`);
    } else {
      show('where', byPlace, 8);
      console.log();
    }
    show('sponsors running trials AT this institution', tally(siteStudies, (r) => [r.lead_sponsor_name]));
    console.log();
    show('sponsor type', tally(siteStudies, (r) => [r.sponsor_type || '(not stated)']), 6);
    console.log();
    show('therapeutic areas, as a site', tally(siteStudies, (r) => [r.therapeutic_area || '(unclassified)']));
    console.log();
    show('the facility names it appears under', tally(siteStudies, (r) => [r.facility]), 12);
    console.log();
    const recruitingNow = siteStudies.filter((r) => /RECRUIT/i.test(r.site_status || ''));
    if (recruitingNow.length) {
      console.log(`   ${recruitingNow.length} of those are RECRUITING at this site right now:`);
      for (const r of recruitingNow.slice(0, 10)) {
        console.log(`      ${r.nct_id}  ${r.phase || 'phase n/a'}  ${r.lead_sponsor_name || ''}`);
        console.log(`         ${(r.brief_title || '').slice(0, 76)}`);
      }
      console.log();
    }
  }

  // ── WHAT THIS CANNOT TELL HIM ────
  console.log(`   ⚠ WHAT IS NOT HERE, AND WHY`);
  console.log(`     · The CRO a sponsor CONTRACTED is not a registry field. A sponsor is not`);
  console.log(`       required to disclose it and most do not. The CRO list above is only those`);
  console.log(`       named as collaborators, so treat it as a floor and never as a count.`);
  console.log(`     · Which EDC, eTMF or CTMS they use is not published anywhere in the registry.`);
  console.log(`     · "Who they give molecules to for development" is visible only where that`);
  console.log(`       partner co-sponsored the trial. A licensing deal with no trial attached`);
  console.log(`       leaves no trace here — that lives in press releases and SEC filings.\n`);

  const newest = studies.slice(0, 8);
  console.log(`   most recently updated:`);
  for (const s of newest) {
    console.log(`      ${s.last_update_post_date || '?'}  ${s.nct_id}  ${s.phase || 'phase n/a'}`
      + `  ${(s.brief_title || '').slice(0, 68)}`);
    console.log(`                  sponsor: ${s.lead_sponsor_name || '(none)'}`);
  }
  console.log();
}

async function main() {
  await initDB();
  if (!NAME) { await countryList(); return; }
  await profile();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('institution-profile failed:', e && e.message ? e.message : e);
  process.exit(1);
});
