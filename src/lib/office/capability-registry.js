// ── ABIOZEN'S VERIFIED CAPABILITY REGISTRY ───────────────────────────────────
//
// Ruling 22 item 2: a registry covering research chemicals, custom synthesis, analytical testing,
// CRO services and scientific supply, requiring "evidence, authorization, and human review before
// activating a capability."
//
// ── THE SHAPE OF THE PROBLEM ─────────────────────────────────────────────────
//
// The registry is empty. Not sparse — empty. The 2026-11-05 inventory measured zero verified
// capabilities across both entities, and found that four dimensions (certifications,
// authorizations to perform work, equipment availability, quality-system records) had no table
// that could hold them at all.
//
// So this module is not a search over existing records. It is the intake path by which a real
// document becomes a registry row, and the gap report that says which documents are still needed.
//
// ── WHY `propose` AND `activate` ARE SEPARATE FUNCTIONS ──────────────────────
//
// A capability becomes real in two steps that must not be one step:
//
//   propose()  — anyone may say "we think we can do this". Writes verification_status='pending'
//                with verified_at, verified_by and approval_id explicitly NULL. Nothing downstream
//                treats a pending row as evidence.
//   activate() — a named, active, admin-tier person attaches a real document and an approval id.
//                The v4 trigger checks the person against `users` at write time, so a role that
//                was revoked yesterday cannot activate a capability today.
//
// A single `upsert(…, {verified: true})` would make the second step a parameter, and a parameter
// is what a batch script sets to true.
//
// ── WHAT COUNTS AS EVIDENCE ──────────────────────────────────────────────────
//
// Not a boolean. The inventory found `labs.research_capable BOOLEAN NOT NULL DEFAULT FALSE` with
// no evidence column, no source, no date and no approver behind it, and recorded the distinction
// precisely: read as a capability it says "this firm can do research work"; read honestly it says
// "at some point a row was set to true, by someone or something, for a reason nobody recorded."
'use strict';

const crypto = require('crypto');
const { INDICATIVE_CLASSES, SUFFICIENT_CLASSES } = require('./intake-schema');
const { isoDay } = require('./iso-day');

// The five areas ruling 22 names, each mapped to the business line the qualification engine looks
// under, and — the useful part — the documents that would actually satisfy it.
const CAPABILITY_AREAS = Object.freeze([
  {
    key: 'research_chemicals',
    label: 'Research chemicals and scientific molecules',
    business_line: 'molecule_commerce',
    satisfied_by: ['stock_on_hand', 'prior_delivery', 'supplier_quote'],
    evidence_needed: [
      'A purchase order or invoice for a completed delivery of a named molecule, with quantity and date',
      'A current inventory record showing material on hand, with lot and expiry',
      'A supplier quotation naming the molecule, quantity, price and validity date',
    ],
    not_evidence: [
      'A catalogue listing — it says we advertised a molecule, not that we hold it',
      'A supplier relationship — it says somebody supplied us once, not that they will again',
    ],
  },
  {
    key: 'custom_synthesis',
    label: 'Custom synthesis',
    business_line: 'custom_synthesis',
    satisfied_by: ['prior_delivery', 'method_validated', 'regulatory_authorization'],
    evidence_needed: [
      'A completed custom synthesis contract or PO with the delivered compound and scale',
      'A validated synthetic route record with analytical confirmation of the product',
      'Any regulatory authorization covering the class of work (controlled substances, cGMP)',
    ],
    not_evidence: [
      'A synthesis prediction — it is a model\'s opinion about a route, not a completed synthesis',
    ],
  },
  {
    key: 'analytical_testing',
    label: 'Analytical testing',
    business_line: 'analytical_services',
    satisfied_by: ['method_validated', 'accreditation', 'prior_delivery'],
    evidence_needed: [
      'ISO/IEC 17025 accreditation certificate with scope, body, number and expiry',
      'A method validation report for each assay offered (HPLC, LC-MS, GC-MS, dissolution, stability)',
      'A completed analytical contract with the client, analyte and turnaround met',
    ],
    not_evidence: ['A list of instruments owned — equipment is not a validated method'],
  },
  {
    key: 'cro_services',
    label: 'CRO services',
    business_line: 'analytical_services',
    satisfied_by: ['accreditation', 'certification', 'regulatory_authorization', 'prior_delivery'],
    evidence_needed: [
      'GLP or GCP compliance certification, or a regulatory inspection record',
      'A completed study report or a contract showing scope and deliverables',
      'Quality-system certification (ISO 9001 or equivalent) with current validity',
    ],
    not_evidence: ['A capability statement or marketing deck — self-description is not evidence'],
  },
  {
    key: 'scientific_supply',
    label: 'Scientific product supply and fulfilment',
    business_line: 'scientific_fulfillment',
    satisfied_by: ['stock_on_hand', 'prior_delivery', 'certification'],
    evidence_needed: [
      'A distribution or reseller agreement with the manufacturer, naming the product lines',
      'A completed fulfilment record: order, ship date, delivery confirmation',
      'Any licence required to distribute the product class (state wholesale drug distributor, DEA)',
    ],
    not_evidence: [
      'A supplier relationship without a distribution agreement — federal reagent buys frequently '
      + 'require OEM-authorized distributor status, and "we can source it" is not that',
    ],
  },
]);

