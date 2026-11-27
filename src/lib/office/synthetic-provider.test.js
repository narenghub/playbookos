// ── THE SYNTHETIC PROVIDER SEAM: WHAT IT REFUSES AND WHAT IT CANNOT BECOME ──
//
// B2.10 stage 4, approved 2026-11-26. The seam exists so a workflow can traverse a governed
// provider call without a paid one; everything here is about the two ways a seam like this goes
// wrong — it becomes reachable where it must not be, or it becomes a place where data turns into
// code.
//
// The database conditions are exercised against a real cluster by
// `scripts/check-synthetic-commercial-workflow-db.js`. These are the conditions that need no
// database, and the shape of the responder's output.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SYN = require('./synthetic-provider');

// ═══ 1. THE FLAG IS A BOOLEAN, AND ONLY THE BOOLEAN ═══════════════════════

test('1. only the literal true is accepted — no truthy value, and never a function', async () => {
  // The standing instruction is *"Do not permit arbitrary agent-generated code execution"*. A
  // function-shaped seam is the shape where a value out of a plan, a memory or a model becomes
  // code, so the seam selects a reviewed responder by boolean and refuses everything else.
  //
  // `query` is passed as a thrower: if any of these reached the database conditions, this test
  // would fail loudly rather than silently depending on an environment.
  const query = () => { throw new Error('the database must not be consulted for a malformed flag'); };
  for (const bad of ['true', 1, {}, [], 'yes', () => ({ text: 'pwned' }), null, undefined,
    Object(true)]) {
    const v = await SYN.authorizeSyntheticProvider(bad, { env: {}, query });
    assert.equal(v.allowed, false, `${typeof bad} ${String(bad)} was ACCEPTED`);
    assert.equal(v.reason, SYN.REFUSAL.NOT_TRUE);
  }
  assert.match(
    (await SYN.authorizeSyntheticProvider(() => {}, { env: {}, query })).detail,
    /where data becomes code/);
});

test('1a. a function passed as the flag is never called', async () => {
  // Specifically: refusing it is not enough if something invoked it on the way to refusing.
  let called = 0;
  const payload = () => { called += 1; return { text: 'arbitrary' }; };
  await SYN.authorizeSyntheticProvider(payload, { env: {}, query: () => { throw new Error('no'); } });
  assert.equal(called, 0, 'the seam invoked a caller-supplied function, which is the exact thing it '
    + 'exists to make impossible');
});

// ═══ 2. PRODUCTION IS REFUSED BEFORE THE DATABASE IS ASKED ════════════════

test('2. NODE_ENV=production refuses, and does not even consult the database', async () => {
  let asked = 0;
  const query = () => { asked += 1; throw new Error('should not be reached'); };
  const v = await SYN.authorizeSyntheticProvider(true, { env: { NODE_ENV: 'production' }, query });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, SYN.REFUSAL.PRODUCTION_ENV);
  assert.equal(asked, 0,
    'the production refusal depends on a database answer, so a database that cannot be reached '
    + 'would change the verdict — the cheapest and bluntest condition must come first');
  assert.match(v.detail, /indistinguishable afterwards unless the provenance says so/);
});

// ═══ 3. AN UNKNOWABLE DATABASE IS A REFUSAL, NOT PERMISSION ═══════════════

test('3. a database that cannot be identified refuses', async () => {
  // cannot_tell is a refusal. The alternative — treating an unanswerable question as a yes — is
  // the failure mode every gate in this repository is written against.
  const v = await SYN.authorizeSyntheticProvider(true, {
    env: { NODE_ENV: 'development' },
    query: async () => { throw new Error('connection refused'); },
  });
  assert.equal(v.allowed, false);
  assert.ok([SYN.REFUSAL.DB_UNKNOWABLE, SYN.REFUSAL.NOT_DEVELOPMENT_DB].includes(v.reason),
    `an unreachable database produced ${v.reason}`);
});

