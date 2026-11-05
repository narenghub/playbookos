'use strict';
// ── WHAT DO WE ACTUALLY HAVE EVIDENCE FOR? ──────────────────────────────────
//
// Ruling 6 items 1–2. Pure. Turns rows from the existing record stores into an evidence inventory
// for one of our own entities, and into CANDIDATE capability records for human verification.
//
// ── THE RULE THIS MODULE EXISTS TO ENFORCE ──────────────────────────────────
//
//   "Do not invent certifications, accreditations, authorizations, equipment availability, or
//    technical capabilities."
//
// The failure mode is not malice, it is a boolean. `labs.research_capable` is
// `BOOLEAN NOT NULL DEFAULT FALSE` with no evidence column, no source, no date and no approver
// behind it. Read as a capability it says "this firm can do research work". Read honestly it says
// "at some point a row was set to true, by someone or something, for a reason nobody recorded."
// Those are not the same statement, and a bid eligibility verdict built on the first one is a
// fabrication with a database row behind it.
//
// So every finding carries a STATUS saying what kind of thing it is, and only two of the five
// statuses may ever reach an eligibility check — and even those enter as CANDIDATES, never as
// verified capabilities. `verified_capabilities` requires evidence_source, verified_at, verified_by,
// approval_id and valid_from before `verification_status = 'verified'` is permitted by a CHECK
// constraint. Nothing this module produces can satisfy that, by design: a human has to.
//
// ── ABSENCE IS A FINDING, NOT A ZERO ────────────────────────────────────────
//
// Where no record exists the answer is UNKNOWN. Never false, never 0, never "none". There is no
// equipment table in this schema and no quality-system table, so those dimensions come back
// UNKNOWN by structural absence — which is the honest answer and a much more useful one than an
// empty list that reads like a finished search.

/** What kind of thing a finding is. Ordered weakest-evidence-first. */
const STATUS = Object.freeze({
  UNKNOWN: 'UNKNOWN',                             // no record at all
  CLAIM_WITHOUT_EVIDENCE: 'CLAIM_WITHOUT_EVIDENCE', // a flag with no source, date or document
  EXPIRED: 'EXPIRED',                             // evidence exists, validity window has passed
  ATTESTED_SELF: 'ATTESTED_SELF',                 // the entity itself supplied it
  ATTESTED_EXTERNAL: 'ATTESTED_EXTERNAL',         // an external register or accreditation body
});

// Only these two describe evidence from a named source. Everything else is a gap.
const EVIDENCE_STATUSES = Object.freeze([STATUS.ATTESTED_SELF, STATUS.ATTESTED_EXTERNAL]);

/**
 * The dimensions the ruling names. `structurallyAbsent` records that NO table in this schema can
 * hold the dimension — so UNKNOWN there is a schema gap, not an empty search, and the two must
 * never be reported the same way.
 */
const DIMENSIONS = Object.freeze([
  { key: 'tenant_identity', label: 'company / tenant identity', structurallyAbsent: false },
  { key: 'registration', label: 'registration records', structurallyAbsent: false },
  { key: 'accreditation', label: 'accreditations', structurallyAbsent: false },
  { key: 'certification', label: 'certifications', structurallyAbsent: true },
  { key: 'authorization', label: 'authorizations to perform work', structurallyAbsent: true },
  { key: 'technical_capability', label: 'technical capabilities', structurallyAbsent: false },
  { key: 'equipment', label: 'equipment availability', structurallyAbsent: true },
  { key: 'quality_system', label: 'quality-system records', structurallyAbsent: true },
  { key: 'supplier_record', label: 'supplier records', structurallyAbsent: false },
  { key: 'catalog_record', label: 'catalogue records', structurallyAbsent: false },
]);

const DIMENSION_KEYS = Object.freeze(DIMENSIONS.map((d) => d.key));

