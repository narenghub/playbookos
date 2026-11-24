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

module.exports = { migrateIdentity, DDL, IDENTITY_TABLES: Object.freeze(['user_companies', 'workflow_companies']) };
