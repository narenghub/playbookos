'use strict';
// ── GRANTS.GOV ADAPTER ───────────────────────────────────────────────────────
//
// Read-only. Pure: no database, no clock, no network except through an injectable fetch.
//
// Every shape here was MEASURED against the live API on 2026-11-05, because the published api-guide
// documents one request field and no response at all. Authentication is not required for either
// endpoint, and a staging host exists.
//
// ── THIS IS A FUNDING SOURCE, NOT A PROCUREMENT SOURCE ───────────────────────
//
// Ruling 2: grant opportunities are preserved separately from procurement contracts and revenue.
// So these rows land in funding_opportunities, never in the procurement tables, and never in a
// revenue figure. `fundingInstruments` does include "Procurement Contract" (PC) for a minority of
// records — that does NOT move them. A grant-funded procurement contract reached through
// Grants.gov is still a Grants.gov record, and the one thing that must never happen is a number
// from this source appearing in a procurement pipeline total.
//
// ── FOUR TRAPS THIS API SETS, ALL MEASURED ───────────────────────────────────
//
// T1  THREE DATE FORMATS, in one API:
//       search2 oppHits.closeDate   "11/17/2026"                     MM/DD/YYYY
//       detail  responseDate        "Nov 17, 2026 12:00:00 AM EST"   US long + tz abbreviation
//       detail  responseDateStr     "2026-11-17-00-00-00"            Y-M-D-H-M-S
//     Only the *Str variant is machine-safe. Date.parse of a tz ABBREVIATION is
//     implementation-defined, and "EST"/"EDT" is exactly the kind of thing that parses on one
//     runtime and shifts a day on another. So the *Str field is preferred and the display variants
//     are never parsed.
//
// T2  AMOUNTS ARE STRINGS, WITH COMMA-FORMATTED TWINS:
//       estimatedFunding           "30000000"
//       estimatedFundingFormatted  "30,000,000"
//     parseInt("30,000,000") is 30. Reading the Formatted twin by mistake understates the figure by
//     a factor of a million and raises no error. parseAmount below REFUSES a value containing a
//     comma rather than parsing it, so the mistake is loud.
//
// T3  THE CURRENT REVISION IS NOT IN THE HISTORY ARRAY. For opportunity 359966,
//     data.revision = 6 while opportunityHistoryDetails carries revisions 0..5. A connector that
//     reads only the history array silently omits the live version — the one that matters.
//
// T4  A FORECAST IS NOT A SOLICITATION. docType 'forecast' / oppStatus 'forecasted' means a plan,
//     and 5 of 10 hits in the first probe were forecasts with an empty closeDate. Empty is not
//     "no deadline, apply anytime". Biddability is therefore DERIVED in the schema (a generated
//     column), not a field any caller can set.
//
// ── WHAT THIS DELIBERATELY DOES NOT COLLECT ──────────────────────────────────
//
// The detail payload carries synopsis.agencyContactEmail, agencyContactName and
// agencyContactPhone. They are not extracted. Phase 1 is read-only intelligence and has no use for
// them; the use is §8 proposal packaging, which is Phase 3 and behind its own ruling. Collecting a
// list of live federal contact addresses before anything is authorized to use it builds an
// outreach capability nobody asked for, under a standing global email HOLD. When Phase 3 is
// authorized, this is one field to add — not a decision to revisit.

const SEARCH_URL = 'https://api.grants.gov/v1/api/search2';
const DETAIL_URL = 'https://api.grants.gov/v1/api/fetchOpportunity';
// The staging host, for test runs that must not touch the production service.
const STAGING_SEARCH_URL = 'https://api.staging.grants.gov/v1/api/search2';

// ── T1: dates ───────────────────────────────────────────────────────────────

const MDY = /^(\d{2})\/(\d{2})\/(\d{4})$/;              // search2:  11/17/2026
const YMDHMS = /^(\d{4})-(\d{2})-(\d{2})(?:-\d{2}){0,3}$/; // detail: 2026-11-17-00-00-00

