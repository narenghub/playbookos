// ── SEARCHING THE INSTITUTIONS, AND READING ONE ───────────────────────────────
//
// "If I enter Oxford, I might see all this information and their contact information."
//
// Everything here reads study_sites — the parsed trial sites, 84,608 rows — rather than the
// curated research_institutions table. The difference is the whole point: research_institutions
// was built when a facility could only be matched where the institution was the PI's affiliation
// or the sponsor, so Oxford showed 4 trials. As a recruiting SITE it is on 18 UK trials, 14 of them
// industry-sponsored, and those 14 are the commercially interesting ones because they name the
// sponsor Oxford is running trials for.
//
// ── TWO RULES THE SQL ENFORCES RATHER THAN DOCUMENTS ─────────────────────────
//
// 1. GROUPING IS ON facility_normalized, NEVER ON THE VERBATIM NAME. One hospital arrives as
//    "Oxford University Hospitals NHS Foundation Trust", "… NHS Trust", and "… Nhs Foundation
//    Trust /ID# 272486". Counting raw names fragments one institution into ten.
//
// 2. AN INSTITUTION IS A NAME **PLUS A COUNTRY**. Searching "Oxford" returned 35 trials, of which
//    20 were Baptist Memorial Hospital and Cancer Center-Oxford — in Oxford, MISSISSIPPI. The NCI
//    and cooperative-group trials belonged to the Mississippi site and the Roche, Pfizer, Janssen
//    and argenx trials to the English one. Reporting the merged total as one institution's
//    activity is confidently wrong, and it is the first thing a buyer would notice. So the group
//    key is (facility_normalized, country) everywhere, and no result can be rendered without its
//    country.
//
//    country is COALESCEd to '' in the key rather than left NULL, because a JOIN or GROUP BY on a
//    NULL country silently drops those rows — the sites with no country published would vanish
//    from a search while still being counted in the totals.
//
// ── WHAT CANNOT BE ANSWERED, AND IS LABELLED AS SUCH ────────────────────────
//
// Naren's question was "to whom are they giving these studies to develop the molecules, to whom
// for CRO clinical studies". Sponsors are answerable. CROs are NOT: a sponsor is not required to
// disclose the CRO it contracted and the overwhelming majority do not. Where a CRO is visible it
// is because it was named as a *collaborator*, so the CRO list is a floor and never a count — and
// the page says so, rather than leaving somebody to discover it after quoting a number to a
// vendor.
'use strict';

// Names that read like a contract research organisation or a central lab. Used only to LABEL a
// collaborator, never to filter one — a wrong guess should mis-tag a row, not hide it.
const CRO_HINT = /\b(cro|contract research|clinical research|quintiles|iqvia|parexel|icon plc|syneos|covance|labcorp|ppd|medpace|fortrea|thermo fisher|charles river|wuxi|novotech|veristat|emmes|worldwide clinical|celerion|premier research|allucent|caidya|simbec|clinipace)\b/i;
const ACADEMIC_HINT = /\b(universit|college|institut|hospital|clinic|school|centre|center|trust|nhs|foundation|academy|cancer cent|klinik|hopital|ospedale|universid)/i;
const GOV_HINT = /\b(national (cancer|institute|institutes|heart|eye)|nih\b|nci\b|ministry|department of (health|veterans)|va (medical|office)|inserm|nhs england|public health)\b/i;

/**
 * What kind of organisation a sponsor or collaborator name looks like.
 * A hint, deliberately: it labels a row in a table a human is reading, and it is never used to
 * include or exclude anything. Order matters — a government institute is also "institute".
 */
function classifyOrg(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return 'unknown';
  if (CRO_HINT.test(s)) return 'cro';
  if (GOV_HINT.test(s)) return 'government';
  if (ACADEMIC_HINT.test(s)) return 'academic';
  return 'industry';
}

