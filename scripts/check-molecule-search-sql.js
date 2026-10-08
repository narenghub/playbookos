#!/usr/bin/env node
// ── EXECUTE THE MOLECULE SEARCH AGAINST A REAL POSTGRES. ──────────────────────
//
//   scripts/check-molecule-search-sql.js      → exit 0 = the query runs and returns the right rows
//
// WHY THIS EXISTS, ON TOP OF THE OTHER THREE CHECKERS:
//
//   • `node --check` proves the file parses. It passed the day production crashed with
//     `column "name" does not exist`.
//   • `lookup-sql.test.js` resolves ORDER BY identifiers against what a subquery projects. It is a
//     parser, so it cannot know whether `LIKE ANY ($2)` accepts a text[] from node-postgres, whether
//     an array parameter's type is inferrable in that position, or whether a GROUP BY covers every
//     non-aggregated column.
//   • `page-renders.test.js` executes the front end. The query never reaches it.
//
// Only Postgres can answer those, so this starts one, builds the real table shapes, seeds the exact
// case that failed at CPHI Milan, and runs THE SHIPPED QUERY STRING — extracted from
// src/api/routes.js rather than copied here, so a divergence between what is tested and what is
// deployed cannot happen quietly.
//
// Needs a server: set MOLSEARCH_PG_URL, or let it spin up a throwaway cluster if initdb is on PATH.
// With neither it SKIPS (exit 0) and says so — a developer machine without Postgres must not be
// unable to run preflight. CI sets the variable, so the check is real where it counts.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROUTES = path.join(ROOT, 'src/api/routes.js');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(String(d).split('\n').map(l => '          ' + l).join('\n')); };

// ── 1. EXTRACT THE SHIPPED QUERY, DO NOT COPY IT ────
//
// The handler builds its SQL with a template literal containing ${moleculeLikeSql(...)} calls. Those
// are evaluated here with the real module, so what runs is byte-identical to production.
const { expandMolecule, moleculeLikeSql, likePatterns } = require('../src/lib/molecules/synonyms');
const { mergeMoleculeRows } = require('../src/lib/molecules/merge');

function extractMoleculeSearchSql() {
  const src = fs.readFileSync(ROUTES, 'utf8');
  const anchor = src.indexOf("router.get('/events/cphi/molecule-search'");
  if (anchor < 0) throw new Error('molecule-search handler not found — did the route move?');
  // The query is the first backtick-delimited template after `await query(` in the handler.
  const qAt = src.indexOf('await query(', anchor);
  if (qAt < 0) throw new Error('no query() call in the molecule-search handler');
  const open = src.indexOf('`', qAt);
  if (open < 0) throw new Error('no template literal in the molecule-search query');
  // Walk to the matching backtick, stepping over ${...} so a backtick inside an interpolation
  // cannot end the scan early.
  let i = open + 1, depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '$' && src[i + 1] === '{') { depth++; i++; continue; }
    if (c === '}' && depth > 0) { depth--; continue; }
    if (c === '`' && depth === 0) break;
  }
  if (i >= src.length) throw new Error('template literal never closed');
  const raw = src.slice(open + 1, i);
  // Evaluate the interpolations with the real helpers in scope.
  // eslint-disable-next-line no-new-func
  return new Function('moleculeLikeSql', 'return `' + raw + '`;')(moleculeLikeSql);
}

let SQL;
try {
  SQL = extractMoleculeSearchSql();
  if (!/LIKE ANY/.test(SQL)) throw new Error('the extracted SQL has no LIKE ANY — wrong literal?');
  ok('extracted the shipped molecule-search SQL from routes.js');
} catch (e) {
  bad('extract the shipped SQL', e.message);
  process.exit(1);
}

// ── 2. GET A SERVER ────
const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { const p = path.join(d, 'initdb'); if (fs.existsSync(p)) return d; }
  return null;
}

let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/molsearch-');
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH, PGPORT: '55999' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55999 -c listen_addresses=' start -w`);
  } catch (e) {
    return null;
  }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55999`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: temp.dir + ':' + process.env.PATH };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) { /* best effort */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.MOLSEARCH_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set MOLSEARCH_PG_URL or install initdb)');
  console.log('SKIP  molecule-search SQL not executed — this check needs a server');
  process.exit(0);
}

// ── 3. BUILD THE REAL SHAPES AND THE EXACT FAILING CASE ────
const SCHEMA = `
CREATE TABLE clinical_studies (
  id BIGSERIAL PRIMARY KEY, nct_id TEXT, brief_title TEXT, overall_status TEXT, phase TEXT,
  lead_sponsor_name TEXT, sponsor_type TEXT, enrollment_count INT);
CREATE TABLE study_molecules (
  id BIGSERIAL PRIMARY KEY, study_id BIGINT, molecule_name TEXT, catalog_match_status TEXT);
