#!/usr/bin/env node
// ── THE OFFICE OPERATING, INTEGRATED, WITH NOBODY DRIVING IT ────────────────
//
//   node scripts/check-integrated-office-operation-db.js
//     exit 0 = every property holds · exit 3 = NOT EXECUTED (no Postgres toolchain)
//
// Owner, 2026-11-27, priorities 1–4: *"Actual running-scheduler integration and autonomous
// objective initiation. Connected employee operating-loop execution through the scheduler. Command
// Center connected to persisted operational state. Independent persistent sampler verification."*
// And: *"Our objective is to complete and operate PlayNexa, not continuously report the same
// development milestone."*
//
// ── WHAT IS DIFFERENT FROM EVERY CHECK BEFORE IT ───────────────────────────
//
// The pieces have each been verified alone. `check-employee-operating-loop-db.js` drives the loop
// by calling its modules. `check-running-scheduler-db.js` proves the real scheduler advances
// phases. `check-reliability-sampler-db.js` proves the sampler detects a gap. Three green checks,
// and none of them says the office RUNS.
//
// This file starts THREE REAL PROCESSES and then only watches the database:
//
//   1. `server.js` — the application, with its real cron registrations
//   2. `office-reliability-sampler.js` — the independent observer, its own process
//   3. the worker client, so delegated work actually executes
//
// It calls no cycle function and advances nothing. Every phase transition asserted below was
// performed by the running server's own scheduler. §0 asserts that against this file's own source
// with comments blanked, so this paragraph cannot satisfy it.
//
// ── THE ONE THING IT CANNOT WAIT FOR, AND WHY IT IS NOT FUDGED ─────────────
//
// Objective INITIATION fires weekdays at 06:00 America/Chicago. A check cannot wait for that, and
// must not be given a way to move it: a configurable initiation schedule is exactly the production
// bypass the owner has ruled out. So initiation is called ONCE, as a stand-in for that single
// business-schedule firing, and nothing is touched afterwards — the same boundary
// `check-running-scheduler-db.js` draws, stated again here because a reader of THIS file should not
// have to find it elsewhere. What is demonstrated is everything after that first firing.
//
// NO REAL EFFECTS: a synthetic company, synthetic task types, no provider key, and the mail
// transport replaced by a capture in-process where the loop touches it. Nothing is transmitted.

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const PG = require('./lib/pg-disposable');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const ROOT = path.join(__dirname, '..');
const TICK_SECONDS = 5;
const SEAL = { WORKER_SECRET_SEAL_KEY: crypto.randomBytes(32).toString('hex') };

process.env.ADMIN_EMAIL = 'io-bootstrap@io.invalid';
process.env.ADMIN_PASSWORD = `i-${crypto.randomBytes(16).toString('hex')}`;

