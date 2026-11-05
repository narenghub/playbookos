// ── R1: EVERY CASE THIS REPOSITORY HAS ALREADY PAID FOR ─────────────────────
//
//   node --test src/lib/molecules/commercial-match.test.js
//
// Each case below is one the codebase, a supplier thread or a live SKU already produced. None is
// invented to suit the implementation.
//
// The contract under test is one sentence: only `exact` is priceable, and every other answer says
// why in a form a human can act on.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { commercialMatch, assertPriceable, modificationsOf, VERDICTS, PRICEABLE } = require('./commercial-match');

const v = (a, b, o) => commercialMatch(a, b, o).verdict;

// ── the contract ────────────────────────────────────────────────────────────

test('only exact is priceable', () => {
  assert.deepEqual(PRICEABLE, ['exact']);
  for (const verdict of VERDICTS) {
    if (verdict === 'exact') continue;
    assert.ok(!PRICEABLE.includes(verdict), `${verdict} must not be priceable`);
  }
});

test('every refusal carries a reason and evidence for both sides', () => {
  const m = commercialMatch('leuprolide', 'leuprolide acetate');
  assert.equal(m.priceable, false);
  assert.ok(m.reason.length > 30, 'a refusal with no usable reason cannot reach a review queue');
  assert.ok(m.evidence.a.key && m.evidence.b.key);
  assert.ok(m.evidence.a.form && m.evidence.b.form);
  // §6: every determination contains evidence and a reason — a non-match included. An unmatched
  // line item must arrive as a question, not vanish as an absence.
});

// ── base vs salt: the case the whole remediation is about ───────────────────

test('leuprolide and leuprolide acetate are not the same orderable substance', () => {
  const m = commercialMatch('leuprolide', 'leuprolide acetate',
    { casA: '53714-56-0', casB: '74381-53-6' });
  // CAS is checked first and the two valid numbers disagree, which is decisive on its own.
  assert.equal(m.verdict, 'cas_conflict');
  assert.match(m.reason, /53714-56-0 vs 74381-53-6/);
});

test('…and without any CAS at all, the names alone still refuse it', () => {
  const m = commercialMatch('leuprolide', 'leuprolide acetate');
  // acetate is an AMBIGUOUS form word, so the refusal names that rather than claiming a form.
  assert.equal(m.verdict, 'ambiguous_form');
  assert.match(m.reason, /salt or ester depending on the parent/);
});

test('leuprorelin is the same substance as leuprolide — a synonym, not a form', () => {
  assert.equal(v('leuprorelin', 'leuprolide'), 'exact',
    'INN vs USAN is a naming divergence, and the curated table says so');
});

test('leuprorelin acetate matches leuprolide acetate, not leuprolide', () => {
  // Both carry the same ambiguous token, so the pair is refused as ambiguous rather than matched —
  // which is stricter than the search rule and correct for ordering.
  assert.equal(v('leuprorelin acetate', 'leuprolide acetate'), 'ambiguous_form');
  assert.notEqual(v('leuprorelin acetate', 'leuprolide'), 'exact');
});

// ── testosterone: three substances, not one ─────────────────────────────────

test('testosterone, its cypionate and its enanthate are three substances — none matches another', () => {
  // Base against ester is a form mismatch the layer can name.
  assert.equal(v('testosterone', 'testosterone cypionate'), 'form_mismatch');
  assert.equal(v('testosterone', 'testosterone enanthate'), 'form_mismatch');
  // Ester against a DIFFERENT ester is refused too, but under form_token_mismatch: both tokens are
  // esters, and without a curated token table the layer cannot tell two distinct esters from one
  // ester spelled two ways. Refused either way — which is the contract — and the reason shows both
  // tokens so a human can see it is cypionate against enanthate.
  const m = commercialMatch('testosterone cypionate', 'testosterone enanthate');
  assert.equal(m.verdict, 'form_token_mismatch');
  assert.equal(m.priceable, false);
  assert.match(m.reason, /cypionate vs enanthate/);
});

test('the testosterone refusal names the shared base, so a human knows where to look', () => {
  const m = commercialMatch('testosterone', 'testosterone enanthate');
  assert.match(m.reason, /both derive from "testosterone"/);
  assert.match(m.reason, /different registry numbers, documentation/);
});

test('the real CAS pair is also refused', () => {
  assert.equal(v('testosterone', 'testosterone cypionate',
    { casA: '58-22-0', casB: '58-20-8' }), 'cas_conflict');
  // 58-22-0 and 58-20-8 are two valid numbers one digit apart. A name-based matcher that ignored
  // CAS, or a CAS-based one that ignored the checksum, would have joined these.
});

test('a monohydrate is not its anhydrous salt', () => {
  // identity.js gives salt precedence over hydrate when a name carries both, so these classify as
  // 'salt' on each side and the hydrate distinction lives in the form TOKENS rather than the form.
  // The pair is still refused, and the reason prints `monohydrate` on one side only, which is what
  // a human needs. Worth stating plainly: the layer refuses here because it cannot resolve the
  // tokens, not because it recognises the hydrate difference.
  const m = commercialMatch('donepezil hydrochloride', 'donepezil hydrochloride monohydrate');
  assert.equal(m.verdict, 'form_token_mismatch');
  assert.equal(m.priceable, false);
  assert.match(m.reason, /monohydrate/);
});

