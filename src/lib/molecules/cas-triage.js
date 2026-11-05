'use strict';
// ── WHY DOES THIS GROUP HOLD TWO REGISTRY NUMBERS? ───────────────────────────
//
// Pure. Takes conflicting canonical groups and sorts them into classes that can be COMPUTED from
// the data, so a human rules on the ones that actually need a human.
//
// ── THE LINE THIS MODULE WILL NOT CROSS ─────────────────────────────────────
//
// It does not decide which number is right. It cannot: that is a chemistry question against an
// external registry, and the one thing worse than 113 unresolved conflicts is 113 confidently
// resolved wrong ones. Every class below is a STRUCTURAL observation about the strings and their
// distribution across groups — the kind of thing a script can be right about.
//
// Where a class suggests a likely cause, the output says "suggests" and names the evidence. The
// verdict column is always for a person.
//
// ── THE CLASSES, AND WHY EACH IS WORTH SEPARATING ───────────────────────────
//
//   form_pair          The group holds more than one filed name and they differ by a salt, ester
//                      or hydrate token. MEASURED: canonicalMolecule() de-salts, so
//                      "gemcitabine hcl" and "gemcitabine" land in ONE group and their two correct,
//                      distinct registry numbers read as a conflict. The conflict is manufactured
//                      by the de-salting; identityOf() keeps the two substances apart. Expected to
//                      be the large majority, and the least interesting: nothing is wrong with the
//                      DATA, only with using canonicalMolecule() as identity — which is exactly
//                      what the census was built to answer.
//
//   grade_duplicate    A single-name group whose name carries a GRADE phrase ("usp reference
//                      standard", "analytical reference standard") and whose CAS set is identical
//                      to another group's. MEASURED: canonicalMolecule() does not strip grade
//                      phrases, so "belzutifan reference standard" forms its own group carrying the
//                      same pair as "belzutifan". identityOf() DOES strip them, so under E1 the two
//                      collapse into one group — the conflict survives, but as one decision rather
//                      than two. Counting them separately overstates the backlog.
//
//   cross_attached     A number in this group ALSO appears in a different canonical group. Two
//                      readings fit and this module cannot separate them: an attachment is
//                      misfiled, OR the canonicaliser split one substance across groups because it
//                      lacks a synonym — which is not a data defect at all. What is established is
//                      the link, which is where a person should look.
//
//   digit_adjacent     Two checksum-valid numbers differing by a single character edit. Both pass
//                      the checksum, so validation cannot separate them, and a transcription slip
//                      that lands on another valid number is invisible to every check we have.
//                      Suggestive, never conclusive: real distinct substances occasionally hold
//                      adjacent numbers.
//
//   unexplained        A single filed name with two or more valid numbers and none of the above.
//                      No salt/base story, no duplicate, no shared number, no adjacency. These are
//                      the ones a person must rule on, and there should not be many.
//
// ── THE ORDERING RULE ───────────────────────────────────────────────────────
//
// form_pair and grade_duplicate are the two classes that answer "no action". They must never
// pre-empt a class that answers "a person must look", or a benign-looking explanation silently
// buries a real signal: the gemcitabine group is a de-salted form pair AND shares 95058-81-4 with
// a different substance, and checked form_pair-first it would have been dismissed as "nothing
// wrong" with the shared number never surfacing. So the evaluation order is
//
//     grade_duplicate → cross_attached → digit_adjacent → form_pair → unexplained
//
// grade_duplicate leads despite being a no-action verdict, for a structural reason: it IS two
// groups holding an identical CAS set, so cross_attached would otherwise swallow every one of them
// and flag each parent for sharing numbers with its own duplicate. Its condition is narrow (a
// grade phrase AND an identical set) and the sharing it explains is excluded from the
// cross-attachment test rather than from the report.

const { substanceForm, GRADE_WORDS, DESCRIPTOR_PHRASES } = require('./identity');

const CLASSES = Object.freeze([
  'form_pair', 'grade_duplicate', 'cross_attached', 'digit_adjacent', 'unexplained',
]);

// Phrases that mark a catalogue GRADE rather than a substance. Taken from identity.js where they
// exist, plus the reference-standard wordings the census output actually contains — a second,
// divergent list here would be the duplication this repo keeps paying for, so the local additions
// are only the multi-word phrases identity.js does not carry.
const GRADE_PHRASES = Object.freeze([
  'reference standard', 'usp reference standard', 'analytical reference standard',
  'usp/analytical reference standard', 'working standard', 'impurity standard',
]);

