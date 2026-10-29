// ── THE TESTS THAT MATTER ARE THE ONES ABOUT WHAT MUST *NOT* MERGE ───────────
//
// synonyms.test.js guards the search side: no name in two groups, nothing under four characters
// substring-matched, no token both a synonym and a counter-ion (that one caught `trometamol`,
// written into both tables by mistake). This file guards the identity side, and its central
// assertion is a negative one: a salt is never an alias of its base.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { SALT_WORDS } = require('./synonyms');
const I = require('./identity');

// ── THE GUARD TEST ──────────────────────────────────────────────────────────
//
// synonyms.js owns one flat SALT_WORDS set; identity.js partitions it into grade / hydrate / ester
// / salt / ambiguous. If the partition is not TOTAL, an unclassified trailing token makes a name
// read as a plain base substance — a salt silently filed as its own parent, which is exactly the
// error this whole phase exists to remove. So adding a counter-ion to synonyms.js without
// classifying it here must fail the suite rather than degrade quietly.
test('the form partition is total over SALT_WORDS', () => {
  const classes = {
    GRADE_WORDS: I.GRADE_WORDS,
    HYDRATE_WORDS: I.HYDRATE_WORDS,
    ESTER_WORDS: I.ESTER_WORDS,
    SALT_FORM_WORDS: I.SALT_FORM_WORDS,
    AMBIGUOUS_FORM_WORDS: I.AMBIGUOUS_FORM_WORDS,
  };
  const unclassified = [];
  for (const w of SALT_WORDS) {
    if (!Object.values(classes).some((s) => s.has(w))) unclassified.push(w);
  }
  assert.deepStrictEqual(unclassified, [],
    `unclassified SALT_WORDS would be treated as part of the substance name: ${unclassified.join(', ')}`);
});

test('the form partition is disjoint — no word in two classes', () => {
  const classes = {
    GRADE_WORDS: I.GRADE_WORDS,
    HYDRATE_WORDS: I.HYDRATE_WORDS,
    ESTER_WORDS: I.ESTER_WORDS,
    SALT_FORM_WORDS: I.SALT_FORM_WORDS,
    AMBIGUOUS_FORM_WORDS: I.AMBIGUOUS_FORM_WORDS,
  };
  const doubled = [];
  for (const w of SALT_WORDS) {
    const hits = Object.keys(classes).filter((k) => classes[k].has(w));
    if (hits.length > 1) doubled.push(`${w} -> ${hits.join(', ')}`);
  }
  assert.deepStrictEqual(doubled, [], `ambiguous classification: ${doubled.join(' | ')}`);
});

test('nothing is classified that is not a strippable word in synonyms.js', () => {
  const extra = [];
  for (const [name, set] of Object.entries({
    GRADE_WORDS: I.GRADE_WORDS, HYDRATE_WORDS: I.HYDRATE_WORDS, ESTER_WORDS: I.ESTER_WORDS,
    SALT_FORM_WORDS: I.SALT_FORM_WORDS, AMBIGUOUS_FORM_WORDS: I.AMBIGUOUS_FORM_WORDS,
  })) {
    for (const w of set) if (!SALT_WORDS.has(w)) extra.push(`${name}:${w}`);
  }
  assert.deepStrictEqual(extra, [],
    `classified but never stripped, so it can never be reached: ${extra.join(', ')}`);
});

test('a grade word is never a form word', () => {
  for (const g of I.GRADE_WORDS) {
    assert.ok(!I.FORM_WORDS.has(g), `${g} is both a grade and a form — it would create a child record`);
  }
});

// ── THE CENTRAL NEGATIVE ────────────────────────────────────────────────────

test('a salt is NOT an alias of its base', () => {
  const { identity, aliases } = I.aliasForms('Leuprolide Acetate');
  assert.strictEqual(identity, 'leuprolide acetate');
  assert.ok(!aliases.includes('leuprolide'),
    'leuprolide was returned as an alias of leuprolide acetate — different CAS, different substance');
});

test('an ester is NOT an alias of its base', () => {
  const { aliases } = I.aliasForms('Testosterone Enanthate');
  assert.ok(!aliases.includes('testosterone'),
    'testosterone enanthate (CAS 315-37-7) must not alias to testosterone (CAS 58-22-0)');
});

