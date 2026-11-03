#!/usr/bin/env node
// ── DOES THE EVIDENCE SCRIPT RUN, AND CAN IT TELL A SEND FROM A CLAIM? ───────
//
//   node scripts/check-identity-evidence-runs.js     exit 0 = it runs and judges sends correctly
//
// `gate2-identity-evidence.js` runs ONCE against production, over an SSH connection that failed
// three distinct ways on 31 Oct, to answer a question with a commercial consequence: did an RFQ
// whose CAS contradicts the canonical identity actually reach a supplier? It gets one attempt, so
// every verdict class is exercised here first.
//
// What is asserted:
//
//   1. it EXECUTES — the defect that shipped to production was an undefined reference that only a
//      run could find, because node --check parses and this project has no linter.
//   2. REACHED_SUPPLIERS fires on a confirmed send, and ALSO on a supplier reply with no send row,
//      because a reply is proof of a send whatever the log says.
//   3. a CLAIMED-BUT-UNSENT row is NOT reported as reached. The claim is written BEFORE the email;
//      reading it as a send would manufacture a commercial-safety finding out of an attempt.
//   4. STATUS_SAYS_SENT_NO_LOG is distinguished from both — a status with no record is the lost-send
//      window the idempotency claim exists to close, and it is neither proof nor absence of proof.
//   5. it writes nothing.
//
// Point 3 is the one that matters most. The whole value of this script is that a person can act on
// its verdict, and a verdict that cannot tell "we tried" from "it went" is worse than no verdict.
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
  const base = fs.mkdtempSync('/var/tmp/idev-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55994' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55994 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55994&sslmode=disable`;
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
  out('SKIP  identity evidence not executed — this check needs a server');
  process.exit(EXIT_NOT_EXECUTED);
}
process.env.DATABASE_URL = url;

const { query } = require('../src/lib/db');
const { DDL_TABLES, DDL_TRIGGERS, applyConflictKinds, applyDriftColumns } = require('./migrate-molecules');

// Only the columns the script reads. It discovers them from information_schema, so a thin fixture
// exercises the discovery rather than defeating it.
const FIXTURE = `
  CREATE TABLE IF NOT EXISTS rfq_requests (
    id TEXT PRIMARY KEY, molecule_name TEXT NOT NULL, cas_number TEXT,
    week_start TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS supplier_outreach_log (
    id TEXT PRIMARY KEY, rfq_id TEXT, supplier_id TEXT, email_sent_to TEXT,
    email_subject TEXT, status TEXT, claimed_at TIMESTAMPTZ, sent_at TIMESTAMPTZ,
    replied_at TIMESTAMPTZ, error TEXT);
  CREATE TABLE IF NOT EXISTS rfq_responses (
    id TEXT PRIMARY KEY, rfq_id TEXT, supplier_name TEXT, price_per_kg REAL,
    lead_time_days INTEGER, created_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS inquiries (id TEXT PRIMARY KEY, molecule_name TEXT, cas_number TEXT);
  CREATE TABLE IF NOT EXISTS inquiry_quotes (id TEXT PRIMARY KEY, molecule_name TEXT, cas_number TEXT);
  CREATE TABLE IF NOT EXISTS molecule_pricing (
    id TEXT PRIMARY KEY, molecule_name TEXT NOT NULL, cas_number TEXT,
    price_per_kg_usd REAL, active INTEGER DEFAULT 1);
  CREATE TABLE IF NOT EXISTS study_molecules (
    id BIGSERIAL PRIMARY KEY, study_id TEXT, molecule_name TEXT NOT NULL, cas_number TEXT);
  CREATE TABLE IF NOT EXISTS supplier_products (
    id BIGSERIAL PRIMARY KEY, event_slug TEXT, contact_id BIGINT, product_name TEXT, cas TEXT);
`;

// Run the script in a child process so its process.exit cannot take this harness with it, and so
// stdout is captured exactly as an operator would see it.
function runScript(arg) {
  try {
    const stdout = execFileSync(process.execPath,
      [path.join(__dirname, 'gate2-identity-evidence.js'), arg],
      { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}
const verdictOf = (stdout) => {
  const m = stdout.match(/send_verdict=([A-Z_]+)/);
  return m ? m[1] : null;
};

(async () => {
  await query(DDL_TABLES);
  await query(DDL_TRIGGERS);
  await applyConflictKinds(query);
  await applyDriftColumns(query, () => {});
  await query(FIXTURE);

  // The real 31 Oct case: the RFQ's CAS and the canonical CAS disagree.
  await query(
    `INSERT INTO molecules (preferred_name, normalized_name, cas, source, derivation_method)
     VALUES ('Tramadol Hydrochloride','tramadol hydrochloride','36282-47-0','fixture','exact')`);
  await query(
    `INSERT INTO study_molecules (study_id, molecule_name, cas_number)
     VALUES ('NCT-TRAM','Tramadol Hydrochloride','36282-47-0')`);
  await query(
    `INSERT INTO rfq_requests (id, molecule_name, cas_number, week_start, status)
     VALUES ('rfq1','Tramadol Hydrochloride','27203-92-5','2026-10-26','pending')`);

  // ── 1. a required argument ───────────────────────────────────────────────
  const noArg = runScript('');
  if (noArg.code === 2) ok('refuses to run with no subject — cannot investigate the wrong substance');
  else bad(`missing argument should exit 2, got ${noArg.code}`);

  // ── 2. NOT_SENT: a claim-free RFQ ────────────────────────────────────────
  let r = runScript('tramadol');
  if (r.code !== 0) bad(`script exited ${r.code}`, r.stderr);
  else ok('runs end to end against a real Postgres and exits 0 having gathered evidence');
  if (verdictOf(r.stdout) === 'NOT_SENT') ok('an RFQ with no outreach row → NOT_SENT');
  else bad(`expected NOT_SENT, got ${verdictOf(r.stdout)}`);
  if (!/ISOLATED COMMERCIAL-SAFETY FINDING/.test(r.stdout)) {
    ok('no safety finding is raised when nothing was sent');
  } else {
    bad('a safety finding was raised for an RFQ that was never sent');
  }
  // It found the contradiction's two numbers without being told them.
  if (/canonical_cas=36282-47-0/.test(r.stdout) && /27203-92-5/.test(r.stdout)) {
    ok('both the canonical CAS and the filed RFQ CAS appear in the output');
  } else {
    bad('the two competing CAS values were not both reported');
  }

  // ── 3. ATTEMPTED_NOT_CONFIRMED: the claim is written BEFORE the email ────
  //
  // This is the assertion that protects against manufacturing a commercial-safety finding out of
  // an attempt. A 'pending' row means "we claimed the right to email", not "we emailed".
  await query(
    `INSERT INTO supplier_outreach_log (id, rfq_id, supplier_id, email_sent_to, status, claimed_at)
     VALUES ('o1','rfq1','sup1','a@example.com','pending',NOW())`);
  r = runScript('tramadol');
  if (verdictOf(r.stdout) === 'ATTEMPTED_NOT_CONFIRMED') {
    ok('a claimed-but-unsent outreach row → ATTEMPTED_NOT_CONFIRMED, not a send');
  } else {
    bad(`expected ATTEMPTED_NOT_CONFIRMED, got ${verdictOf(r.stdout)}`);
  }
  if (!/ISOLATED COMMERCIAL-SAFETY FINDING/.test(r.stdout)) {
    ok('a claim alone does not raise the commercial-safety finding');
  } else {
    bad('a mere claim raised the commercial-safety finding');
  }

  // A failed send is also not a send.
  await query(`UPDATE supplier_outreach_log SET status='failed', error='provider refused' WHERE id='o1'`);
  r = runScript('tramadol');
  if (verdictOf(r.stdout) === 'ATTEMPTED_NOT_CONFIRMED') ok('a failed send → ATTEMPTED_NOT_CONFIRMED');
  else bad(`expected ATTEMPTED_NOT_CONFIRMED for a failed send, got ${verdictOf(r.stdout)}`);

  // ── 4. STATUS_SAYS_SENT_NO_LOG: the lost-send window ─────────────────────
  await query(`DELETE FROM supplier_outreach_log WHERE id='o1'`);
  await query(`UPDATE rfq_requests SET status='sent' WHERE id='rfq1'`);
  r = runScript('tramadol');
  if (verdictOf(r.stdout) === 'STATUS_SAYS_SENT_NO_LOG') {
    ok('status implying a send with no outreach record → STATUS_SAYS_SENT_NO_LOG');
  } else {
    bad(`expected STATUS_SAYS_SENT_NO_LOG, got ${verdictOf(r.stdout)}`);
  }
  if (/POSSIBLY SENT/.test(r.stdout)) ok('the lost-send window is named as possibly sent, not as absence');
  else bad('the ambiguous case was not explained');

  // ── 5. REACHED_SUPPLIERS: a confirmed send ───────────────────────────────
  await query(
    `INSERT INTO supplier_outreach_log (id, rfq_id, supplier_id, email_sent_to, status, claimed_at, sent_at)
     VALUES ('o2','rfq1','sup1','a@example.com','sent',NOW(),NOW())`);
  r = runScript('tramadol');
  if (verdictOf(r.stdout) === 'REACHED_SUPPLIERS') ok('a confirmed send → REACHED_SUPPLIERS');
  else bad(`expected REACHED_SUPPLIERS, got ${verdictOf(r.stdout)}`);
  if (/ISOLATED COMMERCIAL-SAFETY FINDING/.test(r.stdout)) {
    ok('the commercial-safety finding is raised, loudly, on a confirmed send');
  } else {
    bad('a confirmed send did NOT raise the commercial-safety finding');
  }

  // ── 6. a reply proves a send even with no send row ───────────────────────
  await query(`DELETE FROM supplier_outreach_log WHERE id='o2'`);
  await query(`UPDATE rfq_requests SET status='pending' WHERE id='rfq1'`);
  await query(
    `INSERT INTO rfq_responses (id, rfq_id, supplier_name, price_per_kg)
     VALUES ('resp1','rfq1','Supplier A',120)`);
  r = runScript('tramadol');
  if (verdictOf(r.stdout) === 'REACHED_SUPPLIERS') {
    ok('a supplier reply proves a send even with no outreach row → REACHED_SUPPLIERS');
  } else {
    bad(`a reply should prove a send; got ${verdictOf(r.stdout)}`);
  }

  // ── 7. a missing table degrades, it does not abort ───────────────────────
  await query(`DROP TABLE research_interests`).catch(() => {});
  r = runScript('tramadol');
  if (r.code === 0 && /research-interest evidence/.test(r.stdout)) {
    ok('an absent table is reported and the rest of the evidence is still gathered');
  } else {
    bad('a missing table aborted the run', r.stderr);
  }

  // ── 8. it wrote nothing ──────────────────────────────────────────────────
  const counts = async () => (await query(
    `SELECT (SELECT COUNT(*)::int FROM molecules) m,
            (SELECT COUNT(*)::int FROM rfq_requests) r,
            (SELECT COUNT(*)::int FROM supplier_outreach_log) o,
            (SELECT COUNT(*)::int FROM rfq_responses) p,
            (SELECT COUNT(*)::int FROM molecule_conflicts) c,
            (SELECT COUNT(*)::int FROM molecule_aliases) a`)).rows[0];
  const before = await counts();
  runScript('tramadol');
  const after = await counts();
  if (JSON.stringify(before) === JSON.stringify(after)) {
    ok('the evidence script wrote nothing — counts unchanged across six tables');
  } else {
    bad('the evidence script MUTATED the database', JSON.stringify({ before, after }));
  }

  stopTemp();
  if (fail) { out(`FAIL  ${fail} assertion(s) failed`); process.exit(1); }
  out('PASS  identity evidence runs, tells a send from a claim, and writes nothing');
  process.exit(0);
})().catch((e) => {
  stopTemp();
  fs.writeSync(2, `FAIL  harness error: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
