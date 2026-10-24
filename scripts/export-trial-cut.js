#!/usr/bin/env node
// ── THE DELIVERABLE: ONE SLICE OF THE FEED, AS A SPREADSHEET ─────────────────
//
//   railway ssh 'node scripts/export-trial-cut.js --area=Oncology --region=EU --days=90'
//   railway ssh 'node scripts/export-trial-cut.js --area=Oncology --days=90 --out=/tmp/cut.csv'
//   railway ssh 'node scripts/export-trial-cut.js --list-regions'
//
// Read-only. Prints the CSV to stdout unless --out is given, so it can be piped or copied.
//
// ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
//
// Paul Diercksen at Mural Health was promised a real cut: one therapeutic area, one region, the
// last ninety days, to check against deals he already knows the outcome of. That is a far stronger
// pitch than any claim about the data, because he verifies it himself with facts we do not have.
//
// So this exports exactly that, and nothing extra. No contact columns: the registry's published
// contacts are patient-recruitment coordinators, published so patients could ask about enrolling,
// and shipping them to a vendor would be both the wrong desk and the wrong purpose. The product is
// the SIGNAL — who started what, where, and when.
//
// ── WHY SPONSOR IS FOLDED HERE ───────────────────────────────────────────────
//
// The audit found four companies spelled two ways each, "Daiichi Sankyo" and "Daiichi Sankyo Co.,
// Ltd." among them. Four out of 1,661 sounds negligible until you remember that a BD team filters
// by the handful of sponsors it already owns: they type a name they know, get half the rows, and
// conclude the data is unreliable. Folding at export means the defect never reaches the customer,
// and the raw spelling is kept in its own column so nothing is hidden.
'use strict';

const fs = require('fs');
const { initDB, query } = require('../src/lib/db');
const { groupSponsors, canonicalSponsor } = require('../src/lib/trials/sponsor');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};

// Regions as a buyer says them, not as the registry stores them.
const REGIONS = {
  EU: ['Austria', 'Belgium', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia', 'Czech Republic', 'Denmark',
    'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary', 'Ireland', 'Italy', 'Latvia',
    'Lithuania', 'Luxembourg', 'Malta', 'Netherlands', 'Poland', 'Portugal', 'Romania', 'Slovakia',
    'Slovenia', 'Spain', 'Sweden'],
  EUROPE: ['Austria', 'Belgium', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia', 'Czech Republic',
    'Denmark', 'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary', 'Ireland', 'Italy',
    'Latvia', 'Lithuania', 'Luxembourg', 'Malta', 'Netherlands', 'Norway', 'Poland', 'Portugal',
    'Romania', 'Slovakia', 'Slovenia', 'Spain', 'Sweden', 'Switzerland', 'United Kingdom'],
  US: ['United States'],
  NA: ['United States', 'Canada', 'Mexico'],
  UK: ['United Kingdom'],
  APAC: ['Australia', 'China', 'Hong Kong', 'India', 'Indonesia', 'Japan', 'Korea, Republic of',
    'Malaysia', 'New Zealand', 'Philippines', 'Singapore', 'Taiwan', 'Thailand', 'Vietnam'],
};

const AREA = arg('area', '');
const REGION = String(arg('region', '')).toUpperCase();
const DAYS = Math.max(1, Math.min(365, parseInt(arg('days', '90'), 10) || 90));
const OUT = arg('out', '');
const STATUS = arg('status', 'RECRUIT');   // substring of overall_status
// ── WHY ENROLMENT IS A FILTER AND A SORT ────
// Therapeutic area is the obvious axis and it is the wrong one for some buyers. Mural Health sells
// participant payments: their product applies to any trial with people in it, and their revenue
// scales with HOW MANY. For them the useful cut is not "oncology" but "a thousand participants
// about to start being paid". Sorting by date answers "what is new"; sorting by enrolment answers
// "what is worth a call first", which is the question a BD team actually has.
const MIN_ENROL = Math.max(0, parseInt(arg('min-enrolment', '0'), 10) || 0);
const SORT = String(arg('sort', 'changed')).toLowerCase();   // changed | enrolment

