// PlayNexa AI Office — K4: stale-run recovery and the retry entry point.
//
// ── WHY THIS IS NOT "HEARTBEAT OLDER THAN N" ─────────────────────────────────
//
// Measured before anything was designed, per the K4 ruling:
//
//   • ledger.heartbeat() has ZERO production callers. The only writer of heartbeat_at is
//     startRun(), which sets it once at CREATED -> RUNNING and never again.
//   • so COALESCE(heartbeat_at, started_at, created_at) is RUN START TIME, not liveness. The
//     existing staleRuns() read is therefore an age query wearing a liveness name.
//   • staleRuns() also only looks at RUNNING, so a run stranded in CREATED — process died between
//     createRun and startRun — is invisible to it.
//   • G7 is open: src/lib/llm.js and the nine agent files that bypass it have no AbortController.
//     A hung provider call produces an indefinitely RUNNING run, which is exactly the population
//     this file has to reason about.
//
// Consequence, stated plainly: THERE IS NO SIGNAL IN THIS SYSTEM THAT DISTINGUISHES A DEAD
// PROCESS FROM SLOW EXECUTION. Building "heartbeat older than N" on top of that would have
// invented an invariant the evidence does not support — the thing the ruling explicitly forbids.
//
// ── SO THE POLICY IS A DECLARED CEILING, PER RUN ─────────────────────────────
//
// agent_runs.max_runtime_minutes is what the CALLER declared this work should take. Exceeding it
// does not mean the run is dead; it means THE RUN DECLARED IT WOULD FINISH BY NOW AND DID NOT.
// That is a weaker claim than death and it is the strongest one available today, so the recovery
// it licenses is correspondingly conservative. Undeclared runs fall back to a per-workflow
// policy, and failing that to DEFAULT_CEILING_MINUTES — labelled below as a policy default and
// not as evidence.
//
// If per-run heartbeats or process-level liveness are introduced later, this policy tightens
// without changing shape: the eligibility predicate gets a better input. That is recorded as the
// strengthener, not built here, because K4 is "the smallest stale-run recovery mechanism".
//
// ── FOUR CLASSES, AS RULED ───────────────────────────────────────────────────
//
//   safe_stale      over ceiling, NO unresolved ACTION_ATTEMPTED  -> ABANDONED
//   known_unknown   over ceiling, unresolved ACTION_ATTEMPTED     -> ABANDONED + durable record
//   fresh           within ceiling                                -> untouched
//   terminal        SUCCEEDED/PARTIAL/FAILED/ABANDONED/STOPPED_BY_POLICY -> never reclassified
//
// WHY A KNOWN-UNKNOWN IS ALSO ABANDONED, WHICH IS A JUDGEMENT AND IS FLAGGED AS ONE.
// Leaving it non-terminal would be the conservative-looking choice and it is the dangerous one:
// uq_agent_runs_one_active means a non-terminal run PERMANENTLY BLOCKS EVERY FUTURE RUN OF THAT
// INTENT. One stranded consequential run would silently kill that workflow forever — the defect
// K4 exists to remove. ABANDONED does not manufacture certainty: it asserts "no outcome was
// recorded", which is precisely true, and it is neither SUCCEEDED nor FAILED. The ambiguity stays
// enforced where it belongs — the existing retry guard already demands a >=10 character human
// override to retry an ABANDONED predecessor OR any run with unresolved consequential actions, so
// nothing can be automatically retried over the top of it.
//
// ── CONCURRENCY ──────────────────────────────────────────────────────────────
//
// No SELECT-then-UPDATE. The UPDATE's own WHERE clause is the arbiter: it matches only a
// non-terminal state, so of N racing reapers exactly one gets a row back and the rest see zero
// and re-read the current state. Postgres row locking does the arbitration; nothing in JavaScript
// has to be correct for it to hold.
//
// ── RETRY IS NOT RESUME, AND THIS FILE INVENTS NO RETRY RULES ────────────────
//
// retryRun() creates a NEW physical run: new run_id, same intent_key, attempt + 1, predecessor
// set. The previous attempt stays terminal and immutable — attempt 1 remains historical evidence.
// Every eligibility rule is already enforced by trg_agent_runs_retry_guard in the database
// (FAILED retryable; ABANDONED/PARTIAL and unresolved actions require an override reason;
// CREATED/RUNNING/SUCCEEDED refused; intent must match; attempt must be predecessor + 1). This
// function's job is to FEED that guard correctly, not to re-decide any of it.

const { ledger } = require('../run-ledger');

const ACTIVE = ['CREATED', 'RUNNING'];

// Per-workflow ceilings. Keyed by exact workflow name. This is policy, openly: it is where an
// operator records "this work really does take that long" instead of widening a global number.
const CEILINGS = Object.freeze({
  'objective-review': 15,
  // The reaper itself. A sweep over a few hundred rows is seconds of work; if it is still going
  // after 10 minutes it is wedged, and a later sweep should say so. It cannot abandon ITSELF —
  // see excludeRunId in reap() — but a PREVIOUS wedged reaper is a legitimate candidate.
  'quarter-hourly-office-recovery': 10,
});

// A POLICY DEFAULT, NOT AN EVIDENCE-BACKED THRESHOLD. Deliberately generous: with no liveness
// signal, the cost of being wrong early (abandoning live work) is worse than being wrong late.
const DEFAULT_CEILING_MINUTES = 180;

