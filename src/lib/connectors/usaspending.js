'use strict';
// ── USASPENDING ADAPTER ──────────────────────────────────────────────────────
//
// Read-only. Fetches award history and normalises it. Writes nothing itself — persistence is
// sync-run.js's job, so everything here is pure and testable without a database or a network.
//
// Every shape below was MEASURED by scripts/probe-procurement-sources.js against the live API,
// not recalled. Where the probe found a trap, the trap is handled here and named in a comment.

const AWARDS_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';

// The three codes Abiozen actually sells into. 325412 pharmaceutical preparation manufacturing,
// 325411 medicinal and botanical manufacturing, 541380 testing laboratories and services —
// the last being the LabConnect line rather than the molecule line.
const DEFAULT_NAICS = Object.freeze(['325412', '325411', '541380']);

// Contract award types. A/B/C/D are the definitive and delivery-order families. IDV types are
// deliberately excluded: an IDV is a ceiling, not an award, and mixing the two inflates every
// total. §10 draws the same line between ceilings and obligations.
const AWARD_TYPE_CODES = Object.freeze(['A', 'B', 'C', 'D']);

const FIELDS = Object.freeze([
  'Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Awarding Sub Agency',
  'NAICS', 'PSC', 'Start Date', 'End Date', 'recipient_id', 'generated_internal_id',
]);

// The API's own floor, reported in its `messages` array. Asking for earlier silently returns
// nothing useful rather than erroring.
const EARLIEST_SEARCH_DATE = '2007-10-01';

// generated_internal_id is a COMPOSITE, measured in PR-1:
//
//     CONT_AWD_<piid>_<awardingAgency>_<parentPiid | -NONE->_<parentAgency | -NONE->
//
// so the PIID alone is not a key: two awards can share a PIID and differ in agency or parent IDV.
const KEY_RE = /^(?<prefix>[A-Z]+_[A-Z]+)_(?<piid>.+?)_(?<agency>[A-Z0-9]{4})_(?<parentPiid>.+?)_(?<parentAgency>.+?)$/;

// '-NONE-' is a SENTINEL, not a value. Stored verbatim, every later join on parent_piid matches
// unrelated standalone awards. PR-1 measured 3 of 10 awards carrying it.
const SENTINELS = new Set(['-NONE-', 'NONE', '']);
const unsentinel = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return SENTINELS.has(s) ? null : s;
};

/**
 * Split a generated_internal_id into its parts.
 * Returns nulls rather than throwing on an unrecognised shape: an award whose key we cannot parse
 * is still an award worth storing under its key, and a thrown error here would abort a whole page
 * over one malformed row.
 */
function parseAwardKey(key) {
  const m = typeof key === 'string' ? key.match(KEY_RE) : null;
  if (!m) return { piid: null, awardingAgencyCode: null, parentPiid: null, parentAgencyCode: null, wellFormed: false };
  return {
    piid: unsentinel(m.groups.piid),
    awardingAgencyCode: unsentinel(m.groups.agency),
    parentPiid: unsentinel(m.groups.parentPiid),
    parentAgencyCode: unsentinel(m.groups.parentAgency),
    wellFormed: true,
  };
}

// USAspending returns ISO dates ('2026-05-22'), unlike Grants.gov's MM/DD/YYYY. Verified in PR-1.
// Anything that is not exactly an ISO date becomes NULL rather than a guess.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = (v) => (typeof v === 'string' && ISO_DATE.test(v.trim()) ? v.trim() : null);

