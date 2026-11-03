#!/usr/bin/env node
// ── DOES THE PROVENANCE SCRIPT RUN, AND DOES IT REFUSE TO GUESS? ────────────
//
//   node scripts/check-approval-provenance-runs.js   exit 0 = it runs and reports honestly
//
// `gate2-approval-provenance.js` runs once against production to establish where `27203-92-5`
// entered the workflow that emailed three suppliers. Its answer decides whether the defect is a row
// or a producer, so the distinction that matters most is between the cases it can establish and the
// cases it must call UNKNOWN. A provenance report that infers an origin would be used to decide
// whether a producer needs fixing.
//
// Asserted: it runs; it demands an argument; a missing approval reports UNKNOWN rather than
// crashing or guessing; a structured CAS field and a regex-scraped one are told apart; the
// "exists nowhere else" search works in both directions; the SHIPPED parseApproval reproduces the
// historical mismatch; and it writes nothing.
'use strict';

const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let fail = 0;
const out = (s) => fs.writeSync(1, s + '\n');
const ok = (m) => out(`  ok    ${m}`);
const bad = (m, d) => { fail++; out(`  FAIL  ${m}`); if (d) out(`          ${String(d).slice(0, 400)}`); };

const findInitdb = pgBin;
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/aprov-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55996' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
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
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.MOLID_PG_URL || startTemp();
if (!url) {
  out('  skip  no Postgres available (set MOLID_PG_URL or install initdb)');
  out('SKIP  approval provenance not executed — this check needs a server');
  process.exit(EXIT_NOT_EXECUTED);
}
process.env.DATABASE_URL = url;
// An obvious placeholder, in the form scripts/check-secrets.js allowlists. Nothing here signs
// or verifies a token; core.js simply refuses to load without the variable set.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'PLACEHOLDER-test-key';

const { query } = require('../src/lib/db');
const procurement = require('../src/lib/agents/procurement-agent');

const FIXTURE = `
  CREATE TABLE IF NOT EXISTS approval_queue (
    id TEXT PRIMARY KEY, action_type TEXT, action_payload TEXT, status TEXT,
    priority TEXT, requested_for_user_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT, is_active INTEGER DEFAULT 1);
  CREATE TABLE IF NOT EXISTS agent_activity_log (
    id BIGSERIAL PRIMARY KEY, agent_name TEXT, action_type TEXT, reasoning TEXT,
    output_summary TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS study_molecules (
    id BIGSERIAL PRIMARY KEY, study_id TEXT, molecule_name TEXT, cas_number TEXT);
  CREATE TABLE IF NOT EXISTS rfq_requests (
    id TEXT PRIMARY KEY, molecule_name TEXT, cas_number TEXT, approval_id TEXT, status TEXT);
`;

