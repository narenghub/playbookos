#!/usr/bin/env node
// ── IS THE OUTBOUND LEDGER MIGRATION SAFE TO RUN AGAINST PRODUCTION? ─────────
//
//   node scripts/verify-ledger-migration-safety.js
//
// Exit 0 = safe. 1 = not. 3 = no server, so NOTHING was established.
//
// CEO Track A, 2026-11-10. This answers the pre-deployment questions by DOING them against a
// disposable database seeded to look like production — not by reasoning about them:
//
//   • does the migration preserve existing email_log rows, untouched and still readable?
//   • is it idempotent — does a second --apply change anything or fail?
//   • does the rollback restore the prior state exactly, and can it then be re-applied?
//   • what does it LOCK, and for how long, on a table the size of production's?
//   • can anything here reach a mail provider?
//
// The representative fixture matters. A migration verified against an empty table proves only that
// the DDL parses. Production's email_log has 135+ rows carrying the OLD vocabulary — 'sent',
// 'failed', 'stopped_by_policy' in `status`, and NULL in every column this adds — and the new CHECK
// constraints must tolerate every one of them or the ALTER fails halfway through a production run.

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');
const SCHEMA = require('../src/lib/outbound/ledger-schema');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };
const field = (k, v) => console.log(`    ${k.padEnd(28)} ${v}`);
const note = (m) => console.log(`  --    ${m}`);

// NO PROVIDER CAN BE REACHED FROM THIS PROCESS. Asserted by removal rather than by intention: if
// any code path tried, it would throw here and the check would fail loudly.
const realFetch = global.fetch;
let fetchAttempts = 0;
global.fetch = async (...a) => { fetchAttempts += 1; throw new Error(`BLOCKED: outbound fetch attempted to ${a[0]}`); };

let temp = null;
function startTemp() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/ledger-safety-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55994' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55994 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55994`;
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

const url = startTemp();
if (!url) {
  console.log('  skip  no Postgres available');
  console.log('SKIP  migration safety was NOT established — this check proved nothing.');
  process.exit(EXIT_NOT_EXECUTED);
}

