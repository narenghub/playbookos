#!/usr/bin/env node
// ── RETRACT THE 72 MOLECULES THE 29 OCT MIGRATION SHOULD NOT HAVE CREATED ────
//
//   railway ssh 'node scripts/e1-retract.js'              # dry run, writes nothing
//   railway ssh 'node scripts/e1-retract.js --execute'
//
// Exit 0 = the run completed and every id was accounted for. Non-zero = something did not match and
// nothing was retracted for that id.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// The 29 Oct migration created 2466 molecules where the authorised preview said 2428, because there
// were two implementations of "what may be created": the analyser had five exclusion categories and
// the backfill had re-derived its own rule with one. 38 identities the report promised to withhold
// were created anyway, and a further 34 — requirement sentences like "ABBV-1042 (stable
// isotope-labeled internal standard, e.g. deuterated or 13C analog)" — were inside the authorised
// set itself, because the descriptor stripper only ever matched a trailing phrase.
//
// Naresh authorised the retraction of all 72 on 30 Oct, having read both listings.
//
// ── WHY ALL 72 AND NOT THE 48 THAT ARE ACTIVELY WRONG ──────────────────────
//
// Eleven of the 38 are real substances with their CAS correctly withheld, and the analyser has since
// been corrected to create them deliberately. They are retracted anyway, because molecule ids are at
// this moment referenced by nothing except molecules.parent_molecule_id and the three source tables.
// inquiries, inquiry_quotes and rfq_requests have not been migrated. This is the only point at which
// a clean slate costs nothing; after commercial identity migration, id churn stops being free.
//
// ── THE ID LIST IS FROZEN ──────────────────────────────────────────────────
//
// It is written out below as literal ids, taken from the two listings he read, and NOT recomputed at
// run time. A retraction that recomputed its own target set would be a second implementation of the
// decision — which is the exact defect being cleaned up here. CLAUDE.md says a verification script
// may only touch rows it created, by explicit id, never by pattern; a retraction is held to the same
// rule, and more strictly, because nobody reads the cleanup code.
//
// Every id is checked against the normalized_name it had when he approved it. A mismatch means the
// database moved underneath this list, so that id is skipped and reported rather than deleted — an
// expectation built from live state goes stale the moment somebody changes that state, and the way a
// script finds out must not be by writing.
'use strict';

const { initDB, query, withTransaction } = require('../src/lib/db');
// The quarantine record writes kinds that molecule_conflicts' original CHECK does not list, so the
// widening is applied here rather than assumed to have happened in an earlier step.
const { applyConflictKinds } = require('./migrate-molecules');

let Q = query;
let TX = withTransaction;
let EXECUTE = require.main === module && process.argv.slice(2).includes('--execute');

const KNOWN = ['--execute', '--quiet'];
if (require.main === module) {
  for (const a of process.argv.slice(2)) {
    if (!KNOWN.includes(a)) {
      console.error(`unknown flag ${a}. Known: ${KNOWN.join(', ')}`);
      process.exit(2);
    }
  }
}

const SOURCES = [
  { table: 'study_molecules', idCol: 'id' },
  { table: 'research_interests', idCol: 'id' },
  { table: 'supplier_products', idCol: 'id' },
];

