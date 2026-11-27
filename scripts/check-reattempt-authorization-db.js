#!/usr/bin/env node
// ── DECISION 2: A TASK TYPE'S PROHIBITION OUTRANKS A HUMAN OVERRIDE ─────────
//
// Owner decision, 2026-11-27, approving what the previous run reported as a policy question:
// *"Implement reattemptEligibility at the actual retryRun sink. An ordinary human override must not
// bypass a hard task-type prohibition. Derive associated task classifications and execution
// outcomes from persisted authoritative records. Unknown outcomes require independent
// reconciliation. Unknown classifications fail closed. Verify automatic recovery, manual retry,
// concurrent retry, mixed task classifications, authorization withdrawal and duplicate-effect
// prevention."*
//
// Each of those seven is a section below, against a disposable cluster, through the real
// `recovery.retryRun` and the real `leases` module. Nothing is stubbed to permit or refuse.
//
// ── WHAT WAS ACTUALLY WRONG, SO THE FIX IS LEGIBLE ─────────────────────────
//
// `leases.reattemptEligibility` was correct, thoroughly tested, and called by NO product code. Its
// docstring said the attempt "is created by recovery.retryRun(), which owns the override
// enforcement" — and retryRun did own the override REASON, enforced by a database trigger, but it
// operates on runs and never read `worker_tasks` or the gate. So the rule "this type must not be
// redone even with permission" existed at one address and was enforced at neither.
//
// The link it needed was already persisted: a worker lease IS an `agent_runs` row whose
// `intent_key` is copied from the task at claim time, and `worker_tasks` has a unique index on
// `intent_key`. §0 asserts that link exists before anything else relies on it, because every
// section below is a statement about a join.
//
// No consequential operation runs here and no hardware is touched: the task types are the
// `synthetic.*` ones, and nothing is executed — only leased, resolved and retried.

'use strict';

process.env.ADMIN_EMAIL = 'ra-bootstrap@ra.invalid';
process.env.ADMIN_PASSWORD = `r-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.JWT_SECRET = `ra-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.WORKER_SECRET_SEAL_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.NODE_ENV = 'development';

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

const REASON = 'a recorded human judgement accepting the ambiguity of the first attempt';

