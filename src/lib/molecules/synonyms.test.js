'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  SYNONYM_GROUPS, SALT_WORDS, MIN_BASE_LENGTH,
  normalize, moleculeBase, expandMolecule, moleculeLikeSql, likePatterns, matchedVia,
} = require('./synonyms');

// ── THE BUG THIS FILE EXISTS FOR ────

test('leuprorelin finds leuprolide — the CPHI Milan miss', () => {
  const e = expandMolecule('leuprorelin');
  assert.ok(e.terms.includes('leuprolide'), 'the USAN must be searched');
  assert.strictEqual(e.terms[0], 'leuprorelin', 'what was typed sorts first');
  assert.ok(e.expanded);
});

test('and the reverse — leuprolide finds leuprorelin', () => {
  assert.ok(expandMolecule('leuprolide').terms.includes('leuprorelin'));
});

test('a salted name still reaches the synonym', () => {
  // The realistic booth case: the register holds "Leuprolide Acetate", the customer says the INN.
  const e = expandMolecule('Leuprorelin Acetate');
  assert.strictEqual(e.base, 'leuprorelin');
  assert.ok(e.terms.includes('leuprolide'), 'de-salt THEN expand, or this fails');
});

test('the five names a European says that an FDA register does not', () => {
  const pairs = [
    ['paracetamol', 'acetaminophen'],
    ['salbutamol', 'albuterol'],
    ['rifampicin', 'rifampin'],
    ['ciclosporin', 'cyclosporine'],
    ['adrenaline', 'epinephrine'],
  ];
  for (const [eu, us] of pairs) {
    assert.ok(expandMolecule(eu).terms.includes(us), `${eu} must reach ${us}`);
    assert.ok(expandMolecule(us).terms.includes(eu), `${us} must reach ${eu}`);
  }
});

// ── SALT STRIPPING ────

test('trailing salts and hydrates come off', () => {
  assert.strictEqual(moleculeBase('Metformin Hydrochloride'), 'metformin');
  assert.strictEqual(moleculeBase('warfarin sodium'), 'warfarin');
  assert.strictEqual(moleculeBase('Atorvastatin Calcium Trihydrate'), 'atorvastatin');
  assert.strictEqual(moleculeBase('amoxicillin trihydrate'), 'amoxicillin');
  assert.strictEqual(moleculeBase('Fluticasone Propionate'), 'fluticasone');
});

test('a LEADING mineral is part of the name and survives', () => {
  // `sodium cromoglicate` is the substance. Strip from the tail only.
  assert.strictEqual(moleculeBase('sodium cromoglicate'), 'sodium cromoglicate');
});

test('a drug whose whole name is salt words is never stripped to a bare mineral', () => {
  // These are the substance, not a salt of one. Reducing them to `potassium` would match the whole
  // register and return noise instead of an answer.
  for (const n of ['potassium chloride', 'sodium chloride', 'magnesium sulfate',
                   'calcium carbonate', 'zinc oxide']) {
    const base = moleculeBase(n);
    assert.ok(base.includes(' ') || base === normalize(n),
      `${n} must not collapse to a single mineral word, got "${base}"`);
  }
});

test('stripping never leaves something shorter than the floor', () => {
  for (const group of SYNONYM_GROUPS) {
    for (const name of group) {
      const base = moleculeBase(name);
      assert.ok(base.length >= MIN_BASE_LENGTH || base === normalize(name),
        `"${name}" stripped to "${base}", under the ${MIN_BASE_LENGTH}-char floor`);
    }
  }
});

test('stripping never returns empty', () => {
  for (const n of ['acetate', 'sodium', 'hydrate', 'usp', '', '   ']) {
    const base = moleculeBase(n);
    assert.strictEqual(typeof base, 'string');
    if (normalize(n)) assert.ok(base.length > 0, `"${n}" produced an empty base`);
  }
});

// ── TABLE INTEGRITY. A WRONG ROW HERE SENDS A BUYER TO THE WRONG SUBSTANCE. ────

test('every group has at least two members', () => {
  for (const g of SYNONYM_GROUPS) {
    assert.ok(g.length >= 2, `a group of one is not a synonym: ${JSON.stringify(g)}`);
  }
});

