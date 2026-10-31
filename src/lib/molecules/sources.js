// ── THE ONE DEFINITION OF WHAT E1 READS IDENTITY FROM ───────────────────────
//
// P1 of the Commercial Canonical Intake sequence, authorised 31 Oct 2026: a behaviour-preserving
// extraction. **Source membership is unchanged by this file's existence.** The three entries below
// are byte-for-byte the list that `backfill-molecule-identity.js`, `e1-reconcile.js` and
// `e1-retract.js` each held separately, verified identical in all three before extraction.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// On 29 Oct the migration created 2466 molecules against an authorised 2428. The cause was two
// implementations of one question: the analyser had five exclusion categories and the backfill had
// re-derived its own and had one. 38 molecules nobody authorised, and a day spent retracting them.
//
// `SOURCES` was the same defect waiting to happen in a different place. Three identical copies are
// correct right up until somebody edits one — and the next change to this list is Commercial
// Canonical Intake ADDING sources to it, which is exactly the edit that would have diverged. A
// source added to the backfill but not the reconciliation creates molecules the reconciliation
// cannot see; added to the reconciliation but not the backfill, it reports every row of a table
// nobody reads as missing. Both read as a reconciliation problem and neither is.
//
// So: one definition, four consumers, and a check that fails if a fourth copy appears.
//
// ── WHAT A SOURCE IS ────────────────────────────────────────────────────────
//
//   table    the relation to read
//   idCol    its primary key, used to scope every write by row id — never by timestamp, never by
//            pattern, never by "recent"
//   nameCol  the column holding the filed molecule name. NOT normalised here; normalisation is
//            `moleculeKey()`'s job and there is exactly one of those too.
//   casCol   the column holding the filed CAS. A CAS is an identifier, never an identity key: it
//            can VETO a name match whose registry number contradicts the canonical one, and it can
//            never make one. 212 identities in this database already hold a contested CAS, and
//            matching on a shared one priced a correctly-named molecule 2.4x out on 31 Oct.
//   where    an optional SQL predicate restricting which rows of the table are identity evidence.
//            `research_interests` holds several kinds of row and only `kind = 'molecule'` is one.
//
// ── WHAT THIS FILE IS NOT ───────────────────────────────────────────────────
//
// Not a second identity authority. It says WHERE candidate evidence comes from. Whether a candidate
// may become a canonical molecule is decided by the existing analyser, its exclusions, its
// quarantine categories and Decision 1 — none of which live here and none of which this file may
// influence.
'use strict';

const SOURCES = [
  { table: 'study_molecules', idCol: 'id', nameCol: 'molecule_name', casCol: 'cas_number', where: null },
  { table: 'research_interests', idCol: 'id', nameCol: 'value', casCol: 'cas', where: `kind = 'molecule'` },
  { table: 'supplier_products', idCol: 'id', nameCol: 'product_name', casCol: 'cas', where: null },
];

// Deliberately NOT frozen.
//
// The mutation control in check-sources-centralized.js proves the centralisation is load-bearing by
// removing a source from this array at runtime and asserting every consumer observes the removal.
// Freezing the array would make that control impossible to write, and a centralisation nobody can
// demonstrate is load-bearing is a centralisation that has only moved the duplication somewhere
// less visible.
//
// Consumers must therefore treat this as read-only by discipline. The check asserts no consumer
// mutates it during a normal run.
module.exports = { SOURCES };
