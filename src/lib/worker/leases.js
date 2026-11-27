// ── CLAIM, HEARTBEAT, REPORT — AND WHAT AN EXPIRED LEASE MEANS ──────────────
//
// M7.2. The worker-facing operations. Authentication is auth.js; this module assumes the caller is
// already a proven live worker and decides what that worker may do next.
//
// ── A LEASE IS AN agent_runs ROW ────────────────────────────────────────────
//
// See task-schema.js for why there is no worker_leases table. The short version: run identity
// already exists, its arbiter is a partial unique index rather than code, and a second
// implementation of it would be the duplicate-governance mistake the owner's instruction forbids.
//
// ── THE STOP IS CONSULTED AT THREE PLACES, AND THAT IS THE POINT ────────────
//
// Owner refinement 1 of 2026-11-14: registering `worker.execute` in autonomy's CAPABILITIES makes a
// stop EXPRESSIBLE and unbypassable; it does not make anything CHECK it. An earlier draft of the
// discovery document claimed a global stop would halt the worker "for free", which was wrong in
// this project's signature way.
//
//   claim()         a stopped scope grants NO lease
//   heartbeat()     mid-flight: the stop becomes a CANCEL instruction to the running worker
//   submitResult()  a result arriving after a stop is REFUSED, not absorbed
//
// The middle one is what makes cancellation real rather than a flag nobody reads. A long task that
// only checked the stop at the start would keep running through a containment event.
//
// ── AND THE RULE THAT COST THE MOST TO GET RIGHT ────────────────────────────
//
// *"Do not assume expired leases mean a task is safe to execute again."*
//
// An expired lease does NOT mean the work did not happen. It means nobody knows whether it did —
// the worker may have finished and died before reporting. Treating that as "not done, try again"
// is how one task becomes two effects, which is the OUTCOME_UNKNOWN problem from the email ledger
// in a new costume.
//
// So expiry is not a reset. The existing reaper moves the attempt to ABANDONED, this module moves
// the TASK to NEEDS_RESOLUTION, and a further attempt needs BOTH:
//
//   1. the task type to declare itself reexecutable (a fact about the work), and
//   2. an override reason recorded by a human (a judgement about the ambiguity),
//
// the second of which runs.js already enforces for an ABANDONED predecessor. Two gates, because a
// declaration and a judgement are different things and neither substitutes for the other.

'use strict';

const crypto = require('crypto');
const SCHEMA = require('./task-schema');
// B4.3 reads the claiming worker's declared capabilities, which live on worker_identities — a
// different schema module from the task tables, so it is named rather than assumed to be in
// SCHEMA.TABLES (where it is not, and the first version of this code looked for it there).
const IDENTITY_SCHEMA = require('./identity-schema');
const TYPES = require('./task-types');
const AUTH = require('./auth');

const q = (deps) => deps.query || require('../db').query;

/**
 * The server's own ceiling on a result body. Deliberately larger than the client's 64 KiB, so a
 * client at its limit is never refused by a server that happens to be stricter — the two bounds
 * are independent controls rather than one number duplicated in two places.
 */
const MAX_RESULT_BYTES = 256 * 1024;
const newTaskId = () => `wtask_${crypto.randomBytes(12).toString('hex')}`;

const refuse = (code, detail, extra = {}) => ({ ok: false, code, detail, ...extra });

async function migrateWorkerTasks(query) {
  for (const sql of SCHEMA.DDL) await query(sql);
  // The active-company guard: a task may not be enqueued for a company whose authorization has been
  // withdrawn, and the database is what says so (owner's Priority 1, 2026-11-26). Installed from
  // here as well as from migrateOffice because the trigger needs `companies` AND `worker_tasks`,
  // and these two migrations run in different orders — whichever runs last wires it, and a database
  // holding only one half gets nothing rather than an error.
  await require('../office/active-company-guard').installActiveCompanyGuard(query);
  // Migration 62, the same both-ends pattern and for the same reason: `is_synthetic` is on
  // `companies`, which this migrator may not have seen yet, and `synthetic_only` is on
  // `worker_identities`, which migrateOffice may not have seen. Whichever runs last completes it.
  await require('./synthetic-isolation').installSyntheticIsolation(query);
  return { ok: true, statements: SCHEMA.DDL.length };
}

// ── ENQUEUE ─────────────────────────────────────────────────────────────────

/**
 * Offers work to workers. Deliberately NOT a scheduler: the 42 existing cron jobs, a route or an
 * operator decide when to call this. M7.2 introduces no new timing mechanism.
 *
 * An unknown task type is refused HERE as well as at claim time. Refusing at enqueue keeps
 * unrunnable rows out of the queue; refusing at claim is what actually protects the worker, because
 * a row could be inserted by something that bypassed this function.
 */
