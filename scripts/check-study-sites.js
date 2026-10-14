#!/usr/bin/env node
// ── HOW MUCH BIGGER DOES THE PICTURE GET IF WE PARSE THE SITES? ───────────────
//
//   railway ssh 'node scripts/check-study-sites.js --name=Oxford'
//   railway ssh 'node scripts/check-study-sites.js --country=United Kingdom --top=25'
//
// Read-only. Parses what is already stored; fetches nothing and writes nothing.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
//
// institution-profile.js reported 4 studies for Oxford. Naren expected 150, and he is right: the
// University of Oxford runs hundreds of trials. The query is not wrong — it matches on the lead
// PI's affiliation, the lead sponsor and the collaborator list, which is every field the database
// actually has. The problem is that none of those fields is where a site appears.
//
// When Oxford is one of forty hospitals recruiting for an AstraZeneca phase 3, Oxford is a
// LOCATION. We store locations_countries — "United Kingdom" — and throw the facility names away.
// So the trial is in the database, Oxford is in the trial, and the two cannot be joined.
//
// The facilities are not lost: they are in clinical_studies.raw_json, under
// protocolSection.contactsLocationsModule.locations, each with a facility name, city, state,
// country and recruiting status. Nothing needs re-fetching from ClinicalTrials.gov.
//
// This measures the gap before anybody builds a table for it: how many studies carry parseable
// facilities, and how many name the institution being searched for. The ratio between that number
// and what institution-profile.js reports today IS the value of doing the work.
'use strict';

const { initDB, query } = require('../src/lib/db');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const NAME = arg('name', null);
const COUNTRY = arg('country', null);
const TOP = Math.max(1, Math.min(60, parseInt(arg('top', '15'), 10) || 15));
const SAMPLE = Math.max(1, Math.min(5000, parseInt(arg('sample', '3500'), 10) || 3500));

function locationsOf(raw) {
  let j;
  try { j = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return null; }
  if (!j) return null;
  const ps = j.protocolSection || j;
  const m = ps.contactsLocationsModule || ps.contacts_locations_module || {};
  return (m.locations || []).map((l) => ({
    facility: l.facility || l.name || null,
    city: l.city || null,
    state: l.state || null,
    country: l.country || null,
    status: l.status || null,
  }));
}

async function main() {
  await initDB();

  const rows = (await query(
    `SELECT nct_id, lead_sponsor_name, therapeutic_area, phase, overall_status, raw_json
       FROM clinical_studies WHERE raw_json IS NOT NULL
      ORDER BY last_update_post_date DESC NULLS LAST LIMIT $1`, [SAMPLE])).rows;

  let parsed = 0, withSites = 0, totalSites = 0;
  const facilities = new Map();
  const countries = new Map();
  const matches = [];

  for (const r of rows) {
    const locs = locationsOf(r.raw_json);
    if (!locs) continue;
    parsed += 1;
    if (locs.length) withSites += 1;
    totalSites += locs.length;
    let hit = false;
    for (const l of locs) {
      if (l.facility) facilities.set(l.facility, (facilities.get(l.facility) || 0) + 1);
      if (l.country) countries.set(l.country, (countries.get(l.country) || 0) + 1);
      if (NAME && l.facility && l.facility.toLowerCase().includes(NAME.toLowerCase())) hit = true;
      if (COUNTRY && l.country && l.country.toLowerCase().includes(COUNTRY.toLowerCase())) hit = true;
    }
    if (hit) matches.push({ ...r, sites: locs.filter((l) => (NAME
      ? (l.facility || '').toLowerCase().includes(NAME.toLowerCase())
      : (l.country || '').toLowerCase().includes((COUNTRY || '').toLowerCase()))) });
  }

  console.log(`\n── trial SITES held in raw_json · newest ${rows.length} studies\n`);
  console.log(`   parsed                     ${parsed}`);
  console.log(`   carrying site facilities   ${withSites}`
    + `  (${parsed ? Math.round((withSites / parsed) * 1000) / 10 : 0}%)`);
  console.log(`   site rows in total         ${totalSites}`);
  console.log(`   distinct facility names    ${facilities.size}`);
  console.log(`   distinct countries         ${countries.size}\n`);
  console.log(`   Those ${totalSites} site rows are the join that does not exist yet. Today only`);
  console.log(`   locations_countries is stored, so a trial's facilities cannot be searched.\n`);

  if (NAME || COUNTRY) {
    const label = NAME ? `facility matching "${NAME}"` : `a site in "${COUNTRY}"`;
    console.log(`── studies with ${label}: ${matches.length}\n`);
    for (const m of matches.slice(0, TOP)) {
      console.log(`   ${m.nct_id}  ${m.phase || 'phase n/a'}  ${m.overall_status || ''}`);
      console.log(`      ${m.therapeutic_area || 'unclassified'} · sponsor ${m.lead_sponsor_name || '(none)'}`);
      for (const s of m.sites.slice(0, 3)) {
        console.log(`      site: ${s.facility || '(unnamed)'}`
          + `${s.city ? ` — ${s.city}` : ''}${s.country ? `, ${s.country}` : ''}`
          + `${s.status ? ` [${s.status}]` : ''}`);
      }
      console.log();
    }
    if (matches.length > TOP) console.log(`   … and ${matches.length - TOP} more\n`);
    if (NAME) {
      console.log(`   institution-profile.js finds studies where "${NAME}" is the PI's affiliation,`);
      console.log(`   the lead sponsor or a collaborator. This finds it as a RECRUITING SITE.`);
      console.log(`   The difference between the two numbers is what parsing sites would add.\n`);
    }
  }

  const topFac = [...facilities.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP);
  if (topFac.length) {
    console.log(`── busiest facilities in the sample\n`);
    for (const [f, n] of topFac) console.log(`   ${String(n).padStart(4)}  ${f}`);
    console.log();
    console.log(`   ⚠ The same hospital appears under several spellings — this is the entity problem`);
    console.log(`     institution-profile.js already showed with ten Oxford rows. Any site table`);
    console.log(`     needs normalisation at write time, or the counts fragment the same way.\n`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('check-study-sites failed:', e && e.message ? e.message : e);
  process.exit(1);
});
