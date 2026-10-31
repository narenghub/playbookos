#!/usr/bin/env node
// ── DOES THE DEPLOYMENT VALIDATOR PROVE WHAT IT CLAIMS? ─────────────────────
//
//   node scripts/check-rfq-guard-validation-runs.js    exit 0 = the validator is trustworthy
//
// `validate-rfq-guard-deployed.js` runs once against production and its verdict is what closes the
// interim RFQ guard. Two things about it need proving before it is believed:
//
//   1. IT WRITES NOTHING DURABLE. It inserts one synthetic decision row to prove the append-only
//      trigger behaviourally — an empty table cannot prove it, because the trigger is FOR EACH ROW
//      and a zero-row UPDATE succeeds trivially — and that insert lives inside a transaction that
//      is deliberately rolled back. If the rollback ever failed, the row could NOT be removed
//      afterwards, because the table is append-only. So the rollback is asserted, not assumed.
//
//   2. IT CAN GO RED. Drop the trigger, drop the table, or alter the historical Tramadol row, and
//      the validator must fail for that reason. A validator that cannot fail is a formality.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let fail = 0;
const out = (s) => fs.writeSync(1, s + '\n');
const ok = (m) => out(`  ok    ${m}`);
const bad = (m, d) => { fail++; out(`  FAIL  ${m}`); if (d) out(`          ${String(d).slice(0, 400)}`); };

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { const p = path.join(d, 'initdb'); if (fs.existsSync(p)) return d; }
  return null;
}
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/rfqval-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55998' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55998 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55998&sslmode=disable`;
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
  out('SKIP  validator not executed — this check needs a server');
  process.exit(0);
}
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'PLACEHOLDER-test-key';

const REPO = path.join(__dirname, '..');
const { query } = require('../src/lib/db');
const guard = require('../src/lib/procurement/rfq-identity-guard');
const { DDL_TABLES, DDL_TRIGGERS, applyConflictKinds, applyDriftColumns } = require('./migrate-molecules');

// Production's shapes, exactly: sent_at/replied_at TEXT, claimed_at TIMESTAMPTZ.
const FIXTURE = `
  CREATE TABLE IF NOT EXISTS rfq_requests (
    id TEXT PRIMARY KEY, molecule_name TEXT NOT NULL, cas_number TEXT, target_quantity TEXT,
    target_purity TEXT, gmp_required INTEGER DEFAULT 0, week_start TEXT, status TEXT,
    priority TEXT, approval_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS supplier_outreach_log (
    id TEXT PRIMARY KEY, rfq_id TEXT, supplier_id TEXT, email_sent_to TEXT, email_subject TEXT,
    email_body TEXT, sent_at TEXT, replied_at TEXT, reply_text TEXT, status TEXT,
    claimed_at TIMESTAMPTZ, error TEXT);
  CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY, name TEXT, region TEXT, specialties TEXT, reliability_score REAL,
    gmp_certified INTEGER DEFAULT 1, contact_email TEXT, contact_name TEXT);
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT, is_active INTEGER DEFAULT 1,
    whatsapp_number TEXT, created_at TEXT DEFAULT NOW(), excluded_from_scoring BOOLEAN DEFAULT FALSE);
  CREATE TABLE IF NOT EXISTS agent_activity_log (
    id TEXT PRIMARY KEY, agent_name TEXT, action_type TEXT, user_id TEXT, reasoning TEXT,
    source_kpi TEXT, confidence_score INTEGER, output_summary TEXT,
    requires_approval INTEGER DEFAULT 0, created_at TEXT DEFAULT NOW());
`;

function runValidator() {
  try {
    const stdout = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'validate-rfq-guard-deployed.js')],
      { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}
const decisionCount = async () => (await query(
  `SELECT COUNT(*)::int n FROM rfq_identity_decisions`)).rows[0].n;

