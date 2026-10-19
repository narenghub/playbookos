// ── PDF → TEXT, WITH THE LINES PUT BACK ──────────────────────────────────────
//
// A PDF has no lines. It has glyphs at coordinates, and a text extractor that simply concatenates
// them in document order produces one run-on string in which every table row has merged into its
// neighbours. The extractor in extract.js reads a product name from the text around its CAS
// number, so losing the line boundaries loses the pairing — row 12's name attaches to row 13's
// number, which is a different molecule.
//
// So items are grouped by their Y coordinate: a jump of more than a couple of points means a new
// line. Within a line, a horizontal gap wider than a space becomes two spaces, which is what makes
// a flattened column boundary visible to the caller.
//
// ── WHY NOT pdf-parse ───────────────────────────────────────────────────────
//
// The obvious choice, and it was tried first. It is unmaintained — version 1.1.1 ships a pdfjs
// build from 2018 — and it threw "bad XRef entry" on the very first PDF put through it, one that
// poppler read without complaint. A parser that fails on a valid file is worse than no parser,
// because the failure looks like a bad document and sends you to the supplier instead of to the
// library. pdfjs-dist is Mozilla's own, is maintained, and read the same file.
//
// The "Cannot polyfill DOMMatrix" warning on load is expected and harmless: it concerns RENDERING,
// which this never does. Only the text layer is read.
'use strict';

const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

/**
 * Glyph runs → lines of text. Pure, so it can be tested without a PDF.
 *
 * ── THE MISTAKE THIS EXISTS TO RECORD ───────────────────────────────────────
 *
 * The first version put a space between every pair of adjacent items, on the reasonable-sounding
 * basis that separate items are separate words. They are not. pdfjs splits a single word into
 * several items wherever the font applies kerning, so that rule inserted spaces INSIDE words, and
 * a real supplier document came out as:
 *
 *     "Product  S tatus  US DMF Status"
 *     "1  Temozolomide  Co mmercialized  Active"
 *     "205393 - 21 - 1"
 *
 * The last line is the damaging one. That is a CAS number — 205393-21-1 — and the inserted spaces
 * stopped it matching, so an entire Reliance product list reported ZERO products while appearing
 * to parse correctly. The dump that found it showed "S tatus" and "Co mmercialized" in the same
 * output; broken words and lost CAS numbers were one bug, not two.
 *
 * The rule that works: items are CONCATENATED unless something says otherwise. A space appears
 * only where the document puts one — an explicit whitespace item, or a measurable horizontal gap.
 */
function joinItems(items) {
  const lines = [];
  let line = '';
  let lastY = null;
  let lastEndX = null;

  for (const item of items || []) {
    const str = item.str;
    if (str == null) continue;
    const y = item.transform[5];
    const x = item.transform[4];
    const size = Math.abs(item.height || item.transform[3] || 9) || 9;

    // A vertical move of more than 2 points is a new line. Superscripts and small baseline
    // adjustments sit inside that tolerance.
    if (lastY !== null && Math.abs(y - lastY) > 2) {
      lines.push(line);
      line = '';
      lastEndX = null;
    }
    lastY = y;

    // ── AN EXPLICIT WHITESPACE ITEM ────
    //
    // pdfjs FILLS the gap between table columns with a whitespace item whose width spans the gap,
    // which is why measuring the distance between consecutive items finds nothing. The column
    // width is in that item: roughly 0.3 of the font size is one space, so several times that is
    // a column boundary, and two spaces is how a column is reported to the caller.
    if (/^\s*$/.test(str)) {
      if (line) line += (item.width || 0) > size * 0.7 ? '  ' : ' ';
      lastEndX = x + (item.width || 0);
      continue;
    }

    // ── NO WHITESPACE ITEM: MEASURE ────
    //
    // Producers that do not emit space items leave a real horizontal gap instead. Anything
    // narrower than roughly a third of the font size is kerning WITHIN a word and must not become
    // a space, which is the whole lesson above.
    if (lastEndX !== null) {
      const gap = x - lastEndX;
      if (gap > size * 0.7) line += '  ';
      else if (gap > size * 0.28) line += ' ';
      // else: same word, split for kerning. Concatenate.
    }

    line += str;
    lastEndX = x + (item.width || 0);
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The text of a PDF, with line structure reconstructed from glyph positions.
 *
 * Returns { text, pages, chars, empty } — `empty` is the important one: a PDF with no text layer
 * is a scan, and the answer is OCR or typing, not a better parser. Saying so is more useful than
 * returning an empty string that reads like a parsing failure.
 */
async function pdfToText(buffer, opts = {}) {
  const maxPages = opts.maxPages || 200;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    // A supplier brochure is a document, not a web page: nothing in it should be fetched.
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;

  const pages = Math.min(doc.numPages, maxPages);
  const out = [];

  for (let p = 1; p <= pages; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    out.push(...joinItems(content.items));
    out.push('');          // a blank line between pages
  }

  const text = out.join('\n');
  const chars = text.replace(/\s/g, '').length;

  return {
    text,
    pages: doc.numPages,
    chars,
    // A handful of characters across 40 pages is a scanned document with a page-number layer.
    empty: chars < 40 * doc.numPages ? chars < 200 : false,
  };
}

module.exports = { pdfToText, joinItems };
