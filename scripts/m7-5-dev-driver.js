#!/usr/bin/env node
// ── M7.5 DEV-SERVER SIDE: DRIVE THE MAC WORKER THROUGH ITS FAILURE MODES ────
//
//   node scripts/m7-5-dev-driver.js mint      [--label mac-mini]
//   node scripts/m7-5-dev-driver.js watch
//   node scripts/m7-5-dev-driver.js scenarios --worker wkr_<32 hex>
//
// Runs on the DEVELOPMENT server, against the DEVELOPMENT database, while the real worker runs on
// the Mac mini. The split is the point: in M7.4 one process played both halves, which proves the
// two halves agree with each other and nothing about a worker on a different machine over a real
// network.
//
// ── IT REFUSES TO TOUCH PRODUCTION ──────────────────────────────────────────
//
// `scenarios` cancels tasks, sets a STOP and revokes an identity. Against production that would
// change containment state. So the database is checked first, by name and host, and anything
// production-shaped is refused before a single statement runs. "It would be refused anyway" is a
// prediction, not a safeguard — the repo has the scar.
//
// EXIT 0 every scenario behaved · 1 one did not · 2 refused to start · 3 could not complete

'use strict';

const { Pool } = require('pg');

const ARGV = process.argv.slice(2);
const CMD = ARGV[0];
const arg = (n) => { const i = ARGV.indexOf(n); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : null; };

let fail = 0;
// UNTESTED IS NOT PASSED AND IT IS NOT FAILED.
//
// On 2026-11-17 scenario 7's manual `kill -9` was never performed, and the script reported two
// FAILs for a crash that never happened. Both were meaningless, and one of them -- "a crashed task
// was re-executed after the restart" -- reads as a serious correctness defect. A reader skimming
// the transcript would have chased a bug that does not exist, while the real state of crash
// recovery (nobody knows) went unrecorded.
//
// A scenario whose preconditions did not occur produces UNTESTED. Acceptance requires zero
// failures AND zero untested, so this can never be mistaken for a pass.
let untestedCount = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 240)}`); };
const untested = (m, why) => {
  untestedCount += 1;
  console.log(`  UNTESTED  ${m}`);
  if (why) console.log(`          ${String(why).slice(0, 400)}`);
};
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n  ── ${m} ──\n`);

// ── THE PRODUCTION REFUSAL ──────────────────────────────────────────────────
//
// Named hosts and database names, not a substring search for "prod". A list is auditable; a guess
// about the shape of a hostname is how a guard ends up not firing on the one URL that mattered.
// postgres.railway.internal is deliberately absent — Railway's private DNS is project-scoped, so
// that name means "this project's database". scripts/lib/db-identity.js asks the database what
// it holds instead, which is the question that actually matters. See m7-dev-migrate.js.
const FORBIDDEN_HOSTS = [
  'interchange.proxy.rlwy.net',
  'app.playnexa.ai',
  'playbook.abiozen.com',
  'playbookos-production.up.railway.app',
];

