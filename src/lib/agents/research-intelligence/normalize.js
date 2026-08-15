// Clinical Demand Intelligence — Phase 3 org-name normalization (pure function).
//
// Sponsor name → a clean string to feed the Apollo mixed_companies query. Strips
// parentheticals + trailing legal-entity suffixes + punctuation, but KEEPS industry
// descriptors (pharmaceuticals/therapeutics/biosciences) so distinct firms don't
// over-merge. This string is ONLY for building the Apollo query — the canonical
// dedup key is Apollo's resolved org_id / primary_domain, never this string.

// Trailing legal-entity suffixes (the set locked in the Phase 3 spec).
const LEGAL_SUFFIXES = ['incorporated', 'inc', 'llc', 'ltd', 'limited', 'corporation', 'corp', 'co', 'plc', 'gmbh', 'ag', 's.a.', 'n.v.', 'b.v.'];
// Matches a trailing suffix, optionally preceded by comma/space and dotted
// (s.a. / n.v. / b.v.), so it can loop to peel "Co., Ltd." → "".
const SUFFIX_RE = /[\s,]+(incorporated|inc|llc|ltd|limited|corporation|corp|co|plc|gmbh|ag|s\.?a|n\.?v|b\.?v)\.?\s*$/i;

function normalize(name) {
  let s = String(name == null ? '' : name).toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' ');           // drop parentheticals, e.g. "(Hangzhou)"
  let prev;                                    // peel trailing legal suffixes repeatedly
  do { prev = s; s = s.replace(SUFFIX_RE, ''); } while (s !== prev);
  s = s.replace(/[.,/&'"()’]/g, ' ');     // remaining punctuation → space (keep letters/digits/hyphen/space)
  return s.replace(/\s+/g, ' ').trim();
}

module.exports = { normalize, LEGAL_SUFFIXES };
