// ── WHICH OF 3,437 LABS IS WORTH A LOOKUP FIRST ───────────────────────────────
//
// The first live run of the CPHI lab lookup checked these ten, in this order:
//
//   2seventy bio, Inc. · 2Y-Biopharma, Ltd. · 3M Company · 503 Neo Lab LLC ·
//   9055-7588 Quebec Inc dba Attitude · 9231-9110 Québec Inc · 9305-6828 Quebec Inc ·
//   AAA Pharmaceutical · AAA Pharmaceutical · AACE PHARMACEUTICALS
//
// Nought on the floor, and it could hardly have been otherwise: the ordering was
// `(notes IS NULL) DESC, (contact_email IS NOT NULL) DESC, name`, and because `notes` is set only for
// API manufacturers and almost no row carries an email, the whole thing collapsed to ALPHABETICAL.
// Spending four hundred serialised HTTP requests starting at "2seventy" finds nothing and then reports
// a completed run, which is the failure mode the abort guard was written to prevent and this ordering
// walked straight back into.
//
// So the question this module answers is: of the labs in the register, which ones are plausibly
// CONTRACT TESTING BUSINESSES that would pay for a stand at a European trade show? Two signals are
// available without buying data, and both are in the name.
//
// ── SIGNAL 1: THE NAME DESCRIBES A TESTING BUSINESS ──────────────────────────
//
// A company that sells analysis says so on the door. "X Laboratories", "Y Analytical Services",
// "Z Bioanalysis" are selling testing; "2seventy bio" is a biotech that happens to hold an ANALYSIS
// registration for its own product. This is a weak signal about any single row and a strong one about
// the ordering of four hundred, which is all it is used for.
//
// ── SIGNAL 2: THE NAME IS A REGISTRY NUMBER ──────────────────────────────────
//
// "9055-7588 Quebec Inc dba Attitude" is a numbered company — the Québec registry issues these, and
// several hundred sit in the register. The trading name after "dba" may be real, but the registered
// name is what we match on, and it can never match an exhibitor. Sunk to the bottom rather than
// dropped, because a numbered company with a real dba is still a real company.
//
// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
//
// It is NOT a judgement about whether a firm is a contract lab. The register's own answer to that is
// "registered for ANALYSIS and nothing else", and that is not stored on `labs` — which is also why the
// old code's `(notes IS NULL) AS contract_lab` was mislabelling 3M Company as a contract lab on screen.
// `notes IS NULL` means only "no API-manufacturer flag", and it is now labelled as exactly that.

// Matched against an UPPERCASED name. Substrings, not words: "Laboratorios", "Laboratoire" and
// "Laboratory" all have to hit, and a word-boundary match in one language misses the other two.
const LAB_NAME_TOKENS = [
  'LABORATO',         // Laboratory, Laboratories, Laboratorios, Laboratorium, Laboratoire, Laboratório
                      // Truncated to the shared stem on purpose: 'LABORATOR' misses the French
                      // "Laboratoire", which is most of the register's Belgian and French labs.
  'LABS',
  'ANALYTIC',         // Analytical, Analytica, Analytics
  'ANALITIC',         // Analitica — Spanish and Italian spellings
  'BIOANALY',
  'TESTING',
  'QUALITY CONTROL',
  'PHARMA SERVICES',
  'SCIENTIFIC SERVICES',
  // 'CRO' was here and had to go: it matches MICRO, MACRO, CROWN and SACRO. The substring approach
  // that makes 'LABORATO' work across four languages is also what makes a three-letter token useless.
  'MICROBIOLOG',
];

// ── THE FALSE NEGATIVES THE DESCRIBE-YOURSELF TEST CANNOT CATCH ──────────────
//
// The tokens above work because a firm selling analysis usually says so on the door. The exception
// is the firms big enough not to have to: "Eurofins", "Intertek", "Labcorp" and "Nelson Labs" are
// among the largest contract testing businesses in the world and only one of them ("Labs") trips a
// token. When the shape test became a WHERE clause for the SCOPE QC tab rather than just an
// ordering, each of those misses stopped being a demotion and became a deletion — so the brands
// are named.
//
// Deliberately NOT here:
//   · SGS, ALS — three letters. The substring approach that lets 'LABORATO' span four languages
//     also makes a three-letter token match inside unrelated words, which is exactly how 'CRO'
//     matched MICRO and CROWN. A short brand needs an anchored match, and a list of two is not
//     worth a second matching strategy; they are missed, knowingly.
//   · ICON, Syneos, Parexel, IQVIA — clinical CROs, not analytical laboratories. They run trials,
//     which makes them a SCOPE lead on a different tab and a different conversation.
const LAB_BRAND_TOKENS = [
  'EUROFINS',
  'INTERTEK',
  'LABCORP',
  'BUREAU VERITAS',
  'CHARLES RIVER',   // Its testing arm is a genuine contract lab, whatever else the group does.
  'NELSON LAB',
  'MERIEUX NUTRISCIENCES',
  'BIOMERIEUX',
];

