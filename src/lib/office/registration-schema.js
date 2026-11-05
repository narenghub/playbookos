'use strict';
// ── LEGAL-ENTITY REGISTRATIONS, BRANDS, AND THE WIDER CAPABILITY KINDS ──────
//
// Ruling 12 item 4. Prepared, NOT applied.
//
// ── WHY THIS SCHEMA EXISTS AT ALL ───────────────────────────────────────────
//
// `qualify.js` treats an absent registration as UNKNOWN and returns NEEDS_REVIEW. There is no
// stored registration record anywhere in this system — `companies` carries `id`, `slug`,
// `display_name`, `status` and nothing else — so **nothing can reach QUALIFIED today.** One missing
// row gates the whole product. The dashboard already renders from `caps.registration` with
// uei / cage / status / expires_on, so the shape is settled; what is missing is a place to put it
// and a way to say where it came from.
//
// ── THE DISTINCTION RULING 12 ITEM 5 MAKES, ENFORCED STRUCTURALLY ───────────
//
//   "Distinguish Abiozen LLC as the contracting legal entity from Abiozen Scientific and CRO360
//    as operating brands or divisions unless authoritative records prove separate legal entities.
//    Do not infer corporate registrations from brand names."
//
// This is a modelling instruction, not a note, and the way to honour it is to make the wrong thing
// unrepresentable rather than discouraged:
//
//   1. A REGISTRATION HANGS OFF A COMPANY, AND A BRAND IS NOT A COMPANY.
//      `company_registrations.company_id REFERENCES companies(id)`. Brands live in their own
//      table. There is therefore NO COLUMN through which a brand could acquire a UEI, a CAGE code
//      or a registration expiry. "Abiozen Scientific holds a SAM registration" is not a claim this
//      schema can express — which is the point, because it is a claim nobody has evidence for.
//
//   2. CALLING A BRAND A SEPARATE LEGAL ENTITY REQUIRES DOCUMENTS AND AN APPROVAL.
//      `company_brands.legal_status` defaults to 'brand_or_division'. Setting it to
//      'separate_legal_entity' is refused by a CHECK unless evidence, a verifier, a date and an
//      approval id are all present — the same discipline as `verified_capabilities`. So the
//      promotion is a decision with a paper trail, not an UPDATE somebody runs.
//
//   3. A CAPABILITY IS ATTRIBUTED TO A BRAND, NOT REGISTERED BY ONE.
//      `verified_capabilities.brand_id` points at a brand of the SAME tenant, by composite FK.
//      Attribution is useful — it says which part of the business does the work — and it is
//      deliberately a different thing from legal identity.
//
// A related trap this closes: `matchTier('CRO360', 'CRO 360 Inc')` returns null. One space defeats
// the matcher, so a search keyed on a normalised brand name reports an entity as holding NO
// records whatever while a real row sits in the table — output indistinguishable from a completed
// search. `company_brands.aliases` exists so the spellings are recorded data rather than something
// a matcher has to guess at.
//
// ── WHY HISTORY IS A SEPARATE, APPEND-ONLY TABLE ────────────────────────────
//
// A registration is not a fact, it is a fact *as of a date*. It gets renewed; its expiry moves;
// its status changes. And qualification is evaluated against a solicitation's SUBMISSION DEADLINE
// rather than against today, so the question "was this registration valid when we said this bid
// qualified?" has to be answerable months later. A single mutable row cannot answer it: the
// renewal overwrites the evidence the earlier verdict rested on.
//
// So `company_registration_observations` records every read of the authoritative source, with the
// raw payload, and nothing updates it. The current-state row is a convenience; the observations
// are the record. Same reasoning as `funding_opportunity_versions`: where the API hands over only
// a current snapshot, history is something we keep, not something we fetch.
//
// ── THE EXPIRY IS IN THE EVIDENCE CONSTRAINT ON PURPOSE ─────────────────────
//
// A registration record with no expiry cannot be checked against a submission deadline, so a
// 'verified' one lacking it would be worse than no record at all — it would satisfy the
// qualification gate's existence check while being unable to answer the only question the gate
// asks. `expires_on` is therefore required for 'verified', alongside the provenance columns.

const VERSION = '2026-11-06.registrations.v2';

// Tables this migration creates, and the order they must be dropped in (children first).
const CREATED_TABLES = Object.freeze([
  'company_brands',
  'company_registrations',
  'company_registration_observations',
]);
const ROLLBACK_ORDER = Object.freeze([
  'company_registration_observations',
  'company_registrations',
  'company_brands',
]);