// ── GROUP A: unauthorised — created despite an analyser exclusion (38) ──────
// id, the name it must still have, and the reason it is going.
const UNAUTHORISED = [
  [2299, 'asciminib', 'cas_disagreement'],
  [1433, 'atomoxetine free base', 'ambiguous_form'],
  [2300, 'bendamustine', 'cas_disagreement'],
  [2356, 'benzamide', 'corrupted_name'],
  [2220, 'centanafadine free base', 'ambiguous_form'],
  [2365, 'cyanopyridin-4-yl oxyphenyl urea', 'corrupted_name'],
  [2373, 'e-2-carboxylic acid', 'insufficient_identity'],
  [2297, 'elacestrant', 'cas_disagreement'],
  [1199, 'enasidenib free base', 'ambiguous_form'],
  [2301, 'erlotinib', 'cas_disagreement'],
  [35, 'flonoltinib free base', 'ambiguous_form'],
  [2095, 'furmonertinib free base', 'ambiguous_form'],
  [2464, 'gadoterate meglumine', 'cas_disagreement'],
  [589, 'gemcitabine free base', 'ambiguous_form'],
  [753, 'lumateperone free base', 'ambiguous_form'],
  [2399, 'methylpyrimidin-4-yl amino]-1 3-thiazole-5-carboxamide', 'corrupted_name'],
  [608, 'mitapivat free base', 'ambiguous_form'],
  [1117, 'naloxone free base', 'ambiguous_form'],
  [2344, 'nilotinib ksm-2 3- dimethylamino-1- pyridine-3-yl prop-2-en-1-one', 'corrupted_name'],
  [2298, 'nusinersen', 'cas_disagreement'],
  [2303, 'octreotide acetate', 'cas_disagreement'],
  [667, 'octreotide free base', 'duplicate_risk'],
  [1434, 'oxybutynin free base', 'ambiguous_form'],
  [2202, 'pemetrexed free acid', 'duplicate_risk'],
  [2304, 'plerixafor', 'cas_disagreement'],
  [2461, 'pyrimidin-5-yl ethyl] benzoic acid', 'corrupted_name'],
  [2420, 'pyrimidin-5-yl ethyl] benzoic acid methyl ester', 'corrupted_name'],
  [2412, 'pyrimidin-5-yl ethyl]benzoyl]-l-glutamic acid', 'corrupted_name'],
  [2308, 'remibrutinib', 'cas_disagreement'],
  [2309, 'resmetirom', 'cas_disagreement'],
  [479, 'ritlecitinib free base', 'ambiguous_form'],
  [1236, 'saroglitazar free acid', 'ambiguous_form'],
  [1821, 'scopolamine free base', 'ambiguous_form'],
  [2002, 'selumetinib free base', 'duplicate_risk'],
  [519, 'tll-018 free base', 'ambiguous_form'],
  [2305, 'xanomeline tartrate', 'cas_disagreement'],
  [2444, 'yl amino]benzamide', 'corrupted_name'],
  [2445, 'yl amino benzoate', 'corrupted_name'],
];

// ── GROUP B: authorised, and not substances (34) ────────────────────────────
// Analytical requirements written into molecule_name. The authorised set was itself wrong here.
const REQUIREMENTS = [
  [1483, 'abbv-1042 stable isotope-labeled internal standard e.g. deuterated or 13c analog'],
  [1219, 'accg-2671 stable isotope-labeled internal standard deuterated or 13c'],
  [1700, 'aflibercept reference standard lot'],
  [1588, 'alks 2680 stable isotope-labeled internal standard deuterated or 13c-labeled analog'],
  [733, 'armi unlabeled reference standard norepinephrine transporter ligand'],
  [588, 'arv-393 stable isotope-labeled internal standard e.g. deuterated analog'],
  [1437, 'bi 3822971 stable isotope-labeled internal standard e.g. deuterated or 13c analog'],
  [2282, 'bms-986368 stable isotope-labeled internal standard e.g. d-/13c-labeled'],
  [1040, 'calderasib mk-1084 isotope-labeled internal standard e.g. 13c/2h'],
  [1901, 'cpv-104 stable isotope-labeled internal standard e.g. deuterated analog'],
  [718, 'dzd6008 stable isotope-labeled internal standard e.g. deuterated analog'],
  [847, 'fb-101 stable isotope-labeled internal standard deuterated or 13c analog'],
  [131, 'gfh375 stable isotope-labeled internal standard deuterated or 13c'],
  [189, 'hrs-5346 stable isotope-labeled internal standard e.g. d/13c'],
  [139, 'ins1033 isotope-labeled internal standard e.g. deuterated analog'],
  [665, 'jnj-77242113 stable isotope-labeled internal standard e.g. 13c/2h-labeled'],
  [1595, 'lacripep reference standard peptide synthetic lacritin fragment'],
  [701, 'l-boronophenylalanine reference standard 10b/natural abundance'],
  [1229, 'lp-168 isotope-labeled internal standard deuterated'],
  [1418, 'ly3867070 isotope-labeled internal standard deuterated or 13c'],
  [1501, 'ly3971297 stable isotope-labeled internal standard e.g. deuterated analog'],
  [1510, 'ly4226695 isotope-labeled internal standard stable-label e.g. 13c/2h'],
  [1300, "mk-6240 non-radioactive reference standard 2- 2-fluoropyridin-4-yl -9h-pyrrolo[2 3-b:4 5-c']dipyridine"],
  [1575, 'non-radioactive fluorinated reference standard of nos 19f analog'],
  [1768, 'onc206 isotope-labeled internal standard e.g. deuterated onc206'],
  [662, 'r406 isotope-labeled internal standard e.g. r406-d6'],
  [911, 'ribupatide isotope-labeled internal standard e.g. stable-isotope-labeled analog'],
  [1931, 'ro7795081 isotope-labeled internal standard e.g. deuterated analog'],
  [598, 'stable isotope-labeled 13c/2h internal standard of maridebart cafraglutide peptide component'],
  [110, 'stable isotope-labeled internal standard for eloralintide e.g. 13c/15n-labeled peptide analog'],
  [109, 'stable isotope-labeled internal standard for macupatide e.g. 13c/15n-labeled peptide analog'],
  [2050, 'tern-701 mk-4208 stable isotope-labeled internal standard e.g. deuterated analog'],
  [1913, 'vk2735 stable isotope-labeled internal standard e.g. 13c/2h-labeled vk2735'],
  [623, 'zotiraciclib isotope-labeled internal standard e.g. deuterated analog'],
];