function hasGradePhrase(name) {
  const n = String(name || '').toLowerCase();
  if (GRADE_PHRASES.some((p) => n.includes(p))) return true;
  const words = n.split(/\s+/);
  try {
    if (GRADE_WORDS && words.some((w) => GRADE_WORDS.has(w))) return true;
    if (DESCRIPTOR_PHRASES && DESCRIPTOR_PHRASES.some
      && DESCRIPTOR_PHRASES.some((p) => n.includes(String(p).toLowerCase()))) return true;
  } catch (_) { /* identity.js shapes vary; the phrase list above is the floor */ }
  return false;
}

/** The name with any grade phrase removed, for comparing a standard against its parent. */
function stripGrade(name) {
  let n = String(name || '').toLowerCase().trim();
  for (const p of GRADE_PHRASES) n = n.split(p).join(' ');
  return n.replace(/\s+/g, ' ').trim();
}

/** One-character edit distance, capped — enough to answer "is this a transcription slip?". */
function withinOneEdit(a, b) {
  const x = String(a); const y = String(b);
  if (Math.abs(x.length - y.length) > 1) return false;
  if (x === y) return false;
  if (x.length === y.length) {
    let diff = 0;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) { diff++; if (diff > 1) return false; }
    return diff === 1;
  }
  const [s, l] = x.length < y.length ? [x, y] : [y, x];
  let i = 0; let j = 0; let skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true; j++;
  }
  return true;
}

/**
 * Do the filed names in this group differ only by a form token?
 * Uses substanceForm, which is the identity layer's answer — not a second one.
 */
function isFormPair(names) {
  if (!names || names.length < 2) return false;
  const bases = new Set();
  let sawForm = false;
  for (const n of names) {
    const f = substanceForm(n);
    bases.add(f.derivedBase || f.identity);
    if (f.form !== 'base') sawForm = true;
  }
  return sawForm && bases.size === 1;
}

/**
 * Classify conflicting groups.
 *
 * @param {Array} groups  [{ canonical, names: string[], cas: string[] }]
 * @returns {Array} the same groups, each with { class, evidence, needsHuman }
 */
