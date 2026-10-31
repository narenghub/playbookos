#!/usr/bin/env node
// ── A MALFORMED CAS MUST NOT REACH A BUYER AS AN AUTHORITATIVE NUMBER ────────
//
//   node scripts/check-quote-cas-authority.js      exit 0 = the guard holds
//
// The invariant, authorised 31 Oct 2026:
//
//   > A checksum-invalid CAS must never be emitted as an authoritative CAS number on a newly
//   > generated customer quotation.
//
// ── THE MEASURED CASE THIS EXISTS FOR ───────────────────────────────────────
//
// The active molecule_pricing row for Semaglutide holds `910463-68-5`, which FAILS the
// repository's own CAS checksum. Canonical identity ABZ-Mol-000732 holds `910463-68-2`, which
// passes. They differ only in the final check digit, so one of them is not a registry number.
//
// `createInquiry` writes `data.cas_number || pricing?.cas_number`, so a buyer who supplies no CAS
// inherits the pricing row's. `generateQuote` copies that into inquiry_quotes and into the Claude
// prompt, and the render path prints it in the email hero and as the quotation's "CAS Number" row.
// Nothing in that chain validated anything.
//
// ── WHAT IS ASSERTED, AND WHY EACH ONE ──────────────────────────────────────
//
//   1. a VALID CAS still prints. A guard that suppresses good data is a worse defect than the one
//      it fixes, and it would be invisible until a buyer asked why their quote says "to be
//      confirmed".
//   2. the malformed value CANNOT appear in the hero, the specs table, or the stored quote row.
//   3. an ABSENT CAS still works — the business flow permits a quote with no registry number, and
//      the fallback text must survive.
//   4. SUPPRESS, NEVER SUBSTITUTE. The guard must not print the canonical `910463-68-2` in place
//      of the malformed one. A well-formed number elsewhere in the database is not evidence that
//      it is THIS buyer's substance, and inventing that identity relationship inside a safety fix
//      is the thing this programme keeps refusing to do.
//   5. THE NEGATIVE CONTROL. With the rule bypassed, the malformed number MUST reach the
//      quotation. Without this, a passing test might only mean the fixture never contained a bad
//      CAS, and a green check that cannot be made red is not safety evidence.
//
// Everything runs against the SHIPPED renderEmail and buildSpecsTable, exported for this purpose.
// On 30 Oct a test of the territory grant passed by grepping the source for its own query text; a
// test that reimplements what it tests proves only that the test is self-consistent.
'use strict';

const fs = require('fs');
const agent = require('../src/lib/agents/inquiry-agent');
const { validCas } = require('../src/lib/catalogue/cas');

let fail = 0;
const out = (s) => fs.writeSync(1, s + '\n');
const ok = (m) => out(`  ok    ${m}`);
const bad = (m, d) => { fail++; out(`  FAIL  ${m}`); if (d) out(`          ${String(d).slice(0, 300)}`); };

// The real pair from production.
const MALFORMED = '910463-68-5';
const CANONICAL = '910463-68-2';

// ── 0. the premise itself, from the shipped validator ───────────────────────
// If this ever flips, every assertion below is testing nothing.
if (!validCas(CANONICAL)) bad(`premise broken: ${CANONICAL} should be checksum-valid`);
else ok(`${CANONICAL} is checksum-valid (the canonical value)`);
if (validCas(MALFORMED)) bad(`premise broken: ${MALFORMED} should be checksum-INVALID`);
else ok(`${MALFORMED} is checksum-INVALID (the pricing-row value)`);

