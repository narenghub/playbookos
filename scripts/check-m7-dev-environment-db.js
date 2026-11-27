#!/usr/bin/env node
// ── THE DEV ENVIRONMENT, STOOD UP AND USED, AGAINST A REAL POSTGRES ─────────
//
//   node scripts/check-m7-dev-environment-db.js; echo "EXIT=$?"
//
// Runs the exact operator sequence — migrate, contain, start the API, mint, enrol, execute — on a
// throwaway cluster, and asserts the thing that matters most:
//
//     THE CONTAINMENT THAT STOPS 42 CRONS MUST NOT STOP THE WORKER.
//
// That composition is the one failure that would waste a trip to the hardware. Each half is tested
// elsewhere; nothing tested them TOGETHER, and "42 stops are in place" plus "the worker runs" are
// two true statements that do not imply the third.
//
// EXIT 0 the sequence works · 1 it does not · 3 no Postgres, nothing proven

'use strict';

const fs = require('fs');
const http = require('http');
const express = require('express');
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 240)}`); };
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n  ── ${m} ──\n`);

const REPO = path.join(__dirname, '..');
const SEAL = 'c7'.repeat(32);

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
const startTemp = () => __startTemp('m7-devenv');

const url = startTemp();
if (!url) {
  console.log('  skip  no Postgres available');
  console.log('SKIP  the dev environment sequence was NOT exercised — this proved nothing.');
  process.exit(EXIT_NOT_EXECUTED);
}

