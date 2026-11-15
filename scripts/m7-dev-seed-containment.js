#!/usr/bin/env node
// ── STOP EVERY CRON IN THE DEV DATABASE, AND LEAVE THE WORKER ALONE ─────────
//
//   M7_5_DEV_CONFIRM=yes DATABASE_URL=<dev> node scripts/m7-dev-seed-containment.js [--verify]
//
// scripts/dev-worker-api-server.js never loads server.js, so no cron is registered by the dev API
// and this seed is a SECOND layer — for the day somebody runs the real server against the dev
// database to try something. On that day these rows are what stand between a dev deploy and a real
// email to the team.
//
// ── WHY NOT A SINGLE GLOBAL STOP ────────────────────────────────────────────
//
// Because a global stop also halts the worker. scripts/check-worker-runtime-db.js section 5 proves
// it: a global row aborted a running synthetic.echo mid-execution. The whole point of the dev
// environment is that the worker runs, so the containment has to be precise rather than total.
//
// Every cron passes through withAlerts(), which calls checkStopped(scopesForCron(name)) BEFORE the
// body runs, and scopesForCron returns `workflow: <the cron's own name>`. So one workflow stop per
// cron halts each body individually, silently (a deliberate stop deliberately sends no alert —
// otherwise this script would generate 42 emails, which is the opposite of containment), and
// without touching `global` or `capability|worker.execute`.
//
// The list is GENERATED from autonomy.CRON_SCOPES, never typed. A hand-maintained copy would drift
// the first time a cron is added, and the drift would be silent — the new cron would simply run.
//
// Idempotent. Run it as often as you like.
//
// EXIT 0 every cron is stopped and the worker is not · 1 containment is incomplete · 2 refused

'use strict';

const MODE_VERIFY = process.argv.includes('--verify');

const FORBIDDEN_HOSTS = ['postgres.railway.internal', 'interchange.proxy.rlwy.net'];

function refuse(msg, extra) {
  process.stderr.write(`REFUSED: ${msg}\n`);
  if (extra) process.stderr.write(`${extra}\n`);
  process.exit(2);
}

