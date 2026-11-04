// ── WHAT A FILE ACTUALLY IS, NOT WHAT IT IS CALLED ──────────────────────────
//
// Supplier attachments are classified by filename extension: `isPdf` matches `.pdf`, `isSheet`
// matches `.xlsx|.xls|.csv`, and everything else is reported as *"not a product list format"* and
// dropped. Three consequences showed up in the 4 Nov run.
//
//   1. `XNK-API-LIST-260924(2)(1).doc` from Shanxi Tongda was skipped on its extension alone.
//      A `.doc` from a Chinese supplier is often not a Word binary at all — it is frequently RTF or
//      HTML saved under that name, both of which are plain text and trivially readable. Nobody had
//      looked.
//   2. Three `.eml` attachments were skipped the same way, and they hold the most valuable evidence
//      in the mailbox: Alivus's ORIGINAL product list, forwarded as `RE: Book1.xlsx.eml`; Chieron's
//      earlier reply that we never saw; ScinoPharm's product-list website.
//   3. A `.png` from Kelun and one from Zhejiang Peptides are screenshots, correctly unreadable —
//      but indistinguishable, in the report, from the two cases above.
//
// So the extension decides nothing here. `sniff()` reads the first bytes and says what the file is.
//
// ── IT IDENTIFIES. IT DOES NOT EXTRACT. ────────────────────────────────────
//
// Deliberately. The tempting next step is a heuristic text-scraper for legacy `.doc`: walk the OLE
// container, pull printable runs, hope the table survives. On a pharma catalogue that produces
// plausible-looking garbage — a molecule name glued to the wrong CAS number is a different
// substance, and it would arrive wearing the same confidence as a clean parse.
//
// Identifying the format is cheap and certain. Deciding how to read it is a separate decision taken
// with the answer in hand, which is the same discipline that settled the PDF question: find out
// which formats arrived before writing the parser for one of them.
'use strict';

// Each entry: a magic-byte signature, what it means, and whether text can be pulled out safely.
const SIGS = [
  { magic: [0x25, 0x50, 0x44, 0x46], format: 'pdf', note: 'PDF — may still be a scan with no text layer' },
  { magic: [0x50, 0x4b, 0x03, 0x04], format: 'zip', note: 'ZIP container — xlsx, docx, pptx or an archive' },
  { magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], format: 'ole2', note: 'legacy OLE2 — .doc, .xls or .ppt' },
  { magic: [0x7b, 0x5c, 0x72, 0x74, 0x66], format: 'rtf', note: 'RTF — plain text markup, readable' },
  { magic: [0x89, 0x50, 0x4e, 0x47], format: 'png', note: 'PNG image — a screenshot; no text' },
  { magic: [0xff, 0xd8, 0xff], format: 'jpeg', note: 'JPEG image — no text' },
  { magic: [0x1f, 0x8b], format: 'gzip', note: 'gzip' },
];

const startsWith = (buf, magic) => magic.every((b, i) => buf[i] === b);

// A buffer is text when a decode round-trips and it is mostly printable. Used to catch a file whose
// extension lies — an HTML or CSV table saved as `.doc`, which is the common case from suppliers
// exporting out of an unfamiliar tool.
function looksTextual(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 4096));
  if (!head.length) return false;
  let control = 0;
  for (const b of head) {
    if (b === 0) return false;                               // a NUL means binary
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return control / head.length < 0.02;
}

function sniff(buf, filename = '') {
  if (!buf || !buf.length) {
    return { format: 'empty', readable: false, note: 'zero bytes', extension: ext(filename), mismatch: false };
  }
  for (const s of SIGS) {
    if (buf.length >= s.magic.length && startsWith(buf, s.magic)) {
      return finish(s.format, s.note, filename, s.format === 'rtf');
    }
  }
  if (looksTextual(buf)) {
    const head = buf.subarray(0, 2048).toString('utf8').trim().toLowerCase();
    if (head.startsWith('<html') || head.startsWith('<!doctype') || head.includes('<table')) {
      return finish('html', 'HTML — readable text, often a table saved under another name', filename, true);
    }
    if (/^(from|received|return-path|message-id|mime-version|subject|date):/m.test(head)) {
      return finish('rfc822', 'an EMAIL — its own attachments are inside it', filename, true);
    }
    return finish('text', 'plain text — readable', filename, true);
  }
  return finish('unknown', 'binary, no recognised signature', filename, false);
}

const ext = (f) => {
  const m = String(f || '').match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : null;
};

// What the extension CLAIMS, mapped to the format family it implies. A mismatch is the finding:
// it means the current extension-based routing sent the file to the wrong reader, or to none.
const CLAIMS = {
  pdf: ['pdf'], xlsx: ['zip'], xlsm: ['zip'], docx: ['zip'], pptx: ['zip'],
  doc: ['ole2'], xls: ['ole2'], ppt: ['ole2'],
  csv: ['text'], txt: ['text'], eml: ['rfc822'], msg: ['ole2'],
  rtf: ['rtf'], png: ['png'], jpg: ['jpeg'], jpeg: ['jpeg'], htm: ['html'], html: ['html'],
};

function finish(format, note, filename, readable) {
  const e = ext(filename);
  const expected = CLAIMS[e] || null;
  return {
    format,
    readable,
    note,
    extension: e,
    // True when the extension implies a different family from what the bytes say. Not an error —
    // it is the thing worth knowing, because it is why a file was skipped or misread.
    mismatch: Boolean(expected && !expected.includes(format)),
  };
}

module.exports = { sniff, looksTextual };
