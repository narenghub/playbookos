// ── LEGACY GROUPING vs E1 GROUPING, SIDE BY SIDE ─────────────────────────────
//
// Pure. No database, no network, no writes. Takes rows and returns an analysis, so the logic that
// produces the migration decision can be unit-tested without a server — and so the numbers in the
// report are reproducible from a fixture rather than only observable against production once.
//
// ── THE QUESTION IT ANSWERS ─────────────────────────────────────────────────
//
// The census counted conflicts with `canonicalMolecule()`, which de-salts before folding to a
// synonym group. It found 102 conflicting groups. Most of those are not conflicts under the
// approved E1 semantics: `leuprolide` (CAS 53714-56-0) and `leuprolide acetate` (74381-53-6) are
// two substances, each keeping its own registry number, and only the legacy canonicalizer made
// them one row with two CAS numbers.
//
// So the number that matters is not 102. It is: how many conflicts SURVIVE when identity stops
// stripping the form. This computes that, and makes every disappearance inspectable — a conflict
// is only counted as eliminated when the E1 grouping itself explains it deterministically, by
// splitting the group into identities that each carry at most one valid CAS.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
//
// It decides nothing. A shared CAS is evidence requiring classification, never merge permission:
// two identities carrying one registry number might be a synonym the curated table does not know,
// or a misattribution, and the difference is a human judgement about chemistry. The analyser
// reports which of the two the existing curated relationships would explain, and marks the rest
// REVIEW_REQUIRED.
'use strict';

const { validCas } = require('../catalogue/cas');
const { canonicalMolecule, normalize } = require('./synonyms');
const {
  identityOf, aliasForms, describeNormalization,
  GRADE_WORDS, DESCRIPTOR_QUALIFIERS, DESCRIPTOR_PHRASES,
} = require('./identity');

// ── DETECTION-ONLY VOCABULARY. NOTHING IS STRIPPED WITH THIS. ───────────────
//
// Used to answer one question about two identities that share a CAS: does one differ from the
// other only by trailing words that carry no chemical meaning? If so the normalization MISSED a
// descriptor pattern, and saying so is more useful than filing it as a human conflict.
//
// It is deliberately wider than the stripping lists in identity.js, and deliberately separate from
// them. Widening what gets REPORTED is free; widening what gets REMOVED changes identity, and a
// detection set quietly promoted into a stripping set is how `free acid` would end up collapsed.
const NON_CHEMICAL_WORDS = new Set([
  ...GRADE_WORDS, ...DESCRIPTOR_QUALIFIERS, ...DESCRIPTOR_PHRASES.flat(),
  'standard', 'reference', 'grade', 'purity', 'pure', 'assay', 'qualified', 'certified',
]);

// ── THE CHEMICAL CORE ───────────────────────────────────────────────────────
//
// Every non-chemical word removed, from anywhere in the name rather than only the end. Two
// identities whose cores are EQUAL differ by labelling alone; two whose cores differ are two
// different things however similar they look.
//
// This replaced a pairwise `some()` test, and the replacement is the point. With `some()`, one
// benign pair in a group labelled the WHOLE group DESCRIPTOR_VARIANT — and on the 29 Oct corrected
// run that hid three real findings behind the label I had described as "not human work":
//
//   CAS 606143-89-9  selumetinib | binimetinib | selumetinib free base
//                    two DIFFERENT MEK inhibitors sharing selumetinib's number
//   CAS 90357-06-5   bicalutamide | hydroxybicalutamide        a metabolite, not a grade
//   CAS 1972-08-3    dronabinol | delta-9-tetrahydrocannabinol  真 synonym, still masked
//
// A benign classification must never be able to conceal a dangerous one, so the rule is now: every
// identity in the group must share one core, or the group is review work. It errs toward review,
// which is the direction that costs nothing.
function chemicalCore(identity) {
  return String(identity || '')
    .split(' ')
    .filter((w) => w && !NON_CHEMICAL_WORDS.has(w))
    .join(' ');
}

