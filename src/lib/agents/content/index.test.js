// Content pipeline tests — run with:  node --test src/lib/agents/content/index.test.js
// Fully hermetic: source, classify, generate, query, and logAgentActivity are injected via
// deps. Proves never-throws (source/LLM/DB failure), the cost fuse, drop-before-generate,
// ON CONFLICT dedup, and the flag-off no-op.

const { test } = require('node:test');
const assert = require('node:assert');
const { runContentPipeline } = require('./index');
const { parseItem } = require('./news-source');
const { getConfig } = require('./config');

const ON = { CONTENT_PIPELINE_ENABLED: 'true', CONTENT_PIPELINE_RATE_MS: '0' };
const item = (n) => ({ source_ref: `https://ex.com/${n}`, title: `Article ${n}`, url: `https://ex.com/${n}`, published_at: '2026-08-22', summary: 's' });
// a source whose parseItem is identity (items are already normalized)
const srcOf = (items, error) => ({ fetchItems: async () => (error ? { items: [], error } : { items }), parseItem: (r) => r });
const noopLog = async () => {};
// fake DB with ON CONFLICT (product, source_ref) DO NOTHING semantics
function fakeDB() {
  const seen = new Set(); let id = 0;
  return {
    rows: seen,
    query: async (_sql, params) => {
      const key = params[0] + '|' + params[1];
      if (seen.has(key)) return { rows: [] };       // conflict → nothing returned
      seen.add(key); return { rows: [{ id: ++id }] };
    },
  };
}
const okClassify = (over = {}) => async () => ({ relevant: true, topic: 'equipment', segment: 'player', score: 0.9, costUsd: 0.001, usage: { input_tokens: 10, output_tokens: 5 }, ...over });
const okGenerate = (over = {}) => async () => ({ headline: 'H', body: 'B', costUsd: 0.01, usage: { input_tokens: 20, output_tokens: 40 }, ...over });

test('flag OFF → no-op (no fetch, no drafts)', async () => {
  let fetched = false;
  const source = { fetchItems: async () => { fetched = true; return { items: [item(1)] }; }, parseItem: (r) => r };
  const s = await runContentPipeline('golfnex', { deps: { env: {}, source, classify: okClassify(), generate: okGenerate(), query: fakeDB().query, logAgentActivity: noopLog } });
  assert.equal(s.enabled, false);
  assert.equal(fetched, false, 'flag off must not hit the source');
  assert.equal(s.drafts_created, 0);
});

test('NEVER THROWS when the source returns an error', async () => {
  let s;
  await assert.doesNotReject(async () => { s = await runContentPipeline('golfnex', { deps: { env: ON, source: srcOf([], 'NewsAPI 500: down'), classify: okClassify(), generate: okGenerate(), query: fakeDB().query, logAgentActivity: noopLog } }); });
  assert.ok(s.errors.some(e => e.stage === 'fetch'));
  assert.equal(s.drafts_created, 0);
});

test('NEVER THROWS when the source itself throws', async () => {
  const source = { fetchItems: async () => { throw new Error('boom'); }, parseItem: (r) => r };
  let s;
  await assert.doesNotReject(async () => { s = await runContentPipeline('golfnex', { deps: { env: ON, source, classify: okClassify(), generate: okGenerate(), query: fakeDB().query, logAgentActivity: noopLog } }); });
  assert.ok(s.errors.some(e => e.stage === 'run'));
});

test('NEVER THROWS when the LLM (classify) fails; generation is not attempted', async () => {
  let genCalled = false;
  const generate = async () => { genCalled = true; return okGenerate()(); };
  let s;
  await assert.doesNotReject(async () => { s = await runContentPipeline('golfnex', { deps: { env: ON, source: srcOf([item(1)]), classify: async () => ({ error: 'Claude 500: x', costUsd: 0 }), generate, query: fakeDB().query, logAgentActivity: noopLog } }); });
  assert.ok(s.errors.some(e => e.stage === 'classify'));
  assert.equal(genCalled, false, 'generation must not run after a classify failure');
  assert.equal(s.drafts_created, 0);
});

test('NEVER THROWS when generation fails', async () => {
  let s;
  await assert.doesNotReject(async () => { s = await runContentPipeline('golfnex', { deps: { env: ON, source: srcOf([item(1)]), classify: okClassify(), generate: async () => ({ error: 'unparseable content JSON', costUsd: 0 }), query: fakeDB().query, logAgentActivity: noopLog } }); });
  assert.ok(s.errors.some(e => e.stage === 'generate'));
  assert.equal(s.drafts_created, 0);
});

