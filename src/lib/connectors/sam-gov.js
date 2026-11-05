'use strict';
// ── SAM.GOV ADAPTER (PR-3) — PREPARED, NOT ACTIVATED ────────────────────────
//
// Ruling 7 item 1: prepare the connector, authentication configuration, quota handling, amendment
// tracking and live solicitation ingestion tests. DO NOT activate authenticated ingestion until
// credentials and authorization are confirmed.
//
// Read-only. Pure: no database, no clock, no network except through an injectable fetch. Nothing
// in this file performs a request on its own, and `fetchSearch` REFUSES to run without an
// explicitly passed key and an explicit authorization flag — see "the activation gate" below.
//
// ── THE HONEST STATUS OF EVERY SHAPE IN THIS FILE ───────────────────────────
//
// grants-gov.js says "every shape here was MEASURED against the live API". THIS FILE CANNOT SAY
// THAT. SAM.gov requires an api_key for every endpoint, no key exists, and obtaining one is the
// authorization step this ruling withholds. So the shapes below come from the published
// documentation at open.gsa.gov/api/get-opportunities-public-api/ (read 2026-11-05), and the
// documentation is demonstrably imprecise about its own API:
//
//   · the examples use /prod/ and /prodlike/ paths that do not match the stated base URLs
//   · `limit` is "No" in the parameter table and "Yes" in the OpenAPI block
//   · Example 1 shows `pointOfContact`; the field table shows `data.pointOfContact`
//   · the `type` STRINGS the response carries are never listed — only the request-side ptype codes
//   · rate limits are described as varying "based on the federal or non-federal or general roles"
//     with NO NUMBER GIVEN for any role
//
// Therefore: this connector's LOGIC is tested and provable — quota refusal, amendment detection,
// pagination, error classification, date handling. Its FIELD NAMES are not. VERIFY_ON_FIRST_CALL
// below is the explicit list of what must be confirmed against the live API the first time a key
// exists, and `assertResponseShape()` fails loudly rather than silently mapping an absent field to
// undefined.
//
// ── THE ACTIVATION GATE ─────────────────────────────────────────────────────
//
// A connector that only needs a key in the environment to start running is a connector that WILL
// start running the moment somebody sets that key for an unrelated reason. So the key is never
// read from the environment inside this module. It is passed in, alongside `authorized: true`,
// which a caller can only set deliberately. Rule 7's shape, applied here: the refusal happens
// before the request, not as an expected error from it.
//
// ── WHY AMENDMENT TRACKING LOOKS THE WAY IT DOES ────────────────────────────
//
// Documented, and it is the single most consequential fact about this API:
//
//     "The API only provides the latest active version of the opportunity. Earlier versions must
//      be retrieved from SAM.gov Data Services."
//
// There is no history array, no revision number, no amendment list. Grants.gov hands over
// opportunityHistoryDetails and we store versions from it; SAM.gov hands over a single current
// snapshot. So an amendment is not something we READ — it is something we DETECT, by comparing a
// notice against what we stored last time. If we never poll, an amendment is invisible; if we poll
// and do not diff, it is silently overwritten. `detectAmendment()` below is therefore not a
// convenience, it is the only amendment mechanism available.
//
// Two amendments matter more than the rest, and both are easy to miss in a diff of everything:
//
//   A1  THE DEADLINE MOVED. responseDeadLine changing is the amendment most likely to cost a bid.
//   A2  THE NOTICE TYPE CHANGED. `type` is the CURRENT type and `baseType` the ORIGINAL. A Sources
//       Sought that becomes a Solicitation has just become biddable, and a Solicitation that
//       becomes something else has stopped being. That transition is a biddability change, which
//       is the whole point of this product, and it is invisible unless baseType != type is read.

const SEARCH_URL = 'https://api.sam.gov/opportunities/v2/search';
// The alpha host, for tests that must not touch production. NOT the /prodlike/ path the examples
// show — those paths contradict the documented base URLs and are not used here.
const ALPHA_SEARCH_URL = 'https://api-alpha.sam.gov/opportunities/v2/search';

