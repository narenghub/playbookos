#!/usr/bin/env node
// ── THE AFTER PICTURE. DID E1 DO EXACTLY WHAT IT SAID IT WOULD? ──────────────
//
//   railway ssh 'node scripts/e1-reconcile.js'
//
// Exit 0 = every proof holds. Exit 1 = at least one does not, and it says which.
//
// IT READS. IT DOES NOT WRITE, AND IT DOES NOT MIGRATE.
//
// This header used to say the opposite — that proof 10 re-ran the backfill in --execute mode as the
// only honest way to show idempotence on production. That was wrong twice over. It made the
// reconciliation grade its own homework: on 31 Oct it reported 24 authorised identities as missing,
// then created them in proof 10, then failed for having created them. And the verdict depended on
// when you ran it rather than on whether the data was right.
//
// Idempotence is a property of the CODE, so it is proven where nothing else writes —
// check-molecule-identity-db.js runs the backfill twice against fixtures and asserts the second pass
// writes nothing. preflight.sh runs that on every commit.
//
// THE OPERATING ORDER, and it is not optional:
//
//   1. node scripts/backfill-molecule-identity.js --execute    (the writer)
//   2. node scripts/e1-reconcile.js                            (the reader, this file)
//
// Expectations are recomputed from the SAME analyze() the preview uses, against the live source
// rows, so this cannot drift from the authorised rule set. It CAN differ from the live molecule
// table, and that difference has two meanings which this file keeps apart: an unauthorised molecule
// EXISTING is a defect, and an authorised identity being ABSENT is lag behind step 1.
'use strict';

const { initDB, query } = require('../src/lib/db');   // no withTransaction: this file writes nothing
const { analyze, looksTruncated, fragmentCore, GENERIC_FRAGMENT_NAMES } = require('../src/lib/molecules/preview');
const { moleculeKey } = require('../src/lib/molecules/identity');
const { validCas } = require('../src/lib/catalogue/cas');
// NOT required any more: this file performs no migration. Kept out deliberately — importing the
// writer into the reader is what made proof 10 grade its own homework.
// const backfill = require('./backfill-molecule-identity');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 400)}`); };
const h = (n, s) => console.log(`\n── ${n}. ${s}\n`);

const SOURCES = [
  { table: 'study_molecules', idCol: 'id', nameCol: 'molecule_name', casCol: 'cas_number', where: null },
  { table: 'research_interests', idCol: 'id', nameCol: 'value', casCol: 'cas', where: `kind = 'molecule'` },
  { table: 'supplier_products', idCol: 'id', nameCol: 'product_name', casCol: 'cas', where: null },
];

const KNOWN_FLAGS = ['--list-unexpected', '--inspect-sources'];
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--before=')) continue;
  if (!KNOWN_FLAGS.includes(a)) {
    console.error(`unknown flag ${a}. Known: ${KNOWN_FLAGS.join(', ')}, --before=<path>`);
    process.exit(2);
  }
}