function refuseIfProduction(raw) {
  if (!raw) {
    console.error('REFUSED: DATABASE_URL is not set. Point it at the DEVELOPMENT database.');
    process.exit(2);
  }
  let u;
  try { u = new URL(raw); } catch (_) {
    console.error('REFUSED: DATABASE_URL is not a URL this script can inspect, so it cannot be cleared.');
    process.exit(2);
  }
  // Never printed in full, and never echoed with its credentials.
  const host = u.hostname;
  const name = (u.pathname || '').replace(/^\//, '');
  for (const h of FORBIDDEN_HOSTS) {
    if (host === h || host.endsWith(`.${h}`)) {
      console.error(`REFUSED: ${host} is a production host. This script cancels tasks, sets a STOP`);
      console.error('and revokes an identity. None of that is going to happen to production.');
      process.exit(2);
    }
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('REFUSED: NODE_ENV=production. Unset it or run this on the development server.');
    process.exit(2);
  }
  if (process.env.M7_5_DEV_CONFIRM !== 'yes') {
    console.error('REFUSED: set M7_5_DEV_CONFIRM=yes to confirm this is the development database.');
    console.error(`         host=${host} database=${name || '(unnamed)'}`);
    console.error('This is a deliberate second pair of eyes, not a formality: the next few');
    console.error('statements cancel work, set a STOP, and revoke a credential.');
    process.exit(2);
  }
  return { host, name };
}

const where = refuseIfProduction(process.env.DATABASE_URL);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const query = (sql, params) => pool.query(sql, params);
const withTransaction = async (fn) => {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { c.release(); }
};

const IDENTITY = require('../src/lib/worker/identity');
const LEASES = require('../src/lib/worker/leases');
const autonomy = require('../src/lib/autonomy');
const deps = { query, withTransaction, env: process.env };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const one = async (sql, p) => (await query(sql, p)).rows[0];

// ── DEADLINES ARE DERIVED, NOT GUESSED ──────────────────────────────────────
//
// The 2026-11-17 run failed six scenarios against a correct worker because `until()` defaulted to
// a flat 45s while the worker's cycle was ~51s. That number was not arbitrary on the worker's
// side: leases.js issues `heartbeatEveryMs = max(15_000, (ceiling * 60_000) / 6)`, which is 50s at
// a five-minute ceiling, and Defect 6 made every task wait out one full interval before reporting.
//
// A test window that happens to be longer than an unrelated interval is fragile even when it
// passes. So the budget is now COMPOSED from the parts of the wait that actually exist:
//
//     the task's own delay  +  time to claim it  +  time to report it
//
// Defect 6 is fixed, so REPORT_GRACE_MS is small on purpose. If a future change reintroduces a
// per-task interval wait, these scenarios should FAIL — loudly and quickly — rather than being
// papered over by a window wide enough to hide it.
const CLAIM_GRACE_MS = 20_000;   // idle poll, claim round trip, and slack for a loaded machine
const REPORT_GRACE_MS = 15_000;  // execution end -> result recorded. Was ~50s under Defect 6.
const budget = (delayMs = 0) => Number(delayMs || 0) + CLAIM_GRACE_MS + REPORT_GRACE_MS;

// CANCELLATION AND STOP ARRIVE ON THE HEARTBEAT, so their worst case is one whole interval —
// legitimately, by design, and for a completely different reason from Defect 6. A scenario that
// waits on a signalled stop must budget for that or it will fail against a correct worker.
//
// leases.js: `heartbeatEveryMs = max(15_000, (ceiling * 60_000) / 6)`, which is 50s at the
// five-minute ceiling the dev API issues. Stated here as a derivation rather than a magic number,
// so that changing the ceiling makes the arithmetic visible instead of silently invalidating it.
const LEASE_CEILING_MIN = 5;
const HEARTBEAT_MS = Math.max(15_000, Math.floor((LEASE_CEILING_MIN * 60_000) / 6));
const signalBudget = () => HEARTBEAT_MS + REPORT_GRACE_MS + 10_000;

/** Waits for a predicate on a fresh read, so nothing here depends on a guessed sleep. */
async function until(label, fn, { timeoutMs = budget(0), everyMs = 500 } = {}) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { ok: true, ms: Date.now() - started, value: v };
    if (Date.now() - started > timeoutMs) return { ok: false, ms: Date.now() - started, label };
    await sleep(everyMs);
  }
}

// ── A TIMEOUT IS NOT A DIAGNOSIS ────────────────────────────────────────────
//
// `{"ok":false,"ms":45213,"label":"the task completes"}` was the entire evidence offered for four
// of the 2026-11-17 failures. It says a deadline passed. It does not say whether the worker never
// claimed the task, claimed it and is still running it, finished it and failed to report, lost the
// lease, or was correctly refused — and those are five different problems with five different
// owners.
//
// So every timeout is now classified from the row state itself, in the vocabulary the owner asked
// for: execution failure, reporting delay, lease expiry, expected rejection, test orchestration.
async function diagnose(taskId) {
  let t = null; let results = 0;
  try { t = await one(`SELECT * FROM worker_tasks WHERE id = $1`, [taskId]); } catch (e) {
    return `TEST ORCHESTRATION: the task row could not be read (${String(e.message).slice(0, 120)})`;
  }
  if (!t) return 'TEST ORCHESTRATION: no such task row — the fixture was never created';
  try {
    const r = await one(`SELECT COUNT(*)::int n FROM worker_results WHERE task_id = $1`, [taskId]);
    results = Number(r && r.n) || 0;
  } catch (_) { /* a missing count must not mask the state below */ }

  const state = String(t.state || '').toUpperCase();
  const where = `state=${state}, result rows=${results}`;

  if (state === 'PENDING') {
    return `EXECUTION FAILURE: the worker never claimed it (${where}). The worker is not polling, `
      + 'is not running, holds no capability for this task type, or is stopped.';
  }
  if (state === 'LEASED') {
    return results > 0
      ? `TEST ORCHESTRATION: a result exists but the task is still LEASED (${where}) — the `
        + 'predicate is watching the wrong column'
      : `REPORTING DELAY: claimed but nothing reported (${where}). The worker holds the lease. `
        + 'Under Defect 6 this is what a full heartbeat interval of dead time looked like.';
  }
  if (state === 'NEEDS_RESOLUTION') {
    return `LEASE EXPIRY: the lease was abandoned or expired (${where}). The outcome is uncertain `
      + 'by design, and a human resolves it — this is not the same as a failure to execute.';
  }
  if (state === 'CANCELLED' || state === 'STOPPED' || state === 'REVOKED') {
    return `EXPECTED REJECTION: the task reached ${state} (${where}). If the scenario expected `
      + 'completion, the refusal is the finding, not the timeout.';
  }
  if (state === 'DONE' || state === 'SUCCEEDED' || state === 'COMPLETED') {
    return `TEST ORCHESTRATION: the task actually completed (${where}) — the deadline expired `
      + 'before the predicate observed it, or the predicate is wrong.';
  }
  return `UNCLASSIFIED: ${where}. Report this state rather than guessing at it.`;
}

/** A timeout reported WITH its diagnosis. Never a bare `{ok:false,ms:…}` again. */
async function badTimeout(label, res, taskId) {
  bad(label, `${JSON.stringify(res)}\n          ${await diagnose(taskId)}`);
}