const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  if (has('list-regions')) {
    for (const [k, v] of Object.entries(REGIONS)) console.log(`${k.padEnd(8)} ${v.length} countries`);
    process.exit(0);
  }
  // ── KEEP THE DATABASE BANNER OUT OF THE CSV ────
  // initDB announces itself with console.log ("✅ PostgreSQL database ready. 2 admin account(s);
  // super_admin: naren@abiozen.com"). This script writes the CSV to stdout so it can be
  // redirected into a file, so that banner became LINE 1 of a spreadsheet on its way to a
  // customer — a junk row in Excel, and our admin address published to someone outside the
  // company. Nothing errored; the file simply had an extra line nobody looked at.
  //
  // Anything a library prints during startup belongs on stderr when stdout is the product.
  const realLog = console.log;
  console.log = (...a) => console.error(...a);
  try { await initDB(); } finally { console.log = realLog; }

  const countries = REGIONS[REGION] || null;
  if (REGION && !countries) {
    console.error(`unknown region "${REGION}". --list-regions shows the options.`);
    process.exit(1);
  }

  // locations_countries is a TEXT column holding the distinct country list for the study. Matching
  // is a substring test per country rather than an exact compare, because a multi-country trial
  // stores several of them in the one field.
  const rows = (await query(`
    SELECT nct_id, brief_title, lead_sponsor_name, sponsor_type, phase, overall_status,
           enrollment_count, locations_countries, therapeutic_area, conditions,
           start_date, last_update_post_date, classification_confidence
      FROM clinical_studies
     WHERE overall_status ILIKE '%' || $1 || '%'
       AND last_update_post_date >= to_char(NOW() - ($2 || ' days')::interval, 'YYYY-MM-DD')
       AND ($3 = '' OR therapeutic_area ILIKE '%' || $3 || '%')
       AND ($4 = 0 OR enrollment_count >= $4)
     ORDER BY
       CASE WHEN $5 = 'enrolment' THEN enrollment_count END DESC NULLS LAST,
       last_update_post_date DESC, lead_sponsor_name`,
  [STATUS, String(DAYS), AREA, MIN_ENROL, SORT])).rows;

  const inRegion = (s) => {
    if (!countries) return true;
    const t = String(s || '');
    return countries.some((c) => t.includes(c));
  };
  const kept = rows.filter((r) => inRegion(r.locations_countries));

  // Fold across the WHOLE result, so one company reads the same way on every row.
  const lookup = groupSponsors(kept.map((r) => r.lead_sponsor_name));

  const header = ['NCT ID', 'Sponsor', 'Sponsor type', 'Therapeutic area', 'Phase', 'Status',
    'Enrolment target', 'Countries', 'Start date', 'Record last changed', 'Title',
    'Registry link', 'Sponsor as filed'];
  const lines = [header.map(esc).join(',')];
  for (const r of kept) {
    lines.push([
      r.nct_id,
      canonicalSponsor(r.lead_sponsor_name, lookup),
      r.sponsor_type,
      r.therapeutic_area,
      r.phase,
      r.overall_status,
      r.enrollment_count,
      r.locations_countries,
      r.start_date,
      r.last_update_post_date,
      r.brief_title,
      `https://clinicaltrials.gov/study/${r.nct_id}`,
      r.lead_sponsor_name,
    ].map(esc).join(','));
  }
  const csv = lines.join('\n');

  if (OUT) {
    fs.writeFileSync(OUT, csv);
    console.error(`\n   wrote ${OUT}`);
  } else {
    process.stdout.write(`${csv}\n`);
  }

  // The summary goes to stderr so it never contaminates a piped CSV, and gives the numbers to
  // quote in the covering email rather than adjectives.
  const sponsors = new Set(kept.map((r) => canonicalSponsor(r.lead_sponsor_name, lookup)));
  const folded = [...lookup.values()].filter((v) => v.variants.length > 1).length;
  console.error(`\n   ── ${AREA || 'all areas'}${REGION ? ` · ${REGION}` : ''} · last ${DAYS} days`
    + ` · status ~ ${STATUS}${MIN_ENROL ? ` · enrolment ≥ ${MIN_ENROL}` : ''} · sorted by ${SORT}`);
  console.error(`      ${kept.length} trial(s)${countries ? ` (of ${rows.length} before the region filter)` : ''}`);
  console.error(`      ${sponsors.size} distinct sponsor(s)${folded ? `, ${folded} folded from multiple spellings` : ''}`);
  const participants = kept.reduce((a, r) => a + (Number(r.enrollment_count) || 0), 0);
  console.error(`      ${participants.toLocaleString()} participants across the cut`);
  const low = kept.filter((r) => r.classification_confidence != null && r.classification_confidence < 0.7).length;
  if (low) console.error(`      ${low} row(s) classified with confidence below 0.7 — check these before sending`);
  console.error('');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('export-trial-cut failed:', e && e.message ? e.message : e);
  process.exit(1);
});
