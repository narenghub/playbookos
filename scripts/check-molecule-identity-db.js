#!/usr/bin/env node
// ── MOLECULE IDENTITY INVARIANTS, ARBITRATED BY POSTGRES ─────────────────────
//
//   scripts/check-molecule-identity-db.js   → exit 0 = the database, not the application, decides
//
// ── WHY A UNIT TEST CANNOT DO THIS ──────────────────────────────────────────
//
// identity.test.js proves the naming rules against strings, and it proves them well. What it
// cannot prove is any of the four things that actually keep two substances apart once rows exist:
//
//   · that an alias and a molecule's own identity cannot be the same name, FROM EITHER
//     INSERTION ORDER — the guard is two triggers, and a test that inserts in one order only
//     passes with half of it missing;
//   · that the real backfill, run against a real server, REFUSES a CAS disagreement instead of
//     picking the commoner value;
//   · that running it twice writes nothing the second time, which is the whole meaning of
//     "idempotent" and is not visible from reading the code;
//   · that `inchikey` is still entirely NULL, so the day a fuzzy resolver starts writing it a
//     check fails loudly rather than the column filling up quietly.
//
// So this seeds the adversarial case — the three leuprolide strings that printed "SOLE holder
// worldwide" on 9 Oct — and drives the SHIPPED migration and the SHIPPED backfill over it.
//
// ── INDEPENDENCE ────────────────────────────────────────────────────────────
//
// Each trigger is also exercised with itself DISABLED, and the violation must then succeed. The
// first draft of the run-ledger checks passed with either of two unique indexes weakened, because
// each caught every reachable case the other did — so neither was proven necessary for any
// assertion. A guard that is never shown to be load-bearing has not been verified.
//
// Needs a server: set MOLID_PG_URL, or let it start a throwaway cluster if initdb is on PATH.
// With neither it SKIPS, so a machine without Postgres can still run preflight.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { DDL_TABLES, DDL_TRIGGERS, applyTargetColumns, applyConflictKinds } = require('./migrate-molecules');
const backfill = require('./backfill-molecule-identity');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 400)}`); };

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { const p = path.join(d, 'initdb'); if (fs.existsSync(p)) return d; }
  return null;
}
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/molid-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55991' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55991 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55991`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) { /* best effort */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.MOLID_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set MOLID_PG_URL or install initdb)');
  console.log('SKIP  molecule identity invariants not executed — this check needs a server');
  process.exit(0);
}

// ── THE SOURCE TABLE SHAPES, as the three operational tables really are ─────
// Only the columns the backfill reads. Fuller shapes would not make the assertions stronger and
// would drift from db.js.
const FIXTURE_TABLES = `
  CREATE TABLE IF NOT EXISTS study_molecules (
    id BIGSERIAL PRIMARY KEY, study_id TEXT, molecule_name TEXT NOT NULL, cas_number TEXT);
  CREATE TABLE IF NOT EXISTS research_interests (
    id BIGSERIAL PRIMARY KEY, lab_id BIGINT, kind TEXT NOT NULL, value TEXT NOT NULL,
    normalized TEXT, cas TEXT);
  CREATE TABLE IF NOT EXISTS supplier_products (
    id BIGSERIAL PRIMARY KEY, product_name TEXT, cas TEXT);
`;