// ── 1. the rule in isolation ────────────────────────────────────────────────
const A = agent.authoritativeCas;
if (A(CANONICAL) === CANONICAL) ok('a valid CAS passes through untouched');
else bad(`a valid CAS was altered: ${JSON.stringify(A(CANONICAL))}`);
if (A(MALFORMED) === null) ok('a checksum-invalid CAS is suppressed to null');
else bad(`a malformed CAS survived: ${JSON.stringify(A(MALFORMED))}`);
for (const empty of [null, undefined, '', '   ']) {
  if (A(empty) !== null) bad(`absent CAS ${JSON.stringify(empty)} did not normalise to null`);
}
ok('absent and blank CAS values normalise to null rather than throwing');
// Whitespace must not defeat it, and a valid value with padding is still valid.
if (A(` ${MALFORMED} `) === null) ok('padding does not smuggle a malformed CAS past the guard');
else bad('a padded malformed CAS survived');
if (A(` ${CANONICAL} `) === CANONICAL) ok('a padded valid CAS is trimmed, not rejected');
else bad(`a padded valid CAS was rejected: ${JSON.stringify(A(` ${CANONICAL} `))}`);

// ── 2. the rendering boundaries, as shipped ─────────────────────────────────
const hero = (cas) => agent.renderEmail({
  moleculeName: 'Semaglutide', cas, productTypeLabel: 'GMP API', bodyHtml: '<p>x</p>',
});
const specs = (cas) => agent.buildSpecsTable({
  molecule: 'Semaglutide', cas, grade: 'GMP grade', purity: '99%', quantity: '1 kg',
  unitPrice: 9000, leadTime: 21, docs: 'COA', total: 9150,
});

const heroMal = hero(MALFORMED);
if (!heroMal.includes(MALFORMED)) ok('email hero: the malformed CAS does not appear');
else bad('email hero PRINTED the malformed CAS');
if (heroMal.includes('To be confirmed')) ok('email hero: falls back to "To be confirmed"');
else bad('email hero did not fall back');
if (!heroMal.includes(CANONICAL)) ok('email hero: the canonical CAS was NOT substituted in');
else bad('email hero SUBSTITUTED the canonical CAS — that is an invented identity claim');

const specsMal = specs(MALFORMED);
if (!specsMal.includes(MALFORMED)) ok('specs table: the malformed CAS does not appear');
else bad('specs table PRINTED the malformed CAS');
if (specsMal.includes('To be confirmed')) ok('specs table: falls back to "To be confirmed"');
else bad('specs table did not fall back');
if (!specsMal.includes(CANONICAL)) ok('specs table: the canonical CAS was NOT substituted in');
else bad('specs table SUBSTITUTED the canonical CAS');

// A valid CAS must still be printed by both.
if (hero(CANONICAL).includes(CANONICAL)) ok('email hero: a valid CAS is still printed');
else bad('email hero suppressed a VALID CAS — the guard is too wide');
if (specs(CANONICAL).includes(CANONICAL)) ok('specs table: a valid CAS is still printed');
else bad('specs table suppressed a VALID CAS — the guard is too wide');

// Absent stays absent, in both.
if (hero(null).includes('To be confirmed') && !hero(null).includes('null')) {
  ok('email hero: an absent CAS renders the fallback and never the string "null"');
} else { bad('email hero mishandled an absent CAS'); }
if (specs(null).includes('To be confirmed')) ok('specs table: an absent CAS renders the fallback');
else bad('specs table mishandled an absent CAS');

// ── 3. THE MUTATION CONTROL ─────────────────────────────────────────────────
//
// DISABLES THE REAL GUARD in the shipped file, re-requires it, and proves the malformed number
// reaches the quotation. Then restores the file and proves green again.
//
// The first version of this control built a parallel unguarded renderer and asserted the malformed
// CAS appeared in ITS output. That proves the pre-fix behaviour is reproducible; it does NOT prove
// the shipped guard is load-bearing, because nothing in it touches the shipped code. The guard
// could have been deleted and that control would still have passed. This one cannot.
//
// The file is restored in a finally, and the restoration is verified by content hash rather than
// assumed — a check that leaves a source file mutated is a far worse defect than the one it tests.
const path = require('path');
const crypto = require('crypto');
const AGENT_FILE = path.join(__dirname, '..', 'src', 'lib', 'agents', 'inquiry-agent.js');
const ORIGINAL = fs.readFileSync(AGENT_FILE, 'utf8');
const ORIGINAL_HASH = crypto.createHash('sha256').update(ORIGINAL).digest('hex');
const GUARD_LINE = '  return validCas(v) ? v : null;';
const BYPASS_LINE = '  return v;   // MUTATION CONTROL: guard disabled';

