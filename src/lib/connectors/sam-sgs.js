// ── SAM.gov HARVEST, VIA THE WEB UI's OWN JSON BACKEND ───────────────────────
//
//   sam.gov/api/prod/sgs/v1/search/?index=opp&…
//
// This is NOT the documented public API. open.gsa.gov documents api.sam.gov, and every documented
// path there returns HTTP 404 with an empty body and no rate-limit headers, from two unrelated
// networks, while open.gsa.gov and api.data.gov answer normally from both. That evidence is in
// claude/sam-gov-api-unreachable-evidence-for-fsd.md and the FSD questions still stand.
//
// What this module uses instead is the JSON backend of the SAM.gov web site itself, on the sam.gov
// host. It answers 200 application/hal+json with NO API KEY.
//
// ── THE RISK, STATED PLAINLY ─────────────────────────────────────────────────
//
// An undocumented endpoint carries no compatibility promise. It can change shape, move, start
// requiring auth, or close, without notice or deprecation. The decision to depend on it anyway was
// the owner's, made 2026-11-08, because a board that fills itself is worth more to the business
// than one that waits on GSA answering a ticket.
//
// That decision is only safe with ONE property, which is the whole design of this file:
//
//   **IT MUST FAIL LOUDLY, NEVER QUIETLY.**
//
// The failure that matters is not an exception — it is a harvest that returns zero records, or
// records whose fields have been renamed to something we read as null, and a board that therefore
// looks calm and current and is neither. That is the 2026-09-30 shape: green from outside, broken
// in use. So:
//
//   · assertShape() throws on a payload that is not the shape we have measured, rather than
//     mapping unknown fields to undefined.
//   · a page that yields zero results where the index reports a non-zero total is an ERROR, not an
//     empty harvest.
//   · a record without the response-deadline key is counted and reported; if NO record on a whole
//     page has it, that is a field rename and it throws.
//
// ── WHAT IS DELIBERATELY NOT COLLECTED ───────────────────────────────────────
//
// pointOfContacts. Every notice carries a federal contracting officer's name, email and phone.
// A HOLD on sending email is weaker than it looks if the system has meanwhile assembled the list
// to send to — so the list is never assembled. toCsv() emits no contact column and there is no
// code path here that reads that field. check-release-safety-posture.js asserts this.
//
// descriptions are not collected here either: the full solicitation text is large, and the record
// carries a canonical sam.gov link so any row can be read at the source.

'use strict';

const { isoDay } = require('../office/iso-day');

const SGS_SEARCH = 'https://sam.gov/api/prod/sgs/v1/search/';

// NO Accept HEADER. This endpoint serves application/hal+json and answers HTTP 406 to a request
// that asks for application/json specifically. Measured 2026-11-08 — it cost a failed harvest run.
const HEADERS = { 'User-Agent': 'PlaybookOS/1.0 (+https://app.playnexa.ai)' };

// What Abiozen could actually bid on. Overridable so this is not a code change to retune.
const DEFAULT_NAICS = ['325412', '325411', '541380', '541714', '541715', '621511'];

// Only these can be priced and bid. Sources Sought, Presolicitation and Award Notice are
// intelligence, not solicitations — src/lib/office/qualify.js refuses to call anything else
// biddable, and ingesting them as if they were would be the product lying about its own pipeline.
const BIDDABLE_TYPES = Object.freeze(['Solicitation', 'Combined Synopsis/Solicitation']);

// The columns the tracker's importer already accepts — SAM.gov's own CSV export names, identical
// to fixtures/sam-opportunities-real-2026-11-06.csv. Harvesting into THIS rather than into a new
// record shape is deliberate: importCsv() already does header mapping, normalisation, rejection,
// deduplication on notice id, and amendment detection against what is stored. None of that is
// reimplemented here, so none of it can drift from the manual-import path.
const COLUMNS = Object.freeze([
  'NoticeId', 'Title', 'Sol#', 'Department/Ind.Agency', 'Sub-Tier', 'Office', 'PostedDate',
  'Type', 'BaseType', 'ArchiveDate', 'SetASideCode', 'SetASide', 'ResponseDeadLine', 'NaicsCode',
  'ClassificationCode', 'PopCity', 'Active', 'AwardNumber', 'Link', 'Description',
]);

