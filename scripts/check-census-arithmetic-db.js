#!/usr/bin/env node
// ── CAN THE CENSUS'S NUMBERS BE TRUSTED? ─────────────────────────────────────
//
//   node scripts/check-census-arithmetic-db.js
//
// Disposable cluster only. Starts its own, destroys it, and refuses a DATABASE_URL that looks
// hosted.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// scripts/molecule-identity-census.js produced the number a ruling was asked to act on, and that
// number was then reported wrongly in a Phase 0 document — as a defect in the canonical molecule
// layer rather than as a measurement of what a candidate merge rule WOULD collapse. The reporting
// error is corrected. This answers the next question: is the arithmetic itself right?
//
// ── IT RUNS THE SHIPPED SCRIPT, NOT A COPY OF ITS LOGIC ────────────────────
//
// The grouping is inline in the census, so testing it by reimplementing it would prove only that
// two copies of my reasoning agree — the failure mode this repository keeps finding. Instead this
// seeds a disposable cluster with a fixture set whose answer can be computed BY HAND, runs
// `node scripts/molecule-identity-census.js` against it as a child process, and parses the numbers
// out of the real output.
//
// ── THE FIXTURES, AND THE ANSWER WORKED OUT BY HAND ────────────────────────
//
// Seven filed names in study_molecules:
//
//   leuprolide              53714-56-0   valid
//   leuprolide acetate      74381-53-6   valid      ← same canonical group as above (de-salted)
//   leuprorelin             (none)                  ← synonym of leuprolide, same group
//   testosterone            58-22-0      valid
//   testosterone cypionate  58-20-8      valid      ← same canonical group as above
//   metformin               657-24-9     valid
//   gemcitabine             99999-99-9   INVALID    ← must not count toward any conflict
//
// canonicalMolecule de-salts and folds synonyms, so the groups are:
//
//   leuprolide    { leuprolide, leuprolide acetate, leuprorelin }  CAS { 53714-56-0, 74381-53-6 }  → CONFLICT
//   testosterone  { testosterone, testosterone cypionate }         CAS { 58-22-0, 58-20-8 }        → CONFLICT
//   metformin     { metformin }                                    CAS { 657-24-9 }                 → no
//   gemcitabine   { gemcitabine }                                  CAS { }  (invalid discarded)     → no
//
//   distinct filed names                 7
//   distinct canonical substances        4
//   groups with CONFLICTING valid CAS    2
//   groups merged by SALT-STRIPPING      2   (leuprolide+acetate, testosterone+cypionate)
//
// Those four numbers are the assertions. If the census ever stops counting a salt pair as a
// conflict, or starts counting an invalid CAS, this fails.
'use strict';

const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 400)}`); };

let temp = null;
function startTemp() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/census-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55995' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55995 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55995&sslmode=disable`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

// The census reads DATABASE_URL through src/lib/db. A hosted-looking URL is refused rather than
// used: this harness WRITES fixtures, and Rule 7 is that a verification must never perform the
// mutation it predicts will be refused.
const envUrl = process.env.CENSUS_PG_URL;
if (envUrl) {
  for (const re of [/railway/i, /rlwy\.net/i, /amazonaws/i, /\.render\.com/i, /supabase/i, /neon\.tech/i, /prod/i]) {
    if (re.test(envUrl)) {
      console.log('  FAIL  refusing to run against what looks like a hosted or production database — '
        + 'this harness WRITES fixtures');
      process.exit(1);
    }
  }
}
const url = envUrl || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (install initdb or set CENSUS_PG_URL to a DISPOSABLE database)');
  console.log('SKIP  census arithmetic not executed — this check needs a server');
  process.exit(EXIT_NOT_EXECUTED);
}

