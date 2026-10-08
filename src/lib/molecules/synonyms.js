// ── ONE MOLECULE, SEVERAL LEGAL NAMES. THE SEARCH HAS TO KNOW ALL OF THEM. ────
//
// On 2026-10-08 at CPHI Milan a customer asked about LEUPRORELIN and the molecule search returned
// nothing — from a database holding DMF holders for it. The holders are filed as LEUPROLIDE, because
// FDA filings use the USAN and the customer used the INN. The data was there; the match was a raw
// `LIKE '%leuprorelin%'`.
//
// This is not a one-molecule bug. Every European walking the floor says paracetamol, salbutamol,
// rifampicin, ciclosporin, adrenaline, lidocaine. Every FDA record says acetaminophen, albuterol,
// rifampin, cyclosporine, epinephrine, lignocaine's American spelling. A substring search across a
// US register typed into by a European audience fails silently and looks exactly like "we have no
// supplier", which is the single most expensive wrong answer this platform can give at a booth.
//
// Two separate problems, fixed separately:
//
//   1. DIFFERENT NAMES for the same substance (INN vs USAN vs BAN). Solved by SYNONYM_GROUPS — a
//      curated table. There is no way to derive "paracetamol = acetaminophen" from the strings.
//   2. SALT AND HYDRATE FORMS. `leuprolide acetate`, `metformin hydrochloride`, `warfarin sodium`.
//      A search for the base name substring-matches these already; a search for the SALTED name does
//      not match the base. Solved by stripping the trailing salt words to recover the base.
//
// ── WHAT THIS TABLE IS AND IS NOT ────
//
// It is hand-written and deliberately narrow: only pairs where the equivalence is a documented
// naming-convention divergence, not a chemical judgement. It does NOT contain:
//   • prodrugs or metabolites (those are different substances with different DMFs)
//   • esters that change the regulatory entity (testosterone vs testosterone enanthate are both
//     stripped to `testosterone` by the salt rule, which is correct for FINDING a supplier and
//     wrong for ordering one — the UI shows the matched name so the difference stays visible)
//   • brand names (a brand is a company's, not a substance's)
//
// It is incomplete by construction. Adding a row is a one-line change; a missing row degrades to
// today's behaviour (the typed term alone), never to a wrong answer.
'use strict';

// Equivalence groups. Order inside a group does not matter — every member expands to all the others.
// Spelling variants live here too, because a British `oe`/`ph`/`y` is the same silent failure as a
// different name entirely.
const SYNONYM_GROUPS = [
  // ── peptides and hormone analogues: the class that started this ────
  ['leuprorelin', 'leuprolide'],
  ['somatropin', 'somatotropin'],
  ['vasopressin', 'argipressin'],
  ['desmopressin', 'ddavp'],

  // ── INN vs USAN, the common ones ────
  ['paracetamol', 'acetaminophen'],
  ['salbutamol', 'albuterol'],
  ['rifampicin', 'rifampin'],
  ['ciclosporin', 'cyclosporine', 'cyclosporin'],
  ['adrenaline', 'epinephrine'],
  ['noradrenaline', 'norepinephrine'],
  ['isoprenaline', 'isoproterenol'],
  ['orciprenaline', 'metaproterenol'],
  ['lidocaine', 'lignocaine'],
  ['pethidine', 'meperidine'],
  ['glibenclamide', 'glyburide'],
  ['indometacin', 'indomethacin'],
  ['cefalexin', 'cephalexin'],
  ['cefradine', 'cephradine'],
  ['cefazolin', 'cephazolin'],
  ['chlorphenamine', 'chlorpheniramine'],
  ['beclometasone', 'beclomethasone'],
  ['mesalazine', 'mesalamine', '5-aminosalicylic acid'],
  ['aciclovir', 'acyclovir'],
  ['amfetamine', 'amphetamine'],
  ['dexamfetamine', 'dextroamphetamine'],
  ['furosemide', 'frusemide'],
  ['dosulepin', 'dothiepin'],
  ['hyoscine', 'scopolamine'],
  ['dicycloverine', 'dicyclomine'],
  ['phytomenadione', 'phytonadione'],
  ['colecalciferol', 'cholecalciferol'],
  ['ergocalciferol', 'vitamin d2'],
  ['tetracaine', 'amethocaine'],
  // trometamol/tromethamine is deliberately NOT here. It is both a substance and a counter-ion, and
  // its useful role in this search is the second one: `ketorolac trometamol` must strip to
  // `ketorolac`. It lives in SALT_WORDS only. The "no synonym is a salt word" test enforces that a
  // name cannot sit in both tables, because stripping and expanding the same token fight each other.
  ['methylthioninium', 'methylene blue'],
  ['bendroflumethiazide', 'bendrofluazide'],
  ['cromoglicate', 'cromolyn', 'cromoglycate'],
  ['benzylpenicillin', 'penicillin g'],
  ['phenoxymethylpenicillin', 'penicillin v'],
  ['thiopental', 'thiopentone'],
  ['phenobarbital', 'phenobarbitone'],
  ['secobarbital', 'quinalbarbitone'],
  ['amobarbital', 'amylobarbitone'],
  ['guaifenesin', 'guaiphenesin'],
  ['acenocoumarol', 'nicoumalone'],
  ['nicotinamide', 'niacinamide'],
  ['nicotinic acid', 'niacin'],
  ['riboflavin', 'riboflavine'],
  ['thiamine', 'thiamin', 'aneurine'],
  ['ascorbic acid', 'vitamin c'],
  ['tocopherol', 'vitamin e'],
  ['retinol', 'vitamin a'],

  // ── British spelling conventions ────
  ['oestradiol', 'estradiol'],
  ['oestriol', 'estriol'],
  ['oestrone', 'estrone'],
  ['amoxicillin', 'amoxycillin'],
  ['sulfasalazine', 'sulphasalazine'],
  ['sulfamethoxazole', 'sulphamethoxazole'],
  ['sulfadiazine', 'sulphadiazine'],
  ['ciclesonide', 'cyclesonide'],
  ['cefuroxime', 'cephuroxime'],
  ['tranexamic acid', 'tranexaemic acid'],
];

