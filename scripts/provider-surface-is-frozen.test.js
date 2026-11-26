#!/usr/bin/env node
// ── THE PROVIDER SURFACE IS FROZEN, AND UNACCOUNTED FEATURES ARE ABSENT ─────
//
//   node --test scripts/provider-surface-is-frozen.test.js
//
// Owner's Priority 5, 2026-11-26: *"Freeze provider, exact model version, pricing and permitted
// billing features; disable unaccounted features."*
//
// ── WHY THIS IS A TEST AND NOT A PARAGRAPH ─────────────────────────────────
//
// "Frozen" is a claim about what the code can do, and a document cannot hold it. The spend ceiling
// is computed from the request body by `maxInputTokens(buildRequestBody(...))` — so the bound is
// only a bound over the fields that body contains. Every Anthropic request feature that is billed
// but is NOT a text input token is therefore a hole in the ceiling, whatever the document says:
//
//   · `tools` / server-side tool use   — billed, and the tool definitions are themselves input
//   · prompt caching (`cache_control`) — cache WRITES cost more than ordinary input
//   · extended thinking (`thinking`)   — thinking tokens are billed as output
//   · images and documents             — billed by a function of pixels and pages, not of bytes
//   · `stream`                         — not itself billed, but it changes where usage is reported,
//                                        and usage is what settlement reconciles against
//   · the Batches API                  — a different endpoint with different pricing
//   · `anthropic-beta` headers         — the mechanism by which any of the above arrives
//
// None of these are reachable today, and the reason is structural rather than a rule somebody
// follows: `buildRequestBody` is the ONLY thing that constructs a body, and it builds four fields.
// This test asserts that, so adding a fifth is a change that fails here and has to be argued —
// which is the whole point of a freeze.
//
// It costs nothing and reaches no provider: it reads the module and calls one pure function.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'src', 'lib', 'llm.js');
const CODE = fs.readFileSync(FILE, 'utf8');
const llm = require('../src/lib/llm');

// Comments discuss these features at length — that is how the reasoning is recorded — so every
// pattern below is matched against EXECUTABLE code with comments stripped. A scanner that cannot
// tell a comment from a field is measuring prose, which this repository has learned twice.
const EXEC = CODE
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');

test('the provider and the API version are pinned to exact literals', () => {
  assert.equal(llm.ANTHROPIC_URL, 'https://api.anthropic.com/v1/messages',
    'the endpoint is frozen: /v1/messages, not /v1/messages/batches, which prices differently');
  assert.equal(llm.ANTHROPIC_VERSION, '2023-06-01',
    'the anthropic-version header is frozen; a newer version can change defaults');
  assert.equal(/anthropic-beta/i.test(EXEC), false,
    'no anthropic-beta header: beta headers are how an unpriced feature arrives');
});

test('every model alias resolves to an exact, dated or versioned id', () => {
  // An alias that resolved to a moving target would mean the model that runs tomorrow is not the
  // one whose pricing was frozen today.
  const aliases = llm.MODEL_ALIASES;
  assert.deepEqual(Object.keys(aliases).sort(), ['balanced', 'deep', 'fast'],
    'the alias set itself is frozen');
  for (const [name, id] of Object.entries(aliases)) {
    assert.match(id, /^claude-[a-z0-9-]+$/, `${name} resolves to a malformed id`);
    assert.equal(/latest/.test(id), false,
      `${name} resolves to ${id}, which is a moving target: "latest" cannot have frozen pricing`);
  }
  // The one the live-model procedure authorizes, named explicitly so a change to it is visible
  // here and not only in the procedure document.
  assert.equal(aliases.fast, 'claude-haiku-4-5-20251001',
    'the live-model procedure authorizes exactly this model id');
});