function ceilingFor(row) {
  if (row.max_runtime_minutes != null) return Number(row.max_runtime_minutes);
  if (row.workflow && CEILINGS[row.workflow] != null) return CEILINGS[row.workflow];
  return DEFAULT_CEILING_MINUTES;
}

function lazyQuery(deps) {
  return (deps && deps.query) || require('../db').query;
}

// ── MEASUREMENT (read-only) ─────────────────────────────────────────────────
//
// Returns every non-terminal run with its age, its effective ceiling, whether it is over it, and
// its unresolved-consequential-action count. Changes nothing. This is what must be read BEFORE
// the reaper is ever pointed at production: "do not let the first production reaper invocation
// discover its policy by modifying rows."
async function candidates({ limit = 500, excludeRunId = null } = {}, deps = {}) {
  const query = lazyQuery(deps);
  const r = await query(
    `SELECT r.run_id, r.state, r.workflow, r.agent, r.product, r.intent_key, r.attempt,
            r.company_id, r.objective_id, r.max_runtime_minutes,
            r.created_at, r.started_at,
            EXTRACT(EPOCH FROM (NOW() - COALESCE(r.started_at, r.created_at))) / 60.0 AS age_minutes,
            (SELECT COUNT(*)::int FROM agent_run_events e
              WHERE e.run_id = r.run_id AND e.kind = 'ACTION_ATTEMPTED'
                AND NOT EXISTS (SELECT 1 FROM agent_run_events t
                                 WHERE t.run_id = e.run_id
                                   AND t.action_kind IS NOT DISTINCT FROM e.action_kind
                                   AND t.subject_ref IS NOT DISTINCT FROM e.subject_ref
                                   AND t.kind IN ('ACTION_SUCCEEDED','ACTION_FAILED'))
            ) AS unresolved
       FROM agent_runs r
      WHERE r.state = ANY($1)
        AND ($3::uuid IS NULL OR r.run_id <> $3::uuid)
      ORDER BY COALESCE(r.started_at, r.created_at)
      LIMIT $2`,
    [ACTIVE, Math.min(Math.max(1, limit), 1000), excludeRunId]
  );
  return r.rows.map((row) => {
    const ceiling = ceilingFor(row);
    const age = Number(row.age_minutes);
    const over = age > ceiling;
    return {
      ...row,
      age_minutes: Number(age.toFixed(2)),
      ceiling_minutes: ceiling,
      ceiling_source: row.max_runtime_minutes != null ? 'declared'
        : (row.workflow && CEILINGS[row.workflow] != null ? 'workflow_policy' : 'default'),
      over_ceiling: over,
      classification: !over ? 'fresh' : (row.unresolved > 0 ? 'known_unknown' : 'safe_stale'),
    };
  });
}

// ── RECOVERY OF ONE RUN ─────────────────────────────────────────────────────
//
// Returns { recovered: true, classification } for the single winner, or
// { recovered: false, reason, state } for everyone else. Never throws on a race.
async function recoverRun(runId, deps = {}) {
  const query = lazyQuery(deps);

  const cur = (await query(
    `SELECT run_id, state, workflow, company_id, objective_id, max_runtime_minutes, intent_key,
            created_at, started_at,
            EXTRACT(EPOCH FROM (NOW() - COALESCE(started_at, created_at))) / 60.0 AS age_minutes
       FROM agent_runs WHERE run_id = $1`, [runId]
  )).rows[0];
  if (!cur) return { recovered: false, reason: 'no_such_run' };
  if (!ACTIVE.includes(cur.state)) return { recovered: false, reason: 'already_terminal', state: cur.state };

  const ceiling = ceilingFor(cur);
  if (Number(cur.age_minutes) <= ceiling) {
    return { recovered: false, reason: 'fresh', state: cur.state, age_minutes: Number(cur.age_minutes), ceiling_minutes: ceiling };
  }

  const unresolved = (await query(
    `SELECT COUNT(*)::int n FROM agent_run_events e
      WHERE e.run_id = $1 AND e.kind = 'ACTION_ATTEMPTED'
        AND NOT EXISTS (SELECT 1 FROM agent_run_events t
                         WHERE t.run_id = e.run_id
                           AND t.action_kind IS NOT DISTINCT FROM e.action_kind
                           AND t.subject_ref IS NOT DISTINCT FROM e.subject_ref
                           AND t.kind IN ('ACTION_SUCCEEDED','ACTION_FAILED'))`, [runId]
  )).rows[0].n;
  const classification = unresolved > 0 ? 'known_unknown' : 'safe_stale';

  // THE ARBITER. Only a non-terminal row can be claimed, so exactly one racer gets a row back.
  // Deliberately NOT a SELECT followed by an UPDATE: between those two statements another reaper
  // can win, and both would then proceed to escalate.
  const claimed = await query(
    `UPDATE agent_runs
        SET state = 'ABANDONED', ended_at = COALESCE(ended_at, NOW())
      WHERE run_id = $1 AND state = ANY($2)
      RETURNING run_id, state`,
    [runId, ACTIVE]
  );
  if (!claimed.rows.length) {
    const now = (await query(`SELECT state FROM agent_runs WHERE run_id=$1`, [runId])).rows[0];
    return { recovered: false, reason: 'lost_race', state: now ? now.state : null };
  }

  // Durable, append-only, machine-queryable. An email is not a record (K4 ruling 12).
  await query(
    `INSERT INTO agent_run_events (run_id, kind, error, detail)
     VALUES ($1, 'RECOVERY_ABANDONED', $2, $3::jsonb)`,
    [runId,
     classification === 'known_unknown'
       ? `recovered as ABANDONED with ${unresolved} unresolved consequential action(s): outcome UNKNOWN, not failed`
       : null,
     JSON.stringify({
       classification,
       unresolved_actions: unresolved,
       age_minutes: Number(Number(cur.age_minutes).toFixed(2)),
       ceiling_minutes: ceiling,
       ceiling_source: cur.max_runtime_minutes != null ? 'declared' : (CEILINGS[cur.workflow] != null ? 'workflow_policy' : 'default'),
       prior_state: cur.state,
       policy: 'office/recovery: declared ceiling exceeded; ABANDONED asserts no recorded outcome, never failure',
     })]
  );

  // A known-unknown must reach a human queue, not only the ledger. office_exceptions is the K7
  // infrastructure that already exists (K4 ruling 12: adopt, do not build a second one) — but it
  // requires company_id NOT NULL and a composite FK to (run_id, company_id), so a LEGACY run
  // cannot be filed there at all. For those the append-only event above is the durable record,
  // and it is machine-queryable, which is the stated minimum.
  let exceptionId = null;
  if (classification === 'known_unknown' && cur.company_id && cur.objective_id) {
    try {
      // RESOLVED, not fabricated. office/context.js brands contexts with a module-private Symbol,
      // so a hand-built object — even one assembled from the correct row, as this was — is refused
      // by assertContext. The resolver reads the same agent_runs row, which means the company is
      // read from stored state through the one path that can vouch for it.
      const ctx = await require('./context').resolveCompanyContext({ runId: cur.run_id }, { query });
      exceptionId = `ex-recovery-${runId}`;
      await require('./scope').openException(ctx, {
        id: exceptionId,
        runId,
        source: 'office/recovery',
        reason: `run abandoned with ${unresolved} unresolved consequential action(s) — external effect may have occurred; outcome is UNKNOWN. A retry requires a recorded human override.`,
        severity: 'critical',
        slaHours: 4,
      }, deps);
    } catch (e) {
      // The ledger record above is already durable, so a queue failure must not lose the
      // classification. Reported, never swallowed silently.
      exceptionId = null;
      // eslint-disable-next-line no-console
      console.error(`[office/recovery] known-unknown ${runId} recorded in the ledger but NOT queued: ${e.message}`);
    }
  }

  return { recovered: true, classification, unresolved_actions: unresolved, exception_id: exceptionId };
}