// Trailing words that name a SALT, ESTER, HYDRATE or COUNTER-ION rather than the substance. Stripped
// from the END only: `sodium cromoglicate` keeps its leading sodium, `warfarin sodium` loses its
// trailing one.
const SALT_WORDS = new Set([
  'acetate', 'diacetate', 'hydrochloride', 'dihydrochloride', 'hcl', 'hydrobromide', 'hydroiodide',
  'sulfate', 'sulphate', 'bisulfate', 'hemisulfate', 'maleate', 'dimaleate', 'tartrate', 'bitartrate',
  'citrate', 'dicitrate', 'mesylate', 'mesilate', 'besylate', 'besilate', 'tosylate', 'tosilate',
  'fumarate', 'hemifumarate', 'succinate', 'phosphate', 'diphosphate', 'nitrate', 'oxalate',
  'pamoate', 'embonate', 'palmitate', 'propionate', 'dipropionate', 'valerate', 'furoate',
  'xinafoate', 'lactate', 'gluconate', 'stearate', 'benzoate', 'salicylate', 'edisylate',
  'isethionate', 'napadisylate', 'hyclate', 'estolate', 'enanthate', 'heptanoate', 'decanoate',
  'undecanoate', 'cypionate', 'caproate', 'butyrate', 'carbonate', 'bicarbonate', 'borate',
  'sodium', 'disodium', 'trisodium', 'potassium', 'dipotassium', 'calcium', 'magnesium', 'zinc',
  'lithium', 'ammonium', 'meglumine', 'olamine', 'diolamine', 'trometamol', 'tromethamine',
  'bromide', 'chloride', 'dichloride', 'iodide', 'fluoride',
  'monohydrate', 'dihydrate', 'trihydrate', 'tetrahydrate', 'pentahydrate', 'heptahydrate',
  'hydrate', 'anhydrous', 'anhydrate', 'hemihydrate', 'sesquihydrate',
  'usp', 'ep', 'bp', 'jp', 'ph', 'eur', 'micronised', 'micronized', 'sterile',
]);

// Names that ARE the substance even though every word in them is in SALT_WORDS. Never strip these to
// a bare mineral: `potassium chloride` is a drug, not a salt of a drug.
const MINERAL_STEMS = new Set([
  'sodium', 'potassium', 'calcium', 'magnesium', 'zinc', 'lithium', 'ammonium',
  'iron', 'ferrous', 'ferric', 'aluminium', 'aluminum', 'selenium', 'chromium', 'copper',
]);

// Shortest base a salt-strip may leave behind. Below this the base matches half the register and the
// expansion costs more in noise than it buys in recall.
const MIN_BASE_LENGTH = 6;

