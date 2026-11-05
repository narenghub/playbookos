'use strict';
// ── THE ONE DOOR THE SEARCH RULE MAY COME THROUGH ───────────────────────────
//
// Ruling 6 item 6: narrowly scoped remediation for the routes.js search-rule exemption.
//
// ── WHAT WAS WRONG WITH THE OLD EXEMPTION ───────────────────────────────────
//
// The R2 guard is default-deny: no file may import the search-only functions from synonyms.js
// unless it is on an allowlist with a stated reason. `src/api/routes.js` was on that list, and its
// entry carried this residual risk, stated rather than assumed:
//
//     "routes.js is a large mixed file, so a pricing or quoting handler added inline there would
//      sit inside this exemption. The check cannot see that, and narrowing it means extracting the
//      search handlers into their own module — worth doing, not done here."
//
// That is the whole problem. routes.js is ~6,000 lines holding every endpoint in the product:
// search, pricing, RFQ, orders, approvals. Exempting it exempted all of them. Someone writing a
// quote handler three months from now could call expandMolecule() forty lines from a price, and the
// guard would wave it through — not because the guard is weak, but because the exemption was
// granted to a file rather than to a purpose.
//
// ── WHAT THIS MODULE IS ─────────────────────────────────────────────────────
//
// The boundary. It is the only file permitted to import the search-only functions, and the
// allowlist entry moves here — from 6,000 lines of mixed concerns to this one small file that does
// exactly one thing. routes.js imports from here instead, and is removed from the allowlist
// entirely, so an inline call to expandMolecule() in a pricing handler is now caught by the guard
// as a violation. That is the narrowing: the exemption is no longer a place, it is a job.
//
// It is NOT a reimplementation. synonyms.js still owns the equivalence table and the salt-stripping,
// and every function here delegates to it. A second copy of that logic would be the duplication
// this repo keeps paying for, and the two copies would disagree the first time one was edited.
//
// ── WHAT THIS MODULE WILL NOT DO ────────────────────────────────────────────
//
// It returns search terms and SQL fragments. It does not return a price, a supplier count, a
// holder count, a CAS number or an identity, and nothing it produces may be used to decide what a
// substance costs or who can supply it — because its terms are deliberately GENEROUS. The
// expansion folds synonyms and strips salts, so `leuprolide` and `leuprolide acetate` both come
// back for either query. That is correct for FINDING a substance and wrong for ORDERING one: they
// are different substances with different registry numbers and different prices.
//
// Anything commercial goes through the identity layer (moleculeKey/identityOf) instead. The guard
// enforces that separation; this module exists so the guard can be strict about it.

const { expandMolecule, moleculeLikeSql, likePatterns } = require('./synonyms');

// Two characters is the floor. One would scan every molecule in the register to tell the user
// nothing, and at a venue that is several seconds of nothing.
const MIN_TERM_LENGTH = 2;

/**
 * Expand a typed term into every legal name for the substance, plus the LIKE patterns for them.
 *
 * The register is American and half of any trade-show floor is European, so the typed name is
 * often not the filed name: a customer asking for LEUPRORELIN (the INN) finds nothing, because
 * every holder is filed under LEUPROLIDE (the USAN).
 *
 * @param {string} raw
 * @returns {{ok: boolean, term: string, terms: string[], patterns: string[], reason: string|null}}
 *   ok:false means the caller should not search — the term is too short. It is returned rather
 *   than thrown so a handler can answer with a hint instead of a 500.
 */
function expandForSearch(raw) {
  const term = String(raw === undefined || raw === null ? '' : raw).trim();
  if (term.length < MIN_TERM_LENGTH) {
    return {
      ok: false,
      term,
      terms: [],
      patterns: [],
      reason: `a search term must be at least ${MIN_TERM_LENGTH} characters`,
    };
  }
  const expansion = expandMolecule(term);
  const terms = (expansion && expansion.terms) || [];
  return {
    ok: true,
    term,
    terms,
    patterns: likePatterns(terms),
    reason: null,
  };
}

/**
 * The SQL fragment matching `column` against the pattern array bound at $paramIndex.
 *
 * One array parameter rather than per-term placeholders, so the same set matches in every branch
 * of a UNION without index arithmetic.
 *
 * @param {string} column      an already-safe column expression, e.g. "LOWER(sm.molecule_name)"
 * @param {number} paramIndex  1-based position of the pattern array in the query's values
 */
function searchLikeSql(column, paramIndex) {
  if (!column || typeof column !== 'string') {
    throw new Error('searchLikeSql requires a column expression');
  }
  if (!Number.isInteger(paramIndex) || paramIndex < 1) {
    // An off-by-one here silently matches the wrong parameter, which in Postgres is usually a type
    // error at run time and occasionally a query that returns the wrong rows. Refuse instead.
    throw new Error(`searchLikeSql requires a 1-based parameter index, got ${paramIndex}`);
  }
  return moleculeLikeSql(column, paramIndex);
}

module.exports = { MIN_TERM_LENGTH, expandForSearch, searchLikeSql };
