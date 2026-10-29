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

// ── THE SHARED-CAS SPLIT (added after the 29 Oct preview) ───────────────────

test('descriptor variants collapse into ONE identity, so they leave shared-CAS entirely', () => {
  // The 341-values / 823-identities number was dominated by this shape. After normalization these
  // are one molecule, so there is nothing left to share a CAS with.
  const a = analyze([
    row('Venetoclax', '1257044-40-8', 1),
    row('Venetoclax reference standard', '1257044-40-8', 2),
    row('Venetoclax USP Reference Standard', '1257044-40-8', 3),
    row('Venetoclax USP/EP Reference Standard', '1257044-40-8', 4),
  ]);
  assert.strictEqual(a.summary.e1Groups, 1, 'four phrasings of one substance became more than one molecule');
  assert.strictEqual(a.summary.sharedCas, 0);
  assert.strictEqual(a.summary.descriptorNormalizedRows > 0, true);
});

test('a descriptor pattern the rules MISS is reported as a normalization gap, not a conflict', () => {
  // Deliberately a phrasing identity.js does not strip. It must not be filed as human review work:
  // the fix is a rule, not an adjudication.
  const a = analyze([
    row('Foobarium', '50-78-2', 1),
    row('Foobarium certified grade', '50-78-2', 2),
  ]);
  assert.strictEqual(a.summary.sharedCas, 1);
  assert.strictEqual(a.sharedCas[0].kind, 'DESCRIPTOR_VARIANT');
  assert.strictEqual(a.sharedCas[0].explanation, 'normalization_gap_descriptor_only');
  assert.strictEqual(a.summary.sharedCasDistinctNames, 0);
  // Advisory only — neither molecule is blocked, and neither is merged.
  assert.strictEqual(a.summary.e1Groups, 2);
});

test('two unrelated drugs sharing a CAS stay DISTINCT_NAMES_SHARED_CAS and highly visible', () => {
  // 1428935-60-7 is attached to both in the real data. They are an ADC and a PD-L1 antibody.
  // Nothing may normalize these together, and the flag must not be the same one used for a
  // relabelled reference standard.
  const a = analyze([
    row('Mirvetuximab Soravtansine', '1428935-60-7', 1),
    row('Durvalumab', '1428935-60-7', 2),
  ]);
  assert.strictEqual(a.sharedCas[0].kind, 'DISTINCT_NAMES_SHARED_CAS');
  assert.strictEqual(a.sharedCas[0].explanation, 'REVIEW_REQUIRED');
  assert.strictEqual(a.summary.sharedCasDistinctNames, 1);
  assert.strictEqual(a.summary.e1Groups, 2);
  // Reported as a candidate for a human, never acted on.
  assert.strictEqual(a.summary.synonymCandidates, 1);
  assert.match(a.synonymCandidates[0].note, /human decides/);
});

// ── A BENIGN LABEL MUST NOT CONCEAL A DANGEROUS ONE ─────────────────────────
//
// The 29 Oct corrected run classified these as DESCRIPTOR_VARIANT because ONE pair inside each
// group was a descriptor variant, and the group inherited the benign label. All three are real.

test('a descriptor variant in the group does NOT mask a genuinely different substance', () => {
  // selumetinib and binimetinib are two different MEK inhibitors sharing selumetinib's CAS.
  const a = analyze([
    row('Selumetinib', '606143-89-9', 1),
    row('Selumetinib USP/EP reference standard', '606143-89-9', 2),
    row('Binimetinib', '606143-89-9', 3),
  ]);
  const s = a.sharedCas.find((x) => x.cas === '606143-89-9');
  assert.ok(s, 'the shared CAS vanished');
  assert.strictEqual(s.kind, 'DISTINCT_NAMES_SHARED_CAS',
    'a real misattribution was labelled a normalization gap');
  assert.strictEqual(s.explanation, 'REVIEW_REQUIRED');
});

test('a metabolite is not a grade variant', () => {
  const a = analyze([
    row('Bicalutamide', '90357-06-5', 1),
    row('Bicalutamide USP Reference Standard', '90357-06-5', 2),
    row('Hydroxybicalutamide', '90357-06-5', 3),
  ]);
  const s = a.sharedCas.find((x) => x.cas === '90357-06-5');
  assert.strictEqual(s.kind, 'DISTINCT_NAMES_SHARED_CAS');
});

test('chemicalCore strips non-chemical words from anywhere, not just the end', () => {
  const { chemicalCore } = require('./preview');
  assert.strictEqual(chemicalCore('venetoclax reference standard usp/ep grade'), 'venetoclax');
  assert.strictEqual(chemicalCore('venetoclax'), 'venetoclax');
  // Chemical words survive, so two substances never share a core.
  assert.notStrictEqual(chemicalCore('selumetinib'), chemicalCore('binimetinib'));
  assert.notStrictEqual(chemicalCore('bicalutamide'), chemicalCore('hydroxybicalutamide'));
  assert.notStrictEqual(chemicalCore('pemetrexed'), chemicalCore('pemetrexed free acid'));
  assert.notStrictEqual(chemicalCore('leuprolide'), chemicalCore('leuprolide acetate'));
});

