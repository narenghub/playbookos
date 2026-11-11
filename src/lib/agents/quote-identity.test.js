// ── AN APPROVAL MUST NOT BE ABLE TO SUBSTITUTE FOR IDENTITY ──────────────────
//
//   node --test src/lib/agents/quote-identity.test.js
//
// CEO decision 2026-11-11 priority 3. A human approving a quotation is reading an email: a
// greeting, a table, a total. They cannot see that the price in that table came from a different
// substance. So these cases are settled before an approval exists, and the ones that block must
// block whatever anybody later approves.
//
// Both directions are tested. A gate that refuses every quotation is an outage, and the passing
// cases are what stop this file shipping one.

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { assessQuoteIdentity } = require('./quote-identity');

// Real, checksum-valid registry numbers for two different substances.
const GEMCITABINE = '95058-81-4';
const SELUMETINIB = '606143-52-6';

const PRICED = Object.freeze({
  molecule_name: 'Gemcitabine', cas_number: GEMCITABINE,
  price_per_kg_usd: 4000, max_quantity_kg: 50, lead_time_days: 45, purity: '99%',
});
const ASKED = Object.freeze({
  molecule_name: 'Gemcitabine', cas_number: GEMCITABINE,
  quantity_requested: 12, quantity_unit: 'kg',
});

const assess = (inq = {}, pr = {}) => assessQuoteIdentity({
  inquiry: { ...ASKED, ...inq },
  pricing: pr === null ? null : { ...PRICED, ...pr },
});

// ── THE CASE IT WAS WRITTEN FOR ──────────────────────────────────────────────

test('BLOCKS: the buyer asked for one substance and the price is for another', () => {
  // The hole authoritativeCas left open: it asked only whether a registry number passes its own
  // checksum, so a well-formed CAS for a DIFFERENT substance went onto a priced commercial
  // document as though it described the goods.
  const v = assess({ cas_number: SELUMETINIB });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'cas_conflict');
  assert.match(v.detail, /606143-52-6/);
  assert.match(v.detail, /95058-81-4/);
  assert.match(v.detail, /no approval of the email text can resolve that/);
  assert.strictEqual(v.cas, null, 'a conflicting number must not be printed either');
});

test('ALLOWS: the buyer and the catalogue agree', () => {
  const v = assess();
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.cas, GEMCITABINE);
  assert.deepStrictEqual(v.confidence, []);
});

// ── PRICE ────────────────────────────────────────────────────────────────────

test('BLOCKS: no priced row at all', () => {
  const v = assessQuoteIdentity({ inquiry: ASKED, pricing: null });
  assert.strictEqual(v.reason, 'no_pricing');
  assert.match(v.detail, /A near match is not a price/);
});

test('BLOCKS: a priced row whose price is not a number', () => {
  for (const bad of [null, undefined, 0, -10, NaN, 'ask us', '']) {
    const v = assess({}, { price_per_kg_usd: bad });
    assert.strictEqual(v.ok, false, `price_per_kg_usd=${JSON.stringify(bad)} was accepted`);
    assert.strictEqual(v.reason, 'no_usable_price');
  }
});

test('ALLOWS: a price given as a numeric string', () => {
  // Postgres REAL via some drivers, and a legitimate value. Blocking it would be an outage.
  const v = assess({}, { price_per_kg_usd: '4000' });
  assert.strictEqual(v.ok, true);
});

// ── QUANTITY THE PRICE ACTUALLY COVERS ───────────────────────────────────────

test('BLOCKS: a quantity above what the priced row covers', () => {
  const v = assess({ quantity_requested: 80, quantity_unit: 'kg' });
  assert.strictEqual(v.reason, 'quantity_above_catalogue_max');
  assert.match(v.detail, /not a calculation/);
});

test('ALLOWS: a quantity at the limit, and in grams', () => {
  assert.strictEqual(assess({ quantity_requested: 50, quantity_unit: 'kg' }).ok, true);
  assert.strictEqual(assess({ quantity_requested: 5000, quantity_unit: 'g' }).ok, true);
});

test('ALLOWS: no stated max on the priced row', () => {
  for (const maxKg of [null, undefined, 0]) {
    assert.strictEqual(assess({ quantity_requested: 900, quantity_unit: 'kg' }, { max_quantity_kg: maxKg }).ok,
      true, `max_quantity_kg=${maxKg} wrongly blocked`);
  }
});

