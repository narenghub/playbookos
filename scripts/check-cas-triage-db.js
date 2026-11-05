#!/usr/bin/env node
// ── DOES THE CAS TRIAGE CLASSIFY CORRECTLY, AGAINST A REAL POSTGRES? ────────
//
// The unit tests in src/lib/molecules/cas-triage.test.js prove the classifier. This proves the
// SCRIPT: that scripts/cas-conflict-triage.js reads study_molecules, rebuilds groups the way the
// census does, drops checksum-invalid numbers, and reports classes that match a fixture set whose
// answer is computed BY HAND below.
//
// ── WHY THE FIXTURES ARE NOT "THE REAL CENSUS NUMBERS" ──────────────────────
//
// I reconstructed candidate pairs from a SUMMARY of the production census output rather than the
// output itself, and three of the five numbers I had recorded for `lutetium-177 chloride`
// (15158-54-8, 10099-54-0, 20461-71-0) FAIL the CAS checksum — which the census filters on before
// grouping, so it cannot have counted five valid numbers for that name. The transcription is
// therefore unreliable, and seeding it while calling it real would be asserting a measurement I
// do not have.
//
// So this harness proves the logic on a hand-computed set, and the authoritative per-group list
// comes from one production run of cas-conflict-triage.js, which is read-only. Where a pair below
// IS a verified-valid pair from the census (belzutifan, resmetirom, gemcitabine, asciminib,
// enzalutamide, doxorubicinol/idarubicin, dfdu) it is marked REAL.
//
// ── THE FIXTURE SET AND ITS HAND-COMPUTED ANSWER ───────────────────────────
//
//  filed name                              CAS (valid only)              canonical      class
//  ─────────────────────────────────────────────────────────────────────────────────────────────
//  gemcitabine                             95058-81-4                  ┐ gemcitabine     cross_attached
//  gemcitabine hcl                         122111-03-9                 ┘                 (shares 95058-81-4
//                                             de-salted into one group                    with dfdu)
//  2' 2'-difluorodeoxyuridine dfdu         95058-81-4, 114248-23-6       dfdu...          cross_attached
//  belzutifan                              1802220-02-5, 1672668-24-4    belzutifan       digit? no → unexplained
//  belzutifan reference standard           1802220-02-5, 1672668-24-4    belzutifan ref.  grade_duplicate
//  asciminib                               1492952-26-7, 1492952-76-7    asciminib        digit_adjacent
//  n-desmethyl enzalutamide                915087-27-3, 915095-89-5      n-desmethyl...   unexplained
//  leuprolide / leuprolide acetate         1442-14-8 / 74381-53-6        leuprolide       form_pair
//  someprofen                              22222-22-6 ONLY               someprofen       (not a conflict)
//  badcas                                  11111-11-1 (INVALID)          badcas           (not a conflict)
//
// Counted by hand: 7 conflicting groups.
//   form_pair 1 (leuprolide) · grade_duplicate 1 · cross_attached 2 (gemcitabine, dfdu)
//   digit_adjacent 1 (asciminib) · unexplained 2 (belzutifan, enzalutamide)
//   needing a human: 5 (everything but form_pair and grade_duplicate)
// `someprofen` and `badcas` must NOT appear: one has a single number, the other's only number
// fails the checksum. They are the negative controls for the conflict test itself.
'use strict';

const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const fs = require('fs');
const { execFileSync } = require('child_process');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(`          ${String(d).slice(0, 600)}`);
};

let temp = null;
function startTemp() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/castriage-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55997' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55997 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55997&sslmode=disable`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) { /* best effort */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

// This harness WRITES fixtures. Rule 7: a verification must never perform the mutation it predicts
// will be refused — so a hosted-looking URL is refused outright rather than written to and hoped
// about.
const envUrl = process.env.CAS_TRIAGE_PG_URL;
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
  console.log('  skip  no Postgres available (install initdb or set CAS_TRIAGE_PG_URL to a DISPOSABLE database)');
  console.log('SKIP  cas triage db check not executed — this check needs a server');
  process.exit(EXIT_NOT_EXECUTED);
}

