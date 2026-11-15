#!/usr/bin/env node
// ── M7.2 TASK LEASING, AGAINST A REAL POSTGRES ──────────────────────────────
//
//   node scripts/check-worker-leasing-db.js; echo "EXIT=$?"
//
// A lease is an agent_runs row, so the things that matter here are arbitrated by Postgres: who gets
// the task, whether a result can be submitted twice, and what an expired lease leaves behind. A
// fake database would emulate exactly those, which is how `priorClaim` came to exist in a fake
// ledger and not in the real one.
//
// The expiry case uses the REAL reaper from src/lib/office/recovery.js rather than setting
// ABANDONED by hand. Hand-setting the state would test this file's reaction to a string; running
// the reaper tests whether the reaper and the queue actually agree.
//
// ── TWO ARBITERS, AND THIS CHECK ESTABLISHES WHICH DOES WHAT ────────────────
//
// claimTask() has two serialisation points: `UPDATE worker_tasks … WHERE state = 'PENDING'` and the
// uq_agent_runs_one_active index. Section 3 removes the index and measures what still holds, because
// "the index is the arbiter" was an assumption and assumptions about which control is load-bearing
// are what this project keeps paying for.
//
// EXIT 0 every invariant holds · 1 one does not · 3 no Postgres, nothing proven

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n  ── ${m} ──\n`);

const SEAL = { WORKER_SECRET_SEAL_KEY: 'c7'.repeat(32) };

let temp = null;
function startTemp() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/worker-lease-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55931' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55931 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55931`;
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
  console.log('SKIP  worker leasing was NOT exercised — this proved nothing.');
  process.exit(EXIT_NOT_EXECUTED);
}

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: false, max: 16 });
  const query = (sql, params) => pool.query(sql, params);
  const deps = { query, env: SEAL };

  const RUNS = require('../src/lib/runs');
  const RECOVERY = require('../src/lib/office/recovery');
  const autonomy = require('../src/lib/autonomy');
  const IDENTITY = require('../src/lib/worker/identity');
  const LEASES = require('../src/lib/worker/leases');
  const TYPES = require('../src/lib/worker/task-types');
  const TSCHEMA = require('../src/lib/worker/task-schema');

  const one = async (sql, p) => (await query(sql, p)).rows[0];
  const taskState = async (id) => (await one(`SELECT state, resolution_note FROM worker_tasks WHERE id=$1`, [id]));
  const liveLeases = async (intent) => Number((await one(
    `SELECT COUNT(*)::int n FROM agent_runs WHERE intent_key=$1 AND trigger='worker' AND state IN ('CREATED','RUNNING')`,
    [intent])).n);

  console.log('\n══ M7.2 WORKER TASK LEASING — REAL POSTGRES ══');

  // ── 0. SCHEMA ────────────────────────────────────────────────────────────
  head('0. migrations apply, and are idempotent');
  await autonomy.migrateAutonomy(query);
  await RUNS.migrateRuns(query);
  // The reaper's candidate query reads agent_runs.company_id, which migrateRuns does not create —
  // office/schema.js adds it. Found by recovery.reap() raising "column r.company_id does not
  // exist", which is a fixture gap rather than a defect, and exactly the kind of thing a fake
  // database would have hidden by not having a schema at all.
  await require('../src/lib/office/schema').migrateOffice(query);
  await IDENTITY.migrateWorkerIdentity(query);
  const m = await LEASES.migrateWorkerTasks(query);
  await LEASES.migrateWorkerTasks(query);
  ok(`worker task schema applied (${m.statements} statements) and re-applied cleanly`);

  const idx = await one(
    `SELECT COUNT(*)::int n FROM pg_indexes WHERE indexname='uq_agent_runs_one_active'`);
  if (idx.n === 1) ok('uq_agent_runs_one_active exists — run arbitration is in place');
  else bad('the run-arbitration index is absent; nothing below could mean what it says');

  const noLeaseTable = await one(
    `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_name='worker_leases'`);
  if (noLeaseTable.n === 0) ok('there is NO worker_leases table — the lease is an agent_runs row');
  else bad('a worker_leases table exists; run identity has been implemented twice');

  // enrol a worker
  const tok = await IDENTITY.createEnrollmentToken({ label: 'mac-mini-lease' }, deps);
  const W = await IDENTITY.consumeEnrollmentToken({ token: tok.token }, deps);
  const worker = W.workerId;
  autonomy.resetForTests && autonomy.resetForTests();

  // ── 1. THE ALLOWLIST ─────────────────────────────────────────────────────
  head('1. only declared task types can be enqueued or executed');
  if (!TYPES.registryProblems().length) ok('every declared type states summary, reexecutable, readOnly and ceiling');
  else bad('the task-type registry is incomplete', TYPES.registryProblems().join('; '));

  const un = await LEASES.enqueueTask(
    { taskType: 'shell.run', payload: { cmd: 'rm -rf /' }, intentKey: 'evil-1' }, deps);
  if (!un.ok && un.code === 'unknown_task_type') ok('an undeclared type is refused at enqueue');
  else bad('an undeclared task type was enqueued', JSON.stringify(un));

  // And the row-level check: insert a task bypassing enqueueTask, as something else might.
  await query(
    `INSERT INTO worker_tasks (id, task_type, payload, intent_key) VALUES ('t-evil','shell.run','{}'::jsonb,'evil-2')`);
  const evil = await LEASES.claimTask({ workerId: worker, taskId: 't-evil' }, deps);
  if (!evil.ok && evil.code === 'unknown_task_type') {
    ok('a task row with an undeclared type is refused at CLAIM, before anything executes');
    note('enqueue checks the caller\'s intent; this checks the data the worker would actually run');
  } else bad('an undeclared type reached a worker', JSON.stringify(evil));
  await query(`DELETE FROM worker_tasks WHERE id='t-evil'`);

  // ── 2. CLAIM ─────────────────────────────────────────────────────────────
  head('2. a claim leases exactly one task, and a second claim of it is refused');
  const t1 = await LEASES.enqueueTask(
    { taskType: 'synthetic.echo', payload: { hello: 1 }, intentKey: 'intent-echo-1' }, deps);
  if (!t1.ok) bad('enqueue failed', JSON.stringify(t1));

  const c1 = await LEASES.claimTask({ workerId: worker }, deps);
  if (c1.ok && c1.taskId === t1.taskId) ok(`leased ${c1.taskId} (run ${c1.runId.slice(0, 8)}…)`);
  else bad('a claimable task was not leased', JSON.stringify(c1));
  if ((await taskState(t1.taskId)).state === 'LEASED') ok('the task is LEASED');
  else bad('the task state did not become LEASED');

  const c2 = await LEASES.claimTask({ workerId: worker, taskId: t1.taskId }, deps);
  if (!c2.ok) ok(`a second claim of the same task is refused (${c2.code})`);
  else bad('the same task was leased twice');

  // ── 3. CONCURRENCY, AND WHICH CONTROL IS LOAD-BEARING ───────────────────
  head('3. twelve workers race one task');
  const t2 = await LEASES.enqueueTask({ taskType: 'synthetic.echo', intentKey: 'intent-race' }, deps);
  const racers = await Promise.all(Array.from({ length: 12 },
    () => LEASES.claimTask({ workerId: worker, taskId: t2.taskId }, deps)));
  const won = racers.filter((r) => r.ok);
  if (won.length === 1) ok('exactly one claim succeeded out of twelve concurrent attempts');
  else bad(`${won.length} concurrent claims succeeded, not one`, racers.filter((r) => r.ok).map((r) => r.runId).join(', '));
  const live2 = await liveLeases('intent-race');
  if (live2 === 1) ok('exactly one live attempt exists for that intent');
  else bad(`${live2} live attempts exist for one intent`);

  // CONTROL — remove the index and measure what still holds.
  head('3b. CONTROL: with uq_agent_runs_one_active DROPPED, what still refuses?');
  const def = await one(`SELECT indexdef FROM pg_indexes WHERE indexname='uq_agent_runs_one_active'`);
  await query('DROP INDEX uq_agent_runs_one_active');
  const t3 = await LEASES.enqueueTask({ taskType: 'synthetic.echo', intentKey: 'intent-noindex' }, deps);
  const racers2 = await Promise.all(Array.from({ length: 12 },
    () => LEASES.claimTask({ workerId: worker, taskId: t3.taskId }, deps)));
  const won2 = racers2.filter((r) => r.ok);
  const live3 = await liveLeases('intent-noindex');
  await query(def.indexdef);

  if (won2.length === 1) {
    ok(`without the index, still exactly one WINNER — so the task UPDATE is the primary arbiter`);
    note(`and ${live3} live attempt(s) remained for that intent`);
    if (live3 === 1) {
      note('the losers\' attempts were closed by the compensating path, so the index is defence in');
      note('depth rather than the sole arbiter. claimTask\'s comment saying "the unique active index');
      note('is the arbiter" overstated it, and has been corrected to say so.');
    } else {
      bad(`${live3} live attempts survived without the index`,
        'the compensating close did not run for every loser — orphan RUNNING attempts would sit '
        + 'until the reaper abandoned them, holding the intent against a legitimate retry');
    }
  } else {
    bad(`THE INDEX WAS THE ONLY THING REFUSING: ${won2.length} winners without it`,
      'the task UPDATE is not serialising claims, which it must, because the index only prevents '
      + 'a second ATTEMPT and not a second EXECUTION');
  }
  const back = await one(`SELECT COUNT(*)::int n FROM pg_indexes WHERE indexname='uq_agent_runs_one_active'`);
  if (back.n === 1) ok('the index is restored'); else bad('THE INDEX WAS NOT RESTORED');

  // ── 4. THE KILL SWITCH AT ALL THREE CALL SITES ──────────────────────────
  head('4. a STOP prevents a lease, cancels a running one, and refuses a result');
  const t4 = await LEASES.enqueueTask({ taskType: 'synthetic.sleep', intentKey: 'intent-stopped' }, deps);

  await query(`INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
               VALUES ('capability','worker.execute','M7.2 check: stop all worker execution','check')`);
  autonomy.resetForTests && autonomy.resetForTests();

  const blocked = await LEASES.claimTask({ workerId: worker, taskId: t4.taskId }, deps);
  if (!blocked.ok && blocked.code === 'stopped') ok('lease issuance: refused under a capability stop');
  else bad('a lease was granted under a STOP', JSON.stringify(blocked));
  if (await liveLeases('intent-stopped') === 0) ok('and ZERO attempts were opened');
  else bad('an attempt was opened despite the stop');

  await query(`DELETE FROM autonomy_stops WHERE scope_key='worker.execute'`);
  autonomy.resetForTests && autonomy.resetForTests();

  const held = await LEASES.claimTask({ workerId: worker, taskId: t4.taskId }, deps);
  if (!held.ok) bad('could not lease after lifting the stop', JSON.stringify(held));
  const hb1 = await LEASES.heartbeat({ workerId: worker, runId: held.runId }, deps);
  if (hb1.ok && hb1.cancel === false) ok('heartbeat with no stop: keep going');
  else bad('a healthy heartbeat asked the worker to cancel', JSON.stringify(hb1));

  // MID-FLIGHT. The requirement refinement 1 names explicitly.
  await query(`INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
               VALUES ('global','','M7.2 check: global containment mid-flight','check')`);
  autonomy.resetForTests && autonomy.resetForTests();
  const hb2 = await LEASES.heartbeat({ workerId: worker, runId: held.runId }, deps);
  if (hb2.ok && hb2.cancel === true) {
    ok('heartbeat under a GLOBAL stop: cancel = true, mid-flight');
    note('a task that only checked the stop at the start would run on through a containment event');
  } else bad('a mid-flight global stop did not cancel the running task', JSON.stringify(hb2));

  const afterStop = await LEASES.submitResult(
    { workerId: worker, runId: held.runId, status: 'SUCCEEDED', output: { x: 1 } }, deps);
  if (!afterStop.ok && afterStop.code === 'stopped') ok('result acceptance: refused under the stop');
  else bad('a result was accepted while stopped', JSON.stringify(afterStop));
  const rowsWhileStopped = await one(`SELECT COUNT(*)::int n FROM worker_results WHERE run_id=$1`, [held.runId]);
  if (rowsWhileStopped.n === 0) ok('and no result row was written');
  else bad('a result row was written under a stop');

  await query(`DELETE FROM autonomy_stops WHERE scope_type='global'`);
  autonomy.resetForTests && autonomy.resetForTests();

  // ── 5. RESULTS ARE IDEMPOTENT ───────────────────────────────────────────
  head('5. a result is accepted once, and a duplicate is counted once');
  const r1 = await LEASES.submitResult(
    { workerId: worker, runId: held.runId, status: 'SUCCEEDED', output: { done: true } }, deps);
  if (r1.ok && r1.duplicate === false) ok('first submission accepted');
  else bad('the first result was not accepted', JSON.stringify(r1));

  const r2 = await LEASES.submitResult(
    { workerId: worker, runId: held.runId, status: 'SUCCEEDED', output: { done: true } }, deps);
  if (r2.ok && r2.duplicate === true) ok('second submission reports duplicate rather than failing');
  else bad('a duplicate submission was not identified as one', JSON.stringify(r2));

  const n = await one(`SELECT COUNT(*)::int n FROM worker_results WHERE run_id=$1`, [held.runId]);
  if (n.n === 1) ok('exactly ONE result row exists — counted once, by the primary key');
  else bad(`${n.n} result rows for one lease`);
  if ((await taskState(t4.taskId)).state === 'COMPLETED') ok('the task is COMPLETED');
  else bad('the task did not complete', JSON.stringify(await taskState(t4.taskId)));

  const foreign = await LEASES.heartbeat({ workerId: 'wkr_' + 'f'.repeat(32), runId: held.runId }, deps);
  if (!foreign.ok) ok('another worker cannot heartbeat this lease');
  else bad('a foreign worker heartbeat succeeded');

  // ── 6. AN EXPIRED LEASE IS NOT A RESET ──────────────────────────────────
  head('6. THE RULE: an expired lease does NOT mean the task is safe to run again');
  const t5 = await LEASES.enqueueTask({ taskType: 'synthetic.sleep', intentKey: 'intent-expire' }, deps);
  const dying = await LEASES.claimTask({ workerId: worker, taskId: t5.taskId }, deps);
  if (!dying.ok) bad('could not lease the expiry fixture', JSON.stringify(dying));

  // Age it past its ceiling, then run the REAL reaper.
  await query(
    `UPDATE agent_runs SET heartbeat_at = NOW() - INTERVAL '10 hours',
                           started_at   = NOW() - INTERVAL '10 hours'
      WHERE run_id = $1`, [dying.runId]);
  const reaped = await RECOVERY.reap({ dryRun: false, limit: 50 }, deps);
  const state = await one(`SELECT state FROM agent_runs WHERE run_id=$1`, [dying.runId]);
  if (state.state === 'ABANDONED') ok(`the real reaper abandoned the stale lease (reap: ${JSON.stringify(reaped).slice(0, 60)}…)`);
  else bad(`the reaper left the lease ${state.state}`, 'expected ABANDONED');

  const moved = await LEASES.reflectAbandonedLeases({}, deps);
  const ts = await taskState(t5.taskId);
  if (ts.state === 'NEEDS_RESOLUTION') {
    ok('the task is NEEDS_RESOLUTION');
    note(`note recorded: ${String(ts.resolution_note).slice(0, 70)}…`);
  } else bad(`the task is ${ts.state}`, 'expected NEEDS_RESOLUTION');
  if (ts.state !== 'PENDING') {
    ok('and specifically NOT PENDING — "nobody did this, try again" is a claim nothing established');
  }
  void moved;

  // A NEEDS_RESOLUTION task must not be handed out again by an ordinary claim.
  const reclaim = await LEASES.claimTask({ workerId: worker, taskId: t5.taskId }, deps);
  if (!reclaim.ok) ok(`an unresolved task is not claimable (${reclaim.code})`);
  else bad('an unresolved task was leased again automatically');

  // ── 7. THE CRASHED WORKER COMES BACK ────────────────────────────────────
  head('7. a worker that finishes AFTER its lease expired cannot commit');
  const late = await LEASES.submitResult(
    { workerId: worker, runId: dying.runId, status: 'SUCCEEDED', output: { late: true } }, deps);
  if (!late.ok && late.code === 'lease_not_live') {
    ok(`a result against an ABANDONED lease is refused (leaseState ${late.leaseState})`);
    note('a human may already have acted on "outcome unknown"; reopening it behind them would be');
    note('the duplicate-execution defect arriving late rather than concurrently.');
  } else bad('a late result reopened a closed attempt', JSON.stringify(late));
  const lateRows = await one(`SELECT COUNT(*)::int n FROM worker_results WHERE run_id=$1`, [dying.runId]);
  if (lateRows.n === 0) ok('and no result row was written');
  else bad('a late result was recorded');

  // ── 8. RE-ATTEMPT NEEDS A FACT AND A JUDGEMENT ──────────────────────────
  head('8. re-attempting an unresolved task: both gates');
  const cases = [
    ['proposal.draft_once', 'a perfectly good reason here', 'not_reexecutable',
      'a type that does NOT declare itself repeatable is refused even WITH an override'],
    ['synthetic.echo', null, 'override_reason_required',
      'a repeatable type still needs a recorded reason'],
    ['synthetic.echo', 'short', 'override_reason_required', 'and the reason must be substantive'],
    ['nope.nothing', 'a perfectly good reason here', 'unknown_task_type', 'unknown types never qualify'],
  ];
  for (const [type, reason, code, why] of cases) {
    const e = LEASES.reattemptEligibility(type, { overrideReason: reason });
    if (!e.eligible && e.code === code) ok(`${why} (${code})`);
    else bad(`${type} / ${JSON.stringify(reason)} gave ${JSON.stringify(e)}`, `expected ${code}`);
  }
  const good = LEASES.reattemptEligibility('synthetic.echo',
    { overrideReason: 'checked the mailbox; nothing was sent' });
  if (good.eligible && good.viaRetryRun) {
    ok('a repeatable type WITH a recorded reason is eligible — created via recovery.retryRun()');
    note('which owns the override enforcement, rather than this module reimplementing it');
  } else bad('a legitimate re-attempt was refused', JSON.stringify(good));

  // ── 9. REVOCATION REACHES A LIVE LEASE ──────────────────────────────────
  head('9. revoking a worker invalidates the lease it is holding (refinement 2)');
  const t6 = await LEASES.enqueueTask({ taskType: 'synthetic.sleep', intentKey: 'intent-revoke' }, deps);
  const tok2 = await IDENTITY.createEnrollmentToken({ label: 'to-revoke' }, deps);
  const W2 = await IDENTITY.consumeEnrollmentToken({ token: tok2.token }, deps);
  const held2 = await LEASES.claimTask({ workerId: W2.workerId, taskId: t6.taskId }, deps);
  if (!held2.ok) bad('could not lease for the revocation fixture', JSON.stringify(held2));
  if (await liveLeases('intent-revoke') === 1) ok('the lease is live before revocation');

  const rv = await IDENTITY.revokeWorker(W2.workerId, { reason: 'laptop stolen', actor: 'owner' }, deps);
  if (!rv.ok) bad('revocation failed', JSON.stringify(rv));
  if (await liveLeases('intent-revoke') === 0) {
    ok('revocation closed the live lease IMMEDIATELY, not at its ceiling');
    note(`closed ${rv.leases && rv.leases.closed.length} lease(s), moved ${rv.leases && rv.leases.tasks.length} task(s)`);
  } else bad('A REVOKED WORKER STILL HOLDS A LIVE LEASE',
    'revocation would only bite when the worker next asked for work — which a compromised one would not');

  const ts6 = await taskState(t6.taskId);
  if (ts6.state === 'NEEDS_RESOLUTION') {
    ok('and its task is NEEDS_RESOLUTION, not PENDING');
    note('the revoked worker may have completed the work before being revoked');
  } else bad(`the task is ${ts6.state}`, 'expected NEEDS_RESOLUTION');

  const afterRevoke = await LEASES.heartbeat({ workerId: W2.workerId, runId: held2.runId }, deps);
  if (!afterRevoke.ok) ok('and its heartbeat no longer holds anything');
  else bad('a revoked worker heartbeat succeeded');

  // ── 10. CANCELLATION ────────────────────────────────────────────────────
  head('10. cancelling a running task');
  const t7 = await LEASES.enqueueTask({ taskType: 'synthetic.sleep', intentKey: 'intent-cancel' }, deps);
  const held3 = await LEASES.claimTask({ workerId: worker, taskId: t7.taskId }, deps);
  const noReason = await LEASES.cancelTask(t7.taskId, { reason: 'nope' }, deps);
  if (!noReason.ok) ok('a cancellation without a substantive reason is refused');
  else bad('a one-word cancellation was accepted');

  const cx = await LEASES.cancelTask(t7.taskId, { reason: 'superseded by a newer request' }, deps);
  if (cx.ok) ok('cancellation recorded');
  else bad('cancel failed', JSON.stringify(cx));

  const hb3 = await LEASES.heartbeat({ workerId: worker, runId: held3.runId }, deps);
  if (hb3.ok && hb3.cancel === true) ok('the running worker learns of it on its next heartbeat');
  else bad('a cancelled task did not cancel its worker', JSON.stringify(hb3));

  const resAfterCancel = await LEASES.submitResult(
    { workerId: worker, runId: held3.runId, status: 'SUCCEEDED' }, deps);
  if (!resAfterCancel.ok && resAfterCancel.code === 'cancelled') {
    ok('and a result for it is refused, so ignoring the cancellation gains nothing');
  } else bad('a cancelled task accepted a result', JSON.stringify(resAfterCancel));

  void TSCHEMA;
  await pool.end();
})()
  .then(() => {
    console.log();
    if (fail) { console.log(`FAIL  ${fail} leasing invariant(s) do not hold.`); process.exit(1); }
    console.log('PASS  one lease per task under concurrency, the kill switch consulted at all three');
    console.log('      call sites, results counted once, revocation reaching a live lease, and an');
    console.log('      expired lease leaving NEEDS_RESOLUTION rather than a reset.');
    console.log('      Development evidence only. Nothing here speaks to production readiness.');
    process.exit(0);
  })
  .catch((e) => { console.log(`\nINCOMPLETE  ${(e && e.stack) || e}`); process.exit(EXIT_NOT_EXECUTED); })
  .finally(stopTemp);
