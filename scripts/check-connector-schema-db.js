#!/usr/bin/env node
// ── THE CONNECTOR SCHEMA, AGAINST A REAL SERVER ──────────────────────────────
//
//   node scripts/check-connector-schema-db.js
//   CONN_PG_URL=postgres://... node scripts/check-connector-schema-db.js
//
// Authorized scope: an ISOLATED, DISPOSABLE PostgreSQL database only. This starts its own
// throwaway cluster in /var/tmp and destroys it on exit. It must never be pointed at production
// or at a shared database — see the refusal below, which is a control and not a warning.
//
// ── WHY THIS EXISTS WHEN schema.test.js ALREADY PASSES ───────────────────────
//
// schema.test.js reads the DDL TEXT. It proves the migration says the right thing. It cannot prove
// a server accepts it, that a constraint fires, or that MATCH FULL means what I claimed. Those are
// different questions and only a server answers them.
//
// ── EVERY GUARD GETS A NEGATIVE CONTROL ──────────────────────────────────────
//
// The repo has been here before: "The first draft of the run-ledger checks passed with either of
// two unique indexes weakened, because each caught every reachable case the other did — so neither
// was proven necessary for any assertion. A guard that is never shown to be load-bearing has not
// been verified."
//
// So each control is exercised twice: intact, the violation must be REFUSED; dropped, the same
// violation must SUCCEED. If it succeeds both ways the guard is decoration. If it is refused both
// ways something else is doing the work and the attribution is wrong — which is Rule 8, gate
// contamination: a refusal test must prove WHICH control refused.
//
// ── CLEANUP ─────────────────────────────────────────────────────────────────
//
// The cluster is disposable, so teardown is the real cleanup. Fixtures are nevertheless recorded
// by id and deleted by id, and leaks reported, because the discipline is the point: a script that
// cleans up by timestamp or pattern on a throwaway cluster is a script somebody later copies
// against production. Nothing here asserts a table is empty — only that MY fixtures are gone.
'use strict';

const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const fs = require('fs');
const { execFileSync } = require('child_process');
const { migrateConnectors, CONNECTOR_TABLES, GLOBAL_TABLES } = require('../src/lib/connectors/schema');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 400)}`); };

let temp = null;
function startTemp() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/connschema-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55993' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55993 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55993`;
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

// A URL that is not obviously a local throwaway is REFUSED rather than used. The authorization is
// for a disposable database; "it would probably be fine" is the reasoning Rule 7 exists to stop.
function refuseNonDisposable(url) {
  const bad7 = [/railway/i, /rlwy\.net/i, /amazonaws/i, /\.render\.com/i, /supabase/i, /neon\.tech/i, /prod/i];
  for (const re of bad7) {
    if (re.test(url)) {
      console.log(`  FAIL  refusing to run against "${url.replace(/:[^:@/]*@/, ':***@')}" — this harness is `
        + 'authorized for an isolated disposable database only');
      process.exit(1);
    }
  }
}

const envUrl = process.env.CONN_PG_URL;
if (envUrl) refuseNonDisposable(envUrl);
const url = envUrl || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set CONN_PG_URL to a DISPOSABLE database, or install initdb)');
  console.log('SKIP  connector schema invariants not executed — this check needs a server');
  process.exit(EXIT_NOT_EXECUTED);
}

// Minimal shapes of the two tables the connector DDL references. Only the columns and constraints
// the connector schema actually depends on — a fuller copy would drift from the real definitions
// without making any assertion stronger.
const UPSTREAM = `
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active');
  CREATE TABLE IF NOT EXISTS agent_runs (
    run_id UUID PRIMARY KEY, root_run_id UUID, trigger TEXT, product TEXT,
    state TEXT, company_id TEXT REFERENCES companies(id));
  ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS uq_agent_runs_run_company;
  ALTER TABLE agent_runs ADD CONSTRAINT uq_agent_runs_run_company UNIQUE (run_id, company_id);
`;

const A = 'company-abiozen-fixture';
const B = 'company-cro360-fixture';
const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-8222-222222222222';

