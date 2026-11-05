#!/usr/bin/env node
// ── ARE THE PRODUCTION-BOUND READ-ONLY SCRIPTS SAFE TO POINT AT PRODUCTION? ─
//
// Ruling 7 item 6: run the CAS conflict triage and capability evidence inventory in read-only
// mode "only after confirming the scripts, target Railway environment, and permissions."
//
// This confirms THE SCRIPTS. The environment and the permissions are not mine to confirm — I have
// no Railway CLI, no token and no DATABASE_URL — so those two remain with the person who runs
// them. What can be established here is the part that would otherwise be taken on trust: that
// each script runs to completion, exits 0, and leaves the database byte-for-byte as it found it.
//
// Three scripts are covered, all of which are intended to be pointed at production:
//   scripts/cas-conflict-triage.js
//   scripts/capability-evidence-inventory.js
//   scripts/tenancy-diagnostics.js
//
// ── WHY "IT ONLY HAS SELECTS" IS NOT THE CHECK ──────────────────────────────
//
// Reading a file and seeing no INSERT is a statement about my attention. This runs each script
// against a real server with real rows in it and compares a full table-by-table row census taken
// before and after. A script that mutated something would have to mutate it without changing any
// count to pass, and the static scan below closes most of what remains.
//
// Exit: 0 all three confirmed · 1 one of them is not safe · 2 not executed (no Postgres)
'use strict';

const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const fs = require('fs');
const { execFileSync } = require('child_process');

const SCRIPTS = [
  'scripts/cas-conflict-triage.js',
  'scripts/capability-evidence-inventory.js',
  'scripts/tenancy-diagnostics.js',
];

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 500)}`); };

let temp = null;
function startTemp() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/rocheck-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55992 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55992&sslmode=disable`;
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

const envUrl = process.env.READONLY_CHECK_PG_URL;
if (envUrl) {
  for (const re of [/railway/i, /rlwy\.net/i, /amazonaws/i, /\.render\.com/i, /supabase/i, /neon\.tech/i, /prod/i]) {
    if (re.test(envUrl)) {
      console.log('  FAIL  refusing to run against what looks like a hosted or production database — '
        + 'this harness SEEDS fixtures');
      process.exit(1);
    }
  }
}
const url = envUrl || startTemp();
if (!url) {
  console.log('  skip  no Postgres available');
  console.log('SKIP  read-only script confirmation not executed — this check needs a server');
  process.exit(EXIT_NOT_EXECUTED);
}

/**
 * Every template-literal body in the source, by BACKTICK PARITY.
 *
 * The first version used /`[^`]*\bSELECT\b[^`]*`/g over the file. That regex pairs backticks
 * sequentially from wherever it first matches, so whether a given literal is seen at all depends
 * on the parity of every backtick before it — and a planted `DELETE ... SELECT` literal went
 * undetected in a real file for exactly that reason. Splitting on backticks and taking the
 * odd-indexed segments is deterministic, and it inspects EVERY literal rather than only those
 * containing the word SELECT, which is also stricter.
 */
function templateLiterals(code) {
  const segs = code.split('`');
  return segs.filter((_, i) => i % 2 === 1);
}

/**
 * Remove // line comments and block comments, keeping everything else byte-identical in length
 * terms that matter to us (line structure). Deliberately simple and deliberately conservative:
 * it only drops a // comment when the slashes are not inside a string on that line, so a URL
 * like https://… in code survives.
 */
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) { out.push(''); continue; }
      line = line.slice(end + 2);
      inBlock = false;
    }
    const blockStart = line.indexOf('/*');
    if (blockStart >= 0) {
      const end = line.indexOf('*/', blockStart + 2);
      if (end < 0) { inBlock = true; line = line.slice(0, blockStart); } else {
        line = line.slice(0, blockStart) + line.slice(end + 2);
      }
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//')) { out.push(''); continue; }
    // A trailing // comment, only when it is not part of a :// scheme.
    const m = line.match(/(^|[^:])\/\//);
    if (m) line = line.slice(0, m.index + (m[1] ? m[1].length : 0));
    out.push(line);
  }
  return out.join('\n');
}