// Everything this script creates, so cleanup removes exactly that and nothing else — by id, never
// by timestamp, never by pattern, never by "recent".
const made = { taskIds: [], intentKeys: [], workerIds: [], stops: [] };

async function cleanup() {
  for (const id of made.taskIds) {
    try { await query(`DELETE FROM worker_results WHERE task_id = $1`, [id]); } catch (_) {}
    try { await query(`DELETE FROM worker_tasks WHERE id = $1`, [id]); } catch (_) {}
  }
  for (const k of made.intentKeys) {
    try { await query(`DELETE FROM agent_runs WHERE intent_key = $1`, [k]); } catch (_) {}
  }
  // autonomy_stops has no id column: its identity IS (scope_type, scope_key), which is the primary
  // key. So this is still "delete exactly the row I recorded creating" — the recorded identity just
  // happens to be two columns. It is NOT a widening.
  for (const s of made.stops) {
    try {
      await query(`DELETE FROM autonomy_stops WHERE scope_type = $1 AND scope_key = $2`,
        [s.scopeType, s.scopeKey]);
    } catch (_) {}
  }
  // Worker identities are NOT deleted: one of them was deliberately revoked and that record is the
  // evidence. Leaving it also means a rerun cannot silently reuse a revoked credential.
  const leaked = [];
  for (const id of made.taskIds) {
    const r = await one(`SELECT COUNT(*)::int n FROM worker_tasks WHERE id = $1`, [id]);
    if (Number(r.n)) leaked.push(id);
  }
  for (const s of made.stops) {
    const r = await one(
      `SELECT COUNT(*)::int n FROM autonomy_stops WHERE scope_type = $1 AND scope_key = $2`,
      [s.scopeType, s.scopeKey]);
    if (Number(r.n)) leaked.push(`stop:${s.scopeType}:${s.scopeKey}`);
  }
  if (leaked.length) {
    console.log(`\n  LEAK  ${leaked.length} fixture(s) could not be removed: ${leaked.join(', ')}`);
    return false;
  }
  return true;
}

async function setStop(scopeType, scopeKey, reason) {
  // Recorded BEFORE the insert. If the insert succeeds and then something throws, cleanup must
  // still know this row exists — a fixture recorded only on the success path is a fixture that
  // leaks on exactly the runs where it matters.
  const handle = { scopeType, scopeKey };
  made.stops.push(handle);
  await query(
    `INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
     VALUES ($1,$2,$3,'m7-5-dev-driver')
     ON CONFLICT (scope_type, scope_key) DO NOTHING`, [scopeType, scopeKey, reason]);
  return handle;
}
async function clearStop(handle) {
  await query(`DELETE FROM autonomy_stops WHERE scope_type = $1 AND scope_key = $2`,
    [handle.scopeType, handle.scopeKey]);
  made.stops = made.stops.filter((s) => s !== handle);
}

async function enqueue(intentKey, payload, taskType = 'synthetic.echo') {
  const t = await LEASES.enqueueTask({ taskType, payload, intentKey }, deps);
  made.taskIds.push(t.taskId);
  made.intentKeys.push(intentKey);
  return t;
}

// ── IS THERE A WORKER AT ALL? ───────────────────────────────────────────────
//
// On 2026-11-18 the operator's `kill -9` landed 33 seconds early, during scenario 2. Scenarios 3
// to 8 then each reported FAIL with "the Mac never claimed the task" — six product failures
// alleged against a product that was not running. The diagnosis text was right there and the
// verdict still said FAIL.
//
// `worker_identities.last_seen_at` advances on every authenticated request, so a polling worker
// moves it every few seconds whether or not it has work. If it does not advance, there is nothing
// to test, and the honest word for that is UNTESTED.
async function workerLastSeen() {
  const r = await one(`SELECT last_seen_at FROM worker_identities WHERE id = $1`, [workerId]);
  return r && r.last_seen_at ? new Date(r.last_seen_at).getTime() : null;
}

const LIVENESS_WINDOW_MS = 8_000;

/** True only if the worker demonstrably made a request during the window. */
async function workerIsPolling() {
  const before = await workerLastSeen();
  await sleep(LIVENESS_WINDOW_MS);
  const after = await workerLastSeen();
  return {
    polling: before !== null && after !== null && after > before,
    before, after,
  };
}

/**
 * A scenario whose task was never claimed. Distinguishes "the worker is here and did not do its
 * job" (a product FAIL) from "there was no worker" (UNTESTED). Never guesses.
 */
async function neverClaimed(scenario, taskId) {
  const live = await workerIsPolling();
  if (!live.polling) {
    untested(`${scenario} — no worker was polling`,
      `worker_identities.last_seen_at did not advance over ${LIVENESS_WINDOW_MS}ms `
      + `(${live.before ? new Date(live.before).toISOString() : 'never seen'} → `
      + `${live.after ? new Date(live.after).toISOString() : 'never seen'}). `
      + 'The worker is stopped, crashed, or cannot authenticate. This scenario\'s precondition '
      + 'did not hold, so it is neither a pass nor a product failure.');
    return;
  }
  await badTimeout(`${scenario} — the Mac never claimed the task`,
    { ok: false, ms: 0, label: 'claim' }, taskId);
}

