// ── IS THIS ESTABLISHMENT EXCLUDED? ───────────────────────────────────────────
//
// `fda_establishments.exclusion_flag` is the last column of the FDA registration file. The obvious
// reading — a non-empty value means the FDA has excluded this firm — is WRONG, and it was wrong in
// a way that looked like a working safety check right up until it was run against real data:
//
//   ── what the count is actually made of ──
//     importable                             0
//     EXCLUDED, not imported             3,437   ← FDA exclusion flag
//
//   excluded firms (first few):
//     LIFEPharma FZE (ARE), CATALENT ARGENTINA S.A.I.C. (ARG), Glenmark Generics S.A. (ARG) …
//
// Every one of the 3,437 analytical laboratories in the register was discarded, and the output said
// so in a sentence that read like diligence. Catalent and Glenmark are not excluded firms; the
// column is simply populated on nearly every row, so "non-empty" matched everything.
//
// ── THE RULE NOW ──────────────────────────────────────────────────────────────
//
// A row counts as excluded only when the flag AFFIRMATIVELY SAYS SO. Anything else is reported,
// with its distinct values, rather than acted on — because the honest state is that we do not yet
// know this column's vocabulary, and a filter built on a guess about it just cost us the entire
// dataset.
//
// This is deliberately the less cautious of the two readings, and that is a judgement rather than
// an oversight. Excluding a firm that should not be excluded is invisible and total: the whole
// directory disappears and the output congratulates itself. Including one that should be excluded
// is visible at the next step — a lab is reviewed by a person before it is ever moved to 'active',
// and only an 'active' lab can receive an order. So the failure this guards is the silent one, and
// the remaining risk lands where somebody is looking.
//
// WHEN THE VOCABULARY IS KNOWN, tighten this. The census prints the distinct values; put the real
// exclusion markers in EXCLUDED_VALUES and this becomes an exact check instead of a shape-based one.

// Values that plainly assert an exclusion. Matched case-insensitively, after trimming.
const EXCLUDED_VALUES = ['Y', 'YES', 'TRUE', '1', 'EXCLUDED', 'EXCLUSION'];

/** Does this flag value affirmatively say the establishment is excluded? */
function isExcluded(value) {
  if (value == null) return false;
  const v = String(value).trim().toUpperCase();
  if (!v) return false;
  if (EXCLUDED_VALUES.includes(v)) return true;
  // A free-text value that contains the word — "EXCLUDED FROM LISTING", say. Deliberately not a
  // bare substring search for 'EXCL', which would also match an address or a firm name if this
  // column ever shifts by one.
  return /\bEXCLUD/i.test(v);
}

// The same rule as SQL, so a query and the JS cannot disagree. Takes the column expression so it
// works both bare (`exclusion_flag`) and qualified (`e.exclusion_flag`).
const excludedSql = (col = 'exclusion_flag') =>
  `(${col} IS NOT NULL AND (upper(btrim(${col})) = ANY(ARRAY['Y','YES','TRUE','1','EXCLUDED','EXCLUSION'])`
  + ` OR upper(${col}) LIKE '%EXCLUD%'))`;

const notExcludedSql = (col = 'exclusion_flag') => `NOT ${excludedSql(col)}`;

module.exports = { isExcluded, excludedSql, notExcludedSql, EXCLUDED_VALUES };
