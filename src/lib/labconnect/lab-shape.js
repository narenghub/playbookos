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

/** SQL boolean: does this name column read like a testing business? */
function looksLikeLabSql(col = 'name') {
  return '(' + LAB_NAME_TOKENS.map(t => `upper(${col}) LIKE '%${t}%'`).join(' OR ') + ')';
}

/** SQL boolean: is this a registry-numbered company, whose registered name can never match? */
function numberedShellSql(col = 'name') {
  return `(${col} ~ '^[0-9]')`;
}

/** JS mirrors, so the ordering can be tested without a database. */
function looksLikeLab(name) {
  const s = String(name || '').toUpperCase();
  return LAB_NAME_TOKENS.some(t => s.includes(t));
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
  return [
    `(region LIKE 'eu%') DESC`,
    `${looksLikeLabSql('name')} DESC`,
    `${numberedShellSql('name')} ASC`,
    `(contact_email IS NOT NULL) DESC`,
    `name`,
  ].join(', ');
}

module.exports = {
  LAB_NAME_TOKENS, looksLikeLabSql, numberedShellSql,
  looksLikeLab, isNumberedShell, labLookupOrderSql,
};