// ── what must be confirmed the first time a key exists ──────────────────────
//
// Each entry is a thing this connector ASSUMES. Printed by the readiness report, and the list a
// person works through on the first authenticated call. An assumption written down is a question;
// an assumption left in the code is a bug waiting for production.
const VERIFY_ON_FIRST_CALL = Object.freeze([
  'offset semantics: the docs call it a "page index starting at 0", but limit/offset APIs usually '
  + 'take a RECORD offset. If it is a record offset and we treat it as a page index, we re-read '
  + 'page 1 forever and silently ingest only the first `limit` notices. Confirm by requesting '
  + 'limit=2&offset=1 and checking whether record 2 or record 3 comes back first.',
  'the exact `type` strings returned (the docs list only request-side ptype codes). Any string not '
  + 'in SAM_NOTICE_TYPES returns null and goes to review, so an unlisted spelling is safe but noisy.',
  'whether `pointOfContact` sits at the top level or under `data.` — the page shows both.',
  'WHICH SPELLING of the deadline the API returns. The parameter table says `reponseDeadLine` (no '
  + '"s"), Example 1 says `responseDeadLine`. Both are now read and the absence of both is a loud '
  + 'failure, so this cannot silently produce a null — but the probe reports `deadlineKeySeen` and '
  + 'the losing spelling should then be dropped. Also confirm the VALUE format and timezone.',
  'the real per-day quota for this account role — the documentation gives no number for any role.',
  'whether an exhausted quota returns 429, or a 200 with an error body.',
  'whether `totalRecords` is the count for the query or for the page.',
]);

// ── authentication configuration ────────────────────────────────────────────

/**
 * Build the authenticated request, without performing it.
 *
 * THE KEY NEVER ENTERS A LOG. It goes in the query string because SAM.gov requires `api_key` as a
 * query parameter — there is no header form — which means the full URL is a secret. `redactUrl()`
 * exists because the natural thing to do with a failing request is print its URL, and doing that
 * here would paste a live credential into the container logs, a CI transcript and, if it is ever
 * copied into an issue, GitHub. Every error path in this file redacts.
 */
function buildSearchRequest(params = {}, opts = {}) {
  const key = opts.apiKey;
  if (!key || typeof key !== 'string' || !key.trim()) {
    throw new Error('sam-gov: an api_key must be passed explicitly; it is never read from the environment');
  }
  const { postedFrom, postedTo } = params;
  if (!postedFrom || !postedTo) {
    // Documented as mandatory. Catching it here turns a wasted quota call into a local throw —
    // and on an API whose quota is unknown, a wasted call is not free.
    throw new Error('sam-gov: postedFrom and postedTo are mandatory (MM/DD/YYYY)');
  }
  for (const [name, v] of [['postedFrom', postedFrom], ['postedTo', postedTo]]) {
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(v)) {
      throw new Error(`sam-gov: ${name} must be MM/DD/YYYY, got ${JSON.stringify(v)}`);
    }
  }
  if (!withinOneYear(postedFrom, postedTo)) {
    throw new Error('sam-gov: the posted date range may not exceed 1 year');
  }
  // `limit` DEFAULTS TO 1 on this API. Omitting it returns a single record, which reads exactly
  // like a query with one result — so it is always set explicitly and never left to the default.
  const limit = params.limit === undefined ? 100 : params.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(`sam-gov: limit must be an integer 1..1000, got ${JSON.stringify(limit)}`);
  }
  const offset = params.offset === undefined ? 0 : params.offset;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`sam-gov: offset must be a non-negative integer, got ${JSON.stringify(offset)}`);
  }

  const q = new URLSearchParams();
  q.set('api_key', key);
  q.set('postedFrom', postedFrom);
  q.set('postedTo', postedTo);
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  for (const [k, v] of Object.entries(params.filters || {})) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const url = `${opts.baseUrl || SEARCH_URL}?${q.toString()}`;
  return { url, method: 'GET', redacted: redactUrl(url) };
}

