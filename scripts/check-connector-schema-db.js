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
const made = { companies: [], runs: [], syncs: [], awards: [], opps: [], vers: [], assessments: [], findings: [], caps: [], scopes: [] };

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

    // ── C8 biddability is computed, not asserted ─────────────────────────
    const insertOpp = async (id, oppId, { status = 'posted', docType = 'synopsis', close = '2026-11-17', standing = 'open' } = {}) => {
      await q(`INSERT INTO funding_opportunities
                 (id, company_id, source_key, opportunity_id, doc_type, opp_status, standing, close_date, raw_json)
               VALUES ($1,$2,'grants_gov',$3,$4,$5,$6,$7,'{}'::jsonb)`,
      [id, A, oppId, docType, status, standing, close]);
      made.opps.push(id);
    };

    await insertOpp('opp-open', '359966');
    let { rows: b } = await q(`SELECT application_open FROM funding_opportunities WHERE id = 'opp-open'`);
    if (b[0].application_open === true) ok('C8 a posted synopsis with a deadline computes application_open = true');
    else bad('C8 a posted synopsis with a deadline is open for applications', JSON.stringify(b[0]));

    await insertOpp('opp-forecast', '336962', { status: 'forecasted', docType: 'forecast', close: null, standing: 'forecast' });
    ({ rows: b } = await q(`SELECT application_open FROM funding_opportunities WHERE id = 'opp-forecast'`));
    if (b[0].application_open === false) ok('C8 a forecast with no deadline computes application_open = false');
    else bad('C8 a forecast is not open for applications', JSON.stringify(b[0]));

    // The whole point: a caller cannot overrule it.
    e = await refusedBy(() => q(
      `UPDATE funding_opportunities SET application_open = true WHERE id = 'opp-forecast'`));
    if (e && e.code === '428C9') {
      ok('C8 writing application_open directly is refused by the server — a forecast cannot be made to look open');
    } else {
      bad('C8 application_open cannot be written directly',
        e ? `${e.code}/${e.constraint}` : 'the UPDATE was ACCEPTED — the generated column is not generated');
    }

    // And it recomputes when the facts change, rather than going stale.
    await q(`UPDATE funding_opportunities SET opp_status = 'posted', doc_type = 'synopsis',
             close_date = '2026-12-01', standing = 'open' WHERE id = 'opp-forecast'`);
    ({ rows: b } = await q(`SELECT application_open FROM funding_opportunities WHERE id = 'opp-forecast'`));
    if (b[0].application_open === true) ok('C8 application_open recomputes when the underlying facts change');
    else bad('C8 application_open recomputes on update', JSON.stringify(b[0]));

    // A status the vocabulary does not know must read as NOT biddable, not as NULL.
    await insertOpp('opp-unknown', '999999', { status: null, standing: 'unknown' });
    ({ rows: b } = await q(`SELECT application_open FROM funding_opportunities WHERE id = 'opp-unknown'`));
    if (b[0].application_open === false) ok('C8 an unknown status computes application_open = false, not NULL');
    else bad('C8 an unknown status is not open for applications', JSON.stringify(b[0]));

    e = await refusedBy(() => insertOpp('opp-badstanding', '888888', { standing: 'live' }));
    if (e && e.code === '23514' && e.constraint === 'funding_opportunities_standing_check') {
      ok('C8 an invented standing is refused by funding_opportunities_standing_check');
    } else bad('C8 an invented standing is refused', e ? `${e.code}/${e.constraint}` : 'ACCEPTED');

    // ── C9 exactly one current revision ─────────────────────────────────
    const insertVer = async (id, oppId, rev, isCurrent) => {
      await q(`INSERT INTO funding_opportunity_versions
                 (id, company_id, source_key, opportunity_id, revision, is_current, raw_json)
               VALUES ($1,$2,'grants_gov',$3,$4,$5,'{}'::jsonb)`, [id, A, oppId, rev, isCurrent]);
      made.vers.push(id);
    };
    for (let r = 0; r <= 5; r++) await insertVer(`ver-${r}`, '359966', r, false);
    await insertVer('ver-6', '359966', 6, true);
    ok('C9 the measured chain (history 0..5 plus current 6) stores as seven revisions');

    e = await refusedBy(() => insertVer('ver-6-dup', '359966', 6, false));
    if (e && e.code === '23505' && /idx_fov_natural_key/.test(e.constraint || e.message)) {
      ok('C9 re-ingesting a revision is refused by idx_fov_natural_key');
    } else bad('C9 duplicate revision refused', e ? `${e.code}/${e.constraint}` : 'ACCEPTED');

    e = await refusedBy(() => insertVer('ver-7-alsocurrent', '359966', 7, true));
    if (e && e.code === '23505' && /idx_fov_one_current/.test(e.constraint || e.message)) {
      ok('C9 a SECOND current revision is refused by idx_fov_one_current — a proposal cannot be '
        + 'written against two "current" versions');
    } else {
      bad('C9 only one revision may be current',
        e ? `${e.code}/${e.constraint}` : 'ACCEPTED — two rows now both claim to be current');
    }

    // The legitimate path: retire the old claim, then make the new one. This is what
    // upsertFundingOpportunities does, and it must work.
    await q(`UPDATE funding_opportunity_versions SET is_current = FALSE
              WHERE company_id = $1 AND source_key = 'grants_gov' AND opportunity_id = '359966'
                AND is_current AND revision <> 7`, [A]);
    e = await refusedBy(() => insertVer('ver-7-current', '359966', 7, true));
    if (!e) ok('C9 retiring the previous current revision first lets the new one land');
    else bad('C9 the retire-then-write path works', `${e.code}/${e.constraint}`);

    await q('DROP INDEX idx_fov_one_current');
    e = await refusedBy(() => insertVer('ver-8-neg', '359966', 8, true));
    if (!e) ok('C9 negative control: with the index dropped a second current SUCCEEDS — it is load-bearing');
    else bad('C9 negative control', `${e.code}/${e.constraint}`);
    await q(`DELETE FROM funding_opportunity_versions WHERE id = 'ver-8-neg'`);
    made.vers = made.vers.filter((x) => x !== 'ver-8-neg');
    await q(`CREATE UNIQUE INDEX idx_fov_one_current
             ON funding_opportunity_versions (company_id, source_key, opportunity_id)
             WHERE is_current`);

    // ── C10 funding is structurally separate from procurement ───────────
    const { rows: fcols } = await q(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'funding_opportunities'`);
    const names = fcols.map((r) => r.column_name);
    const leaked = ['obligated_amount', 'piid', 'parent_piid', 'naics_code', 'psc_code'].filter((c) => names.includes(c));
    if (!leaked.length) {
      ok('C10 funding_opportunities carries no procurement column — a grant figure has nowhere to land in a procurement total');
    } else bad('C10 funding and procurement stay separate', `leaked columns: ${leaked.join(', ')}`);

    // ── C11 a funding record cannot be a solicitation ────────────────────
    e = await refusedBy(() => q(
      `UPDATE funding_opportunities SET record_kind = 'solicitation' WHERE id = 'opp-open'`));
    if (e && e.code === '23514' && e.constraint === 'funding_opportunities_record_kind_check') {
      ok('C11 a solicitation is UNSTOREABLE in the funding table (ruling 4)');
    } else {
      bad('C11 funding_opportunities refuses a non-funding record kind',
        e ? `${e.code}/${e.constraint}` : 'ACCEPTED — a biddable contract now sits in the grant pipeline');
    }
    for (const kind of ['grant_opportunity', 'forecast']) {
      e = await refusedBy(() => q(
        `UPDATE funding_opportunities SET record_kind = $1 WHERE id = 'opp-open'`, [kind]));
      if (!e) ok(`C11 ${kind} is accepted — the CHECK constrains the kind, not the column`);
      else bad(`C11 ${kind} should be accepted`, `${e.code}/${e.constraint}`);
    }

    // ── C12 a verdict cannot contradict its own blockers ─────────────────
    const insertAssessment = async (id, verdict, blocking) => {
      await q(`INSERT INTO eligibility_assessments
                 (id, company_id, subject_kind, subject_id, verdict, rationale,
                  rule_set_version, as_of, blocking_count)
               VALUES ($1,$2,'funding_opportunity','359966',$3,'fixture','pr5-2026-11-05','2026-11-05',$4)`,
      [id, A, verdict, blocking]);
      made.assessments.push(id);
    };

    await insertAssessment('as-qualified', 'QUALIFIED', 0);
    ok('C12 a QUALIFIED verdict with no blockers is accepted');

    e = await refusedBy(() => insertAssessment('as-lying', 'QUALIFIED', 2));
    if (e && e.code === '23514' && e.constraint === 'eligibility_assessments_qualified_check') {
      ok('C12 a QUALIFIED verdict that admits 2 blocked gates is REFUSED by the engine');
    } else {
      bad('C12 QUALIFIED with blockers is refused',
        e ? `${e.code}/${e.constraint}` : 'ACCEPTED — the most damaging row in this schema is also the easiest to insert');
    }

    e = await refusedBy(() => insertAssessment('as-empty-block', 'NEEDS_REVIEW', 0));
    if (e && e.code === '23514' && e.constraint === 'eligibility_assessments_blocked_check') {
      ok('C12 NEEDS_REVIEW with zero blockers is refused — the verdict must name what it is waiting on');
    } else bad('C12 NEEDS_REVIEW requires a blocker', e ? `${e.code}/${e.constraint}` : 'ACCEPTED');

    e = await refusedBy(() => insertAssessment('as-badverdict', 'MAYBE', 1));
    if (e && e.code === '23514') ok('C12 an invented verdict is refused');
    else bad('C12 an invented verdict is refused', e ? `${e.code}` : 'ACCEPTED');

    await q('ALTER TABLE eligibility_assessments DROP CONSTRAINT eligibility_assessments_qualified_check');
    e = await refusedBy(() => insertAssessment('as-lying-neg', 'QUALIFIED', 2));
    if (!e) ok('C12 negative control: with the CHECK dropped the contradictory verdict lands — it is load-bearing');
    else bad('C12 negative control', `${e.code}/${e.constraint}`);
    await q(`DELETE FROM eligibility_assessments WHERE id = 'as-lying-neg'`);
    made.assessments = made.assessments.filter((x) => x !== 'as-lying-neg');
    await q(`ALTER TABLE eligibility_assessments ADD CONSTRAINT eligibility_assessments_qualified_check
             CHECK (verdict <> 'QUALIFIED' OR blocking_count = 0)`);

    // ── C13 one finding per criterion, and every finding has a reason ────
    const insertFinding = async (id, assessment, key, reason = 'fixture reason long enough') => {
      await q(`INSERT INTO eligibility_findings
                 (id, company_id, assessment_id, criterion_key, label, mandatory, result, reason)
               VALUES ($1,$2,$3,$4,'label',TRUE,'pass',$5)`, [id, A, assessment, key, reason]);
      made.findings.push(id);
    };
    await insertFinding('f-1', 'as-qualified', 'sam_registration');
    ok('C13 a finding with a reason is accepted');

    e = await refusedBy(() => insertFinding('f-dup', 'as-qualified', 'sam_registration'));
    if (e && e.code === '23505' && /idx_ef_one_per_criterion/.test(e.constraint || e.message)) {
      ok('C13 the same criterion twice on one assessment is refused — a report over it would pick one silently');
    } else bad('C13 one finding per criterion', e ? `${e.code}/${e.constraint}` : 'ACCEPTED');

    for (const blank of ['', '   ']) {
      e = await refusedBy(() => insertFinding(`f-blank-${blank.length}`, 'as-qualified', `k${blank.length}`, blank));
      if (e && e.code === '23514' && e.constraint === 'eligibility_findings_reason_check') {
        ok(`C13 a finding whose reason is ${JSON.stringify(blank)} is refused — §6 requires a reason`);
      } else bad('C13 a blank reason is refused', e ? `${e.code}/${e.constraint}` : 'ACCEPTED');
    }

    // ── C14 'verified' is unreachable without the evidence that justifies it ──
    const insertCap = async (id, over = {}) => {
      const r = {
        kind: 'accreditation', code: `ISO-${id}`, name: 'ISO/IEC 17025',
        responsible_entity: 'Abiozen LLC', verification_status: 'planned',
        evidence_source: null, verified_at: null, verified_by: null, approval_id: null,
        valid_from: null, valid_to: null, ...over,
      };
      await q(`INSERT INTO verified_capabilities
                 (id, company_id, kind, code, name, responsible_entity, verification_status,
                  evidence_source, verified_at, verified_by, approval_id, valid_from, valid_to)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, A, r.kind, r.code, r.name, r.responsible_entity, r.verification_status,
        r.evidence_source, r.verified_at, r.verified_by, r.approval_id, r.valid_from, r.valid_to]);
      made.caps.push(id);
    };

    await insertCap('cap-planned');
    ok('C14 a PLANNED capability can be recorded with no evidence — so aspirations are filed as plans');

    const FULL = {
      verification_status: 'verified', evidence_source: 'A2LA cert 1234.01',
      verified_at: '2026-01-15T00:00:00Z', verified_by: 'naren@abiozen.com',
      approval_id: 'appr-1', valid_from: '2026-01-01', valid_to: '2027-12-31',
    };
    await insertCap('cap-verified', FULL);
    ok('C14 a VERIFIED capability with evidence, verifier, date and approval is accepted');

    // Each of the four requirements, dropped one at a time, must break it.
    for (const [field, value] of [['evidence_source', null], ['evidence_source', '   '],
      ['verified_at', null], ['verified_by', null], ['approval_id', null], ['valid_from', null]]) {
      e = await refusedBy(() => insertCap(`cap-no-${field}-${String(value).length}`,
        { ...FULL, [field]: value }));
      if (e && e.code === '23514' && e.constraint === 'verified_capabilities_verified_requires_evidence') {
        ok(`C14 'verified' without ${field} is refused — planned cannot be promoted by one column`);
      } else {
        bad(`C14 'verified' requires ${field}`,
          e ? `${e.code}/${e.constraint}` : 'ACCEPTED — a certification could be asserted with no evidence');
      }
    }

    e = await refusedBy(() => q(
      `UPDATE verified_capabilities SET verification_status = 'verified' WHERE id = 'cap-planned'`));
    if (e && e.code === '23514' && e.constraint === 'verified_capabilities_verified_requires_evidence') {
      ok('C14 a planned row cannot be promoted by UPDATE either — the CHECK fires on the write, not the insert');
    } else bad('C14 promotion by UPDATE is refused', e ? `${e.code}/${e.constraint}` : 'ACCEPTED');

    e = await refusedBy(() => insertCap('cap-badstatus', { verification_status: 'approved' }));
    if (e && e.code === '23514') ok('C14 a status outside the five is refused ("approved" reads like a pass and is not one)');
    else bad('C14 an invented status is refused', e ? `${e.code}` : 'ACCEPTED');

    e = await refusedBy(() => insertCap('cap-badwindow', { ...FULL, valid_from: '2027-01-01', valid_to: '2026-01-01' }));
    if (e && e.code === '23514' && e.constraint === 'verified_capabilities_window_check') {
      ok('C14 a validity window that ends before it starts is refused');
    } else bad('C14 an impossible window is refused', e ? `${e.code}/${e.constraint}` : 'ACCEPTED');

    await q('ALTER TABLE verified_capabilities DROP CONSTRAINT verified_capabilities_verified_requires_evidence');
    e = await refusedBy(() => insertCap('cap-neg', { verification_status: 'verified' }));
    if (!e) ok('C14 negative control: with the CHECK dropped an evidence-free "verified" row lands — it is load-bearing');
    else bad('C14 negative control', `${e.code}/${e.constraint}`);
    await q(`DELETE FROM verified_capabilities WHERE id = 'cap-neg'`);
    made.caps = made.caps.filter((x) => x !== 'cap-neg');
    await q(`ALTER TABLE verified_capabilities ADD CONSTRAINT verified_capabilities_verified_requires_evidence
             CHECK (verification_status <> 'verified' OR (
               evidence_source IS NOT NULL AND length(btrim(evidence_source)) > 0
               AND verified_at IS NOT NULL
               AND verified_by IS NOT NULL AND length(btrim(verified_by)) > 0
               AND approval_id IS NOT NULL AND length(btrim(approval_id)) > 0
               AND valid_from IS NOT NULL))`);

    // ── C15 two entities may each hold the same code; scope is per-method ──
    e = await refusedBy(() => insertCap('cap-cro360', { ...FULL, code: 'ISO-cap-verified', responsible_entity: 'CRO360' }));
    if (!e) ok('C15 CRO360 may hold its own copy of the same code — they are not interchangeable');
    else bad('C15 two entities may each hold the same code', `${e.code}/${e.constraint}`);

    e = await refusedBy(() => insertCap('cap-dupe', { ...FULL, code: 'ISO-cap-verified', responsible_entity: 'Abiozen LLC' }));
    if (e && e.code === '23505' && /idx_vc_natural_key/.test(e.constraint || e.message)) {
      ok('C15 the same code twice for one entity is refused');
    } else bad('C15 one row per code per entity', e ? `${e.code}/${e.constraint}` : 'ACCEPTED');

    const insertScope = async (id, cap, kind, value) => {
      await q(`INSERT INTO capability_scope_items (id, company_id, capability_id, scope_kind, scope_value)
               VALUES ($1,$2,$3,$4,$5)`, [id, A, cap, kind, value]);
      made.scopes.push(id);
    };
    await insertScope('sc-1', 'cap-verified', 'method', 'USP <621> HPLC assay');
    ok('C15 a scope item is accepted');

    e = await refusedBy(() => insertScope('sc-dupe', 'cap-verified', 'method', 'USP <621> HPLC assay'));
    if (e && e.code === '23505') ok('C15 a duplicate scope item is refused');
    else bad('C15 duplicate scope refused', e ? `${e.code}` : 'ACCEPTED');

    for (const bad2 of [['vibes', 'x'], ['method', '   ']]) {
      e = await refusedBy(() => insertScope(`sc-bad-${bad2[0]}`, 'cap-verified', bad2[0], bad2[1]));
      if (e && e.code === '23514') ok(`C15 scope ${JSON.stringify(bad2)} is refused`);
      else bad(`C15 scope ${JSON.stringify(bad2)} refused`, e ? `${e.code}` : 'ACCEPTED');
    }

    // Deleting a capability must not orphan its scope — a scope row pointing at nothing would read
    // as an unscoped claim, which is the general permission this design refuses to make.
    await insertCap('cap-temp', FULL);
    await insertScope('sc-temp', 'cap-temp', 'method', 'temp method');
    await q(`DELETE FROM verified_capabilities WHERE id = 'cap-temp' AND company_id = $1`, [A]);
    made.caps = made.caps.filter((x) => x !== 'cap-temp');
    const { rows: orphan } = await q(`SELECT COUNT(*)::int n FROM capability_scope_items WHERE id = 'sc-temp'`);
    if (orphan[0].n === 0) {
      ok('C15 deleting a capability cascades its scope — no orphan that would read as an unscoped claim');
      made.scopes = made.scopes.filter((x) => x !== 'sc-temp');
    } else bad('C15 scope cascades on delete', `${orphan[0].n} orphan(s)`);

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
    // Ruling 2 authorized PR-4 ahead of PR-3, so grants_gov joins usaspending. Asserted exactly:
    // "at least these" would let a future source switch itself on unnoticed.
    if (active.sort().join(',') === 'grants_gov,usaspending') {
      ok('C7 exactly grants_gov and usaspending are seeded active (rulings 2 and 7)');
    } else bad('C7 exactly the two authorized sources are active', `active = ${active.join(', ')}`);

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
    for (const id of made.scopes) await q('DELETE FROM capability_scope_items WHERE id = $1', [id]);
    for (const id of made.caps) await q('DELETE FROM verified_capabilities WHERE id = $1', [id]);
    for (const id of made.findings) await q('DELETE FROM eligibility_findings WHERE id = $1', [id]);
    for (const id of made.assessments) await q('DELETE FROM eligibility_assessments WHERE id = $1', [id]);
    for (const id of made.vers) await q('DELETE FROM funding_opportunity_versions WHERE id = $1', [id]);
    for (const id of made.opps) await q('DELETE FROM funding_opportunities WHERE id = $1', [id]);
    for (const id of made.awards) await q('DELETE FROM federal_awards WHERE id = $1', [id]);
    for (const id of made.syncs) await q('DELETE FROM source_sync_runs WHERE id = $1', [id]);
    for (const id of made.runs) await q('DELETE FROM agent_runs WHERE run_id = $1', [id]);
    for (const id of made.companies) await q('DELETE FROM companies WHERE id = $1', [id]);

    // Assert MY FIXTURES ARE GONE. Never that a table is empty — that is a statement which becomes
    // false the moment the product is used, and when it starts failing the obvious fix is to widen
    // the DELETE.
    const leaks = [];
    for (const [t, col, ids] of [
      ['capability_scope_items', 'id', made.scopes],
      ['verified_capabilities', 'id', made.caps],
      ['eligibility_findings', 'id', made.findings],
      ['eligibility_assessments', 'id', made.assessments],
      ['funding_opportunity_versions', 'id', made.vers],
      ['funding_opportunities', 'id', made.opps],
      ['federal_awards', 'id', made.awards],
      ['source_sync_runs', 'id', made.syncs],
      ['agent_runs', 'run_id::text', made.runs],
      ['companies', 'id', made.companies],
    ]) {
      if (!ids.length) continue;
      const { rows } = await q(`SELECT COUNT(*)::int n FROM ${t} WHERE ${col} = ANY($1)`, [ids]);
      if (rows[0].n) leaks.push(`${t}: ${rows[0].n}`);
    }
    const totalMade = Object.values(made).reduce((n, a) => n + a.length, 0);
    if (!leaks.length) ok(`cleanup: all ${totalMade} fixtures removed by id, none leaked`);
    else bad('cleanup left fixtures behind', leaks.join('; '));

    // ── the documented rollback, actually executed ───────────────────────
    await q('DROP TABLE IF EXISTS review_tasks');
    await q('DROP TABLE IF EXISTS capability_scope_items');
    await q('DROP TABLE IF EXISTS verified_capabilities');
    await q('DROP TABLE IF EXISTS eligibility_findings');
    await q('DROP TABLE IF EXISTS eligibility_assessments');
    await q('DROP TABLE IF EXISTS funding_opportunity_versions');
    await q('DROP TABLE IF EXISTS funding_opportunities');
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