// Award Amount is an OBLIGATION recorded at action time. It is not spend and not an outlay.
// The returned field is named obligatedAmount for that reason — see schema.js.
function toAmount(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise one API result row into the federal_awards column shape.
 * Pure. No database, no network, no clock beyond what the caller passes.
 */
function normalizeAward(row, { companyId, sourceKey = 'usaspending', syncId = null } = {}) {
  if (!row || typeof row !== 'object') throw new Error('normalizeAward: row must be an object');
  if (!companyId) throw new Error('normalizeAward: companyId is required — these rows are tenant-scoped');

  const awardKey = row.generated_internal_id || null;
  if (!awardKey) {
    // No natural key means no idempotency, which means repeated syncs would duplicate it. PR-1
    // asserted (U2) that every result carries one; if that ever stops being true the connector
    // must skip the row loudly rather than invent a key from the PIID.
    return { skip: true, reason: 'missing generated_internal_id — no natural key, cannot dedupe' };
  }

  const parts = parseAwardKey(awardKey);
  const piidField = unsentinel(row['Award ID']);

  return {
    skip: false,
    companyId,
    sourceKey,
    awardKey,
    // Prefer the explicit field; fall back to the key's slot 1 only if the field is absent.
    piid: piidField || parts.piid,
    parentPiid: parts.parentPiid,
    awardingAgencyCode: parts.awardingAgencyCode,
    awardingAgency: unsentinel(row['Awarding Agency']),
    awardingSubAgency: unsentinel(row['Awarding Sub Agency']),
    recipientName: unsentinel(row['Recipient Name']),
    // The profile key. §vendor caveat: a company appears under multiple names and UEIs, so
    // competitor rollups by name are wrong — they must go through this id.
    recipientProfileId: unsentinel(row.recipient_id),
    naicsCode: row.NAICS ? unsentinel(row.NAICS.code) : null,
    naicsDescription: row.NAICS ? unsentinel(row.NAICS.description) : null,
    pscCode: row.PSC ? unsentinel(row.PSC.code) : null,
    pscDescription: row.PSC ? unsentinel(row.PSC.description) : null,
    obligatedAmount: toAmount(row['Award Amount']),
    popStartDate: isoDate(row['Start Date']),
    popEndDate: isoDate(row['End Date']),
    sourceUrl: `https://www.usaspending.gov/award/${encodeURIComponent(awardKey)}`,
    rawJson: row,
    syncId,
    keyWellFormed: parts.wellFormed,
  };
}

/**
 * Build the request body. Separated from the fetch so a test can assert the body without a network
 * call, and so the body can be logged as evidence of exactly what was asked for.
 */
function buildRequest({ naics = DEFAULT_NAICS, from, to, limit = 100, page = 1 } = {}) {
  if (!from || !to) throw new Error('buildRequest: from and to are required');
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) throw new Error('buildRequest: dates must be YYYY-MM-DD');
  if (from < EARLIEST_SEARCH_DATE) {
    throw new Error(`buildRequest: USAspending search starts at ${EARLIEST_SEARCH_DATE}; got ${from}`);
  }
  if (from > to) throw new Error(`buildRequest: from (${from}) is after to (${to})`);
  if (limit < 1 || limit > 100) throw new Error(`buildRequest: limit must be 1..100; got ${limit}`);
  return {
    filters: {
      award_type_codes: [...AWARD_TYPE_CODES],
      naics_codes: [...naics],
      time_period: [{ start_date: from, end_date: to }],
    },
    fields: [...FIELDS],
    limit,
    page,
  };
}

/**
 * Fetch one page. Returns the parsed body plus the page cursor.
 *
 * Paging, measured in PR-1, is page_metadata.hasNext together with last_record_unique_id — not a
 * page count. A loop that stops when results.length < limit would miss a short final page and a
 * loop that runs to a guessed page total would walk off the end.
 */
async function fetchPage(body, { fetchImpl = fetch, timeoutMs = 45000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(AWARDS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await r.text();
    if (r.status !== 200) {
      // 422 carries a precise validation message; surfacing it beats a generic failure. PR-1 hit
      // exactly this when naics_codes was sent in the wrong shape.
      throw new Error(`USAspending HTTP ${r.status}: ${text.slice(0, 300)}`);
    }
    let json;
    try { json = JSON.parse(text); } catch {
      throw new Error(`USAspending returned unparseable JSON (${text.length} bytes)`);
    }
    const pm = json.page_metadata || {};
    return {
      results: Array.isArray(json.results) ? json.results : [],
      hasNext: pm.hasNext === true,
      lastRecordId: pm.last_record_unique_id ?? null,
      page: pm.page ?? body.page,
      messages: Array.isArray(json.messages) ? json.messages : [],
    };
  } finally { clearTimeout(timer); }
}

module.exports = {
  AWARDS_URL,
  DEFAULT_NAICS,
  AWARD_TYPE_CODES,
  FIELDS,
  EARLIEST_SEARCH_DATE,
  parseAwardKey,
  normalizeAward,
  buildRequest,
  fetchPage,
};