const PLAN = [
  ...UNAUTHORISED.map(([id, name, kind]) => ({ id, name, kind, group: 'unauthorised' })),
  ...REQUIREMENTS.map(([id, name]) => ({
    id, name, kind: 'insufficient_identity', group: 'requirement',
  })),
];

const ok = (m) => console.log(`  ok    ${m}`);
let fail = 0;
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 300)}`); };

// The reason left on each source row. It names the analyser category, so the row's own column
// answers "why is this unresolved" without re-running anything.
const reasonFor = (p) => (p.group === 'requirement'
  ? 'insufficient_identity:analytical_requirement_not_a_substance — retracted 30 Oct, '
    + 'awaiting a human ruling'
  : `${p.kind} — retracted 30 Oct: created by the 29 Oct run against the authorised execution set`);

async function main(deps = {}) {
  if (deps.query) Q = deps.query; else await initDB();
  if (deps.withTransaction) TX = deps.withTransaction;
  if (deps.execute !== undefined) EXECUTE = deps.execute;
  fail = 0;

  // The plan is injectable for ONE reason: so the mechanics can be exercised against fixtures.
  // scripts/check-molecule-identity-db.js builds a molecule, links a row, gives it an alias and a
  // child, and retracts it — which is how the unlink-before-delete ordering, the alias cleanup, the
  // child detach and the name-mismatch skip get verified without a production database. Default is
  // the frozen authorised list; a caller passing its own plan is testing, not retracting.
  const PLAN_IN_USE = deps.plan || PLAN;

  const commit = String(process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'local';
  console.log(`\n═══ E1 RETRACTION · ${EXECUTE ? 'EXECUTE' : 'DRY RUN (writes nothing)'} · ${commit} ═══\n`);
  console.log(PLAN_IN_USE === PLAN
    ? `   authorised set: ${PLAN.length} molecules `
      + `(${UNAUTHORISED.length} unauthorised + ${REQUIREMENTS.length} requirement sentences)\n`
    : `   INJECTED plan: ${PLAN_IN_USE.length} molecule(s) — this is a test, not the authorised set\n`);

  // ── THE SCHEMA THIS RUN DEPENDS ON ──────────────────────────────────────
  //
  // The 13:37 run deleted all 72 and then threw on the 7th evidence row, because the quarantine
  // record writes kind='insufficient_identity' and molecule_conflicts' CHECK predates that
  // category. The widening lived in migrate-molecules.js, which I had listed as the step AFTER this
  // one — so the operator did exactly what I wrote and the run half-landed.
  //
  // A script that needs a schema change does not get to assume somebody ran it first. In EXECUTE it
  // applies the widening itself, idempotently. In DRY RUN it reads the live constraint and asserts
  // every kind this plan will write is accepted, which is the check that would have caught it: the
  // dry run passed while being blind to the only table it was going to fail on.
  const kinds = [...new Set(PLAN_IN_USE.map((p) => p.kind))];
  if (EXECUTE) {
    await applyConflictKinds(Q, (m) => console.log(m));
  } else {
    const def = (await Q(`
      SELECT pg_get_constraintdef(oid) d FROM pg_constraint
       WHERE conname = 'molecule_conflicts_kind_check'`)).rows[0];
    const missing = def ? kinds.filter((k) => !def.d.includes(`'${k}'`)) : kinds;
    if (!def) bad('molecule_conflicts_kind_check does not exist — run scripts/migrate-molecules.js');
    else if (missing.length) {
      bad(`molecule_conflicts.kind rejects ${missing.length} of the kind(s) this plan writes`,
        `${missing.join(', ')} — run scripts/migrate-molecules.js first, or --execute, which widens it`);
    } else ok(`molecule_conflicts.kind accepts all ${kinds.length} kind(s) this plan writes`);
  }

  const before = (await Q(`SELECT COUNT(*)::int n FROM molecules`)).rows[0].n;

  const stats = {
    verified: 0, skippedMissing: 0, skippedMismatch: 0,
    unlinked: 0, aliasesDeleted: 0, childrenDetached: 0, moleculesDeleted: 0, writes: 0,
  };
  const skipped = [];

  for (const p of PLAN_IN_USE) {
    const m = (await Q(
      `SELECT id, normalized_name, preferred_name FROM molecules WHERE id = $1`, [p.id])).rows[0];
    if (!m) {
      // Already gone. Idempotent by design: a re-run after a partial execution must not fail.
      stats.skippedMissing += 1;
      continue;
    }
    if (m.normalized_name !== p.name) {
      // The database moved under the authorised list. Do not guess which row he meant.
      stats.skippedMismatch += 1;
      skipped.push(`id=${p.id} expected "${p.name}" but holds "${m.normalized_name}"`);
      continue;
    }
    stats.verified += 1;

    const apply = async (q) => {
      // 1. Source rows stop pointing at it and say why they are unresolved. Done BEFORE the delete,
      //    because molecule_id is a foreign key — deleting first would either fail or, with a
      //    cascade nobody intended, silently take the rows with it.
      for (const s of SOURCES) {
        const ex = await q(`SELECT to_regclass($1) IS NOT NULL ok`, [s.table]);
        if (!ex.rows[0].ok) continue;
        if (!EXECUTE) {
          const n = (await q(
            `SELECT COUNT(*)::int n FROM ${s.table} WHERE molecule_id = $1`, [p.id])).rows[0].n;
          stats.unlinked += n;
          continue;
        }
        const u = await q(
          `UPDATE ${s.table} SET molecule_id = NULL, molecule_unresolved_reason = $1
            WHERE molecule_id = $2`, [reasonFor(p).slice(0, 500), p.id]);
        stats.unlinked += u.rowCount || 0;
        stats.writes += u.rowCount || 0;
      }

      // 2. Any molecule that took this one as its parent keeps existing, parentless. Detaching is
      //    not a judgement about the child; it is the honest state, and PASS 2 of the backfill
      //    re-links a parent only where the base was independently observed.
      if (!EXECUTE) {
        const n = (await q(
          `SELECT COUNT(*)::int n FROM molecules WHERE parent_molecule_id = $1`, [p.id])).rows[0].n;
        stats.childrenDetached += n;
      } else {
        const d = await q(
          `UPDATE molecules SET parent_molecule_id = NULL WHERE parent_molecule_id = $1`, [p.id]);
        stats.childrenDetached += d.rowCount || 0;
        stats.writes += d.rowCount || 0;
      }

      // 3. Its aliases go with it. An alias outliving its molecule is a dangling name that the
      //    collision trigger would then refuse to let anything else claim.
      if (!EXECUTE) {
        const n = (await q(
          `SELECT COUNT(*)::int n FROM molecule_aliases WHERE molecule_id = $1`, [p.id])).rows[0].n;
        stats.aliasesDeleted += n;
      } else {
        const d = await q(`DELETE FROM molecule_aliases WHERE molecule_id = $1`, [p.id]);
        stats.aliasesDeleted += d.rowCount || 0;
        stats.writes += d.rowCount || 0;
      }

      // 4. The molecule. By id, matched against the name he approved — never by pattern.
      if (!EXECUTE) { stats.moleculesDeleted += 1; return; }
      const d = await q(`DELETE FROM molecules WHERE id = $1 AND normalized_name = $2`,
        [p.id, p.name]);
      stats.moleculesDeleted += d.rowCount || 0;
      stats.writes += d.rowCount || 0;
      if (!d.rowCount) throw new Error(`id ${p.id} ("${p.name}") was not deleted`);
    };

    // One transaction per molecule: unlink, detach, de-alias and delete commit together or not at
    // all. A crash leaves earlier molecules fully retracted and later ones untouched, and a re-run
    // resumes — the same restartability the migration itself has.
    if (EXECUTE) await TX(async (client) => apply((t, pr) => client.query(t, pr)));
    else await apply(Q);
  }

  // The quarantine record. molecule_conflicts is append-only by trigger, so this is evidence that
  // these identities were withheld — not a rewrite of what the 29 Oct run detected.
  if (EXECUTE) {
    for (const p of PLAN_IN_USE) {
      const key = `retracted|${p.name}|${p.kind}`.slice(0, 500);
      const ins = await Q(
        `INSERT INTO molecule_conflicts
           (kind, filed_name, identity_name, detail, source_table, conflict_key)
         VALUES ($1,$2,$3,$4,'retraction',$5)
         ON CONFLICT (conflict_key) WHERE resolved_at IS NULL DO NOTHING`,
        [p.kind, p.name.slice(0, 500), p.name,
          `retracted 30 Oct — ${p.group === 'requirement'
            ? 'an analytical requirement, not a nameable substance'
            : 'created by the 29 Oct run outside the authorised execution set'}`,
          key]);
      stats.writes += ins.rowCount || 0;
    }
  }

  const after = (await Q(`SELECT COUNT(*)::int n FROM molecules`)).rows[0].n;

  console.log('');
  const r = (l, v) => console.log(`   ${String(l).padEnd(36)} ${v}`);
  r('molecules before', before);
  r('ids verified against the approved name', stats.verified);
  r('ids already absent (idempotent re-run)', stats.skippedMissing);
  r('ids SKIPPED — name no longer matches', stats.skippedMismatch);
  r('source rows unlinked, with a reason', stats.unlinked);
  r('children detached from a retracted parent', stats.childrenDetached);
  r('aliases deleted', stats.aliasesDeleted);
  r('molecules deleted', stats.moleculesDeleted);
  r('write statements issued', stats.writes);
  r('molecules after', after);
  console.log('');

  if (skipped.length) {
    console.log('── SKIPPED, nothing written for these\n');
    skipped.forEach((s) => console.log(`   ${s}`));
    console.log('');
  }

  // ── THE PROOFS ──────────────────────────────────────────────────────────
  if (stats.skippedMismatch === 0) ok('every id still held the name it was approved under');
  else bad(`${stats.skippedMismatch} id(s) no longer match — they were left alone, by design`);

  if (EXECUTE) {
    const left = await Q(`SELECT id, normalized_name FROM molecules WHERE id = ANY($1)`,
      [PLAN_IN_USE.map((p) => p.id)]);
    // Only the mismatches may survive. Asserting "none of the 72 remain" would be false whenever a
    // mismatch was correctly skipped, and the obvious fix to a failing assertion like that is to
    // widen the delete — which is the pressure CLAUDE.md warns about.
    if (left.rowCount === stats.skippedMismatch) ok(`${left.rowCount} of the ${PLAN_IN_USE.length} remain, and all of them are the skipped mismatches`);
    else bad(`${left.rowCount} remain but ${stats.skippedMismatch} were skipped`,
      left.rows.map((x) => `${x.id}:${x.normalized_name}`).join(', '));

    const orphanRows = await Q(`
      SELECT COUNT(*)::int n FROM study_molecules WHERE molecule_id IS NULL
         AND molecule_unresolved_reason IS NULL`);
    if (orphanRows.rows[0].n === 0) ok('no source row is unlinked without a reason');
    else bad(`${orphanRows.rows[0].n} study_molecules rows are unlinked and silent about why`);

    const dangling = await Q(`
      SELECT COUNT(*)::int n FROM molecule_aliases a
       WHERE NOT EXISTS (SELECT 1 FROM molecules m WHERE m.id = a.molecule_id)`);
    if (dangling.rows[0].n === 0) ok('no alias outlived its molecule');
    else bad(`${dangling.rows[0].n} aliases point at a molecule that no longer exists`);

    const badParents = await Q(`
      SELECT COUNT(*)::int n FROM molecules c
       WHERE c.parent_molecule_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM molecules p WHERE p.id = c.parent_molecule_id)`);
    if (badParents.rows[0].n === 0) ok('no molecule points at a parent that no longer exists');
    else bad(`${badParents.rows[0].n} molecules have a dangling parent`);

    const expected = before - stats.moleculesDeleted;
    if (after === expected) ok(`the count moved by exactly what was deleted: ${before} - ${stats.moleculesDeleted} = ${after}`);
    else bad(`count arithmetic does not close: ${before} - ${stats.moleculesDeleted} != ${after}`);
  } else {
    console.log('   DRY RUN. Nothing was written. Re-run with --execute to apply.\n');
  }

  console.log('');
  if (fail) {
    console.log(`✗ RETRACTION INCOMPLETE — ${fail} proof(s) did not hold.\n`);
    return fail;
  }
  console.log(EXECUTE
    ? `✓ RETRACTED — ${stats.moleculesDeleted} gone, their rows say why, nothing dangles.\n`
    : '✓ dry run complete, every id accounted for, nothing written.\n');
  return 0;
}

module.exports = { main, PLAN, UNAUTHORISED, REQUIREMENTS };

if (require.main === module) {
  main().then((f) => process.exit(f ? 1 : 0)).catch((e) => {
    console.error(`\n✗ retraction could not run: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
}
