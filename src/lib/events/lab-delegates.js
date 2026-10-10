// ── WHICH LABS GO ON THE SCOPE "QC PARTNERS" TAB ──────────────────────────────
//
// This is a module rather than a template literal inside the seed script for one reason: the
// checker has to execute the SHIPPED query. A checker that rebuilds the SQL tests itself.
//
// ── THE SAME BUG, THREE TIMES, ON THIS ONE TABLE ─────────────────────────────
//
//   1. 2026-10-09, CPHI lab lookup. ORDER BY (notes IS NULL) DESC, (contact_email IS NOT NULL)
//      DESC, name. Ran ALPHABETICALLY and spent four hundred serialised lookups starting at
//      "2seventy bio" and three numbered Québec companies. src/lib/labconnect/lab-shape.js was
//      written to fix it.
//
//   2. 2026-10-10, SCOPE delegate seed. ORDER BY (region LIKE 'eu%') DESC, (contact_email IS NOT
//      NULL) DESC, name. All 60 rows EU with a contact, both leading terms constant, alphabetical
//      again: ACS Dobfar, Aesica, AGC Biologics, Ajinomoto, Albhades, Alexion — API manufacturers,
//      not laboratories. The day-old fix was imported at the top of the file and not used.
//
//   3. 2026-10-10, the fix for (2). The shape filter was correct and the list was STILL
//      alphabetical: Abbott Laboratories, Advande Labs, Almac ×3, ALS, Apotek ×2. 571 rows passed
//      the filter, 111 of them European, and the query took the first 60 — so every ordering term
//      was once again constant across the rows that mattered and `name` decided. The checker said
//      "not in name order" because its fixture held 7 European labs against a limit of 60: the
//      limit never bit, so the condition that causes the bug was never present in the test.
//
// ── WHAT THAT PATTERN ACTUALLY SAYS ──────────────────────────────────────────
//
// Every signal available on `labs` is a coarse boolean — a region prefix, a name token, "has an
// email". Filter to the rows worth having and the survivors all share the same booleans, so the
// tiebreak decides the whole list, and the tiebreak was `name`. An ordering built only from
// booleans WILL collapse; the fix is not another boolean, it is a term that genuinely varies.
//
// Two of those exist, and both were in the data all along:
//
//   · SITE COUNT. `labs` is one row per FDA establishment, so COUNT(*) per company is how many
//     registered sites a firm operates. Eurofins has dozens; a single-site firm has one. It is the
//     only continuous measure of scale on the table, and scale is a fair proxy for "has a stand at
//     a European trade show".
//
//   · THE REGISTER'S OWN API-MANUFACTURER FLAG. scripts/seed-labs-from-fda.js writes `notes` =
//     "also an API manufacturer — may be testing its own product, not a contract lab" and leaves it
//     NULL otherwise. That is the register telling us this site tests its own product. Attempt (1)
//     had this signal and mislabelled it on screen as `contract_lab`; attempts (2) and (3) dropped
//     it entirely. It is a filter here.
//
// ── AND THEN THE BEST GROUP CROWDED OUT THE REST ─────────────────────────────
//
// With the ordering finally working, the top 8 came back five-eighths Eurofins: Amatsi, Biolab,
// BioPharma Finland, BioPharma Leiden, BioPharma Sweden, Pharma Quality Control. Each is a real
// laboratory and the ranking is right — and the list is still wrong, because Eurofins has ONE stand
// at a trade show. Five rows is five of sixty slots spent on one conversation, and it gets worse as
// the ranking improves: scale and a strong name are exactly what a large group scores highest on.
//
// So the ranking is applied WITHIN each corporate group as well as across the list, and only the
// top few of any group survive. The cap runs before the LIMIT, so the list is still 60 rows — just
// 60 across far more firms. `--max-per-group=0` turns it off, which is how the dry run shows what
// the cap is actually doing rather than asking anyone to trust it.
//
// And the duplicates were eating the list: "Almac Pharma Services Limited" appeared three times and
// "Apotek Produktion & Laboratorier AB" twice, because each is one row per registered establishment.
// Three rows for one firm in one city is one target spending three of sixty slots. Deduped per
// company AND city — the city stays part of a lab's identity, because Eurofins Madrid and Eurofins
// Lancaster are genuinely different conversations.
'use strict';

const {
  looksLikeLabSql, strongLabSql, originatorSql, labRankTerms, groupKeySql,
} = require('../labconnect/lab-shape');

