#!/usr/bin/env node
'use strict';
// ── MIGRATION v2 AGAINST A RESTORE OF THE REAL PRODUCTION DATABASE ──────────
//
// Ruling 13 items 2 and 3.
//
//   node scripts/verify-migration-v2-on-restore.js prod-YYYYMMDD.dump
//   echo $?
//
// ── WHY THIS EXISTS WHEN check-migration-v2-db.js ALREADY PASSES ────────────
//
// That harness builds its own `companies` and `verified_capabilities` from DDL I wrote by hand. It
// proves the migration's logic and that every guard fires. It cannot prove the migration works on
// PRODUCTION'S schema, because the fixture is my idea of production's schema rather than
// production's schema — and the two have already diverged once in this repository: a fresh install
// builds ~66 tables against production's 137, so the only faithful copy of that schema is a
// backup.
//
// A fixture that matches a hand-written expectation is the shape of the 2026-09-30 failure, one
// level up: the checker was right and the thing it checked was not the thing that shipped. So this
// restores the actual dump, records what is there, migrates it, and compares.
//
// ── IT NEVER TOUCHES PRODUCTION ─────────────────────────────────────────────
//
// No production connection is opened. The dump is read from disk, restored into a cluster this
// script creates in /var/tmp and destroys on exit, and every statement — including the migration
// and the deliberately destructive rollback tests — runs against that copy. The production
// database is not reachable from this script even by accident: there is no code path that reads
// DATABASE_URL.
//
// ── WHAT IT PROVES ──────────────────────────────────────────────────────────
//
//   1  the production dump restores, and the preconditions v2 needs are really there
//   2  a BEFORE snapshot: every table, index, constraint, company and capability row
//   3  --check against production's actual schema writes nothing
//   4  --apply succeeds on production's actual schema
//   5  EXISTING DATA IS BYTE-IDENTICAL afterwards — companies and capabilities compared row by row
//   6  no pre-existing index or constraint was lost (the kind CHECK is REPLACED, not removed)
//   7  --apply a second time is safe and changes nothing further        (ruling 13 item 3)
//   8  rollback REFUSES while a new-kind capability row exists, and drops nothing (item 3)
//   9  after that row goes, rollback restores the prior schema exactly, data intact
//  10  the migration re-applies afterwards
//
// Exit: 0 all proved · 1 a property failed · 3 did not execute

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Client } = require('pg');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');
const R = require('./lib/restore');
const schema = require('../src/lib/office/registration-schema');

const PGPORT = 55993;
const NEW_KINDS = schema.CAPABILITY_KINDS.filter((k) => !schema.CAPABILITY_KINDS_BEFORE.includes(k));
// Fixture ids. Recorded so cleanup removes exactly these, by id — the house rule, applied even
// though this is a throwaway cluster, because a harness that cleans up loosely here is the
// template somebody copies for one that runs against production.
const FIXTURE_IDS = [];

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 500)}`); };
const note = (m) => console.log(`  note  ${m}`);
const bar = () => '─'.repeat(78);
const h = (t) => console.log(`\n${bar()}\n${t}\n${bar()}`);

const dumpPath = process.argv[2];
if (!dumpPath) {
  console.error(`
Usage: node scripts/verify-migration-v2-on-restore.js <production-dump>

Take the dump first, without copying the URL by hand:
  railway run --service Postgres sh -c \\
    'pg_dump --format=custom --no-owner --no-privileges "$DATABASE_PUBLIC_URL" -f prod-$(date +%Y%m%d).dump'

