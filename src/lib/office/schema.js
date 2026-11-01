// PlayNexa AI Office — K1 company identity + K2 objective control object (schema).
//
// THE INVARIANT (claude/k1-company-identity-design.md):
//   Every autonomous-office object belongs to exactly one company, and the set of objects
//   reachable from any single autonomous execution is confined to one company — refused by the
//   DATABASE, not by the caller.
//
// WHY COMPOSITE FOREIGN KEYS AND NOT RLS.
// PostgreSQL silently bypasses row-level security for superusers, INCLUDING under FORCE ROW
// LEVEL SECURITY. DATABASE_URL connects as `postgres`. An RLS model installed under that
// connection would evaluate every policy and skip every policy, and every test written through
// the application's own pool would pass while proving nothing. Referential integrity is the only
// enforcement here that a superuser does not bypass, that does not depend on a session variable,
// and that does not depend on the shape of the query. It fires on the write, from inside the
// engine, whoever is connected and whatever they forgot.
//
// So company_id is part of every foreign key in the kernel graph:
//
//     companies(id)
//         ^
//     objectives(id, company_id)                     UNIQUE (id, company_id)
//         ^   FK (objective_id, company_id) MATCH FULL
//     agent_runs(run_id, company_id)                 UNIQUE (run_id, company_id)
//         ^   FK (run_id, company_id) MATCH FULL
//     office_cost_ledger / office_approvals / office_exceptions / office_outcomes
//
// A run carrying company A and objective B's id does not fail a check somebody wrote. The PAIR
// (B's objective, A's company) does not exist in objectives, so the insert is refused.
//
// MATCH FULL IS NOT A DETAIL. A composite FK defaults to MATCH SIMPLE, under which the
// constraint PASSES IF ANY COLUMN IS NULL. On a legacy-nullable company_id that is an evasion:
// point objective_id at another company's objective, leave company_id NULL, and the FK never
// fires. MATCH FULL permits only all-NULL (legacy, enforced on nothing) or all-present (kernel,
// fully enforced). Mutation control M2 flips it back to prove this.
//
// LEGACY ROWS. agent_runs has live rows, so company_id there is physically nullable and NOT ONE
// EXISTING ROW IS REWRITTEN. The FK is added NOT VALID: PostgreSQL still enforces it on every
// new INSERT/UPDATE while declining to re-examine history. That is the ruled behaviour exactly —
// "new kernel writes must provide company identity" without "reclassify what is already there".
//
// WHAT MARKS A WRITE AS KERNEL WORK, AND WHY NO EXISTING WRITER BREAKS. objective_id. An
// objective only exists in the table created below, and agent_runs.objective_id has never been
// populated by any caller — so every pre-existing writer inserts both columns NULL, which
// MATCH FULL permits untouched. The one wired cron keeps running exactly as it does today. There
// is no blanket NOT NULL and no blanket trigger, because either would be enforcement over an
// existing production workflow, which K1 is explicitly not authorized to introduce.

