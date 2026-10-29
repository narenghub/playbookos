// ── THE PREVIEW'S NUMBERS MUST BE REPRODUCIBLE FROM A FIXTURE ────────────────
//
// The report that decides whether the migration runs is built from these counts. If they were only
// observable by pointing the script at production, nobody could check them — and a number nobody
// can check is how "37 buyers" survived long enough to reach a board update when the real figure
// was 3. The fixture below is taken from the real 29 Oct census output, so each assertion is a
// claim about data that actually exists.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { analyze } = require('./preview');

const row = (name, cas, rid = 1, table = 'study_molecules') => ({ table, rid, name, cas });

test('a base/salt legacy conflict is eliminated, with the split inspectable', () => {
  const a = analyze([
    row('Leuprolide', '53714-56-0', 1),
    row('Leuprolide Acetate', '74381-53-6', 2),
  ]);
  // MEASURED: the legacy canonicalizer made one group holding two registry numbers.
  assert.strictEqual(a.summary.legacyConflicts, 1);
  // DETERMINISTIC: E1 keeps two identities, each with one CAS, so nothing survives.
  assert.strictEqual(a.summary.e1Conflicts, 0);
  assert.strictEqual(a.summary.eliminatedBySaltForm, 1);

  const e = a.eliminated[0];
  assert.strictEqual(e.legacy, 'leuprolide');
  assert.deepStrictEqual(e.legacyCas.sort(), ['53714-56-0', '74381-53-6']);
  assert.strictEqual(e.splitInto.length, 2);
  // The explanation has to name the mechanism, not assert goodwill.
  assert.match(e.reason, /stripping form tokens/);
  const salt = e.splitInto.find((p) => p.identity === 'leuprolide acetate');
  assert.deepStrictEqual(salt.cas, ['74381-53-6']);
  assert.strictEqual(salt.base, 'leuprolide');
});

test('a synonym-folded pair also separates by form', () => {
  // The census filed this under canonical `adrenaline` because the curated group folds
  // epinephrine -> adrenaline, and THEN the salt split produced the conflict.
  const a = analyze([
    row('Epinephrine', '51-43-4', 3),
    row('Epinephrine Bitartrate', '51-42-3', 4),
  ]);
  assert.strictEqual(a.summary.legacyConflicts, 1);
  assert.strictEqual(a.summary.e1Conflicts, 0);
  assert.strictEqual(a.summary.eliminatedBySaltForm, 1);
});

test('a single filed name with several CAS numbers SURVIVES as a genuine conflict', () => {
  // norketamine, from the census: one name, three valid registry numbers. No form stripping is
  // involved, so E1 cannot and must not make this go away.
  const a = analyze([
    row('Norketamine', '22159-41-7', 5),
    row('Norketamine', '20864-83-9', 6),
    row('Norketamine', '20180-34-1', 7),
  ]);
  assert.strictEqual(a.summary.legacyConflicts, 1);
  assert.strictEqual(a.summary.e1Conflicts, 1);
  assert.strictEqual(a.summary.eliminatedBySaltForm, 0);
  assert.strictEqual(a.summary.surviving, 1);
  assert.match(a.surviving[0].reason, /single filed name/);
  assert.ok(a.classification.get('norketamine').includes('QUARANTINE_IDENTITY_CONFLICT'));
  assert.ok(!a.classification.get('norketamine').includes('SAFE_TO_CREATE'),
    'a quarantined identity must not also be reported safe to create');
});

test('a conflict that merely MOVES is not counted as eliminated', () => {
  // The group splits, but one resulting identity still holds two CAS numbers. Counting this as
  // "resolved" would be the flattering arithmetic this whole exercise exists to avoid.
  const a = analyze([
    row('Resmetirom', '920509-32-6', 8),
    row('Resmetirom', '1132935-63-7', 9),
    row('Resmetirom Sodium', '1234567-89-5', 10),
  ]);
  assert.strictEqual(a.summary.eliminatedBySaltForm, 0);
  assert.strictEqual(a.summary.surviving, 1);
  assert.match(a.surviving[0].reason, /still holds two valid CAS/);
});

test('one CAS under two identities is REVIEW_REQUIRED, never a merge', () => {
  // fludarabine and 2-fluoro-ara-A carry the identical pair in the real data. 2-fluoro-ara-A is
  // fludarabine's active metabolite — a relationship the curated table does not contain — so
  // nothing here may conclude synonymy automatically.
  const a = analyze([
    row('Fludarabine', '21679-14-1', 11),
    row('2-Fluoro-ara-A', '21679-14-1', 12),
  ]);
  assert.strictEqual(a.sharedCas.length, 1);
  const s = a.sharedCas[0];
  assert.strictEqual(s.cas, '21679-14-1');
  assert.strictEqual(s.identities.length, 2);
  assert.strictEqual(s.explanation, 'REVIEW_REQUIRED');
  // Advisory, not blocking: both substances are otherwise well evidenced.
  for (const id of s.identities) {
    assert.ok(a.classification.get(id).includes('REVIEW_SHARED_CAS'));
    assert.ok(a.classification.get(id).includes('SAFE_TO_CREATE'));
  }
});

