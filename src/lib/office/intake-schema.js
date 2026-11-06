'use strict';
// ── MANUAL SOLICITATION INTAKE — SCHEMA v3 ──────────────────────────────────
//
// Ruling 15. Prepared and tested, NOT APPLIED to production.
//
// ── THE THREE THINGS RULING 15 ITEM 1 SEPARATES ─────────────────────────────
//
// My earlier design had two: a match either supported a commercial commitment or it did not. That
// collapsed three different questions into one boolean, and the ruling is right to split them:
//
//   1. EVIDENCE SUFFICIENCY   — is there adequate, current evidence for THIS requirement?
//                               Computed. Lives on requirement_matches.evidence_sufficient.
//
//   2. ELIGIBILITY            — does the solicitation's whole mandatory set come out satisfied?
//                               Computed by qualify.js from (1). Still only ever NEEDS_REVIEW while
//                               anything is UNKNOWN.
//
//   3. AUTHORIZATION TO BID   — may Abiozen commit to delivering this?
//                               A HUMAN DECISION. Never computed, never derived, never implied by
//                               (1) or (2). fulfillment_authorizations, below.
//
// "A previous delivery, supplier quote, catalog listing, or synthesis prediction must never
// independently establish guaranteed fulfillment." Note that this names prior_delivery and
// supplier_quote too — not just the three indicative classes. So no evidence class, however good,
// establishes fulfillment. The strongest thing evidence can do is make a requirement SUFFICIENT,
// and sufficiency across every requirement still is not a commitment.
//
// That is why authorization is a separate table and not a column. A column on solicitations would
// be one UPDATE away from being set by whatever computed the verdict; a table whose every row
// requires an approval id, an authorizing person and a timestamp cannot be produced by an
// evaluation at all. The asymmetry is deliberate: evidence flows upward into sufficiency
// automatically, and nothing flows upward into authorization ever.
//
// ── WHAT ITEM 2 CAN AND CANNOT BE GIVEN ─────────────────────────────────────
//
// "Reject orphaned references and cross-company records."
//
// Orphan rejection: everywhere, by foreign key.
//
// Cross-company rejection: everywhere the TARGET is tenant-scoped — solicitations,
// solicitation_requirements, verified_capabilities, capability_scope_items, company_brands,
// intake_documents — using the composite (id, company_id) MATCH FULL pattern this schema already
// uses, so the constraint fires on the write from inside the engine.
//
// **AND NOT FOR `skus` OR `suppliers`.** Both are `id TEXT PRIMARY KEY` with NO company_id — they
// are global legacy tables. There is no (id, company_id) to reference, so a composite FK is not
// merely omitted here, it is impossible. A plain FK rejects orphans and that is the whole of what
// can be enforced. Writing a constraint that LOOKED like it guarded tenancy would be worse than
// this comment.
//
// The exposure is currently nil — one active company exists, and the read-session resolver refuses
// outright when that stops being true. It becomes real the day a second company is added, and the
// fix is a separate migration giving those two tables a tenant column, which touches live rows and
// is deliberately not in this slice.
//
// ── WHY expires_on / valid_until APPEAR ON EVIDENCE ─────────────────────────
//
// Ruling 15 item 3: qualification must evaluate CURRENT evidence validity. An inventory count and a
// supplier quote are facts as of a date, and a quote outside its validity window supports nothing.
// So every match carries `evidence_as_of`, and `valid_until` where the class has one — and
// sufficiency is a question asked at a point in time, not a stored truth.
//
// ── ITEM 9, WHICH IS A CORRECTION WORTH ENCODING ────────────────────────────
//
// "Do not treat an unrenewed future expiration as permanently disqualifying an opportunity that
// could become eligible after renewal."
//
// A registration expiring before a submission deadline is not the same kind of failure as a
// capability we do not have. One is remediable by an action already on somebody's list; the other
// is a fact about the business. Collapsing them into NOT_QUALIFIED loses the distinction that
// decides whether an opportunity is worth chasing. `blocking_reason_class` carries it:
// 'remediable' vs 'structural', so the review queue can sort by what is fixable.

const VERSION = '2026-11-06.intake.v3';

const CREATED_TABLES = Object.freeze([
  'intake_documents',
  'document_download_grants',
  'document_scan_results',
  'solicitation_requirements',
  'requirement_matches',
  'fulfillment_authorizations',
  'intake_audit',
]);

// Children first.
const ROLLBACK_ORDER = Object.freeze([
  'intake_audit',
  'fulfillment_authorizations',
  'requirement_matches',
  'solicitation_requirements',
  'document_download_grants',
  'document_scan_results',
  'intake_documents',
]);

// The three that can never make a requirement sufficient, named so they can be recorded honestly
// and still never qualify anything.
const INDICATIVE_CLASSES = Object.freeze([
  'catalog_listing',        // we list it for sale. A listing is a sales page, not a shelf.
  'synthesis_prediction',   // a model produced a route. A prediction is a hypothesis.
  'supplier_relationship',  // a supplier exists and talks to us. Not a delivery.
]);

// These CAN make a requirement sufficient. None of them authorizes a bid.
const SUFFICIENT_CLASSES = Object.freeze([
  'stock_on_hand',
  'prior_delivery',
  'method_validated',
  'supplier_quote',
  'accreditation',
  'certification',
  'regulatory_authorization',
]);

