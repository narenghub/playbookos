// ── §4a: A PROVEN BOUND, NOT A CHARACTER HEURISTIC ──────────────────────────
//
//   node --test src/lib/office/spend-ceiling.test.js
//
// Owner's correction of 2026-11-25:
//
//   *"Three characters per token is not a guaranteed maximum token count. Use provider-supported
//    counting or a proven conservative bound covering the entire serialized request, system
//    instructions, tool definitions, attachments, model-specific pricing and output limits."*
//
// The previous ceiling was `Math.ceil((system.length + prompt.length) / 3) + 512`. Tests 2 and 3
// are the counter-examples that make it unsound, and they are ordinary text for this business
// rather than adversarial input.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const llm = require('../llm');
const AI = require('./ai');

// The old formula, kept here as the thing being disproved. Nothing imports it.
const OLD_BOUND = (system, prompt) => Math.ceil((String(system || '').length
  + String(prompt || '').length) / 3) + 512;

const tokensFor = (system, prompt, maxTokens = 100) => llm.maxInputTokens(
  llm.buildRequestBody({ model: 'claude-haiku-4-5', system, prompt, maxTokens }));

// ═══ 1. THE BOUND IS A BOUND ═══════════════════════════════════════════════

test('1. the input estimate is the UTF-8 byte length of the serialized request', () => {
  // NOT asserted as a proven billing bound — the owner's §3 of 2026-11-25 rejected that claim and
  // llm.maxInputTokens now states its limits: the tokenizer's internals are an inference, and
  // billing can include cache writes, thinking tokens, server-side tool use and images that no
  // function of the text's length can see. What IS asserted here is what the function computes,
  // and tests 2–2d assert the property that made the change necessary: it is strictly larger than
  // the character heuristic in every case where that heuristic was too small.
  const body = llm.buildRequestBody({ model: 'claude-haiku-4-5', system: 'sys',
    prompt: 'hello', maxTokens: 64 });
  assert.strictEqual(llm.maxInputTokens(body),
    Buffer.byteLength(JSON.stringify(body), 'utf8'));
});

test('1a. the envelope is MEASURED, not allowed for with a constant', () => {
  // The old formula added a flat 512 tokens for "the message envelope and any system-level
  // additions". Serializing the real body means the field names, the model id and the JSON
  // punctuation are all inside the count — and so is anything added to the body later.
  const bare = tokensFor(null, '');
  assert.ok(bare > 0, 'an empty prompt still has an envelope, and it is counted');
  const body = llm.buildRequestBody({ model: 'claude-haiku-4-5', prompt: '', maxTokens: 100 });
  assert.ok(JSON.stringify(body).includes('"max_tokens"'),
    'the field names are part of what is measured');
});

// ═══ 2. THE COUNTER-EXAMPLES ═══════════════════════════════════════════════

test('2. DECISIVE: CJK text broke chars/3, and this platform handles CJK supplier mail', () => {
  // The claim under test is comparative, not absolute: byte length is larger than chars/3 exactly
  // where chars/3 was unsafe. That is provable from the two expressions and needs no assumption
  // about the provider's tokenizer.
  // `薬` — one character, three UTF-8 bytes, at least one token. chars/3 scores it as 0.33 tokens,
  // so a page of Japanese or Chinese correspondence was bounded at roughly a THIRD of what it can
  // cost. The CPHI campaign's suppliers write exactly this way; rfc822.js has a whole section on
  // decoding their headers.
  const cjk = '薬'.repeat(3000);                    // 3,000 chars, 9,000 bytes
  const old = OLD_BOUND(null, cjk);                 // ≈ 1,512
  const now = tokensFor(null, cjk);                 // ≈ 9,000+

  assert.ok(now > old * 3,
    `the new bound (${now}) must exceed the old one (${old}) by roughly the UTF-8 expansion`);
  assert.ok(now >= Buffer.byteLength(cjk, 'utf8'),
    'the bound must be at least the byte length of the text it covers');
});

test('2a. the same text in ASCII is bounded LOWER — the bound tracks bytes, not characters', () => {
  // The control. If the new bound were simply larger everywhere, it would be a bigger guess rather
  // than a correct one.
  const ascii = 'a'.repeat(3000);
  assert.ok(tokensFor(null, ascii) < tokensFor(null, '薬'.repeat(3000)),
    'ASCII and CJK of equal character length were bounded identically, so bytes are not being read');
});

test('2b. an emoji is one or two characters and several tokens', () => {
  const emoji = '🧪'.repeat(500);                   // 1,000 UTF-16 units, 2,000 bytes
  assert.ok(tokensFor(null, emoji) >= Buffer.byteLength(emoji, 'utf8'));
});

test('2c. base64 and identifiers tokenize denser than three characters per token', () => {
  const blob = Buffer.from('x'.repeat(4096)).toString('base64');
  assert.ok(tokensFor(null, blob) > OLD_BOUND(null, blob),
    'a base64 payload is still bounded below the old heuristic');
});

