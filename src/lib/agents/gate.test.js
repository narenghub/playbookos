// Tool-call gate tests — run with:  node --test src/lib/agents/gate.test.js
// Hermetic: resolve, the audit query, fireDenial, and each agent's entry point are injected
// via deps. No real DB, no real agent execution, no network.

const { test } = require('node:test');
const assert = require('node:assert');
const { callAgent } = require('./gate');

// capture audit-insert param arrays
function capQuery() { const rows = []; const q = (_sql, params) => { rows.push(params); return Promise.resolve({ rows: [] }); }; q.rows = rows; return q; }
const allow = (rule = 7, explain = 'ok') => async () => ({ allowed: true, rule, source: null, explain });
const deny = (rule = 8, explain = 'no rule matched') => async () => ({ allowed: false, rule, source: null, explain });
const USER = { id: 'u1', email: 'u@x', role: 'admin' };
// stub content entry-point (contract's content adapter uses deps.runContentPipeline)
const contentImpl = (over = {}) => async (product) => ({ product, drafts_created: 2, cost_usd: 0.05, tokens: { input: 100, output: 40 }, ...over });

// ── deny path ────────────────────────────────────────────────────────────────
test('DENY writes an audit row, does NOT execute, and calls fireDenial', async () => {
  const q = capQuery(); let denials = 0; let ranImpl = false;
  const res = await callAgent(USER, 'content-pipeline', {
    product: 'golfnex',
    deps: {
      query: q, resolve: deny(8, 'no'), fireDenial: () => { denials++; },
      runContentPipeline: async () => { ranImpl = true; return {}; },
    },
  });
  assert.equal(res.allowed, false);
  assert.equal(res.summary, null);
  assert.equal(ranImpl, false, 'agent must NOT execute on deny');
  assert.equal(res.audit.decision, 'deny');
  assert.equal(res.audit.decision_rule, 8);
  assert.equal(res.audit.feature_key, 'intelligence.content.run');
  assert.equal(res.audit.product, 'golfnex');
  assert.equal(res.audit.success, false);
  assert.equal(q.rows.length, 1, 'one tool_call_audit row written');
  assert.equal(denials, 1, 'existing fireDenial invoked');
});

// ── allow path ───────────────────────────────────────────────────────────────
test('ALLOW executes, audits, and captures cost/tokens/latency', async () => {
  const q = capQuery();
  let seenFeature;
  const res = await callAgent(USER, 'content-pipeline', {
    product: 'golfnex',
    deps: {
      query: q,
      resolve: async (u, fk) => { seenFeature = fk; return { allowed: true, rule: 7, explain: 'template' }; },
      runContentPipeline: contentImpl(),
      now: (() => { let n = 1000; return () => (n += 50); })(), // deterministic latency
    },
  });
  assert.equal(seenFeature, 'intelligence.content.run', 'resolve called with the agent featureKey');
  assert.equal(res.allowed, true);
  assert.equal(res.summary.drafts_created, 2);
  assert.equal(res.audit.decision, 'allow');
  assert.equal(res.audit.success, true);
  assert.equal(res.audit.cost_usd, 0.05);
  assert.equal(res.audit.tokens_input, 100);
  assert.equal(res.audit.tokens_output, 40);
  assert.ok(res.audit.latency_ms >= 0, 'latency recorded');
  assert.equal(res.audit.product, 'golfnex');
  assert.equal(q.rows.length, 1);
});

// ── throwing agent ───────────────────────────────────────────────────────────
test('a THROWING agent audits success=false with the error, gate does not throw', async () => {
  const q = capQuery();
  let res;
  await assert.doesNotReject(async () => {
    res = await callAgent(USER, 'content-pipeline', {
      product: 'golfnex',
      deps: { query: q, resolve: allow(), runContentPipeline: async () => { throw new Error('kaboom'); } },
    });
  });
  assert.equal(res.allowed, true, 'it was authorised; execution failed');
  assert.equal(res.summary, null);
  assert.equal(res.audit.success, false);
  assert.match(res.audit.error, /kaboom/);
  assert.equal(res.audit.decision, 'allow');
  assert.equal(q.rows.length, 1, 'failure still audited (not a lost call)');
});

