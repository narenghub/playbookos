// CPHI sourcing Step 1 — molecule → DMF matching. Pure functions, no DB, no network.
//
// The FDA quarterly DMF file carries SIX columns and no CAS number, so every join between a
// Clinical Demand molecule and a drug-substance manufacturer has to run on free text. That is
// the whole difficulty here: `study_molecules.molecule_name` is written by an LLM from a trial
// record ("Folinic acid (leucovorin)", "Capecitabine USP/EP Reference Standard") while the DMF
// SUBJECT is a registry string in shouting caps with the salt spelled out ("LEUCOVORIN
// CALCIUM"). Four tiers bridge that, weakest last:
//
//   exact      normalized equality.                      Trustworthy.
//   salt_form  the DMF subject is the molecule plus a     Trustworthy — "GEMCITABINE
//              trailing salt/ester token.                 HYDROCHLORIDE" for "Gemcitabine".
//   annotated  the molecule name carries an annotation    Trustworthy once the annotation is
//              the registry never uses — a parenthetical, gone. MEASURED at +14.6pp of total
//              a "USP/EP Reference Standard" suffix, a    recall on live data (24.9% -> 39.5%),
//              slash alternative.                          by far the highest-value tier.
//   contained  whole-token substring.                     NOT trustworthy. Reported separately
//                                                         and never used silently.
//
// Tier order is precedence: a molecule that matches a DMF by more than one route keeps the
// STRONGEST tier, so `match_tier` always describes the best evidence, not the last rule to run.
//
// SCOPE: callers must pass ACTIVE TYPE II rows only. Types III/IV/V are packaging, excipients
// and container-closure systems — matching a molecule to those would name a box supplier as a
// drug-substance manufacturer. buildSubjectIndex enforces it rather than trusting the caller.

const TIERS = ['exact', 'salt_form', 'annotated', 'contained'];
const TIER_RANK = { exact: 0, salt_form: 1, annotated: 2, contained: 3 };

// Salt / ester / hydrate forms that follow a base molecule in a DMF subject. A subject is a
// salt_form hit only when what FOLLOWS the molecule name is drawn entirely from this set —
// otherwise "CALCIUM CARBONATE" would swallow "CALCIUM" and every calcium salt would collapse
// into one molecule.
const SALT_TOKENS = new Set([
  'hydrochloride', 'hcl', 'hydrobromide', 'hydroiodide', 'sulfate', 'sulphate', 'bisulfate',
  'phosphate', 'diphosphate', 'nitrate', 'acetate', 'diacetate', 'trifluoroacetate',
  'maleate', 'fumarate', 'succinate', 'tartrate', 'bitartrate', 'citrate', 'oxalate',
  'malate', 'mesylate', 'mesilate', 'besylate', 'besilate', 'tosylate', 'tosilate',
  'esylate', 'napsylate', 'edisylate', 'isethionate', 'pamoate', 'embonate', 'xinafoate',
  'lactate', 'gluconate', 'glucuronate', 'stearate', 'palmitate', 'laurate', 'benzoate',
  'salicylate', 'valerate', 'propionate', 'butyrate', 'caproate', 'enanthate', 'decanoate',
  'undecylenate', 'pivalate', 'furoate', 'dipropionate', 'acetonide',
  'sodium', 'disodium', 'potassium', 'dipotassium', 'calcium', 'magnesium', 'zinc', 'lithium',
  'aluminum', 'aluminium', 'ammonium', 'meglumine', 'choline', 'diolamine', 'olamine',
  'tromethamine', 'lysine', 'arginine', 'benzathine', 'procaine', 'diethylamine',
  'hydrate', 'monohydrate', 'dihydrate', 'trihydrate', 'tetrahydrate', 'pentahydrate',
  'hexahydrate', 'heptahydrate', 'octahydrate', 'hemihydrate', 'sesquihydrate',
  'anhydrous', 'anhydrate', 'hydrous',
  'mono', 'di', 'tri', 'tetra', 'penta', 'hexa', 'hepta', 'hemi', 'sesqui',
  'salt', 'base', 'free',
  // Halide salts and the fused di-/tri- spellings the registry actually uses. Their absence
  // was pushing real salt forms down into the untrustworthy `contained` tier: "ELACESTRANT
  // DIHYDROCHLORIDE", "TROSPIUM CHLORIDE" and "FOSTAMATINIB DISODIUM HEXAHYDRATE" all
  // matched only by substring until these were added.
  'chloride', 'bromide', 'iodide', 'fluoride',
  'dihydrochloride', 'dihydrobromide', 'dimaleate', 'difumarate', 'dimesylate', 'ditosylate',
  'disuccinate', 'dicitrate', 'ditartrate', 'dinitrate', 'dioxalate', 'diacetate',
  'trihydrochloride', 'hemifumarate', 'hemisuccinate', 'hemitartrate',
]);

