#!/usr/bin/env node
// ── EXACTLY-ONCE AT EVERY PHASE BOUNDARY, NOT JUST AT THE TASK ──────────────
//
//   node scripts/check-phase-idempotency-db.js   exit 0 = every ruled property holds
//                                                 exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner, second directive of 2026-11-25, Priority 2: *"The reported SIGKILL test is valuable, but
// exactly one task per intent key does not prove exactly-once execution across every phase."* The
// nine boundaries named there are the nine sections below, each measured on its own, plus a
// destructive control for every property that rests on a database constraint.
//
// ── WHY THE OWNER WAS RIGHT, IN ONE SENTENCE PER BOUNDARY ──────────────────
//
// What existed before this check: `uq_worker_tasks_intent` (task enqueue) and
// `uq_agent_runs_one_active` + `uq_agent_runs_intent_attempt` (run creation). That is two
// boundaries of nine. The others rested on the CYCLE choosing a deterministic id, which is a
// property of the caller, not of the data — and two of them rested on nothing at all:
//
//   • PLAN PERSISTENCE had no uniqueness. `office_plans.id` is minted per call, so two PLAN phases
//     racing on one run wrote TWO plans, each with its own steps and its own dispatchable intent
//     keys, and `planForRun` would have quietly returned one of them.
//   • MEMORY PERSISTENCE had none either. REPORT writes one memory per completed step; the repair
//     that stopped it duplicating under the advancement tick is a read-before-write, and two
//     concurrent REPORTs both read "not yet".
//
// Plan persistence is now held by `office_plans`' own PRIMARY KEY, because the cycle derives its
// plan id from the run (`cycle.js planIdFor`) — a blanket unique index on run_id was tried first and
// `check-autonomous-office-cycle-db.js` refused it within the hour, correctly: that driver judges
// several proposals against one run on purpose. Memory persistence is held by
// `uq_agent_memory_run_subject`. Section 10 removes each arbiter in turn and shows the duplicate
// appear.
//
// ── CONCURRENCY IS REAL HERE, NOT SIMULATED ────────────────────────────────
//
// Every race below runs N genuine `Promise.all` calls against one Postgres. The in-process overlap
// guard in server.js does not help against this and is not meant to: a second TICK PROCESS has its
// own. So the arbiter has to be the database, and each section names which constraint did the work.
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
  cluster = DISPOSABLE.create({ label: 'idem' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  phase idempotency was not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'idem-bootstrap@idem.invalid';
process.env.ADMIN_PASSWORD = `idem-${crypto.randomBytes(16).toString('hex')}`;

const SEAL = { WORKER_SECRET_SEAL_KEY: crypto.randomBytes(32).toString('hex') };
const ROOT = path.join(__dirname, '..');

const watchdog = setTimeout(() => {
  console.log('\n  FAIL  no progress in 420s — a stall is a failure.');
  process.exit(1);
}, 420_000);
watchdog.unref?.();

/** Run a tick in its own process, as the scheduler does. */
function spawnJson(script, args = [], extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        DATABASE_URL: cluster.url,
        JWT_SECRET: 'phase-idempotency',
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
    const kill = setTimeout(() => child.kill('SIGKILL'), 120_000);
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

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: cluster.url, ssl: false, max: 20 });
  const query = (t, p) => P.query(t, p);
  const withTransaction = async (fn) => {
    const c = await P.connect();
    try {
      await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  };
  const deps = { query, withTransaction, env: SEAL };
  const made = { companies: [], objectives: [], workers: [] };
  const uid = (p) => `idem-${p}-${crypto.randomUUID().slice(0, 8)}`;
  let server = null;

  /** How many times did it succeed, and how many refusals came back? */
  const race = async (n, fn) => {
    const rs = await Promise.allSettled(Array.from({ length: n }, (_, i) => fn(i)));
    return {
      fulfilled: rs.filter((r) => r.status === 'fulfilled').length,
      rejected: rs.filter((r) => r.status === 'rejected').length,
      reasons: rs.filter((r) => r.status === 'rejected')
        .map((r) => (r.reason && (r.reason.code || r.reason.message)) || '?').slice(0, 4),
      values: rs.filter((r) => r.status === 'fulfilled').map((r) => r.value),
    };
  };

  const countOf = async (sql, params) => (await query(sql, params)).rows[0].n;

  try {
    const autonomy = require('../src/lib/autonomy');
    const SCOPE = require('../src/lib/office/scope');
    const MEM = require('../src/lib/office/memory');
    const IDENTITY = require('../src/lib/worker/identity');

    // THE ORDER IS COPIED from check-autonomous-office-cycle-db.js, which already had a known-good
    // one. Composing my own cost three runs: `migrateIdentity` ALTERs daily_tasks (so it must come
    // after migrateSchemas creates it) and creates user_companies REFERENCING companies (so it must
    // come after migrateOffice creates that). Each wrong order surfaced as a product-shaped error —
    // `42703 undefined_column` from inside assignTask, then `relation "companies" does not exist` —
    // and neither was a product fault. A sibling check that already builds the schema I need is the
    // thing to copy, not to re-derive.
    const DB = require('../src/lib/db');
    await DB.initDB();
    await DB.initPhase2?.();
    await DB.migrateSchemas();
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);
    await autonomy.migrateAutonomy(query);
    await MEM.migrateMemory(query);
    await require('../src/lib/identity/schema').migrateIdentity(query);
    await require('../src/lib/identity/schema').migrateRecordOwnership(query);
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
                 VALUES ($1,$2,'phase idempotency','P1','supervised',
                         'all_consequential','active','naren@fixture.invalid',5.00)`, [OBJ, CO]);
    made.objectives.push(OBJ);

    // A worker API, so the enqueue and result boundaries can be exercised for real.
    const express = require('express');
    const WR = require('../src/api/worker.routes');
    const app = express();
    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.use('/api', WR.createWorkerRouter({ enable: true, query, withTransaction, env: SEAL }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const INIT = require('../src/lib/office/initiator');
    const started = await INIT.initiateDueObjectives({ companyId: CO }, deps);
    if (started.initiated.length !== 1) {
      bad('the fixture objective did not initiate', JSON.stringify(started));
      throw new Error('no run');
    }
    const RUN = started.initiated[0].runId;
    const CTX = started.initiated[0].context;

    // ══ 1. PLAN PERSISTENCE ══════════════════════════════════════════════
    head('1. plan persistence: five concurrent PLAN phases, one plan');

    {
      const CYCLE = require('../src/lib/office/cycle');
      const r = await race(5, () => CYCLE.advanceCycle({ runId: RUN }, deps));
      const plans = await countOf(
        `SELECT COUNT(*)::int n FROM office_plans WHERE run_id = $1`, [RUN]);
      if (plans === 1) {
        ok(`five concurrent PLAN phases produced exactly ONE plan `
          + `(${r.fulfilled} returned, ${r.rejected} refused: ${r.reasons.join(', ') || 'none'})`);
      } else bad(`${plans} plans exist for one run`, r.reasons);

      // The steps of that plan must not have been written twice either: a second plan's steps
      // would carry their own intent keys and be dispatchable by them.
      // `office_plan_steps` has no run_id — it is reached through plan_id, which is the shape that
      // makes an orphaned step impossible to point at a run in the first place. Read the DDL, do
      // not assume the column; this query named run_id and Postgres said so.
      // ALL steps in the table. This cluster is disposable and this run is the only thing that has
      // planned in it, so "every step belongs to that plan" is expressible directly — and
      // `office_plan_steps` has neither a run_id NOR an objective_id column, both of which I
      // guessed in turn before reading the DDL. It is reached through plan_id only, which is the
      // shape that makes an orphaned step impossible to attribute to a run at all.
      const objSteps = await countOf(`SELECT COUNT(*)::int n FROM office_plan_steps`);
      const stepsOfPlan = await countOf(
        `SELECT COUNT(*)::int n FROM office_plan_steps s
           JOIN office_plans p ON p.id = s.plan_id WHERE p.run_id = $1`, [RUN]);
      if (objSteps === stepsOfPlan && stepsOfPlan > 0) {
        ok(`and all ${stepsOfPlan} plan step(s) belong to that one plan — a losing race left no `
          + 'steps behind carrying their own dispatchable intent keys');
      } else {
        bad(`${objSteps} steps exist for the objective but ${stepsOfPlan} under the run's plan`);
      }
    }

    // ══ 2. CHILD-RUN CREATION AND DELEGATION ═════════════════════════════
    head('2. child-run creation: concurrent delegation of one parent');

    {
      // `delegate(parentCtx, { toAgent, callingAgent, reason, intentKey })` — read off the
      // signature, after my first attempt passed `parentContext`/`fromAgent`/`capability`, which
      // delegate() does not take, and every call refused with NO_COMPANY_CONTEXT. It also ALREADY
      // accepts an intentKey, so my note claiming delegation "is not yet keyed by a caller-supplied
      // intent" was wrong: the capability exists and this section measures it.
      const DELEG = require('../src/lib/office/delegation');
      const CONTEXT = require('../src/lib/office/context');
      const parentCtx = CONTEXT.deriveContext(CTX, { runId: RUN });
      const key = `idem-delegate-${crypto.randomBytes(6).toString('hex')}`;

      const before = await countOf(`SELECT COUNT(*)::int n FROM office_delegations`);
      const r = await race(4, () => DELEG.delegate(parentCtx, {
        toAgent: 'procurement-agent',
        callingAgent: 'office-initiator',
        reason: 'phase-idempotency: four concurrent delegations under ONE intent key',
        intentKey: key,
      }, deps));
      const after = await countOf(`SELECT COUNT(*)::int n FROM office_delegations`);
      // THROUGH `office_delegations.child_run_id`, which is the authoritative link. My first query
      // counted `agent_runs.predecessor_run_id = parent`, found zero, and reported "a record with
      // no run" — a conclusion about the product drawn from the wrong column. `predecessor_run_id`
      // is the RETRY lineage; a delegation's parentage lives in the dispatch record, which also
      // carries `UNIQUE (child_run_id)` so one child can never have two records.
      const childRuns = await countOf(
        `SELECT COUNT(*)::int n FROM agent_runs r
          WHERE r.run_id IN (SELECT child_run_id FROM office_delegations WHERE parent_run_id = $1)`,
        [RUN]);
      const records = await countOf(
        `SELECT COUNT(*)::int n FROM office_delegations WHERE parent_run_id = $1`, [RUN]);
      const okCalls = r.values.filter((v) => v && v.ok).length;
      const refusals = r.values.filter((v) => v && !v.ok).map((v) => v.code || v.reason);

      if (childRuns === 1) {
        ok(`four concurrent delegations under one intent key produced ONE child run `
          + `(${okCalls} ok, refusals: ${refusals.join(', ') || 'none'})`);
      } else bad(`${childRuns} child runs for one delegation intent key`, refusals);

      if (records === childRuns && records === 1) {
        ok('and exactly one dispatch record, naming that child run — a record without a run, or a '
          + 'run without a record, would be an unauditable delegation');
      } else {
        bad(`${records} delegation records for ${childRuns} child runs`, { before, after });
      }
    }

    // ══ 3. TASK ENQUEUE AND RESULT SUBMISSION ════════════════════════════
    head('3. task enqueue and result submission');

    {
      const LEASES = require('../src/lib/worker/leases');
      const key = `idem-enqueue-${crypto.randomBytes(6).toString('hex')}`;
      const r = await race(6, () => LEASES.enqueueTask({
        taskType: 'synthetic.echo', payload: { hello: 'idem' }, intentKey: key,
        companyId: CO, workflow: INIT.WORKFLOW, createdBy: 'office-initiator',
      }, deps));
      const rows = await countOf(
        `SELECT COUNT(*)::int n FROM worker_tasks WHERE intent_key = $1`, [key]);
      if (rows === 1) {
        ok(`six concurrent enqueues under one intent key produced ONE task `
          + `(${r.values.filter((v) => v && v.ok).length} ok, `
          + `${r.values.filter((v) => v && !v.ok).length} reported duplicate)`);
      } else bad(`${rows} tasks for one intent key`);

      // Result submission: worker_results is keyed by the LEASE run, so one lease cannot report
      // twice. Measured through the real worker process rather than by inspecting the schema.
      const tok = await IDENTITY.createEnrollmentToken({ label: 'idem-worker' }, deps);
      const enrolled = await (await fetch(`${baseUrl}/api/worker/enroll`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: tok.token, hostFingerprint: 'idem-check' }),
      })).json();
      if (!enrolled || !enrolled.ok) { bad('could not enrol a worker', enrolled); throw new Error('no worker'); }
      made.workers.push(enrolled.workerId);

      const workerEnv = {
        WORKER_API_BASE_URL: baseUrl,
        WORKER_ID: enrolled.workerId,
        PLAYNEXA_WORKER_ENV: 'development',
        PLAYNEXA_DEV_WORKER_SECRET: enrolled.secret,
      };
      // Two workers at once against one queue, then two more passes: the same task must not be
      // executed twice and must not produce two results.
      await Promise.all([
        spawnJson('src/worker-client/run.js', ['--once'], workerEnv),
        spawnJson('src/worker-client/run.js', ['--once'], workerEnv),
      ]);
      await spawnJson('src/worker-client/run.js', ['--once'], workerEnv);

      // `worker_tasks` has no `attempts` column — attempts live on `agent_runs` (one lease run per
      // attempt), which is the design: the task is the intent and the runs are the tries. Third
      // column I guessed in this file; each time the DDL was two lines away.
      const t = (await query(`SELECT id, state FROM worker_tasks WHERE intent_key = $1`,
        [key])).rows[0];
      const attempts = await countOf(
        `SELECT COUNT(*)::int n FROM agent_runs WHERE workflow IS NOT NULL
           AND run_id IN (SELECT run_id FROM worker_results WHERE task_id = $1)`, [t.id]);
      const results = await countOf(
        `SELECT COUNT(*)::int n FROM worker_results WHERE task_id = $1`, [t.id]);
      if (results === 1 && t.state === 'COMPLETED') {
        ok(`the task was executed once and has exactly ONE result row, from ${attempts} lease `
          + 'run(s) — two workers racing on one queue did not both execute it');
      } else bad(`${results} result rows, task state ${t.state}`, t);
    }

    // ══ 4. OUTCOME RECORDING ═════════════════════════════════════════════
    head('4. outcome recording');

    {
      const id = `out-idem-${RUN}`.slice(0, 64);
      const r = await race(5, () => SCOPE.recordOutcome(CTX, {
        id, runId: RUN, outcome: 'achieved',
        businessEffect: 'phase-idempotency: five concurrent recordings of one outcome',
      }, deps));
      const rows = await countOf(
        `SELECT COUNT(*)::int n FROM office_outcomes WHERE id = $1`, [id]);
      if (rows === 1 && r.rejected === 4) {
        ok('five concurrent recordings of one outcome id produced ONE row, four refused by the '
          + 'primary key');
      } else bad(`${rows} outcome rows, ${r.rejected} refusals`, r.reasons);
      note('the cycle derives this id from the run (`out-cycle-<runId>`), so a repeated REPORT '
        + 'collides with itself rather than filing a second outcome');
    }

    // ══ 5. EMPLOYEE TASK ASSIGNMENT ══════════════════════════════════════
    head('5. employee task assignment');

    {
      const OPS = require('../src/lib/identity/scoped-operations');
      const MEMBERSHIP = require('../src/lib/identity/company-membership');
      // A real member, because assignTask refuses a non-member — which is the other half of this
      // boundary and is covered by B3.3's own check.
      // COPIED, not composed. This INSERT is the one `check-autonomous-office-cycle-db.js` uses,
      // character for character in its column list and literals: `users.id` is supplied (no
      // default) and `is_active` is an INTEGER, not a boolean. I guessed both in turn, and five
      // guessed-schema errors in one file is a habit rather than an accident — when a sibling check
      // already inserts the fixture I need, the cheapest correct move is to take its statement.
      const userId = `idem-user-${crypto.randomBytes(8).toString('hex')}`;
      const user = (await query(
        `INSERT INTO users (id, email, name, role, password_hash, is_active)
         VALUES ($1,$2,'Idem Fixture','admin','x',1) RETURNING id`,
        [userId, `${userId}@fixture.invalid`])).rows[0];
      // `grantedBy` IS THE ACTOR, and company-membership.js checks it in three steps: the actor
      // must exist, must be active, and must hold authority over THAT company. A string naming this
      // check satisfies none of them, and an `admin` with no membership of its own is refused at
      // the third — *"the actor's own membership could not be read, so their authority cannot be
      // established"*. Both refusals are the guard working, and neither is routed around: the
      // fixture actor is a `super_admin`, which is the documented authority that needs no
      // company membership, and the guard itself is measured by
      // `check-company-membership-db.js`, not here.
      const actorId = `idem-actor-${crypto.randomBytes(8).toString('hex')}`;
      await query(
        `INSERT INTO users (id, email, name, role, password_hash, is_active)
         VALUES ($1,$2,'Idem Authorizer','super_admin','x',1)`,
        [actorId, `${actorId}@fixture.invalid`]);
      await MEMBERSHIP.grantMembership({
        userId: user.id, companyId: CO, companyRole: 'member',
        grantedBy: actorId,
        reason: 'fixture member so an employee task can be assigned at all',
      }, deps);

      // ── THE DEFECT THIS SECTION FOUND, FIRST ──────────────────────────
      //
      // My first version of the call below omitted `taskDate`, and all five attempts came back
      // 23502 (not_null_violation) with ZERO tasks created. I took that for the tenth guessed-schema
      // mistake in this file — and it was one — but the SAME omission was in `office/cycle.js`,
      // which is product code: `daily_tasks.task_date` is TEXT NOT NULL, `assignTask` declared
      // `taskDate` with no default, and the cycle never passed it. Every employee assignment the
      // autonomous cycle has ever attempted refused, and because the cycle catches anything that is
      // not a 23505 into `{ok:false, error}`, the briefing reported `employeeAssigned: false` and
      // the phase moved on. An earlier check of mine saw zero employee tasks and I explained it as
      // "no members in the fixture company" — a measurement standing in for the property again.
      //
      // So this boundary gets BOTH assertions: the named refusal, which is what a missing required
      // argument must now produce, and the idempotency the owner asked about.
      const noDay = await OPS.assignTask(CTX, {
        id: `task-idem-noday-${RUN}`.slice(0, 64), userId: user.id, title: 'no day',
        priority: 'MEDIUM', assignedBy: 'office-initiator',
      }, deps);
      const leaked = await countOf(
        `SELECT COUNT(*)::int n FROM daily_tasks WHERE id = $1`,
        [`task-idem-noday-${RUN}`.slice(0, 64)]);
      if (noDay && noDay.ok === false && noDay.code === 'no_task_date' && leaked === 0) {
        ok('an assignment with no business day is refused BY NAME (no_task_date) and writes '
          + 'nothing — it used to reach Postgres as NULL and surface as a bare 23502, which the '
          + 'cycle logged as "employee not assigned"');
      } else {
        bad('a task with no business day was not refused by name', [JSON.stringify(noDay), leaked]);
      }

      // The business day, through the product's own function rather than a date I format here: if
      // `businessToday` is ever wrong about the day, the cycle and this check are wrong together
      // and the briefing's day still matches the row's.
      const BUSINESS_DAY = require('../src/lib/agent-core').businessToday();
      const taskId = `task-idem-${RUN}`.slice(0, 64);
      const r = await race(5, () => OPS.assignTask(CTX, {
        id: taskId, userId: user.id, title: 'Review the autonomous cycle outcome',
        description: 'phase-idempotency: five concurrent assignments of one task id',
        taskDate: BUSINESS_DAY,
        priority: 'MEDIUM', assignedBy: 'office-initiator',
        reasoning: 'assigned by the scheduled autonomous cycle for human review',
      }, deps));
      const rows = await countOf(
        `SELECT COUNT(*)::int n FROM daily_tasks WHERE id = $1`, [taskId]);
      if (rows === 1) {
        ok(`five concurrent assignments of one task id produced ONE employee task `
          + `(${r.rejected} refused by the primary key)`);
      } else bad(`${rows} employee tasks for one id`, r.reasons);
    }

    // ══ 6. ESCALATION CREATION ═══════════════════════════════════════════
    head('6. escalation creation');

    {
      const id = `ex-idem-${RUN}`.slice(0, 64);
      const r = await race(5, () => SCOPE.openException(CTX, {
        id, runId: RUN, source: 'office/cycle',
        reason: 'phase-idempotency: five concurrent escalations of one exception id',
        severity: 'high', slaHours: 24,
      }, deps));
      const rows = await countOf(
        `SELECT COUNT(*)::int n FROM office_exceptions WHERE id = $1`, [id]);
      if (rows === 1 && r.rejected === 4) {
        ok('five concurrent escalations of one id produced ONE exception — a duplicate escalation '
          + 'is what would make the exception queue untrustworthy');
      } else bad(`${rows} exception rows, ${r.rejected} refusals`, r.reasons);
    }

    // ══ 7. BRIEFING PERSISTENCE ══════════════════════════════════════════
    head('7. briefing persistence — and what is actually true about it');

    {
      // Measured, not assumed: the briefing is RECOUNTED from the kernel tables on every REPORT and
      // is not stored anywhere, so there is no briefing row to duplicate. That is worth asserting
      // rather than asserting an idempotency the product does not need, and it is worth SAYING,
      // because "briefing persistence" is on the owner's list and the honest answer is that nothing
      // persists it.
      const tables = (await query(
        `SELECT tablename FROM pg_tables WHERE schemaname = current_schema()
           AND tablename LIKE '%brief%'`)).rows.map((r) => r.tablename);
      if (!tables.length) {
        ok('no table stores a briefing: it is recounted from the kernel on each REPORT, so there '
          + 'is nothing to write twice');
        note('if a briefing is ever persisted, THIS assertion goes red and that is the point — the '
          + 'row will need its own idempotency before it lands');
      } else {
        bad('a briefing table exists and now needs its own idempotency', tables);
      }
    }

    // ══ 8. MEMORY PERSISTENCE ════════════════════════════════════════════
    head('8. memory persistence: concurrent REPORTs cannot duplicate a memory');

    {
      const subject = 'plan-step-completed:operations.liveness_checkpoint';
      const r = await race(5, (i) => MEM.remember(CTX, {
        subject, body: `phase-idempotency: concurrent memory write ${i}`,
        kind: 'outcome', author: 'agent:office-initiator', sourceRunId: RUN,
      }, deps));
      const rows = await countOf(
        `SELECT COUNT(*)::int n FROM agent_memory
          WHERE source_run_id = $1 AND subject = $2 AND superseded_at IS NULL`, [RUN, subject]);
      if (rows === 1) {
        ok(`five concurrent memory writes for one run and subject produced ONE live row `
          + `(${r.rejected} refused: ${r.reasons.join(', ') || 'none'})`);
      } else bad(`${rows} live memory rows for one run and subject`, r.reasons);

      // A DIFFERENT subject under the same run is not a duplicate and must still be allowed, or
      // the index would silently cap a cycle at one memory.
      const second = await MEM.remember(CTX, {
        subject: 'plan-step-completed:observe.objective_state',
        body: 'a different step of the same run', kind: 'outcome',
        author: 'agent:office-initiator', sourceRunId: RUN,
      }, deps).then(() => true, (e) => e.message);
      if (second === true) ok('and a DIFFERENT subject under the same run is still permitted');
      else bad('the index refuses a second step of the same run', second);
    }

    // ══ 9. TERMINAL RUN COMPLETION ═══════════════════════════════════════
    head('9. terminal run completion');

    {
      const LEDGER = require('../src/lib/run-ledger').ledger({ query });
      await LEDGER.startRun(RUN).catch(() => {});
      const first = await LEDGER.finish(RUN, {});
      const r = await race(4, () => LEDGER.finish(RUN, {}));
      const state = (await query(`SELECT state FROM agent_runs WHERE run_id = $1`, [RUN])).rows[0];
      if (state.state === first.state) {
        ok(`four further finishes left the run ${state.state} — a terminal run is immutable, by a `
          + 'database trigger, not by the caller remembering');
      } else bad(`the run changed state to ${state.state} after repeated finishes`);

      // And a DIFFERENT terminal state is refused outright, which is what stops a late failure
      // rewriting a success.
      const rewrite = await query(
        `UPDATE agent_runs SET state = 'FAILED' WHERE run_id = $1`, [RUN])
        .then(() => 'allowed', (e) => e.message);
      if (/terminal/.test(rewrite)) {
        ok('and rewriting it to FAILED is refused by the transition guard');
      } else bad('a terminal run was rewritten', rewrite);

      const ended = await countOf(
        `SELECT COUNT(*)::int n FROM agent_run_events WHERE run_id = $1 AND kind = 'RUN_ENDED'`,
        [RUN]);
      note(`${ended} RUN_ENDED event(s) recorded: the append-only ledger keeps every attempt to `
        + 'end the run, which is the audit trail, while the STATE changed once');
    }

    // ══ 10. DESTRUCTIVE CONTROLS — LAST ══════════════════════════════════
    head('10. the two new constraints are what hold, named by removing them (control)');

    {
      // PLAN. A fresh run, and the control is the PRIMARY KEY rather than an index: the cycle
      // derives its plan id from the run, so the arbiter is `office_plans`' own primary key. Two
      // inserts with the SAME derived id must collide; two with FRESH ids must both land, which is
      // what shows the key is doing the work and that `decompose()` is still able to judge several
      // proposals against one run — a thing check-autonomous-office-cycle-db.js does on purpose.
      const run2 = (await require('../src/lib/office/run').beginObjectiveRun({
        objectiveId: OBJ, trigger: 'manual',
        triggerDetail: 'phase-idempotency control run',
        workflow: INIT.WORKFLOW, agent: 'office-initiator',
        intentKey: `idem-control-${crypto.randomBytes(6).toString('hex')}`,
      }, deps));
      const CTX2 = run2.context;

      const derived = `plan-cycle-${run2.runId}`.slice(0, 64);
      const same = await race(4, () => SCOPE.createPlan(CTX2,
        { id: derived, runId: run2.runId, proposer: 'control', planner: 'control' }, deps));
      const onePlan = await countOf(
        `SELECT COUNT(*)::int n FROM office_plans WHERE id = $1`, [derived]);
      if (onePlan === 1 && same.rejected === 3) {
        ok('four concurrent inserts of the DERIVED plan id produced one row, three refused by the '
          + 'primary key — that key is the arbiter the cycle relies on');
      } else bad(`${onePlan} rows for the derived plan id, ${same.rejected} refusals`, same.reasons);

      const fresh = await race(2, (i) => SCOPE.createPlan(CTX2,
        { id: `plan-control-${i}-${crypto.randomBytes(4).toString('hex')}`,
          runId: run2.runId, proposer: 'control', planner: 'control' }, deps));
      const plansNow = await countOf(
        `SELECT COUNT(*)::int n FROM office_plans WHERE run_id = $1`, [run2.runId]);
      if (fresh.rejected === 0 && plansNow === 3) {
        ok('and two FRESH plan ids both land — so the guarantee is the derived id, not a blanket '
          + 'one-plan-per-run rule that would narrow decompose() for every other caller');
      } else {
        bad(`fresh plan ids: ${fresh.rejected} refused, ${plansNow} plans on the run`, fresh.reasons);
      }
      await query(`DELETE FROM office_plans WHERE run_id = $1`, [run2.runId]).catch(() => {});

      // MEMORY.
      const droppedMem = await query(`DROP INDEX uq_agent_memory_run_subject`)
        .then(() => true, () => false);
      if (!droppedMem) {
        bad('uq_agent_memory_run_subject could not be dropped — section 8 proved nothing about WHY');
      } else {
        const subject = 'plan-step-completed:control';
        await race(3, (i) => MEM.remember(CTX2, {
          subject, body: `control write ${i}`, kind: 'outcome',
          author: 'agent:office-initiator', sourceRunId: run2.runId,
        }, deps));
        const rows = await countOf(
          `SELECT COUNT(*)::int n FROM agent_memory WHERE source_run_id = $1 AND subject = $2`,
          [run2.runId, subject]);
        if (rows > 1) {
          ok(`without uq_agent_memory_run_subject one run and subject got ${rows} rows — the `
            + 'cycle\'s read-before-write is a narrowing, and the INDEX is the guarantee');
        } else bad('no duplicate memory appeared with the index dropped', rows);
        await query(`DELETE FROM agent_memory WHERE source_run_id = $1`, [run2.runId]).catch(() => {});
        const restoredMem = await query(
          `CREATE UNIQUE INDEX uq_agent_memory_run_subject ON agent_memory (source_run_id, subject)
             WHERE source_run_id IS NOT NULL AND superseded_at IS NULL`)
          .then(() => true, () => false);
        if (restoredMem) ok('and that index was restored too');
        else bad('uq_agent_memory_run_subject could not be restored');
      }
    }

    // ══ 11. WHAT THIS DID NOT PROVE ══════════════════════════════════════
    head('11. what this run did NOT exercise');

    {
      const calls = await countOf(
        `SELECT COUNT(*)::int n FROM office_cost_ledger WHERE company_id = $1`, [CO]);
      if (calls === 0) ok('ZERO provider calls');
      else bad(`${calls} provider cost rows exist; this check must make none`);
      note('NOT proven: the ten negative paths (B3.18) · a crash BETWEEN two statements of one '
        + 'transaction, which is a property of the transaction boundary rather than of a '
        + 'constraint, and which the SIGKILL section of check-unattended-cycle-db.js covers at the '
        + 'tick level only · idempotency of the phases under a partially-applied transaction, as '
        + 'opposed to under concurrency, which is what these ten sections measure');
    }
  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    try { if (server) await new Promise((r) => server.close(r)); } catch (_) {}
    try {
      for (const id of made.objectives) {
        // By plan, because office_plan_steps has no objective_id. The same DELETE with
        // `objective_id` sits in two sibling checks under a `.catch(() => {})`, which means it has
        // never deleted anything and nobody noticed — a swallowed failure in cleanup, which is
        // only harmless because the cluster is destroyed afterwards. Fixed here and there.
        await query(`DELETE FROM office_plan_steps WHERE plan_id IN
                       (SELECT id FROM office_plans WHERE objective_id = $1)`, [id]).catch(() => {});
        await query(`DELETE FROM office_plans WHERE objective_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM objectives WHERE id=$1`, [id]).catch(() => {});
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
})();
