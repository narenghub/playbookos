#!/usr/bin/env node
// ── IS THE TRIAL FEED GOOD ENOUGH TO SELL? ───────────────────────────────────
//
//   railway ssh 'node scripts/audit-trial-feed.js'
//   railway ssh 'node scripts/audit-trial-feed.js --area=Oncology --sample=40'
//
// Read-only. Changes nothing, sends nothing.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// "Accurate" is not a value, it is a number. Right now nobody can say how accurate this feed is,
// which means nobody can say whether it is ready to put in front of a VP of business development
// who will check it against deals he already knows the outcome of. He will find the errors we have
// not looked for, and he will find them in the first ten minutes.
//
// The audit is possible offline because every study keeps its raw_json — the registry record as
// it arrived. So the derived columns can be checked against their own source without a network
// call: if overall_status says RECRUITING and the raw record says COMPLETED, that is a parser bug
// we introduced, and it is exactly the kind that reads as fine until a customer looks.
//
// What this does NOT check is whether the registry itself is right. That is not our problem to
// solve and not a claim we should make.
//
// ── WHAT GOOD LOOKS LIKE ─────────────────────────────────────────────────────
//
// Nothing here is a pass/fail gate, because the thresholds depend on what is being sold. The job
// is to put real numbers next to each claim so the decision to send is made on evidence:
//
//   · derived fields disagreeing with raw_json   → should be 0. Anything else is our bug.
//   · studies with no therapeutic area           → they vanish from every area cut.
//   · low-confidence classifications             → the rows a customer disputes first.
//   · sponsors spelled several ways              → breaks every filter by sponsor.
//   · stale ingest                               → "refreshed daily" stops being true.
'use strict';

const { initDB, query } = require('../src/lib/db');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const SAMPLE = Math.max(5, Math.min(300, parseInt(arg('sample', '60'), 10) || 60));
const AREA = arg('area', '');

const say = (s = '') => console.log(s);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

let problems = 0;
const flag = (s) => { problems += 1; say(`   ⚠ ${s}`); };