const DDL = [
  // ---------------------------------------------------------------------------------------
  // The canonical company. A stable immutable identifier; display metadata may change, the id
  // may not. Product names, tenant strings, agent names and route labels are NOT company
  // identity and must never substitute for it.
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS companies (
     id            TEXT PRIMARY KEY,
     slug          TEXT NOT NULL UNIQUE,
     display_name  TEXT NOT NULL,
     status        TEXT NOT NULL DEFAULT 'active',
     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT companies_status_check CHECK (status IN ('active','suspended','archived'))
   )`,

  // ---------------------------------------------------------------------------------------
  // K2 — the CEO control object. Carries exactly the ruled identity and nothing invented.
  // UNIQUE (id, company_id) exists to be a composite FK target; it is not a second key.
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS objectives (
     id              TEXT PRIMARY KEY,
     company_id      TEXT NOT NULL REFERENCES companies(id),
     objective       TEXT NOT NULL,
     priority        TEXT NOT NULL,
     kpi_metric      TEXT,
     kpi_target      NUMERIC(18,4),
     deadline        DATE,
     budget_usd      NUMERIC(12,2),
     autonomy_tier   TEXT NOT NULL,
     approval_policy TEXT NOT NULL,
     status          TEXT NOT NULL DEFAULT 'draft',
     created_by      TEXT NOT NULL,
     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT objectives_priority_check CHECK (priority IN ('P0','P1','P2','P3')),
     CONSTRAINT objectives_status_check CHECK (status IN ('draft','active','paused','met','missed','cancelled')),
     -- autonomy tier is the CEO's dial. 'none' means a human does the work; 'supervised' means
     -- every consequential action is approved first; 'bounded' means within budget and policy.
     CONSTRAINT objectives_tier_check CHECK (autonomy_tier IN ('none','supervised','bounded')),
     CONSTRAINT objectives_approval_policy_check CHECK (approval_policy IN ('all_consequential','budget_threshold','none')),
     CONSTRAINT objectives_budget_check CHECK (budget_usd IS NULL OR budget_usd >= 0)
   )`,
  `ALTER TABLE objectives ADD CONSTRAINT uq_objectives_id_company UNIQUE (id, company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_objectives_company_status ON objectives (company_id, status)`,

  // ---------------------------------------------------------------------------------------
  // agent_runs — ADDITIVE ONLY. Nullable for history; welded for kernel work.
  // ---------------------------------------------------------------------------------------
  `ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS company_id TEXT REFERENCES companies(id)`,
  `ALTER TABLE agent_runs ADD CONSTRAINT uq_agent_runs_run_company UNIQUE (run_id, company_id)`,

  // The weld. NOT VALID: enforced on every new write, history never re-examined.
  `ALTER TABLE agent_runs
     ADD CONSTRAINT fk_agent_runs_objective_company
     FOREIGN KEY (objective_id, company_id) REFERENCES objectives (id, company_id)
     MATCH FULL NOT VALID`,

  // THERE IS DELIBERATELY NO COMPANY-REQUIRED TRIGGER HERE, AND THAT IS A MEASURED DECISION.
  //
  // The first version of this file added a BEFORE INSERT trigger raising a named exception when
  // objective_id and company_id disagreed about being present, on the belief that it contributed
  // the symmetric "new kernel writes must provide company identity" requirement.
  //
  // Mutation control M3 disproved that. With the trigger dropped, MATCH FULL still refused
  // company-without-objective — because MATCH FULL rejects ANY mixed-NULL state, in BOTH
  // directions. The trigger's condition was exactly MATCH FULL's condition, so it enforced
  // nothing the foreign key did not already enforce, and it could not be shown to be
  // load-bearing by any control.
  //
  // It was removed rather than relabelled. A redundant guard carrying a comment that claims an
  // invariant is worse than no guard: the next reader believes two things protect this, weakens
  // one, and the controls still pass. The cost of removal is honest and small — a mixed-NULL
  // insert now fails with a bare foreign-key violation (SQLSTATE 23503) instead of a sentence.
  //
  // So the FULL enforcement story for agent_runs is one clause: MATCH FULL on the composite FK.
  //   objective set, company NULL  → refused (mixed)
  //   company set, objective NULL  → refused (mixed)
  //   both set, wrong pair         → refused (no such pair in objectives)
  //   both NULL                    → permitted, and INERT: such a run grants no context
  //                                  (context.js) and no kernel record can attach to it, since
  //                                  every kernel FK is itself (run_id, company_id) MATCH FULL.

  // ---------------------------------------------------------------------------------------
  // Kernel records. company_id NOT NULL from creation — no "null today, populate later". The
  // tool_call_audit.tenant_id precedent produced a column that is still null and still unread.
  // Every one of these is welded to its run by (run_id, company_id) MATCH FULL, so a row cannot
  // be filed against another company's execution.
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS office_cost_ledger (
     id           BIGSERIAL PRIMARY KEY,
     company_id   TEXT NOT NULL REFERENCES companies(id),
     run_id       UUID NOT NULL,
     objective_id TEXT,
     provider     TEXT NOT NULL,
     model        TEXT NOT NULL,
     tokens_input  INTEGER,
     tokens_output INTEGER,
     cost_usd     NUMERIC(12,6) NOT NULL,
     at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT office_cost_cost_check CHECK (cost_usd >= 0),
     CONSTRAINT fk_office_cost_run_company
       FOREIGN KEY (run_id, company_id) REFERENCES agent_runs (run_id, company_id) MATCH FULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_office_cost_company_at ON office_cost_ledger (company_id, at DESC)`,

  `CREATE TABLE IF NOT EXISTS office_approvals (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES companies(id),
     run_id        UUID NOT NULL,
     objective_id  TEXT,
     action_kind   TEXT NOT NULL,
     action_payload JSONB NOT NULL,
     status        TEXT NOT NULL DEFAULT 'pending',
     owner_user_id TEXT,
     reason        TEXT NOT NULL,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     acknowledged_at TIMESTAMPTZ,
     acknowledged_by TEXT,
     resolved_at   TIMESTAMPTZ,
     resolved_by   TEXT,
     resolution    TEXT,
     CONSTRAINT office_approvals_status_check CHECK (status IN ('pending','approved','rejected','expired')),
     CONSTRAINT fk_office_approvals_run_company
       FOREIGN KEY (run_id, company_id) REFERENCES agent_runs (run_id, company_id) MATCH FULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_office_approvals_company_status ON office_approvals (company_id, status, created_at)`,

  // The exception queue. "A counter on a dashboard is not a work queue" — so every ruled field is
  // here, and an email is NOT the record: notifications point to this row, they are not it.
  `CREATE TABLE IF NOT EXISTS office_exceptions (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES companies(id),
     run_id        UUID NOT NULL,
     objective_id  TEXT,
     source        TEXT NOT NULL,
     reason        TEXT NOT NULL,
     severity      TEXT NOT NULL,
     status        TEXT NOT NULL DEFAULT 'open',
     owner_user_id TEXT,
     sla_hours     INTEGER,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     acknowledged_at TIMESTAMPTZ,
     acknowledged_by TEXT,
     resolved_at   TIMESTAMPTZ,
     resolved_by   TEXT,
     resolution    TEXT,
     CONSTRAINT office_exceptions_severity_check CHECK (severity IN ('low','medium','high','critical')),
     CONSTRAINT office_exceptions_status_check CHECK (status IN ('open','acknowledged','resolved','wont_fix')),
     CONSTRAINT fk_office_exceptions_run_company
       FOREIGN KEY (run_id, company_id) REFERENCES agent_runs (run_id, company_id) MATCH FULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_office_exceptions_company_status ON office_exceptions (company_id, status, created_at)`,

  // Workflow outcome, kept separate from execution state on purpose:
  // execution state != workflow outcome != business effect.
  `CREATE TABLE IF NOT EXISTS office_outcomes (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES companies(id),
     run_id        UUID NOT NULL,
     objective_id  TEXT,
     outcome       TEXT NOT NULL,
     business_effect TEXT,
     effect_ref    TEXT,
     at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT office_outcomes_outcome_check CHECK (outcome IN ('achieved','partial','no_effect','refused','failed')),
     CONSTRAINT fk_office_outcomes_run_company
       FOREIGN KEY (run_id, company_id) REFERENCES agent_runs (run_id, company_id) MATCH FULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_office_outcomes_company_at ON office_outcomes (company_id, at DESC)`,
];

// Statements that are idempotent only by swallowing "already exists" — ALTER TABLE ADD CONSTRAINT
// has no IF NOT EXISTS form. 42710 = duplicate_object, 42P07 = duplicate_table, 42701 =
// duplicate_column. Anything else propagates: a migration that hides a real error is worse than
// one that fails.
const IGNORABLE = new Set(['42710', '42P07', '42701']);

async function migrateOffice(query) {
  for (const stmt of DDL) {
    try {
      await query(stmt);
    } catch (e) {
      if (!IGNORABLE.has(e.code)) {
        throw new Error(`office schema failed on [${stmt.slice(0, 72).replace(/\s+/g, ' ')}…]: ${e.message}`);
      }
    }
  }
  return { ok: true };
}

// The kernel tables. The read-side architectural check (scripts/check-office-scope-discipline.js)
// reads this list, so adding a kernel table automatically brings it under that check rather than
// requiring somebody to remember to list it twice.
const KERNEL_TABLES = Object.freeze([
  'objectives',
  'office_cost_ledger',
  'office_approvals',
  'office_exceptions',
  'office_outcomes',
]);

module.exports = { migrateOffice, KERNEL_TABLES, DDL };
