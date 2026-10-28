#!/usr/bin/env node
// ── READ THE LEDGER AS EVIDENCE ──────────────────────────────────────────────
//
//   railway ssh 'node scripts/show-run.js --canary'            today's github-sync canary
//   railway ssh 'node scripts/show-run.js --intent=<key>'      every attempt at one intent
//   railway ssh 'node scripts/show-run.js --run=<uuid>'        one run and its timeline
//   railway ssh 'node scripts/show-run.js --unresolved'        actions with unknown outcomes
//   railway ssh 'node scripts/show-run.js --stale'             runs that stopped reporting
//
// The database is the evidence, not the application log. --canary exits non-zero if the expected
// occurrence is missing or looks wrong, so it can be read as a verdict rather than a report.
'use strict';

const { ledger } = require('../src/lib/run-ledger');
const { query } = require('../src/lib/db');

const argv = process.argv.slice(2);
const arg = (n) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3) : null;
};
const has = (n) => argv.includes(`--${n}`);

const L = ledger({ query });
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const iso = (d) => (d ? new Date(d).toISOString() : '—');

async function timeline(runId) {
  const rows = await L.timeline(runId);
  if (!rows.length) { console.log('    (no events)'); return; }
  for (const e of rows) {
    const bits = [e.action_kind, e.subject_ref].filter(Boolean).join(' ');
    const out = e.success === null ? '' : (e.success ? 'ok' : 'FAILED');
    console.log(`    ${iso(e.at)}  ${pad(e.kind, 18)}${pad(bits, 28)}${out}${e.error ? ` — ${e.error}` : ''}`);
  }
}

async function showRun(runId) {
  const r = await L.getRun(runId);
  if (!r) { console.log(`  no run ${runId}`); return null; }
  const dur = r.started_at && r.ended_at ? `${((new Date(r.ended_at) - new Date(r.started_at)) / 1000).toFixed(1)}s` : '—';
  console.log(`  run        ${r.run_id}`);
  console.log(`  state      ${r.state}        attempt ${r.attempt}        duration ${dur}`);
  console.log(`  intent     ${r.intent_key || '(none — unprotected against duplicate triggers)'}`);
  console.log(`  workflow   ${r.workflow || '—'}        agent ${r.agent || '—'}        product ${r.product}`);
  console.log(`  trigger    ${r.trigger}${r.trigger_detail ? ` (${r.trigger_detail})` : ''}`);
  console.log(`  created    ${iso(r.created_at)}   started ${iso(r.started_at)}   ended ${iso(r.ended_at)}`);
  if (r.parent_run_id) console.log(`  parent     ${r.parent_run_id}   root ${r.root_run_id}`);
  if (r.predecessor_run_id) console.log(`  predecessor ${r.predecessor_run_id}  (retry)`);
  if (r.retry_override_reason) console.log(`  override   ${r.retry_override_reason}`);
  if (r.cost_usd != null) console.log(`  cost       $${r.cost_usd}  (PARTIAL/LOWER-BOUND: 8 of 16 LLM paths cannot report usage)`);
  if (r.stopped_by) {
    const s = await query(`SELECT action, scope_type, scope_key, reason, actor, at FROM autonomy_events WHERE id=$1`, [r.stopped_by]);
    const e = s.rows[0];
    if (e) console.log(`  stopped by autonomy_events#${r.stopped_by}: ${e.action} ${e.scope_type}${e.scope_key ? `:${e.scope_key}` : ''} — ${e.reason} (by ${e.actor}, ${iso(e.at)})`);
  }
  console.log('  timeline:');
  await timeline(r.run_id);
  return r;
}

