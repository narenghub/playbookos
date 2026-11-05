'use strict';
// ── PR-6a: THE READ-ONLY VIEW LAYER ──────────────────────────────────────────
//
// Pure SQL builders. Each returns { text, values } and runs nothing, so a test can assert the
// predicate without a server, and the disposable-cluster harness can run the same text the product
// runs. No function here writes, and none takes a write path — the module exports no INSERT, no
// UPDATE and no DELETE.
//
// EVERY BUILDER TAKES companyId AS $1. Not as a convention: assertScoped() below refuses a built
// query that does not mention company_id, and a test sweeps every export through it. The office
// kernel's reasoning applies unchanged — a predicate every developer has to remember is not
// isolation.
//
// ── THE ONE DESIGN RULE ─────────────────────────────────────────────────────
//
// A dashboard is where a claim becomes a decision. Every figure on the page is traceable to a
// stored row or it is not on the page. Two consequences live in this file:
//
//   1. OPEN, SUBMITTABLE and QUALIFIED are three different facts and are never collapsed. A source
//      record's status says nothing about whether we may legally or technically respond.
//   2. Unknown renders as unknown. Never as zero, never as a blank that reads as zero. SQL that
//      COALESCEs a missing verdict to a value would be inventing the most consequential field on
//      the page.

const { biddability } = require('./record-kind');

// ── the three-stage ladder (ruling item 4) ──────────────────────────────────
//
// OPEN         a fact about the NOTICE: it is live at the source, not closed or archived.
// SUBMITTABLE  a fact about US: the record kind permits an offer and there is still time to make
//              one. A sources-sought notice is OPEN and never SUBMITTABLE.
// QUALIFIED    a JUDGEMENT: the qualification engine found every mandatory gate satisfied.
//
// They are strictly nested, and each stage states its own reason, so a row that stops at OPEN says
// why it is not SUBMITTABLE rather than appearing as a lesser kind of qualified.
const STAGES = Object.freeze(['none', 'open', 'submittable', 'qualified']);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = (v) => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === 'string' && ISO_DAY.test(v.trim()) ? v.trim() : null;
};

const LIVE_STATUSES = new Set(['posted', 'active', 'open']);
const DEAD_STATUSES = new Set(['closed', 'archived', 'expired', 'cancelled', 'awarded']);

/**
 * Where on the ladder does this record sit, and why did it stop there?
 *
 * @param {object} record      { recordKind, oppStatus, responseDeadline, standing }
 * @param {object} assessment  the stored eligibility_assessments row, or null when none exists
 * @param {string} asOf        YYYY-MM-DD
 */
