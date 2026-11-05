// ── THE REFUSALS, THE CEILING, AND THE WATERMARK ────────────────────────────
//
//   node --test src/lib/connectors/sync-run.test.js
//
// Three things in this file are controls rather than behaviour, and each exists because the
// alternative is a decision somebody has to remember:
//
//   R1  a manual-assisted portal cannot be synced          FedConnect, SBCX
//   R2  a connector that is not activated cannot be synced  SAM.gov, ruling 5
//   W   the watermark advances only on success
//
// W is the one that would do silent damage. A partially-synced page that advanced the watermark
// permanently skips every record between the failure and the next run — no error, no gap anybody
// counts, just records never fetched. So the test is not only "it does not advance on failure":
// it is that the failure path HAS NO PARAMETER by which a caller could advance it. A control you
// can reach is a control somebody eventually reaches.
//
// These run against a recording fake rather than a database, deliberately. The point is to prove
// the SQL carries the tenant predicate and the ceiling guard in every statement — which is
// readable from the text — without a live cluster. The engine-side half (the CHECK constraint, the
// unique index, MATCH FULL) is asserted against the DDL in schema.test.js.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const {
  beginSync, chargeCalls, upsertAwards, completeSync, endSyncUnsuccessfully,
  lastWatermark, SyncRefused,
} = require('./sync-run');
const { normalizeAward } = require('./usaspending');

const CTX = Object.freeze({ companyId: 'company-abiozen' });
const OTHER = Object.freeze({ companyId: 'company-cro360' });
const RUN = '8f2b1c44-0000-4000-8000-000000000001';

// A recording fake. Returns whatever the scripted handler gives and keeps every statement so the
// test can assert on the SQL actually issued, not on a mock's expectations.
function fakeDb(handlers) {
  const calls = [];
  const query = async (sql, params = []) => {
    // Match on whitespace-normalised SQL. The statements are written multi-line, so a handler
    // pattern like /UPDATE source_sync_runs SET calls_made/ silently matches nothing against the
    // raw text — and a fake that silently matches nothing returns an empty result set, which reads
    // as "the row was not there" rather than "the test harness is broken". Five tests failed that
    // way before this line normalised first.
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params });
    for (const [re, fn] of handlers) {
      if (re.test(flat)) return typeof fn === 'function' ? fn(flat, params) : fn;
    }
    return { rows: [] };
  };
  return { query, calls, find: (re) => calls.filter((c) => re.test(c.sql)) };
}

const connector = (over = {}) => ({
  rows: [{
    source_key: 'usaspending', display_name: 'USAspending', kind: 'procurement',
    auth_mode: 'none', access_mode: 'api', daily_call_ceiling: null, activated: true, notes: '',
    ...over,
  }],
});

// ── R1 — portals are not data endpoints ─────────────────────────────────────

test('R1: a manual-assisted portal cannot be synced', async () => {
  const db = fakeDb([
    [/FROM source_connectors/, connector({ source_key: 'fedconnect', access_mode: 'manual_assisted', auth_mode: 'portal_login', activated: true })],
    [/INSERT INTO source_sync_runs/, { rows: [] }],
  ]);
  await assert.rejects(
    beginSync(CTX, { sourceKey: 'fedconnect', runId: RUN }, db),
    (e) => e instanceof SyncRefused && e.code === 'MANUAL_ASSISTED');
});

test('R1: the refusal leaves an auditable row — a refusal with no trace looks like never trying', async () => {
  const db = fakeDb([
    [/FROM source_connectors/, connector({ source_key: 'hhs_sbcx', access_mode: 'manual_assisted', activated: true })],
    [/INSERT INTO source_sync_runs/, { rows: [] }],
  ]);
  await beginSync(CTX, { sourceKey: 'hhs_sbcx', runId: RUN }, db).catch(() => {});
  const ins = db.find(/INSERT INTO source_sync_runs/);
  assert.equal(ins.length, 1);
  assert.match(ins[0].sql, /'refused'/);
  assert.ok(ins[0].params.includes(CTX.companyId), 'the refused row is tenant-scoped too');
  assert.ok(ins[0].params.some((p) => typeof p === 'string' && /no published API/.test(p)),
    'the reason is recorded, not just the status');
});

