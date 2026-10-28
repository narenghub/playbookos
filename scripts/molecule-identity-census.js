#!/usr/bin/env node
// ── E1 PREFLIGHT: WHAT IS THE MOLECULE IDENTITY DATA ACTUALLY LIKE? ──────────
//
//   railway ssh 'node scripts/molecule-identity-census.js'
//
// READ-ONLY. No INSERT, no UPDATE, no DELETE, no CREATE anywhere in this file. It runs before any
// part of the canonical-molecule migration is designed, because the migration's shape depends on
// numbers nobody has yet measured.
//
// Exit 0 = the census ran. Exit 1 = it could not (and says why). A census cannot "fail" on its
// numbers — a zero is a finding, not an error — so a zero anywhere exits 0 and says so in words.
//
// ── THE TWO QUESTIONS THIS EXISTS TO ANSWER ─────────────────────────────────
//
// E1 as specified says: InChIKey is the preferred structural identity, CAS is retained as an
// identifier rather than treated as globally unique, and unresolved molecules stay unresolved.
// Two things have to be measured before that can be built.
//
// 1. IS THERE ANY STRUCTURE DATA AT ALL? Section 1 prints the actual columns carrying molecule
//    identity across every table that has one. The belief being checked is that no InChIKey and no
//    SMILES exists anywhere — in which case `inchikey` ships as a NULLABLE column with no resolver
//    behind it, and structure resolution is a later phase with its own accuracy measurement. A
//    column that is 100% NULL is honest; an InChIKey written from a fuzzy name lookup is worse than
//    NULL, because it looks authoritative and would then be used to merge unrelated substances.
//
// 2. IS `canonicalMolecule()` SAFE TO USE AS IDENTITY? It is not obvious that it is, and section 4
//    is the number that decides. That function de-salts a name and then folds it to its synonym
//    group — `src/lib/molecules/synonyms.js` says so itself, and says plainly that stripping
//    `testosterone enanthate` to `testosterone` is "correct for FINDING a supplier and wrong for
//    ordering one". Search widening and identity are different jobs. If two rows in one canonical
//    group carry two DIFFERENT VALID CAS NUMBERS, then the registry says they are different
//    substances and the merge would quote the wrong one.
//
// ── WHY THE CAS CONFLICT COUNT IS THE HEADLINE ──────────────────────────────
//
// On 2026-10-09 the same table printed "SOLE holder worldwide" over a substance three companies
// hold, because `Leuprolide`, `Leuprolide Acetate` and `Leuprorelin` were three rows and the
// holders split between them. Merging fixed that. But the merge runs the other way too: collapse
// two genuinely different substances and a count becomes confidently wrong in the opposite
// direction, and scarcity is the number a buyer negotiates on. So the migration must REFUSE to
// auto-merge any group whose members disagree on a valid CAS number, and this census says how many
// of those there are before a line of migration is written.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { validCas } = require('../src/lib/catalogue/cas');
const { canonicalMolecule, moleculeBase, normalize } = require('../src/lib/molecules/synonyms');

const h = (s) => console.log(`\n── ${s}\n`);
const row = (label, value) => console.log(`   ${String(label).padEnd(52)} ${value}`);

/** Does this table exist on this database? Guards every read. */
async function tableExists(name) {
  const r = await query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [name]);
  return !!(r.rows[0] && r.rows[0].ok);
}

// The tables carrying a molecule identity that E1 might touch, with their real column names —
// they are NOT consistent (study_molecules.cas_number vs research_interests.cas vs
// supplier_products.cas), which is itself part of what E1 is fixing.
const IDENTITY_TABLES = [
  { table: 'study_molecules', nameCol: 'molecule_name', casCol: 'cas_number' },
  { table: 'research_interests', nameCol: 'value', casCol: 'cas', where: `kind = 'molecule'` },
  { table: 'supplier_products', nameCol: 'product_name', casCol: 'cas' },
  { table: 'skus', nameCol: 'name', casCol: 'cas_number' },
];