async function main() {
  // Reset per call. `fail` is module-level and main() never cleared it, so a second call counted the
  // first call's failures too — 2 became 14 across four runs. The command line calls main() once, so
  // it never showed. It was the negative control in check-reconcile-runs.js that found it, on its
  // first run, which is the whole argument for having one: a check nobody can invoke twice is a
  // check nobody can test.
  fail = 0;
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

  // ── --list-unexpected ────────────────────────────────────────────────────
  //
  // READ-ONLY. Names every molecule that exists but was not in the authorised CREATE set, with the
  // reason the analyser excluded it and the source rows now pointing at it. This is the input to a
  // retraction decision, so it must be a list of ids — not a pattern. Nothing here writes.
  if (process.argv.includes('--list-unexpected')) {
    await listUnexpected(query, a, expectCreate);
    return 0;
  }
  if (process.argv.includes('--inspect-sources')) {
    await inspectSources(query, a, expectCreate);
    return 0;
  }

  // ── 1 ────────────────────────────────────────────────────────────────────
  h(1, 'every molecule that exists is authorised; absences are lag, not defects');
  //
  // This asserted equality — molecules == CREATE — and that made Gate 1 impossible to close on a
  // live database. The 31 Oct 10:55 run read `expected 2447, found 2425` and failed, because
  // spinosad, vericiguat, cemsidomide and twenty-one others had arrived in study_molecules overnight
  // and no backfill had reached them yet. Nothing was wrong. The agents had simply done their job
  // between the last migration and this reading.
  //
  // Two claims were wearing one assertion:
  //
  //   SAFETY   — nothing exists that the rules do not authorise. This is the invariant. It is what
  //              caught the 38 unauthorised molecules on 29 Oct, and it must fail loudly.
  //   LIVENESS — everything authorised exists. This is lag. It goes false every time an agent writes
  //              a row the backfill has not processed, which on this system is several times a night.
  //
  // Lag is reported with its count so an overdue backfill is visible. It is not a defect, and
  // failing on it would make the verdict a statement about when you happened to look.
  const actual = (await query(`SELECT normalized_name FROM molecules`)).rows.map((x) => x.normalized_name);
  const actualSet = new Set(actual);
  const missing = [...expectCreate].filter((k) => !actualSet.has(k));
  const extra = actual.filter((k) => !expectCreate.has(k));
  console.log(`   ${actual.length} molecules on file, ${expectCreate.size} authorised by the current source data`);
  if (!missing.length) ok('every authorised identity exists — the backfill has caught up');
  else {
    console.log(`   LAG   ${missing.length} authorised identit(ies) not yet created: ${missing.slice(0, 8).join(', ')}`);
    console.log('         Not a defect. Run scripts/backfill-molecule-identity.js --execute, then re-read.');
  }
  // Two different findings wear the same shape, and conflating them cost an afternoon.
  //
  // A molecule outside CREATE whose identity the analyser can EXPLAIN is drift: it was created when
  // its evidence was consistent, and source data has since changed under it. levoleucovorin is the
  // case — one valid CAS on 29 Oct, a second arriving in a study row overnight.
  //
  // A molecule outside CREATE that the analyser cannot explain at all is the 29 Oct defect: created
  // by code that had a rule of its own. That one means the two implementations have diverged again.
  //
  // BOTH fail. Production holding a molecule the current rules exclude is not acceptable either
  // way — but the remedy differs, so the verdict names it instead of leaving the next person to work
  // out which they are looking at. Unlike an absence, an unauthorised PRESENCE is never lag: no
  // amount of waiting removes a row.
  const drift = extra.filter((k) => a.exclusionReasons.has(k));
  const unexplained = extra.filter((k) => !a.exclusionReasons.has(k));
  if (!extra.length) ok('nothing unexpected was created');
  else {
    if (drift.length) {
      bad(`${drift.length} molecule(s) exist whose identity has SINCE become excluded — drift, needs a ruling`,
        drift.slice(0, 8).map((k) => `${k} [${a.exclusionReasons.get(k)}]`).join('; '));
    }
    if (unexplained.length) {
      bad(`${unexplained.length} molecule(s) exist that the analyser cannot explain — the two implementations have diverged`,
        unexplained.slice(0, 8).join(', '));
    }
  }

  // ── 2 ────────────────────────────────────────────────────────────────────
  h(2, 'no excluded identity was created');
  const leaked = [...expectExcluded].filter((k) => actualSet.has(k));
  if (!leaked.length) ok(`all ${expectExcluded.size} exclusions stayed out`);
  else {
    bad(`${leaked.length} excluded identit(ies) exist as molecules`, leaked.slice(0, 10).join(', '));
  }
  // Whatever the remedy, an excluded identity must not be ADVERTISING a disputed CAS while it waits
  // for one. This is the half that can mislead a quotation, and it is checkable independently.
  const leakedWithCas = await query(
    `SELECT normalized_name, cas FROM molecules WHERE cas IS NOT NULL AND normalized_name = ANY($1)`,
    [leaked.length ? leaked : ['']]);
  if (!leakedWithCas.rowCount) ok('  …and none of them carries a canonical CAS while excluded');
  else bad(`${leakedWithCas.rowCount} excluded molecule(s) still carry a canonical CAS`,
    leakedWithCas.rows.map((x) => `${x.normalized_name}=${x.cas}`).join(', '));

  // ── 3 ────────────────────────────────────────────────────────────────────
  h(3, 'every created molecule maps to an expected source identity');
  // Only the unexplained ones trace to nothing. A drifted molecule traces to source rows that are
  // still there and still name it; what changed is the CAS evidence attached to them.
  if (!unexplained.length) ok('every molecule traces to a source identity the analyser knows about');
  else bad(`${unexplained.length} molecule(s) trace to nothing`, unexplained.slice(0, 8).join(', '));

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
  // The OTHER contest shape, which proof 4 did not check at all until levoleucovorin.
  // casContested is one number claimed by several identities; casContestedWithinIdentity is one
  // identity filed under several numbers. Both withhold the canonical CAS under Decision 1, and only
  // the first was ever verified — so a molecule that BECAME contested kept publishing its old number.
  const within = [...a.casContestedWithinIdentity.keys()];
  const withinWrote = await query(
    `SELECT normalized_name, cas FROM molecules WHERE cas IS NOT NULL AND normalized_name = ANY($1)`,
    [within.length ? within : ['']]);
  if (!withinWrote.rowCount) ok(`${within.length} identit(ies) hold more than one valid CAS, and none carries a canonical one`);
  else bad(`${withinWrote.rowCount} identit(ies) filed under several CAS numbers still carry one canonically`,
    withinWrote.rows.slice(0, 6).map((x) => `${x.normalized_name}=${x.cas}`).join(', '));

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
    // A row that is unlinked AND silent is either a defect — the backfill reached it and said
    // nothing — or a row that arrived after the last backfill, which nothing has reached yet. The
    // two are indistinguishable from the row alone, and `missing` is what tells them apart: while
    // authorised identities are still absent, the backfill is behind and silence is expected.
    //
    // At 11:01 this failed on 44 study_molecules rows that had simply arrived overnight, in the same
    // run whose proof 10 then processed them. Failing on that is failing for the clock again.
    if (unlinkedNoReason.rows[0].n === 0) ok(`  every unlinked ${s.table} row says WHY`);
    else if (missing.length) {
      console.log(`   LAG   ${unlinkedNoReason.rows[0].n} ${s.table} row(s) not yet reached — consistent with the `
        + `${missing.length} authorised identit(ies) still absent`);
    } else {
      bad(`  ${unlinkedNoReason.rows[0].n} ${s.table} rows are unlinked with no reason — silently skipped, `
        + 'and the backfill has caught up, so this is not lag');
    }
  }

  // ── 10 ───────────────────────────────────────────────────────────────────
  h(10, 'the state is internally consistent — this proof performs no migration');
  //
  // IT RAN THE MIGRATION. That was the defect, and it took three forms before I saw it.
  //
  // First two passes, so the first could absorb drift and the second assert zero writes: 23 minutes,
  // interrupted. Then one pass asserting zero structural writes: at 11:01 on 31 Oct that pass itself
  // created 24 molecules and 39 links, because 24 authorised identities had arrived overnight and
  // the backfill had legitimately not reached them. It reported the absences as failures in proofs 1
  // and 9, then created them in proof 10, then failed for having created them.
  //
  // A reconciliation that performs the migration is grading its own homework, and its verdict
  // depends on when you happened to run it rather than on whether the data is right. So it reads
  // now, and nothing else.
  //
  // The idempotency claim — "running the backfill twice changes nothing" — is about the CODE, and it
  // lives in check-molecule-identity-db.js, which runs it twice against fixtures and asserts the
  // second pass writes nothing. That is the stronger test: a quiet database is guaranteed there
  // rather than hoped for. preflight.sh runs it on every commit.
  //
  // The operating order is therefore explicit, and not optional:
  //
  //   1. node scripts/backfill-molecule-identity.js --execute    (the writer)
  //   2. node scripts/e1-reconcile.js                            (the reader, this file)
  //
  // Step 1 takes about 16 minutes against current volumes and the agents write during it, so a
  // little lag at step 2 is normal and is reported as lag.
  console.log('   this proof reads only. Idempotency is proven against fixtures in');
  console.log('   scripts/check-molecule-identity-db.js ("a second pass writes NOTHING"), which');
  console.log('   preflight.sh runs on every commit.');
  console.log('');

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
  // `after` used to be the post-pass molecule count from proof 10. Removing the pass left this
  // reading a variable that no longer existed, and the 11:14 run reached the last section of the
  // reconciliation before dying on `after is not defined` — with every proof above it having
  // already printed. node --check cannot see an undefined reference, and nothing in preflight
  // executes main(), so only a production run could find it. Counted here instead.
  const onFile = (await query(`SELECT COUNT(*)::int n FROM molecules`)).rows[0].n;
  const seq = await query(`SELECT last_value::int n FROM molecules_id_seq`);
  if (seq.rows[0].n >= onFile) ok(`sequence last_value ${seq.rows[0].n} >= ${onFile} molecules — allocation is sane`);
  else bad(`sequence ${seq.rows[0].n} is behind the molecule count ${onFile}`);
  // "Complete" is distinguishable from "incomplete" by exactly this: an unlinked row either has a
  // reason (refused) or does not (never reached). The second count being zero is what says the run
  // finished rather than stopped partway.
  const neverReached = await query(`
    SELECT COUNT(*)::int n FROM study_molecules WHERE molecule_id IS NULL AND molecule_unresolved_reason IS NULL`);
  if (neverReached.rows[0].n === 0) ok('no row is in the "never attempted" state — the run completed');
  else if (missing.length) {
    console.log(`   LAG   ${neverReached.rows[0].n} row(s) not yet reached, consistent with the `
      + `${missing.length} authorised identit(ies) still absent — run the backfill`);
  } else {
    bad(`${neverReached.rows[0].n} rows were never reached and the backfill has caught up — the run is INCOMPLETE`);
  }

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
    SELECT normalized_name FROM molecules WHERE normalized_name LIKE '%reference standard%'
       OR normalized_name LIKE '%analytical standard%' OR normalized_name LIKE '%internal standard%'`);
  if (!rsLeak.rowCount) ok('no descriptor-phrase name survives as its own molecule');
  else bad(`${rsLeak.rowCount} descriptor-phrase names became molecules`,
    rsLeak.rows.map((x) => x.normalized_name).join(', '));
  // Truncated and generic fragments must be absent entirely.
  //
  // This asks the ANALYSER, not a SQL pattern. The previous version matched `normalized_name LIKE
  // '%]%'`, which flags every isotope label and ring descriptor — [1-13C]pyruvic acid,
  // [18F]fluoromisonidazole, Kryptofix [8.8.8]hexacosane are all real compounds. A check whose
  // failures are mostly its own false positives trains you to ignore it, which is worse than absent.
  const allNames = (await query(`SELECT normalized_name FROM molecules`)).rows.map((x) => x.normalized_name);
  const fragLeak = allNames.filter(
    (n) => GENERIC_FRAGMENT_NAMES.has(fragmentCore(n)) || looksTruncated(n));
  if (!fragLeak.length) ok('no truncated or generic fragment became a molecule');
  else bad(`${fragLeak.length} fragments were created`, fragLeak.slice(0, 12).join(', '));
  // Contested pair, specifically.
  const sel = await mol(moleculeKey('Selumetinib'));
  const bini = await mol(moleculeKey('Binimetinib'));
  if (sel && bini && sel.cas === null && bini.cas === null) {
    ok('selumetinib and binimetinib both exist and NEITHER carries 606143-89-9');
  } else if (!sel || !bini) console.log('  skip  the contested pair is not both present');
  else bad('a contested molecule carries the disputed CAS', `${sel.cas} / ${bini.cas}`);

  console.log('');
  // RETURNS its verdict; it does not exit the process. main() called process.exit(1) here, which
  // made the function unusable by any caller: check-reconcile-runs.js executes it to prove every
  // line runs, and was killed mid-report with its own output suppressed — exit 1, nothing printed.
  // Same class as the require.main defects fixed on 30 Oct: a function that terminates its caller.
  // The command-line exit code is unchanged, decided by the tail of this file.
  if (fail) {
    console.log(`✗ RECONCILIATION FAILED — ${fail} proof(s) did not hold.\n`);
    return fail;
  }
  console.log('✓ RECONCILED — every proof holds. E1 did exactly what the preview said it would.\n');
  return 0;
}