// Company suffixes and punctuation are what make one sponsor look like four.
function normSponsor(name) {
  return String(name || '').toLowerCase()
    .replace(/[.,]/g, ' ')
    // Legal-entity suffixes across the jurisdictions that actually appear in the registry. Nordic
    // (ab, oy, aps), southern European (spa, sas, sarl) and German (kgaa) were missing, which left
    // "AstraZeneca" and "AstraZeneca AB" looking like two different sponsors.
    .replace(/\b(inc|incorporated|llc|ltd|limited|plc|gmbh|ag|ab|oyj?|aps|a\/s|as|sa|s a|spa|sas|sarl|kgaa|pty|nv|n v|bv|b v|co|corp|corporation|company|holdings?|group|pharmaceuticals?|pharma|therapeutics|biosciences?|laboratories|labs?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

async function section(title, fn) {
  say(`\n   ── ${title}`);
  try { await fn(); } catch (e) {
    // Reported, never swallowed: a section that cannot run is a question left unanswered, which is
    // the state this whole script exists to remove.
    flag(`could not run: ${e && e.message ? e.message : e}`);
  }
}

async function main() {
  await initDB();
  say(`\n── trial feed audit  (read-only)${AREA ? `  · area filter: ${AREA}` : ''}\n`);

  const tot = (await query(`SELECT COUNT(*)::int n FROM clinical_studies`)).rows[0].n;
  say(`   ${tot} studies`);
  if (!tot) { say('\n   nothing to audit.\n'); process.exit(1); }

  // ── 1. DERIVED vs RAW ────
  await section('derived columns against the raw registry record', async () => {
    const rows = (await query(
      `SELECT nct_id, overall_status, phase, enrollment_count, lead_sponsor_name, raw_json
         FROM clinical_studies
        WHERE raw_json IS NOT NULL AND raw_json <> ''
        ORDER BY random() LIMIT $1`, [SAMPLE])).rows;
    if (!rows.length) { flag('no raw_json stored — derived fields cannot be verified at all'); return; }

    let checked = 0; const bad = [];
    for (const r of rows) {
      let j; try { j = JSON.parse(r.raw_json); } catch (_) { bad.push(`${r.nct_id}: raw_json unparseable`); continue; }
      const ps = j.protocolSection || j.protocol_section || {};
      const status = (ps.statusModule || {}).overallStatus;
      const enroll = (((ps.designModule || {}).enrollmentInfo) || {}).count;
      const sponsor = (((ps.sponsorCollaboratorsModule || {}).leadSponsor) || {}).name;
      if (!status && enroll == null && !sponsor) continue;   // shape we cannot read; not a mismatch
      checked += 1;
      if (status && r.overall_status && String(status).toUpperCase() !== String(r.overall_status).toUpperCase()) {
        bad.push(`${r.nct_id}: status "${r.overall_status}" but registry says "${status}"`);
      }
      if (enroll != null && r.enrollment_count != null && Number(enroll) !== Number(r.enrollment_count)) {
        bad.push(`${r.nct_id}: enrolment ${r.enrollment_count} but registry says ${enroll}`);
      }
      if (sponsor && r.lead_sponsor_name && normSponsor(sponsor) !== normSponsor(r.lead_sponsor_name)) {
        bad.push(`${r.nct_id}: sponsor "${r.lead_sponsor_name}" vs registry "${sponsor}"`);
      }
    }
    say(`      ${checked} of ${rows.length} sampled rows were readable`);
    if (!checked) { flag('raw_json present but none readable — the stored shape has changed'); return; }
    if (bad.length) {
      flag(`${bad.length} mismatch(es) between our columns and the stored record:`);
      for (const b of bad.slice(0, 12)) say(`        ${b}`);
      say('      These are OUR bugs, not registry errors. Fix before anyone sees a cut.');
    } else {
      say('      ✓ no disagreement — the derived columns match what arrived.');
    }
  });

  // ── 2. CLASSIFICATION ────
  await section('therapeutic area — the field every cut filters on', async () => {
    const c = (await query(`
      SELECT COUNT(*) FILTER (WHERE therapeutic_area IS NULL OR therapeutic_area = '')::int unclassified,
             COUNT(*) FILTER (WHERE classification_confidence IS NOT NULL
                                AND classification_confidence < 0.7)::int lowconf,
             COUNT(DISTINCT therapeutic_area)::int areas,
             COUNT(DISTINCT classify_prompt_version)::int versions
        FROM clinical_studies`)).rows[0];
    say(`      ${c.areas} distinct areas · ${c.versions} classifier version(s) in the table`);
    say(`      unclassified      ${pad(c.unclassified, 6)} ${pct(c.unclassified, tot)}  (invisible in every area cut)`);
    say(`      confidence < 0.7  ${pad(c.lowconf, 6)} ${pct(c.lowconf, tot)}  (disputed first by a customer)`);
    if (c.unclassified) flag(`${c.unclassified} studies carry no therapeutic area`);
    if (c.versions > 1) {
      flag(`${c.versions} classifier versions present — rows are not comparable to each other`);
    }

    const top = (await query(`
      SELECT COALESCE(NULLIF(therapeutic_area, ''), '(none)') area, COUNT(*)::int n
        FROM clinical_studies GROUP BY 1 ORDER BY n DESC LIMIT 12`)).rows;
    say('');
    for (const r of top) say(`      ${pad(r.n, 6)} ${r.area}`);
  });

  // ── 3. SPONSOR SPELLINGS ────
  await section('sponsor names — one company, or several spellings?', async () => {
    const rows = (await query(
      `SELECT DISTINCT lead_sponsor_name s FROM clinical_studies
        WHERE lead_sponsor_name IS NOT NULL AND lead_sponsor_name <> ''`)).rows;
    const byNorm = new Map();
    for (const r of rows) {
      const k = normSponsor(r.s);
      if (!k) continue;
      if (!byNorm.has(k)) byNorm.set(k, []);
      byNorm.get(k).push(r.s);
    }
    const dupes = [...byNorm.entries()].filter(([, v]) => v.length > 1)
      .sort((a, b) => b[1].length - a[1].length);
    say(`      ${rows.length} distinct sponsor strings → ${byNorm.size} companies after folding`);
    if (dupes.length) {
      flag(`${dupes.length} companies appear under more than one spelling. Filtering by sponsor`);
      say('        silently misses rows. The worst offenders:');
      for (const [, v] of dupes.slice(0, 8)) say(`        ${v.join('  |  ')}`);
    } else {
      say('      ✓ no company appears under two spellings.');
    }
  });

  // ── 4. FRESHNESS ────
  await section('freshness — is "refreshed daily" still true?', async () => {
    const f = (await query(`
      SELECT MAX(ingested_at) last_ingest,
             COUNT(*) FILTER (WHERE last_update_post_date >= to_char(NOW() - INTERVAL '7 days','YYYY-MM-DD'))::int moved7,
             COUNT(*) FILTER (WHERE last_update_post_date >= to_char(NOW() - INTERVAL '30 days','YYYY-MM-DD'))::int moved30
        FROM clinical_studies`)).rows[0];
    say(`      last ingest            ${String(f.last_ingest || '(never)').slice(0, 19)}`);
    say(`      changed in last 7d     ${pad(f.moved7, 6)} ← this is the weekly product`);
    say(`      changed in last 30d    ${f.moved30}`);
    if (!f.moved7) {
      flag('NOTHING changed in the last 7 days. Either the ingest has stopped or the date');
      say('        field is not what we think it is — both make a weekly feed impossible.');
    }
  });

  // ── 5. THE CUT ITSELF ────
  await section('the product: newly recruiting, by area', async () => {
    const rows = (await query(`
      SELECT COALESCE(NULLIF(therapeutic_area, ''), '(none)') area, COUNT(*)::int n
        FROM clinical_studies
       WHERE overall_status ILIKE '%RECRUIT%'
         AND last_update_post_date >= to_char(NOW() - INTERVAL '30 days', 'YYYY-MM-DD')
         AND ($1 = '' OR therapeutic_area ILIKE '%' || $1 || '%')
       GROUP BY 1 ORDER BY n DESC LIMIT 15`, [AREA])).rows;
    const n = rows.reduce((a, r) => a + r.n, 0);
    say(`      ${n} trial(s) recruiting AND changed in the last 30 days`);
    for (const r of rows) say(`      ${pad(r.n, 6)} ${r.area}`);
    if (!n) flag('the headline cut is EMPTY — there is no weekly product to send yet');
    else if (n < 10) flag(`only ${n} rows. A monthly sample that thin will not impress anyone.`);
  });

  say('\n   ── VERDICT');
  if (problems) {
    say(`      ${problems} issue(s) above. Each one is something a customer could find`);
    say('      in their first ten minutes, so fix or disclose before sending a sample.\n');
    process.exit(1);
  }
  say('      No issues found by these checks. That is not the same as "correct" — it means');
  say('      the five things most likely to embarrass us are clean.\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('audit-trial-feed failed:', e && e.stack ? e.stack : e);
  process.exit(1);
});