This script never connects to production. It restores the dump into a cluster it
creates and destroys, and migrates THAT copy.
`);
  process.exit(1);
}
if (!fs.existsSync(dumpPath)) {
  if (!R.reportPlaceholder(dumpPath, process.argv[1])) {
    console.error(`dump file not found: ${dumpPath}`);
  }
  process.exit(1);
}

/** Run the real migration runner against the restored copy. Non-zero exit is data, not a throw. */
function runner(url, args) {
  const script = path.join(__dirname, 'migrate-registrations.js');
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      env: { ...process.env, DATABASE_URL: url, MIGRATION_OPERATOR: 'gate3-restore-harness' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

async function snapshot(q) {
  const one = async (sql, params) => (await q(sql, params)).rows;
  return {
    tables: await one(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`),
    indexes: await one(
      `SELECT indexname, tablename FROM pg_indexes WHERE schemaname='public' ORDER BY indexname`),
    // Constraint DEFINITIONS, not just names: a CHECK can be replaced with a weaker one under the
    // same name, and a name-only comparison would call that unchanged.
    constraints: await one(
      `SELECT c.conname, c.contype, t.relname AS tbl, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public' ORDER BY c.conname`),
    companies: await one(`SELECT id, slug, display_name, status FROM companies ORDER BY id`),
    capabilities: await one(
      `SELECT id, company_id, kind, code, name, responsible_entity, verification_status,
              evidence_source, verified_at, verified_by, approval_id, valid_from, valid_to
         FROM verified_capabilities ORDER BY id`),
    migrations: await one(
      `SELECT version FROM schema_migrations ORDER BY version`).catch(() => []),
  };
}

const j = (v) => JSON.stringify(v);