async function enqueueTask({
  taskType, payload = {}, intentKey, companyId = null, workflow = null, createdBy = null,
} = {}, deps = {}) {
  if (!TYPES.isKnown(taskType)) {
    return refuse('unknown_task_type',
      `'${taskType}' is not in the task-type allowlist; add it deliberately in task-types.js`);
  }
  if (!intentKey) return refuse('no_intent_key', 'a task needs an intent key — it is its identity for run arbitration');

  const id = newTaskId();
  try {
    await q(deps)(
      `INSERT INTO ${SCHEMA.TABLES.tasks} (id, task_type, payload, intent_key, company_id, workflow, created_by)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
      [id, taskType, JSON.stringify(payload), String(intentKey), companyId, workflow, createdBy]);
  } catch (e) {
    if (/uq_worker_tasks_intent/.test(e.message)) {
      return refuse('duplicate_intent',
        'a task already exists for that intent key; two tasks sharing one would be serialised '
        + 'against each other by run arbitration and one would never execute');
    }
    throw e;
  }
  return { ok: true, taskId: id, taskType, intentKey: String(intentKey) };
}

// ── CLAIM ───────────────────────────────────────────────────────────────────

/**
 * Leases one task to this worker, or refuses.
 *
 * ── WHICH CONTROL ACTUALLY SERIALISES A CLAIM ──────────────────────────────
 *
 * Three things could, and it is worth being exact because an earlier draft of this comment said
 * "the unique active index is the arbiter", which overstated it:
 *
 *   UPDATE worker_tasks … WHERE state = 'PENDING'   the PRIMARY arbiter of who executes
 *   uq_agent_runs_one_active                         one LIVE attempt per intent
 *   uq_agent_runs_intent_attempt                     one row per (intent, attempt) — numbering
 *
 * scripts/check-worker-leasing-db.js removes the active index and measures what still holds, so
 * the division of labour is established rather than assumed.
 *
 * ── WHY THE LEASE IS OPENED BEFORE THE TASK IS MARKED ──────────────────────
 *
 * Two writes are needed: open the attempt, and mark the task LEASED. The order is chosen for what
 * happens if the process dies between them.
 *
 *   lease first  → an attempt exists that no task points at. The reaper sees it past its ceiling
 *                  and ABANDONS it; the task is still PENDING, so it remains claimable. Self-healing.
 *   task first   → the task says LEASED and no attempt exists. The reaper only looks at agent_runs,
 *                  so it never sees anything to recover and the task is stuck FOR EVER.
 *
 * One failure mode is transient and the other is permanent, so the order is a decision rather than
 * an accident. If the second write finds the task no longer claimable — cancelled, or taken — the
 * attempt just opened is closed immediately rather than left for the reaper.
 */
async function claimTask({ workerId, taskId = null, overrideReason = null } = {}, deps = {}) {
  const query = q(deps);
  if (!workerId) return refuse('no_worker', 'a claim must name the claiming worker');

  // ── 1. THE KILL SWITCH, BEFORE ANY WORK IS OFFERED ───────────────────────
  const gate = await AUTH.authorizeWorkerAction({ workerId }, deps);
  if (!gate.allowed) {
    return refuse('stopped',
      `worker execution is stopped at scope ${gate.stop.scope_type}`
      + `${gate.stop.scope_key ? `=${gate.stop.scope_key}` : ''}: ${gate.stop.reason}`,
      { stop: gate.stop });
  }

  // ── 2. WHAT MAY THIS WORKER EXECUTE AT ALL? (B4.1/B4.3) ──────────────────
  //
  // Owner instruction: "Hardware-only work must queue safely without consuming retry attempts or
  // being claimed by cloud workers."
  //
  // The filter is in the PICK, and that placement is the whole mechanism. A task this worker may
  // not execute is never selected, so it stays PENDING, untouched, with its attempt count
  // unchanged — "queues safely" falls out of not being chosen rather than needing a special path.
  // The alternative shape — pick it, then refuse it — would consume an attempt and record a
  // failure against work that was never wrong, which is how a correct task gets reaped.
  //
  // A worker with no declared execution capabilities may run cloud-eligible work and nothing else.
  // Fail-closed on purpose: treating an undeclared worker as able to do everything would make the
  // classification vacuous for every worker enrolled before it existed, which is all of them.
  const ident = await query(
    `SELECT capabilities, synthetic_only FROM ${IDENTITY_SCHEMA.TABLES.identities} WHERE id = $1`,
    [workerId]);
  const workerCaps = ident.rows.length ? (ident.rows[0].capabilities || []) : [];
  // MIGRATION 62 — SYNTHETIC ISOLATION, IN THE PICK FOR THE SAME REASON THE CAPABILITY FILTER IS.
  //
  // A restricted worker may claim work only for a company explicitly marked synthetic, so a task it
  // may not have is never selected and stays PENDING with its attempts unconsumed. Pick-then-refuse
  // would burn an attempt on work that was never wrong.
  //
  // **An absent identity row reads as RESTRICTED**, matching the capability filter's own fail-closed
  // reasoning one line above: an unknown worker is not a permitted one. And a task whose
  // `company_id` is NULL is excluded with no special clause, because `NULL IN (SELECT …)` is NULL
  // and never true — a task with no company cannot be isolated at all, since nobody can say whose
  // data it concerns.
  const syntheticOnly = ident.rows.length ? ident.rows[0].synthetic_only !== false : true;
  const claimable = TYPES.claimableTypesFor(workerCaps);
  if (!claimable.length) {
    return refuse('nothing_to_do',
      'this worker declares no capability matching any known task type');
  }

  // ── 3. PICK A CLAIMABLE TASK ─────────────────────────────────────────────
  // Two DIFFERENT guards sit on this path and both must stay load-bearing:
  //
  //   the capability filter  — a KNOWN type this worker may not execute is never selected, so it
  //                            stays PENDING with its attempts unconsumed (the point of B4.3);
  //   the allowlist refusal  — a row naming a type that is not in the registry at all is refused
  //                            BY NAME at claim, below, before anything executes.
  //
  // So the pick must admit an unknown type. Filtering on `task_type = ANY(claimable)` alone made
  // the second guard unreachable: an undeclared type was simply never picked, and the refusal that
  // a check asserts by name silently became non-selection. Non-selection is the right answer for
  // work belonging to another worker and the WRONG answer for a row nobody should ever run — that
  // one must be seen and named, not quietly skipped, because it is a defect in the queue and not a
  // routing decision. Hence: claimable types, OR anything the registry does not know.
  const pick = await query(
    `SELECT id, task_type, payload, intent_key, company_id, workflow
       FROM ${SCHEMA.TABLES.tasks}
      WHERE state = 'PENDING' AND cancel_requested_at IS NULL
        AND (task_type = ANY($2) OR NOT (task_type = ANY($3)))
        AND ($1::text IS NULL OR id = $1)
        AND ($4::boolean IS NOT TRUE
             OR company_id IN (SELECT id FROM companies WHERE is_synthetic))
      ORDER BY created_at
      LIMIT 1`,
    [taskId, claimable, TYPES.KNOWN, syntheticOnly]);
  if (!pick.rows.length) {
    // Distinguish "nothing to do" from "there is work, but not for this worker". The second is a
    // normal, expected state for a cloud worker while hardware-only work waits, and reporting it
    // as an empty queue would hide a backlog that an operator needs to see.
    // Only KNOWN types count as "waiting for another worker". An unknown type is not work a
    // capable worker will come along and take; it is a row that should not exist, and counting it
    // here would report a phantom backlog nobody can ever drain.
    const waiting = await query(
      `SELECT COUNT(*)::int n FROM ${SCHEMA.TABLES.tasks}
        WHERE state = 'PENDING' AND cancel_requested_at IS NULL
          AND task_type = ANY($2) AND NOT (task_type = ANY($1))`,
      [claimable, TYPES.KNOWN]);
    // Work this worker is CAPABLE of and is refused only by synthetic isolation, counted
    // separately and named. Folding it into the capability backlog above would report "waiting for
    // a worker that declares the capability" about work no capability will ever unlock, and
    // reporting nothing at all would draw a blocked queue as an idle office — which is the
    // distinction B2.9 exists to make.
    //
    // The predicate below is the exact NEGATION of the pick's, written once rather than
    // re-formulated, so the two cannot disagree about a NULL company. My first attempt used
    // IS DISTINCT FROM ANY(ARRAY(...)), which is true for almost any value and would have reported
    // the entire queue as blocked. (It also carried backticks inside a template literal, which is
    // the fifth time that has broken a file in this repository — node --check caught it in seconds.)
    if (syntheticOnly) {
      const nonSynthetic = await query(
        `SELECT COUNT(*)::int n FROM ${SCHEMA.TABLES.tasks}
          WHERE state = 'PENDING' AND cancel_requested_at IS NULL
            AND task_type = ANY($1)
            AND (company_id IN (SELECT id FROM companies WHERE is_synthetic)) IS NOT TRUE`,
        [claimable]);
      const blocked = nonSynthetic.rows[0].n;
      if (blocked > 0) {
        return refuse('nothing_claimable_synthetic_isolation',
          `${blocked} task(s) this worker is capable of executing concern companies that are not `
          + 'marked synthetic (or carry no company at all), and this worker is restricted to '
          + 'synthetic data — they remain PENDING with their attempts unconsumed. No capability '
          + 'grant will unlock them: either the company is real, or the task has no company and so '
          + 'cannot be isolated at all',
          { blockedBySyntheticIsolation: blocked, syntheticOnly: true });
      }
    }
    const n = waiting.rows[0].n;
    if (n > 0) {
      return refuse('nothing_claimable_by_this_worker',
        `${n} task(s) are waiting that this worker is not capable of executing — they remain `
        + 'PENDING with their attempts unconsumed, for a worker that declares the capability',
        { waitingForOtherWorkers: n, workerCapabilities: workerCaps });
    }
    return refuse('nothing_to_do', 'no claimable task');
  }
  const task = pick.rows[0];

  // The allowlist again, on the row as it actually is. Enqueue checked the caller's intent; this
  // checks the data, which is what the worker would actually execute.
  if (!TYPES.isKnown(task.task_type)) {
    return refuse('unknown_task_type',
      `task ${task.id} names '${task.task_type}', which is not in the allowlist — refusing before execution`);
  }

  // A task-scoped stop, now that the company and workflow are known.
  const scoped = await AUTH.authorizeWorkerAction(
    { workerId, company: task.company_id, workflow: task.workflow }, deps);
  if (!scoped.allowed) {
    return refuse('stopped',
      `this task is stopped at scope ${scoped.stop.scope_type}: ${scoped.stop.reason}`,
      { stop: scoped.stop });
  }

  // ── 3. WHICH ATTEMPT IS THIS? ────────────────────────────────────────────
  //
  // Not always 1, and getting this wrong broke the self-healing path above.
  // uq_agent_runs_intent_attempt is UNIQUE (intent_key, attempt), so attempt 1 exists at most once
  // per intent FOR EVER. A compensated attempt — opened, then closed because the task was no
  // longer claimable — consumes attempt 1 while leaving the task PENDING, so the next claim must
  // propose 2. Hard-coding 1 made the second claim of such a task raise a constraint violation
  // instead of leasing it. Found by the control in check-worker-leasing-db.js, not by review.
  //
  // And a numbered retry must carry its predecessor, because trg_agent_runs_retry_guard enforces
  // the rules on it: same intent, attempt = predecessor + 1, predecessor terminal and retryable,
  // and an override reason when the predecessor is ABANDONED or PARTIAL or has an unresolved
  // consequential action. That guard is the authority on re-attempts. Asking it is the difference
  // between reusing the governance layer and quietly building a second one.
  const prior = await query(
    `SELECT run_id, attempt, state FROM agent_runs
      WHERE intent_key = $1 ORDER BY attempt DESC LIMIT 1`,
    [task.intent_key]);
  const last = prior.rows[0] || null;

  if (last && ['CREATED', 'RUNNING'].includes(last.state)) {
    return refuse('already_leased',
      'another attempt for this task is already live; run arbitration refused a second');
  }

  // The two gates for repeating work whose outcome is unknown. The DATABASE would refuse this
  // anyway — the point of answering here is a legible refusal instead of a raised exception, and
  // the task-type declaration, which the database knows nothing about.
  if (last && ['ABANDONED', 'PARTIAL'].includes(last.state)) {
    const elig = reattemptEligibility(task.task_type, { overrideReason });
    if (!elig.eligible) return refuse(elig.code, elig.detail, { priorState: last.state });
  }

  const attempt = last ? Number(last.attempt) + 1 : 1;
  const predecessor = last ? last.run_id : null;
  const runId = crypto.randomUUID();
  const ceiling = TYPES.ceilingFor(task.task_type);
  try {
    await query(
      `INSERT INTO agent_runs
         (run_id, root_run_id, trigger, trigger_detail, workflow, agent, product,
          tenant_id, state, intent_key, attempt, predecessor_run_id, retry_override_reason,
          started_at, heartbeat_at, max_runtime_minutes)
       VALUES ($1, $1, $2, $3, $4, $5, 'playbookos', $6, 'RUNNING', $7, $8, $9, $10, NOW(), NOW(), $11)`,
      [runId, SCHEMA.LEASE_TRIGGER, workerId, task.workflow, `worker:${workerId}`,
        task.company_id, task.intent_key, attempt, predecessor,
        predecessor ? (overrideReason || null) : null, ceiling]);
  } catch (e) {
    // EITHER unique index rejecting a concurrent claim means the same thing to the caller: lost
    // the race. The first version of this caught only uq_agent_runs_one_active by name and rethrew
    // everything else, so a loser got an unhandled exception rather than a refusal.
    if (e.code === '23505' || /uq_agent_runs_(one_active|intent_attempt)/.test(e.message)) {
      return refuse('already_leased',
        'another attempt for this task was created concurrently; this one lost the race');
    }
    // The retry guard raises plain exceptions with explanatory text. Surfaced as a refusal rather
    // than a crash, with the database's own wording, which is more precise than a paraphrase.
    if (/retry|predecessor|attempt must be|override/i.test(e.message)) {
      return refuse('retry_refused', e.message, { priorState: last && last.state });
    }
    throw e;
  }

  // ── 4. MARK THE TASK, AND COMPENSATE IF IT IS NO LONGER OURS TO MARK ─────
  const marked = await query(
    `UPDATE ${SCHEMA.TABLES.tasks} SET state = 'LEASED'
      WHERE id = $1 AND state = 'PENDING' AND cancel_requested_at IS NULL
      RETURNING id`,
    [task.id]);
  if (!marked.rows.length) {
    await query(
      `UPDATE agent_runs SET state = 'STOPPED_BY_POLICY', ended_at = COALESCE(ended_at, NOW()) WHERE run_id = $1`,
      [runId]);
    return refuse('task_no_longer_claimable',
      'the task was cancelled or taken between selecting it and leasing it; the attempt just '
      + 'opened has been closed rather than left for the reaper');
  }

  return {
    ok: true,
    taskId: task.id,
    runId,
    taskType: task.task_type,
    payload: task.payload,
    leaseExpiresInMinutes: ceiling,
    heartbeatEveryMs: Math.max(15_000, Math.floor((ceiling * 60_000) / 6)),
  };
}

// ── HEARTBEAT ───────────────────────────────────────────────────────────────

/**
 * Keeps a lease alive, and is the channel through which a running task is CANCELLED.
 *
 * Returning `{ cancel: true }` is not advisory. The worker must abandon the task, and
 * submitResult() refuses a result for a cancelled or stopped lease, so a worker that ignores it
 * gains nothing — the refusal is enforced on this side rather than trusted on that one.
 */
async function heartbeat({ workerId, runId } = {}, deps = {}) {
  const query = q(deps);
  if (!workerId || !runId) return refuse('no_lease', 'a heartbeat must name the worker and the run');

  const live = await query(
    `UPDATE agent_runs SET heartbeat_at = NOW()
      WHERE run_id = $1 AND trigger = $2 AND trigger_detail = $3 AND state = 'RUNNING'
      RETURNING run_id, intent_key`,
    [runId, SCHEMA.LEASE_TRIGGER, workerId]);
  if (!live.rows.length) {
    // Either the reaper abandoned it, somebody closed it, or this worker never held it. All three
    // mean the same thing to the caller: stop working.
    return refuse('lease_not_live',
      'this lease is not live for this worker — it may have been abandoned past its ceiling, '
      + 'closed, or never held by you. Stop work on it.',
      { cancel: true });
  }

  const t = await query(
    `SELECT id, state, cancel_requested_at, cancel_reason, company_id, workflow
       FROM ${SCHEMA.TABLES.tasks} WHERE intent_key = $1`,
    [live.rows[0].intent_key]);
  const task = t.rows[0] || null;

  if (task && task.cancel_requested_at) {
    return { ok: true, cancel: true, reason: task.cancel_reason || 'cancelled by an operator' };
  }

  // ── MID-FLIGHT STOP. The requirement refinement 1 names explicitly. ──────
  const gate = await AUTH.authorizeWorkerAction(
    { workerId, company: task && task.company_id, workflow: task && task.workflow }, deps);
  if (!gate.allowed) {
    return {
      ok: true,
      cancel: true,
      reason: `stopped at scope ${gate.stop.scope_type}: ${gate.stop.reason}`,
      stop: gate.stop,
    };
  }

  return { ok: true, cancel: false };
}

// ── REPORT ──────────────────────────────────────────────────────────────────

/**
 * Accepts a result, exactly once.
 *
 * `worker_results.run_id` is the PRIMARY KEY, so a duplicate submission is refused by Postgres
 * rather than by a read-then-write that could lose a race to itself. The second submission returns
 * `{ ok: true, duplicate: true }` — the work is reported, and it is reported ONCE, which is the
 * acceptance requirement "duplicate result submissions are counted once".
 *
 * A result is a PROPOSAL. Nothing here transmits, and nothing here authorizes a transmission;
 * anything consequential goes back through dispatch.js and the approval path.
 */
async function submitResult({
  workerId, runId, status, output = {},
} = {}, deps = {}) {
  const query = q(deps);
  if (!workerId || !runId) return refuse('no_lease', 'a result must name the worker and the run');
  if (!['SUCCEEDED', 'FAILED'].includes(status)) {
    return refuse('bad_status', "status must be 'SUCCEEDED' or 'FAILED'");
  }

  // ── THE SERVER BOUNDS THE RESULT TOO, NOT ONLY THE CLIENT ────────────────
  //
  // executor.js refuses to submit output over its own limit, which protects a well-behaved worker
  // from itself. It does nothing about a worker that is compromised, modified, or simply older
  // than this limit — and "the client checks it" is a statement about the client.
  //
  // Refused rather than truncated: a stored result that is silently half a result is worse than a
  // refusal that says why, because a later reader cannot tell the difference between the two.
  let serialisedOutput;
  try { serialisedOutput = JSON.stringify(output == null ? {} : output); } catch (e) {
    return refuse('unserialisable_output', `the output could not be serialised: ${e.message}`);
  }
  const outputBytes = Buffer.byteLength(serialisedOutput, 'utf8');
  if (outputBytes > MAX_RESULT_BYTES) {
    return refuse('output_too_large',
      `the result is ${outputBytes} bytes and the limit is ${MAX_RESULT_BYTES}`, { outputBytes });
  }

  const lease = await query(
    `SELECT run_id, state, intent_key FROM agent_runs
      WHERE run_id = $1 AND trigger = $2 AND trigger_detail = $3`,
    [runId, SCHEMA.LEASE_TRIGGER, workerId]);
  if (!lease.rows.length) return refuse('not_your_lease', 'no such lease for this worker');

  const t = await query(
    `SELECT id, state, cancel_requested_at, company_id, workflow
       FROM ${SCHEMA.TABLES.tasks} WHERE intent_key = $1`,
    [lease.rows[0].intent_key]);
  const task = t.rows[0] || null;
  if (!task) return refuse('no_task', 'the lease has no task');

  // ── A RESULT ARRIVING AFTER A STOP IS REFUSED, NOT ABSORBED ──────────────
  const gate = await AUTH.authorizeWorkerAction(
    { workerId, company: task.company_id, workflow: task.workflow }, deps);
  if (!gate.allowed) {
    return refuse('stopped',
      `a result cannot be accepted while worker execution is stopped at scope `
      + `${gate.stop.scope_type}: ${gate.stop.reason}`, { stop: gate.stop });
  }
  if (task.cancel_requested_at) {
    return refuse('cancelled', 'this task was cancelled; its result is not accepted');
  }
  // ── ALREADY REPORTED? ANSWER THAT FIRST ──────────────────────────────────
  //
  // Ordering matters, and the first version got it wrong. Accepting a result closes the lease as
  // SUCCEEDED, so a duplicate submission arrived at the lease-state check below and was refused as
  // `lease_not_live` — the same code an EXPIRED lease produces. Those are different diagnoses: one
  // means "you already told us", the other means "your lease died and a human may have acted on
  // that". Conflating them would send someone debugging a crash that never happened.
  //
  // Found by the acceptance test for "duplicate result submissions are counted once", which is a
  // statement about the ANSWER as much as about the row count. The row count was always right.
  const already = await query(
    `SELECT status, submitted_at FROM ${SCHEMA.TABLES.results} WHERE run_id = $1`, [runId]);
  if (already.rows.length) {
    return { ok: true, duplicate: true, taskId: task.id, status: already.rows[0].status,
      detail: 'a result for this lease was already recorded; counted once' };
  }

  if (lease.rows[0].state !== 'RUNNING') {
    // Most often ABANDONED: the lease expired and the reaper closed it. The worker finishing
    // afterwards does NOT get to re-open it, because the task's outcome is already recorded as
    // unknown and a human may have acted on that.
    return refuse('lease_not_live',
      `this lease is ${lease.rows[0].state}, not RUNNING — a result cannot reopen a closed attempt`,
      { leaseState: lease.rows[0].state });
  }

  const inserted = await query(
    `INSERT INTO ${SCHEMA.TABLES.results} (run_id, task_id, worker_id, status, output)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (run_id) DO NOTHING
     RETURNING run_id`,
    [runId, task.id, workerId, status, serialisedOutput]);

  if (!inserted.rows.length) {
    return { ok: true, duplicate: true, taskId: task.id,
      detail: 'a result for this lease was already recorded; counted once' };
  }

  await query(
    `UPDATE agent_runs SET state = $2, ended_at = COALESCE(ended_at, NOW()) WHERE run_id = $1 AND state = 'RUNNING'`,
    [runId, status]);
  await query(
    `UPDATE ${SCHEMA.TABLES.tasks} SET state = $2, resolved_at = NOW()
      WHERE id = $1 AND state = 'LEASED'`,
    [task.id, status === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED']);

  return { ok: true, duplicate: false, taskId: task.id, status };
}

// ── CANCEL ──────────────────────────────────────────────────────────────────

async function cancelTask(taskId, { reason, actor = null } = {}, deps = {}) {
  if (!reason || String(reason).trim().length < 10) {
    return refuse('reason_required', 'a cancellation needs a reason of at least 10 characters');
  }
  const r = await q(deps)(
    `UPDATE ${SCHEMA.TABLES.tasks}
        SET cancel_requested_at = NOW(), cancel_reason = $2,
            state = CASE WHEN state = 'PENDING' THEN 'CANCELLED' ELSE state END
      WHERE id = $1 AND cancel_requested_at IS NULL
      RETURNING id, state`,
    [taskId, String(reason).trim()]);
  if (!r.rows.length) return refuse('not_cancellable', 'no such task, or it is already cancelled');
  void actor;
  // A LEASED task stays LEASED until its worker stops: the heartbeat delivers the cancellation and
  // submitResult refuses the result. Flipping it to CANCELLED here would claim the worker had
  // stopped, which nothing has established.
  return { ok: true, taskId, state: r.rows[0].state };
}

// ── WHAT AN EXPIRED LEASE LEAVES BEHIND ─────────────────────────────────────

/**
 * Bridges the existing reaper to the queue. For every worker lease the reaper has ABANDONED, the
 * task becomes NEEDS_RESOLUTION — **not** PENDING.
 *
 * That single choice is the whole requirement. PENDING would mean "nobody did this, try again",
 * and nothing has established that. NEEDS_RESOLUTION means "an attempt was made and its outcome is
 * unknown", which is the truth and is actionable by a human.
 *
 * Read-only with respect to agent_runs: the reaper owns that transition, this only reflects it.
 */
async function reflectAbandonedLeases({ limit = 200 } = {}, deps = {}) {
  const query = q(deps);
  const r = await query(
    `UPDATE ${SCHEMA.TABLES.tasks} t
        SET state = 'NEEDS_RESOLUTION',
            resolution_note = 'lease abandoned past its ceiling; outcome UNKNOWN, not "not done"'
      WHERE t.state = 'LEASED'
        AND EXISTS (
          SELECT 1 FROM agent_runs r
           WHERE r.intent_key = t.intent_key AND r.trigger = $1 AND r.state = 'ABANDONED')
        AND NOT EXISTS (
          SELECT 1 FROM agent_runs r2
           WHERE r2.intent_key = t.intent_key AND r2.trigger = $1
             AND r2.state IN ('CREATED','RUNNING'))
        AND t.id IN (SELECT id FROM ${SCHEMA.TABLES.tasks}
                      WHERE state = 'LEASED' ORDER BY created_at LIMIT $2)
      RETURNING t.id, t.task_type`,
    [SCHEMA.LEASE_TRIGGER, limit]);
  return { moved: r.rows.map((x) => ({ taskId: x.id, taskType: x.task_type })) };
}

/**
 * Closes every live lease held by a worker. Called when an identity is REVOKED.
 *
 * Owner refinement 2 of 2026-11-14: *"Revoking an identity while it holds a valid lease must
 * invalidate that lease. Otherwise revocation only takes effect the next time the worker asks for
 * work — exactly when a compromised worker would not."*
 *
 * Authentication already refuses a revoked worker, so it cannot heartbeat and the lease would
 * eventually be abandoned at its ceiling. That is up to three hours of a task pinned to a machine
 * nobody trusts any more, which is a liveness failure rather than a security one — but waiting for
 * a timeout is not what "immediate revocation" means.
 *
 * The task goes to NEEDS_RESOLUTION, NOT PENDING, for the same reason an expired lease does: the
 * revoked worker may have completed the work before being revoked, and nothing here establishes
 * that it did not.
 */
async function releaseLeasesOfWorker(workerId, { reason = 'worker identity revoked' } = {}, deps = {}) {
  const query = q(deps);
  const closed = await query(
    `UPDATE agent_runs
        SET state = 'STOPPED_BY_POLICY', ended_at = COALESCE(ended_at, NOW())
      WHERE trigger = $1 AND trigger_detail = $2 AND state IN ('CREATED','RUNNING')
      RETURNING run_id, intent_key`,
    [SCHEMA.LEASE_TRIGGER, String(workerId)]);

  if (!closed.rows.length) return { closed: [], tasks: [] };

  const intents = closed.rows.map((r) => r.intent_key).filter(Boolean);
  const tasks = await query(
    `UPDATE ${SCHEMA.TABLES.tasks}
        SET state = 'NEEDS_RESOLUTION', resolution_note = $2
      WHERE intent_key = ANY($1) AND state = 'LEASED'
      RETURNING id`,
    [intents, `lease closed: ${reason}. Outcome UNKNOWN — the worker may have completed the work.`]);

  return { closed: closed.rows.map((r) => r.run_id), tasks: tasks.rows.map((r) => r.id) };
}

/**
 * May a NEEDS_RESOLUTION task be attempted again?
 *
 * Two gates, and both must pass:
 *
 *   1. the TYPE declares itself reexecutable — a fact about the work, from task-types.js, which
 *      defaults to false for anything that has not said otherwise;
 *   2. an override reason is recorded — a judgement by a human accepting the ambiguity, which
 *      runs.js already requires for an ABANDONED predecessor (MIN_OVERRIDE_REASON characters).
 *
 * This function answers only the first and reports what the second requires. The attempt itself is
 * created by recovery.retryRun(), which owns the override enforcement — asking it rather than
 * reimplementing it is the difference between reusing the governance layer and duplicating it.
 */
function reattemptEligibility(taskType, { overrideReason = null } = {}) {
  const known = TYPES.isKnown(taskType);
  const reexecutable = TYPES.isReexecutable(taskType);
  const reasonOk = Boolean(overrideReason && String(overrideReason).trim().length >= 10);

  if (!known) {
    return { eligible: false, code: 'unknown_task_type',
      detail: `'${taskType}' is not in the allowlist` };
  }
  if (!reexecutable) {
    return { eligible: false, code: 'not_reexecutable',
      detail: `'${taskType}' does not declare itself re-executable, so a second attempt could `
        + 'duplicate an effect that may already have happened. Resolution is a human act: '
        + 'establish what the first attempt did.' };
  }
  if (!reasonOk) {
    return { eligible: false, code: 'override_reason_required',
      detail: 'an ABANDONED predecessor needs a recorded reason of at least 10 characters — the '
        + 'outcome is unknown and somebody must own accepting that' };
  }
  return { eligible: true, viaRetryRun: true,
    detail: 'create the attempt through recovery.retryRun(), which enforces the override itself' };
}

// ── READS FOR THE COMMAND CENTER (B2.9) ─────────────────────────────────────
//
// This module owns `worker_tasks`, so the counts belong here rather than in a dashboard assembling
// its own SQL. Both are company-scoped by an EQUALITY match, so an unattributed task — one whose
// company_id is NULL — is counted for nobody, exactly as `scoped-operations` treats every other
// scoped table. An unowned task in somebody's dashboard would be the cross-company leak those
// rules exist to prevent.

/** How much work is in each state for this company. */
async function taskStateCounts({ companyId } = {}, deps = {}) {
  if (!companyId) throw new Error('taskStateCounts requires a companyId');
  const r = await q(deps)(
    `SELECT state, COUNT(*)::int AS n FROM ${SCHEMA.TABLES.tasks}
      WHERE company_id = $1 GROUP BY state`, [companyId]);
  const out = {};
  for (const row of r.rows) out[String(row.state).toLowerCase()] = row.n;
  return out;
}

/** Which task types are waiting, and how many of each. The backlog, by kind of work. */
async function pendingTaskTypes({ companyId } = {}, deps = {}) {
  if (!companyId) throw new Error('pendingTaskTypes requires a companyId');
  const r = await q(deps)(
    `SELECT task_type, COUNT(*)::int AS n FROM ${SCHEMA.TABLES.tasks}
      WHERE company_id = $1 AND state = 'PENDING' AND cancel_requested_at IS NULL
      GROUP BY task_type ORDER BY task_type`, [companyId]);
  return r.rows;
}

module.exports = {
  migrateWorkerTasks,
  taskStateCounts, pendingTaskTypes,
  enqueueTask, claimTask, heartbeat, submitResult, cancelTask,
  reflectAbandonedLeases, reattemptEligibility, releaseLeasesOfWorker, MAX_RESULT_BYTES,
  newTaskId,
};
