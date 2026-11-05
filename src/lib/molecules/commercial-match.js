'use strict';
// ── R1: MAY THESE TWO NAMES BE TREATED AS THE SAME ORDERABLE SUBSTANCE? ───────
//
// Pure. No database, no network, no clock. The commercial counterpart to the search rule.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//
// It is NOT a second identity authority. The ruling on SKU identity said to prefer adopting the
// existing molecule identity model over introducing an independent one, so everything here
// composes `identityOf`, `moleculeKey` and `substanceForm` from ./identity and `validCas` from
// ../catalogue/cas. It adds no vocabulary, no second CAS validator and no new normalisation.
//
// It is also NOT a search function. ./synonyms de-salts on purpose — "correct for FINDING a
// supplier and wrong for ordering one" — and scripts/check-search-rule-scope.js now enforces that
// boundary. This module is what the commercial paths use instead, and it is deliberately the
// stricter of the two.
//
// ── THE CONTRACT ────────────────────────────────────────────────────────────
//
//     only `exact` is priceable. everything else fails closed and says why.
//
// There is no "probably", no confidence score and no nearest match. A buyer writing
// "Gemcitabine hydrochloride" against a catalogue row for "Gemcitabine" gets a refusal with a
// reason, not a price — the behaviour the inquiry agent already has, made explicit and reusable.
//
// Every refusal carries `reason` and `evidence`, because §6's "every determination must contain
// evidence and a reason" applies to a non-match as much as to a match: an unmatched line item has
// to arrive in a review queue as a question, not vanish as an absence.
//
// ── WHY FORM EQUALITY IS NOT ENOUGH ON ITS OWN ──────────────────────────────
//
// `moleculeKey` already keeps the form tokens in the key, so `leuprolide acetate` and `leuprolide`
// produce different keys. Form is compared as well, for two reasons: a name can reach the same key
// by a different route once the curated synonym table is involved, and the comparison is what makes
// the refusal legible — "salt vs base" is an answer a human can act on, where "different key" is
// not.

const {
  identityOf, moleculeKey, AMBIGUOUS_FORM_WORDS, SUBSTANCE_FORMS,
} = require('./identity');
const { validCas } = require('../catalogue/cas');

// ── peptide modifications, which this model cannot represent ─────────────────
//
// Peptide identity is sequence + modifications + counterion. `molecules` has a column for none of
// them. Two peptides differing only in acetylation, amidation, PEGylation or lipidation are
// different substances with different handling and different prices, and nothing in the schema can
// tell them apart.
//
// So the rule is not "guess". It is: if a modification marker is present on either side and the
// two sides do not carry the SAME markers, the answer is a refusal naming the reason — and that
// refusal says the data cannot distinguish them, which is a different statement from "they are
// different" and is the true one.
//
// TB-500 is the live case. The shipped SKU "TB-500 99%" carries CAS 77591-33-4, which is
// full-length Thymosin beta-4. TB-500 is Ac-LKKTETQ, CAS 885340-08-9. Those are not the same
// substance and no amount of name normalisation reveals it.
const MODIFICATION_MARKERS = Object.freeze([
  { re: /(^|[^a-z])ac-/i, label: 'N-terminal acetylation (Ac-)' },
  { re: /\bacetyl(ated)?\b/i, label: 'acetylation' },
  { re: /-nh2\b/i, label: 'C-terminal amidation (-NH2)' },
  { re: /\bamide\b|\bamidated\b/i, label: 'amidation' },
  { re: /\bpeg(ylated)?\b|\bpeg-?\d+\b/i, label: 'PEGylation' },
  { re: /\bpalmitoyl\b|\bmyristoyl\b|\blipidated\b/i, label: 'lipidation' },
  // An explicit residue list rather than /\bd-[a-z]{3}\b/, for two reasons. The loose pattern
  // missed `D-Ala2` — the position number is a word character, so the trailing \b never matched —
  // and it would equally have fired on any unrelated `d-xyz`. Named residues with an optional
  // position number is what the notation actually is.
  {
    re: /\bd-(?:ala|arg|asn|asp|cys|gln|glu|gly|his|ile|leu|lys|met|phe|pro|ser|thr|trp|tyr|val)\d*\b/i,
    label: 'D-amino acid substitution',
  },
  { re: /\btfa\b|\btrifluoroacetate\b/i, label: 'TFA counterion' },
  { re: /\bacetate salt\b/i, label: 'acetate counterion (stated)' },
]);

