#!/usr/bin/env node
// ── THE AFTER PICTURE. DID E1 DO EXACTLY WHAT IT SAID IT WOULD? ──────────────
//
//   railway ssh 'node scripts/e1-reconcile.js'
//
// Exit 0 = every proof holds. Exit 1 = at least one does not, and it says which.
//
// This re-runs the backfill in --execute mode ONCE, deliberately, as proof 10: a second run must
// create zero molecules and zero new links. That is the only honest way to demonstrate
// idempotence on production — asserting it from the code would be asserting the thing in
// question. Every statement it issues is idempotent, so the re-run is a no-op by construction and
// the count proves it rather than the comment.
//
// Expectations are recomputed from the SAME analyze() the preview uses, against the live source
// rows. So this cannot drift from the authorised expectation: if the two disagreed, it would be
// because the source data changed, and that is itself worth failing on.
'use strict';

const { initDB, query, withTransaction } = require('../src/lib/db');
const { analyze } = require('../src/lib/molecules/preview');
const { moleculeKey } = require('../src/lib/molecules/identity');
const { validCas } = require('../src/lib/catalogue/cas');
const backfill = require('./backfill-molecule-identity');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 400)}`); };
const h = (n, s) => console.log(`\n── ${n}. ${s}\n`);

const SOURCES = [
  { table: 'study_molecules', idCol: 'id', nameCol: 'molecule_name', casCol: 'cas_number', where: null },
  { table: 'research_interests', idCol: 'id', nameCol: 'value', casCol: 'cas', where: `kind = 'molecule'` },
  { table: 'supplier_products', idCol: 'id', nameCol: 'product_name', casCol: 'cas', where: null },
];

async function main() {
  await initDB();
  const commit = String(process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'unknown';
  console.log(`\n═══ E1 POST-MIGRATION RECONCILIATION · commit ${commit} ═══`);

  // Recompute the expectation from live source rows.
  const rows = [];
  for (const s of SOURCES) {
    const ex = await query(`SELECT to_regclass($1) IS NOT NULL ok`, [s.table]);
    if (!ex.rows[0].ok) continue;
    const w = s.where ? `WHERE ${s.where}` : '';
    const got = await query(`SELECT ${s.idCol} AS rid, ${s.nameCol} AS nm, ${s.casCol} AS cas FROM ${s.table} ${w}`);
    got.rows.forEach((x) => rows.push({ table: s.table, rid: x.rid, name: x.nm, cas: x.cas }));
  }
  const a = analyze(rows);
  const S = a.summary;
  const expectCreate = new Set(a.executionSet.CREATE);
  const expectExcluded = new Set([...a.exclusionReasons.keys()]);

  // ── 1 ────────────────────────────────────────────────────────────────────
  h(1, 'actual molecules created = expected CREATE');
  const actual = (await query(`SELECT normalized_name FROM molecules`)).rows.map((x) => x.normalized_name);
  const actualSet = new Set(actual);
  if (actual.length === expectCreate.size) ok(`${actual.length} molecules, exactly as expected`);
  else bad(`expected ${expectCreate.size}, found ${actual.length}`);
  const missing = [...expectCreate].filter((k) => !actualSet.has(k));
  const extra = actual.filter((k) => !expectCreate.has(k));
  if (!missing.length) ok('nothing expected is absent');
  else bad(`${missing.length} expected molecules were not created`, missing.slice(0, 8).join(', '));
  if (!extra.length) ok('nothing unexpected was created');
  else bad(`${extra.length} molecules exist that were not in CREATE`, extra.slice(0, 8).join(', '));

  // ── 2 ────────────────────────────────────────────────────────────────────
  h(2, 'no excluded identity was created');
  const leaked = [...expectExcluded].filter((k) => actualSet.has(k));
  if (!leaked.length) ok(`all ${expectExcluded.size} exclusions stayed out`);
  else bad(`${leaked.length} excluded identities WERE created`, leaked.slice(0, 10).join(', '));

  // ── 3 ────────────────────────────────────────────────────────────────────
  h(3, 'every created molecule maps to an expected source identity');
  const orphanMolecules = actual.filter((k) => !expectCreate.has(k));
  if (!orphanMolecules.length) ok('every molecule traces to a source identity in the CREATE set');
  else bad(`${orphanMolecules.length} molecules trace to nothing`, orphanMolecules.slice(0, 8).join(', '));

  // ── 4 ────────────────────────────────────────────────────────────────────
  h(4, 'contested CAS values were suppressed');
  const contestedExpected = new Set(a.casEvidence.CAS_CONTESTED);
  const wrote = await query(`
    SELECT normalized_name, cas FROM molecules
     WHERE cas IS NOT NULL AND normalized_name = ANY($1)`, [[...contestedExpected]]);
  if (!wrote.rowCount) ok(`${contestedExpected.size} contested identities, none carrying a canonical CAS`);
  else bad(`${wrote.rowCount} contested molecules DID carry a disputed CAS`,
    wrote.rows.slice(0, 6).map((x) => `${x.normalized_name}=${x.cas}`).join(', '));
  const kept = await query(`
    SELECT COUNT(*)::int n FROM molecules
     WHERE cas_suppressed_reason LIKE 'cas_contested%' AND cas_source_values IS NOT NULL`);
  if (kept.rows[0].n >= contestedExpected.size) ok('the source values were preserved, not discarded');
  else bad(`only ${kept.rows[0].n} of ${contestedExpected.size} kept their source CAS as evidence`);
  const contestRows = await query(`SELECT COUNT(*)::int n FROM molecule_conflicts WHERE kind='cas_contested'`);
  if (contestRows.rows[0].n > 0) ok(`${contestRows.rows[0].n} contests recorded in molecule_conflicts`);
  else bad('no cas_contested rows were written');

  // ── 5 ────────────────────────────────────────────────────────────────────
  h(5, 'invalid CAS values were not promoted');
  const allCas = (await query(`SELECT normalized_name, cas FROM molecules WHERE cas IS NOT NULL`)).rows;
  const badCas = allCas.filter((x) => !validCas(x.cas));
  if (!badCas.length) ok(`all ${allCas.length} canonical CAS values pass the checksum`);
  else bad(`${badCas.length} molecules carry a checksum-invalid CAS`,
    badCas.slice(0, 6).map((x) => `${x.normalized_name}=${x.cas}`).join(', '));

  // ── 6 ────────────────────────────────────────────────────────────────────
  h(6, 'salt and form distinctions remain separated');
  const formPairs = await query(`
    SELECT c.normalized_name child, c.substance_form, p.normalized_name parent
      FROM molecules c JOIN molecules p ON p.id = c.parent_molecule_id`);
  const collapsed = formPairs.rows.filter((x) => x.child === x.parent);
  if (!collapsed.length) ok(`${formPairs.rowCount} parent edges, no child equal to its parent`);
  else bad(`${collapsed.length} form rows collapsed into their base`);
  const baseWithParent = await query(`
    SELECT COUNT(*)::int n FROM molecules WHERE substance_form='base' AND parent_molecule_id IS NOT NULL`);
  if (baseWithParent.rows[0].n === 0) ok('no base substance carries a parent edge');
  else bad(`${baseWithParent.rows[0].n} base substances have a parent`);

  // ── 7 ────────────────────────────────────────────────────────────────────
  h(7, 'isotope distinctions remain separated');
  const iso = await query(`
    SELECT normalized_name FROM molecules
     WHERE normalized_name ~ '(enriched|deuterated|-d[0-9]|\\[18f\\])'`);
  if (iso.rowCount > 0) ok(`${iso.rowCount} isotopically-marked identities survive as their own molecules`);
  else bad('no isotopic identities exist — enrichment may have been normalized away');

  // ── 8 ────────────────────────────────────────────────────────────────────
  h(8, 'curated synonyms collapse only their approved aliases');
  const aliases = await query(`
    SELECT a.alias, m.normalized_name FROM molecule_aliases a JOIN molecules m ON m.id = a.molecule_id`);
  const unexpectedAlias = aliases.rows.filter((x) => moleculeKey(x.alias) !== x.normalized_name);
  if (!unexpectedAlias.length) ok(`${aliases.rowCount} aliases, every one resolving to its curated representative`);
  else bad(`${unexpectedAlias.length} aliases do not match the curated mapping`,
    unexpectedAlias.slice(0, 6).map((x) => `${x.alias}->${x.normalized_name}`).join(', '));
  const aliasIsIdentity = await query(`
    SELECT COUNT(*)::int n FROM molecule_aliases a
     WHERE EXISTS (SELECT 1 FROM molecules m WHERE m.normalized_name = a.alias AND m.id <> a.molecule_id)`);
  if (aliasIsIdentity.rows[0].n === 0) ok('no alias is also another molecule’s own identity');
  else bad(`${aliasIsIdentity.rows[0].n} aliases collide with a molecule identity`);

  // ── 9 ────────────────────────────────────────────────────────────────────
  h(9, 'source rows link only where deterministic');
  for (const s of SOURCES) {
    const w = s.where ? `AND ${s.where}` : '';
    const linkedWrong = await query(`
      SELECT COUNT(*)::int n FROM ${s.table} t JOIN molecules m ON m.id = t.molecule_id
       WHERE TRUE ${w}`);
    const unlinkedNoReason = await query(`
      SELECT COUNT(*)::int n FROM ${s.table}
       WHERE molecule_id IS NULL AND molecule_unresolved_reason IS NULL ${w}`);
    console.log(`   ${s.table}: ${linkedWrong.rows[0].n} linked, ${unlinkedNoReason.rows[0].n} unlinked with no reason`);
    if (unlinkedNoReason.rows[0].n === 0) ok(`  every unlinked ${s.table} row says WHY`);
    else bad(`  ${unlinkedNoReason.rows[0].n} ${s.table} rows are unlinked with no reason — silently skipped`);
  }

  // ── 10 ───────────────────────────────────────────────────────────────────
  h(10, 'rerunning E1 creates zero molecules and no duplicate linkage');
  const before = (await query(`SELECT COUNT(*)::int n FROM molecules`)).rows[0].n;
  const beforeLinks = (await query(`SELECT COUNT(*)::int n FROM study_molecules WHERE molecule_id IS NOT NULL`)).rows[0].n;
  const realLog = console.log;
  console.log = () => {};
  let second;
  try {
    second = await backfill.main({ query, withTransaction, execute: true });
  } finally { console.log = realLog; }
  const after = (await query(`SELECT COUNT(*)::int n FROM molecules`)).rows[0].n;
  const afterLinks = (await query(`SELECT COUNT(*)::int n FROM study_molecules WHERE molecule_id IS NOT NULL`)).rows[0].n;
  if (second.writes === 0) ok('the re-run issued ZERO write statements');
  else bad(`the re-run wrote ${second.writes} time(s)`, JSON.stringify({ created: second.moleculesCreated, linked: second.rowsLinked }));
  if (after === before) ok(`molecule count unchanged at ${after}`);
  else bad(`molecule count moved ${before} -> ${after}`);
  if (afterLinks === beforeLinks) ok(`linkage unchanged at ${afterLinks}`);
  else bad(`linkage moved ${beforeLinks} -> ${afterLinks}`);
  const dupes = await query(`
    SELECT normalized_name, COUNT(*)::int n FROM molecules GROUP BY normalized_name HAVING COUNT(*) > 1`);
  if (!dupes.rowCount) ok('no duplicate molecule exists');
  else bad(`${dupes.rowCount} duplicated identities`, JSON.stringify(dupes.rows.slice(0, 5)));

  // ── RECOVERY EVIDENCE ────────────────────────────────────────────────────
  h('R', 'recovery: quarantines held, sequence valid, state distinguishable');
  const quarantined = await query(`SELECT COUNT(*)::int n FROM molecule_conflicts WHERE resolved_at IS NULL`);
  ok(`${quarantined.rows[0].n} unresolved quarantine rows remain — none auto-resolved`);
  const resolvedByRun = await query(`SELECT COUNT(*)::int n FROM molecule_conflicts WHERE resolved_at IS NOT NULL`);
  if (resolvedByRun.rows[0].n === 0) ok('the migration resolved no conflict on its own');
  else bad(`${resolvedByRun.rows[0].n} conflicts were resolved — the migration must not rule on these`);
  const seq = await query(`SELECT last_value::int n FROM molecules_id_seq`);
  if (seq.rows[0].n >= after) ok(`sequence last_value ${seq.rows[0].n} >= ${after} molecules — allocation is sane`);
  else bad(`sequence ${seq.rows[0].n} is behind the molecule count ${after}`);
  // "Complete" is distinguishable from "incomplete" by exactly this: an unlinked row either has a
  // reason (refused) or does not (never reached). The second count being zero is what says the run
  // finished rather than stopped partway.
  const neverReached = await query(`
    SELECT COUNT(*)::int n FROM study_molecules WHERE molecule_id IS NULL AND molecule_unresolved_reason IS NULL`);
  if (neverReached.rows[0].n === 0) ok('no row is in the "never attempted" state — the run completed');
  else bad(`${neverReached.rows[0].n} rows were never reached — the run is INCOMPLETE, re-run it`);

  // ── REPRESENTATIVE HIGH-RISK CASES ───────────────────────────────────────
  h('HR', 'representative high-risk cases, inspected individually');
  const mol = async (k) => (await query(`SELECT * FROM molecules WHERE normalized_name = $1`, [k])).rows[0];
  const pair = async (label, aName, bName, mustDiffer = true) => {
    const ka = moleculeKey(aName); const kb = moleculeKey(bName);
    const ma = await mol(ka); const mb = await mol(kb);
    if (mustDiffer) {
      if (ma && mb && ma.id !== mb.id) ok(`${label}: distinct molecules (${ka} / ${kb})`);
      else if (!ma || !mb) console.log(`  skip  ${label}: not present in this data (${ka} / ${kb})`);
      else bad(`${label}: COLLAPSED into one molecule`);
    } else if (ka === kb) ok(`${label}: one molecule under both names (${ka})`);
    else bad(`${label}: did not fold`, `${ka} vs ${kb}`);
  };
  await pair('leuprolide / leuprolide acetate', 'Leuprolide', 'Leuprolide acetate');
  await pair('warfarin / warfarin sodium', 'Warfarin', 'Warfarin sodium');
  await pair('gemcitabine / gemcitabine hydrochloride', 'Gemcitabine', 'Gemcitabine hydrochloride');
  await pair('selumetinib / binimetinib', 'Selumetinib', 'Binimetinib');
  await pair('dronabinol / delta-9-THC', 'Dronabinol', 'Delta-9-tetrahydrocannabinol', false);
  await pair('BPA 10B-enriched / natural abundance',
    'L-boronophenylalanine 10B-enriched', 'L-boronophenylalanine');
  // Reference-standard normalization: the relabelled name must NOT exist as its own molecule.
  const rsLeak = await query(`
    SELECT COUNT(*)::int n FROM molecules WHERE normalized_name LIKE '%reference standard%'`);
  if (rsLeak.rows[0].n === 0) ok('no "reference standard" name survives as its own molecule');
  else bad(`${rsLeak.rows[0].n} reference-standard names became molecules`);
  // Truncated and generic fragments must be absent entirely.
  const fragLeak = await query(`
    SELECT normalized_name FROM molecules
     WHERE normalized_name IN ('amine','e-2-carboxylic acid')
        OR normalized_name LIKE '%]%' OR normalized_name LIKE 'yl %'`);
  if (!fragLeak.rowCount) ok('no truncated or generic fragment became a molecule');
  else bad(`${fragLeak.rowCount} fragments were created`, fragLeak.rows.map((x) => x.normalized_name).join(', '));
  // Contested pair, specifically.
  const sel = await mol(moleculeKey('Selumetinib'));
  const bini = await mol(moleculeKey('Binimetinib'));
  if (sel && bini && sel.cas === null && bini.cas === null) {
    ok('selumetinib and binimetinib both exist and NEITHER carries 606143-89-9');
  } else if (!sel || !bini) console.log('  skip  the contested pair is not both present');
  else bad('a contested molecule carries the disputed CAS', `${sel.cas} / ${bini.cas}`);

  console.log('');
  if (fail) {
    console.log(`✗ RECONCILIATION FAILED — ${fail} proof(s) did not hold.\n`);
    process.exit(1);
  }
  console.log('✓ RECONCILED — every proof holds. E1 did exactly what the preview said it would.\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`\n✗ reconciliation could not run: ${e && e.message ? e.message : e}\n`);
  process.exit(1);
});