test('a hydrate is NOT an alias of its base', () => {
  const { aliases } = I.aliasForms('Metformin Hydrochloride');
  assert.ok(!aliases.includes('metformin'));
});

test('no name is ever its own alias', () => {
  for (const n of ['Leuprolide', 'Paracetamol', 'Leuprolide Acetate', 'Aspirin USP', 'Cortisone Acetate']) {
    const { identity, aliases } = I.aliasForms(n);
    assert.ok(!aliases.includes(identity), `${n} aliases to itself`);
  }
});

// ── THE POSITIVES: TRUE SYNONYMY, WITH THE FORM CARRIED THROUGH ─────────────

test('true synonyms alias in both directions', () => {
  assert.ok(I.aliasForms('Leuprorelin').aliases.includes('leuprolide'));
  assert.ok(I.aliasForms('Leuprolide').aliases.includes('leuprorelin'));
  assert.ok(I.aliasForms('Paracetamol').aliases.includes('acetaminophen'));
  assert.ok(I.aliasForms('Acetaminophen').aliases.includes('paracetamol'));
});

test('the synonym substitution applies to the base and keeps the form', () => {
  // This is the only way a salted name may acquire an alias, and it is a real case: leuprorelin
  // acetate and leuprolide acetate ARE the same substance under two naming conventions.
  assert.ok(I.aliasForms('Leuprorelin Acetate').aliases.includes('leuprolide acetate'));
  assert.ok(I.aliasForms('Leuprolide Acetate').aliases.includes('leuprorelin acetate'));
});

test('alias relationships are symmetric', () => {
  const names = ['leuprolide', 'leuprorelin', 'paracetamol', 'acetaminophen',
    'rifampicin', 'rifampin', 'leuprolide acetate', 'leuprorelin acetate'];
  for (const a of names) {
    for (const b of I.aliasForms(a).aliases) {
      assert.ok(I.aliasForms(b).aliases.includes(I.aliasForms(a).identity),
        `${a} -> ${b} is not mirrored by ${b} -> ${a}`);
    }
  }
});

// ── FORM CLASSIFICATION ─────────────────────────────────────────────────────

test('forms are classified from the trailing tokens', () => {
  assert.strictEqual(I.substanceForm('Testosterone Enanthate').form, 'ester');
  assert.strictEqual(I.substanceForm('Metformin Hydrochloride').form, 'salt');
  assert.strictEqual(I.substanceForm('Warfarin Sodium').form, 'salt');
  assert.strictEqual(I.substanceForm('Betamethasone Dipropionate').form, 'ester');
  assert.strictEqual(I.substanceForm('Leuprolide').form, 'base');
});

test('salt outranks hydrate when a name carries both', () => {
  const r = I.substanceForm('Donepezil Hydrochloride Monohydrate');
  assert.strictEqual(r.form, 'salt');
  assert.strictEqual(r.derivedBase, 'donepezil');
  assert.deepStrictEqual(r.formTokens, ['hydrochloride', 'monohydrate']);
});

test('a hydrate alone is a hydrate', () => {
  assert.strictEqual(I.substanceForm('Azithromycin Dihydrate').form, 'hydrate');
});

test('genuinely ambiguous counter-ions resolve to other, not to a guess', () => {
  // acetate is a salt on a peptide and an ester on a steroid; the name cannot tell you which.
  assert.strictEqual(I.substanceForm('Leuprolide Acetate').form, 'other');
  assert.strictEqual(I.substanceForm('Cortisone Acetate').form, 'other');
  assert.strictEqual(I.substanceForm('Metoprolol Succinate').form, 'other');
});

test('a form is always accompanied by a derived base, and base never is', () => {
  for (const n of ['Testosterone Enanthate', 'Metformin Hydrochloride', 'Leuprolide Acetate']) {
    const r = I.substanceForm(n);
    assert.notStrictEqual(r.form, 'base');
    assert.ok(r.derivedBase, `${n} has a form but no derived base`);
    assert.notStrictEqual(r.derivedBase, r.identity, `${n}: base and identity are the same string`);
  }
  for (const n of ['Leuprolide', 'Paracetamol', 'Potassium Chloride']) {
    const r = I.substanceForm(n);
    assert.strictEqual(r.form, 'base');
    assert.strictEqual(r.derivedBase, null, `${n} is a base but carries a derived base`);
  }
});