CREATE TABLE dmf_holders (
  id BIGSERIAL PRIMARY KEY, dmf_number TEXT, holder TEXT, holder_normalized TEXT, submit_date DATE);
CREATE TABLE molecule_dmf_matches (
  id BIGSERIAL PRIMARY KEY, dmf_number TEXT, molecule_name TEXT, review_status TEXT);
CREATE TABLE cphi_exhibitor_matches (
  id BIGSERIAL PRIMARY KEY, event_slug TEXT, holder_normalized TEXT, exhibitor_name TEXT,
  booth TEXT, hall TEXT, exhibiting BOOLEAN, role TEXT, review_status TEXT);
CREATE TABLE molecule_pricing (
  id BIGSERIAL PRIMARY KEY, molecule_name TEXT, cas_number TEXT, gmp_grade TEXT, purity TEXT,
  price_per_kg_usd NUMERIC, min_quantity_g NUMERIC, max_quantity_kg NUMERIC, lead_time_days INT,
  sample_available INT, sample_price_usd NUMERIC, gmp_certified INT, dmf_available INT,
  regulatory_status TEXT, controlled_substance INT, active INT);

INSERT INTO dmf_holders (dmf_number, holder, holder_normalized) VALUES
  ('DMF-1001','Sun Pharmaceutical Industries','sun pharmaceutical industries'),
  ('DMF-1002','ScinoPharm Taiwan','scinopharm taiwan'),
  ('DMF-1003','Bachem AG','bachem ag');
INSERT INTO molecule_dmf_matches (dmf_number, molecule_name, review_status) VALUES
  ('DMF-1001','Leuprolide Acetate','auto_confirmed'),
  ('DMF-1002','Leuprolide Acetate','auto_confirmed'),
  ('DMF-1003','Leuprolide','auto_confirmed'),
  ('DMF-1001','Metformin Hydrochloride','auto_confirmed');
INSERT INTO cphi_exhibitor_matches (event_slug, holder_normalized, exhibitor_name, booth, hall, exhibiting, role, review_status) VALUES
  ('cphi-milan-2026','scinopharm taiwan','ScinoPharm','5B14','5',true,'supplier','auto_confirmed'),
  ('cphi-milan-2026','bachem ag','Bachem','3C22','3',true,'supplier','auto_confirmed');
INSERT INTO clinical_studies (nct_id, brief_title, phase, lead_sponsor_name, sponsor_type, enrollment_count) VALUES
  ('NCT0001','Leuprolide in advanced prostate cancer','Phase 3','AbbVie','INDUSTRY',420),
  ('NCT0002','Leuprorelin for endometriosis','Phase 2','Takeda','INDUSTRY',160),
  ('NCT0003','Metformin and ageing','Phase 3','NIA','NIH',3000);
INSERT INTO study_molecules (study_id, molecule_name) VALUES
  (1,'Leuprolide Acetate'), (2,'Leuprorelin'), (3,'Metformin');
INSERT INTO molecule_pricing (molecule_name, cas_number, gmp_grade, gmp_certified, price_per_kg_usd, active) VALUES
  ('Paracetamol','103-90-2','IP/BP',1,9800,1);
