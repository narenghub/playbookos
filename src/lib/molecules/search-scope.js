'use strict';
// ── WHICH MOLECULE FUNCTIONS ARE SEARCH-ONLY, AND WHO MAY CALL THEM ──────────
//
// THE ONE DEFINITION. scripts/check-search-rule-scope.js reads this file and nothing else, so a
// new search caller is declared in exactly one place. This repository has already paid for the
// alternative: five copies of SOURCES, and a check whose table list had to be remembered twice.
//
// ── THE PROBLEM THIS EXISTS TO SOLVE ────────────────────────────────────────
//
// src/lib/molecules/synonyms.js de-salts names ON PURPOSE, and says so in its own words:
//
//     "testosterone vs testosterone enanthate are both stripped to `testosterone` by the salt
//      rule, which is correct for FINDING a supplier and wrong for ordering one — the UI shows
//      the matched name so the difference stays visible."
//
// That is a correct and deliberate scoping rule. Its weakness is that it is enforced only by
// whoever reads the file. The commercial paths that exist today already fail closed — the inquiry
// agent returns no price rather than a wrong one — but PRPA's matcher does not exist yet, and the
// most convenient function in the repository for writing it is the one its own author documented
// as wrong for ordering.
//
// ── WHY AN ALLOWLIST AND NOT A BLOCKLIST ────────────────────────────────────
//
// A blocklist of commercial modules would have to be extended every time a commercial module is
// added, and the module most likely to be forgotten is the one somebody just wrote. So the default
// is DENY: every file is forbidden from importing these functions unless it is listed below with a
// reason. A new PRPA matcher is forbidden the moment it is created, by doing nothing.
//
// The cost of that choice is honest: adding a legitimate search caller requires a one-line change
// here, and the check will tell whoever forgot.

// The functions whose contract is "generous, for finding things". Each de-salts, folds synonyms, or
// both — none of them preserves the base/salt/ester distinction that an order depends on.
const SEARCH_ONLY_FUNCTIONS = Object.freeze([
  'canonicalMolecule',   // de-salts then folds to a synonym group — the census measured what this
                         // would merge if used as an identity rule, in order that it would not be
  'expandMolecule',      // unions a whole synonym group plus de-salted forms
  'moleculeBase',        // strips trailing salt/ester words; `testosterone enanthate` → `testosterone`
  'moleculeLikeSql',     // builds the SQL for the above
  'likePatterns',        // ditto
]);

// The module that defines them. An import of this path is what the check looks for.
const SEARCH_MODULE = 'src/lib/molecules/synonyms.js';

// Files permitted to import them, each with the reason it is legitimate. Repo-relative paths.
//
// EVERY ENTRY IS A SEARCH SURFACE OR A TOOL THAT MEASURES THE SEARCH RULE. None of them prices,
// quotes, orders or bids. If an entry ever starts doing one of those, it belongs in a new module
// rather than in this list.
const SEARCH_CALLER_ALLOWLIST = Object.freeze({
  'src/api/routes.js':
    'hosts the molecule SEARCH endpoints, which is the purpose these functions were written for. '
    + 'RESIDUAL RISK, stated rather than assumed: routes.js is a large mixed file, so a pricing or '
    + 'quoting handler added inline there would sit inside this exemption. The check cannot see '
    + 'that, and narrowing it means extracting the search handlers into their own module — worth '
    + 'doing, not done here.',
  'scripts/check-molecule-search-sql.js':
    'asserts the search SQL does what the search rule claims; it must call the real functions.',
  'scripts/molecule-identity-census.js':
    'MEASURES what canonicalMolecule() would merge if adopted as the merge rule. Calling it is the '
    + 'whole point — the census exists so the answer can be "no".',
  'src/lib/molecules/preview.js':
    'MEASURES legacy grouping against E1 grouping, to count how many CAS conflicts survive once '
    + 'identity stops stripping the form. Like the census, it must call the legacy function to '
    + 'compare against it.',
  'src/lib/molecules/merge.js':
    'GROUPS search-result rows for discovery with canonicalMolecule, which is what makes a search '
    + 'for the base find the salt. Every COMMERCIAL number on the row now comes from the identity '
    + 'layer instead (moleculeKey/identityOf), so the search rule decides what appears together and '
    + 'never what a thing costs or how many suppliers hold it. '
    + 'CONCERN RESOLVED: it previously merged `Leuprolide` (Bachem) with `Leuprolide Acetate` (Sun, '
    + 'ScinoPharm) into one substance with holder_count 3, took minNum across the group for price '
    + "(returning the BASE's 100 on a row labelled with the acetate) and firstDefined for CAS across "
    + 'two different registry numbers. holder_count is now the exact substance and form, related '
    + 'forms are reported separately as discovery, and supply_claim_allowed is false whenever a '
    + 'group spans forms — so the page prints two counts rather than a leverage verdict that no '
    + 'single number supports.',
  'src/lib/molecules/merge.test.js':
    'tests merge.js, so it must import what merge.js imports.',
});

// Paths under which a file is exempt entirely: the definition itself and its own tests.
const SELF_PATHS = Object.freeze([
  'src/lib/molecules/synonyms.js',
  'src/lib/molecules/synonyms.test.js',
  'src/lib/molecules/search-scope.js',
  'src/lib/molecules/search-scope.test.js',
  // The checker itself. It plants a file containing a real `require('./synonyms')` as its negative
  // control, so it detects its own template string and reports itself — which it duly did on its
  // first run. Exempting the detector is not a hole: it imports nothing at runtime, and if that
  // ever changes, the import would sit in a file whose whole purpose is to forbid it.
  'scripts/check-search-rule-scope.js',
]);

/**
 * Is this file allowed to import the search-only functions?
 * Pure, so the check and its negative control share one answer.
 */
function isAllowedCaller(repoRelativePath) {
  const p = String(repoRelativePath).replace(/^\.\//, '');
  if (SELF_PATHS.includes(p)) return { allowed: true, reason: 'the definition itself or its tests' };
  if (Object.prototype.hasOwnProperty.call(SEARCH_CALLER_ALLOWLIST, p)) {
    return { allowed: true, reason: SEARCH_CALLER_ALLOWLIST[p] };
  }
  return { allowed: false, reason: null };
}

module.exports = {
  SEARCH_ONLY_FUNCTIONS,
  SEARCH_MODULE,
  SEARCH_CALLER_ALLOWLIST,
  SELF_PATHS,
  isAllowedCaller,
};