// ── R2 — prepared is not activated ──────────────────────────────────────────

test('R2: SAM.gov is prepared but not activated, and beginSync honours that', async () => {
  const db = fakeDb([
    [/FROM source_connectors/, connector({ source_key: 'sam_gov', auth_mode: 'api_key', daily_call_ceiling: 10, activated: false })],
    [/INSERT INTO source_sync_runs/, { rows: [] }],
  ]);
  await assert.rejects(
    beginSync(CTX, { sourceKey: 'sam_gov', runId: RUN }, db),
    (e) => e instanceof SyncRefused && e.code === 'NOT_ACTIVATED' && /ruling 5/.test(e.message));
});

test('an unknown source is an error, not a silent no-op', async () => {
  const db = fakeDb([[/FROM source_connectors/, { rows: [] }]]);
  await assert.rejects(beginSync(CTX, { sourceKey: 'nope', runId: RUN }, db), /unknown source_key/);
});

// ── the run requirement ─────────────────────────────────────────────────────

test('a sync cannot happen outside an agent_run', async () => {
  const db = fakeDb([[/FROM source_connectors/, connector()]]);
  await assert.rejects(beginSync(CTX, { sourceKey: 'usaspending' }, db), /runId is required/);
  // Not pedantry: the run is what carries the kill switch, the cost ledger and the audit trail.
  // A sync outside a run is a sync nobody can stop and nothing records.
});

test('an unresolved company context is refused before any lookup happens', async () => {
  const db = fakeDb([[/FROM source_connectors/, connector()]]);
  await assert.rejects(beginSync({ companyId: 'x' }, { sourceKey: 'usaspending', runId: RUN }, db),
    /frozen object/, 'an unfrozen context is not a resolved context');
  await assert.rejects(beginSync(Object.freeze({}), { sourceKey: 'usaspending', runId: RUN }, db),
    /no companyId/);
  assert.equal(db.find(/FROM source_connectors/).length, 0, 'nothing was read');
});

// ── the ceiling ─────────────────────────────────────────────────────────────

test('calls are charged BEFORE they are made, and the guard is in the UPDATE itself', async () => {
  const db = fakeDb([[/UPDATE source_sync_runs SET calls_made/, { rows: [{ calls_made: 3, call_ceiling: 10 }] }]]);
  const r = await chargeCalls(CTX, 'sync-1', 1, db);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, 7);
  const sql = db.find(/UPDATE source_sync_runs SET calls_made/)[0].sql;
  // The guard must be a predicate the engine evaluates, not a branch in JavaScript that a second
  // concurrent sync can interleave with.
  assert.match(sql, /calls_made \+ \$3 <= call_ceiling/);
  assert.match(sql, /company_id = \$2/, 'tenant-scoped');
  assert.match(sql, /status = 'running'/);
});

test('at the ceiling the charge is refused and the caller is told how much is left', async () => {
  const db = fakeDb([
    [/UPDATE source_sync_runs SET calls_made/, { rows: [] }],
    [/SELECT calls_made, call_ceiling, status/, { rows: [{ calls_made: 10, call_ceiling: 10, status: 'running' }] }],
  ]);
  const r = await chargeCalls(CTX, 'sync-1', 1, db);
  assert.equal(r.allowed, false);
  assert.equal(r.remaining, 0);
  // This is the SAM.gov case: ten calls on a personal key. Refusing here is the difference between
  // stopping cleanly and discovering the quota as a 429 halfway through a page.
});

test('a null ceiling means unmetered, not zero', async () => {
  const db = fakeDb([[/UPDATE source_sync_runs SET calls_made/, { rows: [{ calls_made: 4000, call_ceiling: null }] }]]);
  const r = await chargeCalls(CTX, 'sync-1', 1, db);
  assert.equal(r.allowed, true);
  assert.strictEqual(r.remaining, null, 'no published quota is not a quota of nothing');
});

test('a non-positive charge is refused', async () => {
  const db = fakeDb([]);
  await assert.rejects(chargeCalls(CTX, 'sync-1', 0, db), /positive integer/);
  await assert.rejects(chargeCalls(CTX, 'sync-1', 1.5, db), /positive integer/);
});