/**
 * The collaborators on a study, as a list of names.
 *
 * The ingest writes this column as `JSON.stringify(names)`, so in practice every row is a JSON
 * array and that is the path almost all data takes. The other shapes are for rows written before
 * that, or by hand.
 *
 * ── A COMMA IS NOT TREATED AS A DELIMITER, DELIBERATELY ────
 *
 * A pipe or a semicolon is unambiguous. A comma is not: it appears inside organisation names far
 * more often than between them. Splitting on it turns "Hoffmann-La Roche, Inc." into a collaborator
 * called "Inc." and "National Heart, Lung, and Blood Institute" into three organisations that do
 * not exist. The asymmetry decides it — refusing to split leaves one row reading oddly in a table
 * a human is scanning, while splitting invents organisations and attributes real trials to them.
 */
function parseCollaborators(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const s = String(value).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return j.map((v) => String(v && v.name ? v.name : v).trim()).filter(Boolean);
    } catch (_) { /* fall through to splitting */ }
  }
  if (/[|;]/.test(s)) return s.split(/\s*[|;]\s*/).map((v) => v.trim()).filter(Boolean);
  return [s];
}

// The rows a search or a profile is allowed to see. Anonymised placeholders are excluded from both
// — "Novartis Investigative Site" is 2,192 rows and is not an institution — and a row with no
// facility name cannot be grouped under one.
const VISIBLE = `ss.anonymised = FALSE AND ss.facility_normalized IS NOT NULL AND ss.facility_normalized <> ''`;

// ── SEARCH ────────────────────────────────────────────────────────────────────
// $1 = query text ('' matches everything), $2 = country ('' = any), $3 = limit.
//
// The display name is the most common verbatim spelling in the group, longest as the tie-break,
// so "Oxford University Hospitals NHS Foundation Trust" wins over the same name carrying a
// per-trial site id. DISTINCT ON does that in one pass; picking it in JS would mean shipping every
// spelling of 30,519 institutions to the browser.
const SEARCH_SQL = `
WITH m AS (
  SELECT ss.facility_normalized AS key,
         COALESCE(ss.country, '') AS country,
         ss.facility, ss.city, ss.nct_id, ss.status
    FROM study_sites ss
   WHERE ${VISIBLE}
     AND ($1 = '' OR ss.facility_normalized ILIKE '%' || $1 || '%' OR ss.facility ILIKE '%' || $1 || '%')
     AND ($2 = '' OR COALESCE(ss.country, '') = $2)
),
g AS (
  SELECT key, country, COUNT(DISTINCT nct_id)::int AS trials, COUNT(DISTINCT city)::int AS cities
    FROM m GROUP BY key, country
),
nm AS (
  SELECT DISTINCT ON (key, country) key, country, facility AS name
    FROM (SELECT key, country, facility, COUNT(*) AS n FROM m GROUP BY 1, 2, 3) q
   ORDER BY key, country, n DESC, length(facility) DESC
),
ct AS (
  SELECT DISTINCT ON (key, country) key, country, city
    FROM (SELECT key, country, city, COUNT(*) AS n FROM m WHERE city IS NOT NULL GROUP BY 1, 2, 3) q
   ORDER BY key, country, n DESC
),
st AS (
  SELECT m.key, m.country,
         COUNT(DISTINCT m.nct_id) FILTER (WHERE cs.sponsor_type ILIKE '%INDUSTRY%')::int AS industry_trials,
         COUNT(DISTINCT m.nct_id) FILTER (WHERE m.status ILIKE 'RECRUITING')::int AS recruiting
    FROM m JOIN clinical_studies cs ON cs.nct_id = m.nct_id
   GROUP BY 1, 2
)
SELECT g.key, g.country, nm.name, ct.city, g.trials, g.cities,
       COALESCE(st.industry_trials, 0)::int AS industry_trials,
       COALESCE(st.recruiting, 0)::int AS recruiting
  FROM g
  JOIN nm ON nm.key = g.key AND nm.country = g.country
  LEFT JOIN ct ON ct.key = g.key AND ct.country = g.country
  LEFT JOIN st ON st.key = g.key AND st.country = g.country
 ORDER BY g.trials DESC, nm.name
 LIMIT $3`;

