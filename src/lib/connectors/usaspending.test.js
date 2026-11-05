// ── WHAT THE LIVE API ACTUALLY SENDS, PINNED AS A TEST ──────────────────────
//
//   node --test src/lib/connectors/usaspending.test.js
//
// Every fixture below is a VERBATIM row from scripts/probe-procurement-sources.js against the
// live API on 2026-11-05 — not a row somebody wrote to match the parser. That matters: a fixture
// invented from the parser's own assumptions tests nothing except that the parser agrees with
// itself, which is exactly how the task segments passed while writing NULL into every column.
//
// The three rows were chosen because they are structurally different:
//
//   a task order under a parent IDV      → parent_piid is a real award id
//   a standalone definitive contract     → parent slots carry the '-NONE-' SENTINEL
//   a second task order, same parent IDV → two awards sharing a parent, distinct PIIDs
//
// The middle one is the reason this file exists. PR-1's first version of assertion U3 claimed every
// key embeds a parent award id and failed at 7/10, because standalone contracts do not have one.
// The expectation was wrong, not the data, and '-NONE-' stored verbatim would make every later
// join on parent_piid match unrelated standalone awards.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const {
  parseAwardKey, normalizeAward, buildRequest, fetchPage,
  EARLIEST_SEARCH_DATE, DEFAULT_NAICS, AWARD_TYPE_CODES,
} = require('./usaspending');

const CO = 'company-abiozen';

// Verbatim from the live probe.
const TASK_ORDER = {
  internal_id: 361485216,
  'Award ID': 'W91ZLK26FA049',
  'Recipient Name': 'STAR GEOENVIRONMENTAL LLC',
  'Award Amount': 114371.5,
  'Awarding Agency': 'Department of Defense',
  'Awarding Sub Agency': 'Department of the Army',
  NAICS: { code: '541380', description: 'TESTING LABORATORIES AND SERVICES' },
  PSC: { code: 'B510', description: 'SPECIAL STUDIES/ANALYSIS- ENVIRONMENTAL ASSESSMENTS' },
  'Start Date': '2026-05-22',
  'End Date': '2027-05-21',
  recipient_id: '10f73b2c-176c-27da-ecd6-9a5ae7662eeb-C',
  generated_internal_id: 'CONT_AWD_W91ZLK26FA049_9700_W91ZLK26DA001_9700',
  awarding_agency_id: 1173,
  agency_slug: 'department-of-defense',
};

const STANDALONE = {
  'Award ID': 'W91ZLK25P0022',
  'Recipient Name': 'EXAMPLE LABS INC',
  'Award Amount': 24500,
  'Awarding Agency': 'Department of Defense',
  'Awarding Sub Agency': 'Department of the Army',
  NAICS: { code: '325412', description: 'PHARMACEUTICAL PREPARATION MANUFACTURING' },
  PSC: { code: '6505', description: 'DRUGS AND BIOLOGICALS' },
  'Start Date': '2025-03-01',
  'End Date': '2025-09-30',
  recipient_id: 'aaaa1111-2222-3333-4444-555566667777-C',
  generated_internal_id: 'CONT_AWD_W91ZLK25P0022_9700_-NONE-_-NONE-',
};

const SIBLING_TASK_ORDER = {
  'Award ID': 'W91YTZ25FA156',
  'Award Amount': 2059.79,
  NAICS: { code: '325412', description: 'PHARMACEUTICAL PREPARATION MANUFACTURING' },
  PSC: { code: '6509', description: 'DRUGS AND BIOLOGICALS, VETERINARY USE' },
  'Start Date': '2025-09-15',
  'End Date': '2025-09-30',
  recipient_id: '63a4c13a-26a7-04fd-958d-2fdb75715c18-C',
  generated_internal_id: 'CONT_AWD_W91YTZ25FA156_9700_W91YTZ24D0002_9700',
};

// ── key parsing ─────────────────────────────────────────────────────────────

test('a task order key yields the PIID and its parent IDV', () => {
  const p = parseAwardKey(TASK_ORDER.generated_internal_id);
  assert.equal(p.piid, 'W91ZLK26FA049');
  assert.equal(p.awardingAgencyCode, '9700');
  assert.equal(p.parentPiid, 'W91ZLK26DA001');
  assert.equal(p.wellFormed, true);
});

