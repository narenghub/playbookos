#!/usr/bin/env node
// ── K4 ACTIVATION PROOF (READ ONLY) ─────────────────────────────────────────
//
//   railway ssh 'node scripts/validate-k4-activation-deployed.js'
//
// The 12 activation items of the K4 ruling, against the deployed container. It modifies nothing:
// the only reaper call it makes is a DRY one, and it asserts that dryness rather than assuming it.
//
// ── WHAT PRODUCTION CAN AND CANNOT PROVE HERE ───────────────────────────────
//
// Production proves ACTIVATION, WIRING AND INERT COMPATIBILITY: that the scheduler exists in the
// deployed bytes, that it asks for acting mode explicitly, that the library default is still dry,
// that the kill switch can reach it, and that nothing pre-existing was touched.
//
// It does NOT prove recovery BEHAVIOUR, and this script does not pretend otherwise. Behaviour is
// proven against fixtures in scripts/check-office-recovery-db.js — 36 assertions, 3 mutation
// controls, a 20-way race. No stale production run is manufactured to demonstrate the mechanism,
// because a test that needs to break production to pass is not a test.
'use strict';

const fs = require('fs');
const path = require('path');
const { query } = require('../src/lib/db');
const recovery = require('../src/lib/office/recovery');
const autonomy = require('../src/lib/autonomy');

// The K1 baseline: the checksum over every run predating the K1 cutover, recorded when K1 was
// production validated. Pre-cutover rows are a CLOSED set, so this figure can never legitimately
// change — which is exactly what makes it usable as a tamper check here.
const CUTOVER = '2026-11-01T12:00:00Z';
const K1_BASELINE_CHECKSUM = 'f368a87d992fa03162c0b42cb06da630';
const K1_BASELINE_COUNT = 6;

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};
const note = (m) => console.log(`  --    ${m}`);

const CRON_NAME = 'quarter-hourly-office-recovery';