(async () => {
  let cluster = null;
  try {
    cluster = PG.create({ label: 'reattempt-authorization' });
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
    const RECOVERY = require('../src/lib/office/recovery');
    const SYN = require('../src/lib/worker/synthetic-isolation');
    const IDENT = require('../src/lib/worker/identity');
    const TYPES = require('../src/lib/worker/task-types');
    const { fixtureAdmin } = require('./lib/fixture-admin');

    const CO = `ra-co-${crypto.randomUUID().slice(0, 8)}`;
    await query(
      `INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,'RA fixture','active')`,
      [CO]);
    await SYN.setCompanySynthetic(CO, true, { query });
    const admin = await fixtureAdmin(query);

    // One worker, enrolled the real way. A direct INSERT is refused by the grant-immutability
    // trigger, which is 134069a working.
    const tok = await IDENT.createEnrollmentToken({
      label: 'ra-worker', capabilities: ['exec:hardware', 'exec:gui'],
      syntheticOnly: false, createdBy: admin,
    }, { query });
    const enrolled = await IDENT.consumeEnrollmentToken(
      { token: tok.token, hostFingerprint: 'ra-check' }, { query });
    if (!enrolled || !enrolled.ok) throw new Error(`enrolment failed: ${JSON.stringify(enrolled)}`);
    const W = enrolled.workerId;

    // Lease a task and drive it to NEEDS_RESOLUTION through the real path, returning the lease run.
    const leaseAndAbandon = async (taskType) => {
      const enq = await LEASES.enqueueTask({
        taskType, payload: {}, companyId: CO,
        intentKey: `ra-${crypto.randomUUID()}`, workflow: 'ra-workflow', createdBy: 'ra-fixture',
      }, { query });
      if (!enq || enq.ok === false) throw new Error(`enqueue refused: ${JSON.stringify(enq)}`);
      const claim = await LEASES.claimTask({ workerId: W, taskId: enq.taskId }, { query });
      if (!claim || claim.ok !== true) throw new Error(`claim refused: ${JSON.stringify(claim)}`);
      // Back-date the lease past its ceiling and let the REAL reaper abandon it.
      await query(
        `UPDATE agent_runs SET started_at = NOW() - INTERVAL '6 hours', max_runtime_minutes = 5
          WHERE run_id = $1`, [claim.runId]);
      await RECOVERY.reap({ dryRun: false, limit: 200 }, { query });
      // AND the bridge. The reaper abandons the RUN and deliberately does not touch the task —
      // check-needs-resolution-no-auto-reexec-db.js asserts exactly that. `reflectAbandonedLeases`
      // is the function that reflects an abandoned lease onto its task as NEEDS_RESOLUTION. Without
      // it this fixture left the task LEASED, and §2 then "passed" a retry that was never gated,
      // which is the instrument measuring itself rather than the product.
      await LEASES.reflectAbandonedLeases({ limit: 200 }, { query });
      return { taskId: enq.taskId, runId: claim.runId, intentKey: enq.intentKey };
    };

    // ══ 0. THE PERSISTED LINK EVERY SECTION BELOW RELIES ON ════════════════
    step('0. the run → task link is a stored equality, not something a caller passes');

    const probe = await leaseAndAbandon('synthetic.echo');
    const linkRow = await query(
      `SELECT r.run_id, r.trigger, r.intent_key AS run_intent, t.id AS task_id,
              t.intent_key AS task_intent, t.task_type, t.state, t.resolved_at
         FROM agent_runs r JOIN worker_tasks t ON t.intent_key = r.intent_key
        WHERE r.run_id = $1`, [probe.runId]);
    if (linkRow.rows.length === 1 && linkRow.rows[0].task_id === probe.taskId) {
      ok(`the lease run joins its task on intent_key (trigger=${linkRow.rows[0].trigger}, `
        + `type=${linkRow.rows[0].task_type}, state=${linkRow.rows[0].state})`);
    } else {
      bad('the run → task link does not hold, so nothing below measures what it claims',
        JSON.stringify(linkRow.rows[0] || null));
    }
    const derived = await RECOVERY.associatedTasks(
      { intent_key: probe.intentKey }, { query });
    if (derived.known && derived.tasks.length === 1 && derived.tasks[0].id === probe.taskId) {
      ok('associatedTasks derives it from the records, taking no task id from the caller');
    } else {
      bad('associatedTasks did not derive the task', JSON.stringify(derived).slice(0, 200));
    }

    // ══ 1. AUTOMATIC RECOVERY TOUCHES NEITHER ══════════════════════════════
    step('1. automatic recovery — the reaper creates no attempt and prohibits nothing');

    const afterReap = await query(
      'SELECT state, resolved_at FROM worker_tasks WHERE id = $1', [probe.taskId]);
    if (afterReap.rows[0].state === 'NEEDS_RESOLUTION' && !afterReap.rows[0].resolved_at) {
      ok('the real reaper left the task NEEDS_RESOLUTION with resolved_at NULL — an attempt was '
        + 'made and its outcome is unrecorded, which is the state this whole check is about');
    } else {
      bad('the reaper did not produce an unreconciled unknown outcome', afterReap.rows[0]);
    }
    const attempts = await query(
      'SELECT COUNT(*)::int n FROM agent_runs WHERE intent_key = $1', [probe.intentKey]);
    if (attempts.rows[0].n === 1) {
      ok('and exactly ONE run exists for that intent — recovery closed it out, it did not retry');
    } else {
      bad(`${attempts.rows[0].n} runs exist for the intent after recovery`);
    }

    // ══ 2. UNKNOWN OUTCOME REQUIRES INDEPENDENT RECONCILIATION ═════════════
    step('2. an unknown outcome blocks a retry until somebody establishes what happened');

    const unreconciled = await RECOVERY.retryRun(
      probe.runId, { overrideReason: REASON }, { query });
    if (unreconciled.retried === false && unreconciled.reason === 'outcome_requires_reconciliation') {
      ok('a retry of an unreconciled NEEDS_RESOLUTION task is refused BY NAME, with a full '
        + 'override reason present — intent is not a finding');
    } else {
      bad('an unreconciled unknown outcome was retried',
        JSON.stringify(unreconciled).slice(0, 240));
    }
    const stillOne = await query(
      'SELECT COUNT(*)::int n FROM agent_runs WHERE intent_key = $1', [probe.intentKey]);
    if (stillOne.rows[0].n === 1) {
      ok('and NO new run was created by the refused attempt — it refused before creating anything');
    } else {
      bad(`a refused retry left ${stillOne.rows[0].n} runs`);
    }

    // Record the reconciliation, the way an operator would, and the retry becomes possible.
    await query(
      `UPDATE worker_tasks SET resolved_at = NOW(),
          resolution_note = 'checked the target system: the first attempt did not land'
        WHERE id = $1`, [probe.taskId]);
    const afterRecon = await RECOVERY.retryRun(
      probe.runId, { overrideReason: REASON }, { query });
    if (afterRecon.retried === true && afterRecon.attempt === 2) {
      ok('once the reconciliation is RECORDED, the same retry succeeds as attempt 2 — so §2 '
        + 'measured the reconciliation and not some unrelated refusal');
    } else {
      bad('recording the reconciliation did not permit the retry',
        JSON.stringify(afterRecon).slice(0, 240));
    }

    // ══ 3. A HUMAN OVERRIDE CANNOT PASS A TYPE PROHIBITION ═════════════════
    step('3. manual retry — the type prohibition outranks the override');

    if (TYPES.isReexecutable('synthetic.crash_test') === false) {
      ok('synthetic.crash_test does not declare itself re-executable (task-types.js is the source)');
    } else {
      bad('the fixture type is re-executable, so §3 cannot measure a prohibition');
    }
    const barred = await leaseAndAbandon('synthetic.crash_test');
    // Reconcile it, so the ONLY thing left standing is the type prohibition. Without this the
    // refusal below could be §2's, and the section would prove nothing — the gate-contamination
    // pattern this repo keeps paying for.
    await query(
      `UPDATE worker_tasks SET resolved_at = NOW(), resolution_note = 'established: did not land'
        WHERE id = $1`, [barred.taskId]);
    const prohibited = await RECOVERY.retryRun(
      barred.runId, { overrideReason: REASON }, { query });
    if (prohibited.retried === false && prohibited.reason === 'not_reexecutable') {
      ok('a FULL human override is refused: not_reexecutable — the prohibition is not overridable, '
        + `and it names the task (${prohibited.taskType})`);
    } else {
      bad('a human override passed a hard type prohibition', JSON.stringify(prohibited).slice(0, 240));
    }
    const noRuns = await query(
      'SELECT COUNT(*)::int n FROM agent_runs WHERE intent_key = $1', [barred.intentKey]);
    if (noRuns.rows[0].n === 1) {
      ok('and no second run exists for it');
    } else {
      bad(`${noRuns.rows[0].n} runs exist for the prohibited intent`);
    }
    // The override is still required where it was before — not replaced by the new gate.
    const noReason = await RECOVERY.retryRun(probe.runId, {}, { query });
    if (noReason.retried === false) {
      ok(`a retry with no override reason is still refused (${noReason.reason}) — the database `
        + 'guard that owns that rule was not displaced by this change');
    } else {
      bad('the override requirement was lost', JSON.stringify(noReason).slice(0, 200));
    }

    // ══ 4. UNKNOWN CLASSIFICATION FAILS CLOSED ═════════════════════════════
    step('4. an unreadable or unknown classification fails closed');

    const unknownType = LEASES.reattemptEligibility(
      `ra-not-a-type-${crypto.randomUUID().slice(0, 6)}`, { overrideReason: REASON });
    if (unknownType.eligible === false && unknownType.code === 'unknown_task_type') {
      ok('an unknown task type is refused rather than defaulted');
    } else {
      bad('an unknown type was treated as eligible', JSON.stringify(unknownType));
    }
    // UNREADABLE, not merely unknown: a query that throws must not read as permission. Measured by
    // handing the derivation a query that fails, which is what an unmigrated or broken database is.
    //
    // TWO CASES THAT LOOK ALIKE AND ARE NOT. The first version of the product failed closed on any
    // query error, including "relation worker_tasks does not exist" — which refused every retry in
    // check-office-recovery-db.js, a harness that migrates the run ledger and not the worker
    // schema. A database with no worker table has never held a task, so the true answer there is
    // "no associated tasks". A database whose table EXISTS but cannot be read is the unknown the
    // owner's rule is about. Both are asserted, because the fix is the distinction between them.
    const tablePresentButUnreadable = async (sql) => {
      if (/to_regclass/.test(String(sql))) {
        const row = {};
        for (const m of String(sql).matchAll(/AS\s+(t\d+)/g)) row[m[1]] = true;
        return { rows: [row] };
      }
      throw new Error('canceling statement due to lock timeout');
    };
    const unreadable = await RECOVERY.reattemptPermitted(
      { intent_key: probe.intentKey }, { overrideReason: REASON },
      { query: tablePresentButUnreadable });
    if (unreadable.permitted === false && unreadable.reason === 'task_classification_unreadable') {
      ok('the table EXISTS and the read fails (lock timeout) → refused. An outage is not an '
        + 'authorization, and this is the case the rule is for');
    } else {
      bad('a present-but-unreadable classification was permitted',
        JSON.stringify(unreadable).slice(0, 220));
    }
    // ALL worker tables absent AND the run is not a lease — the genuinely non-worker environment.
    const tableAbsent = async (sql) => (/to_regclass/.test(String(sql))
      ? { rows: [{}] }
      : { rows: [] });
    const absent = await RECOVERY.reattemptPermitted(
      { intent_key: probe.intentKey }, { overrideReason: REASON }, { query: tableAbsent });
    if (absent.permitted === true && absent.tasks === 0) {
      ok('the table is ABSENT → permitted with zero tasks. A database that has never run a worker '
        + 'has no work in doubt, and refusing there would make retry impossible for every '
        + 'deployment without the worker subsystem — the over-refusal that gets a gate switched off');
    } else {
      bad('an absent worker schema was treated as an unknown classification',
        JSON.stringify(absent).slice(0, 220));
    }
    const catalogUnreadable = async () => { throw new Error('connection terminated unexpectedly'); };
    const noCatalog = await RECOVERY.reattemptPermitted(
      { intent_key: probe.intentKey }, { overrideReason: REASON }, { query: catalogUnreadable });
    if (noCatalog.permitted === false) {
      ok('and when even the catalog cannot be read, it refuses — the probe is not a loophole');
    } else {
      bad('an unreachable catalog was permitted', JSON.stringify(noCatalog).slice(0, 220));
    }
    // AND THE DISTINCTION THAT MATTERS: "none" is not "unknown". A run that leased no task has no
    // type to prohibit, and refusing it in the name of failing closed would break every ordinary
    // workflow retry.
    const noTasks = await RECOVERY.reattemptPermitted(
      { intent_key: `ra-nothing-${crypto.randomUUID()}` }, { overrideReason: REASON }, { query });
    if (noTasks.permitted === true && noTasks.tasks === 0) {
      ok('a run with NO associated task is permitted — "there are none" and "I could not tell" are '
        + 'different answers, and only the second fails closed');
    } else {
      bad('a run with no tasks was refused, which would break ordinary workflow retries',
        JSON.stringify(noTasks).slice(0, 220));
    }

    // ══ 5. MIXED CLASSIFICATIONS ═══════════════════════════════════════════
    step('5. mixed classifications — any prohibition refuses the whole retry');

    // ── A MIXED SET CANNOT EXIST FOR ONE RUN, AND THAT IS THE FINDING ──────
    //
    // The first version of this section inserted two tasks under one intent key and the database
    // refused it: `uq_worker_tasks_intent` is UNIQUE on intent_key, and its own comment says why —
    // *"two tasks must never share one, otherwise uq_agent_runs_one_active would treat them as the
    // same work and serialise them against each other."*
    //
    // Since the run→task link IS that intent key, **a run has exactly one associated task, by
    // construction.** So "mixed task classifications" is unreachable for a single retry, and the
    // honest thing is to assert the constraint that makes it unreachable rather than to fabricate a
    // state the product cannot be in. A check that forces an impossible shape measures the forcing.
    const mixedIntent = `ra-mixed-${crypto.randomUUID()}`;
    await query(
      `INSERT INTO worker_tasks (id, task_type, payload, intent_key, company_id, workflow, state,
         resolved_at)
       VALUES ($1,'synthetic.echo','{}'::jsonb,$2,$3,'ra-workflow','FAILED',NOW())`,
      [`ra-mix-a-${crypto.randomUUID().slice(0, 8)}`, mixedIntent, CO]);
    let refusedBySchema = null;
    try {
      await query(
        `INSERT INTO worker_tasks (id, task_type, payload, intent_key, company_id, workflow, state)
         VALUES ($1,'synthetic.crash_test','{}'::jsonb,$2,$3,'ra-workflow','FAILED')`,
        [`ra-mix-b-${crypto.randomUUID().slice(0, 8)}`, mixedIntent, CO]);
      refusedBySchema = false;
    } catch (e) {
      refusedBySchema = /uq_worker_tasks_intent/.test(e.message);
    }
    if (refusedBySchema) {
      ok('the DATABASE refuses a second task under one intent key (uq_worker_tasks_intent), so a '
        + 'run can never have a mixed classification set — the guarantee is structural, not a '
        + 'convention this code relies on');
    } else {
      bad('two tasks shared one intent key, so a mixed set IS reachable and the decision below is '
        + 'load-bearing in production rather than defensive');
    }

    // The DECISION over a set is still verified, because the function takes a set and a schema
    // guarantee is a reason to be defensive rather than a reason to be unable to cope. Measured by
    // handing it the set directly — not by writing an impossible row.
    // The stub models BOTH statements associatedTasks makes: the to_regclass existence probe and
    // the task read. A stub that answered only the second returned its canned rows to the probe,
    // whose `present` was then undefined, and the function correctly concluded "no worker_tasks
    // table" — so the section passed its own fixture instead of the product. Routing on the SQL is
    // what makes an injected query a model of the database rather than a constant.
    // WORKER TABLES PRESENT, derived from the probe's own aliases rather than hardcoded. The
    // product now probes three tables in one statement (`... AS t0, ... AS t1, ... AS t2`); a stub
    // that answered the old single-column shape returned `{present:true}`, every alias read as
    // undefined, and the function correctly concluded "no worker table exists" — so these sections
    // passed their own fixture again. Parsing the aliases means the stub keeps modelling the probe
    // if WORKER_TABLES ever changes, instead of silently going stale.
    const allTablesPresent = (sql) => {
      const row = {};
      for (const m of String(sql).matchAll(/AS\s+(t\d+)/g)) row[m[1]] = true;
      return { rows: [row] };
    };
    const setOf = (rows) => async (sql) => (/to_regclass/.test(String(sql))
      ? allTablesPresent(sql)
      : { rows });
    const mixedSet = setOf([
      { id: 'set-a', task_type: 'synthetic.echo', state: 'FAILED', resolved_at: new Date() },
      { id: 'set-b', task_type: 'synthetic.crash_test', state: 'FAILED', resolved_at: new Date() },
    ]);
    const mixed = await RECOVERY.reattemptPermitted(
      { intent_key: mixedIntent }, { overrideReason: REASON }, { query: mixedSet });
    if (mixed.permitted === false && mixed.reason === 'not_reexecutable'
        && mixed.taskId === 'set-b') {
      ok('and over a mixed set the decision refuses on the PROHIBITED member, naming it — a retry '
        + 'is one run, so permitting it on the permissive half would redo the other');
    } else {
      bad('a mixed classification set was permitted', JSON.stringify(mixed).slice(0, 220));
    }
    const permissiveSet = setOf([
      { id: 'set-a', task_type: 'synthetic.echo', state: 'FAILED', resolved_at: new Date() },
      { id: 'set-c', task_type: 'synthetic.echo', state: 'FAILED', resolved_at: new Date() },
    ]);
    const solo = await RECOVERY.reattemptPermitted(
      { intent_key: mixedIntent }, { overrideReason: REASON }, { query: permissiveSet });
    if (solo.permitted === true && solo.tasks === 2) {
      ok('CONTROL: a set of two RE-EXECUTABLE tasks is permitted — the refusal above was about the '
        + 'prohibited member, not about there being more than one');
    } else {
      bad('the permissive control was refused too', JSON.stringify(solo).slice(0, 220));
    }

    // ══ 6. CONCURRENT RETRY ════════════════════════════════════════════════
    step('6. concurrent retry — two callers, at most one new attempt');

    const conc = await leaseAndAbandon('synthetic.echo');
    await query(
      `UPDATE worker_tasks SET resolved_at = NOW(), resolution_note = 'established'
        WHERE id = $1`, [conc.taskId]);
    const both = await Promise.all([
      RECOVERY.retryRun(conc.runId, { overrideReason: REASON }, { query }),
      RECOVERY.retryRun(conc.runId, { overrideReason: REASON }, { query }),
    ]);
    const won = both.filter((r) => r.retried === true);
    const lost = both.filter((r) => r.retried !== true);
    const runCount = await query(
      'SELECT COUNT(*)::int n FROM agent_runs WHERE intent_key = $1', [conc.intentKey]);
    if (won.length === 1 && runCount.rows[0].n === 2) {
      ok(`exactly one of two concurrent retries won; ${runCount.rows[0].n} runs exist for the `
        + 'intent (the original and one retry)');
      note(`the loser said: ${JSON.stringify({ reason: lost[0] && lost[0].reason }).slice(0, 120)}`);
    } else {
      bad(`${won.length} concurrent retries succeeded and ${runCount.rows[0].n} runs exist — a `
        + 'second attempt for one intent is a duplicate execution', JSON.stringify(both).slice(0, 240));
    }

    // ══ 7. AUTHORIZATION WITHDRAWAL ════════════════════════════════════════
    step('7. authorization withdrawn between the attempts');

    const wd = await leaseAndAbandon('synthetic.echo');
    await query(
      `UPDATE worker_tasks SET resolved_at = NOW(), resolution_note = 'established'
        WHERE id = $1`, [wd.taskId]);
    // The company stops being synthetic-authorized for this worker's scope: the isolation boundary
    // migration 62 added. The retry must not resurrect work the company no longer authorizes.
    await query('UPDATE companies SET status = $2 WHERE id = $1', [CO, 'suspended']);
    const afterWithdrawal = await RECOVERY.retryRun(
      wd.runId, { overrideReason: REASON }, { query });
    const claimAfter = await LEASES.claimTask({ workerId: W, taskId: wd.taskId }, { query })
      .catch((e) => ({ ok: false, error: e.message }));
    if (claimAfter.ok !== true) {
      ok('with the company suspended, the task cannot be CLAIMED — so even where a retry run is '
        + 'created, no worker may execute against it');
    } else {
      bad('a suspended company\'s task was claimed', JSON.stringify(claimAfter).slice(0, 200));
    }
    note(`retryRun under withdrawal returned ${JSON.stringify({ retried: afterWithdrawal.retried,
      reason: afterWithdrawal.reason }).slice(0, 140)} — the run ledger and the claim path are `
      + 'separate gates, and the claim path is the one that decides execution');
    await query('UPDATE companies SET status = $2 WHERE id = $1', [CO, 'active']);

    // ══ 7b. THE SUSPENDED COMPANY IS REFUSED AT retryRun ═══════════════════
    step('7b. owner decision: refuse at retryRun, with a durable denial record');

    const susp = await leaseAndAbandon('synthetic.echo');
    await query(
      `UPDATE worker_tasks SET resolved_at = NOW(), resolution_note = 'established'
        WHERE id = $1`, [susp.taskId]);
    await query('UPDATE companies SET status = $2 WHERE id = $1', [CO, 'suspended']);
    const refusedRetry = await RECOVERY.retryRun(
      susp.runId, { overrideReason: REASON }, { query });
    if (refusedRetry.retried === false
        && refusedRetry.reason === 'company_authorization_withdrawn') {
      ok('a suspended company\'s retry is refused AT retryRun — no executable run is created, '
        + 'where before the run existed and could never execute');
    } else {
      bad('a suspended company still got a retry run', JSON.stringify(refusedRetry).slice(0, 240));
    }
    const noNewRun = await query(
      'SELECT COUNT(*)::int n FROM agent_runs WHERE intent_key = $1', [susp.intentKey]);
    if (noNewRun.rows[0].n === 1) {
      ok('and the run count is unchanged — refused before creating, not created then cancelled');
    } else {
      bad(`${noNewRun.rows[0].n} runs exist for the suspended company's intent`);
    }

    // THE DURABLE DENIAL RECORD. "An email is not a record."
    const denialRows = await query(
      `SELECT kind, error, detail FROM agent_run_events
        WHERE run_id = $1 AND kind = 'RETRY_DENIED' ORDER BY at DESC`, [susp.runId]);
    if (denialRows.rows.length >= 1
        && denialRows.rows[0].detail
        && denialRows.rows[0].detail.reason === 'company_authorization_withdrawn') {
      ok('the denial is recorded durably on the PREDECESSOR run as RETRY_DENIED, with its reason '
        + 'machine-queryable — the row that exists, because the point is that no new run does');
    } else {
      bad('the denial left no durable record', JSON.stringify(denialRows.rows).slice(0, 240));
    }
    if (refusedRetry.auditRecorded === true) {
      ok('and retryRun reports that the audit was written, so a silent audit failure is visible '
        + 'to the caller rather than only to a log');
    } else {
      bad('retryRun did not report the audit outcome', JSON.stringify(refusedRetry).slice(0, 200));
    }
    // CLAIM-TIME AUTHORIZATION IS STILL THERE — defence in depth, as the decision requires.
    const claimStill = await LEASES.claimTask({ workerId: W, taskId: susp.taskId }, { query })
      .catch((e) => ({ ok: false, error: e.message }));
    if (claimStill.ok !== true) {
      ok('and the CLAIM-time check still refuses independently — it covers withdrawal that happens '
        + 'after a retry run is created, which the retry-time check cannot see');
    } else {
      bad('claim-time authorization was lost', JSON.stringify(claimStill).slice(0, 200));
    }
    // Every denial is recorded, not only the company one.
    await query('UPDATE companies SET status = $2 WHERE id = $1', [CO, 'active']);
    const barredAgain = await leaseAndAbandon('synthetic.crash_test');
    await query(
      `UPDATE worker_tasks SET resolved_at = NOW(), resolution_note = 'established'
        WHERE id = $1`, [barredAgain.taskId]);
    await RECOVERY.retryRun(barredAgain.runId, { overrideReason: REASON }, { query });
    const typeDenial = await query(
      `SELECT detail FROM agent_run_events
        WHERE run_id = $1 AND kind = 'RETRY_DENIED'`, [barredAgain.runId]);
    if (typeDenial.rows.length >= 1
        && typeDenial.rows[0].detail.reason === 'not_reexecutable'
        && typeDenial.rows[0].detail.task_type === 'synthetic.crash_test') {
      ok('a CLASSIFICATION denial is recorded too, naming the task type — every refusal is '
        + 'written down, because one that leaves no trace looks like a retry nobody attempted');
    } else {
      bad('the classification denial was not recorded', JSON.stringify(typeDenial.rows).slice(0, 240));
    }

    // ══ 7c. SCHEMA ABSENCE: REQUIRED vs GENUINELY NON-WORKER ═══════════════
    step('7c. a missing worker_tasks must not silently bypass the gate');

    // Owner: *"Do not allow a missing worker_tasks table to silently bypass retry protection in an
    // environment where that schema is required. Distinguish verified historical compatibility and
    // genuinely non-worker runs from unexpected schema absence."* Three evidence-based cases.
    const noTables = async (sql) => (/to_regclass/.test(String(sql)) ? { rows: [{}] } : { rows: [] });
    const onlyIdentities = async (sql) => {
      if (/to_regclass/.test(String(sql))) {
        const aliases = [...String(sql).matchAll(/to_regclass\('([a-z_]+)'\)[^,]*AS\s+(t\d+)/g)];
        const row = {};
        for (const [, table, alias] of aliases) {
          if (table !== 'worker_tasks') row[alias] = true;
        }
        return { rows: [row] };
      }
      return { rows: [] };
    };
    const leaseRun = { trigger: 'worker', intent_key: 'ra-lease-probe' };
    const plainRun = { trigger: 'cron', intent_key: 'ra-plain-probe' };

    const leaseNoSchema = await RECOVERY.reattemptPermitted(
      leaseRun, { overrideReason: REASON }, { query: noTables });
    if (leaseNoSchema.permitted === false
        && leaseNoSchema.reason === 'task_classification_unreadable') {
      ok('a run that IS a worker lease, with worker_tasks gone, is REFUSED — the schema existed '
        + 'when that lease was created, so its absence is a lost table and not a non-worker database');
    } else {
      bad('a lease run bypassed the gate on a missing schema',
        JSON.stringify(leaseNoSchema).slice(0, 220));
    }
    const inconsistent = await RECOVERY.reattemptPermitted(
      plainRun, { overrideReason: REASON }, { query: onlyIdentities });
    if (inconsistent.permitted === false) {
      ok('worker_tasks missing while another worker table is PRESENT is refused — an inconsistent '
        + 'schema, not an absent one');
    } else {
      bad('an inconsistent worker schema was permitted', JSON.stringify(inconsistent).slice(0, 220));
    }
    const genuinelyNone = await RECOVERY.reattemptPermitted(
      plainRun, { overrideReason: REASON }, { query: noTables });
    if (genuinelyNone.permitted === true && genuinelyNone.tasks === 0) {
      ok('and a non-lease run with NO worker table at all is permitted — the narrow harnesses and '
        + 'any deployment that never runs workers, where there is no work in doubt');
    } else {
      bad('the genuinely non-worker case was refused, which is the over-refusal that got the gate '
        + 'switched off last time', JSON.stringify(genuinelyNone).slice(0, 220));
    }

    // ══ 7d. LINEAGE: THE DELEGATED SUBTREE, NOT THE IMMEDIATE TASK ═════════
    step('7d. a prohibited task in a properly DELEGATED child blocks the parent\'s retry');

    // Owner: *"A unique immediate task relationship does not establish that the entire delegated
    // workflow is safely repeatable."*
    //
    // THE FIXTURE HAD TO BE REBUILT, and the reason is itself the finding. The first version made a
    // worker lease the delegation parent. That is not constructible:
    // `office_delegations_parent_same_company` is a MATCH FULL foreign key on
    // (parent_run_id, company_id) → agent_runs(run_id, company_id), and a lease carries
    // company_id NULL (leases.js puts the task's company in tenant_id, because the ledger requires
    // company_id and objective_id to arrive together). Under MATCH FULL a partially-NULL key
    // matches nothing, so the database refuses a delegation whose parent is a lease — correctly: a
    // lease is a leaf, not a delegator. Delegation happens between OFFICE runs, which carry both
    // columns, and worker tasks attach by intent_key.
    const SCOPE7 = require('../src/lib/office/scope');
    const CTX7 = require('../src/lib/office/context');
    const OBJ7 = `ra-obj-${crypto.randomUUID().slice(0, 8)}`;
    await SCOPE7.createObjective({
      id: OBJ7, companyId: CO, objective: 'delegated workflow lineage fixture', priority: 'P2',
      kpiMetric: 'ra_lineage', kpiTarget: 1, deadline: '2026-12-31', budgetUsd: 1,
      autonomyTier: 'supervised', approvalPolicy: 'all_consequential', createdBy: admin,
    }, { query });
    const L7 = require('../src/lib/run-ledger').ledger({ query });
    // Activated through the accessor — the scope-discipline scanner refuses a raw UPDATE, and the
    // objective context recordDelegation needs cannot resolve from a draft objective anyway.
    const actRun7 = await L7.createRun({
      trigger: 'check', triggerDetail: 'ra activation', workflow: 'ra-workflow', agent: 'ra-agent',
      product: 'playbookos', companyId: CO, objectiveId: OBJ7,
      intentKey: `ra-act-${crypto.randomUUID().slice(0, 8)}`,
    });
    const coCtx7 = await CTX7.resolveCompanyContext({ runId: actRun7.runId }, { query });
    await SCOPE7.setObjectiveStatus(coCtx7, { id: OBJ7, status: 'active' }, { query });
    const objCtx7 = await CTX7.resolveObjectiveContext({ objectiveId: OBJ7 }, { query });

    const mkOfficeRun = async ({ parentRunId = null, intentKey }) => {
      const made = await L7.createRun({
        trigger: 'cron', triggerDetail: 'ra lineage fixture', workflow: 'ra-workflow',
        agent: 'ra-agent', product: 'playbookos', companyId: CO, objectiveId: OBJ7,
        intentKey, parentRunId, rootRunId: parentRunId || null,
      });
      if (!made.runId) throw new Error(`createRun refused: ${JSON.stringify(made)}`);
      return made.runId;
    };
    const mkTask = async (intentKey, taskType) => {
      const id = `ra-lt-${crypto.randomUUID().slice(0, 8)}`;
      await query(
        `INSERT INTO worker_tasks (id, task_type, payload, intent_key, company_id, workflow, state,
           resolved_at)
         VALUES ($1,$2,'{}'::jsonb,$3,$4,'ra-workflow','FAILED',NOW())`,
        [id, taskType, intentKey, CO]);
      return id;
    };

    const parentIntent = `ra-par-${crypto.randomUUID()}`;
    const parentRun = await mkOfficeRun({ intentKey: parentIntent });
    await query(`UPDATE agent_runs SET state = 'FAILED' WHERE run_id = $1`, [parentRun]);
    await mkTask(parentIntent, 'synthetic.echo');

    const kidIntent = `ra-kid-${crypto.randomUUID()}`;
    const kidRun = await mkOfficeRun({ parentRunId: parentRun, intentKey: kidIntent });
    await mkTask(kidIntent, 'synthetic.crash_test');
    // THE RECORDED AUTHORITY for that edge — without it the retry refuses as undelegated, which is
    // §7e's subject. Here the delegation is legitimate so the CLASSIFICATION is what must refuse.
    await SCOPE7.recordDelegation(objCtx7, {
      id: `ra-del-${crypto.randomUUID().slice(0, 8)}`,
      parentRunId: parentRun, childRunId: kidRun,
      callingAgent: 'ra-agent', targetAgent: 'ra-child-agent', workflow: 'ra-workflow',
      capability: 'exec.synthetic', autonomyTier: 'supervised',
      policyDecision: '{"tier":"supervised"}', depth: 1,
      reason: 'lineage fixture: a legitimate delegation',
    }, { query });

    const auth7d = await RECOVERY.lineageAuthority(parentRun, { query });
    if (auth7d.readable && auth7d.rows.length === 2 && auth7d.undelegated.length === 0) {
      ok('the lineage reads 2 runs and every descendant has a RECORDED delegation');
    } else {
      bad('the delegated fixture is not the shape this section needs',
        JSON.stringify({ rows: auth7d.rows && auth7d.rows.length,
          undelegated: auth7d.undelegated && auth7d.undelegated.length }));
    }
    const ownTask = await query(
      'SELECT task_type FROM worker_tasks WHERE intent_key = $1', [parentIntent]);
    if (ownTask.rows.length === 1 && ownTask.rows[0].task_type === 'synthetic.echo') {
      ok('CONTROL: the parent\'s OWN task is single and re-executable, so an immediate-task check '
        + 'would permit this retry');
    } else {
      bad('the parent fixture is wrong', JSON.stringify(ownTask.rows).slice(0, 200));
    }
    const lineageRefusal = await RECOVERY.retryRun(
      parentRun, { overrideReason: REASON }, { query });
    if (lineageRefusal.retried === false && lineageRefusal.reason === 'not_reexecutable'
        && lineageRefusal.taskType === 'synthetic.crash_test') {
      ok('and the retry is REFUSED on the CHILD\'s prohibited task — the workflow is the subtree, '
        + 'not the immediate task, and a retry re-runs what it delegated');
    } else {
      bad('a prohibited task in a delegated child did not block the parent retry',
        JSON.stringify(lineageRefusal).slice(0, 240));
    }

    // ══ 7e. AUTHORITY, NOT A LIST OF ACTIVE COMPANIES ══════════════════════
    step('7e. an undelegated descendant, and a cross-company one, with every company ACTIVE');

    // Owner: *"Do not treat a cross-company descendant as authorized merely because every involved
    // company is active. Verify the actual delegation authority and permitted scope."*
    const orphanParentIntent = `ra-op-${crypto.randomUUID()}`;
    const orphanParent = await mkOfficeRun({ intentKey: orphanParentIntent });
    await query(`UPDATE agent_runs SET state = 'FAILED' WHERE run_id = $1`, [orphanParent]);
    await mkTask(orphanParentIntent, 'synthetic.echo');
    const orphanIntent = `ra-orph-${crypto.randomUUID()}`;
    const orphanKid = await mkOfficeRun({ parentRunId: orphanParent, intentKey: orphanIntent });
    await mkTask(orphanIntent, 'synthetic.echo');     // RE-EXECUTABLE, so only authority can refuse
    // Deliberately NO office_delegations row for this edge.
    const coRow = await query('SELECT status FROM companies WHERE id = $1', [CO]);
    if (coRow.rows[0].status === 'active') {
      ok(`CONTROL: company ${CO} is ACTIVE, so an "all companies active" check would permit both `
        + 'cases below');
    } else {
      bad('the fixture company is not active, so §7e cannot make its point', coRow.rows[0]);
    }
    const undel = await RECOVERY.retryRun(orphanParent, { overrideReason: REASON }, { query });
    if (undel.retried === false && undel.reason === 'undelegated_descendant') {
      ok('a descendant with NO recorded delegation refuses the parent\'s retry — the edge exists in '
        + 'agent_runs and nothing establishes who authorized it, so something built this child '
        + 'outside delegate()');
    } else {
      bad('an undelegated descendant was permitted', JSON.stringify(undel).slice(0, 240));
    }
    const undelAudit = await query(
      `SELECT detail FROM agent_run_events WHERE run_id = $1 AND kind = 'RETRY_DENIED'`,
      [orphanParent]);
    if (undelAudit.rows.length >= 1
        && undelAudit.rows[0].detail.reason === 'undelegated_descendant') {
      ok('and that denial is recorded durably too');
    } else {
      bad('the authority denial left no record', JSON.stringify(undelAudit.rows).slice(0, 200));
    }

    // CROSS-COMPANY, both active. Built by hand precisely because delegate() cannot build it: it
    // takes no companyId and derives the child's company from the parent.
    const CO2 = `ra-co2-${crypto.randomUUID().slice(0, 8)}`;
    await query(
      `INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,'RA other','active')`,
      [CO2]);
    await SYN.setCompanySynthetic(CO2, true, { query });
    const xIntent = `ra-x-${crypto.randomUUID()}`;
    const xParent = await mkOfficeRun({ intentKey: xIntent });
    await query(`UPDATE agent_runs SET state = 'FAILED' WHERE run_id = $1`, [xParent]);
    await mkTask(xIntent, 'synthetic.echo');
    // A task belonging to ANOTHER company, reached through this parent's own intent lineage.
    const xKidIntent = `ra-xk-${crypto.randomUUID()}`;
    const xKid = await mkOfficeRun({ parentRunId: xParent, intentKey: xKidIntent });
    await SCOPE7.recordDelegation(objCtx7, {
      id: `ra-del-${crypto.randomUUID().slice(0, 8)}`,
      parentRunId: xParent, childRunId: xKid,
      callingAgent: 'ra-agent', targetAgent: 'ra-child-agent', workflow: 'ra-workflow',
      capability: 'exec.synthetic', autonomyTier: 'supervised',
      policyDecision: '{"tier":"supervised"}', depth: 1,
      reason: 'cross-company fixture',
    }, { query });
    await query(
      `INSERT INTO worker_tasks (id, task_type, payload, intent_key, company_id, workflow, state,
         resolved_at)
       VALUES ($1,'synthetic.echo','{}'::jsonb,$2,$3,'ra-workflow','FAILED',NOW())`,
      [`ra-xt-${crypto.randomUUID().slice(0, 8)}`, xKidIntent, CO2]);
    const other = await query('SELECT status FROM companies WHERE id = $1', [CO2]);
    if (other.rows[0].status === 'active') {
      ok(`CONTROL: the second company ${CO2} is ACTIVE too — both companies trading`);
    } else {
      bad('the second company is not active', other.rows[0]);
    }
    const crossRetry = await RECOVERY.retryRun(xParent, { overrideReason: REASON }, { query });
    if (crossRetry.retried === false && crossRetry.reason === 'cross_company_descendant') {
      ok('and the retry is REFUSED as cross-company WITH BOTH COMPANIES ACTIVE — "every company is '
        + 'trading" is not "this delegation was authorized", which is the distinction the owner '
        + 'named');
    } else {
      bad('a cross-company lineage was permitted because both companies were active',
        JSON.stringify(crossRetry).slice(0, 240));
    }

    // ══ 8. DUPLICATE-EFFECT PREVENTION, END TO END ═════════════════════════
    step('8. duplicate-effect prevention — the property all of the above exists for');

    const dup = await leaseAndAbandon('synthetic.crash_test');
    // NOT reconciled and NOT re-executable: both bars are up. Six attempts, every door.
    const tries = [];
    for (let i = 0; i < 3; i += 1) {
      tries.push(await RECOVERY.retryRun(dup.runId, { overrideReason: REASON }, { query }));
      tries.push(await RECOVERY.retryRun(dup.runId, { overrideReason: `${REASON} ${i}` }, { query }));
    }
    const anyRetried = tries.some((t) => t.retried === true);
    const finalRuns = await query(
      'SELECT COUNT(*)::int n FROM agent_runs WHERE intent_key = $1', [dup.intentKey]);
    if (!anyRetried && finalRuns.rows[0].n === 1) {
      ok('six retries with six different recorded reasons: all refused, still exactly ONE run for '
        + 'that intent. The work whose outcome is unknown AND whose type forbids redoing it is not '
        + 'redone, however many times somebody asks');
    } else {
      bad(`${tries.filter((t) => t.retried).length} of 6 retries succeeded; `
        + `${finalRuns.rows[0].n} runs exist`, JSON.stringify(tries.map((t) => t.reason)).slice(0, 200));
    }
    const reasons = [...new Set(tries.map((t) => t.reason))];
    if (reasons.length === 1) {
      ok(`and the refusal is stable: every one said ${reasons[0]} — not a race that sometimes `
        + 'refuses for one reason and sometimes another');
    } else {
      note(`refusal reasons varied: ${reasons.join(', ')} — worth reading if any is unexpected`);
    }
  } catch (e) {
    bad(`the check itself failed: ${e.message}`);
    lines.push(String(e.stack || '').split('\n').slice(1, 6).join('\n'));
  } finally {
    try { cluster.destroy(); } catch (_) { /* already gone is the desired state */ }
  }

  console.log('══ REATTEMPT AUTHORIZATION AT THE retryRun SINK ══');
  console.log(lines.join('\n'));
  console.log('');
  console.log(fail === 0
    ? `OK  (${pass} assertions)`
    : `FAILED  ${fail} assertion(s) failed, ${pass} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();