// id is TEXT PRIMARY KEY and study_id is NOT NULL, so both are supplied. Ids are prefixed
// `castriage-` so cleanup can target exactly these rows by id and a leak is self-identifying.
const FIXTURES = [
  // [id, molecule_name, cas_number]                                REAL = verified-valid census pair
  ['castriage-01', 'gemcitabine', '95058-81-4'],                 // REAL
  ['castriage-02', 'gemcitabine hcl', '122111-03-9'],            // REAL
  ['castriage-03', "2' 2'-difluorodeoxyuridine dfdu", '95058-81-4'],  // REAL (the shared number)
  ['castriage-04', "2' 2'-difluorodeoxyuridine dfdu", '114248-23-6'], // REAL
  ['castriage-05', 'belzutifan', '1802220-02-5'],                // REAL
  ['castriage-06', 'belzutifan', '1672668-24-4'],                // REAL
  ['castriage-07', 'belzutifan reference standard', '1802220-02-5'],  // REAL
  ['castriage-08', 'belzutifan reference standard', '1672668-24-4'],  // REAL
  ['castriage-09', 'asciminib', '1492952-26-7'],                 // REAL
  ['castriage-10', 'asciminib', '1492952-76-7'],                 // REAL
  ['castriage-11', 'n-desmethyl enzalutamide', '915087-27-3'],   // REAL
  ['castriage-12', 'n-desmethyl enzalutamide', '915095-89-5'],   // REAL
  ['castriage-13', 'leuprolide', '53714-56-0'],                  // synthetic form pair
  ['castriage-14', 'leuprolide acetate', '74381-53-6'],          // synthetic form pair
  ['castriage-15', 'someprofen', '22222-22-6'],                  // control: one number, no conflict
  ['castriage-16', 'badcas', '11111-11-1'],                      // control: checksum-invalid
  ['castriage-17', 'badcas', '33333-33-9'],                      // control: checksum-invalid
];

const EXPECTED = {
  total: 7,
  byClass: {
    form_pair: 1, grade_duplicate: 1, cross_attached: 2, digit_adjacent: 1, unexplained: 2,
  },
  needsHuman: 5,
};

