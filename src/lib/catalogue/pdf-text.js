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
    let line = '';
    let lastY = null;
    let lastEndX = null;

    for (const item of content.items) {
      const str = item.str;
      if (str == null) continue;
      const y = item.transform[5];
      const x = item.transform[4];

      // A vertical move of more than 2 points is a new line. Superscripts and small kerning
      // adjustments sit inside that tolerance.
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        out.push(line);
        line = '';
        lastEndX = null;
      }
      lastY = y;

      // ── WHERE THE COLUMN BOUNDARY ACTUALLY LIVES ────
      //
      // The obvious approach — measure the x-gap between consecutive items — never fires, because
      // pdfjs has already FILLED each gap with a synthetic whitespace item whose width spans it.
      // So consecutive items are always adjacent, and a parser looking for gaps sees a table with
      // single spaces: "1 Paracetamol 103-90-2", in which the row number cannot be told from part
      // of the name.
      //
      // The gap is therefore read from the WIDTH OF THE SPACE ITEM. A space at 9pt is about
      // 2.5 points, so anything past 6 is at least two spaces, which is a column.
      if (/^\s*$/.test(str)) {
        if (line) line += (item.width || 0) > 6 ? '  ' : ' ';
        lastEndX = x + (item.width || 0);
        continue;
      }

      // Kept for documents that do NOT insert space items — not every producer does.
      if (lastEndX !== null && x - lastEndX > 4 && !/\s\s$/.test(line)) line += '  ';
      else if (line && !/\s$/.test(line)) line += ' ';

      line += str;
      lastEndX = x + (item.width || 0);
    }
    if (line) out.push(line);
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

module.exports = { pdfToText };
