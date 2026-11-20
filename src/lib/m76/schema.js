// ── M7.6 PILOT TABLES ───────────────────────────────────────────────────────
//
// Four narrow tables, deliberately NOT reusing `objectives`, `agent_activity_log` or
// `approval_queue`. A pilot that entangles production tables cannot be removed cleanly, and this
// one should be removable in a single migration — which is what ROLLBACK below is for.
//
// What is NOT here, on purpose:
//
//   • no `agent_runs` of its own. A dispatched step's run IS an `agent_runs` row, created by
//     `leases.js claimTask`, with the existing append-only `agent_run_events` as its evidence.
//     A pilot keeping a parallel run log would be a second account of the same events, and the
//     two would disagree eventually.
//   • no outcome column that can be written twice. A step's authoritative outcome lives in
//     `worker_results` and `agent_runs.state`; `m76_plan_steps.state` is a cache of where the
//     pipeline has got to, and the report is assembled from the authoritative rows.
//   • no credentials, no destinations, no recipients. The pilot cannot address anything.

'use strict';

const DDL = [
  // A goal as stated by a person. Free text, because the planner's job is to refuse what it does
  // not recognise rather than to make the operator phrase things in a DSL.
  `CREATE TABLE IF NOT EXISTS m76_goals (
     goal_id      TEXT PRIMARY KEY,
     text         TEXT NOT NULL,
     requested_by TEXT,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     state        TEXT NOT NULL DEFAULT 'STATED',
     CONSTRAINT m76_goals_state_check CHECK (state IN ('STATED','PLANNED','REFUSED','REPORTED'))
   )`,

  // A plan. `refused_reason` is populated when the policy engine or the planner refuses, and a
  // refused plan is KEPT: "we would not do that, and here is why" is the most useful record this
  // pilot produces, and deleting it would leave only the plans that happened to be allowed.
  `CREATE TABLE IF NOT EXISTS m76_plans (
     plan_id        TEXT PRIMARY KEY,
     goal_id        TEXT NOT NULL REFERENCES m76_goals(goal_id),
     planner        TEXT NOT NULL,
     state          TEXT NOT NULL DEFAULT 'PROPOSED',
     refused_reason TEXT,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT m76_plans_state_check CHECK (state IN
       ('PROPOSED','VALIDATED','REFUSED','DISPATCHED','COMPLETED','ESCALATED'))
   )`,

  // One row per step. `intent_key` is UNIQUE here as well as in `worker_tasks`, so a second
  // dispatch of the same step cannot create a second task even if the worker-side index were
  // dropped: two independent guarantees for the property idempotency depends on.
  `CREATE TABLE IF NOT EXISTS m76_plan_steps (
     plan_id    TEXT NOT NULL REFERENCES m76_plans(plan_id),
     step_id    TEXT NOT NULL,
     ordinal    INTEGER NOT NULL,
     step_type  TEXT NOT NULL,
     task_type  TEXT NOT NULL,
     payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
     intent_key TEXT NOT NULL UNIQUE,
     task_id    TEXT,
     state      TEXT NOT NULL DEFAULT 'PLANNED',
     note       TEXT,
     PRIMARY KEY (plan_id, step_id),
     CONSTRAINT m76_plan_steps_state_check CHECK (state IN
       ('PLANNED','DISPATCHED','SUCCEEDED','FAILED','ESCALATED'))
   )`,

  // The artifact. `evidence` carries the ids that make the report checkable by someone who does
  // not trust it: plan, steps, tasks, runs, worker. A report without that is an assertion.
  `CREATE TABLE IF NOT EXISTS m76_reports (
     report_id  TEXT PRIMARY KEY,
     plan_id    TEXT NOT NULL REFERENCES m76_plans(plan_id),
     as_of      DATE NOT NULL,
     body       JSONB NOT NULL,
     evidence   JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `CREATE INDEX IF NOT EXISTS idx_m76_plans_goal ON m76_plans (goal_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_m76_reports_plan ON m76_reports (plan_id, created_at DESC)`,
];

// Removable in one step, in dependency order. The pilot is a pilot.
const ROLLBACK = [
  `DROP INDEX IF EXISTS idx_m76_reports_plan`,
  `DROP INDEX IF EXISTS idx_m76_plans_goal`,
  `DROP TABLE IF EXISTS m76_reports`,
  `DROP TABLE IF EXISTS m76_plan_steps`,
  `DROP TABLE IF EXISTS m76_plans`,
  `DROP TABLE IF EXISTS m76_goals`,
];

const TABLES = Object.freeze(['m76_goals', 'm76_plans', 'm76_plan_steps', 'm76_reports']);

async function migrate(deps = {}) {
  const query = (deps && deps.query) || require('../db').query;
  for (const stmt of DDL) await query(stmt);
  return { applied: DDL.length };
}

module.exports = { DDL, ROLLBACK, TABLES, migrate };
