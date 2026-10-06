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