if (!process.env.DATABASE_URL) refuse('DATABASE_URL is not set.');
let host = '';
try { host = new URL(process.env.DATABASE_URL).hostname; } catch (_) {
  refuse('DATABASE_URL is not a URL this script can inspect.');
}
for (const h of FORBIDDEN_HOSTS) {
  if (host === h || host.endsWith(`.${h}`)) {
    refuse(`${host} is the production database.`,
      'Production containment is three specific STOPs set by the owner. This script writes 42 rows\n'
      + 'and is not going anywhere near them.');
  }
}
if (process.env.NODE_ENV === 'production') refuse('NODE_ENV=production.');
if (process.env.M7_5_DEV_CONFIRM !== 'yes') {
  refuse('set M7_5_DEV_CONFIRM=yes to confirm this is the development database.',
    `         host=${host}`);
}

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const query = (sql, params) => pool.query(sql, params);
const autonomy = require('../src/lib/autonomy');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 200)}`); };
const head = (m) => console.log(`\n  ── ${m} ──\n`);

const REASON = 'M7 development environment: all scheduled work is halted here. This database exists '
  + 'to validate the Mac mini worker and nothing else. Removing this row lets a cron body run '
  + 'against dev data.';

(async () => {
  console.log(`\n══ M7 DEV CONTAINMENT — ${host} ══`);

  await autonomy.migrateAutonomy(query);

  const cronNames = Object.keys(autonomy.CRON_SCOPES).sort();
  if (cronNames.length === 0) {
    bad('autonomy.CRON_SCOPES is empty — nothing would be stopped', 'refusing to report success');
    throw new Error('no cron scopes found');
  }
  console.log(`   ${cronNames.length} cron(s) known to autonomy.CRON_SCOPES\n`);

  if (!MODE_VERIFY) {
    head('writing one workflow stop per cron');
    // autonomy_stops is keyed on (scope_type, scope_key) and has no id column, so idempotency comes
    // from the primary key rather than from a read-then-write. ON CONFLICT DO NOTHING also means two
    // people running this at once cannot collide, which a SELECT-then-INSERT would allow.
    let written = 0;
    for (const name of cronNames) {
      const r = await query(
        `INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
         VALUES ('workflow', $1, $2, 'm7-dev-seed-containment')
         ON CONFLICT (scope_type, scope_key) DO NOTHING`, [name, REASON]);
      written += r.rowCount;
    }
    ok(`${written} stop(s) written, ${cronNames.length - written} already present`);
  }

  // ── EVERY CRON IS COVERED ─────────────────────────────────────────────────
  head('verification: every cron is halted');

  autonomy.resetForTests && autonomy.resetForTests();

  const uncovered = [];
  for (const name of cronNames) {
    // Asks the REAL guard the REAL question, exactly as withAlerts() asks it. Checking for the
    // presence of a row would test the row; this tests the decision the row is supposed to cause.
    const blocked = await autonomy.checkStopped(
      autonomy.scopesForCron(name), { consequential: true, deps: { query } });
    if (!blocked) uncovered.push(name);
  }
  if (uncovered.length === 0) {
    ok(`all ${cronNames.length} crons are STOPPED according to checkStopped() itself`);
  } else {
    bad(`${uncovered.length} cron(s) would still RUN`, uncovered.slice(0, 8).join(', '));
  }

  // ── AND THE WORKER IS NOT ─────────────────────────────────────────────────
  head('verification: the worker is NOT halted');

  const g = await query(`SELECT COUNT(*)::int n FROM autonomy_stops WHERE scope_type='global'`);
  if (Number(g.rows[0].n) === 0) ok('no global stop exists — a global stop would halt the worker too');
  else bad(`${g.rows[0].n} global stop(s) present`, 'the worker cannot run with a global stop in place');

  const workerBlocked = await autonomy.checkStopped(
    { capability: 'worker.execute' }, { consequential: true, deps: { query } });
  if (!workerBlocked) ok('capability worker.execute is permitted');
  else bad('worker.execute is STOPPED', `${workerBlocked.scope_type}:${workerBlocked.scope_key}`);

  // The control. If checkStopped() returned truthy for everything, every assertion above would
  // pass and the containment would be meaningless. A scope nobody has stopped must come back clear.
  const control = await autonomy.checkStopped(
    { workflow: 'a-workflow-that-does-not-exist-and-is-not-stopped' },
    { consequential: true, deps: { query } });
  if (!control) ok('control: an unstopped scope reads as permitted, so the checks above are real');
  else bad('checkStopped() blocks even an unstopped scope — the verification above proves nothing');

  // ── THE THREE PRODUCTION STOPS ARE NOT HERE ───────────────────────────────
  head('verification: this is not production');

  const prodShaped = await query(
    `SELECT scope_type, scope_key FROM autonomy_stops
      WHERE (scope_type='capability' AND scope_key='email.send')
         OR (scope_type='workflow' AND scope_key IN ('legacy-inquiry-buyer-email','legacy-supplier-rfq-email'))`);
  if (prodShaped.rows.length === 0) {
    ok('none of the three production STOPs are in this database — it is a different database');
  } else {
    // Not a failure: it means somebody restored a production backup here. Worth saying loudly.
    console.log(`  NOTE  ${prodShaped.rows.length} production-shaped STOP row(s) found here.`);
    console.log('        That is expected if this dev database was restored from a production dump,');
    console.log('        and it is harmless. But confirm DATABASE_URL points where you think it does.');
  }

  const counts = await query(
    `SELECT scope_type, COUNT(*)::int n FROM autonomy_stops GROUP BY scope_type ORDER BY scope_type`);
  console.log('');
  console.log('  stops in this database:');
  for (const r of counts.rows) console.log(`    ${String(r.scope_type).padEnd(12)} ${r.n}`);
})()
  .then(async () => {
    await pool.end().catch(() => {});
    console.log();
    if (fail) {
      console.log(`FAIL  containment is incomplete (${fail} problem(s)). Do not run a server against`);
      console.log('      this database until every cron reads as stopped.');
      process.exit(1);
    }
    console.log('PASS  every cron body is halted in this database, the worker is not, and no global');
    console.log('      stop exists. Verified by asking checkStopped() the same question withAlerts()');
    console.log('      asks, not by counting rows.');
    process.exit(0);
  })
  .catch(async (e) => {
    await pool.end().catch(() => {});
    console.log(`\nINCOMPLETE  ${(e && e.message) || e}`);
    process.exit(1);
  });