class HarvestError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'HarvestError';
    this.detail = detail || null;
  }
}

/**
 * Throw unless the payload is the shape measured on 2026-11-08.
 *
 * Loud on purpose. A renamed wrapper read as undefined produces an empty harvest, and an empty
 * harvest is indistinguishable from "nothing was posted today" — which is a plausible, calm,
 * completely wrong answer.
 */
function assertShape(payload, context) {
  if (!payload || typeof payload !== 'object') {
    throw new HarvestError(`SAM.gov returned a non-object payload (${context})`);
  }
  const embedded = payload._embedded;
  if (!embedded || !Array.isArray(embedded.results)) {
    throw new HarvestError(
      `SAM.gov payload has no _embedded.results array (${context}) — the response shape has changed`,
      { keys: Object.keys(payload).slice(0, 20) });
  }
  const page = payload.page;
  if (!page || typeof page.totalElements !== 'number') {
    throw new HarvestError(
      `SAM.gov payload has no page.totalElements (${context}) — cannot tell a finished harvest from a truncated one`,
      { keys: Object.keys(payload).slice(0, 20) });
  }
  return { results: embedded.results, total: page.totalElements };
}

function orgName(hierarchy, level) {
  for (const h of hierarchy || []) if (h && h.level === level) return h.name || '';
  return '';
}

/** The deadline, preferring the timezone-correct spelling. Both are read; absence is reported. */
function deadlineOf(rec) {
  return rec.responseDateActual || rec.responseDate || '';
}

function toRow(rec) {
  const hier = rec.organizationHierarchy || [];
  const naics = rec.naics || [];
  const psc = rec.psc || [];
  const sol = rec.solicitation || {};
  const setAside = (sol.setAside && (sol.setAside.value || sol.setAside)) || '';
  const nid = rec._id;
  return {
    NoticeId: nid,
    Title: rec.title || '',
    'Sol#': String(rec.solicitationNumber || rec.cleanSolicitationNumber || '').trim(),
    'Department/Ind.Agency': orgName(hier, 1),
    'Sub-Tier': orgName(hier, 2),
    Office: orgName(hier, 3) || orgName(hier, 4),
    PostedDate: isoDay(rec.publishDate) || '',
    Type: (rec.type && rec.type.value) || '',
    BaseType: (rec.type && rec.type.value) || '',
    ArchiveDate: isoDay(rec.archiveDate) || '',
    SetASideCode: '',
    SetASide: typeof setAside === 'string' ? setAside : '',
    ResponseDeadLine: deadlineOf(rec),
    NaicsCode: (naics[0] && naics[0].code) || '',
    ClassificationCode: (psc[0] && psc[0].code) || '',
    PopCity: '',
    Active: rec.isActive ? 'Yes' : 'No',
    AwardNumber: '',
    Link: nid ? `https://sam.gov/opp/${nid}/view` : '',
    Description: '',
  };
}

