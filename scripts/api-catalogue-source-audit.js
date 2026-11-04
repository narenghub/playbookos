#!/usr/bin/env node
// ── WHAT WOULD ACTUALLY BE PUBLISHED, IF ~2,900 MOLECULES WERE LISTED ────────
//
//   railway ssh 'node scripts/api-catalogue-source-audit.js'
//   railway ssh 'node scripts/api-catalogue-source-audit.js --report=json'
//
// READ-ONLY. No INSERT, UPDATE, DELETE, CREATE or ALTER. Nothing is imported, published or
// altered; no provider is invoked and no email is sent.
//
// ── THE QUESTION BEHIND IT ──────────────────────────────────────────────────
//
// A proposal to display "approximately 2,900 API molecules as inquiry only" needs to establish
// what the ~2,900 ARE before anything is mapped. There is no XML catalogue in this project — none
// tracked in git, none in the repository, none uploaded — so the number has to come from a
// database table, and which table it comes from changes what publishing them would mean.
//
// The closest match is `study_molecules`: 2,996 distinct names across 5,504 rows. That table is
// not a product catalogue. Its own columns say what it is:
//
//     inference_rationale · inference_confidence · infer_prompt_version
//     molecule_type ∈ api | reference_standard | metabolite | impurity | intermediate
//                     | tool_compound | other
//     catalog_match_status ∈ catalog_match | sourcing_opportunity | unknown
//
// These are molecules INFERRED BY A MODEL from clinical trial records — demand signals, with a
// confidence score and a prompt version attached. A large share are metabolites, impurities and
// tool compounds, which are not sellable APIs under any display rule. Publishing the table as a
// catalogue would publish a demand list as a product range.
//
// So this reports each candidate source separately, with the breakdown that decides eligibility,
// and it cross-checks every candidate against the company's OWN do-not-list.
//
// ── IT PROPOSES NOTHING ─────────────────────────────────────────────────────
//
// No record is marked ready, eligible or listable. The policy cross-check reports matches against
// a transcribed human-authored document; it does not decide anything, and a non-match is not
// clearance — the policy covers 26 named products, not 2,900.
'use strict';

const { payloadMode } = require('./lib/clean-stdout');
const REPORT = ((process.argv.find((a) => a.startsWith('--report=')) || '').split('=')[1] || '').toLowerCase();
const REPORTING = REPORT === 'json';
const out = REPORTING ? payloadMode() : null;

const fs = require('fs');
const path = require('path');
const { initDB, query } = require('../src/lib/db');
const { validCas } = require('../src/lib/catalogue/cas');

if (REPORT && !REPORTING) {
  console.error(`--report=${REPORT} is not a format. Use --report=json.`);
  process.exit(2);
}