/** Do these two identities differ only by trailing non-chemical words? */
function descriptorVariantOf(a, b) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short === long) return false;
  const st = short.split(' ');
  const lt = long.split(' ');
  if (lt.length <= st.length) return false;
  for (let i = 0; i < st.length; i += 1) if (st[i] !== lt[i]) return false;
  // Every remaining word must be non-chemical. One chemical word in the tail and this is a
  // different substance, not a different label.
  return lt.slice(st.length).every((w) => NON_CHEMICAL_WORDS.has(w));
}

// An unbalanced bracket means the source name was cut. `pyrimidin-5-yl ethyl]benzoyl]-l-glutamic
// acid` is a fragment of pemetrexed's IUPAC name with its opening brackets missing. That is an
// UPSTREAM ingest defect: it is recorded here and deliberately not repaired by normalization,
// because guessing the missing half of a chemical name is exactly the kind of plausible invention
// this project refuses.
function looksTruncated(name) {
  const s = String(name == null ? '' : name);
  const counts = (ch) => (s.match(new RegExp(`\\${ch}`, 'g')) || []).length;
  if (counts('[') !== counts(']')) return 'unbalanced square brackets';
  if (counts('(') !== counts(')')) return 'unbalanced parentheses';
  if (/^[\])}]/.test(s.trim())) return 'begins with a closing bracket';
  if (/^-|^,/.test(s.trim())) return 'begins with a separator';
  return null;
}

// ── DECISION CATEGORIES ─────────────────────────────────────────────────────
//
// Blocking vs advisory, stated rather than implied. A molecule is SAFE_TO_CREATE when no BLOCKER
// applies; warnings coexist with it, because a shared CAS is a reason to review an attribution and
// not a reason to refuse a substance that is otherwise well evidenced. Reality is not mutually
// exclusive, so a group can carry several warnings at once.
// ── WHY QUARANTINE_CORRUPTED_NAME AND AMBIGUOUS_FORM BLOCK ──────────────────
//
// Both were advisory in the previous version and both should not have been.
//
// A corrupted name — `pyrimidin-5-yl ethyl]benzoyl]-l-glutamic acid`, a fragment of pemetrexed's
// IUPAC name with its opening brackets gone — would otherwise be CREATED as a canonical molecule,
// and once it is a row with an id, something downstream will quote from it. Worse, it shares a CAS
// with the real substance, so the very fact that makes it look resolvable is the fact that makes
// it dangerous. A name nobody can read is not an identity.
//
// An AMBIGUOUS free-base case is an unresolved identity by definition. Creating it means possibly
// creating a second row for a substance already present, and duplicates are undone by MERGING —
// the direction that cost 478 identities in this phase and printed a false scarcity claim in
// October. Excluding it is reversible: it can be created the moment someone rules on it.
// ── AND WHY SAME_NEUTRAL_SUBSTANCE BLOCKS TOO ───────────────────────────────
//
// The 29 Oct E1.1 run classified 7 identities as SAME_NEUTRAL_SUBSTANCE and then listed every one
// of them as SAFE_TO_CREATE — `cabozantinib free base` alongside `cabozantinib`, both on CAS
// 849217-68-1. The census concluded they are one substance and the execution set proposed creating
// two rows for it. That is a KNOWN duplicate, not a suspected one, and it is the exact thing the
// 478 avoided duplicates were about.
//
// The instruction was not to merge anything automatically, and this does not: it withholds the
// second row and records why. Creating it later as an alias of its parent is a one-line ruling;
// un-creating a duplicate afterwards is a merge.
const BLOCKERS = [
  'QUARANTINE_IDENTITY_CONFLICT', 'QUARANTINE_CORRUPTED_NAME',
  'AMBIGUOUS_FORM', 'DUPLICATE_RISK', 'INSUFFICIENT_IDENTITY',
];

// ── BARE FUNCTIONAL-GROUP WORDS ARE NOT SUBSTANCES ──────────────────────────
//
// `amine` reached the 29 Oct execution set as a proposed molecule, carrying two CAS numbers. It is
// a fragment of a longer IUPAC name whose brackets happened to balance, so the truncation detector
// missed it — it was excluded only because its CAS values disagreed. Had they agreed it would have
// been CREATED, as a molecule called "amine".
//
// Deliberately narrow: only words that are never themselves a specific substance. `urea` and
// `benzamide` are NOT here, because both are real compounds — a blocklist that swallows real
// substances to catch fragments is the wrong trade.
const GENERIC_FRAGMENT_NAMES = new Set([
  'amine', 'amide', 'carboxamide', 'carboxylic acid', 'ester', 'ether', 'ketone', 'aldehyde',
  'derivative', 'analog', 'analogue', 'isomer', 'enantiomer', 'salt', 'impurity', 'metabolite',
]);

