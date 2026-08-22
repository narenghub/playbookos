// Shared LLM wrapper tests — run with:  node --test src/lib/llm.test.js
// No network: global.fetch is stubbed per test. Proves the never-throws contract, the
// usage/cost math, and that expectJson yields null (not a throw) on unparseable output.

const { test } = require('node:test');
const assert = require('node:assert');
const { callClaude, costOf, ratesFor } = require('./llm');

const KEY = 'test-key';
const realFetch = global.fetch;
function stubFetch(fn) { global.fetch = fn; }
function restore() { global.fetch = realFetch; }
// a well-formed 200 response with the given content blocks + usage
function okResp(content, usage) {
  return { ok: true, json: async () => ({ content, usage }) };
}

test('NEVER THROWS on a network failure → { error }', async () => {
  stubFetch(async () => { throw new Error('ECONNRESET'); });
  try {
    let r;
    await assert.doesNotReject(async () => { r = await callClaude({ model: 'claude-sonnet-5', prompt: 'x', maxTokens: 100, apiKey: KEY }); });
    assert.match(r.error, /Claude request failed: ECONNRESET/);
    assert.equal(r.text, undefined);
  } finally { restore(); }
});

test('NEVER THROWS on a non-200 → { error } with status + truncated body', async () => {
  stubFetch(async () => ({ ok: false, status: 500, text: async () => 'internal boom' }));
  try {
    const r = await callClaude({ model: 'claude-sonnet-5', prompt: 'x', maxTokens: 100, apiKey: KEY });
    assert.equal(r.error, 'Claude 500: internal boom');
  } finally { restore(); }
});

test('NEVER THROWS on a non-JSON 200 body → { error }', async () => {
  stubFetch(async () => ({ ok: true, json: async () => { throw new Error('not json'); } }));
  try {
    let r;
    await assert.doesNotReject(async () => { r = await callClaude({ model: 'claude-sonnet-5', prompt: 'x', maxTokens: 100, apiKey: KEY }); });
    assert.match(r.error, /Claude response not JSON/);
  } finally { restore(); }
});

test('usage and costUsd are computed correctly (sonnet rates)', async () => {
  stubFetch(async () => okResp([{ type: 'text', text: '{"a":1}' }], { input_tokens: 1000, output_tokens: 2000 }));
  try {
    const r = await callClaude({ model: 'claude-sonnet-5', prompt: 'x', maxTokens: 100, apiKey: KEY, expectJson: true });
    assert.deepEqual(r.usage, { input_tokens: 1000, output_tokens: 2000 });
    // 1000 * $3/1e6 + 2000 * $15/1e6 = 0.003 + 0.03 = 0.033
    assert.ok(Math.abs(r.costUsd - 0.033) < 1e-9, 'costUsd should be 0.033, got ' + r.costUsd);
    assert.equal(r.text, '{"a":1}');
    assert.deepEqual(r.json, { a: 1 });
  } finally { restore(); }
});

test('expectJson returns null json (NOT a throw, NOT an error) on unparseable output', async () => {
  stubFetch(async () => okResp([{ type: 'text', text: 'totally not json' }], { input_tokens: 5, output_tokens: 5 }));
  try {
    let r;
    await assert.doesNotReject(async () => { r = await callClaude({ model: 'claude-sonnet-5', prompt: 'x', maxTokens: 100, apiKey: KEY, expectJson: true }); });
    assert.equal(r.json, null, 'json must be null, not thrown');
    assert.equal(r.error, undefined, 'unparseable output is not a call error');
    assert.equal(r.text, 'totally not json');
  } finally { restore(); }
});

test('extractClaudeText joins text blocks and skips a leading thinking block', async () => {
  stubFetch(async () => okResp([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: '{"ok":' }, { type: 'text', text: 'true}' }], null));
  try {
    const r = await callClaude({ model: 'claude-opus-4-8', prompt: 'x', maxTokens: 100, apiKey: KEY, expectJson: true });
    assert.equal(r.text, '{"ok":true}');
    assert.deepEqual(r.json, { ok: true });
    assert.equal(r.usage, null);
    assert.equal(r.costUsd, 0, 'no usage → cost 0');
  } finally { restore(); }
});

test('system is included only when provided; body shape matches the old inline calls', async () => {
  let captured = null;
  stubFetch(async (url, opts) => { captured = { url, body: JSON.parse(opts.body), headers: opts.headers }; return okResp([{ type: 'text', text: 'ok' }], null); });
  try {
    await callClaude({ model: 'claude-sonnet-5', prompt: 'hello', maxTokens: 700, apiKey: KEY });
    assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(captured.body.model, 'claude-sonnet-5');
    assert.equal(captured.body.max_tokens, 700);
    assert.deepEqual(captured.body.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal('system' in captured.body, false, 'no system field when not provided');
    assert.equal(captured.headers['anthropic-version'], '2023-06-01');
    assert.equal(captured.headers['x-api-key'], KEY);

    await callClaude({ model: 'claude-sonnet-5', system: 'be terse', prompt: 'hi', maxTokens: 50, apiKey: KEY });
    assert.equal(captured.body.system, 'be terse', 'system field present when provided');
  } finally { restore(); }
});

test('model is required; missing key is an error — both without touching the network', async () => {
  let fetched = false;
  stubFetch(async () => { fetched = true; return okResp([{ type: 'text', text: 'x' }], null); });
  try {
    assert.equal((await callClaude({ prompt: 'x', maxTokens: 10, apiKey: KEY })).error, 'model is required');
    assert.equal((await callClaude({ model: 'claude-sonnet-5', prompt: 'x', maxTokens: 10, apiKey: '' })).error, 'ANTHROPIC_API_KEY not configured');
    assert.equal(fetched, false, 'neither guard should hit the network');
  } finally { restore(); }
});

test('costOf / ratesFor — prefix matching and conservative default', () => {
  assert.deepEqual(ratesFor('claude-haiku-4-5-20251001'), [1.00 / 1e6, 5.00 / 1e6], 'dated haiku id resolves to haiku rates');
  assert.deepEqual(ratesFor('claude-opus-4-8'), [5.00 / 1e6, 25.00 / 1e6]);
  assert.deepEqual(ratesFor('claude-sonnet-5'), [3.00 / 1e6, 15.00 / 1e6]);
  assert.deepEqual(ratesFor('some-unknown-model'), [5.00 / 1e6, 25.00 / 1e6], 'unknown → opus-tier default');
  assert.equal(costOf(null, 'claude-sonnet-5'), 0, 'null usage → 0');
  assert.ok(Math.abs(costOf({ input_tokens: 1000, output_tokens: 1000 }, 'claude-haiku-4-5-20251001') - 0.006) < 1e-9);
});