/** The URL with the credential removed. The ONLY form that may be logged or stored. */
function redactUrl(url) {
  return String(url).replace(/([?&]api_key=)[^&]*/gi, '$1REDACTED');
}

/** Inclusive-ish range check; the API refuses more than a year. */
function withinOneYear(fromMdY, toMdY) {
  const d = (s) => {
    const [m, dd, y] = String(s).split('/').map(Number);
    return Date.UTC(y, m - 1, dd);
  };
  const a = d(fromMdY); const b = d(toMdY);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return false;
  return (b - a) <= 366 * 864e5;
}

// ── quota handling ──────────────────────────────────────────────────────────
//
// The documentation gives NO numeric limit for any role, so the budget cannot be derived — it has
// to be told to us, and the connector must behave correctly when the real limit turns out to be
// lower than we thought. The ledger therefore refuses BEFORE a call rather than counting failures
// after, and `remaining` is UNKNOWN rather than a guess when no budget was supplied.
//
// Refusing before the call is the same rule as Rule 7: a verification must never perform the
// mutation it predicts will be refused. Here, a sync must never make the call it predicts will be
// rejected for quota — because on an API with an unknown limit, that call might be the one that
// trips a lockout rather than returning a tidy 429.

class QuotaExhausted extends Error {
  constructor(msg) { super(msg); this.name = 'QuotaExhausted'; }
}

function makeQuotaLedger(budget) {
  // budget null/undefined means UNKNOWN, not unlimited. An unknown budget permits calls but
  // reports its own ignorance, so a caller can choose to be conservative.
  const known = Number.isInteger(budget) && budget >= 0;
  let used = 0;
  return {
    get known() { return known; },
    get used() { return used; },
    get budget() { return known ? budget : 'UNKNOWN'; },
    get remaining() { return known ? Math.max(0, budget - used) : 'UNKNOWN'; },
    /** Throws BEFORE the call when the budget is known and spent. */
    charge(n = 1) {
      if (!Number.isInteger(n) || n < 1) throw new Error('charge(n): n must be a positive integer');
      if (known && used + n > budget) {
        throw new QuotaExhausted(
          `sam-gov: refusing the call — it would use ${used + n} of a ${budget}/day budget. `
          + 'The call is not attempted, so a lockout cannot be triggered by discovering the limit.',
        );
      }
      used += n;
      return known ? budget - used : 'UNKNOWN';
    },
  };
}

// ── error classification ────────────────────────────────────────────────────
//
// Documented message strings. Classified so a caller can tell apart "our request was wrong"
// (fix and retry) from "our credential is wrong" (stop, a human is needed) from "we are out of
// quota" (stop until tomorrow). Retrying an auth failure in a loop is how an API key gets blocked.
const ERROR_KINDS = Object.freeze({
  AUTH: 'auth', REQUEST: 'request', QUOTA: 'quota', SERVER: 'server', UNKNOWN: 'unknown',
});

function classifyError(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body || {});
  if (/invalid api_key|no api_key was supplied/i.test(text)) return ERROR_KINDS.AUTH;
  if (status === 401 || status === 403) return ERROR_KINDS.AUTH;
  if (status === 429 || /rate limit|quota|too many requests/i.test(text)) return ERROR_KINDS.QUOTA;
  if (/mandatory|must be|valid range|1 year/i.test(text)) return ERROR_KINDS.REQUEST;
  if (status === 400 || status === 404) return ERROR_KINDS.REQUEST;
  if (status >= 500) return ERROR_KINDS.SERVER;
  return ERROR_KINDS.UNKNOWN;
}

/** Whether a caller may retry. Auth and request errors are never retried — a human must act. */
function isRetryable(kind) {
  return kind === ERROR_KINDS.SERVER;
}

