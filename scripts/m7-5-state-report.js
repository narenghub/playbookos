#!/usr/bin/env node
// ── WHAT IS ACTUALLY IN THE DEVELOPMENT DATABASE, BEFORE ANYBODY CHANGES IT ──
//
//   node scripts/m7-5-state-report.js
//
// Read-only. No DELETE, no UPDATE, no INSERT — see the assertion at the bottom of this file, which
// fails the run if this script ever contains one.
//
// It answers the four questions the M7.5 cleanup needs answered first, and it answers them from the
// database rather than from anybody's recollection:
//
//   1. which worker identities exist, and which are revoked
//   2. which acceptance fixtures are still lying around, BY EXACT ID
//   3. whether any of those are claimable — which is the thing that bit us
//   4. whether the 42 containment stops are still in place
//
// ── WHY QUESTION 3 MATTERS ──────────────────────────────────────────────────
//
// On 2026-11-18 a freshly enrolled identity claimed two tasks from the PREVIOUS run's queue. The
// 2026-11-17 run had been abandoned when its identity was revoked mid-scenario, leaving PENDING
// tasks behind; the next worker to authenticate picked them up and executed them. For a minute it
// looked like the driver was running when it was not, and I read those leases as evidence of a run
// that had not started. Fixtures outliving their run is not a tidiness problem — it corrupts the
// next run's evidence.
//
// ── IT PRINTS NO SECRETS ────────────────────────────────────────────────────
//
// `secret_current` and `secret_previous` are never selected. Neither is any token digest. Worker
// ids, labels and timestamps are not secrets; they appear in the plist in clear.

'use strict';

const { Pool } = require('pg');

