// ── THE FOUR TRAPS GRANTS.GOV SETS ──────────────────────────────────────────
//
//   node --test src/lib/connectors/grants-gov.test.js
//
// Fixtures are verbatim values from the live API on 2026-11-05 (opportunity 359966, NSF TTP), not
// values written to match the parser. The api-guide documents one request field and no response at
// all, so every shape here had to be measured — and four of them are traps that produce a WRONG
// answer rather than an empty one:
//
//   T1  three date formats in one API, one of which must not be parsed at all
//   T2  amounts are strings, each with a comma-formatted twin that parses to a thousandth or less
//   T3  the current revision is absent from the history array
//   T4  a forecast is a plan, and an empty close date is not "apply anytime"
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const {
  parseGrantsDate, isDisplayDate, pickDate, parseAmount, classifyStanding,
  normalizeSearchHit, normalizeDetail, buildSearchRequest, fetchSearch, fetchDetail,
} = require('./grants-gov');

const CO = 'company-abiozen';

// Verbatim search hits: one posted synopsis, one forecast with an empty close date.
const POSTED_HIT = {
  id: '359966',
  number: '25-540',
  title: 'National Science Foundation Translation to Practice (NSF TTP)',
  agencyCode: 'NSF',
  agency: 'U.S. National Science Foundation',
  openDate: '07/09/2025',
  closeDate: '11/17/2026',
  oppStatus: 'posted',
  docType: 'synopsis',
  cfdaList: ['47.041', '47.076'],
};

const FORECAST_HIT = {
  id: '336962',
  number: 'FA8651-22-S0021',
  title: 'Partnership Intermediary Agreement (PIA)',
  agencyCode: 'DOD-AFRL-RW',
  agency: 'Munitions Directorate',
  openDate: '12/14/2021',
  closeDate: '',
  oppStatus: 'forecasted',
  docType: 'forecast',
  cfdaList: ['12.630'],
};

// Verbatim detail payload, trimmed to the fields the adapter reads. data.revision is 6 while the
// history array carries 0..5 — T3.
const DETAIL = {
  errorcode: 0,
  msg: 'Webservice Succeeds',
  data: {
    id: 359966,
    revision: 6,
    opportunityNumber: '25-540',
    opportunityTitle: 'National Science Foundation Translation to Practice (NSF TTP)',
    owningAgencyCode: 'NSF',
    docType: 'synopsis',
    ost: 'POSTED',
    modifiedComments: 'Updated Synopsis via NSF Grants Opportunity Sync',
    synopsisModifiedFields: ['revision', 'version', 'responseDate', 'createTimeStamp'],
    opportunityCategory: { category: 'D', description: 'Discretionary' },
    agencyDetails: { code: 'NSF', agencyName: 'U.S. National Science Foundation' },
    synopsis: {
      responseDate: 'Nov 17, 2026 12:00:00 AM EST',
      responseDateStr: '2026-11-17-00-00-00',
      postingDate: 'Jul 09, 2025 12:00:00 AM EDT',
      postingDateStr: '2025-07-09-00-00-00',
      archiveDate: 'Jun 17, 2027 12:00:00 AM EDT',
      archiveDateStr: '2027-06-17-00-00-00',
      estimatedFunding: '30000000',
      estimatedFundingFormatted: '30,000,000',
      awardCeiling: '2000000',
      awardCeilingFormatted: '2,000,000',
      awardFloor: '600000',
      costSharing: false,
      agencyContactEmail: 'someone@nsf.gov',
      agencyContactName: 'A Person',
    },
    cfdas: [{ cfdaNumber: '47.041', programTitle: 'Engineering' }, { cfdaNumber: '47.076' }],
    opportunityHistoryDetails: [0, 1, 2, 3, 4, 5].map((r) => ({
      revision: r,
      opportunityNumber: '25-540',
      opportunityTitle: 'National Science Foundation Translation to Practice',
      synopsisModifiedFields: r === 0 ? [] : ['revision', 'version', 'responseDate'],
      synopsis: { responseDateStr: '2026-11-17-00-00-00' },
    })),
  },
};

// ── T1: dates ───────────────────────────────────────────────────────────────

