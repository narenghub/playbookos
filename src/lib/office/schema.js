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
  // ── THE COMPANY IDENTIFIER IS IMMUTABLE, AND IT WAS NOT ───────────────────
  //
  // K1's design says "use a stable immutable company identifier" and the K1 record claimed the id
  // could not be changed. NEITHER WAS ENFORCED. The foreign keys default to NO ACTION, so an id
  // change is refused only ONCE SOMETHING REFERENCES IT — an unreferenced company's id was freely
  // mutable, and a company that has just been created is exactly the unreferenced case.
  //
  // Found on 1 Nov 2026 by a probe in office-create-first-objective.js that attempted the change
  // on PRODUCTION expecting a refusal. The refusal did not come, the write landed, and only a
  // restore line undid it. That probe has been removed and replaced with a structural check: a
  // verification must not perform the mutation it predicts will fail.
  //
  // The SLUG stays mutable on purpose: renaming "Abiozen LLC" is a display change. The id is the
  // isolation boundary that every composite foreign key depends on, and re-pointing it would
  // silently re-attribute every row that referenced it.
  `CREATE OR REPLACE FUNCTION office_companies_id_immutable() RETURNS TRIGGER AS $fn$
   BEGIN
     IF NEW.id IS DISTINCT FROM OLD.id THEN
       RAISE EXCEPTION 'a company identifier is immutable: % may not become % — it is the isolation boundary every composite foreign key depends on (rename display_name or slug instead)', OLD.id, NEW.id;
     END IF;
     RETURN NEW;
   END;
   $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_office_companies_id_immutable ON companies`,
  `CREATE TRIGGER trg_office_companies_id_immutable
     BEFORE UPDATE ON companies
     FOR EACH ROW EXECUTE FUNCTION office_companies_id_immutable()`,

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

  // K2 — COMPANY AND OBJECTIVE ARE IDENTITY, NOT STATE.
  //
  // MATCH FULL governs what may be INSERTED. It does not stop an UPDATE from re-pointing a run at
  // another company's objective afterwards, and it does not stop a legacy both-NULL run being
  // PROMOTED into the kernel by a later UPDATE. Either would make "this run executed for exactly
  // this company against exactly this objective" defeasible after the fact — which is the entire
  // evidentiary value of the pair.
  //
  // IS DISTINCT FROM is deliberate: it refuses NULL -> value as well as value -> other value, so
  // the INSERT is the only moment company identity can be established, and a legacy run stays
  // legacy forever.
  //
  // THIS LIVES HERE, NOT IN runs.js, AND THAT IS A MEASURED DECISION. It was first written into
  // agent_runs_transition_guard() in src/lib/runs.js, where it broke three preflight checks: those
  // checks apply migrateRuns WITHOUT migrateOffice, so agent_runs has no company_id column there
  // and the trigger body referenced a column that did not exist — every UPDATE failed. The column
  // is created by this file, so its guard belongs in this file. A second BEFORE UPDATE trigger on
  // the same table is fine; both fire.
  `CREATE OR REPLACE FUNCTION office_runs_company_immutable() RETURNS TRIGGER AS $fn$
   BEGIN
     IF NEW.company_id IS DISTINCT FROM OLD.company_id
        OR NEW.objective_id IS DISTINCT FROM OLD.objective_id THEN
       RAISE EXCEPTION 'company identity is immutable: company_id (% -> %) and objective_id (% -> %) are fixed at INSERT and may never be changed',
         OLD.company_id, NEW.company_id, OLD.objective_id, NEW.objective_id;
     END IF;
     RETURN NEW;
   END;
   $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_office_runs_company_immutable ON agent_runs`,
  `CREATE TRIGGER trg_office_runs_company_immutable
     BEFORE UPDATE ON agent_runs
     FOR EACH ROW EXECUTE FUNCTION office_runs_company_immutable()`,

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

  // ── C1 AT THE STORAGE LAYER: UNKNOWN COST MUST BE STORABLE ────────────────
  //
  // cost_usd was NOT NULL, so an unmeasurable call could not be recorded as unknown AT ALL — the
  // only way to file it was as 0, which is precisely what the ruling forbids. Fixing costOf() in
  // llm.js without this would have pushed the lie one layer down.
  //
  // The CHECK makes the two states mutually exclusive in the database, the same shape as
  // rfq_identity_decisions' refusal constraint: a row cannot claim to know a cost it does not
  // have, and cannot carry a cost while claiming not to know it.
  `ALTER TABLE office_cost_ledger ALTER COLUMN cost_usd DROP NOT NULL`,
  `ALTER TABLE office_cost_ledger ADD COLUMN IF NOT EXISTS cost_known BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE office_cost_ledger ADD CONSTRAINT office_cost_known_shape CHECK (
     (cost_known AND cost_usd IS NOT NULL) OR (NOT cost_known AND cost_usd IS NULL))`,
  // Attribution the ruling requires alongside provider/model: which agent and workflow spent it.
  `ALTER TABLE office_cost_ledger ADD COLUMN IF NOT EXISTS agent TEXT`,
  `ALTER TABLE office_cost_ledger ADD COLUMN IF NOT EXISTS workflow TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_office_cost_unknown ON office_cost_ledger (company_id, at DESC)
     WHERE NOT cost_known`,

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
  // ── A DECISION WITHOUT A RECORDED REASON IS NOT AN AUDIT TRAIL ────────────
  //
  // office_approvals carried `reason` — why the action NEEDS a human — but nothing recorded why
  // the human decided as they did. An incident review asking "why was this supplier contacted" or
  // "why was this rejected" found a status and a name and no answer, which is the same gap
  // autonomy.stop's mandatory reason exists to close.
  `ALTER TABLE office_approvals ADD COLUMN IF NOT EXISTS resolution TEXT`,

  // ── AUTHORIZATION, EXECUTION ATTEMPT AND PROVIDER ACK ARE THREE FACTS ─────
  //
  // Ruling §2. `released_at` was written by the arbitrated release claim BEFORE the supplier claim
  // and before the mailer, so a crash after it left a row saying "released" when the supplier had
  // received nothing. One timestamp cannot honestly mean human authorization, executor
  // responsibility and provider acceptance at once.
  //
  // The three facts now live in three places, and none of them is inferred from another:
  //
  //   authorization        office_approvals.status='approved' + resolved_at / resolved_by
  //   execution claimed    office_approvals.release_claimed_at / release_claimed_by  (below)
  //   attempt evidence     agent_run_events ACTION_ATTEMPTED (throws if it cannot persist)
  //   provider accepted    supplier_outreach_log.provider_accepted_at / provider_message_id
  //
  // `released_at` is RETAINED and kept in step with release_claimed_at, because existing checks and
  // the arbitration predicate reference it, but it means ONLY "the executor claimed the right to
  // attempt this" — never "the supplier received it".
  `ALTER TABLE office_approvals ADD COLUMN IF NOT EXISTS release_claimed_at TIMESTAMPTZ`,
  `ALTER TABLE office_approvals ADD COLUMN IF NOT EXISTS release_claimed_by TEXT`,

  // ── 'superseded' IS A DIFFERENT FACT FROM 'rejected' ──────────────────────
  //
  //   rejected    the proposed action reached the human decision boundary and the decision-maker
  //               declined it.
  //   superseded  the action WAS approved, and before external execution a later governance,
  //               identity, policy, configuration or factual correction made that approved action
  //               no longer executable as prepared.
  //
  // Reusing 'rejected' for the second would rewrite the first fact to represent the second. Both
  // are true of the Hetero approval and they are not the same sentence: the CEO did approve that
  // exact payload at that time, AND a newly enforced sender-provenance invariant later made it
  // ineligible. An evidence trail that cannot say both says the wrong one.
  //
  // THE SUPERSESSION IS RECORDED BESIDE THE ORIGINAL DECISION, NOT OVER IT. `resolution` holds the
  // approver's own words and is never touched here — overwriting it to add a terminal status would
  // trade the original decision evidence for the correction, which is exactly backwards.
  `ALTER TABLE office_approvals DROP CONSTRAINT IF EXISTS office_approvals_status_check`,
  `ALTER TABLE office_approvals ADD CONSTRAINT office_approvals_status_check
     CHECK (status IN ('pending','approved','rejected','expired','superseded'))`,
  `ALTER TABLE office_approvals ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ`,
  `ALTER TABLE office_approvals ADD COLUMN IF NOT EXISTS superseded_by TEXT`,
  `ALTER TABLE office_approvals ADD COLUMN IF NOT EXISTS superseded_reason TEXT`,
  // What it was before, so the transition is legible without reconstructing it from timestamps.
  `ALTER TABLE office_approvals ADD COLUMN IF NOT EXISTS previous_status TEXT`,

  // ── §16: FIRST-SEND BEHAVIOUR IS DURABLE POLICY, NOT A MISSING CALLER ─────
  //
  // "Do not implement the first-send two-act policy as 'we just won't call it automatically yet.'"
  // So it is stored per objective and the executor reads it. 'explicit' means approval authorizes
  // but a separate human RELEASE is required; 'on_approval' means the executor may release once a
  // human has approved. Promotion is a deliberate, visible configuration change.
  `ALTER TABLE objectives ADD COLUMN IF NOT EXISTS release_mode TEXT NOT NULL DEFAULT 'explicit'`,
  `ALTER TABLE objectives ADD CONSTRAINT objectives_release_mode_check
     CHECK (release_mode IN ('explicit','on_approval'))`,

  // ── K7: THE THING APPROVED IS THE THING SENT ──────────────────────────────
  //
  // release() returns the STORED payload, so by construction the sent artefact is the approved
  // one — provided the stored payload cannot change after a human looked at it. Without this an
  // operator could approve email text A and email text B could be released, and every row would
  // still read "approved".
  //
  // action_kind is frozen too: approving "draft_rfq_email" must not become permission to
  // "send_payment". run_id and objective_id are frozen for the same reason company identity is.
  `CREATE OR REPLACE FUNCTION office_approvals_payload_immutable() RETURNS TRIGGER AS $fn$
   BEGIN
     IF NEW.action_payload::text IS DISTINCT FROM OLD.action_payload::text
        OR NEW.action_kind IS DISTINCT FROM OLD.action_kind
        OR NEW.run_id IS DISTINCT FROM OLD.run_id
        OR NEW.objective_id IS DISTINCT FROM OLD.objective_id
        OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
       RAISE EXCEPTION 'an approval request is immutable: action_kind, action_payload, run_id, objective_id and company_id are fixed at creation so that what was approved is what is released';
     END IF;
     RETURN NEW;
   END;
   $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_office_approvals_payload_immutable ON office_approvals`,
  `CREATE TRIGGER trg_office_approvals_payload_immutable
     BEFORE UPDATE ON office_approvals
     FOR EACH ROW EXECUTE FUNCTION office_approvals_payload_immutable()`,
  // Released-at records that the approved action was actually carried out, so an approval that was
  // granted and never used is distinguishable from one that was acted on.
  `ALTER TABLE office_approvals ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ`,
  `ALTER TABLE office_approvals ADD COLUMN IF NOT EXISTS released_by TEXT`,

  // The exception queue. "A counter on a dashboard is not a work queue" — so every ruled field is
  // here, and an email is NOT the record: notifications point to this row, they are not it.
  // ── B2.5a: A NAMED, TIME-BOUNDED, AUDITED BUDGET EXCEPTION ───────────────
  //
  // Owner instruction: "A missing budget must refuse autonomous execution unless a separately
  // authorized, named, time-bounded and audited exception exists."
  //
  // Every word of that is a column. `granted_by` and `reason` make it named and accountable;
  // `effective_to` is NOT NULL so it cannot be open-ended — an exception that never expires is a
  // policy change wearing an exception's clothes; `revoked_at`/`revoked_by` let it be withdrawn
  // before expiry; and the partial unique index allows exactly one ACTIVE exception per objective
  // while keeping every expired and revoked row, so the history of who permitted unmetered
  // execution and why survives.
  //
  // The composite foreign key is the same device agent_memory uses: the exception must point at an
  // objective OF THE SAME COMPANY, enforced by the database rather than by the accessor, so an
  // exception granted for one company's objective can never authorize another's.
  `CREATE TABLE IF NOT EXISTS office_budget_exceptions (
     id              TEXT PRIMARY KEY,
     company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
     objective_id    TEXT NOT NULL,
     granted_by      TEXT NOT NULL,
     reason          TEXT NOT NULL,
     effective_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     effective_to    TIMESTAMPTZ NOT NULL,
     revoked_at      TIMESTAMPTZ,
     revoked_by      TEXT,
     revoked_reason  TEXT,
     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT office_budget_exceptions_window CHECK (effective_to > effective_from),
     CONSTRAINT office_budget_exceptions_revocation_recorded CHECK (
       (revoked_at IS NULL AND revoked_by IS NULL)
       OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
     ),
     CONSTRAINT office_budget_exceptions_reason_not_blank CHECK (length(btrim(reason)) > 0),
     CONSTRAINT office_budget_exceptions_same_company
       FOREIGN KEY (objective_id, company_id) REFERENCES objectives (id, company_id)
       ON DELETE RESTRICT
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS office_budget_exceptions_one_active
     ON office_budget_exceptions (objective_id) WHERE revoked_at IS NULL`,

  // ── B2.5b: A HOLD TAKEN BEFORE THE MONEY IS SPENT ────────────────────────
  //
  // Owner instruction, 2026-11-25: "Prevent unauthorized expenditure BEFORE a metered call, not
  // merely after the budget has been exceeded." · "Atomic reservation or charging before
  // execution." · "Maximum possible provider charges." · "Reservation reconciliation after
  // completion or failure."
  //
  // WHAT B2.5a ACTUALLY ENFORCED, AND WHAT IT DID NOT. `governedCall` asked the budget, then
  // called the provider, then recorded the cost. Check-then-act: two concurrent calls both read
  // the same spend, both pass, and both spend. And neither was bounded — the gate asked "is there
  // headroom" and never "is there headroom for THIS call", so one call against a $0.05 objective
  // could cost $5 and the refusal arrived on the call after it.
  //
  // A reservation closes both. `max_usd` is the MOST this call can cost — computed from the
  // model's list price and the token ceiling, over-estimated on purpose — and it is held against
  // the objective before the provider is reached. Live holds count towards the budget, so a second
  // concurrent call sees the first one's exposure even though nothing has been charged yet.
  //
  // `expires_at` is the crash answer: a hold is only counted while live, so a process that dies
  // mid-call cannot consume an objective's budget for ever. The predicate does that in SQL rather
  // than relying on a reaper being punctual, and the reaper then corrects the record.
  //
  // `settled_cost_known` exists because an unmeasured call is not a free one (the C1 rule): a
  // settlement may legitimately carry no dollar figure, and the row says so instead of recording 0.
  `CREATE TABLE IF NOT EXISTS office_budget_reservations (
     id                 TEXT PRIMARY KEY,
     company_id         TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
     objective_id       TEXT NOT NULL,
     run_id             UUID NOT NULL,
     max_usd            NUMERIC(14,8) NOT NULL,
     state              TEXT NOT NULL DEFAULT 'held',
     reason             TEXT NOT NULL,
     under_exception    TEXT,
     held_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     expires_at         TIMESTAMPTZ NOT NULL,
     settled_at         TIMESTAMPTZ,
     settled_cost_usd   NUMERIC(14,8),
     settled_cost_known BOOLEAN,
     cost_ledger_id     BIGINT,
     CONSTRAINT office_budget_reservations_state
       CHECK (state IN ('held','settled','released','expired')),
     -- A hold must be for a positive amount. A $0 hold would reserve nothing while looking like a
     -- reservation, which is the shape this table exists to prevent.
     CONSTRAINT office_budget_reservations_positive CHECK (max_usd > 0),
     CONSTRAINT office_budget_reservations_window CHECK (expires_at > held_at),
     CONSTRAINT office_budget_reservations_reason_not_blank
       CHECK (length(btrim(reason)) > 0),
     -- A HELD row carries no settlement, and a terminal row carries one. Without this a settled
     -- reservation could keep its hold, or a live one could claim to have been reconciled.
     CONSTRAINT office_budget_reservations_held_is_open CHECK (
       state <> 'held' OR (settled_at IS NULL AND settled_cost_usd IS NULL
                           AND settled_cost_known IS NULL AND cost_ledger_id IS NULL)
     ),
     CONSTRAINT office_budget_reservations_settled_is_closed CHECK (
       state <> 'settled' OR (settled_at IS NOT NULL AND settled_cost_known IS NOT NULL
                              AND (settled_cost_known = FALSE OR settled_cost_usd IS NOT NULL))
     ),
     -- Released and expired mean NOTHING was charged. A dollar figure on one of those would be a
     -- cost nobody can point at a provider call for.
     CONSTRAINT office_budget_reservations_unspent_is_zero CHECK (
       state NOT IN ('released','expired')
       OR (settled_at IS NOT NULL AND settled_cost_usd IS NULL AND settled_cost_known IS NULL)
     ),
     CONSTRAINT office_budget_reservations_objective_same_company
       FOREIGN KEY (objective_id, company_id) REFERENCES objectives (id, company_id)
       ON DELETE RESTRICT,
     CONSTRAINT office_budget_reservations_run_same_company
       FOREIGN KEY (run_id, company_id) REFERENCES agent_runs (run_id, company_id) MATCH FULL
       ON DELETE RESTRICT
   )`,
  // The exposure query's index: live holds for one objective.
  `CREATE INDEX IF NOT EXISTS idx_office_reservations_live
     ON office_budget_reservations (company_id, objective_id, expires_at)
     WHERE state = 'held'`,

  // ── B3.2: A PLAN IS A PROPOSAL, AND THE RECORD SAYS SO ───────────────────
  //
  // Owner instruction: "Agent-generated plans are proposals, not authorization. Every proposed
  // step must be independently validated against company scope, capability permissions, execution
  // eligibility, STOP controls, approval requirements and budget."
  //
  // So the plan is stored with a `status` that starts at 'proposed' and a `verdict` that is written
  // only by the validator. There is no column a proposer can set to make a plan authorized, and no
  // default that means authorized: 'proposed' is the only value the insert can produce, enforced by
  // a CHECK, so a plan that was never validated cannot be mistaken for one that passed.
  //
  // `proposer` records WHAT produced it — 'deterministic' or the model behind a governed call —
  // because a plan's origin is part of its evidence and an AI-proposed plan is exactly the one a
  // reviewer wants to find later.
  `CREATE TABLE IF NOT EXISTS office_plans (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
     objective_id  TEXT NOT NULL,
     run_id        UUID NOT NULL,
     proposer      TEXT NOT NULL,
     planner       TEXT NOT NULL,
     status        TEXT NOT NULL DEFAULT 'proposed',
     verdict       TEXT,
     refusal_code  TEXT,
     refusal_detail TEXT,
     validated_at  TIMESTAMPTZ,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT office_plans_status CHECK (status IN ('proposed','validated','refused')),
     -- A verdict without a validation time, or the reverse, would make "has this been validated?"
     -- answerable two contradictory ways.
     CONSTRAINT office_plans_verdict_paired CHECK (
       (verdict IS NULL AND validated_at IS NULL) OR (verdict IS NOT NULL AND validated_at IS NOT NULL)
     ),
     -- 'proposed' means not yet judged. A row cannot sit in that state carrying a verdict.
     CONSTRAINT office_plans_proposed_has_no_verdict CHECK (
       status <> 'proposed' OR verdict IS NULL
     ),
     -- A refusal must say why. "Refused" with no code is the shape that loses the reason.
     CONSTRAINT office_plans_refusal_has_code CHECK (
       status <> 'refused' OR refusal_code IS NOT NULL
     ),
     CONSTRAINT office_plans_same_company
       FOREIGN KEY (objective_id, company_id) REFERENCES objectives (id, company_id)
       ON DELETE RESTRICT,
     CONSTRAINT office_plans_run_same_company
       FOREIGN KEY (run_id, company_id) REFERENCES agent_runs (run_id, company_id) MATCH FULL
       ON DELETE RESTRICT,
     -- The composite target a step's own foreign key points at, so a step cannot be attached to a
     -- plan of another company.
     CONSTRAINT office_plans_id_company UNIQUE (id, company_id)
   )`,

  // One row per proposed step, with the validator's per-step verdict beside the proposal. Both are
  // kept: a refused step and the reason it was refused are the evidence that validation happened,
  // and deleting the refused steps would leave only plans that passed.
  `CREATE TABLE IF NOT EXISTS office_plan_steps (
     plan_id        TEXT NOT NULL,
     company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
     step_id        TEXT NOT NULL,
     ordinal        INT NOT NULL,
     step_type      TEXT NOT NULL,
     task_type      TEXT,
     capability     TEXT,
     consequential  BOOLEAN NOT NULL,
     execution_class TEXT NOT NULL,
     payload        JSONB NOT NULL,
     payload_digest TEXT NOT NULL,
     intent_key     TEXT NOT NULL,
     requires_approval BOOLEAN NOT NULL,
     verdict        TEXT,
     refusal_code   TEXT,
     refusal_detail TEXT,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (plan_id, step_id),
     CONSTRAINT office_plan_steps_ordinal_positive CHECK (ordinal > 0),
     CONSTRAINT office_plan_steps_same_company
       FOREIGN KEY (plan_id, company_id) REFERENCES office_plans (id, company_id)
       ON DELETE RESTRICT
   )`,
  // An intent key is what stops the same step being executed twice. Unique across the whole table,
  // not per plan: two plans that proposed the same key would collide at dispatch, and finding that
  // out at dispatch means finding it out after one of them has already run.
  `CREATE UNIQUE INDEX IF NOT EXISTS office_plan_steps_intent
     ON office_plan_steps (intent_key)`,
  `CREATE INDEX IF NOT EXISTS idx_office_plans_objective
     ON office_plans (company_id, objective_id, created_at DESC)`,

  // ── B3.3: THE DISPATCH RECORD FOR ONE DELEGATION ─────────────────────────
  //
  // The dependency plan's Gate 3 names exactly what dispatch evidence must identify: "company,
  // objective, parent run, child run, calling agent, target agent, workflow, capability, autonomy
  // tier, policy decision." Every one of those is a NOT NULL column here, so a delegation that
  // cannot say one of them cannot be recorded — and since the record is written before the child
  // run is started, it cannot be delegated either.
  //
  // THE SHAPE THAT MATTERS: both runs are welded to the same company by composite foreign keys.
  // A child run belonging to another company cannot be attached to this parent, and the database
  // refuses it rather than the accessor remembering to check. That is the one property a
  // delegation boundary exists to have.
  `CREATE TABLE IF NOT EXISTS office_delegations (
     id             TEXT PRIMARY KEY,
     company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
     objective_id   TEXT NOT NULL,
     parent_run_id  UUID NOT NULL,
     child_run_id   UUID NOT NULL,
     calling_agent  TEXT NOT NULL,
     target_agent   TEXT NOT NULL,
     workflow       TEXT NOT NULL,
     capability     TEXT NOT NULL,
     autonomy_tier  TEXT NOT NULL,
     policy_decision TEXT NOT NULL,
     depth          INT NOT NULL,
     reason         TEXT NOT NULL,
     at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT office_delegations_depth CHECK (depth >= 1),
     CONSTRAINT office_delegations_reason_not_blank CHECK (length(btrim(reason)) > 0),
     -- A run cannot delegate to itself: that is a cycle of length one, and the depth bound would
     -- never see it because the chain never gets longer.
     CONSTRAINT office_delegations_not_self CHECK (parent_run_id <> child_run_id),
     -- One delegation record per child run. A child reached from two parents is not a tree, and
     -- the evidence would answer "who delegated this" two ways.
     CONSTRAINT office_delegations_one_per_child UNIQUE (child_run_id),
     CONSTRAINT office_delegations_objective_same_company
       FOREIGN KEY (objective_id, company_id) REFERENCES objectives (id, company_id)
       ON DELETE RESTRICT,
     CONSTRAINT office_delegations_parent_same_company
       FOREIGN KEY (parent_run_id, company_id) REFERENCES agent_runs (run_id, company_id) MATCH FULL
       ON DELETE RESTRICT,
     CONSTRAINT office_delegations_child_same_company
       FOREIGN KEY (child_run_id, company_id) REFERENCES agent_runs (run_id, company_id) MATCH FULL
       ON DELETE RESTRICT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_office_delegations_parent
     ON office_delegations (company_id, parent_run_id)`,

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
  // B2.5a. Company-scoped like every other kernel table, so it is read through scope.js and a
  // caller cannot ask "is there an exception" without a resolved context.
  'office_budget_exceptions',
  // B2.5b. Pre-spend holds. The atomic reserve/settle path lives in scope.js with the rest, so a
  // caller cannot take a hold without a resolved context.
  'office_budget_reservations',
  // B3.2. A plan and its steps are company-scoped kernel records: read through scope.js so a
  // caller cannot ask for "the plan" without a resolved context, which is what keeps one company's
  // decomposition out of another's reach.
  'office_plans',
  'office_plan_steps',
  // B3.3. The dispatch record for one delegation, company-scoped like the rest.
  'office_delegations',
  'office_cost_ledger',
  'office_approvals',
  'office_exceptions',
  'office_outcomes',
]);

module.exports = { migrateOffice, KERNEL_TABLES, DDL };
