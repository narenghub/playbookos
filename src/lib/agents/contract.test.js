// Agent contract/registry tests — run with:  node --test src/lib/agents/contract.test.js
// Hermetic: agents are exercised through injected entry-point stubs (deps) so no real agent
// runs. Also proves the content adapter round-trips a REAL run via the flag-off no-op path.

const { test } = require('node:test');
const assert = require('node:assert');
const { REGISTRY, validateEntry, getAgent, listAgents, featureFor, runAgent } = require('./contract');
const { FEATURES } = require('../permissions/registry');
const FKEYS = new Set(FEATURES.map(f => f.key));

// ── registry integrity ─────────────────────────────────────────────────────────
test('every registered entry validates, has a real featureKey, and a product', () => {
  assert.equal(REGISTRY.length, 2);
  for (const e of REGISTRY) {
    assert.deepEqual(validateEntry(e), [], `entry '${e.name}' should validate`);
    assert.ok(e.product && typeof e.product === 'string', `${e.name} has a product`);
    assert.ok(FKEYS.has(e.featureKey), `${e.name} featureKey exists in permissions registry`);
    assert.equal(typeof e.run, 'function');
  }
  assert.deepEqual(listAgents().map(a => a.name).sort(), ['content-pipeline', 'research-intelligence']);
  // listAgents must not leak the run function
  assert.ok(listAgents().every(a => !('run' in a)));
});

test('costClass matches the referenced registry feature', () => {
  for (const e of REGISTRY) {
    assert.equal(e.costClass, featureFor(e.name).cost, `${e.name} costClass == registry cost`);
  }
});

// ── validation rules ─────────────────────────────────────────────────────────────
test('product is REQUIRED', () => {
  const errs = validateEntry({ name: 'x', featureKey: 'intelligence.content.run', run: () => {} });
  assert.ok(errs.some(e => /product is required/.test(e)), 'missing product is an error: ' + errs.join('; '));
});

test('featureKey must exist in the permissions registry', () => {
  const errs = validateEntry({ name: 'x', product: 'p', featureKey: 'bogus.not.a.key', run: () => {} });
  assert.ok(errs.some(e => /not found in permissions registry/.test(e)), errs.join('; '));
});

test('run must be a function; inputSchema must be a plain object', () => {
  assert.ok(validateEntry({ name: 'x', product: 'p', featureKey: 'intelligence.content.run' }).some(e => /run must be a function/.test(e)));
  assert.ok(validateEntry({ name: 'x', product: 'p', featureKey: 'intelligence.content.run', run: () => {}, inputSchema: [] }).some(e => /inputSchema must be a plain object/.test(e)));
});

// ── running through the contract ────────────────────────────────────────────────
test('a registered agent runs through the contract and returns its summary (content, injected impl)', async () => {
  let seen;
  const summary = await runAgent('content-pipeline', {
    user: { id: 'u1', role: 'admin' },
    product: 'golfnex',
    args: { dryRun: true },
    deps: { runContentPipeline: async (product, opts) => { seen = { product, opts }; return { product, ok: true, dry_run: opts.dryRun }; } },
  });
  assert.deepEqual(summary, { product: 'golfnex', ok: true, dry_run: true });
  assert.equal(seen.product, 'golfnex');
  assert.equal(seen.opts.dryRun, true);
  assert.ok('deps' in seen.opts, 'deps forwarded to the underlying agent');
});

test('research-intelligence adapter maps args → its options and attributes product abiozen', async () => {
  let opts;
  const summary = await runAgent('research-intelligence', {
    args: { maxStudies: 7, dryRun: true },
    deps: { runResearchIntelIngest: async (o) => { opts = o; return { studies_new: 0, dry_run: o.dryRun }; } },
  });
  assert.deepEqual(opts, { dryRun: true, maxStudies: 7 });
  assert.equal(summary.dry_run, true);
  // product defaults to the entry's declared 'abiozen' when ctx.product is omitted
  assert.equal(getAgent('research-intelligence').product, 'abiozen');
});

test('product defaults to the entry product when ctx.product is omitted', async () => {
  let seenProduct;
  await runAgent('content-pipeline', {
    deps: { runContentPipeline: async (product) => { seenProduct = product; return { product }; } },
  });
  assert.equal(seenProduct, 'golfnex', 'falls back to entry.product');
});

test('content adapter round-trips a REAL run via the flag-off no-op path (hermetic, no I/O)', async () => {
  // CONTENT_PIPELINE_ENABLED unset → runContentPipeline returns enabled:false with no fetch/LLM/DB.
  const summary = await runAgent('content-pipeline', { product: 'golfnex', deps: { env: {} } });
  assert.equal(summary.enabled, false);
  assert.equal(summary.product, 'golfnex');
  assert.equal(summary.drafts_created, 0);
});

// ── unknown agent ────────────────────────────────────────────────────────────────
test('unknown agent name errors clearly and lists the registered ones', async () => {
  await assert.rejects(() => runAgent('nope'), /Unknown agent 'nope'.*content-pipeline.*research-intelligence/s);
  assert.equal(getAgent('nope'), null);
});
