// ── DOES THIS ADDRESS BELONG TO THAT INSTITUTION? ────────────────────────────
//
// The weakest claim in the research pipeline. NIH RePORTER gives the PI and the money, verifiably.
// Europe PMC gives an address, extracted from affiliation prose on one of their papers. The join
// between the two is a judgement, and it has already been wrong in the obvious way: a search for
// Scott Miller at Yale matched sophie.miller@sahmri.com and edward.miller@yale.edu.
//
// attributeToPi() handles the PERSON half — surname and given-name agreement. This handles the
// INSTITUTION half, which nothing checked: does scott.miller@yale.edu actually belong to the
// organisation RePORTER names as "YALE UNIVERSITY"?
//
// It cannot prove the address is live — only a send does that. What it can do is catch the class
// of error where a correct-looking person is attached to the wrong organisation, which is the one
// that produces a confident, personalised email to a stranger.
//
// ── TWO WAYS A REAL ACADEMIC DOMAIN MATCHES ──────────────────────────────────
//
//   by word   wisc.edu        ↔ UNIVERSITY OF WISCONSIN-MADISON   ("wisc" begins "wisconsin")
//             einsteinmed.edu ↔ ALBERT EINSTEIN COLLEGE OF MEDIC  ("einstein" is a whole token)
//   by initials  byu.edu      ↔ BRIGHAM YOUNG UNIVERSITY
//                uci.edu      ↔ UNIVERSITY OF CALIFORNIA-IRVINE   (stopwords dropped)
//
// Both are needed. Neither alone covers the real list.
'use strict';

// Words that carry no identity. "of" and "at" must go before initials are taken, or UNC becomes
// UONC and the match fails.
const STOP = new Set(['of', 'the', 'at', 'and', 'for', 'in', 'a', 'an',
  'univ', 'university', 'college', 'institute', 'school', 'center', 'centre',
  'dept', 'department', 'div', 'division', 'inc', 'llc', 'ltd', 'the']);

// Public mail providers. A PI using one is not necessarily wrong — plenty do — but it carries no
// institutional evidence at all, so it is reported as its own category rather than as a match or
// a mismatch.
const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
  'outlook.com', 'live.com', 'icloud.com', 'me.com', 'aol.com', 'protonmail.com', 'gmx.com',
  'mail.com', 'qq.com', '163.com', '126.com', 'yandex.ru']);