// ── a matching CAS never rescues a form mismatch ────────────────────────────

test('a CAS that matches does NOT promote a form mismatch to a match', () => {
  // The octreotide case, generalised: a source that files a salt under the base's own number is not
  // distinguishing forms at all, so the number agreeing proves nothing about the form.
  const m = commercialMatch('testosterone', 'testosterone enanthate',
    { casA: '58-22-0', casB: '58-22-0' });
  assert.equal(m.verdict, 'form_mismatch',
    'a checksum proves the number is well-formed, not what it denotes');
});

test('an invalid CAS is discarded, recorded, and does not become a conflict', () => {
  const m = commercialMatch('gemcitabine', 'gemcitabine', { casA: '122111-03-9', casB: '99999-99-9' });
  assert.equal(m.verdict, 'exact', 'an unusable number must not manufacture a disagreement');
  assert.match(m.evidence.b.casRejected, /not a checksum-valid CAS/);
  assert.equal(m.evidence.a.cas, '122111-03-9');
});

test('a CAS on only one side is not a conflict', () => {
  assert.equal(v('gemcitabine', 'gemcitabine', { casA: '122111-03-9' }), 'exact');
});

// ── the Gemcitabine case the inquiry agent already fails closed on ──────────

test('Gemcitabine hydrochloride against a Gemcitabine row gets no price', () => {
  const m = commercialMatch('Gemcitabine', 'Gemcitabine hydrochloride');
  assert.equal(m.priceable, false);
  assert.equal(m.verdict, 'form_mismatch');
  // This is the behaviour inquiry-agent.js already has — "silence is the safe failure" — made
  // explicit and reusable instead of re-derived at each call site.
});

// ── peptides: the model cannot represent them, so it must not pretend ───────

test('TB-500 and Thymosin beta-4 are different substances, and the live SKU conflates them', () => {
  // The shipped SKU "TB-500 99%" carries 77591-33-4, which is full-length Thymosin beta-4.
  // TB-500 is Ac-LKKTETQ, 885340-08-9.
  assert.equal(v('TB-500', 'Thymosin beta-4'), 'no_match');
  const m = commercialMatch('TB-500', 'Thymosin beta-4',
    { casA: '885340-08-9', casB: '77591-33-4' });
  assert.equal(m.verdict, 'cas_conflict');
});

test('a modification present on one side only is refused, naming what differs', () => {
  const m = commercialMatch('Ac-LKKTETQ', 'LKKTETQ');
  assert.equal(m.verdict, 'modification_mismatch');
  assert.match(m.reason, /N-terminal acetylation/);
  assert.match(m.reason, /no column for sequence, modifications or counterion/);
});

test('the refusal says the data cannot distinguish them, not that they are different', () => {
  const m = commercialMatch('semaglutide', 'semaglutide PEG-20');
  assert.equal(m.verdict, 'modification_mismatch');
  assert.match(m.reason, /cannot be resolved, only refused/,
    '"we cannot tell" is a different claim from "they differ", and only the first is true here');
});

test('identical modifications on both sides are not an obstacle', () => {
  assert.equal(v('Ac-LKKTETQ-NH2', 'Ac-LKKTETQ-NH2'), 'exact');
});

test('amidation, lipidation, D-substitution and a TFA counterion are all detected', () => {
  assert.deepEqual(modificationsOf('peptide-NH2'), ['C-terminal amidation (-NH2)']);
  assert.ok(modificationsOf('palmitoyl tripeptide').includes('lipidation'));
  assert.ok(modificationsOf('D-Ala2 peptide').includes('D-amino acid substitution'));
  assert.ok(modificationsOf('octreotide TFA').includes('TFA counterion'));
  assert.deepEqual(modificationsOf('metformin'), []);
});

// ── ambiguous form words resolve to a refusal, never a guess ────────────────

test('acetate and succinate are refused as ambiguous rather than classified', () => {
  for (const tok of ['acetate', 'succinate', 'benzoate', 'salicylate']) {
    const m = commercialMatch('metoprolol', `metoprolol ${tok}`);
    assert.equal(m.verdict, 'ambiguous_form', `${tok} should be ambiguous`);
    assert.ok(m.evidence.ambiguousTokens.includes(tok));
  }
});

test('ambiguity refuses even when both sides are identical strings', () => {
  const m = commercialMatch('metoprolol succinate', 'metoprolol succinate');
  assert.equal(m.verdict, 'ambiguous_form',
    'if we cannot say what form this is, we cannot say two things are the same form — '
    + 'identity.js declined to guess and this must not inherit the guess');
});

test('an unambiguous salt is classified, not refused as ambiguous', () => {
  const m = commercialMatch('metformin hydrochloride', 'metformin hydrochloride');
  assert.equal(m.verdict, 'exact');
  assert.equal(m.evidence.a.form, 'salt');
});