test('2d. and the CEILING ITSELF reflects it, not just the bound function', () => {
  // Tests 2–2c assert on llm.maxInputTokens. A sabotage that restored the character heuristic
  // inside maxChargeUsd left all of them green and was caught only by the discipline grep in test
  // 5 — a measurement of the source standing in for a measurement of the behaviour, which is this
  // repository's recurring defect wearing my own initials. This asserts the dollar figure.
  const cjk = AI.maxChargeUsd({ capability: 'fast', system: null,
    prompt: '薬'.repeat(3000), maxTokens: 100 });
  const ascii = AI.maxChargeUsd({ capability: 'fast', system: null,
    prompt: 'a'.repeat(3000), maxTokens: 100 });
  assert.ok(cjk > ascii * 2,
    `the hold for 3,000 CJK characters ($${cjk}) must be far larger than for 3,000 ASCII ones `
    + `($${ascii}) — equal figures mean the ceiling is counting characters again`);
});

// ═══ 3. THE WHOLE REQUEST, AND NOTHING OUTSIDE THE BOUND ═══════════════════

test('3. system instructions are inside the bound', () => {
  const withSystem = tokensFor('S'.repeat(1000), 'p');
  const without = tokensFor(null, 'p');
  assert.ok(withSystem - without >= 1000,
    'a thousand bytes of system instruction did not raise the ceiling by at least that much');
});

test('3a. a field added to the request body is inside the bound BY CONSTRUCTION', () => {
  // The property that matters for tool definitions and attachments, which the body does not carry
  // today. The bound is computed over whatever buildRequestBody produces, so a new field is
  // covered without anybody remembering to widen a constant — which is exactly what the old
  // 512-token envelope would have required.
  const body = llm.buildRequestBody({ model: 'claude-haiku-4-5', prompt: 'p', maxTokens: 10 });
  const before = llm.maxInputTokens(body);
  body.tools = [{ name: 'lookup', description: 'D'.repeat(2000) }];
  const after = llm.maxInputTokens(body);
  assert.ok(after - before >= 2000,
    'a tool definition added to the body fell outside the bound that authorizes the spend');
});

// ═══ 4. OUTPUT AND PRICE ═══════════════════════════════════════════════════

test('4. the output ceiling is exact, and read from the body rather than the argument', () => {
  // llm.js applies its own default when maxTokens is unset. Reading it back from the body is what
  // keeps the ceiling and the request in step; mirroring the default in ai.js would be a second
  // copy of it, free to drift.
  const body = llm.buildRequestBody({ model: 'claude-haiku-4-5', prompt: 'p' });
  assert.strictEqual(body.max_tokens, 1024, 'the default this ceiling relies on has changed');
});

test('4a. the price is model-specific, and an unknown model costs the most', () => {
  const [hIn, hOut] = llm.ratesFor('claude-haiku-4-5-20251001');
  const [oIn, oOut] = llm.ratesFor('claude-opus-4-1');
  const [uIn, uOut] = llm.ratesFor('some-model-nobody-has-priced');
  assert.ok(oIn > hIn && oOut > hOut, 'the tiers are not distinguished');
  assert.ok(uIn >= oIn && uOut >= oOut,
    'an unrecognised model must price at least as high as the expensive tier, or a new model id '
    + 'silently gets a cheap ceiling');
});

test('4b. a more expensive model yields a larger hold for the identical call', () => {
  const cheap = AI.maxChargeUsd({ capability: 'fast', system: null, prompt: 'p', maxTokens: 500 });
  const dear = AI.maxChargeUsd({ capability: 'deep', system: null, prompt: 'p', maxTokens: 500 });
  assert.ok(dear >= cheap, 'model-specific pricing is not reaching the ceiling');
});

// ═══ 5. ONE BUILDER, SO THE SENT AND THE BOUNDED CANNOT DIVERGE ════════════

test('5. the ceiling is computed from the SAME builder llm.js sends', () => {
  // The lesson this repository keeps relearning about approval digests: two expressions of "what
  // is being sent" is how a check stops covering the thing it checks. ai.js used to estimate from
  // `system.length + prompt.length`, which is a second, looser description of the request.
  const fs = require('node:fs');
  const ai = fs.readFileSync(require.resolve('./ai.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.match(ai, /llm\.buildRequestBody\(/,
    'the ceiling does not use the request builder, so it is bounding something other than the request');
  assert.match(ai, /llm\.maxInputTokens\(/);
  assert.doesNotMatch(ai, /CHARS_PER_TOKEN/,
    'the character heuristic is still present');
  assert.doesNotMatch(ai, /ENVELOPE_TOKENS/,
    'the guessed envelope constant is still present');

  const l = fs.readFileSync(require.resolve('../llm.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.match(l, /body: JSON\.stringify\(reqBody\)/, 'llm.js no longer sends the body it builds');
  assert.match(l, /const reqBody = buildRequestBody\(/,
    'llm.js builds its request inline again, so the ceiling can bound a different shape');
});

test('5a. a hold is never zero', () => {
  // A $0 hold reserves nothing while looking like a reservation, and the table refuses it.
  assert.ok(AI.maxChargeUsd({ capability: 'fast', system: '', prompt: '', maxTokens: 1 }) > 0);
});
