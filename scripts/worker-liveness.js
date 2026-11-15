#!/usr/bin/env node
// ── IS ANY WORKER PICKING UP WORK? ──────────────────────────────────────────
//
//   DATABASE_URL=<db> node scripts/worker-liveness.js [--stale-minutes 20] [--json]
//
// READ-ONLY. It runs SELECTs and nothing else: no INSERT, no UPDATE, no DELETE, no email, no
// WhatsApp, no HTTP request, no provider client. It prints and exits. Layer 1 of the monitoring
// design, and the only layer that exists.
//
// ── IT ALERTS ON WORK NOBODY IS DOING, NOT ON A WORKER BEING ABSENT ─────────
//
// Under the Option B macOS model the worker is EXPECTED to be down after a reboot until somebody
// logs in. A monitor that fires on absence would fire for the normal case, and a monitor that fires
// for the normal case is one people learn to ignore — which is worse than no monitor, because it
// also silences the abnormal case.
//
// So the condition is the one that actually costs something:
//
//     PENDING work older than the threshold   AND   no worker seen within the threshold
//
// An absent worker with an empty queue is SILENT, because nothing is being lost. This is
// self-suppressing by construction rather than by a debounce.
//
// ── WHY last_seen_at AND NOT THE AUDIT ──────────────────────────────────────
//
// Measured, not assumed: an idle poll that finds no work DOES advance
// worker_identities.last_seen_at, and writes ZERO worker_audit rows. Liveness from the audit — the
// obvious first choice — would therefore report every idle worker as offline, and would have been
// wrong in exactly the quiet periods a liveness check exists for.
//
// EXIT 0 nothing is stuck · 1 work is waiting and no worker is alive · 3 could not tell

'use strict';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const JSON_OUT = argv.includes('--json');
const STALE_MIN = Math.max(1, Number(arg('--stale-minutes', '20')) || 20);

const EXIT_OK = 0;
const EXIT_STUCK = 1;
const EXIT_CANNOT_TELL = 3;

if (!process.env.DATABASE_URL) {
  process.stderr.write('worker-liveness: DATABASE_URL is not set.\n');
  process.exit(EXIT_CANNOT_TELL);
}

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1|host=/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: 2,
  // A diagnostic that hangs is a diagnostic nobody runs.
  statement_timeout: 10_000,
  connectionTimeoutMillis: 10_000,
});