function opportunityStage(record = {}, assessment = null, asOf = null) {
  const day = isoDay(asOf);
  if (!day) throw new Error('opportunityStage: asOf (YYYY-MM-DD) is required');

  const reasons = { open: null, submittable: null, qualified: null };
  const status = String(record.oppStatus || '').toLowerCase();

  // ── OPEN ───────────────────────────────────────────────────────────────
  if (DEAD_STATUSES.has(status)) {
    reasons.open = `the source reports this as "${record.oppStatus}"`;
    return { stage: 'none', open: false, submittable: false, qualified: false, reasons };
  }
  if (!status) {
    // No status is not "open". A record whose source status we did not capture is unknown, and
    // unknown must not render as the favourable answer.
    reasons.open = 'no source status was captured, so whether this is live is unknown';
    return { stage: 'none', open: false, submittable: false, qualified: false, reasons };
  }
  if (!LIVE_STATUSES.has(status)) {
    reasons.open = `source status "${record.oppStatus}" is outside the known live set, so it is `
      + 'not treated as open';
    return { stage: 'none', open: false, submittable: false, qualified: false, reasons };
  }
  reasons.open = `the source reports this as "${record.oppStatus}"`;

  // ── SUBMITTABLE ────────────────────────────────────────────────────────
  //
  // This is the stage the ruling exists to protect. A forecast and a sources-sought notice are both
  // OPEN at the source and neither can be responded to with an offer.
  const b = biddability({
    recordKind: record.recordKind,
    responseDeadline: isoDay(record.responseDeadline),
  });
  if (!b.biddable) {
    reasons.submittable = b.reason;
    return { stage: 'open', open: true, submittable: false, qualified: false, reasons };
  }
  const deadline = isoDay(record.responseDeadline);
  if (deadline < day) {
    reasons.submittable = `the response deadline ${deadline} has passed (as of ${day})`;
    return { stage: 'open', open: true, submittable: false, qualified: false, reasons };
  }
  const days = Math.round((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 864e5);
  reasons.submittable = `a ${record.recordKind} with ${days} day(s) until its ${deadline} deadline`;

  // ── QUALIFIED ──────────────────────────────────────────────────────────
  //
  // Only the engine's verdict decides this. The absence of an assessment is NOT a pass, and it is
  // not a failure either — it is "not yet assessed", which is its own answer.
  if (!assessment || !assessment.verdict) {
    reasons.qualified = 'not yet assessed — eligibility is unknown, which is not the same as eligible';
    return {
      stage: 'submittable', open: true, submittable: true, qualified: false,
      verdict: null, reasons,
    };
  }
  const verdict = String(assessment.verdict);
  if (verdict !== 'QUALIFIED') {
    reasons.qualified = `the qualification engine returned ${verdict}`
      + (assessment.rationale ? `: ${assessment.rationale}` : '');
    return {
      stage: 'submittable', open: true, submittable: true, qualified: false,
      verdict, reasons,
    };
  }
  reasons.qualified = assessment.rationale || 'every mandatory gate passed';
  return { stage: 'qualified', open: true, submittable: true, qualified: true, verdict, reasons };
}

// ── scoping discipline ──────────────────────────────────────────────────────

/**
 * Refuse a built query that does not scope by company. Called by every builder, and swept over
 * every export by the tests — so a new view cannot be added without the predicate.
 */
function assertScoped(name, text, values) {
  if (!/\bcompany_id\b/.test(text)) {
    throw new Error(`views.${name}: built a query with no company_id predicate — every view is tenant-scoped`);
  }
  if (!values.length || values[0] == null) {
    throw new Error(`views.${name}: $1 must be the company id and must not be null`);
  }
  if (/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i.test(text)) {
    throw new Error(`views.${name}: this layer is read-only; it built a mutating statement`);
  }
  return { text, values };
}

const q = (name, text, values) => assertScoped(name, text, values);

// ── 6b: the review queue ────────────────────────────────────────────────────
//
// The view that earns its place today, because every live verdict is NEEDS_REVIEW. Grouped by
// criterion so the SHAPE of the work is visible: 40 opportunities blocked on verified_capability is
// one afternoon in the registry, not 40 reviews.

function reviewQueueByCriterion(companyId) {
  return q('reviewQueueByCriterion', `
    SELECT f.criterion_key,
           f.label,
           f.mandatory,
           f.result,
           COUNT(DISTINCT a.id)::int           AS assessments_blocked,
           COUNT(DISTINCT a.subject_id)::int   AS subjects_blocked,
           MIN(a.as_of)                        AS oldest_as_of,
           -- One example reason per criterion. The reasons were written to be read here, and
           -- "ISO-17025 IS on file but is not usable: PENDING" is a different action from
           -- "no verified capability row for cap-sterile-fill".
           (ARRAY_AGG(f.reason ORDER BY a.assessed_at DESC))[1] AS example_reason
      FROM eligibility_findings f
      JOIN eligibility_assessments a
        ON a.id = f.assessment_id AND a.company_id = f.company_id
     WHERE f.company_id = $1
       AND f.mandatory
       AND f.result IN ('fail','unknown')
     GROUP BY f.criterion_key, f.label, f.mandatory, f.result
     ORDER BY subjects_blocked DESC, f.criterion_key`, [companyId]);
}

function reviewQueueItems(companyId, { criterionKey = null, limit = 200 } = {}) {
  const values = [companyId];
  let filter = '';
  if (criterionKey) { values.push(criterionKey); filter = ` AND f.criterion_key = $${values.length}`; }
  values.push(Math.max(1, Math.min(1000, limit)));
  return q('reviewQueueItems', `
    SELECT a.id                AS assessment_id,
           a.subject_kind,
           a.subject_id,
           a.record_kind,
           a.verdict,
           a.rationale,
           a.rule_set_version,
           a.as_of,
           a.blocking_count,
           f.criterion_key,
           f.label,
           f.result,
           f.reason,
           f.evidence_text,
           f.evidence_source_url
      FROM eligibility_findings f
      JOIN eligibility_assessments a
        ON a.id = f.assessment_id AND a.company_id = f.company_id
     WHERE f.company_id = $1
       AND f.mandatory
       AND f.result IN ('fail','unknown')${filter}
     ORDER BY a.as_of DESC, a.subject_id, f.criterion_key
     LIMIT $${values.length}`, values);
}

// ── 6b: the capability registry, in three sections ──────────────────────────

function capabilitiesUsable(companyId, asOf) {
  const day = isoDay(asOf);
  if (!day) throw new Error('capabilitiesUsable: asOf (YYYY-MM-DD) is required');
  return q('capabilitiesUsable', `
    SELECT c.id, c.kind, c.code, c.name, c.responsible_entity,
           c.evidence_source, c.evidence_url, c.valid_from, c.valid_to,
           (c.valid_to - $2::date)            AS days_until_expiry,
           COALESCE(s.scope, '[]'::json)      AS scope
      FROM verified_capabilities c
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('kind', i.scope_kind, 'value', i.scope_value)) AS scope
          FROM capability_scope_items i
         WHERE i.capability_id = c.id AND i.company_id = c.company_id
      ) s ON TRUE
     WHERE c.company_id = $1
       AND c.verification_status = 'verified'
       AND c.valid_from IS NOT NULL
       AND c.valid_from <= $2::date
       AND (c.valid_to IS NULL OR c.valid_to >= $2::date)
     ORDER BY (c.valid_to IS NULL), c.valid_to, c.kind, c.code`, [companyId, day]);
}

/**
 * On file and NOT usable, with the reason derived in SQL so the view and
 * capability-registry.js cannot disagree about the same row.
 */
function capabilitiesOnFileUnusable(companyId, asOf) {
  const day = isoDay(asOf);
  if (!day) throw new Error('capabilitiesOnFileUnusable: asOf (YYYY-MM-DD) is required');
  return q('capabilitiesOnFileUnusable', `
    SELECT c.id, c.kind, c.code, c.name, c.responsible_entity,
           c.verification_status, c.valid_from, c.valid_to,
           CASE
             WHEN c.verification_status = 'planned'  THEN 'PLANNED, not verified — an intended certification is not an approved one'
             WHEN c.verification_status = 'pending'  THEN 'PENDING verification — in progress is not approved'
             WHEN c.verification_status = 'revoked'  THEN 'REVOKED — it was once true, which is why it is still on file and why it must not count'
             WHEN c.verification_status = 'disputed' THEN 'DISPUTED — the evidence is contested, so it cannot support a representation'
             WHEN c.valid_from IS NULL               THEN 'verified but has no valid_from, so there is no window to check'
             WHEN c.valid_from > $2::date            THEN 'not yet in effect — valid from ' || c.valid_from
             WHEN c.valid_to IS NOT NULL AND c.valid_to < $2::date THEN 'EXPIRED on ' || c.valid_to
             ELSE 'unusable for a reason this view does not model — do not treat as usable'
           END AS reason
      FROM verified_capabilities c
     WHERE c.company_id = $1
       AND NOT (
         c.verification_status = 'verified'
         AND c.valid_from IS NOT NULL
         AND c.valid_from <= $2::date
         AND (c.valid_to IS NULL OR c.valid_to >= $2::date)
       )
     ORDER BY c.verification_status, c.kind, c.code`, [companyId, day]);
}

/**
 * Required by a blocked assessment, and absent from the registry — ranked by how much it blocks.
 * This is what turns the registry from a form into a worklist.
 */
function capabilitiesRequiredButAbsent(companyId) {
  return q('capabilitiesRequiredButAbsent', `
    SELECT f.criterion_key,
           f.reason,
           COUNT(DISTINCT a.subject_id)::int AS subjects_blocked
      FROM eligibility_findings f
      JOIN eligibility_assessments a
        ON a.id = f.assessment_id AND a.company_id = f.company_id
     WHERE f.company_id = $1
       AND f.criterion_key IN ('verified_capability','accreditation')
       AND f.result IN ('fail','unknown')
     GROUP BY f.criterion_key, f.reason
     ORDER BY subjects_blocked DESC, f.criterion_key`, [companyId]);
}

// ── opportunities, with the ladder's inputs (not its verdict) ───────────────
//
// The SQL returns the FACTS; opportunityStage() derives the stage in JS. Deriving it in SQL would
// mean a second implementation of the ladder, and the two would disagree the first time one changed.

function fundingOpportunities(companyId, { limit = 200 } = {}) {
  return q('fundingOpportunities', `
    SELECT o.id, o.opportunity_id, o.opportunity_number, o.title,
           o.agency_code, o.agency_name, o.doc_type, o.opp_status, o.standing,
           o.record_kind, o.open_date, o.close_date, o.archive_date,
           o.estimated_funding, o.award_ceiling, o.award_floor, o.cost_sharing,
           o.cfda_list, o.current_revision, o.source_url, o.application_open,
           a.id AS assessment_id, a.verdict, a.rationale, a.rule_set_version,
           a.as_of, a.blocking_count
      FROM funding_opportunities o
      LEFT JOIN LATERAL (
        SELECT x.* FROM eligibility_assessments x
         WHERE x.company_id = o.company_id
           AND x.subject_kind = 'funding_opportunity'
           AND x.subject_id = o.opportunity_id
         ORDER BY x.assessed_at DESC LIMIT 1
      ) a ON TRUE
     WHERE o.company_id = $1
     ORDER BY (o.close_date IS NULL), o.close_date, o.opportunity_id
     LIMIT $2`, [companyId, Math.max(1, Math.min(1000, limit))]);
}

function federalAwards(companyId, { limit = 200 } = {}) {
  return q('federalAwards', `
    SELECT id, award_key, piid, parent_piid, awarding_agency, awarding_sub_agency,
           recipient_name, recipient_profile_id, naics_code, naics_description,
           psc_code, psc_description,
           -- NAMED, not aliased to something shorter. A column called "amount" on a dashboard
           -- becomes a pipeline total by the end of the quarter.
           obligated_amount AS obligated_amount_not_outlay,
           pop_start_date, pop_end_date, source_url
      FROM federal_awards
     WHERE company_id = $1
     ORDER BY pop_start_date DESC NULLS LAST
     LIMIT $2`, [companyId, Math.max(1, Math.min(1000, limit))]);
}

// ── connector health ───────────────────────────────────────────────────────

function connectorHealth(companyId) {
  return q('connectorHealth', `
    SELECT c.source_key, c.display_name, c.kind, c.auth_mode, c.access_mode,
           c.activated, c.daily_call_ceiling, c.notes,
           r.status AS last_status, r.started_at AS last_started_at,
           r.finished_at AS last_finished_at, r.calls_made AS last_calls_made,
           r.records_seen AS last_records_seen, r.records_upserted AS last_records_upserted,
           r.high_water_mark AS last_watermark, r.error_text AS last_error
      FROM source_connectors c
      LEFT JOIN LATERAL (
        SELECT s.* FROM source_sync_runs s
         WHERE s.source_key = c.source_key AND s.company_id = $1
         ORDER BY s.started_at DESC LIMIT 1
      ) r ON TRUE
     ORDER BY c.activated DESC, c.kind, c.source_key`, [companyId]);
}

// ── molecule demand ────────────────────────────────────────────────────────
//
// Returns the rows; the MATCH is decided in JS by commercialMatch(), never in SQL. A LIKE or a
// de-salted join here would be the search rule leaking into a commercial surface, which
// scripts/check-search-rule-scope.js now fails the build over.

function moleculeDemandCandidates(companyId, { limit = 500 } = {}) {
  return q('moleculeDemandCandidates', `
    SELECT sm.id AS demand_id, sm.molecule_name, sm.cas_number,
           sm.molecule_type, sm.catalog_match_status,
           sm.inference_confidence, sm.inference_rationale,
           cs.nct_id, cs.brief_title, cs.phase, cs.overall_status,
           -- The tenant predicate is on the assessment side because study_molecules predates
           -- company_id. Stated rather than hidden: this view is scoped by the company's own
           -- capability rows, and the demand table itself is single-tenant today.
           $1::text AS company_id
      FROM study_molecules sm
      LEFT JOIN clinical_studies cs ON cs.id = sm.study_id
     ORDER BY sm.inference_confidence DESC NULLS LAST, sm.molecule_name
     LIMIT $2`, [companyId, Math.max(1, Math.min(2000, limit))]);
}

module.exports = {
  STAGES,
  opportunityStage,
  assertScoped,
  reviewQueueByCriterion,
  reviewQueueItems,
  capabilitiesUsable,
  capabilitiesOnFileUnusable,
  capabilitiesRequiredButAbsent,
  fundingOpportunities,
  federalAwards,
  connectorHealth,
  moleculeDemandCandidates,
};
