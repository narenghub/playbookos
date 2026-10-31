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
// would drift from db.js.
const FIXTURE = `
  CREATE TABLE IF NOT EXISTS inquiries      (id TEXT PRIMARY KEY, molecule_name TEXT, cas_number TEXT);
  CREATE TABLE IF NOT EXISTS inquiry_quotes (id TEXT PRIMARY KEY, molecule_name TEXT, cas_number TEXT);
  CREATE TABLE IF NOT EXISTS rfq_requests   (id TEXT PRIMARY KEY, molecule_name TEXT, cas_number TEXT);
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

  const canonical = await measure.loadCanonical();
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

  // ── 3. it executes end to end and returns its verdict ────────────────────
  await query(
    `INSERT INTO inquiries (id, molecule_name, cas_number) VALUES
       ('a','Leuprolide','53714-56-0'), ('b','Warfarin Sodium','129-06-6'),
       ('c','Leuprolide','99999-99-9'), ('d','Tirzepatide',NULL),
       ('e','',NULL), ('f',NULL,NULL), ('g','()',NULL)`);
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
            (SELECT COUNT(*)::int FROM molecule_conflicts) c`)).rows[0];
  const before = { i: 7, m: 2, d: 1, c: 0 };
  const after = await counts();
  if (after.i === before.i && after.m === before.m && after.d === before.d && after.c === before.c) {
    ok('the measurement wrote nothing — row counts unchanged across all four tables');
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