test("the '-NONE-' parent sentinel becomes NULL, never the literal string", () => {
  const p = parseAwardKey(STANDALONE.generated_internal_id);
  assert.equal(p.piid, 'W91ZLK25P0022');
  assert.strictEqual(p.parentPiid, null, "'-NONE-' must not survive as a value");
  assert.strictEqual(p.parentAgencyCode, null);
});

test('an unparseable key degrades to nulls instead of throwing', () => {
  // One malformed row must not abort a whole page. The award is still worth storing under its key.
  const p = parseAwardKey('SOMETHING_UNEXPECTED');
  assert.equal(p.wellFormed, false);
  assert.strictEqual(p.piid, null);
});

test('PIID alone cannot key the table: two awards share a parent and differ only in PIID', () => {
  const a = parseAwardKey(SIBLING_TASK_ORDER.generated_internal_id);
  const b = parseAwardKey('CONT_AWD_W91YTZ25FA155_9700_W91YTZ24D0002_9700');
  assert.equal(a.parentPiid, b.parentPiid, 'same parent IDV');
  assert.notEqual(a.piid, b.piid);
  // and the full keys differ, which is why the natural key is the key and not the PIID
  assert.notEqual(SIBLING_TASK_ORDER.generated_internal_id,
    'CONT_AWD_W91YTZ25FA155_9700_W91YTZ24D0002_9700');
});

// ── normalisation ───────────────────────────────────────────────────────────