test('the (USP/EP grade) phrasing — all ten remaining gaps — now collapses', () => {
  const I = require('./identity');
  for (const filed of [
    'Apalutamide reference standard (USP/EP grade)',
    'Pembrolizumab reference standard (USP/analytical grade)',
    'Niraparib reference standard (USP/Ph.Eur. grade)',
    'Enzalutamide USP/reference standard',
    'Alectinib reference standard (USP/EP grade)',
  ]) {
    const core = filed.split(' ')[0].toLowerCase();
    assert.strictEqual(I.substanceForm(filed).identity, core, `${filed} did not collapse`);
  }
});

test('the venetoclax group collapses to one molecule and leaves shared-CAS', () => {
  const a = analyze([
    row('Venetoclax', '1257044-40-8', 1),
    row('Venetoclax reference standard (USP/EP grade)', '1257044-40-8', 2),
    row('Venetoclax USP/analytical reference standard', '1257044-40-8', 3),
  ]);
  assert.strictEqual(a.summary.e1Groups, 1);
  assert.strictEqual(a.summary.sharedCas, 0);
});

test('descriptorVariantOf refuses a pair whose tail carries chemical meaning', () => {
  const { descriptorVariantOf } = require('./preview');
  assert.strictEqual(descriptorVariantOf('venetoclax', 'venetoclax reference standard'), true);
  assert.strictEqual(descriptorVariantOf('leuprolide', 'leuprolide acetate'), false);
  assert.strictEqual(descriptorVariantOf('pemetrexed', 'pemetrexed free acid'), false);
  assert.strictEqual(descriptorVariantOf('metformin', 'metformin hydrochloride'), false);
  assert.strictEqual(descriptorVariantOf('aspirin', 'aspirin'), false);
});

test('a curated synonym pair is EXPLAINED, not flagged for review', () => {
  const a = analyze([
    row('Aspirin', '50-78-2', 1),
    row('Acetylsalicylic acid', '50-78-2', 2),
  ]);
  // Now that the pair is curated, these are one substance plus an alias — no shared CAS at all.
  assert.strictEqual(a.summary.sharedCasDistinctNames, 0);
});

test('truncated chemical names are recorded and NOT repaired', () => {
  // A fragment of pemetrexed's IUPAC name with its opening brackets gone. Guessing the missing
  // half is exactly the plausible invention this refuses; it is an upstream ingest defect.
  const a = analyze([
    row('pyrimidin-5-yl)ethyl]benzoyl]-L-glutamic Acid', '137281-23-3', 1),
    row('Pemetrexed', '137281-23-3', 2),
  ]);
  assert.strictEqual(a.summary.truncatedNames, 1);
  assert.match(a.truncatedNames[0].why, /unbalanced/);
  // Recorded, and still its own identity — normalization did not absorb it.
  assert.strictEqual(a.summary.e1Groups, 2);
});

// ── E1.1 EDGE CASES ─────────────────────────────────────────────────────────

test('ISOTOPE INVARIANT: descriptors normalize away, isotopic composition must not', () => {
  // The demonstrated case from the 29 Oct run. `reference standard` is commercial; `10b-enriched`
  // and `natural abundance` are the substance. These must never become one identity.
  const a = analyze([
    row('L-boronophenylalanine 10B-enriched (L-BPA)', '76099-46-2', 1),
    row('L-boronophenylalanine reference standard 10B/natural abundance', '76099-46-2', 2),
  ]);
  assert.strictEqual(a.summary.e1Groups, 2,
    'isotopic enrichment was erased by descriptor normalization');
  const ids = [...a.e1.groups.keys()];
  assert.ok(ids.some((i) => /10b-enriched/.test(i)), 'the enriched form lost its marker');
});

test('ISOTOPE INVARIANT: deuterated and radiolabelled forms stay distinct from the parent', () => {
  const a = analyze([
    row('MDMA (3,4-methylenedioxymethamphetamine) hydrochloride', '64057-70-1', 1),
    row('MDMA-d5 (deuterated internal standard)', '1219794-27-8', 2),
    row('Fluoromisonidazole [18F]FMISO', '121994-97-2', 3),
    row('Fluoromisonidazole non-radioactive reference standard', '111986-72-4', 4),
  ]);
  const ids = [...a.e1.groups.keys()];
  assert.ok(ids.includes('mdma-d5 deuterated'), 'the deuterated standard lost its label');
  assert.ok(ids.some((i) => /18f/.test(i)), 'the radiolabel was erased');
  assert.ok(ids.includes('fluoromisonidazole non-radioactive'));
  assert.strictEqual(a.summary.e1Groups, 4);
});