/**
 * Pharmacopoeia / presentation qualifiers that follow a molecule in a DMF subject without
 * changing which molecule it is: "PROBENECID USP", "ARGININE STERILE BULK". Treated as
 * allowed trailing noise in the salt_form tail — the same standing as a salt token — so
 * these land in a tier that can be trusted rather than in `contained`.
 */
const GRADE_TOKENS = new Set([
  'usp', 'ep', 'bp', 'jp', 'nf', 'ip', 'phpur', 'pheur', 'usp/ep',
  'grade', 'sterile', 'bulk', 'powder', 'crystalline', 'micronized', 'micronised',
  'solution', 'granular', 'purified', 'compacted', 'dc', 'ph',
]);

/**
 * Fold a molecule or DMF subject to a comparison key: lowercase, punctuation to space,
 * whitespace collapsed. Deliberately conservative — it does NOT drop tokens, because at this
 * stage every token still carries meaning (a salt name here is the difference between two
 * different registry entries).
 */
function normalizeMolecule(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strip the annotations a trial record carries but a drug registry never does.
 *
 * Returns a LIST of candidate names, not one string, because a molecule name can legitimately
 * yield several readings: "Folinic acid (leucovorin)" should be tried both as "folinic acid"
 * AND as "leucovorin" — the registry files it under the second. Order is
 * most-literal-first; the caller takes the first candidate that hits.
 *
 * Handles, in this order:
 *   - grade / standard suffixes:  "Capecitabine USP/EP Reference Standard" -> "capecitabine"
 *   - parentheticals:             "Folinic acid (leucovorin)" -> "folinic acid" + "leucovorin"
 *   - bracketed isotope labels:   "[1-13C]lactic acid" -> "lactic acid"
 *   - slash alternatives:         "sodium/potassium citrate" -> "sodium citrate"-ish head
 *   - descriptor tails:           "Cabozantinib (free base)" -> "cabozantinib"
 */
function annotationCandidates(name) {
  const raw = String(name == null ? '' : name);
  const out = [];
  const push = (s) => {
    const n = normalizeMolecule(s);
    // A 1–2 character residue is noise, not a molecule.
    if (n.length >= 3 && !out.includes(n)) out.push(n);
  };

  // Grade / pharmacopoeia / reference-standard tails. These appear AFTER the molecule, so
  // everything from the marker onward goes. Anchored to token starts so "USPTO" can't trip it.
  const GRADE = /\b(usp|ep|bp|jp|ph\.?\s?eur|nf|ip)\b[\s/,-]*(and\s+)?(usp|ep|bp|jp|nf|ip)?\b[\s/,-]*(reference\s+)?(standard|grade|monograph|quality)?\b.*$/i;
  const DESCRIPTOR = /\b(reference\s+standard|analytical\s+standard|free\s+base|free\s+acid|as\s+the\s+.*|api|drug\s+substance|impurity\s+[a-z0-9]*)\b.*$/i;

  let base = raw
    .replace(/\[[^\]]*\]/g, ' ')   // bracketed isotope labels: [1-13C]
    .replace(GRADE, ' ')
    .replace(DESCRIPTOR, ' ');

  // The name with parentheticals removed.
  const withoutParens = base.replace(/\([^)]*\)/g, ' ');
  push(withoutParens);

  // Each parenthetical's own contents, as an alternative name. This is the reading that
  // rescues "Folinic acid (leucovorin)" and "3,4-Methylenedioxyamphetamine (MDA)".
  for (const m of raw.matchAll(/\(([^)]*)\)/g)) {
    const inner = m[1].replace(GRADE, ' ').replace(DESCRIPTOR, ' ');
    // Skip pure abbreviations and qualifiers that are not names in their own right.
    if (/^\s*(free\s+base|free\s+acid|api|salt|contract|investigational|inn|usan)\s*$/i.test(inner)) continue;
    push(inner);
    // A parenthetical often lists synonyms separated by commas: "(dFdU, gemcitabine metabolite)"
    for (const part of inner.split(/[,;]/)) push(part);
  }

  // Slash alternatives outside parentheses, taken head-first: "abemaciclib/LY2835219".
  if (withoutParens.includes('/')) for (const part of withoutParens.split('/')) push(part);

  // Comma-separated head, for "Sodium chloride, sterile".
  if (withoutParens.includes(',')) push(withoutParens.split(',')[0]);

  return out;
}

/**
 * True when `subject` is `molecule` followed only by salt/hydrate/ester tokens.
 * Both arguments must already be normalized.
 */
