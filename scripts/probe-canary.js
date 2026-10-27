#!/usr/bin/env node
// ── DOES THE LEDGER PATH WORK IN PRODUCTION, BEFORE 3AM FINDS OUT? ───────────
//
//   railway ssh 'node scripts/probe-canary.js'
//
// Exit 0 = the full instrumented path works against the production database.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// The canary is fail-closed: if the durable run identity cannot be created, the GitHub sync does
// not run. That is the approved behaviour, and it means a production-only problem — a permission,
// a TLS quirk, a missing column after a partial migration — would surface at 03:00 Chicago as a
// silently skipped sync and nothing else.
//
// Every controlled test so far ran against throwaway clusters. This exercises the same code path
// against the real database, now, while someone is awake.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
//
// It does NOT call syncGitHubAllDevs. The body is inert: the thing under test is the ledger path,
// and doing the real work would make this a second unscheduled sync rather than a probe.
//
// It does NOT use the scheduled slot's intent key. It uses an explicit `probe:` key, so it cannot
// occupy tomorrow's slot and cause the real occurrence to decline as a duplicate — which would
// turn a safety check into the outage it was meant to prevent.
//
// It leaves its rows behind. agent_run_events is append-only by trigger, and disabling that
// trigger in production to tidy up a probe would be a worse trade than a self-describing row that
// stays. The rows are labelled `probe:` and are evidence, not litter.
'use strict';

const { instrumentedRun, ledger } = require('../src/lib/run-ledger');
const { query } = require('../src/lib/db');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 300)}`); };

(async () => {
  const commit = String(process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'unknown';
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const intentKey = `probe:daily-8utc-github-sync:${stamp}`;
  console.log(`\n── canary path probe · commit ${commit}\n`);
  console.log(`  intent ${intentKey}`);
  console.log('  body is INERT — no GitHub sync is performed, and the scheduled slot is untouched.\n');

  let runId = null;
  try {
    // 1. Refuse to run if the real slot would be affected. Belt and braces: the key is explicit
    //    above, but asserting it means a future edit cannot quietly make this collide.
    if (!intentKey.startsWith('probe:')) { bad('the probe is not using a probe key — refusing'); process.exit(1); }
    ok('the probe key cannot collide with the scheduled slot');

    let entered = 0;
    const out = await instrumentedRun(
      {
        workflow: 'daily-8utc-github-sync',
        product: 'internal',
        trigger: 'manual',
        triggerDetail: 'probe-canary.js (inert body)',
        intentKey,
      },
      async () => { entered += 1; return { probe: true }; },
    );

    if (out.ran && out.state === 'SUCCEEDED' && entered === 1) {
      ok('the full path ran against production: CREATED → RUNNING → SUCCEEDED');
    } else {
      bad('the instrumented path did not complete', JSON.stringify(out));
      if (out.reason === 'ledger_unavailable') {
        console.log('\n  ✗ THIS IS THE CASE THAT WOULD HAVE SKIPPED THE 03:00 SYNC SILENTLY.');
        console.log('    The canary is fail-closed, so the body would not have run and the only');
        console.log('    evidence would have been a log line nobody reads at 3am.\n');
      }
    }
    runId = out.runId;

    if (runId) {
      const L = ledger({ query });
      const r = await L.getRun(runId);
      const kinds = (await L.timeline(runId)).map((e) => e.kind);
      if (r && r.started_at && r.ended_at) ok('both timestamps are durable in production');
      else bad('timestamps missing', JSON.stringify(r && { s: r.started_at, e: r.ended_at }));
      if (JSON.stringify(kinds) === JSON.stringify(['RUN_CREATED', 'RUN_STARTED', 'RUN_ENDED'])) {
        ok('the timeline is RUN_CREATED → RUN_STARTED → RUN_ENDED');
      } else bad('timeline wrong', kinds.join(' → '));

      // The guards are real on this database, not only on a test cluster.
      try {
        await query(`UPDATE agent_run_events SET error='probe tamper' WHERE run_id=$1`, [runId]);
        bad('PRODUCTION agent_run_events accepted an UPDATE — the append-only trigger is not holding');
      } catch (e) {
        if (/append-only/.test(e.message)) ok('append-only enforcement holds on the production table');
        else bad('the append-only refusal came from somewhere unexpected', e.message);
      }
      // To a DIFFERENT terminal state. The first version of this probe tried SUCCEEDED → SUCCEEDED
      // and reported the guard broken: an identical-state write is a permitted no-op, and the
      // guard blocks a change to a different state. The assertion was wrong, not the trigger.
      try {
        await query(`UPDATE agent_runs SET state='FAILED' WHERE run_id=$1`, [runId]);
        bad('a terminal production run was rewritten from SUCCEEDED to FAILED');
      } catch (e) {
        if (/terminal/.test(e.message)) ok('terminal immutability holds on the production table');
        else bad('the terminal refusal came from somewhere unexpected', e.message);
      }
    }

    // 2. The scheduled slot must still be free for tomorrow.
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const slot = `cron:daily-8utc-github-sync:${tomorrow}T08:00`;
    const occupied = await query(
      `SELECT COUNT(*)::int n FROM agent_runs WHERE intent_key = $1`, [slot]);
    if (occupied.rows[0].n === 0) ok(`tomorrow's scheduled slot is still free (${slot})`);
    else bad(`the probe or something else has occupied ${slot}`);
  } catch (e) {
    bad('threw', e && e.stack ? e.stack : e);
  }

  console.log('');
  if (fail) {
    console.log(`✗ FAIL — ${fail} check(s) failed. Do NOT rely on the 08:00 occurrence until this is resolved.\n`);
    process.exit(1);
  }
  console.log('✓ PASS — the instrumented path works against production. The 08:00 occurrence should record.');
  console.log(`  This probe left one labelled run in the ledger (${runId}); the event log is append-only`);
  console.log('  by trigger, and disabling that to tidy up would be the worse trade.\n');
})().catch((e) => { console.error('probe-canary failed:', e && e.message ? e.message : e); process.exit(1); });
