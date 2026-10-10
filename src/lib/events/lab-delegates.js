// ── WHICH LABS GO ON THE SCOPE "QC PARTNERS" TAB ──────────────────────────────
//
// This is a module rather than two template literals inside scripts/seed-scope-delegates.js for one
// reason: the checker has to execute the SHIPPED query. The repo already learned that a query which
// parses is not a query that runs (scripts/check-molecule-search-sql.js), and a checker that
// rebuilds the SQL instead of importing it tests itself.
//
// The history matters, because the same mistake happened twice on this same table:
//
//   2026-10-09, CPHI lab lookup: ORDER BY (notes IS NULL) DESC, (contact_email IS NOT NULL) DESC,
//     name. Both leading terms were effectively constant, so it ran ALPHABETICALLY and spent four
//     hundred serialised lookups starting at "2seventy bio" and three numbered Québec companies.
//     src/lib/labconnect/lab-shape.js was written to fix it.
//
//   2026-10-10, SCOPE delegate seed: ORDER BY (region LIKE 'eu%') DESC, (contact_email IS NOT NULL)
//     DESC, name. All 60 rows were EU with a contact, so again both leading terms were constant and
//     again it ran alphabetically — ACS Dobfar, Aesica, AGC Biologics, Ajinomoto, Albhades, Alexion.
//     The fix from the previous day existed and was not used.
//
// And the ordering was the smaller half of it. Those six names are API MANUFACTURERS and CDMOs, not
// analytical laboratories. `labs` is seeded from the FDA establishment register, which records that
// a site is registered — not whether it makes drugs or tests them. The same register, through the
// same blind spot, put dairies and poultry farms on the CPHI buyer tab.
//
// So on this tab the name-shape test is a FILTER, not a ranking. On the CPHI lookup a wrong row
// cost one HTTP request and could be demoted; here a wrong row is a company Naresh walks up to in
// Barcelona to talk about QC testing, and an API maker is a supplier — a different tab and a
// different conversation. Better a shorter list than a wrong one.
'use strict';

const { labLookupOrderSql, looksLikeLabSql } = require('../labconnect/lab-shape');

// A lab already 'active' in LabConnect is a partner, not a recruitment target; 'rejected' has been
// looked at and declined. Everything else is in scope.
const ELIGIBLE = `status NOT IN ('active', 'rejected')`;

/**
 * The delegates for the QC Partners tab, most worth approaching first.
 *
 * Deliberately NOT restricted to EU regions. A real analytical lab outside Europe is a better row
 * than an Italian CDMO, and labLookupOrderSql already leads with region, so the European ones come
 * first and a non-European one is visible in the count rather than silently dropped.
 */
function labDelegateSql(limit = 60) {
  const n = Number.isInteger(limit) && limit > 0 ? limit : 60;
  return `
  SELECT name, city, country, region, status, contact_name, contact_email,
         research_capable, gmp_capable
    FROM labs
   WHERE ${ELIGIBLE}
     AND ${looksLikeLabSql('name')}
   ORDER BY ${labLookupOrderSql()}
   LIMIT ${n}`;
}

/**
 * What the shape test removed. The same WHERE minus the name test, so the seed can print the
 * before/after rather than only the after — the drop count is the honest measure of how wrong an
 * unfiltered list was, and it is the number that would have caught this on 2026-10-09.
 */
function labShapeAuditSql() {
  const shape = looksLikeLabSql('name');
  return `
  SELECT COUNT(*)::int                                           AS eligible,
         COUNT(*) FILTER (WHERE ${shape})::int                   AS reads_like_a_lab,
         COUNT(*) FILTER (WHERE region LIKE 'eu%')::int          AS eu,
         COUNT(*) FILTER (WHERE region LIKE 'eu%'
                            AND ${shape})::int                   AS eu_reads_like_a_lab
    FROM labs
   WHERE ${ELIGIBLE}`;
}

module.exports = { labDelegateSql, labShapeAuditSql, ELIGIBLE };