/** A finding with no record. The only way to express absence. */
function unknown(dimension, why) {
  const d = DIMENSIONS.find((x) => x.key === dimension);
  return Object.freeze({
    dimension,
    status: STATUS.UNKNOWN,
    value: 'UNKNOWN',
    source: null,
    reason: why || (d && d.structurallyAbsent
      ? 'no table in this schema can hold this dimension — a schema gap, not an empty search'
      : 'no matching record found'),
    structurallyAbsent: !!(d && d.structurallyAbsent),
    usableForEligibility: false,
  });
}

/** Is a validity window open as of `asOf`? Missing dates are not treated as open. */
function withinValidity(validFrom, validTo, asOf) {
  if (!asOf) throw new Error('withinValidity requires asOf — "is it current?" has no answer without a date');
  if (validTo && String(validTo) < String(asOf)) return false;
  if (validFrom && String(validFrom) > String(asOf)) return false;
  return true;
}

/**
 * Classify one raw record into a finding.
 *
 * @param {object} rec
 *   dimension   one of DIMENSION_KEYS
 *   value       what was found, as stored
 *   source      {table, column, id} — where it came from. REQUIRED for any attested status.
 *   external    true when the source is an outside register or accreditation body
 *   selfReported true when the entity supplied it
 *   evidenceRef a certificate number, scope document, FEI — the thing a human can check
 *   validFrom / validTo  ISO dates, if the record carries them
 * @param {string} asOf ISO date
 */
function classify(rec, asOf) {
  if (!rec || !rec.dimension) throw new Error('classify requires a dimension');
  if (!DIMENSION_KEYS.includes(rec.dimension)) {
    throw new Error(`unknown dimension: ${rec.dimension}`);
  }
  if (!asOf) throw new Error('classify requires asOf');

  const source = rec.source || null;
  const hasSource = !!(source && source.table);
  const hasEvidenceRef = !!(rec.evidenceRef && String(rec.evidenceRef).trim());

  // A flag with nothing behind it. This is the branch that stops a default-FALSE boolean flipped
  // to true from becoming "this firm is research capable" in a bid.
  if (!hasSource || (!rec.external && !rec.selfReported) || !hasEvidenceRef) {
    return Object.freeze({
      dimension: rec.dimension,
      status: STATUS.CLAIM_WITHOUT_EVIDENCE,
      value: rec.value === undefined ? 'UNKNOWN' : rec.value,
      source,
      evidenceRef: rec.evidenceRef || null,
      reason: !hasEvidenceRef
        ? 'the record carries no certificate, scope document or external identifier a human could '
          + 'check, so it states a position without evidence for it'
        : 'the record names no attesting party, so nothing distinguishes it from a default value',
      usableForEligibility: false,
    });
  }

  const open = withinValidity(rec.validFrom, rec.validTo, asOf);
  if (!open) {
    return Object.freeze({
      dimension: rec.dimension,
      status: STATUS.EXPIRED,
      value: rec.value === undefined ? 'UNKNOWN' : rec.value,
      source,
      evidenceRef: rec.evidenceRef,
      validFrom: rec.validFrom || null,
      validTo: rec.validTo || null,
      reason: `evidence exists but its validity window does not cover ${asOf}`,
      usableForEligibility: false,
    });
  }

  const status = rec.external ? STATUS.ATTESTED_EXTERNAL : STATUS.ATTESTED_SELF;
  return Object.freeze({
    dimension: rec.dimension,
    status,
    value: rec.value,
    source,
    evidenceRef: rec.evidenceRef,
    validFrom: rec.validFrom || null,
    validTo: rec.validTo || null,
    scope: rec.scope || null,
    reason: rec.external
      ? 'attested by an external register or accreditation body, with a checkable identifier'
      : 'supplied by the entity itself, with a checkable identifier — still requires verification',
    usableForEligibility: true,
  });
}