function modificationsOf(name) {
  const s = String(name == null ? '' : name);
  return MODIFICATION_MARKERS.filter((m) => m.re.test(s)).map((m) => m.label);
}

// ── verdicts ────────────────────────────────────────────────────────────────

const VERDICTS = Object.freeze([
  'exact',                  // same key, same form, no ambiguity, no CAS conflict — PRICEABLE
  'form_mismatch',          // same base substance, different form: base vs salt vs ester vs hydrate
  'form_token_mismatch',    // same base AND same form class, different form words — undecidable here
  'ambiguous_form',         // a form token that is genuinely salt-or-ester depending on the parent
  'modification_mismatch',  // peptide modifications differ, or are present on one side only
  'cas_conflict',           // both sides carry a checksum-valid CAS and they disagree
  'no_match',               // different substances
  'unknown',                // not enough information to answer — never treated as a match
]);

// Only this verdict may feed a price, a bid or a supplier order.
const PRICEABLE = Object.freeze(['exact']);

function result(verdict, reason, evidence) {
  if (!VERDICTS.includes(verdict)) throw new Error(`commercialMatch: unknown verdict "${verdict}"`);
  return Object.freeze({
    verdict,
    priceable: PRICEABLE.includes(verdict),
    reason,
    evidence: Object.freeze(evidence || {}),
  });
}

/**
 * May `a` and `b` be treated as the same orderable substance?
 *
 * @param {string} a            a filed name (ours, or the catalogue's)
 * @param {string} b            a filed name (theirs, or the requirement's)
 * @param {object} [opts]
 * @param {string} [opts.casA]  a CAS claimed for `a`
 * @param {string} [opts.casB]  a CAS claimed for `b`
 * @returns {{verdict:string, priceable:boolean, reason:string, evidence:object}}
 */
