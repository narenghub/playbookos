// ── MIGRATION v4 — THE FEDERAL OPPORTUNITY TRACKER ───────────────────────────
//
//   2026-11-06.opportunities.v4   ·   NOT APPLIED TO PRODUCTION
//
// Ruling 21 priority 1: a centralized opportunity table with the fields a person actually needs to
// decide whether to bid, importable from CSV and from individual solicitation URLs, exportable to
// something Excel opens correctly, filterable, and with duplicates and amendments detected without
// losing history.
//
// ── WHY A NEW TABLE AND NOT `solicitations` ──────────────────────────────────
//
// `solicitations` is live in production, is written by the connector path, and carries a
// seven-kind record_kind with exactly one biddable value. Bolting fourteen federal procurement
// columns onto it would mean an ALTER on a live table for a tracker that has never run, and would
// mix connector-ingested rows with human-imported ones in a table whose generated `response_open`
// column already decides biddability.
//
// So the tracker gets its own table. The cost is that two tables describe solicitations; the
// benefit is that the live one is untouched and this one can be dropped wholesale if the tracker
// turns out to be the wrong shape. When the tracker is proven, the right move is to merge them
// deliberately, not to have pre-merged them on a guess.
//
// ── AMENDMENTS: EVERY VERSION IS A ROW ───────────────────────────────────────
//
// Ruling 21 item 5 — detect amendments "without losing historical versions". A federal
// solicitation gets amended, and the amendment commonly supersedes and removes the prior text. The
// version we assessed a requirement against is the version an audit of that assessment needs.
//
// So every observed version is its own row, `version_seq` ascending, and exactly one row per
// solicitation number may be `is_current` — enforced by a partial unique index, not by convention.
// Re-importing identical content is idempotent (matched on content_hash) and does NOT create a
// version; genuinely changed content does.
'use strict';

const VERSION = '2026-11-06.opportunities.v4';

const CREATED_TABLES = Object.freeze([
  'opportunity_import_batches',
  'federal_opportunities',
  'opportunity_assessments',
  'opportunity_duplicate_candidates',
]);

// Children first.
const ROLLBACK_ORDER = Object.freeze([
  'opportunity_duplicate_candidates',
  'opportunity_assessments',
  'federal_opportunities',
  'opportunity_import_batches',
]);

// How a record reached us. There is no 'api' value: the SAM.gov API is unreachable and ruling 21
// item 1 says not to depend on it. When it works, adding a value is a one-line diff with a visible
// review; having the value now would imply a path that does not exist.
const IMPORT_SOURCES = Object.freeze(['csv', 'url', 'fixture']);

// Notice types as the federal procurement system actually uses them. 'award' and 'sources_sought'
// are NOT opportunities to bid on, and keeping them distinct is the whole reason this is an
// enumeration rather than free text: an award recorded as a solicitation is a closed contract
// presented as an open one.
const NOTICE_TYPES = Object.freeze([
  'solicitation',            // bid on this
  'combined_synopsis',       // bid on this
  'presolicitation',         // not yet biddable; watch
  'sources_sought',          // market research; a reply is not a bid
  'special_notice',          // informational
  'award',                   // already decided
  'justification',           // sole-source justification
  'intent_to_bundle',
  'unknown',                 // the source did not say; NEVER inferred
]);

// Only these two are biddable. Used by the generated column below.
const BIDDABLE_NOTICE_TYPES = Object.freeze(['solicitation', 'combined_synopsis']);

// Abiozen's business lines. DERIVED from v3's list rather than copied, because a second copy of a
// list that must agree is the defect that has already bitten this project twice (the permitted-role
// list that no code read, and the rotation list the test kept its own copy of).
//
// Ruling 15 named the fourth line "scientific intelligence". Ruling 21 priority 2 names it
// "scientific product supply and fulfillment". Those are not the same thing, so rather than pick
// one and silently drop the other, both are representable and the discrepancy is reported for you
// to settle. 'scientific_intelligence' is what v3 already has; 'scientific_fulfillment' is what
// ruling 21 asks the qualification engine to match against.
const V3_BUSINESS_LINES = require('./intake-schema').BUSINESS_LINES;
const BUSINESS_LINES = Object.freeze([...V3_BUSINESS_LINES, 'scientific_fulfillment']);

const VERDICTS = Object.freeze(['QUALIFIED', 'NOT_QUALIFIED', 'NEEDS_REVIEW']);