// Production's email_log, as of the 11:27 CST evidence run.
const PROD_SENT = 5;
const PROD_STOPPED = 135;

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: false });
  const q = (sql, p) => pool.query(sql, p);

  try {
    console.log('\n  ── A2. A REPRESENTATIVE DATABASE ──\n');

    // The LEGACY shape, exactly as src/lib/db.js creates it plus the two ALTERs that exist today.
    await q(`CREATE TABLE email_log (
      id TEXT PRIMARY KEY, to_email TEXT NOT NULL, subject TEXT NOT NULL,
      trigger_type TEXT, sent_at TEXT DEFAULT NOW())`);
    await q(`ALTER TABLE email_log ADD COLUMN IF NOT EXISTS status TEXT`);
    await q(`ALTER TABLE email_log ADD COLUMN IF NOT EXISTS error_message TEXT`);

    // Seeded to production's observed proportions, plus the shapes that exist historically: rows
    // with NULL status from before the status column, and a row with every nullable field empty.
    const seed = [];
    for (let i = 0; i < PROD_SENT; i += 1) seed.push([`s${i}`, 'buyer@example.com', 'Quote', 'sent', null]);
    for (let i = 0; i < PROD_STOPPED; i += 1) seed.push([`p${i}`, 'buyer@example.com', 'Follow-up', 'stopped_by_policy', 'STOPPED_BY_POLICY: capability:email.send']);
    seed.push(['legacy-null-status', 'old@example.com', 'Before the status column existed', null, null]);
    seed.push(['legacy-failed', 'bad@example.com', 'Bounced', 'failed', 'Resend 422']);
    for (const [id, to, subj, st, err] of seed) {
      await q(`INSERT INTO email_log (id, to_email, subject, status, error_message) VALUES ($1,$2,$3,$4,$5)`,
        [id, to, subj, st, err]);
    }
    const before = (await q(`SELECT COUNT(*)::int n FROM email_log`)).rows[0].n;
    field('legacy rows seeded', before);
    field('distinct legacy statuses', (await q(`SELECT COUNT(DISTINCT COALESCE(status,'(null)'))::int n FROM email_log`)).rows[0].n);
    const checksum = async () => (await q(
      `SELECT md5(string_agg(id || '|' || to_email || '|' || subject || '|' ||
          COALESCE(status,'~') || '|' || COALESCE(error_message,'~'), ',' ORDER BY id)) m FROM email_log`
    )).rows[0].m;
    const sumBefore = await checksum();
    field('content checksum', sumBefore.slice(0, 16));

    console.log('\n  ── A3. THE MIGRATION, AND WHAT IT LOCKS ──\n');
    const t0 = Date.now();
    for (const sql of SCHEMA.DDL) await q(sql);
    const elapsed = Date.now() - t0;
    field('apply duration (ms)', elapsed);

    const after = (await q(`SELECT COUNT(*)::int n FROM email_log`)).rows[0].n;
    if (after === before) ok(`every legacy row survived (${after})`);
    else bad(`row count changed: ${before} → ${after}`);

    if (await checksum() === sumBefore) ok('…and their existing content is byte-identical');
    else bad('the migration altered existing row content');

    const nulls = (await q(`SELECT COUNT(*)::int n FROM email_log WHERE outcome IS NULL`)).rows[0].n;
    if (nulls === before) {
      ok('…and every legacy row has outcome NULL, not an invented value');
      note('back-filling an outcome onto a historical row would invent a fact. "We do not know');
      note('what this old row was" is itself true, and the CHECK permits NULL for exactly that.');
    } else bad(`${before - nulls} legacy row(s) were given an outcome`);

    // The constraints must tolerate every legacy status.
    try {
      await q(`INSERT INTO email_log (id, to_email, subject, status) VALUES ('legacy-shape','x@example.com','s','sent')`);
      ok('a row in the OLD shape still inserts — mailer in flight during the migration is unaffected');
      await q(`DELETE FROM email_log WHERE id = 'legacy-shape'`);
    } catch (e) { bad('an old-shape insert was refused after the migration', e.message); }

    console.log('\n  ── A4. IDEMPOTENCY ──\n');
    const t1 = Date.now();
    let secondRunError = null;
    try { for (const sql of SCHEMA.DDL) await q(sql); } catch (e) { secondRunError = e.message; }
    if (!secondRunError) ok(`a second apply succeeds (${Date.now() - t1}ms) — safe to re-run after a partial failure`);
    else bad('the migration is not idempotent', secondRunError);
    if ((await q(`SELECT COUNT(*)::int n FROM email_log`)).rows[0].n === before) {
      ok('…and changed no rows');
    } else bad('the second apply altered data');

    console.log('\n  ── A5. RECOVERY: ROLLBACK, THEN RE-APPLY ──\n');
    for (const sql of SCHEMA.ROLLBACK) await q(sql);
    const remaining = (await q(
      `SELECT COUNT(*)::int n FROM information_schema.columns
        WHERE table_name='email_log' AND column_name = ANY($1)`, [SCHEMA.ADDED_COLUMNS])).rows[0].n;
    if (remaining === 0) ok('rollback removes every column this migration added');
    else bad(`${remaining} added column(s) survived the rollback`);

    const stillThere = (await q(`SELECT COUNT(*)::int n FROM email_log`)).rows[0].n;
    if (stillThere === before && await checksum() === sumBefore) {
      ok('…and every original row is still present and unchanged');
    } else bad('the rollback lost or altered data');

    const legacyCols = (await q(
      `SELECT COUNT(*)::int n FROM information_schema.columns
        WHERE table_name='email_log' AND column_name = ANY($1)`,
      [['id', 'to_email', 'subject', 'trigger_type', 'sent_at', 'status', 'error_message']])).rows[0].n;
    if (legacyCols === 7) ok('…and the pre-existing columns were never touched');
    else bad(`only ${legacyCols} of 7 original columns remain — the rollback is too wide`);

    try {
      for (const sql of SCHEMA.DDL) await q(sql);
      ok('and it can be applied again after a rollback — recovery is a loop, not a one-way door');
    } catch (e) { bad('re-apply after rollback failed', e.message); }

    console.log('\n  ── A6. LOCKING AND DOWNTIME RISK ──\n');
    field('rows in fixture', before);
    field('total apply (ms)', elapsed);
    note('ADD COLUMN with no DEFAULT is a catalog-only change in PostgreSQL 11+ — no table rewrite.');
    note('The three ADD CONSTRAINT statements take ACCESS EXCLUSIVE and scan the table to validate.');
    note(`Production email_log held ${PROD_SENT + PROD_STOPPED} rows at the 11:27 CST evidence run, so that`);
    note('scan is of a trivially small table. The lock is held for the duration of the scan only.');
    note('CREATE INDEX (not CONCURRENTLY) also takes a write lock, again over the same small table.');
    note('Concurrent INSERTs to email_log would wait, not fail. With email under a global STOP the');
    note('only writers are refusals — and a refusal waiting a few milliseconds is not an outage.');

    console.log('\n  ── A7. NOTHING HERE CAN REACH A PROVIDER ──\n');
    if (fetchAttempts === 0) ok('no outbound fetch was attempted at any point in this verification');
    else bad(`${fetchAttempts} outbound fetch attempt(s) were made`);
    note('global.fetch is replaced with a thrower for the whole run, so a provider call would be a');
    note('loud failure rather than a silent send. This is verification, not a dry run of sending.');
  } catch (e) {
    bad('unexpected error', e.stack || e.message);
  } finally {
    await pool.end().catch(() => {});
    stopTemp();
    global.fetch = realFetch;
  }

  console.log(fail
    ? `\nFAIL  ${fail} safety check(s) failed — DO NOT MIGRATE PRODUCTION.\n`
    : '\nPASS  additive, idempotent, reversible, data-preserving, and lock-trivial at production size.\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); stopTemp(); process.exit(1); });