// RULING 22 ITEM 1, APPLIED TO THE REGISTRY ITSELF.
//
// A demonstration seeds fixture capabilities so the engine can be shown reaching a verdict. Those
// rows satisfy every constraint on verified_capabilities — they have an evidence_source, a
// verifier, an approval id and a date — so nothing structural distinguished them from real
// evidence, and the capability gap report duly announced four of five areas COVERED on the
// strength of them. That is the same failure as a fixture QUALIFIED verdict, in a different
// surface, and labelling it in the UI would not have helped: the gap report is read as a
// statement about the company.
//
// So evidence whose source announces itself as a fixture is NOT COUNTABLE. It never reaches the
// qualification engine through activeCapabilities(), and the gap report shows it as FIXTURE_ONLY
// rather than as coverage. If somebody seeds demo rows into production, they still do not count.
const FIXTURE_EVIDENCE = /^\s*FIXTURE\b/i;
const isFixture = (r) => FIXTURE_EVIDENCE.test(String(r.evidence_source || ''));

const AREA_BY_KEY = new Map(CAPABILITY_AREAS.map((a) => [a.key, a]));
const AUTHORIZING_ROLES = Object.freeze(['super_admin', 'admin']);

class RegistryRefused extends Error {
  constructor(m) { super(m); this.name = 'RegistryRefused'; }
}

const newId = (p) => `${p}-${crypto.randomBytes(8).toString('hex')}`;

/**
 * Propose a capability. Always lands pending. Never evidence.
 */
async function propose(q, { companyId, areaKey, code, name, responsibleEntity, notes, proposedBy }) {
  const area = AREA_BY_KEY.get(areaKey);
  if (!area) throw new RegistryRefused(`unknown capability area "${areaKey}"; known: ${[...AREA_BY_KEY.keys()].join(', ')}`);
  if (!name || !String(name).trim()) throw new RegistryRefused('a capability needs a name');
  if (!responsibleEntity) throw new RegistryRefused('a capability needs a responsible entity — which legal entity holds it');
  if (!proposedBy) throw new RegistryRefused('a proposal needs a proposer');

  const id = newId('cap');
  await q(
    `INSERT INTO verified_capabilities
       (id, company_id, kind, code, name, responsible_entity, verification_status,
        business_line, notes)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8)`,
    [id, companyId, 'capability', code || areaKey.toUpperCase(), name, responsibleEntity,
      area.business_line,
      [notes, `proposed by ${proposedBy}`].filter(Boolean).join(' · ')]);
  return { id, status: 'pending', area: area.key };
}

/**
 * Activate a proposed capability. This is the step that makes it count, so it is the step with
 * every check on it.
 *
 * The v4 trigger independently verifies that `verifiedBy` is a real, ACTIVE, admin-tier user at
 * write time. These checks exist as well, so the caller gets a usable message rather than a
 * constraint violation — but the trigger is what makes them load-bearing, because a future caller
 * can skip this function and cannot skip the trigger.
 */