// ── THE GUARDS INHERITED FROM synonyms.js, RE-ASSERTED HERE ─────────────────

test('a mineral is the substance, not a salt of one', () => {
  // `potassium chloride` is a drug. Stripping it to `potassium` would file an electrolyte as a
  // counter-ion and give it a parent that is an element.
  const r = I.substanceForm('Potassium Chloride');
  assert.strictEqual(r.form, 'base');
  assert.strictEqual(r.identity, 'potassium chloride');
  assert.strictEqual(r.derivedBase, null);
});

test('a leading counter-ion is part of the name', () => {
  // Stripping happens from the END only: sodium cromoglicate keeps its sodium.
  const r = I.substanceForm('Sodium Cromoglicate');
  assert.strictEqual(r.form, 'base');
  assert.strictEqual(r.identity, 'sodium cromoglicate');
});

test('a base too short to be a substance means the whole name is the substance', () => {
  // Below the 6-character floor the base matches half the register; the name stays whole.
  const r = I.substanceForm('Zinc Oxide');
  assert.strictEqual(r.form, 'base');
  assert.strictEqual(r.identity, 'zinc oxide');
});

// ── GRADE MARKERS ARE THE SAME SUBSTANCE ────────────────────────────────────

test('pharmacopoeial grade and particle size do not create a new substance', () => {
  for (const [filed, expected] of [
    ['Aspirin USP', 'aspirin'],
    ['Ibuprofen EP', 'ibuprofen'],
    ['Budesonide Micronised', 'budesonide'],
    ['Metformin Anhydrous', 'metformin'],
  ]) {
    const r = I.substanceForm(filed);
    assert.strictEqual(r.identity, expected, `${filed} should normalise to ${expected}`);
    assert.strictEqual(r.form, 'base');
  }
});

// ── PURPOSE DESCRIPTORS (added after the 29 Oct preview) ────────────────────

test('reference-standard phrasing collapses to the underlying substance', () => {
  // The defect the preview found: CAS 1257044-40-8 was attached to four identities that are one
  // substance — venetoclax, plus three ways of saying "the reference standard of it".
  for (const filed of [
    'Venetoclax reference standard',
    'Venetoclax USP Reference Standard',
    'Venetoclax USP/EP Reference Standard',
    'Venetoclax USP/analytical reference standard',
    'Venetoclax (USP reference standard)',
    'Venetoclax analytical standard',
  ]) {
    assert.strictEqual(I.substanceForm(filed).identity, 'venetoclax', `${filed} did not collapse`);
  }
});

test('a purpose descriptor is stripped WITHOUT losing the chemical form', () => {
  // The case that would have been the expensive mistake: strip too much and the hydrochloride
  // becomes the base.
  const r = I.substanceForm('Gemcitabine hydrochloride USP Reference Standard');
  assert.strictEqual(r.identity, 'gemcitabine hydrochloride');
  assert.strictEqual(r.form, 'salt');
  assert.strictEqual(r.derivedBase, 'gemcitabine');
});

test('NEGATIVE CONTROL: free acid and free base are NOT stripped', () => {
  // They look like the same kind of phrase and are not: they name which chemical form you get.
  // `pemetrexed` and `pemetrexed free acid` stay distinct until separately classified.
  assert.strictEqual(I.substanceForm('Pemetrexed free acid').identity, 'pemetrexed free acid');
  assert.strictEqual(I.substanceForm('Naproxen free base').identity, 'naproxen free base');
  assert.notStrictEqual(I.substanceForm('Pemetrexed free acid').identity,
    I.substanceForm('Pemetrexed').identity);
});

test('NEGATIVE CONTROL: isotope and radiolabel words survive descriptor stripping', () => {
  // `non-radioactive` distinguishes a compound from its [18F]-labelled form — a different
  // substance with its own CAS. Purpose goes, isotope stays.
  assert.strictEqual(I.substanceForm('Fluoromisonidazole non-radioactive reference standard').identity,
    'fluoromisonidazole non-radioactive');
  assert.strictEqual(I.substanceForm('MDMA-d5 deuterated internal standard').identity,
    'mdma-d5 deuterated');
});