// ── idempotency and tenant isolation on the write ───────────────────────────

const LIVE_ROW = {
  'Award ID': 'W91ZLK26FA049',
  'Award Amount': 114371.5,
  NAICS: { code: '541380', description: 'TESTING LABORATORIES AND SERVICES' },
  PSC: { code: 'B510', description: 'SPECIAL STUDIES' },
  'Start Date': '2026-05-22',
  'End Date': '2027-05-21',
  recipient_id: '10f73b2c-176c-27da-ecd6-9a5ae7662eeb-C',
  generated_internal_id: 'CONT_AWD_W91ZLK26FA049_9700_W91ZLK26DA001_9700',
};

test('the upsert dedupes on the natural key in the database, not in application code', async () => {
  const db = fakeDb([
    [/INSERT INTO federal_awards/, { rows: [{ is_new: true }] }],
    [/UPDATE source_sync_runs SET records_seen/, { rows: [] }],
  ]);
  const n = [normalizeAward(LIVE_ROW, { companyId: CTX.companyId, syncId: 'sync-1' })];
  const r = await upsertAwards(CTX, 'sync-1', n, db);
  assert.equal(r.inserted, 1);
  const sql = db.find(/INSERT INTO federal_awards/)[0].sql;
  assert.match(sql, /ON CONFLICT \(company_id, source_key, award_key\)/);
  // A read-then-write existence check races itself: two concurrent syncs both read "absent" and
  // both insert. §15's "no duplicates after repeated synchronization" has to be an index.
});

test('re-seeing an award preserves when we FIRST saw it', async () => {
  const db = fakeDb([
    [/INSERT INTO federal_awards/, { rows: [{ is_new: false }] }],
    [/UPDATE source_sync_runs SET records_seen/, { rows: [] }],
  ]);
  const n = [normalizeAward(LIVE_ROW, { companyId: CTX.companyId })];
  const r = await upsertAwards(CTX, 'sync-1', n, db);
  assert.equal(r.updated, 1);
  const sql = db.find(/INSERT INTO federal_awards/)[0].sql;
  assert.ok(!/first_seen_sync_id\s*=\s*EXCLUDED/.test(sql),
    'overwriting first_seen erases the only thing separating a new award from one watched for a year');
  assert.match(sql, /last_seen_sync_id\s*=\s*EXCLUDED/);
});

test("a row carrying another tenant's id is refused by name before the engine sees it", async () => {
  const db = fakeDb([[/INSERT INTO federal_awards/, { rows: [{ is_new: true }] }]]);
  const n = [normalizeAward(LIVE_ROW, { companyId: OTHER.companyId })];
  await assert.rejects(upsertAwards(CTX, 'sync-1', n, db), /does not match context/);
  assert.equal(db.find(/INSERT INTO federal_awards/).length, 0, 'nothing was written');
});

test('skipped rows are counted and their reasons returned, not dropped quietly', async () => {
  const db = fakeDb([[/UPDATE source_sync_runs SET records_seen/, { rows: [] }]]);
  const { generated_internal_id: _drop, ...noKey } = LIVE_ROW;
  const n = [normalizeAward(noKey, { companyId: CTX.companyId })];
  const r = await upsertAwards(CTX, 'sync-1', n, db);
  assert.equal(r.skipped, 1);
  assert.match(r.skippedReasons[0], /natural key/);
  // records_seen counts everything the API returned; records_upserted counts what we stored. If
  // they only ever matched, a skip would be invisible.
  const upd = db.find(/UPDATE source_sync_runs SET records_seen/)[0];
  assert.deepEqual(upd.params.slice(2), [1, 0], 'one seen, zero upserted');
});

// ── W — the watermark ───────────────────────────────────────────────────────

test('W: the watermark is written only by completeSync', async () => {
  const db = fakeDb([[/UPDATE source_sync_runs SET status = 'completed'/, { rows: [{ id: 'sync-1', high_water_mark: '2026-11-05' }] }]]);
  await completeSync(CTX, 'sync-1', { highWaterMark: '2026-11-05' }, db);
  const sql = db.find(/status = 'completed'/)[0].sql;
  assert.match(sql, /high_water_mark = \$3/);
  assert.match(sql, /status = 'running'/, 'only a running sync can complete — no double-close');
});

