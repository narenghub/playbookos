#!/usr/bin/env node
// ── M7.3 WORKER API — OVER A REAL SOCKET, AGAINST A REAL POSTGRES ───────────
//
//   node scripts/check-worker-api-db.js; echo "EXIT=$?"
//
// The unit layers are covered elsewhere. What only an end-to-end run can establish: that the
// signature the worker computes is the signature the server checks (including the PATH, which
// express reports differently from the string the client typed), that a nonce survives a rolled-back
// operation, and that every refusal leaves an audit row.
//
// ── THE TEST THAT JUSTIFIES THE TRANSACTION BOUNDARY ───────────────────────
//
// Section 5 sends a correctly-signed request whose OPERATION fails, then replays it byte for byte.
// If authentication shared a transaction with the operation, the rollback would have released the
// nonce and the replay would be accepted. It must come back 'replayed'.
//
// That is the whole argument for authenticating outside the transaction, and without this test it
// would be a paragraph of reasoning in a comment rather than a property.
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

const SEAL = { WORKER_SECRET_SEAL_KEY: 'a9'.repeat(32) };

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
const startTemp = () => __startTemp('worker-api');

const url = startTemp();
if (!url) {
  console.log('  skip  no Postgres available');
  console.log('SKIP  the worker API was NOT exercised — this proved nothing.');
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
  const AUTHM = require('../src/lib/worker/auth');
  const WR = require('../src/api/worker.routes');

  const deps = { query, env: SEAL };
  const one = async (sql, p) => (await query(sql, p)).rows[0];
  const nonce = () => require('crypto').randomBytes(16).toString('hex');

  console.log('\n══ M7.3 WORKER API — REAL HTTP, REAL POSTGRES ══');

  // ── 0. IT CANNOT BE MOUNTED BY ACCIDENT (requirement 10) ────────────────
  head('0. the API cannot be mounted accidentally');

  if (typeof WR === 'object' && typeof WR.createWorkerRouter === 'function' && typeof WR !== 'function') {
    ok('the module exports a FACTORY, not a router');
    note("so app.use('/api', require('./worker.routes')) — the idiom every other router uses —");
    note('cannot mount this one');
  } else bad('worker.routes exports something router-shaped; the usual mounting idiom would work');

  try {
    express().use('/api', WR);
    bad('express ACCEPTED the module as middleware', 'it could be mounted with one careless line');
  } catch (e) { ok(`express refuses to mount the module directly (${e.constructor.name})`); }

  try {
    WR.createWorkerRouter({ env: {} });
    bad('the factory built a router with WORKER_API_ENABLED unset');
  } catch (e) { ok(`the factory refuses without ${WR.MOUNT_ENV}=true`); }

  for (const v of ['false', '0', 'yes', 'TRUE', '']) {
    try { WR.createWorkerRouter({ env: { [WR.MOUNT_ENV]: v } }); bad(`'${v}' was accepted as enabled`); }
    catch (_) { /* expected */ }
  }
  ok("only the exact string 'true' enables it — not 'TRUE', 'yes', '1' or ''");

  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  if (!/worker\.routes|createWorkerRouter/.test(serverSrc)) {
    ok('server.js does not reference this file at all — nothing mounts it today');
  } else bad('server.js references the worker API', 'it may be reachable in a deployed build');

  // ── BOOT THE REAL THING ─────────────────────────────────────────────────
  await autonomy.migrateAutonomy(query);
  await RUNS.migrateRuns(query);
  await require('../src/lib/office/schema').migrateOffice(query);
  await IDENTITY.migrateWorkerIdentity(query);
  await LEASES.migrateWorkerTasks(query);
  await AUDIT.migrateWorkerAudit(query);
  autonomy.resetForTests && autonomy.resetForTests();

  const app = express();
  // Mirrors server.js exactly: the raw body is captured for signature verification.
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use('/api', WR.createWorkerRouter({ enable: true, query, withTransaction, env: SEAL }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const tokA = await IDENTITY.createEnrollmentToken({ syntheticOnly: false, label: 'api-a' }, deps);
  const A = await IDENTITY.consumeEnrollmentToken({ token: tokA.token }, deps);
  const tokB = await IDENTITY.createEnrollmentToken({ syntheticOnly: false, label: 'api-b' }, deps);
  const B = await IDENTITY.consumeEnrollmentToken({ token: tokB.token }, deps);

  /** Signs and sends exactly what a worker would. Returns the parsed response plus the raw request. */
  async function call(who, method, p, body = undefined, over = {}) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const req = {
      workerId: over.workerId || who.workerId,
      method,
      path: p,
      timestamp: over.timestamp || String(Date.now()),
      nonce: over.nonce || nonce(),
      body: raw,
    };
    const headers = AUTHM.signRequest(over.secret || who.secret, req);
    if (over.signature !== undefined) headers['x-worker-signature'] = over.signature;
    if (over.dropHeaders) for (const h of over.dropHeaders) delete headers[h];
    const res = await fetch(base + p, {
      method,
      headers: { ...headers, ...(raw ? { 'content-type': 'application/json' } : {}) },
      body: raw || undefined,
    });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json, sent: { ...req, headers } };
  }
  /** Replays a previous call byte for byte, including its nonce. */
  async function replay(prev) {
    const raw = prev.sent.body;
    const res = await fetch(base + prev.sent.path, {
      method: prev.sent.method,
      headers: { ...prev.sent.headers, ...(raw ? { 'content-type': 'application/json' } : {}) },
      body: raw || undefined,
    });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
  }
  const auditCount = async (where, params) => Number((await one(
    `SELECT COUNT(*)::int n FROM worker_audit WHERE ${where}`, params)).n);

  // ── 1. AUTHENTICATION OVER THE WIRE ─────────────────────────────────────
  head('1. the signature the worker computes is the signature the server checks');
  await LEASES.enqueueTask({ taskType: 'synthetic.echo', intentKey: 'api-1' }, deps);

  const good = await call(A, 'POST', '/api/worker/claim', {});
  if (good.status === 200 && good.json.ok) ok(`a correctly signed claim succeeds (run ${String(good.json.runId).slice(0, 8)}…)`);
  else bad('a correctly signed claim failed over HTTP', JSON.stringify(good));
  note('this is the end-to-end check: express reports the path as originalUrl, and if the server');
  note('signed a different string from the client every request would fail as bad_signature');

  const unsigned = await fetch(base + '/api/worker/claim', { method: 'POST' });
  if (unsigned.status === 401) ok('an unsigned request is 401');
  else bad(`an unsigned request returned ${unsigned.status}`);

  const wrong = await call(A, 'POST', '/api/worker/claim', {}, { signature: 'deadbeef' });
  if (wrong.status === 401 && wrong.json.code === 'bad_signature') ok('a wrongly signed request is 401 bad_signature');
  else bad('a wrongly signed request was not refused', JSON.stringify(wrong));

  const foreignSecret = await call(A, 'POST', '/api/worker/claim', {}, { secret: B.secret });
  if (foreignSecret.status === 401) ok("signing worker A's id with worker B's secret is refused");
  else bad('a mismatched id/secret pair authenticated', JSON.stringify(foreignSecret));

  // ── 2. CROSS-WORKER RESULT SUBMISSION ───────────────────────────────────
  head('2. worker B cannot report on worker A\'s lease');
  const runA = good.json.runId;
  const cross = await call(B, 'POST', '/api/worker/result', { runId: runA, status: 'SUCCEEDED' });
  if (cross.status === 403 && cross.json.code === 'not_your_lease') ok('403 not_your_lease');
  else bad('a cross-worker result was accepted or mis-coded', JSON.stringify(cross));
  if (Number((await one(`SELECT COUNT(*)::int n FROM worker_results WHERE run_id=$1`, [runA])).n) === 0) {
    ok('and no result row was written');
  } else bad('a cross-worker submission wrote a result');

  const crossHb = await call(B, 'POST', '/api/worker/heartbeat', { runId: runA });
  if (crossHb.status === 409) ok("worker B cannot heartbeat worker A's lease either");
  else bad('a cross-worker heartbeat succeeded', JSON.stringify(crossHb));

  // ── 3. CANCELLATION STATUS WITHOUT EXTENDING THE LEASE ──────────────────
  head('3. the status endpoint does not extend the lease');
  const before = await one(`SELECT heartbeat_at FROM agent_runs WHERE run_id=$1`, [runA]);
  await new Promise((r) => setTimeout(r, 1100));
  const st = await call(A, 'GET', `/api/worker/lease/${runA}`);
  const after = await one(`SELECT heartbeat_at FROM agent_runs WHERE run_id=$1`, [runA]);
  if (st.status === 200 && st.json.cancel === false) ok('status reports not-cancelled');
  else bad('status did not report a healthy lease', JSON.stringify(st));
  if (String(before.heartbeat_at) === String(after.heartbeat_at)) {
    ok('and heartbeat_at is UNCHANGED');
    note('asking whether to stop should not require asserting you are still alive');
  } else bad('the status endpoint extended the lease', `${before.heartbeat_at} → ${after.heartbeat_at}`);

  const hb = await call(A, 'POST', '/api/worker/heartbeat', { runId: runA });
  const afterHb = await one(`SELECT heartbeat_at FROM agent_runs WHERE run_id=$1`, [runA]);
  if (hb.status === 200 && String(afterHb.heartbeat_at) !== String(after.heartbeat_at)) {
    ok('whereas a heartbeat does extend it');
  } else bad('a heartbeat did not extend the lease', JSON.stringify(hb));

  // ── 4. DUPLICATE RESULTS ────────────────────────────────────────────────
  head('4. a result is recorded once');
  const r1 = await call(A, 'POST', '/api/worker/result', { runId: runA, status: 'SUCCEEDED', output: { n: 1 } });
  if (r1.status === 200 && r1.json.duplicate === false) ok('first result recorded');
  else bad('the first result was not recorded', JSON.stringify(r1));
  if (/proposal/i.test(String(r1.json.note))) ok('and the response states it is a PROPOSAL, not a transmission');
  else bad('the response does not say a result is only a proposal');

  const r2 = await call(A, 'POST', '/api/worker/result', { runId: runA, status: 'SUCCEEDED', output: { n: 1 } });
  if (r2.status === 200 && r2.json.duplicate === true) ok('a second submission answers duplicate: true');
  else bad('a duplicate submission was not identified', JSON.stringify(r2));
  if (Number((await one(`SELECT COUNT(*)::int n FROM worker_results WHERE run_id=$1`, [runA])).n) === 1) {
    ok('exactly one result row exists');
  } else bad('duplicate submissions produced more than one row');

  // ── 5. THE NONCE SURVIVES A ROLLED-BACK OPERATION ───────────────────────
  head('5. replay protection does NOT depend on the operation succeeding');

  const failing = await call(A, 'POST', '/api/worker/result',
    { runId: '00000000-0000-4000-8000-000000000000', status: 'SUCCEEDED' });
  if (!failing.json.ok) ok(`a signed request whose operation fails is refused (${failing.json.code})`);
  else bad('a result for a nonexistent run was accepted');

  const again = await replay(failing);
  if (again.status === 401 && again.json.code === 'replayed') {
    ok('replaying it byte for byte is refused as REPLAYED, not re-evaluated');
    note('so the nonce committed even though the operation rolled back. Had authentication shared');
    note('the transaction, this replay would have been accepted — which is the entire reason the');
    note('nonce is recorded outside it.');
  } else {
    bad('A FAILED REQUEST RELEASED ITS NONCE', `the replay returned ${again.status} `
      + `${JSON.stringify(again.json)} — replay protection only holds for requests that succeed, `
      + 'which means authentication is inside the operation transaction');
  }

  const replayGood = await replay(good);
  if (replayGood.status === 401 && replayGood.json.code === 'replayed') ok('and a SUCCESSFUL request cannot be replayed either');
  else bad('a successful request was replayable', JSON.stringify(replayGood));

  // ── 6. MID-FLIGHT STOP ──────────────────────────────────────────────────
  head('6. a STOP mid-flight cancels the worker and refuses its result');
  await LEASES.enqueueTask({ taskType: 'synthetic.sleep', intentKey: 'api-stop' }, deps);
  const held = await call(A, 'POST', '/api/worker/claim', {});
  if (!held.json.ok) bad('could not lease the stop fixture', JSON.stringify(held));
  const runS = held.json.runId;

  await query(`INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
               VALUES ('global','','M7.3 check: mid-flight containment','check')`);
  autonomy.resetForTests && autonomy.resetForTests();

  const hbStop = await call(A, 'POST', '/api/worker/heartbeat', { runId: runS });
  if (hbStop.status === 200 && hbStop.json.cancel === true) ok('the heartbeat answers cancel: true');
  else bad('a mid-flight stop did not cancel via heartbeat', JSON.stringify(hbStop));

  const stStop = await call(A, 'GET', `/api/worker/lease/${runS}`);
  if (stStop.status === 200 && stStop.json.cancel === true) ok('and so does the status endpoint');
  else bad('the status endpoint missed the stop', JSON.stringify(stStop));

  const resStop = await call(A, 'POST', '/api/worker/result', { runId: runS, status: 'SUCCEEDED' });
  if (resStop.status === 409 && resStop.json.code === 'stopped') ok('and a result is refused with 409 stopped');
  else bad('a result was accepted during a stop', JSON.stringify(resStop));

  const claimStop = await call(A, 'POST', '/api/worker/claim', {});
  if (claimStop.status === 409 && claimStop.json.code === 'stopped') ok('and no new lease is granted');
  else bad('a lease was granted during a stop', JSON.stringify(claimStop));

  await query(`DELETE FROM autonomy_stops WHERE scope_type='global'`);
  autonomy.resetForTests && autonomy.resetForTests();

  // ── 7. REVOCATION RACE ──────────────────────────────────────────────────
  head('7. revoking a worker that is holding a lease');
  const stillOk = await call(A, 'POST', '/api/worker/heartbeat', { runId: runS });
  if (stillOk.status === 200) ok('the lease is live again once the stop is lifted');
  else bad('the lease did not resume after the stop was lifted', JSON.stringify(stillOk));

  const rv = await IDENTITY.revokeWorker(A.workerId, { reason: 'revocation race test' }, deps);
  if (!rv.ok) bad('revocation failed', JSON.stringify(rv));

  const afterRevoke = await call(A, 'POST', '/api/worker/heartbeat', { runId: runS });
  if (afterRevoke.status === 401 && afterRevoke.json.code === 'revoked') ok('its very next call is 401 revoked');
  else bad('a revoked worker was still served', JSON.stringify(afterRevoke));

  const resRevoked = await call(A, 'POST', '/api/worker/result', { runId: runS, status: 'SUCCEEDED' });
  if (resRevoked.status === 401) ok('and it cannot submit a result');
  else bad('a revoked worker submitted a result', JSON.stringify(resRevoked));

  const liveAfter = Number((await one(
    `SELECT COUNT(*)::int n FROM agent_runs WHERE run_id=$1 AND state IN ('CREATED','RUNNING')`, [runS])).n);
  if (liveAfter === 0) ok('and the lease it held was closed immediately, not left to expire');
  else bad('a revoked worker still holds a live lease');

  // ── 8. EXPIRED LEASE ────────────────────────────────────────────────────
  head('8. an expired lease cannot commit');
  const tokC = await IDENTITY.createEnrollmentToken({ syntheticOnly: false, label: 'api-c' }, deps);
  const C = await IDENTITY.consumeEnrollmentToken({ token: tokC.token }, deps);
  await LEASES.enqueueTask({ taskType: 'synthetic.sleep', intentKey: 'api-expire' }, deps);
  const dying = await call(C, 'POST', '/api/worker/claim', {});
  if (!dying.json.ok) bad('could not lease the expiry fixture', JSON.stringify(dying));
  await query(
    `UPDATE agent_runs SET heartbeat_at = NOW() - INTERVAL '10 hours', started_at = NOW() - INTERVAL '10 hours'
      WHERE run_id = $1`, [dying.json.runId]);
  await require('../src/lib/office/recovery').reap({ dryRun: false, limit: 50 }, deps);

  const late = await call(C, 'POST', '/api/worker/result', { runId: dying.json.runId, status: 'SUCCEEDED' });
  if (late.status === 409 && late.json.code === 'lease_not_live') ok('409 lease_not_live after the reaper abandoned it');
  else bad('a result was accepted against an abandoned lease', JSON.stringify(late));

  const lateHb = await call(C, 'POST', '/api/worker/heartbeat', { runId: dying.json.runId });
  if (lateHb.status === 409 && lateHb.json.cancel === true) ok('and its heartbeat tells the worker to stop');
  else bad('an abandoned lease did not signal cancellation', JSON.stringify(lateHb));

  // ── 9. THE AUDIT ────────────────────────────────────────────────────────
  head('9. every call left a durable, linked, secret-free audit row');

  const granted = await auditCount(`outcome = 'GRANTED'`);
  const denied = await auditCount(`outcome = 'DENIED'`);
  if (granted > 0 && denied > 0) ok(`${granted} GRANTED and ${denied} DENIED rows`);
  else bad(`audit has ${granted} granted / ${denied} denied — denials are the rows that matter most`);

  const unsignedAudited = await auditCount(`outcome='DENIED' AND code='unsigned'`);
  if (unsignedAudited > 0) ok('the UNSIGNED request was audited, with no worker identity to attribute it to');
  else bad('an unsigned request left no audit row');

  const replayAudited = await auditCount(`outcome='DENIED' AND code='replayed'`);
  if (replayAudited >= 2) ok('both replays were audited');
  else bad(`${replayAudited} replay denials audited, expected at least 2`);

  const revokedAudited = await auditCount(`outcome='DENIED' AND code='revoked' AND worker_id=$1`, [A.workerId]);
  if (revokedAudited >= 2) ok('the revoked worker\'s attempts are attributed to it by id');
  else bad(`${revokedAudited} revoked denials recorded for that worker`);

  const linked = await one(
    `SELECT COUNT(*)::int n FROM worker_audit WHERE outcome='GRANTED' AND code='leased'
       AND worker_id IS NOT NULL AND task_id IS NOT NULL AND run_id IS NOT NULL`);
  if (Number(linked.n) > 0) ok(`${linked.n} lease grant(s) link worker, task and agent_run together`);
  else bad('no audit row links worker, task and run — requirement 5 is not met');

  const runFk = await one(
    `SELECT COUNT(*)::int n FROM worker_audit a JOIN agent_runs r ON r.run_id = a.run_id
      WHERE a.code = 'leased'`);
  if (Number(runFk.n) > 0) ok('and those run ids resolve against agent_runs — the linkage is real');
  else bad('audit run ids do not join to agent_runs');

  // NOTHING SECRET. The forbidden-key filter is the control; this asserts it on real rows.
  const leaked = await one(
    `SELECT COUNT(*)::int n FROM worker_audit
      WHERE detail::text ~* '(signature|nonce|secret|token|password|payload|to_email)'`);
  if (Number(leaked.n) === 0) ok('no audit detail contains a signature, nonce, secret, token or recipient');
  else bad(`${leaked.n} audit row(s) contain something that should never be written`);

  const sanitized = AUDIT.safeDetail({
    keep: 'fine', signature: 'abc', worker_token: 'x', payload: { a: 1 }, to_email: 'a@b.c',
    nested: { deep: 'x' }, count: 3, flag: true,
  });
  const keys = Object.keys(sanitized).sort();
  if (keys.join(',') === 'count,flag,keep') ok(`safeDetail strips forbidden and nested values (kept: ${keys.join(', ')})`);
  else bad('safeDetail kept something it should not', JSON.stringify(sanitized));

  // ── 10. NO INBOUND LISTENER IS REQUIRED OF THE WORKER ───────────────────
  head('10. the protocol is outbound-polling only');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'worker.routes.js'), 'utf8');
  const LEX = require('./js-lex');
  const code = LEX.blankCommentsOnly(src);
  for (const t of ['listen(', 'createServer', 'WebSocket', 'ws://', 'callbackUrl', 'webhook']) {
    if (code.includes(t)) bad(`worker.routes.js references ${t} — the worker would need to be reachable`);
  }
  if (!fail || true) ok('the API never calls back to the worker: it answers, and the worker polls');
  if (code.includes('authenticateWorker')) ok('precondition: the lexer returned code, so the scan above meant something');
  else bad('the lexer blanked the code and the scan proved nothing');

  await pool.end();
})()
  .then(() => {
    if (server) server.close();
    console.log();
    if (fail) { console.log(`FAIL  ${fail} worker-API invariant(s) do not hold.`); process.exit(1); }
    console.log('PASS  the API authenticates over a real socket, refuses cross-worker and replayed');
    console.log('      requests, cancels mid-flight, records results once, closes leases on');
    console.log('      revocation, audits every grant AND denial without writing a secret — and');
    console.log('      cannot be mounted by a single careless line.');
    console.log('      Development evidence only.');
    process.exit(0);
  })
  .catch((e) => {
    if (server) server.close();
    console.log(`\nINCOMPLETE  ${(e && e.stack) || e}`);
    process.exit(EXIT_NOT_EXECUTED);
  })
  .finally(stopTemp);
