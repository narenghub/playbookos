// CPHI company-name matching tests — run with:  node --test src/lib/cphi/match-company.test.js
// Every fixture is a real (DMF holder, CPHI Milan 2026 exhibitor) pair observed during the
// 286-company lookup run.

const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeCompany, companyCore, matchTier, searchTerms, reviewStatusFor } = require('./match-company');

test('possessives collapse before punctuation splitting', () => {
  // "Dr. Reddy's" -> "dr reddy s" would never match; this is the bug that hid a 23-molecule holder.
  assert.equal(normalizeCompany("Dr. Reddy's"), 'dr reddys');
  assert.equal(matchTier('DR REDDYS LABORATORIES LTD', "Dr. Reddy's"), 'core');
});

test('identical short cores are core-tier, not rejected by the anchor guard', () => {
  // Both sides core to "sun". The >=5-char guard belongs to prefix, not equality.
  assert.equal(companyCore('SUN PHARMACEUTICAL INDUSTRIES LTD'), 'sun');
  assert.equal(companyCore('Sun Pharmaceutical Ind. Ltd.'), 'sun');
  assert.equal(matchTier('SUN PHARMACEUTICAL INDUSTRIES LTD', 'Sun Pharmaceutical Ind. Ltd.'), 'core');
  // ...but a different company that merely starts the same way must NOT match.
  assert.equal(matchTier('SUN PHARMACEUTICAL INDUSTRIES LTD', 'Sunflower Pharma'), null);
});

test('exact and core tiers', () => {
  assert.equal(matchTier('TAPI NL BV', 'TAPI NL BV'), 'exact');
  // "LABS LTD" and "Labs Limited" both peel to "hetero labs" - genuinely exact, not core.
  assert.equal(matchTier('HETERO LABS LTD', 'Hetero Labs Limited'), 'exact');
  // Abbreviated industry words ("PHARM." / "IND.") survive normalisation but drop out of the
  // core, which is exactly what the core tier is for.
  assert.equal(matchTier('YUNG SHIN PHARMACEUTICAL INDUSTRIAL CO LTD', 'YUNG SHIN PHARM. IND. CO., LTD.'), 'core');
});

test('a typo in the FDA name degrades the tier rather than losing the match', () => {
  // The 2Q2026 file really does spell it "DIVI'S LABOTATORIES". "labotatories" is not a known
  // industry word, so it stays in the core and the pair lands one tier weaker instead of
  // dropping out - which is the behaviour we want from a registry full of hand-typed names.
  assert.equal(matchTier("DIVI'S LABOTATORIES LTD", 'Divis Laboratories Limited'), 'prefix');
});

test('prefix tier finds the right stand, and is gated because the entity may differ', () => {
  assert.equal(matchTier('BIOPHORE INDIA PHARMACEUTICALS PVT LTD', 'Biophore'), 'prefix');
  assert.equal(matchTier('UMICORE ARGENTINA SA', 'UMICORE AG & CO. KG'), 'prefix');
  assert.equal(matchTier('CAMBREX CHARLES CITY INC', 'Cambrex'), 'prefix');
  assert.equal(reviewStatusFor('prefix'), 'entity_review');
  assert.equal(reviewStatusFor('exact'), 'auto_confirmed');
  assert.equal(reviewStatusFor('token'), 'unreviewed');
});

test('a lone geographic token can never anchor a match', () => {
  // This is the failure that produced "beijing nuobote" -> "beijing sl pharmaceutical".
  assert.equal(matchTier('BEIJING NUOBOTE BIOTECHNOLOGY CO LTD', 'Beijing SL Pharmaceutical Co Ltd'), null);
  assert.equal(matchTier('SHANDONG ANHONG PHARMACEUTICAL CO LTD', 'Nantong Jinghua Pharmaceutical co., Ltd.'), null);
});

test('token tier rescues brand-last names', () => {
  assert.equal(matchTier('ZAKLADY FARMACEUTYCZNE POLPHARMA SA', 'Polpharma S.A.'), 'token');
  assert.equal(matchTier('YANGZHOU AURISCO PHARMACEUTICAL CO LTD', 'Aurisco Pharmaceutical Co.,Ltd'), 'token');
});

test('token tier known false positives stay in the token tier, never higher', () => {
  // All of these are wrong; the point is that they are quarantined, not that they vanish.
  for (const [h, e] of [
    ['CHINESE PEPTIDE CO', 'Hangzhou Go Top Peptide Biotech Co'],
    ['AURO PEPTIDES LTD', 'BCN PEPTIDES'],
    ['SICHUAN QISHENG BIOMEDICAL TECHNOLOGY CO LTD', 'GM BIOMEDICAL'],
  ]) {
    const t = matchTier(h, e);
    assert.ok(t === null || t === 'token', `${h} -> ${e} came back as ${t}`);
    if (t) assert.equal(reviewStatusFor(t), 'unreviewed');
  }
});

test('search terms try the trailing brand token, not just the leading one', () => {
  // Missing this hid Polpharma (7A50) and Aurisco (2A42) in the first pass.
  assert.ok(searchTerms('ZAKLADY FARMACEUTYCZNE POLPHARMA SA').includes('polpharma'));
  assert.ok(searchTerms('YANGZHOU AURISCO PHARMACEUTICAL CO LTD').includes('aurisco'));
  assert.ok(searchTerms('MSN LABORATORIES PRIVATE LTD').includes('msn'));
  // A holder whose core is entirely geographic still produces a usable query.
  assert.ok(searchTerms('CHANGZHOU PHARMACEUTICAL FACTORY').length > 0);
});
