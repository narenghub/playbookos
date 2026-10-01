// Who needs outsourced QC testing.
//
//   node --test src/lib/labconnect/buyers.test.js
//
// The claim this rests on: a site registered to MANUFACTURE and not registered for ANALYSIS has no
// in-house laboratory on that registration and is buying its testing from somebody. If the SQL
// fragment is wrong, the agent emails the wrong half of the industry — and it would look like a
// working prospect list either way, because every row in it is a real pharmaceutical company.

const { test } = require('node:test');
const assert = require('node:assert');
const { outsourcerSql, SIBLING_ANALYSIS_SQL, segmentFor, likelyTests, MAKER_TOKENS, SEGMENTS } =
  require('./buyers');

// ── the SQL fragment ─────────────────────────────────────────────────────────

test('it selects makers and EXCLUDES anyone registered for analysis', () => {
  const { sql } = outsourcerSql(1);
  assert.match(sql, /operations NOT ILIKE '%ANALYSIS%'/,
    'the exclusion IS the signal — without it this is just a list of manufacturers');
  assert.match(sql, /operations ILIKE \$1/, 'and it must require at least one maker token');
});

test('a row with NO operations is excluded explicitly, not by accident', () => {
  // THE BUG THIS PREVENTS. `NOT (NULL ILIKE '%ANALYSIS%')` evaluates to NULL, which is not true, so
  // a row with no operations would silently vanish from the result. That is the right outcome and
  // the wrong reason: it would make the query's behaviour on missing data an accident of
  // three-valued logic rather than a decision, and nobody would be counting those rows.
  const { sql } = outsourcerSql(1);
  assert.match(sql, /operations IS NOT NULL/);
  assert.match(sql, /btrim\(operations\) <> ''/, 'an empty string is as absent as a NULL here');
});

test('every maker token is bound as a parameter, never interpolated', () => {
  const { sql, params, nextIndex } = outsourcerSql(1);
  assert.equal(params.length, MAKER_TOKENS.length);
  assert.equal(nextIndex, MAKER_TOKENS.length + 1, 'so it composes with clauses that follow');
  for (const t of MAKER_TOKENS) assert.ok(params.includes('%' + t + '%'), `${t} is not bound`);
  // No token text in the SQL itself.
  for (const t of MAKER_TOKENS) assert.ok(!sql.includes(t), `${t} is interpolated into the SQL`);
});

test('it composes from an arbitrary bind position', () => {
  // The fragment is ANDed with territory and filter clauses that have already taken positions.
  const { sql, params, nextIndex } = outsourcerSql(7);
  assert.match(sql, /\$7\b/);
  // `!sql.includes('$1')` is WRONG here and failed: with seven tokens the positions run $7..$13,
  // and "$13" contains "$1" as a substring. The lookahead asks for a bind position that IS one,
  // not one that merely starts with the digit — the same trap as asserting a column name is absent
  // when a longer column name contains it.
  assert.ok(!/\$1(?!\d)/.test(sql), 'it must not hardcode the first bind position');
  assert.equal(nextIndex, 7 + params.length);
});

test('ANALYSIS is not one of the maker tokens', () => {
  // Including it would make the clause self-contradictory: require analysis and forbid it.
  assert.ok(!MAKER_TOKENS.includes('ANALYSIS'));
  assert.ok(!MAKER_TOKENS.some(t => t.includes('ANALYSIS')));
});

test('the sibling-site check matches on the SAME firm fold the rest of the system uses', () => {
  // THE MAIN FALSE POSITIVE: a company with a plant at one site and a laboratory at another appears
  // as an outsourcer and is not one. Matching on `firm_normalized` rather than firm_name means this
  // agrees with the DMF join rather than inventing a second idea of "the same company".
  assert.match(SIBLING_ANALYSIS_SQL, /s\.firm_normalized = fda_establishments\.firm_normalized/);
  assert.match(SIBLING_ANALYSIS_SQL, /s\.id <> fda_establishments\.id/, 'a site must not match itself');
  assert.match(SIBLING_ANALYSIS_SQL, /ANALYSIS/);
  assert.ok(!/firm_name\s*=/.test(SIBLING_ANALYSIS_SQL),
    'raw firm_name would miss "Acme Inc" vs "ACME, INC." and overstate the outsourcer count');
});

// ── segmentation ────────────────────────────────────────────────────────────

test('a compounding pharmacy is recognised from its name', () => {
  const r = segmentFor({ firm_name: 'Greenfield Compounding Pharmacy LLC', operations: 'MANUFACTURE' });
  assert.equal(r.segment, 'compounding_pharmacy');
  assert.equal(r.confidence, 'name');
});