function csvEscape(v) {
  return `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
}

/** Rows → the CSV text importCsv() consumes. */
function toCsv(rows) {
  const lines = [COLUMNS.map(csvEscape).join(',')];
  for (const r of rows) lines.push(COLUMNS.map((c) => csvEscape(r[c])).join(','));
  return `${lines.join('\n')}\n`;
}

async function getJson(url, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: HEADERS, signal: ctl.signal });
    if (!res.ok) {
      throw new HarvestError(`SAM.gov answered HTTP ${res.status} for ${redact(url)}`,
        { status: res.status });
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** No credential is sent to this endpoint, but keep URLs short in logs regardless. */
function redact(url) {
  return String(url).replace(/\?.*$/, '?…');
}

/**
 * Harvest currently-active biddable notices.
 *
 * @returns {{rows: object[], stats: object}}
 */
async function harvest({
  naics = DEFAULT_NAICS,
  types = BIDDABLE_TYPES,
  pageSize = 100,
  maxPagesPerNaics = 5,
  // SAM.gov's index still flags notices from 2017 and 2020 as is_active, with deadlines long
  // past. They are not opportunities, and a bid board that lists them trains the reader to skim.
  // Filtered here rather than in the UI so the count on the page means "could be responded to".
  // Set false to take everything the index calls active.
  onlyOpen = true,
  now = new Date(),
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  const seen = new Set();
  const rows = [];
  const stats = {
    naicsQueried: naics.length, pagesFetched: 0, recordsSeen: 0,
    biddable: 0, withDeadline: 0, withoutDeadline: 0, closedSkipped: 0, byNaics: {},
  };

  const isOpen = (iso) => {
    if (!iso) return false;              // no deadline → cannot be shown as respondable
    const d = new Date(iso);
    return !Number.isNaN(d.getTime()) && d.getTime() >= now.getTime();
  };

  for (const code of naics) {
    let before = seen.size;
    for (let page = 0; page < maxPagesPerNaics; page += 1) {
      const url = `${SGS_SEARCH}?index=opp&page=${page}&size=${pageSize}`
        + `&is_active=true&naics=${encodeURIComponent(code)}&sort=-modifiedDate`;
      const payload = await getJson(url, { fetchImpl });
      const { results, total } = assertShape(payload, `naics=${code} page=${page}`);
      stats.pagesFetched += 1;

      // A first page that is empty while the index claims records exist is a BROKEN HARVEST, not
      // an empty one. Reported as an error rather than quietly contributing nothing.
      if (page === 0 && results.length === 0 && total > 0) {
        throw new HarvestError(
          `SAM.gov reports ${total} records for naics ${code} but returned an empty first page`,
          { naics: code, total });
      }
      if (results.length === 0) break;

      let deadlineKeysOnPage = 0;
      for (const rec of results) {
        stats.recordsSeen += 1;
        if (deadlineOf(rec)) deadlineKeysOnPage += 1;
        const t = (rec.type && rec.type.value) || '';
        if (!types.includes(t)) continue;
        const nid = rec._id;
        if (!nid) {
          // The natural key is (company, source, notice id). Without it dedupe cannot work, so a
          // record with no id is refused rather than inserted as a perpetual duplicate.
          throw new HarvestError('a SAM.gov record arrived with no _id — the natural key for '
            + 'deduplication is absent, refusing to ingest', { title: rec.title });
        }
        if (seen.has(nid)) continue;
        const row = toRow(rec);
        if (onlyOpen && !isOpen(row.ResponseDeadLine)) { stats.closedSkipped += 1; continue; }
        seen.add(nid);
        if (row.ResponseDeadLine) stats.withDeadline += 1; else stats.withoutDeadline += 1;
        rows.push(row);
      }

      // EVERY record on a page lacking a deadline is a field rename, not data. Award notices have
      // no deadline, so one record missing it is ordinary; a whole page missing it is not.
      if (results.length >= 5 && deadlineKeysOnPage === 0) {
        throw new HarvestError(
          `no record on naics=${code} page=${page} carried responseDate or responseDateActual — `
          + 'the deadline field has been renamed; every ingested notice would be non-biddable',
          { naics: code, page, pageRecords: results.length });
      }

      if ((page + 1) * pageSize >= total) break;
    }
    stats.byNaics[code] = seen.size - before;
    log(`  naics ${code}: ${stats.byNaics[code]} biddable`);
  }

  stats.biddable = rows.length;
  rows.sort((a, b) => String(a.ResponseDeadLine).localeCompare(String(b.ResponseDeadLine)));
  return { rows, stats };
}

module.exports = {
  SGS_SEARCH, DEFAULT_NAICS, BIDDABLE_TYPES, COLUMNS, HarvestError,
  harvest, toCsv, toRow, assertShape, deadlineOf,
};