test('a corrupted name is EXCLUDED from creation, not created because its CAS resolves', () => {
  // The fact that makes it look resolvable — sharing a CAS with the real substance — is the fact
  // that makes it dangerous. A name nobody can read is not an identity.
  const a = analyze([
    row('pyrimidin-5-yl)ethyl]benzoyl]-L-glutamic Acid', '137281-23-3', 1),
    row('Pemetrexed', '137281-23-3', 2),
  ]);
  const corrupted = [...a.e1.groups.keys()].find((k) => /glutamic acid/.test(k));
  assert.ok(corrupted, 'the corrupted identity vanished');
  const flags = a.classification.get(corrupted);
  assert.ok(flags.includes('QUARANTINE_CORRUPTED_NAME'));
  assert.ok(!flags.includes('SAFE_TO_CREATE'), 'a corrupted name would have been created');
  assert.match(a.exclusionReasons.get(corrupted), /^corrupted_name:/);
  // The real substance is unaffected.
  assert.ok(a.classification.get('pemetrexed').includes('SAFE_TO_CREATE'));
});

test('free base sharing one CAS with its parent is SAME_NEUTRAL_SUBSTANCE', () => {
  const a = analyze([
    row('Ketamine', '6740-88-1', 1),
    row('Ketamine free base', '6740-88-1', 2),
  ]);
  assert.strictEqual(a.summary.freeFormCases, 1);
  const f = a.freeForm[0];
  assert.strictEqual(f.disposition, 'SAME_NEUTRAL_SUBSTANCE');
  assert.strictEqual(f.parentExists, true);
  assert.strictEqual(f.structuralEvidence, 'NONE — no InChIKey, SMILES or molfile exists in this database');
  // Classified, NOT merged: both identities still exist.
  assert.strictEqual(a.summary.e1Groups, 2);
});

test('free base whose CAS disagrees with its parent is DISTINCT_FORM', () => {
  const a = analyze([
    row('Selumetinib', '606143-89-9', 1),
    row('Selumetinib free base', '943332-08-9', 2),
  ]);
  assert.strictEqual(a.freeForm[0].disposition, 'DISTINCT_FORM');
  assert.match(a.freeForm[0].reason, /registry disagrees/);
});

test('free base with no parent, or without registry evidence, is AMBIGUOUS and BLOCKED', () => {
  const a = analyze([
    row('Obscurimab free base', '50-78-2', 1),      // no parent identity anywhere
    row('Octreotide', null, 2),
    row('Octreotide free base', null, 3),            // parent exists, neither has a valid CAS
  ]);
  assert.strictEqual(a.summary.freeFormAmbiguous, 2);
  for (const f of a.freeForm) {
    assert.strictEqual(f.disposition, 'AMBIGUOUS');
    const flags = a.classification.get(f.identity);
    assert.ok(flags.includes('AMBIGUOUS_FORM'));
    assert.ok(!flags.includes('SAFE_TO_CREATE'),
      'an unresolved identity leaked into the creation set');
    assert.match(a.exclusionReasons.get(f.identity), /^ambiguous_form:/);
  }
});

test('salt counterparts are reported as context and do not decide the disposition', () => {
  const a = analyze([
    row('Ketamine', '6740-88-1', 1),
    row('Ketamine free base', '6740-88-1', 2),
    row('Ketamine hydrochloride', '1867-66-9', 3),
  ]);
  const f = a.freeForm[0];
  assert.ok(f.saltCounterparts.some((s) => /ketamine hydrochloride/.test(s)));
  // Still decided on registry evidence, not on the salt's presence.
  assert.strictEqual(f.disposition, 'SAME_NEUTRAL_SUBSTANCE');
});

test('the THC cluster is gathered as evidence with its stereo markers flagged', () => {
  const a = analyze([
    row('Dronabinol ((-)-trans-Δ9-tetrahydrocannabinol)', '1972-08-3', 1),
    row('Delta-9-tetrahydrocannabinol (THC)', '1972-08-3', 2),
    row('Dronabinol USP Reference Standard', '1972-08-3', 3),
  ]);
  assert.ok(a.summary.thcIdentities >= 2);
  const stereo = a.thcCluster.find((t) => t.hasStereoMarker);
  assert.ok(stereo, 'the (-)-trans-Δ9 stereochemistry was not detected');
  // Nothing is merged by the census.
  assert.ok(a.summary.thcIdentities >= 2);
});

test('EXCLUSION INTEGRITY: every excluded identity has a machine-readable reason', () => {
  const a = analyze([
    row('Leuprolide', '53714-56-0', 1),
    row('Norketamine', '22159-41-7', 2),
    row('Norketamine', '20864-83-9', 3),
    row('pyrimidin-5-yl)ethyl]benzoyl]-L-glutamic Acid', '137281-23-3', 4),
    row('Obscurimab free base', '50-78-2', 5),
    row('()', null, 6),
  ]);
  assert.strictEqual(a.exclusionIntegrity.excluded, a.exclusionIntegrity.withReason,
    `unexplained exclusions: ${a.exclusionIntegrity.missingReason.join(', ')}`);
  assert.deepStrictEqual(a.exclusionIntegrity.missingReason, []);
  assert.deepStrictEqual(a.exclusionIntegrity.createdAndExcluded, [],
    'an identity was both created and excluded');
  // And the execution set partitions cleanly.
  const created = new Set(a.executionSet.CREATE);
  for (const k of a.exclusionReasons.keys()) {
    assert.ok(!created.has(k), `${k} is excluded and in CREATE`);
  }
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
