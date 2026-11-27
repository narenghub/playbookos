#!/usr/bin/env node
// ── EXECUTION CONSISTENCY AT THE REAL BOUNDARIES ────────────────────────────
//
//   node scripts/check-execution-consistency-db.js   exit 0 = the properties below hold
//                                                    exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner's Priority 1, second directive of 2026-11-26:
//
//   · *"Verify atomicity and recovery at actual transaction boundaries, including interruption
//      between related writes."*
//   · *"Distinguish exactly-once durable state transitions from execution attempts and external
//      effects."*
//   · *"Verify authorization changes between a phase guard and the consequential operation itself."*
//   · *"Verify that repeated terminal completion calls cannot cause duplicate downstream business
//      effects."*
//
// ── WHAT THIS CHECK IS FOR, AND WHAT IT IS NOT ─────────────────────────────
//
// It measures three properties that B3.17 did not separate, each at the boundary where it actually
// lives, with a CONTROL for each so a pass names the mechanism rather than the absence of a crash:
//
//   1. ORDERING is the atomicity. Two related writes, no transaction: the one that marks the phase
//      complete goes LAST, so an interruption anywhere before it re-runs the phase. Measured by
//      BREAKING the first write and asserting the second never happened.
//   2. A GUARD IS NOT A GATE. Authorization revoked in the milliseconds between the phase guard and
//      the insert it permitted: the database refuses the row. Measured with the window forced open.
//   3. REPEATED COMPLETION. The terminal state was already immutable; the completion TIME and the
//      completion EVENT were not, and a per-tick repeat moved one and duplicated the other.
//
// ── AND THE DISTINCTION THE OWNER ASKED FOR, STATED PLAINLY ────────────────
//
// Three different things are held by three different mechanisms, and only the first is exactly-once:
//
//   · a DURABLE STATE TRANSITION — a plan minted, an outcome recorded, a run ended, a task filed.
//     Exactly-once, held by a derived primary key or a unique index, with the database as arbiter.
//     Verified here and in check-phase-idempotency-db.js.
//   · an EXECUTION ATTEMPT — a tick, a claim, a dispatch, a retry. AT-LEAST-ONCE by design: the
//     recovery story IS repetition, and every attempt is recorded. Counting attempts is not
//     counting completions, which is the confusion that let a repeated `finish` inflate a
//     "completed runs" figure taken over the event ledger.
//   · an EXTERNAL EFFECT — an email, a payment, a supplier contact. NOT established as exactly-once
//     by anything in this file, and no claim here says it is. Outbound transmission is under STOP;
//     B7's transmitted-message verification is the work that would establish it.
//
// So: the cycle's durable state transitions are exactly-once. **The cycle is not.** Nothing in this
// repository has yet shown that an external effect cannot repeat, and this check does not pretend to.
//
// NO URL OVERRIDE: its own disposable cluster; every fixture created by id and removed by id.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
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
  cluster = DISPOSABLE.create({ label: 'xc' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  execution consistency was not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'xc-bootstrap@xc.invalid';
process.env.ADMIN_PASSWORD = `xc-${crypto.randomBytes(16).toString('hex')}`;

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

  /** The same deps with ONE statement shape refusing, which is what a partial outage looks like. */
  const brokenOn = (re, code = '57P01') => ({
    ...deps,
    query: (t, p) => (re.test(String(t))
      ? Promise.reject(Object.assign(new Error('simulated database outage'), { code }))
      : query(t, p)),
  });

  const made = { companies: [], objectives: [], workers: [] };
  let server = null;
  const uid = (p) => `xc-${p}-${crypto.randomUUID().slice(0, 8)}`;
  const countOf = async (sql, params) => (await query(sql, params)).rows[0].n;

  try {
    const autonomy = require('../src/lib/autonomy');
    const MEM = require('../src/lib/office/memory');

    // The migration order is copied from check-negative-paths-db.js, which copied it from
    // check-phase-idempotency-db.js. Composing one from scratch cost three runs there.
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
    await require('../src/lib/worker/identity').migrateWorkerIdentity(query);
    await require('../src/lib/worker/leases').migrateWorkerTasks(query);
    await require('../src/lib/worker/audit').migrateWorkerAudit(query);
    autonomy.resetForTests && autonomy.resetForTests();

    const CYCLE = require('../src/lib/office/cycle');
    const INIT = require('../src/lib/office/initiator');
    const SCOPE = require('../src/lib/office/scope');
    const LEASES = require('../src/lib/worker/leases');
    const LEDGER = require('../src/lib/run-ledger').ledger({ query });
    const IDENTITY = require('../src/lib/worker/identity');

    // A real worker API, so the claim and submit paths are the product's own rather than an
    // UPDATE of my own invention — which is what the first draft of section 1 tried, against a
    // `result` column that does not exist. The result lives in `worker_results`, keyed by run.
    const express = require('express');
    const WR = require('../src/api/worker.routes');
    const app = express();
    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.use('/api', WR.createWorkerRouter({ enable: true, query, withTransaction, env: SEAL }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const enrolWorker = async (label) => {
      const tok = await IDENTITY.createEnrollmentToken({ syntheticOnly: false,
      createdBy: await require('./lib/fixture-admin').fixtureAdmin(query), label }, deps);
      const r = await (await fetch(`${baseUrl}/api/worker/enroll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: tok.token, hostFingerprint: 'xc-check' }),
      })).json();
      if (!r || !r.ok) throw new Error(`could not enrol ${label}: ${JSON.stringify(r)}`);
      made.workers.push(r.workerId);
      return r.workerId;      // the secret is deliberately not kept: nothing here needs it
    };

    const newCompany = async (label) => {
      const id = uid(label);
      await query(`INSERT INTO companies (id, slug, display_name, status)
                   VALUES ($1,$1,$1,'active')`, [id]);
      made.companies.push(id);
      return id;
    };

    const newRun = async (companyId, label) => {
      const objId = uid(label);
      await query(`INSERT INTO objectives
                     (id, company_id, objective, priority, autonomy_tier, approval_policy, status,
                      created_by, budget_usd)
                   VALUES ($1,$2,$3,'P1','supervised','all_consequential','active',
                           'naren@fixture.invalid',5.00)`,
        [objId, companyId, `execution consistency: ${label}`]);
      made.objectives.push(objId);
      const started = await INIT.initiateDueObjectives({ companyId }, deps);
      const mine = (started.initiated || []).find((x) => x.objectiveId === objId);
      if (!mine) throw new Error(`${label}: initiation started no run (${JSON.stringify(started)})`);
      return { objId, runId: mine.runId, ctx: mine.context };
    };

    const stateOf = async (runId) => (await query(
      `SELECT state, ended_at FROM agent_runs WHERE run_id = $1`, [runId])).rows[0];

    // ══ 1. ORDERING IS THE ATOMICITY (VALIDATE) ══════════════════════════
    head('1. the phase-completing write goes last, so an interruption re-runs the phase');

    {
      // ── WHY THIS IS A REAL BOUNDARY AND NOT A HYPOTHETICAL ─────────────
      //
      // `phaseOf` leaves VALIDATE as soon as an outcome row exists. So the outcome IS the commit,
      // and anything the phase must leave behind has to precede it. The escalation used to come
      // SECOND: a process dying in between left a detected validation failure with a `partial`
      // outcome, no exception, and the next tick moving on to REPORT — a found problem turned into
      // no problem by a two-millisecond window.
      //
      // Measured by breaking the FIRST write and asserting the SECOND never happened, which is the
      // interruption, from the module's point of view, without killing anything.
      const CO = await newCompany('co-order');
      const { runId } = await newRun(CO, 'validate-ordering');
      await CYCLE.advanceCycle({ runId }, deps);                      // PLAN
      const disp = await CYCLE.advanceCycle({ runId }, deps);          // DISPATCH
      if (!(disp.phase === 'dispatch' && disp.enqueued.length)) bad('dispatch enqueued nothing', disp);

      // An INVALID result through the REAL lease path, so VALIDATE must escalate. Claimed BY ID:
      // there is one queue and `claimTask({workerId})` takes the oldest PENDING task in it, which
      // is how check-negative-paths-db.js once claimed another section's row.
      const workerId = await enrolWorker('xc-order');
      const task = (await query(
        `SELECT id FROM worker_tasks WHERE company_id = $1 LIMIT 1`, [CO])).rows[0];
      const claim = await LEASES.claimTask({ workerId, taskId: task.id }, deps);
      const submitted = await LEASES.submitResult({
        workerId, runId: claim.runId, status: 'SUCCEEDED',
        output: { unrelated: 'this is not what the plan asked for' },
      }, deps);
      if (!(claim.ok && submitted.ok)) bad('could not stage an invalid result', { claim, submitted });

      // THE INTERRUPTION: the exception insert refuses; everything else works.
      const broken = brokenOn(/INSERT INTO office_exceptions/i);
      const r = await CYCLE.advanceCycle({ runId }, broken);

      const exN = await countOf(
        `SELECT COUNT(*)::int n FROM office_exceptions WHERE run_id = $1::uuid`, [runId]);
      const outN = await countOf(
        `SELECT COUNT(*)::int n FROM office_outcomes WHERE run_id = $1::uuid`, [runId]);

      if (exN === 0 && outN === 0) {
        ok('the escalation failed and the outcome was therefore NOT written — the phase is left '
          + 'incomplete on purpose, because committing a validated failure that nothing escalated '
          + 'is the exact state this ordering exists to prevent');
      } else bad('an interruption between the two writes left a partial state', { exN, outN, r });

      if (r && r.ok === false && r.outcomeError && /escalation/.test(r.outcomeError)) {
        ok('and it is reported rather than swallowed: the return value names the escalation as the '
          + 'reason the outcome was withheld');
      } else bad('the interruption was not reported', r);

      // ── RECOVERY: the next tick, with the database whole again ─────────
      const r2 = await CYCLE.advanceCycle({ runId }, deps);
      const exN2 = await countOf(
        `SELECT COUNT(*)::int n FROM office_exceptions WHERE run_id = $1::uuid`, [runId]);
      const outN2 = await countOf(
        `SELECT COUNT(*)::int n FROM office_outcomes WHERE run_id = $1::uuid`, [runId]);
      if (r2.phase === 'validate' && exN2 === 1 && outN2 === 1) {
        ok('the next tick re-derived VALIDATE and completed it — one exception, one outcome: '
          + 'recovery is the phase derivation plus the derived ids, with no transaction and nothing '
          + 'to unwind');
      } else bad('the retry did not recover the phase', { r2: r2.phase, exN2, outN2 });

      // ── AND THE THIRD TICK ADDS NOTHING (the derived ids are the arbiter) ──
      const r3 = await CYCLE.advanceCycle({ runId }, deps);
      const exN3 = await countOf(
        `SELECT COUNT(*)::int n FROM office_exceptions WHERE run_id = $1::uuid`, [runId]);
      const outN3 = await countOf(
        `SELECT COUNT(*)::int n FROM office_outcomes WHERE run_id = $1::uuid`, [runId]);
      if (exN3 === 1 && outN3 === 1) {
        ok(`a third tick (now ${r3.phase}) added neither a second exception nor a second outcome`);
      } else bad('repetition duplicated the phase effects', { exN3, outN3 });

      // CONTROL: the ordering is what did it, named by reading the source. Without this, every
      // assertion above would also pass on an implementation that wrote them in either order
      // inside one successful tick.
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'lib', 'office', 'cycle.js'), 'utf8');
      const vStart = src.indexOf('case PHASE.VALIDATE:');
      const vEnd = src.indexOf('case PHASE.REPORT:');
      const body = src.slice(vStart, vEnd);
      const iEx = body.indexOf('ex-cycle-');
      const iOut = body.indexOf('out-cycle-');
      if (vStart > 0 && vEnd > vStart && iEx > 0 && iOut > iEx) {
        ok('control: in the source, the escalation id appears BEFORE the outcome id inside '
          + 'VALIDATE — the order is the mechanism, so it is asserted as source order too');
      } else bad('the outcome is written before the escalation', { iEx, iOut });
    }

    // ══ 2. A GUARD IS NOT A GATE ═════════════════════════════════════════
    head('2. authorization withdrawn between the phase guard and the write it permitted');

    {
      // ── THE WINDOW THE PHASE GUARD CANNOT CLOSE ────────────────────────
      //
      // `office/phase-guard.js` re-reads the company at every phase boundary, which closes the gap
      // between PHASES. It cannot close the gap between its own answer and the insert a few
      // milliseconds later, and no amount of re-checking makes a check-then-act atomic — the same
      // lesson B2.5b learned about budget. So the DATABASE states it, and this is the measurement.
      const CO = await newCompany('co-toctou');
      const objId = uid('toctou');
      await query(`INSERT INTO objectives
                     (id, company_id, objective, priority, autonomy_tier, approval_policy, status,
                      created_by, budget_usd)
                   VALUES ($1,$2,'toctou','P1','supervised','all_consequential','active',
                           'naren@fixture.invalid',5.00)`, [objId, CO]);
      made.objectives.push(objId);

      // The CONTROL FIRST, so a refusal below cannot be the fixture being wrong: the same insert
      // lands while the company is active.
      const control = await LEASES.enqueueTask({
        intentKey: `xc-toctou-control-${crypto.randomUUID().slice(0, 8)}`,
        companyId: CO, taskType: 'synthetic.echo', payload: { echo: 'control' },
        requestedBy: 'xc-check', capabilities: ['exec:node'],
      }, deps).then((x) => x, (e) => ({ error: e.message }));
      if (control && control.ok === true && control.taskId) {
        ok('control: the identical enqueue LANDS while the company is active — so a refusal below '
          + 'is the company status and not a malformed fixture');
      } else bad('the control enqueue did not land', control);

      // THE WINDOW, forced open: the guard has already answered, and now authorization is
      // withdrawn before the write.
      await query(`UPDATE companies SET status='suspended' WHERE id=$1`, [CO]);

      // ── TWO REFUSALS, AND THIS USED TO MEASURE ONLY ONE ────────────────────
      //
      // This section's claim is that the write is refused BY THE DATABASE, *"however the insert
      // arrives, including from a caller nobody has written yet"*. It tested that claim THROUGH
      // `enqueueTask` — a caller that very much has been written — so what it actually measured was
      // that one function's behaviour, and the trigger was inferred from the error text.
      //
      // On 2026-11-27 A.6 added a company check inside `enqueueTask` (the company on a task is the
      // isolation boundary and was previously unvalidated: a nonexistent company was accepted, and
      // an unrestricted worker's claim filter skips the company subquery entirely). That check now
      // refuses first and RETURNS rather than throwing, so this assertion began failing — not
      // because the property broke, but because the application gate now stands in front of the
      // database gate it was reading through. The gate-contamination pattern, in reverse.
      //
      // So both are measured, separately and in the right order: the application refusal for its
      // legibility, and then a RAW INSERT for the claim this section actually makes.
      const viaFunction = await LEASES.enqueueTask({
        intentKey: `xc-toctou-after-${crypto.randomUUID().slice(0, 8)}`,
        companyId: CO, taskType: 'synthetic.echo', payload: { echo: 'after' },
        requestedBy: 'xc-check', capabilities: ['exec:node'],
      }, deps).then((x) => x, (e) => ({ ok: false, threw: e.message }));
      if (viaFunction && viaFunction.ok === false
          && /not active|company_not_active/i.test(
            `${viaFunction.code || ''} ${viaFunction.detail || viaFunction.threw || ''}`)) {
        ok(`enqueueTask refuses for the withdrawn company by name (${viaFunction.code || 'threw'}) `
          + '— the legible refusal, before any row is attempted');
      } else bad('enqueueTask enqueued work for a suspended company', viaFunction);

      // THE CLAIM ITSELF: a caller nobody has written. A direct INSERT bypasses every application
      // check, which is the only way to establish that the DATABASE is what enforces this.
      const rawIntent = `xc-toctou-raw-${crypto.randomUUID().slice(0, 8)}`;
      const after = await query(
        `INSERT INTO worker_tasks (id, task_type, payload, intent_key, company_id, workflow)
         VALUES ($1,'synthetic.echo','{}'::jsonb,$2,$3,'xc-check')`,
        [`xc-raw-${crypto.randomUUID().slice(0, 8)}`, rawIntent, CO]
      ).then((x) => ({ landed: x }), (e) => ({ refused: e.message, code: e.code }));

      if (after.refused && /not active|authorization has been withdrawn/i.test(after.refused)) {
        ok('and a RAW INSERT — a caller nobody has written — is REFUSED BY THE DATABASE, naming '
          + 'the withdrawn authorization. This is what the section claimed all along and could not '
          + 'establish while it measured through enqueueTask');
      } else bad('a raw insert created work for a suspended company, so the database is NOT what '
        + 'enforces this', after);

      // And the same for a plan, which is minting authorization to act. A plan needs a run, so one
      // is started while the company is still suspended — `agent_runs` is deliberately NOT guarded,
      // which is what lets the ledger record that the system stopped.
      const planRun = crypto.randomUUID();
      await query(`INSERT INTO agent_runs
                     (run_id, root_run_id, agent, product, trigger, state, attempt,
                      objective_id, company_id)
                   VALUES ($1,$1,'xc-check','playbookos','manual','RUNNING',1,$2,$3)`,
        [planRun, objId, CO]);
      const planRefused = await query(
        `INSERT INTO office_plans (id, company_id, objective_id, run_id, proposer, planner, status)
         VALUES ($1,$2,$3,$4,'xc-check','xc-check','proposed')`,
        [uid('plan'), CO, objId, planRun]).then(() => 'allowed', (e) => e.message);
      if (/not active|authorization has been withdrawn/i.test(planRefused)) {
        ok('and minting a PLAN for a suspended company is refused by the same trigger — a plan is '
          + 'authorization to act, so it belongs on the same side of the line as a task');
      } else bad('a plan was minted for a suspended company', planRefused);

      // The truthful record stays WRITABLE, which is the point of not guarding those tables: the
      // system must be able to write down that it stopped.
      const exOk = await query(
        `INSERT INTO office_exceptions
           (id, company_id, objective_id, run_id, source, reason, severity, status)
         VALUES ($1,$2,$3,$4,'xc-check','authorization withdrawn mid-flight','high','open')`,
        [uid('ex'), CO, objId, planRun]).then(() => true, (e) => e.message);
      if (exOk === true) {
        ok('while an EXCEPTION for the same suspended company still writes — a trigger that '
          + 'refused the record of the stop would turn a governed refusal into silence');
      } else bad('the system could not record that it had stopped', exOk);

      await query(`UPDATE companies SET status='active' WHERE id=$1`, [CO]);
    }

    // ══ 3. REPEATED TERMINAL COMPLETION ══════════════════════════════════
    head('3. repeated terminal completion produces no second downstream effect');

    {
      // B3.17 raced four finishes and asserted the STATE was unchanged, which it was — the
      // transition guard holds it. But the state was never the only thing `finish` wrote, and two
      // downstream figures did duplicate: the completion TIME moved with every tick, and a second
      // RUN_ENDED event was appended each time, so a "completed runs" count taken over the event
      // ledger over-counted one completion.
      const CO = await newCompany('co-finish');
      const { runId } = await newRun(CO, 'repeated-finish');
      await LEDGER.startRun(runId);

      const first = await LEDGER.finish(runId, {});
      const s1 = await stateOf(runId);
      if (first.state === s1.state && first.observed === true) {
        ok(`the first finish ended the run ${s1.state}, and the return value is READ BACK from the `
          + 'row rather than being the state it intended');
      } else bad('the first finish did not agree with the row', { first, s1 });

      const t1 = s1.ended_at && new Date(s1.ended_at).getTime();
      await new Promise((r) => setTimeout(r, 25));

      const repeats = await Promise.all([1, 2, 3, 4].map(() => LEDGER.finish(runId, {})));
      const s2 = await stateOf(runId);
      const t2 = s2.ended_at && new Date(s2.ended_at).getTime();

      if (s2.state === s1.state) ok(`four further finishes left the run ${s2.state}`);
      else bad(`the state changed to ${s2.state}`);

      if (t1 && t2 && t1 === t2) {
        ok('and the COMPLETION TIME did not move — it used to walk forward with every tick, which '
          + 'falsified every duration, SLA and wall-clock progress figure derived from it, the '
          + 'reliability run\'s among them');
      } else bad('ended_at was rewritten by a repeated finish', { t1, t2 });

      const ended = await countOf(
        `SELECT COUNT(*)::int n FROM agent_run_events WHERE run_id=$1 AND kind='RUN_ENDED'`,
        [runId]);
      if (ended === 1) {
        ok('exactly ONE RUN_ENDED event for five finish calls — RUN_ENDED means the run ended, and '
          + 'it ended once, so a count of completions over the ledger is now a count of completions');
      } else bad(`${ended} RUN_ENDED events for one completion`, ended);

      // CONTROL: the freeze is in the DATABASE, not in the caller remembering a WHERE clause.
      const frozen = await query(
        `UPDATE agent_runs SET ended_at = NOW() + INTERVAL '1 hour' WHERE run_id=$1`, [runId])
        .then(() => 'allowed', (e) => e.message);
      if (/written once/.test(frozen)) {
        ok('control: a raw SQL attempt to move ended_at is refused by the transition guard — so the '
          + 'property holds for a caller that has not been written yet');
      } else bad('ended_at is not frozen at the database level', frozen);

      // ── AND A LATE FAILURE CANNOT REPORT ITSELF AS THE TRUTH ───────────
      //
      // The quiet one. `finish` returned the state it COMPUTED, and `operational` swallows the
      // refusal — so finishing an already-SUCCEEDED run with an error returned PARTIAL while the
      // row said SUCCEEDED, and the cycle's REPORT phase put that straight into the briefing. The
      // guard was intact in the database and the answer was wrong in the caller's hand.
      const late = await LEDGER.finish(runId, { error: 'a late failure arriving after completion' });
      const s3 = await stateOf(runId);
      if (late.state === s3.state && late.state !== 'PARTIAL') {
        ok(`a late failing finish reports ${late.state} — what the row says — not the PARTIAL it `
          + 'computed: the return value is an observation, not an intention');
      } else bad('a repeated finish reported a state the row does not hold', { late, s3 });
      // `intendedState` is whatever the derivation produced for THIS call — FAILED here, because
      // the run has no ACTION_SUCCEEDED events and an error was passed. The property is that it is
      // kept and is DIFFERENT from the state that holds, not that it is any particular value;
      // asserting the value was my own error and would have pinned the derivation table.
      if (late.alreadyTerminal === true && late.intendedState && late.intendedState !== late.state) {
        ok('and it says so explicitly: alreadyTerminal, with the state it wanted kept separately, '
          + 'so a caller can tell "I ended this run" from "somebody else already had"');
      } else bad('the repeat did not distinguish itself from the original completion', late);

      if (repeats.every((r) => r.observed === true)) {
        ok('every racing repeat observed the row rather than asserting its own answer');
      } else bad('a racing repeat returned an unobserved state', repeats);
    }

    // ══ 4. THE DISTINCTION, AND THE WAITING POLICY, IN WRITING ═══════════
    head('4. exactly-once is claimed only where it is held, and the wait is documented');

    {
      // The owner: *"Do not describe the entire cycle as exactly-once until the remaining
      // properties are established."* So the claim has to be scoped in the DOCUMENT a human reads,
      // not only in a comment, and the scope is asserted here so it cannot quietly widen.
      const docPath = path.join(__dirname, '..', 'docs', 'office', 'execution-consistency.md');
      let doc = null;
      try { doc = fs.readFileSync(docPath, 'utf8'); } catch (_) { doc = null; }
      if (!doc) {
        bad('docs/office/execution-consistency.md is missing: the waiting policy and the scope of '
          + 'the exactly-once claim must be written down for an operator, not only asserted in code');
      } else {
        const hasThree = /durable state transition/i.test(doc)
          && /execution attempt/i.test(doc) && /external effect/i.test(doc);
        if (hasThree) {
          ok('the document separates durable state transitions, execution attempts and external '
            + 'effects by name');
        } else bad('the document does not separate the three', { hasThree });

        // The NEGATIVE claim is the one that matters: it must say the cycle as a whole is NOT
        // exactly-once. A document that only makes the positive claim is the mislabelling the
        // owner forbade.
        const scoped = /\bnot\b[^.\n]{0,80}exactly[- ]once/i.test(doc)
          || /exactly[- ]once[^.\n]{0,80}\bnot\b/i.test(doc);
        if (scoped) {
          ok('and it states in the negative that the cycle as a whole is NOT exactly-once — the '
            + 'positive claim alone would be the mislabelling the directive forbids');
        } else bad('the document does not scope the exactly-once claim in the negative');

        const waiting = /waiting policy/i.test(doc) && /\bgrace\b/i.test(doc)
          && /escalat/i.test(doc);
        if (waiting) {
          ok('and the waiting policy for an unavailable worker is written down with its window and '
            + 'its escalation, so the bound is a published decision rather than a constant');
        } else bad('the waiting policy is not documented', { waiting });
      }

      // And the code must not claim more than the document does. A grep for the unqualified phrase
      // in the cycle, which is the file a reader would trust.
      const cyc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'lib', 'office', 'cycle.js'), 'utf8');
      const overclaim = /\bthe cycle is exactly[- ]once\b/i.test(cyc)
        || /\bexactly[- ]once cycle\b/i.test(cyc);
      if (!overclaim) {
        ok('and cycle.js nowhere calls the cycle itself exactly-once');
      } else bad('cycle.js claims the whole cycle is exactly-once');
    }

    // ══ 5. WHAT IS STILL NOT ESTABLISHED ════════════════════════════════
    head('5. the boundary of this check, stated rather than implied');

    note('NOT established here: that an EXTERNAL EFFECT cannot repeat. Outbound transmission is '
      + 'under the production email STOP and no message has been transmitted, so there is nothing '
      + 'to measure; B7\'s transmitted-message verification is the work that would establish it.');
    note('NOT established here: behaviour under a real SIGKILL between two statements of ONE '
      + 'transaction. The interruptions above are per-statement refusals, which is what a partial '
      + 'outage looks like from inside a module; the tick-level SIGKILL lives in '
      + 'check-unattended-cycle-db.js and the 72-hour behaviour is B4.7.');
    note('NOT established here: that the trigger in section 2 is present in PRODUCTION. It is '
      + 'installed by migrateOffice and migrateWorkerTasks, which have not been deployed.');
    note('every fixture here was created by id and is removed by id below; rows held by '
      + 'append-only audit tables stay in the disposable cluster, which is destroyed');
  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    try { if (server) await new Promise((r) => server.close(r)); } catch (_) {}
    try {
      for (const id of made.objectives) {
        await query(`DELETE FROM office_exceptions WHERE objective_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM office_plan_steps WHERE plan_id IN
                       (SELECT id FROM office_plans WHERE objective_id = $1)`, [id]).catch(() => {});
        await query(`DELETE FROM office_plans WHERE objective_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM objectives WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.workers) {
        await query(`DELETE FROM worker_identities WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.companies) {
        await query(`DELETE FROM worker_results WHERE task_id IN
                       (SELECT id FROM worker_tasks WHERE company_id=$1)`, [id]).catch(() => {});
        await query(`DELETE FROM worker_tasks WHERE company_id=$1`, [id]).catch(() => {});
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