// ── mint ────────────────────────────────────────────────────────────────────
async function cmdMint() {
  const label = arg('--label') || 'mac-mini';
  const t = await IDENTITY.createEnrollmentToken({ label }, deps);
  console.log('\nAn enrolment token has been minted. It is single-use and short-lived.\n');
  console.log('Carry it to the Mac mini by hand and paste it at the workerctl prompt. Do NOT put it');
  console.log('in a file, a chat message, an environment variable in your shell history, or argv.\n');
  console.log(t.token);
  console.log('\nThen on the Mac:  export WORKER_ID=<the id workerctl prints after enrolling>');
  console.log('The token is spent the moment it is used; if enrolment fails, mint another.\n');
}

// ── watch ───────────────────────────────────────────────────────────────────
async function cmdWatch() {
  console.log(`\nwatching ${where.host}/${where.name} — Ctrl-C to stop\n`);
  for (;;) {
    const rows = (await query(
      `SELECT t.intent_key, t.state, t.task_type, r.trigger_detail, r.state AS run_state,
              r.heartbeat_at, res.status
         FROM worker_tasks t
         LEFT JOIN agent_runs r ON r.intent_key = t.intent_key AND r.trigger = 'worker'
         LEFT JOIN worker_results res ON res.task_id = t.id
        ORDER BY t.created_at DESC LIMIT 12`)).rows;
    console.log(`\n${new Date().toISOString()}`);
    for (const r of rows) {
      console.log(`  ${String(r.intent_key).padEnd(28)} ${String(r.state).padEnd(17)} `
        + `run=${String(r.run_state || '-').padEnd(10)} result=${r.status || '-'} `
        + `worker=${r.trigger_detail || '-'}`);
    }
    await sleep(3000);
  }
}

