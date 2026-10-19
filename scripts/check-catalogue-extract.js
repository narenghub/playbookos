#!/usr/bin/env node
// ── RUN THE WHOLE CHAIN ON REAL PDFs. ────────────────────────────────────────
//
//   scripts/check-catalogue-extract.js    → exit 0 = PDF → text → rows → classification is right
//
// The unit tests feed hand-written strings to the extractor. That proves the string logic and
// nothing about the two steps that actually broke:
//
//   1. pdf-parse — the obvious library — threw "bad XRef entry" on the FIRST valid PDF put
//      through it. A unit test on strings would never have found that; the library was replaced
//      with pdfjs-dist because of it.
//   2. pdfjs fills the gaps between table columns with synthetic whitespace ITEMS, so measuring
//      the x-gap between glyphs finds nothing and every column boundary collapses to one space.
//      Row numbers then stayed glued to product names — "1 Paracetamol" — and the unit tests all
//      passed, because the hand-written fixtures had the two spaces the real file lacked.
//
// Both are failures of the PDF layer, invisible to every test that does not open a PDF. So this
// opens two, committed to the repo: a tidy table, and the awkward layout that supplier brochures
// actually use — names split onto their own line, two products flattened onto one, a document
// reference shaped like a CAS number, and a peptide list with no CAS numbers at all.
'use strict';

const fs = require('fs');
const path = require('path');

const { pdfToText } = require('../src/lib/catalogue/pdf-text');
const { rowsFromText, rowsFromSheet } = require('../src/lib/catalogue/extract');
const { classifyAll } = require('../src/lib/catalogue/classify');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(String(d).split('\n').map((l) => '          ' + l).join('\n')); };

const FIX = path.join(__dirname, '..', 'test-fixtures');