// ── THE REAPER ──────────────────────────────────────────────────────────────
//
// dryRun is the default ON PURPOSE. A reaper whose default is to act is one accidental invocation
// away from abandoning live production work, and the K4 ruling requires the candidate list to be
// read before anything is changed.
async function reap({ limit = 100, dryRun = true, excludeRunId = null } = {}, deps = {}) {
  // excludeRunId exists because the reaper now runs INSIDE a ledger run of its own (K4
  // activation). That run is CREATED/RUNNING while it works, so without this it would appear in
  // its own candidate list and — if it ever ran longer than its ceiling — abandon itself mid-flight
  // and then keep writing against a terminal run. The scheduler passes its own runId.
  const all = await candidates({ limit, excludeRunId }, deps);
  const eligible = all.filter((c) => c.over_ceiling);
  if (dryRun) {
    return {
      dry_run: true,
      inspected: all.length,
      eligible: eligible.length,
      safe_stale: eligible.filter((c) => c.classification === 'safe_stale').length,
      known_unknown: eligible.filter((c) => c.classification === 'known_unknown').length,
      fresh: all.length - eligible.length,
      would_change: eligible.map((c) => ({
        run_id: c.run_id, state: c.state, workflow: c.workflow,
        age_minutes: c.age_minutes, ceiling_minutes: c.ceiling_minutes,
        ceiling_source: c.ceiling_source, classification: c.classification,
      })),
    };
  }
  const results = [];
  for (const c of eligible) {
    if (excludeRunId && c.run_id === excludeRunId) continue;   // belt and braces
    results.push({ run_id: c.run_id, ...(await recoverRun(c.run_id, deps)) });
  }
  return {
    dry_run: false,
    inspected: all.length,
    recovered: results.filter((r) => r.recovered).length,
    skipped: results.filter((r) => !r.recovered).length,
    results,
  };
}

