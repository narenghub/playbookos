#!/usr/bin/env node
// ── M7.4 THE WORKER ACTUALLY RUNS ───────────────────────────────────────────
//
//   node scripts/check-worker-runtime-db.js; echo "EXIT=$?"
//
// A real WorkerClient, over a real socket, against the real M7.3 API, against a real Postgres. It
// enrols over HTTP, claims, executes `synthetic.echo`, heartbeats, is cancelled mid-flight, loses
// its identity mid-flight, and reports. This is the "actual worker execution evidence".
//
// ── WHAT IS SIMULATED AND WHAT IS NOT ───────────────────────────────────────
//
// NOT simulated: the HMAC signing, the nonce per request, the HTTP round trip, the task handler,
// the AbortController, the deadline, the heartbeat loop, the server's refusals, the audit rows and
// every database interaction. All of that is executed.
//
// SIMULATED / UNTESTED: everything macOS. This container is Linux. `launchctl`, `security` and the
// Keychain do not exist here, so the installer and the LaunchAgent are verified only by `bash -n`
// and by parsing the rendered plist. The secret is injected directly in these tests instead of
// being read from a Keychain, which is why keychain.js refuses off-darwin rather than offering a
// file fallback — the fallback would have made this test pass through a code path that then exists
// in production.
//
// Loopback HTTP rather than HTTPS, deliberately: a self-signed certificate here would test
// Node's TLS stack, not this code, and run.js already refuses non-loopback http://.
//
// EXIT 0 every invariant holds · 1 one does not · 3 no Postgres, nothing proven

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { execFileSync } = require('child_process');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n  ── ${m} ──\n`);

const SEAL = { WORKER_SECRET_SEAL_KEY: 'd4'.repeat(32) };

// ── THE DISPOSABLE CLUSTER COMES FROM THE VERIFIED LIFECYCLE UTILITY (B7.20b) ──
//
// This file used to carry its own copy of `startTemp`/`stopTemp`: a fixed port, a `/var/tmp`
// directory, and `.finally(stopTemp)` for cleanup. That pair leaks, and not because somebody forgot
// a `finally`: these checks call `process.exit()` on both pass and fail, so a promise `finally`
// never runs, and a SIGTERM does not reach it at all. A leaked legacy cluster also carries no
// ownership record, so `pg-cleanup.js` correctly refuses to remove it — leaving it to accumulate.
// Measured: 66 orphaned directories, 28 GB, which filled the disk mid-gate and made several checks
// report `SKIP infrastructure unavailable` — a full disk presenting as a missing database.
//
// `scripts/lib/pg-legacy-harness.js` presents this exact contract and is backed by
// `pg-disposable`: signal and exit handlers, a random port, and an `OWNER.json` that makes a dead
// run's cluster positively identifiable and therefore removable.
const { startTemp: __startTemp, stopTemp } = require('./lib/pg-legacy-harness');
const startTemp = () => __startTemp('worker-runtime');

/** LISTEN sockets in this network namespace, so "the worker opens none" is measured, not asserted. */
function listeningSockets() {
  const out = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split('\n').slice(1)) {
        const c = line.trim().split(/\s+/);
        if (c.length > 3 && c[3] === '0A') out.push(`${f}:${c[1]}`);   // 0A = TCP_LISTEN
      }
    } catch (_) { /* not Linux */ }
  }
  return out.sort();
}

const url = startTemp();
if (!url) {
  console.log('  skip  no Postgres available');
  console.log('SKIP  the worker runtime was NOT exercised — this proved nothing.');
  process.exit(EXIT_NOT_EXECUTED);
}

let server = null;
(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: false, max: 12 });
  const query = (sql, params) => pool.query(sql, params);
  const withTransaction = async (fn) => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally { c.release(); }
  };

  const autonomy = require('../src/lib/autonomy');
  const RUNS = require('../src/lib/runs');
  const IDENTITY = require('../src/lib/worker/identity');
  const LEASES = require('../src/lib/worker/leases');
  const AUDIT = require('../src/lib/worker/audit');
  const WR = require('../src/api/worker.routes');
  const EXEC = require('../src/worker-client/executor');
  const { WorkerClient, backoffMs } = require('../src/worker-client/client');
  const RUNJS = require('../src/worker-client/run');
  const KEYCHAIN = require('../src/worker-client/keychain');

  const deps = { query, env: SEAL };
  const one = async (sql, p) => (await query(sql, p)).rows[0];
  const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Compresses the client's own waits so a 15s heartbeat interval does not make this a 10-minute test. */
  const fastSleep = (ms) => realSleep(Math.min(ms, 40));

  console.log('\n══ M7.4 WORKER RUNTIME — REAL CLIENT, REAL API, REAL POSTGRES ══');

  await autonomy.migrateAutonomy(query);
  await RUNS.migrateRuns(query);
  await require('../src/lib/office/schema').migrateOffice(query);
  await IDENTITY.migrateWorkerIdentity(query);
  await LEASES.migrateWorkerTasks(query);
  await AUDIT.migrateWorkerAudit(query);
  autonomy.resetForTests && autonomy.resetForTests();

  const beforeSockets = listeningSockets();

  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use('/api', WR.createWorkerRouter({ enable: true, query, withTransaction, env: SEAL }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const withServerSockets = listeningSockets();

  // ── 1. ENROLMENT OVER HTTP ──────────────────────────────────────────────
  head('1. a worker with no credential obtains one, and only once');

  const tok = await IDENTITY.createEnrollmentToken({ syntheticOnly: false,
      createdBy: await require('./lib/fixture-admin').fixtureAdmin(query), label: 'runtime-a' }, deps);
  const enrolled = await (await fetch(`${baseUrl}/api/worker/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: tok.token, hostFingerprint: 'linux-test' }),
  })).json();
  if (enrolled.ok && /^wkr_[0-9a-f]{32}$/.test(enrolled.workerId) && enrolled.secret) {
    ok(`enrolled ${enrolled.workerId} over HTTP — the gap M7.4 found in M7.3`);
  } else bad('enrolment over HTTP failed', JSON.stringify(enrolled).slice(0, 200));

  const reused = await (await fetch(`${baseUrl}/api/worker/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: tok.token }),
  })).json();
  if (!reused.ok && reused.code === 'token_already_used') ok('the same token is refused the second time');
  else bad('an enrollment token was reusable', JSON.stringify(reused));

  const noTok = await (await fetch(`${baseUrl}/api/worker/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  })).json();
  if (!noTok.ok) ok('and a request with no token is refused');
  else bad('enrolment succeeded with no token');

  const tokenLeak = await one(
    `SELECT COUNT(*)::int n FROM worker_audit WHERE detail::text LIKE '%' || $1 || '%'`, [tok.token]);
  if (Number(tokenLeak.n) === 0) ok('the token appears in no audit row');
  else bad('the enrollment token was written to the audit');

  const W = { workerId: enrolled.workerId, secret: enrolled.secret };
  const mkClient = (over = {}) => new WorkerClient({
    baseUrl, workerId: W.workerId, secret: W.secret, sleep: fastSleep, ...over,
  });

  // ── 2. IT ACTUALLY EXECUTES A TASK ──────────────────────────────────────
  head('2. synthetic.echo runs end to end');

  const t1 = await LEASES.enqueueTask(
    { taskType: 'synthetic.echo', payload: { hello: 'world', n: 7 }, intentKey: 'rt-echo-1' }, deps);
  const client = mkClient();
  const r1 = await client.runOnce();

  if (r1.did === 'reported' && r1.status === 'SUCCEEDED') ok(`executed and reported in ${r1.ms}ms`);
  else bad('the worker did not execute and report', JSON.stringify(r1));

  const stored = await one(`SELECT status, output FROM worker_results WHERE task_id=$1`, [t1.taskId]);
  if (stored && stored.status === 'SUCCEEDED'
      && stored.output && stored.output.echoed && stored.output.echoed.n === 7) {
    ok('the stored output is the handler\'s own validated output');
    note(`output: ${JSON.stringify(stored.output).slice(0, 80)}`);
  } else bad('the stored result is wrong', JSON.stringify(stored));

  const ts = await one(`SELECT state FROM worker_tasks WHERE id=$1`, [t1.taskId]);
  if (ts.state === 'COMPLETED') ok('the task is COMPLETED');
  else bad(`the task is ${ts.state}`);

  const runRow = await one(
    `SELECT state, trigger, trigger_detail FROM agent_runs WHERE intent_key='rt-echo-1'`);
  if (runRow.state === 'SUCCEEDED' && runRow.trigger === 'worker' && runRow.trigger_detail === W.workerId) {
    ok('the agent_run is SUCCEEDED and attributed to this exact worker identity');
  } else bad('the run is not attributed correctly', JSON.stringify(runRow));

  // ── 3. NO INBOUND SOCKET ────────────────────────────────────────────────
  head('3. the worker opens no listening socket');
  const afterClient = listeningSockets();
  const newOnes = afterClient.filter((s) => !withServerSockets.includes(s));
  if (newOnes.length === 0) {
    ok(`no new LISTEN socket appeared (measured: ${beforeSockets.length} before the test server, `
      + `${withServerSockets.length} with it, ${afterClient.length} after the worker ran)`);
  } else bad(`the worker opened ${newOnes.length} listening socket(s)`, newOnes.join(', '));

  const LEX = require('./js-lex');
  for (const f of ['client.js', 'executor.js', 'run.js', 'keychain.js']) {
    const code = LEX.blankCommentsOnly(
      fs.readFileSync(path.join(__dirname, '..', 'src', 'worker-client', f), 'utf8'));
    for (const t of ['createServer', '.listen(', 'WebSocketServer', 'net.Server']) {
      if (code.includes(t)) bad(`src/worker-client/${f} references ${t}`);
    }
  }
  ok('and no worker-client module contains server-creating code');

  // ── 4. CANCELLATION DURING EXECUTION ────────────────────────────────────
  head('4. cancelled mid-execution: it stops and reports NOTHING');

  const t2 = await LEASES.enqueueTask(
    { taskType: 'synthetic.echo', payload: { delayMs: 2500 }, intentKey: 'rt-cancel' }, deps);
  const c2 = mkClient();
  const running = c2.runOnce();
  await realSleep(400);
  const cx = await LEASES.cancelTask(t2.taskId, { reason: 'cancelled by the runtime check' }, deps);
  if (!cx.ok) bad('could not cancel', JSON.stringify(cx));
  const r2 = await running;

  if (r2.did === 'aborted' && r2.reportedAnything === false) {
    ok(`aborted mid-execution and reported nothing (${String(r2.reason).slice(0, 60)}…)`);
    note('not FAILED: "failed" would claim the work did not happen, and an aborted task may have');
    note('completed its effect before the abort landed.');
  } else bad('a cancelled task was not aborted cleanly', JSON.stringify(r2));

  const noResult = await one(`SELECT COUNT(*)::int n FROM worker_results WHERE task_id=$1`, [t2.taskId]);
  if (Number(noResult.n) === 0) ok('no result row was written for it');
  else bad('a cancelled task wrote a result');
  if (c2.unresolved.length === 1) ok('and the client recorded it as UNRESOLVED locally');
  else bad(`the client recorded ${c2.unresolved.length} unresolved items, expected 1`);

  // ANTI-VACUITY. "Aborted, reported nothing" is ALSO what a worker that never executed anything
  // would produce, so without a control the assertion above is satisfied by a no-op — which is
  // exactly the proxy-measurement defect this repo keeps finding. Prove it was RUNNING.
  const cancelledRun = await one(
    `SELECT trigger_detail, (started_at IS NOT NULL) AS started
       FROM agent_runs WHERE intent_key='rt-cancel'`);
  if (cancelledRun && cancelledRun.trigger_detail === W.workerId && cancelledRun.started) {
    ok('control: the task WAS claimed and started by this worker before the abort');
  } else bad('no evidence the task ever started — the "abort" may have been a no-op',
    JSON.stringify(cancelledRun));
  if (r2.ms >= 350) ok(`control: still executing when cancelled (${r2.ms}ms elapsed, cancel at 400ms)`);
  else bad(`it finished in ${r2.ms}ms, so the cancel cannot have landed mid-execution`);

  // ── 5. MID-FLIGHT STOP ──────────────────────────────────────────────────
  head('5. a STOP mid-execution does the same');
  const t3 = await LEASES.enqueueTask(
    { taskType: 'synthetic.echo', payload: { delayMs: 2500 }, intentKey: 'rt-stop' }, deps);
  const c3 = mkClient();
  const running3 = c3.runOnce();
  await realSleep(400);
  await query(`INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
               VALUES ('global','','M7.4 runtime check: containment mid-execution','check')`);
  autonomy.resetForTests && autonomy.resetForTests();
  const r3 = await running3;
  await query(`DELETE FROM autonomy_stops WHERE scope_type='global'`);
  autonomy.resetForTests && autonomy.resetForTests();

  if (r3.did === 'aborted' && r3.reportedAnything === false) ok('a global STOP aborted the running task');
  else bad('a mid-flight STOP did not abort execution', JSON.stringify(r3));

  // ── 6. REVOKED MID-FLIGHT ───────────────────────────────────────────────
  head('6. losing its identity mid-execution');
  const tokB = await IDENTITY.createEnrollmentToken({ syntheticOnly: false,
      createdBy: await require('./lib/fixture-admin').fixtureAdmin(query), label: 'runtime-b' }, deps);
  const Bres = await (await fetch(`${baseUrl}/api/worker/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: tokB.token }),
  })).json();
  await LEASES.enqueueTask(
    { taskType: 'synthetic.echo', payload: { delayMs: 2500 }, intentKey: 'rt-revoke' }, deps);
  const c4 = new WorkerClient({ baseUrl, workerId: Bres.workerId, secret: Bres.secret, sleep: fastSleep });
  const running4 = c4.runOnce();
  await realSleep(400);
  await IDENTITY.revokeWorker(Bres.workerId, { reason: 'revoked during the runtime check' }, deps);
  const r4 = await running4;

  if (r4.did === 'aborted' && r4.reportedAnything === false) {
    ok('a revoked worker stops executing and reports nothing');
  } else bad('revocation did not stop the running task', JSON.stringify(r4));

  // ── 7. NO HANDLER IS A KNOWN FAILURE, NOT AN IMPROVISATION ──────────────
  head('7. an allowlisted type with no handler');
  const t5 = await LEASES.enqueueTask({ taskType: 'synthetic.sleep', intentKey: 'rt-nohandler' }, deps);
  const r5 = await mkClient().runOnce();
  if (r5.did === 'reported' && r5.status === 'FAILED') ok('reported FAILED — a known outcome, not a guess');
  else bad('a missing handler was not reported as a failure', JSON.stringify(r5));
  const f5 = await one(`SELECT status, output FROM worker_results WHERE task_id=$1`, [t5.taskId]);
  if (f5 && f5.output && f5.output.failure && f5.output.failure.code === 'no_handler') {
    ok('and the reason is structured in the result, not only in a log');
  } else bad('the failure reason was not recorded', JSON.stringify(f5));

  // ── THE INVARIANT, NOT THE COUNT ──────────────────────────────────────────
  //
  // This asserted `caps.implemented.length === 1`. Adding `synthetic.crash_test` on 2026-11-19
  // broke it — correctly by its own terms, but the property worth protecting was never "there is
  // exactly one handler". It is that `capabilities()` tells the truth about which declared types
  // this build can actually run: the two lists must partition the registry exactly, with no
  // overlap and nothing invented. A hardcoded count tests the author's memory of the build on the
  // day; the partition tests the property, and goes on testing it as handlers are added.
  const caps = EXEC.capabilities();
  const TASK_TYPES = require('../src/lib/worker/task-types');
  const handlerNames = Object.keys(EXEC.HANDLERS).sort();
  const impl = [...caps.implemented].sort();
  const notImpl = [...caps.declaredButNotImplemented].sort();
  const union = [...impl, ...notImpl].sort();
  const registry = [...TASK_TYPES.KNOWN].sort();

  const capProblems = [];
  if (JSON.stringify(impl) !== JSON.stringify(handlerNames)) {
    capProblems.push(`implemented ${JSON.stringify(impl)} != HANDLERS ${JSON.stringify(handlerNames)}`);
  }
  if (JSON.stringify(union) !== JSON.stringify(registry)) {
    capProblems.push(`the two lists do not partition the registry: ${JSON.stringify(union)} vs ${JSON.stringify(registry)}`);
  }
  const bothLists = impl.filter((t) => notImpl.includes(t));
  if (bothLists.length) capProblems.push(`a type is in both lists: ${bothLists.join(', ')}`);
  // Kept as a named case: a declared-but-unimplemented type must exist, or the second list is
  // only ever empty and the distinction this clause exists to check goes untested.
  if (!notImpl.includes('synthetic.sleep')) {
    capProblems.push('synthetic.sleep is declared and unimplemented, and must be reported as such');
  }

  if (!capProblems.length) {
    ok(`the executor is honest about its coverage: ${impl.length} implemented, `
      + `${notImpl.length} declared but not, partitioning all ${registry.length} declared types`);
  } else bad('capabilities() misreports what is implemented', `${capProblems.join('; ')} — ${JSON.stringify(caps)}`);

  // ── 8. DISPATCH IS CLOSED ───────────────────────────────────────────────
  head('8. nothing can make it run arbitrary code');
  for (const t of ['shell.run', '../../etc/passwd', 'synthetic.echo/../x', '']) {
    const r = await EXEC.execute({ taskType: t, payload: {} });
    if (r.verdict === 'FAILED' && ['unknown_task_type', 'no_handler'].includes(r.code)) {
      // refused before anything ran
    } else { bad(`executor accepted task type ${JSON.stringify(t)}`, JSON.stringify(r)); }
  }
  ok('unknown, traversal-shaped and empty type names are all refused before execution');
  const execSrc = LEX.blankCommentsOnly(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'worker-client', 'executor.js'), 'utf8'));
  if (!/require\([^')]*\$\{|require\(\s*[a-zA-Z]/.test(execSrc) && !/\beval\b|new Function|execSync|spawn/.test(execSrc)) {
    ok('the dispatch table is a frozen object: no dynamic require, no eval, no shell');
  } else bad('executor.js contains a dynamic require, eval or shell call');

  // ── 9. BOUNDS ───────────────────────────────────────────────────────────
  head('9. payload and result sizes are bounded on BOTH sides');
  const bigPayload = { blob: 'x'.repeat(20 * 1024) };
  await LEASES.enqueueTask({ taskType: 'synthetic.echo', payload: bigPayload, intentKey: 'rt-big' }, deps);
  const r6 = await mkClient().runOnce();
  if (r6.did === 'reported' && r6.status === 'FAILED') ok('an oversized payload is refused by the handler, and the refusal is reported');
  else bad('an oversized payload was not refused', JSON.stringify(r6));

  // The SERVER's own cap, which must hold against a client that does not check.
  const t7 = await LEASES.enqueueTask({ taskType: 'synthetic.echo', intentKey: 'rt-srvcap' }, deps);
  const held = await LEASES.claimTask({ workerId: W.workerId }, deps);
  const huge = await LEASES.submitResult(
    { workerId: W.workerId, runId: held.runId, status: 'SUCCEEDED', output: { blob: 'y'.repeat(300 * 1024) } }, deps);
  if (!huge.ok && huge.code === 'output_too_large') {
    ok(`the server refuses an oversized result independently (${huge.outputBytes} > ${LEASES.MAX_RESULT_BYTES})`);
    note('the client checking its own output is a statement about the client');
  } else bad('the server accepted an oversized result', JSON.stringify(huge));
  void t7;

  // ── 10. RETRY POLICY ───────────────────────────────────────────────────
  head('10. retries are bounded, jittered, and never re-execute');
  const waits = Array.from({ length: 40 }, () => backoffMs(3, { baseBackoffMs: 500, maxBackoffMs: 30_000 }));
  const cap = Math.min(30_000, 500 * (2 ** 2));
  if (waits.every((w) => w >= 0 && w <= cap)) ok(`backoff stays within its cap (${cap}ms at attempt 3)`);
  else bad('backoff exceeded its cap', `max ${Math.max(...waits)}`);
  if (new Set(waits).size > 20) ok('and is jittered — 40 samples produced many distinct values');
  else bad('backoff is not jittered; workers would retry in lockstep', `${new Set(waits).size} distinct`);

  // A 4xx is a DECISION. Retrying it would just repeat the answer while looking like a network fault.
  let attempts = 0;
  const counting = new WorkerClient({
    baseUrl, workerId: W.workerId, secret: W.secret, sleep: fastSleep,
    fetchImpl: async (...a) => { attempts += 1; return globalThis.fetch(...a); },
  });
  await query(`INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
               VALUES ('capability','worker.execute','M7.4: refusal is not a network fault','check')`);
  autonomy.resetForTests && autonomy.resetForTests();
  attempts = 0;
  const refused = await counting.runOnce();
  await query(`DELETE FROM autonomy_stops WHERE scope_key='worker.execute'`);
  autonomy.resetForTests && autonomy.resetForTests();
  if (refused.did === 'not_claimed' && attempts === 1) ok('a 409 refusal is NOT retried — one request, one answer');
  else bad(`a refusal caused ${attempts} request(s)`, JSON.stringify(refused));

  // ── 11. CRASH / RESTART RECOVERY ───────────────────────────────────────
  head('11. a restarted worker does not re-execute an abandoned task');
  await LEASES.enqueueTask({ taskType: 'synthetic.echo', intentKey: 'rt-crash' }, deps);
  const crashed = await LEASES.claimTask({ workerId: W.workerId }, deps);
  await query(
    `UPDATE agent_runs SET heartbeat_at = NOW() - INTERVAL '10 hours', started_at = NOW() - INTERVAL '10 hours'
      WHERE run_id = $1`, [crashed.runId]);
  await require('../src/lib/office/recovery').reap({ dryRun: false, limit: 50 }, deps);
  await LEASES.reflectAbandonedLeases({}, deps);

  const fresh = await mkClient().runOnce();
  if (fresh.did === 'nothing') {
    ok('a freshly started worker finds nothing to do — the abandoned task is NOT re-offered');
    note('its outcome is unknown, so re-running it is the one thing that must not happen automatically');
  } else bad('a restarted worker was handed an abandoned task', JSON.stringify(fresh));
  const crashState = await one(`SELECT state FROM worker_tasks WHERE intent_key='rt-crash'`);
  if (crashState.state === 'NEEDS_RESOLUTION') ok('and the task sits at NEEDS_RESOLUTION for a human');
  else bad(`the task is ${crashState.state}`);

  // ANTI-VACUITY. "Found nothing" is also what a permanently broken claim returns, and that would
  // make this section pass while the worker was in fact dead. So hand the same client a task it
  // SHOULD take, immediately afterwards.
  await LEASES.enqueueTask({ taskType: 'synthetic.echo', intentKey: 'rt-crash-control' }, deps);
  const after = await mkClient().runOnce();
  if (after.did === 'reported' && after.status === 'SUCCEEDED') {
    ok('control: the very next claimable task IS executed — "nothing to do" was a real answer');
  } else bad('the client could not claim anything at all, so section 11 proved nothing',
    JSON.stringify(after));

  // ── 12. LOGS AND DIAGNOSTICS CARRY NO SECRETS ──────────────────────────
  head('12. nothing secret reaches a log line or the diagnostic');
  const captured = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { captured.push(String(chunk)); return origWrite(chunk, ...rest); };
  RUNJS.logLine({ at: 'test', secret: W.secret, signature: 'abc', payload: { a: 1 }, output: { b: 2 },
    runId: 'r-1', workerId: W.workerId });
  process.stdout.write = origWrite;
  const line = captured.join('');
  if (!line.includes(W.secret) && !line.includes('abc') && !/payload|output/.test(line)) {
    ok('logLine drops secret, signature, payload and output; keeps runId and workerId');
  } else bad('a log line carried something it should not', line.slice(0, 200));

  const doc = RUNJS.doctor({ WORKER_API_BASE_URL: baseUrl, WORKER_ID: W.workerId });
  if (JSON.stringify(doc).indexOf(W.secret) === -1) ok('the diagnostic contains no secret');
  else bad('doctor() leaked the secret');
  // Now asserts the STATE, not a boolean. The boolean could not distinguish "absent" from
  // "present and macOS refused to release it", which is a real persistent state on macOS 26.4+.
  if (doc.keychainState === 'not_macos' && /not macOS/.test(String(doc.keychainDetail))) {
    ok(`doctor() reports the Keychain state honestly off-darwin: "${doc.keychainState}"`);
  } else bad('doctor() misreported Keychain state', JSON.stringify(doc));
  if (doc.keychainState !== 'missing') {
    ok('and does NOT claim the credential is missing merely because this is not macOS');
  } else bad('doctor() reported "missing" off-darwin, which is the defect this replaced');
  if (doc.inboundListeners === 0) ok('and reports zero inbound listeners');

  for (const fn of ['readSecret', 'writeSecret', 'deleteSecret']) {
    let threw = false;
    try { KEYCHAIN[fn]({ workerId: W.workerId, secret: 'x' }); } catch (_) { threw = true; }
    if (!threw) bad(`keychain.${fn} did NOT refuse off-darwin`, 'a file fallback would exist in production');
  }
  ok('keychain refuses off-darwin for every operation — there is no file fallback to inherit');

  // ── 13. macOS: WHAT WAS AND WAS NOT VERIFIED ───────────────────────────
  head('13. macOS installation — verified by parsing, NOT by running');
  const tpl = fs.readFileSync(
    path.join(__dirname, '..', 'installer', 'macos', 'ai.playnexa.worker.plist.template'), 'utf8');
  for (const [name, re] of [
    ['it is an AGENT with RunAtLoad', /<key>RunAtLoad<\/key>\s*<true\/>/],
    ['KeepAlive is conditional on exit status', /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/],
    ['ThrottleInterval is raised above the default', /<key>ThrottleInterval<\/key>\s*<integer>(\d+)<\/integer>/],
  ]) { if (re.test(tpl)) ok(name); else bad(`plist template: ${name}`); }

  if (!/secret|password|token|-w\s/i.test(tpl.replace(/<!--[\s\S]*?-->/g, ''))) {
    ok('the plist carries NO credential — the Keychain does');
  } else bad('the LaunchAgent template contains something credential-shaped');

  const ctl = fs.readFileSync(path.join(__dirname, '..', 'installer', 'macos', 'workerctl'), 'utf8');
  for (const [name, re] of [
    ['it refuses to run as root', /id -u.*!=.*0|do not run this as root/],
    ['it refuses an admin account', /grep -qx admin/],
    ['uninstall leaves the logs and says revocation is the real control', /REVOKE THE IDENTITY SERVER-SIDE/],
    ['it states plainly that it has not run on macOS', /NOT EXECUTED ON APPLE HARDWARE|NOT TESTED ON macOS/],
  ]) { if (re.test(ctl)) ok(name); else bad(`workerctl: ${name}`); }

  if (!/systemsetup|remotelogin|ARDAgent|screensharing|socketfilterfw|pfctl/i.test(
    ctl.replace(/^#.*$/gm, ''))) {
    ok('and it enables nothing inbound: no SSH, Remote Management, Screen Sharing or firewall change');
  } else bad('workerctl touches an inbound access setting');

  note('');
  note('NOT VERIFIED BY EXECUTION: launchctl bootstrap/kickstart/bootout, plutil -lint, the');
  note('Keychain write, PlistBuddy, and the account checks. This is Linux. They are syntax-checked');
  note('and the rendered plist parses, and that is the whole of the claim.');

  await pool.end();
})()
  .then(() => {
    if (server) server.close();
    console.log();
    if (fail) { console.log(`FAIL  ${fail} worker-runtime invariant(s) do not hold.`); process.exit(1); }
    console.log('PASS  a real worker enrolled, executed synthetic.echo, was cancelled mid-flight,');
    console.log('      stopped on STOP and on revocation, reported nothing when its outcome was');
    console.log('      uncertain, never re-executed an abandoned task, opened no listening socket,');
    console.log('      and leaked no secret to a log or a diagnostic.');
    console.log('      macOS installation is syntax-verified only — NOT run on Apple hardware.');
    process.exit(0);
  })
  .catch((e) => {
    if (server) server.close();
    console.log(`\nINCOMPLETE  ${(e && e.stack) || e}`);
    process.exit(EXIT_NOT_EXECUTED);
  })
  .finally(stopTemp);