(async () => {
  try {
    console.log('\nK4 activation proof — READ ONLY\n');

    // ── 1. Exact deployed SHA ─────────────────────────────────────────────
    const sha = process.env.RAILWAY_GIT_COMMIT_SHA || null;
    if (!sha) bad('RAILWAY_GIT_COMMIT_SHA is not set — the running bytes cannot be identified');
    else ok(`deployed SHA ${sha}`);

    // ── 2-3. The scheduler exists in the DEPLOYED bytes, and states acting mode ──
    // Read from the container's own server.js, so this is evidence about what is running rather
    // than about what is in anybody's checkout.
    const serverPath = path.join(__dirname, '..', 'server.js');
    let src = '';
    try { src = fs.readFileSync(serverPath, 'utf8'); } catch (e) { bad(`could not read the deployed server.js: ${e.message}`); }

    const hasCron = /cron\.schedule\('7,22,37,52 \* \* \* \*',\s*withAlerts\('quarter-hourly-office-recovery'/.test(src);
    if (!hasCron) bad('the recovery cron is NOT registered in the deployed server.js');
    else ok('the recovery scheduler exists in the deployed bytes, on 7,22,37,52 * * * * via withAlerts');

    if (!/instrumentedRun\(/.test(src.slice(src.indexOf(CRON_NAME)))) bad('the reaper does not run inside instrumentedRun — it would have no durable execution evidence');
    else ok('the reaper executes inside instrumentedRun — its own firings are durably recorded');

    const body = src.slice(src.indexOf(`withAlerts('${CRON_NAME}'`), src.indexOf(`withAlerts('${CRON_NAME}'`) + 2600);
    if (!/dryRun:\s*false/.test(body)) bad('the scheduler does not state dryRun:false — it would be relying on a default');
    else ok('the scheduler requests acting mode EXPLICITLY (dryRun: false), not by default');
    if (!/excludeRunId:\s*runId/.test(body)) bad('the scheduler does not pass excludeRunId — the reaper could abandon its own run');
    else ok('the scheduler passes its own runId as excludeRunId — it cannot abandon itself');

    // ── 4. The library default is still dry ───────────────────────────────
    const dry = await recovery.reap({ limit: 200 });
    if (!dry.dry_run) {
      bad('CRITICAL: reap() did NOT default to dry. Stopping here before anything else.');
      process.exit(1);
    }
    ok('reap() still defaults to dryRun:true as a library — the acting mode lives only in the caller');
    console.log(`        dry sweep: inspected=${dry.inspected} eligible=${dry.eligible} `
      + `safe_stale=${dry.safe_stale} known_unknown=${dry.known_unknown}`);

    // ── 5-7. Nothing pre-existing was modified ────────────────────────────
    const fp = (await query(
      `SELECT md5(string_agg(run_id::text || '|' || state || '|' || product || '|' ||
                              COALESCE(trigger,'') || '|' || created_at::text, E'\\n'
                              ORDER BY run_id)) AS checksum,
              COUNT(*)::int AS n
         FROM agent_runs WHERE created_at < $1::timestamptz`, [CUTOVER]
    )).rows[0];
    if (fp.n !== K1_BASELINE_COUNT) bad(`the pre-cutover run count changed: ${K1_BASELINE_COUNT} -> ${fp.n}`);
    else ok(`the ${K1_BASELINE_COUNT} pre-existing runs are still exactly ${fp.n}`);
    if (fp.checksum !== K1_BASELINE_CHECKSUM) {
      bad(`the pre-cutover checksum CHANGED — a historical run was modified`,
        `expected ${K1_BASELINE_CHECKSUM}\ngot      ${fp.checksum}`);
    } else ok(`pre-cutover identity/state checksum unchanged (${fp.checksum})`);

    const dist = (await query(`SELECT state, COUNT(*)::int n FROM agent_runs GROUP BY state ORDER BY n DESC`)).rows;
    console.log('        terminal distribution: ' + dist.map((d) => `${d.state}=${d.n}`).join(' '));
    const abandonedPre = (await query(
      `SELECT COUNT(*)::int n FROM agent_runs
        WHERE state = 'ABANDONED' AND created_at < $1::timestamptz`, [CUTOVER]
    )).rows[0].n;
    if (abandonedPre) bad(`${abandonedPre} PRE-EXISTING run(s) were abandoned — activation touched history`);
    else ok('no pre-existing run was abandoned by activation');

    // ── 8-9. Nothing was manufactured ─────────────────────────────────────
    const manufactured = (await query(
      `SELECT (SELECT COUNT(*)::int FROM office_exceptions WHERE source = 'office/recovery') AS ex,
              (SELECT COUNT(*)::int FROM agent_runs WHERE attempt > 1) AS retries,
              (SELECT COUNT(*)::int FROM agent_run_events WHERE kind = 'RECOVERY_ABANDONED') AS recoveries`
    )).rows[0];
    if (manufactured.ex) bad(`${manufactured.ex} recovery exception(s) exist — none should have been manufactured`);
    else ok('zero recovery exceptions were manufactured');
    if (manufactured.retries) bad(`${manufactured.retries} retry run(s) exist — retry is NOT automatic`);
    else ok('zero retries were manufactured — retryRun() is a mechanism, not a policy');
    if (manufactured.recoveries) note(`${manufactured.recoveries} recovery event(s) recorded (expected 0 immediately after activation)`);
    else ok('zero recoveries recorded, as expected immediately after activation');

    // ── 10. The kill switch can reach the recovery caller ─────────────────
    const scopes = autonomy.scopesForCron(CRON_NAME);
    if (!scopes || scopes.workflow !== CRON_NAME) bad('scopesForCron does not resolve the reaper — the kill switch could not scope it');
    else ok(`the kill switch scopes the reaper as workflow=${scopes.workflow} (platform-level: company/agent null)`);
    // Validation only. No stop is written by this script.
    const v = autonomy.validate({ scope_type: 'workflow', scope_key: CRON_NAME,
      reason: 'K4 activation proof: confirming the reaper is a valid stop target' });
    if (v !== null) bad(`K8 would REFUSE a stop on the reaper: ${v}`);
    else ok('K8 accepts workflow=quarter-hourly-office-recovery as a stop target — the reaper is haltable by name');
    const blocked = await autonomy.checkStopped(scopes, { consequential: true });
    if (blocked) note(`the reaper is CURRENTLY STOPPED by ${blocked.scope_type}${blocked.scope_key ? `:${blocked.scope_key}` : ''} — recovery is not running`);
    else ok('the reaper is not currently stopped by policy');

    // ── 11. Overlapping invocations cannot duplicate recovery ─────────────
    const idx = (await query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_agent_runs_one_active'`
    )).rows[0];
    if (!idx) bad('uq_agent_runs_one_active is ABSENT — two concurrent reapers could both run');
    else ok('uq_agent_runs_one_active is present: a second concurrent reaper is declined outright');
    note('the second mechanism is recoverRun\'s arbitrated UPDATE (only a non-terminal row can be');
    note('claimed), fixture-proven at 20 racers -> exactly 1 transition, 1 record, 1 exception.');

    // ── 12. A restart leaves recovery active ──────────────────────────────
    // The cron is registered at module scope in server.js, so it is re-registered by any boot that
    // reaches the end of the file. That is the same durability every other cron has.
    const beforeListen = src.indexOf(`withAlerts('${CRON_NAME}'`) < src.indexOf('app.listen(PORT');
    if (!beforeListen) bad('the reaper is registered AFTER app.listen — a boot that fails to listen would skip it');
    else ok('the reaper is registered at module scope before app.listen, so any boot re-arms it');
    // process.uptime() here is THIS script's process, not the server's — `railway ssh` spawns a
    // fresh node. An earlier version printed it as though it said something about the running
    // server; it does not, and reporting it that way was misleading.
    note(`(process.uptime() is this script's own process, not the server's — it proves nothing about the server)`);

    // ── 13. THE ONLY PROOF THAT THE LIVE SERVER ACTUALLY ARMED IT ─────────
    //
    // Everything above proves the deployed BYTES register the cron. It does not prove the running
    // process did: a boot that threw before reaching that line would pass every assertion so far.
    // Because the reaper executes inside instrumentedRun, every firing leaves a durable run row —
    // so an OBSERVED FIRING is the difference between "wired" and "running".
    const fired = (await query(
      `SELECT COUNT(*)::int AS n, MAX(created_at) AS last, MAX(state) AS last_state
         FROM agent_runs WHERE workflow = $1`, [CRON_NAME]
    )).rows[0];
    if (fired.n > 0) {
      ok(`OBSERVED ${fired.n} reaper firing(s) — the live server armed the schedule, not just the bytes`);
      console.log(`        most recent ${fired.last.toISOString()} (${fired.last_state})`);
    } else {
      note('NO reaper firing observed yet. Expected only inside the first cadence window after a');
      note('deploy (it fires at :07/:22/:37/:52 UTC). Re-run after the next boundary: if it is');
      note('still zero, the schedule is NOT armed in the running process and the activation is');
      note('wired-but-dead — which every other assertion in this file would still pass.');
    }

    console.log('\n' + (fail
      ? `FAIL  ${fail} activation assertion(s) failed`
      : 'PASS  K4 activation: the reaper is wired, explicit about acting mode, haltable by policy, '
        + 'cannot duplicate recovery, and modified nothing pre-existing'));
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\nFAIL  activation proof error:', e.stack || e.message);
    process.exit(1);
  }
})();
