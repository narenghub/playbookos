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
// ── RESUMABLE AND TIME-BOXED, BECAUSE THE TUNNEL DIES ────
// The first live run printed its header and was killed by "Connection to ssh.railway.com closed by
// remote host — broken pipe". `railway ssh` tears down the exec session and kills the process
// group, and nohup does not survive that (tried; the log file was never even created). A job that
// writes 86,000 rows therefore cannot live on the end of that tunnel.
//
// So each invocation does a slice and returns: studies already parsed are skipped, and the run
// stops cleanly after --max-seconds and reports how many remain. Run it until it says 0.
const FORCE = process.argv.includes('--force');
const SINCE = arg('since', null);
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const BATCH = Math.max(50, Math.min(1000, parseInt(arg('batch', '250'), 10) || 250));
const MAX_SECONDS = Math.max(10, Math.min(600, parseInt(arg('max-seconds', '60'), 10) || 60));
// Studies between progress lines. Small on purpose: this is a keep-alive as much as a report.
const PROGRESS_EVERY = Math.max(1, Math.min(200, parseInt(arg('progress-every', '20'), 10) || 20));

async function main() {
  await initDB();

  const params = [];
  let where = 'raw_json IS NOT NULL';
  if (SINCE) { params.push(SINCE); where += ` AND last_update_post_date >= $${params.length}`; }
  // Already-parsed studies are skipped so the job can be resumed after the pipe drops. --force
  // re-parses everything, which is what to use after a change to the parsing rules.
  if (!FORCE) where += ` AND NOT EXISTS (SELECT 1 FROM study_sites ss WHERE ss.nct_id = clinical_studies.nct_id)`;

  const total = (await query(`SELECT COUNT(*)::int n FROM clinical_studies WHERE ${where}`, params)).rows[0].n;
  const already = (await query(`SELECT COUNT(DISTINCT nct_id)::int n FROM study_sites`)).rows[0].n;
  console.log(`── backfill study_sites · ${EXECUTE ? 'WRITING' : 'dry run'}`
    + `${FORCE ? ' · FORCE (re-parsing everything)' : ''}\n`);
  if (already && !FORCE) console.log(`   ${already} study record(s) already parsed — skipping those`);
  console.log(`   ${total} still to read${SINCE ? ` (updated since ${SINCE})` : ''}`);
  console.log(`   stopping after ${MAX_SECONDS}s so the ssh tunnel cannot kill it mid-write\n`);
  if (!total) { console.log('   nothing left to do.\n'); return; }
  const started = Date.now();
  const deadline = started + MAX_SECONDS * 1000;

  let read = 0, sites = 0, anon = 0, named = 0, written = 0, studiesWithNone = 0;
  const facilities = new Set();
  const countries = new Set();
  // Paged by nct_id, NOT by OFFSET: the NOT EXISTS clause means the result set shrinks as rows are
  // written, so an OFFSET would skip studies it had never read. A keyset page cannot.
  let after = '';

  for (;;) {
    const page = (await query(
      `SELECT nct_id, raw_json FROM clinical_studies WHERE ${where} AND nct_id > $${params.length + 1}
        ORDER BY nct_id LIMIT ${BATCH}`, [...params, after])).rows;
    if (!page.length) break;
    after = page[page.length - 1].nct_id;

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
      // ONE multi-row insert per study rather than one statement per site. A trial with 300 sites
      // was 300 round trips, and 86,000 of those is the difference between minutes and an hour.
      const vals = [];
      const ph = [];
      rows.forEach((r, i) => {
        const b = i * 9;
        ph.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
        vals.push(s.nct_id, r.facility, r.facility_normalized, r.anonymised,
          r.city, r.state, r.country, r.zip, r.status);
      });
      await withTransaction(async (client) => {
        await client.query(`DELETE FROM study_sites WHERE nct_id = $1`, [s.nct_id]);
        await client.query(
          `INSERT INTO study_sites
             (nct_id, facility, facility_normalized, anonymised, city, state, country, zip, status)
           VALUES ${ph.join(',')} ON CONFLICT DO NOTHING`, vals);
      });
      written += 1;

      // ── KEEP TALKING, OR THE TUNNEL HANGS UP ────
      // A --max-seconds=550 run was killed before it printed anything at all, while the 60-second
      // runs had been fine. The difference is not the duration, it is the SILENCE: progress was
      // printed once per 250-study page, roughly once a minute, and `railway ssh` closes a session
      // that produces no output for less than that. So the heartbeat is per-study-count, not
      // per-page, and a long run stays visibly alive.
      if (read % PROGRESS_EVERY === 0) {
        const secs = Math.round((Date.now() - started) / 1000);
        console.log(`   …${read}/${total}  ${sites} site rows  ${secs}s`);
      }
    }

    if (LIMIT && read >= LIMIT) break;
    if (Date.now() > deadline) { console.log(`\n   time budget reached — stopping cleanly.`); break; }
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
  const left = (await query(`SELECT COUNT(*)::int n FROM clinical_studies WHERE ${where}`, params)).rows[0].n;
  if (left) {
    console.log(`\n   ${left} study record(s) still to parse. Run the same command again —`);
    console.log(`   it skips what is done, so repeat until this says 0.\n`);
  } else {
    console.log(`\n   ✅ nothing left to parse.`);
    console.log(`   Then:  node scripts/institution-profile.js --name=Oxford\n`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('backfill-study-sites failed:', e && e.message ? e.message : e);
  process.exit(1);
});
