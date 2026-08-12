// Clinical Demand Intelligence — Catalog Match (deterministic, no LLM).
//
// Given one inferred molecule ({ molecule_name, cas_number }), decide whether
// Abiozen already offers it. This is the FAST/CHEAP step — a single indexed SQL
// lookup, no Claude call. Cross-references three catalogs in priority order:
//   1. skus              — canonical active SKU catalog (name has purity suffix,
//                          e.g. "Semaglutide 99%", so CAS is the reliable match here)
//   2. molecule_pricing  — active GMP API price book (clean molecule_name)
//   3. molecule_history  — past sourcing/transaction history (we've handled it before)
//
// Match precedence PER TABLE: exact case-insensitive name OR exact CAS (CAS only
// when the molecule actually carries one). Precision over recall — no fuzzy/LIKE
// matching, so "sourcing_opportunity" stays a real catalog-expansion signal.
//
// Returns { catalog_match_status, matched_sku_id, matched_source } — never throws.
// matched_sku_id holds the id of whichever record matched (skus / molecule_pricing /
// molecule_history); matched_source disambiguates which table it came from.
const { query } = require('../../db');

// One UNION ALL over the three catalogs, ranked by priority; lowest priority wins.
// $1 = normalized molecule name (lowercased compare), $2 = normalized CAS or ''.
// The `$2 <> ''` guard skips CAS matching entirely when the molecule has no CAS,
// so a NULL/empty CAS never spuriously matches NULL catalog rows.
const MATCH_SQL = `
  SELECT id, source FROM (
    SELECT id, 'skus' AS source, 1 AS priority FROM skus
      WHERE is_active = 1 AND (LOWER(name) = $1 OR ($2 <> '' AND cas_number = $2))
    UNION ALL
    SELECT id, 'molecule_pricing' AS source, 2 AS priority FROM molecule_pricing
      WHERE active = 1 AND (LOWER(molecule_name) = $1 OR ($2 <> '' AND cas_number = $2))
    UNION ALL
    SELECT id, 'molecule_history' AS source, 3 AS priority FROM molecule_history
      WHERE LOWER(molecule_name) = $1 OR ($2 <> '' AND cas_number = $2)
  ) matches
  ORDER BY priority ASC
  LIMIT 1`;

// Match one molecule against the catalogs. queryFn is injectable for testing.
// Returns { catalog_match_status, matched_sku_id, matched_source[, error] }.
async function matchCatalog(molecule, { queryFn = query } = {}) {
  const miss = { catalog_match_status: 'sourcing_opportunity', matched_sku_id: null, matched_source: null };
  const unknown = { catalog_match_status: 'unknown', matched_sku_id: null, matched_source: null };

  const name = String(molecule && molecule.molecule_name || '').trim();
  const cas = (molecule && typeof molecule.cas_number === 'string') ? molecule.cas_number.trim() : '';
  // Nothing to match on → unknown (not a sourcing signal — we simply can't tell).
  if (!name && !cas) return unknown;

  try {
    const { rows } = await queryFn(MATCH_SQL, [name.toLowerCase(), cas]);
    if (rows && rows.length) {
      return { catalog_match_status: 'catalog_match', matched_sku_id: rows[0].id, matched_source: rows[0].source };
    }
    return miss; // queried cleanly, no hit anywhere → real sourcing opportunity
  } catch (e) {
    // DB error: don't guess "sourcing_opportunity" (would be a false expansion
    // signal) — surface unknown + error for the orchestrator to log/decide.
    return { ...unknown, error: e.message };
  }
}

module.exports = { matchCatalog, MATCH_SQL };