function normalize(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[(),;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strip trailing salt/hydrate/grade words. Returns the input unchanged when stripping would leave
// something too short, a bare mineral, or nothing at all.
function moleculeBase(name) {
  const norm = normalize(name);
  if (!norm) return '';
  let tokens = norm.split(' ');
  while (tokens.length > 1 && SALT_WORDS.has(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
  }
  const base = tokens.join(' ');
  if (base === norm) return norm;
  if (base.length < MIN_BASE_LENGTH) return norm;          // too generic to search on
  if (tokens.length === 1 && MINERAL_STEMS.has(base)) return norm;  // potassium chloride stays whole
  return base;
}

// Build the synonym index once. Keyed by normalized name → the full group it belongs to.
const INDEX = new Map();
for (const group of SYNONYM_GROUPS) {
  const members = group.map(normalize).filter(Boolean);
  for (const m of members) {
    const existing = INDEX.get(m) || [];
    INDEX.set(m, Array.from(new Set(existing.concat(members))));
  }
}

// ── THE ONE FUNCTION THE SEARCH CALLS ────
//
// Returns every name worth searching for what the user typed, the typed term first so an exact hit
// still sorts first, plus enough detail for the UI to say WHICH name the data is filed under.
//
//   expandMolecule('leuprorelin')
//     → { typed: 'leuprorelin', base: 'leuprorelin',
//         terms: ['leuprorelin', 'leuprolide'], expanded: true }
//
//   expandMolecule('Leuprolide Acetate')
//     → { typed: 'leuprolide acetate', base: 'leuprolide',
//         terms: ['leuprolide acetate', 'leuprolide', 'leuprorelin'], expanded: true }
function expandMolecule(term) {
  const typed = normalize(term);
  if (!typed) return { typed: '', base: '', terms: [], expanded: false };

  const base = moleculeBase(typed);
  const out = [typed];
  const push = (t) => { if (t && !out.includes(t)) out.push(t); };

  push(base);
  // Synonyms of both what was typed and its de-salted base: someone may type either.
  for (const key of [typed, base]) {
    for (const syn of INDEX.get(key) || []) {
      push(syn);
      // A synonym's own salted forms are found by substring, so only the bare synonym is needed.
    }
  }

  return { typed, base, terms: out, expanded: out.length > 1 };
}

// ── ONE SUBSTANCE, ONE ROW ────
//
// The register holds `Leuprolide`, `Leuprolide Acetate` and `Leuprorelin` as three strings. A query
// grouped on the raw name therefore returns three rows and SPLITS THE HOLDERS between them — and the
// top row then reads "SOLE holder worldwide" when three companies hold a DMF. That is not a display
// bug: scarcity is the number a buyer negotiates on, so an inflated one is a false commercial claim
// coming out of the platform.
//
// canonicalMolecule collapses a filed name to the substance: de-salted, then folded to the first
// member of its synonym group so every alias lands on the same key. It is a stable label for
// grouping, not a claim about which name is correct.
function canonicalMolecule(name) {
  const base = moleculeBase(name);
  if (!base) return '';
  const group = INDEX.get(base) || INDEX.get(normalize(name));
  if (!group || !group.length) return base;
  // The group's own order is the table's order, so the canonical name is stable across calls and
  // across processes. Sorted so a reordering of SYNONYM_GROUPS cannot silently re-key existing data.
  return group.slice().sort()[0];
}

// SQL for "this column matches any of these names". One array parameter, usable in several places in
// a query without index arithmetic — which is what the CPHI molecule search needs, since it matches
// the same term set against demand, holders and the price list.
//
//   const { sql, param } = moleculeLikeSql('k');
//   query(`... WHERE ${sql} ...`, [param(terms)])
function moleculeLikeSql(col, index) {
  return `${col} LIKE ANY ($${index})`;
}

// The patterns for the parameter above. Kept next to the SQL so the `%` wrapping lives in one place.
function likePatterns(terms) {
  return (terms || []).map((t) => '%' + t + '%');
}

// Which of the searched names a returned row is actually filed under — so the UI can print
// "filed as leuprolide acetate" when the user typed leuprorelin. Returns null when the row matches
// what they typed, because then there is nothing to explain.
function matchedVia(rowMolecule, expansion) {
  const row = normalize(rowMolecule);
  if (!row || !expansion || !expansion.typed) return null;
  if (row.includes(expansion.typed)) return null;        // typed name is in there; nothing surprising
  for (const t of expansion.terms) {
    if (t !== expansion.typed && row.includes(t)) return t;
  }
  return null;
}

module.exports = {
  SYNONYM_GROUPS,
  SALT_WORDS,
  MINERAL_STEMS,
  MIN_BASE_LENGTH,
  normalize,
  moleculeBase,
  canonicalMolecule,
  expandMolecule,
  moleculeLikeSql,
  likePatterns,
  matchedVia,
};