// ── THE LISTING, AS A FUNCTION OF ITS QUERY ─────────────────────────────────
//
// Separated and exported for one reason: the first version of this selected `canonical_name`, which
// does not exist. The column is `preferred_name`. I wrote a production query from memory instead of
// from the DDL, and production is where it failed — after a deploy and an SSH round trip.
//
// scripts/check-molecule-identity-db.js now calls this against the local Postgres it already builds
// from the real DDL, so a column that does not exist fails in preflight, locally, in a second.
async function listUnexpected(q, a, expectCreate) {
  const got = await q(
      `SELECT id, molecule_ref, normalized_name, preferred_name, cas, substance_form,
              parent_molecule_id, derived_base_name
         FROM molecules ORDER BY normalized_name`);
    const extras = got.rows.filter((m) => !expectCreate.has(m.normalized_name));
    console.log(`\n── molecules present but NOT in the authorised CREATE set: ${extras.length}\n`);
    for (const m of extras) {
      const reason = a.exclusionReasons.get(m.normalized_name) || '(no analyser reason — unaccounted)';
      let linked = 0;
      const per = [];
      for (const s of SOURCES) {
        const ex = await q(`SELECT to_regclass($1) IS NOT NULL ok`, [s.table]);
        if (!ex.rows[0].ok) continue;
        const n = (await q(
          `SELECT COUNT(*)::int n FROM ${s.table} WHERE molecule_id = $1`, [m.id])).rows[0].n;
        if (n) { linked += n; per.push(`${s.table}=${n}`); }
      }
      const al = (await q(
        `SELECT COUNT(*)::int n FROM molecule_aliases WHERE molecule_id = $1`, [m.id])).rows[0].n;
      console.log(`   id=${String(m.id).padEnd(6)} ${m.molecule_ref}  ${m.normalized_name}`);
      console.log(`          reason   ${reason}`);
      console.log(`          cas      ${m.cas === null ? '(withheld)' : m.cas}   form=${m.substance_form}` +
        `${m.parent_molecule_id ? `  parent=${m.parent_molecule_id}` : ''}`);
      console.log(`          links    ${linked} source row(s)${per.length ? ` [${per.join(' ')}]` : ''}` +
        `   aliases ${al}`);
    }
    console.log(`\n── RETRACTION SET (ids), for review only — nothing was written\n`);
    console.log(`   ${extras.map((m) => m.id).join(',')}\n`);

    const rs = await q(
      `SELECT id, normalized_name FROM molecules WHERE normalized_name LIKE '%reference standard%'
         OR normalized_name LIKE '%analytical standard%' OR normalized_name LIKE '%internal standard%'
       ORDER BY normalized_name`);
    console.log(`── names still carrying a descriptor phrase: ${rs.rowCount}\n`);
    rs.rows.forEach((x) => console.log(`   id=${String(x.id).padEnd(6)} ${x.normalized_name}`));
    if (!rs.rowCount) console.log('   (none)');

    const alx = await q(`
      SELECT al.alias, m.normalized_name FROM molecule_aliases al
        JOIN molecules m ON m.id = al.molecule_id ORDER BY al.alias`);
    const mism = alx.rows.filter((x) => moleculeKey(x.alias) !== x.normalized_name);
    console.log(`\n── aliases whose key does not reproduce their molecule: ${mism.length}\n`);
    mism.forEach((x) => console.log(`   ${x.alias}  ->  ${x.normalized_name}   (key = ${moleculeKey(x.alias) || '(empty)'})`));
    if (!mism.length) console.log('   (none)');

  console.log('\n   READ-ONLY listing complete. No INSERT, UPDATE or DELETE was issued.\n');
}

