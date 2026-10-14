// ── TRIAL SITES: THE JOIN THAT DID NOT EXIST ──────────────────────────────────
//
// A trial's recruiting sites are the most commercially useful thing in the registry and the one
// part we were discarding. We stored locations_countries — "United Kingdom" — and threw the
// facility names away, so Oxford appeared in 4 studies when the real figure is 46: the other 42
// are trials where Oxford is one of forty hospitals recruiting for somebody else's drug, and those
// are the interesting ones, because they name the sponsor Oxford is working for.
//
// 86,514 site rows sit in clinical_studies.raw_json across 91.6% of studies, with 38,903 distinct
// facility names in 113 countries. Nothing needs re-fetching.
//
// ── TWO THINGS MAKE RAW FACILITY NAMES UNUSABLE AS KEYS ──────────────────────
//
// 1. SPELLING. The same hospital arrives as "Oxford University Hospitals NHS Foundation Trust",
//    "Oxford University Hospitals NHS Trust", "Churchill Hospital, Oxford University Hospitals NHS
//    Foundation Trust", and "Oxford University Hospitals Nhs Foundation Trust /ID# 272486" — the
//    last carrying a per-trial site identifier inside the name. Counting raw names fragments one
//    institution into ten, which is exactly what the institutions table already does.
//
// 2. ANONYMISATION. The busiest "facilities" in the data are not facilities:
//
//        2192  Novartis Investigative Site
//        1836  Research Site
//        1602  Clinical Trial Site
//         342  GSK Investigational Site
//          86  Cinical Study Site        ← the registry's own typo
//
//    Industry sponsors routinely publish a placeholder plus a city. Those rows are real sites and
//    must be kept — they are evidence a trial runs in that city — but they are NOT institutions,
//    and letting them into an institution count would put "Research Site" at the top of every
//    league table. So they are flagged, not dropped, and the flag is what callers filter on.
//
// The consequence worth stating plainly: institution-level intelligence is systematically blind to
// the sponsors that anonymise. Any claim about "which institutions work with which sponsor" is
// complete only for the sponsors that name their sites, and that is a property of the registry
// rather than something better code can fix.
'use strict';

// A per-trial site identifier embedded in the name. Four shapes seen in live data.
const SITE_ID_PATTERNS = [
  /\s*\/\s*ID#\s*\d+\s*$/i,              // "… NHS Foundation Trust /ID# 272486"
  /\s*\(\s*Site\s*\d+\s*\)\s*$/i,        // "GenesisCare - Oxford ( Site 2607)"
  /\s*[-–]\s*Site\s*\d+\s*$/i,           // "Something - Site 123"
  /\s*,?\s*Site\s+\d+\s*$/i,             // "Something, Site 45"
];

// Ends in a generic "… site" with no institution in front of it. Deliberately matched on the
// SUFFIX so that a sponsor's name in front ("Novartis Investigative Site") still counts as
// anonymised, while a real name that merely contains "Research" does not —
// "Oxford Centre for Clinical Magnetic Resonance Research (Ocmr)" is a real place.
// Only "… Site" forms. I first allowed "centre|center" here too, and it flagged "National
// Institutes of Health Clinical Center" — 249 rows and one of the best-known research hospitals in
// the world. The asymmetry settles it: missing a placeholder puts one junk row in a league table,
// while flagging a real institution hides all of its trials. "Clinical Center" is a legitimate
// name; "Clinical Site" is not.
const ANON_SUFFIX = /\b(investigative|investigational|research|clinical|study|trial|cinical)\s+site$/i;
const ANON_EXACT = /^(site|research site|clinical site|study site|trial site|investigator site|local institution|site reference \d+)$/i;

/** Strip a per-trial site id from a facility name. Returns the name unchanged if there is none. */
function stripSiteId(name) {
  let s = String(name == null ? '' : name).trim();
  let prev;
  do {
    prev = s;
    for (const re of SITE_ID_PATTERNS) s = s.replace(re, '').trim();
  } while (s !== prev);
  return s;
}

/**
 * Is this facility name a sponsor's placeholder rather than an institution?
 * Kept as data, excluded from institution counts.
 */
function isAnonymised(name) {
  const s = stripSiteId(name).replace(/[.,;:]+$/, '').trim();
  if (!s) return true;
  if (ANON_EXACT.test(s)) return true;
  return ANON_SUFFIX.test(s);
}

const LEGAL = /\b(inc|llc|ltd|limited|plc|gmbh|ag|sa|srl|spa|bv|nv|as|ab|oy|pty|pte|co|corp|corporation)\b\.?/gi;

/**
 * A normalised key for grouping one institution's many spellings.
 *
 * Deliberately lossy and deliberately conservative: it folds case, punctuation, legal suffixes and
 * the "NHS Foundation Trust" / "NHS Trust" distinction, because those are the same organisation.
 * It does NOT try to merge "Churchill Hospital" into "Oxford University Hospitals" — that is a
 * real-world hierarchy decision, not a string operation, and guessing it would silently attribute
 * one hospital's trials to another.
 */
function normalizeFacility(name) {
  let s = stripSiteId(name).toLowerCase();
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9]+/g, ' ');
  s = s.replace(LEGAL, ' ');
  // NHS trust forms are the same body written three ways.
  s = s.replace(/\bnhs\s+foundation\s+trust\b/g, 'nhs trust');
  s = s.replace(/\buniversity\s+hospitals?\b/g, 'university hospital');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Every site on a stored study record.
 * Returns [{ facility, facility_normalized, anonymised, city, state, country, status, zip }].
 *
 * Rows with no facility name at all still come back when they carry a city or country, because
 * "a trial recruits in Oxford" is useful even when the hospital is unnamed — that is precisely the
 * anonymised case, and dropping it would understate activity in the places industry trials run.
 */
function sitesOf(raw) {
  let j;
  try { j = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return []; }
  if (!j) return [];
  const ps = j.protocolSection || j;
  const m = ps.contactsLocationsModule || ps.contacts_locations_module || {};
  const out = [];
  for (const l of (m.locations || [])) {
    const facility = (l.facility || l.name || '').trim() || null;
    const city = (l.city || '').trim() || null;
    const country = (l.country || '').trim() || null;
    if (!facility && !city && !country) continue;
    out.push({
      facility,
      facility_normalized: facility ? normalizeFacility(facility) : null,
      anonymised: facility ? isAnonymised(facility) : true,
      city,
      state: (l.state || '').trim() || null,
      country,
      zip: (l.zip || '').trim() || null,
      status: (l.status || '').trim() || null,
    });
  }
  return out;
}

module.exports = { sitesOf, normalizeFacility, isAnonymised, stripSiteId };
