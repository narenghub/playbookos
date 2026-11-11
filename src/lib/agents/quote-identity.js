// ── WHAT AN APPROVAL CANNOT FIX ──────────────────────────────────────────────
//
//   const v = assessQuoteIdentity({ inquiry, pricing });
//   if (!v.ok) { /* no quote, and therefore no approval to grant */ }
//
// CEO decision 2026-11-11 priority 3: "Do not allow approval to substitute for correct molecule
// identity or reliable pricing. A quotation with unresolved identity or pricing confidence must
// remain blocked even if someone approves the email text."
//
// That distinction is the whole point of this file. A human approving a quotation is reading an
// email: a greeting, a table, a total. They are not in a position to notice that the price in
// that table came from a different substance, and asking them to is not oversight — it is
// transferring a machine's failure onto a reader who has no way to see it. So identity and price
// are settled BEFORE anything is prepared, and an unresolved one produces no approval at all.
//
// ── WHAT WAS ALREADY FIXED, AND WHAT WAS NOT ─────────────────────────────────
//
// FIXED. findPricing used to match `LOWER(molecule_name)=$1 OR cas_number=$2`. molecule_pricing is
// unique on LOWER(molecule_name) and UNCONSTRAINED on cas_number, so two differently-priced
// molecules may legitimately share a registry number — and a LIMIT 1 with no ORDER BY then let
// physical row order decide the price. Measured on 31 Oct: the same buyer, naming Selumetinib with
// Selumetinib's own correct CAS, was priced at $22,000/kg or $9,000/kg depending on which row was
// inserted first. The OR is gone; the unique index bounds the exact-name branch at one row.
//
// NOT FIXED, and this file is that. The quotation still printed the BUYER'S CAS beside OUR price,
// checked only for checksum validity. A well-formed registry number that belongs to a different
// substance than the one we priced passed straight onto a commercial document as though it
// described the goods. Nothing compared the buyer's identity claim with the catalogue's.
//
// That is not a pricing bug; it is worse. The buyer reads a document asserting that Abiozen will
// supply CAS X at that price, and the price is for something else. A human approver sees a
// coherent-looking table.
//
// ── SUPPRESS, NEVER SUBSTITUTE — AND NEVER ASSERT WHAT WE CANNOT CORROBORATE ─
//
// Where the catalogue has no CAS of its own, there is nothing to check the buyer's against. The
// quote then prints no CAS rather than printing theirs: asserting that a registry number
// describes our goods is an identity claim, and we do not make one we cannot support. The quote
// still goes out — the molecule NAME matched the catalogue exactly, which is the authoritative
// key — with the CAS row reading "to confirm".
//
// A conflict is different from an absence, and it blocks.

'use strict';

const { validCas } = require('../catalogue/cas');

/** A CAS that passes its own checksum, or null. Not "the CAS", just a readable one. */
function wellFormed(value) {
  const v = value === null || value === undefined ? '' : String(value).trim();
  return v && validCas(v) ? v : null;
}

/**
 * Is this quotation's identity and price established well enough to send?
 *
 * @returns {{ok:boolean, reason:string|null, detail:string|null,
 *            cas:string|null, confidence:string[]}}
 *
 * `cas` is the registry number the quotation may print — corroborated, or null. `confidence`
 * carries non-blocking notes for the approver to read, because "this is fine but here is what we
 * could not establish" is information a decision deserves.
 */
function assessQuoteIdentity({ inquiry = {}, pricing = null } = {}) {
  const confidence = [];
  const no = (reason, detail) => ({ ok: false, reason, detail, cas: null, confidence });

  // ── PRICE ────────────────────────────────────────────────────────────────
  if (!pricing) {
    return no('no_pricing', `the catalogue has no active priced row whose name is exactly `
      + `"${inquiry.molecule_name || '(none given)'}", so there is no price to quote. A near match `
      + 'is not a price: silence is the safe failure.');
  }

  const price = Number(pricing.price_per_kg_usd);
  if (!Number.isFinite(price) || price <= 0) {
    return no('no_usable_price', `the priced row for "${pricing.molecule_name}" carries `
      + `price_per_kg_usd = ${JSON.stringify(pricing.price_per_kg_usd)}, which is not a price`);
  }

  // ── IDENTITY ─────────────────────────────────────────────────────────────
  const buyerCas = wellFormed(inquiry.cas_number);
  const catalogueCas = wellFormed(pricing.cas_number);
  const buyerGaveSomething = String(inquiry.cas_number || '').trim() !== '';

  if (buyerGaveSomething && !buyerCas) {
    // Unreadable, not conflicting. The name matched exactly, so the goods are identified; their
    // registry number is not. Printing it would pass a malformed value off as authoritative.
    confidence.push(`the buyer's CAS "${String(inquiry.cas_number).trim()}" fails its checksum and `
      + 'is not printed');
  }

  if (buyerCas && catalogueCas && buyerCas !== catalogueCas) {
    return no('cas_conflict', `the buyer asked for CAS ${buyerCas}; the catalogue row being priced `
      + `("${pricing.molecule_name}") is CAS ${catalogueCas}. These are different substances, or one `
      + 'of the two records is wrong. Either way the price and the identity on this quotation would '
      + 'not describe the same thing, and no approval of the email text can resolve that.');
  }

  // Corroborated only when both sides agree. Where the catalogue has no CAS we print none.
  let cas = null;
  if (buyerCas && catalogueCas && buyerCas === catalogueCas) cas = buyerCas;
  else if (!catalogueCas && buyerCas) {
    confidence.push(`the catalogue row for "${pricing.molecule_name}" records no CAS, so the `
      + `buyer's ${buyerCas} could not be corroborated and is not printed as ours`);
  } else if (catalogueCas && !buyerGaveSomething) {
    // The buyer named no registry number and the catalogue has one for the exact name they gave.
    // That is our own record about our own goods, so it may be stated.
    cas = catalogueCas;
  }

  // ── QUANTITY THE PRICE ACTUALLY COVERS ───────────────────────────────────
  const qty = Number(inquiry.quantity_requested);
  if (Number.isFinite(qty) && qty > 0) {
    const qtyKg = inquiry.quantity_unit === 'kg' ? qty : qty / 1000;
    const maxKg = Number(pricing.max_quantity_kg);
    if (Number.isFinite(maxKg) && maxKg > 0 && qtyKg > maxKg) {
      return no('quantity_above_catalogue_max', `the buyer wants ${qtyKg} kg; the priced row covers `
        + `up to ${maxKg} kg. Extrapolating a per-kg price beyond the quantity it was set for is a `
        + 'new commercial decision, not a calculation.');
    }
  }

  return { ok: true, reason: null, detail: null, cas, confidence };
}

module.exports = { assessQuoteIdentity, wellFormed };