// ── DECISION 2: A TASK TYPE'S PROHIBITION OUTRANKS A HUMAN OVERRIDE ─────────
//
// Owner decision, 2026-11-27: *"Implement reattemptEligibility at the actual retryRun sink. An
// ordinary human override must not bypass a hard task-type prohibition. Derive associated task
// classifications and execution outcomes from persisted authoritative records. Unknown outcomes
// require independent reconciliation. Unknown classifications fail closed."*
//
// Before this, `leases.reattemptEligibility` was called by no product code at all. It encoded
// exactly the right rule — a type that has not declared itself re-executable must not be redone,
// because a second attempt could duplicate an effect that may already have happened — and its own
// docstring delegated enforcement to `retryRun`, which never consulted it and never read
// `worker_tasks`. A gate documented as living elsewhere, with nothing at either address.
//
// ── THE LINK IS PERSISTED, NOT PASSED IN ───────────────────────────────────
//
// A worker lease IS an `agent_runs` row: `trigger = 'worker'`, `trigger_detail` the worker id, and
// `intent_key` COPIED FROM THE TASK at claim time (leases.js). `worker_tasks` carries a unique
// index on `intent_key`. So the run→task link is a stored equality between two columns, which is
// what "derive from persisted authoritative records" has to mean: nothing here accepts a task id,
// a type or an outcome from the caller, because a caller that could name the classification could
// choose the one that permits the retry.
//
// ── THE THREE OUTCOMES, AND WHY THEY ARE THREE ─────────────────────────────
//
// `known: true` with tasks — classifications read; each is checked.
// `known: true` with none — this run leased no task. Not every run is a worker lease, and a run
//     with no associated task has no type to prohibit. This is NOT the unknown case, and
//     collapsing the two would refuse every ordinary workflow retry in the name of failing closed.
// `known: false` — the records could not be READ. Fails closed, because an unreadable
//     classification is indistinguishable from a prohibited one, and the owner's rule is explicit.
//
// That middle case is the one worth stating aloud: "there are none" and "I could not tell" look the
// same in a result set and must never be treated the same. An outage is not an authorization.
// ── IS THE WORKER SCHEMA REQUIRED HERE, OR GENUINELY ABSENT? ────────────────
//
// Owner, 2026-11-27: *"Do not allow a missing worker_tasks table to silently bypass retry
// protection in an environment where that schema is required. Distinguish verified historical
// compatibility and genuinely non-worker runs from unexpected schema absence."*
//
// The previous version treated a missing `worker_tasks` as a definite "no tasks". That fixed a real
// over-refusal — check-office-recovery-db.js migrates the run ledger only, and failing closed there
// refused every retry including its own mutation control — but it traded it for a bypass: anywhere
// the table is missing UNEXPECTEDLY, the classification gate silently stops applying.
//
// The distinction is evidence, not configuration. Three signals, strongest first:
//
//   1. THE RUN IS ITSELF A WORKER LEASE (`trigger = 'worker'`). Then the schema existed when that
//      run was created, because a lease cannot be created without it. Its absence now is not a
//      non-worker environment — it is an environment that has lost a table it needs, and a retry
//      there is exactly the duplicate-effect risk the gate exists for. REFUSE.
//   2. ANOTHER WORKER TABLE IS PRESENT. `worker_identities` or `worker_enrollment_tokens` without
//      `worker_tasks` is an inconsistent schema: somebody migrated part of it, or dropped one
//      table. REFUSE, and say which table was found, because that is what an operator needs.
//   3. NO WORKER TABLE AT ALL, and the run is not a lease. This is a genuinely non-worker
//      environment — a database that has never run a worker, including the narrow harnesses and
//      any deployment that does not use them. There is no work in doubt. PERMIT, with zero tasks.
//
// Signal 3 is the one that must stay permitted, and signals 1 and 2 are why it is safe to: it is
// reached only when nothing in the database and nothing about the run suggests a worker ever ran.
const WORKER_TABLES = ['worker_tasks', 'worker_identities', 'worker_enrollment_tokens'];

async function workerSchemaState(run, deps = {}) {
  const query = lazyQuery(deps);
  let present;
  try {
    const r = await query(
      `SELECT ${WORKER_TABLES.map((t, i) => `to_regclass('${t}') IS NOT NULL AS t${i}`).join(', ')}`);
    present = WORKER_TABLES.filter((_, i) => r.rows[0] && r.rows[0][`t${i}`] === true);
  } catch (e) {
    // The catalog itself is unreachable. Not a loophole: unknown.
    return { readable: false, reason: `the table catalog could not be read (${e.message})` };
  }
  if (present.includes('worker_tasks')) return { readable: true, tasksTable: true, present };

  const isLease = run && String(run.trigger || '') === 'worker';
  if (isLease) {
    return { readable: true, tasksTable: false, required: true,
      why: 'this run IS a worker lease, so worker_tasks existed when it was created — its absence '
        + 'now is a lost table, not a non-worker environment' };
  }
  if (present.length) {
    return { readable: true, tasksTable: false, required: true,
      why: `worker_tasks is missing while ${present.join(' and ')} ${present.length > 1 ? 'are' : 'is'} `
        + 'present — an inconsistent worker schema, not an absent one' };
  }
  return { readable: true, tasksTable: false, required: false,
    why: 'no worker table exists at all and this run is not a lease, so this database has never '
      + 'held a worker task' };
}

// ── LINEAGE: A WORKFLOW IS NOT ITS IMMEDIATE TASK ───────────────────────────
//
// Owner, 2026-11-27: *"Verify parent and child execution lineage before retrying a workflow. A
// unique immediate task relationship does not establish that the entire delegated workflow is
// safely repeatable."*
//
// Exactly right, and the previous version was open to it. It read the tasks matching the
// predecessor's OWN intent_key, and `uq_worker_tasks_intent` guarantees that is at most one — which
// I reported as "a run has exactly one associated task, by design". True of the run, and
// MISLEADING about the workflow: a run that DELEGATED work has children, each its own `agent_runs`
// row with its own intent_key and its own task. Retrying the parent re-runs the subtree, so a
// prohibited task three levels down is a duplicate effect that the immediate-task check cannot see.
//
// So the descendants are walked. A recursive CTE from the predecessor over `parent_run_id` collects
// the whole delegated tree, and every task belonging to any run in it is a task this retry would
// redo. `root_run_id` is deliberately NOT used as the entry point: that would collect SIBLINGS as
// well — other branches the retry does not touch — and refusing on a sibling's prohibition would be
// a different, wrong answer.
async function lineageIntentKeys(runId, deps = {}) {
  const query = lazyQuery(deps);
  const r = await query(
    `WITH RECURSIVE tree AS (
       SELECT run_id, intent_key, 0 AS depth
         FROM agent_runs WHERE run_id = $1
       UNION ALL
       SELECT c.run_id, c.intent_key, t.depth + 1
         FROM agent_runs c JOIN tree t ON c.parent_run_id = t.run_id
        WHERE t.depth < 20
     )
     SELECT run_id, intent_key, depth FROM tree`, [runId]);
  return r.rows;
}

