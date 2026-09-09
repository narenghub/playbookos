// FDA quarterly Drug Master File download + parse. Pure of DB and of process concerns, so
// BOTH the ingest (scripts/ingest-dmf.js) and the read-only matching report
// (scripts/report-dmf-matches.js) run the identical fetch and parse.
//
// The download URL is SCRAPED, never hardcoded. FDA republishes each quarter behind a fresh
// /media/<id>/download path (2Q2026 is /media/192069/), so a pinned id silently serves stale
// data forever - the request keeps returning 200.
//
// The file is XLSX and there is no xlsx dependency in this repo, so the sheet is parsed
// directly out of the zip. ~40k rows of six short text columns; the parse takes a few hundred ms.

const zlib = require('zlib');
const { normalizeMolecule } = require('./match');
const { normalize: normalizeOrg } = require('../agents/research-intelligence/normalize');

const LIST_PAGE = 'https://www.fda.gov/drugs/drug-master-files-dmfs/list-drug-master-files-dmfs';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

// ───────────────────────── link discovery ─────────────────────────

/**
 * Find the current quarterly download URL on the FDA list page.
 * Returns { url, label, currentThrough } — label is the link text ("2nd Quarter 2026").
 */
async function resolveDownloadUrl() {
  const res = await fetch(LIST_PAGE, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`FDA list page returned ${res.status}`);
  const html = await res.text();

  // The data link is a media_download entity whose text names the quarter.
  const re = /<a[^>]+href="(\/media\/\d+\/download[^"]*)"[^>]*>([^<]*Quarter[^<]*)<\/a>/gi;
  const found = [...html.matchAll(re)].map((m) => ({
    url: new URL(m[1], 'https://www.fda.gov').toString(),
    label: m[2].replace(/\s+/g, ' ').trim(),
  }));
  if (!found.length) throw new Error('No quarterly download link found on the FDA DMF page — the page layout changed.');

  // "The list is current through DMF 044443." — worth reporting alongside the file.
  const through = html.match(/current through DMF\s*(\d+)/i);
  const received = html.match(/contains DMFs received by ([^,]+),/i);
  return { ...found[0], currentThrough: through ? through[1] : null, receivedBy: received ? received[1].trim() : null };
}

// ───────────────────────── minimal XLSX reader ─────────────────────────

/** Read a stored/deflated member out of a zip buffer by name. */
function readZipMember(buf, wanted) {
  // Walk the End-Of-Central-Directory -> central directory -> local headers.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    if (name === wanted) {
      const lnLen = buf.readUInt16LE(localOff + 26);
      const leLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lnLen + leLen;
      const raw = buf.slice(start, start + compSize);
      return method === 0 ? raw : zlib.inflateRawSync(raw);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip member not found: ${wanted}`);
}

const unescapeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, '&');

/** A1 -> 0. Used only when a cell carries an explicit ref. */
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Parse the first worksheet of an XLSX buffer into an array of string arrays.
 *
 * Two things this has to get right, both of which the FDA file exercises:
 *   - shared strings: text cells hold an index into xl/sharedStrings.xml, not the text.
 *   - cells with NO `ref` attribute: positional, and a naive reader crashes on them.
 */
function readXlsx(buf) {
  const shared = [];
  try {
    const ss = readZipMember(buf, 'xl/sharedStrings.xml').toString('utf8');
    for (const si of ss.split(/<si[ >]/).slice(1)) {
      const texts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]));
      shared.push(texts.join(''));
    }
  } catch { /* a sheet with only inline strings has no sharedStrings part */ }

  const sheet = readZipMember(buf, 'xl/worksheets/sheet1.xml').toString('utf8');
  const rows = [];
  for (const rowXml of sheet.split(/<row[ >]/).slice(1)) {
    const cells = [];
    let idx = 0;
    for (const m of rowXml.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g)) {
      const attrs = m[1] || m[3] || '';
      const inner = m[2] || '';
      const refM = /r="([A-Z]+\d+)"/.exec(attrs);
      const pos = refM ? colIndex(refM[1]) : idx;
      idx = pos + 1;
      const t = /t="([^"]+)"/.exec(attrs);
      let val = '';
      if (t && t[1] === 'inlineStr') {
        val = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unescapeXml(x[1])).join('');
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (v) val = t && t[1] === 's' ? (shared[+v[1]] ?? '') : unescapeXml(v[1]);
      }
      while (cells.length < pos) cells.push('');
      cells[pos] = val;
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** Excel serial -> ISO date. Epoch is 1899-12-30 (Excel's 1900 leap-year bug). */
function excelDate(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = Date.UTC(1899, 11, 30) + n * 86400000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}


/**
 * Download the current quarterly file and parse it into ingest-ready rows.
 * Returns { rows, meta }. Never writes anything.
 */
async function fetchAndParseDmf() {
  const link = await resolveDownloadUrl();
  const res = await fetch(link.url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`download returned ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const sheetRows = readXlsx(buf);
  const header = sheetRows[0].map((h) => h.trim().toUpperCase());
  const need = ['DMF#', 'STATUS', 'TYPE', 'SUBMIT DATE', 'HOLDER', 'SUBJECT'];
  const col = {};
  for (const h of need) {
    const i = header.indexOf(h);
    if (i < 0) throw new Error(`column "${h}" missing - FDA changed the file layout. Got: ${header.join(', ')}`);
    col[h] = i;
  }

  // source_file: the quarter tag the FDA stamps on the worksheet ("2Q2026-EXCEL"); fall back
  // to the link label if the sheet name is ever absent.
  let sourceFile = link.label;
  try {
    const wb = readZipMember(buf, 'xl/workbook.xml').toString('utf8');
    const m = /<sheet[^>]*name="([^"]+)"/.exec(wb);
    if (m) sourceFile = m[1];
  } catch { /* keep the label */ }

  const rows = [];
  for (const r of sheetRows.slice(1)) {
    const dmfNumber = parseInt(String(r[col['DMF#']] || '').trim(), 10);
    const holder = String(r[col.HOLDER] || '').trim();
    const subject = String(r[col.SUBJECT] || '').trim();
    if (!Number.isFinite(dmfNumber) || !holder || !subject) continue; // a handful of blank rows
    rows.push({
      dmf_number: dmfNumber,
      status: String(r[col.STATUS] || '').trim() || null,
      dmf_type: String(r[col.TYPE] || '').trim() || null,
      submit_date: excelDate(r[col['SUBMIT DATE']]),
      holder,
      subject,
      holder_normalized: normalizeOrg(holder),
      subject_normalized: normalizeMolecule(subject),
      source_file: sourceFile,
    });
  }

  return {
    rows,
    meta: {
      ...link,
      sourceFile,
      bytes: buf.length,
      skipped: sheetRows.length - 1 - rows.length,
    },
  };
}

module.exports = { LIST_PAGE, resolveDownloadUrl, readXlsx, readZipMember, excelDate, fetchAndParseDmf };