async function main() {
  const stat = fs.statSync(dumpPath);
  h('MIGRATION v2 ON A RESTORE OF PRODUCTION (ruling 13 items 2–3)');
  console.log(`  dump      : ${path.resolve(dumpPath)}`);
  console.log(`  size      : ${(stat.size / 1048576).toFixed(2)} MiB`);
  console.log(`  taken     : ${stat.mtime.toISOString()}`);
  console.log(`  version   : ${schema.VERSION}`);
  console.log(`  started   : ${new Date().toISOString()}`);
  console.log('');
  console.log('  No production connection is opened. Everything below runs against a restored');
  console.log('  copy in a throwaway cluster, destroyed on exit.');

  const archive = R.archiveVersion(dumpPath);
  const chosen = R.toolchainFor(dumpPath, archive !== null);
  if (!chosen.dir) {
    if (!chosen.tried.length && !(chosen.clientOnly || []).length) {
      console.log('\nSKIP  no PostgreSQL available. This asserted NOTHING; it is not a pass.\n');
      process.exit(EXIT_NOT_EXECUTED);
    }
    h('TOOLCHAIN');
    bad(`no installed PostgreSQL server can read this dump (archive ${archive})`);
    for (const t of chosen.tried) console.log(`    server install, cannot read it: ${t}`);
    for (const d of chosen.clientOnly || []) console.log(`    client-only, no server:        ${d}`);
    console.log('\n  On macOS: brew install postgresql@18\n');
    process.exit(1);
  }
  console.log(`  format    : ${archive ? `custom (archive ${archive})` : 'plain SQL'}`);
  console.log(`  toolchain : ${chosen.dir}`);
  console.log(`              ${chosen.version}`);
  console.log(`              ${chosen.initdbVersion}`);

  const cluster = R.startCluster(chosen.dir, { port: PGPORT, prefix: 'mig2-restore-' });
  if (cluster.error) {
    h('CLUSTER');
    bad('the selected PostgreSQL could not start a cluster', `failed at: ${cluster.error.step}`);
    if (cluster.error.output) console.log(`\n  output:\n    ${cluster.error.output.split('\n').slice(-12).join('\n    ')}`);
    if (cluster.error.log) console.log(`\n  server log:\n    ${cluster.error.log.split('\n').slice(-12).join('\n    ')}`);
    console.log(`\n  data directory left for inspection: ${cluster.error.base}\n`);
    process.exit(1);
  }

  let client = null;
  try {
    // ── 1. restore, and check v2's preconditions are genuinely present ────
    h('1. RESTORE THE PRODUCTION COPY');
    const res = R.restoreDump(cluster, dumpPath);
    if (res.error) { bad('THE RESTORE FAILED', res.error); return; }
    ok('restored with no error (strict mode)');
    const url = res.url;
    client = new Client({ connectionString: url });
    await client.connect();
    const q = (sql, params) => client.query(sql, params);

    for (const p of schema.PRECONDITIONS) {
      const n = (await q(
        `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
        [p.table])).rows[0].n;
      if (n === 1) ok(`${p.name} ${p.what} — present in the production copy`);
      else bad(`${p.name} ${p.what} — ABSENT in production`, 'v2 cannot be applied to production as it stands');
    }

    // ── 2. the BEFORE snapshot ────────────────────────────────────────────
    h('2. WHAT PRODUCTION LOOKS LIKE NOW');
    const before = await snapshot(q);
    console.log(`  tables          : ${before.tables.length}`);
    console.log(`  indexes         : ${before.indexes.length}`);
    console.log(`  constraints     : ${before.constraints.length}`);
    console.log(`  companies       : ${before.companies.length}`);
    console.log(`  capabilities    : ${before.capabilities.length}`);
    console.log(`  migrations      : ${before.migrations.map((m) => m.version).join(', ') || 'none recorded'}`);
    for (const c of before.companies) console.log(`    ${c.id} | ${c.slug} | ${c.display_name} | ${c.status}`);
    const kindDefBefore = (before.constraints.find((c) => c.conname === 'verified_capabilities_kind_check') || {}).def;
    console.log(`\n  verified_capabilities_kind_check:\n    ${kindDefBefore || 'ABSENT'}`);
    if (before.migrations.some((m) => m.version === schema.VERSION)) {
      bad(`${schema.VERSION} is ALREADY recorded in this dump`,
        'production has had v2 applied, or the dump is newer than expected. Stop and reconcile.');
      return;
    }
    ok(`${schema.VERSION} is not yet recorded — this dump predates it, as expected`);

    // ── 3. --check writes nothing, against the real schema ────────────────
    h('3. --check AGAINST PRODUCTION\'S ACTUAL SCHEMA');
    let r = runner(url, ['--check']);
    if (r.code === 0) ok('--check exits 0: the preconditions hold on production\'s schema');
    else { bad(`--check exited ${r.code}`, r.out.slice(-600)); return; }
    const afterCheck = await snapshot(q);
    if (j(afterCheck) === j(before)) ok('--check changed NOTHING — snapshots are identical');
    else bad('--check modified the database', 'a dry run must be a dry run');

    // ── 4 & 5 & 6. apply, then compare everything ─────────────────────────
    h('4. --apply ON PRODUCTION\'S ACTUAL SCHEMA');
    r = runner(url, ['--apply']);
    if (r.code === 0) ok('--apply exits 0');
    else { bad(`--apply exited ${r.code}`, r.out.slice(-900)); return; }
    const after = await snapshot(q);

    h('5. IS EXISTING DATA UNCHANGED? (ruling 13 item 3)');
    if (j(after.companies) === j(before.companies)) {
      ok(`all ${before.companies.length} company row(s) identical, field by field`);
    } else bad('company rows changed', `before ${j(before.companies)}\n          after  ${j(after.companies)}`);
    if (j(after.capabilities) === j(before.capabilities)) {
      ok(`all ${before.capabilities.length} capability row(s) identical, field by field`);
    } else bad('capability rows changed', `before ${j(before.capabilities)}\n          after  ${j(after.capabilities)}`);
    // Row counts across EVERY pre-existing table, captured here and compared again after the
    // rollback. A migration that touched an unrelated table is the thing nobody thinks to look for.
    const counts = {};
    for (const t of before.tables.map((x) => x.table_name)) {
      try { counts[t] = (await q(`SELECT COUNT(*)::int n FROM "${t}"`)).rows[0].n; } catch (_) { /* skip */ }
    }
    ok(`row counts captured for ${Object.keys(counts).length} pre-existing tables (compared after rollback too)`);

    h('6. WAS ANYTHING LOST?');
    const newTables = after.tables.filter((t) => !before.tables.some((b) => b.table_name === t.table_name));
    const lostTables = before.tables.filter((t) => !after.tables.some((a) => a.table_name === t.table_name));
    if (!lostTables.length) ok(`no table lost; ${newTables.length} added: ${newTables.map((t) => t.table_name).join(', ')}`);
    else bad(`${lostTables.length} table(s) disappeared`, lostTables.map((t) => t.table_name).join(', '));
    if (after.tables.length === before.tables.length + schema.CREATED_TABLES.length) {
      ok(`table count ${before.tables.length} → ${after.tables.length} (+${schema.CREATED_TABLES.length}), exactly as planned`);
    } else bad(`table count went ${before.tables.length} → ${after.tables.length}`,
      `expected +${schema.CREATED_TABLES.length}`);

    const lostIdx = before.indexes.filter((i) => !after.indexes.some((a) => a.indexname === i.indexname));
    if (!lostIdx.length) ok(`no pre-existing index lost; ${after.indexes.length - before.indexes.length} added`);
    else bad(`${lostIdx.length} index(es) lost`, lostIdx.map((i) => i.indexname).join(', '));

    // THE SUBTLE ONE. The kind CHECK is dropped and re-added under the SAME NAME, so a name-only
    // comparison reports it as untouched. Definitions are compared, and this constraint is
    // expected to differ — every OTHER constraint is expected not to.
    const lostCons = before.constraints.filter((c) => !after.constraints.some((a) => a.conname === c.conname));
    if (!lostCons.length) ok('no constraint disappeared');
    else bad(`${lostCons.length} constraint(s) lost`, lostCons.map((c) => c.conname).join(', '));
    const changed = before.constraints.filter((c) => {
      const a = after.constraints.find((x) => x.conname === c.conname);
      return a && a.def !== c.def;
    });
    const expectChanged = ['verified_capabilities_kind_check'];
    const unexpected = changed.filter((c) => !expectChanged.includes(c.conname));
    if (!unexpected.length) {
      ok(`exactly ${changed.length} constraint definition changed, and it is the expected one`);
      for (const c of changed) {
        console.log(`    ${c.conname}`);
        console.log(`      was: ${c.def}`);
        console.log(`      now: ${after.constraints.find((x) => x.conname === c.conname).def}`);
      }
    } else {
      bad(`${unexpected.length} constraint(s) changed that should not have`,
        unexpected.map((c) => c.conname).join(', '));
    }
    const kindDefAfter = (after.constraints.find((c) => c.conname === 'verified_capabilities_kind_check') || {}).def;
    if (kindDefAfter && NEW_KINDS.every((k) => kindDefAfter.includes(`'${k}'`))) {
      ok('the kind CHECK is REPLACED with the widened form, not removed');
    } else bad('the kind CHECK is missing or not widened', kindDefAfter || 'absent');

    // ── 7. apply twice ────────────────────────────────────────────────────
    h('7. --apply A SECOND TIME (ruling 13 item 3)');
    r = runner(url, ['--apply']);
    if (r.code === 0) ok('the second --apply exits 0');
    else bad(`the second --apply exited ${r.code}`, r.out.slice(-600));
    const afterTwice = await snapshot(q);
    if (j(afterTwice) === j(after)) ok('the second --apply changed NOTHING — snapshots identical');
    else bad('applying twice changed the database', 'the migration is not idempotent on production\'s schema');

    // ── 8. the rollback guard, with real evidence at stake ────────────────
    h('8. ROLLBACK REFUSES RATHER THAN DESTROY CAPABILITY EVIDENCE (item 3)');
    const co = before.companies[0];
    if (!co) { note('no company row in this dump, so the guard cannot be exercised with real data'); }
    else {
      // A FULLY EVIDENCED certification — a kind that only exists after v2. This is precisely the
      // row a rollback would have to destroy, and it is created with real evidence so the refusal
      // is about something that would actually be a loss.
      const id = 'vc-gate3-fixture-cert';
      FIXTURE_IDS.push(id);
      await q(
        `INSERT INTO verified_capabilities
           (id, company_id, kind, code, name, responsible_entity, verification_status,
            evidence_source, verified_at, verified_by, approval_id, valid_from)
         VALUES ($1,$2,'certification','GATE3-FIXTURE','Gate 3 rollback fixture',
                 'Abiozen Scientific','verified','gate-3 harness fixture', NOW(),
                 'gate3-restore-harness','appr-gate3-fixture', CURRENT_DATE)`,
        [id, co.id]);
      ok(`a fully evidenced 'certification' row exists (${id}) — a kind only v2 permits`);

      r = runner(url, ['--rollback']);
      if (r.code === 2) ok('--rollback without the acknowledgement exits 2');
      else bad(`--rollback without acknowledgement exited ${r.code}`, r.out.slice(-300));

      r = runner(url, ['--rollback', '--i-understand-this-drops-tables']);
      if (r.code === 2 && /DATA WOULD HAVE TO BE DESTROYED/.test(r.out)) {
        ok('rollback REFUSED: restoring the narrow CHECK would require deleting that row,');
        ok('and it would fail AFTER dropping tables — so it refuses the whole operation');
      } else bad(`rollback exited ${r.code} with an evidenced new-kind row present`, r.out.slice(-600));
      let stillThere = 0;
      for (const t of schema.CREATED_TABLES) {
        stillThere += (await q(
          `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
          [t])).rows[0].n;
      }
      if (stillThere === schema.CREATED_TABLES.length) ok('the refused rollback dropped NOTHING');
      else bad(`only ${stillThere} of ${schema.CREATED_TABLES.length} tables survived a refused rollback`);
      const rowSurvived = (await q(
        `SELECT COUNT(*)::int n FROM verified_capabilities WHERE id = ANY($1)`, [FIXTURE_IDS])).rows[0].n;
      if (rowSurvived === 1) ok('the evidenced capability row is untouched');
      else bad('the capability row was affected by a refused rollback');

      // ── 9. clean rollback once that row is gone ─────────────────────────
      h('9. AFTER THE NEW-KIND ROW GOES, ROLLBACK IS AN EXACT REVERT');
      // Deleted BY ID, the only ids this harness created. Not by timestamp, not by pattern.
      for (const fid of FIXTURE_IDS) await q(`DELETE FROM verified_capabilities WHERE id = $1`, [fid]);
      const leaked = (await q(
        `SELECT COUNT(*)::int n FROM verified_capabilities WHERE id = ANY($1)`, [FIXTURE_IDS])).rows[0].n;
      if (leaked === 0) ok('fixture removed by id; zero leaked');
      else bad(`${leaked} fixture row(s) leaked`);

      r = runner(url, ['--rollback', '--i-understand-this-drops-tables']);
      if (r.code === 0) ok('rollback succeeds once nothing depends on the widened CHECK');
      else bad(`rollback exited ${r.code}`, r.out.slice(-600));

      const rolled = await snapshot(q);
      if (j(rolled.companies) === j(before.companies)) ok('companies identical to the production copy');
      else bad('company rows differ after rollback');
      if (j(rolled.capabilities) === j(before.capabilities)) {
        ok(`capabilities identical to the production copy (${before.capabilities.length} row(s))`);
      } else bad('capability rows differ after rollback',
        `before ${j(before.capabilities)}\n          after  ${j(rolled.capabilities)}`);
      if (j(rolled.tables) === j(before.tables)) ok(`table list identical — back to ${before.tables.length}`);
      else bad('the table list differs after rollback');
      if (j(rolled.indexes) === j(before.indexes)) ok('index list identical');
      else bad('the index list differs after rollback');
      const rolledKind = (rolled.constraints.find((c) => c.conname === 'verified_capabilities_kind_check') || {}).def;
      if (rolledKind === kindDefBefore) ok('the kind CHECK definition is byte-identical to production\'s');
      else bad('the kind CHECK was not restored exactly', `was: ${kindDefBefore}\n          now: ${rolledKind}`);
      // Every pre-existing table's row count, against the numbers taken after apply.
      //
      // schema_migrations is excluded BY NAME and for one reason: it is the runner's own
      // bookkeeping, and a rollback is supposed to delete its version row. Leaving it in made this
      // check fail with `schema_migrations: 2 → 1`, which is the migration behaving correctly.
      //
      // Excluding it silently would be the wrong fix, because then nothing would check that the
      // row actually went. So it is excluded here and asserted explicitly below — a narrower
      // expectation, not a looser one.
      const BOOKKEEPING = ['schema_migrations'];
      const drift = [];
      for (const [t, n] of Object.entries(counts)) {
        if (BOOKKEEPING.includes(t)) continue;
        try {
          const now = (await q(`SELECT COUNT(*)::int n FROM "${t}"`)).rows[0].n;
          if (now !== n) drift.push(`${t}: ${n} → ${now}`);
        } catch (_) { /* skip */ }
      }
      if (!drift.length) {
        ok(`row counts unchanged across all ${Object.keys(counts).length - BOOKKEEPING.length} `
          + 'pre-existing data tables');
      } else bad(`${drift.length} table(s) changed row count`, drift.slice(0, 8).join(' | '));

      const stillRecorded = (await q(
        `SELECT COUNT(*)::int n FROM schema_migrations WHERE version = $1`, [schema.VERSION])).rows[0].n;
      if (stillRecorded === 0) ok(`schema_migrations no longer records ${schema.VERSION} — the rollback un-recorded itself`);
      else bad(`${schema.VERSION} is still recorded after a rollback`,
        'a later --apply would then report "already recorded" and skip, leaving the schema reverted '
        + 'but the bookkeeping claiming otherwise');
      // And the versions that were there before must survive: a rollback of v2 must not disturb v1.
      const otherBefore = before.migrations.map((m) => m.version);
      const otherNow = (await q(`SELECT version FROM schema_migrations ORDER BY version`)).rows.map((m) => m.version);
      if (j(otherNow) === j(otherBefore)) {
        ok(`the other recorded version(s) survive: ${otherNow.join(', ') || 'none'}`);
      } else bad('rollback disturbed other migration records', `${j(otherBefore)} → ${j(otherNow)}`);

      // ── 10. re-apply ──────────────────────────────────────────────────
      h('10. THE MIGRATION RE-APPLIES AFTER A ROLLBACK');
      r = runner(url, ['--apply']);
      if (r.code === 0) ok('re-apply exits 0 — the rollback did not leave the schema unmigratable');
      else bad(`re-apply exited ${r.code}`, r.out.slice(-600));
    }
  } finally {
    if (client) await client.end().catch(() => {});
    R.stopCluster(cluster);
  }

}

// ── THE EXIT CODE IS COMPUTED HERE, NOT INSIDE main() ──────────────────────
//
// Same correction as verify-prod-dashboard.js, where this shape was caught producing a FAIL and
// an exit 0. main() returns early when the restore fails, when a precondition is absent, when the
// dump already records v2 and when --check or --apply fails — and a `return` inside a try/finally
// runs the finally and then leaves the function, so the RESULT block that used to sit below it
// never executed. Those are the paths where a wrong verdict matters most.
function result() {
  h('RESULT');
  if (fail) {
    console.log(`  ${fail} property FAILED. Migration v2 is NOT verified against production's schema.\n`);
  } else {
    console.log('  Migration v2 applies cleanly to a restore of the real production database,');
    console.log('  twice, changes no existing row, loses no index or constraint, and its rollback');
    console.log('  refuses rather than destroy capability evidence.');
    console.log('  Production itself was never connected to.\n');
  }
  return fail ? 1 : 0;
}

main()
  .then(() => process.exit(result()))
  .catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
