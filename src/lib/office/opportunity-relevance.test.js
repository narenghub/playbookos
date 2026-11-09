// ── RELEVANCE, TESTED AGAINST THE REAL BOARD ─────────────────────────────────
//
//   node --test src/lib/office/opportunity-relevance.test.js
//
// Every title below was observed in production on 2026-11-09 in the live set of 149 open
// solicitations. That is the point: a relevance engine tested on invented examples tells you the
// author's imagination works, not that the filter does. The cases that matter are the ones that
// previously sat side by side in the queue, indistinguishable.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const R = require('./opportunity-relevance');
const { BUSINESS_LINES } = require('./intake-schema');

const of = (psc, naics, title, description) =>
  R.assessRelevance({ psc_code: psc, naics_code: naics, title, description: description || '' });

// ── THE PAIRS THAT BROKE THE BOARD ───────────────────────────────────────────

test('the VA reference-laboratory contract is RELEVANT', () => {
  // The single opportunity that qualified out of 149. If this engine ever stops ranking it, the
  // engine is wrong, not the contract.
  const r = of('Q301', '621511', 'Q301--New Reference Lab Testing | Legacy VISN 15',
    'The contractor shall provide clinical reference laboratory testing services including '
    + 'specimen collection, transport and reporting for the VISN.');
  assert.strictEqual(r.verdict, 'RELEVANT', JSON.stringify(r.reasons));
  assert.ok(r.lines.includes('analytical_services'));
});

test('a hull survey under a testing-laboratory NAICS is NOT_RELEVANT', () => {
  // NAICS 541380 is "testing laboratories". This is a diver with a thickness gauge. It sat in the
  // same queue as the contract above.
  const r = of('H219', '541380', 'USNS KAISER (T-187 Ultrasonic Gauging Hull Special Survey 8)',
    'Ultrasonic thickness gauging of hull plating and internal structure.');
  assert.strictEqual(r.verdict, 'NOT_RELEVANT', JSON.stringify(r));
  assert.ok(r.vetoes.some((v) => /marine or vessel/.test(v)), JSON.stringify(r.vetoes));
});

test('laboratory meat testing under the same H family IS relevant', () => {
  // Same family as the hull survey. Only the words separate them, which is the whole design.
  const r = of('H389', '541380', 'AMS Designated Laboratory Meat Testing Services (ADL)',
    'Microbiology laboratory analysis of meat samples; sample collection and testing by an '
    + 'accredited laboratory under ISO/IEC 17025.');
  assert.notStrictEqual(r.verdict, 'NOT_RELEVANT', JSON.stringify(r.reasons));
  assert.ok(r.lines.includes('analytical_services'));
});

test('NIAID and BARDA medical R&D are RELEVANT', () => {
  for (const [psc, naics, title] of [
    ['AN12', '541715', '2027 NIAID DMID Omnibus Broad Agency Announcement: Development of '
      + 'therapeutic candidates, preclinical services and assay development'],
    ['AN13', '541714', 'BARDA DRIVe EZ-BAA (EZBAA - 22-100-SOL-00003) drug discovery and '
      + 'IND-enabling studies'],
  ]) {
    const r = of(psc, naics, title);
    assert.strictEqual(r.verdict, 'RELEVANT', `${psc}: ${JSON.stringify(r)}`);
  }
});

test('defense-systems R&D is NOT_RELEVANT even under NAICS 541715', () => {
  // 69 of the 149 were this family. They are the reason the queue was unreadable.
  for (const [psc, title] of [
    ['AC33', 'Advanced Metal Castings Research & Development (R&D) Requirement'],
    ['AC34', 'Operational Test and Training Infrastructure (OTTI) Commercial Solutions'],
    ['AR12', 'Commercial Solutions Opening (CSO) for Space Domain Awareness'],
    ['R425', 'ERDC Watercraft and Ship Simulator Support Services'],
  ]) {
    const r = of(psc, '541715', title);
    assert.strictEqual(r.verdict, 'NOT_RELEVANT', `${psc}: ${JSON.stringify(r)}`);
  }
});

test('building plant work under a laboratory NAICS is vetoed', () => {
  const r = of('H361', '541380', 'TDA Isolated Phase Bus and Duct Inspection');
  assert.strictEqual(r.verdict, 'NOT_RELEVANT');
  assert.ok(r.vetoes.some((v) => /building plant/.test(v)));
});

