// ── IDENTITY IS NOT SEARCH. THIS FILE IS THE IDENTITY HALF. ──────────────────
//
// `synonyms.js` answers "what else should I look for when somebody types this". That question wants
// to be GENEROUS: a search that also finds `leuprolide acetate` when you typed `leuprorelin` is a
// better search. This file answers "which substance IS this", and that question has to be EXACT,
// because the answer ends up on a quotation.
//
// The two must not share a function. `canonicalMolecule()` in synonyms.js de-salts before folding to
// a synonym group, so it maps:
//
//     Testosterone Enanthate  ->  testosterone      CAS 315-37-7  vs  58-22-0
//     Leuprolide Acetate      ->  leuprolide        CAS 74381-53-6 vs 53714-56-0
//     Metformin Hydrochloride ->  metformin
//
// Those are three different substances in each pair, with different CAS numbers, different prices
// and different regulatory status. synonyms.js says so itself: stripping `testosterone enanthate`
// to `testosterone` is "correct for FINDING a supplier and wrong for ordering one". Using it as the
// identity key would quote the wrong material — the commercial inverse of the "SOLE holder
// worldwide" error of 9 Oct, where three filed names split one substance's holders and the page
// printed false scarcity. Merging too eagerly breaks the same number in the other direction.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
//
//     An ALIAS means "the same substance".
//     A PARENT edge means "chemically related but NOT interchangeable identity".
//
// So `leuprorelin` is an alias of `leuprolide`; `leuprolide acetate` is its own molecule with a
// parent edge to it. And `leuprorelin acetate` is an alias of `leuprolide acetate`, because the
// synonym substitution applies to the BASE while the form is held constant — that is what
// aliasForms() below does, and it is the only place a synonym may act.
'use strict';

const {
  SALT_WORDS, MINERAL_STEMS, MIN_BASE_LENGTH, SYNONYM_GROUPS, normalize,
} = require('./synonyms');

// ── PARTITIONING SALT_WORDS ─────────────────────────────────────────────────
//
// synonyms.js keeps one flat set, because for search it does not matter WHY a trailing word is
// strippable. For identity it matters, so the set is partitioned here — and `identity.test.js`
// asserts the partition is TOTAL and DISJOINT over SALT_WORDS.
//
// That test is the point. Without it, adding a counter-ion to synonyms.js next year would leave it
// unclassified here, and an unclassified trailing token means the name reads as a plain base
// substance — a salt silently filed as its own parent. Classification failures have to be loud.

// Not a form at all. `aspirin usp` IS aspirin: a pharmacopoeial grade or a particle size is a
// specification of the same substance, so these are stripped before identity is computed and never
// create a child record. `anhydrous` is here deliberately — it names the absence of water of
// crystallisation, which is the base substance, not a distinct form.
const GRADE_WORDS = new Set([
  'usp', 'ep', 'bp', 'jp', 'ph', 'eur', 'micronised', 'micronized', 'sterile',
  'anhydrous', 'anhydrate',
]);

// Water of crystallisation.
const HYDRATE_WORDS = new Set([
  'hydrate', 'hemihydrate', 'monohydrate', 'dihydrate', 'trihydrate', 'tetrahydrate',
  'pentahydrate', 'heptahydrate', 'sesquihydrate',
]);

// Unambiguously an ester: a fatty-acid or aryl acyl group, which in drug nomenclature is a covalent
// ester rather than a counter-ion.
const ESTER_WORDS = new Set([
  'enanthate', 'heptanoate', 'decanoate', 'undecanoate', 'cypionate', 'caproate', 'valerate',
  'propionate', 'dipropionate', 'palmitate', 'stearate', 'furoate', 'xinafoate', 'butyrate',
]);