// ── SUPPRESS, NEVER SUBSTITUTE, NEVER ASSERT THE UNCORROBORATED ──────────────

test('a malformed buyer CAS is not printed, and ours is NOT substituted for it', () => {
  // The name matched the catalogue exactly, so the goods are identified and the quote may go. The
  // buyer's registry number is not readable, and we do not quietly replace it with ours.
  //
  // My first version of this test expected the catalogue's CAS here. The repository had already
  // decided otherwise, in inquiry-agent.js: "It does NOT reach for the canonical CAS, even though
  // one exists and is well-formed: asserting that ABZ-Mol-000732 is the substance this buyer asked
  // for is an identity relationship, and inventing that relationship inside a safety fix is
  // exactly what this programme has been avoiding." A malformed number may be a typo of ANOTHER
  // substance's CAS, and printing ours would silently correct the buyer to our goods.
  const v = assess({ cas_number: '12345-67-9' }); // fails its checksum
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.cas, null, "the buyer's claim was overwritten with our own");
  assert.ok(v.confidence.some((c) => /fails its checksum/.test(c)));
});

test('an uncorroborated buyer CAS is suppressed rather than asserted as ours', () => {
  // The catalogue row has no CAS, so there is nothing to check theirs against. Printing it would
  // assert that this registry number describes our goods, which we cannot support.
  const v = assess({ cas_number: SELUMETINIB }, { cas_number: null });
  assert.strictEqual(v.ok, true, 'the exact name matched, so the quote may still go');
  assert.strictEqual(v.cas, null, "the buyer's number was printed as ours");
  assert.ok(v.confidence.some((c) => /could not be corroborated/.test(c)));
});

test("the catalogue's own CAS is printed when the buyer named none", () => {
  const v = assess({ cas_number: null });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.cas, GEMCITABINE, 'our own record about our own goods may be stated');
  assert.deepStrictEqual(v.confidence, []);
});

test('neither side has a CAS: no number, no note, no block', () => {
  const v = assess({ cas_number: null }, { cas_number: null });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.cas, null);
});

test('whitespace and case differences are not a conflict', () => {
  const v = assess({ cas_number: `  ${GEMCITABINE}  ` });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.cas, GEMCITABINE);
});

// ── NON-VACUITY ──────────────────────────────────────────────────────────────

test('the shared-CAS scenario that caused this: same CAS, different priced molecule', () => {
  // molecule_pricing is unique on LOWER(molecule_name) and UNCONSTRAINED on cas_number, so two
  // differently-priced molecules may legitimately share a registry number. findPricing no longer
  // ORs on CAS, so the row comes from the exact name — and this is the remaining question: does
  // the row we priced actually describe what the buyer asked for?
  const binimetinib = { molecule_name: 'Binimetinib', cas_number: SELUMETINIB, price_per_kg_usd: 22000 };
  const v = assessQuoteIdentity({
    inquiry: { molecule_name: 'Binimetinib', cas_number: GEMCITABINE, quantity_requested: 1, quantity_unit: 'kg' },
    pricing: binimetinib,
  });
  assert.strictEqual(v.reason, 'cas_conflict',
    'a buyer naming our molecule but another substance\'s CAS was quoted anyway');
});

test('every blocking reason is distinct and names what to do', () => {
  // A verdict an operator cannot act on is a verdict that gets overridden.
  const reasons = new Set();
  for (const [inq, pr] of [
    [{}, null], [{}, { price_per_kg_usd: 0 }], [{ cas_number: SELUMETINIB }, {}],
    [{ quantity_requested: 900, quantity_unit: 'kg' }, {}],
  ]) {
    const v = assessQuoteIdentity({ inquiry: { ...ASKED, ...inq },
      pricing: pr === null ? null : { ...PRICED, ...pr } });
    assert.strictEqual(v.ok, false);
    assert.ok(v.reason && v.detail && v.detail.length > 40, `${v.reason} has no usable detail`);
    reasons.add(v.reason);
  }
  assert.strictEqual(reasons.size, 4, 'two different failures share a reason code');
});
