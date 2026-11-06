// ── CSV IN AND OUT, FOR A FILE EXCEL OPENS CORRECTLY ─────────────────────────
//
// Ruling 21 items 1 and 3: import SAM.gov opportunities from CSV, and export CSV that "opens
// correctly in Excel" while keeping the original identifiers and source links.
//
// ── WHY THIS IS NOT `rows.map(r => r.join(','))` ─────────────────────────────
//
// Four things break a CSV in Excel, and all four turn up in federal procurement data:
//
// 1. FORMULA INJECTION. Excel evaluates a cell beginning with = + - @ or a tab/CR as a formula.
//    A solicitation titled `=cmd|' /c calc'!A1` is a real documented attack, and the data here is
//    imported from a file a third party produced. This is the one that matters: a CSV export is
//    normally thought of as inert, and it is not — handing somebody a spreadsheet that runs
//    something when opened is a code-execution path with a friendly file extension.
//    Neutralised by prefixing an apostrophe, which Excel strips on display. The stored value is
//    untouched; only the exported cell is annotated.
//
// 2. ENCODING. Agency and place names carry non-ASCII characters. Excel on Windows reads a CSV as
//    the system codepage unless there is a UTF-8 BOM, so "Peña" becomes mojibake. The BOM is
//    three bytes and is the difference between a file that opens correctly and one that looks
//    corrupted.
//
// 3. LINE ENDINGS. Excel wants CRLF. LF alone works in modern Excel and does not in older ones,
//    and this file is going to a CEO, not to a parser.
//
// 4. LONG NUMERIC IDENTIFIERS. A solicitation number like `70RDAD26Q00000012` is safe, but one
//    that is all digits — and many are — gets read as a number, loses leading zeros, and above
//    15 digits silently loses precision. Those are forced to text.
//
// ── THE PARSER ───────────────────────────────────────────────────────────────
//
// Hand-written rather than a dependency, because the input is small, the semantics must be exact
// (quoted fields containing commas and newlines are normal in solicitation descriptions), and
// adding a package to parse four columns is not a trade worth making. It follows RFC 4180: double
// quotes escape by doubling, a quoted field may contain commas and newlines.
'use strict';

const BOM = '﻿';
const CRLF = '\r\n';

// Excel's formula triggers. The tab and CR are included because a leading tab also starts a
// formula in some versions, and they are invisible in a diff.
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Parse CSV text into { headers, rows } where each row is an object keyed by header.
 * Throws on structurally broken input rather than guessing — a misparsed solicitation is worse
 * than a refused import.
 */
function parseCsv(text) {
  if (typeof text !== 'string') throw new TypeError('parseCsv needs a string');
  let s = text;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);          // tolerate an incoming BOM
  if (!s.trim()) return { headers: [], rows: [] };

  const records = [];
  let field = '';
  let record = [];
  let i = 0;
  let inQuotes = false;

  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }   // escaped quote
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') {
      if (field !== '') {
        // A quote appearing mid-field is malformed. Tolerating it means silently changing data.
        throw new Error(`malformed CSV: unexpected quote at offset ${i}`);
      }
      inQuotes = true; i += 1; continue;
    }
    if (c === ',') { record.push(field); field = ''; i += 1; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      record.push(field); field = '';
      records.push(record); record = [];
      i += 1; continue;
    }
    field += c; i += 1;
  }
  if (inQuotes) throw new Error('malformed CSV: unterminated quoted field');
  record.push(field);
  if (record.length > 1 || record[0] !== '') records.push(record);

  if (!records.length) return { headers: [], rows: [] };
  const headers = records[0].map((h) => h.trim());
  const seen = new Set();
  for (const h of headers) {
    if (!h) throw new Error('malformed CSV: a header cell is empty');
    const k = h.toLowerCase();
    if (seen.has(k)) throw new Error(`malformed CSV: duplicate header "${h}"`);
    seen.add(k);
  }

  const rows = [];
  for (let r = 1; r < records.length; r += 1) {
    const rec = records[r];
    if (rec.length === 1 && rec[0].trim() === '') continue;     // blank line
    if (rec.length !== headers.length) {
      throw new Error(
        `malformed CSV: row ${r + 1} has ${rec.length} field(s), header has ${headers.length}. `
        + 'Refusing rather than padding — a shifted row would import one column into another.');
    }
    const o = {};
    headers.forEach((h, idx) => { o[h] = rec[idx]; });
    o.__row = r + 1;
    rows.push(o);
  }
  return { headers, rows };
}

/** Make one cell safe for Excel. Returns the quoted, escaped, neutralised cell text. */
function cell(value, { forceText = false } = {}) {
  if (value === null || value === undefined) return '""';
  let v = String(value);
  // Normalise internal newlines to LF inside the quoted field; Excel handles those fine and a bare
  // CR inside a cell confuses older versions.
  v = v.replace(/\r\n|\r/g, '\n');
  let prefix = '';
  if (FORMULA_START.test(v)) prefix = "'";
  // An all-digit identifier longer than 15 characters loses precision as a number, and any
  // leading zero is dropped. Both are silent.
  else if (forceText && /^\d+$/.test(v) && (v.length > 15 || v[0] === '0')) prefix = "'";
  return `"${(prefix + v).replace(/"/g, '""')}"`;
}

/**
 * Render rows to CSV text for Excel.
 * @param {Array<{key:string,label:string,text?:boolean}>} columns
 * @param {Array<object>} rows
 */
function toExcelCsv(columns, rows) {
  if (!Array.isArray(columns) || !columns.length) throw new Error('toExcelCsv needs columns');
  const out = [columns.map((c) => cell(c.label)).join(',')];
  for (const r of rows) {
    out.push(columns.map((c) => {
      const raw = typeof c.value === 'function' ? c.value(r) : r[c.key];
      return cell(raw, { forceText: !!c.text });
    }).join(','));
  }
  // BOM + CRLF + trailing newline. All three matter; see the header comment.
  return BOM + out.join(CRLF) + CRLF;
}

/** Was this cell neutralised? Exposed so a test can assert the behaviour rather than infer it. */
function wouldNeutralise(value) {
  return FORMULA_START.test(String(value === null || value === undefined ? '' : value));
}

module.exports = { BOM, CRLF, FORMULA_START, parseCsv, cell, toExcelCsv, wouldNeutralise };