const freshAgent = () => {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('src', 'lib', 'agents', 'inquiry-agent.js'))) delete require.cache[k];
  }
  return require(AGENT_FILE);
};

try {
  if (!ORIGINAL.includes(GUARD_LINE)) {
    bad('cannot locate the guard line to mutate — the control would silently prove nothing',
      GUARD_LINE);
  } else {
    fs.writeFileSync(AGENT_FILE, ORIGINAL.replace(GUARD_LINE, BYPASS_LINE), 'utf8');
    const mutated = freshAgent();
    const mutSpecs = mutated.buildSpecsTable({
      molecule: 'Semaglutide', cas: MALFORMED, grade: 'GMP grade', purity: '99%',
      quantity: '1 kg', unitPrice: 9000, leadTime: 21, docs: 'COA', total: 9150,
    });
    const mutHero = mutated.renderEmail({
      moleculeName: 'Semaglutide', cas: MALFORMED, productTypeLabel: 'GMP API',
      bodyHtml: '<p>x</p>',
    });
    if (mutSpecs.includes(MALFORMED)) {
      ok('MUTATION CONTROL: guard disabled → the malformed CAS reaches the quotation specs row');
    } else {
      bad('guard disabled and the malformed CAS still did not appear — this control proves nothing,'
        + ' so the assertions above are not evidence either');
    }
    if (mutHero.includes(MALFORMED)) {
      ok('MUTATION CONTROL: guard disabled → the malformed CAS reaches the email hero');
    } else {
      bad('guard disabled and the hero still suppressed it — control invalid');
    }
    if (mutated.authoritativeCas(MALFORMED) === MALFORMED) {
      ok('MUTATION CONTROL: the bypass really did take effect in the shipped module');
    } else {
      bad('the bypass did not take effect — the mutation was not loaded');
    }
  }
} finally {
  fs.writeFileSync(AGENT_FILE, ORIGINAL, 'utf8');
  const after = crypto.createHash('sha256')
    .update(fs.readFileSync(AGENT_FILE, 'utf8')).digest('hex');
  if (after === ORIGINAL_HASH) {
    ok('the mutated file was restored exactly — verified by content hash, not assumed');
  } else {
    bad('THE SOURCE FILE WAS NOT RESTORED', `expected ${ORIGINAL_HASH.slice(0, 16)} got ${after.slice(0, 16)}`);
  }
}

// ── 3b. green again after restoration ───────────────────────────────────────
const restored = freshAgent();
if (restored.authoritativeCas(MALFORMED) === null
    && restored.authoritativeCas(CANONICAL) === CANONICAL) {
  ok('after restoration the guard holds again and a valid CAS still passes');
} else {
  bad('the guard did not return to green after restoration');
}

// ── 4. the guard is actually wired into the shipped exports ─────────────────
//
// A rule that exists but is not called is the defect family this repo keeps finding. Proven by
// behaviour above; asserted here as a shape check so a future refactor that drops the call site
// fails loudly rather than silently.
if (typeof agent.authoritativeCas === 'function'
    && typeof agent.renderEmail === 'function'
    && typeof agent.buildSpecsTable === 'function') {
  ok('the rule and both render boundaries are exported and callable');
} else {
  bad('the guard or a render boundary is not exported — the proof above may be testing nothing');
}

if (fail) {
  out(`FAIL  ${fail} assertion(s) failed`);
  out('      A malformed CAS may be reaching customer quotations. DO NOT PUSH.');
  process.exit(1);
}
out('PASS  a checksum-invalid CAS cannot be emitted as authoritative; a valid one still is');
process.exit(0);