/** Every name token the shape test uses: what a lab calls itself, plus the brands that need not. */
const LAB_ALL_TOKENS = [...LAB_NAME_TOKENS, ...LAB_BRAND_TOKENS];

// ── STRONG VERSUS WEAK, BECAUSE "LABORATORIES" PROVES ALMOST NOTHING ─────────
//
// 2026-10-10, third attempt: the filtered list still led with "Abbott Laboratories GmbH". Abbott is
// an originator pharma company whose name has said "Laboratories" since 1900. 'LABORATO' and 'LABS'
// are weak — they appear in originators, in hospital pharmacies and in state institutes. A name
// containing ANALYTICAL, BIOANALYSIS, TESTING or QUALITY CONTROL is a firm SELLING analysis, which
// is a far stronger claim about what it does.
//
// Weak is still kept, because ALS Laboratories and Wessling Laboratorien are real contract labs
// that use only the weak word. Weak means "ranks below strong", not "excluded".
const STRONG_LAB_TOKENS = [
  'ANALYTIC', 'ANALITIC', 'BIOANALY', 'TESTING', 'QUALITY CONTROL', 'MICROBIOLOG',
  ...LAB_BRAND_TOKENS,
];

// ── THE ORIGINATORS, WHOSE "LABORATORIES" IS HISTORICAL ──────────────────────
//
// An originator's own site never sells QC testing to anyone — it tests its own product, which is
// precisely what the register's API-manufacturer note describes. These names trip a lab token and
// have to be named to be excluded.
//
// Deliberately NOT here, because each would match inside an unrelated word: ROCHE (Rochester),
// BAYER (Bayerische — a Bavarian state institute could be a genuine lab), UCB, MSD, GSK. The
// substring approach that lets 'LABORATO' span four languages is the same thing that makes a short
// or common fragment unsafe, and the rule from 'CRO' matching MICRO holds here too.
const ORIGINATOR_TOKENS = [
  'ABBOTT', 'ABBVIE', 'PFIZER', 'NOVARTIS', 'SANOFI', 'ASTRAZENECA', 'BOEHRINGER',
  'GLAXO', 'JANSSEN', 'SERVIER', 'RECORDATI', 'CHIESI', 'MENARINI', 'ALMIRALL',
  'NOVO NORDISK', 'ELI LILLY', 'BRISTOL-MYERS', 'AMGEN', 'BIOGEN', 'ALEXION',
  'GILEAD', 'VERTEX', 'TAKEDA', 'ASTELLAS', 'DAIICHI', 'OTSUKA',
];

/** SQL boolean: does the name claim to SELL analysis, rather than merely contain "laboratories"? */
function strongLabSql(col = 'name') {
  return '(' + STRONG_LAB_TOKENS.map(t => `upper(${col}) LIKE '%${t}%'`).join(' OR ') + ')';
}

/** SQL boolean: is this an originator pharma company whose own site is never a QC vendor? */
function originatorSql(col = 'name') {
  return '(' + ORIGINATOR_TOKENS.map(t => `upper(${col}) LIKE '%${t}%'`).join(' OR ') + ')';
}

// ── ONE GROUP, ONE BOOTH ─────────────────────────────────────────────────────
//
// 2026-10-10: with the ordering finally working, the top 8 of the SCOPE QC list came back as
// Eurofins Amatsi, Eurofins Biolab, Eurofins BioPharma Finland, Eurofins BioPharma Leiden, Labcorp,
// Charles River, Eurofins BioPharma Sweden, Eurofins Pharma Quality Control. Correct ranking, and
// still the wrong list: Eurofins operates one stand at a trade show. Five rows for one group is
// five of sixty slots spent on a single conversation, and the ranking signals that put them there
// (sites, strong name) are exactly the ones a large group scores highest on — so the better the
// ordering gets, the more the biggest group crowds out everyone else.
//
// The group key is the brand where there is one, because "eurofins amatsi" and "eurofins biolab"
// share no leading words beyond the brand. Otherwise the first two words of the normalised name,
// which holds together "Wessling Laboratorien Altenberge" and "Wessling Laboratorien Münster"
// without merging unrelated single-word firms.
function groupKeySql(col = 'name_normalized', nameCol = 'name') {
  const cases = LAB_BRAND_TOKENS
    .map(t => `WHEN upper(${nameCol}) LIKE '%${t}%' THEN '${t.toLowerCase()}'`)
    .join('\n             ');
  return `CASE ${cases}
             ELSE btrim(split_part(${col}, ' ', 1) || ' ' || split_part(${col}, ' ', 2))
           END`;
}