`;

(async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query(SCHEMA);
    ok('built the real table shapes and seeded the CPHI Milan case');

    // Mirrors the handler exactly: query, then merge. Asserting the raw rows would pass while the
    // number the page actually prints is wrong, which is the bug this found in the first place.
    const run = async (typed) => {
      const e = expandMolecule(typed);
      const r = await client.query(SQL, ['cphi-milan-2026', likePatterns(e.terms), e.terms]);
      return { expansion: e, raw: r.rows, rows: mergeMoleculeRows(r.rows) };
    };

    // ── THE BUG. This query returned zero rows in production on 2026-10-08. ────
    const inn = await run('leuprorelin');
    if (!inn.rows.length) {
      bad('leuprorelin returns holders', 'zero rows — the synonym expansion is not reaching the SQL');
    } else {
      ok(`leuprorelin returns ${inn.rows.length} row(s) — the INN now finds the USAN`);

      // ── THE FALSE SCARCITY CHECK ────
      // The register splits this substance across three strings. Unmerged, the top row carries ONE
      // holder and the page prints "SOLE holder worldwide" — a scarcity claim a buyer negotiates on.
      if (inn.raw.length <= 1) {
        bad('the fixture still exercises the alias split',
          `only ${inn.raw.length} raw row(s) — this check is no longer testing the merge`);
      } else ok(`${inn.raw.length} alias rows from the register, merged into ${inn.rows.length}`);
      if (inn.rows.length !== 1) {
        bad('one substance, one row', `got ${inn.rows.length}: ${inn.rows.map(r => r.molecule).join(' | ')}`);
      } else ok('three filed names collapse to one substance');

      const top = inn.rows[0];
      const holders = (top.holders || []).map(h => h.holder);
      if (top.holder_count !== 3) {
        bad('holder_count counts every holder of the substance',
          `got ${top.holder_count}, expected 3 — the page would claim false scarcity`);
      } else ok('holder_count=3 — not "SOLE holder worldwide"');
      if (top.holder_count !== holders.length) {
        bad('holder_count matches the holder list', `${top.holder_count} vs ${holders.length}`);
      }
      for (const want of [/scinopharm/i, /bachem/i, /sun pharm/i]) {
        if (!holders.some(h => want.test(h))) bad(`holder matching ${want} is present`, JSON.stringify(holders));
      }
      ok(`holders attached: ${holders.join(', ')}`);
      if (top.on_floor !== 2) bad('both exhibiting holders are counted', `on_floor=${top.on_floor}, expected 2`);
      else ok('on_floor=2 — both booth chips will render');
      if (top.studies !== 2) bad('demand sums across aliases', `studies=${top.studies}, expected 2`);
      else ok('studies=2 — the INN trial and the USAN trial are both counted');
      if (!(top.filed_as || []).length) bad('filed_as explains the merge on the page', 'null');
      else ok(`filed_as: ${top.filed_as.join(' · ')}`);
    }

    // The same molecule typed the American way must give the same supply picture. If the two
    // disagree, one of them is wrong and a buyer is being told the wrong number of holders.
    const usan = await run('leuprolide');
    const innHolders = new Set(inn.rows.flatMap(r => (r.holders || []).map(h => h.holder)));
    const usanHolders = new Set(usan.rows.flatMap(r => (r.holders || []).map(h => h.holder)));
    if (innHolders.size !== usanHolders.size || [...innHolders].some(h => !usanHolders.has(h))) {
      bad('INN and USAN agree on the holder set',
        `leuprorelin → ${[...innHolders].join(', ')}\nleuprolide  → ${[...usanHolders].join(', ')}`);
    } else ok('leuprorelin and leuprolide return the same holders — one substance, one answer');

    // A salted INN, which is what a European price list actually says.
    const salted = await run('Leuprorelin Acetate');
    if (!salted.rows.length) bad('a salted INN still finds the register', 'zero rows');
    else ok('"Leuprorelin Acetate" finds it too — de-salt then expand');

    // Regression: a molecule with no synonym must behave exactly as before, and an unknown name must
    // still come back empty rather than matching everything through an empty-array parameter.
    const met = await run('metformin');
    if (!met.rows.length) bad('metformin still works', 'zero rows — the array parameter broke the plain case');
    else ok(`metformin returns ${met.rows.length} row(s) — no regression on unexpanded names`);

    const nothing = await run('zzzqqq');
    if (nothing.rows.length) bad('an unknown name returns nothing', `${nothing.rows.length} rows leaked`);
    else ok('an unknown name returns nothing — no accidental wildcard');

    // The research-grade third case: priced, no DMF, no trial. holder_count must be 0, not null,
    // because the UI switches on it.
    const para = await run('paracetamol');
    const pr = para.rows[0];
    if (!pr) bad('a priced-only molecule is findable', 'paracetamol returned no rows');
    else if (pr.holder_count !== 0) bad('holder_count is 0 for a priced-only molecule', `got ${pr.holder_count}`);
    else if (pr.gmp_certified !== true) bad('the price list GMP flag survives the join', `got ${pr.gmp_certified}`);
    else ok('a priced-only molecule returns holder_count=0 with its GMP flag intact');

    // And the demand side, which got the same fix.
    const dem = await client.query(
      `SELECT cs.nct_id FROM clinical_studies cs
        WHERE EXISTS (SELECT 1 FROM study_molecules sm
                       WHERE sm.study_id = cs.id AND ${moleculeLikeSql('LOWER(sm.molecule_name)', 1)})
          AND cs.sponsor_type = $2
        ORDER BY cs.nct_id`,
      [likePatterns(expandMolecule('leuprorelin').terms), 'INDUSTRY']);
    const ncts = dem.rows.map(r => r.nct_id);
    if (ncts.length !== 2) {
      bad('the demand side finds studies filed under either name', `got ${JSON.stringify(ncts)}, expected both NCT0001 and NCT0002`);
    } else ok(`demand side: ${ncts.join(', ')} — both the USAN study and the INN study`);

  } catch (e) {
    bad('execute the molecule-search SQL', e.message + (e.position ? ` (at position ${e.position})` : ''));
  } finally {
    try { await client.end(); } catch (_) {}
    stopTemp();
  }

  if (fail) { console.error(`FAIL  ${fail} check(s) failed`); process.exit(1); }
  console.log('PASS  the molecule search runs on real Postgres and the synonym fix works end to end');
})();
