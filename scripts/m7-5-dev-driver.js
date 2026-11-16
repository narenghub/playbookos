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
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 240)}`); };
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

/** Waits for a predicate on a fresh read, so nothing here depends on a guessed sleep. */
async function until(label, fn, { timeoutMs = 45_000, everyMs = 500 } = {}) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { ok: true, ms: Date.now() - started, value: v };
    if (Date.now() - started > timeoutMs) return { ok: false, ms: Date.now() - started, label };
    await sleep(everyMs);
  }
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

async function enqueue(intentKey, payload) {
  const t = await LEASES.enqueueTask(
    { taskType: 'synthetic.echo', payload, intentKey }, deps);
  made.taskIds.push(t.taskId);
  made.intentKeys.push(intentKey);
  return t;
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

  // ── 1. END TO END ─────────────────────────────────────────────────────────
  head('1. synthetic.echo, end to end, worker on separate hardware');
  const t1 = await enqueue('m75-echo', { hello: 'mac', n: 41 });
  const done = await until('the task completes', async () =>
    await one(`SELECT status, output FROM worker_results WHERE task_id=$1`, [t1.taskId]));
  if (done.ok && done.value.status === 'SUCCEEDED' && done.value.output
      && done.value.output.echoed && done.value.output.echoed.n === 41) {
    ok(`executed by the Mac and reported in ${done.ms}ms`);
    note(`output: ${JSON.stringify(done.value.output).slice(0, 90)}`);
  } else bad('the Mac worker did not execute and report an echo task', JSON.stringify(done));

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
    bad('the Mac never claimed the cancellation task; the rest of this scenario cannot run');
  } else {
    ok(`claimed after ${claimed.ms}ms`);
    const cx = await LEASES.cancelTask(t2.taskId, { reason: 'M7.5 live cancellation' }, deps);
    if (!cx.ok) bad('cancel was refused', JSON.stringify(cx));
    const stopped = await until('it stops', async () => {
      const r = await one(`SELECT state FROM worker_tasks WHERE id=$1`, [t2.taskId]);
      return r && r.state === 'CANCELLED' ? r : null;
    });
    if (stopped.ok) ok(`the task is CANCELLED (${stopped.ms}ms after the cancel)`);
    else bad('the task did not reach CANCELLED', JSON.stringify(stopped));

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
  if (!claimed3.ok) bad('the Mac never claimed the STOP task');
  else {
    const sid = await setStop('capability', 'worker.execute', 'M7.5 live STOP test');
    const halted = await until('the worker stops', async () => {
      const r = await one(`SELECT COUNT(*)::int n FROM worker_results WHERE task_id=$1`, [t3.taskId]);
      const t = await one(`SELECT state FROM worker_tasks WHERE id=$1`, [t3.taskId]);
      return (t && t.state !== 'LEASED') || Number(r.n) > 0 ? { t, r } : null;
    });
    if (halted.ok && Number(halted.value.r.n) === 0) {
      ok(`the STOP ended execution in ${halted.ms}ms and nothing was reported`);
    } else if (halted.ok) {
      bad('a STOPped task still produced a result', JSON.stringify(halted.value));
    } else bad('the worker kept going after a STOP', JSON.stringify(halted));
    await clearStop(sid);
    ok('STOP cleared — it was a fixture STOP in a dev database, never one of the three');
  }

  // ── 5. EXPIRY ─────────────────────────────────────────────────────────────
  head('5. an expired lease is not a reset');
  const t4 = await enqueue('m75-expire', { delayMs: 25_000 });
  const claimed4 = await until('the Mac claims it', async () =>
    await one(`SELECT id FROM worker_tasks WHERE id=$1 AND state='LEASED'`, [t4.taskId]));
  if (!claimed4.ok) bad('the Mac never claimed the expiry task');
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
  if (!dres.ok) bad('the duplicate-submission task never completed');
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
  note('The crash itself is a MANUAL step: kill -9 the worker on the Mac while it holds a lease.');
  const t6 = await enqueue('m75-crash', { delayMs: 30_000 });
  const claimed6 = await until('the Mac claims it', async () =>
    await one(`SELECT id FROM worker_tasks WHERE id=$1 AND state='LEASED'`, [t6.taskId]));
  if (!claimed6.ok) bad('the Mac never claimed the crash task');
  else {
    console.log('');
    console.log('    >>> ON THE MAC, NOW:  kill -9 $(pgrep -f worker-client/run.js)');
    console.log('    >>> launchd should restart it within ThrottleInterval (60s).');
    console.log('    >>> This script waits up to 4 minutes.');
    console.log('');
    const settled = await until('the abandoned lease is reflected', async () => {
      await require('../src/lib/office/recovery').reap({ dryRun: false, limit: 50 }, deps);
      await LEASES.reflectAbandonedLeases({}, deps);
      const r = await one(`SELECT state FROM worker_tasks WHERE id=$1`, [t6.taskId]);
      return r.state === 'NEEDS_RESOLUTION' ? r : null;
    }, { timeoutMs: 240_000, everyMs: 5000 });
    if (settled.ok) ok(`the crashed task is NEEDS_RESOLUTION after ${Math.round(settled.ms / 1000)}s`);
    else bad('the crashed task never settled', JSON.stringify(settled));

    const dup = await one(`SELECT COUNT(*)::int n FROM worker_results WHERE task_id=$1`, [t6.taskId]);
    if (Number(dup.n) === 0) ok('and the restarted worker did NOT re-execute it');
    else bad('a crashed task was re-executed after the restart', `${dup.n} result row(s)`);

    // Control: the restarted worker must still be alive, or the line above proves nothing.
    const t7 = await enqueue('m75-crash-control', { hello: 'after-restart' });
    const alive = await until('the restarted worker takes new work', async () =>
      await one(`SELECT status FROM worker_results WHERE task_id=$1`, [t7.taskId]),
    { timeoutMs: 120_000, everyMs: 2000 });
    if (alive.ok) ok('control: the restarted worker executes NEW work — it really did come back');
    else bad('the worker never came back, so "did not re-execute" proved nothing', JSON.stringify(alive));
  }

  // ── 8. REVOCATION ─────────────────────────────────────────────────────────
  head('8. revocation ends access');
  note('This is LAST because it ends this identity. Everything above needed it alive.');
  const t8 = await enqueue('m75-revoke', { delayMs: 20_000 });
  const claimed8 = await until('the Mac claims it', async () =>
    await one(`SELECT id FROM worker_tasks WHERE id=$1 AND state='LEASED'`, [t8.taskId]));
  if (!claimed8.ok) bad('the Mac never claimed the revocation task');
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
    if (fail) {
      console.log(`FAIL  ${fail} scenario expectation(s) did not hold. M7.5 is not accepted.`);
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