test('W: the failure path has NO route by which the watermark could advance', async () => {
  const db = fakeDb([[/UPDATE source_sync_runs SET status = \$3/, { rows: [{ id: 'sync-1', status: 'failed' }] }]]);
  // Pass a watermark the way a caller under time pressure would, and prove it goes nowhere.
  await endSyncUnsuccessfully(CTX, 'sync-1',
    { status: 'failed', error: 'HTTP 429', highWaterMark: '2026-11-05' }, db);
  const call = db.find(/SET status = \$3/)[0];
  // Precisely: never in SET. It MAY appear in RETURNING — reading the watermark back as it stands
  // is useful and harmless, and asserting "not mentioned anywhere" was too broad a claim, which
  // this test caught on its first run.
  const setClause = call.sql.slice(call.sql.indexOf('SET '), call.sql.indexOf('WHERE'));
  assert.ok(!/high_water_mark/.test(setClause),
    `the failure path must never SET the watermark — got: ${setClause}`);
  assert.ok(!call.params.includes('2026-11-05'),
    'a watermark handed to the failure path must not reach the database by any parameter');
});

test('W: only failed and ceiling_reached are accepted as unsuccessful endings', async () => {
  const db = fakeDb([]);
  await assert.rejects(endSyncUnsuccessfully(CTX, 'sync-1', { status: 'completed' }, db),
    /must be failed or ceiling_reached/, 'completeSync is the only route to completed');
  await assert.rejects(endSyncUnsuccessfully(CTX, 'sync-1', { status: 'running' }, db), /must be/);
});

test('W: resuming reads only COMPLETED runs — a failed or refused run contributes nothing', async () => {
  const db = fakeDb([[/SELECT high_water_mark/, { rows: [{ high_water_mark: '2026-10-01' }] }]]);
  const wm = await lastWatermark(CTX, 'usaspending', db);
  assert.equal(wm, '2026-10-01');
  const sql = db.find(/SELECT high_water_mark/)[0].sql;
  assert.match(sql, /status = 'completed'/);
  assert.match(sql, /company_id = \$1/);
  assert.match(sql, /high_water_mark IS NOT NULL/);
});

test('no watermark yet reads as null, which must mean full window, not epoch zero', async () => {
  const db = fakeDb([[/SELECT high_water_mark/, { rows: [] }]]);
  assert.strictEqual(await lastWatermark(CTX, 'usaspending', db), null);
});

// ── every write is tenant-scoped ────────────────────────────────────────────

test('every statement this module issues against a tenant table carries company_id', async () => {
  const db = fakeDb([
    [/FROM source_connectors/, connector()],
    [/INSERT INTO source_sync_runs/, { rows: [] }],
    [/INSERT INTO federal_awards/, { rows: [{ is_new: true }] }],
    [/UPDATE source_sync_runs SET calls_made/, { rows: [{ calls_made: 1, call_ceiling: null }] }],
    [/UPDATE source_sync_runs SET records_seen/, { rows: [] }],
    [/UPDATE source_sync_runs SET status = 'completed'/, { rows: [{ id: 's' }] }],
    [/SELECT high_water_mark/, { rows: [] }],
  ]);
  const { syncId } = await beginSync(CTX, { sourceKey: 'usaspending', runId: RUN }, db);
  await chargeCalls(CTX, syncId, 1, db);
  await upsertAwards(CTX, syncId, [normalizeAward(LIVE_ROW, { companyId: CTX.companyId })], db);
  await completeSync(CTX, syncId, { highWaterMark: '2026-11-05' }, db);
  await lastWatermark(CTX, 'usaspending', db);

  const tenantTable = /source_sync_runs|federal_awards/;
  const offenders = db.calls.filter((c) => tenantTable.test(c.sql)
    && !/company_id/.test(c.sql));
  assert.deepEqual(offenders.map((o) => o.sql.slice(0, 80)), [],
    'a statement against a tenant table with no company_id is the isolation hole');
});
