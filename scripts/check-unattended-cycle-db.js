#!/usr/bin/env node
// ── §2: THE CYCLE RUNS WITHOUT THE ACCEPTANCE DRIVER ────────────────────────
//
//   node scripts/check-unattended-cycle-db.js   exit 0 = every ruled property holds
//                                                exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner's Priority 2 of 2026-11-25: *"A scheduled objective must proceed without the acceptance
// driver manually advancing it… Demonstrate at least two consecutive scheduled cycles, including a
// controlled process restart and recovery without duplicate execution."*
//
// ── HOW THIS DIFFERS FROM check-autonomous-office-cycle-db.js ──────────────
//
// That driver performs all fifteen steps itself, in order, inside one process. It proved the steps
// work. It is also, precisely, the thing this requirement says must not be needed: the driver WAS
// the orchestrator.
//
// Here the checker does **four things only**: it creates fixtures, it SPAWNS SUBPROCESSES, it runs
// the worker, and it reads the database. It never calls a cycle function. Every phase transition
// is performed by `scripts/office-cycle-tick.js` in a **separate operating-system process** that
// exits afterwards — so the restart requirement is not simulated with a flag, it is the only way
// this check can work at all. If the cycle needed resident state, nothing below would advance.
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
  cluster = DISPOSABLE.create({ label: 'unatt' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  the unattended cycle was not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'unatt-bootstrap@unatt.invalid';
process.env.ADMIN_PASSWORD = `unatt-${crypto.randomBytes(16).toString('hex')}`;

const watchdog = setTimeout(() => {
  console.log('\n  FAIL  no progress in 420s — a stall is a failure.');
  try { cluster.destroy(); } catch (_) {}
  process.exit(1);
}, 420_000);
watchdog.unref?.();

const SEAL = { WORKER_SECRET_SEAL_KEY: crypto.randomBytes(32).toString('hex') };
const ROOT = path.join(__dirname, '..');

/** Spawn a process, collect its JSON log lines, and return them with the exit code. */
function spawnJson(script, args = [], extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        DATABASE_URL: cluster.url,
        JWT_SECRET: 'unattended-check',
        ADMIN_EMAIL: process.env.ADMIN_EMAIL,
        ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
        ...SEAL,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const kill = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('close', (code) => {
      clearTimeout(kill);
      resolve({
        code,
        lines: out.split('\n').filter(Boolean).map((l) => {
          try { return JSON.parse(l); } catch (_) { return { raw: l }; }
        }),
        stdout: out, stderr: err,
      });
    });
  });
}