test('NEVER THROWS when the DB write fails', async () => {
  const throwingQuery = async () => { throw new Error('DB unavailable'); };
  let s;
  await assert.doesNotReject(async () => { s = await runContentPipeline('golfnex', { deps: { env: ON, source: srcOf([item(1)]), classify: okClassify(), generate: okGenerate(), query: throwingQuery, logAgentActivity: noopLog } }); });
  assert.ok(s.errors.some(e => e.stage === 'item'));
  assert.equal(s.drafts_created, 0);
});

test('cost fuse HALTS the run before spending past the cap', async () => {
  const env = { ...ON, CONTENT_PIPELINE_DAILY_USD_CAP: '0.6' };
  // each classify costs 0.5, each generate 0.2 → after item 1 spend = 0.7 > 0.6
  const s = await runContentPipeline('golfnex', { deps: { env, source: srcOf([item(1), item(2), item(3)]), classify: okClassify({ costUsd: 0.5 }), generate: okGenerate({ costUsd: 0.2 }), query: fakeDB().query, logAgentActivity: noopLog } });
  assert.ok(s.errors.some(e => e.stage === 'cost_cap'), 'a cost_cap error is recorded');
  assert.ok(s.drafts_created < 3, 'fuse stopped the run early');
  assert.ok(s.items_processed < 3, 'later items were not processed');
});

test('irrelevant items are dropped BEFORE generation (generation never called, no draft)', async () => {
  let genCalled = false;
  const generate = async () => { genCalled = true; return okGenerate()(); };
  const s = await runContentPipeline('golfnex', { deps: { env: ON, source: srcOf([item(1), item(2)]), classify: okClassify({ relevant: false }), generate, query: fakeDB().query, logAgentActivity: noopLog } });
  assert.equal(genCalled, false, 'generation must never run for irrelevant items');
  assert.equal(s.dropped_irrelevant, 2);
  assert.equal(s.drafts_created, 0);
});

test('dedup: the same source_ref twice produces exactly one row', async () => {
  const db = fakeDB();
  const dup = item(1); // identical source_ref both times
  const s = await runContentPipeline('golfnex', { deps: { env: ON, source: srcOf([dup, dup]), classify: okClassify(), generate: okGenerate(), query: db.query, logAgentActivity: noopLog } });
  assert.equal(s.drafts_created, 1, 'first insert creates the row');
  assert.equal(s.duplicates, 1, 'second is an ON CONFLICT no-op');
  assert.equal(db.rows.size, 1, 'exactly one row persisted');
});

test('happy path: relevant items become drafts with topic/segment/cost', async () => {
  const db = fakeDB(); let insertParams;
  const q = async (sql, params) => { insertParams = params; return db.query(sql, params); };
  const s = await runContentPipeline('golfnex', { deps: { env: ON, source: srcOf([item(1)]), classify: okClassify(), generate: okGenerate(), query: q, logAgentActivity: noopLog } });
  assert.equal(s.drafts_created, 1);
  assert.equal(insertParams[0], 'golfnex');                 // product
  assert.equal(insertParams[1], 'https://ex.com/1');        // source_ref
  assert.equal(insertParams[2], 'equipment');               // topic
  assert.equal(insertParams[3], 'player');                  // segment
  assert.equal(insertParams[4], 'H');                       // headline
  assert.ok(Math.abs(insertParams[6] - 0.011) < 1e-9, 'cost_usd = classify + generate');
  assert.ok(s.cost_usd > 0);
});

test('unknown product → config error, no throw', async () => {
  let s;
  await assert.doesNotReject(async () => { s = await runContentPipeline('nope', { deps: { env: ON, source: srcOf([item(1)]), logAgentActivity: noopLog } }); });
  assert.ok(s.errors.some(e => e.stage === 'config'));
});

// ── news-source parseItem (pure) ────────────────────────────────────────────────
test('news-source.parseItem uses the article URL as the stable source_ref', () => {
  const p = parseItem({ url: 'https://x.com/a', title: 'T', publishedAt: '2026-08-22T00:00:00Z', description: 'd' });
  assert.equal(p.source_ref, 'https://x.com/a');
  assert.equal(p.url, 'https://x.com/a');
  assert.equal(p.title, 'T');
  assert.equal(p.published_at, '2026-08-22T00:00:00Z');
  assert.equal(p.summary, 'd');
  // falls back to content when description is missing; null source_ref when no url
  assert.equal(parseItem({ title: 'T', content: 'c' }).summary, 'c');
  assert.equal(parseItem({ title: 'T' }).source_ref, null);
});

// ── config: adding a product is data, not code ──────────────────────────────────
test('golfnex config exposes topics, segments, voice, and per-stage models', () => {
  const c = getConfig('golfnex');
  assert.deepEqual(c.topics, ['equipment', 'tournaments', 'course-openings', 'instruction', 'industry']);
  assert.deepEqual(c.segments, ['facility_owner', 'player']);
  assert.ok(c.voice && c.classifyModel && c.generateModel && c.query);
  assert.equal(getConfig('unknown'), null);
});