// ── THE HEURISTIC THAT WAS 94% NOISE, AND WHAT REPLACED IT ──────────────────
//
// The first version flagged "a locant digit plus a class suffix" as a suspected fragment. On the
// 29 Oct run it returned 17 names of which SIXTEEN were real substances —
// `4-hydroxycyclophosphamide`, `6-gingerol`, `25-hydroxycholesterol`,
// `n1-acetyltriethylenetetramine` and so on. It blocked nothing, being review-only, but a report
// that is 94% false positives is the 168-false-alerts-a-week pattern this repo has already paid
// for: the fix for a detector nobody trusts is a quieter detector, not a louder one.
//
// The real signal was never the locant. It is that the name's CORE is a bare class term with
// nothing but a position marker in front of it. So: strip leading locants and stereo descriptors,
// then ask whether what remains is a word that is never itself a substance.
//
//   e-2-carboxylic acid      -> carboxylic acid     bare class term    FRAGMENT
//   d-2-aminobutyric acid    -> aminobutyric acid   a real substance   kept
//   4-hydroxypropranolol     -> hydroxypropranolol  a real substance   kept
//   25-hydroxycholesterol    -> hydroxycholesterol  a real substance   kept
//
// One true positive on the real data, no false ones. `e-` is a legitimate E/Z stereo descriptor,
// which is why the prefix alone could never have been the test.
const LEADING_LOCANT_RE = /^(?:[dlrsez]|[a-z]{1,2})?-?\d+[a-z]?-/;

function fragmentCore(identity) {
  const s = String(identity || '');
  const stripped = s.replace(LEADING_LOCANT_RE, '').trim();
  return stripped || s;
}
const WARNINGS = ['REVIEW_SHARED_CAS', 'INVALID_CAS_EVIDENCE'];

// Form phrases that name the neutral substance. Deliberately NOT in identity.js's stripping rules:
// they are classified here, case by case, against evidence — never collapsed by a global rule.
const NEUTRAL_FORM_PHRASES = ['free base', 'free acid'];

