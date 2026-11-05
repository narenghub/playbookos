#!/usr/bin/env node
// ── DOES THE EVIDENCE INVENTORY TELL THE TRUTH, AGAINST A REAL POSTGRES? ────
//
// evidence-inventory.test.js proves the classifier. This proves the SCRIPT against the real
// migrations: that it reads the real columns, classifies a bare boolean as a claim rather than a
// capability, never marks anything verified, and — the control that matters most — prints a row
// whose NAME DID NOT MATCH rather than reporting the entity as having no records.
//
// ── THE FIXTURE SET AND ITS HAND-COMPUTED ANSWER ───────────────────────────
//
//  labs row "Abiozen Scientific"  source='self_onboard'
//    accreditations: [ {A2LA, cert 1234.01, expires 2027-03-01},      → ATTESTED_SELF  → candidate
//                      {ISO 9001, cert OLD-1, expires 2020-01-01} ]   → EXPIRED        → NOT a candidate
//    research_capable = true, no evidence column behind it             → CLAIM_WITHOUT_EVIDENCE → gap
//    gmp_capable      = true, likewise                                → CLAIM_WITHOUT_EVIDENCE → gap
//    fei_number       = '3001234567'                                   → ATTESTED_SELF  → candidate
//
//  labs row "CRO 360 Inc"  — THE CONTROL.
//    The target name is 'CRO360'. matchTier('CRO360','CRO 360 Inc') is null: one space defeats it.
//    This row must appear under NEAR MISSES, and CRO360 must report IDENTITY UNCONFIRMED rather
//    than "no certifications". Reporting it as an absence is the failure this harness exists for.
//
//  Expected, by hand:
//    Abiozen Scientific — candidates 2 (the live accreditation + the FEI), verified 0,
//                         at least 2 CLAIM_WITHOUT_EVIDENCE gaps, 1 EXPIRED
//    CRO360             — candidates 0, verified 0, IDENTITY UNCONFIRMED, near miss printed
//    Both               — equipment/quality_system/certification/authorization = schema gaps
'use strict';

const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const fs = require('fs');
const { execFileSync } = require('child_process');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(`          ${String(d).slice(0, 700)}`);
};

let temp = null;
function startTemp() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/evinv-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55996' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55996 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55996&sslmode=disable`;
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

// This harness WRITES fixtures. Rule 7 — never perform the mutation you predict will be refused.
const envUrl = process.env.EVIDENCE_PG_URL;
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
  console.log('  skip  no Postgres available (install initdb or set EVIDENCE_PG_URL to a DISPOSABLE database)');
  console.log('SKIP  evidence inventory db check not executed — this check needs a server');
  process.exit(EXIT_NOT_EXECUTED);
}

