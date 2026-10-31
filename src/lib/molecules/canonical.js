// ── THE CANONICAL IDENTITY WRITE BOUNDARY ────────────────────────────────────
//
// Amendment 2 of the drift policy, 31 Oct 2026:
//
//   > No new consequential commercial object may acquire a deprecated molecule identity.
//
// Built now as a reusable invariant; the Gate 2 consumers are wired later and separately. Nothing
// in this file is called by the commercial path yet, and wiring it there is NOT authorised.
//
// ── THE DISTINCTION THAT MATTERS ────────────────────────────────────────────
//
// Three outcomes, never two:
//
//   ok          — an eligible canonical identity. Use it.
//   deprecated  — the identity EXISTS and is deprecated. This is a review outcome, not a miss.
//   not_found   — no canonical identity resolves this name.
//
// Collapsing `deprecated` into `not_found` is the failure this guard exists to prevent. A caller
// told "not found" will reasonably fall back to matching on name or CAS — which is precisely the
// uncontrolled name-string identity that E1 was built to remove, and in the pricing path it was a
// bare CAS match that priced a buyer's correctly-named molecule at another substance's rate, 2.4x
// out, decided by physical row order. A deprecated identity means "we know this name and we do not
// currently trust it", and the only safe response is to stop and have a human look.
//
// UI filtering is not sufficient and is not what this is. The refusal belongs at the write boundary,
// because the agents write without a UI in the loop.
'use strict';

const { moleculeKey } = require('./identity');
const { parseReason } = require('./drift');

/**
 * Resolve a filed name to a canonical molecule for NEW consequential use.
 *
 * @param q        a query function — injected, so this is testable against fixtures and usable
 *                 inside a transaction.
 * @param filed    the name as written by a buyer, supplier, study or agent.
 * @returns {{status:'ok'|'deprecated'|'not_found', identity:string|null, molecule:object|null,
 *            review:object|null}}
 */
async function resolveForNewUse(q, filed) {
  const identity = moleculeKey(filed || '');
  if (!identity) return { status: 'not_found', identity: null, molecule: null, review: null };

  // Its own identity first, then the alias table — the same order resolveExisting uses in the
  // backfill, so the two cannot disagree about what a name resolves to.
  let row = (await q(
    `SELECT id, molecule_ref, normalized_name, preferred_name, cas, cas_suppressed_reason,
            substance_form, deprecated_at, deprecated_reason
       FROM molecules WHERE normalized_name = $1`, [identity])).rows[0];
  if (!row) {
    row = (await q(
      `SELECT m.id, m.molecule_ref, m.normalized_name, m.preferred_name, m.cas,
              m.cas_suppressed_reason, m.substance_form, m.deprecated_at, m.deprecated_reason
         FROM molecule_aliases a JOIN molecules m ON m.id = a.molecule_id
        WHERE a.alias = $1`, [identity])).rows[0];
  }
  if (!row) return { status: 'not_found', identity, molecule: null, review: null };

  if (row.deprecated_at) {
    const parsed = parseReason(row.deprecated_reason);
    return {
      status: 'deprecated',
      identity,
      molecule: row,
      // Enough for a caller to raise a review item without re-deriving anything.
      review: {
        molecule_id: row.id,
        molecule_ref: row.molecule_ref,
        identity,
        filed,
        deprecated_at: row.deprecated_at,
        analyser_reason: parsed.analyserReason,
        category: parsed.category,
        reversibility: parsed.reversibility,
        action: parsed.reversibility === 'AUTO_REVERSIBLE'
          ? 'correct the source evidence, or rule on the identity'
          : 'a human chemistry/identity ruling is required before this identity can be used',
      },
    };
  }
  return { status: 'ok', identity, molecule: row, review: null };
}

/**
 * The assertion form, for a caller that wants to fail rather than branch.
 *
 * Throws a tagged error for a deprecated identity so a consequential writer cannot proceed by
 * accident. `code` is set so callers can distinguish it from an ordinary miss without string
 * matching on the message.
 */
async function requireEligible(q, filed) {
  const r = await resolveForNewUse(q, filed);
  if (r.status === 'ok') return r.molecule;
  const e = new Error(r.status === 'deprecated'
    ? `canonical identity "${r.identity}" is DEPRECATED and may not be used for new consequential `
      + `work (${r.review.analyser_reason})`
    : `no canonical identity resolves "${filed}"`);
  e.code = r.status === 'deprecated' ? 'MOLECULE_DEPRECATED' : 'MOLECULE_NOT_FOUND';
  e.review = r.review;
  e.identity = r.identity;
  throw e;
}

module.exports = { resolveForNewUse, requireEligible };