async function activate(q, {
  companyId, capabilityId, evidenceClass, evidenceSource, evidenceUrl, evidenceSha256,
  verifiedBy, approvalId, validFrom, validTo,
}) {
  if (!evidenceSource || !String(evidenceSource).trim()) {
    throw new RegistryRefused('activation needs evidence_source — what document, from whom, dated when');
  }
  if (!SUFFICIENT_CLASSES.includes(evidenceClass)) {
    const why = INDICATIVE_CLASSES.includes(evidenceClass)
      ? `"${evidenceClass}" is an INDICATIVE class. A catalogue listing, a supplier relationship and `
        + 'a synthesis prediction are reasons to look, not reasons to commit, and none of them may '
        + 'activate a capability.'
      : `"${evidenceClass}" is not a known evidence class.`;
    throw new RegistryRefused(`${why} Sufficient classes: ${SUFFICIENT_CLASSES.join(', ')}`);
  }
  if (!approvalId) throw new RegistryRefused('activation needs an approval_id — the human authorization this rests on');
  if (!verifiedBy) throw new RegistryRefused('activation needs verified_by — a named person, not a system');
  if (!validFrom) throw new RegistryRefused('activation needs valid_from — evidence without a date cannot expire');
  if (evidenceSha256 && !/^[0-9a-f]{64}$/.test(evidenceSha256)) {
    throw new RegistryRefused('evidence_sha256 must be a full sha256 of the document bytes');
  }

  const r = await q(
    `UPDATE verified_capabilities
        SET verification_status = 'verified',
            evidence_class = $3, evidence_source = $4, evidence_url = $5, evidence_sha256 = $6,
            verified_by = $7, verified_at = NOW(), approval_id = $8,
            valid_from = $9, valid_to = $10
      WHERE id = $1 AND company_id = $2 AND verification_status = 'pending'
      RETURNING id, verification_status, evidence_class, valid_to`,
    [capabilityId, companyId, evidenceClass, evidenceSource, evidenceUrl || null,
      evidenceSha256 || null, verifiedBy, approvalId, validFrom, validTo || null]);
  if (!r.rows.length) {
    throw new RegistryRefused(
      `no PENDING capability ${capabilityId} for this company. A capability can only be activated `
      + 'from pending — activating something already verified, revoked or absent is not a no-op, '
      + 'it is a sign the caller has the wrong id.');
  }
  return r.rows[0];
}

/** Load the capabilities the qualification engine should use: verified, current, classified. */
async function activeCapabilities(q, companyId, { today } = {}) {
  const day = today || new Date().toISOString().slice(0, 10);
  return (await q(
    `SELECT id, kind, name, evidence_class, business_line, valid_from, valid_to, evidence_source
       FROM verified_capabilities
      WHERE company_id = $1
        AND verification_status = 'verified'
        AND (valid_from IS NULL OR valid_from <= $2)
        -- Fixture-sourced evidence is excluded here, not filtered by the caller, because the
        -- caller is where it would be forgotten.
        AND (evidence_source IS NULL OR evidence_source !~* '^[[:space:]]*FIXTURE\\M')
      ORDER BY business_line, name`,
    [companyId, day])).rows;
}

/**
 * What is held, what is pending, and what is still missing — per area.
 * This is the document that tells a person what to go and find.
 */
async function gapReport(q, companyId, { today } = {}) {
  const day = today || new Date().toISOString().slice(0, 10);
  const rows = (await q(
    `SELECT id, name, verification_status, evidence_class, business_line, valid_to, evidence_source
       FROM verified_capabilities WHERE company_id = $1`, [companyId])).rows;

  return CAPABILITY_AREAS.map((area) => {
    const mine = rows.filter((r) => r.business_line === area.business_line);
    const allVerified = mine.filter((r) => r.verification_status === 'verified');
    const fixtures = allVerified.filter(isFixture);
    const verified = allVerified.filter((r) => !isFixture(r));
    // isoDay, not String().slice() — see src/lib/office/iso-day.js. The first version of this
    // function used the naive form and reported a capability that expired on 2026-01-01 as COVERED.
    const current = verified.filter((r) => !r.valid_to || (isoDay(r.valid_to) || '9999-12-31') >= day);
    const expired = verified.filter((r) => r.valid_to && (isoDay(r.valid_to) || '9999-12-31') < day);
    const sufficient = current.filter((r) => SUFFICIENT_CLASSES.includes(r.evidence_class));
    const unclassified = current.filter((r) => !r.evidence_class);
    const pending = mine.filter((r) => r.verification_status === 'pending');

    let status;
    if (sufficient.length) status = 'COVERED';
    else if (fixtures.length) status = 'FIXTURE_ONLY';
    else if (expired.length) status = 'EXPIRED';
    else if (unclassified.length) status = 'UNCLASSIFIED';
    else if (pending.length) status = 'PENDING_REVIEW';
    else status = 'NO EVIDENCE';

    return {
      area: area.key,
      label: area.label,
      business_line: area.business_line,
      status,
      sufficient_count: sufficient.length,
      fixture_count: fixtures.length,
      pending_count: pending.length,
      expired_count: expired.length,
      unclassified_count: unclassified.length,
      // What to go and get. The whole point of the report.
      evidence_needed: sufficient.length ? [] : area.evidence_needed,
      not_evidence: area.not_evidence,
      accepted_classes: area.satisfied_by,
      held: current.map((r) => ({ id: r.id, name: r.name, evidence_class: r.evidence_class, valid_to: isoDay(r.valid_to) })),
    };
  });
}

module.exports = {
  CAPABILITY_AREAS,
  AUTHORIZING_ROLES,
  RegistryRefused,
  propose,
  activate,
  activeCapabilities,
  gapReport,
};