test('T1 the two machine-safe formats parse; MM/DD/YYYY is not read as DD/MM', () => {
  assert.equal(parseGrantsDate('2026-11-17-00-00-00'), '2026-11-17');
  assert.equal(parseGrantsDate('11/17/2026'), '2026-11-17');
  // 11/17 cannot be a day-first date, but 07/09 can, and getting it wrong is silent.
  assert.equal(parseGrantsDate('07/09/2025'), '2025-07-09', 'July 9th, not September 7th');
});

test('T1 the US long display form is REFUSED, not parsed', () => {
  assert.ok(isDisplayDate('Nov 17, 2026 12:00:00 AM EST'));
  assert.strictEqual(parseGrantsDate('Nov 17, 2026 12:00:00 AM EST'), null,
    'a timezone abbreviation is implementation-defined; EST/EDT parses on one runtime and shifts a day on another');
});

test('T1 pickDate prefers the *Str twin over the display form', () => {
  const got = pickDate(DETAIL.data.synopsis, 'responseDate');
  assert.equal(got, '2026-11-17');
});

test('T1 with no *Str twin and only a display form, pickDate returns null rather than guessing', () => {
  assert.strictEqual(pickDate({ responseDate: 'Nov 17, 2026 12:00:00 AM EST' }, 'responseDate'), null);
  // A guessed submission deadline is worse than a missing one: a missing one stops the pipeline,
  // a wrong one sends a proposal a day late.
});

test('T1 unrecognised and empty values are null, not NaN or Invalid Date', () => {
  for (const v of [null, undefined, '', '  ', 'next Tuesday', '2026/11/17', '17-11-2026']) {
    assert.strictEqual(parseGrantsDate(v), null, `${JSON.stringify(v)} should be null`);
  }
});

// ── T2: amounts ─────────────────────────────────────────────────────────────

test('T2 the unformatted amount parses to the real figure', () => {
  assert.equal(parseAmount('30000000'), 30000000);
  assert.equal(parseAmount('600000'), 600000);
  assert.strictEqual(parseAmount(''), null);
  assert.strictEqual(parseAmount(null), null);
});

test('T2 the comma-formatted twin THROWS rather than parsing to a thousandth', () => {
  // parseInt("30,000,000") is 30. Number("30,000,000") is NaN. Either way, reading the Formatted
  // field is a wrong number or a silent null, and nothing in the response marks which field is which.
  assert.equal(Number.parseInt('30,000,000', 10), 30, 'this is what the trap actually produces');
  assert.throws(() => parseAmount('30,000,000', 'estimatedFunding'),
    /contains a comma.*Formatted display/s);
});

test('T2 the detail normaliser reads the unformatted fields', () => {
  const n = normalizeDetail(DETAIL, { companyId: CO });
  assert.equal(n.estimatedFunding, 30000000);
  assert.equal(n.awardCeiling, 2000000);
  assert.equal(n.awardFloor, 600000);
  assert.strictEqual(n.costSharing, false, 'costSharing is a real boolean, unlike every amount');
});

// ── T3: the revision chain ──────────────────────────────────────────────────

test('T3 the chain is the history array PLUS the current revision the API omits from it', () => {
  const n = normalizeDetail(DETAIL, { companyId: CO });
  assert.equal(n.currentRevision, 6);
  assert.deepEqual(n.versions.map((v) => v.revision), [0, 1, 2, 3, 4, 5, 6],
    'the API returned 0..5 in opportunityHistoryDetails and 6 in data.revision');
  const current = n.versions.filter((v) => v.isCurrent);
  assert.equal(current.length, 1, 'exactly one current revision');
  assert.equal(current[0].revision, 6);
});

test('T3 when the history already contains the current revision, it is marked not duplicated', () => {
  const d = JSON.parse(JSON.stringify(DETAIL));
  d.data.revision = 5;                      // already present in history
  const n = normalizeDetail(d, { companyId: CO });
  assert.deepEqual(n.versions.map((v) => v.revision), [0, 1, 2, 3, 4, 5]);
  assert.equal(n.versions.filter((v) => v.isCurrent).length, 1);
  assert.equal(n.versions.find((v) => v.isCurrent).revision, 5);
});