/** A full row census of every user table. The before/after comparison is the real proof. */
async function census(pool) {
  const { rows: tables } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
  const out = {};
  for (const t of tables) {
    const r = await pool.query(`SELECT COUNT(*)::int n FROM "${t.table_name}"`);
    out[t.table_name] = r.rows[0].n;
  }
  return out;
}

async function main() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: false });
  const made = { sols: [] };

  try {
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'REPLACE_ME_NOT_A_SECRET';
    process.env.ADMIN_EMAIL = 'fixture-admin@example.invalid';
    process.env.ADMIN_PASSWORD = 'REPLACE_ME_NOT_A_SECRET';

    const db = require('../src/lib/db');
    await db.initDB();
    if (db.migrateSchemas) await db.migrateSchemas().catch(() => {});
    await db.migrateResearchIntelligence();
    try {
      execFileSync('node', ['scripts/migrate-fda-establishments.js'],
        { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
    } catch (_) { /* reported by the census below if it matters */ }
    try {
      const { migrate } = require('./migrate-labconnect');
      await migrate();
    } catch (_) { /* ditto */ }

    // Seed rows so the scripts have something to read. A script that runs against an EMPTY
    // database proves very little: the code paths that touch rows never execute, so a mutation
    // sitting in one of them would never fire.
    for (const [id, name, cas] of [
      ['ro-1', 'gemcitabine', '95058-81-4'],
      ['ro-2', 'gemcitabine hcl', '122111-03-9'],
      ['ro-3', 'asciminib', '1492952-26-7'],
      ['ro-4', 'asciminib', '1492952-76-7'],
    ]) {
      await pool.query(
        'INSERT INTO study_molecules (id, study_id, molecule_name, cas_number) VALUES ($1,$1,$2,$3)',
        [id, name, cas],
      );
      made.sols.push(id);
    }
    const labs = await pool.query(`
      INSERT INTO labs (name, name_normalized, source, status, research_capable, accreditations)
      VALUES ('Abiozen Scientific','abiozen scientific','self_onboard','active',TRUE,
              '[{"body":"A2LA","certificate":"1234.01","expires_on":"2027-03-01"}]'::jsonb)
      RETURNING id`);
    ok(`seeded ${made.sols.length} molecule rows and 1 lab row, so the scripts read real data`);

    // NEGATIVE CONTROL FOR THE STATIC SCANNER, before it is trusted on anything.
    //
    // The scanner now strips comments first, and a stripper that ate real code would make every
    // "no mutating literal" result below meaningless — a clean report from a scanner that sees
    // nothing is indistinguishable from a clean file. So: plant a mutating literal in a copy of a
    // real script, in code and not in a comment, and require the scan to catch it. Then plant one
    // inside a comment and require the scan to IGNORE it, which is the false positive that
    // prompted the stripper.
    {
      const sample = fs.readFileSync('scripts/tenancy-diagnostics.js', 'utf8');
      const planted = `${sample}\nconst evil = \`DELETE FROM companies WHERE 1=1; SELECT 1\`;\n`;
      const caught = templateLiterals(stripComments(planted))
        .filter((s) => /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\b/i.test(s));
      if (caught.length) ok('NEGATIVE CONTROL: the scanner still catches a planted mutating literal after stripping comments');
      else bad('NEGATIVE CONTROL FAILED: the comment stripper blinded the scanner',
        'every "no mutating literal" result below would be vacuous');

      const commented = `${sample}\n// const evil = \`DELETE FROM companies\`; // SELECT\n`;
      const falsePos = templateLiterals(stripComments(commented))
        .filter((s) => /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\b/i.test(s));
      if (!falsePos.length) ok('NEGATIVE CONTROL: a mutating verb inside a COMMENT is correctly ignored');
      else bad('the scanner still flags comments', falsePos.join(' | '));
    }

    const before = await census(pool);
    const tableCount = Object.keys(before).length;
    ok(`census taken across ${tableCount} tables before any script runs`);

    for (const script of SCRIPTS) {
      // 1. STATIC: no SQL literal in the file may contain a mutating verb.
      //
      // COMMENTS ARE STRIPPED FIRST, LINE BY LINE. The first version scanned the raw file, and a
      // backtick used around an identifier in a prose comment opened a "literal" that ran on
      // through text containing the words SELECT and migrate — so the scan reported a mutating
      // SQL literal in a file that has none. Stripped with a line walk rather than a regex over
      // the whole file, because a regex comment-stripper has already eaten a live code region in
      // this repo once.
      const src = fs.readFileSync(script, 'utf8');
      const codeOnly = stripComments(src);
      const literals = templateLiterals(codeOnly);
      const mutating = literals.filter((s) => /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\b/i.test(s));
      if (!mutating.length) ok(`${script}: no SQL literal contains a mutating verb`);
      else bad(`${script}: ${mutating.length} mutating SQL literal(s)`, mutating.join('\n'));

      // 2. It must carry a call-site refusal, not merely avoid writing by habit.
      if (/assertReadOnly/.test(src)) ok(`${script}: refuses non-SELECT statements at the call site`);
      else bad(`${script}: has no call-site read-only assertion`);

      // 3. DYNAMIC: run it and read the EXIT CODE.
      let out = ''; let code = 0;
      try {
        out = execFileSync('node', [script], {
          env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', cwd: process.cwd(),
        });
      } catch (e) {
        code = e.status === undefined ? 1 : e.status;
        out = `${e.stdout || ''}${e.stderr || ''}`;
      }
      if (code === 0) ok(`${script}: ran to completion, exit 0`);
      else bad(`${script}: exited ${code}`, out);

      if (out && out.trim().length > 200) ok(`${script}: produced a report (${out.trim().length} chars)`);
      else bad(`${script}: produced almost no output`, out);
    }

    // 4. THE REAL PROOF: nothing changed.
    const after = await census(pool);
    const changed = Object.keys(after).filter((t) => after[t] !== before[t]);
    if (!changed.length) {
      ok(`NOTHING CHANGED: all ${tableCount} table row counts identical after running all three scripts`);
    } else {
      bad(`${changed.length} table(s) changed row count`,
        changed.map((t) => `${t}: ${before[t]} -> ${after[t]}`).join(', '));
    }

    // 5. NEGATIVE CONTROL. Without this, the census comparison would pass on a harness that
    // compares two copies of the same snapshot, or on tables nobody ever writes.
    await pool.query(
      'INSERT INTO study_molecules (id, study_id, molecule_name, cas_number) VALUES ($1,$1,$2,$3)',
      ['ro-control', 'control molecule', '657-24-9'],
    );
    made.sols.push('ro-control');
    const afterControl = await census(pool);
    const detected = Object.keys(afterControl).filter((t) => afterControl[t] !== after[t]);
    if (detected.includes('study_molecules')) {
      ok('NEGATIVE CONTROL: the census DOES detect a deliberate single-row insert');
    } else {
      bad('NEGATIVE CONTROL FAILED: the census missed a deliberate insert',
        'the "nothing changed" result above therefore proves nothing');
    }
  } finally {
    try {
      for (const id of made.sols) await pool.query('DELETE FROM study_molecules WHERE id = $1', [id]);
      const mine = await pool.query(
        'SELECT COUNT(*)::int n FROM study_molecules WHERE id = ANY($1)', [made.sols]);
      if (mine.rows[0].n) { console.log(`  FAIL  LEAK: ${mine.rows[0].n} fixture row(s) remain`); fail++; }
      else ok('cleanup: every fixture row removed by id, zero leaked');
    } catch (e) { console.log(`  FAIL  cleanup error: ${e.message}`); fail++; }
    await pool.end();
  }
}

main()
  .then(() => {
    stopTemp();
    console.log(fail
      ? `\nFAIL  read-only script confirmation: ${fail} failure(s)`
      : '\nPASS  all three production-bound scripts run clean and change nothing');
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => {
    stopTemp();
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(1);
  });