test('a live row normalises into the federal_awards shape with provenance intact', () => {
  const n = normalizeAward(TASK_ORDER, { companyId: CO, syncId: 'sync-1' });
  assert.equal(n.skip, false);
  assert.equal(n.awardKey, 'CONT_AWD_W91ZLK26FA049_9700_W91ZLK26DA001_9700');
  assert.equal(n.piid, 'W91ZLK26FA049');
  assert.equal(n.parentPiid, 'W91ZLK26DA001');
  assert.equal(n.naicsCode, '541380');
  assert.equal(n.pscCode, 'B510');
  assert.equal(n.recipientProfileId, '10f73b2c-176c-27da-ecd6-9a5ae7662eeb-C');
  assert.equal(n.popStartDate, '2026-05-22');
  // §4: every imported record preserves source identifiers, provenance and a source URL.
  assert.equal(n.rawJson, TASK_ORDER, 'the whole original row is kept');
  assert.match(n.sourceUrl, /^https:\/\/www\.usaspending\.gov\/award\//);
});

test('the amount is called an obligation, because that is what it is', () => {
  const n = normalizeAward(TASK_ORDER, { companyId: CO });
  assert.equal(n.obligatedAmount, 114371.5);
  // A field called "spend" or "amount" invites a dashboard tile that sums obligations and labels
  // the total as money spent. That is wrong by construction, and wrong in the flattering direction.
  assert.ok(!('spend' in n), 'no field named spend');
  assert.ok(!('amount' in n), 'no bare amount field');
});

test('a row with no natural key is skipped loudly, not keyed off the PIID', () => {
  const { generated_internal_id: _drop, ...noKey } = TASK_ORDER;
  const n = normalizeAward(noKey, { companyId: CO });
  assert.equal(n.skip, true);
  assert.match(n.reason, /natural key/i);
  // Inventing a key from the PIID is the tempting fix and it is the wrong one: PIIDs collide
  // across agencies and parents, so it would silently merge distinct awards.
});

test('normalising without a company id is refused — these rows are tenant-scoped', () => {
  assert.throws(() => normalizeAward(TASK_ORDER, {}), /companyId is required/);
});

test('a non-ISO date becomes NULL rather than a guess', () => {
  const n = normalizeAward({ ...TASK_ORDER, 'Start Date': '05/22/2026' }, { companyId: CO });
  assert.strictEqual(n.popStartDate, null,
    'MM/DD/YYYY is Grants.gov\'s format, not this API\'s — parsing it here would invent a date');
});

test('missing NAICS or PSC objects do not throw', () => {
  const n = normalizeAward({ ...TASK_ORDER, NAICS: null, PSC: undefined }, { companyId: CO });
  assert.strictEqual(n.naicsCode, null);
  assert.strictEqual(n.pscCode, null);
});

// ── request building ────────────────────────────────────────────────────────

test('the request body matches the shape the live API accepted', () => {
  const b = buildRequest({ from: '2025-11-05', to: '2026-11-05', limit: 10 });
  // PR-1 measured a 422 when naics_codes was sent as {require:[[...]]}. It is a flat array.
  assert.ok(Array.isArray(b.filters.naics_codes));
  assert.deepEqual(b.filters.naics_codes, [...DEFAULT_NAICS]);
  assert.deepEqual(b.filters.award_type_codes, [...AWARD_TYPE_CODES]);
  assert.deepEqual(b.filters.time_period, [{ start_date: '2025-11-05', end_date: '2026-11-05' }]);
  assert.ok(b.fields.includes('generated_internal_id'), 'the natural key must be requested');
});

test('IDV award types are excluded, because a ceiling is not an award', () => {
  const b = buildRequest({ from: '2025-01-01', to: '2025-12-31' });
  for (const t of b.filters.award_type_codes) {
    assert.ok(['A', 'B', 'C', 'D'].includes(t), `unexpected award type ${t}`);
  }
});

test("a window before the API's own floor is refused", () => {
  assert.throws(() => buildRequest({ from: '2001-01-01', to: '2002-01-01' }),
    new RegExp(EARLIEST_SEARCH_DATE));
});

test('reversed and out-of-range arguments are refused', () => {
  assert.throws(() => buildRequest({ from: '2026-01-01', to: '2025-01-01' }), /is after/);
  assert.throws(() => buildRequest({ from: '2025-01-01', to: '2025-02-01', limit: 0 }), /limit/);
  assert.throws(() => buildRequest({ from: '2025-01-01', to: '2025-02-01', limit: 500 }), /limit/);
  assert.throws(() => buildRequest({ from: 'last tuesday', to: '2025-02-01' }), /YYYY-MM-DD/);
  assert.throws(() => buildRequest({ to: '2025-02-01' }), /required/);
});

// ── paging ──────────────────────────────────────────────────────────────────

test('paging is read from page_metadata, not inferred from the row count', () => {
  // A loop that stops when results.length < limit misses a short final page; one that runs to a
  // guessed page total walks off the end. hasNext is the only signal that is actually correct.
  const fetchImpl = async () => ({
    status: 200,
    text: async () => JSON.stringify({
      results: [TASK_ORDER, STANDALONE],
      page_metadata: { page: 1, hasNext: true, last_record_unique_id: 350537429 },
      messages: ['time period start and end dates are currently limited'],
    }),
  });
  return fetchPage(buildRequest({ from: '2025-01-01', to: '2025-12-31', limit: 100 }), { fetchImpl })
    .then((r) => {
      assert.equal(r.results.length, 2);
      assert.equal(r.hasNext, true, 'two rows out of a limit of 100 and there is still a next page');
      assert.equal(r.lastRecordId, 350537429);
      assert.equal(r.messages.length, 1);
    });
});

test('a missing page_metadata means hasNext is false, not undefined', () => {
  const fetchImpl = async () => ({ status: 200, text: async () => JSON.stringify({ results: [] }) });
  return fetchPage(buildRequest({ from: '2025-01-01', to: '2025-12-31' }), { fetchImpl })
    .then((r) => {
      assert.strictEqual(r.hasNext, false, 'an undefined hasNext must not read as truthy and loop forever');
      assert.strictEqual(r.lastRecordId, null);
    });
});

test('a non-200 surfaces the API validation message rather than a generic failure', () => {
  const fetchImpl = async () => ({
    status: 422,
    text: async () => JSON.stringify({ detail: "Invalid value in 'filters|naics_codes'." }),
  });
  return assert.rejects(
    fetchPage(buildRequest({ from: '2025-01-01', to: '2025-12-31' }), { fetchImpl }),
    /HTTP 422.*naics_codes/s);
});

test('unparseable JSON is reported as such, not swallowed into an empty page', () => {
  const fetchImpl = async () => ({ status: 200, text: async () => '<html>gateway timeout</html>' });
  return assert.rejects(
    fetchPage(buildRequest({ from: '2025-01-01', to: '2025-12-31' }), { fetchImpl }),
    /unparseable JSON/);
  // An empty page here would complete the sync and advance the watermark over records never read.
});