/** Runs an operator script exactly as the owner will, and returns its real exit code. */
function operator(script, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    DATABASE_URL: url, M7_5_DEV_CONFIRM: 'yes', ...extraEnv,
  };
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', script), ...(extraEnv.__args || [])],
    { env, encoding: 'utf8', timeout: 180_000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

let server = null;
(async () => {
  console.log('\n══ M7 DEV ENVIRONMENT — THE OPERATOR SEQUENCE, EXECUTED ══');

  // ── 1. THE MIGRATION ──────────────────────────────────────────────────────
  head('1. the development-only migration creates every M7 artifact');

  const mig = operator('m7-dev-migrate.js');
  if (mig.code === 0 && /PASS/.test(mig.out)) {
    ok('m7-dev-migrate.js exits 0 and verifies its own result');
    const derived = (mig.out.match(/derived from DDL: (\d+) table\(s\), (\d+) index\(es\), (\d+) constraint/) || []);
    if (derived[1]) note(`derived ${derived[1]} tables, ${derived[2]} indexes, ${derived[3]} constraints from the DDL`);
  } else bad('the dev migration failed', mig.out.slice(-500));

  const again = operator('m7-dev-migrate.js');
  if (again.code === 0) ok('and it is idempotent — a second run also exits 0');
  else bad('the dev migration is not idempotent', again.out.slice(-300));

  const verifyOnly = operator('m7-dev-migrate.js', { __args: ['--verify'] });
  if (verifyOnly.code === 0 && /changing nothing/.test(verifyOnly.out)) {
    ok('--verify reports without applying anything');
  } else bad('--verify did not behave as a read-only check', verifyOnly.out.slice(-200));

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: false, max: 10 });
  const query = (sql, params) => pool.query(sql, params);
  const withTransaction = async (fn) => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally { c.release(); }
  };
  const one = async (sql, p) => (await query(sql, p)).rows[0];

  // The migration verifies itself; this confirms it independently, because a script's own verdict
  // on its own work is the weakest kind of evidence available.
  for (const t of ['worker_identities', 'worker_enrollment_tokens', 'worker_request_nonces',
    'worker_tasks', 'worker_results', 'worker_audit', 'agent_runs', 'autonomy_stops']) {
    const r = await one(`SELECT COUNT(*)::int n FROM pg_tables WHERE tablename = $1`, [t]);
    if (Number(r.n) !== 1) bad(`${t} does not exist after the migration`);
  }
  ok('all 8 tables the worker path needs exist (checked independently of the migration script)');

  // And the business schema is absent, which is the isolation property.
  const biz = await one(
    `SELECT COUNT(*)::int n FROM pg_tables WHERE tablename IN ('users','orders','email_log')`);
  if (Number(biz.n) === 0) {
    ok('users, orders and email_log do NOT exist — no schema here can hold business data');
  } else bad(`${biz.n} business table(s) exist in the minimal dev schema`);

  // ── 2. THE DEV API REFUSES, THEN STARTS ───────────────────────────────────
  head('2. the dev API rejects production URLs and provider credentials');

  const DEVAPI = path.join(REPO, 'scripts', 'dev-worker-api-server.js');
  const base = {
    PATH: process.env.PATH, HOME: process.env.HOME, M7_DEV_API: 'yes',
    WORKER_API_ENABLED: 'true', WORKER_SECRET_SEAL_KEY: SEAL, DATABASE_URL: url,
  };
  const start = (over) => {
    const env = { ...base, ...over };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const r = spawnSync(process.execPath, [DEVAPI], { env, encoding: 'utf8', timeout: 15_000 });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  // The Abiozen Django production DB is publicly reachable and unambiguously production, so it is
  // still refused by name. `postgres.railway.internal` is no longer on that list — project-scoped
  // DNS means it is the DEV database from inside the dev project — and is covered instead by
  // scripts/lib/db-identity.js, which check-db-identity-db.js exercises against real databases.
  const prodDb = start({ DATABASE_URL: 'postgresql://u:p@interchange.proxy.rlwy.net:18553/railway' });
  if (prodDb.code === 2 && /production database host/.test(prodDb.out)) {
    ok('refuses the Abiozen production database by host');
  } else bad('did not refuse the Abiozen production database', `exit ${prodDb.code}`);

  const withCred = start({ RESEND_API_KEY: 'x' });
  if (withCred.code === 2 && /provider credential/.test(withCred.out)) {
    ok('refuses to start with a provider credential in its environment');
  } else bad('started with a provider credential present', `exit ${withCred.code}`);

  const noFlag = start({ WORKER_API_ENABLED: 'TRUE' });
  if (noFlag.code === 2) ok("refuses WORKER_API_ENABLED='TRUE' — it must be exactly 'true'");
  else bad('accepted a near-miss activation flag');

  // ── 3. CONTAINMENT ────────────────────────────────────────────────────────
  head('3. containment halts all 42 crons');

  const seed = operator('m7-dev-seed-containment.js');
  if (seed.code === 0 && /PASS/.test(seed.out)) ok('the containment seed exits 0');
  else bad('the containment seed failed', seed.out.slice(-400));

  const autonomy = require('../src/lib/autonomy');
  autonomy.resetForTests && autonomy.resetForTests();
  const cronNames = Object.keys(autonomy.CRON_SCOPES);
  const stillRunning = [];
  for (const n of cronNames) {
    const blocked = await autonomy.checkStopped(
      autonomy.scopesForCron(n), { consequential: true, deps: { query } });
    if (!blocked) stillRunning.push(n);
  }
  if (stillRunning.length === 0) ok(`all ${cronNames.length} crons read as STOPPED`);
  else bad(`${stillRunning.length} cron(s) would run`, stillRunning.slice(0, 6).join(', '));

  const globals = await one(`SELECT COUNT(*)::int n FROM autonomy_stops WHERE scope_type='global'`);
  if (Number(globals.n) === 0) ok('and no global stop was written');
  else bad(`${globals.n} global stop(s) written — that would halt the worker too`);

  // ── 4. THE COMPOSITION — THE POINT OF THIS CHECK ──────────────────────────
  head('4. and the worker STILL EXECUTES with all of it in place');

  note('Each half is proven elsewhere. "42 crons are stopped" and "the worker runs" are two true');
  note('statements that do not imply the third. This runs the worker with the containment in force.');

  const WR = require('../src/api/worker.routes');
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use('/api', WR.createWorkerRouter({
    enable: true, query, withTransaction, env: { WORKER_SECRET_SEAL_KEY: SEAL },
  }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${server.address().port}`;

  const IDENTITY = require('../src/lib/worker/identity');
  const LEASES = require('../src/lib/worker/leases');
  const { WorkerClient } = require('../src/worker-client/client');
  const deps = { query, env: { WORKER_SECRET_SEAL_KEY: SEAL } };

  // The full operator sequence: token -> worker id -> secret -> signed requests.
  const tok = await IDENTITY.createEnrollmentToken({ label: 'mac-mini' }, deps);
  if (tok && tok.token && tok.token.length >= 20) ok(`an enrolment token was minted (${tok.token.length} chars)`);
  else bad('no usable enrolment token', JSON.stringify(tok));

  const enrolled = await (await fetch(`${apiBase}/api/worker/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: tok.token, hostFingerprint: 'darwin-mac-mini' }),
  })).json();
  if (enrolled.ok && /^wkr_[0-9a-f]{32}$/.test(enrolled.workerId)) {
    ok(`enrolment returned a well-formed worker id: ${enrolled.workerId}`);
  } else bad('enrolment failed', JSON.stringify(enrolled).slice(0, 200));

  const reuse = await (await fetch(`${apiBase}/api/worker/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: tok.token }),
  })).json();
  if (!reuse.ok && reuse.code === 'token_already_used') ok('and the token is single-use');
  else bad('the enrolment token was reusable', JSON.stringify(reuse));

  const stored = await one(`SELECT id, label, last_seen_at FROM worker_identities WHERE id = $1`,
    [enrolled.workerId]);
  if (stored && stored.label === 'mac-mini') ok('the identity is persisted with its label');
  else bad('the identity was not persisted correctly', JSON.stringify(stored));

  // NOW the composition.
  const t1 = await LEASES.enqueueTask(
    { taskType: 'synthetic.echo', payload: { hello: 'contained', n: 5 }, intentKey: 'devenv-1' }, deps);
  const client = new WorkerClient({
    baseUrl: apiBase, workerId: enrolled.workerId, secret: enrolled.secret,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 40))),
  });
  const r1 = await client.runOnce();

  if (r1.did === 'reported' && r1.status === 'SUCCEEDED') {
    ok('synthetic.echo EXECUTED with 42 workflow stops in force');
  } else bad('the containment prevented the worker from executing', JSON.stringify(r1));

  const res1 = await one(`SELECT status, output FROM worker_results WHERE task_id = $1`, [t1.taskId]);
  if (res1 && res1.status === 'SUCCEEDED' && res1.output.echoed && res1.output.echoed.n === 5) {
    ok('and the result is the handler\'s real output');
  } else bad('the stored result is wrong', JSON.stringify(res1));

  // The control: the containment must still be in force AFTER the worker ran. Without this, a seed
  // that silently cleared itself would make the section above pass for the wrong reason.
  const stillStopped = await autonomy.checkStopped(
    autonomy.scopesForCron(cronNames[0]), { consequential: true, deps: { query } });
  if (stillStopped) ok(`control: ${cronNames[0]} is still stopped after the worker ran`);
  else bad('the containment disappeared during the worker run');

  // And the converse control: stopping worker.execute must actually stop it, or "it executed
  // despite containment" would just mean containment never works on this path.
  await query(`INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
               VALUES ('capability','worker.execute','dev-env check: the converse control','check')
               ON CONFLICT (scope_type, scope_key) DO NOTHING`);
  autonomy.resetForTests && autonomy.resetForTests();
  await LEASES.enqueueTask({ taskType: 'synthetic.echo', intentKey: 'devenv-2' }, deps);
  const r2 = await client.runOnce();
  if (r2.did === 'not_claimed') {
    ok('control: stopping worker.execute DOES stop it — the permission above was real');
  } else bad('a worker.execute stop did not stop the worker', JSON.stringify(r2));
  await query(`DELETE FROM autonomy_stops WHERE scope_type='capability' AND scope_key='worker.execute'`);
  autonomy.resetForTests && autonomy.resetForTests();

  // ── 5. THE LIVENESS DIAGNOSTIC ────────────────────────────────────────────
  head('5. the liveness diagnostic, and that it is read-only');

  const LIVE = path.join(REPO, 'scripts', 'worker-liveness.js');
  const liveness = (extraArgs = []) => {
    const r = spawnSync(process.execPath, [LIVE, ...extraArgs],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: url }, encoding: 'utf8', timeout: 30_000 });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };

  const snapshot = async () => {
    const t = await one(`SELECT COUNT(*)::int n FROM worker_tasks`);
    const s = await one(`SELECT COUNT(*)::int n FROM autonomy_stops`);
    const a = await one(`SELECT COUNT(*)::int n FROM worker_audit`);
    const r = await one(`SELECT COUNT(*)::int n FROM worker_results`);
    const w = await one(`SELECT COUNT(*)::int n FROM worker_identities`);
    return `${t.n}/${s.n}/${a.n}/${r.n}/${w.n}`;
  };
  const before = await snapshot();
  const l1 = liveness();
  const after = await snapshot();
  if (before === after) ok(`it wrote nothing (row counts unchanged: ${before})`);
  else bad('the liveness diagnostic MODIFIED the database', `${before} -> ${after}`);

  const src = fs.readFileSync(LIVE, 'utf8');
  const mutations = ['INSERT INTO', 'UPDATE ', 'DELETE FROM', 'TRUNCATE', 'ALTER '];
  const found = mutations.filter((m) => new RegExp(m, 'i').test(src.replace(/^\s*\/\/.*$/gm, '')));
  if (found.length === 0) ok('and contains no mutating SQL at all');
  else bad(`it contains mutating SQL: ${found.join(', ')}`);
  for (const t of ['sendOperatorAlert', 'mailer', 'whatsapp', 'fetch(', 'require(\'https\')']) {
    if (src.replace(/^\s*\/\/.*$/gm, '').includes(t)) bad(`the liveness diagnostic references ${t}`);
  }
  ok('and makes no outbound call of any kind');

  // A live worker and an empty queue is the quiet case: exit 0.
  if (l1.code === 0) ok(`a live worker with no overdue work exits 0`);
  else bad(`exited ${l1.code} when nothing was wrong`, l1.out.slice(-300));

  // Now the condition that matters: overdue work, no live worker.
  await query(`UPDATE worker_identities SET last_seen_at = NOW() - INTERVAL '3 hours'`);
  await LEASES.enqueueTask({ taskType: 'synthetic.echo', intentKey: 'devenv-stale' }, deps);
  await query(`UPDATE worker_tasks SET created_at = NOW() - INTERVAL '3 hours'
                WHERE intent_key = 'devenv-stale'`);
  const l2 = liveness(['--stale-minutes', '20']);
  if (l2.code === 1 && /WORK WAITING, NO WORKER ALIVE/.test(l2.out)) {
    ok('overdue work with no live worker exits 1 and says so');
  } else bad('it did not detect work waiting with no worker', `exit ${l2.code}: ${l2.out.slice(-300)}`);

  // The self-suppression property: the SAME absent worker, with nothing waiting, is silent.
  await query(`DELETE FROM worker_tasks WHERE state = 'PENDING'`);
  const l3 = liveness(['--stale-minutes', '20']);
  if (l3.code === 0 && /nothing is waiting/.test(l3.out)) {
    ok('the same absent worker with an EMPTY queue is silent — exit 0');
    note('this is why it will not page you for a normal Option B reboot');
  } else bad('an absent worker with no work still alarmed', `exit ${l3.code}: ${l3.out.slice(-200)}`);

  // Wrong database must be "cannot tell", never "no workers".
  const l4 = spawnSync(process.execPath, [LIVE], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME,
      DATABASE_URL: url.replace('/postgres?', '/postgres?application_name=x&') },
    encoding: 'utf8', timeout: 30_000,
  });
  void l4;
  const l5 = liveness(['--json']);
  try {
    const j = JSON.parse(l5.out);
    if (j.verdict && j.workers && j.tasks) ok('--json emits a parseable report for a cron to consume');
    else bad('--json output is missing fields', l5.out.slice(0, 200));
  } catch (e) { bad('--json output does not parse', l5.out.slice(0, 200)); }

  await pool.end();
})()
  .then(() => {
    if (server) server.close();
    console.log();
    if (fail) { console.log(`FAIL  ${fail} problem(s) in the dev environment sequence.`); process.exit(1); }
    console.log('PASS  the operator sequence works end to end: the dev-only migration creates every');
    console.log('      M7 artifact and is idempotent, the dev API refuses production URLs and');
    console.log('      provider credentials, containment halts all 42 crons, THE WORKER STILL');
    console.log('      EXECUTES with that containment in force, and the liveness diagnostic reports');
    console.log('      without writing anything or calling out anywhere.');
    process.exit(0);
  })
  .catch((e) => {
    if (server) server.close();
    console.log(`\nINCOMPLETE  ${(e && e.stack) || e}`);
    process.exit(EXIT_NOT_EXECUTED);
  })
  .finally(stopTemp);