// Unambiguously ionic: mineral acids, sulfonates, carboxylate counter-ions, metal cations and amine
// counter-ions.
const SALT_FORM_WORDS = new Set([
  'hydrochloride', 'dihydrochloride', 'hcl', 'hydrobromide', 'hydroiodide',
  'sulfate', 'sulphate', 'bisulfate', 'hemisulfate',
  'mesylate', 'mesilate', 'besylate', 'besilate', 'tosylate', 'tosilate',
  'edisylate', 'isethionate', 'napadisylate',
  'phosphate', 'diphosphate', 'nitrate', 'oxalate', 'carbonate', 'bicarbonate', 'borate',
  'bromide', 'chloride', 'dichloride', 'iodide', 'fluoride',
  'maleate', 'dimaleate', 'tartrate', 'bitartrate', 'citrate', 'dicitrate',
  'fumarate', 'hemifumarate', 'gluconate', 'lactate', 'pamoate', 'embonate',
  'sodium', 'disodium', 'trisodium', 'potassium', 'dipotassium', 'calcium', 'magnesium',
  'zinc', 'lithium', 'ammonium', 'meglumine', 'olamine', 'diolamine', 'trometamol', 'tromethamine',
]);

// ── THE TOKENS THAT ARE GENUINELY BOTH, AND ARE THEREFORE NEITHER ───────────
//
// `acetate` is the clearest case and it is not a gap in this list — it is a fact about the
// nomenclature. `leuprolide acetate` is an acetate SALT of a peptide; `cortisone acetate` is an
// acetate ESTER of a steroid. The name alone does not distinguish them; the parent's chemical class
// does, and we do not have the parent's chemical class. Same for `succinate` (metoprolol succinate
// is a salt, methylprednisolone sodium succinate is an ester).
//
// These resolve to `other`, not to a guess. That is cheap, because substance_form is DESCRIPTIVE —
// it never decides identity. `leuprolide acetate` is its own molecule with its own CAS whether the
// form column reads 'salt' or 'other', so an honest 'other' costs a label and no correctness. A
// human can promote the row later; a guessed 'salt' would be an unmarked chemical judgement sitting
// in the identity spine, which is the thing synonyms.js was careful never to do.
const AMBIGUOUS_FORM_WORDS = new Set([
  'acetate', 'diacetate', 'succinate', 'benzoate', 'salicylate', 'hyclate', 'estolate',
]);

// Every form class in one set, for the peel loop.
const FORM_WORDS = new Set([
  ...HYDRATE_WORDS, ...ESTER_WORDS, ...SALT_FORM_WORDS, ...AMBIGUOUS_FORM_WORDS,
]);

// `solvate` and `mixture` are legal substance_form values and nothing in E1 produces them: no token
// in SALT_WORDS names a non-aqueous solvate, and a mixture is not derivable from a name. They exist
// so that a human-entered row has somewhere correct to go.
const SUBSTANCE_FORMS = ['base', 'salt', 'ester', 'hydrate', 'solvate', 'mixture', 'other'];

/** Strip trailing pharmacopoeial/grade words. The result is the SAME substance as the input. */
function normalizeIdentity(name) {
  const norm = normalize(name);
  if (!norm) return '';
  let tokens = norm.split(' ');
  const dropped = [];
  while (tokens.length > 1 && GRADE_WORDS.has(tokens[tokens.length - 1])) {
    dropped.unshift(tokens.pop());
  }
  return tokens.join(' ');
}

/** Which class does a single trailing token belong to? */
function formClassOf(token) {
  if (SALT_FORM_WORDS.has(token)) return 'salt';
  if (ESTER_WORDS.has(token)) return 'ester';
  if (HYDRATE_WORDS.has(token)) return 'hydrate';
  if (AMBIGUOUS_FORM_WORDS.has(token)) return 'other';
  return null;
}