// ── scenarios ───────────────────────────────────────────────────────────────
async function cmdScenarios() {
  const workerId = arg('--worker');
  if (!/^wkr_[0-9a-f]{32}$/.test(String(workerId))) {
    console.error('usage: --worker wkr_<32 hex>   (the id the Mac enrolled as)');
    process.exit(2);
  }
  console.log(`\n══ M7.5 SCENARIOS — dev database ${where.host}/${where.name} ══`);
  console.log(`   driving worker ${workerId}, which must be RUNNING on the Mac mini now.\n`);

  // The scenarios cancel tasks, set a STOP and revoke a credential. Identify the database first.
  const DBID = require('./lib/db-identity');
  const identified = await DBID.assertDevelopmentDatabase(query, { log: console.log });
  if (!identified.ok) {
    console.log(`\n  INCOMPLETE  the database was not identified as development (${identified.verdict}).`);
    process.exit(3);
  }

  const w = await IDENTITY.findWorker(workerId, deps);
  if (!w) { console.log(`  INCOMPLETE  no such worker identity in this database.`); process.exit(3); }
  if (w.revoked_at) { console.log(`  INCOMPLETE  that identity is already revoked.`); process.exit(3); }
  made.workerIds.push(workerId);

  // ── STALE FIXTURES FROM A PREVIOUS RUN ──────────────────────────────────
  //
  // On 2026-11-18 a freshly enrolled identity claimed two PENDING tasks left behind when the
  // 2026-11-17 run was abandoned mid-scenario. It executed them, and those leases looked for all
  // the world like evidence of a run that had not started — I read them as exactly that and said
  // so twice before the database corrected me.
  //
  // A run that begins with another run's claimable work in the queue cannot attribute its own
  // first scenarios. So this refuses to start, and names the ids. It does NOT delete them by
  // default: deleting is the owner's decision, and a driver that tidies production-adjacent state
  // on its own initiative is how the ten-minute DELETE got written in the first place.
  const staleRows = (await query(
    `SELECT id, intent_key, state FROM worker_tasks
      WHERE intent_key LIKE $1 AND state IN ('PENDING','LEASED')
      ORDER BY created_at`,
    ['m75-%'])).rows;

  if (staleRows.length) {
    console.log(`\n  ${staleRows.length} CLAIMABLE acceptance task(s) from a previous run:\n`);
    for (const t of staleRows) {
      console.log(`    ${t.id}  ${String(t.intent_key).padEnd(20)} ${t.state}`);
    }
    if (!ARGV.includes('--clean-stale')) {
      console.log('\n  INCOMPLETE  this worker would claim them, and the first scenarios would be');
      console.log('              measuring the previous run instead of this one.');
      console.log('\n  Re-run with --clean-stale to delete exactly the ids above (and the');
      console.log('  agent_runs and worker_results that belong to them), or clear them yourself.');
      console.log('  Nothing has been changed.');
      process.exit(3);
    }
    // Exactly the ids listed above. Recorded first, then removed, then verified — the same
    // discipline the rest of this script's cleanup follows.
    const staleIds = staleRows.map((t) => t.id);
    const staleKeys = [...new Set(staleRows.map((t) => t.intent_key))];
    for (const id of staleIds) {
      await query(`DELETE FROM worker_results WHERE task_id = $1`, [id]);
      await query(`DELETE FROM worker_tasks WHERE id = $1`, [id]);
    }
    for (const k of staleKeys) {
      await query(`DELETE FROM agent_runs WHERE intent_key = $1`, [k]);
    }
    const left = (await query(
      `SELECT COUNT(*)::int n FROM worker_tasks WHERE id = ANY($1)`, [staleIds])).rows[0].n;
    if (Number(left) === 0) {
      ok(`cleared ${staleIds.length} stale fixture(s) by id — the queue starts clean`);
    } else {
      bad(`${left} stale fixture(s) survived their own deletion`, staleIds.join(' '));
      console.log('\n  INCOMPLETE  refusing to run with an unclean queue.');
      process.exit(3);
    }
  } else {
    ok('no stale acceptance fixtures — this run starts from a clean queue');
  }

  // ── 1. END TO END ─────────────────────────────────────────────────────────
  head('1. synthetic.echo, end to end, worker on separate hardware');
  const t1 = await enqueue('m75-echo', { hello: 'mac', n: 41 });
  const done = await until('the task completes', async () =>
    await one(`SELECT status, output FROM worker_results WHERE task_id=$1`, [t1.taskId]));
  if (done.ok && done.value.status === 'SUCCEEDED' && done.value.output
      && done.value.output.echoed && done.value.output.echoed.n === 41) {
    ok(`executed by the Mac and reported in ${done.ms}ms`);
    note(`output: ${JSON.stringify(done.value.output).slice(0, 90)}`);
  } else await badTimeout('the Mac worker did not execute and report an echo task', done, t1.taskId);

  // ── 2. AUDIT AND agent_run LINKAGE ────────────────────────────────────────
  head('2. audit and agent_run linkage');
  const run = await one(
    `SELECT run_id, state, trigger, trigger_detail, started_at, ended_at
       FROM agent_runs WHERE intent_key='m75-echo'`);
  if (run && run.trigger === 'worker' && run.trigger_detail === workerId
      && run.state === 'SUCCEEDED' && run.started_at && run.ended_at) {
    ok('the agent_run is SUCCEEDED, attributed to this worker, with both timestamps set');
  } else bad('the agent_run linkage is wrong', JSON.stringify(run));

  // Columns are endpoint/outcome/code and the time column is `at`. This read `event` and
  // `created_at`, neither of which exists — it would have thrown on the Mac, in the middle of a
  // hardware run, and been indistinguishable from a worker problem. Found by EXPLAINing every
  // statement in this file against the real schema during the local rehearsal.
  const aud = (await query(
    `SELECT endpoint, outcome, code, run_id, worker_id FROM worker_audit
      WHERE worker_id = $1 ORDER BY at DESC LIMIT 20`, [workerId])).rows;
  if (aud.length) {
    const shapes = [...new Set(aud.map((a) => `${a.endpoint}:${a.outcome}`))];
    ok(`${aud.length} audit row(s) for this worker: ${shapes.join(', ')}`);
  } else bad('nothing was audited for a worker that just executed a task');
  const linked = aud.filter((a) => a.run_id === (run && run.run_id));
  if (linked.length) ok(`and ${linked.length} of them link to that exact run_id`);
  else bad('no audit row references the run it was about');

  const leak = await one(
    `SELECT COUNT(*)::int n FROM worker_audit
      WHERE detail::text ~* '(secret|signature|password|bearer|authorization)'`);
  if (Number(leak.n) === 0) ok('and no audit detail contains a credential-shaped field');
  else bad(`${leak.n} audit row(s) carry something credential-shaped`);

  // ── 3. LIVE CANCELLATION ──────────────────────────────────────────────────
  head('3. live cancellation while the Mac is executing');
  const t2 = await enqueue('m75-cancel', { delayMs: 20_000 });
  const claimed = await until('the Mac claims it', async () =>
    await one(`SELECT id FROM worker_tasks WHERE id=$1 AND state='LEASED'`, [t2.taskId]));
  if (!claimed.ok) {
    await neverClaimed('live cancellation', t2.taskId);
  } else {
    ok(`claimed after ${claimed.ms}ms`);
    const cx = await LEASES.cancelTask(t2.taskId, { reason: 'M7.5 live cancellation' }, deps);
    if (!cx.ok) bad('cancel was refused', JSON.stringify(cx));
    // Budget composed from THIS task's own delay, not a flat number that happened to work once.
    const stopped = await until('it stops', async () => {
      const r = await one(`SELECT state FROM worker_tasks WHERE id=$1`, [t2.taskId]);
      return r && r.state === 'CANCELLED' ? r : null;
    }, { timeoutMs: signalBudget() });
    if (stopped.ok) ok(`the task is CANCELLED (${stopped.ms}ms after the cancel)`);
    else await badTimeout('the task did not reach CANCELLED', stopped, t2.taskId);

    await sleep(4000);     // long enough for a worker that was going to report to have reported
    const res = await one(`SELECT COUNT(*)::int n FROM worker_results WHERE task_id=$1`, [t2.taskId]);
    if (Number(res.n) === 0) ok('and the Mac reported NOTHING for it — not even a FAILED');
    else bad('a cancelled task got a result row', `${res.n} row(s)`);
  }

  // ── 4. GLOBAL STOP MID-EXECUTION ──────────────────────────────────────────
  head('4. a STOP while the Mac is executing');
  const t3 = await enqueue('m75-stop', { delayMs: 20_000 });
  const claimed3 = await until('the Mac claims it', async () =>
    await one(`SELECT id FROM worker_tasks WHERE id=$1 AND state='LEASED'`, [t3.taskId]));
  if (!claimed3.ok) await neverClaimed('STOP enforcement mid-execution', t3.taskId);
  else {
    const sid = await setStop('capability', 'worker.execute', 'M7.5 live STOP test');
    const halted = await until('the worker stops', async () => {
      const r = await one(`SELECT COUNT(*)::int n FROM worker_results WHERE task_id=$1`, [t3.taskId]);
      const t = await one(`SELECT state FROM worker_tasks WHERE id=$1`, [t3.taskId]);
      return (t && t.state !== 'LEASED') || Number(r.n) > 0 ? { t, r } : null;
    }, { timeoutMs: signalBudget() });
    if (halted.ok && Number(halted.value.r.n) === 0) {
      ok(`the STOP ended execution in ${halted.ms}ms and nothing was reported`);
    } else if (halted.ok) {
      bad('a STOPped task still produced a result', JSON.stringify(halted.value));
    } else await badTimeout('the worker kept going after a STOP', halted, t3.taskId);
    await clearStop(sid);
    ok('STOP cleared — it was a fixture STOP in a dev database, never one of the three');
  }

  // ── 5. EXPIRY ─────────────────────────────────────────────────────────────
  head('5. an expired lease is not a reset');
  const t4 = await enqueue('m75-expire', { delayMs: 25_000 });
  const claimed4 = await until('the Mac claims it', async () =>
    await one(`SELECT id FROM worker_tasks WHERE id=$1 AND state='LEASED'`, [t4.taskId]));
  if (!claimed4.ok) await neverClaimed('expired lease is not a reset', t4.taskId);
  else {
    await query(
      `UPDATE agent_runs SET heartbeat_at = NOW() - INTERVAL '6 hours',
                             started_at   = NOW() - INTERVAL '6 hours'
        WHERE intent_key = 'm75-expire'`);
    await require('../src/lib/office/recovery').reap({ dryRun: false, limit: 50 }, deps);
    await LEASES.reflectAbandonedLeases({}, deps);
    const st = await one(`SELECT state FROM worker_tasks WHERE id=$1`, [t4.taskId]);
    if (st.state === 'NEEDS_RESOLUTION') ok('the task is NEEDS_RESOLUTION, not PENDING');
    else bad(`an expired lease left the task ${st.state}`, 'PENDING would mean silent re-execution');

    const reoffered = await until('nothing re-offers it', async () => {
      const r = await one(`SELECT state FROM worker_tasks WHERE id=$1`, [t4.taskId]);
      return r.state === 'LEASED' ? r : null;
    }, { timeoutMs: 12_000 });
    if (!reoffered.ok) ok('and no worker was handed it again in the following 12s');
    else bad('an abandoned task was re-offered to a worker');
  }

  // ── 6. DUPLICATE RESULT SUBMISSION ────────────────────────────────────────
  head('6. a duplicate result is recognised, not re-recorded');
  const t5 = await enqueue('m75-dup', { hello: 'dup' });
  const dres = await until('it completes', async () =>
    await one(`SELECT status FROM worker_results WHERE task_id=$1`, [t5.taskId]));
  if (!dres.ok) {
    // Routed through the liveness probe for the same reason as the claim failures: on 2026-11-18
    // this printed FAIL with a diagnosis that said, in the same breath, "the worker is not
    // running". A verdict that contradicts its own detail line is the thing to fix.
    const live = await workerIsPolling();
    if (!live.polling) {
      untested('duplicate-submission protection — no worker was polling',
        'The task was never executed, so there was no first result to duplicate.');
    } else {
      await badTimeout('the duplicate-submission task never completed', dres, t5.taskId);
    }
  }
  else {
    const r = await one(`SELECT run_id FROM agent_runs WHERE intent_key='m75-dup'`);
    const again = await LEASES.submitResult(
      { workerId, runId: r.run_id, status: 'SUCCEEDED', output: { echoed: { hello: 'dup' }, steps: 0 } }, deps);
    const count = await one(`SELECT COUNT(*)::int n FROM worker_results WHERE task_id=$1`, [t5.taskId]);
    if (Number(count.n) === 1) ok('still exactly one result row after a second submission');
    else bad(`${count.n} result rows for one task`);
    if (again && (again.duplicate === true || again.ok === false)) {
      ok(`the second submission was recognised (${again.duplicate ? 'duplicate' : again.code})`);
    } else bad('a duplicate submission was accepted as new', JSON.stringify(again));
  }

  // ── 7. CRASH RECOVERY ─────────────────────────────────────────────────────
  head('7. crash recovery');
  // ── THE CRASH IS NOW A TASK, NOT A KEYSTROKE ──────────────────────────────
  //
  // Twice this scenario produced nothing. On 2026-11-17 the manual `kill -9` never happened and
  // two FAILs were reported for a crash that did not occur. On 2026-11-18 it happened 33 seconds
  // early, during scenario 2, and took the six scenarios after it down as collateral.
  //
  // So the worker kills itself, when and only when it leases a `synthetic.crash_test` task that
  // names it — and the kill therefore happens, by construction, while the lease is held. No
  // operator timing, no remote execution path: see src/worker-client/handlers/synthetic-crash-test.js.
  //
  // The handshake has exactly two possible answers, and both are informative:
  //
  //   the worker is armed      → it dies holding the lease, and recovery is what we measure
  //   the worker is not armed  → it REPORTS a FAILED result with `crash_test_refused`, which is
  //                              not a product defect and not a pass. UNTESTED, with the reason.
  note('The crash is a gated self-SIGKILL triggered by leasing the task — no manual timing.');
  const t6 = await enqueue('m75-crash',
    { confirm: 'crash-this-worker', workerId }, 'synthetic.crash_test');
  const claimed6 = await until('the Mac claims the crash task', async () =>
    await one(`SELECT id FROM worker_tasks WHERE id=$1 AND state='LEASED'`, [t6.taskId]));
  if (!claimed6.ok) await neverClaimed('crash recovery', t6.taskId);
  else {
    ok('the crash task is LEASED — whatever happens next happens while the lease is held');

    // A refusal arrives as a reported result, and fast. Check for it before spending four minutes
    // waiting for a death that is never coming.
    const refusal = await until('the worker either dies or refuses', async () => {
      const r = await one(
        `SELECT status, error FROM worker_results WHERE task_id=$1`, [t6.taskId]);
      return r || null;
    }, { timeoutMs: 45_000, everyMs: 2_000 });

    if (refusal.ok && /crash_test_refused/.test(String(refusal.value.error || ''))) {
      untested('crash recovery — the worker is not armed for the crash handshake',
        `It refused and reported instead of dying: ${String(refusal.value.error).slice(0, 160)}. `
        + 'Arm it on the Mac with:  workerctl install <url> <wkr_id> --env development --crash-test '
        + 'then re-run. Nothing about crash recovery was exercised.');
    } else if (refusal.ok) {
      bad('the crash task completed normally instead of crashing the worker',
        JSON.stringify(refusal.value).slice(0, 200));
    } else {
      // Sampled BEFORE the wait so "did the worker stop beating" stays answerable afterwards.
      const beatBefore = await (async () => {
        const r = await one(
          `SELECT heartbeat_at FROM agent_runs WHERE intent_key = $1 ORDER BY started_at DESC LIMIT 1`,
          ['m75-crash']);
        return r && r.heartbeat_at ? new Date(r.heartbeat_at).getTime() : null;
      })();
      const settled = await until('the abandoned lease is reflected', async () => {
        await require('../src/lib/office/recovery').reap({ dryRun: false, limit: 50 }, deps);
        await LEASES.reflectAbandonedLeases({}, deps);
        const r = await one(`SELECT state FROM worker_tasks WHERE id=$1`, [t6.taskId]);
        return r.state === 'NEEDS_RESOLUTION' ? r : null;
      }, { timeoutMs: 240_000, everyMs: 5000 });

      // ── DID THE CRASH ACTUALLY HAPPEN? ──────────────────────────────────
      //
      // The handshake makes the crash deterministic, but "deterministic" is a claim about the
      // design, not an observation of this run. A live worker keeps advancing `heartbeat_at`; a
      // killed one stops. So the question stays answerable from data the system was already
      // writing, rather than from the design being believed.
      const beatAt = async () => {
        const r = await one(
          `SELECT heartbeat_at FROM agent_runs WHERE intent_key = $1 ORDER BY started_at DESC LIMIT 1`,
          ['m75-crash']);
        return r && r.heartbeat_at ? new Date(r.heartbeat_at).getTime() : null;
      };
      const beatNow = await beatAt();
      const neverStopped = !settled.ok && beatBefore !== null && beatNow !== null && beatNow > beatBefore;

      if (settled.ok) {
        ok(`the abandoned lease was reflected after ${Math.round(settled.ms / 1000)}s — the task is NEEDS_RESOLUTION`);

        const dup = await one(`SELECT COUNT(*)::int n FROM worker_results WHERE task_id=$1`, [t6.taskId]);
        if (Number(dup.n) === 0) ok('and nothing re-executed it — reexecutable:false was honoured');
        else bad('a crashed task was re-executed after the restart', `${dup.n} result row(s)`);

        // The task's terminal state is only half of it. A run left ACTIVE holds the per-intent
        // uniqueness constraint and silently blocks that intent for ever.
        const run = await one(
          `SELECT state, ended_at FROM agent_runs WHERE intent_key = $1 ORDER BY started_at DESC LIMIT 1`,
          ['m75-crash']);
        if (run && run.state && run.state !== 'RUNNING') {
          ok(`and the agent_run is ${run.state}, not left RUNNING`);
        } else {
          bad('the agent_run is still RUNNING after its lease was abandoned', JSON.stringify(run));
        }

        // Control: launchd must have brought the worker back, or "did not re-execute" is just a
        // statement that a dead worker did nothing.
        const t7 = await enqueue('m75-crash-control', { hello: 'after-restart' });
        const alive = await until('the restarted worker takes new work', async () =>
          await one(`SELECT status FROM worker_results WHERE task_id=$1`, [t7.taskId]),
        { timeoutMs: 180_000, everyMs: 2000 });
        if (alive.ok) ok('control: launchd restarted the worker and it executes NEW work');
        else await badTimeout('the worker never came back, so "did not re-execute" proved nothing',
          alive, t7.taskId);
      } else if (neverStopped) {
        untested('crash recovery — the worker never died',
          'The run\'s heartbeat_at kept advancing throughout the wait, so the worker was alive the '
          + 'whole time, yet it neither crashed nor reported a refusal. The handshake did not take '
          + 'effect. Nothing about crash recovery was exercised.');
      } else {
        await badTimeout('the crashed task never settled', settled, t6.taskId);
        untested('the re-execution, terminal-state and restart checks were skipped',
          'They only mean something once the abandoned lease has been reflected.');
      }
    }
  }

  // ── 8. REVOCATION ─────────────────────────────────────────────────────────
  head('8. revocation ends access');
  note('This is LAST because it ends this identity. Everything above needed it alive.');
  const t8 = await enqueue('m75-revoke', { delayMs: 20_000 });
  const claimed8 = await until('the Mac claims it', async () =>
    await one(`SELECT id FROM worker_tasks WHERE id=$1 AND state='LEASED'`, [t8.taskId]));
  if (!claimed8.ok) await neverClaimed('revocation ends access', t8.taskId);
  else {
    await IDENTITY.revokeWorker(workerId, { reason: 'M7.5 revocation test' }, deps);
    const after = await until('it stops', async () => {
      const t = await one(`SELECT state FROM worker_tasks WHERE id=$1`, [t8.taskId]);
      return t.state !== 'LEASED' ? t : null;
    }, { timeoutMs: 60_000 });
    if (after.ok) ok(`execution ended ${after.ms}ms after revocation (task is ${after.value.state})`);
    else bad('a revoked worker kept its lease', JSON.stringify(after));
    const res8 = await one(`SELECT COUNT(*)::int n FROM worker_results WHERE task_id=$1`, [t8.taskId]);
    if (Number(res8.n) === 0) ok('and it reported nothing');
    else bad('a revoked worker still reported a result');

    const t9 = await enqueue('m75-revoke-control', { hello: 'should-never-run' });
    const stillWorking = await until('a revoked worker claims nothing', async () =>
      await one(`SELECT COUNT(*)::int n FROM worker_results WHERE task_id=$1`, [t9.taskId]),
    { timeoutMs: 20_000, everyMs: 2000 });
    const n9 = stillWorking.ok ? Number(stillWorking.value.n) : 0;
    if (n9 === 0) ok('control: it claims no NEW work either — revocation is total');
    else bad('a revoked worker executed a new task');
  }

  const clean = await cleanup();
  console.log('');
  if (clean) ok('every fixture this script created was removed, by id');
  console.log('');
  console.log('  The revoked identity was deliberately LEFT in place as evidence. Mint a new one');
  console.log('  for any further testing: node scripts/m7-5-dev-driver.js mint');
}