test('an unknown model is priced at the MOST expensive tier, not the cheapest', () => {
  // The direction of the fallback is the safety property. A cheap default would under-hold for an
  // expensive model, which is the one way this arithmetic can lose money.
  const [unkIn, unkOut] = llm.ratesFor('claude-something-nobody-has-priced');
  const [haikuIn, haikuOut] = llm.ratesFor('claude-haiku-4-5-20251001');
  assert.ok(unkIn > haikuIn && unkOut > haikuOut,
    'an unpriced model must cost MORE in the estimate than the cheapest known one');
  // Every listed tier has positive rates, so no model is priced at zero by accident.
  for (const m of ['claude-fable-5', 'claude-mythos-5', 'claude-opus-4',
    'claude-sonnet', 'claude-haiku']) {
    const [i, o] = llm.ratesFor(m);
    assert.ok(i > 0 && o > 0, `${m} has a non-positive rate`);
  }
});

test('pricing is output-heavier than input, which is what makes max_tokens the lever', () => {
  // The ceiling is exact on the output side because `max_tokens` is sent; it is an ESTIMATE on the
  // input side. That asymmetry only helps if output is the expensive half, and it is.
  for (const m of ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-4-8']) {
    const [inR, outR] = llm.ratesFor(m);
    assert.ok(outR > inR, `${m}: output must be dearer than input for the bound to be meaningful`);
  }
});

test('buildRequestBody produces EXACTLY the four permitted fields', () => {
  // The freeze, stated as the shape of the thing actually sent.
  const body = llm.buildRequestBody({
    model: 'claude-haiku-4-5-20251001', system: 'a system prompt', prompt: 'hello', maxTokens: 64,
  });
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'system'],
    'the request body has a field that is not one of the four permitted ones');
  assert.equal(body.messages.length, 1, 'exactly one message: one user turn, no history');
  assert.deepEqual(Object.keys(body.messages[0]).sort(), ['content', 'role'],
    'a message carries only a role and content — no cache_control, no content blocks');
  assert.equal(typeof body.messages[0].content, 'string',
    'content is a STRING, not a block array: block arrays are how images, documents and '
    + 'cache_control enter a request');

  // And with no system prompt it is three fields, identical to a no-system call.
  const bare = llm.buildRequestBody({ model: 'claude-haiku-4-5-20251001', prompt: 'x' });
  assert.deepEqual(Object.keys(bare).sort(), ['max_tokens', 'messages', 'model']);
});

test('max_tokens is always present, so the output side of the ceiling is exact', () => {
  // A request with no max_tokens would be bounded only by the model's own limit, and the held
  // worst case would be an estimate on BOTH sides.
  for (const mt of [undefined, null, 0, 1, 4096]) {
    const b = llm.buildRequestBody({ model: 'claude-haiku-4-5-20251001', prompt: 'x', maxTokens: mt });
    assert.equal(typeof b.max_tokens, 'number', `max_tokens missing for maxTokens=${String(mt)}`);
    assert.ok(b.max_tokens > 0, `max_tokens must be positive (got ${b.max_tokens})`);
  }
});

test('no unaccounted billing feature appears in executable code', () => {
  // Each of these is billed, or changes where billing is reported, and none is covered by a
  // function of the text's length. The point is not that they are forbidden for ever — it is that
  // adding one must fail here, so the ceiling is revisited in the same change.
  const FORBIDDEN = [
    ['tools', /\btools\s*:/],
    ['tool_choice', /\btool_choice\b/],
    ['cache_control', /\bcache_control\b/],
    ['thinking', /\bthinking\s*:/],
    ['stream', /\bstream\s*:\s*true\b/],
    ['batches endpoint', /messages\/batches/],
    ['image content block', /"type"\s*:\s*"image"|'type'\s*:\s*'image'|type:\s*'image'/],
    ['document content block', /type:\s*'document'|"type"\s*:\s*"document"/],
    ['web search tool', /web_search/],
    ['code execution tool', /code_execution/],
    ['computer use tool', /computer_\d{8}|\bcomputer_use\b/],
    ['citations', /\bcitations\s*:/],
    ['service_tier', /\bservice_tier\b/],
  ];
  for (const [name, re] of FORBIDDEN) {
    assert.equal(re.test(EXEC), false,
      `${name} appears in executable code in llm.js: it is billed (or moves where usage is `
      + 'reported) and the spend ceiling is computed from text length, so it must not be reachable '
      + 'without the ceiling being reconsidered in the same change');
  }
});

