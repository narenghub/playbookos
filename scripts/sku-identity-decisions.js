#!/usr/bin/env node
// ── THE FIVE SKUs, AND EXACTLY WHICH FIELDS NOBODY HAS DECIDED ───────────────
//
//   railway ssh 'node scripts/sku-identity-decisions.js'
//   railway ssh 'node scripts/sku-identity-decisions.js --report=json'
//
// READ-ONLY. No INSERT, UPDATE, DELETE, CREATE or ALTER. It decides nothing and proposes no
// identity.
//
// ── WHY A SCRIPT RATHER THAN A WRITTEN TABLE ────────────────────────────────
//
//   "Do not invent missing molecule identities or business priorities."
//
// A decision table for the five SKUs cannot be written from outside the database without guessing,
// and guessing here is the specific failure this whole sequence exists to prevent: a SKU name
// matched to a molecule by resemblance is how `Testosterone Enanthate` becomes `Testosterone`,
// CAS 315-37-7 read as 58-22-0, and a quote issued against a different substance.
//
// So this prints what is ON RECORD and names the fields that are not. Every cell is either a value
// from the database or the word UNRESOLVED. There is no third kind of cell, and nothing is derived
// from a name.
//
// ── WHAT COUNTS AS IDENTITY EVIDENCE HERE ───────────────────────────────────
//
// `skus` holds `id · name · category · prices · stock · supplier · is_gmp · is_active`. No CAS, no
// form, no molecule reference — so there is no identity on the row itself, and the evidence has to
// come from elsewhere or be absent. Three places are consulted, each reported separately so a
// reviewer can see which one spoke:
//
//   molecule_pricing       a priced molecule, which may carry a CAS
//   molecule_dmf_matches   a DMF filing against a molecule name
//   supplier_products      what CPHI suppliers sent, with CAS provenance per row
//
// A match in any of them is reported as A NAME MATCH AND NOTHING MORE. The report says so on every
// line, because the temptation is to read a name match in three tables as corroboration when it is
// the same inference made three times.
'use strict';

const { payloadMode } = require('./lib/clean-stdout');
const REPORT = ((process.argv.find((a) => a.startsWith('--report=')) || '').split('=')[1] || '').toLowerCase();
const REPORTING = REPORT === 'json';
const out = REPORTING ? payloadMode() : null;

const { initDB, query } = require('../src/lib/db');
// The SHIPPED validator, not a second copy. A CAS check digit implemented twice is two authorities
// that can disagree, which is the defect class this repo fails builds over.
const { validCas } = require('../src/lib/catalogue/cas');
// The evidence gathering is a pure function under test, because the first version of this script
// omitted skus.cas_number from its own aggregate and reported "none on record" for five SKUs that
// each hold a checksum-valid CAS. See src/lib/catalogue/sku-identity.js.
const { casEvidenceFor } = require('../src/lib/catalogue/sku-identity');

if (REPORT && !REPORTING) {
  console.error(`--report=${REPORT} is not a format. Use --report=json.`);
  process.exit(2);
}