// ── unknown is never a match ────────────────────────────────────────────────

test('an empty or unusable name is unknown, not no_match and never exact', () => {
  for (const pair of [['', 'metformin'], ['metformin', ''], [null, null], ['   ', 'x']]) {
    const m = commercialMatch(pair[0], pair[1]);
    assert.equal(m.verdict, 'unknown', `${JSON.stringify(pair)} should be unknown`);
    assert.equal(m.priceable, false);
  }
});

test('unknown says no comparison was made, rather than implying a difference', () => {
  assert.match(commercialMatch('', 'metformin').reason, /no comparison was made/);
});

// ── mineral stems and the base-length floor ─────────────────────────────────

test('potassium chloride is a drug, not a salt of a drug', () => {
  assert.equal(v('potassium chloride', 'potassium chloride'), 'exact');
  assert.equal(commercialMatch('potassium chloride', 'potassium chloride').evidence.a.form, 'base');
});

test('a name whose stripped base falls under the floor is treated as the substance itself', () => {
  // The DDAVP case identity.js documents: `ddavp` is 5 characters against a 6-char floor, so the
  // acetate was never recognised as a form. The behaviour is inherited deliberately — this module
  // must not disagree with the identity layer about what a form is.
  const m = commercialMatch('DDAVP acetate', 'DDAVP acetate');
  assert.ok(['exact', 'ambiguous_form'].includes(m.verdict));
  assert.equal(m.evidence.a.form, m.evidence.b.form, 'both sides must classify the same way');
});

// ── no second CAS validator, no second normaliser ──────────────────────────

test('this module imports the shipped CAS validator rather than implementing one', () => {
  const src = require('node:fs').readFileSync(require.resolve('./commercial-match'), 'utf8');
  assert.match(src, /require\('\.\.\/catalogue\/cas'\)/);
  // The repo already failed this way once: a check-digit implementation inlined into
  // sku-identity-decisions.js instead of importing src/lib/catalogue/cas.js. A sweep now fails the
  // build on a duplicate validator, and this asserts the intent locally too.
  assert.ok(!/% 10|checkDigit|\bchecksum\s*=/.test(src), 'no inlined check-digit arithmetic');
});

test('this module does not import the search rule', () => {
  const src = require('node:fs').readFileSync(require.resolve('./commercial-match'), 'utf8');
  assert.ok(!/require\(['"]\.\/synonyms['"]\)/.test(src),
    'the commercial matcher importing the search rule would defeat the entire point');
});

// ── assertPriceable ─────────────────────────────────────────────────────────

test('assertPriceable throws on a refusal and carries the verdict and evidence', () => {
  assert.throws(() => assertPriceable('testosterone', 'testosterone enanthate'), (e) => {
    assert.equal(e.verdict, 'form_mismatch');
    assert.ok(e.evidence.a.key);
    assert.match(e.message, /commercial match refused \(form_mismatch\)/);
    return true;
  });
});

test('assertPriceable returns the match when it is exact', () => {
  const m = assertPriceable('metformin hydrochloride', 'Metformin Hydrochloride');
  assert.equal(m.verdict, 'exact', 'case and spacing differences normalise away');
});

test('hydrochloride vs HCl is REFUSED — the model does not normalise salt-token spellings', () => {
  // This is one substance spelled two ways, and the matcher still refuses it. That is the correct
  // behaviour here rather than a shortcoming: to this layer the pair is indistinguishable from
  // `metformin hydrochloride` vs `metformin hydrobromide`, which is two substances. Resolving it
  // needs a curated salt-token table, and inventing one inside the commercial matcher is exactly
  // the independent identity authority the ruling said to avoid.
  //
  // The first implementation reported this as form_mismatch with the reason "the forms differ
  // (salt vs salt)" — false on its face, and caught by this test.
  const m = commercialMatch('metformin hydrochloride', 'Metformin HCl');
  assert.equal(m.verdict, 'form_token_mismatch');
  assert.equal(m.priceable, false);
  assert.match(m.reason, /does not normalise salt-token spellings/);
  assert.match(m.reason, /refused rather than guessed/);
  assert.equal(m.evidence.a.form, 'salt');
  assert.equal(m.evidence.b.form, 'salt');
});

test('hydrochloride vs hydrobromide gets the SAME verdict — which is the honest answer', () => {
  const m = commercialMatch('metformin hydrochloride', 'metformin hydrobromide');
  assert.equal(m.verdict, 'form_token_mismatch',
    'two genuinely different salts and one salt spelled two ways are indistinguishable to this '
    + 'layer, so both must refuse — a verdict that separated them would be claiming knowledge '
    + 'the model does not have');
});

test('an unrecognised verdict cannot be constructed', () => {
  // Guards against a future edit adding a verdict string without adding it to VERDICTS, which would
  // otherwise produce a result whose priceable flag is silently false for the wrong reason.
  const src = require('node:fs').readFileSync(require.resolve('./commercial-match'), 'utf8');
  assert.match(src, /unknown verdict/);
});