// ── DELEGATION AUTHORITY, NOT MERELY A LIST OF ACTIVE COMPANIES ─────────────
//
// Owner, 2026-11-27: *"Do not treat a cross-company descendant as authorized merely because every
// involved company is active. Verify the actual delegation authority and permitted scope."*
//
// A hole in the version written an hour earlier. That one gathered every company in the lineage and
// refused if any was inactive — which answers "is this company still trading" and NOT "was this
// company's work ever authorized under this parent". Company A's run having a descendant doing
// company B's work is not authorized by B being active. It is not authorized at all.
//
// ── WHAT THE PRODUCT ALREADY GUARANTEES, AND WHY THAT IS THE TEST ──────────
//
// `office/delegation.js:delegate()` takes NO companyId. Its own note: *"the company and objective
// come from the parent context... the child's own context is DERIVED rather than built."* So a
// legitimate delegation cannot cross companies — not by convention, but because there is no
// argument with which to do it. The database agrees twice over:
//
//   office_delegations_parent_same_company
//     FOREIGN KEY (parent_run_id, company_id) REFERENCES agent_runs (run_id, company_id) MATCH FULL
//   office_delegations_one_per_child UNIQUE (child_run_id)
//
// A delegation's company must equal its parent run's, and a child has at most one delegation. So a
// single-company chain is a database guarantee along every recorded edge.
//
// THEREFORE a cross-company descendant is not a delegation that needs checking — it is evidence
// that something created a child run outside `delegate()`. The honest test is not "are these
// companies active" but "is this tree what the delegation path can produce":
//
//   · more than one company across the lineage's runs and tasks → REFUSE. The chain cannot have
//     been built by delegate(), whatever the companies' statuses say.
//   · a descendant with NO recorded delegation → REFUSE. The edge exists in agent_runs and the
//     authority for it was never written down, so there is nothing establishing it was permitted.
//
// Both refuse by name, because "this work belongs to two companies" and "nobody recorded who
// authorized this child" need different operator action.
async function lineageAuthority(rootRunId, deps = {}) {
  let rows;
  try {
    // Through the accessor. check-office-scope-discipline.js refused this query here — correctly,
    // and as PRODUCT code, which that scanner never exempts. The SQL now lives in
    // scope.bootstrapLineageAuthority, which documents why it takes no resolved context: a function
    // whose job is to establish whose work this is cannot require that answer first.
    rows = await require('./scope').bootstrapLineageAuthority(rootRunId, deps);
  } catch (e) {
    // Including a missing office_delegations table: an unreadable authority is not an authority.
    return { readable: false, reason: `the delegation authority could not be read (${e.message})` };
  }

  const undelegated = rows.filter((r) => r.depth > 0 && !r.delegation_id);
  return { readable: true, rows, undelegated };
}

/**
 * Every task this retry would redo — the predecessor's own, and every descendant's.
 *
 * Takes NOTHING about the work from the caller. The run→task link is a stored equality: a lease
 * copies the task's `intent_key` into `agent_runs`, and `worker_tasks` holds a unique index on it.
 * A caller that could name a task id or a classification could name the one that permits its retry.
 */
async function associatedTasks(run, deps = {}) {
  const query = lazyQuery(deps);

  const schema = await workerSchemaState(run, deps);
  if (!schema.readable) return { known: false, reason: schema.reason };
  if (!schema.tasksTable) {
    if (schema.required) {
      return { known: false, reason: `worker_tasks is missing in an environment that requires it: `
        + `${schema.why}` };
    }
    return { known: true, tasks: [], why: schema.why };
  }

  // The lineage, when there is a run id to walk from. A bare `{ intent_key }` (the shape the unit
  // checks hand in) has no identity to recurse over, so it falls back to its own key.
  let keys;
  try {
    if (run && run.run_id) {
      const tree = await lineageIntentKeys(run.run_id, deps);
      keys = tree.map((r) => r.intent_key).filter(Boolean);
      if (!keys.length && run.intent_key) keys = [run.intent_key];
    } else {
      keys = run && run.intent_key ? [run.intent_key] : [];
    }
  } catch (e) {
    return { known: false, reason: `the execution lineage could not be read (${e.message}) — a `
      + 'retry re-runs the delegated subtree, so an unreadable lineage is an unknown scope' };
  }
  if (!keys.length) {
    return { known: true, tasks: [],
      why: 'the run carries no intent key and has no descendants that do' };
  }

  try {
    const r = await query(
      `SELECT id, task_type, state, resolved_at, resolution_note, intent_key, company_id
         FROM worker_tasks WHERE intent_key = ANY($1)`, [keys]);
    return { known: true, tasks: r.rows, lineage: keys.length };
  } catch (e) {
    return { known: false, reason: e.message };
  }
}

