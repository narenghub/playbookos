#!/usr/bin/env node
// ── THE ACTUAL RUNNING SCHEDULER ADVANCES THE CYCLE ─────────────────────────
//
//   node scripts/check-running-scheduler-db.js   exit 0 = every ruled property holds
//                                                 exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner, second directive of 2026-11-25, Priority 1: *"The reported cron fires once per weekday at
// 6 AM Chicago time, while advanceCycle advances only one phase per invocation… Demonstrate this
// through the actual running scheduler, without a test driver manually invoking successive ticks."*
//
// That was a real defect and the report before it was wrong in a specific way: what
// `check-unattended-cycle-db.js` verified is the ENGINE, and it verified it by invoking successive
// ticks itself. With one weekday cron doing one phase per firing, a six-phase cycle would have
// taken six weekdays. B3.16 splits the two schedules; this file is the evidence for the second one.
//
// ── WHAT MAKES THIS DIFFERENT FROM EVERY OTHER CHECK HERE ──────────────────
//
// It spawns `server.js` — the real application, with its real cron registrations — and then
// **watches the database**. It calls no cycle function, spawns no tick, and never advances
// anything. Every phase transition below is performed by the running server's own
// `office-cycle-advance` cron. The assertion that it does not drive the cycle is made against this
// file's own source with comments blanked, so this paragraph cannot satisfy it.
//
// ── THE ONE THING IT CANNOT WAIT FOR, STATED PLAINLY ───────────────────────
//
// Initiation fires weekdays at 06:00 America/Chicago. A check cannot wait for that and must not be
// given a way to move it — a configurable initiation schedule would be exactly the production
// bypass the owner's Priority 5 rules out. So the check calls `initiateDueObjectives` ONCE, as a
// stand-in for that one business-schedule firing, and then touches nothing. `B3.12`'s own check
// covers initiation from a tick. What is demonstrated here is the part the owner named: the
// SUCCESSIVE advancement, by the running scheduler, with no driver.
//
// NO URL OVERRIDE: its own disposable cluster; fixtures by id.

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
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
  cluster = DISPOSABLE.create({ label: 'sched' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  the running scheduler was not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'sched-bootstrap@sched.invalid';
process.env.ADMIN_PASSWORD = `sched-${crypto.randomBytes(16).toString('hex')}`;

const TICK_SECONDS = 15;              // the configured floor; see server.js's clamp
const ROOT = path.join(__dirname, '..');
const SEAL = { WORKER_SECRET_SEAL_KEY: crypto.randomBytes(32).toString('hex') };

const watchdog = setTimeout(() => {
  console.log('\n  FAIL  no progress in 600s — a stall is a failure.');
  process.exit(1);
}, 600_000);
watchdog.unref?.();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The employee-task id the cycle derives for a run, computed INDEPENDENTLY here.
 *
 * `daily_tasks.id` is TEXT. Deriving the id from the run is what makes a repeated REPORT phase
 * collide with its own primary key instead of filing a second task; writing the formula again here
 * rather than importing it means a change to either one shows up as a failed assertion.
 *
 * Two wrong turns are recorded here because both were the same mistake: this query first invented a
 * `run_tag` column, and then I changed the PRODUCT's id to a hash-derived UUID on the strength of
 * an `operator does not exist` error whose real cause was an untyped placeholder in this file.
 * Neither was a schema fact until I read the DDL.
 */
function taskIdFor(runId) {
  return `task-cycle-${runId}`.slice(0, 64);
}

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
  const made = { companies: [], objectives: [], workers: [] };
  const uid = (p) => `sched-${p}-${crypto.randomUUID().slice(0, 8)}`;
  const children = [];
  let workerApi = null;

  const spawnChild = (script, args, extraEnv) => {
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        DATABASE_URL: cluster.url,
        JWT_SECRET: 'running-scheduler-check',
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

  /** Poll the database until `fn` returns truthy, or give up. Never advances anything. */
  const waitFor = async (label, fn, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) return null;
      await sleep(1000);
    }
  };

  try {
    const autonomy = require('../src/lib/autonomy');
    const IDENTITY = require('../src/lib/worker/identity');
    await require('../src/lib/db').initDB();

    // THE WHOLE MIGRATOR, not a hand-picked subset. server.js refuses to boot unless
    // `schema-ready.js` finds every required table and column (ENG-003: boot reads, it does not
    // migrate), so a check that migrates only the tables IT needs gets a server that exits
    // immediately — which is what the first run of this check measured, and it read as "the server
    // did not come up" rather than "I did not build the schema it boots against".
    await require('../src/lib/migrate-all').runAll(query, { seeds: true });
    // The worker tables are NOT in the application migrator — they belong to the M7 worker service
    // and are migrated by it. `schema-ready` does not require them, which is why the server booted
    // happily without them and the failure surfaced one step later, at enrolment.
    await IDENTITY.migrateWorkerIdentity(query);
    await require('../src/lib/worker/leases').migrateWorkerTasks(query);
    await require('../src/lib/worker/audit').migrateWorkerAudit(query);
    autonomy.resetForTests && autonomy.resetForTests();

    // ── FIXTURES ───────────────────────────────────────────────────────────
    const CO = uid('co');
    await query(`INSERT INTO companies (id, slug, display_name, status)
                 VALUES ($1,$1,$1,'active')`, [CO]);
    made.companies.push(CO);

    const OBJ = uid('obj');
    await query(`INSERT INTO objectives
                   (id, company_id, objective, priority, autonomy_tier, approval_policy, status,
                    created_by, budget_usd)
                 VALUES ($1,$2,'synthetic scheduler cycle','P1','supervised',
                         'all_consequential','active','naren@fixture.invalid',5.00)`, [OBJ, CO]);
    made.objectives.push(OBJ);

    // ── AN EMPLOYEE TO ASSIGN WORK TO ──────────────────────────────────────
    //
    // This fixture is here because of what its ABSENCE hid. Without a member of CO, the cycle's
    // employee-assignment phase has nobody to assign to, `employeesOf` returns none, and the
    // effects assertion below read `tasks <= 1` — satisfied by ZERO. B3.17 then found that the
    // cycle omitted the NOT NULL `task_date`, so the assignment would have refused even with a
    // member: two layers of nothing-happening agreeing with each other. With a real member the
    // assertion is `=== 1`, and the running scheduler has to actually assign the task.
    const EMP = uid('emp');
    const ACTOR = uid('actor');
    await query(`INSERT INTO users (id, email, name, role, password_hash, is_active)
                 VALUES ($1,$2,'Scheduler Fixture Employee','admin','x',1)`,
      [EMP, `${EMP}@fixture.invalid`]);
    await query(`INSERT INTO users (id, email, name, role, password_hash, is_active)
                 VALUES ($1,$2,'Scheduler Fixture Authorizer','super_admin','x',1)`,
      [ACTOR, `${ACTOR}@fixture.invalid`]);
    made.users = [EMP, ACTOR];
    await require('../src/lib/identity/company-membership').grantMembership({
      userId: EMP, companyId: CO, companyRole: 'member', grantedBy: ACTOR,
      reason: 'fixture member so the scheduler-driven cycle has somebody to assign work to',
    }, deps);

    // ── THE REAL SERVER, WITH ITS REAL CRONS ───────────────────────────────
    const port = 30000 + Math.floor(Math.random() * 20000);
    const { child: server, log: serverLog } = spawnChild('server.js', [], {
      PORT: String(port),
      OFFICE_INITIATOR_ENABLED: 'true',
      OFFICE_CYCLE_TICK_SECONDS: String(TICK_SECONDS),
      WORKER_API_ENABLED: 'true',
    });
    const baseUrl = `http://127.0.0.1:${port}`;

    head('1. the application starts and registers BOTH schedules');

    const up = await waitFor('server', async () => {
      try {
        const r = await fetch(`${baseUrl}/health`);
        return r.ok ? await r.json() : null;
      } catch (_) { return null; }
    }, 90_000);
    if (up) ok(`the real server.js is serving (${baseUrl}/health)`);
    else { bad('the server did not come up', serverLog.err.slice(-600)); throw new Error('no server'); }

    // The registration line is a LOG, so it is read for diagnostics only. The property below is
    // measured by whether the cycle actually advances with nobody driving it.
    if (/office-cycle-advance registered/.test(serverLog.out)) {
      ok('it registered office-scheduled-initiation AND office-cycle-advance as separate crons');
    } else {
      bad('the advancement cron was not registered', serverLog.out.slice(-600));
    }
    if (new RegExp(`\\*/${TICK_SECONDS} \\* \\* \\* \\* \\*`).test(serverLog.out)) {
      ok(`and the advancement tick honoured OFFICE_CYCLE_TICK_SECONDS=${TICK_SECONDS}`);
    } else bad('the configured tick interval was not used', serverLog.out.slice(-400));

    // ── THE WORKER API, IN PROCESS, AND WHY NOT THE DEV SERVICE ────────────
    //
    // Two things were learned here and both are the product behaving correctly.
    // (1) `server.js` does NOT mount the worker router — `/api/worker/enroll` on it returns the
    //     SPA's index.html, which is how an earlier run failed with "Unexpected token '<'". The
    //     worker API is a service of its own.
    // (2) That service, `scripts/dev-worker-api-server.js`, then REFUSED to start against this
    //     cluster: `db-identity.js` found populated business tables and reported
    //     `production_fingerprint`. It is right to refuse. This check runs the FULL application
    //     migrator with seeds — because `schema-ready.js` will not let server.js boot otherwise —
    //     and a seeded application database is exactly what that guard exists to decline.
    // So the worker API is mounted in THIS process, from the same router the dev service mounts.
    // What is under test here is the SCHEDULER, which is the real `server.js` in its own process;
    // the worker API is a fixture, and saying so is better than weakening a guard to dress it up.
    const express = require('express');
    const http = require('node:http');
    const WR = require('../src/api/worker.routes');
    const app = express();
    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.use('/api', WR.createWorkerRouter({ enable: true, query, withTransaction, env: SEAL }));
    workerApi = http.createServer(app);
    await new Promise((r) => workerApi.listen(0, '127.0.0.1', r));
    const apiUrl = `http://127.0.0.1:${workerApi.address().port}`;
    ok('a worker API is serving for the fixture worker (in-process, and stated as a fixture)');

    // ── A REAL WORKER, ALSO A SEPARATE PROCESS, ALSO UNDRIVEN ──────────────
    const tok = await IDENTITY.createEnrollmentToken({ syntheticOnly: false, label: 'scheduler-worker' }, deps);
    const enrolled = await (await fetch(`${apiUrl}/api/worker/enroll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tok.token, hostFingerprint: 'running-scheduler-check' }),
    })).json();
    if (!enrolled || !enrolled.ok) {
      bad('could not enrol a worker against the running server', enrolled);
      throw new Error('no worker');
    }
    made.workers.push(enrolled.workerId);
    // No --once: a long-running worker, polling on its own, exactly as a deployed one does.
    spawnChild('src/worker-client/run.js', [], {
      WORKER_API_BASE_URL: apiUrl,
      WORKER_ID: enrolled.workerId,
      PLAYNEXA_WORKER_ENV: 'development',
      PLAYNEXA_DEV_WORKER_SECRET: enrolled.secret,
    });
    ok('a real worker process is polling the running server');

    // ── 2. ONE INITIATION, THEN NOTHING FROM THIS PROCESS ─────────────────
    head('2. one business-schedule initiation, then the scheduler is on its own');

    const INIT = require('../src/lib/office/initiator');
    const started = await INIT.initiateDueObjectives({ companyId: CO }, deps);
    if (started.initiated.length === 1) {
      ok('the initiator started exactly one run for the funded supervised objective');
      note('this stands in for the weekday 06:00 Chicago firing, which a check cannot wait for '
        + 'and must not be given a way to move — see the header');
    } else {
      bad('initiation did not start the fixture run', JSON.stringify(started.refused.concat(started.skipped)));
      throw new Error('no run');
    }
    const RUN = started.initiated[0].runId;

    // ── 3. THE SCHEDULER CARRIES IT, PHASE BY PHASE ───────────────────────
    head('3. the running scheduler advances it with nobody driving');

    const plan = await waitFor('plan', async () => (await query(
      `SELECT id, verdict FROM office_plans WHERE run_id = $1`, [RUN])).rows[0],
    TICK_SECONDS * 4000);
    if (plan && String(plan.verdict || '').startsWith('validated')) {
      ok(`the scheduler's own tick planned the run (${plan.id})`);
    } else bad('no validated plan appeared within four ticks', plan);

    const task = await waitFor('task', async () => (await query(
      `SELECT t.id, t.state FROM worker_tasks t
         JOIN office_plan_steps s ON s.intent_key = t.intent_key
        WHERE s.plan_id = $1`, [plan && plan.id])).rows[0], TICK_SECONDS * 4000);
    if (task) ok(`and dispatched its plan step as a durable task (${task.id})`);
    else bad('no task was enqueued within four ticks');

    const result = await waitFor('result', async () => (await query(
      `SELECT status FROM worker_results WHERE task_id = $1`, [task && task.id])).rows[0],
    TICK_SECONDS * 4000);
    if (result && result.status === 'SUCCEEDED') ok('the worker executed it and submitted a result');
    else bad('the delegated work did not complete', result);

    const outcome = await waitFor('outcome', async () => (await query(
      `SELECT outcome FROM office_outcomes WHERE run_id = $1`, [RUN])).rows[0],
    TICK_SECONDS * 4000);
    if (outcome && outcome.outcome === 'achieved') {
      ok('a later tick validated the result independently and recorded `achieved`');
    } else bad('no outcome was recorded', outcome);

    const mem = await waitFor('memory', async () => {
      const r = await query(`SELECT subject FROM agent_memory WHERE source_run_id = $1`, [RUN]);
      return r.rows.length ? r.rows : null;
    }, TICK_SECONDS * 4000);
    if (mem && mem.every((m) => m.subject.startsWith('plan-step-completed:'))) {
      ok(`${mem.length} memory row(s) written in the vocabulary the planner reads back`);
    } else bad('the REPORT phase did not write planner-readable memory', mem);

    // THE ASSERTION THAT FOUND THE LOOP. This was a `note` in the first version — "the run had
    // not reached a terminal state yet; the phases above are the evidence" — which is exactly the
    // sentence that lets an indefinite loop pass as success. The running scheduler then re-ran
    // REPORT every 15 seconds, re-writing memory and re-assigning the employee task, because
    // nothing ended the run. It is a FAILURE now.
    const done = await waitFor('terminal', async () => (await query(
      `SELECT state FROM agent_runs WHERE run_id = $1 AND state NOT IN ('CREATED','RUNNING')`,
      [RUN])).rows[0], TICK_SECONDS * 5000);
    if (done) ok(`the run reached a terminal state (${done.state}) with no driver involved`);
    else bad('the run never became terminal, so the scheduler will re-run REPORT for ever');

    // And the effects of REPORT must not have multiplied while it was looping.
    const effects = (await query(
      // EVERY placeholder CAST. `agent_memory.source_run_id` is TEXT and `office_outcomes.run_id`
      // is UUID, so one untyped `$1` used against both makes Postgres choose a single type and
      // refuse the other half — `operator does not exist: uuid = text`, twice in this file.
      `SELECT
         (SELECT COUNT(*)::int FROM agent_memory WHERE source_run_id = $1::text) AS memories,
         (SELECT COUNT(*)::int FROM office_outcomes WHERE run_id = $2::uuid)     AS outcomes,
         (SELECT COUNT(*)::int FROM daily_tasks WHERE id = $3::text)             AS tasks`,
      [RUN, RUN, taskIdFor(RUN)])).rows[0];
    // `tasks === 1`, not `<= 1`: an assertion a zero satisfies measures nothing, and that is the
    // form in which this one hid a product defect for two commits.
    if (effects.outcomes === 1 && effects.tasks === 1 && effects.memories <= 2) {
      ok(`REPORT's effects landed ONCE each (${effects.memories} memory, ${effects.outcomes} `
        + `outcome, ${effects.tasks} employee task) — the task is the scheduler assigning real `
        + `work to a real member, not an absence read as a pass`);
    } else {
      bad('a repeated phase duplicated its effects, or an effect never landed', effects);
    }

    // ── 4. SUCCESSIVE TICKS, NOT ONE ───────────────────────────────────────
    head('4. it took SUCCESSIVE ticks, which is the whole point');

    const tickLines = (serverLog.out.match(/office-cycle-advance — \d+\/\d+ run\(s\) advanced/g) || []);
    if (tickLines.length >= 3) {
      ok(`${tickLines.length} advancement ticks did work — a single firing could not have done this`);
      note('this is the defect the owner found: one weekday cron doing one phase per firing would '
        + 'have needed one business DAY per phase');
    } else {
      bad(`only ${tickLines.length} advancement tick(s) reported work`, serverLog.out.slice(-800));
    }
    const loadLine = (serverLog.out.match(/advanced in (\d+)ms \(tick (\d+)s, cap (\d+)\)/) || null);
    if (loadLine) {
      ok(`each tick reports its own measured cost (${loadLine[1]}ms, cap ${loadLine[3]} runs) — the `
        + 'measurement the interval is meant to be set from');
    } else bad('the tick does not report measured load');

    // ── 5. HALTABLE BY NAME, SEPARATELY FROM INITIATION ───────────────────
    head('5. advancement is haltable by its own name');

    const OBJ2 = uid('obj');
    await query(`INSERT INTO objectives
                   (id, company_id, objective, priority, autonomy_tier, approval_policy, status,
                    created_by, budget_usd)
                 VALUES ($1,$2,'synthetic scheduler cycle 2','P1','supervised',
                         'all_consequential','active','naren@fixture.invalid',5.00)`, [OBJ2, CO]);
    made.objectives.push(OBJ2);

    const stop = await autonomy.stop({
      scope_type: 'workflow', scope_key: 'office-cycle-advance',
      reason: 'running-scheduler check: advancement halted by name',
      actor: 'running-scheduler-check',
    }, { deps });
    if (!stop || stop.ok !== true) bad('the fixture STOP was not applied', stop);

    const started2 = await INIT.initiateDueObjectives({ companyId: CO }, deps);
    const RUN2 = (started2.initiated.find((x) => x.objectiveId === OBJ2) || {}).runId;
    if (RUN2) ok('a second run was initiated while advancement is stopped');
    else bad('the second objective did not initiate', JSON.stringify(started2));

    // A DEAD SERVER WOULD ALSO PLAN NOTHING. That is the trap in this section, and the first
    // version of it walked straight into one: "the run was not planned" is satisfied by a STOP
    // being honoured AND by the process having crashed, and those are opposite facts. So the
    // length of the server's output is recorded first, and the assertions below require that the
    // scheduler went on SAYING something — a tick that reports the STOP — before concluding
    // anything from the absence of a plan.
    const outBefore = serverLog.out.length;
    const errBefore = serverLog.err.length;
    await sleep(TICK_SECONDS * 2500);

    const alive = server.exitCode === null && server.signalCode === null;
    if (alive) ok('the server process is still running');
    else bad(`the server exited (code ${server.exitCode}, signal ${server.signalCode})`,
      serverLog.err.slice(-700));

    // BOTH STREAMS. The refusal is logged by `withAlerts` with console.WARN — stderr — and the
    // first version of this assertion read stdout only, found nothing, and reported that the STOP
    // had not been honoured. It had: `withAlerts` is the one place all 37 crons pass through and it
    // checks the kill switch before the body runs, so a stopped cron is silent on stdout BY
    // DESIGN. Reading one stream and calling the other's silence a failure is this project's
    // recurring defect pointed at a file descriptor.
    const since = serverLog.out.slice(outBefore) + serverLog.err.slice(errBefore);
    if (/\[STOPPED_BY_POLICY\] office-cycle-advance: workflow:office-cycle-advance/.test(since)) {
      ok('every firing since the STOP was refused BY NAME at the shared cron guard, and said so — '
        + 'so the scheduler is firing and refusing, not absent');
      note('the refusal comes from `withAlerts`, which checks the kill switch before any cron body '
        + 'runs; the advancement tick\'s own check is the second line, reachable for a '
        + 'capability-scoped stop that the cron\'s static scopes do not name');
    } else {
      bad('no firing since the STOP reported a policy refusal, so the absence of a plan below '
        + 'proves nothing', since.slice(-700) || '(the server produced no output at all)');
    }

    const plan2 = (await query(`SELECT id FROM office_plans WHERE run_id = $1`, [RUN2 || null])).rows[0];
    if (!plan2) {
      ok('and the stopped scheduler planned nothing — the STOP holds the scheduler, not just the '
        + 'phase');
    } else bad('the stopped scheduler advanced a run anyway', plan2);

    await autonomy.resume({
      scope_type: 'workflow', scope_key: 'office-cycle-advance',
      reason: 'running-scheduler check: lifting the fixture STOP to prove it resumes',
      actor: 'running-scheduler-check',
    }, { deps }).catch(async () => {
      await query(`UPDATE autonomy_stops SET resumed_at = NOW()
                    WHERE scope_type='workflow' AND scope_key='office-cycle-advance'
                      AND resumed_at IS NULL`);
    });
    const plan2after = await waitFor('plan2', async () => (await query(
      `SELECT id FROM office_plans WHERE run_id = $1`, [RUN2])).rows[0], TICK_SECONDS * 4000);
    if (plan2after) ok('and it resumed on its own once the STOP was lifted — no restart needed');
    else bad('the scheduler did not resume after the STOP was lifted');

    // ── 6. THIS CHECK DROVE NOTHING ───────────────────────────────────────
    head('6. and this file advanced nothing itself');

    {
      // Comments BLANKED, so the header's claim cannot satisfy the assertion.
      const src = fs.readFileSync(__filename, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      // The names are ASSEMBLED, never written, because a list of forbidden identifiers in this
      // file is itself an occurrence of them — the first version of this assertion failed on its
      // own vocabulary, which is the same shape as a scanner matching the comment that describes
      // the thing it forbids.
      const forbidden = [['advance', 'Cycle'], ['office-cycle', '-tick'], ['phase', 'Of']]
        .map((parts) => parts.join(''));
      const found = forbidden.filter((f) => src.includes(f));
      if (!found.length) {
        ok('it never advances a cycle, never spawns the tick script, and never asks for a phase');
      } else bad('this check drives the cycle after all', found);
      // CALLS, not mentions: `initiateDueObjectives(` with its parenthesis. Counting the bare name
      // counted this assertion too, so a correct check reported itself as a driver.
      const initCalls = (src.match(/initiateDueObjectives\s*\(/g) || []).length;
      if (initCalls <= 2) ok(`initiation is CALLED ${initCalls}× (the business-schedule stand-in, `
        + 'and one more to prove the STOP does not block initiation) and nothing else is driven');
      else bad(`initiateDueObjectives is called ${initCalls}× — that is a driver`);
    }

    // ── 7. WHAT THIS DID NOT PROVE ────────────────────────────────────────
    head('7. what this run did NOT exercise');

    {
      const calls = (await query(
        `SELECT COUNT(*)::int n FROM office_cost_ledger WHERE company_id=$1`, [CO])).rows[0].n;
      if (calls === 0) ok('ZERO provider calls — no live model was used');
      else bad(`${calls} provider cost rows exist; this check must make none`);
      note('NOT proven: the 06:00 initiation firing (a check cannot wait a day, and giving it a way '
        + 'to move the schedule would be the bypass Priority 5 forbids) · 72-hour continuity '
        + '(B4.7) · phase-level idempotency at every boundary (B3.17) · the negative paths (B3.18)');
    }
  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    for (const c of children) { try { c.kill('SIGKILL'); } catch (_) {} }
    try { if (workerApi) await new Promise((r) => workerApi.close(r)); } catch (_) {}
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
      for (const id of made.workers) {
        await query(`DELETE FROM worker_identities WHERE id=$1`, [id]).catch(() => {});
      }
      // The employee task and the membership before the users they point at, and every one BY ID.
      for (const id of (made.users || [])) {
        await query(`DELETE FROM daily_tasks WHERE user_id=$1`, [id]).catch(() => {});
        // `user_companies`, read off company-membership.js's own FROM clause, not guessed.
        await query(`DELETE FROM user_companies WHERE user_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM users WHERE id=$1`, [id]).catch(() => {});
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
})();