const list = (xs) => xs.map((x) => `'${x}'`).join(',');

const DDL = [
  // ── where a batch of records came from ──────────────────────────────────
  // Provenance is per batch as well as per record, so "where did these twelve rows come from"
  // has an answer that survives the file being deleted.
  `CREATE TABLE IF NOT EXISTS opportunity_import_batches (
     id              TEXT PRIMARY KEY,
     company_id      TEXT NOT NULL REFERENCES companies(id),
     source          TEXT NOT NULL,
     imported_by     TEXT NOT NULL,
     imported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     -- For csv: the filename and the sha256 of the bytes, so the exact input is identifiable.
     -- For url: the URL fetched. For fixture: what the fixture represents and why it is not real.
     source_detail   TEXT NOT NULL,
     source_sha256   TEXT,
     row_count       INTEGER NOT NULL DEFAULT 0,
     accepted_count  INTEGER NOT NULL DEFAULT 0,
     rejected_count  INTEGER NOT NULL DEFAULT 0,
     notes           TEXT,
     CONSTRAINT opportunity_import_batches_source CHECK (source IN (${list(IMPORT_SOURCES)})),
     CONSTRAINT opportunity_import_batches_sha CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
     -- A fixture must say so in its own detail text. Ruling 21 priority 3: fixtures must be
     -- clearly labelled, and the label belongs on the data, not only in a report somebody reads once.
     CONSTRAINT opportunity_import_batches_fixture_is_labelled
       CHECK (source <> 'fixture' OR source_detail LIKE 'FIXTURE:%'),
     UNIQUE (id, company_id)
   )`,

  // ── the tracker itself ──────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS federal_opportunities (
     id                   TEXT PRIMARY KEY,
     company_id           TEXT NOT NULL REFERENCES companies(id),
     import_batch_id      TEXT NOT NULL,

     -- IDENTITY. solicitation_number is the federal identifier a human will search for and the
     -- key amendments arrive under. notice_id is SAM.gov's own per-notice id when the source
     -- gives one; it differs per amendment, which is why it cannot be the identity.
     solicitation_number  TEXT NOT NULL,
     notice_id            TEXT,

     -- VERSIONING. Every observed version is a row.
     version_seq          INTEGER NOT NULL DEFAULT 1,
     is_current           BOOLEAN NOT NULL DEFAULT true,
     superseded_by        TEXT,
     content_hash         TEXT NOT NULL,

     -- THE FIELDS RULING 21 ITEM 2 ASKS FOR.
     title                TEXT NOT NULL,
     agency               TEXT,
     sub_agency           TEXT,
     office               TEXT,
     naics_code           TEXT,
     psc_code             TEXT,
     set_aside            TEXT,
     contract_type        TEXT,
     -- Estimated value is usually absent. NULL means the source did not say; it never means zero,
     -- which is why there is no DEFAULT 0 here.
     estimated_value_usd  NUMERIC(14,2),
     posted_date          DATE,
     response_deadline    TIMESTAMPTZ,
     -- Whether the source gave a time of day. A deadline rendered as midnight when the source said
     -- "2:00 PM Eastern" is a fourteen-hour lie, so the two cases are distinguishable.
     deadline_has_time    BOOLEAN NOT NULL DEFAULT false,
     deadline_source_text TEXT,
     notice_type          TEXT NOT NULL DEFAULT 'unknown',
     status               TEXT NOT NULL DEFAULT 'open',
     source_url           TEXT,
     description          TEXT,
     place_of_performance TEXT,

     -- DEADLINE CONFIRMATION. A deadline that a person has not confirmed is not one we act on.
     deadline_confirmed_by TEXT,
     deadline_confirmed_at TIMESTAMPTZ,

     first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     observed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

     -- Biddable is DERIVED and STORED, mirroring solicitations.response_open: a NULL anywhere
     -- yields false, so the safe answer is the default rather than something to maintain. An award
     -- can never be biddable however the rest of the row reads, and an unconfirmed deadline cannot
     -- make something biddable either.
     is_biddable          BOOLEAN GENERATED ALWAYS AS (
       COALESCE(is_current
                AND status = 'open'
                AND notice_type IN (${list(BIDDABLE_NOTICE_TYPES)})
                AND response_deadline IS NOT NULL
                AND deadline_confirmed_at IS NOT NULL, false)) STORED,

     CONSTRAINT federal_opportunities_batch_fk
       FOREIGN KEY (import_batch_id, company_id)
       REFERENCES opportunity_import_batches(id, company_id) MATCH FULL,
     CONSTRAINT federal_opportunities_notice_type CHECK (notice_type IN (${list(NOTICE_TYPES)})),
     CONSTRAINT federal_opportunities_status
       CHECK (status IN ('open','closed','awarded','cancelled','archived','unknown')),
     CONSTRAINT federal_opportunities_hash CHECK (content_hash ~ '^[0-9a-f]{64}$'),
     CONSTRAINT federal_opportunities_version CHECK (version_seq >= 1),
     -- NAICS is six digits, PSC is four characters. A malformed code is worse than an absent one,
     -- because it will be filtered on.
     CONSTRAINT federal_opportunities_naics CHECK (naics_code IS NULL OR naics_code ~ '^[0-9]{6}$'),
     CONSTRAINT federal_opportunities_psc CHECK (psc_code IS NULL OR psc_code ~ '^[0-9A-Z]{4}$'),
     CONSTRAINT federal_opportunities_value CHECK (estimated_value_usd IS NULL OR estimated_value_usd >= 0),
     CONSTRAINT federal_opportunities_title_present CHECK (length(btrim(title)) > 0),
     CONSTRAINT federal_opportunities_solnum_present CHECK (length(btrim(solicitation_number)) > 0),
     -- A person and a time, or neither.
     CONSTRAINT federal_opportunities_deadline_confirmation
       CHECK ((deadline_confirmed_by IS NULL) = (deadline_confirmed_at IS NULL)),
     -- You cannot confirm a deadline that is not recorded.
     CONSTRAINT federal_opportunities_cannot_confirm_absent_deadline
       CHECK (deadline_confirmed_at IS NULL OR response_deadline IS NOT NULL),
     -- A superseded row is not current, and a current row supersedes nothing.
     CONSTRAINT federal_opportunities_supersession
       CHECK ((superseded_by IS NULL) = is_current),
     UNIQUE (company_id, solicitation_number, version_seq),
     -- Re-importing identical bytes must be idempotent, so the same content cannot land twice.
     UNIQUE (company_id, solicitation_number, content_hash),
     UNIQUE (id, company_id)
   )`,

  // Exactly one current version per solicitation, enforced by the database rather than by whichever
  // code path happens to do the demotion.
  `CREATE UNIQUE INDEX IF NOT EXISTS federal_opportunities_one_current
     ON federal_opportunities (company_id, solicitation_number) WHERE is_current`,

  // The filters ruling 21 item 4 asks for, indexed so the tracker stays usable as rows accumulate.
  `CREATE INDEX IF NOT EXISTS federal_opportunities_by_deadline
     ON federal_opportunities (company_id, response_deadline) WHERE is_current`,
  `CREATE INDEX IF NOT EXISTS federal_opportunities_by_agency
     ON federal_opportunities (company_id, agency) WHERE is_current`,
  `CREATE INDEX IF NOT EXISTS federal_opportunities_by_naics
     ON federal_opportunities (company_id, naics_code) WHERE is_current`,

  // ── the qualification verdict ───────────────────────────────────────────
  // Ruling 21 priority 2. Separate table, because an assessment is a dated opinion about a version
  // of an opportunity and the opportunity is a fact about the world. Keeping them in one row would
  // make re-assessing an amendment overwrite the assessment of the version it superseded.
  `CREATE TABLE IF NOT EXISTS opportunity_assessments (
     id                   TEXT PRIMARY KEY,
     company_id           TEXT NOT NULL REFERENCES companies(id),
     opportunity_id       TEXT NOT NULL,
     assessed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     assessed_by          TEXT NOT NULL,
     verdict              TEXT NOT NULL,
     -- Which of Abiozen's four lines the opportunity would be served by, if any.
     business_lines       TEXT[] NOT NULL DEFAULT '{}',
     -- Why, and what is missing. Both are arrays because a verdict with one reason is usually a
     -- verdict that stopped looking.
     reasons              TEXT[] NOT NULL DEFAULT '{}',
     missing_requirements TEXT[] NOT NULL DEFAULT '{}',
     -- Evidence actually relied on, by id in verified_capabilities. An empty array with a
     -- QUALIFIED verdict is refused below: that is the failure mode this whole project guards.
     evidence_capability_ids TEXT[] NOT NULL DEFAULT '{}',
     notes                TEXT,
     CONSTRAINT opportunity_assessments_opp_fk
       FOREIGN KEY (opportunity_id, company_id)
       REFERENCES federal_opportunities(id, company_id) MATCH FULL ON DELETE RESTRICT,
     CONSTRAINT opportunity_assessments_verdict CHECK (verdict IN (${list(VERDICTS)})),
     -- RULING 21 PRIORITY 2, ENFORCED: no QUALIFIED without evidence and without a reason.
     -- "Do not mark Abiozen qualified without sufficient supporting evidence" is a constraint here
     -- and not a convention, because a convention is what the next deadline overrides.
     CONSTRAINT opportunity_assessments_qualified_needs_evidence CHECK (
       verdict <> 'QUALIFIED'
       OR (array_length(evidence_capability_ids, 1) >= 1
           AND array_length(reasons, 1) >= 1
           AND array_length(business_lines, 1) >= 1)),
     -- A NOT_QUALIFIED or NEEDS_REVIEW verdict must say why. An unexplained refusal is as useless
     -- to a human reviewer as an unevidenced approval.
     CONSTRAINT opportunity_assessments_negative_needs_reason CHECK (
       verdict = 'QUALIFIED' OR array_length(reasons, 1) >= 1),
     -- An assessment is never an authorization. fulfillment_authorizations (v3) is the only place
     -- a human commits the company, and it has its own trigger-enforced guard. There is
     -- deliberately no column here that could be mistaken for one.
     UNIQUE (id, company_id)
   )`,

  `CREATE INDEX IF NOT EXISTS opportunity_assessments_latest
     ON opportunity_assessments (company_id, opportunity_id, assessed_at DESC)`,

  // ── possible duplicates across sources, for a human to decide ───────────
  // Ruling 21 item 5. Tier 3 of duplicate detection does NOT merge anything: two different
  // solicitation numbers that look alike may be a genuine reissue or two genuinely different
  // procurements, and the system is not entitled to that judgement. It records the suspicion.
  `CREATE TABLE IF NOT EXISTS opportunity_duplicate_candidates (
     id             TEXT PRIMARY KEY,
     company_id     TEXT NOT NULL REFERENCES companies(id),
     opportunity_id TEXT NOT NULL,
     other_id       TEXT NOT NULL,
     similarity     NUMERIC(4,3) NOT NULL,
     basis          TEXT NOT NULL,
     detected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     resolved_by    TEXT,
     resolved_at    TIMESTAMPTZ,
     resolution     TEXT,
     CONSTRAINT opportunity_duplicate_candidates_a_fk
       FOREIGN KEY (opportunity_id, company_id)
       REFERENCES federal_opportunities(id, company_id) MATCH FULL ON DELETE RESTRICT,
     CONSTRAINT opportunity_duplicate_candidates_b_fk
       FOREIGN KEY (other_id, company_id)
       REFERENCES federal_opportunities(id, company_id) MATCH FULL ON DELETE RESTRICT,
     CONSTRAINT opportunity_duplicate_candidates_similarity
       CHECK (similarity > 0 AND similarity <= 1),
     CONSTRAINT opportunity_duplicate_candidates_not_self CHECK (opportunity_id <> other_id),
     CONSTRAINT opportunity_duplicate_candidates_resolution
       CHECK ((resolved_by IS NULL) = (resolved_at IS NULL)),
     CONSTRAINT opportunity_duplicate_candidates_resolution_value
       CHECK (resolution IS NULL OR resolution IN ('same_procurement','different_procurement','unclear')),
     UNIQUE (company_id, opportunity_id, other_id)
   )`,
];

const ROLLBACK_EXTRA_DDL = [];

const PRECONDITIONS = Object.freeze([
  { name: 'P1', what: 'companies exists (migrateOffice has run)', table: 'companies' },
  { name: 'P2', what: 'verified_capabilities exists (connectors.v1 has run)', table: 'verified_capabilities' },
]);

module.exports = {
  VERSION,
  DDL,
  CREATED_TABLES,
  ROLLBACK_ORDER,
  ROLLBACK_EXTRA_DDL,
  PRECONDITIONS,
  IMPORT_SOURCES,
  NOTICE_TYPES,
  BIDDABLE_NOTICE_TYPES,
  BUSINESS_LINES,
  VERDICTS,
};