// ── response shape ──────────────────────────────────────────────────────────

/**
 * Fail loudly on an unexpected payload instead of mapping absent fields to undefined.
 *
 * Because the field names here are documented rather than measured, the likeliest failure on the
 * first real call is a renamed key — and the silent version of that failure is a database full of
 * notices whose title, deadline and type are all null, which looks like sparse data rather than a
 * broken connector.
 */
function assertResponseShape(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('sam-gov: response is not an object');
  }
  if (!Array.isArray(payload.opportunitiesData)) {
    throw new Error('sam-gov: response has no opportunitiesData array — the documented shape has '
      + `changed or the payload is an error. Keys present: ${Object.keys(payload).join(', ') || 'none'}`);
  }
  // ── IS THE DEADLINE FIELD NAME THE ONE WE THINK IT IS? ──────────────────
  //
  // Decidable here and nowhere else. The documentation gives two spellings of this field, and
  // picking the wrong one does not raise an error — it yields a null deadline, which makes
  // solicitations.response_open false for EVERY record, which reads as "nothing is biddable",
  // which is the correct output for the current pre-activation state. The product would report
  // the right answer for the wrong reason and nobody would look.
  //
  // A single notice without a deadline is ordinary (award notices have none). A response with
  // records in which NOT ONE carries either spelling means the field has been renamed again.
  if (payload.opportunitiesData.length) {
    const withKey = payload.opportunitiesData.filter(
      (n) => n && typeof n === 'object' && DEADLINE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(n, k)),
    ).length;
    if (withKey === 0) {
      const keys = Object.keys(payload.opportunitiesData[0] || {});
      throw new Error(
        `sam-gov: NOT ONE of ${payload.opportunitiesData.length} notice(s) carries either documented `
        + `spelling of the response deadline (${DEADLINE_KEYS.join(' | ')}). The field has been `
        + `renamed. Keys on the first record: ${keys.join(', ') || 'none'}. Refusing: a null deadline `
        + 'makes response_open false for every record, which is indistinguishable from the correct '
        + '"nothing is biddable" state, so this would not surface as a bug.',
      );
    }
  }
  if (payload.totalRecords !== undefined && typeof payload.totalRecords !== 'number') {
    throw new Error(`sam-gov: totalRecords is ${typeof payload.totalRecords}, expected number`);
  }
  return true;
}

/**
 * Normalise one notice. UNKNOWN is preserved as null — never '', never 0, never a guess.
 *
 * `recordKind` is deliberately NOT computed here. record-kind.js owns that mapping, returns null
 * for an unrecognised type, and the caller must send a null to review rather than defaulting. A
 * default of `solicitation` would make every new notice type biddable, which is the failure in the
 * expensive direction.
 */
// ── THE DEADLINE FIELD IS SPELLED TWO WAYS IN THE DOCUMENTATION ────────────
//
// The parameter table at open.gsa.gov spells it `reponseDeadLine` — no `s` in "response". Example 1
// on the same page spells it `responseDeadLine`. The page never reconciles them, and with no key
// there is no way to ask the API which is real.
//
// READING ONLY ONE OF THEM IS THE WORST AVAILABLE OUTCOME, and not for the obvious reason. The
// field feeds `solicitations.response_open`, a GENERATED column requiring
// `response_deadline IS NOT NULL`. Pick the wrong spelling and every deadline is null, so
// response_open is false for every record, so the product reports that NOTHING IS BIDDABLE —
// which is character-for-character the correct output for the current, pre-activation state. The
// defect would be indistinguishable from working as designed, on the one number the whole product
// exists to produce.
//
// So both spellings are read, and the ABSENCE OF BOTH KEYS is a loud failure. Note the distinction
// that makes this safe: a null VALUE is legitimate data — Example 1 itself shows
// `"responseDeadLine": null`, and notice types like an award notice have no deadline. It is the
// missing KEY that means the field name is wrong. `deadlineKeySeen` records which spelling the live
// API actually used, so the first authenticated call ANSWERS the question instead of surviving it.
const DEADLINE_KEYS = Object.freeze(['responseDeadLine', 'reponseDeadLine']);