async function main() {
  await initDB();
  const commit = String(process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'unknown';
  console.log(`\n═══ molecule identity census · commit ${commit} · READ-ONLY ═══`);

  // ── 1. THE PREMISE, CHECKED RATHER THAN ASSUMED ───────────────────────────
  h('1. Columns carrying molecule identity, and whether any structure data exists');
  const cols = await query(`
    SELECT table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (column_name ILIKE '%inchi%' OR column_name ILIKE '%smiles%'
            OR column_name ILIKE '%cas%'  OR column_name ILIKE '%molecule%')
     ORDER BY table_name, column_name`);
  const structural = cols.rows.filter((c) => /inchi|smiles/i.test(c.column_name));
  row('columns matching inchi / smiles', structural.length);
  if (structural.length === 0) {
    console.log('\n   ✗ NO STRUCTURE DATA EXISTS ANYWHERE IN THIS DATABASE.');
    console.log('     InChIKey cannot be the operative identity in E1. It ships as a nullable');
    console.log('     column with no resolver behind it; name->structure resolution is its own');
    console.log('     phase, because a wrong InChIKey is worse than a missing one.\n');
  } else {
    structural.forEach((c) => row(`  ${c.table_name}.${c.column_name}`, c.data_type));
  }
  row('columns matching cas / molecule', cols.rows.length - structural.length);
  const byTable = {};
  cols.rows.forEach((c) => { (byTable[c.table_name] = byTable[c.table_name] || []).push(c.column_name); });
  console.log('');
  Object.keys(byTable).sort().forEach((t) => row(t, byTable[t].join(', ')));
  console.log(`\n   ${Object.keys(byTable).length} tables carry a molecule identity column.`);
  console.log('   E1 must choose a narrow blast radius rather than migrate all of them.');

  // ── 2. ROW COUNTS AND CAS QUALITY, PER TABLE ──────────────────────────────
  h('2. Per-table census: rows, distinct names, CAS coverage and CAS VALIDITY');
  const live = [];
  for (const t of IDENTITY_TABLES) {
    if (!(await tableExists(t.table))) { row(t.table, 'TABLE DOES NOT EXIST'); continue; }
    const colOk = await query(`
      SELECT COUNT(*)::int n FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [t.table, t.nameCol]);
    if (!colOk.rows[0].n) { row(t.table, `column ${t.nameCol} does not exist — skipped`); continue; }
    const w = t.where ? `WHERE ${t.where}` : '';
    const r = await query(`
      SELECT COUNT(*)::int total,
             COUNT(DISTINCT LOWER(TRIM(${t.nameCol})))::int distinct_names,
             COUNT(${t.casCol})::int with_cas
        FROM ${t.table} ${w}`);
    const d = r.rows[0];
    // CAS validity is computed in JS with the shipped checksum, not in SQL: the whole point is to
    // use the same validator the extractor uses, so this cannot drift from it.
    const casRows = await query(`
      SELECT ${t.casCol} AS cas FROM ${t.table}
       ${t.where ? `WHERE ${t.where} AND` : 'WHERE'} ${t.casCol} IS NOT NULL AND ${t.casCol} <> ''`);
    const valid = casRows.rows.filter((x) => validCas(x.cas)).length;
    const invalid = casRows.rows.length - valid;
    console.log(`   ${t.table}`);
    row('  rows', d.total);
    row('  distinct names (lowercased)', d.distinct_names);
    row('  rows with a CAS value', `${d.with_cas}  (${pct(d.with_cas, d.total)})`);
    row('  of those, CHECKSUM-VALID', `${valid}`);
    row('  of those, checksum-INVALID', invalid ? `${invalid}   ← not usable as an identifier` : '0');
    live.push({ ...t, total: d.total });
  }

  // ── 3. WHAT CANONICALISATION WOULD COLLAPSE ───────────────────────────────
  h('3. Collapse: distinct filed names -> distinct canonical substances');
  const smExists = await tableExists('study_molecules');
  if (!smExists) {
    console.log('   study_molecules does not exist — nothing to measure.');
  } else {
    const names = await query(`
      SELECT molecule_name, cas_number, COUNT(*)::int n
        FROM study_molecules
       GROUP BY molecule_name, cas_number`);
    const groups = new Map();           // canonical -> { names:Set, cas:Set, rows:int }
    const baseOnly = new Map();         // de-salt only, to separate the two effects
    for (const r of names.rows) {
      const canon = canonicalMolecule(r.molecule_name) || normalize(r.molecule_name);
      const g = groups.get(canon) || { names: new Set(), cas: new Set(), rows: 0 };
      g.names.add(normalize(r.molecule_name));
      if (r.cas_number && validCas(r.cas_number)) g.cas.add(String(r.cas_number).trim());
      g.rows += r.n;
      groups.set(canon, g);
      const b = moleculeBase(normalize(r.molecule_name));
      const bg = baseOnly.get(b) || new Set();
      bg.add(normalize(r.molecule_name));
      baseOnly.set(b, bg);
    }
    const distinctFiled = new Set(names.rows.map((r) => normalize(r.molecule_name))).size;
    row('distinct filed names', distinctFiled);
    row('distinct canonical substances', groups.size);
    row('names that would merge into another', distinctFiled - groups.size);
    const multi = [...groups.entries()].filter(([, g]) => g.names.size > 1);
    row('canonical groups with >1 filed name', multi.length);
    const saltMerges = [...baseOnly.values()].filter((s) => s.size > 1).length;
    row('groups merged by SALT-STRIPPING alone', saltMerges);

    // ── 4. THE NUMBER THAT DECIDES THE SCHEMA ──────────────────────────────
    h('4. CAS CONFLICTS INSIDE A CANONICAL GROUP  ← the decision number');
    console.log('   A group holding two different checksum-valid CAS numbers contains two');
    console.log('   substances the registry considers distinct. The migration must REFUSE to');
    console.log('   auto-merge these, not pick one.\n');
    const conflicts = [...groups.entries()].filter(([, g]) => g.cas.size > 1);
    row('canonical groups with CONFLICTING valid CAS', conflicts.length);
    row('rows inside those groups', conflicts.reduce((a, [, g]) => a + g.rows, 0));
    if (conflicts.length) {
      console.log('\n   every conflicting group, in full — these are the rows a human must rule on:');
      conflicts
        .sort((a, b) => b[1].cas.size - a[1].cas.size)
        .forEach(([canon, g]) => {
          console.log(`\n     canonical: ${canon}`);
          console.log(`       filed as : ${[...g.names].join(' | ')}`);
          console.log(`       CAS      : ${[...g.cas].join(' | ')}`);
        });
      console.log('');
    } else {
      console.log('\n   ZERO conflicts. That is a finding, not an absence of one: it means the');
      console.log('   CAS coverage above is too thin to contradict the name-based merge, NOT');
      console.log('   that the merge is proven safe. Read section 2 coverage before concluding.\n');
    }

    // ── 5. UNRESOLVABLE AND ORPHANED ──────────────────────────────────────
    h('5. What would stay UNRESOLVED, and what is already orphaned');
    const unresolvable = names.rows.filter((r) => {
      const n = normalize(r.molecule_name);
      return !n || n.length < 3;
    }).length;
    row('name rows too short/empty to resolve', unresolvable);
    const noCas = await query(`
      SELECT COUNT(*)::int n FROM study_molecules
       WHERE cas_number IS NULL OR cas_number = ''`);
    row('rows with no CAS at all', `${noCas.rows[0].n}  (${pct(noCas.rows[0].n, names.rows.reduce((a, r) => a + r.n, 0))})`);
    const orphans = await query(`
      SELECT COUNT(*)::int n FROM study_molecules sm
       WHERE NOT EXISTS (SELECT 1 FROM clinical_studies cs WHERE cs.id = sm.study_id)`);
    row('study_molecules with no parent study (orphans)', orphans.rows[0].n);
    const confidence = await query(`
      SELECT catalog_match_status, COUNT(*)::int n FROM study_molecules
       GROUP BY catalog_match_status ORDER BY n DESC`);
    console.log('');
    confidence.rows.forEach((r) => row(`  catalog_match_status = ${r.catalog_match_status}`, r.n));
  }

  h('verdict');
  console.log('   The census ran. Nothing was written.');
  console.log('   Section 1 decides whether InChIKey can be identity in E1 (expected: it cannot).');
  console.log('   Section 4 decides whether canonicalMolecule() may be used as the merge rule.');
  console.log('   Both answers are required before the migration is designed.\n');
}

function pct(n, d) { return d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a'; }

main().then(() => process.exit(0)).catch((e) => {
  console.error(`\n✗ census could not run: ${e && e.message ? e.message : e}\n`);
  process.exit(1);
});
