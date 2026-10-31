#!/usr/bin/env node
// ── DOES THE GATE 2 MEASUREMENT RUN, AND CAN IT TELL THE CASES APART? ────────
//
//   node scripts/check-gate2-measure-runs.js        exit 0 = it runs and classifies correctly
//
// `gate2-measure-identity.js` is a READ-ONLY measurement meant to be run once against production,
// over an SSH connection that failed three distinct ways on 31 Oct. It gets exactly one chance to
// be correct, with no opportunity to iterate against the data it is measuring. So every outcome
// class is exercised here first, against a real Postgres built from the real molecule DDL.
//
// Two things are asserted, and they are different:
//
//   1. it EXECUTES — the `after is not defined` defect shipped to production because node --check
//      only parses, there is no linter, and nothing executed main().
//   2. it CLASSIFIES — each of the six outcomes is reachable, and, most importantly, a CAS NEVER
//      resolves a name. CAS is a veto and not a key; the whole measurement is worthless if a
//      shared registry number can make a match, because that is the defect that mispriced a quote
//      2.4x on 31 Oct.
//
// Not a negative control on a reconciliation, because the measurement is not a reconciliation: it
// has no verdict to go red. Its exit code means "I measured", which is stated in its own header.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let fail = 0;
const out = (s) => fs.writeSync(1, s + '\n');
const ok = (m) => out(`  ok    ${m}`);
const bad = (m, d) => { fail++; out(`  FAIL  ${m}`); if (d) out(`          ${String(d).slice(0, 400)}`); };

// Same temp-cluster bootstrap as check-molecule-identity-db.js — trust auth on a private socket,
// so this needs no pre-running server and no credentials.
const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { const p = path.join(d, 'initdb'); if (fs.existsSync(p)) return d; }
  return null;
}
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/g2meas-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55993' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55993 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55993&sslmode=disable`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) { /* best effort */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.MOLID_PG_URL || startTemp();
if (!url) {
  out('  skip  no Postgres available (set MOLID_PG_URL or install initdb)');
  out('SKIP  gate2 measurement not executed — this check needs a server');
  process.exit(0);
}
process.env.DATABASE_URL = url;

// Required before db.js is loaded, because its pool is built at require time.
const { query } = require('../src/lib/db');
const { DDL_TABLES, DDL_TRIGGERS, applyConflictKinds, applyDriftColumns } = require('./migrate-molecules');
const measure = require('./gate2-measure-identity');

// Only the columns the measurement reads. A fuller shape would not strengthen any assertion and
// would drift from db.js. `skus` names its molecule column `name`, as it really does.
const FIXTURE = `
  CREATE TABLE IF NOT EXISTS inquiries      (id TEXT PRIMARY KEY, molecule_name TEXT, cas_number TEXT);
  CREATE TABLE IF NOT EXISTS inquiry_quotes (id TEXT PRIMARY KEY, molecule_name TEXT, cas_number TEXT);
  CREATE TABLE IF NOT EXISTS rfq_requests   (id TEXT PRIMARY KEY, molecule_name TEXT, cas_number TEXT,
                                             week_start TEXT);
  CREATE TABLE IF NOT EXISTS molecule_pricing (
    id TEXT PRIMARY KEY, molecule_name TEXT NOT NULL, cas_number TEXT,
    price_per_kg_usd REAL, active INTEGER DEFAULT 1);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_name ON molecule_pricing (LOWER(molecule_name));
  CREATE TABLE IF NOT EXISTS skus (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, cas_number TEXT,
    units_in_stock INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
    -- every column the SHIPPED findStock selects. A thinner fixture makes it THROW, and a
    -- swallowed throw was being counted as "no stock claim today", which then read as
    -- availability that canonicalisation gains. The measurement now separates the two; this
    -- fixture makes the before-state real so the separation is exercised rather than assumed.
    demand_trend TEXT DEFAULT 'stable', lead_time_days INTEGER DEFAULT 14,
    is_gmp INTEGER DEFAULT 0, sale_price REAL DEFAULT 0);
`;