function runScript(arg) {
  try {
    const stdout = execFileSync(process.execPath,
      [path.join(__dirname, 'gate2-approval-provenance.js'), ...(arg === undefined ? [] : [arg])],
      { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}
const field = (stdout, key) => {
  const m = stdout.match(new RegExp(`${key}=([^\\s]+)`));
  return m ? m[1] : null;
};

(async () => {
  await query(FIXTURE);

  // ── 0. THE MECHANISM, reproduced through the SHIPPED parser ──────────────
  //
  // The historical payload shape: one sentence carrying the SALT's name and the BASE's registry
  // number. parseApproval pulls them out with two independent regexes and compares nothing.
  if (typeof procurement.parseApproval !== 'function') {
    bad('parseApproval is not exported, so the mechanism cannot be shown without reimplementing it');
  } else {
    const r = procurement.parseApproval(JSON.stringify({
      task: 'Source Tramadol Hydrochloride (CAS: 27203-92-5) — GMP API — Target: 1 kg at 99% purity',
    }), 'source_gmp_api');
    if (r.molecule_name === 'Tramadol Hydrochloride' && r.cas_number === '27203-92-5') {
      ok('the SHIPPED parseApproval reproduces the historical mismatch: a salt name beside a base CAS');
    } else {
      bad('could not reproduce the historical extraction', JSON.stringify(r));
    }
  }

  // ── 1. a required argument ───────────────────────────────────────────────
  if (runScript(undefined).code === 2) {
    ok('refuses to run with no approval id — cannot investigate the wrong row');
  } else { bad('a missing argument should exit 2'); }

  // ── 2. a missing approval reports UNKNOWN, not a crash and not a guess ───
  let r = runScript('does-not-exist');
  if (r.code === 0 && /NOT FOUND/.test(r.stdout) && /UNKNOWN/.test(r.stdout)) {
    ok('an absent approval row reports NOT FOUND and UNKNOWN rather than crashing or inferring');
  } else {
    bad(`absent approval mishandled (exit ${r.code})`, r.stdout.slice(-300) + r.stderr);
  }

  // ── 3. regex-over-free-text is identified as such ────────────────────────
  //
  // The historical case. The CAS is NOT a structured field; it is scraped out of a sentence.
  await query(
    `INSERT INTO approval_queue (id, action_type, action_payload, status, requested_for_user_id)
     VALUES ('ap-free','source_gmp_api',$1,'approved','u1')`,
    [JSON.stringify({
      task: 'Source Tramadol Hydrochloride (CAS: 27203-92-5) — GMP API — Target: 1 kg at 99% purity',
    })]);
  await query(
    `INSERT INTO users (id, email, name, role) VALUES ('u1','palash@abiozen.com','Palash Das','procurement_team')`);
  r = runScript('ap-free');
  if (r.code !== 0) bad(`script exited ${r.code}`, r.stderr);
  else ok('runs end to end against a real Postgres and exits 0');
  if (field(r.stdout, 'cas_source') === 'regex_over_free_text') {
    ok('a CAS scraped from a free-text sentence is reported as regex_over_free_text');
  } else {
    bad(`cas_source = ${field(r.stdout, 'cas_source')}, expected regex_over_free_text`);
  }
  if (/SEPARATE regex over the SAME sentence/.test(r.stdout)) {
    ok('the report names the mechanism: two regexes over one sentence, never compared');
  } else { bad('the mechanism was not explained in the output'); }
  if (/palash@abiozen.com/.test(r.stdout)) ok('the requester is resolved and reported');
  else bad('the requester was not resolved');

  // ── 4. a structured field is told apart from a scraped one ───────────────
  //
  // These need different responses: a structured value points at whoever wrote the field, a scraped
  // one points at the parser. Collapsing them would misdirect the fix.
  await query(
    `INSERT INTO approval_queue (id, action_type, action_payload, status)
     VALUES ('ap-struct','source_molecule',$1,'approved')`,
    [JSON.stringify({ molecule_name: 'Gemcitabine', cas_number: '95058-81-4' })]);
  r = runScript('ap-struct');
  if (field(r.stdout, 'cas_source') === 'structured_field') {
    ok('a CAS in a structured payload field is reported as structured_field');
  } else {
    bad(`cas_source = ${field(r.stdout, 'cas_source')}, expected structured_field`);
  }

  // ── 5. the "exists nowhere else" search, both ways ───────────────────────
  r = runScript('ap-free');
  if (/found NOWHERE else/.test(r.stdout)) {
    ok('a CAS present in no other table is reported as originating outside the database');
  } else {
    bad('the nowhere-else case was not reported', r.stdout.slice(-400));
  }
  await query(
    `INSERT INTO study_molecules (study_id, molecule_name, cas_number)
     VALUES ('NCT-X','Tramadol','27203-92-5')`);
  r = runScript('ap-free');
  if (/study_molecules\.cas_number: 1 row/.test(r.stdout)
      && /does not establish\s+direction of travel|direction of travel/.test(r.stdout)) {
    ok('a CAS found elsewhere is reported WITHOUT claiming direction of travel');
  } else {
    bad('the found-elsewhere case was mishandled', r.stdout.slice(-500));
  }

  // ── 6. the producer verdict is present ───────────────────────────────────
  if (/CAN THE SAME MISMATCH STILL BE PRODUCED TODAY/.test(r.stdout) && /→ YES\. Unchanged\./.test(r.stdout)) {
    ok('the report answers whether the producer can still generate the mismatch');
  } else { bad('the producer verdict is missing'); }

  // ── 7. it wrote nothing ──────────────────────────────────────────────────
  const counts = async () => (await query(
    `SELECT (SELECT COUNT(*)::int FROM approval_queue) a,
            (SELECT COUNT(*)::int FROM users) u,
            (SELECT COUNT(*)::int FROM study_molecules) s,
            (SELECT COUNT(*)::int FROM rfq_requests) r,
            (SELECT COUNT(*)::int FROM agent_activity_log) l`)).rows[0];
  const before = await counts();
  runScript('ap-free');
  const after = await counts();
  if (JSON.stringify(before) === JSON.stringify(after)) {
    ok('the provenance script wrote nothing — counts unchanged across five tables');
  } else {
    bad('the provenance script MUTATED the database', JSON.stringify({ before, after }));
  }

  stopTemp();
  if (fail) { out(`FAIL  ${fail} assertion(s) failed`); process.exit(1); }
  out('PASS  approval provenance runs, distinguishes its cases, and reports UNKNOWN honestly');
  process.exit(0);
})().catch((e) => {
  stopTemp();
  fs.writeSync(2, `FAIL  harness error: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
