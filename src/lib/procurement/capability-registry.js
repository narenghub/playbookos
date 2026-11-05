'use strict';
// ── WHAT ABIOZEN CAN ACTUALLY SUPPLY, AND IS ACTUALLY ACCREDITED TO DO ───────
//
// The reader half is pure: it takes rows and an as-of date and returns what is usable. The query
// half is one function at the bottom, injectable, so every rule here is testable without a server.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// PR-5's capability gate resolves against rows by id, because §8 forbids inventing certifications,
// project references, equipment, laboratory capacity or regulatory approvals. There were no rows,
// so every verdict was NEEDS_REVIEW. This is the registry that changes that — and it changes it
// only for capabilities somebody has actually verified.
//
// ── THE FOUR RULES, IN THE ORDER THEY BITE ──────────────────────────────────
//
//   1. STATUS. Only 'verified' counts. 'planned' and 'pending' exist so an intended certification
//      can be recorded WITHOUT becoming usable — the alternative is that people file aspirations as
//      verified facts, which is exactly what the ruling forbids. 'disputed' and 'revoked' are also
//      unusable, and a revoked accreditation is the most dangerous of all because it was once true.
//
//   2. VALIDITY. Checked against the assessment's as-of date. An accreditation that lapsed last
//      month remains a true historical fact and must not satisfy a gate today. A window that has
//      not opened yet is equally unusable, and that case is real: a certificate issued with a
//      future effective date.
//
//   3. SCOPE. An accreditation covers NAMED METHODS. "We hold ISO 17025" is not an answer to "are
//      you accredited for USP <621> HPLC assay". A capability with no scope rows cannot satisfy a
//      scoped requirement — not because scope is missing data, but because an unscoped claim is the
//      general claim the ruling says not to make.
//
//   4. ENTITY. Abiozen LLC and CRO360 each hold their own. A bid by one entity cannot rest on the
//      other's accreditation, so a requirement naming an entity is matched against that entity.
//
// Every refusal carries a reason naming which of the four bit, because a capability gate that says
// only "no" sends a human to look through the registry by hand.

const USABLE_STATUS = 'verified';
const RECORDED_BUT_UNUSABLE = Object.freeze(['planned', 'pending', 'disputed', 'revoked']);
const ALL_STATUSES = Object.freeze([USABLE_STATUS, ...RECORDED_BUT_UNUSABLE]);
const SCOPE_KINDS = Object.freeze(['method', 'molecule', 'service', 'naics', 'psc']);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = (v) => (typeof v === 'string' && ISO_DAY.test(v.trim()) ? v.trim() : null);

/**
 * Why a row is not usable as of a date, or null when it is.
 * Pure. Returns a sentence, not a code, because this text reaches a human in a review queue.
 */
function unusableReason(row, asOf) {
  if (!row) return 'no such capability row';
  const status = String(row.verification_status || '').toLowerCase();

  if (status !== USABLE_STATUS) {
    if (status === 'planned') {
      return `recorded as PLANNED, not verified — an intended certification is not an approved one`;
    }
    if (status === 'pending') {
      return `recorded as PENDING verification — in progress is not approved`;
    }
    if (status === 'revoked') {
      return `REVOKED — it was once true, which is why it is still on file and why it must not count`;
    }
    if (status === 'disputed') {
      return `DISPUTED — the evidence is contested, so it cannot support a representation`;
    }
    return `verification_status is "${row.verification_status}", which is not "verified"`;
  }

  // A 'verified' row without evidence should be impossible — the schema CHECK refuses it — but a
  // reader that trusts the status alone would be relying on a constraint it cannot see. If the rows
  // ever arrive from somewhere else (a fixture, an import, another service), this is the backstop.
  if (!row.evidence_source || !String(row.evidence_source).trim()) {
    return 'marked verified but carries no evidence source, which the schema should have refused — '
      + 'treating it as unusable rather than trusting the status';
  }
  if (!row.approval_id || !String(row.approval_id).trim()) {
    return 'marked verified but carries no approval id, so no human authorised the verification';
  }

  const from = isoDay(row.valid_from);
  const to = isoDay(row.valid_to);
  if (!from) return 'verified but has no valid_from, so there is no window to check';
  if (asOf < from) return `not yet in effect — valid from ${from}, assessed as of ${asOf}`;
  if (to && asOf > to) return `EXPIRED on ${to} (assessed as of ${asOf})`;
  return null;
}

/** Days until this row's validity ends; null when open-ended or unusable. */
function daysUntilExpiry(row, asOf) {
  const to = isoDay(row && row.valid_to);
  if (!to || !isoDay(asOf)) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 864e5);
}

/**
 * Normalise registry rows into what the qualification engine consumes, as of a date.
 *
 * Returns { capabilities, accreditations, excluded } where the first two carry ONLY usable rows and
 * `excluded` explains every row that was left out. The exclusions are returned rather than dropped
 * because "we hold this but it is pending" is the single most useful thing to tell a human about a
 * NEEDS_REVIEW verdict.
 *
 * @param {Array}  rows        verified_capabilities rows, each optionally with `scope: [{scope_kind, scope_value}]`
 * @param {string} asOf        YYYY-MM-DD
 */