// Every profile query takes the same two parameters: $1 = facility_normalized, $2 = country ('').
const SCOPE = `${VISIBLE} AND ss.facility_normalized = $1 AND COALESCE(ss.country, '') = $2`;

// The spellings and places this one institution appears under. Shown at the top of the profile
// rather than hidden behind a tooltip: if two hospitals have been merged by a shared name, the
// reader sees it before reading a single sponsor.
const PROFILE_NAMES_SQL = `
SELECT ss.facility AS name, ss.city, ss.state, COUNT(DISTINCT ss.nct_id)::int AS trials
  FROM study_sites ss
 WHERE ${SCOPE}
 GROUP BY 1, 2, 3
 ORDER BY trials DESC, name
 LIMIT 40`;

// last_update_post_date is TEXT in YYYY-MM-DD, so MAX() on it is the real maximum. start_date is a
// DATE. Mixing them in one row is fine; formatting them is the caller's problem.
const PROFILE_TOTALS_SQL = `
SELECT COUNT(DISTINCT ss.nct_id)::int AS trials,
       COUNT(DISTINCT ss.nct_id) FILTER (WHERE cs.sponsor_type ILIKE '%INDUSTRY%')::int AS industry_trials,
       COUNT(DISTINCT ss.nct_id) FILTER (WHERE ss.status ILIKE 'RECRUITING')::int AS recruiting_here,
       COUNT(DISTINCT cs.lead_sponsor_name)::int AS sponsors,
       COUNT(DISTINCT cs.therapeutic_area)::int AS areas,
       MIN(cs.start_date) AS first_start,
       MAX(cs.last_update_post_date) AS last_update
  FROM study_sites ss
  JOIN clinical_studies cs ON cs.nct_id = ss.nct_id
 WHERE ${SCOPE}`;

// WHO THEY RUN TRIALS FOR. The answer to the actual question.
const PROFILE_SPONSORS_SQL = `
SELECT cs.lead_sponsor_name AS sponsor,
       MAX(cs.sponsor_type) AS sponsor_type,
       COUNT(DISTINCT ss.nct_id)::int AS trials,
       COUNT(DISTINCT ss.nct_id) FILTER (WHERE ss.status ILIKE 'RECRUITING')::int AS recruiting,
       MAX(cs.last_update_post_date) AS last_update
  FROM study_sites ss
  JOIN clinical_studies cs ON cs.nct_id = ss.nct_id
 WHERE ${SCOPE} AND cs.lead_sponsor_name IS NOT NULL
 GROUP BY 1
 ORDER BY trials DESC, sponsor
 LIMIT 80`;

const PROFILE_AREAS_SQL = `
SELECT COALESCE(cs.therapeutic_area, 'unclassified') AS area,
       COUNT(DISTINCT ss.nct_id)::int AS trials
  FROM study_sites ss
  JOIN clinical_studies cs ON cs.nct_id = ss.nct_id
 WHERE ${SCOPE}
 GROUP BY 1
 ORDER BY trials DESC, area
 LIMIT 30`;

const PROFILE_PHASES_SQL = `
SELECT COALESCE(NULLIF(cs.phase, ''), 'not stated') AS phase,
       COUNT(DISTINCT ss.nct_id)::int AS trials
  FROM study_sites ss
  JOIN clinical_studies cs ON cs.nct_id = ss.nct_id
 WHERE ${SCOPE}
 GROUP BY 1
 ORDER BY trials DESC, phase`;