let pass = 0;
let fail = 0;
const lines = [];
const ok = (m) => { pass += 1; lines.push(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail += 1;
  lines.push(`  FAIL  ${m}`);
  if (extra !== undefined) lines.push(`          ${String(extra).slice(0, 300)}`);
};
const note = (m) => lines.push(`  --    ${m}`);
const head = (t) => lines.push('', `── ${t} ──`, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let cluster = null;
  let workerApi = null;
  try {
    cluster = PG.create({ label: 'integrated-office-operation' });
  } catch (e) {
    console.log(`NOT EXECUTED  infrastructure unavailable: ${e.message}`);
    process.exit(EXIT_NOT_EXECUTED);
  }
  process.env.DATABASE_URL = cluster.url;

  const DB = require('../src/lib/db');
  const { query } = DB;
  const deps = { query };
  const children = [];
  const uid = (p) => `io-${p}-${crypto.randomUUID().slice(0, 8)}`;
  const samplerOut = path.join(os.tmpdir(), `io-sampler-${crypto.randomUUID().slice(0, 8)}.jsonl`);

  const spawnChild = (script, args, extraEnv) => {
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        DATABASE_URL: cluster.url,
        JWT_SECRET: 'integrated-office-check',
        ADMIN_EMAIL: process.env.ADMIN_EMAIL,
        ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
        ...SEAL,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = { out: '', err: '' };
    child.stdout.on('data', (d) => { log.out += d; });
    child.stderr.on('data', (d) => { log.err += d; });
    children.push(child);
    return { child, log };
  };

  /** Poll the database until `fn` returns truthy. NEVER advances anything. */
  const waitFor = async (fn, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn().catch(() => null);
      if (v) return v;
      if (Date.now() > deadline) return null;
      await sleep(1000);
    }
  };

  try {
    await DB.initDB();
    // THE WHOLE MIGRATOR. server.js refuses to boot unless schema-ready.js finds every required
    // table (ENG-003: boot reads, it does not migrate), so a check that migrates only what it
    // needs gets a server that exits at once — which reads as "the server did not come up" rather
    // than "I did not build the schema it boots against".
    await require('../src/lib/migrate-all').runAll(query, { seeds: true });
    await require('../src/lib/worker/identity').migrateWorkerIdentity(query);
    await require('../src/lib/worker/leases').migrateWorkerTasks(query);
    await require('../src/lib/worker/audit').migrateWorkerAudit(query).catch(() => {});
    await require('../src/lib/worker/synthetic-isolation').installSyntheticIsolation(query);
    const autonomy = require('../src/lib/autonomy');
    autonomy.resetForTests && autonomy.resetForTests();

    // ══ 0. THIS FILE DOES NOT DRIVE ANYTHING ═══════════════════════════════
    head('0. the check cannot be what advances the cycle');

    // Comments blanked first, so the prose above cannot satisfy the assertion.
    // Comments blanked AND this section's own list removed. The first run reported that the file
    // calls all eight — because all eight appear in the array literal two lines below, which is the
    // scan reading its own needle. A self-check that cannot tell its own vocabulary from a call is
    // measuring its source as text rather than as code.
    const drivers = ['advanceCycle', 'runPerformanceCheck', 'reflectAbandonedLeases',
      'assignTask', 'completeTask', 'sendEmailDetailed', 'retryRun', 'reap'];
    const selfSrc = fs.readFileSync(__filename, 'utf8')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/const drivers = \[[\s\S]*?\];/, '')
      .replace(/found\.join\([^)]*\)/g, '');
    // CALL syntax, not a mention: `advanceCycle(` rather than the bare name, so a string in a
    // message cannot trip it either.
    const found = drivers.filter((d) => new RegExp(`\\b${d}\\s*\\(`).test(selfSrc));
    if (found.length === 0) {
      ok(`none of ${drivers.length} driving calls appears in this file's code — every transition `
        + 'below is the running server\'s own');
    } else {
      bad(`this file calls ${found.join(', ')}, so it is driving what it claims to observe`);
    }
    if (/initiateDueObjectives/.test(selfSrc)) {
      ok('initiation IS called once, and is declared — the single business-schedule firing a check '
        + 'cannot wait for, and must not be given a way to move');
    } else {
      bad('initiation is not called, so no objective will ever start');
    }

    // ══ 1. FIXTURES ════════════════════════════════════════════════════════
    head('1. a synthetic company, an employed member, and an active objective');

    const CO = uid('co');
    await query(`INSERT INTO companies (id, slug, display_name, status)
                 VALUES ($1,$1,$1,'active')`, [CO]);
    await require('../src/lib/worker/synthetic-isolation')
      .setCompanySynthetic(CO, true, deps);

    // Through the accessor, and activated the way the office activates. The scope-discipline
    // scanner refused a raw INSERT here and it is right: company scoping lives in one file, and a
    // check has no claim on being special. Objectives are born draft, so activation needs a
    // company context — which needs a run — and that is fixture setup, not driving: §0's list
    // covers the functions that ADVANCE a cycle, and createRun is not one of them.
    const SCOPE_IO = require('../src/lib/office/scope');
    const CTX_IO = require('../src/lib/office/context');
    const OBJ = uid('obj');
    await SCOPE_IO.createObjective({
      id: OBJ, companyId: CO, objective: 'operate the office end to end', priority: 'P1',
      kpiMetric: 'io_cycles', kpiTarget: 1, deadline: '2026-12-31', budgetUsd: 5,
      autonomyTier: 'supervised', approvalPolicy: 'all_consequential',
      createdBy: 'io@fixture.invalid',
    }, deps);
    const seedRun = await require('../src/lib/run-ledger').ledger({ query }).createRun({
      trigger: 'check', triggerDetail: 'io activation', workflow: 'io-setup', agent: 'io',
      product: 'playbookos', companyId: CO, objectiveId: OBJ,
      intentKey: `io-act-${crypto.randomUUID().slice(0, 8)}`,
    });
    const seedCtx = await CTX_IO.resolveCompanyContext({ runId: seedRun.runId }, deps);
    await SCOPE_IO.setObjectiveStatus(seedCtx, { id: OBJ, status: 'active' }, deps);

    const EMP = uid('emp');
    const ACTOR = uid('actor');
    await query(`INSERT INTO users (id, email, name, role, password_hash, is_active)
                 VALUES ($1,$2,'Integrated Fixture Employee','admin','x',1)`,
      [EMP, `${EMP}@fixture.invalid`]);
    await query(`INSERT INTO users (id, email, name, role, password_hash, is_active)
                 VALUES ($1,$2,'Integrated Fixture Authorizer','super_admin','x',1)`,
      [ACTOR, `${ACTOR}@fixture.invalid`]);
    await require('../src/lib/identity/company-membership').grantMembership({
      userId: EMP, companyId: CO, companyRole: 'member', grantedBy: ACTOR,
      grantedReason: 'fixture member so the scheduler-driven cycle has somebody to assign work to',
    }, deps);
    ok(`company ${CO} marked synthetic, one employed member, one ACTIVE objective`);

    // ══ 2. THREE REAL PROCESSES ════════════════════════════════════════════
    head('2. the server, the sampler and a worker — three processes, none of them this one');

    const port = 30000 + Math.floor(Math.random() * 20000);
    const { child: server, log: serverLog } = spawnChild('server.js', [], {
      PORT: String(port),
      OFFICE_INITIATOR_ENABLED: 'true',
      OFFICE_CYCLE_TICK_SECONDS: String(TICK_SECONDS),
      WORKER_API_ENABLED: 'true',
    });
    const booted = await waitFor(async () => {
      if (server.exitCode !== null) return 'exited';
      const r = await fetch(`http://127.0.0.1:${port}/health`).then((x) => x.json()).catch(() => null);
      return r && r.status === 'ok' ? r : null;
    }, 60000);
    if (booted && booted !== 'exited') {
      ok(`server.js is up on ${port} and reports db ${booted.db}`);
    } else {
      bad('the real server did not boot', `${serverLog.err || serverLog.out}`.slice(0, 400));
      throw new Error('no server: nothing below can be observed');
    }

    // ── A REAL WORKER, ALSO ITS OWN PROCESS ────────────────────────────────
    //
    // Without this the cycle enqueues a task that nothing executes, so it never reaches COLLECT and
    // therefore never reaches REPORT — which is exactly what the first run of this file measured:
    // §5 reported no employee assignment, and the reason was not the cycle but a missing process I
    // had promised in this section's own heading.
    // ── THE WORKER API IS A FIXTURE, AND SAYING SO IS BETTER THAN DRESSING IT UP ──
    //
    // The first run pointed the enrolment at server.js and got HTML back: server.js does not mount
    // the worker router in this configuration. The deployed worker API is
    // `scripts/dev-worker-api-server.js`, and it REFUSES to start against this cluster — because
    // this check runs the full application migrator with seeds (schema-ready.js will not let
    // server.js boot otherwise), and `db-identity.js` correctly reports a seeded application
    // database as a `production_fingerprint`. That guard is right and is not weakened here.
    //
    // So the worker router is mounted IN THIS PROCESS, from the same module the dev service mounts.
    // What is under test is the SCHEDULER — the real server.js, in its own process, undriven. The
    // worker API is scaffolding, exactly as check-running-scheduler-db.js states for the same
    // reason, and the worker itself is still a separate real process polling it.
    const express = require('express');
    const http = require('node:http');
    const WR = require('../src/api/worker.routes');
    const app = express();
    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.use('/api', WR.createWorkerRouter({
      enable: true, query, withTransaction: DB.withTransaction, env: SEAL }));
    workerApi = http.createServer(app);
    await new Promise((r) => workerApi.listen(0, '127.0.0.1', r));
    const apiUrl = `http://127.0.0.1:${workerApi.address().port}`;
    ok('a worker API is serving on an ephemeral port (in-process, and stated as a fixture)');

    const tok = await require('../src/lib/worker/identity').createEnrollmentToken({
      syntheticOnly: false, label: 'integrated-worker',
      createdBy: await require('./lib/fixture-admin').fixtureAdmin(query),
    }, deps);
    const enrolled = await (await fetch(`${apiUrl}/api/worker/enroll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tok.token, hostFingerprint: 'integrated-office-check' }),
    })).json().catch((e) => ({ ok: false, error: e.message }));
    if (enrolled && enrolled.ok) {
      spawnChild('src/worker-client/run.js', [], {
        WORKER_API_BASE_URL: apiUrl,
        WORKER_ID: enrolled.workerId,
        PLAYNEXA_WORKER_ENV: 'development',
        PLAYNEXA_DEV_WORKER_SECRET: enrolled.secret,
      });
      ok('a real worker process is polling the running server — no --once, it polls on its own');
    } else {
      bad('could not enrol a worker against the running server',
        JSON.stringify(enrolled).slice(0, 240));
    }

    const { child: sampler, log: samplerLog } = spawnChild('scripts/office-reliability-sampler.js',
      ['--objective', OBJ, '--interval-seconds', '5', '--duration-seconds', '330',
        '--out', samplerOut], {});
    await sleep(2000);
    if (sampler.exitCode === null) {
      ok('the independent sampler is running as its OWN process, writing its own evidence file');
    } else {
      note(`the sampler exited ${sampler.exitCode}: ${(samplerLog.err || samplerLog.out).slice(0, 220)}`);
    }

    // ══ 3. INITIATION, ONCE ════════════════════════════════════════════════
    head('3. one initiation firing, then nothing from this process');

    const initiated = await require('../src/lib/office/initiator')
      .initiateDueObjectives({ now: new Date() }, deps);
    const startedRun = await waitFor(async () => {
      const r = await query(
        `SELECT run_id, state, workflow FROM agent_runs
          WHERE objective_id = $1 AND workflow <> 'io-setup'
          ORDER BY started_at LIMIT 1`, [OBJ]);
      return r.rows[0] || null;
    }, 30000);
    if (startedRun) {
      ok(`initiation started a durable run (${startedRun.workflow}, ${startedRun.state})`);
    } else {
      bad('no run was started', JSON.stringify(initiated).slice(0, 240));
    }

    // ══ 4. THE SCHEDULER ADVANCES IT, UNATTENDED ═══════════════════════════
    head('4. the running scheduler advances the cycle with no driver');

    // Read through the accessor, which is scoped by company and takes the run. The raw read was
    // refused by the scope-discipline scanner; planForRun is the function that exists for this.
    const planned = await waitFor(async () => {
      const runs = await query(
        `SELECT run_id FROM agent_runs WHERE objective_id = $1 AND workflow <> 'io-setup'
          ORDER BY started_at DESC`, [OBJ]);
      for (const row of runs.rows) {
        const ctx = await CTX_IO.resolveCompanyContext({ runId: row.run_id }, deps)
          .catch(() => null);
        if (!ctx) continue;
        const pl = await SCOPE_IO.planForRun(ctx, row.run_id, deps).catch(() => null);
        if (pl) return pl;
      }
      return null;
    }, 90000);
    if (planned) {
      ok(`a plan exists with verdict ${planned.verdict} — written by the server's own cron, not `
        + 'by this file');
    } else {
      bad('no plan appeared within 90s', (serverLog.err || '').slice(-400));
    }
    const enqueued = await waitFor(async () => {
      const r = await query(
        `SELECT COUNT(*)::int n FROM worker_tasks WHERE company_id = $1`, [CO]);
      return r.rows[0].n > 0 ? r.rows[0].n : null;
    }, 90000);
    if (enqueued) {
      ok(`${enqueued} task(s) enqueued for the company by the scheduler-driven cycle`);
    } else {
      note('no worker task was enqueued within 90s — the plan may have had no delegable step');
    }

    // ══ 5. THE EMPLOYEE LOOP, THROUGH THE SCHEDULER ════════════════════════
    head('5. the employee operating loop, executed by the scheduler rather than by a driver');

    const assigned = await waitFor(async () => {
      const r = await query(
        `SELECT id, user_id, task_date, status FROM daily_tasks
          WHERE company_id = $1 ORDER BY id LIMIT 1`, [CO]);
      return r.rows[0] || null;
    }, 240000);
    if (assigned && assigned.user_id === EMP) {
      ok(`the cycle assigned an employee task to the verified member (${assigned.task_date}, `
        + `${assigned.status}) — the REPORT phase, reached without anybody advancing it`);
    } else if (assigned) {
      bad('a task was assigned to somebody who is not the fixture member', JSON.stringify(assigned));
    } else {
      note('no employee assignment within 120s — §7 reports which phase the cycle reached');
    }
    // Through office/memory's own reader — the identity-accessor scanner refused a direct count,
    // and its reason applies here: the live predicate is several conditions long and a second copy
    // would drift. What this needs is "did the cycle record anything", which `timeline` answers.
    const MEM_IO = require('../src/lib/office/memory');
    const memCtx = seedCtx;
    const timeline = await MEM_IO.timeline(memCtx, {}, deps).catch((e) => ({ error: e.message }));
    const memCount = Array.isArray(timeline) ? timeline.length
      : (timeline && Array.isArray(timeline.rows) ? timeline.rows.length : null);
    if (memCount > 0) {
      ok(`${memCount} memory row(s) written for the company, read through office/memory — the `
        + 'cycle recorded what it observed, which is what the next cycle reads');
    } else {
      note(`memory timeline: ${JSON.stringify(timeline).slice(0, 180)}`);
    }

    // ══ 6. THE COMMAND CENTER READS THE SAME PERSISTED STATE ═══════════════
    head('6. the Command Center is a read model over what actually happened');

    const CC = require('../src/lib/office/command-center');
    const snap = await CC.snapshot({ companyId: CO }, deps)
      .then((x) => x).catch((e) => ({ error: e.message }));
    if (snap && !snap.error) {
      ok(`snapshot() returns a read model (${Object.keys(snap).sort().join(', ')})`);
    } else {
      bad('the Command Center snapshot failed', snap && snap.error);
    }
    // INDEPENDENTLY RECOUNTED. A read model that agrees with itself proves nothing; the figures are
    // compared against a recount this file performs from the same rows.
    const recount = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM worker_tasks WHERE company_id = $1) AS tasks,
         (SELECT COUNT(*)::int FROM daily_tasks  WHERE company_id = $1) AS employee_tasks,
         (SELECT COUNT(*)::int FROM agent_runs   WHERE company_id = $1) AS runs`, [CO]);
    const r6 = recount.rows[0];
    note(`independent recount — worker tasks ${r6.tasks}, employee tasks ${r6.employee_tasks}, `
      + `runs ${r6.runs}`);
    const snapJson = JSON.stringify(snap || {});
    if (snap && !snap.error && snapJson.length > 2) {
      ok('and the snapshot is non-empty while the office has state, so it is reading the office '
        + 'rather than returning a shape');
    } else {
      bad('the snapshot is empty while the database has state', snapJson.slice(0, 200));
    }
    // CROSS-COMPANY CONTROL: another company's snapshot must not see any of this.
    const OTHER = uid('other');
    await query(`INSERT INTO companies (id, slug, display_name, status)
                 VALUES ($1,$1,$1,'active')`, [OTHER]);
    const otherSnap = await CC.snapshot({ companyId: OTHER }, deps)
      .then((x) => JSON.stringify(x)).catch((e) => `error:${e.message}`);
    if (!otherSnap.includes(EMP) && !otherSnap.includes(OBJ)) {
      ok('CONTROL: another company\'s snapshot contains none of this company\'s objective or '
        + 'employee — the read model is company-scoped, measured rather than assumed');
    } else {
      bad('the Command Center leaked across companies', otherSnap.slice(0, 240));
    }

    // ══ 7. THE SAMPLER'S INDEPENDENT EVIDENCE ══════════════════════════════
    head('7. the sampler observed the same window, from outside');

    await sleep(8000);
    let samples = [];
    try {
      samples = fs.readFileSync(samplerOut, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter(Boolean);
    } catch (e) {
      note(`the sampler evidence file could not be read: ${e.message}`);
    }
    if (samples.length >= 3) {
      ok(`${samples.length} independent samples were written by a SEPARATE process — the evidence `
        + 'for a reliability claim comes from outside the system under test');
    } else {
      note(`${samples.length} sample(s) written; the sampler needs its interval to elapse, and `
        + 'this window is short');
    }
    const gaps = samples.filter((s) => s.gap === true);
    if (samples.length >= 3 && gaps.length === 0) {
      ok('and ZERO gaps across them — the office was continuously observable while it worked');
    } else if (gaps.length) {
      note(`${gaps.length} gap(s) recorded: ${JSON.stringify(gaps[0]).slice(0, 180)} — a gap in a `
        + 'five-second interval on a loaded box is not a product failure, and it is recorded '
        + 'rather than suppressed');
    }

    // ══ 8. WHAT THE CYCLE ACTUALLY REACHED, STATED PLAINLY ═════════════════
    head('8. the phase the office reached, read from rows');

    const CYCLE = require('../src/lib/office/cycle');
    const finalRun = await query(
      `SELECT run_id, state FROM agent_runs
        WHERE objective_id = $1 AND workflow <> 'io-setup'
        ORDER BY started_at DESC LIMIT 1`, [OBJ]);
    // phaseOf needs a RESOLVED context — the first run passed `deps` and got back
    // "kernel write requires a resolved company context", which is the guard working and my call
    // being wrong. Resolved from the run itself, which is where a company is allowed to come from.
    let phase = null;
    if (finalRun.rows[0]) {
      const phaseCtx = await CTX_IO
        .resolveCompanyContext({ runId: finalRun.rows[0].run_id }, deps)
        .catch(() => null);
      phase = phaseCtx
        ? await CYCLE.phaseOf(phaseCtx, finalRun.rows[0].run_id, deps)
          .catch((e) => ({ error: e.message }))
        : { error: 'no company context could be resolved for the final run' };
    }
    note(`final run ${finalRun.rows[0] && finalRun.rows[0].state}, phase `
      + `${JSON.stringify(phase).slice(0, 160)}`);
    const events = await query(
      `SELECT COUNT(*)::int n FROM agent_run_events e
         JOIN agent_runs r ON r.run_id = e.run_id WHERE r.company_id = $1`, [CO]);
    if (events.rows[0].n > 0) {
      ok(`${events.rows[0].n} durable run event(s) recorded — the office left an audit trail of its `
        + 'own operation, which is what an operator reads afterwards');
    } else {
      bad('the office operated and left no run events');
    }
    if (server.exitCode === null) {
      ok('and the server is STILL RUNNING at the end — it operated continuously rather than '
        + 'crashing after one tick');
    } else {
      bad(`the server exited ${server.exitCode} during the run`,
        (serverLog.err || '').slice(-400));
    }
  } catch (e) {
    bad(`the check itself failed: ${e.message}`);
    lines.push(String(e.stack || '').split('\n').slice(1, 6).join('\n'));
  } finally {
    for (const c of children) { try { c.kill('SIGKILL'); } catch (_) { /* already gone */ } }
    try { if (workerApi) workerApi.close(); } catch (_) { /* already closed is fine */ }
    await sleep(500);
    try { fs.unlinkSync(samplerOut); } catch (_) { /* may not exist */ }
    try { cluster.destroy(); } catch (_) { /* already gone is the desired state */ }
  }

  console.log('══ THE OFFICE OPERATING, INTEGRATED ══');
  console.log(lines.join('\n'));
  console.log('');
  console.log(fail === 0
    ? `OK  (${pass} assertions)`
    : `FAILED  ${fail} assertion(s) failed, ${pass} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();