function commercialMatch(a, b, { casA = null, casB = null } = {}) {
  const idA = identityOf(a);
  const idB = identityOf(b);
  const keyA = moleculeKey(a);
  const keyB = moleculeKey(b);

  const evidence = {
    a: { filed: idA.filed, identity: idA.identity, key: keyA, form: idA.form, formTokens: idA.formTokens, derivedBase: idA.derivedBase },
    b: { filed: idB.filed, identity: idB.identity, key: keyB, form: idB.form, formTokens: idB.formTokens, derivedBase: idB.derivedBase },
  };

  // An empty or unusable name is UNKNOWN, never a match and never "no match" — "we could not tell"
  // and "they are different" are different answers and only one of them is true here.
  if (!idA.identity || !idB.identity) {
    return result('unknown', 'one or both names normalise to nothing, so no comparison was made', evidence);
  }

  // ── CAS first, because a conflict settles it regardless of the names ──────
  //
  // A checksum proves a registry number is well-formed. It does NOT prove what the number denotes,
  // so a MATCHING CAS is never promoted to proof of identity on its own — it cannot rescue a
  // form_mismatch. A DISAGREEING pair of valid numbers, however, is decisive in the safe direction.
  const vA = casA && validCas(casA) ? String(casA).trim() : null;
  const vB = casB && validCas(casB) ? String(casB).trim() : null;
  if (casA && !vA) evidence.a.casRejected = `${casA} is not a checksum-valid CAS`;
  if (casB && !vB) evidence.b.casRejected = `${casB} is not a checksum-valid CAS`;
  if (vA) evidence.a.cas = vA;
  if (vB) evidence.b.cas = vB;

  if (vA && vB && vA !== vB) {
    return result('cas_conflict',
      `both sides carry a checksum-valid CAS and they disagree (${vA} vs ${vB}); a disagreement is `
      + 'decisive, and this is refused rather than resolved by name',
      evidence);
  }

  // ── peptide modifications the model cannot represent ─────────────────────
  const modA = modificationsOf(idA.filed);
  const modB = modificationsOf(idB.filed);
  evidence.a.modifications = modA;
  evidence.b.modifications = modB;
  const sameMods = modA.length === modB.length && modA.every((m) => modB.includes(m));
  if (!sameMods) {
    const onlyA = modA.filter((m) => !modB.includes(m));
    const onlyB = modB.filter((m) => !modA.includes(m));
    return result('modification_mismatch',
      'peptide modifications differ, and the identity model has no column for sequence, '
      + 'modifications or counterion — so this cannot be resolved, only refused. '
      + `present only on "${idA.filed}": ${onlyA.join(', ') || 'none'}; `
      + `present only on "${idB.filed}": ${onlyB.join(', ') || 'none'}`,
      evidence);
  }

  // ── ambiguous form tokens ────────────────────────────────────────────────
  //
  // `acetate` and `succinate` are genuinely both a salt and an ester depending on the parent's
  // chemical class. identity.js resolves them to form 'other' rather than to a guess, and this
  // refuses rather than inheriting the guess it declined to make. It applies even when the two
  // names are otherwise identical in key and form: if we cannot say WHAT form this is, we cannot
  // say two things are the same form.
  const ambigA = idA.formTokens.filter((t) => AMBIGUOUS_FORM_WORDS.has(t));
  const ambigB = idB.formTokens.filter((t) => AMBIGUOUS_FORM_WORDS.has(t));
  if (ambigA.length || ambigB.length) {
    evidence.ambiguousTokens = [...new Set([...ambigA, ...ambigB])];
    return result('ambiguous_form',
      `the form token(s) ${evidence.ambiguousTokens.map((t) => `"${t}"`).join(', ')} are salt or `
      + 'ester depending on the parent\'s chemical class. identity.js resolves them to form "other" '
      + 'rather than guessing, and a commercial match must not inherit a guess that was declined',
      evidence);
  }

  // ── the substance ────────────────────────────────────────────────────────
  if (keyA !== keyB) {
    // Same base, different form is a far more useful refusal than "different key", because it tells
    // a human the two rows are chemically related and which direction to look.
    const baseA = idA.derivedBase || idA.identity;
    const baseB = idB.derivedBase || idB.identity;
    if (baseA && baseA === baseB) {
      if (idA.form !== idB.form) {
        return result('form_mismatch',
          `both derive from "${baseA}" but the forms differ (${idA.form} vs ${idB.form}); a base, its `
          + 'salt and its ester are different substances with different registry numbers, documentation '
          + 'and price',
          evidence);
      }
      // SAME base, SAME form class, DIFFERENT form words. `metformin hydrochloride` against
      // `metformin hcl` is one substance spelled two ways; `metformin hydrochloride` against
      // `metformin hydrobromide` is two substances. Both pairs look identical to this layer —
      // same base, both 'salt', tokens differ — because the identity model does not normalise
      // salt-token spellings and there is no curated table of them.
      //
      // Building one here would be exactly the independent identity authority the ruling said to
      // avoid, so this refuses and says what is missing. The first version of this branch reported
      // "form_mismatch … the forms differ (salt vs salt)", which was false on its face and was
      // caught by the HCl test.
      return result('form_token_mismatch',
        `both derive from "${baseA}" and both are form "${idA.form}", but the form words differ `
        + `(${idA.formTokens.join(' ') || '(none)'} vs ${idB.formTokens.join(' ') || '(none)'}). `
        + 'The identity model does not normalise salt-token spellings, so "hydrochloride" vs "hcl" '
        + '(one substance) is indistinguishable here from "hydrochloride" vs "hydrobromide" (two). '
        + 'A curated token table would resolve it and does not exist; this is refused rather than '
        + 'guessed.',
        evidence);
    }
    return result('no_match',
      `different substances: "${keyA}" and "${keyB}" share no identity key`, evidence);
  }

  // Same key. Form must still agree — see the header for why this is checked separately.
  if (idA.form !== idB.form) {
    return result('form_mismatch',
      `the identity keys agree but the forms do not (${idA.form} vs ${idB.form}); this is refused `
      + 'because form is what decides which substance is actually shipped',
      evidence);
  }

  if (!SUBSTANCE_FORMS.includes(idA.form)) {
    return result('unknown', `form "${idA.form}" is outside the known vocabulary`, evidence);
  }

  return result('exact',
    vA && vB
      ? `same identity key "${keyA}" and same form "${idA.form}"; both sides carry CAS ${vA}, which `
        + 'is consistent but is not what the match rests on'
      : `same identity key "${keyA}" and same form "${idA.form}"`,
    evidence);
}

/**
 * The gate a commercial caller should use. Returns the match, and throws nothing — refusing is a
 * result, not an error.
 *
 * `assertPriceable` is the loud form, for a path that has already decided it has a match and would
 * otherwise proceed on a wrong one.
 */
function assertPriceable(a, b, opts) {
  const m = commercialMatch(a, b, opts);
  if (!m.priceable) {
    const e = new Error(`commercial match refused (${m.verdict}): ${m.reason}`);
    e.verdict = m.verdict;
    e.evidence = m.evidence;
    throw e;
  }
  return m;
}

module.exports = {
  VERDICTS,
  PRICEABLE,
  MODIFICATION_MARKERS,
  modificationsOf,
  commercialMatch,
  assertPriceable,
};
