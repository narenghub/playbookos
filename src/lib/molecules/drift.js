// ── POST-CREATION IDENTITY DRIFT ─────────────────────────────────────────────
//
// A molecule was created under the rules. Later evidence arrives that would exclude that identity
// under the current rules. This module answers two questions about that situation:
//
//   1. Is the condition machine-resolvable, or does it need a chemistry ruling?
//   2. Given the evidence now, has the condition been POSITIVELY corrected?
//
// Policy approved 31 Oct 2026: the automatic safe state is DEPRECATION, never deletion. Retraction
// requires an explicit human ruling and zero prohibited references. A newly contradictory source
// must never gain the power to delete a canonical molecule — the two producers already known to
// manufacture bad identity (truncated supplier names, requirement prose in molecule_name) would
// otherwise acquire the ability to remove real substances from the catalogue by being wrong.
//
// ── WHY QUESTION 2 EXISTS ──────────────────────────────────────────────────
//
// The first draft of this policy said: the analyser authorises the identity again, so un-deprecate.
// That is wrong, and it is the amendment that saved it.
//
// `apatinib mesylate` was deprecated because two source rows disagreed about its CAS and no row
// named the substance alone. Suppose somebody DELETES the erroneous row. The disagreement vanishes,
// the analyser authorises the identity, and under the naive rule the molecule returns — with nothing
// whatsoever having established that the identity is correct. A deletion would have resurrected it.
//
// So restoration requires POSITIVE evidence of correction, not the absence of contradiction. The
// evidence signature recorded at deprecation time is what makes that checkable: if the identity now
// resolves cleanly AND its source evidence has not merely shrunk, the condition was corrected. If
// the contradiction disappeared because the evidence did, it was not.
'use strict';

// ── WHICH CONDITIONS A MACHINE MAY REVERSE ──────────────────────────────────
//
// AUTO_REVERSIBLE: the question is about an attribute, and the data can answer it. A CAS contest
// resolves when the numbers agree or a clean row appears — no judgement about what the substance IS.
//
// HUMAN_RULING_REQUIRED: the question is about identity itself, and no arrangement of the existing
// rows answers it.
//
//   duplicate_risk        — are these two names one substance? A merge is a chemistry ruling.
//   ambiguous_form        — is "X free base" the same entity as "X"? Four such pairs took evidence
//                           per pair to prove; none was derivable from the rows.
//   corrupted_name        — "benzamide)" lost its leading portion upstream. A name that now looks
//                           balanced is a NEW claim about what the string meant, not a correction
//                           this code can verify.
//   insufficient_identity — is this a substance at all? Covers analytical requirements written into
//                           molecule_name and bare functional-group fragments.
const AUTO_REVERSIBLE = ['cas_disagreement'];
const HUMAN_RULING_REQUIRED = [
  'duplicate_risk', 'ambiguous_form', 'corrupted_name', 'insufficient_identity',
];

/** The analyser's reason string -> its leading category, e.g. `cas_disagreement:1,2` -> that. */
function categoryOf(reason) {
  const head = String(reason || '').split(':')[0].trim();
  return head || 'unknown';
}

/**
 * AUTO_REVERSIBLE or HUMAN_RULING_REQUIRED.
 *
 * An unrecognised category is HUMAN_RULING_REQUIRED, deliberately. A reason this module has not been
 * taught is a reason it cannot reason about, and defaulting to automatic reversal would mean a new
 * analyser rule silently acquired the power to resurrect molecules. The reconciliation reports the
 * unknown category so the omission is visible rather than absorbed.
 */
function reversibility(reason) {
  const cat = categoryOf(reason);
  if (AUTO_REVERSIBLE.includes(cat)) return 'AUTO_REVERSIBLE';
  if (HUMAN_RULING_REQUIRED.includes(cat)) return 'HUMAN_RULING_REQUIRED';
  return 'HUMAN_RULING_REQUIRED';
}
const isKnownCategory = (reason) => AUTO_REVERSIBLE.includes(categoryOf(reason))
  || HUMAN_RULING_REQUIRED.includes(categoryOf(reason));

// ── THE RECORDED REASON ─────────────────────────────────────────────────────
//
// Machine-readable, and it carries the EVIDENCE SIGNATURE the restoration test needs:
//
//   cas_disagreement:811803-05-1,1218779-75-9|rev=AUTO_REVERSIBLE|rows=6|at=2026-10-31T17:00:00.000Z
//
// `rows` is the count of source rows resolving to the identity when it was deprecated. Restoration
// refuses if the count has merely dropped, which is how "the erroneous row was corrected" is told
// apart from "the erroneous row was deleted".
//
// One TEXT column, parsed here. No lifecycle enum, and no second state table: the approved schema is
// two columns, and the authoritative account of WHY remains the source evidence and the quarantine
// record. This string is a checkable summary of them, not a replacement.
function buildReason(analyserReason, rowCount, at = new Date()) {
  const rev = reversibility(analyserReason);
  return `${analyserReason}|rev=${rev}|rows=${Number(rowCount) || 0}|at=${at.toISOString()}`;
}

function parseReason(stored) {
  const s = String(stored || '');
  const parts = s.split('|');
  const analyserReason = parts[0] || '';
  const get = (k) => {
    const hit = parts.find((p) => p.startsWith(`${k}=`));
    return hit ? hit.slice(k.length + 1) : null;
  };
  const rows = get('rows');
  return {
    analyserReason,
    category: categoryOf(analyserReason),
    reversibility: get('rev') || reversibility(analyserReason),
    rowsAtDeprecation: rows === null ? null : Number(rows),
    at: get('at'),
    known: isKnownCategory(analyserReason),
  };
}

// ── MAY THIS MOLECULE BE RESTORED? ──────────────────────────────────────────
//
// Called only for an identity the analyser currently AUTHORISES. Returns a decision and the reason
// for it, so a refusal is reportable rather than silent.
//
// Three gates, and all three must pass:
//
//   1. the recorded condition is AUTO_REVERSIBLE
//   2. the identity resolves cleanly now — there is positive evidence, not just absent contradiction
//   3. the source evidence has not shrunk below what it was at deprecation
//
// Gate 3 is the deletion guard. Gate 2 is what makes gate 3 meaningful: a count alone could be held
// up by rows that establish nothing.
function restorationDecision({ storedReason, authorisedNow, rowsNow, hasCleanEvidence }) {
  const parsed = parseReason(storedReason);
  if (!authorisedNow) {
    return { restore: false, why: 'the analyser does not authorise this identity', parsed };
  }
  if (parsed.reversibility !== 'AUTO_REVERSIBLE') {
    return {
      restore: false,
      why: `${parsed.category} requires a human ruling — the disappearance of contradictory `
        + 'evidence is not proof that the identity is correct',
      parsed,
    };
  }
  if (!hasCleanEvidence) {
    return {
      restore: false,
      why: 'no source row positively establishes the identity — the contest is absent rather than resolved',
      parsed,
    };
  }
  if (parsed.rowsAtDeprecation !== null && Number(rowsNow) < parsed.rowsAtDeprecation) {
    return {
      restore: false,
      why: `source evidence shrank from ${parsed.rowsAtDeprecation} row(s) to ${rowsNow} — a deleted `
        + 'row must not resurrect a molecule',
      parsed,
    };
  }
  return { restore: true, why: 'condition is machine-resolvable and positively corrected', parsed };
}

module.exports = {
  AUTO_REVERSIBLE, HUMAN_RULING_REQUIRED,
  categoryOf, reversibility, isKnownCategory,
  buildReason, parseReason, restorationDecision,
};
