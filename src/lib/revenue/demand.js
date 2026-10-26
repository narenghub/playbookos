// ── WHAT COUNTS AS A BUYER ───────────────────────────────────────────────────
//
// On 2026-10-26 a report said "37 inquiries" and that number was used to describe the state of the
// business. Reading the rows showed what it was made of:
//
//   20  classified spam — one sender, "RobertFilub", eight times, never naming a molecule
//    4  our own test records: qa-buyer@abiozen.com and naresh.boda143@gmail.com, filed under
//       "ABIOZEN LLC", "abc" and "Adifice Technologies"
//    3  real external people who asked us for something
//
// The spam gate was not at fault. It caught all twenty, replied to none, escalated none — exactly
// as designed. The fault was downstream: a COUNT(*) over the table it writes to, presented as
// demand. The gate's whole value is that it separates noise from buyers, and a count that ignores
// its verdict throws that away and then reports the noise as a result.
//
// ── WHY THIS LIVES IN ITS OWN MODULE ─────────────────────────────────────────
//
// Because the rule has to be identical in every place that counts, and it has to be executable by
// a test. A predicate pasted into three reports drifts, and the drift shows up as three different
// answers to "how many buyers do we have" with no way to tell which is right. One exported string,
// imported by the reports and run against a real Postgres by check-demand-count-sql.js.
//
// ── WHY THE EXCLUDED ROWS ARE RETURNED, NOT DROPPED ──────────────────────────
//
// A filter nobody can see is how the next wrong number gets believed. Every caller therefore gets
// the spam count and the internal count beside the real one, so the headline can be narrow and
// still auditable in the same glance.
'use strict';

// Addresses and company names that are ours. Kept deliberately literal: a clever heuristic here
// would eventually exclude a real customer whose company happens to match, and silently shrinking
// the demand number is a worse failure than showing one test row.
//
// \y is a Postgres word boundary. The company test is anchored so "ABC Pharma Ltd" is excluded as
// ours (it was a test row) but a company merely containing those letters is not.
//
// ── EVERY FIELD IS COALESCED, AND THAT IS NOT TIDINESS ───────────────────────
//
// The first version of this compared the columns directly, and check-demand-count-sql.js failed on
// the row it mattered most for. Can Gundogan — the live Yttrium oxide enquiry, eight days old —
// filed no company. So `buyer_company ~* '...'` was NULL, the OR chain was NULL, `NOT (NULL)` was
// NULL, the WHERE filter rejected him, and he appeared in NO bucket: not a buyer, not spam, not
// ours. A real customer deleted from the report by three-valued logic, with nothing logged and no
// error raised — and the one person the report existed to surface.
//
// This is the same defect as every other one found this month: success and silence were
// indistinguishable. COALESCE to '' makes the predicate total, so a missing field can only ever
// make a row MORE likely to count as a buyer, never less.
const OURS_SQL = `(
     COALESCE(buyer_email, '')   ILIKE '%@abiozen.com'
  OR COALESCE(buyer_email, '')   ILIKE '%naresh.boda%'
  OR COALESCE(buyer_email, '')   ILIKE '%@adificetechnologies.com'
  OR COALESCE(buyer_company, '') ~* '^(abiozen|adifice|abc)\\y'
)`;

// A real buyer: not classified spam, not us. Nothing about age, status or value — a 67-day-old
// unanswered enquiry is still a buyer, and the point of the number is that it stays uncomfortable.
const EXTERNAL_SQL = `(COALESCE(status, '') <> 'spam' AND NOT ${OURS_SQL})`;

// One query, so the three numbers can never be computed from different snapshots of the table.
const COUNTS_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE ${EXTERNAL_SQL})::int                       AS external,
    COUNT(*) FILTER (WHERE ${EXTERNAL_SQL}
      AND created_at::text >= to_char(NOW() - INTERVAL '30 days', 'YYYY-MM-DD'))::int AS external_30d,
    COUNT(*) FILTER (WHERE status = 'spam')::int                       AS spam,
    COUNT(*) FILTER (WHERE COALESCE(status, '') <> 'spam' AND ${OURS_SQL})::int AS ours,
    COUNT(*)::int                                                      AS all_rows
  FROM inquiries`;

async function demandCounts(query) {
  const r = await query(COUNTS_SQL);
  return r.rows[0];
}

module.exports = { OURS_SQL, EXTERNAL_SQL, COUNTS_SQL, demandCounts };
