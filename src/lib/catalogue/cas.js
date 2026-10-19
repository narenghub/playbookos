// ── CAS NUMBERS: THE ONLY RELIABLE ANCHOR IN A SUPPLIER PDF ──────────────────
//
// Thirteen of the sixteen files the CPHI suppliers sent are PDFs, and no two share a layout. Egis
// publishes a designed brochure, Reliance a plain table, Kelun a Chinese-English export list.
// Detecting "the table" in each is a losing game — a column shifts and the parser silently pairs
// the wrong name with the wrong number, which on a pharma listing means a different molecule.
//
// A CAS Registry Number does not depend on layout. It has a fixed shape — 2 to 7 digits, a dash,
// 2 digits, a dash, 1 digit — and the last digit is a CHECKSUM over the others. So a string that
// looks like a CAS number can be tested rather than assumed, and the test is cheap and exact.
//
// That matters because supplier documents are full of digit groups that match the shape and are
// not CAS numbers: phone numbers, document references, ISO dates, DMF numbers, batch codes. On a
// 40-page brochure a shape-only match would invent dozens of products. The checksum removes
// essentially all of them: a random number of this shape passes only 1 time in 10.
//
// ── THE CHECKSUM ────────────────────────────────────────────────────────────
//
// Take the digits before the final one, reverse them, multiply each by its 1-based position, sum,
// and the remainder modulo 10 is the check digit.
//
//   Aspirin, 50-78-2:   digits 5 0 7 8 → reversed 8 7 0 5
//                       8×1 + 7×2 + 0×3 + 5×4 = 8 + 14 + 0 + 20 = 42 → 42 mod 10 = 2 ✓
'use strict';

// Shape only. Validation is the caller's next step, never skipped.
// The boundaries matter: without them "12345-67-89" yields a false "2345-67-8" from the middle.
const CAS_RE = /(?<![\d-])(\d{2,7})-(\d{2})-(\d)(?![\d-])/g;

/** Does this string's final digit match the checksum over the others? */
function validCas(s) {
  const m = /^(\d{2,7})-(\d{2})-(\d)$/.exec(String(s || '').trim());
  if (!m) return false;
  const body = m[1] + m[2];
  const check = Number(m[3]);
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    // Right-most body digit has weight 1, the next 2, and so on.
    sum += Number(body[body.length - 1 - i]) * (i + 1);
  }
  return sum % 10 === check;
}

/**
 * Every CAS number in a block of text, with where it was found.
 * Returns [{ cas, index, line }] — invalid checksums are dropped, which is the point.
 */
function findCas(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  const seenAt = new Set();
  let m;
  CAS_RE.lastIndex = 0;
  while ((m = CAS_RE.exec(s)) !== null) {
    const cas = `${m[1]}-${m[2]}-${m[3]}`;
    if (!validCas(cas)) continue;
    if (seenAt.has(m.index)) continue;
    seenAt.add(m.index);
    out.push({ cas, index: m.index });
  }
  return out;
}

module.exports = { validCas, findCas, CAS_RE };
