'use strict';
// ── PRPA CONNECTOR SPINE — SCHEMA ────────────────────────────────────────────
//
// Additive-only. Follows src/lib/office/schema.js exactly: a DDL array applied statement by
// statement, swallowing only the three "already exists" codes, because a migration that hides a
// real error is worse than one that fails.
//
// ROLLBACK (safe, additive — nothing existing is altered):
//   DROP TABLE IF EXISTS solicitation_amendments;
//   DROP TABLE IF EXISTS solicitations;
//   DROP TABLE IF EXISTS review_tasks;
//   DROP TABLE IF EXISTS capability_scope_items;
//   DROP TABLE IF EXISTS verified_capabilities;
//   DROP TABLE IF EXISTS eligibility_findings;
//   DROP TABLE IF EXISTS eligibility_assessments;
//   DROP TABLE IF EXISTS funding_opportunity_versions;
//   DROP TABLE IF EXISTS funding_opportunities;
//   DROP TABLE IF EXISTS federal_awards;
//   DROP TABLE IF EXISTS source_sync_runs;
//   DROP TABLE IF EXISTS source_connectors;
//
// ── WHY TENANT ISOLATION IS SHAPED THE WAY IT IS ─────────────────────────────
//
// src/lib/office/schema.js already explains why company_id belongs in the foreign key rather than
// in a WHERE clause somebody has to remember: the constraint then fires on the write, from inside
// the engine, whoever is connected and whatever they forgot. These tables join that graph.
//
// The difference from the kernel is that these tables are NEW. agent_runs carries live legacy rows,
// so its company_id is physically nullable and MATCH FULL permits the all-NULL case for them.
// federal_awards and source_sync_runs have no history and are owed none of that latitude:
// company_id is NOT NULL from creation. A nullable tenant column on a new table reopens exactly
// the evasion MATCH FULL was added to close — point a row at another company's run, leave
// company_id NULL, and the composite FK never fires.
//
// CONSEQUENCE WORTH STATING. source_sync_runs.company_id is NOT NULL, so under MATCH FULL the
// (run_id, company_id) pair can never be half-present, which means run_id cannot be NULL either.
// Every sync therefore has to happen inside an agent_run. That is deliberate, not incidental: the
// run is what carries the kill switch, the cost ledger and the audit trail. A sync that could run
// outside a run would be a sync with no way to stop it and no record of what it spent.
//
// ── WHY source_connectors HAS NO company_id ──────────────────────────────────
//
// That USAspending exists, needs no key and publishes no quota is a fact about the world, not
// tenant data. Per-tenant behaviour lives in source_sync_runs (which is tenant-scoped) and in the
// `activated` flag below. Giving a global fact a tenant column would invite two tenants to hold
// contradictory beliefs about the same public API.
//
// ── WHY `activated` DEFAULTS TO FALSE ────────────────────────────────────────
//
// Ruling 5: prepare SAM.gov, do not activate it until API access and quotas are verified. A code
// comment saying so is not a control. A row that cannot be synced until somebody flips a column is.
// The seed below inserts sam_gov with activated = FALSE and daily_call_ceiling = NULL.
//
// NULL, AND NOT A NUMBER. This comment previously said the ceiling was 10, "the personal-key
// limit". That figure came from recollection and is not published: open.gsa.gov states only that
// "Request per day are limited based on the federal or non-federal or general roles" and gives NO
// NUMBER FOR ANY ROLE. An invented ceiling is worse than none — it reads as knowledge to the next
// person, and it is wrong in both directions. Too low silently caps ingestion and looks like a
// quiet source; too high 429s halfway through a run and leaves a false high-water mark. NULL means
// UNKNOWN, the quota ledger permits calls while refusing to report a budget it does not have, and
// the real number gets recorded here only once an authenticated call has measured it.

