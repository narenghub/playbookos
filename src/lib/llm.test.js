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
    // C1: a SUCCESSFUL call that returned no usage is the exact case the ruling addresses — the
    // text arrived, tokens were certainly spent, and we cannot say how many. That is UNKNOWN, not
    // free. This assertion previously read `costUsd === 0`, which is the defect in test form.
    assert.equal(r.costUsd, null, 'no usage → cost UNKNOWN, never 0');
    assert.equal(r.costKnown, false, 'and it is flagged as unknown so a budget cannot read it as free');
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
  // C1: UNKNOWN COST IS NOT ZERO. This previously asserted `costOf(null) === 0`, which is the
  // defect: a budget built on it would treat every unmeasurable call as free, silently, because
  // $0.00 looks like a successful measurement of a cheap call. The three states must stay distinct.
  const unknown = costOf(null, 'claude-sonnet-5');
  assert.equal(unknown.costUsd, null, 'absent usage → costUsd null, never 0');
  assert.equal(unknown.costKnown, false, 'absent usage → costKnown false');

  const measured = costOf({ input_tokens: 1000, output_tokens: 1000 }, 'claude-haiku-4-5-20251001');
  assert.ok(Math.abs(measured.costUsd - 0.006) < 1e-9);
  assert.equal(measured.costKnown, true);

  // A REAL zero is a measurement and must not be confused with an absence.
  const realZero = costOf({ input_tokens: 0, output_tokens: 0 }, 'claude-haiku-4-5-20251001');
  assert.equal(realZero.costUsd, 0, 'zero usage → a real 0');
  assert.equal(realZero.costKnown, true, 'zero usage is KNOWN to be zero');
  assert.notEqual(realZero.costKnown, unknown.costKnown, 'a real zero and an unknown are distinguishable');
});

test('C2 — every provider request has a finite upper bound', () => {
  const { boundedTimeout, DEFAULT_LLM_TIMEOUT_MS, MIN_LLM_TIMEOUT_MS } = require('./llm');
  assert.equal(boundedTimeout(undefined), DEFAULT_LLM_TIMEOUT_MS, 'unspecified → the default bound');
  assert.equal(boundedTimeout(30000), 30000, 'a justified shorter bound is honoured');
  assert.equal(boundedTimeout(600000), 600000, 'a justified longer bound is honoured');
  // "Unbounded" is not a policy an autonomous kernel may express.
  assert.equal(boundedTimeout(0), DEFAULT_LLM_TIMEOUT_MS, '0 does NOT mean unlimited');
  assert.equal(boundedTimeout(-1), DEFAULT_LLM_TIMEOUT_MS, 'negative does NOT mean unlimited');
  assert.equal(boundedTimeout(Infinity), DEFAULT_LLM_TIMEOUT_MS, 'Infinity does NOT mean unlimited');
  assert.equal(boundedTimeout(null), DEFAULT_LLM_TIMEOUT_MS, 'null does NOT mean unlimited');
  assert.equal(boundedTimeout('nonsense'), DEFAULT_LLM_TIMEOUT_MS, 'garbage does NOT mean unlimited');
  assert.equal(boundedTimeout(1), MIN_LLM_TIMEOUT_MS, 'an absurdly small bound is floored, not zeroed');
});

test('C4 — capability aliases resolve, and a literal id still passes through', () => {
  const { resolveModel, MODEL_ALIASES } = require('./llm');
  assert.equal(resolveModel('fast'), MODEL_ALIASES.fast);
  assert.equal(resolveModel('balanced'), MODEL_ALIASES.balanced);
  assert.equal(resolveModel('deep'), MODEL_ALIASES.deep);
  assert.equal(resolveModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001',
    'a literal id is not mangled — existing callers are unaffected');
  assert.equal(resolveModel(null), null, 'no model stays no model, so the required-model check still fires');
  // The alias target must be a real-looking pin, not another alias.
  for (const [k, v] of Object.entries(MODEL_ALIASES)) {
    assert.ok(v.startsWith('claude-'), `alias ${k} resolves to a literal model id`);
    assert.equal(resolveModel(v), v, `alias ${k}'s target is itself literal, not chained`);
  }
});
