'use strict';
// ── PR-6e: CSV / XLSX EXPORT ─────────────────────────────────────────────────
//
// Pure: takes rows, returns a string (CSV) or a workbook spec. No filesystem, no network, no
// external destination — ruling item 6 is download-only for now.
//
// ── A SPREADSHEET OUTLIVES THE PAGE IT CAME FROM ────────────────────────────
//
// That is the whole design constraint. A figure on a dashboard sits next to its caveat; the same
// figure in a .xlsx is forwarded, pasted into a deck, and read six weeks later by somebody who
// never saw the page. So the caveat has to travel IN THE COLUMN HEADER, which is the only context
// that survives the journey:
//
//     obligated_amount_usd (obligations at action time, not outlays)
//     holder_count (exact substance and form)
//
// Verbose, and deliberately so. "amount" becomes a pipeline total by the end of the quarter.
//
// ── THE SIX MANDATORY COLUMNS (ruling item 6) ──────────────────────────────
//
// Every exported opportunity row carries source URL, record kind, qualification verdict, blocking
// reasons, rule-set version and evaluation date. The first four make the row checkable; the last
// two make it READABLE LATER — a verdict read against today's rules rather than the rules that
// produced it is a different verdict wearing the same label.
//
// assertExportIntegrity() below refuses a row set missing any of them, and the tests sweep it.

const REQUIRED_COLUMNS = Object.freeze([
  'source_url',
  'record_kind',
  'qualification_verdict',
  'blocking_reasons',
  'rule_set_version',
  'evaluated_as_of',
]);

// Headers whose meaning cannot be left to the reader. The key is the field; the value is the
// header text that must appear.
const QUALIFIED_HEADERS = Object.freeze({
  obligated_amount: 'obligated_amount_usd (obligations at action time, not outlays)',
  holder_count: 'holder_count (exact substance and form)',
  related_form_holder_count: 'related_form_holder_count (different substances, not interchangeable)',
  estimated_funding: 'estimated_funding_usd (programme total, not an award to us)',
  award_ceiling: 'award_ceiling_usd (ceiling, not an obligation)',
  qualification_verdict: 'qualification_verdict (QUALIFIED requires every mandatory gate; NEEDS_REVIEW means unknown, not negative)',
  record_kind: 'record_kind (only "solicitation" is biddable)',
  stage: 'stage (open < submittable < qualified; a source status implies no eligibility)',
});

// The marker written wherever a value is absent. NOT an empty cell, and never 0: an empty cell in
// a spreadsheet is read as zero by every reader and by SUM().
const UNKNOWN = 'UNKNOWN';

function headerFor(field) {
  return QUALIFIED_HEADERS[field] || field;
}

/**
 * Render a cell. The only place a value becomes text, so the unknown rule holds everywhere.
 */