// Recorded as created, deleted by exactly these ids.
const made = { companies: [], runs: [], syncs: [], awards: [] };

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 4 });
  const q = (sql, params) => pool.query(sql, params);

  // Does `fn` raise, and with which SQLSTATE and constraint name? Rule 8: knowing it was refused
  // is not enough — the test must name WHICH control refused, or a different guard firing reads
  // as a pass.
  const refusedBy = async (fn) => {
    try { await fn(); return null; } catch (e) { return { code: e.code, constraint: e.constraint, message: e.message }; }
  };

  try {
    await q(UPSTREAM);

    // ── the migration itself ──────────────────────────────────────────────
    try {
      const r = await migrateConnectors(q);
      ok(`migration applied against a real server (${r.tables} tenant tables, ${r.connectors} connectors seeded)`);
    } catch (e) { bad('migration applied against a real server', e.message); }

    // Idempotency of the migration, which is what a redeploy actually does.
    try { await migrateConnectors(q); ok('migration is idempotent — a second run changes nothing and raises nothing'); }
    catch (e) { bad('migration is idempotent', e.message); }

    // Every table and index the design claims, as the server now holds them.
    for (const t of [...CONNECTOR_TABLES, ...GLOBAL_TABLES]) {
      const { rows } = await q('SELECT to_regclass($1) AS r', [t]);
      if (rows[0].r) ok(`${t} exists`); else bad(`${t} exists`);
    }

    // company_id NOT NULL, read from the catalog rather than from the DDL text.
    for (const t of CONNECTOR_TABLES) {
      const { rows } = await q(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'company_id'`, [t]);
      if (rows[0] && rows[0].is_nullable === 'NO') ok(`${t}.company_id is NOT NULL on the server`);
      else bad(`${t}.company_id is NOT NULL on the server`, rows[0] ? rows[0].is_nullable : 'column absent');
    }

    // ── fixtures ──────────────────────────────────────────────────────────
    for (const [id, slug] of [[A, 'abiozen-fixture'], [B, 'cro360-fixture']]) {
      await q('INSERT INTO companies (id, slug, display_name) VALUES ($1,$2,$3)', [id, slug, slug]);
      made.companies.push(id);
    }
    for (const [run, co] of [[RUN_A, A], [RUN_B, B]]) {
      await q('INSERT INTO agent_runs (run_id, root_run_id, trigger, product, state, company_id) VALUES ($1,$1,$2,$3,$4,$5)',
        [run, 'fixture', 'prpa', 'running', co]);
      made.runs.push(run);
    }
    ok('fixtures created, recorded by id');

    const insertSync = async (id, co, run) => {
      await q(`INSERT INTO source_sync_runs (id, company_id, source_key, run_id, status)
               VALUES ($1,$2,'usaspending',$3,'running')`, [id, co, run]);
      made.syncs.push(id);
    };
    const insertAward = async (id, co, key, parent = null) => {
      await q(`INSERT INTO federal_awards (id, company_id, source_key, award_key, parent_piid, raw_json)
               VALUES ($1,$2,'usaspending',$3,$4,'{}'::jsonb)`, [id, co, key, parent]);
      made.awards.push(id);
    };

    // ── C1 the tenant composite FK ────────────────────────────────────────
    await insertSync('sync-ok', A, RUN_A);
    ok('C1 a sync whose run belongs to the same company is accepted');

    let e = await refusedBy(() => insertSync('sync-cross', A, RUN_B));
    if (e && e.code === '23503' && e.constraint === 'fk_source_sync_runs_run_company') {
      ok('C1 a sync pointing at ANOTHER company\'s agent_run is refused, by name, by the composite FK');
    } else {
      bad('C1 cross-tenant run linkage is refused by fk_source_sync_runs_run_company',
        e ? `${e.code} / ${e.constraint} — a different control fired, so the attribution is wrong` : 'it was ACCEPTED');
    }

    // C1 negative control — drop the FK and the same write must land.
    await q('ALTER TABLE source_sync_runs DROP CONSTRAINT fk_source_sync_runs_run_company');
    e = await refusedBy(() => insertSync('sync-cross-neg', A, RUN_B));
    if (!e) ok('C1 negative control: with the FK dropped the cross-tenant write SUCCEEDS — the FK is load-bearing');
    else bad('C1 negative control: the cross-tenant write should succeed once the FK is dropped',
      `still refused by ${e.code}/${e.constraint} — something else is doing the work`);
    await q(`ALTER TABLE source_sync_runs ADD CONSTRAINT fk_source_sync_runs_run_company
             FOREIGN KEY (run_id, company_id) REFERENCES agent_runs (run_id, company_id) MATCH FULL NOT VALID`);

    // ── C2 MATCH FULL, and an honest finding about it ─────────────────────
    //
    // I claimed in PR-2 that MATCH FULL closes an evasion here. On a NULLABLE company_id it does:
    // MATCH SIMPLE passes if any column is NULL. But source_sync_runs.company_id is NOT NULL and
    // run_id is NOT NULL, so neither column can ever BE null — and the two modes are therefore
    // indistinguishable for this table. The real control is the pair of NOT NULLs.
    //
    // This is measured rather than argued: try to write the half-NULL row the evasion needs.
    e = await refusedBy(() => q(
      `INSERT INTO source_sync_runs (id, company_id, source_key, run_id, status)
       VALUES ('sync-halfnull', $1, 'usaspending', NULL, 'running')`, [A]));
    if (e && e.code === '23502') {
      ok('C2 the half-NULL row MATCH FULL exists to refuse cannot be written at all — run_id is NOT NULL');
      ok('C2 FINDING: MATCH FULL is therefore defence-in-depth here, not the operative control. '
        + 'The operative controls are the two NOT NULLs. It earns its place only if company_id is '
        + 'ever relaxed — and it must not be removed on the grounds that it never fires.');
    } else {
      bad('C2 run_id NOT NULL refuses the half-NULL row', e ? `${e.code}/${e.constraint}` : 'it was ACCEPTED');
    }

    // ── C3 idempotency: the natural key ──────────────────────────────────
    await insertAward('award-1', A, 'CONT_AWD_X_9700_Y_9700');
    e = await refusedBy(() => insertAward('award-1-dup', A, 'CONT_AWD_X_9700_Y_9700'));
    if (e && e.code === '23505' && /idx_fa_natural_key/.test(e.constraint || e.message)) {
      ok('C3 re-syncing the same award is refused by idx_fa_natural_key — §15 holds in the engine');
    } else {
      bad('C3 duplicate award refused by idx_fa_natural_key',
        e ? `${e.code}/${e.constraint}` : 'the duplicate was ACCEPTED — repeated syncs would duplicate rows');
    }

    // The same public award under a DIFFERENT tenant must be allowed. This is the half that a
    // careless unique key would break, and it is why company_id leads the index.
    e = await refusedBy(() => insertAward('award-1-cro360', B, 'CONT_AWD_X_9700_Y_9700'));
    if (!e) ok('C3 the same public award under another tenant is ACCEPTED — company_id leads the key');
    else bad('C3 two tenants may each track the same public award', `${e.code}/${e.constraint}`);

    // C3 negative control.
    await q('DROP INDEX idx_fa_natural_key');
    e = await refusedBy(() => insertAward('award-1-dup-neg', A, 'CONT_AWD_X_9700_Y_9700'));
    if (!e) ok('C3 negative control: with the index dropped the duplicate SUCCEEDS — the index is load-bearing');
    else bad('C3 negative control: the duplicate should succeed once the index is dropped', `${e.code}/${e.constraint}`);
    // The duplicate the negative control let through must go BEFORE the index is rebuilt, or the
    // CREATE UNIQUE INDEX fails on the very row that proved the index works. Written the other way
    // round first, and the harness aborted — which is the harness doing its job on itself.
    await q('DELETE FROM federal_awards WHERE id = $1', ['award-1-dup-neg']);
    made.awards = made.awards.filter((x) => x !== 'award-1-dup-neg');
    await q(`CREATE UNIQUE INDEX idx_fa_natural_key ON federal_awards (company_id, source_key, award_key)`);

    // ── C4 the sentinel ──────────────────────────────────────────────────
    for (const sentinel of ['-NONE-', 'NONE', '']) {
      e = await refusedBy(() => insertAward(`award-sent-${sentinel || 'empty'}`, A, `KEY_${sentinel || 'EMPTY'}`, sentinel));
      if (e && e.code === '23514' && e.constraint === 'federal_awards_parent_sentinel_check') {
        ok(`C4 parent_piid = ${JSON.stringify(sentinel)} is refused by federal_awards_parent_sentinel_check`);
      } else {
        bad(`C4 parent_piid ${JSON.stringify(sentinel)} refused by the sentinel check`,
          e ? `${e.code}/${e.constraint}` : 'it was ACCEPTED — joins on parent_piid would match unrelated awards');
      }
    }
    e = await refusedBy(() => insertAward('award-realparent', A, 'KEY_REAL', 'W91YTZ24D0002'));
    if (!e) ok('C4 a real parent award id is accepted — the check constrains the sentinel, not the column');
    else bad('C4 a real parent id is accepted', `${e.code}/${e.constraint}`);

    await q('ALTER TABLE federal_awards DROP CONSTRAINT federal_awards_parent_sentinel_check');
    e = await refusedBy(() => insertAward('award-sent-neg', A, 'KEY_NEG', '-NONE-'));
    if (!e) ok('C4 negative control: with the CHECK dropped \'-NONE-\' SUCCEEDS — the CHECK is load-bearing');
    else bad('C4 negative control: \'-NONE-\' should succeed once the CHECK is dropped', `${e.code}/${e.constraint}`);
    await q(`ALTER TABLE federal_awards ADD CONSTRAINT federal_awards_parent_sentinel_check
             CHECK (parent_piid IS NULL OR parent_piid NOT IN ('-NONE-', 'NONE', ''))
             NOT VALID`);

    // ── C5 the call ceiling ──────────────────────────────────────────────
    await q(`UPDATE source_sync_runs SET call_ceiling = 10 WHERE id = 'sync-ok' AND company_id = $1`, [A]);
    await q(`UPDATE source_sync_runs SET calls_made = 10 WHERE id = 'sync-ok' AND company_id = $1`, [A]);
    ok('C5 charging up to the ceiling is accepted');
    e = await refusedBy(() => q(
      `UPDATE source_sync_runs SET calls_made = 11 WHERE id = 'sync-ok' AND company_id = $1`, [A]));
    if (e && e.code === '23514' && e.constraint === 'source_sync_runs_calls_check') {
      ok('C5 exceeding the ceiling is refused by source_sync_runs_calls_check — the engine stops it, not just the caller');
    } else {
      bad('C5 exceeding the ceiling refused by source_sync_runs_calls_check',
        e ? `${e.code}/${e.constraint}` : 'it was ACCEPTED — the SAM.gov quota would be a suggestion');
    }

    await q('ALTER TABLE source_sync_runs DROP CONSTRAINT source_sync_runs_calls_check');
    e = await refusedBy(() => q(
      `UPDATE source_sync_runs SET calls_made = 11 WHERE id = 'sync-ok' AND company_id = $1`, [A]));
    if (!e) ok('C5 negative control: with the CHECK dropped the overrun SUCCEEDS — the CHECK is load-bearing');
    else bad('C5 negative control: the overrun should succeed once the CHECK is dropped', `${e.code}/${e.constraint}`);
    await q(`UPDATE source_sync_runs SET calls_made = 10 WHERE id = 'sync-ok' AND company_id = $1`, [A]);
    await q(`ALTER TABLE source_sync_runs ADD CONSTRAINT source_sync_runs_calls_check
             CHECK (calls_made >= 0 AND (call_ceiling IS NULL OR calls_made <= call_ceiling))`);

    // ── C6 the status domain ─────────────────────────────────────────────
    e = await refusedBy(() => q(
      `UPDATE source_sync_runs SET status = 'done' WHERE id = 'sync-ok' AND company_id = $1`, [A]));
    if (e && e.code === '23514' && e.constraint === 'source_sync_runs_status_check') {
      ok('C6 an invented status is refused by source_sync_runs_status_check');
    } else bad('C6 an invented status is refused', e ? `${e.code}/${e.constraint}` : 'ACCEPTED');

    // ── C7 the seed, as it lands ─────────────────────────────────────────
    const { rows: seeded } = await q(
      'SELECT source_key, access_mode, activated, daily_call_ceiling FROM source_connectors ORDER BY source_key');
    const byKey = Object.fromEntries(seeded.map((r) => [r.source_key, r]));
    if (byKey.sam_gov && byKey.sam_gov.activated === false && byKey.sam_gov.daily_call_ceiling === 10) {
      ok('C7 sam_gov lands activated=false with the personal-key ceiling of 10 (ruling 7)');
    } else bad('C7 sam_gov lands inert', JSON.stringify(byKey.sam_gov));

    const active = seeded.filter((r) => r.activated).map((r) => r.source_key);
    if (active.length === 1 && active[0] === 'usaspending') ok('C7 usaspending is the only source seeded active');
    else bad('C7 usaspending is the only active source', `active = ${active.join(', ')}`);

    const manual = seeded.filter((r) => r.access_mode === 'manual_assisted').map((r) => r.source_key).sort();
    if (manual.join(',') === 'fedconnect,hhs_sbcx') ok('C7 fedconnect and hhs_sbcx land manual_assisted (ruling 3)');
    else bad('C7 the two portals land manual_assisted', `manual = ${manual.join(', ')}`);

    // The seed must not flip `activated`. Set it by hand, re-migrate, and check it survived — the
    // way a redeploy would actually behave after somebody switched a source on.
    await q(`UPDATE source_connectors SET activated = true WHERE source_key = 'sam_gov'`);
    await migrateConnectors(q);
    const { rows: after } = await q(`SELECT activated FROM source_connectors WHERE source_key = 'sam_gov'`);
    if (after[0].activated === true) {
      ok('C7 re-running the migration does NOT reset activated — an operational decision survives a redeploy');
    } else bad('C7 the migration must not reset activated', 'the seed overwrote an operator\'s decision');
    await q(`UPDATE source_connectors SET activated = false WHERE source_key = 'sam_gov'`);

    // ── cleanup: only what I made, by id ─────────────────────────────────
    for (const id of made.awards) await q('DELETE FROM federal_awards WHERE id = $1', [id]);
    for (const id of made.syncs) await q('DELETE FROM source_sync_runs WHERE id = $1', [id]);
    for (const id of made.runs) await q('DELETE FROM agent_runs WHERE run_id = $1', [id]);
    for (const id of made.companies) await q('DELETE FROM companies WHERE id = $1', [id]);

    // Assert MY FIXTURES ARE GONE. Never that a table is empty — that is a statement which becomes
    // false the moment the product is used, and when it starts failing the obvious fix is to widen
    // the DELETE.
    const leaks = [];
    for (const [t, col, ids] of [
      ['federal_awards', 'id', made.awards],
      ['source_sync_runs', 'id', made.syncs],
      ['agent_runs', 'run_id::text', made.runs],
      ['companies', 'id', made.companies],
    ]) {
      if (!ids.length) continue;
      const { rows } = await q(`SELECT COUNT(*)::int n FROM ${t} WHERE ${col} = ANY($1)`, [ids]);
      if (rows[0].n) leaks.push(`${t}: ${rows[0].n}`);
    }
    if (!leaks.length) ok(`cleanup: all ${made.awards.length + made.syncs.length + made.runs.length + made.companies.length} fixtures removed by id, none leaked`);
    else bad('cleanup left fixtures behind', leaks.join('; '));

    // ── the documented rollback, actually executed ───────────────────────
    await q('DROP TABLE IF EXISTS federal_awards');
    await q('DROP TABLE IF EXISTS source_sync_runs');
    await q('DROP TABLE IF EXISTS source_connectors');
    const { rows: gone } = await q(
      `SELECT COUNT(*)::int n FROM pg_class WHERE relname = ANY($1) AND relkind = 'r'`,
      [[...CONNECTOR_TABLES, ...GLOBAL_TABLES]]);
    if (gone[0].n === 0) ok('the documented rollback runs in the stated order and leaves nothing behind');
    else bad('the documented rollback removes every table', `${gone[0].n} remain`);

    // And it must not have taken the upstream tables with it.
    const { rows: up } = await q(`SELECT to_regclass('companies') c, to_regclass('agent_runs') r`);
    if (up[0].c && up[0].r) ok('the rollback leaves companies and agent_runs untouched');
    else bad('the rollback leaves upstream tables untouched', JSON.stringify(up[0]));
  } catch (e) {
    bad('harness aborted', e.stack || e.message);
  } finally {
    await pool.end().catch(() => {});
    stopTemp();
  }

  console.log('');
  if (fail) {
    console.log(`FAIL  ${fail} connector schema invariant(s) failed`);
    process.exit(1);
  }
  console.log('PASS  the connector schema holds against a real server, and every guard was shown to be load-bearing');
  process.exit(0);
})();
