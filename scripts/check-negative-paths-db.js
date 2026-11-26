#!/usr/bin/env node
// ── THE TEN NEGATIVE PATHS OF THE UNATTENDED CYCLE ──────────────────────────
//
//   node scripts/check-negative-paths-db.js    exit 0 = every failure is handled truthfully
//                                              exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner, second directive of 2026-11-25, Priority 3: *"Complete negative-path execution … Every
// failure must produce a truthful durable state, bounded recovery or a visible escalation. No silent
// catch blocks, indefinite phase loops or falsely completed objectives. Revalidate authorization at
// sensitive phase boundaries."*
//
// Ten paths were named. Each is a section below, and each section asserts THREE things rather than
// one, because "it did not crash" is not the requirement:
//
//   1. the EFFECT did not happen       — nothing was dispatched, assigned, remembered or completed
//   2. the STATE is truthful           — the run is not SUCCEEDED, and says why
//   3. it is BOUNDED or VISIBLE        — it stops re-trying, or an exception exists for a human
//
// ── WHAT THIS CHECK FOUND, BEFORE IT PASSED ────────────────────────────────
//
// Four defects, all of the same shape: a correct refusal with no durable consequence, repeating for
// ever.
//
//   • A PAUSED OBJECTIVE could not resolve a context, so `advanceCycle` returned
//     `{ok:false, reason:'no resolvable company context'}` — nothing written, run still live, and
//     the scheduler re-refused it every 45 seconds indefinitely.
//   • A REVOKED COMPANY was never re-read at all. `bootstrapObjectiveForContext` does not select
//     the company's status; the initiator reads it once when it decides what to START. So a company
//     whose authorization was withdrawn mid-flight kept having work enqueued, an employee task
//     assigned and memory written under its name.
//   • A REFUSED PLAN said in its own comment *"a refused plan is terminal for this run"* and then
//     left the run RUNNING, so `phaseOf` derived REFUSED again on every tick, for ever.
//   • A PARTIAL OUTCOME ended the run SUCCEEDED. `finish({})` derives the terminal state from
//     EVENTS, and an outcome row is not an event — so an invalid worker result produced an open
//     exception and a SUCCEEDED run at the same time. A falsely completed objective, which is the
//     first thing the owner's Priority 3 forbids.
//
// ── THE ONE SEAM, AND WHY IT IS SAFE ───────────────────────────────────────
//
// `agent_runs.created_at` is immutable — the transition guard raises if an UPDATE changes it — so a
// run cannot be aged by SQL and the grace window is the only adjustable end of the comparison. The
// cycle therefore accepts `deps.graceMinutes`. Unlike B3.20's `--business-day`, this seam is
// fail-SAFE in the only direction it moves: a shorter window makes the cycle escalate and stop
// SOONER. It cannot authorize a phase. The production cron passes none.
//
// NO URL OVERRIDE: its own disposable cluster; every fixture created by id and removed by id.

'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');

