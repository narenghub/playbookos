#!/usr/bin/env node
// ── THE BEFORE PICTURE. READ-ONLY. ───────────────────────────────────────────
//
//   railway ssh 'node scripts/e1-snapshot.js'
//
// Exit 0 = the snapshot was taken. No INSERT, UPDATE, DELETE, CREATE, ALTER or TRUNCATE.
//
// ── WHY TAKE ONE AT ALL ─────────────────────────────────────────────────────
//
// Reconciliation afterwards compares actual against expected. Without a before-picture, "2428
// molecules exist" cannot be distinguished from "2428 molecules already existed", and a migration
// that did nothing would reconcile perfectly. The counts below are what make the after-picture
// mean something.
//
// It is deliberately NOT stored in the database. Writing the snapshot would make this script a
// write, and the whole point is that nothing is written until the migration is authorised on the
// evidence. Keep the output; scripts/e1-reconcile.js takes it as --before=<path> or recomputes.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { analyze } = require('../src/lib/molecules/preview');

const SOURCES = [
  { table: 'study_molecules', idCol: 'id', nameCol: 'molecule_name', casCol: 'cas_number', where: null },
  { table: 'research_interests', idCol: 'id', nameCol: 'value', casCol: 'cas', where: `kind = 'molecule'` },
  { table: 'supplier_products', idCol: 'id', nameCol: 'product_name', casCol: 'cas', where: null },
];

const r = (l, v) => console.log(`   ${String(l).padEnd(46)} ${v}`);
async function exists(t) {
  return !!(await query(`SELECT to_regclass($1) IS NOT NULL ok`, [t])).rows[0].ok;
}
async function count(sql, params) {
  try { return (await query(sql, params)).rows[0].n; } catch (_) { return 'n/a'; }
}

async function main() {
  await initDB();
  const commit = String(process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'unknown';
  const at = new Date().toISOString();
  console.log(`\n═══ E1 PREFLIGHT SNAPSHOT · commit ${commit} · ${at} · READ-ONLY ═══\n`);

  // ── 1. WHAT THE SPINE HOLDS NOW ────────────────────────────────────────
  console.log('── spine (before)\n');
  const haveMolecules = await exists('molecules');
  r('molecules table exists', haveMolecules);
  r('molecules', haveMolecules ? await count(`SELECT COUNT(*)::int n FROM molecules`) : 0);
  r('molecule_aliases', (await exists('molecule_aliases')) ? await count(`SELECT COUNT(*)::int n FROM molecule_aliases`) : 0);
  r('molecule_conflicts (quarantine rows)', (await exists('molecule_conflicts')) ? await count(`SELECT COUNT(*)::int n FROM molecule_conflicts`) : 0);
  // The sequence matters for restart safety: a failed run that consumed ids leaves gaps, and a
  // reconciliation that assumed contiguous ids would read those gaps as missing molecules.
  const seq = await count(`SELECT last_value::int n FROM molecules_id_seq`);
  r('molecules_id_seq last_value', seq);

  // ── 2. SOURCE ROWS AND EXISTING LINKAGE ────────────────────────────────
  console.log('\n── source rows and current linkage (before)\n');
  const rows = [];
  for (const s of SOURCES) {
    if (!(await exists(s.table))) { r(s.table, 'ABSENT'); continue; }
    const w = s.where ? `WHERE ${s.where}` : '';
    const got = await query(`SELECT ${s.idCol} AS rid, ${s.nameCol} AS nm, ${s.casCol} AS cas FROM ${s.table} ${w}`);
    got.rows.forEach((x) => rows.push({ table: s.table, rid: x.rid, name: x.nm, cas: x.cas }));
    const linked = await count(`SELECT COUNT(*)::int n FROM ${s.table} WHERE molecule_id IS NOT NULL`);
    const reasoned = await count(`SELECT COUNT(*)::int n FROM ${s.table} WHERE molecule_unresolved_reason IS NOT NULL`);
    r(`${s.table} rows`, got.rowCount);
    r(`  linked (molecule_id NOT NULL)`, linked);
    r(`  attempted and refused (reason set)`, reasoned);
  }

  // ── 3. WHAT THE MIGRATION SHOULD PRODUCE ───────────────────────────────
  //
  // Computed from the SAME analyze() the preview uses, so the expectation here and the
  // recommendation there cannot drift apart.
  console.log('\n── expected after the migration  [PREDICTION]\n');
  const a = analyze(rows);
  const S = a.summary;
  const created = new Set(a.executionSet.CREATE);
  // A source row links only if its identity is in CREATE. Rows whose identity is excluded stay
  // unlinked WITH a reason, which is the distinction the whole quarantine rests on.
  let linkable = 0;
  const { moleculeKey } = require('../src/lib/molecules/identity');
  for (const row of rows) {
    const k = moleculeKey(row.name);
    if (k && created.has(k)) linkable += 1;
  }

  r('expected CREATE (molecules)', S.safeToCreate);
  r('expected EXCLUDED', a.exclusionIntegrity.excluded);
  r('expected curated-synonym aliases', S.aliasFolded);
  r('expected source rows LINKED', linkable);
  r('expected source rows refused with a reason', rows.length - linkable);
  console.log('');
  r('expected canonical CAS populated', S.casPopulated);
  r('expected CAS withheld — contested', S.casContested);
  r('expected CAS withheld — invalid only', S.casPresentInvalidOnly);
  r('expected CAS absent at source', S.casMissing);
  r('expected InChIKey populated', 0);
  console.log('');
  r('expected quarantine: identity conflicts', S.quarantine);
  r('expected quarantine: corrupted names', S.corruptedName);
  r('expected quarantine: ambiguous form', S.ambiguousForm);
  r('expected quarantine: duplicate risk', S.duplicateRisk);
  r('expected quarantine: insufficient identity', S.insufficient);

  console.log('\n── the invariants this snapshot asserts before anything runs\n');
  const ok1 = S.safeToCreate + a.exclusionIntegrity.excluded === S.e1Groups;
  const ok2 = a.exclusionIntegrity.missingReason.length === 0;
  const ok3 = a.exclusionIntegrity.createdAndExcluded.length === 0;
  r('CREATE + EXCLUDED = PROPOSED', `${ok1 ? 'ok' : 'FAIL'}  ${S.safeToCreate} + ${a.exclusionIntegrity.excluded} = ${S.e1Groups}`);
  r('UNEXPLAINED_EXCLUSIONS = 0', ok2 ? 'ok' : `FAIL ${a.exclusionIntegrity.missingReason.length}`);
  r('CREATE n EXCLUDED = empty', ok3 ? 'ok' : `FAIL ${a.exclusionIntegrity.createdAndExcluded.length}`);

  console.log('\n   KEEP THIS OUTPUT. scripts/e1-reconcile.js compares the after-picture against');
  console.log('   these numbers. Without a before-picture, "2428 molecules exist" cannot be told');
  console.log('   apart from "2428 molecules already existed", and a migration that did nothing');
  console.log('   would reconcile perfectly.\n');

  if (!ok1 || !ok2 || !ok3) {
    console.error('✗ an invariant fails BEFORE the migration — do not run it.\n');
    process.exit(1);
  }
  console.log('✓ snapshot taken, invariants hold, nothing was written.\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`\n✗ snapshot failed: ${e && e.message ? e.message : e}\n`);
  process.exit(1);
});