async function main() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: false });
  const insertedIds = [];

  try {
    // NO FIXTURE DDL. A hand-written study_molecules shadows the real one, and
    // `CREATE TABLE IF NOT EXISTS` in the real migration then skips it — a trap this repo has
    // already paid for once. The research-intelligence tables are their own exported migration,
    // so it is called by name; the DDL stays in db.js.
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'REPLACE_ME_NOT_A_SECRET';
    process.env.ADMIN_EMAIL = 'fixture-admin@example.invalid';
    process.env.ADMIN_PASSWORD = 'REPLACE_ME_NOT_A_SECRET';
    const db = require('../src/lib/db');
    await db.initDB();
    if (db.migrateSchemas) await db.migrateSchemas();
    await db.migrateResearchIntelligence();

    const shape = await pool.query(
      "SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_name = 'study_molecules'");
    if (shape.rows[0].n > 4) {
      ok(`study_molecules built by the real migration (${shape.rows[0].n} columns, not a stub)`);
    } else {
      bad('the real schema must build the table', `${shape.rows[0].n} columns — this looks like a stub`);
      return;
    }

    // Record every id as it is inserted, so cleanup removes exactly these rows and nothing else.
    const before = (await pool.query('SELECT COUNT(*)::int n FROM study_molecules')).rows[0].n;
    for (const [id, name, cas] of FIXTURES) {
      await pool.query(
        'INSERT INTO study_molecules (id, study_id, molecule_name, cas_number) VALUES ($1,$1,$2,$3)',
        [id, name, cas],
      );
      insertedIds.push(id);
    }
    ok(`seeded ${insertedIds.length} fixture rows, recorded by id (table held ${before} before)`);

    // Run the real script, as a separate process, reading its EXIT CODE.
    let out = ''; let code = 0;
    try {
      out = execFileSync('node', ['scripts/cas-conflict-triage.js'], {
        env: { ...process.env, DATABASE_URL: url },
        encoding: 'utf8',
        cwd: process.cwd(),
      });
    } catch (e) {
      code = e.status === undefined ? 1 : e.status;
      out = `${e.stdout || ''}${e.stderr || ''}`;
    }
    if (code !== 0) bad(`triage script exited ${code}`, out);
    else ok('triage script exited 0');

    // Parse the classification block rather than trusting prose.
    const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : null; };
    const got = {
      total: num(/^\s*(\d+)\s+total\s*$/m),
      needsHuman: num(/^\s*(\d+)\s+NEED A HUMAN RULING\s*$/m),
      byClass: {
        form_pair: num(/^\s*(\d+)\s+form_pair\b/m),
        grade_duplicate: num(/^\s*(\d+)\s+grade_duplicate\b/m),
        cross_attached: num(/^\s*(\d+)\s+cross_attached\b/m),
        digit_adjacent: num(/^\s*(\d+)\s+digit_adjacent\b/m),
        unexplained: num(/^\s*(\d+)\s+unexplained\b/m),
      },
    };

    if (got.total === EXPECTED.total) ok(`conflicting groups = ${got.total} (hand-computed)`);
    else bad(`conflicting groups: expected ${EXPECTED.total}, got ${got.total}`, out);

    for (const [c, want] of Object.entries(EXPECTED.byClass)) {
      if (got.byClass[c] === want) ok(`${c} = ${want}`);
      else bad(`${c}: expected ${want}, got ${got.byClass[c]}`);
    }
    if (got.needsHuman === EXPECTED.needsHuman) ok(`needing a human = ${EXPECTED.needsHuman}`);
    else bad(`needing a human: expected ${EXPECTED.needsHuman}, got ${got.needsHuman}`);

    // ── NEGATIVE CONTROLS ──────────────────────────────────────────────────
    // Each proves a filter is load-bearing. Without these the counts above could be right by
    // accident.
    if (!/someprofen/.test(out)) ok('NEGATIVE CONTROL: a single-CAS name is not reported as a conflict');
    else bad('someprofen (one valid CAS) was reported as a conflict', out);

    if (!/badcas/.test(out)) ok('NEGATIVE CONTROL: a name whose every CAS fails the checksum is not a conflict');
    else bad('badcas (two INVALID numbers) was reported as a conflict', out);

    if (!/11111-11-1|33333-33-9/.test(out)) ok('NEGATIVE CONTROL: checksum-invalid numbers never reach the report');
    else bad('an invalid CAS number appeared in the report', out);

    // The grade variant must be named as a duplicate of its parent, not counted as fresh work.
    if (/grade_duplicate/.test(out) && /belzutifan reference standard/.test(out)) {
      ok('the grade variant is reported and classed as a duplicate');
    } else bad('the belzutifan grade variant was not reported as a grade_duplicate', out);

    // The report must say, in the report, that it changed nothing.
    if (/No identity was changed\. No row was written\./.test(out)) {
      ok('the report states that no identity was changed and no row written');
    } else bad('the report does not state its read-only guarantee', out);

    // Row counts must survive the classifier. They were dropped once, and the report printed
    // "rows: undefined" for every group — numbers nobody could check.
    if (!/rows\s*:\s*undefined/.test(out)) ok('every reported group carries a row count');
    else bad('the report printed "rows: undefined" — the classifier dropped the field', out);

    // DETERMINISM: identical data must produce an identical report. The GROUP BY has no ORDER BY,
    // so without explicit sorting two runs reshuffle the numbers and a diff shows changes that
    // are not changes.
    let out2 = '';
    try {
      out2 = execFileSync('node', ['scripts/cas-conflict-triage.js'], {
        env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', cwd: process.cwd(),
      });
    } catch (e) { out2 = `${e.stdout || ''}${e.stderr || ''}`; }
    const strip = (s) => s.replace(/^\s*generated\s*:.*$/m, '').replace(/^\s*database\s*:.*$/m, '');
    if (strip(out) === strip(out2)) ok('DETERMINISM: two runs over identical data print an identical report');
    else bad('two runs over identical data printed different reports — ordering is unstable');

    // ── READ-ONLY PROOF: the script must not have altered the fixture rows ──
    const after = await pool.query(
      'SELECT COUNT(*)::int n FROM study_molecules WHERE id = ANY($1)', [insertedIds],
    );
    if (after.rows[0].n === insertedIds.length) {
      ok(`all ${insertedIds.length} fixture rows survived the triage run unchanged in count`);
    } else {
      bad(`the triage run changed the row count: ${after.rows[0].n} of ${insertedIds.length} remain`);
    }

    // And that the script contains no mutating statement at all.
    const src = fs.readFileSync('scripts/cas-conflict-triage.js', 'utf8');
    const sqlish = src.match(/`[^`]*\bSELECT\b[^`]*`/gi) || [];
    const mutating = sqlish.filter((s) => /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\b/i.test(s));
    if (!mutating.length) ok('no SQL literal in the triage script contains a mutating verb');
    else bad(`${mutating.length} SQL literal(s) in the triage script mutate`, mutating.join('\n'));
  } finally {
    // Delete exactly what was created, by id. Then assert MY FIXTURES are gone — never that the
    // table is empty, which is a statement that becomes false the moment the product is used.
    try {
      for (const id of insertedIds) {
        await pool.query('DELETE FROM study_molecules WHERE id = $1', [id]);
      }
      if (insertedIds.length) {
        const mine = await pool.query(
          'SELECT COUNT(*)::int n FROM study_molecules WHERE id = ANY($1)', [insertedIds],
        );
        if (mine.rows[0].n) {
          console.log(`  FAIL  LEAK: ${mine.rows[0].n} fixture row(s) remain`);
          fail++;
        } else {
          ok('cleanup: every fixture row removed by id, zero leaked');
        }
      }
    } catch (e) {
      console.log(`  FAIL  cleanup error: ${e.message}`);
      fail++;
    }
    await pool.end();
  }
}

main()
  .then(() => {
    stopTemp();
    console.log(fail ? `\nFAIL  cas triage db check: ${fail} failure(s)` : '\nPASS  cas triage db check');
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => {
    stopTemp();
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(1);
  });