// The capability kinds. The first two are what the live CHECK allows today; the rest are the ones
// ruling 11 item 5 named and the schema could not express — a certification forced in as
// 'capability' loses the distinction that was explicitly asked for.
const CAPABILITY_KINDS = Object.freeze([
  'capability',
  'accreditation',
  'certification',
  'regulatory_authorization',
  'equipment',
  'service_capability',
  'quality_system',
]);
const CAPABILITY_KINDS_BEFORE = Object.freeze(['capability', 'accreditation']);

const kindList = (ks) => ks.map((k) => `'${k}'`).join(',');

const DDL = [
  // ─────────────────────────────────────────────────────────────────────────
  // BRANDS AND DIVISIONS — not legal entities until proven otherwise
  // ─────────────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS company_brands (
     id                   TEXT PRIMARY KEY,
     company_id           TEXT NOT NULL REFERENCES companies(id),
     name                 TEXT NOT NULL,
     -- Recorded spellings, because one space defeated the name matcher and reported a real entity
     -- as holding no records at all. Data, not a guess made at query time.
     aliases              TEXT[] NOT NULL DEFAULT '{}',
     -- DEFAULT IS THE SAFE CLAIM. Ruling 12 item 5: a brand is a brand until authoritative
     -- records prove a separate legal entity.
     legal_status         TEXT NOT NULL DEFAULT 'brand_or_division',
     -- Provenance for a promotion to separate legal entity. Same shape as verified_capabilities.
     evidence_source      TEXT,
     evidence_url         TEXT,
     evidence_sha256      TEXT,
     verified_at          TIMESTAMPTZ,
     verified_by          TEXT,
     approval_id          TEXT,
     notes                TEXT,
     created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT company_brands_legal_status_check
       CHECK (legal_status IN ('brand_or_division','separate_legal_entity')),
     -- THE CONTROL FOR ITEM 5. 'separate_legal_entity' is unreachable without documents, a
     -- verifier, a date and the approval that authorised it. A brand cannot become a legal entity
     -- by editing one column, which is exactly how a brand name would otherwise acquire a
     -- corporate registration nobody evidenced.
     CONSTRAINT company_brands_legal_entity_requires_evidence
       CHECK (
         legal_status <> 'separate_legal_entity' OR (
           evidence_source IS NOT NULL AND length(btrim(evidence_source)) > 0
           AND verified_at IS NOT NULL
           AND verified_by IS NOT NULL AND length(btrim(verified_by)) > 0
           AND approval_id IS NOT NULL AND length(btrim(approval_id)) > 0
         )
       ),
     UNIQUE (company_id, name),
     -- Composite FK target, so anything attributing to a brand cannot cross tenants.
     UNIQUE (id, company_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_company_brands_company
     ON company_brands (company_id, name)`,

  // ─────────────────────────────────────────────────────────────────────────
  // REGISTRATIONS — current state, for a LEGAL ENTITY only
  // ─────────────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS company_registrations (
     id                     TEXT PRIMARY KEY,
     -- A company. There is no brand_id here, and that absence is the enforcement of item 5.
     company_id             TEXT NOT NULL REFERENCES companies(id),
     registry               TEXT NOT NULL,
     -- Legal identity AS THE REGISTRY STATES IT, not as we call the company internally.
     legal_name             TEXT,
     uei                    TEXT,
     cage_code              TEXT,
     registration_status    TEXT,
     purpose_of_registration TEXT,
     registered_at          DATE,
     expires_on             DATE,
     physical_address       TEXT,
     exclusion_flag         TEXT,
     verification_status    TEXT NOT NULL DEFAULT 'pending',
     evidence_source        TEXT,
     evidence_url           TEXT,
     evidence_sha256        TEXT,
     verified_at            TIMESTAMPTZ,
     verified_by            TEXT,
     approval_id            TEXT,
     created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT company_registrations_registry_check
       CHECK (registry IN ('sam_gov','fedconnect','state','other')),
     CONSTRAINT company_registrations_status_check
       CHECK (verification_status IN ('pending','verified','disputed','expired','revoked')),
     -- expires_on IS IN HERE DELIBERATELY. A verified registration with no expiry would satisfy the
     -- qualification gate's existence check while being unable to answer the only question that
     -- gate asks — is this valid at the submission deadline — which is worse than no record.
     CONSTRAINT company_registrations_verified_requires_evidence
       CHECK (
         verification_status <> 'verified' OR (
           evidence_source IS NOT NULL AND length(btrim(evidence_source)) > 0
           AND verified_at IS NOT NULL
           AND verified_by IS NOT NULL AND length(btrim(verified_by)) > 0
           AND approval_id IS NOT NULL AND length(btrim(approval_id)) > 0
           AND expires_on IS NOT NULL
           AND uei IS NOT NULL AND length(btrim(uei)) > 0
         )
       ),
     CONSTRAINT company_registrations_window_check
       CHECK (registered_at IS NULL OR expires_on IS NULL OR expires_on >= registered_at),
     UNIQUE (company_id, registry, uei),
     UNIQUE (id, company_id)
   )`,
  // The expiry index exists because the hot query is "is this valid at that deadline", not
  // "is this valid now".
  `CREATE INDEX IF NOT EXISTS idx_company_registrations_expiry
     ON company_registrations (company_id, expires_on)`,
  `CREATE INDEX IF NOT EXISTS idx_company_registrations_registry
     ON company_registrations (company_id, registry, verification_status)`,

  // ─────────────────────────────────────────────────────────────────────────
  // OBSERVATIONS — append-only history of what the authoritative source said
  // ─────────────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS company_registration_observations (
     id                   TEXT PRIMARY KEY,
     company_id           TEXT NOT NULL,
     registration_id      TEXT NOT NULL,
     observed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     observed_by          TEXT,
     source               TEXT NOT NULL,
     source_version       TEXT,
     registration_status  TEXT,
     expires_on           DATE,
     raw_json             JSONB,
     created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     -- MATCH FULL on a composite FK, the house pattern: the tenant column is part of the key, so
     -- the constraint fires on the write from inside the engine rather than in a WHERE clause
     -- somebody has to remember. company_id is NOT NULL here because this table has no legacy
     -- rows owed any latitude — a nullable tenant column on a new table reopens the exact evasion
     -- MATCH FULL closes.
     CONSTRAINT company_registration_observations_tenant_fk
       FOREIGN KEY (registration_id, company_id)
       REFERENCES company_registrations (id, company_id) MATCH FULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_registration_observations_latest
     ON company_registration_observations (registration_id, observed_at DESC)`,

  // ─────────────────────────────────────────────────────────────────────────
  // WIDEN THE CAPABILITY KINDS, AND ATTRIBUTE TO A BRAND
  // ─────────────────────────────────────────────────────────────────────────
  //
  // THE ONLY NON-ADDITIVE STEP IN THIS MIGRATION. Widening a CHECK cannot invalidate an existing
  // row — every value the old constraint permitted the new one permits — so this is safe in the
  // forward direction. It is the ROLLBACK that is dangerous, and the runner refuses it rather
  // than discovering the problem halfway through. See the rollback guard.
  `ALTER TABLE verified_capabilities
     DROP CONSTRAINT IF EXISTS verified_capabilities_kind_check`,
  `ALTER TABLE verified_capabilities
     ADD CONSTRAINT verified_capabilities_kind_check
     CHECK (kind IN (${kindList(CAPABILITY_KINDS)}))`,
  `ALTER TABLE verified_capabilities
     ADD COLUMN IF NOT EXISTS brand_id TEXT`,
  // Attribution cannot cross tenants. Added as a named constraint so rollback can drop it by name.
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'verified_capabilities_brand_tenant_fk'
     ) THEN
       ALTER TABLE verified_capabilities
         ADD CONSTRAINT verified_capabilities_brand_tenant_fk
         FOREIGN KEY (brand_id, company_id)
         REFERENCES company_brands (id, company_id) MATCH SIMPLE;
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS idx_verified_capabilities_brand
     ON verified_capabilities (company_id, brand_id)`,
];

// Reverting the capability changes. Ordered: drop what depends on company_brands before the
// rollback drops that table.
const ROLLBACK_CAPABILITY_DDL = [
  `ALTER TABLE verified_capabilities
     DROP CONSTRAINT IF EXISTS verified_capabilities_brand_tenant_fk`,
  `DROP INDEX IF EXISTS idx_verified_capabilities_brand`,
  `ALTER TABLE verified_capabilities DROP COLUMN IF EXISTS brand_id`,
  `ALTER TABLE verified_capabilities
     DROP CONSTRAINT IF EXISTS verified_capabilities_kind_check`,
  `ALTER TABLE verified_capabilities
     ADD CONSTRAINT verified_capabilities_kind_check
     CHECK (kind IN (${kindList(CAPABILITY_KINDS_BEFORE)}))`,
];

// What must already exist. P1/P2 are the tables this migration references by foreign key; P3 is
// the table it alters. Checked before anything is written, so a wrong target database is a refusal
// rather than a half-applied schema.
const PRECONDITIONS = Object.freeze([
  { name: 'P1', what: 'companies exists (migrateOffice has run)', table: 'companies' },
  { name: 'P2', what: 'verified_capabilities exists (connectors.v1 has run)', table: 'verified_capabilities' },
]);

module.exports = {
  VERSION,
  DDL,
  ROLLBACK_ORDER,
  ROLLBACK_CAPABILITY_DDL,
  CREATED_TABLES,
  CAPABILITY_KINDS,
  CAPABILITY_KINDS_BEFORE,
  PRECONDITIONS,
};