// The trials themselves, with the site's OWN status — which is not the trial's status. A trial can
// be RECRUITING overall while this particular hospital has completed, and "is Oxford recruiting
// today" is the question somebody is actually asking.
const PROFILE_STUDIES_SQL = `
SELECT DISTINCT ON (ss.nct_id)
       ss.nct_id, ss.status AS site_status, ss.city,
       cs.brief_title, cs.phase, cs.overall_status, cs.therapeutic_area, cs.disease,
       cs.lead_sponsor_name, cs.sponsor_type, cs.collaborators,
       cs.enrollment_count, cs.start_date, cs.last_update_post_date
  FROM study_sites ss
  JOIN clinical_studies cs ON cs.nct_id = ss.nct_id
 WHERE ${SCOPE}
 ORDER BY ss.nct_id, cs.last_update_post_date DESC NULLS LAST
 LIMIT 400`;

// Countries for the filter, built from the same visible set as the search so the two cannot
// disagree — a country offered in a dropdown that returns nothing is a bug report.
const COUNTRIES_SQL = `
SELECT COALESCE(ss.country, '') AS country,
       COUNT(DISTINCT ss.facility_normalized)::int AS institutions
  FROM study_sites ss
 WHERE ${VISIBLE}
 GROUP BY 1
 HAVING COALESCE(ss.country, '') <> ''
 ORDER BY institutions DESC, country`;

// ── THE SIBLINGS A STRICT KEY HIDES ──────────────────────────────────────────
//
// Oxford University Hospitals publishes under at least six spellings, and normalizeFacility folds
// only three of them. It deliberately will not fold "Churchill Hospital, Oxford University
// Hospitals NHS Foundation Trust" or "… - John Radcliffe Hospital" into the parent, because those
// are named hospitals INSIDE the trust and merging a child into its parent is a real-world
// hierarchy decision rather than a string operation — guess it wrong and one hospital's trials are
// attributed to another.
//
// The cost of that correctness is that the trust's own row reads 8 trials when the Oxford footprint
// is nearer 25, with Churchill, John Radcliffe, GenesisCare and the OCMR sitting in separate rows
// that give no sign of being the same place. So instead of merging them, the profile SHOWS them:
// other institutions in the same country whose name shares a distinctive word with this one, each
// keeping its own count and its own link.
//
// That is the honest shape. The system does not claim they are one organisation — Oxford Health NHS
// Foundation Trust is a different trust and GenesisCare is a private chain — it says "these look
// related, you decide", which is a judgement Naren can make and the data cannot.
//
// MATCHING IS ON A DISTINCTIVE WORD, NOT A SHARED ONE. Without the stop list, every token in
// "Oxford University Hospitals NHS Foundation Trust" is a match term and "hospital" alone would
// return every hospital in the United Kingdom under the heading "related".
const NAME_STOPWORDS = new Set(['hospital', 'hospitals', 'university', 'universities', 'college',
  'school', 'clinic', 'clinical', 'clinics', 'centre', 'center', 'centres', 'centers', 'nhs',
  'trust', 'trusts', 'medical', 'medicine', 'institute', 'institutes', 'institution', 'research',
  'foundation', 'health', 'healthcare', 'care', 'cancer', 'general', 'regional', 'national',
  'children', 'childrens', 'womens', 'department', 'dept', 'division', 'science', 'sciences',
  'service', 'services', 'system', 'group', 'site', 'unit', 'trial', 'trials', 'study', 'studies',
  'of', 'the', 'and', 'for', 'at', 'in', 'de', 'la', 'el', 'du', 'des', 'der', 'die', 'das',
  'saint', 'st', 'dr', 'prof', 'ltd', 'inc', 'llc', 'gmbh']);

/**
 * The words in a normalised institution name that could identify an organisation.
 *
 * Returns [] when nothing distinctive is left — "University Hospital", "National Cancer Centre" —
 * and the caller must then skip the related lookup entirely rather than match on a generic word.
 */
function distinctiveTokens(normalizedName, max = 4) {
  return String(normalizedName == null ? '' : normalizedName)
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t) && !/^\d+$/.test(t))
    .slice(0, max);
}