function effectiveAsOf(rows, asOf) {
  const day = isoDay(asOf);
  if (!day) throw new Error('effectiveAsOf: asOf (YYYY-MM-DD) is required');

  const capabilities = [];
  const accreditations = [];
  const excluded = [];

  for (const row of rows || []) {
    const reason = unusableReason(row, day);
    if (reason) {
      excluded.push({
        id: row && row.id, code: row && row.code, kind: row && row.kind,
        responsible_entity: row && row.responsible_entity,
        status: row && row.verification_status, reason,
      });
      continue;
    }
    const scope = (row.scope || []).filter((s) => s && s.scope_kind && s.scope_value);
    const entry = {
      id: row.id,
      code: row.code,
      name: row.name,
      kind: row.kind,
      responsibleEntity: row.responsible_entity,
      reference: row.evidence_source,
      evidenceUrl: row.evidence_url || null,
      validTo: isoDay(row.valid_to),
      daysUntilExpiry: daysUntilExpiry(row, day),
      scope: scope.map((s) => ({ kind: s.scope_kind, value: String(s.scope_value) })),
    };
    if (row.kind === 'accreditation') accreditations.push(entry);
    else capabilities.push(entry);
  }

  return { capabilities, accreditations, excluded, asOf: day };
}

/**
 * Does a usable entry cover this requirement's scope?
 *
 * A requirement may be a bare id/code (no scope asked), or carry `scope: {kind, value}`. An
 * unscoped requirement is satisfied by holding the capability. A SCOPED requirement needs a
 * matching scope row — and an entry with no scope rows at all satisfies nothing scoped, because
 * holding ISO 17025 is not the same as being accredited for a named method.
 */
function coversScope(entry, requirement) {
  const want = requirement && requirement.scope;
  if (!want || !want.kind || !want.value) return { covered: true, reason: 'no scope was asked for' };
  if (!SCOPE_KINDS.includes(want.kind)) {
    return { covered: false, reason: `"${want.kind}" is not a scope kind this registry records` };
  }
  if (!entry.scope.length) {
    return {
      covered: false,
      reason: `${entry.code} has no recorded scope, so it cannot cover ${want.kind} "${want.value}". `
        + 'An accreditation covers named methods; holding it is not a general permission.',
    };
  }
  const hit = entry.scope.find((s) => s.kind === want.kind
    && s.value.trim().toLowerCase() === String(want.value).trim().toLowerCase());
  if (hit) return { covered: true, reason: `${entry.code} scope includes ${want.kind} "${hit.value}"` };
  return {
    covered: false,
    reason: `${entry.code} is held but OUT OF SCOPE for ${want.kind} "${want.value}" — in scope: `
      + entry.scope.filter((s) => s.kind === want.kind).map((s) => s.value).join(', ') || '(nothing of that kind)',
  };
}

/**
 * Resolve one requirement against the usable registry.
 *
 * A requirement is { id?, code?, kind?, entity?, scope? }. Matching prefers id, then code — id
 * because that is what a stored assessment refers to, code because that is what a human writes.
 */
function resolveRequirement(requirement, effective) {
  const req = typeof requirement === 'string' ? { id: requirement } : (requirement || {});
  const pool = [...effective.capabilities, ...effective.accreditations];

  let candidates = pool.filter((e) => (req.id ? e.id === req.id : true))
    .filter((e) => (req.code ? String(e.code).toLowerCase() === String(req.code).toLowerCase() : true))
    .filter((e) => (req.kind ? e.kind === req.kind : true));

  if (req.entity) {
    const before = candidates.length;
    candidates = candidates.filter((e) => String(e.responsibleEntity).toLowerCase() === String(req.entity).toLowerCase());
    if (before && !candidates.length) {
      return {
        satisfied: false,
        reason: `held, but by another entity — the requirement names "${req.entity}". A bid by one `
          + 'entity cannot rest on another entity\'s accreditation.',
      };
    }
  }

  if (!candidates.length) {
    // Distinguish "we have nothing" from "we have it but it is not usable yet" — the second is the
    // one somebody can act on today.
    const key = (req.id || req.code || '').toLowerCase();
    const recorded = effective.excluded.find((x) => String(x.id || '').toLowerCase() === key
      || String(x.code || '').toLowerCase() === key);
    if (recorded) {
      return {
        satisfied: false,
        recordedButUnusable: true,
        reason: `${recorded.code || recorded.id} IS on file but is not usable: ${recorded.reason}`,
      };
    }
    return { satisfied: false, reason: `no verified capability row for ${req.id || req.code || '(unnamed requirement)'}` };
  }

  for (const entry of candidates) {
    const c = coversScope(entry, req);
    if (c.covered) {
      return {
        satisfied: true,
        entry,
        reason: `${entry.code} (${entry.responsibleEntity}) — ${c.reason}; evidence: ${entry.reference}`,
      };
    }
  }
  return { satisfied: false, reason: coversScope(candidates[0], req).reason };
}

/**
 * Read the registry for a company. The one impure function here, and injectable.
 * Scoped by company_id, like every other tenant read.
 */
async function loadRegistry(ctx, deps = {}) {
  const query = (deps && deps.query) || require('../db').query;
  const { rows } = await query(
    `SELECT c.*,
            COALESCE(
              (SELECT json_agg(json_build_object('scope_kind', s.scope_kind, 'scope_value', s.scope_value))
                 FROM capability_scope_items s
                WHERE s.capability_id = c.id AND s.company_id = c.company_id),
              '[]'::json) AS scope
       FROM verified_capabilities c
      WHERE c.company_id = $1
      ORDER BY c.kind, c.code`, [ctx.companyId]);
  return rows.map((r) => ({ ...r, scope: r.scope || [] }));
}

module.exports = {
  USABLE_STATUS,
  RECORDED_BUT_UNUSABLE,
  ALL_STATUSES,
  SCOPE_KINDS,
  unusableReason,
  daysUntilExpiry,
  effectiveAsOf,
  coversScope,
  resolveRequirement,
  loadRegistry,
};
