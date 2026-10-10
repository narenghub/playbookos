// ── WHICH ROWS OF A ROLE THIS RUN NO LONGER PRODUCES ──────────────────────────
//
// Every event seed needs the same question answered before it writes: of the rows already filed
// under this event and this role, which ones does the current run no longer produce? Those are
// stale — a previous run's keys — and leaving them beside the new rows is how a list silently
// doubles.
//
// This is a module because the second copy was already wrong. scripts/seed-scope-linkable.js was
// written with `jsonb_array_length(contact_cards)`, and there is no `contact_cards` column: a
// contact card is a ROW in cphi_exhibitor_contacts, joined by exhibitor_match_id. It parsed, it
// passed node --check, and it would have thrown on the first --execute against production — the
// same failure class as `CASE types text and timestamp cannot be matched`, which also passed every
// local check and failed live in front of a blocked partner.
//
// TWO RULES THIS ENCODES.
//
// 1. SCOPED TO ONE ROLE, ALWAYS. Never a role-wide or event-wide sweep. The delegate seed's cleanup
//    is qc_lab-only because the abiozen role holds 146 sponsor rows that a DIFFERENT script owns; a
//    wider DELETE would take out the six companies actually on the floor.
//
// 2. A ROW A HUMAN HAS TOUCHED IS NEVER STALE. met_in_person, a LinkedIn connection or a contact
//    card means somebody stood in front of that company. The key changing is a reason to re-examine
//    the row, never a reason to delete the only record of a conversation.
'use strict';

/**
 * Rows filed under (event, role), each with the three human-touch signals, so the caller can
 * partition them into "safe to remove" and "keep, somebody worked this".
 *
 * Parameters are ($1 event_slug, $2 role) — role is NOT interpolated, so a role name can never
 * reach the SQL text.
 */
const STALE_ROWS_SQL = `
  SELECT x.id, x.holder, x.holder_normalized, x.met_in_person, x.linkedin_connected,
         COUNT(c.id)::int AS cards
    FROM cphi_exhibitor_matches x
    LEFT JOIN cphi_exhibitor_contacts c ON c.exhibitor_match_id = x.id
   WHERE x.event_slug = $1 AND x.role = $2
   GROUP BY x.id
   ORDER BY x.holder`;

/** True when nobody has touched this row, so removing it loses nothing. */
const isUntouched = (r) => !r.met_in_person && !r.linkedin_connected && !r.cards;

/**
 * Splits the rows of (event, role) into stale-and-removable, stale-but-worked, and reports the
 * total, given the set of keys THIS run produces.
 */
async function staleRows(query, event, role, plannedKeys) {
  const rows = (await query(STALE_ROWS_SQL, [event, role])).rows;
  const stale = rows.filter((r) => !plannedKeys.has(r.holder_normalized));
  return {
    all: rows,
    stale,
    removable: stale.filter(isUntouched),
    keepers: stale.filter((r) => !isUntouched(r)),
  };
}

module.exports = { STALE_ROWS_SQL, staleRows, isUntouched };