// ── WHAT THE SOURCE ROWS ACTUALLY SAID ──────────────────────────────────────
//
// READ-ONLY. The listing above gives the molecule as it was created; this gives the raw string it was
// created from. Both are needed before anything is retracted, for two different reasons.
//
// For the corrupted names, the raw string is the evidence that the identity is fabricated: `benzamide`
// is a real and very common compound (CAS 55-21-0) and this row carries a different number, so either
// the name or the CAS is wrong — and the source string shows which.
//
// For the 34 descriptor-phrase rows the raw string IS the finding. `… internal standard e.g.
// deuterated or 13c analog` is an analytical requirement, not a nameable substance, and it must not be
// normalised down to the parent drug code either: an isotopically labelled analog is a DIFFERENT
// material, which is the isotope invariant E1 already enforces everywhere else.
async function inspectSources(q, a, expectCreate) {
  const mols = (await q(
    `SELECT id, molecule_ref, normalized_name, preferred_name, cas FROM molecules
      ORDER BY normalized_name`)).rows;
  const extras = mols.filter((m) => !expectCreate.has(m.normalized_name));
  const descr = mols.filter((m) => /\b(reference|analytical|internal) standard\b/.test(m.normalized_name));

  const dump = async (title, set) => {
    console.log(`\n── ${title}: ${set.length}\n`);
    for (const m of set) {
      const reason = a.exclusionReasons.get(m.normalized_name) || '(in the authorised CREATE set)';
      console.log(`   id=${String(m.id).padEnd(6)} ${m.normalized_name}`);
      console.log(`          reason   ${reason}`);
      console.log(`          cas held ${m.cas === null ? '(withheld)' : m.cas}`);
      for (const s of SOURCES) {
        const ex = await q(`SELECT to_regclass($1) IS NOT NULL ok`, [s.table]);
        if (!ex.rows[0].ok) continue;
        const rs = await q(
          `SELECT ${s.idCol} AS rid, ${s.nameCol} AS nm, ${s.casCol} AS cas
             FROM ${s.table} WHERE molecule_id = $1 ORDER BY ${s.idCol}`, [m.id]);
        for (const r0 of rs.rows) {
          console.log(`          src      ${s.table}#${r0.rid}  cas=${r0.cas === null ? '(null)' : r0.cas}`);
          console.log(`                   "${r0.nm}"`);
        }
      }
    }
    if (!set.length) console.log('   (none)');
  };

  await dump('UNAUTHORISED molecules, with the strings they came from', extras);
  await dump('DESCRIPTOR-PHRASE molecules — authorised, and not substances', descr);
  console.log('\n   READ-ONLY. No INSERT, UPDATE or DELETE was issued.\n');
}

// main is exported so scripts/check-reconcile-runs.js can execute it against a local database and
// prove every line runs. `after is not defined` reached production because nothing in preflight
// called this function.
module.exports = { listUnexpected, inspectSources, main };

// Gated, for the reason the backfill's guards are gated: an importer gets the exported function, not
// a full reconciliation run against whatever database it happens to be pointed at, followed by this
// file's process.exit. scripts/check-molecule-identity-db.js requires listUnexpected; ungated, that
// require would have run main() and exited the checker from inside a dependency.
if (require.main === module) {
  main().then((f) => process.exit(f ? 1 : 0)).catch((e) => {
    console.error(`\n✗ reconciliation could not run: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
}
