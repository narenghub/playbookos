// ── IDENTITY SCHEMA: WHO WORKS FOR WHICH COMPANY ────────────────────────────
//
//   require('./schema').migrateIdentity(query)
//
// Separate from src/lib/office/schema.js, and separate for a reason it cost a preflight run to
// learn. `user_companies` carries a foreign key to `users`, which src/lib/db.js initDB() creates.
// Putting the table in the office kernel's DDL coupled the K1 migration to a core table, so every
// harness that migrates the kernel ALONE — ten of them — died on `relation "users" does not exist`.
//
// In production the order is fine (initDB is schema step 1, the kernel is step 9). The coupling was
// still wrong: the office kernel is objectives, cost, approvals and outcomes, and this is identity.
// Its own module, its own migration step, ordered after core tables.
//
// The loud failure was correct behaviour and worth keeping: 42P01 is NOT among migrateOffice's
// ignorable codes, so a wrong order fails rather than silently skipping the table that decides
// company access. A silent skip here would have produced a system where every membership lookup
// returned nothing and every company refused — which reads exactly like "nobody is employed".

'use strict';

const DDL = [
  // ---------------------------------------------------------------------------------------
  // WHO WORKS FOR WHICH COMPANY. Owner ruling 2026-11-24, B7.8.
  //
  // Until now there was no user-to-company mapping anywhere in this system — not a column on
  // users, not a membership table. src/lib/office/context.js
  // resolveCompanyForReadSession REFUSED rather than guess, and said so: "when that day comes the
  // fix is a real user-to-company mapping, which is a ruling, not a patch here." This is that
  // table. It is deliberately NOT email-specific: PlayNexa runs ABIOZEN, Adifice, Favly, Linkabl
  // and GolfNex, and the same authorization foundation is to carry agent memory, task assignment,
  // document access and delegation.
  //
  // MANY-TO-MANY, because a shared employee genuinely works for two companies and the alternative
  // — a company column on users — cannot express that without duplicating the person.
  //
  // WHAT EACH COLUMN IS FOR, since every one of them answers a ruled requirement:
  //   company_role    a role WITHIN this company. The same person may be an admin of one and a
  //                   contributor to another; `users.role` is the global account role and cannot
  //                   express that.
  //   status          'active' | 'revoked'. Revocation is scoped: revoking ABIOZEN must not touch
  //                   the same person's Adifice membership, so revocation lives on the membership
  //                   row and never on the user.
  //   effective_from  / effective_to — a membership that starts or ends on a date, so a transfer
  //                   is recorded rather than deleted and history survives.
  //   granted_by      / revoked_by / *_reason — audit attribution. A membership is an access
  //                   grant; who made it is part of the record, not metadata.
  //
  // NOTHING HERE INFERS A MEMBERSHIP. There is no email-domain rule and no default company:
  // common ownership does not imply access, so every membership is an explicit row somebody is
  // accountable for.
  //
  // The partial unique index allows exactly one ACTIVE membership per (person, company) while
  // keeping every revoked and expired row. A plain UNIQUE would have forced deleting history to
  // re-grant access.
  //
  // DELIBERATELY NOT in KERNEL_TABLES. That list routes a table through src/lib/office/scope.js,
  // whose predicate is the company scope — and this is the table that DECIDES company scope, so
  // reading it through the thing it authorizes is circular. It gets the same single-accessor
  // discipline from its own module and its own check instead:
  // src/lib/identity/company-membership.js, enforced by
  // scripts/check-membership-accessor-discipline.js.
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS user_companies (
     id              TEXT PRIMARY KEY,
     user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
     company_role    TEXT NOT NULL,
     status          TEXT NOT NULL DEFAULT 'active',
     effective_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     effective_to    TIMESTAMPTZ,
     granted_by      TEXT NOT NULL,
     granted_reason  TEXT,
     revoked_at      TIMESTAMPTZ,
     revoked_by      TEXT,
     revoked_reason  TEXT,
     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT user_companies_status_check CHECK (status IN ('active','revoked')),
     -- A revoked row MUST carry when and by whom, and an active row must carry neither. Without
     -- this, "revoked" becomes a label that a half-finished write can leave behind with no record
     -- of who removed the access.
     CONSTRAINT user_companies_revocation_recorded CHECK (
       (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
       OR (status = 'active' AND revoked_at IS NULL AND revoked_by IS NULL)
     ),
     CONSTRAINT user_companies_window CHECK (effective_to IS NULL OR effective_to > effective_from)
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS user_companies_one_active
     ON user_companies (user_id, company_id) WHERE status = 'active'`,

  `CREATE INDEX IF NOT EXISTS user_companies_by_company
     ON user_companies (company_id) WHERE status = 'active'`,

  // ---------------------------------------------------------------------------------------
  // WHICH COMPANY A SCHEDULED WORKFLOW ACTS FOR. Owner decision 2026-11-24: Option A, the
  // transitional bridge to governed runs (Option B).
  //
  // THE PROBLEM THIS SOLVES. Agent work resolves its company from the run row, and a person's
  // session resolves it from their membership. A CRON has neither: no authenticated subject, no
  // run. The 7am CEO briefing, the 8am assignments and the 6pm coaching mail are exactly those,
  // and without a company they cannot be classified as internal — so they stay stopped no matter
  // what else is fixed.
  //
  // WHAT IT IS NOT. It is not a default, not "the only active company", and not derived from an
  // email domain. Each row is an explicit authorization somebody is accountable for, which is the
  // same rule as user_companies: deriving a company from a mailbox is the inference that stopped
  // all company email on 2026-11-03.
  //
  // MULTIPLE COMPANIES ARE ROWS, NOT A CHOICE AT RUN TIME. A workflow authorized for two companies
  // gets two rows, and the scheduler runs it once per company — separate company-scoped
  // executions, so a single run never spans tenants and a resolver never has to pick. The
  // resolver therefore REFUSES on ambiguity rather than selecting.
  //
  // TRANSITIONAL BY DESIGN. Option B migrates these workflows into governed runs; when a workflow's
  // governed replacement is verified, its mapping row is revoked and the bridge is gone for that
  // workflow. `retired_for_governed_run` records that this is why, so retirement is visible rather
  // than looking like a revoked authorization.
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS workflow_companies (
     id                        TEXT PRIMARY KEY,
     workflow                  TEXT NOT NULL,
     company_id                TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
     status                    TEXT NOT NULL DEFAULT 'active',
     effective_from            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     effective_to              TIMESTAMPTZ,
     granted_by                TEXT NOT NULL,
     granted_reason            TEXT,
     revoked_at                TIMESTAMPTZ,
     revoked_by                TEXT,
     revoked_reason            TEXT,
     retired_for_governed_run  BOOLEAN NOT NULL DEFAULT FALSE,
     created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT workflow_companies_status_check CHECK (status IN ('active','revoked')),
     CONSTRAINT workflow_companies_revocation_recorded CHECK (
       (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
       OR (status = 'active' AND revoked_at IS NULL AND revoked_by IS NULL)
     ),
     CONSTRAINT workflow_companies_window CHECK (effective_to IS NULL OR effective_to > effective_from)
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS workflow_companies_one_active
     ON workflow_companies (workflow, company_id) WHERE status = 'active'`,

  `CREATE INDEX IF NOT EXISTS workflow_companies_by_workflow
     ON workflow_companies (workflow) WHERE status = 'active'`,
];

async function migrateIdentity(query) {
  for (const stmt of DDL) {
    try {
      await query(stmt);
    } catch (e) {
      // Same narrow ignorable set as the office kernel: duplicate object, duplicate table,
      // duplicate column. A missing dependency (42P01) is NOT ignorable — see the header.
      if (!['42710', '42P07', '42701'].includes(e.code)) {
        throw new Error(`identity schema failed on [${stmt.slice(0, 72).replace(/\s+/g, ' ')}…]: ${e.message}`);
      }
    }
  }
  return { ok: true };
}

// ── B7.21: COMPANY OWNERSHIP ON THE OPERATIONAL RECORDS ─────────────────────
//
// Owner instruction: "Filtering employees alone is insufficient. The underlying tasks, orders,
// objectives and performance records must also belong to the authorized company."
//
// Measured: thirteen operational tables carried no company ownership of any kind. This adds it to
// the ones the eight named areas actually read. The policy — which table can be attributed how, and
// which cannot be attributed at all — lives in src/lib/identity/record-ownership.js.
//
// ── NULLABLE, AND THAT IS THE POINT ─────────────────────────────────────────
//
// `company_id` is added NULLABLE, with no default and no backfill. A NOT NULL column would have
// forced a value onto every existing row, and the only values available are guesses — exactly what
// "do not infer ownership or silently assign ambiguous records to ABIOZEN" forbids.
//
// NULL therefore means "ownership not yet established", and the accessor treats that as visible to
// NO company rather than to all. The NOT NULL constraint arrives with the reviewed attribution,
// once there is something true to put in the column.
const OWNERSHIP_DDL = [
  // One statement per table rather than a loop, so each is visible in a diff and a failure names
  // the table it failed on.
  `ALTER TABLE daily_tasks        ADD COLUMN IF NOT EXISTS company_id TEXT REFERENCES companies(id) ON DELETE RESTRICT`,
  `ALTER TABLE performance_scores ADD COLUMN IF NOT EXISTS company_id TEXT REFERENCES companies(id) ON DELETE RESTRICT`,
  `ALTER TABLE weekly_kpis        ADD COLUMN IF NOT EXISTS company_id TEXT REFERENCES companies(id) ON DELETE RESTRICT`,
  `ALTER TABLE activity_logs      ADD COLUMN IF NOT EXISTS company_id TEXT REFERENCES companies(id) ON DELETE RESTRICT`,
  `ALTER TABLE milestones         ADD COLUMN IF NOT EXISTS company_id TEXT REFERENCES companies(id) ON DELETE RESTRICT`,
  `ALTER TABLE targets            ADD COLUMN IF NOT EXISTS company_id TEXT REFERENCES companies(id) ON DELETE RESTRICT`,
  `ALTER TABLE orders             ADD COLUMN IF NOT EXISTS company_id TEXT REFERENCES companies(id) ON DELETE RESTRICT`,

  // Every company-scoped read filters company_id first, so it leads each index.
  `CREATE INDEX IF NOT EXISTS daily_tasks_by_company        ON daily_tasks (company_id)`,
  `CREATE INDEX IF NOT EXISTS performance_scores_by_company ON performance_scores (company_id, score_date DESC)`,
  `CREATE INDEX IF NOT EXISTS weekly_kpis_by_company        ON weekly_kpis (company_id, week_start DESC)`,
  `CREATE INDEX IF NOT EXISTS activity_logs_by_company      ON activity_logs (company_id, log_date DESC)`,
  `CREATE INDEX IF NOT EXISTS milestones_by_company         ON milestones (company_id)`,
  `CREATE INDEX IF NOT EXISTS targets_by_company            ON targets (company_id)`,
  `CREATE INDEX IF NOT EXISTS orders_by_company             ON orders (company_id, order_date DESC)`,

  // ── performance_scores: ONE SCORE PER PERSON PER DAY BLOCKED SHARED EMPLOYEES ──
  //
  // MEASURED while verifying this change: `UNIQUE(user_id, score_date)`. So a shared employee
  // CANNOT hold two scores for one day — one for ABIOZEN and one for Adifice — and per-company
  // performance scoring for them was structurally impossible, not merely unimplemented. Prasanthi
  // is an admin of both companies; her Tuesday could only ever have one score, belonging to
  // whichever workflow wrote first.
  //
  // THE SAME NULL TRAP as metrics_snapshots below, and it is worth stating twice because it is the
  // kind of widening that looks obviously right: replacing the constraint with
  // UNIQUE(user_id, score_date, company_id) would let the SAME person accumulate unlimited
  // NULL-company scores for one day, because NULLs are distinct in a Postgres unique index. Two
  // partial indexes keep both guarantees:
  //   · one UNATTRIBUTED score per person per day (company_id IS NULL) — the legacy shape, intact
  //   · one score per person per company per day  (company_id IS NOT NULL) — what B7.21 needs
  `ALTER TABLE performance_scores DROP CONSTRAINT IF EXISTS performance_scores_user_id_score_date_key`,
  `CREATE UNIQUE INDEX IF NOT EXISTS performance_scores_one_unattributed_per_day
     ON performance_scores (user_id, score_date) WHERE company_id IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS performance_scores_one_per_company_per_day
     ON performance_scores (user_id, score_date, company_id) WHERE company_id IS NOT NULL`,

  // ── metrics_snapshots: THE AGGREGATE THAT CANNOT BE SPLIT ────────────────
  //
  // It was `snapshot_date TEXT NOT NULL UNIQUE` — one row per day for the whole platform, built by
  // summing orders and averaging scores across every company. An aggregate cannot be decomposed
  // back into its parts, so the existing rows are PORTFOLIO-level and always were; labelling them
  // ABIOZEN's would be the silent assignment the owner forbids.
  //
  // THE TRAP, AND WHY TWO PARTIAL INDEXES RATHER THAN ONE WIDER KEY. Replacing
  // UNIQUE(snapshot_date) with UNIQUE(snapshot_date, company_id) is the obvious widening and would
  // have DESTROYED the daily guarantee: in Postgres NULLs are distinct in a unique index, so every
  // existing portfolio row — all of which have company_id NULL — would have been free to
  // duplicate. Two partial indexes keep both guarantees exactly:
  //   · one portfolio row per day   (company_id IS NULL)
  //   · one row per company per day (company_id IS NOT NULL)
  `ALTER TABLE metrics_snapshots ADD COLUMN IF NOT EXISTS company_id TEXT REFERENCES companies(id) ON DELETE RESTRICT`,
  `ALTER TABLE metrics_snapshots DROP CONSTRAINT IF EXISTS metrics_snapshots_snapshot_date_key`,
  `CREATE UNIQUE INDEX IF NOT EXISTS metrics_snapshots_one_portfolio_per_day
     ON metrics_snapshots (snapshot_date) WHERE company_id IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS metrics_snapshots_one_company_per_day
     ON metrics_snapshots (snapshot_date, company_id) WHERE company_id IS NOT NULL`,
];

async function migrateRecordOwnership(query) {
  for (const stmt of OWNERSHIP_DDL) {
    try {
      await query(stmt);
    } catch (e) {
      // The same narrow ignorable set as the rest of this file. 42P01 — a missing table — is NOT
      // ignorable: these ALTERs depend on core tables from initDB and on `companies` from the
      // office kernel, and a silent skip would leave the column absent while every scoped read
      // quietly returned nothing, which reads exactly like "this company has no data".
      if (!['42710', '42P07', '42701'].includes(e.code)) {
        throw new Error(`record-ownership schema failed on [${stmt.slice(0, 72).replace(/\s+/g, ' ')}…]: ${e.message}`);
      }
    }
  }
  return { ok: true };
}

module.exports = {
  migrateIdentity, DDL,
  migrateRecordOwnership, OWNERSHIP_DDL,
  IDENTITY_TABLES: Object.freeze(['user_companies', 'workflow_companies']),
};