function triage(groups) {
  // `rows` is passed through untouched when the caller supplies it — a report that prints
  // "rows: undefined" because the classifier quietly dropped the field is a report whose numbers
  // nobody can check.
  const list = (groups || []).map((g) => ({
    canonical: g.canonical,
    names: (g.names || []).slice(),
    cas: (g.cas || []).slice(),
    ...(g.rows === undefined ? {} : { rows: g.rows }),
  }));

  // Which other groups hold each number. Built once; this is the whole basis of cross_attached.
  const byCas = new Map();
  for (const g of list) {
    for (const c of g.cas) {
      if (!byCas.has(c)) byCas.set(c, []);
      byCas.get(c).push(g.canonical);
    }
  }

  // Groups keyed by their CAS set, for spotting a grade variant carrying its parent's conflict.
  const bySet = new Map();
  for (const g of list) {
    const k = g.cas.slice().sort().join('|');
    if (!bySet.has(k)) bySet.set(k, []);
    bySet.get(k).push(g);
  }

  // ── PASS 1: grade duplicates, BEFORE anything looks at shared numbers ─────
  //
  // A grade duplicate is by construction two groups holding an IDENTICAL CAS set, so if
  // cross_attached ran first it would swallow every one of them, and the parent would be flagged
  // for "sharing" numbers with its own duplicate. Resolving the grade link first, then excluding
  // it from the cross-attachment test, is what keeps both classes meaningful. The condition is
  // narrow — a grade phrase AND an identical set — so it cannot excuse a general conflict.
  const gradeTwin = new Map();   // canonical -> [canonicals it duplicates]
  for (const g of list) {
    if (!g.names.some(hasGradePhrase)) continue;
    const k = g.cas.slice().sort().join('|');
    const twins = (bySet.get(k) || []).filter((o) => o.canonical !== g.canonical);
    if (twins.length) gradeTwin.set(g.canonical, twins.map((t) => t.canonical));
  }
  /** Is the sharing between these two groups fully explained by a grade-duplicate link? */
  const explainedByGrade = (a, b) => (gradeTwin.get(a) || []).includes(b)
    || (gradeTwin.get(b) || []).includes(a);

  // ── PASS 2: classify ──────────────────────────────────────────────────────
  //
  // ORDER MATTERS, and the rule is that a verdict of "no action" must never pre-empt a verdict of
  // "a person must look". form_pair and grade_duplicate both set needsHuman=false, so they run
  // AFTER the classes that demand attention — except grade_duplicate, which must run first for the
  // structural reason above. Checked the other way round, a de-salted form pair that also shares a
  // number with an unrelated group would be dismissed as "nothing wrong" and the shared number
  // would never be seen.
  for (const g of list) {
    const evidence = [];

    // 1. grade_duplicate — a standard carrying its parent's pair.
    if (gradeTwin.has(g.canonical)) {
      const twins = gradeTwin.get(g.canonical);
      const parentish = twins.filter((t) => g.names.some((n) => stripGrade(n).includes(t)));
      g.class = 'grade_duplicate';
      g.needsHuman = false;
      evidence.push('the name carries a grade phrase, and the identical CAS set appears under: '
        + `${twins.join(', ')}`);
      if (parentish.length) evidence.push(`its parent group appears to be "${parentish[0]}"`);
      evidence.push('resolving the parent resolves this one, so counting it separately overstates '
        + 'the backlog');
      g.evidence = evidence;
      continue;
    }

    // 2. cross_attached — a number that also lives in an unrelated group.
    const shared = g.cas
      .map((c) => ({
        cas: c,
        others: (byCas.get(c) || [])
          .filter((o) => o !== g.canonical)
          .filter((o) => !explainedByGrade(g.canonical, o)),
      }))
      .filter((x) => x.others.length);
    if (shared.length) {
      g.class = 'cross_attached';
      g.needsHuman = true;
      for (const s of shared) {
        evidence.push(`${s.cas} also appears under: ${s.others.join(', ')}. Two readings fit, and `
          + 'this module cannot separate them: either one of the attachments is misfiled, or the '
          + 'canonicaliser split ONE substance into several groups because it does not know a '
          + 'synonym linking them. The second is not a data defect at all. What is established is '
          + 'that the groups are linked by a shared number, which is where a person should look.');
      }
      g.evidence = evidence;
      continue;
    }

    // 3. digit_adjacent — a transcription slip that landed on another valid number.
    const adjacent = [];
    for (let i = 0; i < g.cas.length; i++) {
      for (let j = i + 1; j < g.cas.length; j++) {
        if (withinOneEdit(g.cas[i], g.cas[j])) adjacent.push([g.cas[i], g.cas[j]]);
      }
    }
    if (adjacent.length) {
      g.class = 'digit_adjacent';
      g.needsHuman = true;
      g.evidence = adjacent.map(([a, b]) => `${a} and ${b} differ by a single character. Both pass `
        + 'the checksum, so validation cannot separate them — SUGGESTS a transcription slip, and '
        + 'does not prove one: distinct substances occasionally hold adjacent numbers.');
      continue;
    }

    // 4. form_pair — the de-salting artifact. Runs LAST of the explanations, so it can only
    //    dismiss a group that nothing above found a reason to escalate.
    if (isFormPair(g.names)) {
      g.class = 'form_pair';
      g.needsHuman = false;
      g.evidence = [`filed names differ by a form token: ${g.names.join(' | ')}. canonicalMolecule() `
        + 'de-salts, so these land in one group and their two correct, distinct registry numbers '
        + 'read as a conflict. identityOf() keeps them apart. No number is shared with an unrelated '
        + 'group and no pair is digit-adjacent, so nothing here needs a ruling.'];
      continue;
    }

    // 5. unexplained — a person must rule.
    g.class = 'unexplained';
    g.needsHuman = true;
    g.evidence = [
      g.names.length === 1
        ? `one filed name ("${g.names[0]}") carrying ${g.cas.length} checksum-valid numbers, with no `
          + 'salt/base story, no grade duplicate, no shared number and no adjacency'
        : `${g.names.length} filed names that are not a form pair, carrying ${g.cas.length} numbers`,
      `numbers: ${g.cas.join(' | ')}`,
    ];
  }

  return list;
}

/** Counts per class, plus how many actually need a person. */
function summarise(triaged) {
  const byClass = {};
  for (const c of CLASSES) byClass[c] = 0;
  let needsHuman = 0;
  for (const g of triaged) {
    byClass[g.class] = (byClass[g.class] || 0) + 1;
    if (g.needsHuman) needsHuman += 1;
  }
  return { total: triaged.length, byClass, needsHuman };
}

module.exports = {
  CLASSES, GRADE_PHRASES, hasGradePhrase, stripGrade, withinOneEdit, isFormPair, triage, summarise,
};