const tokens = (s) => String(s || '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .split(/[^a-z0-9]+/)
  .filter(Boolean);

/** The significant words of an institution name, in order. */
function nameWords(institution) {
  return tokens(institution).filter((w) => w.length > 1 && !STOP.has(w));
}

// Only grammatical filler is dropped when forming initials. "University" must stay — UNC is
// U-N-C from "Univ of North Carolina", and dropping it yields NCHH, which matches nothing. The
// first version dropped it and produced eight false mismatches out of twenty-five real pairs.
const INITIAL_SKIP = new Set(['of', 'the', 'at', 'and', 'for', 'in', 'a', 'an']);

/**
 * Acronyms a name could plausibly produce, as PREFIXES of increasing length, because a domain
 * usually keeps the first two to four initials and drops the rest:
 *   UNIV OF NORTH CAROLINA CHAPEL HILL -> un, unc, unch, unchh   (unc.edu)
 *   UNIVERSITY OF TEXAS SAN ANTONIO    -> ut, uts, utsa          (utsa.edu)
 * plus the "u + first word" form that umich.edu and utdallas.edu use.
 */
function acronyms(institution) {
  const all = tokens(institution).filter((t) => t.length > 1 && !INITIAL_SKIP.has(t));
  const out = new Set();
  const letters = all.map((x) => x[0]).join('');
  for (let n = 2; n <= Math.min(letters.length, 5); n += 1) out.add(letters.slice(0, n));

  const w = nameWords(institution);
  if (/univ/i.test(institution)) {
    if (w.length) out.add(`u${w[0]}`);
    if (w.length > 1) out.add(`u${w[1]}`);
  }
  return [...out].filter((a) => a.length >= 2);
}

/**
 * @returns {{verdict: 'match'|'freemail'|'mismatch'|'unknown', how: string, domain: string}}
 *
 * 'unknown' rather than 'mismatch' when there is nothing to compare, because an absent
 * institution name is a gap in our data, not evidence against the address.
 */
function domainMatchesInstitution(email, institution) {
  const addr = String(email || '').trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  if (at < 1) return { verdict: 'unknown', how: 'no address', domain: '' };
  const domain = addr.slice(at + 1);
  if (!domain) return { verdict: 'unknown', how: 'no domain', domain: '' };
  if (FREEMAIL.has(domain)) return { verdict: 'freemail', how: 'public mail provider', domain };
  if (!String(institution || '').trim()) {
    return { verdict: 'unknown', how: 'no institution recorded', domain };
  }

  // Labels of the domain, minus the public suffix pieces, so "chem.wisc.edu" offers chem + wisc.
  const labels = domain.split('.').filter((l) => !['edu', 'ac', 'uk', 'com', 'org', 'net', 'gov',
    'us', 'de', 'fr', 'ca', 'au', 'jp', 'cn', 'in', 'ch', 'nl', 'se', 'es', 'it'].includes(l));

  const words = nameWords(institution);

  // ── BY WORD ────
  for (const label of labels) {
    for (const w of words) {
      if (label === w) return { verdict: 'match', how: `"${label}" is "${w}"`, domain };
      // A label that begins a name word, or contains one: wisc→wisconsin, einsteinmed⊃einstein.
      if (w.length >= 4 && label.startsWith(w.slice(0, Math.min(w.length, 6)))) {
        return { verdict: 'match', how: `"${label}" begins "${w}"`, domain };
      }
      if (label.length >= 4 && w.startsWith(label)) {
        return { verdict: 'match', how: `"${label}" begins "${w}"`, domain };
      }
      if (w.length >= 5 && label.includes(w)) {
        return { verdict: 'match', how: `"${label}" contains "${w}"`, domain };
      }
    }
  }

  // ── BY INITIALS ────
  const acr = acronyms(institution);
  for (const label of labels) {
    for (const a of acr) {
      if (label === a) return { verdict: 'match', how: `"${label}" = initials of "${institution}"`, domain };
      if (a.length >= 3 && label.startsWith(a)) {
        return { verdict: 'match', how: `"${label}" begins with initials "${a}"`, domain };
      }
      // umich.edu ↔ "u" + "michigan": the domain is a truncation of the long form.
      if (label.length >= 4 && a.startsWith(label)) {
        return { verdict: 'match', how: `"${label}" shortens "${a}"`, domain };
      }
    }
  }

  // ── NOTHING MATCHED, AND THAT IS TWO DIFFERENT SITUATIONS ────
  //
  // umn.edu and umd.edu are real addresses at the right institutions whose acronyms no algorithm
  // derives from "University of Minnesota" and "Univ of Maryland, College Park" — they are brand
  // names. Reporting those as wrong, beside a genuinely wrong one, would teach the reader to
  // ignore the whole column.
  //
  // So an academic domain that cannot be linked is UNVERIFIED — a human glance, not an error. A
  // non-academic domain with no link is a MISMATCH, which is the sahmri.com-for-Yale shape and
  // the one worth acting on.
  const academic = /\.(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$/.test(domain)
    || /\.(gov|int)$/.test(domain);
  if (academic) {
    return {
      verdict: 'unverified',
      how: `"${domain}" is an academic domain but nothing links it to "${institution}" — `
        + 'likely a brand acronym; worth one human glance',
      domain,
    };
  }
  return { verdict: 'mismatch', how: `"${domain}" is not academic and nothing links it to "${institution}"`, domain };
}

module.exports = { domainMatchesInstitution, nameWords, acronyms, FREEMAIL };