// WHERE THE LOUD FAILURE BELONGS, AND WHY NOT HERE. The first version of this threw when a notice
// carried neither key. That was an assumption of my own dressed up as rigour: JSON APIs routinely
// omit null fields, and notice types that genuinely have no deadline — an award notice, a special
// notice — would then have been rejected as schema errors. A confident wrong refusal is not an
// improvement on a silent null.
//
// One record without a deadline is DATA. A whole response in which NOT ONE record carries either
// spelling is a FIELD NAME ERROR. Only the second is decidable, and only from the full payload, so
// it lives in assertResponseShape() below. This function stays total and reports what it saw.
function readDeadline(raw) {
  const present = DEADLINE_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(raw, k));
  if (!present.length) return { value: null, key: null };
  // If both are somehow present, the one with a value wins; ties go to the Example 1 spelling.
  const withValue = present.find((k) => raw[k] !== undefined && raw[k] !== null && raw[k] !== '');
  const key = withValue || present[0];
  return { value: raw[key], key };
}

function normalizeNotice(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('sam-gov: notice is not an object');
  const s = (v) => (v === undefined || v === null || v === '' ? null : String(v));
  const deadline = readDeadline(raw);
  return {
    noticeId: s(raw.noticeId),
    solicitationNumber: s(raw.solicitationNumber),
    title: s(raw.title),
    // CURRENT type and ORIGINAL type, both kept. Keeping only one loses the transition that
    // decides biddability — see A2 in the header.
    noticeType: s(raw.type),
    baseNoticeType: s(raw.baseType),
    postedDate: s(raw.postedDate),
    responseDeadline: s(deadline.value),
    // Which of the two documented spellings this record actually carried. Not stored with the
    // notice — reported by the readiness probe, so one authenticated call settles it permanently.
    deadlineKeySeen: deadline.key,
    naicsCode: s(raw.naicsCode),
    classificationCode: s(raw.classificationCode),
    setAside: s(raw.typeOfSetAside) || s(raw.setAside) || null,
    setAsideCode: s(raw.typeOfSetAsideDescription) || s(raw.setAsideCode) || null,
    active: raw.active === undefined ? null : /^(yes|true)$/i.test(String(raw.active)),
    archiveType: s(raw.archiveType),
    archiveDate: s(raw.archiveDate),
    organizationName: s(raw.fullParentPathName) || s(raw.organizationName) || null,
    // `uiLink` needs a contracting-officer role to open, so it is NOT the citation link we show a
    // user. links.self is the API record. Both are kept and labelled.
    uiLink: s(raw.uiLink),
    selfLink: raw.links && raw.links.self ? s(raw.links.self) : null,
    // DELIBERATELY NOT COLLECTED: pointOfContact. It carries names, emails and phone numbers of
    // federal staff. Phase 1 is read-only intelligence with no use for them, the global email HOLD
    // is standing, and assembling a list of contactable federal officers before anything is
    // authorized to contact them builds an outreach capability nobody asked for. Same decision as
    // grants-gov.js, same reasoning.
    //
    // `description` is also skipped: it is a LINK that requires the api_key appended, so fetching
    // it spends quota per notice AND puts the credential in another URL.
  };
}

// ── amendment tracking ──────────────────────────────────────────────────────

/** The fields whose change constitutes an amendment worth recording. */
const TRACKED_FIELDS = Object.freeze([
  'title', 'noticeType', 'baseNoticeType', 'responseDeadline', 'naicsCode',
  'classificationCode', 'setAside', 'setAsideCode', 'active', 'archiveType', 'archiveDate',
  'solicitationNumber',
]);