// NO FIXTURE DDL. The first attempt created a minimal study_molecules with just the four columns
// the census reads — and the real migration's CREATE TABLE IF NOT EXISTS then skipped it, so the
// census failed on a column my stub had shadowed. The schema must come from db.js, so the harness
// runs the census once against an empty database purely to let initDB() build the real tables, and
// only then seeds. A hand-written stub of a production table is a copy that drifts.

const FIXTURES = [
  ['f1', 'leuprolide', '53714-56-0'],
  ['f2', 'leuprolide acetate', '74381-53-6'],
  ['f3', 'leuprorelin', null],
  ['f4', 'testosterone', '58-22-0'],
  ['f5', 'testosterone cypionate', '58-20-8'],
  ['f6', 'metformin', '657-24-9'],
  ['f7', 'gemcitabine', '99999-99-9'],     // checksum-invalid on purpose
];

const EXPECTED = {
  'distinct filed names': 7,
  'distinct canonical substances': 4,
  'canonical groups with CONFLICTING valid CAS': 2,
  'groups merged by SALT-STRIPPING alone': 2,
};

function runCensus() {
  // The census prints a report; `row()` pads the label to 52 characters then the value.
  const out = execFileSync('node', [path.join(__dirname, 'molecule-identity-census.js')], {
    // The census calls initDB(), which refuses to start without an admin user. These are FIXTURE
    // values for a cluster that is destroyed at the end of this process — deliberately not the real
    // administrator's credentials, which have no business in a test harness or in this file.
    env: {
      ...process.env,
      DATABASE_URL: url,
      // Deliberately shaped so nothing here can be mistaken for a secret. The repo's own
      // no-committed-credentials check flagged the first attempt, because a value like
      // "census-harness-fixture" reads like a key — and its advice is exactly right: a placeholder
      // must be obvious at a glance.
      JWT_SECRET: 'REPLACE_ME_NOT_A_SECRET',
      ADMIN_EMAIL: 'fixture-admin@example.invalid',
      ADMIN_PASSWORD: 'REPLACE_ME_NOT_A_SECRET',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  const nums = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^\s{3}(.+?)\s{2,}(-?\d+)\s*$/);
    if (m) nums[m[1].trim()] = Number(m[2]);
  }
  return { out, nums };
}

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 3 });
  const q = (sql, params) => pool.query(sql, params);
  const made = [];

  try {
    // Build the real schema with the real migrations, in process. initDB() alone does not create
    // study_molecules — the research-intelligence tables are their own exported migration, which
    // the census does not call either. So they are called here by name, from db.js, which keeps the
    // DDL in one place.
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'REPLACE_ME_NOT_A_SECRET';
    process.env.ADMIN_EMAIL = 'fixture-admin@example.invalid';
    process.env.ADMIN_PASSWORD = 'fixture-only-not-a-real-password';
    const db = require('../src/lib/db');
    await db.initDB();
    if (db.migrateSchemas) await db.migrateSchemas();
    await db.migrateResearchIntelligence();

    const { rows: shape } = await q(
      `SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_name = 'study_molecules'`);
    if (shape[0].n > 4) ok(`study_molecules created by the real migration (${shape[0].n} columns, not a stub)`);
    else bad('the real schema must build the table', `${shape[0].n} columns — this looks like a stub`);

    for (const [id, name, cas] of FIXTURES) {
      await q('INSERT INTO study_molecules (id, study_id, molecule_name, cas_number) VALUES ($1,$1,$2,$3)', [id, name, cas]);
      made.push(id);
    }
    ok(`${made.length} fixtures seeded, recorded by id`);

    const { out, nums } = runCensus();

    for (const [label, want] of Object.entries(EXPECTED)) {
      if (nums[label] === want) ok(`${label} = ${want}, as worked out by hand`);
      else bad(`${label} should be ${want}`, `the census printed ${nums[label]}`);
    }

    // The invalid CAS must be discarded rather than counted. Proven by the conflict count: if
    // 99999-99-9 counted, gemcitabine would still be a single-CAS group — so prove it directly by
    // adding a SECOND invalid CAS under the same canonical name and asserting nothing changes.
    await q('INSERT INTO study_molecules (id, study_id, molecule_name, cas_number) VALUES ($1,$1,$2,$3)',
      ['f8', 'gemcitabine hcl', '88888-88-8']);
    made.push('f8');
    const second = runCensus();
    if (second.nums['canonical groups with CONFLICTING valid CAS'] === 2) {
      ok('two checksum-INVALID numbers in one group do not make a conflict');
    } else {
      bad('an invalid CAS must not count toward a conflict',
        `conflicts became ${second.nums['canonical groups with CONFLICTING valid CAS']}`);
    }

    // ── the negative control ───────────────────────────────────────────────
    //
    // The four assertions above would all pass if the census printed hard-coded numbers, or if the
    // harness were reading a stale run. So perturb the data by exactly one conflict and require the
    // count to move by exactly one.
    await q('INSERT INTO study_molecules (id, study_id, molecule_name, cas_number) VALUES ($1,$1,$2,$3)',
      ['f9', 'metformin hydrochloride', '1115-70-4']);
    made.push('f9');
    const third = runCensus();
    const got = third.nums['canonical groups with CONFLICTING valid CAS'];
    if (got === 3) {
      ok('negative control: adding one conflicting salt moved the count 2 → 3, exactly');
    } else {
      bad('negative control: the conflict count must track the data', `expected 3, got ${got}`);
    }
    // FOUR, not three — and the reason is worth keeping, because my first expectation was wrong
    // here and the census was right. `gemcitabine hcl`, added above purely to test the
    // invalid-CAS rule, de-salts to `gemcitabine`, so it formed a salt-stripping pair of its own.
    // Salt-stripping and CAS conflict are separate effects: hcl carried no VALID number, so it
    // added a salt group without adding a conflict. That separation is exactly what the census's
    // two counts exist to show, and asserting the wrong total would have hidden it.
    if (third.nums['groups merged by SALT-STRIPPING alone'] === 4) {
      ok('negative control: salt-stripping reached 4 — gemcitabine+hcl and metformin+hydrochloride '
        + 'are both salt pairs, while only the latter added a CAS conflict');
    } else {
      bad('negative control: salt-stripping count', `expected 4, got ${third.nums['groups merged by SALT-STRIPPING alone']}`);
    }

    // ── the scope disclosure must be present ──────────────────────────────
    //
    // The number was misread once as covering the canonical molecule layer. The disclosure is what
    // stops that happening again, so its absence is a failure rather than a cosmetic regression.
    if (/SCOPE: study_molecules only/.test(out)) {
      ok('the report states its scope — study_molecules only, source data, a prospective measurement');
    } else {
      bad('the census must state its scope',
        'without it, section 4\'s number reads as a defect in the canonical layer, which is how it '
        + 'was reported wrongly once');
    }
    if (/WOULD merge if adopted as the merge rule/.test(out)) {
      ok('the report says the number is prospective, not a description of damage done');
    } else bad('the census must say the measurement is prospective');

    // ── cleanup: only what I made, by id ──────────────────────────────────
    for (const id of made) await q('DELETE FROM study_molecules WHERE id = $1', [id]);
    const { rows } = await q('SELECT COUNT(*)::int n FROM study_molecules WHERE id = ANY($1)', [made]);
    if (rows[0].n === 0) ok(`cleanup: all ${made.length} fixtures removed by id, none leaked`);
    else bad('cleanup left fixtures behind', `${rows[0].n} remain`);
  } catch (e) {
    bad('harness aborted', e.stack || e.message);
  } finally {
    await pool.end().catch(() => {});
    stopTemp();
  }

  console.log('');
  if (fail) { console.log(`FAIL  ${fail} census arithmetic check(s) failed`); process.exit(1); }
  console.log('PASS  the census counts what it says it counts, and its numbers track the data');
  process.exit(0);
})();