test('NEGATIVE CONTROL: no salt, ester or hydrate is collapsed by the descriptor rule', () => {
  const pairs = [
    ['Leuprolide acetate', 'Leuprolide'],
    ['Testosterone enanthate', 'Testosterone'],
    ['Metformin hydrochloride', 'Metformin'],
    ['Cyclophosphamide monohydrate', 'Cyclophosphamide'],
    ['Warfarin sodium', 'Warfarin'],
    ['Dexamethasone sodium phosphate', 'Dexamethasone'],
  ];
  for (const [form, base] of pairs) {
    assert.notStrictEqual(I.substanceForm(form).identity, I.substanceForm(base).identity,
      `${form} collapsed into ${base} — this is the quotation error`);
  }
});

test('every DESCRIPTOR_PHRASE actually fires — a rule nobody can demonstrate is unproven', () => {
  for (const phrase of I.DESCRIPTOR_PHRASES) {
    const filed = `foobarium ${phrase.join(' ')}`;
    const d = I.describeNormalization(filed);
    assert.strictEqual(d.identity, 'foobarium', `phrase "${phrase.join(' ')}" did not strip`);
    assert.ok(d.removed.includes(phrase.join(' ')), `phrase "${phrase.join(' ')}" not reported as removed`);
  }
});

test('every DESCRIPTOR_QUALIFIER is reachable', () => {
  // Reachability, which is weaker than "observed in production" and is the honest claim for a
  // defensive entry. The preview's own descriptorRemovedCounts reports which ones fire on the
  // real data, and that is the observed evidence.
  for (const q of I.DESCRIPTOR_QUALIFIERS) {
    const d = I.describeNormalization(`foobarium ${q} reference standard`);
    assert.strictEqual(d.identity, 'foobarium', `qualifier "${q}" did not strip`);
  }
});

test('describeNormalization reports exactly what it removed', () => {
  const d = I.describeNormalization('Carboplatin USP/analytical reference standard');
  assert.strictEqual(d.identity, 'carboplatin');
  assert.strictEqual(d.changed, true);
  assert.ok(d.removed.includes('reference standard'));
  assert.ok(d.removed.includes('usp/analytical'));
  const u = I.describeNormalization('Carboplatin');
  assert.strictEqual(u.changed, false);
  assert.deepStrictEqual(u.removed, []);
});

test('a bare "standard" is not stripped', () => {
  // Alone it is too close to ordinary words. Only the two-word phrases are removed.
  assert.strictEqual(I.substanceForm('Foobarium standard').identity, 'foobarium standard');
});

test('aspirin and acetylsalicylic acid are curated synonyms', () => {
  // Found by the shared-CAS detection (both carry 50-78-2), added by hand as one pair.
  assert.ok(I.aliasForms('Aspirin').aliases.includes('acetylsalicylic acid'));
  assert.ok(I.aliasForms('Acetylsalicylic acid').aliases.includes('aspirin'));
});

test('grade stripping composes with form detection', () => {
  const r = I.substanceForm('Testosterone Enanthate USP');
  assert.strictEqual(r.identity, 'testosterone enanthate');
  assert.strictEqual(r.form, 'ester');
  assert.strictEqual(r.derivedBase, 'testosterone');
});

// ── DEGENERATE INPUT ────────────────────────────────────────────────────────

test('empty and junk input yields nothing rather than something', () => {
  for (const bad of [null, undefined, '', '   ', '()', ';;']) {
    const r = I.identityOf(bad);
    assert.strictEqual(r.identity, '');
    assert.deepStrictEqual(r.aliases, []);
    assert.strictEqual(r.form, 'base');
  }
});

test('a name consisting only of form words is left whole', () => {
  // "sodium chloride" must not strip to nothing. The single-token guard keeps it intact.
  const r = I.substanceForm('Sodium Chloride');
  assert.strictEqual(r.identity, 'sodium chloride');
  assert.strictEqual(r.form, 'base');
});

test('identityOf reports why it decided what it decided', () => {
  // Every record carries its reason, because a classification a human cannot audit is a
  // classification a human has to trust.
  for (const n of ['Testosterone Enanthate', 'Potassium Chloride', 'Leuprolide']) {
    assert.ok(I.identityOf(n).reason && I.identityOf(n).reason.length > 5, `${n} has no reason`);
  }
});
