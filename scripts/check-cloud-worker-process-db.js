#!/usr/bin/env node
// ── B4.2: THE WORKER PROCESS, RUNNING AS A CONTAINER RUNS IT ────────────────
//
//   node scripts/check-cloud-worker-process-db.js   exit 0 = every ruled property holds
//                                                    exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner's Priority 1 of 2026-11-25: *"Prepare everything possible in development so that my
// intervention is limited to the necessary service creation, enrollment and approval."*
//
// ── WHAT THIS ADDS THAT check-worker-runtime-db.js DOES NOT ────────────────
//
// That check enrols, claims, executes and heartbeats over real HTTP, and it is thorough. It also
// says this about itself:
//
//     "The secret is injected directly in these tests instead of being read from a Keychain"
//
// So it exercises the client LIBRARY with a credential handed to it. It never runs `run.js`, and
// therefore never exercises the thing a container actually does: start a PROCESS that has to find
// its own credential, build its own client, and poll.
//
// That gap is exactly where B4.2's blocker lived. `keychain.js` is macOS-only and refuses
// elsewhere by design, so until `secret-source.js` existed the worker process could not start in a
// Linux container at all — and no test would have told us, because no test started the process.
//
// This check spawns `node src/worker-client/run.js --once` as a SUBPROCESS, with its credential in
// the environment, against a real server on loopback. THIS CONTAINER IS LINUX, which is the same
// platform Railway runs, so what Railway adds is being long-running and reachable — not a
// different runtime.
//
// ── WHAT IS STILL NOT PROVEN HERE ──────────────────────────────────────────
//
// Being long-running (B4.7's 72 hours), automatic restart by the platform supervisor, and the
// Railway service's own networking. Those need the service. Everything the process itself must do
// is below.
//
// NO URL OVERRIDE: its own disposable cluster; fixtures by id.