// Isotopic and stereochemical markers. Detection only, used to say whether a name carries a
// distinction that normalization must never erase.
const ISOTOPE_RE = /(\b|-)(d\d+|1[0-9][a-z]|[0-9]{1,3}[a-z]-(?:enriched|labell?ed)|deuterated|tritiated|\[\s*\d+[a-z]+\s*\]|enriched)(\b|-)/i;
const STEREO_RE = /\(\s*[-+±]\s*\)|\b(?:trans|cis|rac|racemic|[rs])\b|\(\d+[ar]|δ\d|delta-\d|\b\d+[ar],/i;

/**
 * @param rows [{ table, rid, name, cas }]
 * @returns the full analysis
 */
function analyze(rows) {
  const out = {
    measured: {
      sourceRows: rows.length,
      rowsByTable: {},
      casMissing: 0,
      casPresentValid: 0,
      casPresentInvalid: 0,
    },
    legacy: { groups: new Map() },
    e1: { groups: new Map() },
    invalidCas: { occurrences: [], distinct: new Set() },
    sharedCas: [],
    eliminated: [],
    surviving: [],
    classification: new Map(),
    // Deterministic normalization evidence: which filed names were changed by descriptor
    // stripping, and what was removed. This is how "how much disappears through normalization"
    // is answered with a list rather than a claim.
    descriptorNormalized: [],
    descriptorRemovedCounts: {},
    truncatedNames: [],
    synonymCandidates: [],
    // ── E1.1 edge-case census ────
    freeForm: [],          // free base / free acid, classified against evidence
    thcCluster: [],        // the dronabinol / delta-9-THC records, as evidence
    corruptedIdentities: new Map(),  // identity -> why
    executionSet: null,
  };

  // ── PASS A: the two groupings, built from the same rows in one walk ───────
  for (const r of rows) {
    out.measured.rowsByTable[r.table] = (out.measured.rowsByTable[r.table] || 0) + 1;

    const rec = identityOf(r.name);
    const legacyKey = canonicalMolecule(r.name) || normalize(r.name);
    const e1Key = rec.identity;

    // Normalization evidence, per row, before anything is grouped.
    const norm = describeNormalization(r.name);
    if (norm.changed) {
      if (out.descriptorNormalized.length < 400) {
        out.descriptorNormalized.push({
          filed: String(r.name).trim(), identity: norm.identity,
          removed: norm.removed, table: r.table, rid: r.rid,
        });
      }
      norm.removed.forEach((w) => {
        out.descriptorRemovedCounts[w] = (out.descriptorRemovedCounts[w] || 0) + 1;
      });
    }
    const trunc = looksTruncated(r.name);
    if (trunc) {
      if (out.truncatedNames.length < 100) {
        out.truncatedNames.push({ filed: String(r.name).trim(), why: trunc, table: r.table, rid: r.rid });
      }
      // The identity this corrupted name would become must be excluded from creation. Recorded
      // against the identity, not the row, because the identity is what would be created.
      if (e1Key) out.corruptedIdentities.set(e1Key, trunc);
    }

    // CAS evidence state. "missing" and "present but invalid" are materially different: the first
    // is an absence, the second is a source asserting something that cannot be true, and only the
    // second is a data-quality defect worth anyone's time.
    const raw = r.cas == null ? '' : String(r.cas).trim();
    let casOk = null;
    if (!raw) out.measured.casMissing += 1;
    else if (validCas(raw)) { casOk = raw; out.measured.casPresentValid += 1; }
    else {
      out.measured.casPresentInvalid += 1;
      out.invalidCas.distinct.add(raw);
      out.invalidCas.occurrences.push({ cas: raw, table: r.table, rid: r.rid, name: r.name, e1: e1Key });
    }

    if (legacyKey) {
      const g = out.legacy.groups.get(legacyKey)
        || { names: new Set(), cas: new Set(), rows: 0 };
      g.names.add(normalize(r.name)); g.rows += 1;
      if (casOk) g.cas.add(casOk);
      out.legacy.groups.set(legacyKey, g);
    }

    if (!e1Key || e1Key.length < 3) {
      const g = out.e1.groups.get('__unresolvable__')
        || { names: new Set(), cas: new Set(), rows: 0, refs: [], form: null, base: null, unresolvable: true };
      g.names.add(String(r.name || '')); g.rows += 1;
      g.refs.push(`${r.table}#${r.rid}`);
      out.e1.groups.set('__unresolvable__', g);
      continue;
    }

    const g = out.e1.groups.get(e1Key)
      || { names: new Set(), cas: new Set(), invalid: new Set(), rows: 0, refs: [],
        form: rec.form, base: rec.derivedBase, formTokens: rec.formTokens, reason: rec.reason };
    g.names.add(String(r.name).trim()); g.rows += 1;
    if (g.refs.length < 25) g.refs.push(`${r.table}#${r.rid}`);
    if (casOk) g.cas.add(casOk);
    if (!casOk && raw) g.invalid.add(raw);
    out.e1.groups.set(e1Key, g);
  }

  // ── PASS B: which legacy conflicts survive, and WHY the others do not ─────
  //
  // A legacy conflict is eliminated only when the E1 grouping accounts for it: the legacy group
  // splits into two or more E1 identities, and every one of them carries at most one valid CAS.
  // If any resulting identity still holds two, the conflict did not disappear — it moved, and it
  // is reported as surviving. A legacy group that does not split at all (one filed name, several
  // CAS numbers) was never a form artefact and cannot be eliminated by this change.
  for (const [legacyKey, lg] of out.legacy.groups) {
    if (lg.cas.size <= 1) continue;                       // not a legacy conflict

    const members = [...lg.names].map((n) => identityOf(n).identity).filter(Boolean);
    const e1Keys = [...new Set(members)];
    const parts = e1Keys.map((k) => {
      const g = out.e1.groups.get(k);
      return { identity: k, cas: g ? [...g.cas] : [], form: g ? g.form : null, base: g ? g.base : null };
    });
    const worst = Math.max(0, ...parts.map((p) => p.cas.length));

    if (e1Keys.length > 1 && worst <= 1) {
      out.eliminated.push({
        legacy: legacyKey,
        legacyCas: [...lg.cas],
        filedAs: [...lg.names],
        // The deterministic explanation, not a narrative: the legacy key stripped these form
        // tokens, E1 kept these identities, and each one now carries at most one CAS.
        splitInto: parts,
        reason: `legacy canonicalizer folded ${e1Keys.length} distinct substances together by `
          + `stripping form tokens; E1 keeps them apart and each carries <= 1 valid CAS`,
      });
    } else {
      out.surviving.push({
        legacy: legacyKey,
        legacyCas: [...lg.cas],
        filedAs: [...lg.names],
        splitInto: parts,
        reason: e1Keys.length === 1
          ? 'a single filed name carries several valid CAS numbers — not a form artefact'
          : 'the group splits, but at least one resulting identity still holds two valid CAS numbers',
      });
    }
  }

  // ── PASS C: one CAS, more than one E1 identity ───────────────────────────
  const byCas = new Map();
  for (const [key, g] of out.e1.groups) {
    if (g.unresolvable) continue;
    for (const c of g.cas) {
      const s = byCas.get(c) || new Set();
      s.add(key); byCas.set(c, s);
    }
  }
  for (const [cas, keys] of byCas) {
    if (keys.size < 2) continue;
    const ids = [...keys];

    // Does an EXISTING curated relationship explain it? Two possibilities, both checkable without
    // chemistry knowledge: the names are in one curated synonym group, or they are forms of one
    // base. Anything else is REVIEW_REQUIRED — and neither explanation is permission to merge.
    // ── THE SPLIT. One overloaded flag was hiding two different phenomena. ──
    //
    // DESCRIPTOR_VARIANT          a normalization gap: the names differ only by words with no
    //                             chemical meaning. Evidence to fix the rules, not a conflict for
    //                             a human to adjudicate.
    // DISTINCT_NAMES_SHARED_CAS   genuinely different names still holding one registry number
    //                             after descriptor normalization and curated synonym resolution.
    //                             REVIEW_REQUIRED, and this is where
    //                             `mirvetuximab soravtansine | durvalumab` has to stay visible.
    //
    // CAS equality NEVER implies synonymy. Both labels leave the molecules separate.
    let kind = 'DISTINCT_NAMES_SHARED_CAS';
    let explanation = 'REVIEW_REQUIRED';

    const aliasLinked = ids.some((a) => ids.some((b) => a !== b && aliasForms(a).aliases.includes(b)));
    const bases = ids.map((k) => {
      const g = out.e1.groups.get(k);
      return (g && g.base) || k;
    });
    const sameBase = new Set(bases).size === 1;
    // ALL identities must share one chemical core. Not "some pair matches" — see chemicalCore.
    const cores = new Set(ids.map(chemicalCore));
    const allOneCore = cores.size === 1;

    if (allOneCore) { kind = 'DESCRIPTOR_VARIANT'; explanation = 'normalization_gap_descriptor_only'; }
    else if (aliasLinked && ids.length === 2) { kind = 'EXPLAINED'; explanation = 'explained_curated_synonym'; }
    else if (sameBase) { kind = 'EXPLAINED'; explanation = 'explained_form_relationship'; }

    const entry = {
      cas,
      kind,
      identities: ids,
      sourceNames: [...new Set(ids.flatMap((k) => [...(out.e1.groups.get(k).names || [])]))],
      refs: ids.flatMap((k) => (out.e1.groups.get(k).refs || []).slice(0, 6)),
      explanation,
    };
    out.sharedCas.push(entry);

    // A candidate is REPORTED for review and never acted on. Bulk-creating synonym rows from a
    // shared CAS is precisely what the durvalumab case forbids.
    if (kind === 'DISTINCT_NAMES_SHARED_CAS') {
      out.synonymCandidates.push({
        cas, identities: ids, note: 'possible synonym OR source misattribution — human decides',
      });
    }
  }
  const sharedCasIdentities = new Set(
    out.sharedCas.filter((s) => s.kind === 'DISTINCT_NAMES_SHARED_CAS').flatMap((s) => s.identities));

  // ── PASS C2: FREE BASE / FREE ACID, CLASSIFIED AGAINST EVIDENCE ──────────
  //
  // No global stripping rule, and none derived from frequency. Each case is decided on what the
  // source actually says, and where the source says too little the answer is AMBIGUOUS rather
  // than a guess in either direction.
  //
  // THERE IS NO STRUCTURAL EVIDENCE AVAILABLE. No InChIKey, SMILES or molfile exists anywhere in
  // this database — section 1 of the preview proves it against the live schema. So every
  // classification below rests on names and registry numbers alone, and that limit is stated on
  // every row rather than left for a reader to discover.
  for (const [key, g] of out.e1.groups) {
    if (g.unresolvable) continue;
    const phrase = NEUTRAL_FORM_PHRASES.find((p) => key.endsWith(` ${p}`));
    if (!phrase) continue;

    const parent = key.slice(0, -(phrase.length + 1)).trim();
    const parentGroup = out.e1.groups.get(parent);
    const myCas = [...g.cas];
    const parentCas = parentGroup ? [...parentGroup.cas] : [];

    // Does a salt or ester of the same parent exist? Context for a human, not a decision input:
    // the presence of `ketamine hydrochloride` says the catalogue distinguishes forms, which makes
    // `free base` more likely to be meaningful — but "more likely" is not evidence.
    const saltCounterparts = [...out.e1.groups.entries()]
      .filter(([k, v]) => !v.unresolvable && v.base === parent && v.form !== 'base' && k !== key)
      .map(([k, v]) => `${k} (${v.form})`);

    const sharedWith = out.sharedCas
      .filter((s) => s.identities.includes(key))
      .flatMap((s) => s.identities.filter((i) => i !== key));

    let disposition; let reason;
    if (!parentGroup) {
      disposition = 'AMBIGUOUS';
      reason = `the neutral parent "${parent}" does not exist as its own identity in this data — `
        + 'nothing to be the same substance AS';
    } else if (myCas.length === 1 && parentCas.length === 1 && myCas[0] === parentCas[0]) {
      // The strongest evidence available without structures: the names differ only by a phrase
      // that NAMES THE NEUTRAL FORM, and the source gives both the SAME registry number. That
      // conjunction is much stronger than a shared CAS alone — which, on its own, also links
      // selumetinib to binimetinib and must never imply synonymy.
      disposition = 'SAME_NEUTRAL_SUBSTANCE';
      reason = `identical single valid CAS ${myCas[0]} on both, and the names differ only by `
        + `"${phrase}", which names the neutral form`;
    } else if (myCas.length === 1 && parentCas.length === 1) {
      disposition = 'DISTINCT_FORM';
      reason = `the registry disagrees: ${myCas[0]} here vs ${parentCas[0]} on "${parent}"`;
    } else {
      disposition = 'AMBIGUOUS';
      reason = `insufficient registry evidence (this: ${myCas.join(' | ') || 'no valid CAS'}; `
        + `parent: ${parentCas.join(' | ') || 'no valid CAS'})`;
    }

    out.freeForm.push({
      identity: key,
      phrase,
      sourceNames: [...g.names],
      cas: myCas,
      parent,
      parentExists: !!parentGroup,
      parentCas,
      saltCounterparts,
      sharedCasWith: [...new Set(sharedWith)],
      refs: g.refs.slice(0, 10),
      structuralEvidence: 'NONE — no InChIKey, SMILES or molfile exists in this database',
      disposition,
      reason,
    });
  }
  const ambiguousForm = new Set(
    out.freeForm.filter((f) => f.disposition === 'AMBIGUOUS').map((f) => f.identity));
  // Positively evidenced duplicates: the census says this IS the parent substance.
  const duplicateRisk = new Map(
    out.freeForm.filter((f) => f.disposition === 'SAME_NEUTRAL_SUBSTANCE')
      .map((f) => [f.identity, f.parent]));

  // ── PASS C3: THE DRONABINOL / DELTA-9-THC CLUSTER, AS EVIDENCE ───────────
  //
  // Gathered, not adjudicated. Whether a generic THC name is standing in for a specific
  // stereoisomer is a chemistry judgement about source intent, and the script's job is to put the
  // exact records in front of someone who can make it — with the stereochemical and isotopic
  // markers each name does or does not carry made explicit.
  for (const [key, g] of out.e1.groups) {
    if (g.unresolvable) continue;
    if (!/dronabinol|tetrahydrocannabinol|\bthc\b/i.test(key)) continue;
    out.thcCluster.push({
      identity: key,
      sourceNames: [...g.names],
      cas: [...g.cas],
      invalidCas: [...(g.invalid || [])],
      rows: g.rows,
      refs: g.refs.slice(0, 10),
      hasStereoMarker: [...g.names].some((n) => STEREO_RE.test(n)),
      hasIsotopeMarker: [...g.names].some((n) => ISOTOPE_RE.test(n)),
      form: g.form,
    });
  }

  // ── PASS D: the per-molecule decision ────────────────────────────────────
  // Every exclusion carries a machine-readable reason keyed by identity, so "why was this not
  // created" is answerable from data rather than by re-deriving the logic.
  out.exclusionReasons = new Map();
  for (const [key, g] of out.e1.groups) {
    const flags = [];
    const reasons = [];
    if (g.unresolvable) {
      flags.push('INSUFFICIENT_IDENTITY');
      reasons.push('insufficient_identity:name_unusable');
    } else {
      if (g.cas.size > 1) {
        flags.push('QUARANTINE_IDENTITY_CONFLICT');
        reasons.push(`cas_disagreement:${[...g.cas].join(',')}`);
      }
      if (out.corruptedIdentities.has(key)) {
        flags.push('QUARANTINE_CORRUPTED_NAME');
        reasons.push(`corrupted_name:${out.corruptedIdentities.get(key)}`);
      }
      if (ambiguousForm.has(key)) {
        flags.push('AMBIGUOUS_FORM');
        const f = out.freeForm.find((x) => x.identity === key);
        reasons.push(`ambiguous_form:${f ? f.phrase.replace(' ', '_') : 'unknown'}`);
      }
      if (duplicateRisk.has(key)) {
        flags.push('DUPLICATE_RISK');
        reasons.push(`duplicate_risk:same_neutral_substance_as:${duplicateRisk.get(key)}`);
      }
      // The bare name, or the name once a leading locant/stereo marker is removed.
      const core = fragmentCore(key);
      if (GENERIC_FRAGMENT_NAMES.has(key) || GENERIC_FRAGMENT_NAMES.has(core)) {
        flags.push('INSUFFICIENT_IDENTITY');
        reasons.push(`insufficient_identity:generic_fragment_not_a_substance:${core}`);
      }
      if (sharedCasIdentities.has(key)) flags.push('REVIEW_SHARED_CAS');
      if (g.invalid && g.invalid.size) flags.push('INVALID_CAS_EVIDENCE');
    }
    const blocked = flags.some((f) => BLOCKERS.includes(f));
    if (!blocked) flags.unshift('SAFE_TO_CREATE');
    else out.exclusionReasons.set(key, reasons.join('; '));
    out.classification.set(key, flags);
  }

  // ── THE PROPOSED EXECUTION SET ───────────────────────────────────────────
  const inFlag = (f) => [...out.classification.entries()]
    .filter(([, flags]) => flags.includes(f)).map(([k]) => k);
  out.executionSet = {
    CREATE: inFlag('SAFE_TO_CREATE'),
    QUARANTINE_IDENTITY_CONFLICT: inFlag('QUARANTINE_IDENTITY_CONFLICT'),
    QUARANTINE_CORRUPTED_NAME: inFlag('QUARANTINE_CORRUPTED_NAME'),
    AMBIGUOUS_FORM: inFlag('AMBIGUOUS_FORM'),
    DUPLICATE_RISK: inFlag('DUPLICATE_RISK'),
    INSUFFICIENT_IDENTITY: inFlag('INSUFFICIENT_IDENTITY'),
    REVIEW_SHARED_CAS: inFlag('REVIEW_SHARED_CAS'),
    INVALID_CAS_EVIDENCE: inFlag('INVALID_CAS_EVIDENCE'),
  };
  // Nothing left to report here: the only fragments the data contains are now caught
  // deterministically, as INSUFFICIENT_IDENTITY, with the stripped core named in the reason.
  out.fragmentSuspects = [];
  // The assertion that matters: nothing excluded is unexplained, and nothing is both.
  const excluded = [...out.classification.entries()]
    .filter(([, f]) => !f.includes('SAFE_TO_CREATE')).map(([k]) => k);
  out.exclusionIntegrity = {
    excluded: excluded.length,
    withReason: excluded.filter((k) => out.exclusionReasons.has(k)).length,
    missingReason: excluded.filter((k) => !out.exclusionReasons.has(k)),
    createdAndExcluded: out.executionSet.CREATE.filter((k) => excluded.includes(k)),
  };

  out.summary = {
    sourceRows: out.measured.sourceRows,
    legacyGroups: out.legacy.groups.size,
    e1Groups: [...out.e1.groups.keys()].filter((k) => k !== '__unresolvable__').length,
    legacyMultiName: [...out.legacy.groups.values()].filter((g) => g.names.size > 1).length,
    e1MultiName: [...out.e1.groups.values()].filter((g) => !g.unresolvable && g.names.size > 1).length,
    legacyConflicts: [...out.legacy.groups.values()].filter((g) => g.cas.size > 1).length,
    e1Conflicts: [...out.e1.groups.values()].filter((g) => !g.unresolvable && g.cas.size > 1).length,
    eliminatedBySaltForm: out.eliminated.length,
    surviving: out.surviving.length,
    sharedCas: out.sharedCas.length,
    sharedCasIdentitiesTotal: new Set(out.sharedCas.flatMap((s) => s.identities)).size,
    sharedCasDescriptorVariant: out.sharedCas.filter((s) => s.kind === 'DESCRIPTOR_VARIANT').length,
    sharedCasExplained: out.sharedCas.filter((s) => s.kind === 'EXPLAINED').length,
    sharedCasDistinctNames: out.sharedCas.filter((s) => s.kind === 'DISTINCT_NAMES_SHARED_CAS').length,
    sharedCasReviewRequired: out.sharedCas.filter((s) => s.explanation === 'REVIEW_REQUIRED').length,
    descriptorNormalizedRows: Object.values(out.descriptorRemovedCounts).reduce((a, b) => a + b, 0),
    truncatedNames: out.truncatedNames.length,
    synonymCandidates: out.synonymCandidates.length,
    invalidCasOccurrences: out.invalidCas.occurrences.length,
    invalidCasDistinct: out.invalidCas.distinct.size,
    safeToCreate: [...out.classification.values()].filter((f) => f.includes('SAFE_TO_CREATE')).length,
    quarantine: [...out.classification.values()].filter((f) => f.includes('QUARANTINE_IDENTITY_CONFLICT')).length,
    insufficient: [...out.classification.values()].filter((f) => f.includes('INSUFFICIENT_IDENTITY')).length,
    corruptedName: out.executionSet.QUARANTINE_CORRUPTED_NAME.length,
    ambiguousForm: out.executionSet.AMBIGUOUS_FORM.length,
    duplicateRisk: out.executionSet.DUPLICATE_RISK.length,
    fragmentSuspects: out.fragmentSuspects.length,
    freeFormCases: out.freeForm.length,
    freeFormSameNeutral: out.freeForm.filter((f) => f.disposition === 'SAME_NEUTRAL_SUBSTANCE').length,
    freeFormDistinct: out.freeForm.filter((f) => f.disposition === 'DISTINCT_FORM').length,
    freeFormAmbiguous: out.freeForm.filter((f) => f.disposition === 'AMBIGUOUS').length,
    thcIdentities: out.thcCluster.length,
  };

  return out;
}

module.exports = {
  analyze, BLOCKERS, WARNINGS, descriptorVariantOf, chemicalCore, looksTruncated,
  NON_CHEMICAL_WORDS, NEUTRAL_FORM_PHRASES, ISOTOPE_RE, STEREO_RE,
  GENERIC_FRAGMENT_NAMES, fragmentCore,
};