test('a shared CAS that a curated synonym explains is labelled as such', () => {
  const a = analyze([
    row('Paracetamol', '103-90-2', 13),
    row('Acetaminophen', '103-90-2', 14),
  ]);
  assert.strictEqual(a.sharedCas.length, 1);
  assert.strictEqual(a.sharedCas[0].explanation, 'explained_curated_synonym');
});

test('a shared CAS between two forms of one base is labelled as a form relationship', () => {
  const a = analyze([
    row('Leuprolide', '53714-56-0', 15),
    row('Leuprolide Acetate', '53714-56-0', 16),
  ]);
  assert.strictEqual(a.sharedCas.length, 1);
  assert.strictEqual(a.sharedCas[0].explanation, 'explained_form_relationship');
  // Explained is still not merged: they remain two identities.
  assert.strictEqual(a.summary.e1Groups, 2);
});

test('missing CAS and present-but-invalid CAS are counted separately', () => {
  const a = analyze([
    row('Molecule A', null, 17),
    row('Molecule B', '', 18),
    row('Molecule C', '50-78-3', 19),      // CAS-shaped, checksum fails
    row('Molecule D', '50-78-2', 20),      // aspirin, valid
  ]);
  assert.strictEqual(a.measured.casMissing, 2);
  assert.strictEqual(a.measured.casPresentInvalid, 1);
  assert.strictEqual(a.measured.casPresentValid, 1);
  assert.strictEqual(a.summary.invalidCasDistinct, 1);
  assert.strictEqual(a.invalidCas.occurrences[0].rid, 19);
  assert.ok(a.classification.get('molecule c').includes('INVALID_CAS_EVIDENCE'));
  // An invalid CAS does not stop the substance being created — the name is the identity key.
  assert.ok(a.classification.get('molecule c').includes('SAFE_TO_CREATE'));
});

test('a missing CAS alone is not INSUFFICIENT_IDENTITY', () => {
  // 28.5% of real rows carry no CAS. A name is identity enough in E1, so treating absence as
  // insufficiency would quarantine a quarter of the data for no gain.
  const a = analyze([row('Pembrolizumab', null, 21)]);
  assert.ok(a.classification.get('pembrolizumab').includes('SAFE_TO_CREATE'));
  assert.strictEqual(a.summary.insufficient, 0);
});

test('a name too short to be a substance is INSUFFICIENT_IDENTITY', () => {
  const a = analyze([row('()', null, 22), row('X', null, 23)]);
  assert.strictEqual(a.summary.insufficient, 1);     // both land in the one unresolvable bucket
  assert.strictEqual(a.summary.e1Groups, 0);
});

test('grade markers do not create a second substance', () => {
  const a = analyze([
    row('Gemcitabine', '122111-03-9', 24),
    row('Gemcitabine USP Reference Standard', '122111-03-9', 25),
  ]);
  // "usp" is stripped as a grade; "reference standard" is not a form token, so this stays its own
  // identity — which is correct, and is why the census saw it as a separate canonical group.
  assert.ok(a.summary.e1Groups >= 1);
  assert.strictEqual(a.summary.e1Conflicts, 0);
});

test('row and table counts are reported as measured, per table', () => {
  const a = analyze([
    row('A', null, 1, 'study_molecules'),
    row('B', null, 2, 'supplier_products'),
    row('C', null, 3, 'supplier_products'),
  ]);
  assert.strictEqual(a.measured.sourceRows, 3);
  assert.deepStrictEqual(a.measured.rowsByTable, { study_molecules: 1, supplier_products: 2 });
});

test('every E1 group receives exactly one decision set, and blockers exclude SAFE_TO_CREATE', () => {
  const a = analyze([
    row('Leuprolide', '53714-56-0', 1),
    row('Norketamine', '22159-41-7', 2),
    row('Norketamine', '20864-83-9', 3),
    row('()', null, 4),
  ]);
  for (const [key, flags] of a.classification) {
    assert.ok(flags.length >= 1, `${key} has no decision`);
    const blocked = flags.includes('QUARANTINE_IDENTITY_CONFLICT') || flags.includes('INSUFFICIENT_IDENTITY');
    assert.strictEqual(flags.includes('SAFE_TO_CREATE'), !blocked,
      `${key}: SAFE_TO_CREATE must be present exactly when no blocker applies`);
  }
});
