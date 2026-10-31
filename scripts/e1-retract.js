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

// Name and CAS columns are here too, because the drift verification has to ask the analyser whether
// a candidate is still excluded — and the analyser reads source rows, not molecules. The shapes match
// scripts/backfill-molecule-identity.js and scripts/e1-reconcile.js exactly; three copies of this
// list is two too many, and consolidating it is worth doing when something next touches all three.
const SOURCES = [
  { table: 'study_molecules', idCol: 'id', nameCol: 'molecule_name', casCol: 'cas_number', where: null },
  { table: 'research_interests', idCol: 'id', nameCol: 'value', casCol: 'cas', where: `kind = 'molecule'` },
  { table: 'supplier_products', idCol: 'id', nameCol: 'product_name', casCol: 'cas', where: null },
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

// ── GROUP C: DRIFT — created legitimately, excluded by later data (1) ──────
//
// levoleucovorin was created on 29 Oct holding ONE checksum-valid CAS and was correctly inside the
// authorised set, which is why it is not among the 72. A study row arriving overnight brought a
// second number (61246-44-4 vs 80433-71-2), and with no row naming the substance alone it is now the
// norketamine shape: nothing can link, so the identity is withheld.
//
// Its canonical CAS has already been withdrawn under Decision 1 by the backfill. What remains is a
// molecule the current rules say should not exist, which reconciliation reports as drift.
//
// THIS RETRACTION IS REVERSIBLE and that is the point. Both of its source rows stay in
// study_molecules with a reason. If somebody rules which number is levoleucovorin's and corrects the
// wrong row, the identity becomes creatable again and the next backfill recreates the molecule. So
// retracting now does not decide the chemistry — it declines to publish a substance whose evidence
// contradicts itself, which is what the whole quarantine is for.
//
// Identified by NAME, not by id, and deliberately: the 72 are literal ids because those ids are what
// was read and approved in a listing. levoleucovorin's id was never in front of anybody, and an id
// written from memory that turns out to be absent would send this script down its idempotent-re-run
// path — reporting success while the molecule it was pointed at sat untouched. normalized_name is
// uniquely indexed, so resolving by name is exact, and a name that resolves to nothing is reported
// rather than passed over.
const DRIFT = [
  ['levoleucovorin', 'cas_disagreement'],
  // 31 Oct, authorised after the 11:23 reconciliation. Both were legitimately created, later
  // received a contradictory CAS, and are now excluded under the current rules — canonical CAS
  // already withdrawn, source rows refused, nothing linked. Inert, but outside the authorised
  // partition.
  //
  // NOT a precedent for deleting any molecule whose evidence later turns contradictory. That is the
  // POST-CREATION IDENTITY DRIFT POLICY, a Gate 3 design item, and it has to be decided before
  // Gate 2 makes canonical identity a transaction dependency — because once inquiries,
  // inquiry_quotes and rfq_requests carry molecule_id, retraction stops being cheap and the policy
  // gets chosen by a foreign key instead of by a person.
  ['apatinib mesylate', 'cas_disagreement'],
  ['n-desmethyl enzalutamide', 'cas_disagreement'],
];

const PLAN = [
  ...DRIFT.map(([name, kind]) => ({ id: null, name, kind, group: 'drift' })),
  ...UNAUTHORISED.map(([id, name, kind]) => ({ id, name, kind, group: 'unauthorised' })),
  ...REQUIREMENTS.map(([id, name]) => ({
    id, name, kind: 'insufficient_identity', group: 'requirement',
  })),
];


// ── INDEPENDENT VERIFICATION BEFORE ANY DELETION ────────────────────────────
//
// Required by the 31 Oct authorisation: establish, per candidate, the exact name, the canonical CAS
// state, accepted source linkage, alias and parent/child references, EVERY other foreign key into
// molecules within E1 scope, that the analyser currently excludes it, and that the exclusion reason
// survives on the source evidence. If a candidate has acquired a consequential reference, STOP
// rather than force the deletion.
//
// The foreign keys are enumerated from information_schema, not from a list I wrote. A hand-kept list
// is exactly how a reference gets missed: it is correct until someone adds a table. This asks the
// database which tables point at molecules and counts rows in each.
const SAFE_REFERENCERS = new Set([
  'study_molecules', 'research_interests', 'supplier_products',  // source rows: unlinked, by design
  'molecule_aliases',                                            // deleted with the molecule
  'molecules',                                                   // parent_molecule_id: detached
]);

async function verifyRetractable(q, p, analysis) {
  const out = { name: p.name, ok: true, notes: [], blockers: [] };
  const m = (await q(
    `SELECT id, normalized_name, preferred_name, cas, cas_suppressed_reason, cas_source_values,
            substance_form, parent_molecule_id
       FROM molecules WHERE normalized_name = $1`, [p.name])).rows[0];
  if (!m) { out.notes.push('not present — nothing to retract'); out.absent = true; return out; }
  out.id = m.id;

  // 1. exact identity
  if (m.normalized_name === p.name) out.notes.push(`id ${m.id}, name matches exactly ("${m.preferred_name}")`);
  else { out.blockers.push(`name mismatch: holds "${m.normalized_name}"`); out.ok = false; }

  // 2. canonical CAS state — must already be withdrawn, or retraction would be destroying evidence
  if (m.cas === null) {
    out.notes.push(`canonical cas withdrawn (${m.cas_suppressed_reason || 'no reason recorded'})`);
    out.notes.push(`source values kept: ${m.cas_source_values || '(none)'}`);
  } else {
    out.blockers.push(`still carries a canonical CAS (${m.cas}) — withdraw it before retracting, `
      + 'so the contest is recorded rather than deleted with the row');
    out.ok = false;
  }

  // 3-6. every foreign key into molecules, asked of the database
  const fks = (await q(`
    SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'molecules'`)).rows;
  out.notes.push(`${fks.length} foreign key(s) reference molecules`);
  for (const fk of fks) {
    const n = (await q(
      `SELECT COUNT(*)::int n FROM ${fk.table_name} WHERE ${fk.column_name} = $1`, [m.id])).rows[0].n;
    if (!n) continue;
    const label = `${fk.table_name}.${fk.column_name} = ${n} row(s)`;
    if (SAFE_REFERENCERS.has(fk.table_name)) out.notes.push(label);
    else {
      out.blockers.push(`${label} — a referencing table the safe-retraction assumptions do not cover`);
      out.ok = false;
    }
  }
  const al = (await q(`SELECT COUNT(*)::int n FROM molecule_aliases WHERE molecule_id = $1`, [m.id])).rows[0].n;
  const kids = (await q(`SELECT COUNT(*)::int n FROM molecules WHERE parent_molecule_id = $1`, [m.id])).rows[0].n;
  out.notes.push(`${al} alias(es), ${kids} child molecule(s)`);

  // 7. the analyser must currently EXCLUDE it. Without this the retraction is deleting a molecule
  //    the rules would recreate on the next backfill — a loop, not a correction.
  if (analysis) {
    const reason = analysis.exclusionReasons.get(p.name);
    if (reason) out.notes.push(`analyser excludes it: ${reason}`);
    else if (analysis.createSet.has(p.name)) {
      out.blockers.push('the analyser currently AUTHORISES this identity — retracting it would be '
        + 'undone by the next backfill');
      out.ok = false;
    } else {
      out.blockers.push('the analyser neither authorises nor explains this identity — unexplained, '
        + 'which is the 29 Oct divergence signature, not drift');
      out.ok = false;
    }
  } else out.notes.push('analyser state NOT CHECKED (no analysis supplied)');

  // 8. the exclusion reason must survive on the source evidence
  let reasoned = 0; let linked = 0;
  for (const src of SOURCES) {
    const ex = await q(`SELECT to_regclass($1) IS NOT NULL ok`, [src.table]);
    if (!ex.rows[0].ok) continue;
    linked += (await q(
      `SELECT COUNT(*)::int n FROM ${src.table} WHERE molecule_id = $1`, [m.id])).rows[0].n;
  }
  const conf = (await q(
    `SELECT COUNT(*)::int n FROM molecule_conflicts WHERE identity_name = $1`, [p.name])).rows[0].n;
  reasoned = conf;
  out.notes.push(`${linked} accepted source row(s) linked, ${conf} quarantine record(s) on file`);
  if (!conf) {
    out.blockers.push('no quarantine record names this identity — the reason would not survive the '
      + 'retraction, so the evidence for recreating it later would be gone');
    out.ok = false;
  }
  return out;
}

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
      + `(${UNAUTHORISED.length} unauthorised + ${REQUIREMENTS.length} requirement sentences`
      + `${DRIFT.length ? ` + ${DRIFT.length} drift` : ''})\n`
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

  // ── VERIFY THE DRIFT CANDIDATES BEFORE TOUCHING ANYTHING ────────────────
  //
  // Runs in BOTH modes and gates the deletion. A candidate that fails verification is skipped, not
  // forced: "STOP rather than force deletion" is the authorisation's wording and it is the right
  // instinct — a molecule that has acquired a reference since this list was written is exactly the
  // case where a confident script does damage.
  // Keyed on the entry's own group, not on membership of the DRIFT constant. An injected test plan
  // can then exercise this path, which matters: the verification is the safety gate, and a gate no
  // test can reach is a gate nobody has seen work.
  const driftPlan = PLAN_IN_USE.filter((p) => p.group === 'drift');
  const blocked = new Set();
  if (driftPlan.length) {
    console.log('── independent verification of the drift candidates\n');
    // The analyser's current view, computed from live source rows — the same analyze() the preview
    // and the backfill use, so "is it excluded" is answered by the authority rather than by me.
    let analysis = null;
    try {
      const { analyze } = require('../src/lib/molecules/preview');
      const rows = [];
      for (const src of SOURCES) {
        const ex = await Q(`SELECT to_regclass($1) IS NOT NULL ok`, [src.table]);
        if (!ex.rows[0].ok) continue;
        const w = src.where ? `WHERE ${src.where}` : '';
        const got = await Q(`SELECT ${src.nameCol} AS nm, ${src.casCol} AS cas FROM ${src.table} ${w}`);
        got.rows.forEach((r) => rows.push({ table: src.table, rid: 0, name: r.nm, cas: r.cas }));
      }
      const a = analyze(rows);
      analysis = { exclusionReasons: a.exclusionReasons, createSet: new Set(a.executionSet.CREATE) };
      console.log(`   analyser: ${a.e1.groups.size} identities, ${analysis.createSet.size} authorised\n`);
    } catch (e) {
      console.log(`   analyser state could not be computed: ${e.message}\n`);
    }

    for (const p of driftPlan) {
      const v = await verifyRetractable(Q, p, analysis);
      console.log(`   ${v.name}`);
      v.notes.forEach((n) => console.log(`       · ${n}`));
      v.blockers.forEach((b) => console.log(`       ✗ ${b}`));
      if (v.absent) { console.log('       → nothing to do\n'); continue; }
      if (v.ok) { console.log('       → verified retractable\n'); }
      else { blocked.add(p.name); console.log('       → BLOCKED, will not be deleted\n'); }
    }
    if (blocked.size) {
      bad(`${blocked.size} drift candidate(s) failed verification and were NOT deleted`,
        [...blocked].join(', '));
    } else ok(`all ${driftPlan.length} drift candidate(s) verified retractable`);
  }

  const before = (await Q(`SELECT COUNT(*)::int n FROM molecules`)).rows[0].n;

  const stats = {
    verified: 0, skippedMissing: 0, skippedMismatch: 0,
    unlinked: 0, aliasesDeleted: 0, childrenDetached: 0, moleculesDeleted: 0, writes: 0,
  };
  const skipped = [];
  // table -> the row ids this run unlinked. The reason-is-set proof is scoped to these.
  const touched = new Map(SOURCES.map((s) => [s.table, []]));

  for (const p of PLAN_IN_USE) {
    // An entry with no id is resolved by its uniquely-indexed normalized_name. Everything after this
    // point is identical, including the name re-check, which for these is trivially true — the point
    // of resolving by name is that a wrong id cannot quietly become "already gone".
    if (blocked.has(p.name)) { stats.skippedMismatch += 1; skipped.push(`${p.name} failed verification`); continue; }
    if (p.id === null) {
      const byName = await Q(`SELECT id FROM molecules WHERE normalized_name = $1`, [p.name]);
      if (!byName.rowCount) {
        stats.skippedMissing += 1;
        console.log(`   drift  "${p.name}" is not present — nothing to retract`);
        continue;
      }
      p.id = byName.rows[0].id;
      console.log(`   drift  "${p.name}" resolved to id ${p.id}`);
    }
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
        // RETURNING, so the proof afterwards can name the rows this run touched instead of
        // asserting something about the whole table.
        const u = await q(
          `UPDATE ${s.table} SET molecule_id = NULL, molecule_unresolved_reason = $1
            WHERE molecule_id = $2 RETURNING ${s.idCol} AS rid`,
          [reasonFor(p).slice(0, 500), p.id]);
        u.rows.forEach((x) => touched.get(s.table).push(x.rid));
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

    // ── THE ROWS THIS RUN UNLINKED, AND ONLY THOSE ────────────────────────
    //
    // This asked the whole table whether any row was unlinked without a reason, and at 13:50 it
    // reported 51 and failed the run. None of the 51 were this script's doing: study_molecules grew
    // overnight — the agents write into it — and new rows are unlinked and silent until a backfill
    // reaches them, which is the correct state for them to be in.
    //
    // CLAUDE.md names this exactly: "Never assert a table is empty. Assert that MY fixtures are
    // gone." A global absolute in a cleanup script becomes false the moment the product is used,
    // and the obvious fix to a failing assertion like that is to widen the destructive statement
    // until it passes. A test that pressures the next person toward a bigger DELETE is worse than
    // no test. So the question is now about the rows this run unlinked, by id.
    let silent = 0;
    const silentExamples = [];
    for (const [table, ids] of touched) {
      if (!ids.length) continue;
      const src = SOURCES.find((x) => x.table === table);
      const r0 = await Q(
        `SELECT ${src.idCol} AS rid FROM ${table}
          WHERE ${src.idCol} = ANY($1) AND molecule_unresolved_reason IS NULL`, [ids]);
      silent += r0.rowCount;
      r0.rows.slice(0, 4).forEach((x) => silentExamples.push(`${table}#${x.rid}`));
    }
    const totalTouched = [...touched.values()].reduce((a, b) => a + b.length, 0);
    if (silent === 0) ok(`all ${totalTouched} row(s) this run unlinked carry a reason`);
    else bad(`${silent} of ${totalTouched} rows this run unlinked are silent about why`, silentExamples.join(', '));

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

module.exports = { main, PLAN, UNAUTHORISED, REQUIREMENTS, DRIFT };

if (require.main === module) {
  main().then((f) => process.exit(f ? 1 : 0)).catch((e) => {
    console.error(`\n✗ retraction could not run: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
}