/**
 * Parse a Grants.gov date to an ISO calendar date, or null.
 *
 * Accepts only the two machine-safe shapes. The US long form
 * ("Nov 17, 2026 12:00:00 AM EST") is REFUSED rather than parsed: its timezone abbreviation is not
 * reliably interpreted, and every field that carries it has a *Str twin that is unambiguous.
 * Returning null for an unrecognised shape is deliberate — a guessed date on a submission deadline
 * is worse than a missing one.
 */
function parseGrantsDate(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(YMDHMS);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(MDY);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return null;
}

/** True when the value is the US long display form, whose *Str twin should be used instead. */
function isDisplayDate(v) {
  return typeof v === 'string' && /^[A-Z][a-z]{2} \d{2}, \d{4}/.test(v.trim());
}

/**
 * Prefer the *Str field; fall back to the plain field only if it is already machine-safe.
 * Never parses the display form.
 */
function pickDate(obj, base) {
  if (!obj) return null;
  const str = parseGrantsDate(obj[`${base}Str`]);
  if (str) return str;
  const plain = obj[base];
  if (isDisplayDate(plain)) return null;   // the *Str twin was absent or unusable; do not guess
  return parseGrantsDate(plain);
}

// ── T2: amounts ─────────────────────────────────────────────────────────────

/**
 * Parse an amount that arrives as a string.
 *
 * Throws on a comma, because a comma means the caller reached for the *Formatted twin:
 * parseInt("30,000,000") is 30, a factor-of-a-million understatement that raises no error. Making
 * it throw turns a silent wrong number into a loud wrong field name.
 */
