const test = require('node:test');
const assert = require('node:assert');
const {
  looksLikeLab, isNumberedShell, looksLikeLabSql, numberedShellSql, labLookupOrderSql,
} = require('./lab-shape');

test('the names that actually sell testing are recognised, across languages', () => {
  for (const n of [
    'Eurofins Analytical Laboratories', 'SGS Laboratoire', 'Laboratorios Rubio',
    'Intertek Testing Services', 'Alcami Analytical', 'Frontage Bioanalysis',
    'Nelson Labs', 'Quality Control Services Srl', 'Chemi Pharma Services',
    'Analitica de Mexico', 'Pharma Microbiology Srl',
  ]) assert.ok(looksLikeLab(n), `${n} should read as a testing business`);
});

test('the names from the first live run that wasted the budget are NOT recognised', () => {
  // These ten were checked first, alphabetically, and none was on the floor. Whatever the new
  // ordering does, it must not put these at the top again.
  for (const n of [
    '2seventy bio, Inc.', '2Y-Biopharma, Ltd.', '3M Company',
    '9055-7588 Quebec Inc dba Attitude', 'AAA Pharmaceutical, Inc.', 'AACE PHARMACEUTICALS, INC.',
  ]) assert.ok(!looksLikeLab(n), `${n} should not read as a testing business`);
});

test('503 Neo Lab LLC is the honest edge case', () => {
  // 'LAB' alone is not a token — it hits 'Labelling', 'Labor' and half the German register. So this
  // row is NOT promoted by the name signal, and it IS demoted as a numbered name. That is the wrong
  // answer for this one company and the right answer for the several hundred numbered shells it sits
  // among, which is the trade being made deliberately rather than by accident.
  assert.ok(!looksLikeLab('503 Neo Lab LLC'));
  assert.ok(isNumberedShell('503 Neo Lab LLC'));
});

test('registry-numbered names are detected', () => {
  assert.ok(isNumberedShell('9055-7588 Quebec Inc dba Attitude'));
  assert.ok(isNumberedShell('9231-9110 Québec Inc'));
  assert.ok(!isNumberedShell('Eurofins'));
  assert.ok(!isNumberedShell(''));
  assert.ok(!isNumberedShell(null));
});

test('the SQL and the JS agree, token for token', () => {
  // Two implementations of one rule drift. This pins them to the same token list by checking that
  // every token the SQL tests for is one the JS mirror also matches.
  const sql = looksLikeLabSql('name');
  for (const tok of ['LABORATO', 'ANALYTIC', 'TESTING', 'MICROBIOLOG']) {
    assert.ok(sql.includes(`LIKE '%${tok}%'`), `${tok} missing from the SQL`);
    assert.ok(looksLikeLab('Something ' + tok + ' Ltd'), `${tok} missing from the JS`);
  }
  assert.match(numberedShellSql('name'), /name ~ '\^\[0-9\]'/);
  // No token short enough to hit inside an unrelated word. 'CRO' matched MICRO, MACRO and CROWN;
  // four characters is the floor, which 'LABS' sits on and nothing shorter may join.
  const { LAB_NAME_TOKENS } = require('./lab-shape');
  for (const tok of LAB_NAME_TOKENS) {
    assert.ok(tok.length >= 4, `token "${tok}" is too short to be a signal`);
  }
  assert.ok(!looksLikeLab('Micro Crown Macro Holdings'), 'a short token crept back in');
});

test('the ordering leads with region, not with the alphabet', () => {
  // The bug was an ORDER BY whose every term was constant, leaving `name` to decide. Region first,
  // and `name` last as a tiebreak only.
  const order = labLookupOrderSql();
  assert.ok(order.startsWith("(region LIKE 'eu%') DESC"), 'region must be the FIRST ordering term');
  assert.ok(order.lastIndexOf('name') > order.indexOf('contact_email'), 'name must be the last resort');
  // And the demotion must be ASC — a numbered name sorts true-last, not true-first.
  assert.match(order, /~ '\^\[0-9\]'\) ASC/);
});

test('the lab lookup asks about each COMPANY once, not each registered site', () => {
  // `labs` is one row per FDA establishment. The first EU run spent 3 of its 10 lookups on Apotek
  // Produktion & Laboratorier and 3 on Almac Pharma Services, learning the same booth six times —
  // and the writes collapse onto one row regardless, because the key is (event, role,
  // holder_normalized). Duplicates cost HTTP requests and buy nothing.
  const fs = require('fs');
  const path = require('path');
  const LOOK = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'scripts/lookup-cphi-roles.js'), 'utf8');
  assert.match(LOOK, /DISTINCT ON \(name_normalized\)/, 'the lab scope must dedupe by company');
  // DISTINCT ON requires its key to lead that query's ORDER BY; the priority ordering therefore has
  // to be applied OUTSIDE the subquery or Postgres rejects it.
  assert.match(LOOK, /ORDER BY name_normalized, \(region LIKE 'eu%'\) DESC/,
    'the inner ORDER BY must lead with the DISTINCT ON key');
  const inner = LOOK.indexOf('ORDER BY name_normalized');
  const outer = LOOK.indexOf('ORDER BY ${labLookupOrderSql()}');
  assert.ok(inner >= 0 && outer > inner, 'the priority ordering must be outside the dedupe');
});

