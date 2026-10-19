// ── SUPPLIER PDF TEXT → PRODUCT ROWS ─────────────────────────────────────────
//
// Sixteen files from ten suppliers, no two laid out alike: a designed brochure from Egis, a plain
// table from Reliance, a Chinese-English export list from Kelun, a peptide list from Zhejiang.
// PDF text extraction flattens all of that into lines whose column structure is gone or scrambled.
//
// ── THE ROW IS FOUND FROM THE CAS NUMBER OUTWARD, NOT FROM THE TABLE INWARD ──
//
// Trying to detect "the table" in each layout is how a parser silently pairs row 12's name with
// row 13's number. A CAS number can be VERIFIED (see cas.js), so it is the fixed point: find the
// verified numbers, then read the name from the text around each one. A layout change moves the
// name; it cannot invent a CAS that passes a checksum.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
//
// It does not guess a product from a line with no CAS number. Peptide and custom-synthesis lists
// often carry none, and a name-only heuristic on a 40-page brochure turns headings, addresses and
// marketing copy into products. Those lines are collected SEPARATELY as `unanchored` — reported
// for a human to look at, never written as a product.
//
// Everything it does produce is `pending`. Nothing here reaches the marketplace without review:
// extraction is lossy, and a wrong CAS on a pharma listing is a different molecule, not a typo.
'use strict';

const { findCas, validCas } = require('./cas');

// Words that mean the line is furniture, not a product.
const HEADER_WORDS = /^(s\.?\s?no|sr\.?\s?no|no|item|product|products|name|product name|description|cas|cas no|cas number|category|status|remarks?|grade|page|index|contents?|tel|fax|email|address|website)\.?:?$/i;

