// ── WHAT IS LEFT TO CHECK, ON THE KEY THE WRITE USES ──────────────────────────
//
// TWO FOLDS, WHICH IS THE WHOLE PROBLEM. The scope queries in scripts/lookup-cphi-roles.js dedupe on
// the SOURCE table's own normalisation — `labs.name_normalized`, `fda_establishments.firm_normalized` —
// while the write keys on normalizeCompany(). Those two disagree, so a scope query can hand back rows
// that collapse into one on insert.
//
// It showed up as an arithmetic discrepancy rather than an error: a run reported "wrote 120 row(s)" and
// the next run reported "skipping 118 already checked". The two missing rows were
// "LABORATORIOS FARMACEUTICOS ROVI S.A." / "Laboratorios Farmacéuticos Rovi, S.A." and a repeated
// "Advanced Accelerator Applications (Italy)" — one company each to normalizeCompany, two to the
// register. Each pair spent two lookups to write one row.
//
// SQL cannot do this filtering, because normalizeCompany runs in JS. So the SQL clause is a coarse
// case-insensitive pre-filter whose only job is to keep the over-fetch small, and this is where the
// list is actually made exact.

/**
 * The first `limit` candidates that are new, deduped on `holder_normalized`.
 *
 * ORDER IS PRESERVED, which matters: the scope queries order by how much a company is worth checking,
 * so the survivor of a duplicate pair must be the one that came first, not an arbitrary one.
 *
 * @param {Array<{holder_normalized: string}>} scope  candidates, most valuable first
 * @param {Set<string>} checked  holder_normalized values already written for this event and role
 * @param {number} limit
 */
function newCandidates(scope, checked, limit) {
  const seen = new Set();
  const out = [];
  // Checked BEFORE the loop as well as after each push: a trailing break alone pushes one row before
  // noticing that the limit was zero.
  if (!(limit > 0)) return out;
  for (const h of scope || []) {
    const key = h && h.holder_normalized;
    // A candidate with no fold cannot be deduped or resumed against, and would be re-checked on every
    // run forever. Dropped rather than passed through, and the caller's count makes it visible.
    if (!key) continue;
    if ((checked && checked.has(key)) || seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { newCandidates };
