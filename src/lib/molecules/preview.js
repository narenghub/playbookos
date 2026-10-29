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
const BLOCKERS = ['QUARANTINE_IDENTITY_CONFLICT', 'INSUFFICIENT_IDENTITY'];
const WARNINGS = ['REVIEW_SHARED_CAS', 'INVALID_CAS_EVIDENCE'];

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
    if (trunc && out.truncatedNames.length < 100) {
      out.truncatedNames.push({ filed: String(r.name).trim(), why: trunc, table: r.table, rid: r.rid });
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

  // ── PASS D: the per-molecule decision ────────────────────────────────────
  for (const [key, g] of out.e1.groups) {
    const flags = [];
    if (g.unresolvable) flags.push('INSUFFICIENT_IDENTITY');
    else {
      if (g.cas.size > 1) flags.push('QUARANTINE_IDENTITY_CONFLICT');
      if (sharedCasIdentities.has(key)) flags.push('REVIEW_SHARED_CAS');
      if (g.invalid && g.invalid.size) flags.push('INVALID_CAS_EVIDENCE');
    }
    const blocked = flags.some((f) => BLOCKERS.includes(f));
    if (!blocked) flags.unshift('SAFE_TO_CREATE');
    out.classification.set(key, flags);
  }

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
  };

  return out;
}

module.exports = {
  analyze, BLOCKERS, WARNINGS, descriptorVariantOf, chemicalCore, looksTruncated, NON_CHEMICAL_WORDS,
};
