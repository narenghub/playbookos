// Prospecting orchestrator tests — run with:  node --test src/lib/agents/prospecting/index.test.js
// Hermetic: searchText, query, tilesForProduct, logAgentActivity injected via deps.
const { test } = require('node:test');
const assert = require('node:assert');
const { runProspecting } = require('./index');
const { tilesForProduct } = require('./tiles');

const ON = { PROSPECTING_ENABLED: 'true', PROSPECTING_RATE_MS: '0' };
const noopLog = async () => {};
// fake DB with ON CONFLICT (product, place_id) DO NOTHING semantics
function fakeDB() {
  const seen = new Set(); let id = 0;
  const q = async (_sql, params) => {
    const key = params[0] + '|' + params[1]; // product|place_id
    if (seen.has(key)) return { rows: [] };
    seen.add(key); return { rows: [{ id: ++id }] };
  };
  q.seen = seen; return q;
}
const place = (id) => ({ place_id: id, name: 'F' + id, address: 'a', phone: 'p', website: 'w', types: ['golf_course'], rating: 4.4, rating_count: 10, business_status: 'OPERATIONAL' });
const oneTile = [{ state: 'illinois', region: 'Chicago, IL', subtype: 'course', query: 'golf course in Chicago, IL' }];

test('flag OFF → no-op (no Places calls, no tiles)', async () => {
  let searched = false, tiled = false;
  const s = await runProspecting('golfnex', { deps: { env: {}, searchText: async () => { searched = true; return { places: [] }; }, tilesForProduct: () => { tiled = true; return oneTile; }, query: fakeDB(), logAgentActivity: noopLog } });
  assert.equal(s.enabled, false);
  assert.equal(searched, false);
  assert.equal(tiled, false);
  assert.equal(s.new_facilities, 0);
});

test('NEVER THROWS on a Places API error; the error is recorded and the run continues', async () => {
  const tiles = [oneTile[0], { ...oneTile[0], subtype: 'range', query: 'driving range in Chicago, IL' }];
  let calls = 0;
  let s;
  await assert.doesNotReject(async () => {
    s = await runProspecting('golfnex', { deps: {
      env: ON, tilesForProduct: () => tiles, query: fakeDB(), logAgentActivity: noopLog,
      searchText: async (q) => { calls++; return q.includes('golf course') ? { places: [], error: 'HTTP 403: blocked' } : { places: [place('x1')], nextPageToken: null }; },
    } });
  });
  assert.ok(s.errors.some(e => e.stage === 'search'), 'search error recorded');
  assert.equal(s.tiles_run, 2, 'continued to the second tile after the first errored');
  assert.equal(s.new_facilities, 1, 'second tile still ingested');
});

test('dedup — the same place_id across pages/tiles yields ONE row', async () => {
  const db = fakeDB();
  // tile returns the same place on page 1 and page 2 (token), then a second tile repeats it
  let call = 0;
  const search = async () => {
    call++;
    if (call === 1) return { places: [place('dup'), place('a')], nextPageToken: 'p2' };
    return { places: [place('dup')], nextPageToken: null }; // page 2 repeats 'dup'
  };
  const s = await runProspecting('golfnex', { deps: { env: ON, tilesForProduct: () => oneTile, query: db, searchText: search, logAgentActivity: noopLog } });
  assert.equal(s.facilities_found, 3, 'dup seen 3 times across pages');
  assert.equal(s.new_facilities, 2, 'only dup + a are new');
  assert.equal(s.duplicates, 1, 'the repeat of dup is a dedup no-op');
  assert.equal(db.seen.size, 2, 'exactly two distinct rows persisted');
});

test('call cap HALTS the run', async () => {
  const manyTiles = Array.from({ length: 10 }, (_, i) => ({ state: 'il', region: 'R' + i, subtype: 'course', query: 'q' + i }));
  const env = { ...ON, PROSPECTING_CALL_CAP: '2' };
  let calls = 0;
  const search = async () => { calls++; return { places: [place('x' + calls)], nextPageToken: 'more' }; }; // always a token → would page forever
  const s = await runProspecting('golfnex', { deps: { env, tilesForProduct: () => manyTiles, query: fakeDB(), searchText: search, logAgentActivity: noopLog } });
  assert.equal(s.calls_made, 2, 'stopped at the call cap');
  assert.ok(s.errors.some(e => e.stage === 'call_cap'), 'call_cap error recorded');
  assert.ok(s.tiles_run < 10, 'did not run all tiles');
});

