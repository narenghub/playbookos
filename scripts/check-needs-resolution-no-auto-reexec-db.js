#!/usr/bin/env node
// ── CAN NEEDS_RESOLUTION RE-EXECUTE POSSIBLY-COMPLETED WORK BY ITSELF? ──────
//
// Owner, Priority 3: *"Verify that NEEDS_RESOLUTION cannot automatically re-execute potentially
// completed work."*
//
// NEEDS_RESOLUTION is the state a lease expiry produces, and its meaning is precise: an attempt was
// made and **its outcome is unknown**. Not "it failed", not "it did not run". The whole danger is
// that "unknown" is one careless predicate away from "available": a reaper that treats a stale
// lease as a free task, or a retry that re-enqueues work whose first attempt may have completed,
// duplicates a real-world effect — a supplier email sent twice, a payment moved twice.
//
// ── WHY THIS IS MEASURED AT THREE INDEPENDENT PLACES ───────────────────────
//
// The repo's own lesson is that a gate in a caller is a statement about that caller, while a gate
// at the sink covers every path including the ones nobody has written yet. "It cannot re-execute"
// is a claim about the whole system, so it is measured where the system could actually do it:
//
//   §1 THE CLAIM PREDICATE (the sink). Every pick filters `state = 'PENDING'`. A NEEDS_RESOLUTION
//      task is invisible to a worker asking for work, however many workers ask and whatever
//      capabilities they hold. Measured by putting a task in that state and having a
//      fully-capable, unrestricted worker try to claim it.
//
//   §2 THE AUTOMATIC REAPER. server.js runs `recovery.reap({dryRun:false})` every 15 minutes. It
//      calls `recoverRun`, never `retryRun` — so the automatic path closes stale RUNS out and
//      never creates attempt 2. Measured by running the real reaper over a real stale run with a
//      NEEDS_RESOLUTION task attached and asserting the task is untouched.
//
//   §3 THE RETRY PATH. `retryRun` needs an override reason, enforced by a database guard, and
//      re-checks the kill switch for a policy stop. Measured by calling it without one.
//
// ── AND ONE FINDING THIS CHECK RECORDS RATHER THAN FIXES ───────────────────
//
// `leases.reattemptEligibility(taskType, …)` is the gate that encodes *"this task type does not
// declare itself re-executable, so a second attempt could duplicate an effect that may already have
// happened"*, defaulting to false for anything that has not said otherwise. **No product code calls
// it.** Its own docstring says the attempt "is created by recovery.retryRun(), which owns the
// override enforcement" — and retryRun does own the override REASON, but it never consults task
// type re-executability at all, because it operates on runs and never reads `worker_tasks`.
//
// So on the retry path the protection is the human override, not the type declaration. That is not
// obviously wrong — a human accepting the ambiguity in writing is a real control, and arguably
// outranks a type's default — but it is a DIFFERENT control from the one the type declaration
// implies exists, and the gap is invisible because the gate is thoroughly tested by checks and
// called by nothing. §4 pins both halves so the next person reads the real arrangement rather than
// the documented one. Whether retryRun should consult the type is a policy decision for the owner,
// not something to change underneath them.

'use strict';

process.env.ADMIN_EMAIL = 'nr-bootstrap@nr.invalid';
process.env.ADMIN_PASSWORD = `n-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.JWT_SECRET = `nr-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.WORKER_SECRET_SEAL_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.NODE_ENV = 'development';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PG = require('./lib/pg-disposable');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

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
const step = (t) => lines.push('', `── ${t} ──`, '');