// ── THE COMPANY MUST STILL AUTHORIZE THE WORK (owner decision, 2026-11-27) ──
//
// *"My decision on suspended-company retry is explicit: refuse at retryRun before creating an
// executable run. Preserve a durable denial audit record and retain claim-time authorization as
// defense in depth."*
//
// §7 of check-reattempt-authorization-db.js found that retryRun created a run for a SUSPENDED
// company. No work happened — `companyStillAuthorizes` refuses at claim, heartbeat and submit — so
// it was a layered defence rather than a hole. But an executable run that exists and can never
// execute is a queue entry nobody can explain, and the decision is that the ledger refuses first.
//
// The CLAIM-TIME check is deliberately untouched. It is not redundant: it covers withdrawal that
// happens AFTER the retry run is created, which is the window this one cannot see. Two gates at two
// times, not one rule in two places.
//
// Only the company-level question is asked here. Whether a RESTRICTED worker may hold a
// non-synthetic company's task depends on which worker claims it, which is unknown at retry time
// and belongs where it already lives.
// ── WHERE THE COMPANY ACTUALLY LIVES, WHICH IS NOT WHERE I FIRST LOOKED ─────
//
// The first version read `run.company_id` and never fired: for a WORKER LEASE that column is NULL.
// `leases.js` stores the task's company in `agent_runs.tenant_id`, because the run ledger requires
// `company_id` and `objective_id` to arrive TOGETHER under MATCH FULL and a lease has no objective.
// So the check looked authoritative and measured nothing — §7b caught it by asserting the retry was
// refused and being handed `retried: true`.
//
// Reading `tenant_id` instead would be guessing: it is a general tenant column, and only the lease
// path happens to put a company id in it. The companies are taken from the TASK ROWS already being
// read — `worker_tasks.company_id` is the authoritative statement of whose data the work concerns,
// which is the same column the claim filter and the isolation boundary use.
//
// And it is a SET, not one value: the lineage walk can reach a child run whose task belongs to a
// different company. Any one withdrawal refuses the retry, for the same reason a prohibited task
// anywhere in the subtree does — the retry re-runs the whole of it.
async function companyStillAuthorizesRetry(companyIds, deps = {}) {
  const query = lazyQuery(deps);
  const ids = [...new Set((companyIds || []).filter(Boolean))];
  if (!ids.length) {
    return { ok: true, why: 'no company is named on this run or its tasks, so there is no company '
      + 'authorization to withdraw' };
  }
  let rows;
  try {
    const r = await query(
      'SELECT id, status FROM companies WHERE id = ANY($1)', [ids]);
    rows = r.rows;
  } catch (e) {
    return { ok: false, code: 'company_authorization_unreadable',
      detail: `whether ${ids.length} company(ies) still authorize this work could not be `
        + `established (${e.message}) — refusing rather than assuming they do` };
  }
  const found = new Map(rows.map((r) => [r.id, r.status]));
  for (const id of ids) {
    if (!found.has(id)) {
      return { ok: false, code: 'company_authorization_withdrawn',
        detail: `company ${id} no longer exists` };
    }
    if (found.get(id) !== 'active') {
      return { ok: false, code: 'company_authorization_withdrawn', companyId: id,
        detail: `company ${id} is ${found.get(id)}, so work for it is no longer authorized — a `
          + 'retry would create a run that can never execute' };
    }
  }
  return { ok: true, companies: ids.length };
}

/**
 * The durable denial record.
 *
 * Append-only, machine-queryable, on the PREDECESSOR run — the row that exists, because the point
 * is that no new run was created. Same table and same reasoning as `recoverRun`'s
 * RECOVERY_ABANDONED event: *"An email is not a record (K4 ruling 12)."*
 *
 * EVERY denial is recorded, not only the company one. A refusal that leaves no trace is
 * indistinguishable from a retry nobody attempted, and the question an operator asks three weeks
 * later is "why is this work not done" — answerable only if the refusals are written down.
 *
 * Best-effort by design: a failure to WRITE the audit must not turn a refusal into a permission.
 * The denial is already decided by the time this runs, and it is returned either way. The failure
 * is logged rather than swallowed, because an audit trail that is silently not being written is
 * worse than one that is absent.
 */
async function recordRetryDenial(runId, denial, deps = {}) {
  const query = lazyQuery(deps);
  try {
    await query(
      `INSERT INTO agent_run_events (run_id, kind, error, detail)
       VALUES ($1, 'RETRY_DENIED', $2, $3::jsonb)`,
      [runId, denial.detail || denial.reason || 'retry denied',
        JSON.stringify({
          reason: denial.reason || null,
          task_id: denial.taskId || null,
          task_type: denial.taskType || null,
          at: new Date().toISOString(),
        })]);
    return true;
  } catch (e) {
    console.error(`[recovery] the retry denial for ${runId} could not be recorded: ${e.message}`);
    return false;
  }
}