(async () => {
  const q = (sql, params) => pool.query(sql, params);

  // Does the worker subsystem even exist here? Reporting "no workers" against a database that has
  // no worker tables would be a confident wrong answer.
  const present = await q(
    `SELECT COUNT(*)::int n FROM pg_tables
      WHERE schemaname = current_schema() AND tablename IN ('worker_identities','worker_tasks')`);
  if (Number(present.rows[0].n) !== 2) {
    const msg = 'the worker tables are not present in this database, so liveness cannot be assessed';
    if (JSON_OUT) console.log(JSON.stringify({ verdict: 'cannot_tell', reason: msg }, null, 2));
    else {
      console.log('\nCANNOT TELL');
      console.log(`  ${msg}.`);
      console.log('  This is not "no workers" — it is "wrong database, or M7 not migrated here".');
    }
    await pool.end();
    process.exit(EXIT_CANNOT_TELL);
  }

  const workers = (await q(
    `SELECT id, label, last_seen_at, revoked_at,
            EXTRACT(EPOCH FROM (NOW() - last_seen_at))/60 AS idle_minutes
       FROM worker_identities
      ORDER BY last_seen_at DESC NULLS LAST`)).rows;

  const live = workers.filter((w) => !w.revoked_at && w.last_seen_at
    && Number(w.idle_minutes) <= STALE_MIN);
  const stale = workers.filter((w) => !w.revoked_at
    && (!w.last_seen_at || Number(w.idle_minutes) > STALE_MIN));
  const revoked = workers.filter((w) => w.revoked_at);

  const pending = (await q(
    `SELECT COUNT(*)::int AS n,
            MAX(EXTRACT(EPOCH FROM (NOW() - created_at))/60)::numeric(10,1) AS oldest_minutes
       FROM worker_tasks WHERE state = 'PENDING'`)).rows[0];
  const pendingOld = (await q(
    `SELECT COUNT(*)::int n FROM worker_tasks
      WHERE state = 'PENDING' AND created_at < NOW() - ($1 || ' minutes')::interval`,
    [String(STALE_MIN)])).rows[0];

  // Needs a human regardless of liveness: an abandoned task is not going to resolve itself.
  const needs = (await q(
    `SELECT COUNT(*)::int n FROM worker_tasks WHERE state = 'NEEDS_RESOLUTION'`)).rows[0];
  const leased = (await q(
    `SELECT COUNT(*)::int n FROM worker_tasks WHERE state = 'LEASED'`)).rows[0];

  // A deliberate stop explains silence. Saying so is the difference between a diagnostic and an
  // alarm: somebody pulled the switch, and the report should say that rather than imply a fault.
  const stops = (await q(
    `SELECT scope_type, scope_key, reason FROM autonomy_stops
      WHERE (scope_type = 'global')
         OR (scope_type = 'capability' AND scope_key = 'worker.execute')`)).rows;

  const workStuck = Number(pendingOld.n) > 0;
  const anyLive = live.length > 0;
  const stuck = workStuck && !anyLive;

  const report = {
    verdict: stuck ? 'work_waiting_no_worker' : 'ok',
    stale_threshold_minutes: STALE_MIN,
    workers: { live: live.length, stale: stale.length, revoked: revoked.length },
    tasks: {
      pending: Number(pending.n),
      pending_older_than_threshold: Number(pendingOld.n),
      oldest_pending_minutes: pending.oldest_minutes === null ? null : Number(pending.oldest_minutes),
      leased: Number(leased.n),
      needs_resolution: Number(needs.n),
    },
    explaining_stops: stops.map((s) => ({ scope: `${s.scope_type}:${s.scope_key}`, reason: s.reason })),
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n── worker liveness · threshold ${STALE_MIN} min ──\n`);
    console.log(`  workers    : ${live.length} live, ${stale.length} stale, ${revoked.length} revoked`);
    for (const w of live) {
      console.log(`               LIVE  ${w.id}  ${w.label || ''}  (seen ${Number(w.idle_minutes).toFixed(1)} min ago)`);
    }
    for (const w of stale) {
      const when = w.last_seen_at ? `${Number(w.idle_minutes).toFixed(0)} min ago` : 'never';
      console.log(`               STALE ${w.id}  ${w.label || ''}  (seen ${when})`);
    }
    console.log(`  tasks      : ${pending.n} pending (${pendingOld.n} older than the threshold), `
      + `${leased.n} leased, ${needs.n} needing resolution`);
    if (pending.oldest_minutes !== null) {
      console.log(`               oldest pending: ${Number(pending.oldest_minutes).toFixed(1)} min`);
    }
    if (stops.length) {
      console.log('');
      console.log('  a STOP explains worker silence:');
      for (const s of stops) {
        console.log(`    ${s.scope_type}${s.scope_key ? `:${s.scope_key}` : ''} — ${String(s.reason).slice(0, 90)}`);
      }
    }
    if (Number(needs.n) > 0) {
      console.log('');
      console.log(`  ${needs.n} task(s) at NEEDS_RESOLUTION. These do not resolve themselves and are not`);
      console.log('  re-offered to a worker, by design: their outcome is unknown, so a human decides.');
    }
    console.log('');
    if (stuck) {
      console.log('WORK WAITING, NO WORKER ALIVE');
      console.log(`  ${pendingOld.n} task(s) have been PENDING longer than ${STALE_MIN} minutes and no worker`);
      console.log('  has been seen in that window.');
      if (stops.length) {
        console.log('  A stop listed above may be the reason. If somebody pulled it deliberately, this is');
        console.log('  expected and not a fault.');
      } else {
        console.log('  On the Mac mini: workerctl status, then workerctl logs.');
        console.log('  After a reboot this is NORMAL until somebody logs in as the worker account —');
        console.log('  that is the accepted cost of the Option B security model.');
      }
    } else if (workStuck) {
      console.log('OK  work is waiting, but a worker is alive and should pick it up.');
    } else if (!anyLive) {
      console.log('OK  no worker is alive, and nothing is waiting. Nothing is being lost.');
    } else {
      console.log('OK  a worker is alive and nothing is overdue.');
    }
  }

  await pool.end();
  process.exit(stuck ? EXIT_STUCK : EXIT_OK);
})().catch(async (e) => {
  await pool.end().catch(() => {});
  const msg = String((e && e.message) || e).slice(0, 200);
  if (JSON_OUT) console.log(JSON.stringify({ verdict: 'cannot_tell', reason: msg }, null, 2));
  else {
    console.log(`\nCANNOT TELL  ${msg}`);
    console.log('  Reported as "cannot tell", never as "nothing is wrong": a diagnostic that');
    console.log('  returns OK when it failed to look is worse than one that is absent.');
  }
  process.exit(EXIT_CANNOT_TELL);
});