// ═══ 4. THE RESPONDER'S OUTPUT ════════════════════════════════════════════

test('4. the provider string is never the real one', () => {
  assert.equal(SYN.SYNTHETIC_PROVIDER, 'synthetic');
  assert.notEqual(SYN.SYNTHETIC_PROVIDER, 'anthropic');
  const r = SYN.syntheticCall({ model: 'fast', prompt: 'write a letter' });
  assert.equal(r.provider, 'synthetic');
  assert.equal(r.synthetic, true);
  // And the model field does not echo a model name that nothing ran.
  assert.match(r.model, /^synthetic:/);
  assert.equal(/claude/i.test(r.model), false);
});

test('4a. the marker is in the TEXT, not only in the metadata', () => {
  // Provenance in a column protects a reader who queries the column. The artefact itself travels:
  // into an approval payload, into a log, into a screenshot. The marker travels with it.
  const prose = SYN.syntheticCall({ model: 'fast', prompt: 'write a letter' });
  assert.ok(prose.text.includes(SYN.MARKER), prose.text.slice(0, 80));
  const json = SYN.syntheticCall({ model: 'fast', system: 'Return JSON only', prompt: 'x' });
  const parsed = JSON.parse(json.text);
  assert.equal(parsed.synthetic, true);
  assert.equal(parsed.marker, SYN.MARKER,
    'the marker must survive JSON.parse — a marker only in a prose preamble is lost the moment a '
    + 'downstream stage parses the response, which is what stage 4 does');
});

test('4b. deterministic: the same request gives the same answer, a different one differs', () => {
  // A stage that passes because the canned answer happened to parse, and fails tomorrow because a
  // random one did not, teaches nothing.
  const a = SYN.syntheticCall({ model: 'fast', system: 's', prompt: 'p' });
  const b = SYN.syntheticCall({ model: 'fast', system: 's', prompt: 'p' });
  const c = SYN.syntheticCall({ model: 'fast', system: 's', prompt: 'p2' });
  assert.equal(a.text, b.text);
  assert.notEqual(a.text, c.text);
});

test('4c. zero cost, KNOWN, with evidence that names this module', () => {
  // Zero and known is honest here and is NOT the "failed therefore free" assumption: no request
  // was dispatched, which is a fact about this process rather than a guess about billing. The
  // evidence matters because `releaseSpend` records it, and settleHold's default text blames a
  // policy stop or a missing credential — a true-sounding reason for the wrong run.
  const r = SYN.syntheticCall({ model: 'fast', prompt: 'x' });
  assert.equal(r.costUsd, 0);
  assert.equal(r.costKnown, true);
  assert.match(r.zeroChargeEvidence, /synthetic-provider\.js/);
  assert.match(r.zeroChargeEvidence, /never reached/);
  assert.deepEqual(r.usage, { input_tokens: 0, output_tokens: 0 });
});

// ═══ 5. THE RESPONDER CANNOT REACH THE NETWORK ════════════════════════════