test('a tile that still has a token after 3 pages is reported as capped (needs subdividing)', async () => {
  let call = 0;
  const search = async () => { call++; return { places: [place('c' + call + '_' + Math.random())], nextPageToken: 'always-more' }; };
  const s = await runProspecting('golfnex', { deps: { env: { ...ON, PROSPECTING_CALL_CAP: '50' }, tilesForProduct: () => oneTile, query: fakeDB(), searchText: search, logAgentActivity: noopLog } });
  assert.deepEqual(s.capped_tiles, ['golf course in Chicago, IL']);
  assert.equal(s.calls_made, 3, 'exactly the 3-page cap for the tile');
});

test('a tile that exhausts before the cap is NOT reported as capped', async () => {
  let call = 0;
  const search = async () => { call++; return call === 1 ? { places: [place('a'), place('b')], nextPageToken: null } : { places: [] }; };
  const s = await runProspecting('golfnex', { deps: { env: ON, tilesForProduct: () => oneTile, query: fakeDB(), searchText: search, logAgentActivity: noopLog } });
  assert.deepEqual(s.capped_tiles, []);
  assert.equal(s.calls_made, 1);
  assert.equal(s.new_facilities, 2);
});

test('unknown product → config error, no throw', async () => {
  let s;
  await assert.doesNotReject(async () => { s = await runProspecting('nope', { deps: { env: ON, query: fakeDB(), searchText: async () => ({ places: [] }), logAgentActivity: noopLog } }); });
  assert.ok(s.errors.some(e => e.stage === 'config'));
});

// ── real tile config sanity ──────────────────────────────────────────────────
test('golfnex tiles = 3 subtypes × 13 IL regions = 39 tiles; unknown product = 0', () => {
  const t = tilesForProduct('golfnex');
  assert.equal(t.length, 39);
  assert.equal(new Set(t.map(x => x.subtype)).size, 3);
  assert.ok(t.every(x => x.query.includes(' in ')));
  assert.equal(tilesForProduct('nope').length, 0);
});

// ── runQualifyProspects (booking-signature orchestrator step) ──────────────────
const { runQualifyProspects } = require('./index');
function qualDB(rows) { const updates = []; const q = async (sql, params) => { if (/^SELECT/i.test(sql.trim())) return { rows }; if (/UPDATE/i.test(sql)) { updates.push(params); return { rows: [] }; } return { rows: [] }; }; return { query: q, updates }; }

test('runQualifyProspects flag OFF → no-op (no select)', async () => {
  let sel = false; const q = async () => { sel = true; return { rows: [] }; };
  const s = await runQualifyProspects('golfnex', { deps: { env: {}, query: q, qualifyFacility: async () => ({ platform: null }), logAgentActivity: noopLog } });
  assert.equal(s.enabled, false); assert.equal(sel, false);
});

test('runQualifyProspects writes platform + reachability, tallies by_platform + reachable', async () => {
  const db = qualDB([{ id: 1, website: 'a' }, { id: 2, website: 'b' }, { id: 3, website: 'c' }]);
  const qualify = async (w) => w === 'a' ? { platform: 'foreup', confidence: 'high', reachable: true }
    : w === 'b' ? { platform: null, reachable: true, unreachableReason: null }       // reached, no platform → prime
    : { platform: 'golfnow', confidence: 'medium', reachable: true };
  const s = await runQualifyProspects('golfnex', { deps: { env: ON, query: db.query, qualifyFacility: qualify, logAgentActivity: noopLog } });
  assert.equal(s.considered, 3); assert.equal(s.qualified, 3);
  assert.equal(s.with_platform, 2); assert.equal(s.no_platform, 1);
  assert.equal(s.reachable, 3); assert.equal(s.unreachable, 0);
  assert.deepEqual(s.by_platform, { foreup: 1, golfnow: 1 });
  assert.equal(db.updates.length, 3);
  assert.deepEqual(db.updates[0], ['foreup', true, null, 1]); // booking_platform, reachable, unreachable_reason, id
  assert.deepEqual(db.updates[1], [null, true, null, 2]);
});