test('no name appears in two different groups', () => {
  // Two groups sharing a name means one substance silently expands into another's suppliers. That is
  // the one failure mode worse than finding nothing.
  const home = new Map();
  for (const [gi, g] of SYNONYM_GROUPS.entries()) {
    for (const name of g) {
      const key = normalize(name);
      if (home.has(key)) {
        assert.fail(`"${key}" is in group ${home.get(key)} and group ${gi} — ` +
                    `merge them or one substance will return the other's holders`);
      }
      home.set(key, gi);
    }
  }
});

test('no synonym is shorter than four characters', () => {
  // A short token substring-matches unrelated molecules. `CRO` once matched MICRO, MACRO and CROWN in
  // the lab lookup; the same mistake here would attach a supplier to the wrong compound.
  for (const g of SYNONYM_GROUPS) {
    for (const name of g) {
      assert.ok(normalize(name).length >= 4,
        `"${name}" is too short to substring-match safely`);
    }
  }
});

test('no synonym is a salt word', () => {
  for (const g of SYNONYM_GROUPS) {
    for (const name of g) {
      assert.ok(!SALT_WORDS.has(normalize(name)),
        `"${name}" is a counter-ion, not a substance`);
    }
  }
});

test('every group member round-trips to every other', () => {
  for (const g of SYNONYM_GROUPS) {
    for (const a of g) {
      const terms = expandMolecule(a).terms;
      for (const b of g) {
        assert.ok(terms.includes(normalize(b)),
          `${a} does not reach ${b} — the index is not symmetric`);
      }
    }
  }
});

// ── NO EXPANSION WHERE NONE IS WARRANTED ────

test('an unknown molecule expands to itself alone', () => {
  const e = expandMolecule('cabazitaxel');
  assert.deepStrictEqual(e.terms, ['cabazitaxel']);
  assert.strictEqual(e.expanded, false, 'nothing to explain in the UI');
});

test('semaglutide and metformin are not silently renamed', () => {
  // Both are the same in every register. If a future edit makes either expand, the UI starts
  // claiming a match under a name that does not exist.
  for (const n of ['semaglutide', 'liraglutide', 'docetaxel', 'paclitaxel', 'gemcitabine']) {
    assert.deepStrictEqual(expandMolecule(n).terms, [n], `${n} should not expand`);
  }
  assert.deepStrictEqual(expandMolecule('metformin').terms, ['metformin']);
});

test('a short or empty query yields no terms rather than a wildcard', () => {
  for (const q of ['', '   ', null, undefined]) {
    assert.deepStrictEqual(expandMolecule(q).terms, []);
  }
});

// ── SQL COMPOSITION ────

test('likePatterns wraps every term and nothing else', () => {
  assert.deepStrictEqual(likePatterns(['leuprolide', 'leuprorelin']),
    ['%leuprolide%', '%leuprorelin%']);
  assert.deepStrictEqual(likePatterns([]), []);
  assert.deepStrictEqual(likePatterns(undefined), []);
});

test('moleculeLikeSql takes an array parameter so one index serves every clause', () => {
  // The CPHI search matches the same term set in three CTEs. With per-term placeholders that is
  // index arithmetic in three places; with LIKE ANY it is one parameter used three times.
  const sql = moleculeLikeSql('k', 2);
  assert.strictEqual(sql, 'k LIKE ANY ($2)');
  assert.ok(!/\$\d+\s*\|\|/.test(sql), 'patterns belong in the parameter, not concatenated in SQL');
});

// ── WHAT THE UI TELLS THE USER ────

test('matchedVia names the filed name when it differs from what was typed', () => {
  const e = expandMolecule('leuprorelin');
  assert.strictEqual(matchedVia('Leuprolide Acetate', e), 'leuprolide');
});

test('matchedVia is silent when the row matches what was typed', () => {
  const e = expandMolecule('leuprorelin');
  assert.strictEqual(matchedVia('Leuprorelin Acetate', e), null,
    'no point telling someone their own word matched');
});

test('matchedVia survives junk', () => {
  assert.strictEqual(matchedVia(null, expandMolecule('leuprorelin')), null);
  assert.strictEqual(matchedVia('leuprolide', null), null);
  assert.strictEqual(matchedVia('leuprolide', expandMolecule('')), null);
});

test('normalize folds case, punctuation and whitespace', () => {
  assert.strictEqual(normalize('  Leuprolide   Acetate '), 'leuprolide acetate');
  assert.strictEqual(normalize('Gemcitabine (dFdU)'), 'gemcitabine dfdu');
  assert.strictEqual(normalize(null), '');
});