/**
 * May this predecessor's work be attempted again, given what its TASKS are?
 *
 * "Its tasks" means the whole delegated subtree, not the immediate one — see `associatedTasks`.
 *
 * Returns `{ permitted: true }` or `{ permitted: false, reason, detail, taskId? }`.
 *
 * Enforces the CLASSIFICATION half of `reattemptEligibility` and deliberately not the override half.
 * That gate answers two questions — "is this type re-executable" and "is there a recorded human
 * reason" — and the second is already owned authoritatively by `trg_agent_runs_retry_guard` in the
 * database. Enforcing it here as well would put one policy in two places, which is the drift this
 * module's own header warns against ("this function's job is to FEED that guard correctly, not to
 * re-decide any of it"). So `override_reason_required` is passed over here and still refuses, one
 * layer down, as `refused_by_retry_guard`.
 *
 * The type prohibition is the opposite case: nothing else enforces it, and the owner's instruction
 * is that a human override must not get past it. So it is refused here, BEFORE the guard is ever
 * reached, and the override reason is handed to the gate only so the gate's answer is about the
 * type rather than about a missing field.
 */
async function reattemptPermitted(run, { overrideReason = null } = {}, deps = {}) {
  const LEASES = (deps && deps.leases) || require('../worker/leases');
  const assoc = await associatedTasks(run, deps);
  if (!assoc.known) {
    return { permitted: false, reason: 'task_classification_unreadable',
      detail: `the associated task classifications could not be read (${assoc.reason}) — an `
        + 'unreadable classification is not a permitted one' };
  }
  if (!assoc.tasks.length) {
    // Still ask about the run's own company: a non-lease run with an objective carries one, and a
    // withdrawn company is a refusal whether or not any worker task is involved.
    const bare = await companyStillAuthorizesRetry([run && run.company_id], deps);
    if (!bare.ok) {
      return { permitted: false, reason: bare.code, detail: bare.detail };
    }
    return { permitted: true, tasks: 0, why: assoc.why || 'no associated task' };
  }

  // ── AUTHORITY BEFORE STATUS, AND BOTH BEFORE CLASSIFICATION ───────────────
  //
  // Order is deliberate. "Who authorized this tree" comes before "are its companies trading",
  // which comes before "may this type be redone" — because a tree that was never authorized is not
  // made acceptable by an active company, and a withdrawn company makes the type question moot.
  if (run && run.run_id) {
    const authority = await lineageAuthority(run.run_id, deps);
    if (!authority.readable) {
      return { permitted: false, reason: 'delegation_authority_unreadable',
        detail: authority.reason };
    }
    if (authority.undelegated.length) {
      const first = authority.undelegated[0];
      return { permitted: false, reason: 'undelegated_descendant', runId: first.run_id,
        detail: `run ${first.run_id} is a descendant at depth ${first.depth} with NO recorded `
          + 'delegation. The edge exists in agent_runs and no office_delegations row establishes '
          + 'who authorized it, so something created this child outside delegate(). A retry would '
          + 're-run work whose authority was never written down.' };
    }
  }

  // ONE COMPANY, OR NONE. Not "all active" — see lineageAuthority's note. A set of size greater
  // than one cannot have come from delegate(), whatever each company's status is.
  const companies = [...new Set([
    run && run.company_id,
    ...assoc.tasks.map((t) => t.company_id),
  ].filter(Boolean))];
  if (companies.length > 1) {
    return { permitted: false, reason: 'cross_company_descendant', companies,
      detail: `this execution lineage spans ${companies.length} companies (${companies.join(', ')}). `
        + 'delegate() derives a child\'s company from its parent and takes no companyId, and the '
        + 'database ties a delegation\'s company to its parent run under MATCH FULL — so a '
        + 'multi-company tree is not an authorized delegation regardless of whether each company '
        + 'is active. Establish how this tree was built before retrying any of it.' };
  }

  const authorized = await companyStillAuthorizesRetry(companies, deps);
  if (!authorized.ok) {
    return { permitted: false, reason: authorized.code, detail: authorized.detail,
      companyId: authorized.companyId || null };
  }

  // MIXED CLASSIFICATIONS: every task is checked and ANY prohibition refuses the whole retry. A
  // run that leased one re-executable and one prohibited task cannot be partly retried — the retry
  // is one run, and permitting it on the strength of the permissive half would redo the other.
  for (const t of assoc.tasks) {
    const elig = LEASES.reattemptEligibility(t.task_type, { overrideReason });
    if (!elig.eligible && elig.code !== 'override_reason_required') {
      return { permitted: false, reason: elig.code, taskId: t.id, taskType: t.task_type,
        detail: elig.detail };
    }
  }

  // UNKNOWN OUTCOME REQUIRES INDEPENDENT RECONCILIATION. NEEDS_RESOLUTION means an attempt was made
  // and nobody knows what it did. `leases.js` writes that state with `resolved_at = NULL`, so a
  // non-null `resolved_at` is the persisted record that somebody established what happened. Until
  // that exists, a retry is not a retry — it is a second execution of work that may be complete,
  // and the override reason cannot substitute for the finding, because the reason is a statement of
  // intent and the reconciliation is a statement of fact.
  const unreconciled = assoc.tasks.filter(
    (t) => t.state === 'NEEDS_RESOLUTION' && !t.resolved_at);
  if (unreconciled.length) {
    return { permitted: false, reason: 'outcome_requires_reconciliation',
      taskId: unreconciled[0].id,
      detail: `${unreconciled.length} associated task(s) are NEEDS_RESOLUTION with no recorded `
        + 'resolution. The outcome of the first attempt is unknown, so a second attempt could '
        + 'duplicate a completed effect. Establish what the first attempt did and record it '
        + '(worker_tasks.resolved_at / resolution_note), then retry.' };
  }

  return { permitted: true, tasks: assoc.tasks.length };
}


