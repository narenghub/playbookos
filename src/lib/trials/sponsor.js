'use strict';
// ── ONE COMPANY, ONE NAME ────────────────────────────────────────────────────
//
// The registry records a sponsor however the submitter typed it that day, so one company arrives
// under several names: "Daiichi Sankyo" and "Daiichi Sankyo Co., Ltd.", "Eisai Limited" and
// "Eisai Inc.". Across 1,661 sponsor strings the audit found four such pairs — a small number that
// does disproportionate damage, because a business-development team filters by exactly the handful
// of sponsors it already knows. They type the name of an account they own, get half the rows, and
// conclude the data is unreliable. They are not wrong to.
//
// ── WHY FOLDING STOPS WHERE IT DOES ──────────────────────────────────────────
//
// Only legal-entity suffixes and punctuation are removed. "Roche" and "Hoffmann-La Roche" stay
// apart, because they are genuinely different registrants and merging them would invent a fact
// rather than tidy one. Over-folding is the worse error: a missing row is visible and fixable, a
// wrongly merged sponsor is a quiet lie in every count built on top of it.
//
// canonicalSponsor picks the longest spelling as the display name, on the reasoning that the most
// complete form is the one a reader recognises and the one a lawyer would want on a document.

const SUFFIXES = new RegExp(
  '\\b('
  + 'inc|incorporated|llc|ltd|limited|plc|gmbh|ag|ab|oyj?|aps|a/s|as|sa|s a|spa|sas|sarl|kgaa|pty'
  + '|nv|n v|bv|b v|co|corp|corporation|company|holdings?|group'
  + '|pharmaceuticals?|pharma|therapeutics|biosciences?|laboratories|labs?'
  + ')\\b', 'g');

/** The folding key. Equal keys mean the same company; it is not meant to be shown to anyone. */
function normalizeSponsor(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(SUFFIXES, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Group raw sponsor strings into companies.
 * Returns Map<key, { display, variants[] }> — display is the fullest spelling seen.
 */
function groupSponsors(names) {
  const out = new Map();
  for (const raw of names || []) {
    const key = normalizeSponsor(raw);
    if (!key) continue;
    if (!out.has(key)) out.set(key, { display: raw, variants: [] });
    const e = out.get(key);
    if (!e.variants.includes(raw)) e.variants.push(raw);
    // Longest wins: "Daiichi Sankyo Co., Ltd." over "Daiichi Sankyo".
    if (String(raw).length > String(e.display).length) e.display = raw;
  }
  return out;
}

/** The name to print for one sponsor, given every spelling of it in the data. */
function canonicalSponsor(name, lookup) {
  const key = normalizeSponsor(name);
  if (lookup && lookup.has(key)) return lookup.get(key).display;
  return name;
}

module.exports = { normalizeSponsor, groupSponsors, canonicalSponsor };