function parseAmount(v, field = 'amount') {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (s.includes(',')) {
    throw new Error(`parseAmount(${field}): "${s}" contains a comma — this is the *Formatted display `
      + 'twin. Read the unformatted field instead; parsing this would understate the figure.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ── T4: biddability ────────────────────────────────────────────────────────

const LIVE_STATUSES = new Set(['posted']);
const PLAN_DOC_TYPES = new Set(['forecast']);

/**
 * Classify an opportunity's standing. Returned for reporting; the authoritative value is the
 * generated column in the schema, so nothing downstream can assert biddability by writing it.
 */
function classifyStanding({ oppStatus, docType, closeDate }) {
  const status = (oppStatus || '').toLowerCase();
  const dt = (docType || '').toLowerCase();
  if (PLAN_DOC_TYPES.has(dt) || status === 'forecasted') return 'forecast';
  if (status === 'closed') return 'closed';
  if (status === 'archived') return 'archived';
  if (LIVE_STATUSES.has(status) && closeDate) return 'open';
  if (LIVE_STATUSES.has(status) && !closeDate) return 'posted_no_deadline';
  return 'unknown';
}

// ── normalisation ──────────────────────────────────────────────────────────

/**
 * Normalise one search hit. The search result is the cheap, broad record; the detail call adds
 * revisions and the synopsis.
 */
function normalizeSearchHit(hit, { companyId, sourceKey = 'grants_gov' } = {}) {
  if (!hit || typeof hit !== 'object') throw new Error('normalizeSearchHit: hit must be an object');
  if (!companyId) throw new Error('normalizeSearchHit: companyId is required — these rows are tenant-scoped');
  const oppId = hit.id == null ? null : String(hit.id).trim();
  if (!oppId) {
    return { skip: true, reason: 'missing oppHits[].id — no natural key, cannot dedupe' };
  }
  const closeDate = parseGrantsDate(hit.closeDate);
  return {
    skip: false,
    companyId,
    sourceKey,
    opportunityId: oppId,
    opportunityNumber: hit.number ? String(hit.number).trim() : null,
    title: hit.title || null,
    agencyCode: hit.agencyCode || null,
    agencyName: hit.agency || null,
    openDate: parseGrantsDate(hit.openDate),
    closeDate,
    oppStatus: hit.oppStatus || null,
    docType: hit.docType || null,
    standing: classifyStanding({ oppStatus: hit.oppStatus, docType: hit.docType, closeDate }),
    cfdaList: Array.isArray(hit.cfdaList) ? hit.cfdaList.slice() : [],
    sourceUrl: `https://www.grants.gov/search-results-detail/${encodeURIComponent(oppId)}`,
    rawJson: hit,
  };
}

/**
 * Normalise the detail payload, including the full revision chain.
 *
 * T3: the chain is opportunityHistoryDetails (revisions 0..n-1) PLUS the current data.revision.
 * Reading only the array omits the live version.
 */
function normalizeDetail(payload, { companyId, sourceKey = 'grants_gov' } = {}) {
  if (!companyId) throw new Error('normalizeDetail: companyId is required');
  const d = (payload && payload.data) || payload;
  if (!d || d.id == null) throw new Error('normalizeDetail: payload carries no data.id');

  const syn = d.synopsis || {};
  const closeDate = pickDate(syn, 'responseDate');

  const history = Array.isArray(d.opportunityHistoryDetails) ? d.opportunityHistoryDetails : [];
  const versions = history.map((h) => ({
    revision: Number(h.revision),
    isCurrent: false,
    title: h.opportunityTitle || null,
    opportunityNumber: h.opportunityNumber || null,
    modifiedFields: Array.isArray(h.synopsisModifiedFields) ? h.synopsisModifiedFields.slice() : [],
    closeDate: pickDate(h.synopsis || {}, 'responseDate'),
    rawJson: h,
  }));

  // The current revision, which the history array does not contain.
  const currentRevision = Number(d.revision);
  if (Number.isFinite(currentRevision) && !versions.some((v) => v.revision === currentRevision)) {
    versions.push({
      revision: currentRevision,
      isCurrent: true,
      title: d.opportunityTitle || null,
      opportunityNumber: d.opportunityNumber || null,
      modifiedFields: Array.isArray(d.synopsisModifiedFields) ? d.synopsisModifiedFields.slice() : [],
      closeDate,
      rawJson: { revision: currentRevision, modifiedComments: d.modifiedComments || null },
    });
  } else if (Number.isFinite(currentRevision)) {
    // The history already held it. Mark which one is current rather than adding a duplicate.
    const hit = versions.find((v) => v.revision === currentRevision);
    if (hit) hit.isCurrent = true;
  }
  versions.sort((a, b) => a.revision - b.revision);

  return {
    companyId,
    sourceKey,
    opportunityId: String(d.id),
    opportunityNumber: d.opportunityNumber || null,
    title: d.opportunityTitle || null,
    agencyCode: d.owningAgencyCode || null,
    agencyName: (d.agencyDetails && d.agencyDetails.agencyName) || null,
    docType: d.docType || null,
    // `ost` is the authoritative status on the detail payload ("POSTED"), lower-cased to match the
    // search result's vocabulary rather than introducing a second one.
    oppStatus: d.ost ? String(d.ost).toLowerCase() : null,
    category: (d.opportunityCategory && d.opportunityCategory.description) || null,
    openDate: pickDate(syn, 'postingDate'),
    closeDate,
    archiveDate: pickDate(syn, 'archiveDate'),
    standing: classifyStanding({ oppStatus: d.ost, docType: d.docType, closeDate }),
    estimatedFunding: parseAmount(syn.estimatedFunding, 'estimatedFunding'),
    awardCeiling: parseAmount(syn.awardCeiling, 'awardCeiling'),
    awardFloor: parseAmount(syn.awardFloor, 'awardFloor'),
    costSharing: typeof syn.costSharing === 'boolean' ? syn.costSharing : null,
    cfdaList: Array.isArray(d.cfdas)
      ? d.cfdas.map((c) => c.cfdaNumber).filter(Boolean)
      : [],
    currentRevision: Number.isFinite(currentRevision) ? currentRevision : null,
    versions,
    sourceUrl: `https://www.grants.gov/search-results-detail/${encodeURIComponent(String(d.id))}`,
    rawJson: d,
  };
}

// ── requests ───────────────────────────────────────────────────────────────

function buildSearchRequest({ keyword, rows = 25, startRecordNum = 0, oppStatuses, agencies, cfda } = {}) {
  if (!keyword || !String(keyword).trim()) throw new Error('buildSearchRequest: keyword is required');
  if (rows < 1 || rows > 1000) throw new Error(`buildSearchRequest: rows must be 1..1000; got ${rows}`);
  if (startRecordNum < 0) throw new Error('buildSearchRequest: startRecordNum must be >= 0');
  const body = { keyword: String(keyword).trim(), rows, startRecordNum };
  // Only send a filter the caller actually set. The API fills its own defaults
  // (oppStatuses "forecasted|posted") and echoes them in data.searchParams, which is how a sync
  // can record what it really asked for rather than what it meant to ask for.
  if (oppStatuses) body.oppStatuses = oppStatuses;
  if (agencies) body.agencies = agencies;
  if (cfda) body.cfda = cfda;
  return body;
}

async function post(url, body, { fetchImpl = fetch, timeoutMs = 45000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await r.text();
    if (r.status !== 200) throw new Error(`Grants.gov HTTP ${r.status}: ${text.slice(0, 300)}`);
    let json;
    try { json = JSON.parse(text); } catch {
      throw new Error(`Grants.gov returned unparseable JSON (${text.length} bytes)`);
    }
    // errorcode 0 / "Webservice Succeeds" is the success envelope. A non-zero errorcode arrives
    // with HTTP 200, so trusting the status code alone would read a failure as a result.
    if (json.errorcode !== 0) {
      throw new Error(`Grants.gov errorcode ${json.errorcode}: ${json.msg || '(no message)'}`);
    }
    return json;
  } finally { clearTimeout(timer); }
}

async function fetchSearch(body, { staging = false, ...opts } = {}) {
  const json = await post(staging ? STAGING_SEARCH_URL : SEARCH_URL, body, opts);
  const d = json.data || {};
  return {
    hits: Array.isArray(d.oppHits) ? d.oppHits : [],
    hitCount: typeof d.hitCount === 'number' ? d.hitCount : null,
    // What the server says it searched for, which may differ from what we sent.
    searchParams: d.searchParams || null,
  };
}

async function fetchDetail(opportunityId, opts = {}) {
  // Measured: the undocumented signature is {opportunityId: <number>}. A numeric string is coerced
  // on purpose, because the search response returns ids as strings ("359966") and refusing them
  // would make every caller convert. Anything that is not an integer is refused: Number('abc') is
  // NaN, and NaN serialises to null, which asks the API about no opportunity in particular.
  //
  // The empty string is refused separately, because Number('') is 0 — an integer, and a
  // plausible-looking id. A missing id would otherwise become a request about opportunity 0.
  const t = typeof opportunityId;
  const blank = t === 'string' && !opportunityId.trim();
  const id = (!blank && (t === 'string' || t === 'number')) ? Number(opportunityId) : NaN;
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`fetchDetail: opportunityId must be an integer; got ${JSON.stringify(opportunityId)}`);
  }
  return post(DETAIL_URL, { opportunityId: id }, opts);
}

module.exports = {
  SEARCH_URL,
  DETAIL_URL,
  STAGING_SEARCH_URL,
  parseGrantsDate,
  isDisplayDate,
  pickDate,
  parseAmount,
  classifyStanding,
  normalizeSearchHit,
  normalizeDetail,
  buildSearchRequest,
  fetchSearch,
  fetchDetail,
};