(async () => {
  let cluster = null;
  try {
    cluster = PG.create({ label: 'needs-resolution-no-auto-reexec' });
  } catch (e) {
    console.log(`NOT EXECUTED  infrastructure unavailable: ${e.message}`);
    process.exit(EXIT_NOT_EXECUTED);
  }
  process.env.DATABASE_URL = cluster.url;
  const DB = require('../src/lib/db');
  const { query } = DB;

  try {
    await DB.initDB();
    await DB.initPhase2();
    await DB.migrateSchemas();
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);
    await require('../src/lib/identity/schema').migrateIdentity(query);
    await require('../src/lib/worker/leases').migrateWorkerTasks(query);
    await require('../src/lib/worker/identity').migrateWorkerIdentity(query);
    await require('../src/lib/worker/synthetic-isolation').installSyntheticIsolation(query);

    const LEASES = require('../src/lib/worker/leases');
    const SYN = require('../src/lib/worker/synthetic-isolation');
    const TYPES = require('../src/lib/worker/task-types');

    const CO = `nr-co-${crypto.randomUUID().slice(0, 8)}`;
    await query(
      `INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,'NR fixture','active')`,
      [CO]);
    await SYN.setCompanySynthetic(CO, true, { query });

    // ── THE WORKER, ENROLLED THE REAL WAY ──────────────────────────────────
    //
    // A direct INSERT is refused by the grant-immutability trigger: *"a worker identity may only be
    // created by the enrollment exchange, which records enrolled_by as enrollment:<digest>"*. That
    // is commit 134069a working, so the fixture mints a token and exchanges it, like an operator.
    //
    // The grant is WIDENED (`exec:hardware`, `exec:gui`, `syntheticOnly: false`), which
    // createEnrollmentToken permits only for an active internal administrator — hence the fixture
    // admin. Widened deliberately: §1's claim is that the refusal comes from the task's STATE, so
    // every other reason to refuse has to be absent, or the gate under test is never reached.
    const IDENT = require('../src/lib/worker/identity');
    const { fixtureAdmin } = require('./lib/fixture-admin');
    const admin = await fixtureAdmin(query);
    const tok = await IDENT.createEnrollmentToken({
      label: 'nr-worker', capabilities: ['exec:hardware', 'exec:gui'],
      syntheticOnly: false, createdBy: admin,
    }, { query });
    const enrolled = await IDENT.consumeEnrollmentToken(
      { token: tok.token, hostFingerprint: 'nr-check' }, { query });
    if (!enrolled || !enrolled.ok) {
      throw new Error(`enrolment failed: ${JSON.stringify(enrolled)}`);
    }
    const W = enrolled.workerId;
    ok('a hardware-capable unrestricted worker is enrolled through the real token exchange');

    // ══ 1. THE SINK: A WORKER ASKING FOR WORK CANNOT SEE IT ════════════════
    step('1. the claim predicate — the sink, which covers paths nobody has written yet');

    // Enqueued through the REAL accessor, then moved into the state under test. My first version
    // hand-wrote the INSERT and invented two columns (`kind`, `enqueued_at`) while omitting the
    // NOT NULL `intent_key` — a fixture naming columns from memory measures the memory. enqueueTask
    // also refuses an unknown task type and a missing intent key, so the fixture traverses the same
    // road the product does.
    const mkTask = async (state, type = 'synthetic.echo') => {
      const r = await LEASES.enqueueTask({
        taskType: type, payload: {}, companyId: CO,
        intentKey: `nr-${crypto.randomUUID()}`, workflow: 'nr-check', createdBy: 'nr-fixture',
      }, { query });
      if (!r || r.ok === false) throw new Error(`enqueueTask refused: ${JSON.stringify(r)}`);
      const id = r.taskId || r.id;
      if (state !== 'PENDING') {
        await query('UPDATE worker_tasks SET state = $2 WHERE id = $1', [id, state]);
      }
      return id;
    };

    const unknownTask = await mkTask('NEEDS_RESOLUTION');
    const pendingTask = await mkTask('PENDING');

    // POSITIVE CONTROL FIRST. If the claim path is broken for an unrelated reason, every assertion
    // below passes for the wrong reason — so establish that this worker CAN claim before asserting
    // what it cannot.
    let claimedPending = null;
    try {
      claimedPending = await LEASES.claimTask({ workerId: W }, { query });
    } catch (e) { claimedPending = { ok: false, error: e.message }; }
    if (claimedPending && claimedPending.ok === true && claimedPending.taskId === pendingTask) {
      ok('POSITIVE CONTROL: this worker claims the PENDING task, so the claim path works and the '
        + 'refusals below are about state rather than about a broken instrument');
    } else {
      bad('the positive control failed — nothing below measures anything',
        JSON.stringify(claimedPending).slice(0, 220));
    }

    // Now nothing is left but the NEEDS_RESOLUTION task.
    let claimedUnknown = null;
    try {
      claimedUnknown = await LEASES.claimTask({ workerId: W }, { query });
    } catch (e) { claimedUnknown = { ok: false, error: e.message }; }
    if (claimedUnknown && claimedUnknown.ok !== true) {
      ok('with only the NEEDS_RESOLUTION task left, a fully-capable unrestricted worker is given '
        + 'NOTHING — the task is invisible to anyone asking for work');
    } else {
      bad('a NEEDS_RESOLUTION task was handed to a worker', JSON.stringify(claimedUnknown).slice(0, 220));
    }
    const stillUnknown = await query(
      'SELECT state FROM worker_tasks WHERE id = $1', [unknownTask]);
    if (stillUnknown.rows[0].state === 'NEEDS_RESOLUTION') {
      ok('and the task is still NEEDS_RESOLUTION — the claim attempt did not quietly reset it');
    } else {
      bad(`the claim attempt changed the state to ${stillUnknown.rows[0].state}`);
    }

    // Ten more attempts, because "it refused once" and "it cannot be claimed" are different claims.
    let everClaimed = false;
    for (let i = 0; i < 10; i += 1) {
      const r = await LEASES.claimTask({ workerId: W }, { query })
        .catch(() => ({ ok: false }));
      if (r && r.ok === true) everClaimed = true;
    }
    if (!everClaimed) {
      ok('ten further attempts, all empty — not a race that happened to resolve the right way once');
    } else {
      bad('a repeated claim eventually picked up the NEEDS_RESOLUTION task');
    }

    // And the state is in the lifecycle's own terminal-ish set, asserted from the schema rather
    // than from this file's belief about it.
    const SCHEMA = require('../src/lib/worker/task-schema');
    const states = SCHEMA.TASK_STATES || SCHEMA.STATES || [];
    if (Array.isArray(states) && states.includes('NEEDS_RESOLUTION')) {
      ok(`NEEDS_RESOLUTION is a declared lifecycle state (${states.length} states), not an ad-hoc `
        + 'string this check invented');
    } else {
      note(`task-schema exports ${Object.keys(SCHEMA).join(', ')}; the state set could not be read `
        + 'by name — the database CHECK constraint is the authority either way');
    }

    // ══ 2. THE AUTOMATIC REAPER ════════════════════════════════════════════
    step('2. the 15-minute reaper — the only thing that acts without a human');

    // The reaper is the automatic path, so this is where "automatically" is actually measured.
    const RECOVERY = require('../src/lib/office/recovery');
    // Through the real ledger — a hand-built INSERT fails on agent_runs.root_run_id being NOT NULL,
    // and would keep failing on the next invariant the ledger exists to maintain. No companyId: the
    // ledger requires company_id and objective_id to arrive TOGETHER under MATCH FULL, and §2 needs
    // only a stale run, not a company-scoped one.
    //
    // Then back-dated, because a run is only a reaper candidate once it is over its ceiling. The
    // dates are what make it stale; nothing else about the row is touched.
    const L = require('../src/lib/run-ledger').ledger({ query });
    const madeRun = await L.createRun({
      trigger: 'cron', triggerDetail: 'nr stale fixture', workflow: 'nr-workflow',
      agent: 'nr-agent', product: 'playnexa',
      intentKey: `nr-intent-${crypto.randomUUID().slice(0, 8)}`,
    });
    const staleRun = madeRun.runId;
    await query(
      `UPDATE agent_runs
          SET state = 'RUNNING', started_at = NOW() - INTERVAL '6 hours', max_runtime_minutes = 5
        WHERE run_id = $1`, [staleRun]);
    const staleRow = await query(
      'SELECT state, max_runtime_minutes FROM agent_runs WHERE run_id = $1', [staleRun]);
    if (staleRow.rows[0] && staleRow.rows[0].state === 'RUNNING') {
      ok('a genuinely stale RUNNING run exists, six hours past a five-minute ceiling — so the '
        + 'reaper below has something real to act on');
    } else {
      bad('the stale run fixture is not in the state the reaper looks for', staleRow.rows[0]);
    }

    const beforeStates = (await query(
      'SELECT id, state FROM worker_tasks WHERE company_id = $1 ORDER BY id', [CO])).rows;
    let reaped = null;
    try {
      reaped = await RECOVERY.reap({ dryRun: false, limit: 200 }, { query });
    } catch (e) { reaped = { error: e.message }; }
    if (reaped && !reaped.error && reaped.dry_run === false) {
      ok(`the real reaper ran in acting mode: inspected ${reaped.inspected}, `
        + `recovered ${reaped.recovered}`);
    } else {
      bad('the reaper did not run', JSON.stringify(reaped).slice(0, 220));
    }
    const afterStates = (await query(
      'SELECT id, state FROM worker_tasks WHERE company_id = $1 ORDER BY id', [CO])).rows;
    const changed = afterStates.filter((a, i) =>
      !beforeStates[i] || beforeStates[i].state !== a.state);
    const unknownAfterReap = afterStates.find((r) => r.id === unknownTask);
    if (unknownAfterReap && unknownAfterReap.state === 'NEEDS_RESOLUTION') {
      ok('the NEEDS_RESOLUTION task is untouched by the reaper — it recovers RUNS, and a run '
        + 'closing out is not a licence to redo the work');
    } else {
      bad('the reaper altered the NEEDS_RESOLUTION task',
        JSON.stringify(unknownAfterReap || null));
    }
    if (changed.length === 0) {
      ok('and it changed no task state at all');
    } else {
      note(`the reaper changed ${changed.length} task state(s): `
        + `${JSON.stringify(changed).slice(0, 160)} — review whether each is a run closing out`);
    }
    // The reaper's source is the claim: it calls recoverRun, not retryRun. Asserted statically,
    // because a run where no candidate happened to be retried proves nothing about whether it CAN.
    const reapSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'office', 'recovery.js'), 'utf8');
    const reapBody = reapSrc.slice(reapSrc.indexOf('async function reap('),
      reapSrc.indexOf('async function retryRun('));
    if (!/retryRun\s*\(/.test(reapBody)) {
      ok('and reap()\'s body does not mention retryRun — the automatic path cannot create '
        + 'attempt 2 on any input, not merely on this one');
    } else {
      bad('reap() can reach retryRun, so the automatic path can create a second attempt');
    }

    // ══ 3. THE RETRY PATH NEEDS A HUMAN ════════════════════════════════════
    step('3. retryRun — a human act, enforced by the database');

    const noReason = await RECOVERY.retryRun(staleRun, {}, { query });
    if (noReason && noReason.retried === false) {
      ok(`a retry with no override reason is refused (${noReason.reason})`);
    } else {
      bad('a retry was created with no override reason', JSON.stringify(noReason).slice(0, 220));
    }
    const shortReason = await RECOVERY.retryRun(staleRun, { overrideReason: 'ok' }, { query });
    if (shortReason && shortReason.retried === false) {
      ok(`and a token reason is refused too (${shortReason.reason}) — the requirement is a `
        + 'recorded judgement, not a filled field');
    } else {
      note(`a two-character reason produced ${JSON.stringify(shortReason).slice(0, 160)}; the `
        + 'guard\'s minimum is the authority');
    }

    // ══ 4. THE GATE NOTHING CALLS ══════════════════════════════════════════
    step('4. reattemptEligibility — correct, tested, and consulted by no product code');

    const nonRx = LEASES.reattemptEligibility('synthetic.crash_test',
      { overrideReason: 'a recorded human judgement accepting the ambiguity' });
    if (nonRx && nonRx.eligible === false && nonRx.code === 'not_reexecutable') {
      ok('the gate refuses a non-re-executable type even WITH a full override reason — so the '
        + 'type declaration is meant to outrank the human override');
    } else {
      bad('the type declaration did not refuse', JSON.stringify(nonRx).slice(0, 220));
    }
    const unknownType = LEASES.reattemptEligibility(`nr-made-up-${crypto.randomUUID().slice(0, 6)}`,
      { overrideReason: 'a recorded human judgement accepting the ambiguity' });
    if (unknownType && unknownType.eligible === false && unknownType.code === 'unknown_task_type') {
      ok('and an unknown type is refused rather than defaulted — re-executability is not something '
        + 'a task type gets by omission');
    } else {
      bad('an unknown task type was treated as eligible', JSON.stringify(unknownType).slice(0, 220));
    }
    if (typeof TYPES.isReexecutable === 'function' && TYPES.isReexecutable('synthetic.crash_test') === false) {
      ok('task-types.js is the single source of that fact, and it says no for crash_test');
    } else {
      note('task-types.isReexecutable could not be read directly; the gate\'s answer above stands');
    }

    // THE ARRANGEMENT, ASSERTED. Not "is this right" — "is this what is actually wired".
    const prodFiles = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); }
        else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) prodFiles.push(full);
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    const callers = prodFiles.filter((f) =>
      !f.endsWith(path.join('worker', 'leases.js'))
      && /reattemptEligibility\s*\(/.test(fs.readFileSync(f, 'utf8')));
    const retrySrc = reapSrc.slice(reapSrc.indexOf('async function retryRun('));
    const retryReadsTasks = /worker_tasks|reattemptEligibility/.test(retrySrc);

    if (callers.length === 0 && !retryReadsTasks) {
      ok('CONFIRMED ARRANGEMENT: no file under src/ calls reattemptEligibility, and retryRun reads '
        + 'neither worker_tasks nor the gate. On the retry path the protection is the recorded '
        + 'human override — NOT the type declaration §4 just measured');
      note('This is a finding, not a failure. The two controls are both real and they are not the '
        + 'same control: the type declaration says "this work must not be redone even with '
        + 'permission", and nothing on the live retry path consults it. Whether retryRun should is '
        + 'a POLICY decision — a human override may legitimately outrank a default — so it is '
        + 'recorded here for the owner rather than changed underneath them.');
      note('If the answer is that it should: retryRun would need the predecessor run\'s tasks, '
        + 'which means reading worker_tasks from office/recovery.js — a new dependency between the '
        + 'run ledger and the task queue, and the reason it is not a one-line change.');
    } else if (callers.length > 0) {
      ok(`reattemptEligibility is consulted by ${callers.length} product file(s): `
        + `${callers.map((f) => path.basename(f)).join(', ')} — the arrangement has changed since `
        + 'this check was written, which is good; re-read §4\'s note and update it');
    } else {
      ok('retryRun now reads worker_tasks or the gate — the arrangement has changed since this '
        + 'check was written; re-read §4\'s note and update it');
    }
  } catch (e) {
    bad(`the check itself failed: ${e.message}`);
    lines.push(String(e.stack || '').split('\n').slice(1, 6).join('\n'));
  } finally {
    try { cluster.destroy(); } catch (_) { /* already gone is the desired state */ }
  }

  console.log('══ NEEDS_RESOLUTION CANNOT RE-EXECUTE BY ITSELF ══');
  console.log(lines.join('\n'));
  console.log('');
  console.log(fail === 0
    ? `OK  (${pass} assertions)`
    : `FAILED  ${fail} assertion(s) failed, ${pass} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();