/** JS mirror, for reporting a planned list without a database. */
function groupKey(name) {
  const s = String(name || '').toUpperCase();
  const brand = LAB_BRAND_TOKENS.find(t => s.includes(t));
  if (brand) return brand.toLowerCase();
  const words = String(name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  return words.slice(0, 2).join(' ');
}

/** JS mirrors. */
function isStrongLab(name) {
  const s = String(name || '').toUpperCase();
  return STRONG_LAB_TOKENS.some(t => s.includes(t));
}
function isOriginator(name) {
  const s = String(name || '').toUpperCase();
  return ORIGINATOR_TOKENS.some(t => s.includes(t));
}

/** SQL boolean: does this name column read like a testing business? */
function looksLikeLabSql(col = 'name') {
  return '(' + LAB_ALL_TOKENS.map(t => `upper(${col}) LIKE '%${t}%'`).join(' OR ') + ')';
}

/** SQL boolean: is this a registry-numbered company, whose registered name can never match? */
function numberedShellSql(col = 'name') {
  return `(${col} ~ '^[0-9]')`;
}

/** JS mirrors, so the ordering can be tested without a database. */
function looksLikeLab(name) {
  const s = String(name || '').toUpperCase();
  return LAB_ALL_TOKENS.some(t => s.includes(t));
}
function isNumberedShell(name) { return /^[0-9]/.test(String(name || '')); }

/**
 * The ORDER BY for a trade-show lookup, most-worth-checking first, as a list of SQL fragments.
 *
 * Region leads: a European lab is far likelier to be standing in Milan than a better-named one in
 * Ohio. Then the name signals, then a contactable email — which matters for the follow-up rather than
 * the lookup, so it ranks below both — then name, for a stable order across runs.
 */
function labLookupOrderSql() {
  return labRankTerms();
}

/**
 * THE one ranking for labs, in one place, because this ordering has now been written wrong three
 * times (see the history in src/lib/events/lab-delegates.js). Callers add the terms their query can
 * supply rather than hand-writing the whole list, which is how the second and third collapses
 * happened.
 *
 * `COALESCE(region, '')` matters: `NULL LIKE 'eu%'` is NULL, and a DESC sort puts NULLs FIRST in
 * Postgres, so a lab with no region at all would have led a list ordered for Barcelona.
 *
 *   sitesColumn      — a column holding how many registered sites the firm has. The ONLY continuous
 *                      signal on this table, and the term that stops the ordering collapsing to the
 *                      alphabet once every boolean is constant across the survivors.
 *   capabilityFlags  — include the human-set gmp/research flags (present on `labs`, not on a
 *                      lookup's narrower projection).
 */
function labRankTerms(opts = {}) {
  const terms = [
    `(COALESCE(region, '') LIKE 'eu%') DESC`,
    // Strong before weak: a firm that says ANALYTICAL or TESTING sells analysis; one that merely
    // says "Laboratories" might be Abbott.
    `${strongLabSql('name')} DESC`,
    `${looksLikeLabSql('name')} DESC`,
  ];
  if (opts.sitesColumn) terms.push(`${opts.sitesColumn} DESC`);
  if (opts.capabilityFlags) {
    terms.push(`(COALESCE(gmp_capable, false) OR COALESCE(research_capable, false)) DESC`);
  }
  terms.push(
    `(contact_email IS NOT NULL) DESC`,
    `${numberedShellSql('name')} ASC`,
    // `name` is the last resort and must never be the only non-constant term. If it decides the
    // list, the ordering has collapsed — which is the bug this whole module exists for.
    `name`,
  );
  return terms.join(', ');
}

module.exports = {
  LAB_NAME_TOKENS, LAB_BRAND_TOKENS, LAB_ALL_TOKENS,
  STRONG_LAB_TOKENS, ORIGINATOR_TOKENS,
  looksLikeLabSql, numberedShellSql, strongLabSql, originatorSql, labRankTerms,
  groupKeySql, groupKey,
  isStrongLab, isOriginator,
  looksLikeLab, isNumberedShell, labLookupOrderSql,
};