(async () => {
  if (CMD === 'mint') return cmdMint();
  if (CMD === 'watch') return cmdWatch();
  if (CMD === 'scenarios') return cmdScenarios();
  console.error('usage: m7-5-dev-driver.js mint | watch | scenarios --worker wkr_<32 hex>');
  process.exit(2);
})()
  .then(async () => {
    await pool.end().catch(() => {});
    if (CMD !== 'scenarios') process.exit(0);
    console.log('');
    // ACCEPTANCE REQUIRES ZERO FAILURES **AND** ZERO UNTESTED.
    //
    // An untested scenario is not a weaker pass. Crash recovery going unexercised on 2026-11-17
    // meant nobody knew whether this machine survives being killed — and the transcript's two
    // confident FAILs made it look as though somebody did know, and that it was broken.
    if (fail || untestedCount) {
      if (fail) console.log(`FAIL  ${fail} scenario expectation(s) did not hold.`);
      if (untestedCount) {
        console.log(`UNTESTED  ${untestedCount} scenario(s) never ran. Their preconditions did not`);
        console.log('          occur, so they are neither passed nor failed — they are unknown.');
      }
      console.log('M7.5 is not accepted.');
      process.exit(1);
    }
    console.log('PASS  the Mac worker executed over the network, was cancelled, STOPped, expired,');
    console.log('      crashed, restarted and revoked — and in every uncertain case reported');
    console.log('      nothing rather than guessing an outcome.');
    process.exit(0);
  })
  .catch(async (e) => {
    console.log(`\nINCOMPLETE  ${(e && e.stack) || e}`);
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(3);
  });