/**
 * A candidate capability record for the human verification queue.
 *
 * It is NOT a verified capability and cannot become one here. `verification_status` is always
 * 'pending'; the four fields the CHECK constraint demands for 'verified' (verified_at, verified_by,
 * approval_id, and a non-empty evidence_source) are deliberately left for a person, and
 * `candidateFrom` refuses to populate them even if asked.
 */
function candidateFrom(finding, entity) {
  if (!finding) throw new Error('candidateFrom requires a finding');
  if (!entity || !entity.name) throw new Error('candidateFrom requires the responsible entity');
  if (!EVIDENCE_STATUSES.includes(finding.status)) {
    // A claim without evidence must not enter the queue dressed as a candidate capability. It
    // enters as a GAP to be investigated, which is a different kind of task.
    return null;
  }
  return Object.freeze({
    responsible_entity: entity.name,
    company_id: entity.companyId || null,
    capability: finding.value,
    dimension: finding.dimension,
    verification_status: 'pending',       // the ONLY value this function will ever produce
    evidence_source: `${finding.source.table}${finding.source.column ? `.${finding.source.column}` : ''}`
      + `${finding.source.id ? ` id=${finding.source.id}` : ''}`,
    evidence_ref: finding.evidenceRef,
    scope: finding.scope || null,
    valid_from: finding.validFrom || null,
    valid_to: finding.validTo || null,
    attestation: finding.status,
    // Explicitly null, and named, so a reader can see these are a person's to fill.
    verified_at: null,
    verified_by: null,
    approval_id: null,
    note: 'CANDIDATE ONLY. Remains pending until a person verifies it against the evidence and '
      + 'records scope, entity, validity dates and an authorized approval.',
  });
}

/**
 * Build the inventory for one entity.
 *
 * @param {object} entity  { name, companyId }
 * @param {Array}  records raw records already gathered read-only from the stores
 * @param {string} asOf    ISO date
 */
function inventory(entity, records, asOf) {
  if (!entity || !entity.name) throw new Error('inventory requires an entity name');
  if (!asOf) throw new Error('inventory requires asOf');

  const findings = [];
  for (const rec of records || []) findings.push(classify(rec, asOf));

  // Every dimension gets a row. A dimension with no finding reports UNKNOWN rather than being
  // left out of the table, because a missing row reads as "not applicable" and an UNKNOWN row
  // reads as "we do not know" — only one of those is true.
  const byDimension = {};
  for (const d of DIMENSIONS) {
    const mine = findings.filter((f) => f.dimension === d.key);
    byDimension[d.key] = mine.length ? mine : [unknown(d.key)];
  }

  const candidates = findings
    .map((f) => candidateFrom(f, entity))
    .filter(Boolean);

  const gaps = findings.filter((f) => !f.usableForEligibility);
  for (const d of DIMENSIONS) {
    if (byDimension[d.key].every((f) => f.status === STATUS.UNKNOWN)) {
      gaps.push(byDimension[d.key][0]);
    }
  }

  return {
    entity: entity.name,
    companyId: entity.companyId || null,
    asOf,
    byDimension,
    candidates,
    gaps,
    summary: {
      dimensions: DIMENSIONS.length,
      withEvidence: DIMENSIONS.filter(
        (d) => byDimension[d.key].some((f) => EVIDENCE_STATUSES.includes(f.status)),
      ).length,
      unknownDimensions: DIMENSIONS.filter(
        (d) => byDimension[d.key].every((f) => f.status === STATUS.UNKNOWN),
      ).length,
      structurallyAbsentDimensions: DIMENSIONS.filter((d) => d.structurallyAbsent).length,
      candidatesForVerification: candidates.length,
      // Deliberately named "verified: 0" rather than omitted. Nothing here is verified, and saying
      // so out loud is the point of the whole exercise.
      verified: 0,
    },
  };
}

module.exports = {
  STATUS,
  EVIDENCE_STATUSES,
  DIMENSIONS,
  DIMENSION_KEYS,
  unknown,
  withinValidity,
  classify,
  candidateFrom,
  inventory,
};