// ── THE SAME BUG, THE SAME TABLE, A SECOND SCRIPT ───────────────────────────────
//
// This module was written on 2026-10-09 because the CPHI lab lookup ordered by terms that were all
// constant and so ran alphabetically. On 2026-10-10 scripts/seed-scope-delegates.js did it again on
// the same table — `(region LIKE 'eu%') DESC, (contact_email IS NOT NULL) DESC, name`, every row EU
// with a contact, so the SCOPE QC tab was ACS Dobfar, Aesica, AGC Biologics, Ajinomoto, Albhades,
// Alexion. These tests exist so a third script cannot.

test('the SCOPE delegate query uses this module rather than its own ordering', () => {
  const { labDelegateSql } = require('../events/lab-delegates');
  const sql = labDelegateSql(60);

  assert.match(sql, /ORDER BY \(region LIKE 'eu%'\) DESC/,
    'the ordering must come from labLookupOrderSql, which leads with region');
  assert.ok(/ORDER BY[\s\S]*LIKE '%LABORATO%'/.test(sql),
    'the shape test must be part of the ordering, not just the filter');
  assert.match(sql, /AND \(upper\(name\) LIKE/,
    'the shape test must also be a WHERE clause — a CDMO on the QC tab is a wrong row, not a late one');
  // The ordering that collapsed to alphabetical twice: region then contact_email with nothing
  // between them. If those two ever become adjacent again, `name` decides the list.
  assert.ok(!/\(region LIKE 'eu%'\) DESC,\s*\(contact_email IS NOT NULL\) DESC/.test(sql),
    'region immediately followed by contact_email is the ordering that ran alphabetically twice');
  // And `name` may only ever be the final tiebreak.
  const order = sql.slice(sql.indexOf('ORDER BY'));
  assert.ok(order.lastIndexOf('contact_email') < order.lastIndexOf('name'),
    'name must be the last resort, after every real signal');
});

test('the seed script does not hand-write the lab SQL any more', () => {
  const fs = require('fs');
  const path = require('path');
  const SEED = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'scripts/seed-scope-delegates.js'), 'utf8');
  assert.match(SEED, /labDelegateSql\(TOP_LABS\)/,
    'the seed must call the shared builder so the checker executes the shipped query');
  // A counting query over `labs` is fine — the one that reports how many are already partners.
  // What must not come back is a hand-written SELECT that RANKS labs, which is how the identical
  // bug arrived in a second script a day after it was fixed in the first.
  assert.ok(!/FROM labs[\s\S]{0,400}ORDER BY/.test(SEED),
    'a second hand-written lab ranking in this script is how the same bug arrived twice');
});

test('the firms that filled the broken list are rejected by the shape test', () => {
  // Verbatim from the dry run that exposed it. Every one is an API manufacturer or a CDMO.
  for (const name of [
    'ACS Dobfar SpA', 'Aesica Pharmaceuticals GmbH', 'AGC Biologics SPA',
    'Ajinomoto Omnichem', 'Alexion Pharma International Operations Limited',
  ]) {
    assert.ok(!looksLikeLab(name), `"${name}" is a manufacturer and must not read as a lab`);
  }
  // Albhades Provence is a genuine French analytical lab and must survive — the test separates the
  // two kinds of row, it does not simply shorten the list.
  assert.ok(looksLikeLab('Albhades Provence Laboratoire'), 'a real French lab must pass');
});

test('the big contract labs pass even though their names do not describe them', () => {
  // Once the shape test became a WHERE clause, a miss here deleted the largest testing firms in
  // Europe from the QC tab.
  for (const name of [
    'Eurofins Scientific SE', 'Intertek Group plc', 'Labcorp Early Development Laboratories',
    'Nelson Labs Europe', 'bioMerieux SA', 'Charles River Laboratories Ireland Limited',
  ]) {
    assert.ok(looksLikeLab(name), `"${name}" is a contract testing business and must pass`);
  }
});

test('clinical CROs are NOT labs — they belong on another tab', () => {
  for (const name of ['ICON plc', 'Syneos Health', 'Parexel International', 'IQVIA RDS Ireland']) {
    assert.ok(!looksLikeLab(name), `"${name}" is a clinical CRO, not an analytical laboratory`);
  }
});

test('no brand token is short enough to match inside an unrelated word', () => {
  const { LAB_BRAND_TOKENS, LAB_ALL_TOKENS } = require('./lab-shape');
  for (const tok of LAB_BRAND_TOKENS) {
    assert.ok(tok.length >= 4, `brand token "${tok}" is too short for a substring match`);
  }
  // SGS and ALS are deliberately absent: three letters cannot be matched as a substring safely.
  assert.ok(!LAB_ALL_TOKENS.includes('SGS'));
  assert.ok(!LAB_ALL_TOKENS.includes('ALS'));
  assert.ok(!looksLikeLab('Pharmaceuticals Ltd'), 'a plain manufacturer must still be rejected');
});