// ── failing audit write ──────────────────────────────────────────────────────
test('a FAILING audit write does not break the agent result', async () => {
  const throwingQ = () => { throw new Error('audit db down'); };
  let res;
  await assert.doesNotReject(async () => {
    res = await callAgent(USER, 'content-pipeline', {
      product: 'golfnex',
      deps: { query: throwingQ, resolve: allow(), runContentPipeline: contentImpl() },
    });
  });
  assert.equal(res.allowed, true);
  assert.equal(res.summary.drafts_created, 2, 'result intact despite audit-write failure');
});

test('a REJECTING async audit write does not break the result', async () => {
  const rejectingQ = () => Promise.reject(new Error('audit timeout'));
  let res;
  await assert.doesNotReject(async () => {
    res = await callAgent(USER, 'content-pipeline', { product: 'golfnex', deps: { query: rejectingQ, resolve: allow(), runContentPipeline: contentImpl() } });
  });
  assert.equal(res.summary.drafts_created, 2);
});

// ── product always recorded ──────────────────────────────────────────────────
test('product is ALWAYS recorded — ctx.product, entry default, and unknown', async () => {
  const q = capQuery();
  // ctx.product wins
  let r = await callAgent(USER, 'content-pipeline', { product: 'abiozen', deps: { query: q, resolve: allow(), runContentPipeline: contentImpl() } });
  assert.equal(r.audit.product, 'abiozen');
  // entry default when ctx.product omitted (content default = golfnex)
  r = await callAgent(USER, 'content-pipeline', { deps: { query: q, resolve: allow(), runContentPipeline: contentImpl() } });
  assert.equal(r.audit.product, 'golfnex');
  // unknown agent still records a product ('unknown') and never NULL
  r = await callAgent(USER, 'nope', { deps: { query: q } });
  assert.equal(r.allowed, false);
  assert.equal(r.audit.product, 'unknown');
  assert.ok(r.audit.product, 'product never null');
  assert.match(r.audit.error, /unknown agent/);
});

// ── both registered agents run through the gate ──────────────────────────────
test('both registered agents run through the gate', async () => {
  const q = capQuery();
  const c = await callAgent(USER, 'content-pipeline', { product: 'golfnex', deps: { query: q, resolve: allow(), runContentPipeline: contentImpl() } });
  assert.equal(c.allowed, true);
  assert.equal(c.audit.tool_name, 'content-pipeline');
  assert.equal(c.audit.feature_key, 'intelligence.content.run');

  const r = await callAgent(USER, 'research-intelligence', {
    deps: { query: q, resolve: allow(), runResearchIntelIngest: async (o) => ({ studies_new: 3, dry_run: o.dryRun, cost_usd: 0.02, tokens: { input: 10, output: 5 } }) },
    args: { maxStudies: 5, dryRun: true },
  });
  assert.equal(r.allowed, true);
  assert.equal(r.audit.tool_name, 'research-intelligence');
  assert.equal(r.audit.feature_key, 'intelligence.research_intelligence.run');
  assert.equal(r.audit.product, 'abiozen', 'RI attributed to its fixed product');
  assert.equal(r.summary.studies_new, 3);
  assert.equal(r.audit.cost_usd, 0.02);
});

// ── resolver error → fail closed, audited ────────────────────────────────────
test('resolver error fails CLOSED (deny), audited, no execution', async () => {
  const q = capQuery(); let ran = false;
  const res = await callAgent(USER, 'content-pipeline', {
    product: 'golfnex',
    deps: { query: q, resolve: async () => { throw new Error('resolve boom'); }, runContentPipeline: async () => { ran = true; return {}; } },
  });
  assert.equal(res.allowed, false);
  assert.equal(ran, false);
  assert.equal(res.audit.decision, 'deny');
  assert.match(res.audit.decision_explain, /resolver error/);
});