test('runQualifyProspects persists unreachable rows with a reason + tallies by_reason', async () => {
  const db = qualDB([{ id: 1, website: 'dead' }, { id: 2, website: 'slow' }]);
  const qualify = async (w) => w === 'dead'
    ? { platform: null, reachable: false, unreachableReason: '403' }
    : { platform: null, reachable: false, unreachableReason: 'timeout' };
  const s = await runQualifyProspects('golfnex', { deps: { env: ON, query: db.query, qualifyFacility: qualify, logAgentActivity: noopLog } });
  assert.equal(s.qualified, 2); assert.equal(s.no_platform, 2);
  assert.equal(s.reachable, 0); assert.equal(s.unreachable, 2);
  assert.deepEqual(s.by_reason, { '403': 1, timeout: 1 });
  assert.deepEqual(db.updates[0], [null, false, '403', 1]);
  assert.deepEqual(db.updates[1], [null, false, 'timeout', 2]);
});

test('runQualifyProspects backfill: SELECT also picks up qualified rows with reachable IS NULL', async () => {
  let selSql = '';
  const q = async (sql, params) => { if (/^SELECT/i.test(sql.trim())) { selSql = sql; return { rows: [] }; } return { rows: [] }; };
  await runQualifyProspects('golfnex', { deps: { env: ON, query: q, qualifyFacility: async () => ({ platform: null, reachable: true }), logAgentActivity: noopLog } });
  assert.match(selSql, /status='new'\s+OR\s+reachable IS NULL/i, 'select covers new + untagged-qualified rows');
});

test('runQualifyProspects never-throws when the qualifier throws (reachable stays null → retryable)', async () => {
  const db = qualDB([{ id: 1, website: 'a' }]);
  let s;
  await assert.doesNotReject(async () => { s = await runQualifyProspects('golfnex', { deps: { env: ON, query: db.query, qualifyFacility: async () => { throw new Error('kaboom'); }, logAgentActivity: noopLog } }); });
  assert.equal(s.qualified, 1); assert.equal(s.no_platform, 1); // recorded as no-platform, still marked qualified
  assert.equal(s.reachable, 0); assert.equal(s.unreachable, 0); // undetermined → neither tally
  assert.deepEqual(db.updates[0], [null, null, null, 1]); // reachable persisted null so a later run retries it
});

// ── REFACTOR REGRESSION (config externalisation) ───────────────────────────────
test('tilesForProduct(golfnex) returns the SAME 39 tiles as before the refactor', () => {
  const regions = ['Chicago, IL','North Shore, Illinois','Northwest suburbs, Chicago, IL','West suburbs, Chicago, IL','South suburbs, Chicago, IL','Rockford, IL','Peoria, IL','Springfield, IL','Champaign, IL','Bloomington, IL','Quad Cities, IL','Decatur, IL','Metro East, Illinois'];
  const terms = ['golf course','driving range','golf simulator'];
  const expected = [];
  for (const r of regions) for (const t of terms) expected.push(`${t} in ${r}`);
  const got = tilesForProduct('golfnex');
  assert.equal(got.length, 39);
  assert.deepEqual(got.map(t => t.query).sort(), expected.sort(), 'exact 39 queries unchanged');
  assert.deepEqual([...new Set(got.map(t => t.subtype))].sort(), ['course','range','simulator']);
  assert.ok(got.every(t => t.state === 'IL'));
});

test('runQualifyProspects on an unknown product → config error, no throw (does not run)', async () => {
  let selected = false;
  const q = async () => { selected = true; return { rows: [] }; };
  let s;
  await assert.doesNotReject(async () => { s = await runQualifyProspects('nope', { deps: { env: ON, query: q, qualifyFacility: async () => ({ platform: null }), logAgentActivity: noopLog } }); });
  assert.ok(s.errors.some(e => e.stage === 'config'), 'clear config error for unknown product');
  assert.equal(selected, false, 'did not query prospects for an unconfigured product');
});