const EVIDENCE_CLASSES = Object.freeze([...INDICATIVE_CLASSES, ...SUFFICIENT_CLASSES]);

const BUSINESS_LINES = Object.freeze([
  'molecule_commerce',
  'custom_synthesis',
  'analytical_services',
  'scientific_intelligence',
]);

const REQUIREMENT_KINDS = Object.freeze([
  'material', 'quantity', 'delivery', 'certification', 'analytical', 'specification', 'other',
]);

const list = (xs) => xs.map((x) => `'${x}'`).join(',');

// Roles permitted to authorize or revoke a bid commitment. Narrow on purpose — widening is a
// one-line diff, narrowing after the fact is a conversation.
const AUTHORIZING_ROLES = Object.freeze(['super_admin', 'admin']);

const DDL = [
  // ─────────────────────────────────────────────────────────────────────────
  // DOCUMENTS — integrity, scanning, and S3 by reference only
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Bytes never enter Postgres. `storage_key` points at a private S3 object (ruling 15 item 5);
  // downloads are short-lived presigned URLs issued per request, never a public object.
  `CREATE TABLE IF NOT EXISTS intake_documents (
     id                   TEXT PRIMARY KEY,
     company_id           TEXT NOT NULL REFERENCES companies(id),
     submitted_by         TEXT NOT NULL,
     submitted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     origin               TEXT NOT NULL,
     source_url           TEXT,
     filename_original    TEXT,
     -- declared_mime is recorded for the audit trail and NEVER trusted. detected_mime comes from
     -- magic bytes and is what decides. A mismatch is a rejection, not a correction.
     declared_mime        TEXT,
     detected_mime        TEXT,
     byte_size            BIGINT NOT NULL,
     sha256               TEXT NOT NULL,
     storage_bucket       TEXT,
     storage_key          TEXT,
     storage_kms_key_id   TEXT,
     -- The S3 object version this row describes. Versioning is on, so every write produces one.
     storage_version_id   TEXT,
     scan_status          TEXT NOT NULL DEFAULT 'pending',
     -- The version the VERDICT applies to. Ruling 17 item 4: a verdict is object-version-specific.
     -- A new version of the same key has not been scanned, whatever the previous verdict said, and
     -- this column is what makes that representable instead of assumed.
     scan_version_id      TEXT,
     -- The scanner's own verdict string, recorded VERBATIM and never parsed for authority. Our
     -- five-value domain below is ours; this is theirs. Kept separate so that a provider value we
     -- have never seen cannot silently land in a category it does not belong to.
     scan_provider        TEXT,
     scan_provider_status TEXT,
     scan_detail          TEXT,
     scanned_at           TIMESTAMPTZ,
     integrity_checked_at TIMESTAMPTZ,
     integrity_ok         BOOLEAN,
     -- Derived, STORED, and the single thing the download path may consult. Mirrors the
     -- solicitations.response_open pattern: a NULL anywhere yields false, so the safe state is the
     -- default rather than something that has to be maintained.
     servable             BOOLEAN GENERATED ALWAYS AS (
       COALESCE(scan_status = 'clean'
                AND storage_version_id IS NOT NULL
                AND scan_version_id = storage_version_id
                AND integrity_ok, false)) STORED,
     CONSTRAINT intake_documents_origin_check CHECK (origin IN ('upload','url')),
     -- Ruling 17 item 4 names the quarantined categories: pending, failed, unsupported, infected.
     -- 'access_denied' is a sixth, added because GuardDuty documents ACCESS_DENIED as a distinct
     -- result and it means something operationally different from FAILED: not "the scanner broke"
     -- but "we did not grant it access". Collapsing the two would hide a misconfiguration of ours
     -- inside a category that reads as the provider's fault.
     -- Only 'clean' leaves quarantine. The reason for six values rather than a boolean is that
     -- "could not be scanned" must never be representable as "scanned and fine".
     CONSTRAINT intake_documents_scan_check
       CHECK (scan_status IN ('pending','clean','infected','unsupported','failed','access_denied')),
     -- A verdict must name the version it judged, and a clean verdict must judge THE CURRENT one.
     CONSTRAINT intake_documents_verdict_names_its_version CHECK (
       scan_status = 'pending' OR scan_version_id IS NOT NULL),
     CONSTRAINT intake_documents_clean_verdict_is_current CHECK (
       scan_status <> 'clean' OR (
         storage_version_id IS NOT NULL
         AND scan_version_id = storage_version_id
         AND integrity_ok IS TRUE
         AND integrity_checked_at IS NOT NULL)),
     CONSTRAINT intake_documents_url_has_url
       CHECK (origin <> 'url' OR (source_url IS NOT NULL AND length(btrim(source_url)) > 0)),
     CONSTRAINT intake_documents_size_cap
       CHECK (byte_size > 0 AND byte_size <= 52428800),
     CONSTRAINT intake_documents_sha256_shape
       CHECK (sha256 ~ '^[0-9a-f]{64}$'),
     -- A clean document must say where it is and that its bytes were verified. A scan verdict with
     -- no storage reference is a verdict about nothing.
     CONSTRAINT intake_documents_clean_requires_storage CHECK (
       scan_status <> 'clean' OR (
         storage_bucket IS NOT NULL AND length(btrim(storage_bucket)) > 0
         AND storage_key IS NOT NULL AND length(btrim(storage_key)) > 0
         AND scanned_at IS NOT NULL
         AND detected_mime IS NOT NULL)),
     -- The same bytes submitted twice is the same document.
     UNIQUE (company_id, sha256),
     UNIQUE (id, company_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_intake_documents_company
     ON intake_documents (company_id, submitted_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_intake_documents_scan
     ON intake_documents (company_id, scan_status)`,

  // ─────────────────────────────────────────────────────────────────────────
  // WHAT THE SOLICITATION ASKS FOR
  // ─────────────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS solicitation_requirements (
     id                    TEXT PRIMARY KEY,
     company_id            TEXT NOT NULL,
     solicitation_id       TEXT NOT NULL,
     requirement_kind      TEXT NOT NULL,
     -- NULL is legitimate and common: ruling 15 item 4 models Abiozen as ONE platform, and a single
     -- solicitation may touch molecule commerce, custom synthesis, analytical services and
     -- scientific intelligence at once. The line is a property of the REQUIREMENT, never of the
     -- solicitation, and a requirement nobody has classified yet is not a requirement in no line.
     business_line         TEXT,
     mandatory             BOOLEAN NOT NULL DEFAULT true,
     description           TEXT NOT NULL,
     specification         TEXT,
     quantity_value        NUMERIC,
     quantity_unit         TEXT,
     required_by           DATE,
     delivery_terms        TEXT,
     -- PROVENANCE OF THE EXTRACTION ITSELF. A requirement nobody can trace back to a span of a
     -- document is an assertion, not a finding.
     extracted_from        TEXT,
     source_span           JSONB,
     extraction_method     TEXT,
     extraction_confidence NUMERIC,
     confirmed_by          TEXT,
     confirmed_at          TIMESTAMPTZ,
     created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT solicitation_requirements_kind_check
       CHECK (requirement_kind IN (${list(REQUIREMENT_KINDS)})),
     CONSTRAINT solicitation_requirements_line_check
       CHECK (business_line IS NULL OR business_line IN (${list(BUSINESS_LINES)})),
     -- Anything a model proposed must name the model. An unattributed extraction cannot be audited,
     -- and "a machine said so" is not provenance.
     CONSTRAINT solicitation_requirements_method_attributed
       CHECK (extraction_method IS NULL
              OR extraction_method IN ('human','structured')
              OR extraction_method LIKE 'model:%'),
     CONSTRAINT solicitation_requirements_confidence_range
       CHECK (extraction_confidence IS NULL
              OR (extraction_confidence >= 0 AND extraction_confidence <= 1)),
     -- A confirmation is a person and a time, together or not at all.
     CONSTRAINT solicitation_requirements_confirmation_paired
       CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL)),
     CONSTRAINT solicitation_requirements_quantity_paired
       CHECK ((quantity_value IS NULL) OR (quantity_unit IS NOT NULL)),
     CONSTRAINT solicitation_requirements_tenant_fk
       FOREIGN KEY (solicitation_id, company_id)
       REFERENCES solicitations (id, company_id) MATCH FULL,
     CONSTRAINT solicitation_requirements_document_tenant_fk
       FOREIGN KEY (extracted_from, company_id)
       REFERENCES intake_documents (id, company_id) MATCH SIMPLE,
     UNIQUE (id, company_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_solicitation_requirements_sol
     ON solicitation_requirements (company_id, solicitation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_solicitation_requirements_unconfirmed
     ON solicitation_requirements (company_id, solicitation_id) WHERE confirmed_at IS NULL`,

  // ─────────────────────────────────────────────────────────────────────────
  // EVIDENCE SUFFICIENCY — ruling 15 item 1, concept (1) of three
  // ─────────────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS requirement_matches (
     id                   TEXT PRIMARY KEY,
     company_id           TEXT NOT NULL,
     requirement_id       TEXT NOT NULL,
     evidence_class       TEXT NOT NULL,
     capability_id        TEXT,
     scope_item_id        TEXT,
     -- skus and suppliers have NO company_id (see the header). A plain FK rejects orphans; cross-
     -- tenant safety is NOT enforceable here and is not pretended to be.
     sku_id               TEXT REFERENCES skus(id),
     supplier_id          TEXT REFERENCES suppliers(id),
     evidence_ref         TEXT,
     -- Inventory and quotes are facts AS OF a date, and a quote outside its window supports nothing.
     evidence_as_of       DATE,
     valid_until          DATE,
     -- How much of the requirement this evidence actually covers. A quote for 5 kg against a 50 kg
     -- requirement is real evidence and is not sufficient, and without this column that difference
     -- is invisible.
     quantity_covered     NUMERIC,
     quantity_unit        TEXT,
     -- CONCEPT (1): is the evidence adequate for this requirement? NOT a commitment, NOT a bid
     -- authorization, and deliberately not named as either.
     evidence_sufficient  BOOLEAN NOT NULL DEFAULT false,
     notes                TEXT,
     matched_by           TEXT NOT NULL,
     matched_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     approval_id          TEXT,
     CONSTRAINT requirement_matches_class_check
       CHECK (evidence_class IN (${list(EVIDENCE_CLASSES)})),
     -- ── RULING 15 ITEM 1, AS A CONSTRAINT ──────────────────────────────
     -- The three indicative classes can never be sufficient. The claim cannot be stored, by any
     -- caller, however it is phrased.
     CONSTRAINT requirement_matches_indicative_never_sufficient CHECK (
       evidence_sufficient = false OR evidence_class NOT IN (${list(INDICATIVE_CLASSES)})),
     -- Sufficiency needs a reference, an approval, and a date to be read at.
     CONSTRAINT requirement_matches_sufficient_requires_evidence CHECK (
       evidence_sufficient = false OR (
         approval_id IS NOT NULL AND length(btrim(approval_id)) > 0
         AND (capability_id IS NOT NULL OR evidence_ref IS NOT NULL)
         AND evidence_as_of IS NOT NULL)),
     CONSTRAINT requirement_matches_validity_window CHECK (
       valid_until IS NULL OR evidence_as_of IS NULL OR valid_until >= evidence_as_of),
     CONSTRAINT requirement_matches_quantity_paired
       CHECK ((quantity_covered IS NULL) OR (quantity_unit IS NOT NULL)),
     CONSTRAINT requirement_matches_tenant_fk
       FOREIGN KEY (requirement_id, company_id)
       REFERENCES solicitation_requirements (id, company_id) MATCH FULL,
     CONSTRAINT requirement_matches_capability_tenant_fk
       FOREIGN KEY (capability_id, company_id)
       REFERENCES verified_capabilities (id, company_id) MATCH SIMPLE,
     UNIQUE (id, company_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_requirement_matches_req
     ON requirement_matches (company_id, requirement_id)`,
  `CREATE INDEX IF NOT EXISTS idx_requirement_matches_sufficient
     ON requirement_matches (company_id, requirement_id) WHERE evidence_sufficient`,

  // ─────────────────────────────────────────────────────────────────────────
  // AUTHORIZATION TO BID — concept (3). A HUMAN DECISION, NEVER DERIVED.
  // ─────────────────────────────────────────────────────────────────────────
  //
  // A table and not a column on solicitations, deliberately. A column is one UPDATE away from
  // being written by whatever computed the verdict. A row here requires an approving person, an
  // approval id and a timestamp, so an evaluation cannot produce one even by accident — there is
  // nothing for it to set.
  //
  // Evidence flows upward into sufficiency automatically. Nothing flows upward into authorization,
  // ever. That asymmetry is the control.
  `CREATE TABLE IF NOT EXISTS fulfillment_authorizations (
     id                   TEXT PRIMARY KEY,
     company_id           TEXT NOT NULL,
     solicitation_id      TEXT NOT NULL,
     -- What is being authorised, in the authoriser's words. Not generated.
     scope                TEXT NOT NULL,
     authorized_by        TEXT NOT NULL,
     authorized_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     approval_id          TEXT NOT NULL,
     -- An authorization is bounded. An open-ended commitment is how a stale decision becomes a
     -- current one.
     valid_until          DATE,
     -- A revocation is recorded, never a deletion: the fact that we once authorised this is itself
     -- part of the audit trail.
     revoked_at           TIMESTAMPTZ,
     revoked_by           TEXT,
     revocation_reason    TEXT,
     notes                TEXT,
     CONSTRAINT fulfillment_authorizations_authorizer_present
       CHECK (length(btrim(authorized_by)) > 0 AND length(btrim(approval_id)) > 0
              AND length(btrim(scope)) > 0),
     CONSTRAINT fulfillment_authorizations_revocation_paired
       CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
     CONSTRAINT fulfillment_authorizations_tenant_fk
       FOREIGN KEY (solicitation_id, company_id)
       REFERENCES solicitations (id, company_id) MATCH FULL,
     UNIQUE (id, company_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_fulfillment_authorizations_sol
     ON fulfillment_authorizations (company_id, solicitation_id) WHERE revoked_at IS NULL`,

  // ─────────────────────────────────────────────────────────────────────────
  // APPROVAL HISTORY — ruling 15 item 2, "preserve approval history"
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Append-only. Nothing updates or deletes a row here, and the rollback guard treats the presence
  // of these rows as human work that must not be destroyed to make a revert succeed.
  `CREATE TABLE IF NOT EXISTS intake_audit (
     id                   TEXT PRIMARY KEY,
     company_id           TEXT NOT NULL REFERENCES companies(id),
     subject_table        TEXT NOT NULL,
     subject_id           TEXT NOT NULL,
     action               TEXT NOT NULL,
     actor                TEXT NOT NULL,
     occurred_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     approval_id          TEXT,
     detail               JSONB,
     CONSTRAINT intake_audit_subject_check CHECK (subject_table IN (
       'intake_documents','solicitation_requirements','requirement_matches',
       'fulfillment_authorizations','solicitations')),
     CONSTRAINT intake_audit_action_check CHECK (action IN (
       'submitted','scanned','rejected','confirmed','matched','authorized','revoked',
       'duplicate_linked','integrity_failed')),
     CONSTRAINT intake_audit_actor_present CHECK (length(btrim(actor)) > 0),
     -- The actions that represent a human decision must carry the approval that made it.
     CONSTRAINT intake_audit_decisions_have_approval CHECK (
       action NOT IN ('confirmed','authorized','revoked') OR
       (approval_id IS NOT NULL AND length(btrim(approval_id)) > 0))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_intake_audit_subject
     ON intake_audit (company_id, subject_table, subject_id, occurred_at DESC)`,

  // ─────────────────────────────────────────────────────────────────────────
  // RULING 16 ITEM 7 — AUTHORIZATION ENFORCED BY THE DATABASE, NOT BY SHAPE
  // ─────────────────────────────────────────────────────────────────────────
  //
  // "Enforce authorization through role-based permissions and database write controls, not merely
  // table structure."
  //
  // The table structure (a separate table, every row needing a person, an approval id and a scope)
  // makes a bid authorization impossible to DERIVE. It does nothing about a careless or hostile
  // INSERT that supplies those three fields. So the write itself is controlled.
  //
  // WHY A TRIGGER AND NOT ROW-LEVEL SECURITY. RLS is the textbook answer and it does not work here:
  // src/lib/office/context.js records that the application connects as a SUPERUSER, and a superuser
  // bypasses RLS even under FORCE ROW LEVEL SECURITY. A policy would read as a control and enforce
  // nothing. A BEFORE trigger fires for every role including superuser, so it holds against the
  // connection we actually have rather than the one we would prefer.
  //
  // WHAT IT ENFORCES:
  //
  //   1. the authorizer must be a REAL, ACTIVE user — not a string somebody passed
  //   2. their role must be one permitted to commit the company (admin tier only, by default)
  //   3. the decision is IMMUTABLE once made: only the revocation fields and notes may change,
  //      so an authorization cannot be quietly re-scoped or re-attributed after the fact
  //   4. a revocation must also name a real, active, permitted user
  //
  // Point 3 matters as much as the first two. An authorization that can be edited is a signature
  // that can be moved onto a different document.
  //
  // The permitted set is interpolated from AUTHORIZING_ROLES, the one declaration. It was written
  // literally here at first, which meant three copies and nothing forcing them to agree: a mutation
  // test that widened the constant PASSED, because the constant drove nothing.
  // The set is deliberately NARROW — super_admin and admin. Whether a procurement
  // director may commit the company to a federal delivery is a business decision, not mine, and
  // widening a list is a one-line change with a visible diff whereas narrowing one after it has
  // been used is a conversation.
  `CREATE OR REPLACE FUNCTION prpa_authorization_write_guard() RETURNS TRIGGER AS $fn$
     DECLARE
       actor_role   TEXT;
       actor_active INTEGER;
     BEGIN
       IF TG_OP = 'INSERT' THEN
         SELECT role, is_active INTO actor_role, actor_active
           FROM users WHERE email = NEW.authorized_by OR id = NEW.authorized_by;
         IF actor_role IS NULL THEN
           RAISE EXCEPTION 'fulfillment_authorizations: authorized_by % is not a known user', NEW.authorized_by
             USING ERRCODE = 'check_violation';
         END IF;
         IF actor_active IS DISTINCT FROM 1 THEN
           RAISE EXCEPTION 'fulfillment_authorizations: % is not an active user', NEW.authorized_by
             USING ERRCODE = 'check_violation';
         END IF;
         IF actor_role NOT IN (${list(AUTHORIZING_ROLES)}) THEN
           RAISE EXCEPTION 'fulfillment_authorizations: role % may not authorize a bid', actor_role
             USING ERRCODE = 'insufficient_privilege';
         END IF;
         RETURN NEW;
       END IF;

       -- UPDATE: the decision is immutable. Only a revocation, or a note, may be added.
       IF NEW.id <> OLD.id
          OR NEW.company_id <> OLD.company_id
          OR NEW.solicitation_id <> OLD.solicitation_id
          OR NEW.scope <> OLD.scope
          OR NEW.authorized_by <> OLD.authorized_by
          OR NEW.authorized_at <> OLD.authorized_at
          OR NEW.approval_id <> OLD.approval_id
          OR NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
         RAISE EXCEPTION 'fulfillment_authorizations: an authorization is immutable once made; only revocation fields may change'
           USING ERRCODE = 'check_violation';
       END IF;

       IF NEW.revoked_by IS NOT NULL AND NEW.revoked_by IS DISTINCT FROM OLD.revoked_by THEN
         SELECT role, is_active INTO actor_role, actor_active
           FROM users WHERE email = NEW.revoked_by OR id = NEW.revoked_by;
         IF actor_role IS NULL OR actor_active IS DISTINCT FROM 1
            OR actor_role NOT IN (${list(AUTHORIZING_ROLES)}) THEN
           RAISE EXCEPTION 'fulfillment_authorizations: % may not revoke an authorization', NEW.revoked_by
             USING ERRCODE = 'insufficient_privilege';
         END IF;
       END IF;
       RETURN NEW;
     END;
   $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_prpa_authorization_write_guard ON fulfillment_authorizations`,
  `CREATE TRIGGER trg_prpa_authorization_write_guard
     BEFORE INSERT OR UPDATE ON fulfillment_authorizations
     FOR EACH ROW EXECUTE FUNCTION prpa_authorization_write_guard()`,

  // ── RULING 18 ITEM 6 — A VERDICT IS INGESTED, NEVER ASSERTED ───────────────
  //
  // Until now intake_documents.scan_status was an ordinary column. Any code path that could write
  // the row could write 'clean' — including the AI evaluation path, which has no business having
  // an opinion about malware.
  //
  // So a verdict is no longer something the application states. It is something a scanner's
  // result is INGESTED as, and scan_status may only reflect an ingested result for the exact
  // object version it judged. The application's remaining power is to copy a verdict it received;
  // it cannot invent one.
  //
  // WHAT THIS DOES NOT ACHIEVE, stated plainly because the gap matters more than the control:
  // src/lib/office/context.js records that this application connects to Postgres as a SUPERUSER.
  // A superuser bypasses GRANT, so there is no in-database privilege separation available: a
  // determined code path could insert a fabricated row into document_scan_results and then
  // reflect it. What follows is STRUCTURAL separation — the verdict must be derived from an
  // ingested result that names a provider, a channel and an event id — not PRIVILEGE separation.
  // Real privilege separation requires a non-superuser application role and a scanner-ingestion
  // role of its own. That is ENG-003, and it is a production change, so it is not done here.
  //
  // Structural separation is still worth having: it removes the accident and the casual path, and
  // it makes a forged verdict something that has to be deliberately constructed and that leaves a
  // row naming its channel behind. It does not stop an attacker who already runs our code.
  `CREATE TABLE IF NOT EXISTS document_scan_results (
     id                 TEXT PRIMARY KEY,
     company_id         TEXT NOT NULL REFERENCES companies(id),
     document_id        TEXT NOT NULL,
     -- The object version the scanner judged. GuardDuty's EventBridge event carries
     -- detail.s3ObjectDetails.versionId, so this is a documented field and not an inference.
     storage_version_id TEXT NOT NULL,
     provider           TEXT NOT NULL,
     -- How the result reached us. 'application' and 'ai' are deliberately NOT permitted values:
     -- there is no channel by which the app's own reasoning becomes a scan result.
     channel            TEXT NOT NULL,
     -- The provider's own identifier for the event, kept so a result cannot be ingested twice and
     -- so a verdict can be traced back to a specific delivery.
     provider_event_id  TEXT NOT NULL,
     provider_status    TEXT NOT NULL,
     mapped_status      TEXT NOT NULL,
     threats            TEXT,
     received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     raw_detail         JSONB,
     CONSTRAINT document_scan_results_doc_fk
       FOREIGN KEY (document_id, company_id) REFERENCES intake_documents(id, company_id)
       MATCH FULL ON DELETE RESTRICT,
     CONSTRAINT document_scan_results_channel
       CHECK (channel IN ('eventbridge', 'guardduty_on_demand')),
     CONSTRAINT document_scan_results_provider
       CHECK (provider IN ('aws_guardduty_malware_protection_s3')),
     -- The provider's five documented values, and ours. An unrecognised provider status cannot be
     -- stored at all, so it can never be silently mapped to 'clean'.
     CONSTRAINT document_scan_results_provider_status
       CHECK (provider_status IN ('NO_THREATS_FOUND','THREATS_FOUND','UNSUPPORTED','ACCESS_DENIED','FAILED')),
     CONSTRAINT document_scan_results_mapped_status
       CHECK (mapped_status IN ('clean','infected','unsupported','access_denied','failed')),
     -- The mapping is fixed here as well as in JavaScript, so a wrong mapping is refused by the
     -- database rather than depending on the one caller getting it right.
     CONSTRAINT document_scan_results_mapping_is_the_documented_one CHECK (
       (provider_status = 'NO_THREATS_FOUND' AND mapped_status = 'clean')
       OR (provider_status = 'THREATS_FOUND'  AND mapped_status = 'infected')
       OR (provider_status = 'UNSUPPORTED'    AND mapped_status = 'unsupported')
       OR (provider_status = 'ACCESS_DENIED'  AND mapped_status = 'access_denied')
       OR (provider_status = 'FAILED'         AND mapped_status = 'failed')),
     -- A threat list belongs only to a verdict that found one.
     CONSTRAINT document_scan_results_threats_only_when_found
       CHECK (mapped_status = 'infected' OR threats IS NULL),
     UNIQUE (provider, provider_event_id),
     UNIQUE (id, company_id)
   )`,

  // Append-only. A scan result is evidence; evidence that can be edited after the fact is not
  // evidence. A later verdict for the same version is a NEW row, not a correction of the old one.
  `CREATE OR REPLACE FUNCTION prpa_scan_results_append_only() RETURNS TRIGGER AS $fn$
     BEGIN
       IF TG_OP = 'UPDATE' THEN
         RAISE EXCEPTION 'document_scan_results is append-only; a later verdict is a new row'
           USING ERRCODE = 'check_violation';
       END IF;
       RAISE EXCEPTION 'document_scan_results rows are never deleted'
         USING ERRCODE = 'check_violation';
     END;
   $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_prpa_scan_results_append_only ON document_scan_results`,
  `CREATE TRIGGER trg_prpa_scan_results_append_only
     BEFORE UPDATE OR DELETE ON document_scan_results
     FOR EACH ROW EXECUTE FUNCTION prpa_scan_results_append_only()`,

  // The gate: scan_status may only hold what an ingested result said, about the version it judged.
  `CREATE OR REPLACE FUNCTION prpa_scan_status_must_be_ingested() RETURNS TRIGGER AS $fn$
     DECLARE
       m TEXT;
     BEGIN
       -- 'pending' is the only verdict the application may write on its own, because it is the
       -- absence of one. Everything else must be shown.
       IF NEW.scan_status = 'pending' THEN RETURN NEW; END IF;

       IF TG_OP = 'UPDATE'
          AND NEW.scan_status = OLD.scan_status
          AND NEW.scan_version_id IS NOT DISTINCT FROM OLD.scan_version_id THEN
         RETURN NEW;                      -- the verdict is unchanged; this write is about something else
       END IF;

       SELECT mapped_status INTO m
         FROM document_scan_results
        WHERE document_id = NEW.id
          AND company_id = NEW.company_id
          AND storage_version_id = NEW.scan_version_id
        ORDER BY received_at DESC
        LIMIT 1;

       IF m IS NULL THEN
         RAISE EXCEPTION 'intake_documents: no ingested scan result for document % version %; a verdict of ''%'' cannot be asserted, only reflected',
             NEW.id, COALESCE(NEW.scan_version_id, '(null)'), NEW.scan_status
           USING ERRCODE = 'insufficient_privilege';
       END IF;
       IF m <> NEW.scan_status THEN
         RAISE EXCEPTION 'intake_documents: the ingested scan result for version % says ''%'', not ''%''',
             NEW.scan_version_id, m, NEW.scan_status
           USING ERRCODE = 'check_violation';
       END IF;
       RETURN NEW;
     END;
   $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_prpa_scan_status_must_be_ingested ON intake_documents`,
  `CREATE TRIGGER trg_prpa_scan_status_must_be_ingested
     BEFORE INSERT OR UPDATE ON intake_documents
     FOR EACH ROW EXECUTE FUNCTION prpa_scan_status_must_be_ingested()`,

  // ── RULING 17 ITEM 4 — ONLY A CURRENT CLEAN VERDICT AUTHORIZES A DOWNLOAD ──
  // A presigned URL is not a database write, so the database cannot refuse one directly. What it
  // CAN refuse is the record that must exist before one is issued. Every download authorization is
  // a row here, and the trigger below refuses the row unless the document is servable for the exact
  // version being handed out. No row, no URL.
  //
  // This is the same reasoning as the authorization guard: enforce in the engine, not in a code
  // path that a future caller can forget to take.
  `CREATE TABLE IF NOT EXISTS document_download_grants (
     id                 TEXT PRIMARY KEY,
     company_id         TEXT NOT NULL REFERENCES companies(id),
     document_id        TEXT NOT NULL,
     -- The version the URL will serve. Recorded so a grant cannot be reused across a re-upload.
     storage_version_id TEXT NOT NULL,
     granted_to         TEXT NOT NULL,
     granted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     expires_at         TIMESTAMPTZ NOT NULL,
     purpose            TEXT NOT NULL,
     CONSTRAINT document_download_grants_doc_fk
       FOREIGN KEY (document_id, company_id) REFERENCES intake_documents(id, company_id)
       MATCH FULL ON DELETE RESTRICT,
     -- Short-lived by construction. A grant good for a day is not a short-lived download.
     CONSTRAINT document_download_grants_short_lived
       CHECK (expires_at > granted_at AND expires_at <= granted_at + INTERVAL '15 minutes'),
     CONSTRAINT document_download_grants_purpose
       CHECK (purpose IN ('human_review','extraction')),
     UNIQUE (id, company_id)
   )`,

  `CREATE OR REPLACE FUNCTION prpa_download_grant_guard() RETURNS TRIGGER AS $fn$
     DECLARE
       d RECORD;
     BEGIN
       SELECT servable, scan_status, storage_version_id, scan_version_id, integrity_ok
         INTO d
         FROM intake_documents
        WHERE id = NEW.document_id AND company_id = NEW.company_id;
       IF NOT FOUND THEN
         RAISE EXCEPTION 'document_download_grants: document % is not this company''s', NEW.document_id
           USING ERRCODE = 'check_violation';
       END IF;
       IF d.servable IS NOT TRUE THEN
         RAISE EXCEPTION 'document_download_grants: document % is quarantined (scan_status=%, integrity_ok=%); no download may be authorized',
             NEW.document_id, d.scan_status, COALESCE(d.integrity_ok::text, 'null')
           USING ERRCODE = 'insufficient_privilege';
       END IF;
       IF NEW.storage_version_id IS DISTINCT FROM d.storage_version_id THEN
         RAISE EXCEPTION 'document_download_grants: grant names version % but the document is now version %',
             NEW.storage_version_id, d.storage_version_id
           USING ERRCODE = 'check_violation';
       END IF;
       RETURN NEW;
     END;
   $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_prpa_download_grant_guard ON document_download_grants`,
  `CREATE TRIGGER trg_prpa_download_grant_guard
     BEFORE INSERT OR UPDATE ON document_download_grants
     FOR EACH ROW EXECUTE FUNCTION prpa_download_grant_guard()`,

  // The manual source. Last, because everything above is what makes it usable.
  // activated = true because there is no API to activate; the control on this source is per-record
  // human approval, not a connector flag. kind = 'manual' and NOT 'procurement', so the coverage
  // panel does not imply an automated procurement feed exists.
  // ── THIS SEED WAS WRITTEN AGAINST A STUB AND COULD NEVER HAVE APPLIED ──────
  //
  // Three separate mismatches with the real source_connectors table in
  // src/lib/connectors/schema.js, each of which fails the INSERT outright:
  //
  //   base_url      declared NOT NULL; the row omitted it entirely
  //   kind          CHECK IN ('procurement','funding','research'); the row said 'manual'
  //                 -> RESOLVED by widening the CHECK to include 'manual', not by changing the
  //                    row: migrate-intake.js verifies kind = 'manual' AND NOT 'procurement', and
  //                    the reason is in the comment above — a human paste must not read as a feed.
  //   access_mode   CHECK IN ('api','manual_assisted');            the row said 'manual'
  //
  // None of them ever surfaced, because this schema had only been applied to a disposable cluster
  // whose stub table carried neither the NOT NULL nor the CHECKs. On a real database the entire
  // PRPA intake schema stopped here. Found by running the migrator against an empty cluster.
  //
  // base_url has no honest value for a human-submitted source — there is no endpoint. A URN says
  // that, where a plausible-looking https:// placeholder would imply a service that does not exist
  // and that something might later try to call.
  `INSERT INTO source_connectors (source_key, display_name, base_url, kind, auth_mode, access_mode,
                                  daily_call_ceiling, activated, notes)
     VALUES ('manual', 'Manual intake (human-submitted)',
             'urn:playbookos:manual-intake',
             'manual', 'none', 'manual_assisted',
             NULL, true,
             'Human-submitted solicitations. Control is per-record human approval, not a connector '
             || 'flag. base_url is a URN, not an endpoint: there is nothing to call.')
     ON CONFLICT (source_key) DO NOTHING`,
];

// Reverting. Children first; the source row last, because it will fail by foreign key if any
// manual solicitation survives — which is the correct outcome.
const ROLLBACK_EXTRA_DDL = [
  // The trigger goes with its table; the function must be dropped explicitly or it survives as a
  // dangling object that the next apply would silently CREATE OR REPLACE.
  `DROP FUNCTION IF EXISTS prpa_authorization_write_guard()`,
  `DROP FUNCTION IF EXISTS prpa_download_grant_guard()`,
  `DROP FUNCTION IF EXISTS prpa_scan_results_append_only()`,
  `DROP FUNCTION IF EXISTS prpa_scan_status_must_be_ingested()`,
  `DELETE FROM source_connectors WHERE source_key = 'manual'`,
];


// GuardDuty Malware Protection for S3 publishes detail.scanResultDetails.scanResultStatus with
// exactly these five values, documented at
// docs.aws.amazon.com/guardduty/latest/ug/monitoring-malware-protection-s3-scans-gdu.html
// and applied as the object tag GuardDutyMalwareScanStatus. This is the ONLY place the provider's
// vocabulary is translated into ours; the raw string is also stored verbatim in
// intake_documents.scan_provider_status so a value we have never seen cannot be silently
// reinterpreted. An unrecognised status must map to 'failed', never to 'clean'.
const SCAN_STATUS_FROM_GUARDDUTY = Object.freeze({
  NO_THREATS_FOUND: 'clean',
  THREATS_FOUND:    'infected',
  UNSUPPORTED:      'unsupported',
  ACCESS_DENIED:    'access_denied',
  FAILED:           'failed',
});
const GUARDDUTY_TAG_KEY = 'GuardDutyMalwareScanStatus';

const PRECONDITIONS = Object.freeze([
  { name: 'P1', what: 'companies exists (migrateOffice has run)', table: 'companies' },
  { name: 'P2', what: 'solicitations exists (connectors.v1 has run)', table: 'solicitations' },
  { name: 'P3', what: 'verified_capabilities exists (connectors.v1 has run)', table: 'verified_capabilities' },
  { name: 'P4', what: 'source_connectors exists (connectors.v1 has run)', table: 'source_connectors' },
  { name: 'P5', what: 'skus exists (referenced for orphan rejection)', table: 'skus' },
  { name: 'P6', what: 'suppliers exists (referenced for orphan rejection)', table: 'suppliers' },
  { name: 'P7', what: 'users exists (the authorization trigger reads roles from it)', table: 'users' },
]);

module.exports = {
  VERSION,
  DDL,
  ROLLBACK_ORDER,
  ROLLBACK_EXTRA_DDL,
  CREATED_TABLES,
  PRECONDITIONS,
  EVIDENCE_CLASSES,
  INDICATIVE_CLASSES,
  SUFFICIENT_CLASSES,
  BUSINESS_LINES,
  REQUIREMENT_KINDS,
  AUTHORIZING_ROLES,
  SCAN_STATUS_FROM_GUARDDUTY,
  GUARDDUTY_TAG_KEY,
};