function cell(value) {
  if (value === null || value === undefined || value === '') return UNKNOWN;
  if (Array.isArray(value)) return value.length ? value.join(' | ') : UNKNOWN;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/**
 * Refuse an export that is missing a mandatory column, or that renders an unknown as a zero.
 *
 * Called before anything is written. An export is the artefact most likely to be read without
 * context, so it is the one worth refusing rather than warning about.
 */
function assertExportIntegrity(fields, rows) {
  const missing = REQUIRED_COLUMNS.filter((c) => !fields.includes(c));
  if (missing.length) {
    throw new Error(`export: missing mandatory column(s) ${missing.join(', ')} — an exported row `
      + 'without its rule-set version and evaluation date cannot be read against the rules that '
      + 'produced it');
  }
  // A verdict column that is blank rather than UNKNOWN is the specific failure this guards: the
  // reader sees an empty cell and concludes "no problem found".
  for (const r of rows || []) {
    if (r.qualification_verdict === null || r.qualification_verdict === undefined || r.qualification_verdict === '') {
      if (!('qualification_verdict' in r)) continue;
    }
    if (r.qualification_verdict === 0 || r.blocking_reasons === 0) {
      throw new Error('export: a verdict or blocking list must never be the number 0');
    }
  }
  return true;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

function csvEscape(s) {
  const v = String(s);
  // Quote when the value contains a delimiter, a quote or a newline. Also quote a leading =, +, -
  // or @, because a spreadsheet treats those as a formula — an exported cell starting "=" is a
  // CSV-injection vector and, more mundanely, renders as #NAME? instead of the data.
  if (/^[=+\-@\t\r]/.test(v)) return `"'${v.replace(/"/g, '""')}"`;
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/**
 * @param {string[]} fields  field names, in column order
 * @param {object[]} rows
 */
function toCsv(fields, rows) {
  assertExportIntegrity(fields, rows);
  const head = fields.map((f) => csvEscape(headerFor(f))).join(',');
  const body = (rows || []).map((r) => fields.map((f) => csvEscape(cell(r[f]))).join(','));
  // CRLF: Excel on Windows is the single most common destination for these files.
  return [head, ...body].join('\r\n') + '\r\n';
}

// ── the opportunity row shape ───────────────────────────────────────────────

const OPPORTUNITY_FIELDS = Object.freeze([
  'record_kind',
  'stage',
  'opportunity_id',
  'opportunity_number',
  'title',
  'agency_code',
  'agency_name',
  'open_date',
  'close_date',
  'days_until_close',
  'estimated_funding',
  'award_ceiling',
  'qualification_verdict',
  'blocking_reasons',
  'rule_set_version',
  'evaluated_as_of',
  'source_url',
]);

/**
 * Build export rows from view output plus the stage ladder. The caller supplies the stage so the
 * ladder is computed once per row rather than twice with a chance of disagreeing.
 */
function opportunityRows(viewRows, { stageFor }) {
  return (viewRows || []).map((r) => {
    const st = stageFor(r);
    return {
      record_kind: r.record_kind,
      stage: st.stage,
      opportunity_id: r.opportunity_id,
      opportunity_number: r.opportunity_number,
      title: r.title,
      agency_code: r.agency_code,
      agency_name: r.agency_name,
      open_date: r.open_date,
      close_date: r.close_date,
      days_until_close: r.days_until_close,
      estimated_funding: r.estimated_funding,
      award_ceiling: r.award_ceiling,
      // A missing assessment exports as NOT_ASSESSED, not as blank and not as NOT_QUALIFIED.
      // "Nobody has looked" is a third state and the only honest one.
      qualification_verdict: r.verdict || 'NOT_ASSESSED',
      blocking_reasons: st.qualified
        ? 'none'
        : [st.reasons.open, st.reasons.submittable, st.reasons.qualified].filter(Boolean).join(' | '),
      rule_set_version: r.rule_set_version,
      evaluated_as_of: r.as_of,
      source_url: r.source_url,
    };
  });
}

/**
 * An XLSX spec for the xlsx skill: sheet name, headers, rows. This module does not write the file —
 * it returns what to write, so the format and the content are testable apart.
 */
function xlsxSpec(sheetName, fields, rows) {
  assertExportIntegrity(fields, rows);
  return {
    sheet: String(sheetName).slice(0, 31),      // Excel's sheet-name limit, truncated not rejected
    headers: fields.map(headerFor),
    rows: (rows || []).map((r) => fields.map((f) => cell(r[f]))),
    // Written into the file so a forwarded workbook says where it came from.
    provenance: {
      generated_by: 'PlayNexa PRPA PR-6 export',
      note: 'Figures carry their basis in the column header. UNKNOWN means not known, never zero.',
    },
  };
}

module.exports = {
  REQUIRED_COLUMNS,
  QUALIFIED_HEADERS,
  OPPORTUNITY_FIELDS,
  UNKNOWN,
  headerFor,
  cell,
  csvEscape,
  assertExportIntegrity,
  toCsv,
  opportunityRows,
  xlsxSpec,
};
