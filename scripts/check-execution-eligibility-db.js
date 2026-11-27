#!/usr/bin/env node
// ── WHERE WORK MAY EXECUTE, AND WHAT A CLOUD WORKER MAY NOT TAKE (B4.1/B4.3) ─
//
//   node scripts/check-execution-eligibility-db.js   exit 0 = every ruled property holds
//                                                    exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner instruction, 2026-11-24:
//
//   "Classify every execution capability as cloud eligible, physical hardware required, or
//    authorized GUI session required. [...] Hardware-only work must queue safely without consuming
//    retry attempts or being claimed by cloud workers."
//
// ── WHY THE FILTER IS IN THE PICK, AND WHY THAT IS THE WHOLE MECHANISM ──────
//
// A task this worker may not execute is never SELECTED, so it stays PENDING, untouched, with its
// attempt count unchanged. "Queues safely" falls out of not being chosen.
//
// The obvious alternative — pick it, then refuse it — would consume an attempt and record a
// failure against work that was never wrong, and after enough cloud polls the reaper would call a
// perfectly good hardware task ABANDONED. That is the property this check is really about, and it
// is why the assertions below count ATTEMPTS and not just outcomes.
//
// Proved against a real database because claiming is a single arbitrating UPDATE and the attempt
// count is a column. A stubbed query would be asserting that my own stub increments the way
// Postgres does.

'use strict';

const crypto = require('node:crypto');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail++;
  console.log(`  FAIL  ${m}`);
  if (extra !== undefined) console.log(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
};
const note = (m) => console.log(`  --    ${m}`);

const DISPOSABLE = require('./lib/pg-disposable');
let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'exeligi' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  execution eligibility not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
// The enrolment exchange seals the secret at rest; a direct INSERT did not. Generated per run.
process.env.WORKER_SECRET_SEAL_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.ADMIN_EMAIL = 'exeligi-bootstrap@exeligi.invalid';
process.env.ADMIN_PASSWORD = `exeligi-${crypto.randomBytes(16).toString('hex')}`;