test('CONTROL: the forbidden patterns fire on planted code and not on prose', () => {
  // Without this the test above could be a silencing rather than a check — nine of those patterns
  // would also "pass" if they simply never matched anything.
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');

  assert.equal(/\btools\s*:/.test(strip('  const body = { tools: [defn] };')), true,
    'planted tools must be caught');
  assert.equal(/\btools\s*:/.test(strip('  // tools: never sent, see the freeze')), false,
    'the same text in a comment must NOT be caught');
  assert.equal(/\bcache_control\b/.test(strip('x.cache_control = {type:"ephemeral"};')), true,
    'planted cache_control must be caught');
  assert.equal(/\bcache_control\b/.test(strip('/* cache_control is discussed here */')), false,
    'cache_control in a block comment must NOT be caught');
  assert.equal(/\bstream\s*:\s*true\b/.test(strip('fetch(u,{body:JSON.stringify({stream: true})})')),
    true, 'planted streaming must be caught');
  // And a field that merely CONTAINS a forbidden word is not a false positive:
  assert.equal(/\btools\s*:/.test(strip('const toolsAvailable = 0;')), false,
    'an identifier containing the word must not trip it');
});

test('only ONE function builds a request body', () => {
  // The freeze rests on `buildRequestBody` being the single constructor. A second place that
  // assembles a body would be a second surface, and this test would have no opinion about it.
  const bodies = (EXEC.match(/max_tokens\s*:/g) || []).length;
  assert.equal(bodies, 1,
    `max_tokens is assigned in ${bodies} places: there must be exactly one request builder, or `
    + 'the ceiling is computed from a body that is not the one sent');
  // The fetch must send the body `buildRequestBody` returned. Matched by tracing the variable:
  // whatever name the body is bound to, it must come FROM that function and be what is stringified.
  const bound = EXEC.match(/const\s+(\w+)\s*=\s*buildRequestBody\(/);
  assert.ok(bound, 'callClaude does not obtain its body from buildRequestBody at all');
  assert.ok(new RegExp(`body:\\s*JSON\\.stringify\\(\\s*${bound[1]}\\b`).test(EXEC),
    `the fetch does not send ${bound[1]}, the body buildRequestBody produced — a body assembled `
    + 'at the call site would not be the one the spend ceiling was computed from');
});

test('the usage the settlement reads is the provider\'s own, never inferred', () => {
  // `costOf` must take the provider's reported usage. A cost derived from our own token estimate
  // would make the reconciliation compare an estimate against itself, which is how B3.15 would
  // pass without measuring anything.
  // Argument order is (usage, model) — my first version had it reversed, and `ratesFor` fell
  // through to the conservative opus tier while `usage` was a string with no token fields, so the
  // cost came out 0 and the test read as a product failure. A signature guessed from the name.
  const measured = llm.costOf({ input_tokens: 1000, output_tokens: 500 },
    'claude-haiku-4-5-20251001');
  assert.equal(measured.costKnown, true);
  assert.ok(measured.costUsd > 0, 'a measured call has a positive cost');

  // No usage at all is UNKNOWN, not zero. "Failed therefore free" is the assumption this whole
  // financial lifecycle exists to refuse.
  assert.equal(llm.COST_UNKNOWN.costKnown, false);
  assert.equal(llm.COST_UNKNOWN.costUsd, null,
    'an unmeasured call must carry NO dollar figure — writing 0 makes "zero spend" ambiguous');
  assert.equal(llm.COST_NONE.costKnown, true);
  assert.equal(llm.COST_NONE.costUsd, 0,
    'nothing left the process, so nothing was spent — distinct from "we could not tell"');
});
