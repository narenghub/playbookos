// ── GATHERING CAS EVIDENCE FOR A SKU, WITHOUT MISSING THE ROW IN FRONT OF YOU ─
//
// `sku-identity-decisions.js` reported, for all five active SKUs:
//
//     identity on the SKU row: NONE (skus holds no CAS, form or molecule reference)
//     checksum-valid CAS on record: none
//
// The molecule identity census, run minutes later against the same database, reported:
//
//     skus
//       rows with a CAS value          5  (100.0%)
//       of those, CHECKSUM-VALID       5
//
// **All five SKUs hold a checksum-valid CAS, and my report said there were none.** Two causes, and
// they are the same cause twice:
//
//   1. The "identity on the SKU row" line was a HARDCODED STRING, written from the `CREATE TABLE`
//      in db.js, printed two lines below a schema probe that said `skus has cas_number: true`. A
//      report that contradicts its own output on the same page.
//   2. The evidence aggregate summed `molecule_pricing` and `supplier_products` and silently
//      omitted the SKU row's own column.
//
// A false NEGATIVE about identity is the dangerous direction here. It says "nobody knows what this
// is" when a value exists, which invites someone to supply one — and the value already there might
// have been right, or might have been wrong in a way worth investigating. Either way it is
// evidence, and evidence that a report hides is worse than evidence nobody gathered.
//
// So the gathering is a pure function over plain rows, with a test asserting the specific thing
// that went wrong: a CAS on the SKU row can never produce "none on record".
//
// ── AND A CHECKSUM IS STILL NOT AN IDENTITY ────────────────────────────────
//
// The check digit proves the NUMBER is well-formed. It says nothing about whether that number
// denotes this substance. A checksum-valid CAS copied from the wrong row is checksum-valid.
//
// This matters more for `skus.cas_number` than anywhere else, because `molecules` carries
// `cas_source_values` and `cas_suppressed_reason` — provenance — and `skus.cas_number` carries
// none. A CAS on a SKU row is therefore **unsourceable by construction**: there is no column that
// could record where it came from or who decided it. That is reported as its own finding rather
// than folded into a confidence score.
'use strict';

/**
 * casEvidenceFor({ skuRow, pricingRows, supplierRows, validCas })
 *
 * Every CAS the system holds for this SKU, grouped by WHERE it came from and HOW it was obtained.
 * Nothing is merged into a single verdict, because the sources are not equivalent:
 *
 *   on_sku_row        a value in skus.cas_number — no provenance column exists for it
 *   same_line         printed on the molecule's own line in a supplier document (strongest)
 *   nearby            a CAS near the name — a candidate, not an identity
 *   from_pricing      a priced-molecule record matched BY NAME
 */
function casEvidenceFor({ skuRow = {}, pricingRows = [], supplierRows = [], validCas } = {}) {
  if (typeof validCas !== 'function') throw new Error('casEvidenceFor requires the shipped validCas');

  const hasCasColumn = Object.prototype.hasOwnProperty.call(skuRow, 'cas_number');
  const rawOnRow = hasCasColumn ? (skuRow.cas_number || null) : null;
  const onRowValid = Boolean(rawOnRow && validCas(rawOnRow));

  const sameLine = supplierRows.filter((r) => r.cas && r.confidence === 'high' && validCas(r.cas));
  const nearby = supplierRows.filter((r) => r.cas && r.confidence !== 'high');
  const fromPricing = pricingRows.map((p) => p.cas_number).filter((c) => c && validCas(c));

  // The SKU row's own value is included. Omitting it is the defect this module exists for.
  const allValid = [...new Set([
    ...(onRowValid ? [rawOnRow] : []),
    ...fromPricing,
    ...sameLine.map((r) => r.cas),
  ])];

  const unresolved = [];
  if (!hasCasColumn) {
    unresolved.push('CAS — the skus table has no cas_number column');
  } else if (!rawOnRow) {
    unresolved.push('CAS — blank on the SKU row');
  } else if (!onRowValid) {
    unresolved.push(`CAS — the value on the SKU row FAILS the check digit: ${rawOnRow}`);
  }
  if (!allValid.length) unresolved.push('CAS — no checksum-valid CAS anywhere in the system');
  if (allValid.length > 1) {
    unresolved.push(`CAS — ${allValid.length} DIFFERENT checksum-valid values on record: `
      + `${allValid.join(', ')} — a human must rule on which substance this SKU IS`);
  }
  if (onRowValid) {
    // Always, even when everything agrees. Agreement between unsourced values is not provenance.
    unresolved.push('CAS PROVENANCE — skus has no column recording where cas_number came from or '
      + 'who decided it, so this value is unsourceable by construction');
  }

  return {
    has_cas_column: hasCasColumn,
    on_sku_row: rawOnRow,
    on_sku_row_checksum_valid: onRowValid,
    on_sku_row_provenance: hasCasColumn
      ? 'NONE — skus has no cas_source or cas_decided_by column, unlike molecules.cas_source_values'
      : 'n/a',
    same_line_from_suppliers: sameLine.map((r) => ({ supplier: r.supplier, cas: r.cas })),
    nearby_only_count: nearby.length,
    from_pricing_by_name: fromPricing,
    all_checksum_valid: allValid,
    agrees_across_sources: allValid.length === 1,
    unresolved,
    caveat: 'A check digit proves the NUMBER is well-formed, not that it denotes this substance. '
      + 'A checksum-valid CAS copied from the wrong row is checksum-valid.',
  };
}

module.exports = { casEvidenceFor };