async function main() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: false });
  const labIds = [];

  try {
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'REPLACE_ME_NOT_A_SECRET';
    process.env.ADMIN_EMAIL = 'fixture-admin@example.invalid';
    process.env.ADMIN_PASSWORD = 'REPLACE_ME_NOT_A_SECRET';

    // Real schema from the real migrations. No stubs: a hand-written labs table would drift from
    // the one the script actually reads, and `CREATE TABLE IF NOT EXISTS` would then skip the real
    // DDL — the trap this repo has already paid for once.
    const db = require('../src/lib/db');
    await db.initDB();
    // The FDA migration is a script, not a module, so it runs as a subprocess. Its failure used to
    // be swallowed here, which left the registration dimension untested while every check stayed
    // green — a silent hole is worse than a red check, so the exit code is read and the table's
    // presence asserted below.
    let fdaOut = ''; let fdaCode = 0;
    try {
      fdaOut = execFileSync('node', ['scripts/migrate-fda-establishments.js'],
        { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
    } catch (e) {
      fdaCode = e.status === undefined ? 1 : e.status;
      fdaOut = `${e.stdout || ''}${e.stderr || ''}`;
    }
    if (fdaCode !== 0) bad(`the FDA establishment migration exited ${fdaCode}`, fdaOut);
    else ok('FDA establishment migration applied');

    const { migrate } = require('./migrate-labconnect');
    await migrate();

    for (const t of ['labs', 'test_catalogue', 'lab_tests', 'fda_establishments']) {
      const p = (await pool.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables
           WHERE table_schema='public' AND table_name=$1) AS p`, [t])).rows[0].p;
      if (!p) { bad(`${t} was not created by the real migration`); return; }
    }
    ok('labs, test_catalogue and lab_tests built by the real migrations');

    // ── fixtures, recorded by id ─────────────────────────────────────────
    const a = await pool.query(
      `INSERT INTO labs (name, name_normalized, source, status, fei_number,
                         research_capable, gmp_capable, accreditations)
       VALUES ($1,$2,'self_onboard','active','3001234567', TRUE, TRUE, $3::jsonb)
       RETURNING id`,
      ['Abiozen Scientific', 'abiozen scientific', JSON.stringify([
        { body: 'A2LA', certificate: '1234.01', scope_url: 'https://example.invalid/scope', expires_on: '2027-03-01' },
        { body: 'ISO 9001', certificate: 'OLD-1', expires_on: '2020-01-01' },
      ])],
    );
    labIds.push(a.rows[0].id);

    // THE CONTROL: a real row for CRO360 under a name the matcher will not match.
    const b = await pool.query(
      `INSERT INTO labs (name, name_normalized, source, status, research_capable, accreditations)
       VALUES ($1,$2,'fda_register','discovered', TRUE, '[]'::jsonb) RETURNING id`,
      ['CRO 360 Inc', 'cro 360', ],
    );
    labIds.push(b.rows[0].id);
    ok(`seeded ${labIds.length} lab fixtures, recorded by id`);

    // ── run the real script, read its EXIT CODE ──────────────────────────
    let out = ''; let code = 0;
    try {
      out = execFileSync('node', ['scripts/capability-evidence-inventory.js'], {
        env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', cwd: process.cwd(),
      });
    } catch (e) {
      code = e.status === undefined ? 1 : e.status;
      out = `${e.stdout || ''}${e.stderr || ''}`;
    }
    if (code !== 0) bad(`inventory script exited ${code}`, out);
    else ok('inventory script exited 0');

    const section = (name) => {
      const i = out.indexOf(`ENTITY: ${name}`);
      if (i < 0) return '';
      const rest = out.slice(i + 1);
      const j = rest.indexOf('ENTITY: ');
      const k = rest.indexOf('WHAT THIS INVENTORY DOES NOT ESTABLISH');
      const end = [j, k].filter((x) => x >= 0).sort((x, y) => x - y)[0];
      return end === undefined ? rest : rest.slice(0, end);
    };
    const abiozen = section('Abiozen Scientific');
    const cro = section('CRO360');

    if (abiozen) ok('the report contains an Abiozen Scientific section');
    else bad('no Abiozen Scientific section in the report', out);

    // ── THE CENTRAL CONTROL: a failed name match is not an absence ────────
    if (/NEAR MISSES/.test(cro) && /CRO 360 Inc/.test(cro)) {
      ok('CONTROL: the unmatched "CRO 360 Inc" row is printed under NEAR MISSES');
    } else {
      bad('the unmatched row was NOT surfaced — a failed name match would read as "no records"', cro || out);
    }
    if (/IDENTITY UNCONFIRMED/.test(cro)) {
      ok('CONTROL: CRO360 reports IDENTITY UNCONFIRMED rather than an absence of capability');
    } else {
      bad('CRO360 did not report IDENTITY UNCONFIRMED', cro || out);
    }
    if (!/CRO360[\s\S]{0,400}holds no certification/i.test(cro)) {
      ok('CONTROL: the report never states that the entity holds no certifications');
    } else bad('the report asserted an absence of certifications', cro);

    // ── a boolean is not a capability ────────────────────────────────────
    if (/research_capable = true/.test(abiozen) && /CLAIM_WITHOUT_EVIDENCE/.test(abiozen)) {
      ok('a bare capability boolean is classified CLAIM_WITHOUT_EVIDENCE');
    } else bad('the capability booleans were not classified as claims', abiozen);

    // It must not appear in the verification queue.
    const queue = abiozen.slice(abiozen.indexOf('PROPOSED VERIFICATION QUEUE'));
    if (queue && !/research_capable = true/.test(queue)) {
      ok('NEGATIVE CONTROL: the bare boolean does NOT enter the verification queue');
    } else bad('a bare boolean entered the verification queue as a capability', queue);

    // ── evidence that IS evidence ────────────────────────────────────────
    if (/A2LA/.test(abiozen) && /ATTESTED_SELF/.test(abiozen)) {
      ok('the accreditation carrying a certificate number is attested');
    } else bad('the certificate-bearing accreditation was not attested', abiozen);

    if (/EXPIRED/.test(abiozen)) ok('the lapsed ISO 9001 entry is reported EXPIRED, not absent');
    else bad('the expired accreditation was not reported as EXPIRED', abiozen);

    if (queue && !/OLD-1/.test(queue)) {
      ok('NEGATIVE CONTROL: the EXPIRED accreditation does not enter the queue');
    } else bad('an expired accreditation entered the verification queue', queue);

    // ── nothing is ever verified ─────────────────────────────────────────
    const verifiedLines = out.match(/VERIFIED capabilities\s*:\s*(\d+)/g) || [];
    if (verifiedLines.length && verifiedLines.every((l) => /:\s*0$/.test(l.trim()))) {
      ok(`every entity reports VERIFIED capabilities: 0 (${verifiedLines.length} entities)`);
    } else bad('an entity reported a non-zero verified count', verifiedLines.join(' | ') || out);

    if (/status\s*:\s*pending/.test(abiozen)) ok('every queue candidate is pending');
    else bad('a queue candidate was not pending', abiozen);

    if (/verified_capabilities: TABLE NOT APPLIED/.test(out)) {
      ok('the report states that verified_capabilities is not applied');
    } else if (/verified_capabilities rows for this entity/.test(out)) {
      ok('verified_capabilities exists and was read');
    } else bad('the report says nothing about verified_capabilities', out);

    // ── structural absence is reported as a schema gap ───────────────────
    for (const dim of ['equipment', 'quality_system', 'certification', 'authorization']) {
      if (new RegExp(`${dim}[\\s\\S]{0,160}schema gap`).test(abiozen)) {
        ok(`${dim} reports UNKNOWN as a schema gap, not an empty search`);
      } else bad(`${dim} did not report its structural absence`, abiozen);
    }

    if (/no equipment record anywhere/.test(out)) ok('the report states there is no equipment record at all');
    else bad('the report does not state the equipment gap', out);

    // ── read-only, proven two ways ───────────────────────────────────────
    const survived = await pool.query('SELECT COUNT(*)::int n FROM labs WHERE id = ANY($1)', [labIds]);
    if (survived.rows[0].n === labIds.length) ok('all fixture rows survived the inventory run');
    else bad(`the run changed the row count: ${survived.rows[0].n} of ${labIds.length}`);

    const src = fs.readFileSync('scripts/capability-evidence-inventory.js', 'utf8');
    const sqlish = src.match(/`[^`]*\bSELECT\b[^`]*`/gi) || [];
    const mutating = sqlish.filter((s) => /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\b/i.test(s));
    if (!mutating.length) ok('no SQL literal in the inventory script contains a mutating verb');
    else bad(`${mutating.length} SQL literal(s) mutate`, mutating.join('\n'));
  } finally {
    // Delete exactly what was created, by id. Assert MY fixtures are gone — never that the table
    // is empty, which is a claim that becomes false the moment the product is used.
    try {
      for (const id of labIds) await pool.query('DELETE FROM labs WHERE id = $1', [id]);
      if (labIds.length) {
        const mine = await pool.query('SELECT COUNT(*)::int n FROM labs WHERE id = ANY($1)', [labIds]);
        if (mine.rows[0].n) { console.log(`  FAIL  LEAK: ${mine.rows[0].n} fixture row(s) remain`); fail++; }
        else ok('cleanup: every fixture row removed by id, zero leaked');
      }
    } catch (e) { console.log(`  FAIL  cleanup error: ${e.message}`); fail++; }
    await pool.end();
  }
}

main()
  .then(() => {
    stopTemp();
    console.log(fail ? `\nFAIL  evidence inventory db check: ${fail} failure(s)` : '\nPASS  evidence inventory db check');
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => {
    stopTemp();
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(1);
  });