test('5. the module contains no transport of any kind', () => {
  const src = fs.readFileSync(path.join(__dirname, 'synthetic-provider.js'), 'utf8');
  const LEX = require(path.join(__dirname, '..', '..', '..', 'scripts', 'js-lex.js'));
  // blankCommentsOnly, NOT blankNonCode: the latter blanks string VALUES too, so `require('crypto')`
  // becomes `require('')` and the module list comes back empty — which is how this test first
  // passed its transport sweep while reading nothing and then failed its require assertion.
  const code = LEX.blankCommentsOnly(src);
  for (const re of [/\bfetch\s*\(/, /require\(['"]https?['"]\)/, /\bnet\./, /XMLHttpRequest/,
    /\bexecFile|\bspawn|\bexec\s*\(/, /child_process/]) {
    assert.equal(re.test(code), false,
      `the synthetic responder contains ${re} — it must be incapable of reaching anything, so that `
      + '"no provider was contacted" is a property of the code and not a promise about it');
  }
  // It requires exactly what it needs, and `crypto` is the whole list at module scope.
  const topRequires = [...code.matchAll(/^const\s+\w+\s*=\s*require\((['"])([^'"]+)\1\)/gm)]
    .map((m) => m[2]);
  assert.deepEqual(topRequires, ['crypto'], JSON.stringify(topRequires));
});

// ═══ 6. AND office/ai.js DOES NOT FALL BACK ═══════════════════════════════

test('6. a refused seam never takes a hold, and never reaches the real provider', () => {
  // The dangerous failure is not a refusal; it is a refusal that quietly becomes a paid call, or
  // one that reserves money it then has to give back. This is asserted on the source because the
  // alternative is attempting a real provider call to prove one does not happen.
  //
  // THIS TEST WAS REWRITTEN, and the reason is the thing it is about. Its first version sliced from
  // the seam check to the next `} else {` and asserted that span contained no `llm.callClaude`.
  // When the seam moved ABOVE the budget hold — so that a refusal cannot have reserved anything —
  // that span grew to 5,911 characters covering `authorizeSpend` and the entire hold block, and the
  // assertion kept passing because the transport's call happens to sit after it. **It was passing
  // for the wrong reason**, which is this repository's recurring defect in a test about structure.
  // So the structure is now asserted by ORDER, with each boundary named.
  const ai = fs.readFileSync(path.join(__dirname, 'ai.js'), 'utf8');
  const LEX = require(path.join(__dirname, '..', '..', '..', 'scripts', 'js-lex.js'));
  // blankCommentsOnly: the key this looks for IS a string literal.
  const code = LEX.blankCommentsOnly(ai);

  const iSeam = code.indexOf("'syntheticProvider' in deps");
  const iHold = code.indexOf('budget.authorizeSpend(');
  const iCall = code.indexOf('llm.callClaude(');
  const iSettle = code.indexOf('await settleHold(ctx, reservation');
  for (const [name, at] of [['the seam check', iSeam], ['authorizeSpend', iHold],
    ['llm.callClaude', iCall], ['the reservation settle', iSettle]]) {
    assert.ok(at > 0, `${name} is not in office/ai.js — the structure moved and this test is `
      + 'reading nothing');
  }

  // 1. THE SEAM IS DECIDED BEFORE ANY MONEY IS HELD. This is what makes "a refusal releases a hold
  //    it should never have taken" unrepresentable rather than merely avoided.
  assert.ok(iSeam < iHold,
    'the synthetic seam is consulted AFTER the budget hold, so a refusal has money to give back');

  // 2. THE REFUSAL RETURNS, and reaches neither the provider nor the hold on its way out.
  const refusal = code.slice(iSeam, iHold);
  assert.match(refusal, /if \(!verdict\.allowed\)/);
  assert.match(refusal, /return \{/);
  assert.equal(/llm\.callClaude/.test(refusal), false,
    'the refusal path can reach the real provider: a seam that becomes a paid call when its gate '
    + 'declines is worse than no seam');
  assert.equal(/settleHold/.test(refusal), false,
    'the refusal path settles a hold — it should not have one');

  // 3. THE TRANSPORT BRANCHES ON THE ALREADY-DECIDED FLAG, and only the else-branch calls out.
  const iFlag = code.indexOf('if (useSynthetic)');
  assert.ok(iFlag > iHold && iFlag < iCall,
    'the transport does not branch on a flag decided before the hold');
  assert.match(code.slice(iFlag, iCall), /syntheticCall\(/,
    'the synthetic branch does not call the reviewed responder');

  // 4. AND THE PROPERTY validate-k5-budget-deployed.js MEASURES, held here too: the reservation is
  //    settled AFTER the call, so the ledger figure is the authoritative one. My first attempt at
  //    this seam broke exactly this ordering, and that validator is what caught it.
  assert.ok(iSettle > iCall,
    'the reservation is settled before the provider call, so it cannot carry the real cost');
});