function isSaltFormOf(subject, molecule) {
  if (!molecule || !subject) return false;
  if (subject === molecule) return false;
  if (!subject.startsWith(molecule + ' ')) return false;
  const tail = subject.slice(molecule.length + 1).split(' ').filter(Boolean);
  // Every trailing token must be a salt/hydrate form or a grade qualifier. A single unknown
  // token (e.g. "carbonate" after "calcium", "conjugate" after an antibody) disqualifies the
  // match - that is what stops one molecule swallowing another that shares its prefix.
  // Bare numerals are allowed only between known tokens ("ZINC SULFATE 7 HYDRATE").
  return tail.length > 0 && tail.every((t) => SALT_TOKENS.has(t) || GRADE_TOKENS.has(t) || /^\d{1,2}$/.test(t));
}

/**
 * Build the lookup the matcher runs against.
 *
 * Filters to ACTIVE TYPE II here rather than trusting the caller: a Type III packaging DMF
 * reaching a molecule match would name a carton supplier as a drug-substance manufacturer,
 * which is the single worst error this module could make.
 */
function buildSubjectIndex(dmfRows) {
  const bySubject = new Map();   // normalized subject -> [row, ...]
  const byFirstToken = new Map(); // first token -> Set(normalized subject)
  let considered = 0;

  for (const row of dmfRows) {
    if (row.status !== 'A' || row.dmf_type !== 'II') continue;
    considered++;
    const key = normalizeMolecule(row.subject);
    if (!key) continue;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(row);
    const first = key.split(' ')[0];
    if (!byFirstToken.has(first)) byFirstToken.set(first, new Set());
    byFirstToken.get(first).add(key);
  }
  return { bySubject, byFirstToken, considered, subjects: [...bySubject.keys()] };
}

/**
 * Match one molecule name against the index.
 *
 * Returns { tier, dmfNumbers, holders, matchedSubject } or null. Tiers are tried in
 * precedence order and the FIRST hit wins, so a molecule reachable by both `exact` and
 * `contained` is recorded as `exact`.
 */
function matchMolecule(moleculeName, index) {
  const base = normalizeMolecule(moleculeName);
  if (!base) return null;

  const collect = (subjects, tier) => {
    const rows = [];
    for (const s of subjects) rows.push(...(index.bySubject.get(s) || []));
    if (!rows.length) return null;
    return {
      tier,
      matchedSubject: subjects[0],
      dmfNumbers: [...new Set(rows.map((r) => r.dmf_number))].sort((a, b) => a - b),
      holders: [...new Set(rows.map((r) => r.holder))].sort(),
    };
  };

  // 1 ── exact
  if (index.bySubject.has(base)) return collect([base], 'exact');

  // 2 ── salt_form: the registry files the salt, the trial names the base.
  const saltHits = [...(index.byFirstToken.get(base.split(' ')[0]) || [])].filter((s) =>
    isSaltFormOf(s, base),
  );
  if (saltHits.length) return collect(saltHits.sort(), 'salt_form');

  // 3 ── annotated: retry each de-annotated reading through tiers 1 and 2.
  for (const cand of annotationCandidates(moleculeName)) {
    if (cand === base) continue; // already tried above
    if (index.bySubject.has(cand)) return { ...collect([cand], 'exact'), tier: 'annotated' };
    const hits = [...(index.byFirstToken.get(cand.split(' ')[0]) || [])].filter((s) =>
      isSaltFormOf(s, cand),
    );
    if (hits.length) return { ...collect(hits.sort(), 'salt_form'), tier: 'annotated' };
  }

  // 4 ── contained: whole-token substring, length-guarded. LOW CONFIDENCE by construction —
  // this is the tier that let "Daratumumab" reach an imaging firm's conjugate DMF. Callers
  // must surface these for human review rather than writing them through silently.
  if (base.length >= 7) {
    const needle = ` ${base} `;
    const hits = index.subjects.filter((s) => ` ${s} `.includes(needle));
    if (hits.length) return collect(hits.sort(), 'contained');
  }

  return null;
}

/** Match many molecules. Returns one entry per input name, matched or not. */
function matchMolecules(moleculeNames, dmfRows) {
  const index = buildSubjectIndex(dmfRows);
  const results = moleculeNames.map((name) => {
    const m = matchMolecule(name, index);
    return m ? { moleculeName: name, ...m } : { moleculeName: name, tier: null, dmfNumbers: [], holders: [] };
  });
  return { index, results };
}

module.exports = {
  TIERS,
  TIER_RANK,
  SALT_TOKENS,
  GRADE_TOKENS,
  normalizeMolecule,
  annotationCandidates,
  isSaltFormOf,
  buildSubjectIndex,
  matchMolecule,
  matchMolecules,
};