// Labels that sit next to a CAS number and are not part of the product name.
const CAS_LABEL = /\b(cas(\s*(no|number|#))?\s*[:.]?)/ig;

// Regulatory and quality markers worth capturing — they decide whether a product is listable.
const REG_MARKERS = [
  [/\bUS\s*DMF\b|\bUSDMF\b|\bDMF\b/i, 'DMF'],
  [/\bCEP\b|\bCOS\b/i, 'CEP'],
  [/\bGMP\b/i, 'GMP'],
  [/\bUSP\b/i, 'USP'],
  [/\bEP\b(?![a-z])/i, 'EP'],
  [/\bJP\b(?![a-z])/i, 'JP'],
  [/\bBP\b(?![a-z])/i, 'BP'],
  [/\bANDA\b/i, 'ANDA'],
  [/\bwritten\s+confirmation\b|\bWC\b(?![a-z])/i, 'WC'],
];

// What kind of material it is. Order matters: "peptide API" is a peptide.
const GRADES = [
  [/\bpeptide\b/i, 'peptide'],
  [/\bintermediate\b/i, 'intermediate'],
  [/\bKSM\b|\bkey\s+starting\s+material\b/i, 'ksm'],
  [/\bimpurit(y|ies)\b|\breference\s+standard\b/i, 'impurity'],
  [/\bexcipient\b/i, 'excipient'],
  [/\bAPI\b|\bactive\s+pharmaceutical\b/i, 'api'],
];

function detect(list, text) {
  for (const [re, label] of list) if (re.test(text)) return label;
  return null;
}

function markers(text) {
  const out = [];
  for (const [re, label] of REG_MARKERS) if (re.test(text) && !out.includes(label)) out.push(label);
  return out;
}

/**
 * Clean a candidate product name.
 * Returns null when what is left is not a name — a row number, a header, a fragment.
 */
function cleanName(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(CAS_LABEL, ' ');
  // ── LEADING ROW NUMBER ────
  //
  // Two forms, and both need care because a molecule name can legitimately START with a digit:
  // 5-Fluorouracil, 6-Mercaptopurine, 2-Chloroadenosine.
  //
  //   "12." / "12)" / "(12)" / "7 )"  — a number followed by punctuation. Unambiguous.
  //   "12    Paracetamol"             — a number followed by a COLUMN GAP. Two or more spaces,
  //                                     because one space cannot be told from part of a name.
  //
  // The punctuation may be separated from the digits by whitespace, which a flattened PDF table
  // produces often: "  7 )  Atorvastatin" left a stray ")" on the front of the name.
  s = s.replace(/^\s*\(?\s*\d{1,4}\s*[).:]\s*/, ' ');
  s = s.replace(/^\s*\d{1,4}\s{2,}/, ' ');
  // Bullets, box-drawing and the pipe characters a flattened table leaves behind.
  s = s.replace(/[•·▪●○|│┃]+/g, ' ');
  // Trailing punctuation and separators.
  s = s.replace(/[\s.,;:–—-]+$/, '');
  s = s.replace(/^[\s.,;:–—-]+/, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  if (!s) return null;
  if (HEADER_WORDS.test(s)) return null;
  // A name needs letters. "2 5" and "(3)" are not products.
  const letters = (s.match(/[A-Za-zÀ-ɏ一-鿿]/g) || []).length;
  if (letters < 3) return null;
  if (s.length > 160) s = s.slice(0, 160).trim();
  return s;
}

// A line that is almost certainly not a product name, however many letters it has.
const NOISE_LINE = /@|https?:|www\.|\btel\b|\bfax\b|\bemail\b|\bcopyright\b|\ball rights reserved\b|^\s*page\s+\d+/i;

/**
 * Product rows from the text of one supplier document.
 *
 * Returns { rows, unanchored, stats }.
 *   rows       — one per verified CAS number, with the name read from around it
 *   unanchored — lines that look like they might name a product but carry no CAS. Reported for a
 *                human, never treated as products.
 */
function rowsFromText(text, opts = {}) {
  const src = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  const lines = src.split('\n');

  const rows = [];
  const seen = new Set();
  let casLines = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const hits = findCas(line);
    if (!hits.length) continue;
    casLines += 1;

    for (const hit of hits) {
      // The name normally sits before the number on the same line. Where several CAS numbers share
      // a line — a flattened two-column table — the text between the previous number and this one
      // belongs to this row.
      const prevHit = hits.filter((h) => h.index < hit.index).pop();
      const from = prevHit ? prevHit.index + prevHit.cas.length : 0;
      const before = line.slice(from, hit.index);
      const after = line.slice(hit.index + hit.cas.length);

      let name = cleanName(before);
      let confidence = 'high';
      let nameSource = 'same-line';

      // Nothing usable before the number: some layouts put the name after it, and some put it on
      // the preceding line because the PDF's text order broke the row apart.
      if (!name) {
        const fromAfter = cleanName(after.split(/\s{2,}|\t/)[0] || '');
        if (fromAfter) { name = fromAfter; nameSource = 'after-cas'; confidence = 'medium'; }
      }
      if (!name) {
        for (let back = 1; back <= 2 && i - back >= 0; back += 1) {
          const cand = lines[i - back];
          if (!cand || !cand.trim() || NOISE_LINE.test(cand)) continue;
          if (findCas(cand).length) break;      // that line is its own row
          const c = cleanName(cand);
          if (c) { name = c; nameSource = `line-${back}-above`; confidence = 'low'; break; }
        }
      }
      if (!name) { name = null; confidence = 'none'; nameSource = 'not found'; }

      // One row per (name, cas). The same product listed twice in one document is one product.
      const key = `${(name || '').toLowerCase()}|${hit.cas}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const context = `${before} ${after}`;
      rows.push({
        name,
        cas: hit.cas,
        grade: detect(GRADES, context) || detect(GRADES, src.slice(0, 2000)) || null,
        markers: markers(context),
        confidence,
        name_source: nameSource,
        line: line.trim().slice(0, 300),
        source_file: opts.file || null,
        supplier: opts.supplier || null,
      });
    }
  }

  // Lines with no CAS that might still be products — reported, never listed.
  const unanchored = [];
  const casSet = new Set(rows.map((r) => (r.name || '').toLowerCase()));
  for (const line of lines) {
    if (findCas(line).length) continue;
    if (NOISE_LINE.test(line)) continue;
    const c = cleanName(line);
    if (!c) continue;
    if (c.length < 4 || c.length > 80) continue;
    if (casSet.has(c.toLowerCase())) continue;
    // A product name is mostly one to six words. Prose is longer.
    const words = c.split(/\s+/).length;
    if (words > 6) continue;
    unanchored.push(c);
  }

  return {
    rows,
    unanchored: [...new Set(unanchored)].slice(0, 400),
    stats: {
      lines: lines.length,
      cas_lines: casLines,
      rows: rows.length,
      named: rows.filter((r) => r.name).length,
      high_confidence: rows.filter((r) => r.confidence === 'high').length,
      unanchored: unanchored.length,
    },
  };
}

/**
 * Rows from a parsed spreadsheet, given as an array of row-arrays.
 *
 * A spreadsheet keeps its columns, so this does not need the CAS anchor to find structure — but it
 * still VALIDATES any CAS it finds, because a column headed "CAS" regularly contains blanks,
 * notes and "to be confirmed".
 */
function rowsFromSheet(grid, opts = {}) {
  const rows = [];
  const seen = new Set();
  const table = (grid || []).map((r) => (r || []).map((c) => (c == null ? '' : String(c).trim())));

  // Find the header row: the first row naming something recognisable.
  let headerAt = -1;
  let cols = {};
  for (let i = 0; i < Math.min(table.length, 25); i += 1) {
    const cells = table[i].map((c) => c.toLowerCase());
    const find = (re) => cells.findIndex((c) => re.test(c));
    const name = find(/product|material|molecule|item|description|api\b/);
    const cas = find(/^cas|cas\s*(no|number|#)/);
    if (name >= 0 || cas >= 0) {
      headerAt = i;
      cols = {
        name: name >= 0 ? name : null,
        cas: cas >= 0 ? cas : null,
        grade: find(/grade|type|category/),
        status: find(/status|remark|regulatory|dmf|cep/),
        qty: find(/qty|quantity|pack|size|kg|moq/),
      };
      break;
    }
  }

  for (let i = headerAt + 1; i < table.length; i += 1) {
    const r = table[i];
    if (!r.length || !r.join('').trim()) continue;
    const joined = r.join(' ');

    let cas = null;
    if (cols.cas != null && r[cols.cas] && validCas(r[cols.cas])) cas = r[cols.cas].trim();
    if (!cas) { const f = findCas(joined); if (f.length) cas = f[0].cas; }

    let name = cols.name != null ? cleanName(r[cols.name]) : null;
    if (!name) {
      // The longest cell that is not the CAS is the best guess at the name.
      const cand = r.filter((c) => c && c !== cas).sort((a, b) => b.length - a.length)[0];
      name = cleanName(cand);
    }
    if (!name && !cas) continue;

    const key = `${(name || '').toLowerCase()}|${cas || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({
      name,
      cas,
      grade: (cols.grade >= 0 && detect(GRADES, r[cols.grade] || '')) || detect(GRADES, joined) || null,
      markers: markers(joined),
      confidence: name && cas ? 'high' : 'medium',
      name_source: 'sheet',
      line: joined.slice(0, 300),
      source_file: opts.file || null,
      supplier: opts.supplier || null,
    });
  }

  return {
    rows,
    unanchored: [],
    stats: {
      lines: table.length,
      cas_lines: rows.filter((r) => r.cas).length,
      rows: rows.length,
      named: rows.filter((r) => r.name).length,
      high_confidence: rows.filter((r) => r.confidence === 'high').length,
      unanchored: 0,
      header_row: headerAt,
    },
  };
}

module.exports = { rowsFromText, rowsFromSheet, cleanName, markers, detect, GRADES };
