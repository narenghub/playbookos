#!/usr/bin/env node
// ── PARSE THE SITES OUT OF raw_json INTO study_sites ──────────────────────────
//
//   railway ssh 'node scripts/backfill-study-sites.js'              → what it would write
//   railway ssh 'node scripts/backfill-study-sites.js --execute'
//   railway ssh 'node scripts/backfill-study-sites.js --execute --since=2026-09-01'
//
// Reads only clinical_studies.raw_json, already stored. Fetches nothing from ClinicalTrials.gov.
//
// ── RE-RUNNABLE BY REPLACEMENT, PER STUDY ────────────────────────────────────
//
// A study's site list changes between amendments: a hospital is added, another stops recruiting.
// So a study's rows are DELETED and re-inserted as one unit, inside a transaction, which makes the
// backfill idempotent and keeps a half-written study from ever being visible.
//
// Deleting by nct_id is deleting only rows this script created for that study, which is what
// CLAUDE.md requires: scoped to the thing being rewritten, never "recent" or "matching a pattern".
'use strict';

const { initDB, query, withTransaction } = require('../src/lib/db');
const { sitesOf } = require('../src/lib/agents/research-intelligence/sites');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EXECUTE = process.argv.includes('--execute');
const SINCE = arg('since', null);
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const BATCH = Math.max(50, Math.min(1000, parseInt(arg('batch', '250'), 10) || 250));

async function main() {
  await initDB();

  const params = [];
  let where = 'raw_json IS NOT NULL';
  if (SINCE) { params.push(SINCE); where += ` AND last_update_post_date >= $${params.length}`; }

  const total = (await query(`SELECT COUNT(*)::int n FROM clinical_studies WHERE ${where}`, params)).rows[0].n;
  console.log(`── backfill study_sites · ${EXECUTE ? 'WRITING' : 'dry run'}\n`);
  console.log(`   ${total} study record(s) to read${SINCE ? ` (updated since ${SINCE})` : ''}\n`);

  let read = 0, sites = 0, anon = 0, named = 0, written = 0, studiesWithNone = 0;
  const facilities = new Set();
  const countries = new Set();
  let offset = 0;

  for (;;) {
    const page = (await query(
      `SELECT nct_id, raw_json FROM clinical_studies WHERE ${where}
        ORDER BY nct_id LIMIT ${BATCH} OFFSET ${offset}`, params)).rows;
    if (!page.length) break;
    offset += page.length;

    for (const s of page) {
      read += 1;
      const rows = sitesOf(s.raw_json);
      if (!rows.length) { studiesWithNone += 1; continue; }
      sites += rows.length;
      for (const r of rows) {
        if (r.anonymised) anon += 1; else named += 1;
        if (r.facility_normalized && !r.anonymised) facilities.add(r.facility_normalized);
        if (r.country) countries.add(r.country);
      }

      if (!EXECUTE) continue;

      // Replace this study's sites as one unit: a half-written study is never visible, and a
      // re-run cannot duplicate. Scoped to this nct_id and nothing else.
      await withTransaction(async (client) => {
        await client.query(`DELETE FROM study_sites WHERE nct_id = $1`, [s.nct_id]);
        for (const r of rows) {
          await client.query(
            `INSERT INTO study_sites
               (nct_id, facility, facility_normalized, anonymised, city, state, country, zip, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT DO NOTHING`,
            [s.nct_id, r.facility, r.facility_normalized, r.anonymised,
             r.city, r.state, r.country, r.zip, r.status]);
        }
      });
      written += 1;
    }

    if (read % 1000 < BATCH) console.log(`   …${read}/${total}`);
    if (LIMIT && read >= LIMIT) break;
  }

  console.log(`\n   read                ${read} studies`);
  console.log(`   studies with no site ${studiesWithNone}`);
  console.log(`   site rows            ${sites}`);
  console.log(`      named institution ${named}`);
  console.log(`      anonymised        ${anon}  (sponsor placeholders, kept but excluded from`);
  console.log(`                        institution counts)`);
  console.log(`   distinct institutions ${facilities.size}  (after normalisation)`);
  console.log(`   distinct countries    ${countries.size}`);

  if (!EXECUTE) {
    console.log(`\n   DRY RUN — nothing written. Re-run with --execute.\n`);
    return;
  }

  const inDb = (await query(`SELECT COUNT(*)::int n FROM study_sites`)).rows[0].n;
  const inDbNamed = (await query(`SELECT COUNT(*)::int n FROM study_sites WHERE anonymised = FALSE`)).rows[0].n;
  const distinct = (await query(
    `SELECT COUNT(DISTINCT facility_normalized)::int n FROM study_sites WHERE anonymised = FALSE`)).rows[0].n;
  console.log(`\n   ✅ ${written} studies written · ${inDb} rows in study_sites`);
  console.log(`      ${inDbNamed} named · ${distinct} distinct institutions after normalisation`);
  if (inDb < sites) {
    console.log(`   ⚠ ${sites - inDb} fewer rows than parsed — duplicates collapsed by the unique index,`);
    console.log(`     which is expected where a trial lists the same hospital twice.`);
  }
  console.log(`\n   Then:  node scripts/institution-profile.js --name=Oxford\n`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('backfill-study-sites failed:', e && e.message ? e.message : e);
  process.exit(1);
});