const ACCEPTANCE_INTENT_PREFIX = 'm75-';
const CLAIMABLE = ['PENDING', 'LEASED'];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('REFUSED: DATABASE_URL is not set.');
    process.exit(2);
  }

  // The same positive identification every other M7 script does. A read-only report is still a
  // report about SOME database, and "which one" is the question that has gone wrong before.
  const pool = new Pool({ connectionString: url, max: 3 });
  const query = (sql, params) => pool.query(sql, params);
  const DBID = require('./lib/db-identity');
  const identified = await DBID.assertDevelopmentDatabase(query, { log: console.log });
  if (!identified.ok) {
    console.log(`\nREFUSED: not identified as development (${identified.verdict}).`);
    await pool.end();
    process.exit(2);
  }

  const rows = async (sql, params) => (await query(sql, params)).rows;

  console.log('\n══ M7.5 STATE REPORT ══\n');

  // ── 1. IDENTITIES ─────────────────────────────────────────────────────────
  console.log('── worker identities ──\n');
  const ids = await rows(
    `SELECT id, label, enrolled_at, last_seen_at, revoked_at, revoked_reason
       FROM worker_identities
      ORDER BY enrolled_at DESC`);
  if (!ids.length) console.log('  (none)');
  for (const w of ids) {
    const state = w.revoked_at
      ? `REVOKED ${new Date(w.revoked_at).toISOString()} (${w.revoked_reason || 'no reason recorded'})`
      : 'LIVE';
    console.log(`  ${w.id}  ${String(w.label).padEnd(18)} ${state}`);
    console.log(`    enrolled ${new Date(w.enrolled_at).toISOString()}`
      + `  last seen ${w.last_seen_at ? new Date(w.last_seen_at).toISOString() : 'never'}`);
  }
  const live = ids.filter((w) => !w.revoked_at);
  console.log(`\n  ${live.length} live, ${ids.length - live.length} revoked.`);
  if (live.length > 1) {
    console.log('  NOTE: more than one live identity. Each is a credential that can claim work;'
      + '\n        an acceptance run cannot attribute a claim to a particular machine.');
  }

  // ── 2 AND 3. FIXTURES ─────────────────────────────────────────────────────
  console.log('\n── acceptance fixtures still present ──\n');
  const tasks = await rows(
    `SELECT t.id, t.intent_key, t.task_type, t.state, t.created_at,
            (SELECT COUNT(*)::int FROM worker_results r WHERE r.task_id = t.id) AS results
       FROM worker_tasks t
      WHERE t.intent_key LIKE $1
      ORDER BY t.created_at`,
    [`${ACCEPTANCE_INTENT_PREFIX}%`]);

  if (!tasks.length) console.log('  (none — the queue is clean)');
  for (const t of tasks) {
    const flag = CLAIMABLE.includes(t.state) ? '  <-- CLAIMABLE BY THE NEXT WORKER' : '';
    console.log(`  ${t.id}  ${String(t.intent_key).padEnd(20)} ${String(t.task_type).padEnd(22)}`
      + ` ${String(t.state).padEnd(17)} results=${t.results}${flag}`);
  }

  const claimable = tasks.filter((t) => CLAIMABLE.includes(t.state));
  const runs = await rows(
    `SELECT run_id, intent_key, state, started_at, ended_at
       FROM agent_runs
      WHERE intent_key LIKE $1
      ORDER BY started_at`,
    [`${ACCEPTANCE_INTENT_PREFIX}%`]);

  console.log(`\n  ${tasks.length} task(s), ${claimable.length} claimable, ${runs.length} run(s).`);
  const stuck = runs.filter((r) => r.state === 'RUNNING');
  if (stuck.length) {
    console.log(`  ${stuck.length} run(s) still RUNNING — these hold the per-intent uniqueness`
      + '\n        constraint and will block that intent key for ever if left:');
    for (const r of stuck) console.log(`    ${r.run_id}  ${r.intent_key}`);
  }

  if (claimable.length) {
    console.log('\n  THIS IS THE 2026-11-18 HAZARD. A newly enrolled worker authenticates and'
      + '\n  claims these, so the next run\'s first scenarios measure the previous run\'s'
      + '\n  leftovers. Clear them before enrolling, with:');
    console.log('\n    node scripts/m7-5-dev-driver.js scenarios --worker <id> --clean-stale\n');
    console.log('  which deletes exactly the ids listed above and nothing else.');
  }

  // ── 4. CONTAINMENT ────────────────────────────────────────────────────────
  console.log('\n── containment ──\n');
  const stops = await rows(
    `SELECT scope_type, COUNT(*)::int n FROM autonomy_stops GROUP BY scope_type ORDER BY scope_type`);
  if (!stops.length) console.log('  NO STOPS AT ALL — this is not the expected state.');
  for (const s of stops) console.log(`  ${String(s.scope_type).padEnd(12)} ${s.n}`);
  const workflow = stops.find((s) => s.scope_type === 'workflow');
  const global = stops.find((s) => s.scope_type === 'global');
  console.log(`\n  workflow stops: ${workflow ? workflow.n : 0} (42 expected)`);
  console.log(`  global stops  : ${global ? global.n : 0} (0 expected — a global stop halts the worker too)`);

  await pool.end();

  // The report is a report. It deliberately does not decide anything, and exits 0 whatever it
  // found, so that a non-zero exit here always means the report itself failed to run.
  console.log('\nread-only report complete. Nothing was changed.');
}

// ── THE READ-ONLY CLAIM, ENFORCED RATHER THAN ASSERTED ──────────────────────
//
// This file's whole value is that it is safe to run against a database somebody cares about. A
// comment saying so is worth nothing once somebody adds "just one little UPDATE" during an
// incident, so the claim is checked against this file's own source at startup.
(function selfCheck() {
  const src = require('fs').readFileSync(__filename, 'utf8');
  // Strip this function itself, or the literals below would match themselves — and strip comment
  // lines, because the first version of this check refused to run on account of its OWN header
  // comment, which says "No DELETE, no UPDATE, no INSERT". A guard that fires on the sentence
  // describing it is not a guard, it is a tongue-twister.
  const body = src
    .slice(0, src.indexOf('function selfCheck'))
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  for (const verb of ['DELETE ', 'UPDATE ', 'INSERT ', 'TRUNCATE', 'DROP ', 'ALTER ']) {
    if (body.toUpperCase().includes(verb)) {
      console.error(`REFUSED: this script claims to be read-only but contains ${verb.trim()}.`);
      process.exit(2);
    }
  }
}());

main().catch((e) => { console.error('REPORT FAILED:', e.message); process.exit(1); });