(async () => {
  await query(DDL_TABLES);
  await query(DDL_TRIGGERS);
  await applyConflictKinds(query);
  await applyDriftColumns(query, () => {});
  await query(FIXTURE);
  await guard.migrate(query);

  // The historical record the validator must find unchanged.
  await query(
    `INSERT INTO rfq_requests (id, molecule_name, cas_number, week_start, status)
     VALUES ('hist-tramadol','Tramadol Hydrochloride','27203-92-5','2026-07-20','sent')
     ON CONFLICT (id) DO NOTHING`);
  await query(
    `INSERT INTO molecules (preferred_name, normalized_name, cas, substance_form, source, derivation_method)
     VALUES ('Tramadol hydrochloride','tramadol hydrochloride','36282-47-0','salt','fixture','exact')
     ON CONFLICT DO NOTHING`);
  await query(
    `INSERT INTO users (id,email,name,role) VALUES ('u-p','palash@abiozen.com','Palash Das','procurement_director')
     ON CONFLICT (id) DO NOTHING`);

  // ── 1. green on a correct deployment ────────────────────────────────────
  out('\n── 1. a correct deployment validates');
  const n0 = await decisionCount();
  let r = runValidator();
  if (r.code === 0) ok('the validator exits 0 against a correct fixture');
  else bad(`the validator failed on a correct fixture (exit ${r.code})`, r.stdout.slice(-900));
  for (const want of ['all 17 expected columns present', 'enabled', 'UPDATE on a real row is refused',
    'DELETE on a real row is refused', 'rolled back', 'the guard is wired',
    'preserved, not corrected']) {
    if (r.stdout.includes(want)) ok(`proved: ${want}`);
    else bad(`the validator did not prove: ${want}`, r.stdout.slice(-500));
  }

  // ── 2. THE ROLLBACK, asserted ───────────────────────────────────────────
  out('\n── 2. the synthetic row leaves nothing behind');
  const n1 = await decisionCount();
  if (n1 === n0) ok(`rfq_identity_decisions is unchanged at ${n1} row(s) — the insert was rolled back`);
  else bad(`THE VALIDATOR LEFT ${n1 - n0} ROW(S) in an append-only table — they cannot be removed`);
  // And nothing with the synthetic marker survived, under any id.
  const residue = (await query(
    `SELECT COUNT(*)::int n FROM rfq_identity_decisions WHERE filed_name = '__validation__'`)).rows[0].n;
  if (residue === 0) ok('no row carrying the validation marker exists');
  else bad(`${residue} validation row(s) persisted`);

  // ── 3. it goes RED when the trigger is gone ─────────────────────────────
  out('\n── 3. negative control: the append-only trigger removed');
  await query('DROP TRIGGER trg_rfq_identity_decisions_append_only ON rfq_identity_decisions');
  r = runValidator();
  if (r.code !== 0 && /trigger is MISSING/.test(r.stdout)) {
    ok('a missing append-only trigger turns the validator RED for that reason');
  } else { bad(`validator stayed green without the trigger (exit ${r.code})`, r.stdout.slice(-500)); }
  // With the trigger gone, the UPDATE/DELETE proofs must ALSO fail — otherwise they were never
  // testing the trigger.
  if (/UPDATE was NOT refused/.test(r.stdout) && /DELETE was NOT refused/.test(r.stdout)) {
    ok('the UPDATE and DELETE proofs depend on the trigger, not on something else');
  } else { bad('the refusal proofs passed without a trigger — they prove nothing'); }
  // Restore, and confirm green again.
  for (const stmt of guard.DDL) await query(stmt);
  r = runValidator();
  if (r.code === 0) ok('restoring the trigger returns the validator to green');
  else bad(`validator not green after restoring the trigger (exit ${r.code})`, r.stdout.slice(-400));

  // ── 4. it goes RED when the table is gone ───────────────────────────────
  out('\n── 4. negative control: the table missing entirely');
  await query('ALTER TABLE rfq_identity_decisions RENAME TO rfq_identity_decisions_hidden');
  r = runValidator();
  if (r.code !== 0 && /DOES NOT EXIST|cannot read the required tables/.test(r.stdout)) {
    ok('a missing decisions table turns the validator RED');
  } else { bad(`validator stayed green with no table (exit ${r.code})`, r.stdout.slice(-400)); }
  await query('ALTER TABLE rfq_identity_decisions_hidden RENAME TO rfq_identity_decisions');

  // ── 5. it goes RED if history was altered ───────────────────────────────
  out('\n── 5. negative control: the historical Tramadol CAS "corrected"');
  await query(`UPDATE rfq_requests SET cas_number='36282-47-0' WHERE id='hist-tramadol'`);
  r = runValidator();
  if (r.code !== 0 && /no Tramadol RFQ carries the historical/.test(r.stdout)) {
    ok('silently correcting history turns the validator RED — history is asserted positively');
  } else { bad(`validator stayed green after history was rewritten (exit ${r.code})`, r.stdout.slice(-400)); }
  await query(`UPDATE rfq_requests SET cas_number='27203-92-5' WHERE id='hist-tramadol'`);

  // ── 6. green again, and still nothing written ───────────────────────────
  out('\n── 6. restoration');
  r = runValidator();
  if (r.code === 0) ok('the validator is green again after every control');
  else bad(`not green after restoration (exit ${r.code})`, r.stdout.slice(-500));
  const n2 = await decisionCount();
  if (n2 === n0) ok(`across ${6} validator runs, rfq_identity_decisions is still ${n2} row(s)`);
  else bad(`the decisions table grew to ${n2} across repeated validator runs`);
  const outreach = (await query(`SELECT COUNT(*)::int n FROM supplier_outreach_log`)).rows[0].n;
  if (outreach === 0) ok('no supplier claim or send was ever created by validation');
  else bad(`supplier_outreach_log holds ${outreach} row(s) after validation`);

  stopTemp();
  out('');
  if (fail) { out(`FAIL  ${fail} assertion(s) failed`); process.exit(1); }
  out('PASS  the deployment validator proves its claims, can go red, and writes nothing durable');
  process.exit(0);
})().catch((e) => {
  stopTemp();
  fs.writeSync(2, `FAIL  harness error: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