test('a CDMO is not mistaken for its clients', () => {
  // Addressing a contract manufacturer as though it were a virtual pharma company ends the
  // conversation, which is why the name tokens are checked before the operations.
  for (const n of ['Patheon CDMO Services', 'Alcami CMO', 'Nordic CRO Holdings', 'Summit Contract Manufacturing']) {
    assert.equal(segmentFor({ firm_name: n, operations: 'MANUFACTURE; PACK' }).segment, 'cro_cdmo', n);
  }
});

test('an API manufacturer with no lab is a generic-chain supplier', () => {
  const r = segmentFor({ firm_name: 'Shandong Fine Chemicals Co', operations: 'API MANUFACTURE', is_api_manufacturer: true });
  assert.equal(r.segment, 'generic_manufacturer');
  assert.equal(r.confidence, 'operations', 'the register said so, not the name');
});

test('a packager or steriliser is a service provider, which is the CDMO shape', () => {
  assert.equal(segmentFor({ firm_name: 'Midwest Packaging Services', operations: 'PACK; LABEL' }).segment, 'cro_cdmo');
  assert.equal(segmentFor({ firm_name: 'SteriPro Industries', operations: 'STERILIZE' }).segment, 'cro_cdmo');
});

test('IT REFUSES TO GUESS when the register does not distinguish', () => {
  // 'unknown' is a normal outcome. A confident wrong segment produces a wrong opening line, and the
  // agent cannot tell a guess from a fact unless this says so.
  const r = segmentFor({ firm_name: 'Zenith Holdings', operations: 'STORE' });
  assert.equal(r.segment, 'unknown');
  assert.equal(r.confidence, 'none');
  assert.equal(segmentFor({}).segment, 'unknown', 'an empty row must not land in a real segment');
  assert.equal(segmentFor({ firm_name: null, operations: null }).segment, 'unknown');
});

test('confidence is reported, and a weak guess is labelled weak', () => {
  // A bare MANUFACTURE with an uninformative name is the commonest row in the register, and it is a
  // guess. Labelling it lets the agent soften the opening rather than asserting a business model.
  const r = segmentFor({ firm_name: 'Lakeside Industries', operations: 'MANUFACTURE' });
  assert.equal(r.segment, 'generic_manufacturer');
  assert.equal(r.confidence, 'weak');
});

test('every segment segmentFor can return is a defined segment with a needs line', () => {
  // A segment key with no entry in SEGMENTS renders as a blank reason in the agent's email.
  const rows = [
    { firm_name: 'X Compounding Pharmacy', operations: 'MANUFACTURE' },
    { firm_name: 'Y CDMO', operations: 'MANUFACTURE' },
    { firm_name: 'Z Laboratories', operations: 'MANUFACTURE' },
    { firm_name: 'W Chemicals', operations: 'API MANUFACTURE', is_api_manufacturer: true },
    { firm_name: 'V Industries', operations: 'MANUFACTURE' },
    { firm_name: 'U Services', operations: 'PACK' },
  ];
  for (const row of rows) {
    const { segment } = segmentFor(row);
    assert.ok(SEGMENTS[segment], `'${segment}' has no entry in SEGMENTS`);
    assert.ok(SEGMENTS[segment].needs.length > 20, `'${segment}' has no usable needs line`);
    assert.equal(typeof SEGMENTS[segment].gmp, 'boolean', `'${segment}' does not say whether it is GMP work`);
  }
});

test('the research segment is the only non-GMP one', () => {
  // It is also the one to sell into first: no quality agreement, no release-testing liability, and
  // the agent can close it in weeks rather than quarters.
  const nonGmp = Object.entries(SEGMENTS).filter(([, v]) => !v.gmp).map(([k]) => k);
  assert.deepEqual(nonGmp, ['research_biotech']);
});

// ── the tests each segment needs ────────────────────────────────────────────

test('every segment maps to catalogue codes, and the codes exist', () => {
  // A code here that is not in test_catalogue would produce a quote for a test nobody can run.
  const { migrate } = require('../../../scripts/migrate-labconnect');
  assert.equal(typeof migrate, 'function', 'the migration must be requirable without running');
  const sql = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../../scripts/migrate-labconnect.js'), 'utf8');
  for (const segment of [...Object.keys(SEGMENTS), 'unknown']) {
    const codes = likelyTests(segment);
    assert.ok(codes.length, `${segment} suggests no tests at all`);
    for (const code of codes) {
      assert.ok(sql.includes(`'${code}'`), `'${code}' (for ${segment}) is not in the seeded catalogue`);
    }
  }
});

test('a compounding pharmacy is offered the USP 797 set, not a generic assay', () => {
  // The whole point of segmenting: the opening offer has to be the thing they are already buying.
  assert.deepEqual(likelyTests('compounding_pharmacy'), ['potency_797', 'sterility', 'endotoxin']);
  assert.ok(likelyTests('research_biotech').includes('characterisation'));
  assert.ok(likelyTests('generic_manufacturer').includes('dissolution'));
});