// ── WHAT FORM IS THIS, AND WHAT IS ITS BASE? ────────────────────────────────
//
// Returns the identity name (grade removed), the form, the tokens that produced the form so the
// classification can be audited by a human rather than trusted, and the derived base name.
//
// `derivedBase` is RECORDED BUT NOT RESOLVED here. The backfill links parent_molecule_id only when a
// molecule with that base name was independently OBSERVED in the data. Creating a base molecule
// because a child implies one would be filing a derived fact as a sourced one, which P1 forbids —
// and it would mean `testosterone` appearing in the spine on the strength of an enanthate row and
// nothing else.
function substanceForm(name) {
  const identity = normalizeIdentity(name);
  const out = {
    identity, form: 'base', formTokens: [], derivedBase: null, reason: 'no trailing form token',
  };
  if (!identity) { out.reason = 'empty name'; return out; }

  const tokens = identity.split(' ');
  let t = tokens.slice();
  const formTokens = [];
  while (t.length > 1 && FORM_WORDS.has(t[t.length - 1])) formTokens.unshift(t.pop());

  if (!formTokens.length) return out;

  const base = t.join(' ');

  // The two guards copied in behaviour from moleculeBase, for the same reasons. A base shorter than
  // MIN_BASE_LENGTH is too generic to be a substance, and a bare mineral stem IS the substance —
  // `potassium chloride` is a drug, not a salt of a drug.
  if (base.length < MIN_BASE_LENGTH) {
    out.reason = `stripping would leave "${base}", under the ${MIN_BASE_LENGTH}-char floor — treated as the substance itself`;
    return out;
  }
  if (t.length === 1 && MINERAL_STEMS.has(base)) {
    out.reason = `"${base}" is a mineral stem — the whole name is the substance`;
    return out;
  }

  // Precedence when a name carries more than one class, e.g. `dexamethasone sodium phosphate` or
  // `donepezil hydrochloride monohydrate`: the ionic relationship dominates how the substance is
  // bought and registered, so salt wins, then ester, then hydrate.
  const classes = formTokens.map(formClassOf);
  let form = 'other';
  if (classes.includes('salt')) form = 'salt';
  else if (classes.includes('ester')) form = 'ester';
  else if (classes.includes('hydrate')) form = 'hydrate';

  out.form = form;
  out.formTokens = formTokens;
  out.derivedBase = base;
  out.reason = `trailing ${formTokens.join(' + ')} -> ${form}`;
  return out;
}

// Synonym index over BASE names only, built from the curated groups.
const SYN_INDEX = new Map();
for (const group of SYNONYM_GROUPS) {
  const members = group.map(normalize).filter(Boolean);
  for (const m of members) {
    SYN_INDEX.set(m, Array.from(new Set((SYN_INDEX.get(m) || []).concat(members))));
  }
}

// ── THE ONLY PLACE A SYNONYM MAY ACT ON IDENTITY ────────────────────────────
//
// The substitution happens on the BASE and the form tokens are carried through unchanged, so:
//
//   aliasForms('Leuprorelin')          -> identity 'leuprorelin',          aliases ['leuprolide']
//   aliasForms('Leuprorelin Acetate')  -> identity 'leuprorelin acetate',  aliases ['leuprolide acetate']
//   aliasForms('Leuprolide Acetate')   -> identity 'leuprolide acetate',   aliases ['leuprorelin acetate']
//
// What it never does is return a bare base as an alias of a salted name. `leuprolide` is NOT in the
// alias list for `leuprolide acetate`; that relationship is a parent edge, and the difference is
// the whole file.
function aliasForms(name) {
  const { identity, formTokens, derivedBase } = substanceForm(name);
  if (!identity) return { identity: '', aliases: [] };

  const base = derivedBase || identity;
  const suffix = formTokens.length ? ` ${formTokens.join(' ')}` : '';
  const aliases = [];
  for (const syn of SYN_INDEX.get(base) || []) {
    const candidate = `${syn}${suffix}`;
    if (candidate !== identity && !aliases.includes(candidate)) aliases.push(candidate);
  }
  return { identity, aliases };
}

/**
 * The full identity record for a filed name. Pure — no database, no network, no guessing.
 * `preferredName` keeps the filed spelling for display; `identity` is the key.
 */
function identityOf(filedName) {
  const f = substanceForm(filedName);
  const { aliases } = aliasForms(filedName);
  return {
    filed: String(filedName == null ? '' : filedName).trim(),
    identity: f.identity,
    form: f.form,
    formTokens: f.formTokens,
    derivedBase: f.derivedBase,
    aliases,
    reason: f.reason,
  };
}

module.exports = {
  GRADE_WORDS,
  HYDRATE_WORDS,
  ESTER_WORDS,
  SALT_FORM_WORDS,
  AMBIGUOUS_FORM_WORDS,
  FORM_WORDS,
  SUBSTANCE_FORMS,
  normalizeIdentity,
  formClassOf,
  substanceForm,
  aliasForms,
  identityOf,
};