// $1 = this institution's key (excluded), $2 = country, $3 = text[] of distinctive tokens.
// \m and \M are Postgres word boundaries, so "oxford" cannot match "oxfordshire-something" as a
// substring. Tokens arrive from distinctiveTokens(), which strips everything but [a-z0-9], so
// there is nothing in them that can act as regex metacharacter.
const RELATED_SQL = `
WITH tok AS (SELECT DISTINCT unnest($3::text[]) AS t),
cand AS (
  SELECT ss.facility_normalized AS key, COALESCE(ss.country, '') AS country,
         ss.facility, ss.city, ss.nct_id
    FROM study_sites ss
   WHERE ${VISIBLE}
     AND COALESCE(ss.country, '') = $2
     AND ss.facility_normalized <> $1
     AND EXISTS (SELECT 1 FROM tok WHERE ss.facility_normalized ~ ('\\m' || tok.t || '\\M'))
),
g AS (SELECT key, country, COUNT(DISTINCT nct_id)::int AS trials FROM cand GROUP BY 1, 2),
nm AS (
  SELECT DISTINCT ON (key, country) key, country, facility AS name, city
    FROM (SELECT key, country, facility, city, COUNT(*) AS n FROM cand GROUP BY 1, 2, 3, 4) q
   ORDER BY key, country, n DESC, length(facility) DESC
),
sh AS (
  SELECT c.key, c.country, COUNT(DISTINCT t.t)::int AS shared
    FROM (SELECT DISTINCT key, country FROM cand) c
    JOIN tok t ON c.key ~ ('\\m' || t.t || '\\M')
   GROUP BY 1, 2
)
SELECT g.key, g.country, nm.name, nm.city, g.trials, sh.shared
  FROM g
  JOIN nm ON nm.key = g.key AND nm.country = g.country
  JOIN sh ON sh.key = g.key AND sh.country = g.country
 ORDER BY sh.shared DESC, g.trials DESC, nm.name
 LIMIT 12`;

const CENSUS_SQL = `
SELECT COUNT(*)::int AS site_rows,
       COUNT(*) FILTER (WHERE anonymised = FALSE)::int AS named_rows,
       COUNT(DISTINCT facility_normalized) FILTER (WHERE anonymised = FALSE)::int AS institutions,
       COUNT(DISTINCT country)::int AS countries,
       COUNT(DISTINCT nct_id)::int AS trials,
       MAX(parsed_at) AS parsed_at
  FROM study_sites`;

/**
 * Rank the collaborators across a set of studies, labelled by what they look like.
 *
 * Done in JS rather than SQL because collaborators is a delimited TEXT column: splitting it in
 * Postgres would mean a regexp_split_to_table over every row on every request, and the labelling
 * rule already lives here.
 */
function collaboratorRanking(studies, limit = 40) {
  const seen = new Map();
  for (const s of studies || []) {
    const names = parseCollaborators(s.collaborators);
    const unique = new Set(names.map((n) => n.trim()).filter(Boolean));
    for (const name of unique) {
      const k = name.toLowerCase();
      const row = seen.get(k) || { name, kind: classifyOrg(name), trials: 0 };
      row.trials += 1;
      seen.set(k, row);
    }
  }
  return [...seen.values()]
    .sort((a, b) => b.trials - a.trials || a.name.localeCompare(b.name))
    .slice(0, limit);
}

module.exports = {
  classifyOrg,
  parseCollaborators,
  collaboratorRanking,
  distinctiveTokens,
  NAME_STOPWORDS,
  RELATED_SQL,
  SEARCH_SQL,
  PROFILE_NAMES_SQL,
  PROFILE_TOTALS_SQL,
  PROFILE_SPONSORS_SQL,
  PROFILE_AREAS_SQL,
  PROFILE_PHASES_SQL,
  PROFILE_STUDIES_SQL,
  COUNTRIES_SQL,
  CENSUS_SQL,
};