(async () => {
  await query(DDL_TABLES);
  await query(DDL_TRIGGERS);
  await applyConflictKinds(query);
  await applyDriftColumns(query, () => {});
  await query(FIXTURE);

  // Two canonical identities, one of them deprecated. Real registry numbers: Leuprolide
  // 53714-56-0 against Warfarin Sodium 129-06-6.
  await query(
    `INSERT INTO molecules (preferred_name, normalized_name, cas, source, derivation_method) VALUES
       ('Leuprolide','leuprolide','53714-56-0','fixture','exact'),
       ('Warfarin Sodium','warfarin sodium','129-06-6','fixture','exact')`);
  await query(
    `UPDATE molecules SET deprecated_at = NOW(),
       deprecated_reason = 'cas_disagreement:1,2|rev=AUTO_REVERSIBLE|rows=2|at=2026-10-31T00:00:00.000Z'
     WHERE normalized_name = 'warfarin sodium'`);

  let canonical = await measure.loadCanonical();
  const cols = { name: 'molecule_name', cas: 'cas_number' };
  const got = (name, cas) =>
    measure.classify({ molecule_name: name, cas_number: cas }, canonical, cols).outcome;
  const expect = (label, actual, wanted) =>
    (actual === wanted ? ok(`${label} → ${wanted}`) : bad(`${label} → ${actual}, expected ${wanted}`));

  // ── 1. every outcome class is reachable ───────────────────────────────────
  expect('exact name + matching CAS', got('Leuprolide', '53714-56-0'), 'resolved');
  expect('name resolving to a deprecated identity',
    got('Warfarin Sodium', '129-06-6'), 'resolved_deprecated');
  expect('exact name + contradicting CAS', got('Leuprolide', '99999-99-9'), 'cas_contradiction');
  expect('a name nothing canonical answers to', got('Tirzepatide', null), 'unresolved_no_match');
  expect('a string that normalises to nothing', got('()', null), 'unresolved_unusable');
  expect('a row naming no molecule', got('', null), 'no_molecule_named');
  expect('a row whose molecule_name is NULL', got(null, null), 'no_molecule_named');

  // ── 2. THE ONE THAT MATTERS: a CAS must never resolve a name ──────────────
  // An unknown name carrying a KNOWN, CORRECT registry number must stay unresolved. If this ever
  // passes as `resolved`, the measurement has reintroduced the pricing defect as a design input.
  expect('unknown name + a real CAS from another row',
    got('Some Substance We Have Never Heard Of', '53714-56-0'), 'unresolved_no_match');
  // And a row with no CAS contradicts nothing — absence is not disagreement.
  expect('known name + no CAS at all', got('Leuprolide', null), 'resolved');
  // A deprecated identity is still told apart from a miss, exactly as canonical.js requires.
  if (got('Warfarin Sodium', null) === 'unresolved_no_match') {
    bad('a deprecated identity was collapsed into "not found"');
  } else {
    ok('a deprecated identity is never reported as not found');
  }

  // ── 3. CANONICAL COLLISIONS: two priced rows that are one substance ──────
  //
  // `molecule_pricing` is unique on LOWER(molecule_name), so "Gemcitabine" and "Gemcitabine USP"
  // are two legitimate rows with two legitimate prices — and both normalise to `gemcitabine`.
  // Canonical lookup then has two prices for one substance and must refuse. This is the number
  // that decides how much priced catalogue becomes unquotable, so the detection is asserted here
  // rather than discovered on production.
  await query(
    `INSERT INTO molecules (preferred_name, normalized_name, cas, source, derivation_method)
     VALUES ('Gemcitabine','gemcitabine','95058-81-4','fixture','exact')`);
  // The canonical map is a snapshot taken by loadCanonical(). Adding a molecule after that snapshot
  // and then resolving against it finds nothing -- which is how this check first failed, and is the
  // same stale-snapshot shape as resolving production rows against a map loaded before a backfill.
  canonical = await measure.loadCanonical();
  await query(
    `INSERT INTO molecule_pricing (id, molecule_name, cas_number, price_per_kg_usd, active) VALUES
       ('p1','Gemcitabine',NULL,9000,1),
       ('p2','Gemcitabine USP',NULL,12000,1),
       ('p3','Leuprolide',NULL,40000,1),
       ('p4','SPhos',NULL,2000,1)`);
  const pricingM = await measure.measureTable(measure.LOOKUP_TABLES[0], canonical);
  const pricingCol = measure.collisions(pricingM);
  if (pricingCol.groups.length === 1 && pricingCol.rows === 2
      && String(pricingCol.groups[0].molecule.normalized_name) === 'gemcitabine') {
    ok('two priced rows normalising to one molecule are detected as a collision');
  } else {
    bad('canonical collision not detected', JSON.stringify(
      pricingCol.groups.map((g) => [g.molecule.normalized_name, g.rows.length])));
  }
  // A reagent name E1 has no molecule for must NOT silently become a collision or a resolution.
  if (pricingM.counts.unresolved_no_match >= 1) {
    ok('a catalogue row with no canonical molecule stays unresolved, not guessed');
  } else {
    bad('a reagent row resolved to something', JSON.stringify(pricingM.counts));
  }

  // ── 4. BEHAVIOUR TRANSITIONS: both directions must be reachable ──────────
  //
  // canonicalAnswer is what decides whether a buyer is priced, refused, or priced differently.
  // Both directions matter: a false refusal removed is revenue enabled, and a new refusal is
  // revenue withdrawn. A measurement that could only show one of them would read as good news.
  const ca = (name) => measure.canonicalAnswer(name, canonical, pricingM).status;
  expect('a name whose only catalogue match differs by grade word', ca('Gemcitabine, USP'), 'ambiguous');
  expect('a cleanly priced single-row molecule', ca('Leuprolide'), 'answer');
  expect('a deprecated identity may not supply a new answer', ca('Warfarin Sodium'), 'refused_deprecated');
  expect('a name with no canonical molecule', ca('SPhos'), 'refused_unresolved');

  // transitionOf is the comparison itself. Asserted directly, because the interesting cases are
  // the ones production may not happen to contain today.
  const t = measure.transitionOf;
  expect('today nothing, canonical one answer',
    t(null, { status: 'answer', row: { id: 'p3' } }, 'p3'), 'refusal_removed');
  expect('today an answer, canonical ambiguous',
    t('p1', { status: 'ambiguous' }, null), 'now_ambiguous');
  expect('today an answer, canonical cannot resolve',
    t('p1', { status: 'refused_unresolved' }, null), 'now_refused_unresolved');
  expect('today an answer, canonical refuses a deprecated identity',
    t('p1', { status: 'refused_deprecated' }, null), 'now_refused_deprecated');
  expect('both answer, different rows',
    t('p1', { status: 'answer', row: { id: 'p2' } }, 'p2'), 'different_row');
  expect('both answer, same row',
    t('p1', { status: 'answer', row: { id: 'p1' } }, 'p1'), 'unchanged_answer');
  expect('nothing either way', t(null, { status: 'none' }, null), 'unchanged_answer');

  // A thrown shipped lookup must never be scored as a transition. Asserted directly, because the
  // fixture that first exposed it was a fixture bug and production will have its own.
  expect('a thrown lookup is not a refusal removed',
    t(null, { status: 'answer', row: { id: 'p3' } }, 'p3'), 'refusal_removed');

  // ── 4b. THE UNRESOLVED DIAGNOSIS: three buckets, and no auto-linking ─────
  //
  // Fixture names are the ones production actually reported unresolved on 31 Oct, so these
  // assertions are about real data rather than invented cases.
  await query(
    `INSERT INTO molecules (preferred_name, normalized_name, cas, source, derivation_method) VALUES
       ('Ciprofloxacin Hydrochloride','ciprofloxacin hydrochloride',NULL,'fixture','exact'),
       ('Tacrolimus','tacrolimus',NULL,'fixture','exact')`);
  canonical = await measure.loadCanonical();
  const byBase = measure.buildBaseIndex(canonical);
  const diag = (n) => measure.diagnoseUnresolved(n, canonical, byBase);

  // "Ciprofloxacin HCl" shares the derived base and the salt form class with
  // "Ciprofloxacin Hydrochloride" -- only the token spelling differs.
  const cip = diag('Ciprofloxacin HCl');
  expect('a differing form token is reported as a candidate',
    cip.diagnosis, 'form_token_differs');
  if (cip.candidates.length === 1
      && cip.candidates[0].ourTokens.join() === 'hcl'
      && cip.candidates[0].theirTokens.join() === 'hydrochloride') {
    ok('both competing form tokens are shown side by side for a human to rule on');
  } else {
    bad('form tokens not reported for the ruling', JSON.stringify(cip.candidates));
  }

  // The base exists, the filed hydrate does not. E1 keeps base and hydrate distinct, so this is a
  // neighbour, never a resolution.
  expect('a filed hydrate whose base exists is reported as base-only',
    diag('Tacrolimus Monohydrate').diagnosis, 'base_exists_salt_absent');

  // Nothing related exists. This is the bucket that means the canonical universe does not cover
  // buyer demand, and it must not be contaminated by the other two.
  expect('a substance with no relative is reported absent',
    diag('Yttrium oxide').diagnosis, 'no_candidate');
  expect('a plain organic with no relative is reported absent',
    diag('4-Aminopyridine').diagnosis, 'no_candidate');

  // THE ONE THAT MATTERS: a different anion is NOT a spelling variant. If this ever reports
  // form_token_differs, the diagnosis has started making chemistry calls.
  await query(
    `INSERT INTO molecules (preferred_name, normalized_name, cas, source, derivation_method)
     VALUES ('Tiotropium Chloride','tiotropium chloride',NULL,'fixture','exact')`);
  canonical = await measure.loadCanonical();
  const byBase2 = measure.buildBaseIndex(canonical);
  const tio = measure.diagnoseUnresolved('Tiotropium Bromide', canonical, byBase2);
  if (tio.diagnosis === 'form_token_differs'
      && tio.candidates.length === 1
      && tio.candidates[0].ourTokens.join() === 'bromide'
      && tio.candidates[0].theirTokens.join() === 'chloride') {
    ok('a different anion is surfaced for ruling WITH both tokens shown, never linked');
  } else {
    bad('a different-anion neighbour was not surfaced with its tokens', JSON.stringify(tio));
  }
  // And nothing was written to molecule_aliases by any of it.
  const aliasesAfter = (await query(`SELECT COUNT(*)::int n FROM molecule_aliases`)).rows[0].n;
  if (aliasesAfter === 0) ok('the diagnosis created no alias — it reports, it does not link');
  else bad('the diagnosis WROTE an alias', `molecule_aliases now has ${aliasesAfter} row(s)`);

  // ── 5. it executes end to end and returns its verdict ────────────────────
  await query(
    `INSERT INTO skus (id, name, cas_number, units_in_stock, is_active) VALUES
       ('s1','Leuprolide',NULL,40,1), ('s2','Semaglutide 99%',NULL,10,1)`);
  await query(
    `INSERT INTO inquiries (id, molecule_name, cas_number) VALUES
       ('a','Leuprolide','53714-56-0'), ('b','Warfarin Sodium','129-06-6'),
       ('c','Leuprolide','99999-99-9'), ('d','Tirzepatide',NULL),
       ('e','',NULL), ('f',NULL,NULL), ('g','()',NULL),
       ('h','Gemcitabine',NULL), ('i','Semaglutide',NULL)`);
  let code;
  try {
    code = await measure.main();
    if (code === 0) ok('main() ran end to end and returned 0 having measured');
    else bad(`main() returned ${code}`);
  } catch (e) {
    bad('main() threw', `${e.message}\n${e.stack}`);
  }

  // ── 4. it wrote nothing ──────────────────────────────────────────────────
  // The claim on the tin is "READS ONLY", and a claim in a comment is not evidence. Measured by
  // row counts either side of the run, and by the molecule state the run could most plausibly
  // have touched.
  const counts = async () => (await query(
    `SELECT (SELECT COUNT(*)::int FROM inquiries) i,
            (SELECT COUNT(*)::int FROM molecules) m,
            (SELECT COUNT(*)::int FROM molecules WHERE deprecated_at IS NOT NULL) d,
            (SELECT COUNT(*)::int FROM molecule_conflicts) c,
            (SELECT COUNT(*)::int FROM molecule_pricing) p,
            (SELECT COALESCE(SUM(price_per_kg_usd),0)::int FROM molecule_pricing) ps,
            (SELECT COUNT(*)::int FROM skus) s`)).rows[0];
  const before = { i: 9, m: 6, d: 1, c: 0, p: 4, ps: 63000, s: 2 };
  const after = await counts();
  const same = Object.keys(before).every((k) => before[k] === after[k]);
  if (same) {
    ok('the measurement wrote nothing — counts and the pricing total unchanged across six tables');
  } else {
    bad('the measurement MUTATED the database', JSON.stringify({ before, after }));
  }

  stopTemp();
  if (fail) {
    out(`FAIL  ${fail} assertion(s) failed`);
    process.exit(1);
  }
  out('PASS  the gate 2 measurement runs, classifies correctly, and writes nothing');
  process.exit(0);
})().catch((e) => {
  stopTemp();
  fs.writeSync(2, `FAIL  harness error: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