(async () => {
  // ── 1. A TIDY TABLE ────
  const tidy = path.join(FIX, 'supplier-list.pdf');
  if (!fs.existsSync(tidy)) {
    bad('the fixture PDFs are present', `${tidy} is missing — they are committed to the repo on purpose`);
  } else {
    let t;
    try { t = await pdfToText(fs.readFileSync(tidy)); ok(`a real PDF opens — ${t.pages} page(s), ${t.chars} characters`); }
    catch (e) { bad('open a real PDF', e.message); }

    if (t) {
      if (t.empty) bad('a text PDF is not reported as a scan');
      else ok('a text PDF is not reported as a scan');

      const { rows, stats } = rowsFromText(t.text, { file: 'supplier-list.pdf', supplier: 'Acme' });
      if (rows.length !== 8) {
        bad('all 8 products are found', `got ${rows.length}: ${rows.map((r) => r.name).join(', ')}`);
      } else ok('all 8 products found in the tidy table');

      const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

      // THE REGRESSION THAT PASSED EVERY UNIT TEST: the row number stayed on the name.
      const glued = rows.filter((r) => /^\d+\s/.test(r.name || ''));
      if (glued.length) {
        bad('row numbers are stripped from product names',
          `${glued.length} still glued: ${glued.map((r) => JSON.stringify(r.name)).join(', ')}`);
      } else ok('row numbers stripped — the column gap survived PDF extraction');

      // …and the opposite error: eating a digit that belongs to the molecule.
      if (!byName['5-Fluorouracil']) {
        bad('a name that begins with a digit is preserved',
          `5-Fluorouracil missing. Got: ${rows.map((r) => r.name).join(', ')}`);
      } else ok('"5-Fluorouracil" preserved — a leading digit is not always a row number');

      if (byName.Paracetamol && byName.Paracetamol.cas !== '103-90-2') {
        bad('each name keeps its OWN CAS', `Paracetamol → ${byName.Paracetamol.cas}`);
      } else ok('names and CAS numbers stay paired');

      if (byName.Semaglutide && byName.Semaglutide.grade !== 'peptide') {
        bad('grade is read from the row', `Semaglutide grade=${byName.Semaglutide.grade}`);
      } else ok('grade read from the row');

      if (byName.Paracetamol && !byName.Paracetamol.markers.includes('DMF')) {
        bad('regulatory markers are read', JSON.stringify(byName.Paracetamol.markers));
      } else ok('regulatory markers read (DMF, CEP, GMP, USP)');

      // The footer carries "Doc ref 31245-08-7", which is CAS-shaped and fails the checksum.
      if (rows.some((r) => r.cas === '31245-08-7')) {
        bad('a CAS-shaped document reference is rejected by the checksum');
      } else ok('the CAS-shaped document reference in the footer is rejected');

      if (stats.high_confidence !== 8) {
        bad('a clean table yields high confidence throughout', JSON.stringify(stats));
      } else ok('all 8 rows are high confidence');
    }
  }

  // ── 2. THE AWKWARD LAYOUT SUPPLIERS ACTUALLY SEND ────
  const awk = path.join(FIX, 'supplier-list-awkward.pdf');
  if (!fs.existsSync(awk)) {
    bad('the awkward fixture is present', `${awk} is missing`);
  } else {
    const t = await pdfToText(fs.readFileSync(awk));
    const { rows, unanchored } = rowsFromText(t.text, { file: 'awkward.pdf', supplier: 'Example' });
    const names = rows.map((r) => r.name);

    if (rows.length !== 4) bad('4 products found in the awkward layout', `got ${rows.length}: ${names.join(', ')}`);
    else ok('4 products found in the awkward layout');

    // A row broken across two lines: the name sits ABOVE its number.
    const dex = rows.find((r) => /Dexamethasone/.test(r.name || ''));
    if (!dex) bad('a name on the line above its CAS is still found', names.join(', '));
    else if (dex.confidence !== 'low') bad('that row is marked uncertain', `confidence=${dex.confidence}`);
    else ok('a name split onto its own line is found, and marked uncertain');

    // Two products flattened onto one line must not swap numbers.
    const pred = rows.find((r) => r.name === 'Prednisolone');
    const beta = rows.find((r) => r.name === 'Betamethasone');
    if (!pred || pred.cas !== '50-24-8' || !beta || beta.cas !== '378-44-9') {
      bad('two products on one line keep their own CAS numbers',
        JSON.stringify(rows.map((r) => [r.name, r.cas])));
    } else ok('two products flattened onto one line keep their own CAS numbers');

    if (rows.some((r) => r.cas === '31245-08-7')) bad('the fake reference is excluded here too');
    else ok('the CAS-shaped internal reference is excluded');

    // Peptides with no CAS are NOT products. They are reported for a human.
    if (rows.some((r) => /Epitalon|Selank|Thymosin/i.test(r.name || ''))) {
      bad('a peptide with no CAS must not become a product row', names.join(', '));
    } else ok('CAS-less peptides stay out of the product rows');
    if (!unanchored.includes('Epitalon')) {
      bad('…but they ARE reported for a human to look at', JSON.stringify(unanchored));
    } else ok('…and are reported as unanchored for a human');
  }

  // ── 3. CLASSIFICATION ON THOSE REAL ROWS ────
  if (fs.existsSync(tidy)) {
    const t = await pdfToText(fs.readFileSync(tidy));
    const { rows } = rowsFromText(t.text, { file: 'supplier-list.pdf', supplier: 'Acme' });
    const { rows: cls, counts } = classifyAll(rows, {
      catalogueNames: new Set(['paracetamol']),            // pretend we already sell it
      demandNames: new Set(['abiraterone acetate']),       // and somebody wants this one
      trialNames: new Set(['abiraterone acetate']),        // …because it is in active trials
      dmfNames: new Set(['ibuprofen']),                    // and this one is on the register
    });

    // ── THE RESTRICTION MUST SURVIVE EVERY PATH ────
    // A listing that loses its research-use notice between two systems is the failure the column
    // exists to prevent, so every row carries one, including holds and rejects.
    const noUse = cls.filter((r) => !r.use_class);
    if (noUse.length) {
      bad('every classified row carries a use_class',
        noUse.map((r) => r.name).join(', '));
    } else ok('every row carries a use_class, holds and rejects included');

    const abiRuo = cls.find((r) => r.name === 'Abiraterone Acetate');
    if (!abiRuo || abiRuo.use_class !== 'rnd_only' || !abiRuo.listing_notice) {
      bad('a molecule in active trials with no DMF is research-use only',
        JSON.stringify(abiRuo && [abiRuo.use_class, abiRuo.listing_notice]));
    } else ok('in trials, no DMF → research-use only, with the notice attached');

    const ibu = cls.find((r) => r.name === 'Ibuprofen');
    if (!ibu || ibu.use_class !== 'commercial' || ibu.listing_notice) {
      bad('a molecule on the DMF register is commercially supplyable',
        JSON.stringify(ibu && [ibu.use_class, ibu.listing_notice]));
    } else ok('on the DMF register → commercial, no restriction');

    // ── A PROPERLY CONTROLLED COMPARISON ────
    //
    // Two earlier attempts at this compared different molecules and proved nothing: the first
    // pair differed in demand as well as restriction, the second in regulatory markers. Both
    // "failures" were the code behaving correctly against a sloppy test.
    //
    // The only way to isolate the variable is to classify THE SAME ROW twice, changing nothing
    // but whether the molecule is on the DMF register.
    const probe = rows.find((r) => r.name === 'Ibuprofen');
    const asCommercial = classifyAll([probe], { dmfNames: new Set(['ibuprofen']) }).rows[0];
    const asRestricted = classifyAll([probe], { dmfNames: new Set() }).rows[0];
    if (asCommercial.use_class !== 'commercial' || asRestricted.use_class !== 'rnd_only') {
      bad('the probe row changes class with the register',
        `${asCommercial.use_class} / ${asRestricted.use_class}`);
    } else if (!(asCommercial.priority > asRestricted.priority)) {
      bad('one row, two contexts: commercial must outrank restricted',
        `${asCommercial.priority} vs ${asRestricted.priority}`);
    } else {
      ok(`same row, register the only difference — commercial ${asCommercial.priority} > restricted ${asRestricted.priority}`);
    }

    const sema = cls.find((r) => r.name === 'Semaglutide');
    if (!sema || sema.decision !== 'hold') {
      bad('Semaglutide is HELD, never listed', JSON.stringify(sema && [sema.decision, sema.reason]));
    } else ok('Semaglutide held — GLP-1, legal advice first');

    const para = cls.find((r) => r.name === 'Paracetamol');
    if (!para || para.decision !== 'second_source') {
      bad('a molecule we already sell is a SECOND SOURCE', JSON.stringify(para && [para.decision]));
    } else ok('a molecule already in the catalogue → second_source, not a duplicate');

    const abi = cls.find((r) => r.name === 'Abiraterone Acetate');
    if (!abi || abi.decision !== 'list') {
      bad('an evidenced-demand molecule is listable', JSON.stringify(abi && [abi.decision, abi.priority]));
    } else ok(`evidenced demand is listable — Abiraterone Acetate at ${abi.priority}`);

    if (cls[0].priority < cls[cls.length - 1].priority) bad('rows come back sorted by priority');
    else ok('rows come back sorted, most worth reading first');

    if (!counts.hold || !counts.list) bad('the summary counts every outcome', JSON.stringify(counts));
    else ok(`classified: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }

  // ── 4. SPREADSHEETS ────
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Abiozen samples', '', ''],
      ['Sr', 'Product Name', 'CAS Number'],
      ['1', 'Paracetamol', '103-90-2'],
      ['2', 'Unknown Thing', 'to be confirmed'],
    ]), 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const back = XLSX.read(buf, { type: 'buffer' });
    const grid = XLSX.utils.sheet_to_json(back.Sheets.Sheet1, { header: 1, raw: false, defval: '' });
    const { rows } = rowsFromSheet(grid, { file: 'x.xlsx', supplier: 'Acme' });
    if (rows.length !== 2) bad('a real xlsx round-trips into rows', JSON.stringify(rows));
    else if (rows[0].cas !== '103-90-2' || rows[1].cas !== null) {
      bad('a junk value in the CAS column is not trusted', JSON.stringify(rows.map((r) => [r.name, r.cas])));
    } else ok('a real xlsx round-trips, and "to be confirmed" is not accepted as a CAS');
  } catch (e) { bad('xlsx round-trip', e.message); }

  if (fail) {
    console.log(`\nFAIL  ${fail} problem(s) in the catalogue extraction chain`);
    process.exit(1);
  }
  console.log('\nPASS  PDF → text → rows → classification works on real files');
  process.exit(0);
})().catch((e) => {
  console.error('check-catalogue-extract crashed:', (e && e.stack) || e);
  process.exit(1);
});