(async () => {
  const { Pool } = require('pg');
  const A = new Pool({ connectionString: url, ssl: false });
  const q = (t, p) => A.query(t, p);
  // Silence the backfill's own report; this script's verdict is its exit code, and 200 lines of
  // another script's stdout in the middle of it is how a verdict gets misread.
  const realLog = console.log;
  const quiet = (fn) => async (...a) => { console.log = () => {}; try { return await fn(...a); } finally { console.log = realLog; } };

  try {
    await q(FIXTURE_TABLES);
    await q(DDL_TABLES);
    await q(DDL_TRIGGERS);
    await applyConflictKinds(q);
    await applyTargetColumns(q);
    ok('the shipped DDL applies to an empty database');

    // ── 1. THE ADVERSARIAL FIXTURE ────────────────────────────────────────
    //
    // The 9 Oct case, with the real registry numbers. If identity collapses these to one substance
    // the holder count inflates and the platform prints false scarcity; if it splits the two
    // naming conventions the count deflates and we tell a customer we have no supplier.
    await q(`INSERT INTO study_molecules (study_id, molecule_name, cas_number) VALUES
      ('NCT-A', 'Leuprolide',          '53714-56-0'),
      ('NCT-B', 'Leuprorelin',         '53714-56-0'),
      ('NCT-C', 'Leuprolide Acetate',  '74381-53-6'),
      ('NCT-D', 'Testosterone',        '58-22-0'),
      ('NCT-E', 'Testosterone Enanthate', '315-37-7'),
      ('NCT-F', 'Potassium Chloride',  '7447-40-7'),
      ('NCT-G', 'Aspirin USP',         '50-78-2'),
      ('NCT-H', 'Aspirin',             '50-78-2')`);
    // The refusal case: one name, two valid CAS numbers. Nothing may resolve this by voting.
    await q(`INSERT INTO study_molecules (study_id, molecule_name, cas_number) VALUES
      ('NCT-X', 'Ambiguoustatin', '50-78-2'),
      ('NCT-Y', 'Ambiguoustatin', '58-22-0'),
      ('NCT-Z', 'Ambiguoustatin', '58-22-0')`);
    // ── THE SAME CONTEST, ONE ROW SHORT OF HOPELESS ───────────────────────
    //
    // Every Ambiguoustatin row names a registry number, so there is no row left that named only the
    // substance — nothing could link, and the identity is withheld. Scopedstatin is the shape that
    // cost eleven real compounds on 29 Oct: two rows disagree about the number and a THIRD names the
    // substance alone. That row committed to nothing it can be wrong about, so the substance exists
    // with cas NULL and the quarantine falls on the two rows that named a disputed number.
    //
    // Both fixtures are needed because they now have different outcomes, and a single fixture of
    // either shape would assert half the rule while reading like all of it. The CAS pair is
    // asciminib's real one, used nowhere else here so it raises no cross-identity contest.
    await q(`INSERT INTO study_molecules (study_id, molecule_name, cas_number) VALUES
      ('NCT-P', 'Scopedstatin', '1492952-26-7'),
      ('NCT-Q', 'Scopedstatin', '1492952-76-7'),
      ('NCT-R', 'Scopedstatin', NULL)`);
    // ── THE CONTESTED-CAS CASE, WITH THE TWO HALVES IN DIFFERENT TABLES ────
    // Deliberately split across study_molecules and supplier_products: a per-table check would
    // not see that two substances claim one registry number, and that is the case Decision 1 is
    // about. 606143-89-9 is selumetinib's; one of these two is wrong and the data does not say
    // which, so neither may carry it as canonical identity.
    await q(`INSERT INTO study_molecules (study_id, molecule_name, cas_number) VALUES
      ('NCT-S1', 'Selumetinib', '606143-89-9')`);
    await q(`INSERT INTO research_interests (lab_id, kind, value, cas) VALUES
      (1, 'molecule', 'Leuprorelin Acetate', '74381-53-6'),
      (2, 'molecule', 'Paracetamol', '103-90-2'),
      (3, 'target',   'KRAS G12C', NULL)`);
    await q(`INSERT INTO supplier_products (product_name, cas) VALUES
      ('Binimetinib', '606143-89-9')`);
    await q(`INSERT INTO supplier_products (product_name, cas) VALUES
      ('Metformin Hydrochloride', '1115-70-4'), ('Acetaminophen', '103-90-2')`);

    // A REAL transaction helper, so the path exercised here is the transactional one the migration
  // uses — not a second code path that happens to produce the same rows.
  const tx = async (fn) => {
    const client = await A.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* best effort */ }
      throw e;
    } finally { client.release(); }
  };
  const res = await quiet(backfill.main)({ query: q, withTransaction: tx, execute: true });

    // ── 2. WHAT MUST NOT HAVE MERGED ──────────────────────────────────────
    const mol = async (name) => (await q(`SELECT * FROM molecules WHERE normalized_name = $1`, [name])).rows[0];

    const lb = await mol('leuprolide');
    const la = await mol('leuprolide acetate');
    if (lb && la && lb.id !== la.id) ok('leuprolide and leuprolide acetate are separate substances');
    else bad('the base and its acetate collapsed into one molecule — this is the quotation error');

    if (la && la.cas === '74381-53-6' && lb && lb.cas === '53714-56-0') {
      ok('each carries its own registry number (53714-56-0 vs 74381-53-6)');
    } else bad('CAS numbers were not kept with their own substance', JSON.stringify({ base: lb && lb.cas, salt: la && la.cas }));

    const te = await mol('testosterone enanthate');
    const tb = await mol('testosterone');
    if (te && tb && te.id !== tb.id && te.substance_form === 'ester') {
      ok('testosterone enanthate is its own molecule, classified as an ester');
    } else bad('testosterone enanthate did not survive as a distinct ester', JSON.stringify(te));

    if (te && tb && te.parent_molecule_id === tb.id) {
      ok('the ester has a parent edge to the base that WAS observed in the data');
    } else bad('the parent edge to an observed base was not linked', JSON.stringify({ te: te && te.parent_molecule_id, tb: tb && tb.id }));

    // The honest-omission case: metformin hydrochloride is present, plain metformin is not.
    const mh = await mol('metformin hydrochloride');
    const mb = await mol('metformin');
    if (mh && !mb && mh.parent_molecule_id === null && mh.derived_base_name === 'metformin') {
      ok('an UNOBSERVED base was not invented — parent is NULL and derived_base_name holds the answer');
    } else bad('a base molecule was created that the data never contained', JSON.stringify({ mh: mh && mh.parent_molecule_id, mb: !!mb }));

    // ── 3. WHAT MUST HAVE MERGED ──────────────────────────────────────────
    const lr = await q(`SELECT molecule_id FROM molecule_aliases WHERE alias = 'leuprorelin'`);
    if (lr.rowCount && lb && lr.rows[0].molecule_id === lb.id) {
      ok('leuprorelin is an ALIAS of leuprolide, not a second substance');
    } else bad('the INN/USAN pair did not merge — this is the "we have no supplier" answer');

    const asp = await q(`SELECT COUNT(*)::int n FROM molecules WHERE normalized_name LIKE 'aspirin%'`);
    if (asp.rows[0].n === 1) ok('"Aspirin USP" and "Aspirin" are one substance, not two');
    else bad(`a pharmacopoeial grade created a second substance (${asp.rows[0].n} aspirin rows)`);

    const kcl = await mol('potassium chloride');
    if (kcl && kcl.substance_form === 'base' && kcl.parent_molecule_id === null) {
      ok('potassium chloride stayed whole — not filed as a salt of potassium');
    } else bad('a mineral was stripped to its counter-ion', JSON.stringify(kcl));

    // Cross-table: the supplier row and the lab row are the same substance as each other.
    const acet = await q(`
      SELECT m.id FROM molecules m WHERE m.normalized_name = 'acetaminophen'
      UNION SELECT a.molecule_id FROM molecule_aliases a WHERE a.alias = 'acetaminophen'`);
    const para = await q(`
      SELECT m.id FROM molecules m WHERE m.normalized_name = 'paracetamol'
      UNION SELECT a.molecule_id FROM molecule_aliases a WHERE a.alias = 'paracetamol'`);
    if (acet.rowCount && para.rowCount && acet.rows[0].id === para.rows[0].id) {
      ok('paracetamol (a lab interest) and acetaminophen (a supplier product) resolve to one substance');
    } else bad('the same substance under two conventions did not unify across tables');

    // ── 4. THE REFUSAL, SCOPED TO THE ROWS ────────────────────────────────
    //
    // This assertion used to read "the molecule must NOT exist". That rule cost eleven real
    // compounds on 29 Oct — asciminib, elacestrant, erlotinib, nusinersen, plerixafor, resmetirom
    // and others were forbidden because two study rows disagreed about a registry number, while
    // every one of their supplier rows carried no CAS at all.
    //
    // Decision 1 is a rule about the ATTRIBUTE, so it now applies to the attribute: the substance
    // exists, its canonical cas is NULL, the contest is recorded, and the quarantine lands on the
    // rows that actually name a disputed number — those are the rows that might have meant a salt
    // rather than the base. Nothing is decided by majority; what changed is WHAT gets withheld.
    // Shape 1 — nothing left to link, so the identity itself is withheld.
    const amb = await mol('ambiguoustatin');
    const conf = await q(`SELECT * FROM molecule_conflicts WHERE kind = 'cas_disagreement'`);
    if (!amb && conf.rowCount) {
      ok('every row naming a different CAS: the identity is withheld, not resolved by majority');
    } else {
      bad('a hopeless CAS disagreement was decided rather than refused',
        JSON.stringify({ created: !!amb, conflicts: conf.rowCount }));
    }

    // Shape 2 — one row named the substance alone, so the substance exists without the number.
    const sc = await mol('scopedstatin');
    const scConf = await q(
      `SELECT * FROM molecule_conflicts WHERE kind = 'cas_contested_within_identity'`);
    if (sc && sc.cas === null && scConf.rowCount) {
      ok('one clean row present: the substance exists, its canonical cas does not');
    } else {
      bad('a scopeable within-identity contest was not handled as Decision 1 requires',
        JSON.stringify({ created: !!sc, cas: sc && sc.cas, conflicts: scConf.rowCount }));
    }
    if (sc && /^cas_contested_within_identity:/.test(String(sc.cas_suppressed_reason))
      && String(sc.cas_source_values).split(',').length === 2) {
      ok('  …and both disputed numbers are preserved on the row, with the reason it holds neither');
    } else {
      bad('the contest was not recorded on the molecule itself',
        JSON.stringify(sc && { r: sc.cas_suppressed_reason, v: sc.cas_source_values }));
    }
    // The point of scoping: the clean row links, the two that named a number do not.
    const scoped = await q(`
      SELECT
        COUNT(*) FILTER (WHERE cas_number IS NULL AND molecule_id IS NOT NULL)::int AS linked,
        COUNT(*) FILTER (WHERE cas_number IS NOT NULL AND molecule_id IS NULL
                           AND molecule_unresolved_reason IS NOT NULL)::int AS held
      FROM study_molecules WHERE molecule_name = 'Scopedstatin'`);
    if (scoped.rows[0].linked === 1 && scoped.rows[0].held === 2) {
      ok('  …and the quarantine is scoped to rows: 1 linked, 2 held with a reason');
    } else bad('the row-level scoping did not happen', JSON.stringify(scoped.rows[0]));

    const unres = await q(`
      SELECT COUNT(*)::int n FROM study_molecules
       WHERE molecule_name = 'Ambiguoustatin' AND molecule_id IS NULL
         AND molecule_unresolved_reason IS NOT NULL`);
    if (unres.rows[0].n === 3) {
      ok('all three conflicting rows say WHY they are unlinked, not merely that they are');
    } else bad(`${unres.rows[0].n} of 3 conflicting rows carry an unresolved reason`);

    // ── 4b. DECISION 1: THE CONTESTED CAS IS NOT WRITTEN AS CANONICAL ─────
    //
    // The invariant in one line: a missing canonical CAS is preferable to a registry number known
    // to be contested across distinct proposed substances. Both NAMES proceed — they are two real
    // and different MEK inhibitors — and the disputed ATTRIBUTE is withheld from both.
    const sel = await mol('selumetinib');
    const bini = await mol('binimetinib');
    if (sel && bini && sel.id !== bini.id) ok('selumetinib and binimetinib are both created, as distinct molecules');
    else bad('the contested pair did not produce two distinct molecules', JSON.stringify({ sel: !!sel, bini: !!bini }));

    const bothNull = sel && bini && sel.cas === null && bini.cas === null;
    if (bothNull) ok('NEITHER carries the disputed 606143-89-9 as canonical cas');
    else bad('a contested CAS was written as canonical identity', JSON.stringify({ sel: sel && sel.cas, bini: bini && bini.cas }));

    const anyoneClaims = await q(
      `SELECT normalized_name FROM molecules WHERE cas = '606143-89-9'`);
    if (anyoneClaims.rowCount === 0) ok('no molecule anywhere claims the contested number');
    else bad('a molecule claims the contested CAS', JSON.stringify(anyoneClaims.rows));

    // Withheld is not the same as discarded: the source values must still be answerable.
    if (sel && /^cas_contested:/.test(sel.cas_suppressed_reason || '')
        && (sel.cas_source_values || '').includes('606143-89-9')) {
      ok('the suppression reason and the source value are both preserved on the row');
    } else bad('contested evidence was discarded rather than preserved', JSON.stringify({ r: sel && sel.cas_suppressed_reason, v: sel && sel.cas_source_values }));

    const contestRow = await q(`SELECT * FROM molecule_conflicts WHERE kind = 'cas_contested'`);
    if (contestRow.rowCount) ok('the contest is recorded in molecule_conflicts as its own kind');
    else bad('no cas_contested conflict row was written');

    // And the three evidence states stay apart rather than collapsing into one empty column.
    const states = await q(`
      SELECT COUNT(*) FILTER (WHERE cas IS NOT NULL)                                      populated,
             COUNT(*) FILTER (WHERE cas IS NULL AND cas_suppressed_reason LIKE 'cas_contested%') contested,
             COUNT(*) FILTER (WHERE cas IS NULL AND cas_suppressed_reason = 'cas_missing')       missing,
             COUNT(*) FILTER (WHERE cas IS NULL AND cas_suppressed_reason = 'cas_present_invalid') invalid
        FROM molecules`);
    const st = states.rows[0];
    if (Number(st.contested) >= 2 && Number(st.populated) > 0) {
      ok(`CAS evidence states are distinguishable (populated ${st.populated}, contested ${st.contested}, missing ${st.missing}, invalid ${st.invalid})`);
    } else bad('the CAS evidence states are not distinguishable', JSON.stringify(st));

    // ── 5. IDEMPOTENCE, MEASURED ──────────────────────────────────────────
    const second = await quiet(backfill.main)({ query: q, withTransaction: tx, execute: true });
    if (second.writes === 0) ok('a second pass writes NOTHING — idempotent, measured rather than intended');
    else bad(`the second pass issued ${second.writes} write statement(s)`, JSON.stringify(second));

    const dupMol = await q(`
      SELECT normalized_name, COUNT(*)::int n FROM molecules GROUP BY normalized_name HAVING COUNT(*) > 1`);
    if (!dupMol.rowCount) ok('no duplicate substance was created by re-running');
    else bad('re-running duplicated a substance', JSON.stringify(dupMol.rows));

    // The one a DELETE could not clean up afterwards. molecule_conflicts forbids DELETE, so a
    // backfill that re-records the same refusal every run leaves a table nobody can tidy — which
    // is what the first version of this script did, caught here.
    const dupConf = await q(`
      SELECT conflict_key, COUNT(*)::int n FROM molecule_conflicts
       WHERE resolved_at IS NULL GROUP BY conflict_key HAVING COUNT(*) > 1`);
    if (!dupConf.rowCount) ok('re-running did not duplicate a quarantine row on an append-only table');
    else bad('the same refusal was recorded twice and cannot be deleted', JSON.stringify(dupConf.rows));

    // ── 6. InChIKey MUST STILL BE EMPTY ───────────────────────────────────
    const ik = await q(`SELECT COUNT(*)::int n FROM molecules WHERE inchikey IS NOT NULL`);
    if (ik.rows[0].n === 0) ok('inchikey is entirely NULL — no structure was manufactured from a name');
    else bad(`${ik.rows[0].n} molecule(s) carry an InChIKey; E1 has no resolver and must not invent one`);

    // ── 7. THE GUARDS, EACH SHOWN TO BE LOAD-BEARING ──────────────────────
    //
    // Refuse first, then disable the trigger and show the same statement SUCCEEDS. Without the
    // second half, a passing refusal might be coming from a NOT NULL, a CHECK, or nothing at all.

    // 7a. a base cannot have a parent
    try {
      await q(`INSERT INTO molecules (preferred_name, normalized_name, substance_form, parent_molecule_id, source, derivation_method)
               VALUES ('X','guard-base-x','base',$1,'test','test')`, [lb.id]);
      bad('a base substance was allowed a parent');
    } catch (e) {
      if (/cannot have a parent/.test(e.message)) ok('a base substance is refused a parent edge');
      else bad('the refusal came from somewhere unexpected', e.message);
    }
    await q(`ALTER TABLE molecules DISABLE TRIGGER trg_molecules_form_parent`);
    try {
      await q(`INSERT INTO molecules (preferred_name, normalized_name, substance_form, parent_molecule_id, source, derivation_method)
               VALUES ('X','guard-base-x','base',$1,'test','test')`, [lb.id]);
      ok('  …and it is that trigger doing it: with the trigger off, the same insert succeeds');
      await q(`DELETE FROM molecules WHERE normalized_name = 'guard-base-x'`);
    } catch (e) { bad('the insert still failed with the trigger disabled — the guard is something else', e.message); }
    await q(`ALTER TABLE molecules ENABLE TRIGGER trg_molecules_form_parent`);

    // 7b. self-parent and cycles
    try {
      await q(`UPDATE molecules SET parent_molecule_id = id WHERE id = $1`, [la.id]);
      bad('a molecule became its own parent');
    } catch (e) {
      if (/own parent/.test(e.message)) ok('a molecule cannot be its own parent');
      else bad('unexpected refusal', e.message);
    }
    try {
      // base -> its own child would close a loop
      await q(`UPDATE molecules SET substance_form='salt', parent_molecule_id = $1 WHERE id = $2`, [te.id, tb.id]);
      bad('a parent cycle was allowed');
    } catch (e) {
      if (/cycle/.test(e.message)) ok('a parent cycle is refused by walking the chain');
      else bad('unexpected refusal on the cycle case', e.message);
    }

    // 7c. a name cannot be both an identity and another molecule's alias — BOTH ORDERS
    try {
      await q(`INSERT INTO molecule_aliases (molecule_id, alias, source) VALUES ($1,'leuprolide','test')`, [la.id]);
      bad('a name that is one molecule\'s identity was aliased to another');
    } catch (e) {
      if (/already the identity/.test(e.message)) ok('alias -> existing identity is refused (alias inserted second)');
      else bad('unexpected refusal', e.message);
    }
    try {
      await q(`INSERT INTO molecules (preferred_name, normalized_name, source, derivation_method)
               VALUES ('Leuprorelin','leuprorelin','test','test')`);
      bad('a name that is already an alias was created as its own substance');
    } catch (e) {
      if (/already an alias/.test(e.message)) ok('identity -> existing alias is refused (molecule inserted second)');
      else bad('unexpected refusal', e.message);
    }
    // Independence: the second direction needs its OWN trigger. With only the alias-side guard,
    // inserting the molecule afterwards would succeed and the database would hold both.
    await q(`ALTER TABLE molecules DISABLE TRIGGER trg_molecules_name_vs_alias`);
    try {
      await q(`INSERT INTO molecules (preferred_name, normalized_name, source, derivation_method)
               VALUES ('Leuprorelin','leuprorelin','test','test')`);
      ok('  …and that direction is a SEPARATE trigger: with it off, the collision lands');
      await q(`DELETE FROM molecules WHERE normalized_name = 'leuprorelin'`);
    } catch (e) { bad('still refused with the name-vs-alias trigger off', e.message); }
    await q(`ALTER TABLE molecules ENABLE TRIGGER trg_molecules_name_vs_alias`);

    // 7d. one name resolves to one substance
    try {
      await q(`INSERT INTO molecule_aliases (molecule_id, alias, source) VALUES ($1,'leuprorelin','test')`, [la.id]);
      bad('the same alias was attached to a second molecule');
    } catch (e) {
      if (/duplicate key|unique/i.test(e.message)) ok('an alias cannot point at two substances');
      else bad('unexpected refusal', e.message);
    }

    // 7e. conflicts are append-only
    try {
      await q(`UPDATE molecule_conflicts SET detail = 'rewritten' WHERE id = $1`, [conf.rows[0].id]);
      bad('a detected conflict was rewritten');
    } catch (e) {
      if (/append-only/.test(e.message)) ok('molecule_conflicts refuses an UPDATE to what was detected');
      else bad('unexpected refusal', e.message);
    }
    try {
      await q(`DELETE FROM molecule_conflicts WHERE id = $1`, [conf.rows[0].id]);
      bad('a detected conflict was deleted');
    } catch (e) {
      if (/append-only/.test(e.message)) ok('molecule_conflicts refuses a DELETE');
      else bad('unexpected refusal', e.message);
    }
    // …but a human ruling must still be recordable, or the quarantine is a dead end.
    try {
      await q(`UPDATE molecule_conflicts SET resolved_at = NOW(), resolution = 'ruled: two substances'
               WHERE id = $1`, [conf.rows[0].id]);
      ok('a human ruling CAN be recorded — resolved_at and resolution stay writable');
    } catch (e) { bad('the quarantine cannot be resolved by a human', e.message); }

    // ── 8. the generated reference ────────────────────────────────────────
    const refs = await q(`SELECT COUNT(*)::int n FROM molecules WHERE molecule_ref !~ '^ABZ-Mol-[0-9]{6}$'`);
    if (refs.rows[0].n === 0) ok('every molecule has a quotable ABZ-Mol-NNNNNN reference');
    else bad(`${refs.rows[0].n} molecule(s) have a malformed reference`);

    // ── 9. triggers left enabled ──────────────────────────────────────────
    const trg = await q(`
      SELECT tgname, tgenabled FROM pg_trigger
       WHERE tgname IN ('trg_molecules_form_parent','trg_molecules_name_vs_alias',
                        'trg_molecule_alias_collision','trg_molecule_conflicts_append_only')`);
    const off = trg.rows.filter((t) => t.tgenabled !== 'O');
    if (trg.rowCount === 4 && !off.length) ok('all four guards are present and enabled after the run');
    else bad('a guard is missing or left disabled', JSON.stringify(trg.rows));

    if (!res || res.quarantined < 1) bad('the backfill reported no quarantine on a fixture built to cause one');

    // ── 9b. THE RETRACTION, AGAINST FIXTURES ──────────────────────────────
    //
    // The authorised plan names 72 production ids, so it cannot run here. What can run here is the
    // mechanics, which is the part that matters: unlink BEFORE delete (molecule_id is a foreign
    // key), detach children, remove aliases, and refuse to touch an id whose name has changed.
    //
    // That last one is the whole safeguard. CLAUDE.md records a verification script that PUT a
    // narrower product set onto the live super admin because its expectation encoded account state a
    // human had since changed, and it found out by writing. A retraction carrying 72 literal ids is
    // the same hazard with teeth, so the name is re-checked per id and a mismatch is skipped.
    try {
      const retract = require('./e1-retract');
      const vict = await q(
        `INSERT INTO molecules (preferred_name, normalized_name, source, derivation_method)
         VALUES ('Retractme','retractme','test','test') RETURNING id`);
      const vid = vict.rows[0].id;
      const kid = await q(
        `INSERT INTO molecules (preferred_name, normalized_name, substance_form,
                                parent_molecule_id, source, derivation_method)
         VALUES ('Retractme Acetate','retractme acetate','salt',$1,'test','test') RETURNING id`, [vid]);
      await q(`INSERT INTO molecule_aliases (molecule_id, alias, source) VALUES ($1,'retractme-alt','test')`, [vid]);
      const sm = await q(
        `INSERT INTO study_molecules (study_id, molecule_name, cas_number, molecule_id)
         VALUES ('NCT-RETRACT','Retractme',NULL,$1) RETURNING id`, [vid]);

      // A plan with one real entry and one whose name no longer matches.
      const plan = [
        { id: vid, name: 'retractme', kind: 'corrupted_name', group: 'unauthorised' },
        { id: kid.rows[0].id, name: 'a name this molecule does not have', kind: 'corrupted_name', group: 'unauthorised' },
      ];
      const quiet = console.log; console.log = () => {};
      const failed = await retract.main({ query: q, withTransaction: tx, execute: true, plan });
      console.log = quiet;

      const gone = await q(`SELECT COUNT(*)::int n FROM molecules WHERE id = $1`, [vid]);
      const row = await q(
        `SELECT molecule_id, molecule_unresolved_reason FROM study_molecules WHERE id = $1`,
        [sm.rows[0].id]);
      const al = await q(`SELECT COUNT(*)::int n FROM molecule_aliases WHERE alias = 'retractme-alt'`);
      const child = await q(
        `SELECT parent_molecule_id, normalized_name FROM molecules WHERE id = $1`, [kid.rows[0].id]);

      if (gone.rows[0].n === 0) ok('the retraction removed the molecule it was given by id');
      else bad('the retracted molecule is still there');
      if (row.rows[0].molecule_id === null && row.rows[0].molecule_unresolved_reason) {
        ok('  …its source row is unlinked AND says why, rather than silently orphaned');
      } else bad('the source row was not unlinked with a reason', JSON.stringify(row.rows[0]));
      if (al.rows[0].n === 0) ok('  …its alias went with it, leaving no dangling name');
      else bad('an alias outlived its molecule');
      if (child.rowCount && child.rows[0].parent_molecule_id === null) {
        ok('  …and the child survives, parentless, rather than being deleted with it');
      } else bad('the child was not detached', JSON.stringify(child.rows[0]));
      // The mismatch must have been skipped, which is also why `failed` is non-zero: the script
      // reports a mismatch as a failed proof instead of proceeding.
      if (child.rowCount && failed) {
        ok('  …and an id whose name no longer matches is skipped and reported, not deleted');
      } else bad('a name mismatch did not stop the delete', JSON.stringify({ failed }));

      await q(`DELETE FROM study_molecules WHERE id = $1`, [sm.rows[0].id]);
      await q(`DELETE FROM molecules WHERE id = $1`, [kid.rows[0].id]);

      // ── THE DRY RUN MUST SEE THE SCHEMA IT WILL FAIL ON ────────────────
      //
      // On 30 Oct at 13:37 the retraction dry run passed, and the --execute run then deleted all 72
      // molecules and threw on the 7th evidence row: the quarantine record writes
      // kind='insufficient_identity' and molecule_conflicts' CHECK predated that category. The dry
      // run was blind to the only table the real run was going to fail on.
      //
      // So: drop the constraint, and assert the dry run REFUSES. A dry run that cannot fail is not a
      // rehearsal, it is a formality.
      await q(`ALTER TABLE molecule_conflicts DROP CONSTRAINT molecule_conflicts_kind_check`);
      // NOT VALID: rows the backfill already wrote would fail a narrow CHECK, and
      // molecule_conflicts is append-only by trigger so they cannot be cleared. New inserts are
      // still checked, which is the condition being reproduced.
      await q(`ALTER TABLE molecule_conflicts ADD CONSTRAINT molecule_conflicts_kind_check
                 CHECK (kind IN ('cas_disagreement')) NOT VALID`);
      const q2 = console.log; console.log = () => {};
      const refused = await retract.main({
        query: q, withTransaction: tx, execute: false,
        plan: [{ id: -1, name: 'nothing', kind: 'insufficient_identity', group: 'requirement' }],
      });
      console.log = q2;
      if (refused) ok('  …and the DRY RUN refuses when the conflict table rejects a kind it will write');
      else bad('the dry run passed against a schema that would have failed the real run');
      await applyConflictKinds(q);
    } catch (e) {
      bad('the retraction could not run against fixtures', e && e.message ? e.message : e);
    }

    // ── 10. the --list-unexpected listing actually runs ───────────────────
    //
    // Its first version selected `canonical_name`, a column that does not exist, and the way I found
    // out was a failed run against PRODUCTION after a deploy and an SSH round trip. Every column it
    // names is checked here, against the schema built from the real DDL above. This asserts the query
    // executes and writes nothing — the retraction decision reads its output, so it has to survive a
    // schema it was not written against.
    try {
      const { listUnexpected, inspectSources } = require('./e1-reconcile');
      const before = await q(`SELECT COUNT(*)::int n FROM molecules`);
      const quiet = console.log; console.log = () => {};
      await listUnexpected(q, { exclusionReasons: new Map() }, new Set());
      await inspectSources(q, { exclusionReasons: new Map() }, new Set());
      console.log = quiet;
      const after = await q(`SELECT COUNT(*)::int n FROM molecules`);
      if (before.rows[0].n === after.rows[0].n) ok('--list-unexpected and --inspect-sources run against the real schema and write nothing');
      else bad('the listing changed the molecule count', `${before.rows[0].n} -> ${after.rows[0].n}`);
    } catch (e) {
      bad('a read-only listing could not run against the real schema', e && e.message ? e.message : e);
    }
  } catch (e) {
    bad('threw', e && e.stack ? e.stack : e);
  } finally {
    console.log = realLog;
    await A.end().catch(() => {});
    stopTemp();
  }

  if (fail) { console.log(`FAIL  ${fail} check(s) failed`); process.exit(1); }
  console.log('PASS  salts stay distinct, synonyms merge, CAS disagreements are refused, backfill is idempotent');
})();