test('T3 what changed in a revision is preserved', () => {
  const n = normalizeDetail(DETAIL, { companyId: CO });
  assert.deepEqual(n.versions.find((v) => v.revision === 0).modifiedFields, []);
  assert.ok(n.versions.find((v) => v.revision === 3).modifiedFields.includes('responseDate'),
    'a changed response date is the amendment that matters most');
});

test('T3 a payload with no history still yields the current revision', () => {
  const d = { data: { id: 1, revision: 0, docType: 'synopsis', ost: 'POSTED', synopsis: {} } };
  const n = normalizeDetail(d, { companyId: CO });
  assert.deepEqual(n.versions.map((v) => v.revision), [0]);
  assert.equal(n.versions[0].isCurrent, true);
});

// ── T4: forecasts are not biddable ──────────────────────────────────────────

test('T4 a forecast is classified as a plan, never as open', () => {
  const n = normalizeSearchHit(FORECAST_HIT, { companyId: CO });
  assert.equal(n.standing, 'forecast');
  assert.strictEqual(n.closeDate, null, 'an empty closeDate string becomes null');
});

test('T4 a posted hit with a deadline is open', () => {
  const n = normalizeSearchHit(POSTED_HIT, { companyId: CO });
  assert.equal(n.standing, 'open');
  assert.equal(n.closeDate, '2026-11-17');
});

test('T4 posted with NO deadline gets its own standing, not "open"', () => {
  const n = normalizeSearchHit({ ...POSTED_HIT, closeDate: '' }, { companyId: CO });
  assert.equal(n.standing, 'posted_no_deadline',
    'an empty close date is not "no deadline, apply anytime" — it is a fact we do not have');
});

test('T4 docType forecast wins even if the status says posted', () => {
  assert.equal(classifyStanding({ oppStatus: 'posted', docType: 'forecast', closeDate: '2026-01-01' }), 'forecast');
});

test('T4 an unknown status is "unknown", never a default of open', () => {
  assert.equal(classifyStanding({ oppStatus: 'something-new', docType: 'synopsis', closeDate: '2026-01-01' }), 'unknown');
  assert.equal(classifyStanding({}), 'unknown');
});

test('T4 closed and archived keep their own standings', () => {
  assert.equal(classifyStanding({ oppStatus: 'closed', docType: 'synopsis' }), 'closed');
  assert.equal(classifyStanding({ oppStatus: 'archived', docType: 'synopsis' }), 'archived');
});

// ── identity, provenance and data minimisation ──────────────────────────────

test('the natural key is the opportunity id, with the solicitation number kept separately', () => {
  const n = normalizeSearchHit(POSTED_HIT, { companyId: CO });
  assert.equal(n.opportunityId, '359966');
  assert.equal(n.opportunityNumber, '25-540');
  assert.match(n.sourceUrl, /359966/);
  assert.equal(n.rawJson, POSTED_HIT, 'provenance kept whole');
});

test('a hit with no id is skipped loudly rather than keyed off the number', () => {
  const { id: _drop, ...noId } = POSTED_HIT;
  const n = normalizeSearchHit(noId, { companyId: CO });
  assert.equal(n.skip, true);
  assert.match(n.reason, /natural key/i);
});

test('normalising without a company id is refused', () => {
  assert.throws(() => normalizeSearchHit(POSTED_HIT, {}), /companyId is required/);
  assert.throws(() => normalizeDetail(DETAIL, {}), /companyId is required/);
});

test('agency contact details are NOT extracted', () => {
  const n = normalizeDetail(DETAIL, { companyId: CO });
  const flat = JSON.stringify({ ...n, rawJson: undefined, versions: undefined });
  assert.ok(!/someone@nsf\.gov/.test(flat),
    'Phase 1 is read-only intelligence and has no use for a contact address; collecting live '
    + 'federal addresses under a standing global email HOLD builds an outreach capability nobody asked for');
  assert.ok(!/agencyContactName|contactName/i.test(Object.keys(n).join(',')));
  // It remains inside rawJson, which is provenance rather than a working field — the payload is
  // kept whole on purpose, and nothing reads a contact out of it.
});

test('the detail status vocabulary is folded into the search vocabulary, not a second one', () => {
  const n = normalizeDetail(DETAIL, { companyId: CO });
  assert.equal(n.oppStatus, 'posted', 'data.ost is "POSTED"; two vocabularies for one fact is the duplication §2.6 forbids');
  assert.equal(n.standing, 'open');
});

