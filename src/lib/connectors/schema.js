'use strict';
// ── PRPA CONNECTOR SPINE — SCHEMA ────────────────────────────────────────────
//
// Additive-only. Follows src/lib/office/schema.js exactly: a DDL array applied statement by
// statement, swallowing only the three "already exists" codes, because a migration that hides a
// real error is worse than one that fails.
//
// ROLLBACK (safe, additive — nothing existing is altered):
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
// The seed below inserts sam_gov with activated = FALSE and a ceiling of 10 — the personal-key
// limit — so that if it is ever activated before a system account exists, the ceiling stops it
// after ten calls instead of letting it 429 halfway through and leave a false high-water mark.

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
  // BIDDABILITY IS GENERATED, NOT STORED BY A CALLER. The first probe found 5 of 10 hits were
  // forecasts — plans, with an empty close date — and an empty close date is not "no deadline,
  // apply anytime". If `biddable` were an ordinary column, some later writer would set it from a
  // field it misread, and a forecast would render as a live opportunity. As a generated column the
  // database computes it from the three facts that decide it and no INSERT can assert otherwise.
  // COALESCE wraps the expression so an unknown status yields FALSE rather than NULL: for a
  // control, "we do not know" and "not biddable" must be the same answer.
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
     biddable             BOOLEAN GENERATED ALWAYS AS (
       COALESCE(opp_status = 'posted' AND doc_type <> 'forecast' AND close_date IS NOT NULL, false)
     ) STORED,
     CONSTRAINT funding_opportunities_standing_check
       CHECK (standing IN ('open','posted_no_deadline','forecast','closed','archived','unknown'))
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_fo_natural_key
     ON funding_opportunities (company_id, source_key, opportunity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fo_close ON funding_opportunities (company_id, close_date)
     WHERE close_date IS NOT NULL`,
  // The dashboard's "live federal funding" view reads this and nothing else.
  `CREATE INDEX IF NOT EXISTS idx_fo_biddable ON funding_opportunities (company_id, close_date)
     WHERE biddable`,
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
    daily_call_ceiling: 10,
    activated: false,
    notes: 'PR-3, PREPARED BUT NOT ACTIVATED (ruling 5). Ceiling 10 = the personal-key limit; a '
         + 'system account raises it to ~1,000/day and must be obtained via the entity administrator '
         + 'before activation. Description and attachments each cost a further authenticated call. '
         + 'postedFrom/postedTo required, MM/dd/yyyy, max 365 days apart. Dedupe on noticeId; track '
         + 'solicitationNumber across amendments. Federal prime only — no state, local, education, '
         + 'DLA DIBBS or GSA eBuy. Abiozen SAM registration expires 2026-12-30.',
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
]);

// source_connectors is deliberately absent from CONNECTOR_TABLES: it holds global facts about
// public APIs and carries no company_id, as documented at the top of this file.
const GLOBAL_TABLES = Object.freeze(['source_connectors']);

module.exports = { migrateConnectors, DDL, CONNECTOR_SEED, CONNECTOR_TABLES, GLOBAL_TABLES };