const say = (s = '') => (REPORTING ? null : console.log(s));
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const has = async (t) => Boolean((await query(
  `SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [t])).rows[0]);

(async () => {
  await initDB();
  say('\n══ CANDIDATE SOURCES FOR AN API CATALOGUE · READ-ONLY, NOTHING PROPOSED ══\n');

  // ── 1. EVERY TABLE THAT COULD HOLD ~2,900 MOLECULES ──────────────────────
  const sources = [];
  const addSource = async (table, nameCol, casCol, extra = {}) => {
    if (!await has(table)) { sources.push({ table, present: false }); return; }
    const r = (await query(
      `SELECT COUNT(*)::int rows,
              COUNT(DISTINCT LOWER(${nameCol}))::int distinct_names,
              COUNT(${casCol})::int with_cas
         FROM ${table}`)).rows[0];
    const casVals = (await query(
      `SELECT DISTINCT ${casCol} c FROM ${table} WHERE ${casCol} IS NOT NULL`)).rows.map((x) => x.c);
    const valid = casVals.filter(validCas);
    sources.push({
      table, present: true, ...r,
      distinct_cas: casVals.length,
      distinct_cas_checksum_valid: valid.length,
      distinct_cas_checksum_invalid: casVals.length - valid.length,
      ...extra,
    });
  };

  await addSource('study_molecules', 'molecule_name', 'cas_number',
    { what: 'molecules INFERRED BY A MODEL from clinical trial records — demand signals' });
  await addSource('supplier_products', 'product_name', 'cas',
    { what: 'what CPHI suppliers actually sent, pending human review' });
  await addSource('molecules', 'preferred_name', 'cas',
    { what: 'the canonical identity spine' });
  await addSource('skus', 'name', 'cas_number',
    { what: 'the commercial catalogue — what is actually for sale' });
  await addSource('molecule_pricing', 'molecule_name', 'cas_number',
    { what: 'priced molecules' });

  for (const s of sources) {
    if (!s.present) { say(`   ${s.table.padEnd(20)} TABLE NOT PRESENT`); continue; }
    say(`── ${s.table}`);
    say(`     ${s.what}`);
    say(`     rows ${String(s.rows).padStart(6)}   distinct names ${String(s.distinct_names).padStart(6)}`
      + `   with a CAS ${String(s.with_cas).padStart(6)} (${pct(s.with_cas, s.rows)})`);
    say(`     distinct CAS ${String(s.distinct_cas).padStart(5)}`
      + `   checksum-valid ${String(s.distinct_cas_checksum_valid).padStart(5)}`
      + `   INVALID ${String(s.distinct_cas_checksum_invalid).padStart(5)}`);
    say('');
  }

  // ── 2. THE BREAKDOWN THAT DECIDES ELIGIBILITY ────────────────────────────
  //
  // `molecule_type` is the difference between a saleable API and a metabolite nobody can buy. A
  // headline count of 2,900 that does not separate these is not a catalogue size.
  let byType = [];
  let byMatch = [];
  let confidence = null;
  if (await has('study_molecules')) {
    byType = (await query(
      `SELECT COALESCE(molecule_type,'(null)') t, COUNT(*)::int n,
              COUNT(DISTINCT LOWER(molecule_name))::int names
         FROM study_molecules GROUP BY 1 ORDER BY n DESC`)).rows;
    byMatch = (await query(
      `SELECT COALESCE(catalog_match_status,'(null)') s, COUNT(*)::int n
         FROM study_molecules GROUP BY 1 ORDER BY n DESC`)).rows;
    confidence = (await query(
      `SELECT MIN(inference_confidence) lo, AVG(inference_confidence) avg,
              MAX(inference_confidence) hi,
              COUNT(*) FILTER (WHERE inference_confidence IS NULL)::int no_score
         FROM study_molecules`)).rows[0];

    say('── study_molecules by molecule_type — the eligibility breakdown\n');
    for (const r of byType) {
      say(`     ${r.t.padEnd(20)} ${String(r.n).padStart(6)} rows   ${String(r.names).padStart(6)} distinct names`);
    }
    const api = byType.find((r) => r.t === 'api');
    say(`\n     Only molecule_type='api' is a candidate for an API listing: `
      + `${api ? `${api.names} distinct names` : 'none'}`);
    say('     Metabolites, impurities, reference standards and tool compounds are not APIs.\n');
    say('── catalog_match_status\n');
    for (const r of byMatch) say(`     ${r.s.padEnd(22)} ${String(r.n).padStart(6)}`);
    say(`\n     inference_confidence  min ${confidence.lo} · avg ${Number(confidence.avg).toFixed(3)}`
      + ` · max ${confidence.hi} · with NO score ${confidence.no_score}`);
    say('     Every row carries a model confidence and a prompt version. These are inferences.\n');
  }

  // ── 3. THREE REPRESENTATIVE RECORDS PER SOURCE ───────────────────────────
  //
  // Commercial terms are omitted: no price, cost, margin or supplier pricing appears below. The
  // point is the SHAPE of a record and the quality of its identity, not its economics.
  const samples = {};
  const sample = async (table, sql) => {
    if (!await has(table)) return;
    samples[table] = (await query(sql)).rows;
    say(`── three representative ${table} records (commercial terms omitted)\n`);
    for (const r of samples[table]) {
      say(`     ${JSON.stringify(r, null, 2).split('\n').join('\n     ')}`);
      say('');
    }
  };
  await sample('study_molecules',
    `SELECT molecule_name, cas_number, molecule_type, catalog_match_status,
            inference_confidence, LEFT(COALESCE(inference_rationale,''), 160) AS inference_rationale_excerpt,
            infer_prompt_version, nct_id
       FROM study_molecules ORDER BY molecule_name LIMIT 3`);
  await sample('supplier_products',
    `SELECT product_name, cas, grade, markers, confidence, name_source, use_class,
            listing_notice, review_status, source_file
       FROM supplier_products ORDER BY product_name LIMIT 3`);

  // ── 4. DUPLICATES AND IDENTITY COLLISIONS ────────────────────────────────
  let dupes = {};
  if (await has('study_molecules')) {
    const nameDupes = (await query(
      `SELECT LOWER(molecule_name) n, COUNT(*)::int c, COUNT(DISTINCT cas_number)::int cas_variants
         FROM study_molecules GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY c DESC LIMIT 10`)).rows;
    const casManyNames = (await query(
      `SELECT cas_number, COUNT(DISTINCT LOWER(molecule_name))::int names
         FROM study_molecules WHERE cas_number IS NOT NULL
        GROUP BY 1 HAVING COUNT(DISTINCT LOWER(molecule_name)) > 1
        ORDER BY names DESC LIMIT 10`)).rows;
    const nameManyCas = (await query(
      `SELECT LOWER(molecule_name) n, COUNT(DISTINCT cas_number)::int cas
         FROM study_molecules WHERE cas_number IS NOT NULL
        GROUP BY 1 HAVING COUNT(DISTINCT cas_number) > 1 ORDER BY cas DESC LIMIT 10`)).rows;
    dupes = { top_repeated_names: nameDupes, one_cas_many_names: casManyNames, one_name_many_cas: nameManyCas };

    say('── identity collisions in study_molecules\n');
    say(`     one CAS carrying MORE THAN ONE name: ${casManyNames.length} shown (top by name count)`);
    for (const r of casManyNames) say(`        ${r.cas_number.padEnd(16)} ${r.names} different names`);
    say(`\n     one name carrying MORE THAN ONE CAS: ${nameManyCas.length} shown`);
    for (const r of nameManyCas) say(`        ${r.n.slice(0, 40).padEnd(42)} ${r.cas} different CAS`);
    say('\n     Either direction makes a listing ambiguous: the first sells one name under a');
    say('     number that belongs to several substances, the second cannot say which it is.\n');
  }

  // ── 5. THE COMPANY'S OWN DO-NOT-LIST, CROSS-CHECKED ──────────────────────
  //
  // Transcribed from the procurement team's workbook. It is NOT a clearance list: it names 26
  // products, so a non-match means "not on this list", never "eligible".
  let policy = null;
  let policyHits = [];
  const policyPath = path.join(__dirname, '..', 'data', 'marketplace-display-policy.json');
  try { policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')); } catch (e) {
    say(`── policy cross-check SKIPPED: ${(e && e.message) || e}\n`);
  }
  if (policy) {
    const byName = new Map(policy.do_not_list.map((p) => [norm(p.product), p]));
    const byCas = new Map();
    for (const p of policy.do_not_list) {
      const m = String(p.detail || '').match(/\d{2,7}-\d{2}-\d/);
      if (m) byCas.set(m[0], p);
    }
    const checks = [
      ['skus', 'name', 'cas_number'],
      ['study_molecules', 'molecule_name', 'cas_number'],
      ['supplier_products', 'product_name', 'cas'],
    ];
    for (const [table, nameCol, casCol] of checks) {
      if (!await has(table)) continue;
      const rows = (await query(
        `SELECT DISTINCT ${nameCol} AS nm, ${casCol} AS cas FROM ${table}`)).rows;
      for (const r of rows) {
        const byCasHit = r.cas ? byCas.get(String(r.cas).trim()) : null;
        const byNameHit = byName.get(norm(r.nm)) || [...byName.entries()]
          .find(([k]) => k && norm(r.nm).startsWith(k))?.[1] || null;
        if (byCasHit || byNameHit) {
          policyHits.push({
            table, record_name: r.nm, record_cas: r.cas || null,
            matched_by: byCasHit ? 'CAS — an exact identifier match' : 'name',
            policy_product: (byCasHit || byNameHit).product,
            reason_code: (byCasHit || byNameHit).reason_code,
            detail: (byCasHit || byNameHit).detail,
          });
        }
      }
    }
    say('── CROSS-CHECK AGAINST THE COMPANY\'S OWN DO-NOT-LIST\n');
    say(`     policy source: ${policy._provenance.source_document} · sheet ${policy._provenance.source_sheet}`);
    say(`     "${policy._provenance.verbatim_header}"`);
    say(`     ${policy.do_not_list.length} named products on the list\n`);
    const onSale = policyHits.filter((h) => h.table === 'skus');
    if (onSale.length) {
      say(`     ⚠ ${onSale.length} LIVE SKU(s) MATCH A DO-NOT-LIST ENTRY:\n`);
      for (const h of onSale) {
        say(`        ${h.record_name}  [${h.record_cas || 'no CAS'}]`);
        say(`           matched by ${h.matched_by} → policy entry "${h.policy_product}"`);
        say(`           ${h.reason_code}: ${h.detail}`);
        say('');
      }
    } else say('     no live SKU matches a do-not-list entry\n');
    const other = policyHits.filter((h) => h.table !== 'skus');
    say(`     ${other.length} match(es) in candidate (not-yet-listed) sources:`);
    for (const h of other.slice(0, 20)) {
      say(`        ${h.table}: ${String(h.record_name).slice(0, 36).padEnd(38)} ${h.reason_code}`);
    }
    say('\n     A NON-MATCH IS NOT CLEARANCE. The list names 26 products; a proposal covering');
    say('     ~2,900 is mostly unexamined by it.\n');
  }

  // ── 6. DOES THE ABIOZEN MARKETPLACE ALREADY HOLD THESE? ──────────────────
  let marketplace = { reachable: false, reason: 'ABIOZEN_DATABASE_URL not set', answer: 'UNKNOWN' };
  if (process.env.ABIOZEN_DATABASE_URL) {
    try {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.ABIOZEN_DATABASE_URL, ssl: false,
        connectionTimeoutMillis: 8000, max: 2 });
      try {
        const t = await pool.query(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema='public' AND table_name ~* 'product|sku|listing|item' ORDER BY 1`);
        marketplace = { reachable: true, reason: null, answer: 'see tables',
          tables: t.rows.map((r) => r.table_name) };
      } finally { await pool.end().catch(() => {}); }
    } catch (e) {
      marketplace = { reachable: false, reason: String((e && e.message) || e), answer: 'UNKNOWN' };
    }
  }
  say('── DO THESE ALREADY EXIST ON THE ABIOZEN MARKETPLACE?\n');
  if (!marketplace.reachable) {
    say(`     UNKNOWN — could not look: ${marketplace.reason}`);
    say('     This is NOT "they are not there". Only one of those is safe to act on.\n');
  } else {
    say(`     product-like tables: ${marketplace.tables.join(', ') || '(none)'}\n`);
  }

  if (!REPORTING) {
    say('── WHAT THIS AUDIT DOES NOT SAY ──\n');
    say('   That any record is marketplace-ready, eligible, or safe to list. It reports what the');
    say('   candidate sources contain and how good their identity is. Nothing here is a clearance.\n');
    process.exit(0);
  }

  out.emitJson({
    generated_at: new Date().toISOString(),
    wrote_nothing: true, imported_nothing: true, published_nothing: true,
    proposes_no_listing: true,
    sources, study_molecules_by_type: byType, catalog_match_status: byMatch,
    inference_confidence: confidence, samples, identity_collisions: dupes,
    policy: policy ? { provenance: policy._provenance, display_rules: policy.display_rules,
      entries: policy.do_not_list.length } : null,
    policy_matches: policyHits,
    abiozen_marketplace: marketplace,
    caveats: {
      not_a_catalogue: 'study_molecules holds model-inferred molecules from trial records, with '
        + 'inference_confidence and infer_prompt_version per row. It is a demand signal, not a '
        + 'product range.',
      non_match_is_not_clearance: 'The do-not-list names 26 products. A record not on it is '
        + 'unexamined, not approved.',
      unknown_vs_absent: 'An unreachable marketplace is UNKNOWN, never "not published".',
    },
  });
  process.exit(0);
})().catch((e) => {
  console.error(`\napi-catalogue-source-audit failed: ${(e && e.stack) || e}\n`);
  process.exit(1);
});