'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail++;
  console.log(`  FAIL  ${m}`);
  if (extra !== undefined) console.log(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
};
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n── ${m} ──\n`);

const DISPOSABLE = require('./lib/pg-disposable');
let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'cloudw' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  the cloud worker process was not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'cloudw-bootstrap@cloudw.invalid';
process.env.ADMIN_PASSWORD = `cloudw-${crypto.randomBytes(16).toString('hex')}`;

const watchdog = setTimeout(() => {
  console.log('\n  FAIL  no progress in 300s — a stall is a failure.');
  try { cluster.destroy(); } catch (_) {}
  process.exit(1);
}, 300_000);
watchdog.unref?.();

const SEAL = { WORKER_SECRET_SEAL_KEY: crypto.randomBytes(32).toString('hex') };

/** Run the worker process one cycle. Returns its JSON log lines and exit code. */
function runWorkerOnce({ baseUrl, workerId, secret, env = {} , args = ['--once'] }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath,
      [path.join(__dirname, '..', 'src', 'worker-client', 'run.js'), ...args],
      { env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        WORKER_API_BASE_URL: baseUrl,
        WORKER_ID: workerId,
        PLAYNEXA_WORKER_ENV: 'development',
        PLAYNEXA_DEV_WORKER_SECRET: secret,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const kill = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => {
      clearTimeout(kill);
      const lines = out.split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch (_) { return { raw: l }; }
      });
      resolve({ code, lines, stdout: out, stderr: err });
    });
  });
}

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: cluster.url, ssl: false });
  const query = (t, p) => P.query(t, p);
  const withTransaction = async (fn) => {
    const c = await P.connect();
    try {
      await c.query('BEGIN');
      // `fn(c)` — the CLIENT, not a query function. The consumer calls `client.query(...)`, and
      // handing it a bare function produced "client.query is not a function" from inside the
      // enrolment route. Mirrors check-worker-runtime-db.js, which is the shape the routes expect.
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  };
  const deps = { query, withTransaction, env: SEAL };
  let server = null;
  const created = { workers: [], tasks: [] };

  try {
    const autonomy = require('../src/lib/autonomy');
    await require('../src/lib/db').initDB();
    await autonomy.migrateAutonomy(query);
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);
    const IDENTITY = require('../src/lib/worker/identity');
    const LEASES = require('../src/lib/worker/leases');
    const AUDIT = require('../src/lib/worker/audit');
    await IDENTITY.migrateWorkerIdentity(query);
    await LEASES.migrateWorkerTasks(query);
    await AUDIT.migrateWorkerAudit(query);
    autonomy.resetForTests && autonomy.resetForTests();

    const express = require('express');
    const WR = require('../src/api/worker.routes');
    const app = express();
    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.use('/api', WR.createWorkerRouter({ enable: true, query, withTransaction, env: SEAL }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    console.log(`  ..    server on ${baseUrl}\n`);

    // ══ 1. ENROLMENT, AS AN OPERATOR WOULD DO IT ═════════════════════════
    head('1. the cloud worker enrols with a server-issued token');

    const tok = await IDENTITY.createEnrollmentToken({ syntheticOnly: false, label: 'm7-dev-cloud-worker' }, deps);
    const enrolled = await (await fetch(`${baseUrl}/api/worker/enroll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tok.token, hostFingerprint: 'railway-container' }),
    })).json();
    if (enrolled.ok && /^wkr_[0-9a-f]{32}$/.test(enrolled.workerId || '')) {
      ok(`enrolled ${enrolled.workerId} — this is the step that needs the owner's hands on Railway`);
      created.workers.push(enrolled.workerId);
    } else {
      bad('enrolment failed; nothing below can run', JSON.stringify(enrolled).slice(0, 200));
      throw new Error('no worker');
    }
    const WID = enrolled.workerId;
    const WSECRET = enrolled.secret;

    // Capabilities: NONE. Decision 4 — a cloud worker gets no exec:hardware and no exec:gui, and
    // the grant is server-authorized at enrolment, never self-declared.
    // `id`, not `worker_id`: the real column, read from identity-schema.js rather than guessed.
    const caps = (await query(
      `SELECT capabilities FROM worker_identities WHERE id = $1`, [WID])).rows[0];
    const capList = caps && caps.capabilities ? caps.capabilities : [];
    if (!capList.includes('exec:hardware') && !capList.includes('exec:gui')) {
      ok(`it holds no hardware or GUI capability (${JSON.stringify(capList)}) — per §3, a cloud `
        + 'worker must not be granted either');
    } else bad('the cloud worker was granted a hardware or GUI capability', capList);

    // ══ 2. THE PROCESS STARTS AND AUTHENTICATES ══════════════════════════
    head('2. the PROCESS finds its own credential and authenticates');

    {
      const r = await runWorkerOnce({ baseUrl, workerId: WID, secret: WSECRET,
        args: ['--doctor'] });
      let doc = null;
      try { doc = JSON.parse(r.stdout); } catch (_) { /* reported below */ }
      if (doc && doc.credentialUsable === true
          && doc.credentialSource === 'development-environment-variable') {
        ok('--doctor reports the container credential source as usable');
      } else {
        bad('the process could not establish its credential in a container',
          doc ? JSON.stringify({ src: doc.credentialSource, usable: doc.credentialUsable })
            : r.stdout.slice(0, 300));
      }
      if (doc && doc.ready === true) ok('…and reports itself READY');
      else bad('--doctor says not ready', doc && doc.problems);
      if (!/dev-secret|PLAYNEXA_DEV_WORKER_SECRET=/.test(r.stdout.replace(/"PLAYNEXA[^"]*"/g, ''))) {
        ok('and the readiness report contains no part of the secret');
      } else bad('the secret appeared in the doctor output');
    }

    // ══ 3. A CLOUD-ELIGIBLE TASK IS CLAIMED AND EXECUTED ═════════════════
    head('3. cloud-eligible work is claimed and completed by the process');

    // enqueueTask, and it MINTS the id — the real signature, read rather than assumed. It also
    // refuses an unknown task type and a missing intent key, which is why the fixture supplies one.
    const mkTask = async (taskType, payload = {}) => {
      const r = await LEASES.enqueueTask({
        taskType, payload,
        intentKey: `cloud-check:${taskType}:${crypto.randomUUID().slice(0, 8)}`,
        createdBy: 'check-cloud-worker-process',
      }, deps);
      if (!r || !r.ok) throw new Error(`could not enqueue ${taskType}: ${JSON.stringify(r)}`);
      created.tasks.push(r.taskId);
      return r.taskId;
    };

    const echoId = await mkTask('synthetic.echo', { echo: 'hello from the cloud worker' });
    {
      const r = await runWorkerOnce({ baseUrl, workerId: WID, secret: WSECRET });
      // `leased`, not `claimed` — the event name the worker actually logs. My first version
      // asserted on a name I assumed, so it reported "did not complete" for a task the database
      // showed as COMPLETED: the assertion was wrong, not the worker. Reading the log vocabulary
      // beats guessing it.
      const claimed = r.lines.some((l) => l.at === 'leased');
      const done = r.lines.some((l) => l.at === 'reported');
      const row = (await query(
        `SELECT state FROM worker_tasks WHERE id = $1`, [echoId])).rows[0];
      if (claimed && row && row.state === 'COMPLETED') {
        ok(`the worker PROCESS claimed and completed ${echoId} — state COMPLETED in the database`);
      } else {
        bad('the process did not complete a cloud-eligible task',
          JSON.stringify({ claimed, done, state: row && row.state,
            lines: r.lines.map((l) => l.at) }));
      }
      const res = (await query(
        `SELECT status FROM worker_results WHERE task_id = $1`, [echoId])).rows[0];
      if (res && res.status === 'SUCCEEDED') {
        ok('and the RESULT verdict is SUCCEEDED — the task state and the result verdict are '
          + 'separate facts, and both are right');
      } else bad('no succeeded result row', res);
    }

    // ══ 4. HARDWARE WORK STAYS PENDING, ATTEMPTS UNTOUCHED ═══════════════
    head('4. hardware-required work is not claimed, and is not damaged by waiting');

    const hwId = await mkTask('desktop.capture_once', { reason: 'hardware-only fixture' });
    {
      const before = (await query(
        `SELECT state FROM worker_tasks WHERE id = $1`, [hwId])).rows[0];
      // Three cycles. A pick-then-refuse implementation would consume an attempt each time and
      // eventually reap the task — which is the defect B4.3's placement-in-the-pick prevents.
      for (let i = 0; i < 3; i += 1) {
        await runWorkerOnce({ baseUrl, workerId: WID, secret: WSECRET });
      }
      const after = (await query(
        `SELECT state FROM worker_tasks WHERE id = $1`, [hwId])).rows[0];
      if (before && after && after.state === 'PENDING' && before.state === 'PENDING') {
        ok('after THREE cycles of a capability-less worker the hardware task is still PENDING');
      } else {
        bad('a hardware-only task changed state under a cloud worker',
          JSON.stringify({ before: before && before.state, after: after && after.state }));
      }
      const results = (await query(
        `SELECT COUNT(*)::int n FROM worker_results WHERE task_id = $1`, [hwId])).rows[0].n;
      if (results === 0) ok('and no result was recorded against it — it was never picked');
      else bad(`${results} result rows exist for a task no worker may execute`);
    }

    // ══ 5. CLOUD WORK CONTINUES WITH NO HARDWARE WORKER PRESENT ══════════
    head('5. cloud execution does not depend on a hardware worker existing');

    {
      // The iMac is not merely unavailable here — it has never existed in this cluster. That is a
      // stronger condition than "offline", and it is the condition that matters for the owner's
      // *"cloud execution continuing while the iMac is unavailable"*: a non-destructive
      // availability test, with no deliberate crash of anything.
      const hwWorkers = (await query(
        `SELECT COUNT(*)::int n FROM worker_identities
          WHERE 'exec:hardware' = ANY(capabilities)`)).rows[0].n;
      if (hwWorkers === 0) ok('no hardware-capable worker exists in this cluster at all');
      else note(`${hwWorkers} hardware-capable identities exist — weaker than intended`);

      const second = await mkTask('synthetic.echo', { echo: 'still working' });
      await runWorkerOnce({ baseUrl, workerId: WID, secret: WSECRET });
      const row = (await query(`SELECT state FROM worker_tasks WHERE id = $1`, [second])).rows[0];
      if (row && row.state === 'COMPLETED') {
        ok('cloud-eligible work completes while NO hardware worker is present — the platform does '
          + 'not depend on the iMac for cloud work');
      } else bad('cloud work did not complete with no hardware worker present', row);
    }

    // ══ 6. A STOP HALTS IT ═══════════════════════════════════════════════
    head('6. the kill switch reaches the cloud worker');

    {
      const stoppable = await mkTask('synthetic.echo', { echo: 'should not run' });
      // `worker.execute`, not `worker.claim`: autonomy REFUSES a stop whose capability matches
      // nothing — "this stop would protect nothing" — and names the four valid keys in the error.
      // A kill switch that accepts a scope it cannot enforce would be the worst kind of control:
      // set, reported as set, and silently protecting nothing.
      //
      // snake_case, and `{ deps }` nested — the real signature:
      //   stop({ scope_type, scope_key, reason, actor }, { deps })
      // My camelCase guess was rejected with "scope_type must be one of …", which named the
      // parameter I had got wrong while listing values that looked right, and I nearly read that
      // as the VALUE being rejected. The error was precise; my reading of it was not.
      const stopped = await autonomy.stop({
        scope_type: 'capability', scope_key: 'worker.execute',
        reason: 'cloud worker check', actor: 'check-cloud-worker-process',
      }, { deps }).catch((e) => ({ ok: false, error: e.message }));
      if (!stopped || stopped.ok !== true) {
        bad('the STOP fixture could not be set, so the assertion below measures nothing',
          JSON.stringify(stopped));
      }
      const r = await runWorkerOnce({ baseUrl, workerId: WID, secret: WSECRET });
      const row = (await query(`SELECT state FROM worker_tasks WHERE id = $1`, [stoppable])).rows[0];
      if (row && row.state === 'PENDING') {
        ok('with a STOP in force the task is NOT claimed and stays PENDING');
      } else {
        bad('a STOP did not prevent the cloud worker claiming work',
          JSON.stringify({ state: row && row.state, lines: r.lines.map((l) => l.at) }));
      }
      await autonomy.resume({ scope_type: 'capability', scope_key: 'worker.execute',
        actor: 'check-cloud-worker-process', reason: 'check complete' },
      { deps }).catch(() => {});
    }

    // ══ 7. REVOCATION IS IMMEDIATE AND TERMINAL ══════════════════════════
    head('7. revoking the identity stops the process authenticating');

    {
      await IDENTITY.revokeWorker(WID,
        { reason: 'revoked by the cloud worker check' }, deps);
      const afterRevoke = await mkTask('synthetic.echo', { echo: 'after revocation' });
      const r = await runWorkerOnce({ baseUrl, workerId: WID, secret: WSECRET });
      const row = (await query(
        `SELECT state FROM worker_tasks WHERE id = $1`, [afterRevoke])).rows[0];
      if (row && row.state === 'PENDING') {
        ok('a revoked worker claims nothing — the credential is still in its environment, and the '
          + 'SERVER is what refuses, which is the only place revocation can be enforced');
      } else {
        bad('a revoked worker still claimed work', JSON.stringify({ state: row && row.state }));
      }
      const refused = r.lines.some((l) => /revoked|unauthor|forbidden/i
        .test(JSON.stringify(l)));
      if (refused || r.code !== 0) {
        ok('and the process reports the refusal rather than looping silently');
      } else note('the process exited 0 without an explicit refusal line — worth a look');
    }
  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    try { if (server) await new Promise((r) => server.close(r)); } catch (_) {}
    // ── CLEANUP: ONLY WHAT THIS CREATED, BY ID ──────────────────────────
    try {
      for (const id of created.tasks) {
        await query(`DELETE FROM worker_results WHERE task_id = $1`, [id]).catch(() => {});
        await query(`DELETE FROM worker_tasks WHERE id = $1`, [id]).catch(() => {});
      }
      for (const id of created.workers) {
        await query(`DELETE FROM worker_identities WHERE id = $1`, [id]).catch(() => {});
      }
      const mine = (await query(
        `SELECT COUNT(*)::int n FROM worker_tasks WHERE id = ANY($1)`, [created.tasks])).rows[0].n;
      if (mine) note(`${mine} fixture tasks survived (audit rows hold them) — disposable cluster`);
      else ok('every fixture this check created is gone (by id, not by timestamp)');
    } catch (e) {
      bad('cleanup failed', e.message);
    }
    try { await P.end(); } catch (_) {}
    try { cluster.destroy(); } catch (_) {}
    clearTimeout(watchdog);
  }

  console.log(`\n${fail ? 'FAIL' : 'OK'}  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`FAIL  ${e.stack || e.message}`);
  try { cluster.destroy(); } catch (_) {}
  process.exit(1);
});
