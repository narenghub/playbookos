// ── THE WORKER TASK QUEUE — AND THE LEASE THAT IS NOT IN IT ─────────────────
//
// M7.2. Two tables, and the important thing about this file is what it does NOT create.
//
// ── THERE IS NO worker_leases TABLE, ON PURPOSE ─────────────────────────────
//
// A lease is an `agent_runs` row. That is the single biggest decision in M7.2 and it is a decision
// to build nothing.
//
// `src/lib/runs.js` already separates INTENT (what work), ATTEMPT (this physical execution) and
// ACTION (the consequential effect), with its own words on why: *"Collapsing any two of them is how
// a retry becomes a duplicate email."* A worker lease is an ATTEMPT. It needs exactly what
// agent_runs already has:
//
//   intent_key            one live attempt per task, arbitrated by uq_agent_runs_one_active
//   heartbeat_at          which the existing reaper already reads
//   max_runtime_minutes   the per-run ceiling the reaper already honours
//   attempt / predecessor_run_id / retry_override_reason
//   ABANDONED             a terminal state meaning "no outcome was established"
//
// And the index is the arbiter, which runs.js chose over advisory locks for a reason worth
// repeating: *"both are correct only while every future writer remembers to use them, and a
// forgotten lock fails silently. An index cannot be forgotten."*
//
// A parallel worker_leases table with its own partial unique index would have been a second
// implementation of run identity. The owner's instruction was *"Reuse existing infrastructure where
// possible. Do not build a second scheduler or duplicate the governance layer"* — and a second
// arbiter is the same mistake as a second scheduler.
//
// `trigger` on agent_runs carries no CHECK constraint and already holds an open vocabulary
// ('cron', 'date', 'office', 'on_launch', 'on_signature'), so a worker lease is simply
// trigger = 'worker' with trigger_detail = the worker id. No migration to agent_runs at all.
//
// ── WHAT THE EXPIRY RULE INHERITS ───────────────────────────────────────────
//
// *"Do not assume expired leases mean a task is safe to execute again."*
//
// An expired lease does not mean the work did not happen. It means NOBODY KNOWS. The reaper in
// src/lib/office/recovery.js already encodes precisely that distinction —
//
//   safe_stale      over ceiling, no unresolved consequential action  -> ABANDONED
//   known_unknown   over ceiling, WITH an unresolved action           -> ABANDONED + durable record
//   terminal                                                          -> never reclassified
//
// — and ABANDONED is in RETRY_NEEDS_OVERRIDE, so producing another attempt requires a human to
// record why they accept the ambiguity, at least MIN_OVERRIDE_REASON characters of it. The
// requirement was already built, already tested by scripts/check-office-recovery-db.js, and this
// milestone adopts it rather than restating it.
//
// On top of that, `worker_tasks.task_type` must declare itself re-executable (task-types.js), so
// an unsafe-to-repeat task is not eligible for a new attempt even WITH an override. Two
// independent gates, because the override records a judgement and the declaration records a fact.

'use strict';

/** Task lifecycle. NEEDS_RESOLUTION is the one that exists because of lease expiry. */
const TASK_STATES = Object.freeze([
  'PENDING',           // enqueued, nobody holds it
  'LEASED',            // an agent_runs attempt is live for it
  'COMPLETED',         // a result was accepted
  'FAILED',            // the worker reported failure
  'NEEDS_RESOLUTION',  // a lease expired. Outcome UNKNOWN — not "not done"
  'CANCELLED',         // withdrawn before or during execution
]);

const DDL = [
  // The queue. Created by things that already exist — the 42 cron jobs, a route, an operator — and
  // NOT by anything in this milestone. M7.2 introduces no scheduler.
  `CREATE TABLE IF NOT EXISTS worker_tasks (
     id                  TEXT PRIMARY KEY,
     task_type           TEXT NOT NULL,
     payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
     intent_key          TEXT NOT NULL,
     company_id          TEXT,
     workflow            TEXT,
     state               TEXT NOT NULL DEFAULT 'PENDING',
     cancel_requested_at TIMESTAMPTZ,
     cancel_reason       TEXT,
     created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_by          TEXT,
     resolved_at         TIMESTAMPTZ,
     resolution_note     TEXT,
     CONSTRAINT worker_tasks_state_check CHECK (state IN
       ('PENDING','LEASED','COMPLETED','FAILED','NEEDS_RESOLUTION','CANCELLED'))
   )`,

  // The intent key is the task's identity as far as run arbitration is concerned, so two tasks must
  // never share one — otherwise uq_agent_runs_one_active would treat them as the same work and
  // serialise them against each other.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_tasks_intent ON worker_tasks (intent_key)`,

  `CREATE INDEX IF NOT EXISTS idx_worker_tasks_claimable
     ON worker_tasks (created_at) WHERE state = 'PENDING' AND cancel_requested_at IS NULL`,

  // One result per LEASE, not per task. A task may legitimately have several attempts over its
  // life; each attempt may report exactly once, and the PRIMARY KEY is what enforces it rather
  // than a read-then-write. A duplicate submission is refused by Postgres, which is the same
  // discipline the outbound ledger's claim uses.
  `CREATE TABLE IF NOT EXISTS worker_results (
     run_id        UUID PRIMARY KEY,
     task_id       TEXT NOT NULL REFERENCES worker_tasks(id),
     worker_id     TEXT NOT NULL,
     status        TEXT NOT NULL,
     output        JSONB NOT NULL DEFAULT '{}'::jsonb,
     submitted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT worker_results_status_check CHECK (status IN ('SUCCEEDED','FAILED'))
   )`,

  `CREATE INDEX IF NOT EXISTS idx_worker_results_task ON worker_results (task_id, submitted_at DESC)`,

  // Finding a worker's live leases without scanning. agent_runs is not modified; this is an index
  // over columns it already has.
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_worker_live
     ON agent_runs (trigger_detail)
     WHERE trigger = 'worker' AND state IN ('CREATED','RUNNING')`,
];

const ROLLBACK = [
  `DROP INDEX IF EXISTS idx_agent_runs_worker_live`,
  `DROP INDEX IF EXISTS idx_worker_results_task`,
  `DROP TABLE IF EXISTS worker_results`,
  `DROP INDEX IF EXISTS idx_worker_tasks_claimable`,
  `DROP INDEX IF EXISTS uq_worker_tasks_intent`,
  `DROP TABLE IF EXISTS worker_tasks`,
];

/** The trigger value that marks an agent_runs row as a worker lease. */
const LEASE_TRIGGER = 'worker';

module.exports = {
  DDL, ROLLBACK, TASK_STATES, LEASE_TRIGGER,
  TABLES: { tasks: 'worker_tasks', results: 'worker_results', leases: 'agent_runs' },
};