test('instrument calibration is not analysis', () => {
  const r = of('J049', '541380', 'Granite Surface Plate Calibration and lapping - with Q&As');
  assert.strictEqual(r.verdict, 'NOT_RELEVANT', JSON.stringify(r));
});

// ── THE ENGINE'S OWN RULES ───────────────────────────────────────────────────

test('a score with no identifiable business line cannot be RELEVANT', () => {
  // The failure this prevents: vocabulary coincidence producing a confident number on work we
  // have no business doing. A PSC prior with no lines must not survive on its own.
  const r = R.assessRelevance({
    psc_code: 'ZZ99', naics_code: '999999', title: 'Analysis of something', description: '',
  });
  assert.strictEqual(r.verdict, 'NOT_RELEVANT');
  assert.deepStrictEqual(r.lines, []);
  assert.ok(r.score < R.MARGINAL_AT);
});

test('every line the engine can emit is a real business line', () => {
  // Guards the defect this module was written against: opportunity-qualify.js maps NAICS codes to
  // 'scientific_fulfillment', which is NOT in BUSINESS_LINES and which the database CHECK
  // constraint rejects. Nothing here may emit a line the schema will not accept.
  for (const [, , line] of R.EVIDENCE) {
    assert.ok(BUSINESS_LINES.includes(line), `EVIDENCE emits unknown business line: ${line}`);
  }
  for (const [fam, spec] of Object.entries(R.PSC_FAMILY)) {
    for (const line of spec.lines) {
      assert.ok(BUSINESS_LINES.includes(line), `PSC_FAMILY ${fam} emits unknown line: ${line}`);
    }
  }
});

test('a veto always outranks an accumulated score', () => {
  // A defense simulator notice stuffed with laboratory vocabulary must still lose.
  const r = of('AC33', '541715',
    'Missile range simulator support',
    'Includes HPLC, assay, method validation, reference standard and CAS 50-00-0 handling.');
  assert.strictEqual(r.verdict, 'NOT_RELEVANT', JSON.stringify(r));
});

test('reasons are always given, for every verdict', () => {
  // A verdict nobody can audit is a verdict nobody can correct.
  for (const r of [
    of('Q301', '621511', 'Reference lab testing', 'clinical laboratory specimen analysis'),
    of('AC33', '541715', 'Metal castings R&D'),
    of(null, null, ''),
  ]) {
    assert.ok(Array.isArray(r.reasons) && r.reasons.length > 0, JSON.stringify(r));
    assert.ok(R.VERDICTS.includes(r.verdict));
    assert.ok(r.score >= 0 && r.score <= 100);
  }
});

test('a missing PSC is survivable — strong text alone can reach MARGINAL', () => {
  const r = of(null, '541380', 'Custom synthesis of reference standards',
    'Supplier shall perform custom synthesis of certified reference material, CAS 1234-56-7, '
    + 'with HPLC purity determination and method validation.');
  assert.notStrictEqual(r.verdict, 'NOT_RELEVANT', JSON.stringify(r));
  assert.ok(r.lines.length > 0);
});

test('NAICS 541715 alone cannot make anything relevant', () => {
  // 115 of 149 records carry it. If it could carry a verdict, nothing would be filtered.
  const r = of('AJ11', '541715', '2026 ERDC Broad Agency Announcement');
  assert.ok(r.score < R.RELEVANT_AT, `541715 carried a record to ${r.score}`);
});

test('a molecule purchase is molecule_commerce', () => {
  const r = of('6505', '325412', 'Pharmaceutical supply — bulk active pharmaceutical ingredient',
    'Delivery of API, CAS 59-67-6, with certificate of analysis and reference standard.');
  assert.strictEqual(r.verdict, 'RELEVANT', JSON.stringify(r));
  assert.ok(r.lines.includes('molecule_commerce'));
});

test('discovery work maps to scientific_intelligence, not synthesis', () => {
  const r = of('AN41', '541714', 'ARPA-H Emerging Health Innovators (EHI) Initiative',
    'Target identification and target validation for disease-target association, including '
    + 'mechanism of action characterisation.');
  assert.ok(r.lines.includes('scientific_intelligence'), JSON.stringify(r.lines));
});