// ── requests ────────────────────────────────────────────────────────────────

test('the search request carries only what the caller set', () => {
  const b = buildSearchRequest({ keyword: 'active pharmaceutical ingredient', rows: 10 });
  assert.deepEqual(b, { keyword: 'active pharmaceutical ingredient', rows: 10, startRecordNum: 0 });
  assert.ok(!('oppStatuses' in b), 'the API fills its own default and echoes it in searchParams');
});

test('a keyword is required and bounds are enforced', () => {
  assert.throws(() => buildSearchRequest({}), /keyword is required/);
  assert.throws(() => buildSearchRequest({ keyword: '   ' }), /keyword is required/);
  assert.throws(() => buildSearchRequest({ keyword: 'x', rows: 0 }), /rows/);
  assert.throws(() => buildSearchRequest({ keyword: 'x', rows: 5000 }), /rows/);
  assert.throws(() => buildSearchRequest({ keyword: 'x', startRecordNum: -1 }), /startRecordNum/);
});

test('fetchDetail refuses an id that is not an integer, and coerces one that is', async () => {
  // The measured signature is {opportunityId: <number>}. A numeric string is coerced on purpose —
  // ids arrive from the search response as strings ("359966"), so refusing them would make every
  // caller convert. What must be refused is anything that is not an integer at all, because
  // Number('abc') is NaN and NaN serialises to null, which the API would answer for some other
  // opportunity or not at all.
  for (const bad of ['abc', '', null, undefined, 3.5, '12.7', {}, []]) {
    await assert.rejects(fetchDetail(bad), /must be an integer/, `${JSON.stringify(bad)} should be refused`);
  }
  let sent = null;
  const fetchImpl = async (_url, opts) => {
    sent = JSON.parse(opts.body);
    return { status: 200, text: async () => JSON.stringify({ errorcode: 0, data: { id: 359966, revision: 0, synopsis: {} } }) };
  };
  await fetchDetail('359966', { fetchImpl });
  assert.strictEqual(sent.opportunityId, 359966, 'coerced to a number, not left as a string');
});

test('an errorcode arrives with HTTP 200, so the status code alone is not the verdict', async () => {
  const fetchImpl = async () => ({
    status: 200,
    text: async () => JSON.stringify({ errorcode: 1, msg: 'Invalid request' }),
  });
  await assert.rejects(
    fetchSearch(buildSearchRequest({ keyword: 'x' }), { fetchImpl }),
    /errorcode 1.*Invalid request/s,
    'trusting HTTP 200 would read a failure as an empty result set and complete the sync');
});

test('a successful search returns the hits, the total and what the server says it searched for', async () => {
  const fetchImpl = async () => ({
    status: 200,
    text: async () => JSON.stringify({
      errorcode: 0,
      msg: 'Webservice Succeeds',
      data: {
        hitCount: 454,
        oppHits: [POSTED_HIT, FORECAST_HIT],
        searchParams: { oppStatuses: 'forecasted|posted', rows: 10 },
      },
    }),
  });
  const r = await fetchSearch(buildSearchRequest({ keyword: 'x', rows: 10 }), { fetchImpl });
  assert.equal(r.hitCount, 454);
  assert.equal(r.hits.length, 2);
  assert.equal(r.searchParams.oppStatuses, 'forecasted|posted',
    'the default the server applied, recorded so a sync knows what it really asked for');
});

test('the staging host is reachable through the same code path', async () => {
  let seen = null;
  const fetchImpl = async (url) => {
    seen = url;
    return { status: 200, text: async () => JSON.stringify({ errorcode: 0, data: { oppHits: [], hitCount: 0 } }) };
  };
  await fetchSearch(buildSearchRequest({ keyword: 'x' }), { fetchImpl, staging: true });
  assert.match(seen, /api\.staging\.grants\.gov/,
    'so a test run can avoid the production service entirely');
});

test('unparseable JSON is reported, not swallowed into an empty page', async () => {
  const fetchImpl = async () => ({ status: 200, text: async () => '<html>504</html>' });
  await assert.rejects(fetchSearch(buildSearchRequest({ keyword: 'x' }), { fetchImpl }), /unparseable JSON/);
});