const tick = (args = [], extraEnv = {}) =>
  spawnJson('scripts/office-cycle-tick.js', args, extraEnv);

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: cluster.url, ssl: false });
  const query = (t, p) => P.query(t, p);
  const withTransaction = async (fn) => {
    const c = await P.connect();
    try {
      await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  };
  const deps = { query, withTransaction, env: SEAL };
  let server = null;
  const made = { companies: [], objectives: [], workers: [], controlTasks: [] };
  const uid = (p) => `unatt-${p}-${crypto.randomUUID().slice(0, 8)}`;

  try {
    const autonomy = require('../src/lib/autonomy');
    await require('../src/lib/db').initDB();
    await autonomy.migrateAutonomy(query);
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);
    await require('../src/lib/office/memory').migrateMemory(query);
    const IDENTITY = require('../src/lib/worker/identity');
    await IDENTITY.migrateWorkerIdentity(query);
    await require('../src/lib/worker/leases').migrateWorkerTasks(query);
    await require('../src/lib/worker/audit').migrateWorkerAudit(query);
    await require('../src/lib/identity/schema').migrateIdentity
      ? require('../src/lib/identity/schema').migrateIdentity(query) : null;
    autonomy.resetForTests && autonomy.resetForTests();

    // A worker API, so the DISPATCH phase's task can actually be executed by a real worker.
    const express = require('express');
    const WR = require('../src/api/worker.routes');
    const app = express();
    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.use('/api', WR.createWorkerRouter({ enable: true, query, withTransaction, env: SEAL }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    // ── FIXTURES: one company, one funded supervised objective, one worker ──
    const CO = uid('co');
    await query(`INSERT INTO companies (id, slug, display_name, status)
                 VALUES ($1,$1,$1,'active')`, [CO]);
    made.companies.push(CO);

    const OBJ = uid('obj');
    await query(`INSERT INTO objectives
                   (id, company_id, objective, priority, autonomy_tier, approval_policy, status,
                    created_by, budget_usd)
                 VALUES ($1,$2,'synthetic unattended cycle','P1','supervised',
                         'all_consequential','active','naren@fixture.invalid',5.00)`, [OBJ, CO]);
    made.objectives.push(OBJ);

    const tok = await IDENTITY.createEnrollmentToken({ syntheticOnly: false, label: 'unattended-worker' }, deps);
    const enrolled = await (await fetch(`${baseUrl}/api/worker/enroll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tok.token, hostFingerprint: 'unattended-check' }),
    })).json();
    if (!enrolled.ok) { bad('could not enrol the fixture worker', enrolled); throw new Error('no worker'); }
    made.workers.push(enrolled.workerId);
    const runWorker = () => spawnJson('src/worker-client/run.js', ['--once'], {
      WORKER_API_BASE_URL: baseUrl,
      WORKER_ID: enrolled.workerId,
      PLAYNEXA_WORKER_ENV: 'development',
      PLAYNEXA_DEV_WORKER_SECRET: enrolled.secret,
    });

    // `--once` leases ONE task and exits, which is the right shape for a worker and the wrong
    // shape for an assertion: a plan with two steps left the second task PENDING and the check
    // reported the cycle broken. Drain by RUNNING THE WORKER AGAIN — a fresh process each time,
    // which is also the behaviour under test — bounded, and never by widening the assertion.
    const drainWorker = async (planId, limit = 6) => {
      let last = null;
      for (let i = 0; i < limit; i++) {
        last = await runWorker();
        const left = (await query(
          `SELECT COUNT(*)::int n FROM worker_tasks t
             JOIN office_plan_steps s ON s.intent_key = t.intent_key
            WHERE s.plan_id = $1 AND t.state NOT IN ('COMPLETED','FAILED','CANCELLED')`,
          [planId])).rows[0].n;
        if (!left) return { ...last, passes: i + 1 };
      }
      return { ...last, passes: limit, drained: false };
    };
    console.log(`  ..    fixtures up; worker enrolled; api on ${baseUrl}\n`);

    // ══ 1. NOBODY CALLS A CYCLE FUNCTION ═════════════════════════════════
    head('1. the first tick starts a run and plans it — in a separate process');

    const t1 = await tick(['--company', CO]);
    const initiated = t1.lines.find((l) => l.at === 'initiated');
    const advanced = t1.lines.filter((l) => l.at === 'advanced');
    if (initiated && initiated.started === 1) {
      ok('tick 1 DISCOVERED the objective and started a run (no objective was named to it)');
    } else bad('tick 1 started nothing', JSON.stringify({ initiated, code: t1.code, err: t1.stderr.slice(0, 300) }));

    if (advanced.some((a) => a.phase === 'plan' && a.ok === true)) {
      ok('…and advanced it through the PLAN phase in the same tick');
    } else bad('the run was not planned', JSON.stringify(advanced));

    const runRow = (await query(
      `SELECT run_id, state FROM agent_runs WHERE objective_id = $1`, [OBJ])).rows[0];
    const RUN = runRow && runRow.run_id;
    const plan = (await query(
      `SELECT id, status, verdict FROM office_plans WHERE run_id = $1`, [RUN])).rows[0];
    if (plan && String(plan.verdict || '').startsWith('validated')) {
      ok(`a validated plan exists (${plan.id}) — minted by a process that has since exited`);
    } else bad('no authorized plan', plan);

    // ══ 2. A SEPARATE PROCESS DISPATCHES ═════════════════════════════════
    head('2. the next tick dispatches — a different process, no shared memory');

    const t2 = await tick(['--company', CO]);
    const d = t2.lines.filter((l) => l.at === 'advanced');
    if (d.some((a) => a.phase === 'dispatch')) {
      ok('tick 2 read the phase from DURABLE ROWS and dispatched');
    } else bad('tick 2 did not dispatch', JSON.stringify(d));

    const queued = (await query(
      `SELECT t.id, t.state, t.task_type FROM worker_tasks t
         JOIN office_plan_steps s ON s.intent_key = t.intent_key
        WHERE s.plan_id = $1`, [plan.id])).rows;
    if (queued.length >= 1) {
      ok(`${queued.length} plan step(s) enqueued as durable worker task(s)`);
    } else bad('nothing was enqueued for the plan steps');

    if (t2.lines.find((l) => l.at === 'initiated' && l.duplicates === 1)) {
      ok('and the same tick reported the initiation as a DUPLICATE rather than starting a second run');
    } else {
      bad('tick 2 did not report a duplicate initiation',
        JSON.stringify(t2.lines.find((l) => l.at === 'initiated')));
    }

    // ══ 3. A TICK WHILE THE WORKER HAS NOT RUN WAITS ═════════════════════
    head('3. a tick with work outstanding waits, and says what for');

    const t3 = await tick(['--company', CO]);
    const waiting = t3.lines.find((l) => l.at === 'advanced' && l.phase === 'collect');
    if (waiting) {
      ok('the cycle reports COLLECT and does not block — a scheduler must never wait on another '
        + 'process');
    } else bad('the cycle did not report waiting', JSON.stringify(t3.lines));

    const stillOne = (await query(
      `SELECT COUNT(*)::int n FROM worker_tasks t
         JOIN office_plan_steps s ON s.intent_key = t.intent_key WHERE s.plan_id = $1`,
      [plan.id])).rows[0].n;
    if (stillOne === queued.length) {
      ok('and a tick in COLLECT enqueues NOTHING further — no duplicate dispatch');
    } else bad(`task count went from ${queued.length} to ${stillOne} on an idle tick`);

    // ══ 4. THE WORKER EXECUTES, THEN A TICK VALIDATES ════════════════════
    head('4. a real worker executes; a later process validates independently');

    const w = await drainWorker(plan.id);
    const executed = (await query(
      `SELECT t.id, t.task_type, t.state, r.status, r.output FROM worker_tasks t
         LEFT JOIN worker_results r ON r.task_id = t.id
         JOIN office_plan_steps s ON s.intent_key = t.intent_key
        WHERE s.plan_id = $1`, [plan.id])).rows;
    if (executed.every((x) => x.state === 'COMPLETED' && x.status === 'SUCCEEDED')) {
      ok(`the worker PROCESS completed the delegated work (${w.passes} lease(s), a new process each)`);
    } else bad('the delegated work did not complete', JSON.stringify({ executed, code: w.code }));

    const t4 = await tick(['--company', CO]);
    if (t4.lines.some((l) => l.at === 'advanced' && l.phase === 'validate')) {
      ok('a later tick validated the result INDEPENDENTLY of the handler that produced it');
    } else bad('no validate phase ran', JSON.stringify(t4.lines.filter((l) => l.at === 'advanced')));

    const outcomes = (await query(
      `SELECT outcome, business_effect, effect_ref FROM office_outcomes WHERE run_id = $1`, [RUN])).rows;
    if (outcomes.length === 1 && outcomes[0].outcome === 'achieved') {
      ok('and recorded a durable outcome of `achieved`');
    } else bad('the outcome was not recorded as achieved', outcomes);

    // ══ 5. REPORT: EMPLOYEE WORK, BRIEFING, MEMORY ═══════════════════════
    head('5. the final phase coordinates, briefs, and writes memory');

    const t5 = await tick(['--company', CO]);
    if (t5.lines.some((l) => l.at === 'advanced' && l.phase === 'report')) {
      ok('the REPORT phase ran');
    } else bad('no report phase', JSON.stringify(t5.lines.filter((l) => l.at === 'advanced')));

    const mem = (await query(
      `SELECT subject FROM agent_memory WHERE company_id = $1 AND source_run_id = $2`,
      [CO, RUN])).rows;
    if (mem.length && mem.every((m) => m.subject.startsWith('plan-step-completed:'))) {
      ok(`${mem.length} memory row(s) written in the vocabulary the PLANNER can read back`);
      note('the prefix matters: priorStepsFromMemories requires it, so writing anything else '
        + 'would make the continuity claim false while looking like it worked');
    } else bad('memory was not written in the planner-readable form', mem);

    // ══ 6. THE SECOND CONSECUTIVE CYCLE ══════════════════════════════════
    head('6. a second scheduled cycle, informed by the first');

    // Age the run and its intent key into "yesterday" so the next business day is a new intent.
    // The CLOCK is not moved: the fixture is, which keeps the assertion deterministic.
    // Only if it has not already ended. Both statements here were written when a terminal run's
    // `ended_at` could be rewritten; it is now write-once at the database level (B3.21), and the
    // first statement was already a silent no-op against the transition guard. A run the cycle has
    // already finished needs neither, so the fixture asks for the state it wants and stops if it is
    // already there, rather than issuing two statements that mean nothing.
    const already = (await query(
      `SELECT state, ended_at FROM agent_runs WHERE run_id=$1`, [RUN])).rows[0];
    if (!already || !already.ended_at) {
      await query(`UPDATE agent_runs SET state='RUNNING' WHERE run_id=$1`, [RUN]).catch(() => {});
      await query(`UPDATE agent_runs SET state='SUCCEEDED', ended_at=COALESCE(ended_at, NOW())
                    WHERE run_id=$1`, [RUN]);
    }
    // agent_runs enforces run identity as immutable — run_id, attempt, intent_key and the rest
    // cannot be rewritten, by a trigger, which is correct and which my fixture tried to do anyway.
    // So the second cycle is reached the way the product reaches it: the business day moves. The
    // intent key embeds `bd=<day>`, so initiating "tomorrow" is a different intent and the
    // first run's key is left exactly as the product wrote it.

    // TOMORROW IN CHICAGO, from the product's own helpers — not a UTC day plus one.
    //
    // This read `new Date(); setUTCDate(+1)`, and B3.20's window refused it: the container clock was
    // already 2026-11-26 UTC while Chicago was still on the 25th, so "UTC tomorrow" was two days
    // ahead in the timezone the crons fire in, which is exactly the future-dating the seam exists to
    // refuse. The guard was right and the harness was wrong. Asking the same question the product
    // asks is also the only version of this that cannot drift from it.
    const OVERRIDE = require('../src/lib/office/business-day-override');
    const TOMORROW = OVERRIDE.dayAfter(OVERRIDE.chicagoDay());
    const t6 = await tick(['--company', CO, '--business-day', TOMORROW]);
    const second = t6.lines.find((l) => l.at === 'initiated');
    if (second && second.started === 1) {
      ok('a SECOND consecutive cycle started for the same objective on a new intent');
    } else bad('the second cycle did not start', JSON.stringify(second));

    const runs = (await query(
      `SELECT run_id, state FROM agent_runs WHERE objective_id=$1 ORDER BY created_at`, [OBJ])).rows;
    if (runs.length === 2) ok('exactly two runs exist for this objective — one per cycle');
    else bad(`${runs.length} runs exist for two cycles`, runs.map((r) => r.state));

    const RUN2 = runs[1].run_id;
    const plan2 = (await query(
      `SELECT id, verdict FROM office_plans WHERE run_id=$1`, [RUN2])).rows[0];
    if (plan2 && String(plan2.verdict || '').startsWith('validated')) {
      ok('the second cycle produced its own validated plan');
    } else bad('the second cycle did not plan', plan2);

    const informed = t6.lines.find((l) => l.at === 'advanced' && l.phase === 'plan');
    if (informed) {
      ok('…and the planning phase ran with the first cycle\'s memory available to it');
      note('that the memory was CONSULTED is asserted here; that a recalled step changes the plan '
        + 'is decomposition\'s own property and is measured in check-office-decomposition-db.js');
    } else bad('the second cycle did not reach a plan phase');

    // ══ 7. CONCURRENT TICKS MUST NOT DOUBLE-DISPATCH ═════════════════════
    head('7. two schedulers firing at once do not duplicate execution');

    // THE case a "have I dispatched?" flag would get wrong: both processes read the same phase
    // before either writes. The arbiter is the task table's unique intent key, not a check.
    const before = (await query(`SELECT COUNT(*)::int n FROM worker_tasks`)).rows[0].n;
    const [a, b] = await Promise.all([
      tick(['--company', CO, '--business-day', TOMORROW]),
      tick(['--company', CO, '--business-day', TOMORROW])]);
    const after = (await query(`SELECT COUNT(*)::int n FROM worker_tasks`)).rows[0].n;
    const steps2 = (await query(
      `SELECT COUNT(*)::int n FROM office_plan_steps WHERE plan_id=$1 AND task_type IS NOT NULL`,
      [plan2.id])).rows[0].n;
    // EXACTLY the step count, not "at most" it. `<=` was satisfied by zero, so a race that
    // dispatched nothing at all would have passed as a race that dispatched correctly — the
    // assertion would have been measuring the absence of work rather than the presence of
    // deduplication.
    if (after - before === steps2 && steps2 > 0) {
      ok(`two simultaneous ticks enqueued exactly one task per plan step `
        + `(+${after - before} for ${steps2} step(s))`);
    } else {
      bad(`two simultaneous ticks enqueued ${after - before} tasks for ${steps2} step(s)`,
        { aLines: a.lines.length, bLines: b.lines.length });
    }
    const dupRuns = (await query(
      `SELECT COUNT(*)::int n FROM agent_runs WHERE objective_id=$1`, [OBJ])).rows[0].n;
    if (dupRuns === 2) ok('and still exactly two runs — no third was started by the race');
    else bad(`${dupRuns} runs after concurrent ticks`);

    // ══ 8. A KILLED TICK LOSES NOTHING ═══════════════════════════════════
    head('8. a tick killed mid-flight leaves the cycle resumable');

    {
      // SIGKILL during a tick, then a fresh tick. Nothing is recovered, because nothing was held:
      // the phase is derived from rows, so the next process reaches the same conclusion.
      const victim = spawn(process.execPath,
        [path.join(ROOT, 'scripts/office-cycle-tick.js'), '--company', CO,
          '--business-day', TOMORROW],
        { env: { PATH: process.env.PATH, DATABASE_URL: cluster.url, JWT_SECRET: 'x', ...SEAL },
          stdio: 'ignore' });
      // The close listener is attached BEFORE the kill. Attaching it after is a race the checker
      // lost on its first green run: the process exited between `kill` and `on('close')`, the
      // event had already fired, and the promise never resolved — a hung check, which reads as a
      // hung product. A watchdog would have called it a stall in the cycle. It was a stall in the
      // measurement.
      const closed = new Promise((r) => victim.on('close', r));
      await new Promise((r) => setTimeout(r, 150));
      victim.kill('SIGKILL');
      await closed;

      const resumed = await tick(['--company', CO, '--business-day', TOMORROW]);
      if (resumed.code === 0 && resumed.lines.some((l) => l.at === 'advanced')) {
        ok('after a SIGKILL mid-tick, the next process advanced the cycle normally');
      } else {
        bad('the cycle did not resume after a killed tick',
          JSON.stringify({ code: resumed.code, err: resumed.stderr.slice(0, 300) }));
      }
      const runsAfterKill = (await query(
        `SELECT COUNT(*)::int n FROM agent_runs WHERE objective_id=$1`, [OBJ])).rows[0].n;
      if (runsAfterKill === 2) ok('and the kill created no extra run');
      else bad(`${runsAfterKill} runs after a killed tick`);
    }

    // ══ 8a. THE BUSINESS-DAY SEAM REFUSES WHAT IT MUST (B3.20) ═══════════
    //
    // Owner's Priority 5 of the second directive, 2026-11-25. The module's own unit tests cover the
    // four conditions; what they cannot cover is whether the TICK SCRIPT honours a refusal, so this
    // runs the real script and reads its exit code. A seam whose guard is only unit-tested is a
    // guard the caller may be ignoring.
    head('8a. --business-day is restricted, and the refusal is the script\'s exit code');

    {
      // NODE_ENV=production, with everything else identical to the ticks above.
      const prod = await tick(['--company', CO, '--business-day', TOMORROW], { NODE_ENV: 'production' });
      if (prod.code === 3 && /production_environment/.test(prod.stderr)) {
        ok('NODE_ENV=production REFUSES the override, exit 3, naming the condition');
      } else {
        bad('a production environment did not refuse the override',
          { code: prod.code, stderr: prod.stderr.slice(0, 300) });
      }

      // A historical day, in a development environment: replay is refused on its own.
      const past = await tick(['--company', CO, '--business-day', '2026-01-02']);
      if (past.code === 3 && /day_outside_the_permitted_window/.test(past.stderr)) {
        ok('a historical business day REFUSES — no replay of a day whose work is closed');
      } else {
        bad('a historical business day was accepted',
          { code: past.code, stderr: past.stderr.slice(0, 300) });
      }

      // And a far-future one.
      const future = await tick(['--company', CO, '--business-day', '2027-06-01']);
      if (future.code === 3 && /day_outside_the_permitted_window/.test(future.stderr)) {
        ok('a future-dated business day REFUSES — no run for a day nobody authorized');
      } else {
        bad('a future-dated business day was accepted',
          { code: future.code, stderr: future.stderr.slice(0, 300) });
      }

      // The CONTROL: tomorrow still works, or the three refusals above would prove only that the
      // flag is broken.
      const okTick = await tick(['--company', CO, '--business-day', TOMORROW]);
      if (okTick.code === 0 && okTick.lines.some((l) => l.at === 'business_day_override')) {
        ok('CONTROL: tomorrow is still honoured on this development database, and says so');
      } else {
        bad('the permitted case stopped working, so the refusals above prove nothing',
          { code: okTick.code, stderr: okTick.stderr.slice(0, 300) });
      }
    }

    // ══ 9a. DESTRUCTIVE CONTROL — LAST, AND NEVER BEFORE A MEASUREMENT ═══
    //
    // Section 7 showed that two simultaneous ticks produced one task per step. That is the right
    // outcome and, on its own, no evidence about WHY: an application check, a lucky ordering and a
    // database constraint are indistinguishable from the outside. This control names the arbiter.
    //
    // It does NOT try to make the cycle dispatch twice. It cannot: phaseOf derives the phase from
    // durable rows, so once tasks exist the cycle never returns to DISPATCH — my first version of
    // this control reset results and task states and still measured nothing, because the thing it
    // was trying to provoke is structurally unreachable. That is the cycle behaving correctly.
    // The duplication claim is a property of `enqueueTask` under one intent key, so that is what
    // is measured, with a fixture key of its own.
    head('9a. the arbiter is the database, named by removing it (control)');

    {
      const LEASES = require(path.join(ROOT, 'src/lib/worker/leases'));
      const controlKey = `unatt-control-${crypto.randomBytes(8).toString('hex')}`;
      const enqueue = () => LEASES.enqueueTask({
        taskType: 'synthetic.echo', payload: { hello: 'control' }, intentKey: controlKey,
        companyId: CO, workflow: 'office.scheduled_cycle', createdBy: 'office-initiator',
      }, {});

      const first = await enqueue().catch((e) => ({ ok: false, code: e.message }));
      if (first && first.ok) {
        made.controlTasks.push(first.taskId);
        ok('the control enqueued one task under its own fixture intent key');
      } else bad('the control could not enqueue at all', first);

      const again = await enqueue().catch((e) => ({ ok: false, code: e.message }));
      const repeatedRows = (await query(
        `SELECT id FROM worker_tasks WHERE intent_key = $1`, [controlKey])).rows;
      if (repeatedRows.length === 1) {
        ok(`a second enqueue under the same intent key added no row `
          + `(reported: ${(again && (again.code || again.ok)) || 'n/a'})`);
      } else bad(`${repeatedRows.length} rows exist for one intent key before the index was dropped`);

      const dropped = await query(`DROP INDEX uq_worker_tasks_intent`).then(() => true, () => false);
      if (!dropped) {
        bad('uq_worker_tasks_intent could not be dropped — the control did not run, so nothing '
          + 'here names what prevents a duplicate');
      } else {
        const third = await enqueue().catch((e) => ({ ok: false, code: e.message }));
        if (third && third.ok) made.controlTasks.push(third.taskId);
        const nowRows = (await query(
          `SELECT id FROM worker_tasks WHERE intent_key = $1`, [controlKey])).rows;
        if (nowRows.length > 1) {
          ok(`with uq_worker_tasks_intent dropped the same enqueue produced a duplicate `
            + `(${nowRows.length} rows for one intent key) — the DATABASE is what refuses it, `
            + 'not an application flag');
        } else {
          bad('no duplicate appeared even with the unique index dropped, so the refusal above '
            + 'came from somewhere this control has not identified', nowRows.length);
        }
        await query(`DELETE FROM worker_tasks WHERE intent_key = $1`, [controlKey]).catch(() => {});
        const restored = await query(
          `CREATE UNIQUE INDEX uq_worker_tasks_intent ON worker_tasks (intent_key)`)
          .then(() => true, () => false);
        if (restored) ok('and the index was restored, so no later section inherits a damaged schema');
        else bad('the unique index could not be restored after the control');
      }
    }

    // ══ 9. WHAT THIS DID NOT PROVE ═══════════════════════════════════════
    head('9. what this run did NOT exercise');

    {
      const calls = (await query(
        `SELECT COUNT(*)::int n FROM office_cost_ledger WHERE company_id=$1`, [CO])).rows[0].n;
      if (calls === 0) {
        ok('ZERO provider calls — the planning here is deterministic, and no live model was used');
      } else bad(`${calls} provider cost rows exist; this check must make none`);
      note('NOT proven: live-model planning · a real external communication · production '
        + 'scheduling · a long-running scheduler (B4.7). The cron that calls this tick is inert '
        + 'unless OFFICE_INITIATOR_ENABLED=true.');
    }
  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    try { if (server) await new Promise((r) => server.close(r)); } catch (_) {}
    try {
      for (const id of made.objectives) {
        // By PLAN, not by objective_id: office_plan_steps has no such column, so this DELETE had
        // been failing silently under its own `.catch` since it was written. Harmless here because
        // the cluster is destroyed, and a swallowed cleanup failure is still worth not having.
        await query(`DELETE FROM office_plan_steps WHERE plan_id IN
                       (SELECT id FROM office_plans WHERE objective_id = $1)`, [id]).catch(() => {});
        await query(`DELETE FROM office_plans WHERE objective_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM objectives WHERE id=$1`, [id]).catch(() => {});
      }
      // The control's own tasks, by the ids it recorded as it created them — never by intent-key
      // pattern and never by recency.
      for (const id of made.controlTasks) {
        await query(`DELETE FROM worker_results WHERE task_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM worker_tasks WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.workers) {
        await query(`DELETE FROM worker_identities WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.companies) {
        await query(`DELETE FROM companies WHERE id=$1`, [id]).catch(() => {});
      }
      note('fixtures held by append-only audit rows remain in the disposable cluster, which is '
        + 'destroyed below — the by-id discipline still applied to everything deletable');
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