/**
 * Compare a freshly fetched notice against the stored one.
 *
 * Returns { amended, isNew, changes[], significance } where significance is:
 *   'deadline_moved'   the response deadline changed   (A1 — the amendment most likely to cost a bid)
 *   'type_changed'     the notice type changed         (A2 — a biddability transition)
 *   'withdrawn'        the notice went inactive/archived
 *   'material'         something else tracked changed
 *   'none'             nothing tracked changed
 *
 * Deadline and type are singled out rather than being two rows in a diff list, because a diff that
 * treats "the title gained a comma" and "the closing date moved three weeks earlier" as the same
 * kind of event will get both the same amount of attention, which is none.
 */
function detectAmendment(previous, current) {
  if (!current) throw new Error('detectAmendment requires the current notice');
  if (!previous) {
    return { amended: false, isNew: true, changes: [], significance: 'none' };
  }
  const changes = [];
  for (const f of TRACKED_FIELDS) {
    const a = previous[f] === undefined ? null : previous[f];
    const b = current[f] === undefined ? null : current[f];
    if (a !== b) changes.push({ field: f, from: a, to: b });
  }
  if (!changes.length) return { amended: false, isNew: false, changes: [], significance: 'none' };

  let significance = 'material';
  const changed = new Set(changes.map((c) => c.field));
  // Checked in order of consequence, most expensive first.
  if (previous.active === true && current.active === false) significance = 'withdrawn';
  else if (changed.has('responseDeadline')) significance = 'deadline_moved';
  else if (changed.has('noticeType')) significance = 'type_changed';

  return { amended: true, isNew: false, changes, significance };
}

/**
 * Did this notice's CURRENT type diverge from its ORIGINAL type?
 *
 * Answerable from a single snapshot, with no stored history — which matters because the first time
 * we ever see a notice we have nothing to diff it against, and this is the one transition we can
 * still detect on that first sighting.
 */
function typeDiverged(notice) {
  if (!notice || !notice.noticeType || !notice.baseNoticeType) {
    return { diverged: false, determinable: false, reason: 'type or baseType is UNKNOWN' };
  }
  const diverged = notice.noticeType.trim().toLowerCase() !== notice.baseNoticeType.trim().toLowerCase();
  return {
    diverged,
    determinable: true,
    reason: diverged
      ? `the notice began as "${notice.baseNoticeType}" and is now "${notice.noticeType}" — `
        + 'biddability is decided by the CURRENT type, and this transition is exactly the event '
        + 'worth watching'
      : 'the notice is still its original type',
  };
}

// ── fetch, behind the activation gate ───────────────────────────────────────

/**
 * Perform one authenticated search.
 *
 * REFUSES unless `authorized: true` is passed explicitly. The key alone is not enough, deliberately:
 * a connector that runs as soon as a key appears in the environment will run the first time anyone
 * sets that key for an unrelated reason, and ruling 7 withholds exactly that activation.
 *
 * @param {object} params   postedFrom, postedTo, limit, offset, filters
 * @param {object} opts     apiKey, authorized, quota (ledger), fetchImpl, baseUrl
 */