const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail++;
  console.log(`  FAIL  ${m}`);
  if (extra !== undefined) {
    console.log(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
  }
};
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n── ${m} ──\n`);

const DISPOSABLE = require('./lib/pg-disposable');
let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'neg' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  the negative paths were not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'neg-bootstrap@neg.invalid';
process.env.ADMIN_PASSWORD = `neg-${crypto.randomBytes(16).toString('hex')}`;

const SEAL = { WORKER_SECRET_SEAL_KEY: crypto.randomBytes(32).toString('hex') };

const watchdog = setTimeout(() => {
  console.log('\n  FAIL  no progress in 420s — a stall is a failure, not a slow pass.');
  process.exit(1);
}, 420_000);
watchdog.unref?.();

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: cluster.url, ssl: false, max: 12 });
  const query = (t, p) => P.query(t, p);
  const withTransaction = async (fn) => {
    const c = await P.connect();
    try {
      await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  };
  const deps = { query, withTransaction, env: SEAL };

  /**
   * The same deps with ONE kind of statement failing, which is what a partial database outage looks
   * like from inside a module: not "the database is gone" but "this read did not come back".
   */
  const brokenOn = (re, code = '57P01') => ({
    ...deps,
    query: (t, p) => (re.test(String(t))
      ? Promise.reject(Object.assign(new Error('simulated database outage'), { code }))
      : query(t, p)),
  });

  const made = { companies: [], objectives: [], workers: [], users: [] };
  const uid = (p) => `neg-${p}-${crypto.randomUUID().slice(0, 8)}`;
  const countOf = async (sql, params) => (await query(sql, params)).rows[0].n;

  let server = null;

  try {
    const autonomy = require('../src/lib/autonomy');
    const IDENTITY = require('../src/lib/worker/identity');
    const MEM = require('../src/lib/office/memory');

    // The migration order is COPIED from check-phase-idempotency-db.js, which copied it from
    // check-autonomous-office-cycle-db.js. Composing it from scratch cost three runs there and the
    // failures all looked like product faults; a known-good order is a thing to reuse.
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

    const CYCLE = require('../src/lib/office/cycle');
    const GUARD = require('../src/lib/office/phase-guard');
    const INIT = require('../src/lib/office/initiator');
    const LEASES = require('../src/lib/worker/leases');

    // A worker API, so the dispatch and result paths are the real ones.
    const express = require('express');
    const WR = require('../src/api/worker.routes');
    const app = express();
    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.use('/api', WR.createWorkerRouter({ enable: true, query, withTransaction, env: SEAL }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    /** One company per scenario, so a withdrawn authorization cannot leak into another section. */
    const newCompany = async (label) => {
      const id = uid(label);
      await query(`INSERT INTO companies (id, slug, display_name, status)
                   VALUES ($1,$1,$1,'active')`, [id]);
      made.companies.push(id);
      return id;
    };

    /** An objective, and the run a REAL scheduled initiation starts for it. */
    const newRun = async (companyId, label, { budget = 5.00 } = {}) => {
      const objId = uid(label);
      await query(`INSERT INTO objectives
                     (id, company_id, objective, priority, autonomy_tier, approval_policy, status,
                      created_by, budget_usd)
                   VALUES ($1,$2,$3,'P1','supervised','all_consequential','active',
                           'naren@fixture.invalid',$4)`,
        [objId, companyId, `negative path: ${label}`, budget]);
      made.objectives.push(objId);
      const started = await INIT.initiateDueObjectives({ companyId }, deps);
      const mine = (started.initiated || []).find((x) => x.objectiveId === objId);
      if (!mine) throw new Error(`${label}: initiation started no run (${JSON.stringify(started)})`);
      return { objId, runId: mine.runId, ctx: mine.context };
    };

    const exceptionsFor = async (runId, prefix) => countOf(
      `SELECT COUNT(*)::int n FROM office_exceptions WHERE run_id = $1::uuid AND id LIKE $2`,
      [runId, `${prefix}%`]);
    const runStateOf = async (runId) => (await query(
      `SELECT state FROM agent_runs WHERE run_id = $1`, [runId])).rows[0].state;

    /**
     * The task this company's run dispatched. Claims are made BY ID for the same reason every
     * cleanup in this repository deletes by id: there is ONE queue, `claimTask({workerId})` takes
     * the oldest PENDING task in it, and the first version of section 2 claimed and completed
     * section 1's task — whose whole assertion is that it stays PENDING. The failure read as "an
     * invalid result was accepted"; it was my harness acting on the wrong row.
     */
    const taskOf = async (companyId) => (await query(
      `SELECT id, intent_key, state FROM worker_tasks WHERE company_id = $1`,
      [companyId])).rows[0];

    /** A worker identity, enrolled through the real HTTP enrolment path. */
    const enrolWorker = async (label) => {
      const tok = await IDENTITY.createEnrollmentToken({ label }, deps);
      const r = await (await fetch(`${baseUrl}/api/worker/enroll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: tok.token, hostFingerprint: 'neg-check' }),
      })).json();
      if (!r || !r.ok) throw new Error(`could not enrol ${label}: ${JSON.stringify(r)}`);
      made.workers.push(r.workerId);
      return r.workerId;      // the secret is deliberately not kept: nothing here needs it
    };

    // ══ 1. WORKER UNAVAILABLE ════════════════════════════════════════════
    head('1. worker unavailable: the wait is bounded and becomes visible');

    {
      const CO = await newCompany('co-wait');
      const { runId } = await newRun(CO, 'worker-unavailable');
      await CYCLE.advanceCycle({ runId }, deps);                       // PLAN
      const dispatched = await CYCLE.advanceCycle({ runId }, deps);    // DISPATCH
      if (dispatched.phase === 'dispatch' && dispatched.enqueued.length > 0) {
        ok(`the step was enqueued (${dispatched.enqueued.length}) — with no worker in the cluster `
          + 'at all, which is stronger than a worker being offline');
      } else bad('dispatch did not enqueue', dispatched);

      // No worker ever runs. Inside the window, the right behaviour is to wait quietly.
      const waiting = await CYCLE.advanceCycle({ runId }, deps);
      const quiet = await exceptionsFor(runId, 'ex-wait-');
      if (waiting.phase === 'collect' && waiting.waitingTooLong === false && quiet === 0) {
        ok('inside the grace window it waits and escalates nothing — a worker arriving two minutes '
          + 'later is normal operation, not an incident');
      } else bad('a fresh wait was treated as a failure', { waiting, quiet });

      // Past the window, ONE escalation — and the run is deliberately left alive.
      const late = await CYCLE.advanceCycle({ runId }, { ...deps, graceMinutes: 0 });
      const again = await CYCLE.advanceCycle({ runId }, { ...deps, graceMinutes: 0 });
      const exs = await exceptionsFor(runId, 'ex-wait-');
      const state = await runStateOf(runId);
      const task = (await query(
        `SELECT state FROM worker_tasks WHERE company_id = $1`, [CO])).rows[0];
      if (late.waitingTooLong && late.escalated && exs === 1 && again.escalated !== false) {
        ok(`past the window it raises exactly ONE visible escalation (${exs}), and a second tick `
          + 'adds none — the derived exception id is the arbiter');
      } else bad('the bounded wait did not escalate exactly once', { late, again, exs });

      if (state === 'RUNNING' && task && task.state === 'PENDING') {
        ok('the run is NOT killed and the task stays PENDING — the work is durably enqueued and a '
          + 'worker coming online later will still execute it, so ending the run would discard it');
      } else bad('a waiting run was ended or its task was lost', { state, task });
    }

    // ══ 2. INVALID WORKER RESULT ═════════════════════════════════════════
    head('2. invalid worker result: a partial outcome cannot end as a success');

    {
      const CO = await newCompany('co-invalid');
      const { runId } = await newRun(CO, 'invalid-result');
      await CYCLE.advanceCycle({ runId }, deps);                    // PLAN
      await CYCLE.advanceCycle({ runId }, deps);                    // DISPATCH

      // A real lease, a real submission — and output that has nothing to do with what was planned.
      const workerId = await enrolWorker('neg-invalid');
      const mine = await taskOf(CO);
      const claim = await LEASES.claimTask({ workerId, taskId: mine.id }, deps);
      const submitted = await LEASES.submitResult({
        workerId, runId: claim.runId, status: 'SUCCEEDED',
        output: { unrelated: 'this is not what the plan asked for' },
      }, deps);
      if (claim.ok && submitted.ok) {
        ok('a worker reported SUCCEEDED with output unrelated to the plan — the handler is happy '
          + 'with its own contract, which is exactly the case independent validation exists for');
      } else bad('could not stage an invalid result', { claim, submitted });

      const validated = await CYCLE.advanceCycle({ runId }, deps);   // VALIDATE
      const outcome = (await query(
        `SELECT outcome FROM office_outcomes WHERE run_id = $1::uuid`, [runId])).rows[0];
      const cycleEx = await exceptionsFor(runId, 'ex-cycle-');
      if (outcome && outcome.outcome === 'partial' && cycleEx === 1
        && validated.verdicts.every((v) => v.independentlyValidated === false)) {
        ok('independent validation refused it: the outcome is recorded `partial` and ONE exception '
          + 'is open — the handler\'s own verdict did not decide this');
      } else bad('an invalid result was accepted', { outcome, cycleEx, validated });

      const reported = await CYCLE.advanceCycle({ runId }, deps);    // REPORT
      const state = await runStateOf(runId);
      const reportEx = await exceptionsFor(runId, 'ex-report-');
      if (state !== 'SUCCEEDED' && reported.reportFailures.some((f) => /not 'achieved'/.test(f))) {
        ok(`the run ended ${state}, not SUCCEEDED, and says why — this is the defect the section `
          + 'found: `finish({})` derives the state from EVENTS, and an outcome row is not an event');
      } else bad('a partial objective completed as a success', { state, reported });

      if (reportEx === 0) {
        ok('and it did NOT open a second exception for the same problem — VALIDATE already '
          + 'escalated it, and two alarms for one fault is how a queue becomes noise');
      } else bad('the same failure was escalated twice', { reportEx });
    }

    // ══ 3. RETRYABLE FAILURE ═════════════════════════════════════════════
    head('3. retryable failure: escalated once, never silently re-dispatched');

    {
      const CO = await newCompany('co-failed');
      const { runId } = await newRun(CO, 'retryable-failure');
      await CYCLE.advanceCycle({ runId }, deps);
      const disp = await CYCLE.advanceCycle({ runId }, deps);
      const intentKey = (await query(
        `SELECT intent_key FROM worker_tasks WHERE company_id = $1`, [CO])).rows[0].intent_key;

      const workerId = await enrolWorker('neg-failed');
      const claim = await LEASES.claimTask({ workerId, taskId: (await taskOf(CO)).id }, deps);
      await LEASES.submitResult({
        workerId, runId: claim.runId, status: 'FAILED',
        output: { error: 'simulated retryable failure' },
      }, deps);

      await CYCLE.advanceCycle({ runId }, deps);     // VALIDATE
      const after = await CYCLE.advanceCycle({ runId }, deps);     // REPORT
      const tasks = await countOf(
        `SELECT COUNT(*)::int n FROM worker_tasks WHERE intent_key = $1`, [intentKey]);
      const results = await countOf(
        `SELECT COUNT(*)::int n FROM worker_results WHERE task_id IN
           (SELECT id FROM worker_tasks WHERE intent_key = $1)`, [intentKey]);
      const state = await runStateOf(runId);
      const exs = await exceptionsFor(runId, 'ex-cycle-');
      if (tasks === 1 && results === 1 && exs === 1 && state !== 'SUCCEEDED') {
        ok(`one task, one result, one escalation, run ${state} — the cycle does NOT retry, and `
          + 'that is the design: re-executing work whose outcome is already recorded is a decision '
          + 'with consequences, so it belongs to the governed retry path and not to a scheduler');
      } else bad('a failed step was re-dispatched or quietly completed',
        { tasks, results, exs, state, disp: disp.enqueued.length });

      // And the governed path is not a formality: a re-attempt has to satisfy two separate gates.
      // `eligible`, not `ok` — read off leases.js's own return shape. My first version asserted on
      // `.ok`, which is `undefined` on both answers, so the assertion compared undefined to false
      // and reported that a re-attempt needed nothing while the refusal was working perfectly.
      const elig = LEASES.reattemptEligibility('synthetic.echo', {});
      const eligWithReason = LEASES.reattemptEligibility('synthetic.echo', {
        overrideReason: 'a human has reviewed the failure and accepts the ambiguity',
      });
      if (elig.eligible === false && eligWithReason.eligible === true) {
        ok(`a re-attempt without a recorded human override is refused by name `
          + `(${elig.code}), and WITH one it is still not something this cycle may do: the answer `
          + 'is "create the attempt through recovery.retryRun()", which owns the enforcement');
      } else bad('a re-attempt needed nothing', { elig, eligWithReason });
    }

    // ══ 4. RETRY EXHAUSTION ══════════════════════════════════════════════
    head('4. retry exhaustion: the cap and the lineage rules are the database\'s, not a flag\'s');

    {
      const PIPE = require('../src/lib/m76/pipeline');
      // `proposal.draft_once` is the type that declares `reexecutable: false` — task-types.js says
      // in its own comment that it exists so this rule has a fixture. I first asked about
      // `report.daily_operations`, which IS re-executable, so the assertion measured nothing and
      // said so: a fixture that takes the wrong branch tests the wrong branch.
      const notRe = await PIPE.mayRetry({ taskType: 'proposal.draft_once', intentKey: 'x' },
        deps).catch((e) => ({ ok: false, reason: 'threw', detail: e.message }));
      if (notRe.ok === false) {
        ok(`a type that does not declare itself re-executable is refused by name `
          + `(${notRe.reason}) — the cap is not the only bound, and this one is a fact about the `
          + 'work rather than about how many times it has been tried');
      } else bad('a non-reexecutable type was retryable', notRe);

      // The lineage rules live in trg_agent_runs_retry_guard, so they hold whatever the caller
      // believes. Measured by asking the database directly for an impossible attempt.
      const CO = await newCompany('co-retry');
      const { runId } = await newRun(CO, 'retry-lineage');
      const intent = (await query(`SELECT intent_key FROM agent_runs WHERE run_id = $1`,
        [runId])).rows[0].intent_key;
      let refused = null;
      try {
        await query(
          `INSERT INTO agent_runs (run_id, workflow, trigger, state, intent_key, attempt,
                                   predecessor_run_id, company_id, objective_id)
           SELECT gen_random_uuid(), workflow, trigger, 'CREATED', $2, 3, $1, company_id,
                  objective_id
             FROM agent_runs WHERE run_id = $1`,
          [runId, intent]);
      } catch (e) { refused = e.message; }
      if (refused && /attempt must be predecessor attempt \+ 1|may not be retried/.test(refused)) {
        ok(`the database refused attempt 3 of a live attempt 1: "${refused.split('\n')[0]
          .slice(0, 90)}" — a retry chain cannot be forged by a caller that has lost count`);
      } else bad('an impossible retry attempt was accepted', refused);

      note('MAX_ATTEMPTS itself is enforced in m76/pipeline.mayRetry and measured by the M7.6 '
        + 'acceptance drivers; what this section establishes is that the office cycle reaches '
        + 'neither of those by accident, because it never retries at all');
    }

    // ══ 5. REVOKED COMPANY AUTHORIZATION ═════════════════════════════════
    head('5. revoked company authorization, mid-execution');

    {
      const CO = await newCompany('co-revoked');
      const { runId } = await newRun(CO, 'revoked-company');
      await CYCLE.advanceCycle({ runId }, deps);        // PLAN, while still authorized

      // The withdrawal happens BETWEEN phases, which is the whole point: nothing re-read this.
      await query(`UPDATE companies SET status = 'suspended' WHERE id = $1`, [CO]);

      const refusedTick = await CYCLE.advanceCycle({ runId }, deps);
      const tasks = await countOf(
        `SELECT COUNT(*)::int n FROM worker_tasks WHERE company_id = $1`, [CO]);
      if (refusedTick.ok === false
        && refusedTick.refusal.code === GUARD.CODES.COMPANY_NOT_ACTIVE && tasks === 0) {
        ok('the DISPATCH boundary refused by name (company_authorization_withdrawn) and enqueued '
          + 'NOTHING — before B3.18 the company status was never read again after initiation');
      } else bad('a suspended company was still acted for', { refusedTick, tasks });

      if (refusedTick.withinGrace === true && await exceptionsFor(runId, 'ex-guard-') === 0) {
        ok('inside the window it declines quietly: a suspension reversed in the next minute is '
          + 'bounded recovery, not an incident to file');
      } else bad('the first refusal escalated immediately', refusedTick);

      const late = await CYCLE.advanceCycle({ runId }, { ...deps, graceMinutes: 0 });
      const exs = await exceptionsFor(runId, 'ex-guard-');
      const state = await runStateOf(runId);
      if (late.escalated && exs === 1 && state === 'FAILED' && late.terminal === 'FAILED') {
        ok('past the window: ONE escalation and the run ends FAILED — explicitly, because '
          + '`finish({})` would have derived SUCCEEDED from a run that had simply stopped failing');
      } else bad('a withdrawn authorization left the run live or completed it', { late, exs, state });

      const after = await CYCLE.advanceCycle({ runId }, { ...deps, graceMinutes: 0 });
      const exsAfter = await exceptionsFor(runId, 'ex-guard-');
      if (after.phase === 'done' && exsAfter === 1) {
        ok('and the next tick reads DONE and does nothing — the indefinite refusal loop is closed, '
          + 'which is what made this a defect rather than a missing feature');
      } else bad('the run was still being processed after it ended', { after, exsAfter });
    }

    // ══ 6. OBJECTIVE PAUSED DURING EXECUTION ═════════════════════════════
    head('6. objective paused between phases');

    {
      const CO = await newCompany('co-paused');
      const { objId, runId } = await newRun(CO, 'paused-objective');
      await CYCLE.advanceCycle({ runId }, deps);        // PLAN, while active
      await query(`UPDATE objectives SET status = 'paused' WHERE id = $1`, [objId]);

      const tick = await CYCLE.advanceCycle({ runId }, deps);
      if (tick.ok === false && tick.refusal
        && tick.refusal.code === GUARD.CODES.OBJECTIVE_NOT_ACTIVE) {
        ok('refused by name (objective_not_active) through the run-scoped diagnostic context — '
          + 'the objective context cannot be built for a paused objective, and before B3.18 that '
          + 'returned "no resolvable company context" with nothing durable and no end');
      } else bad('a paused objective was not refused by name', tick);

      const resumed = await query(`UPDATE objectives SET status = 'active' WHERE id = $1`, [objId]);
      void resumed;
      const back = await CYCLE.advanceCycle({ runId }, deps);
      if (back.ok === true && back.phase === 'dispatch') {
        ok('and un-pausing it resumes the SAME run with no restart — the bounded recovery is real, '
          + 'not a description of one');
      } else bad('a resumed objective did not continue', back);

      // Paused again, and this time left past the window.
      await query(`UPDATE objectives SET status = 'paused' WHERE id = $1`, [objId]);
      const late = await CYCLE.advanceCycle({ runId }, { ...deps, graceMinutes: 0 });
      const exs = await exceptionsFor(runId, 'ex-guard-');
      const state = await runStateOf(runId);
      if (late.escalated && exs === 1 && state === 'FAILED') {
        ok('left paused past the window it escalates once and ends FAILED, so the live set does '
          + 'not fill up with runs nobody is going to re-authorize');
      } else bad('a long-paused objective kept its run alive for ever', { late, exs, state });
    }

    // ══ 7. STOP ACTIVATED BETWEEN PHASES ═════════════════════════════════
    head('7. STOP activated between phases: halted, not killed');

    {
      const CO = await newCompany('co-stop');
      const { runId } = await newRun(CO, 'stop-between-phases');
      await CYCLE.advanceCycle({ runId }, deps);        // PLAN

      // `{ scope_type, scope_key }`, snake_case, and deps goes in the SECOND argument's `deps`
      // key — read off autonomy.js's signature, not guessed. A camelCase call returns
      // `{ok:false}`, sets no stop, and every assertion below would then measure an unstopped
      // cycle while reporting that a STOP had been ignored. That exact mistake is in this
      // repository's recorded defect list, and the next line is why it is checked.
      const stopped = await autonomy.stop({
        scope_type: 'company', scope_key: CO,
        reason: 'negative-path check: a company-scoped halt activated between phases',
        actor: 'neg-check',
      }, { deps });
      if (!stopped || stopped.ok === false) {
        bad('the fixture STOP was not set — the assertions below would measure nothing', stopped);
      }
      autonomy.resetForTests && autonomy.resetForTests();

      const tick = await CYCLE.advanceCycle({ runId }, deps);
      const tasks = await countOf(
        `SELECT COUNT(*)::int n FROM worker_tasks WHERE company_id = $1`, [CO]);
      if (tick.stopped === true && tick.refusal.code === GUARD.CODES.STOPPED && tasks === 0) {
        ok('the phase boundary refused by name and dispatched nothing');
      } else bad('a STOP did not halt the phase', { tick, tasks });

      // THE ASSERTION THAT KEEPS A STOP REVERSIBLE. A stop is an operator's deliberate halt, and
      // B3.16 showed a stopped cycle resuming with no restart. Bounding it into a kill would
      // destroy exactly the work the operator intends to resume, so the grace window must NOT
      // apply to it — asserted with grace 0, where every other refusal in this file would end the
      // run.
      const late = await CYCLE.advanceCycle({ runId }, { ...deps, graceMinutes: 0 });
      const exs = await exceptionsFor(runId, 'ex-guard-');
      const state = await runStateOf(runId);
      if (late.stopped === true && exs === 0 && state !== 'FAILED' && !late.terminal) {
        ok('and it is NEVER bounded into a terminal state: with the window at zero the run is '
          + `still ${state}, with no exception filed — an operator using the kill switch is not an `
          + 'incident, and a stop may legitimately last for days');
      } else bad('a STOP was escalated or killed the run', { late, exs, state });

      await autonomy.resume({ scope_type: 'company', scope_key: CO, actor: 'neg-check',
        reason: 'negative-path check: the halt is lifted' }, { deps });
      autonomy.resetForTests && autonomy.resetForTests();
      const back = await CYCLE.advanceCycle({ runId }, deps);
      if (back.ok === true && back.phase === 'dispatch' && back.enqueued.length > 0) {
        ok('lifting it resumes the same run and the work is dispatched — no restart, no new run, '
          + 'no lost plan');
      } else bad('a resumed cycle did not continue', back);
    }

    // ══ 8. INSUFFICIENT BUDGET ═══════════════════════════════════════════
    head('8. insufficient budget: a refused plan is an ANSWER, so the run ends');

    {
      const CO = await newCompany('co-budget');
      // $0 is not unlimited (B2.5a), and a plan is a consequential act the budget gate judges.
      const { runId } = await newRun(CO, 'insufficient-budget', { budget: 0.00 });
      const planned = await CYCLE.advanceCycle({ runId }, deps);
      const plan = (await query(
        `SELECT verdict, refusal_code FROM office_plans WHERE run_id = $1::uuid`, [runId])).rows[0];

      if (planned.ok === false && plan && plan.verdict && !plan.verdict.startsWith('validated')) {
        ok(`the plan was refused and the refusal is DURABLE: verdict ${plan.verdict}`
          + `${plan.refusal_code ? `, code ${plan.refusal_code}` : ''} — recorded rather than `
          + 'returned, so a reader learns why nothing happened');
      } else bad('a zero-budget objective produced an authorized plan', { planned, plan });

      const refusedTick = await CYCLE.advanceCycle({ runId }, deps);
      const exs = await exceptionsFor(runId, 'ex-refused-');
      const state = await runStateOf(runId);
      if (refusedTick.phase === 'refused' && exs === 1 && state === 'FAILED') {
        ok('and the REFUSED phase now ends the run FAILED with ONE escalation — it used to say in '
          + 'its own comment that a refused plan is terminal and then leave the run RUNNING, so '
          + 'phaseOf derived REFUSED again on every tick, for ever');
      } else bad('a refused plan left the run spinning', { refusedTick, exs, state });

      const after = await CYCLE.advanceCycle({ runId }, deps);
      if (after.phase === 'done' && await exceptionsFor(runId, 'ex-refused-') === 1) {
        ok('the tick after that reads DONE and files nothing further');
      } else bad('the refused run kept being processed', after);
    }

    // ══ 9. DATABASE TEMPORARILY UNAVAILABLE ══════════════════════════════
    head('9. database temporarily unavailable: unreadable is not "carry on"');

    {
      const CO = await newCompany('co-outage');
      const { runId } = await newRun(CO, 'database-outage');
      await CYCLE.advanceCycle({ runId }, deps);     // PLAN, with a healthy database

      // The ONE read that decides whether the run is already finished.
      const blind = await CYCLE.advanceCycle({ runId },
        brokenOn(/FROM agent_runs WHERE company_id/));
      const tasks = await countOf(
        `SELECT COUNT(*)::int n FROM worker_tasks WHERE company_id = $1`, [CO]);
      if (blind.phase === 'unknown' && blind.ok === false && tasks === 0) {
        ok('an unreadable run state is its OWN phase: the tick does nothing and says why. It used '
          + 'to be `.catch(() => null)`, which is the same value as "no row yet" — so a blip on '
          + 'this read made a TERMINAL run look live and REPORT ran again against a finished '
          + 'objective, re-assigning work and re-writing memory');
      } else bad('an unreadable state was treated as a live run', { blind, tasks });

      // The same tick, healthy: the refusal above must not be something that always happens.
      const healthy = await CYCLE.advanceCycle({ runId }, deps);
      if (healthy.ok === true && healthy.phase === 'dispatch') {
        ok('and with the read working, the very same tick dispatches — the refusal is the outage, '
          + 'not the check');
      } else bad('the control tick did not proceed', healthy);

      // An unreadable AUTHORIZATION fails closed too, and says which read failed.
      const unreadable = await CYCLE.advanceCycle({ runId }, brokenOn(/FROM companies WHERE id/));
      if (unreadable.ok === false
        && unreadable.refusal.code === GUARD.CODES.COMPANY_UNREADABLE) {
        ok('an unreadable company authorization refuses by name — an outage is not an '
          + 'authorization, which is the same rule assignTask applies to membership');
      } else bad('an unreadable authorization was treated as permission', unreadable);
    }

    // ══ 10. REPORTING OR MEMORY PERSISTENCE FAILURE ══════════════════════
    head('10. reporting and memory persistence failure');

    {
      const CO = await newCompany('co-report');
      const { runId } = await newRun(CO, 'memory-failure');
      await CYCLE.advanceCycle({ runId }, deps);     // PLAN
      await CYCLE.advanceCycle({ runId }, deps);     // DISPATCH

      const workerId = await enrolWorker('neg-report');
      const claim = await LEASES.claimTask({ workerId, taskId: (await taskOf(CO)).id }, deps);
      const planned = (await query(
        `SELECT payload FROM office_plan_steps WHERE plan_id = $1`,
        [`plan-cycle-${runId}`.slice(0, 64)])).rows[0];
      await LEASES.submitResult({
        workerId, runId: claim.runId, status: 'SUCCEEDED',
        output: { echo: (planned.payload || {}).echo, ok: true },
      }, deps);
      const validated = await CYCLE.advanceCycle({ runId }, deps);    // VALIDATE

      // REPORT, with the memory write failing and nothing else.
      const reported = await CYCLE.advanceCycle({ runId },
        brokenOn(/INSERT INTO agent_memory/));
      const memories = await countOf(
        `SELECT COUNT(*)::int n FROM agent_memory WHERE source_run_id = $1`, [runId]);
      const exs = await exceptionsFor(runId, 'ex-report-');
      const state = await runStateOf(runId);

      if (reported.memoryErrors.length > 0 && memories === 0) {
        ok(`${reported.memoryErrors.length} memory write(s) failed and are REPORTED, not swallowed`);
      } else bad('a memory persistence failure was invisible', { reported, memories });

      if (exs === 1 && state !== 'SUCCEEDED') {
        ok(`one visible escalation and the run ended ${state} — a run whose continuity record `
          + 'never persisted must not claim success, or the next cycle plans as though nothing '
          + 'happened while the dashboard says the objective completed');
      } else bad('a failed report completed the objective', { exs, state, reported });

      if (reported.briefing.employeeAssigned === true && validated.ok === true) {
        ok('and what DID persist is still reported truthfully: the employee task was assigned, so '
          + 'the briefing says so — a failure in one effect does not make the others disappear');
      } else {
        note(`briefing employeeAssigned=${reported.briefing.employeeAssigned} — no company member `
          + 'exists in this fixture, so there was nobody to assign to (a measured zero)');
      }
    }

    // ══ 11. WHAT HOLDS, AND WHAT THIS DID NOT TOUCH ══════════════════════
    head('11. the boundary itself, and what is not covered');

    {
      const calls = await countOf('SELECT COUNT(*)::int n FROM office_cost_ledger', []);
      if (calls === 0) ok('ZERO provider calls — no live model was used by any negative path');
      else bad(`${calls} provider cost rows exist; this check must make none`);

      // The guard is asked at EVERY non-terminal phase, which is a property of the code and is
      // asserted as one: a future phase added without the guard would not be caught by any of the
      // ten scenarios above, because each one only visits the phase it needs.
      const src = require('node:fs').readFileSync(
        path.join(__dirname, '..', 'src', 'lib', 'office', 'cycle.js'), 'utf8');
      const guarded = /phase !== PHASE\.DONE && phase !== PHASE\.REFUSED[\s\S]{0,400}?GUARD\.revalidate/
        .test(src);
      if (guarded) {
        ok('the revalidation is a single gate before the phase switch, not a call repeated in each '
          + 'case — so a phase added later inherits it instead of needing to remember it');
      } else bad('the guard is not a single gate before the switch');

      note('NOT covered here: a crash BETWEEN two statements of one transaction (the SIGKILL '
        + 'section of check-unattended-cycle-db.js covers it at the tick level) · the ten paths '
        + 'under the REAL running scheduler rather than under direct ticks, which B4.7 will '
        + 'exercise over 72 hours · an objective whose company is DELETED rather than suspended, '
        + 'which the foreign keys refuse before this guard is reached');
      note('every fixture here was created by id and is removed by id below; rows held by '
        + 'append-only audit tables stay in the disposable cluster, which is destroyed');
    }
  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    try { if (server) await new Promise((r) => server.close(r)); } catch (_) {}
    try {
      for (const id of made.objectives) {
        await query(`DELETE FROM office_plan_steps WHERE plan_id IN
                       (SELECT id FROM office_plans WHERE objective_id = $1)`, [id]).catch(() => {});
        await query(`DELETE FROM office_plans WHERE objective_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM objectives WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.workers) {
        await query(`DELETE FROM worker_identities WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.users) {
        await query(`DELETE FROM daily_tasks WHERE user_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM user_companies WHERE user_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM users WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.companies) {
        await query(`DELETE FROM companies WHERE id=$1`, [id]).catch(() => {});
      }
    } catch (e) { bad('cleanup failed', e.message); }
    try { await P.end(); } catch (_) {}
    try { cluster.destroy(); } catch (_) {}
    clearTimeout(watchdog);
  }

  console.log(`\n${fail ? 'FAIL' : 'OK'}  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