const DDL = [
  // ---------------------------------------------------------------------------------------
  // The source registry. One row per external system, API or not.
  //
  // access_mode distinguishes what we may automate from what we may not. FedConnect and SBCX are
  // authenticated portals with no published API; the brief forbids scraping them and forbids
  // bypassing access controls. They are therefore 'manual_assisted' here — a value the sync path
  // refuses to act on, so "do not automate this" is enforced by the data rather than remembered.
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS source_connectors (
     source_key          TEXT PRIMARY KEY,
     display_name        TEXT NOT NULL,
     base_url            TEXT NOT NULL,
     kind                TEXT NOT NULL,
     auth_mode           TEXT NOT NULL,
     access_mode         TEXT NOT NULL,
     daily_call_ceiling  INTEGER,
     activated           BOOLEAN NOT NULL DEFAULT FALSE,
     notes               TEXT,
     created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT source_connectors_kind_check
       CHECK (kind IN ('procurement','funding','research')),
     CONSTRAINT source_connectors_auth_check
       CHECK (auth_mode IN ('none','api_key','portal_login')),
     CONSTRAINT source_connectors_access_check
       CHECK (access_mode IN ('api','manual_assisted')),
     CONSTRAINT source_connectors_ceiling_check
       CHECK (daily_call_ceiling IS NULL OR daily_call_ceiling > 0)
   )`,

  // ---------------------------------------------------------------------------------------
  // One row per synchronisation attempt. This is the brief's SourceSyncRun (§4) and it is a row
  // on the EXISTING run ledger rather than a parallel one: run_id points at agent_runs, so a sync
  // inherits the kill switch, office_cost_ledger and the audit trail instead of growing its own.
  //
  // calls_made against call_ceiling is how a published quota becomes an enforced budget rather
  // than something discovered as an HTTP 429 at three in the morning.
  //
  // high_water_mark is advanced ONLY on status = 'completed'. A partial page that advanced the
  // watermark would silently skip every record between the failure and the next run — the quiet
  // data-loss failure, not the loud one.
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS source_sync_runs (
     id                  TEXT PRIMARY KEY,
     company_id          TEXT NOT NULL REFERENCES companies(id),
     source_key          TEXT NOT NULL REFERENCES source_connectors(source_key),
     run_id              UUID NOT NULL,
     window_from         DATE,
     window_to           DATE,
     calls_made          INTEGER NOT NULL DEFAULT 0,
     call_ceiling        INTEGER,
     records_seen        INTEGER NOT NULL DEFAULT 0,
     records_upserted    INTEGER NOT NULL DEFAULT 0,
     high_water_mark     TEXT,
     status              TEXT NOT NULL,
     error_text          TEXT,
     started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     finished_at         TIMESTAMPTZ,
     CONSTRAINT source_sync_runs_status_check
       CHECK (status IN ('running','completed','failed','ceiling_reached','refused')),
     CONSTRAINT source_sync_runs_calls_check
       CHECK (calls_made >= 0 AND (call_ceiling IS NULL OR calls_made <= call_ceiling))
   )`,

  // The composite tenant FK. MATCH FULL, for the reason the kernel documents: MATCH SIMPLE passes
  // if any column is NULL, which on a nullable company_id is an evasion rather than a constraint.
  // NOT VALID so existing agent_runs history is not re-examined; PostgreSQL still enforces it on
  // every new INSERT and UPDATE, which is the whole point.
  `ALTER TABLE source_sync_runs
     ADD CONSTRAINT fk_source_sync_runs_run_company
     FOREIGN KEY (run_id, company_id) REFERENCES agent_runs (run_id, company_id)
     MATCH FULL NOT VALID`,

  `CREATE INDEX IF NOT EXISTS idx_ssr_company_source
     ON source_sync_runs (company_id, source_key, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ssr_run ON source_sync_runs (run_id)`,
  // Finding the live watermark must not scan history.
  `CREATE INDEX IF NOT EXISTS idx_ssr_completed
     ON source_sync_runs (company_id, source_key, finished_at DESC)
     WHERE status = 'completed'`,

  // ---------------------------------------------------------------------------------------
  // USAspending award history. Read-only intelligence: this table is never a source of truth about
  // anything Abiozen owes or is owed, only about what agencies have bought.
  //
  // THE COLUMN NAME IS THE CONTROL. obligated_amount, not "amount" and not "spend". USAspending
  // returns obligations recorded at action time; outlays are a different number reported
  // separately. A column called "spend" invites a dashboard tile that sums obligations and labels
  // the total as money spent, which is wrong by construction and wrong in the direction that
  // flatters. §10 draws the same distinction between ceilings, obligations and realized revenue.
  //
  // parent_piid is NULL for a standalone award, never the literal '-NONE-' sentinel the API
  // returns inside generated_internal_id. PR-1 measured 3 of 10 awards carrying that sentinel;
  // stored verbatim it makes every later join on parent_piid match unrelated standalone awards.
  // The CHECK makes that unstoreable rather than merely discouraged.
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS federal_awards (
     id                   TEXT PRIMARY KEY,
     company_id           TEXT NOT NULL REFERENCES companies(id),
     source_key           TEXT NOT NULL REFERENCES source_connectors(source_key),
     award_key            TEXT NOT NULL,
     piid                 TEXT,
     parent_piid          TEXT,
     awarding_agency_code TEXT,
     awarding_agency      TEXT,
     awarding_sub_agency  TEXT,
     recipient_name       TEXT,
     recipient_profile_id TEXT,
     naics_code           TEXT,
     naics_description    TEXT,
     psc_code             TEXT,
     psc_description      TEXT,
     obligated_amount     NUMERIC(18,2),
     pop_start_date       DATE,
     pop_end_date         DATE,
     source_url           TEXT,
     raw_json             JSONB NOT NULL,
     ingested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     first_seen_sync_id   TEXT,
     last_seen_sync_id    TEXT,
     CONSTRAINT federal_awards_parent_sentinel_check
       CHECK (parent_piid IS NULL OR parent_piid NOT IN ('-NONE-', 'NONE', ''))
   )`,

  // §15: "No duplicate opportunities after repeated synchronization." That is this index, enforced
  // by the database, not an application-side existence check that races itself under concurrency.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_natural_key
     ON federal_awards (company_id, source_key, award_key)`,
  `CREATE INDEX IF NOT EXISTS idx_fa_naics ON federal_awards (company_id, naics_code)`,
  `CREATE INDEX IF NOT EXISTS idx_fa_psc ON federal_awards (company_id, psc_code)`,
  `CREATE INDEX IF NOT EXISTS idx_fa_recipient ON federal_awards (company_id, recipient_profile_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fa_parent ON federal_awards (company_id, parent_piid)
     WHERE parent_piid IS NOT NULL`,

  // ---------------------------------------------------------------------------------------
  // Grants.gov funding opportunities (PR-4).
  //
  // A SEPARATE TABLE FROM PROCUREMENT, BY RULING. Grant opportunities are preserved apart from
  // procurement contracts and revenue. Grants.gov's fundingInstruments vocabulary does include
  // "Procurement Contract" for a minority of records, and that does NOT move them: a grant-funded
  // contract reached through Grants.gov is still a Grants.gov record. The one thing that must never
  // happen is a number from this source landing in a procurement pipeline total, and the surest way
  // to prevent it is for there to be no column it could land in.
  //
  // THE COLUMN IS application_open, AND IT USED TO BE CALLED biddable. THAT NAME WAS WRONG.
  //
  // It was written in PR-4, before the record-kind taxonomy existed, and it means what its
  // expression says: this record is live at the source and has a deadline you can still apply
  // against. Once PR-5 gave "biddable" a precise meaning — exactly one of six record kinds, and
  // grant_opportunity is NOT one of them — the old name asserted something false about every row
  // in this table. A grant is an APPLICATION, never an offer, so no funding record is ever
  // biddable, and a column called `biddable` reading true on all of them is the unsupported claim
  // the ruling forbids. scripts/check-dashboard-views-db.js caught the disagreement by comparing
  // the column against the ladder on a real row.
  //
  // IT IS STILL GENERATED, for the original reason. The first probe found 5 of 10 hits were
  // forecasts — plans, with an empty close date — and an empty close date is not "no deadline,
  // apply anytime". If this were an ordinary column, some later writer would set it from a field it
  // misread. As a generated column the database computes it from the three facts that decide it and
  // no INSERT can assert otherwise. COALESCE wraps the expression so an unknown status yields FALSE
  // rather than NULL: for a control, "we do not know" and "not open" must be the same answer.
  //
  // Biddability is NOT in this table. It is src/lib/procurement/record-kind.js's biddability(),
  // which answers for any record kind and answers no for every one of these.
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS funding_opportunities (
     id                   TEXT PRIMARY KEY,
     company_id           TEXT NOT NULL REFERENCES companies(id),
     source_key           TEXT NOT NULL REFERENCES source_connectors(source_key),
     opportunity_id       TEXT NOT NULL,
     opportunity_number   TEXT,
     title                TEXT,
     agency_code          TEXT,
     agency_name          TEXT,
     doc_type             TEXT,
     opp_status           TEXT,
     standing             TEXT NOT NULL,
     open_date            DATE,
     close_date           DATE,
     archive_date         DATE,
     estimated_funding    NUMERIC(18,2),
     award_ceiling        NUMERIC(18,2),
     award_floor          NUMERIC(18,2),
     cost_sharing         BOOLEAN,
     cfda_list            TEXT[],
     current_revision     INTEGER,
     source_url           TEXT,
     raw_json             JSONB NOT NULL,
     ingested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     first_seen_sync_id   TEXT,
     last_seen_sync_id    TEXT,
     application_open     BOOLEAN GENERATED ALWAYS AS (
       COALESCE(opp_status = 'posted' AND doc_type <> 'forecast' AND close_date IS NOT NULL, false)
     ) STORED,
     CONSTRAINT funding_opportunities_standing_check
       CHECK (standing IN ('open','posted_no_deadline','forecast','closed','archived','unknown'))
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_fo_natural_key
     ON funding_opportunities (company_id, source_key, opportunity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fo_close ON funding_opportunities (company_id, close_date)
     WHERE close_date IS NOT NULL`,
  // The dashboard's "open for applications" view reads this and nothing else.
  `CREATE INDEX IF NOT EXISTS idx_fo_application_open ON funding_opportunities (company_id, close_date)
     WHERE application_open`,
  `CREATE INDEX IF NOT EXISTS idx_fo_agency ON funding_opportunities (company_id, agency_code)`,

  // ---------------------------------------------------------------------------------------
  // The amendment chain. §4's SolicitationVersion and §15's "correct preservation of notice IDs
  // and amendment versions" — for this source, available unauthenticated and free, which is why
  // PR-4 runs before SAM.gov.
  //
  // The current revision is NOT in the API's history array (measured: data.revision = 6 while
  // opportunityHistoryDetails carried 0..5), so the adapter appends it. The partial unique index
  // below makes "exactly one current revision" an invariant the engine holds, rather than
  // something the ingest is trusted to get right — two rows claiming to be current is precisely
  // how a proposal gets written against a superseded version.
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS funding_opportunity_versions (
     id                   TEXT PRIMARY KEY,
     company_id           TEXT NOT NULL REFERENCES companies(id),
     source_key           TEXT NOT NULL REFERENCES source_connectors(source_key),
     opportunity_id       TEXT NOT NULL,
     opportunity_row_id   TEXT,
     revision             INTEGER NOT NULL,
     is_current           BOOLEAN NOT NULL DEFAULT FALSE,
     title                TEXT,
     opportunity_number   TEXT,
     modified_fields      TEXT[],
     close_date           DATE,
     raw_json             JSONB NOT NULL,
     ingested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT funding_opportunity_versions_revision_check CHECK (revision >= 0)
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_fov_natural_key
     ON funding_opportunity_versions (company_id, source_key, opportunity_id, revision)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_fov_one_current
     ON funding_opportunity_versions (company_id, source_key, opportunity_id)
     WHERE is_current`,
  `CREATE INDEX IF NOT EXISTS idx_fov_opp
     ON funding_opportunity_versions (company_id, source_key, opportunity_id, revision DESC)`,

  // ---------------------------------------------------------------------------------------
  // Ruling item 4: a funding record is a grant or a forecast, and can never be anything else.
  //
  // The CHECK is the control. src/lib/procurement/record-kind.js has six kinds and exactly one of
  // them is biddable; this table's source can produce only two of the six, so the other four — a
  // solicitation above all — are unstoreable here rather than merely unexpected. A solicitation
  // written into the funding table would be a biddable contract sitting in the pipeline that by
  // ruling must never hold procurement revenue.
  // ---------------------------------------------------------------------------------------
  `ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS record_kind TEXT`,
  `ALTER TABLE funding_opportunities
     ADD CONSTRAINT funding_opportunities_record_kind_check
     CHECK (record_kind IS NULL OR record_kind IN ('grant_opportunity','forecast'))`,
  `CREATE INDEX IF NOT EXISTS idx_fo_kind ON funding_opportunities (company_id, record_kind)`,

  // ---------------------------------------------------------------------------------------
  // PR-5: the qualification verdict and its per-criterion evidence.
  //
  // ONE ROW PER CRITERION, not a JSON blob on the assessment. §6 requires every determination to
  // contain evidence and a reason, and thirteen criteria each need their own provenance — a verdict
  // whose per-criterion evidence cannot be retrieved is not auditable, which is the same as not
  // having one.
  //
  // rule_set_version is NOT NULL because a verdict read against today's rules rather than the rules
  // that produced it is a different verdict wearing the same label.
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS eligibility_assessments (
     id                 TEXT PRIMARY KEY,
     company_id         TEXT NOT NULL REFERENCES companies(id),
     subject_kind       TEXT NOT NULL,
     subject_id         TEXT NOT NULL,
     record_kind        TEXT,
     verdict            TEXT NOT NULL,
     rationale          TEXT NOT NULL,
     rule_set_version   TEXT NOT NULL,
     as_of              DATE NOT NULL,
     blocking_count     INTEGER NOT NULL,
     assessed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT eligibility_assessments_verdict_check
       CHECK (verdict IN ('QUALIFIED','CONDITIONAL','NOT_QUALIFIED','NEEDS_REVIEW')),
     CONSTRAINT eligibility_assessments_subject_check
       CHECK (subject_kind IN ('procurement_opportunity','funding_opportunity')),
     CONSTRAINT eligibility_assessments_blocking_check
       CHECK (blocking_count >= 0),
     -- THE TWO CONSTRAINTS THAT MAKE THE VERDICT HONEST.
     --
     -- A QUALIFIED verdict that admits a blocked gate is a contradiction, and the engine computes
     -- the blocking list from the findings precisely so that it cannot disagree with them. These make the
     -- same thing true of what is STORED, for any writer — including one that recomputes a verdict
     -- by hand or replays an old payload. Without them the most damaging possible row is also the
     -- easiest to insert.
     CONSTRAINT eligibility_assessments_qualified_check
       CHECK (verdict <> 'QUALIFIED' OR blocking_count = 0),
     CONSTRAINT eligibility_assessments_conditional_check
       CHECK (verdict <> 'CONDITIONAL' OR blocking_count = 0),
     CONSTRAINT eligibility_assessments_blocked_check
       CHECK (verdict NOT IN ('NOT_QUALIFIED','NEEDS_REVIEW') OR blocking_count > 0)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_ea_subject
     ON eligibility_assessments (company_id, subject_kind, subject_id, assessed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ea_verdict
     ON eligibility_assessments (company_id, verdict, assessed_at DESC)`,

  `CREATE TABLE IF NOT EXISTS eligibility_findings (
     id                   TEXT PRIMARY KEY,
     company_id           TEXT NOT NULL REFERENCES companies(id),
     assessment_id        TEXT NOT NULL,
     criterion_key        TEXT NOT NULL,
     label                TEXT NOT NULL,
     mandatory            BOOLEAN NOT NULL,
     result               TEXT NOT NULL,
     reason               TEXT NOT NULL,
     evidence_text        TEXT,
     evidence_source_url  TEXT,
     CONSTRAINT eligibility_findings_result_check
       CHECK (result IN ('pass','fail','unknown','not_applicable')),
     -- §6 again: a finding with no reason is not a determination. An empty string is as useless as
     -- a NULL, so both are refused.
     CONSTRAINT eligibility_findings_reason_check
       CHECK (length(btrim(reason)) > 0)
   )`,

  // One finding per criterion per assessment. A duplicate would let the same criterion appear twice
  // with different results, and any report over it would silently pick one.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ef_one_per_criterion
     ON eligibility_findings (assessment_id, criterion_key)`,
  `CREATE INDEX IF NOT EXISTS idx_ef_assessment
     ON eligibility_findings (company_id, assessment_id)`,
  // The review queue reads exactly this.
  `CREATE INDEX IF NOT EXISTS idx_ef_blocking
     ON eligibility_findings (company_id, criterion_key)
     WHERE mandatory AND result IN ('fail','unknown')`,

  // ---------------------------------------------------------------------------------------
  // THE VERIFIED-CAPABILITY AND ACCREDITATION REGISTRY.
  //
  // This is what PR-5 has been waiting for. §8 forbids inventing certifications, project
  // references, equipment, laboratory capacity or regulatory approvals, so the qualification
  // engine's capability gate resolves against rows by id — and until now there were no rows, which
  // is why every verdict was NEEDS_REVIEW.
  //
  // ── "PLANNED OR PENDING MUST NEVER BE TREATED AS APPROVED" IS A CONSTRAINT, NOT A CONVENTION ──
  //
  // The ruling's second item is the whole design. A capability becomes usable only at
  // verification_status = 'verified', and the CHECK below makes that status UNREACHABLE without
  // all four things that justify it: the evidence source, who verified it, when, and the
  // office_approvals row that authorised the verification.
  //
  // So a row cannot be quietly promoted. Somebody who wants to mark an ISO 17025 accreditation
  // verified must produce an approval id and an evidence source or the INSERT fails — which is a
  // different kind of safeguard from a code path that checks a status and could be bypassed by the
  // next writer. The statuses 'planned' and 'pending' exist precisely so an intended certification
  // can be RECORDED without becoming usable: leaving them out would push people to file aspirations
  // as verified facts, which is the failure this is built to prevent.
  //
  // ── VALIDITY IS A WINDOW, AND AN EXPIRED CAPABILITY IS NOT A CAPABILITY ──
  //
  // valid_from/valid_to are checked against the assessment's as-of date, not against row existence.
  // An accreditation that lapsed last month is still a true historical fact and still must not
  // satisfy a gate today. The reader enforces that; the CHECK here only stops an impossible window.
  //
  // ── SCOPE IS SEPARATE, BECAUSE ISO 17025 IS NOT HELD "IN GENERAL" ──
  //
  // An accreditation covers named methods. Holding it is not the same as being accredited for the
  // method a solicitation asks about, and flattening scope into a boolean on the capability row is
  // how "we have ISO 17025" becomes an answer to a question it does not answer.
  //
  // ROLLBACK: DROP TABLE capability_scope_items; DROP TABLE verified_capabilities;
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS verified_capabilities (
     id                   TEXT PRIMARY KEY,
     company_id           TEXT NOT NULL REFERENCES companies(id),
     kind                 TEXT NOT NULL,
     code                 TEXT NOT NULL,
     name                 TEXT NOT NULL,
     responsible_entity   TEXT NOT NULL,
     verification_status  TEXT NOT NULL DEFAULT 'planned',
     evidence_source      TEXT,
     evidence_url         TEXT,
     evidence_sha256      TEXT,
     verified_at          TIMESTAMPTZ,
     verified_by          TEXT,
     approval_id          TEXT,
     valid_from           DATE,
     valid_to             DATE,
     notes                TEXT,
     created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT verified_capabilities_kind_check
       CHECK (kind IN ('capability','accreditation')),
     CONSTRAINT verified_capabilities_status_check
       CHECK (verification_status IN ('planned','pending','verified','disputed','revoked')),
     -- THE CONTROL. 'verified' is unreachable without the evidence, the verifier, the date and the
     -- approval that authorised it. A planned certification therefore cannot be promoted by
     -- changing one column.
     CONSTRAINT verified_capabilities_verified_requires_evidence
       CHECK (
         verification_status <> 'verified' OR (
           evidence_source IS NOT NULL AND length(btrim(evidence_source)) > 0
           AND verified_at IS NOT NULL
           AND verified_by IS NOT NULL AND length(btrim(verified_by)) > 0
           AND approval_id IS NOT NULL AND length(btrim(approval_id)) > 0
           AND valid_from IS NOT NULL
         )
       ),
     CONSTRAINT verified_capabilities_window_check
       CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
   )`,

  // One row per capability per holding entity. Abiozen LLC and CRO360 may each hold their own ISO
  // 17025, and they are not interchangeable: a bid by one entity cannot rest on the other's
  // accreditation.
  // Company-welded foreign keys need a UNIQUE on the exact referenced pair, and `id TEXT PRIMARY
  // KEY` alone does not provide (id, company_id). The intake schema (v3) declares
  //   REFERENCES verified_capabilities (id, company_id)
  // and without this constraint it fails with "there is no unique constraint matching given keys".
  //
  // This never surfaced because the PRPA schema had only ever been applied on a disposable cluster
  // whose stub table happened to carry the pair. On an empty database the whole PRPA schema could
  // not apply — found by running the migrator against one, which is the only place it would show.
  //
  // ADD CONSTRAINT has no IF NOT EXISTS, so the DO block is what makes it re-runnable. It is
  // redundant with the primary key for uniqueness purposes and exists purely so the pair is
  // referenceable.
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid = 'verified_capabilities'::regclass
          AND conname = 'verified_capabilities_id_company_key'
     ) THEN
       ALTER TABLE verified_capabilities
         ADD CONSTRAINT verified_capabilities_id_company_key UNIQUE (id, company_id);
     END IF;
   END $$`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_vc_natural_key
     ON verified_capabilities (company_id, kind, code, responsible_entity)`,
  `CREATE INDEX IF NOT EXISTS idx_vc_usable
     ON verified_capabilities (company_id, kind, code)
     WHERE verification_status = 'verified'`,
  `CREATE INDEX IF NOT EXISTS idx_vc_expiring
     ON verified_capabilities (company_id, valid_to)
     WHERE verification_status = 'verified' AND valid_to IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS capability_scope_items (
     id              TEXT PRIMARY KEY,
     company_id      TEXT NOT NULL REFERENCES companies(id),
     capability_id   TEXT NOT NULL REFERENCES verified_capabilities(id) ON DELETE CASCADE,
     scope_kind      TEXT NOT NULL,
     scope_value     TEXT NOT NULL,
     notes           TEXT,
     CONSTRAINT capability_scope_items_kind_check
       CHECK (scope_kind IN ('method','molecule','service','naics','psc')),
     CONSTRAINT capability_scope_items_value_check
       CHECK (length(btrim(scope_value)) > 0)
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_csi_natural_key
     ON capability_scope_items (capability_id, scope_kind, scope_value)`,
  `CREATE INDEX IF NOT EXISTS idx_csi_lookup
     ON capability_scope_items (company_id, scope_kind, scope_value)`,

  // ---------------------------------------------------------------------------------------
  // PR-6b: REVIEW TASKS. Owner, priority, due date, status — and NO AUTHORITY.
  //
  // The ruling is explicit: "Assignment must not grant approval or trigger external actions."
  // That is enforced here rather than promised, in three ways:
  //
  //   1. THERE IS NO APPROVAL COLUMN. No `approved`, no `decision`, no `authorised_by`. A reviewer
  //      marking a task `done` records that somebody looked; it does not record that anything may
  //      proceed. Approval lives in office_approvals and nowhere else, and the only link to it is
  //      read-only: approval_id below is the approval this task was raised ABOUT, never one it
  //      creates.
  //
  //   2. THE STATUS VOCABULARY CANNOT EXPRESS A DECISION. 'open', 'in_progress', 'blocked',
  //      'done', 'cancelled'. There is deliberately no 'approved' and no 'rejected' — a status set
  //      that can say "approved" will eventually be read as approval by something downstream, and
  //      the cheapest way to prevent that is for the word to be unstoreable.
  //
  //   3. IT POINTS AT A FINDING, NOT AT AN ACTION. A task is "resolve this blocked criterion",
  //      which is work. It is not "submit this bid", which is an external action and belongs behind
  //      the gate.
  //
  // ROLLBACK: DROP TABLE review_tasks;
  // ---------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS review_tasks (
     id              TEXT PRIMARY KEY,
     company_id      TEXT NOT NULL REFERENCES companies(id),
     subject_kind    TEXT NOT NULL,
     subject_id      TEXT NOT NULL,
     criterion_key   TEXT,
     assessment_id   TEXT,
     approval_id     TEXT,
     title           TEXT NOT NULL,
     detail          TEXT,
     owner_user_id   TEXT,
     priority        TEXT NOT NULL DEFAULT 'normal',
     due_date        DATE,
     status          TEXT NOT NULL DEFAULT 'open',
     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     closed_at       TIMESTAMPTZ,
     closed_by       TEXT,
     closure_note    TEXT,
     CONSTRAINT review_tasks_priority_check
       CHECK (priority IN ('low','normal','high','urgent')),
     CONSTRAINT review_tasks_status_check
       CHECK (status IN ('open','in_progress','blocked','done','cancelled')),
     CONSTRAINT review_tasks_subject_check
       CHECK (subject_kind IN ('procurement_opportunity','funding_opportunity','capability')),
     CONSTRAINT review_tasks_title_check
       CHECK (length(btrim(title)) > 0),
     -- A closed task records WHO closed it and WHY. "Done" with no note and no name is the audit
     -- gap that makes a review queue look complete without anybody having looked.
     CONSTRAINT review_tasks_closure_check
       CHECK (status NOT IN ('done','cancelled') OR (
         closed_at IS NOT NULL
         AND closed_by IS NOT NULL AND length(btrim(closed_by)) > 0
         AND closure_note IS NOT NULL AND length(btrim(closure_note)) > 0
       ))
   )`,

  // One live task per subject+criterion. Two open tasks for the same blocked gate is two people
  // doing the same work and one of them discovering it afterwards.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rt_one_live
     ON review_tasks (company_id, subject_kind, subject_id, COALESCE(criterion_key, ''))
     WHERE status IN ('open','in_progress','blocked')`,
  `CREATE INDEX IF NOT EXISTS idx_rt_owner
     ON review_tasks (company_id, owner_user_id, status, due_date)`,
  `CREATE INDEX IF NOT EXISTS idx_rt_due
     ON review_tasks (company_id, due_date)
     WHERE status IN ('open','in_progress','blocked')`,

  // ---------------------------------------------------------------------------------------
  // PR-3 / ruling 7 items 1 and 4 — SAM.GOV SOLICITATIONS, IN THEIR OWN TABLE.
  //
  // A solicitation does NOT go in funding_opportunities. That table is Grants.gov-shaped
  // (cfda_list, estimated_funding, award_ceiling, cost_sharing) and its generated
  // `application_open` column encodes Grants.gov semantics outright: opp_status='posted' AND
  // doc_type<>'forecast'. Reusing it would mean a procurement solicitation living in the funding
  // table under a funding-shaped status, which is the category collapse ruling 7 item 4 forbids —
  // in the other direction. The two channels stay separate in the SCHEMA, not merely in a report,
  // because a shared table is how they eventually get summed.
  //
  // RECORD KIND IS STORED, NOT DERIVED FROM A STRING HERE. record-kind.js owns the notice-type
  // mapping and returns NULL for anything it does not recognise. A NULL arrives here as NULL and
  // the generated column below treats it as not-open, so a new SAM notice type can never become
  // biddable by default — the failure in the expensive direction.
  `CREATE TABLE IF NOT EXISTS solicitations (
     id                   TEXT PRIMARY KEY,
     company_id           TEXT NOT NULL REFERENCES companies(id),
     source_key           TEXT NOT NULL REFERENCES source_connectors(source_key),
     notice_id            TEXT NOT NULL,
     solicitation_number  TEXT,
     title                TEXT,
     -- CURRENT type and ORIGINAL type. Keeping only one loses the transition that decides
     -- biddability: a Sources Sought that becomes a Solicitation has just become biddable.
     notice_type          TEXT,
     base_notice_type     TEXT,
     record_kind          TEXT,
     organization_name    TEXT,
     naics_code           TEXT,
     classification_code  TEXT,
     set_aside            TEXT,
     set_aside_code       TEXT,
     posted_date          DATE,
     response_deadline    TIMESTAMPTZ,
     active               BOOLEAN,
     archive_type         TEXT,
     archive_date         DATE,
     source_url           TEXT,
     raw_json             JSONB NOT NULL,
     ingested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     first_seen_sync_id   TEXT,
     last_seen_sync_id    TEXT,
     -- A GENERATED column, so no caller can assert that something is open. Three conditions, all
     -- required: it is the one biddable kind, it has not been withdrawn, and a deadline exists.
     -- COALESCE makes an UNKNOWN record_kind or an UNKNOWN active flag resolve to false.
     response_open        BOOLEAN GENERATED ALWAYS AS (
       COALESCE(record_kind = 'solicitation' AND active AND response_deadline IS NOT NULL, false)
     ) STORED,
     CONSTRAINT solicitations_record_kind_check
       CHECK (record_kind IS NULL OR record_kind IN (
         'solicitation','sources_sought','rfi','grant_opportunity','forecast',
         'research_lead','historical_award')),
     -- A composite FK target for anything that must not cross tenants.
     UNIQUE (id, company_id)
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sol_natural_key
     ON solicitations (company_id, source_key, notice_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sol_open
     ON solicitations (company_id, response_deadline)
     WHERE response_open`,
  `CREATE INDEX IF NOT EXISTS idx_sol_number
     ON solicitations (company_id, solicitation_number)`,

  // ---------------------------------------------------------------------------------------
  // AMENDMENTS — DETECTED BY US, BECAUSE THE API WILL NOT TELL US.
  //
  // Documented at open.gsa.gov: "The API only provides the latest active version of the
  // opportunity. Earlier versions must be retrieved from SAM.gov Data Services." There is no
  // history array, no revision number and no amendment list — unlike Grants.gov, which hands over
  // opportunityHistoryDetails and fills funding_opportunity_versions from it.
  //
  // So an amendment is not something we read, it is something we OBSERVE: this table is the only
  // amendment history that will ever exist for a SAM notice, and it exists only for notices we
  // were already watching. A notice amended before we first saw it has a history we cannot
  // reconstruct, and `observed_from_first_sight` records which of the two a row is, so nobody
  // later reads an empty history as "never amended".
  `CREATE TABLE IF NOT EXISTS solicitation_amendments (
     id                   TEXT PRIMARY KEY,
     company_id           TEXT NOT NULL REFERENCES companies(id),
     solicitation_id      TEXT NOT NULL,
     notice_id            TEXT NOT NULL,
     detected_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     detected_in_sync_id  TEXT,
     significance         TEXT NOT NULL,
     changed_fields       TEXT[] NOT NULL,
     previous_values      JSONB NOT NULL,
     new_values           JSONB NOT NULL,
     observed_from_first_sight BOOLEAN NOT NULL DEFAULT FALSE,
     CONSTRAINT solicitation_amendments_significance_check
       CHECK (significance IN ('deadline_moved','type_changed','withdrawn','material')),
     -- COALESCE IS LOAD-BEARING. array_length(ARRAY[]::text[], 1) returns NULL, not 0, and a CHECK
     -- passes on NULL — it only fails on FALSE. So the obvious spelling, array_length(...) >= 1
     -- without the COALESCE, is VACUOUS for the empty array, which is the one value it exists to
     -- reject. It was written that way first and the harness accepted an amendment with no
     -- changed fields. (No backticks in this comment: it lives inside a JS template literal, and
     -- a backtick here ends the string and breaks the module at load — which also already
     -- happened once in this file.)
     CONSTRAINT solicitation_amendments_fields_not_empty
       CHECK (COALESCE(array_length(changed_fields, 1), 0) >= 1),
     -- MATCH FULL: an amendment may never attach to another tenant's solicitation.
     FOREIGN KEY (solicitation_id, company_id)
       REFERENCES solicitations (id, company_id) MATCH FULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_sol_amend_notice
     ON solicitation_amendments (company_id, notice_id, detected_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sol_amend_significant
     ON solicitation_amendments (company_id, detected_at DESC)
     WHERE significance IN ('deadline_moved','withdrawn','type_changed')`,
];

// ── The registry seed ───────────────────────────────────────────────────────
//
// Every value here is a MEASURED or VENDOR-DOCUMENTED fact, not an estimate. Where a limit is
// unpublished the ceiling is NULL and the notes say so — an invented number would be worse than
// none, because it would look like knowledge.
const CONNECTOR_SEED = Object.freeze([
  {
    source_key: 'usaspending',
    display_name: 'USAspending — federal award history',
    base_url: 'https://api.usaspending.gov/api/v2/',
    kind: 'procurement',
    auth_mode: 'none',
    access_mode: 'api',
    daily_call_ceiling: null,
    activated: true,
    notes: 'No key, no signup, no published quota (PR-1, HTTP 200). Natural key generated_internal_id. '
         + 'Amounts are OBLIGATIONS at action time, not outlays. DoD actions withheld ~90 days, so '
         + 'trailing-quarter DoD trends undercount. Recipient rollups need recipient_id profile '
         + 'resolution, not name matching. Search window earliest 2007-10-01.',
  },
  {
    source_key: 'grants_gov',
    display_name: 'Grants.gov — funding opportunities',
    base_url: 'https://api.grants.gov/v1/api/',
    kind: 'funding',
    auth_mode: 'none',
    access_mode: 'api',
    daily_call_ceiling: null,
    // Activated: ruling 2 authorizes PR-4 ahead of SAM.gov, and this source needs no key, publishes
    // no quota and has a staging host. Nothing is wired or deployed, so activation here records the
    // authorization rather than starting anything.
    activated: true,
    notes: 'PR-4. "Authentication and authorization are not required" (api-guide); confirmed HTTP 200 '
         + 'in PR-1. Natural key oppHits[].id, solicitation number oppHits[].number. docType '
         + 'synopsis|forecast and oppStatus posted|forecasted: a forecast is a PLAN and must never '
         + 'render as biddable. closeDate may be empty. Dates are MM/DD/YYYY strings. '
         + 'fetchOpportunity takes {opportunityId:<number>} and returns opportunityHistoryDetails[] '
         + 'with revision numbers — an unauthenticated amendment chain. Funding pipeline only: '
         + 'never procurement revenue, even for fundingInstrument "PC".',
  },
  {
    source_key: 'sam_gov',
    display_name: 'SAM.gov — federal prime solicitations',
    base_url: 'https://api.sam.gov/',
    kind: 'procurement',
    auth_mode: 'api_key',
    access_mode: 'api',
    daily_call_ceiling: null,
    activated: false,
    notes: 'PR-3, PREPARED BUT NOT ACTIVATED (rulings 5 and 7). '
         + 'CEILING CORRECTED TO NULL ON 2026-11-05. It previously read 10, with a note claiming a '
         + 'system account raises it to ~1,000/day. Neither figure is published. The documentation '
         + 'at open.gsa.gov says only, verbatim, "Request per day are limited based on the federal '
         + 'or non-federal or general roles", and gives NO number for any role — so those values '
         + 'came from recollection, not from a source, and this seed\'s own rule is that an '
         + 'unpublished limit is NULL because an invented number looks like knowledge. A wrong '
         + 'ceiling is not harmless either way: too low refuses valid calls, too high sails past '
         + 'the real limit. CONFIRM THE REAL NUMBER with the entity administrator when the system '
         + 'account is issued, then set it here. '
         + 'Description and attachments each cost a further authenticated call, and the description '
         + 'field is a URL that requires the api_key appended. '
         + 'postedFrom/postedTo required, MM/dd/yyyy, max 365 days apart; limit defaults to 1 and '
         + 'must always be set explicitly. Dedupe on noticeId; track solicitationNumber across '
         + 'amendments. The API returns ONLY the latest version of a notice, so amendment history '
         + 'must be observed by diffing polls — see solicitation_amendments. Federal prime only — '
         + 'no state, local, education, DLA DIBBS or GSA eBuy. '
         + 'Abiozen SAM registration expires 2026-12-30.',
  },
  {
    source_key: 'fedconnect',
    display_name: 'FedConnect — EPA/DOE solicitations (portal)',
    base_url: 'https://www.fedconnect.net/FedConnect/',
    kind: 'procurement',
    auth_mode: 'portal_login',
    access_mode: 'manual_assisted',
    daily_call_ceiling: null,
    activated: false,
    notes: 'PR-1 measured HTTP 302 to a sign-in page. No public API documented — API availability '
         + 'UNKNOWN, not denied. Authenticated access is NOT automated (ruling 3). Scheduled human '
         + 'task plus evidence attachment.',
  },
  {
    source_key: 'hhs_sbcx',
    display_name: 'HHS Small Business Contracting Exchange (portal)',
    base_url: 'https://mysbcx.hhs.gov/',
    kind: 'procurement',
    auth_mode: 'portal_login',
    access_mode: 'manual_assisted',
    daily_call_ceiling: null,
    activated: false,
    notes: 'Authenticated portal operated by Apex Logic. The HHS developer page publishes no API and '
         + 'does not mention SBCX. Brief §2/§3 place it outside automated access entirely: manual '
         + 'workflow, no login automation, no browser extraction.',
  },
]);

// Idempotent seed. ON CONFLICT updates the descriptive columns so a corrected note or a verified
// ceiling propagates, but DELIBERATELY DOES NOT TOUCH `activated`. Activation is an operational
// decision somebody made; a migration re-run must not quietly switch a source back on — or off.
const SEED_SQL = `
  INSERT INTO source_connectors
    (source_key, display_name, base_url, kind, auth_mode, access_mode, daily_call_ceiling, activated, notes)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  ON CONFLICT (source_key) DO UPDATE SET
    display_name       = EXCLUDED.display_name,
    base_url           = EXCLUDED.base_url,
    kind               = EXCLUDED.kind,
    auth_mode          = EXCLUDED.auth_mode,
    access_mode        = EXCLUDED.access_mode,
    daily_call_ceiling = EXCLUDED.daily_call_ceiling,
    notes              = EXCLUDED.notes`;

// 42710 duplicate_object, 42P07 duplicate_table, 42701 duplicate_column. Same set and same reason
// as the office migration: anything else propagates.
const IGNORABLE = new Set(['42710', '42P07', '42701']);

async function migrateConnectors(query) {
  for (const stmt of DDL) {
    try {
      await query(stmt);
    } catch (e) {
      if (!IGNORABLE.has(e.code)) {
        throw new Error(`connector schema failed on [${stmt.slice(0, 72).replace(/\s+/g, ' ')}…]: ${e.message}`);
      }
    }
  }
  for (const c of CONNECTOR_SEED) {
    await query(SEED_SQL, [c.source_key, c.display_name, c.base_url, c.kind,
      c.auth_mode, c.access_mode, c.daily_call_ceiling, c.activated, c.notes]);
  }
  return { ok: true, tables: CONNECTOR_TABLES.length, connectors: CONNECTOR_SEED.length };
}

// Read by scripts/check-office-scope-discipline.js's sibling check, so adding a table here brings
// it under the tenant-scope check automatically instead of requiring somebody to list it twice.
const CONNECTOR_TABLES = Object.freeze([
  'source_sync_runs',
  'federal_awards',
  'funding_opportunities',
  'funding_opportunity_versions',
  'eligibility_assessments',
  'eligibility_findings',
  'verified_capabilities',
  'capability_scope_items',
  'review_tasks',
  'solicitations',
  'solicitation_amendments',
]);

// source_connectors is deliberately absent from CONNECTOR_TABLES: it holds global facts about
// public APIs and carries no company_id, as documented at the top of this file.
const GLOBAL_TABLES = Object.freeze(['source_connectors']);

module.exports = { migrateConnectors, DDL, CONNECTOR_SEED, CONNECTOR_TABLES, GLOBAL_TABLES };