const say = (s = '') => (REPORTING ? null : console.log(s));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const tableExists = async (t) => Boolean((await query(
  `SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [t])).rows[0]);

(async () => {
  await initDB();

  // ── 0. IS THERE AN IDENTITY SPINE AT ALL? ─────────────────────────────────
  const spine = {
    molecules: await tableExists('molecules'),
    molecule_aliases: await tableExists('molecule_aliases'),
  };
  const skuCols = (await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'skus'`))
    .rows.map((r) => r.column_name);

  say('\n── the five SKUs · identity decision table · READ-ONLY, decides nothing\n');
  say(`   canonical spine deployed      molecules=${spine.molecules} molecule_aliases=${spine.molecule_aliases}`);
  say(`   skus has cas_number           ${skuCols.includes('cas_number')}`);
  say(`   skus has molecule_id          ${skuCols.includes('molecule_id')}`);
  if (!spine.molecules) {
    say('   → E1 is approved and NOT built, so no SKU can carry a canonical identity today.');
    say('     Every identity field below is therefore UNRESOLVED by construction, not by neglect.');
  }
  say('');

  const skus = (await query(
    `SELECT id, name, category, supplier, is_gmp, is_active, sale_price, units_sold, lead_time_days
       FROM skus WHERE is_active = 1 ORDER BY name`)).rows;

  const havePricing = await tableExists('molecule_pricing');
  const haveDmf = await tableExists('molecule_dmf_matches');
  const haveSupplier = await tableExists('supplier_products');

  const rows = [];
  for (const s of skus) {
    const key = norm(s.name);

    // ── NAME MATCHES, LABELLED AS SUCH ──
    const pricing = havePricing ? (await query(
      `SELECT molecule_name, cas_number FROM molecule_pricing
        WHERE LOWER(molecule_name) = LOWER($1) LIMIT 5`, [s.name])).rows : [];
    const dmf = haveDmf ? (await query(
      `SELECT molecule_name, dmf_number FROM molecule_dmf_matches
        WHERE LOWER(molecule_name) = LOWER($1) LIMIT 5`, [s.name])).rows : [];
    const supplied = haveSupplier ? (await query(
      `SELECT supplier, product_name, cas, confidence, name_source, use_class, review_status,
              source_file
         FROM supplier_products
        WHERE LOWER(product_name) = LOWER($1)
        ORDER BY (cas IS NOT NULL AND confidence = 'high') DESC, supplier`, [s.name])).rows : [];

    // A CAS is evidence only when it passes the check digit AND was printed on the molecule's own
    // line. Anything else is a candidate.
    const cas = casEvidenceFor({ skuRow: s, pricingRows: pricing, supplierRows: supplied, validCas });
    const distinctValidCas = cas.all_checksum_valid;

    const unresolved = [...cas.unresolved];
    unresolved.push('substance_form — base / salt / ester / hydrate: not recorded in any table');
    // The census found 113 canonical groups holding CONFLICTING checksum-valid CAS numbers, 109 of
    // them merged by salt-stripping alone. For a peptide the form is not a detail: leuprolide
    // 53714-56-0 and leuprolide acetate 74381-53-6 are different substances to order.
    unresolved.push('peptide identity — sequence, modifications and counterion have no column in '
      + 'molecules, so a peptide cannot be represented even once the spine is referenced');
    if (!spine.molecules) unresolved.push('molecule_id — the canonical spine does not exist yet');
    if (!s.supplier) unresolved.push('supplier — blank on the SKU row');

    const rec = {
      sku_id: s.id,
      name: s.name,
      category: s.category || null,
      supplier_on_row: s.supplier || null,
      is_gmp: s.is_gmp === 1,
      units_sold: s.units_sold,
      cas_evidence: cas,
      name_matches: {
        molecule_pricing: pricing.map((p) => ({ name: p.molecule_name, cas: p.cas_number,
          cas_checksum_valid: validCas(p.cas_number) })),
        dmf_register: dmf.map((d) => ({ name: d.molecule_name, dmf: d.dmf_number })),
        supplier_products: supplied.map((r) => ({ supplier: r.supplier, cas: r.cas,
          cas_checksum_valid: validCas(r.cas), cas_provenance: r.confidence === 'high'
            ? 'printed on the same line as the name' : `NOT on the name's line — ${r.name_source}`,
          use_class: r.use_class, review_status: r.review_status, source_file: r.source_file })),
      },
      evidence_quality: {
        checksum_valid_cas_on_record: distinctValidCas,
        same_line_cas_from_suppliers: casSameLine.length,
        nearby_cas_only: casNearby.length,
        caveat: 'Every match above is a NAME match. A name match in three tables is one inference '
          + 'made three times, not three pieces of evidence.',
      },
      unresolved_fields: unresolved,
      second_source_candidates: supplied.filter((r) => r.review_status !== 'rejected')
        .map((r) => r.supplier),
    };
    rows.push(rec);

    if (!REPORTING) {
      say(`── ${s.name}   [${s.id}]`);
      say(`     category ${String(s.category || '(none)').padEnd(18)} supplier on row: ${s.supplier || '(blank)'}`);
      // Derived from the row, never asserted. The hardcoded version of this line contradicted the
      // schema probe printed a few lines above it.
      say(`     cas_number on the row: ${cas.on_sku_row || '(blank)'}`
        + `${cas.on_sku_row ? (cas.on_sku_row_checksum_valid ? '  CHECKSUM-VALID' : '  CHECKSUM-INVALID') : ''}`);
      say(`     cas provenance: ${cas.on_sku_row_provenance}`);
      say(`     checksum-valid CAS anywhere: ${distinctValidCas.length ? distinctValidCas.join(', ') : 'none'}`);
      say(`     name matches — pricing ${pricing.length} · DMF ${dmf.length} · supplier_products ${supplied.length}`);
      for (const r of supplied.slice(0, 6)) {
        say(`        ${r.supplier.slice(0, 28).padEnd(30)} ${(r.cas || '(no CAS)').padEnd(14)}`
          + ` ${r.confidence === 'high' ? 'SAME-LINE CAS' : 'cas not on the line'}  [${r.review_status}]`);
      }
      say('     UNRESOLVED:');
      for (const u of unresolved) say(`        • ${u}`);
      say('');
    }
  }

  // ── RELIANCE: TWO DIFFERENT KINDS OF OPPORTUNITY ──────────────────────────
  //
  // A second source for a molecule we already sell is a different proposition from a molecule they
  // would synthesise to order. The first can be qualified against an existing SKU; the second is an
  // RFQ with no catalogue history at all. Reporting them together is how a speculative enquiry
  // becomes a purchase commitment in somebody's summary.
  let reliance = { second_source_against_existing_sku: [], custom_synthesis_candidates: [], note: null };
  if (haveSupplier) {
    const skuNames = new Set(skus.map((s) => norm(s.name)));
    const rel = (await query(
      `SELECT product_name, cas, confidence, name_source, use_class, suggested, source_file
         FROM supplier_products
        WHERE event_slug = 'cphi-milan-2026' AND supplier ILIKE '%reliance%'
        ORDER BY (cas IS NOT NULL AND confidence = 'high') DESC, product_name`)).rows;

    for (const r of rel) {
      const entry = { product_name: r.product_name, cas: r.cas || null,
        cas_checksum_valid: validCas(r.cas),
        cas_provenance: r.cas ? (r.confidence === 'high'
          ? 'printed on the same line as the name'
          : `NOT on the name's line — ${r.name_source}`) : 'none printed',
        use_class: r.use_class, source_file: r.source_file };
      if (skuNames.has(norm(r.product_name))) reliance.second_source_against_existing_sku.push(entry);
    }
    reliance.custom_synthesis_candidates = [];
    reliance.note = 'Custom synthesis is NOT listed here. Murtaza offered to synthesise oncology '
      + 'APIs "if we know the molecule structure/CAS number" — that is an RFQ against a molecule '
      + 'Abiozen names, not a selection from their catalogue, so it cannot be populated from this '
      + 'data and must come from a stated sourcing priority.';

    if (!REPORTING) {
      say('── RELIANCE — the two kinds of opportunity, kept apart\n');
      say(`   second source against an EXISTING SKU: ${reliance.second_source_against_existing_sku.length}`);
      for (const e of reliance.second_source_against_existing_sku) {
        say(`      ${e.product_name.slice(0, 30).padEnd(32)} ${(e.cas || '(no CAS)').padEnd(14)} ${e.cas_provenance}`);
      }
      if (!reliance.second_source_against_existing_sku.length) {
        say('      none — no Reliance row name-matches any active SKU, so there is no verified');
        say('      second-source opportunity to propose from this data.');
      }
      say(`\n   custom synthesis: ${reliance.note}\n`);
      say(`   total Reliance rows extracted: ${rel.length}`
        + `, of which ${rel.filter((r) => r.cas && r.confidence === 'high' && validCas(r.cas)).length}`
        + ' carry a checksum-valid same-line CAS\n');
    }
  }

  if (!REPORTING) {
    say('── WHAT ONLY A HUMAN CAN SUPPLY ──\n');
    say('   1. For each SKU: the molecule it IS — name, CAS, and form (base/salt/ester/hydrate).');
    say('      Five rows. Not derivable from anything above; a name match is not an identity.');
    say('   2. The actual sourcing priorities. Nothing in this database records what Abiozen has');
    say('      decided to buy, as distinct from what a classifier ranked highly.');
    say('\n   Nothing was written. No identity was proposed.\n');
    process.exit(0);
  }

  out.emitJson({
    generated_at: new Date().toISOString(),
    wrote_nothing: true, proposed_no_identity: true,
    spine_deployed: spine,
    skus_columns: skuCols,
    rules: {
      identity: 'A CAS counts as evidence only when it passes the check digit AND was printed on '
        + "the molecule's own line. Everything else is a candidate.",
      name_matches: 'Every name match is one inference, however many tables it appears in.',
      invention: 'No molecule identity or business priority is proposed by this report.',
    },
    skus: rows,
    reliance,
    requires_human_decision: [
      'the molecule each SKU IS — name, CAS and substance form, five rows',
      'the actual sourcing priorities, as distinct from a classifier ranking',
    ],
  });
  process.exit(0);
})().catch((e) => {
  console.error(`\nsku-identity-decisions failed: ${(e && e.stack) || e}\n`);
  process.exit(1);
});