// A lab already 'active' in LabConnect is a partner, not a recruitment target; 'rejected' has been
// looked at and declined.
//
// `notes IS NULL` is the register's API-manufacturer flag, not an absence of information — see the
// header. An originator's own site never sells QC testing to anyone, which is the same exclusion
// reached by name for the firms whose "Laboratories" is historical.
function eligibleSql() {
  return [
    `status NOT IN ('active', 'rejected')`,
    `notes IS NULL`,
    `NOT ${originatorSql('name')}`,
    looksLikeLabSql('name'),
  ].join('\n     AND ');
}

/**
 * The delegates for the QC Partners tab, most worth approaching first.
 *
 * Deliberately NOT restricted to EU regions: a real analytical lab outside Europe is a better row
 * than a European CDMO, and the ordering puts the European ones first anyway. COALESCE on region,
 * because `NULL LIKE 'eu%'` is NULL and a DESC sort puts NULLs FIRST in Postgres — a lab with no
 * region would otherwise have led the list for Barcelona.
 */
function labDelegateSql(limit = 60, maxPerGroup = 4) {
  const n = Number.isInteger(limit) && limit > 0 ? limit : 60;
  // 0 or a non-integer means "no cap", which is how the dry run shows what the cap is doing.
  const cap = Number.isInteger(maxPerGroup) && maxPerGroup > 0 ? maxPerGroup : null;
  return `
  WITH eligible AS (
    SELECT id, name, name_normalized, city, country, region, status,
           contact_name, contact_email, research_capable, gmp_capable,
           COUNT(*) OVER (PARTITION BY name_normalized)::int AS sites,
           ${groupKeySql('name_normalized', 'name')} AS group_key
      FROM labs
     WHERE ${eligibleSql()}
  ),
  one_per_site AS (
    -- The COUNTRY is part of the identity, not just the city. "Almac Pharma Services Limited" (GBR)
    -- and "Almac Pharma Services (Ireland) Limited" (IRL) normalise to the same company name and
    -- BOTH have a NULL city, so a city-only key silently dropped one of two separate legal
    -- entities — the thirteen-labs-lost failure again, two rows at a time instead of thirteen.
    SELECT DISTINCT ON (name_normalized, LOWER(COALESCE(city, '')), UPPER(COALESCE(country, ''))) *
      FROM eligible
     ORDER BY name_normalized, LOWER(COALESCE(city, '')), UPPER(COALESCE(country, '')),
              (contact_email IS NOT NULL) DESC, id
  ),
  ranked AS (
    SELECT *,
           ROW_NUMBER() OVER (PARTITION BY group_key
                                  ORDER BY ${labRankTerms({ sitesColumn: 'sites', capabilityFlags: true })}
                             )::int AS rank_in_group,
           COUNT(*) OVER (PARTITION BY group_key)::int AS group_rows
      FROM one_per_site
  )
  SELECT name, city, country, region, status, contact_name, contact_email,
         research_capable, gmp_capable, sites, group_key, group_rows
    FROM ranked
   ${cap ? `WHERE rank_in_group <= ${cap}` : ''}
   ORDER BY ${labRankTerms({ sitesColumn: 'sites', capabilityFlags: true })}
   LIMIT ${n}`;
}

/**
 * What each stage removed. The seed prints this, because a count of what was dropped is the number
 * that would have caught all three of the failures in the header — and the previous version of this
 * audit reported only the name filter, which is why attempt (3) looked fine.
 */
function labShapeAuditSql() {
  const shape = looksLikeLabSql('name');
  const strong = strongLabSql('name');
  const orig = originatorSql('name');
  return `
  SELECT COUNT(*)::int                                              AS eligible,
         COUNT(*) FILTER (WHERE ${shape})::int                      AS reads_like_a_lab,
         COUNT(*) FILTER (WHERE ${shape} AND notes IS NOT NULL)::int AS api_manufacturer_flag,
         COUNT(*) FILTER (WHERE ${shape} AND ${orig})::int           AS originator,
         COUNT(*) FILTER (WHERE ${shape} AND notes IS NULL
                            AND NOT ${orig})::int                    AS kept,
         COUNT(*) FILTER (WHERE ${shape} AND notes IS NULL
                            AND NOT ${orig} AND ${strong})::int       AS kept_strong,
         COUNT(*) FILTER (WHERE ${shape} AND notes IS NULL
                            AND NOT ${orig}
                            AND COALESCE(region, '') LIKE 'eu%')::int AS kept_eu,
         COUNT(DISTINCT name_normalized) FILTER (WHERE ${shape} AND notes IS NULL
                            AND NOT ${orig}
                            AND COALESCE(region, '') LIKE 'eu%')::int AS kept_eu_companies
    FROM labs
   WHERE status NOT IN ('active', 'rejected')`;
}

module.exports = { labDelegateSql, labShapeAuditSql, eligibleSql };