async function fetchSearch(params = {}, opts = {}) {
  if (opts.authorized !== true) {
    throw new Error(
      'sam-gov: REFUSED — authenticated ingestion is not activated. Pass { authorized: true } '
      + 'only once credentials AND authorization are confirmed (ruling 7 item 1). No request was made.',
    );
  }
  const req = buildSearchRequest(params, opts);
  const quota = opts.quota || makeQuotaLedger(null);
  quota.charge(1);   // BEFORE the call, so an exhausted budget never reaches the network

  const doFetch = opts.fetchImpl;
  if (typeof doFetch !== 'function') {
    throw new Error('sam-gov: fetchImpl must be injected — this module performs no I/O of its own');
  }
  const res = await doFetch(req.url, { method: 'GET' });
  const status = res && typeof res.status === 'number' ? res.status : 0;
  let body = null;
  try { body = typeof res.json === 'function' ? await res.json() : null; } catch (_) { body = null; }

  if (status !== 200) {
    const kind = classifyError(status, body);
    const err = new Error(`sam-gov: HTTP ${status} (${kind}) for ${req.redacted}`);
    err.kind = kind;
    err.retryable = isRetryable(kind);
    err.status = status;
    throw err;
  }
  assertResponseShape(body);
  return {
    totalRecords: typeof body.totalRecords === 'number' ? body.totalRecords : null,
    limit: body.limit === undefined ? null : body.limit,
    offset: body.offset === undefined ? null : body.offset,
    notices: body.opportunitiesData.map(normalizeNotice),
    quotaRemaining: quota.remaining,
    // THE ONLY ROUTE TO THE REAL QUOTA, AND IT WAS BEING THROWN AWAY.
    //
    // The documentation gives no number for this API — open.gsa.gov says only that requests "are
    // limited based on the federal or non-federal or general roles". Sibling GSA pages carrying
    // that identical sentence publish 10/day for a non-federal user; another publishes a table
    // where a non-federal personal key gets 10/day with no SAM.gov role and 1,000/day with one.
    // Those two schemes contradict each other and neither is stated to apply here.
    //
    // So the number cannot be looked up — it can only be MEASURED, and the response says it. The
    // headers are reported rather than acted on: this function does not silently reconcile a
    // header against the ledger's budget, because a budget the operator set deliberately should
    // not be widened by a header, and narrowing it is a decision with evidence attached. Read,
    // record in source_connectors.daily_call_ceiling, and stop guessing.
    rateLimit: readRateLimitHeaders(res),
  };
}

/**
 * The api.data.gov rate-limit headers, if this API sets them.
 *
 * Reported as UNKNOWN rather than as a number when absent, because "no header" means we still do
 * not know the limit — it does not mean there isn't one. SAM.gov's error strings ("No api_key was
 * supplied", "An invalid api_key was supplied") are verbatim API Umbrella strings, which is
 * suggestive that these headers exist, but no official page states that SAM.gov is behind
 * api.data.gov. Suggestive is not documented, so this reads whatever is there and claims nothing.
 */
function readRateLimitHeaders(res) {
  const get = (name) => {
    try {
      if (res && res.headers && typeof res.headers.get === 'function') return res.headers.get(name);
    } catch (_) { /* a stub response in a test need not have headers */ }
    return null;
  };
  const num = (v) => {
    if (v === null || v === undefined || v === '') return 'UNKNOWN';
    const n = Number(v);
    return Number.isFinite(n) ? n : 'UNKNOWN';
  };
  const limit = num(get('x-ratelimit-limit'));
  const remaining = num(get('x-ratelimit-remaining'));
  return {
    limit,
    remaining,
    // What a person should do with it, carried alongside so the readiness report does not have to
    // re-derive the meaning of an absent header.
    measured: limit !== 'UNKNOWN',
    note: limit === 'UNKNOWN'
      ? 'this API set no X-RateLimit-Limit header, so the real daily quota is STILL UNKNOWN and '
        + 'must be learned from a 429. Do not infer it from a sibling API\'s published table.'
      : `the account's limit is ${limit} per window as reported by the API itself — record this in `
        + 'source_connectors.daily_call_ceiling, replacing the NULL that means UNKNOWN.',
  };
}

module.exports = {
  SEARCH_URL,
  ALPHA_SEARCH_URL,
  VERIFY_ON_FIRST_CALL,
  DEADLINE_KEYS,
  ERROR_KINDS,
  TRACKED_FIELDS,
  QuotaExhausted,
  buildSearchRequest,
  redactUrl,
  withinOneYear,
  makeQuotaLedger,
  classifyError,
  isRetryable,
  assertResponseShape,
  normalizeNotice,
  readRateLimitHeaders,
  detectAmendment,
  typeDiverged,
  fetchSearch,
};