// ── THE RETRY ENTRY POINT ───────────────────────────────────────────────────
//
// The smallest supported path to attempt 2. Every rule is the database's; this reads the
// predecessor and hands createRun the right values. A refusal from the guard is returned, not
// translated — a rewritten error message is a second place for the policy to live.
async function retryRun(predecessorRunId, { overrideReason = null, triggerDetail = null } = {}, deps = {}) {
  const query = lazyQuery(deps);
  const p = (await query(
    `SELECT run_id, root_run_id, parent_run_id, trigger, workflow, agent, product, tenant_id,
            objective_id, company_id, actor_user_id, intent_key, attempt, state, max_runtime_minutes
       FROM agent_runs WHERE run_id = $1`, [predecessorRunId]
  )).rows[0];
  if (!p) return { retried: false, reason: 'no_such_run' };

  // Reported here rather than left to the guard only because the guard's message would name the
  // column, not the situation. The guard still enforces it — this is not the decision.
  if (!p.intent_key) {
    return { retried: false, reason: 'no_intent_key',
      detail: 'the predecessor has no intent_key, so a retry cannot be shown to be the same work' };
  }

  // K4 ruling 10: "STOPPED_BY_POLICY -> kill policy re-evaluated before retry."
  //
  // A policy stop is not a failure, and time passing does not lift it. Retrying one without
  // re-asking would walk straight through the kill switch — the one control the programme has
  // already production-validated — because the retry is a NEW run and nothing else on this path
  // consults autonomy. The scopes mirror scopesForCron's shape so one vocabulary governs both.
  if (p.state === 'STOPPED_BY_POLICY') {
    const autonomy = (deps && deps.autonomy) || require('../autonomy');
    let blocked;
    try {
      blocked = await autonomy.checkStopped(
        { workflow: p.workflow || undefined, agent: p.agent || undefined, company: p.company_id || undefined },
        { consequential: true, deps: { query } }
      );
    } catch (e) {
      // Fail closed. An unknowable kill state must not become permission to retry.
      return { retried: false, reason: 'killswitch_check_failed', detail: e.message };
    }
    if (blocked) {
      return { retried: false, reason: 'still_stopped_by_policy',
        scope_type: blocked.scope_type, scope_key: blocked.scope_key || null };
    }
  }

  // DECISIONS 2 AND 3, at the sink. After the kill-switch re-check and before anything is created:
  // neither a classification prohibition nor a withdrawn company is something a new run should
  // exist to discover. Each denial is recorded durably on the predecessor.
  const allowed = await reattemptPermitted(p, { overrideReason }, { ...deps, query });
  if (!allowed.permitted) {
    const denial = { reason: allowed.reason, detail: allowed.detail,
      taskId: allowed.taskId || null, taskType: allowed.taskType || null,
      companyId: allowed.companyId || null };
    const auditRecorded = await recordRetryDenial(predecessorRunId, denial, { ...deps, query });
    return { retried: false, ...denial, auditRecorded };
  }

  const L = (deps && deps.ledger) || ledger({ query });
  try {
    const created = await L.createRun({
      trigger: p.trigger,
      triggerDetail: triggerDetail || `retry of ${predecessorRunId} (attempt ${p.attempt})`,
      workflow: p.workflow, agent: p.agent, product: p.product, tenantId: p.tenant_id,
      objectiveId: p.objective_id, companyId: p.company_id, actorUserId: p.actor_user_id,
      intentKey: p.intent_key,
      attempt: p.attempt + 1,
      predecessorRunId,
      retryOverrideReason: overrideReason,
      rootRunId: p.root_run_id,
      parentRunId: p.parent_run_id,
    });
    if (created.duplicate) return { retried: false, reason: 'intent_already_active', intentKey: created.intentKey };
    return { retried: true, runId: created.runId, attempt: p.attempt + 1, predecessorRunId };
  } catch (e) {
    // The database refused. Surfaced verbatim: it is the authoritative policy statement.
    return { retried: false, reason: 'refused_by_retry_guard', code: e.code, detail: e.message };
  }
}

// Known-unknowns that recovery has recorded. Machine-queryable, which is the ruled minimum.
async function knownUnknownRecoveries({ limit = 200 } = {}, deps = {}) {
  const query = lazyQuery(deps);
  const r = await query(
    `SELECT e.run_id, e.at, e.error, e.detail, r.workflow, r.intent_key, r.attempt, r.state,
            r.company_id, r.objective_id
       FROM agent_run_events e JOIN agent_runs r USING (run_id)
      WHERE e.kind = 'RECOVERY_ABANDONED'
        AND (e.detail->>'classification') = 'known_unknown'
      ORDER BY e.at DESC LIMIT $1`, [Math.min(Math.max(1, limit), 1000)]
  );
  return r.rows;
}

module.exports = {
  candidates, recoverRun, reap, retryRun, knownUnknownRecoveries,
  associatedTasks, reattemptPermitted, companyStillAuthorizesRetry,
  workerSchemaState, lineageIntentKeys, recordRetryDenial, lineageAuthority,
  CEILINGS, DEFAULT_CEILING_MINUTES, ceilingFor, ACTIVE,
};