const WATCHDOG_MS = Number(process.env.EXELIGI_CHECK_TIMEOUT_MS || 240_000);
const watchdog = setTimeout(() => {
  console.log(`\n  FAIL  no progress in ${Math.round(WATCHDOG_MS / 1000)}s — a stall is a failure.`);
  try { cluster.destroy(); } catch (_) {}
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: cluster.url, ssl: false });
  const q = (t, p) => P.query(t, p);
  const deps = { query: q };
  const made = { workers: [], tasks: [] };
  const uid = (p) => `exeligi-${p}-${crypto.randomUUID().slice(0, 8)}`;

  try {
    await require('../src/lib/db').initDB();
    await require('../src/lib/runs').migrateRuns(q);
    const IDSCHEMA = require('../src/lib/worker/identity-schema');
    const TASKSCHEMA = require('../src/lib/worker/task-schema');
    // Neither module exports a migrate(); they export DDL arrays. Applied here with the same narrow
    // ignorable set the other migrations use, so a missing dependency still fails loudly.
    // THE KILL SWITCH SCHEMA, FIRST. Without `autonomy_stops` the worker auth gate fails CLOSED —
    // "kill-state could not be determined" — and refuses every claim. That made the eligibility
    // assertions below pass for entirely the wrong reason: the cloud worker was refused, but by the
    // stop gate rather than by the capability filter, which was never reached. The positive control
    // in section 5 is what exposed it, which is precisely what a positive control is for.
    await require('../src/lib/autonomy').migrateAutonomy(q);
    for (const mod of [IDSCHEMA, TASKSCHEMA]) {
      for (const stmt of mod.DDL) {
        try { await q(stmt); } catch (e) {
          if (!['42710', '42P07', '42701'].includes(e.code)) throw e;
        }
      }
    }
    // MIGRATION 62, which the DDL arrays above do not carry. This file applies raw DDL rather than
    // calling the migrators — a fourth setup shape in this repository — so the installer the three
    // migrators run never fired here, and `claimTask` reads `synthetic_only`: the check failed with
    // `column "synthetic_only" does not exist`. Same class as the autonomy note above, where a
    // missing schema made the eligibility assertions pass for entirely the wrong reason.
    // MIGRATION 62 MAKES `companies` A DEPENDENCY OF THE CLAIM PATH. The pick's predicate reads
    // `SELECT id FROM companies WHERE is_synthetic`, so the table must exist for the statement to
    // plan at all — even for an unrestricted worker, where the subquery is never needed per row.
    // This harness deliberately migrated only the worker schemas; it now needs the office schema
    // too, and that coupling is the honest consequence of making isolation a claim-time decision
    // rather than a property of the worker alone.
    await require('../src/lib/office/schema').migrateOffice(q);
    await require('../src/lib/worker/synthetic-isolation').installSyntheticIsolation(q);
    await require('../src/lib/worker/grant-immutability').installGrantImmutability(q);
    console.log('  ..    schema up\n');

    const TYPES = require('../src/lib/worker/task-types');
    const LEASES = require('../src/lib/worker/leases');

    // ── 1. EVERY CAPABILITY IS CLASSIFIED, AND THE REGISTRY ENFORCES IT ────
    const problems = TYPES.registryProblems();
    if (!problems.length) ok('the task-type registry is internally consistent');
    else bad('the registry reports problems', problems);

    const unclassified = TYPES.KNOWN.filter((t) => !TYPES.executionClassOf(t));
    if (!unclassified.length) {
      ok(`all ${TYPES.KNOWN.length} known task types declare an execution class`);
    } else bad('task types with no execution class', unclassified);

    // All three classes are represented, or one of the branches below is untested.
    const classes = new Set(TYPES.KNOWN.map((t) => TYPES.executionClassOf(t)));
    for (const k of Object.values(TYPES.EXECUTION)) {
      if (classes.has(k)) ok(`the registry has at least one ${k} type, so that branch is exercised`);
      else bad(`no task type is ${k} — that branch is untested`, k);
    }

    // The registry must REFUSE a type with no class. Proved by handing it one, not by reading it.
    const withMissing = { ...TYPES.TASK_TYPES, 'bad.unclassified': {
      summary: 'x', reexecutable: true, readOnly: true, ceilingMinutes: 5 } };
    const refused = TYPES.registryProblems(withMissing)
      .some((p) => /bad\.unclassified.*execution/.test(p));
    if (refused) ok('a type declaring NO execution class is REFUSED by the registry validator');
    else bad('an unclassified type passed the registry validator');

    // ── 2. THE PREDICATE: WHO MAY EXECUTE WHAT ─────────────────────────────
    if (!TYPES.workerMayExecute('synthetic.crash_test', [])) {
      ok('a worker with NO declared capabilities may NOT execute hardware-required work');
    } else bad('an undeclared worker could execute hardware work — the classification is vacuous');
    if (TYPES.workerMayExecute('synthetic.crash_test', ['exec:hardware'])) {
      ok('a worker declaring exec:hardware MAY execute it');
    } else bad('a hardware worker was refused hardware work');
    if (TYPES.workerMayExecute('synthetic.echo', [])) {
      ok('cloud-eligible work needs no extra capability — any authorized worker may run it');
    } else bad('cloud-eligible work demanded a capability');
    if (!TYPES.workerMayExecute('desktop.capture_once', ['exec:hardware'])) {
      ok('GUI-session work is NOT satisfied by hardware capability alone — a machine can be up, '
        + 'enrolled and executing with nobody logged in, which is what B4.4b turns on');
    } else bad('hardware capability was treated as a logged-in desktop session');

    // ── FIXTURES: A CLOUD WORKER AND A HARDWARE WORKER ─────────────────────
    // FIXTURES THROUGH THE ENROLMENT EXCHANGE, which is now the only path that may create an
    // identity at all. This helper used to INSERT directly with `enrolled_by = 'exeligi-fixture'`;
    // the BEFORE INSERT trigger refuses that, because a correctly formatted provenance string is
    // not an authenticated enrolment and an arbitrary one is not even formatted. Going the
    // authorized way also means these fixtures' capabilities are the ones a token APPROVED, which
    // is the property the trigger enforces and the thing this check's subject depends on.
    const IDENTITY = require('../src/lib/worker/identity');
    const mkWorker = async (label, capabilities) => {
      const tok = await IDENTITY.createEnrollmentToken({
        label: uid(label),
        capabilities,
        syntheticOnly: false,
        // Widened, because this check's subject is the CAPABILITY filter and its tasks carry no
        // company. Left restricted, every assertion below came back
        // `nothing_claimable_synthetic_isolation` — a true refusal for the wrong reason, which
        // would have made the capability filter unreachable and the check vacuous. The same
        // declaration the other seventeen fixture harnesses make.
        createdBy: await require('./lib/fixture-admin').fixtureAdmin(q),
      }, { query: q });
      const enr = await IDENTITY.consumeEnrollmentToken(
        { token: tok.token, hostFingerprint: `exeligi-${label}` }, { query: q });
      if (!enr || enr.ok !== true) {
        throw new Error(`fixture enrolment failed for ${label}: ${JSON.stringify(enr)}`);
      }
      made.workers.push(enr.workerId);
      return enr.workerId;
    };
    const cloudWorker = await mkWorker('cloud', ['worker.execute']);
    const hwWorker = await mkWorker('hardware', ['worker.execute', 'exec:hardware']);

    const enqueue = async (taskType) => {
      const id = uid('task');
      // `intent_key` is NOT NULL: it is what the one-live-attempt and (intent, attempt) unique
      // indexes are keyed on, which is also how attempts are counted below.
      await q(
        `INSERT INTO ${TASKSCHEMA.TABLES.tasks} (id, task_type, payload, intent_key, state, created_at)
         VALUES ($1,$2,'{}',$3,'PENDING',NOW())`,
        [id, taskType, `exeligi:${id}`]);
      made.tasks.push(id);
      return id;
    };

    // AN ATTEMPT IS A LEASE, not a counter on the task. `worker_tasks` has no `attempts` column —
    // attempts are rows in agent_runs, numbered per intent_key by uq_agent_runs_intent_attempt. So
    // "without consuming retry attempts" means NO RUN WAS OPENED, and that is what this counts.
    // Reading a column that does not exist would have been a measurement standing in for the
    // property; this reads the thing the system actually increments.
    const stateOf = async (id) => {
      const t = (await q(
        `SELECT state, intent_key FROM ${TASKSCHEMA.TABLES.tasks} WHERE id = $1`, [id])).rows[0];
      const runs = (await q(
        `SELECT COUNT(*)::int n FROM agent_runs WHERE intent_key = $1`, [t.intent_key])).rows[0].n;
      return { state: t.state, attempts: runs };
    };

    // ── 3. A CLOUD WORKER MUST NOT CLAIM HARDWARE-ONLY WORK ────────────────
    const hwTask = await enqueue('synthetic.crash_test');
    const before = await stateOf(hwTask);

    const cloudTry = await LEASES.claimTask({ workerId: cloudWorker }, deps);
    // The REASON matters, not merely that it was refused. The first version of this assertion
    // checked only `!ok`, and it passed while the claim was being refused by the kill-switch gate
    // because a table was missing — a refusal for the wrong reason reported as the property
    // holding. "Is it refused" is not the question; "is it refused BY THE CAPABILITY FILTER" is.
    if (!cloudTry.ok && cloudTry.code === 'nothing_claimable_by_this_worker') {
      ok('a CLOUD worker is not given the hardware-only task, and the refusal names capability '
        + 'as the reason');
    } else if (cloudTry.ok) {
      bad('a cloud worker CLAIMED hardware-only work', cloudTry);
    } else {
      bad(`the cloud worker was refused for an unrelated reason (${cloudTry.code}), so the `
        + 'capability filter was never measured', cloudTry.detail);
    }

    if (cloudTry.code === 'nothing_claimable_by_this_worker' && cloudTry.waitingForOtherWorkers === 1) {
      ok('and it is told there is work it CANNOT do — "nothing to do" would hide a backlog an '
        + 'operator needs to see');
    } else {
      bad('the refusal did not distinguish an empty queue from an incapable worker', cloudTry.code);
    }

    // ── 4. AND THE TASK QUEUED SAFELY: NO ATTEMPT CONSUMED ─────────────────
    const after = await stateOf(hwTask);
    if (after.state === 'PENDING') ok('the hardware task is still PENDING after the cloud poll');
    else bad('the hardware task left PENDING', after.state);
    if (after.attempts === before.attempts) {
      ok(`and NO attempt was opened (${after.attempts} runs for its intent) — filtering in the pick `
        + `means it was never chosen, so a cloud worker polling all day cannot exhaust it`);
    } else {
      bad('a cloud poll consumed an attempt on work it could not do', { before: before.attempts, after: after.attempts });
    }

    // Ten polls, to make the point the way it would actually happen.
    for (let i = 0; i < 10; i++) await LEASES.claimTask({ workerId: cloudWorker }, deps);
    const afterTen = await stateOf(hwTask);
    if (afterTen.attempts === before.attempts && afterTen.state === 'PENDING') {
      ok('ten cloud polls later: still PENDING, still zero attempts opened');
    } else bad('repeated cloud polls degraded the hardware task', afterTen);

    // ── 5. THE CAPABLE WORKER DOES GET IT ──────────────────────────────────
    //
    // The positive control. Without this, "the cloud worker did not get it" could equally mean the
    // task was unclaimable by anyone, and the refusal above would prove nothing.
    const hwTry = await LEASES.claimTask({ workerId: hwWorker }, deps);
    if (hwTry.ok && hwTry.taskId === hwTask) {
      ok('CONTROL: the worker declaring exec:hardware DOES claim it — so the refusal above is '
        + 'about capability, not about the task being unclaimable');
    } else bad('the hardware worker could not claim the hardware task', hwTry);

    // ── 6. A CLOUD WORKER STILL GETS CLOUD WORK ────────────────────────────
    const cloudTask = await enqueue('synthetic.echo');
    const cloudOk = await LEASES.claimTask({ workerId: cloudWorker }, deps);
    if (cloudOk.ok && cloudOk.taskId === cloudTask) {
      ok('and the cloud worker claims cloud-eligible work normally — the filter narrows, it does '
        + 'not stop');
    } else bad('the cloud worker could not claim cloud-eligible work', cloudOk);

    // ── 7. GUI WORK IS CLAIMED BY NEITHER ──────────────────────────────────
    const guiTask = await enqueue('desktop.capture_once');
    const guiByHw = await LEASES.claimTask({ workerId: hwWorker }, deps);
    // Asserted on the REFUSAL CODE, not on the absence of a field. The first version read
    // `guiByHw.task.id`, which is always undefined in this return shape, so the assertion could
    // not fail — an unfalsifiable test, which measures nothing at all.
    if (!guiByHw.ok && guiByHw.code === 'nothing_claimable_by_this_worker') {
      ok('GUI-session work is not claimed by the hardware worker either, and the refusal names '
        + 'capability — it waits for a worker that declares exec:gui');
    } else if (guiByHw.ok && guiByHw.taskId === guiTask) {
      bad('a headless hardware worker CLAIMED GUI-session work', guiByHw);
    } else {
      bad(`the GUI claim was refused for an unrelated reason (${guiByHw.code})`, guiByHw.detail);
    }
    const guiState = await stateOf(guiTask);
    if (guiState.state === 'PENDING' && guiState.attempts === 0) {
      ok('and it too queues with no attempt consumed');
    } else bad('GUI work was degraded by an incapable poll', guiState);

    note(`OWNER ACTION RECORDED: the iMac worker must be granted \`exec:hardware\` at enrollment `
      + 'before it can claim synthetic.crash_test again. Until then that task QUEUES rather than '
      + 'failing — which is the B4.3 behaviour, not a regression. Enrollment is an owner action '
      + 'and is not performed here.');
  } catch (e) {
    bad('the check threw', e && (e.stack || e.message));
  } finally {
    try {
      const TASKSCHEMA = require('../src/lib/worker/task-schema');
      const IDSCHEMA = require('../src/lib/worker/identity-schema');
      for (const id of made.tasks) {
        await q(`DELETE FROM ${TASKSCHEMA.TABLES.results} WHERE task_id = $1`, [id]).catch(() => {});
        await q(`DELETE FROM ${TASKSCHEMA.TABLES.tasks} WHERE id = $1`, [id]).catch(() => {});
      }
      for (const id of made.workers) {
        await q(`DELETE FROM ${IDSCHEMA.TABLES.identities} WHERE id = $1`, [id]).catch(() => {});
      }
      const left = (await q(
        `SELECT COUNT(*)::int n FROM ${TASKSCHEMA.TABLES.tasks} WHERE id = ANY($1)`,
        [made.tasks])).rows[0].n;
      if (left === 0) ok('cleanup: my fixtures are gone');
      else bad('cleanup leaked fixtures', left);
    } catch (e) {
      bad('cleanup itself failed', e && e.message);
    }
    await P.end().catch(() => {});
    clearTimeout(watchdog);
    cluster.destroy();
  }

  console.log(`\n  ${pass} ok, ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  execution eligibility does not hold every ruled property.');
    process.exit(1);
  }
  console.log('\nPASS  B4.1/B4.3: every capability declares where it may execute and the registry '
    + 'refuses one that does not; a cloud worker cannot claim hardware-only or GUI-session work, '
    + 'is told that work is waiting rather than that the queue is empty, and the work it cannot '
    + 'take queues with its attempts unconsumed through repeated polls — while the worker that '
    + 'declares the capability claims it immediately.');
  process.exit(0);
})();