(async () => {
  const commit = String(process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'unknown';

  if (has('unresolved')) {
    const rows = await L.unresolvedActions();
    console.log(`\n── UNKNOWN_OUTCOME · consequential actions attempted with no acknowledgement\n`);
    if (!rows.length) { console.log('  none.\n'); process.exit(0); }
    console.log('  These are neither FAILED nor safe to retry. A retry over one requires a recorded reason.\n');
    for (const r of rows) {
      console.log(`  ${iso(r.at)}  ${pad(r.action_kind, 18)}${pad(r.subject_ref || '', 24)}run=${r.run_id} (${r.run_state}, attempt ${r.attempt})`);
    }
    console.log('');
    process.exit(0);
  }

  if (has('stale')) {
    const rows = await L.staleRuns({ olderThanMinutes: Number(arg('minutes') || 90) });
    console.log(`\n── RUNNING runs that have stopped reporting\n`);
    if (!rows.length) { console.log('  none.\n'); process.exit(0); }
    for (const r of rows) console.log(`  ${pad(r.workflow, 40)}started ${iso(r.started_at)}  last heartbeat ${iso(r.heartbeat_at)}  run=${r.run_id}`);
    console.log('');
    process.exit(0);
  }

  // --recent lists the ledger by time rather than by intent key, which is the only way to tell
  // "the cron never fired" from "the cron fired and recorded under a different (or null) intent".
  // A lookup BY intent key cannot distinguish those two, and they have opposite causes.
  if (has('recent')) {
    const wf = arg('workflow');
    const rows = (await query(
      `SELECT run_id, workflow, trigger, intent_key, attempt, state, created_at, started_at, ended_at
         FROM agent_runs ${wf ? 'WHERE workflow = $2' : ''}
        ORDER BY created_at DESC LIMIT $1`,
      wf ? [Number(arg('limit') || 15), wf] : [Number(arg('limit') || 15)])).rows;
    console.log(`\n── ${rows.length} most recent run(s)${wf ? ` for ${wf}` : ''}\n`);
    if (!rows.length) { console.log('  (the ledger is empty)\n'); process.exit(0); }
    console.log(`  ${pad('created (UTC)', 26)}${pad('state', 12)}${pad('run_id', 38)}${pad('workflow', 32)}intent_key`);
    console.log(`  ${'─'.repeat(150)}`);
    for (const r of rows) {
      console.log(`  ${pad(iso(r.created_at), 26)}${pad(r.state, 12)}${pad(r.run_id, 38)}${pad(r.workflow || '—', 32)}`
        + `${r.intent_key === null ? '*** NULL — unprotected against duplicate triggers ***' : r.intent_key}`);
    }
    console.log('');
    const nulls = rows.filter((r) => r.intent_key === null && r.trigger === 'cron');
    if (nulls.length) {
      console.log(`  ${nulls.length} CRON run(s) recorded with NO intent key. A cron-triggered run should always`);
      console.log('  carry its scheduled slot; a null one means the firing context never reached the');
      console.log('  derivation, so duplicate-trigger protection was not in force for it.\n');
    }
    process.exit(0);
  }

  // The GitHub sync's OWN result, read from the table it writes. The ledger proves a run was
  // recorded; it says nothing about whether the sync did its job. Those are separate claims and
  // conflating them would let an instrumented no-op look like a healthy canary.
  if (has('github-stats')) {
    const rows = (await query(
      `SELECT stat_date, COUNT(*)::int AS users, SUM(commits)::int AS commits,
              SUM(prs_merged)::int AS prs_merged, MAX(synced_at) AS last_sync
         FROM github_stats GROUP BY stat_date ORDER BY stat_date DESC LIMIT $1`,
      [Number(arg('limit') || 7)])).rows;
    console.log(`\n── github_stats, most recent ${rows.length} day(s)\n`);
    if (!rows.length) { console.log('  (no rows — the sync has never written)\n'); process.exit(1); }
    console.log(`  ${pad('stat_date', 14)}${pad('users', 8)}${pad('commits', 10)}${pad('prs_merged', 12)}last_sync`);
    console.log(`  ${'─'.repeat(78)}`);
    for (const r of rows) {
      console.log(`  ${pad(r.stat_date, 14)}${pad(r.users, 8)}${pad(r.commits, 10)}${pad(r.prs_merged, 12)}${iso(r.last_sync)}`);
    }
    console.log('\n  The question this answers is whether the sync still produces what it produced');
    console.log('  before instrumentation — a comparable number of users on recent dates, and a');
    console.log('  last_sync from the latest run. It is NOT evidence that the ledger recorded it.\n');
    process.exit(0);
  }

  const runArg = arg('run');
  if (runArg) { console.log(''); await showRun(runArg); console.log(''); process.exit(0); }

  const canaryDate = arg('date') || new Date().toISOString().slice(0, 10);
  const intent = arg('intent') || (has('canary')
    ? `cron:daily-8utc-github-sync:${canaryDate}T08:00`
    : null);
  if (!intent) {
    console.log('usage: --canary | --intent=<key> | --run=<uuid> | --unresolved | --stale');
    process.exit(2);
  }

  console.log(`\n── intent ${intent} · read at commit ${commit}\n`);
  const attempts = await L.attemptsOf(intent);
  if (!attempts.length) {
    console.log('  NO RUN RECORDED for this intent.\n');
    if (has('canary')) {
      // Say which of the three possibilities this is, rather than leaving a missing row looking
      // like a failure. The canary fails closed, so "did not record" and "has not happened yet"
      // have to be distinguishable or a normal morning reads as an incident.
      const slotAt = new Date(`${canaryDate}T08:00:00Z`);
      const now = new Date();
      const anyRuns = await query(`SELECT COUNT(*)::int n FROM agent_runs`);
      const firstEver = await query(
        `SELECT MIN(created_at) AS t FROM agent_runs WHERE workflow = 'daily-8utc-github-sync'`);
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0));
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1);

      if (slotAt > now) {
        console.log(`  This slot is in the FUTURE (${iso(slotAt)}). Nothing is wrong — it has not fired yet.`);
      } else if (firstEver.rows[0].t && new Date(firstEver.rows[0].t) > slotAt) {
        console.log(`  This slot (${iso(slotAt)}) PREDATES the first instrumented run`);
        console.log(`  (${iso(firstEver.rows[0].t)}), so no record is expected for it.`);
        console.log(`  The next instrumented occurrence is ${iso(next)}.`);
      } else if (anyRuns.rows[0].n === 0) {
        console.log(`  The ledger is empty, so the canary has never recorded anything. If the`);
        console.log(`  instrumented build was deployed after ${iso(slotAt)}, that is expected.`);
        console.log(`  The next occurrence is ${iso(next)}.`);
      } else {
        console.log(`  The ledger holds other runs but nothing for this slot, and the slot has passed.`);
        console.log(`  THIS IS WORTH INVESTIGATING: the canary is fail-closed, so a missing row can`);
        console.log(`  mean the run identity could not be created and the sync was skipped.`);
        console.log(`  Check the Railway log for [LEDGER FAIL-CLOSED] or [LEDGER DUPLICATE].`);
      }
      console.log('');
      process.exit(1);
    }
    process.exit(1);
  }

  console.log(`  ${attempts.length} attempt(s):\n`);
  for (const a of attempts) {
    console.log(`  ── attempt ${a.attempt} ──`);
    await showRun(a.run_id);
    console.log('');
  }

  // The canary's own verdict. Asserted, not described.
  if (has('canary')) {
    let bad = 0;
    const a1 = attempts[0];
    const r = await L.getRun(a1.run_id);
    const check = (c, m) => { if (c) console.log(`  ok    ${m}`); else { bad += 1; console.log(`  FAIL  ${m}`); } };
    console.log('── canary verdict\n');
    check(attempts.length === 1, 'exactly one attempt for the scheduled slot');
    check(r.attempt === 1, 'attempt = 1');
    check(r.workflow === 'daily-8utc-github-sync', 'workflow is the canary');
    check(r.product === 'internal', "product is 'internal' (commit stats belong to no one business)");
    check(r.intent_key === intent, 'intent key is the scheduled slot');
    check(!!r.started_at && !!r.ended_at, 'start and end timestamps are both durable');
    check(r.state === 'SUCCEEDED', `terminal state is SUCCEEDED (got ${r.state})`);
    const kinds = (await L.timeline(r.run_id)).map((e) => e.kind);
    check(kinds[0] === 'RUN_CREATED' && kinds.includes('RUN_STARTED') && kinds[kinds.length - 1] === 'RUN_ENDED',
      `timeline is RUN_CREATED → RUN_STARTED → RUN_ENDED (got ${kinds.join(' → ')})`);
    const act = await query(
      `SELECT COUNT(*)::int n FROM agent_runs WHERE intent_key=$1 AND state IN ('CREATED','RUNNING')`, [intent]);
    check(act.rows[0].n === 0, 'no run is left active for a finished intent');
    console.log('');
    if (bad) { console.log(`✗ ${bad} canary expectation(s) not met.\n`); process.exit(1); }
    console.log('✓ canary evidence complete — and this is the DATABASE, not the application log.\n');
  }
  process.exit(0);
})().catch((e) => { console.error('show-run failed:', e && e.message ? e.message : e); process.exit(1); });
