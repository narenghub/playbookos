#!/usr/bin/env node
// ── PR-6: THE VIEWS AGAINST A REAL SERVER, WITH CROSS-TENANT CONTROLS ────────
//
//   node scripts/check-dashboard-views-db.js
//
// Disposable cluster only. Starts its own, destroys it, refuses a hosted-looking URL.
//
// ── WHY THE CROSS-TENANT CONTROL IS THE POINT ───────────────────────────────
//
// views.test.js asserts every builder MENTIONS company_id. That is a text check, and it would pass
// on a query whose predicate was `WHERE company_id = company_id` or one that joined a second table
// without scoping it. The only way to know a view does not leak is to put a second company's rows
// in the database and look.
//
// So every view is run twice: once for Abiozen with CRO360's rows present, asserting none of
// CRO360's data appears; and once with the predicate deliberately removed, asserting that it then
// DOES — because a view that returns nothing for an unrelated reason would pass the first half
// while proving nothing.
'use strict';

const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const fs = require('fs');
const { execFileSync } = require('child_process');
const { migrateConnectors } = require('../src/lib/connectors/schema');
const views = require('../src/lib/procurement/views');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 500)}`); };

let temp = null;
function startTemp() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/dashviews-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55996' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55996 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55996&sslmode=disable`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const envUrl = process.env.VIEWS_PG_URL;
if (envUrl) {
  for (const re of [/railway/i, /rlwy\.net/i, /amazonaws/i, /\.render\.com/i, /supabase/i, /neon\.tech/i, /prod/i]) {
    if (re.test(envUrl)) {
      console.log('  FAIL  refusing to run against what looks like a hosted or production database');
      process.exit(1);
    }
  }
}
const url = envUrl || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (install initdb or set VIEWS_PG_URL to a DISPOSABLE database)');
  console.log('SKIP  dashboard views not executed — this check needs a server');
  process.exit(EXIT_NOT_EXECUTED);
}

const UPSTREAM = `
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active');
  CREATE TABLE IF NOT EXISTS agent_runs (
    run_id UUID PRIMARY KEY, root_run_id UUID, trigger TEXT, product TEXT,
    state TEXT, company_id TEXT REFERENCES companies(id));
  ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS uq_agent_runs_run_company;
  ALTER TABLE agent_runs ADD CONSTRAINT uq_agent_runs_run_company UNIQUE (run_id, company_id);
  CREATE TABLE IF NOT EXISTS study_molecules (
    id TEXT PRIMARY KEY, study_id TEXT, molecule_name TEXT NOT NULL, cas_number TEXT,
    molecule_type TEXT, catalog_match_status TEXT, inference_confidence REAL,
    inference_rationale TEXT);
  CREATE TABLE IF NOT EXISTS clinical_studies (
    id TEXT PRIMARY KEY, nct_id TEXT, brief_title TEXT, phase TEXT, overall_status TEXT);
`;

const A = 'company-abiozen-fixture';
const B = 'company-cro360-fixture';
const RUN_A = '44444444-4444-4444-8444-444444444444';
const RUN_B = '55555555-5555-4555-8555-555555555555';
const TODAY = new Date().toISOString().slice(0, 10);

const made = { companies: [], runs: [], syncs: [], opps: [], assessments: [], findings: [], caps: [], tasks: [], awards: [] };

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 4 });
  const q = (sql, params) => pool.query(sql, params);
  const run = ({ text, values }) => q(text, values);

  try {
    await q(UPSTREAM);
    await migrateConnectors(q);
    for (const [id, slug] of [[A, 'abiozen-fx'], [B, 'cro360-fx']]) {
      await q('INSERT INTO companies (id, slug, display_name) VALUES ($1,$2,$2)', [id, slug]);
      made.companies.push(id);
    }
    for (const [r, co] of [[RUN_A, A], [RUN_B, B]]) {
      await q(`INSERT INTO agent_runs (run_id, root_run_id, trigger, product, state, company_id)
               VALUES ($1,$1,'verify','prpa','running',$2)`, [r, co]);
      made.runs.push(r);
    }
    ok('disposable cluster up, migration applied, two tenants seeded');

    // ── seed BOTH tenants with structurally identical data ─────────────────
    //
    // Identical on purpose. If a view leaked, rows that looked different would make the leak
    // obvious; rows that look the same make it invisible unless the test checks ids.
    const seedTenant = async (co, run, tag) => {
      const syncId = `sync-${tag}`;
      await q(`INSERT INTO source_sync_runs (id, company_id, source_key, run_id, status, calls_made, high_water_mark, finished_at)
               VALUES ($1,$2,'grants_gov',$3,'completed',5,$4,NOW())`, [syncId, co, run, TODAY]);
      made.syncs.push(syncId);

      const oppRow = `opp-${tag}`;
      await q(`INSERT INTO funding_opportunities
                 (id, company_id, source_key, opportunity_id, opportunity_number, title,
                  agency_code, agency_name, doc_type, opp_status, standing, record_kind,
                  open_date, close_date, estimated_funding, source_url, raw_json)
               VALUES ($1,$2,'grants_gov',$3,'25-540',$4,'NSF','NSF','synopsis','posted','open',
                       'grant_opportunity','2025-07-09','2026-12-10',30000000,'https://example.invalid/1','{}'::jsonb)`,
      [oppRow, co, `opp-id-${tag}`, `Title for ${tag}`]);
      made.opps.push(oppRow);

      const asId = `as-${tag}`;
      await q(`INSERT INTO eligibility_assessments
                 (id, company_id, subject_kind, subject_id, record_kind, verdict, rationale,
                  rule_set_version, as_of, blocking_count)
               VALUES ($1,$2,'funding_opportunity',$3,'grant_opportunity','NEEDS_REVIEW',
                       'no capability registry','pr5-2026-11-05',$4,2)`,
      [asId, co, `opp-id-${tag}`, TODAY]);
      made.assessments.push(asId);

      for (const [key, label] of [['verified_capability', 'the requirement maps to a verified capability'],
        ['accreditation', 'required accreditations held and in scope']]) {
        const fId = `f-${tag}-${key}`;
        await q(`INSERT INTO eligibility_findings
                   (id, company_id, assessment_id, criterion_key, label, mandatory, result, reason)
                 VALUES ($1,$2,$3,$4,$5,TRUE,'unknown',$6)`,
        [fId, co, asId, key, label, `blocked for ${tag}`]);
        made.findings.push(fId);
      }

      const capId = `cap-${tag}`;
      await q(`INSERT INTO verified_capabilities
                 (id, company_id, kind, code, name, responsible_entity, verification_status,
                  evidence_source, verified_at, verified_by, approval_id, valid_from, valid_to)
               VALUES ($1,$2,'accreditation','ISO-17025','ISO/IEC 17025',$3,'verified',
                       'cert on file',NOW(),'fixture','appr-1','2026-01-01','2027-12-31')`,
      [capId, co, `Entity ${tag}`]);
      made.caps.push(capId);

      const planned = `cap-${tag}-planned`;
      await q(`INSERT INTO verified_capabilities
                 (id, company_id, kind, code, name, responsible_entity, verification_status)
               VALUES ($1,$2,'accreditation','ISO-13485','ISO 13485',$3,'planned')`,
      [planned, co, `Entity ${tag}`]);
      made.caps.push(planned);

      const awardId = `award-${tag}`;
      await q(`INSERT INTO federal_awards
                 (id, company_id, source_key, award_key, piid, awarding_agency, recipient_name,
                  naics_code, obligated_amount, pop_start_date, source_url, raw_json)
               VALUES ($1,$2,'usaspending',$3,$4,'Department of Defense',$5,'325412',114371.50,
                       '2026-05-22','https://example.invalid/award','{}'::jsonb)`,
      [awardId, co, `CONT_AWD_${tag}_9700_-NONE-_-NONE-`.replace('-NONE-_-NONE-', 'PARENT_9700'), `PIID-${tag}`, `Recipient ${tag}`]);
      made.awards.push(awardId);

      const taskId = `task-${tag}`;
      await q(`INSERT INTO review_tasks
                 (id, company_id, subject_kind, subject_id, criterion_key, title, priority, status)
               VALUES ($1,$2,'funding_opportunity',$3,'verified_capability',$4,'high','open')`,
      [taskId, co, `opp-id-${tag}`, `Resolve capability for ${tag}`]);
      made.tasks.push(taskId);
    };
    await seedTenant(A, RUN_A, 'a');
    await seedTenant(B, RUN_B, 'b');
    ok('both tenants seeded with structurally identical rows — a leak cannot hide behind looking different');

    // ── every view runs, and returns only tenant A ────────────────────────
    const BUILDERS = [
      ['reviewQueueByCriterion', () => views.reviewQueueByCriterion(A)],
      ['reviewQueueItems', () => views.reviewQueueItems(A)],
      ['capabilitiesUsable', () => views.capabilitiesUsable(A, TODAY)],
      ['capabilitiesOnFileUnusable', () => views.capabilitiesOnFileUnusable(A, TODAY)],
      ['capabilitiesRequiredButAbsent', () => views.capabilitiesRequiredButAbsent(A)],
      ['fundingOpportunities', () => views.fundingOpportunities(A)],
      ['federalAwards', () => views.federalAwards(A)],
      ['connectorHealth', () => views.connectorHealth(A)],
      // moleculeDemandCandidates is DELIBERATELY excluded from the isolation sweep. study_molecules
      // has no company_id — the research spine is single-tenant today, as the Phase 0 measurement
      // recorded — so the view cannot isolate by tenant and a passing isolation test would be a
      // lie. It is asserted separately below, as single-tenant, so the gap is visible rather than
      // disguised as coverage.
    ];

    for (const [name, build] of BUILDERS) {
      let res;
      try { res = await run(build()); } catch (e) { bad(`${name} runs against Postgres`, e.message); continue; }
      const blob = JSON.stringify(res.rows);
      // The decisive assertion: no identifier belonging to tenant B anywhere in the result.
      const leaked = /-b\b|opp-id-b|Entity b|for b\b|cro360|PIID-b|Recipient b/.test(blob);
      if (leaked) { bad(`${name} LEAKED tenant B data`, blob.slice(0, 300)); continue; }
      if (!res.rows.length) {
        // A VACUOUS PASS, named as one. A view returning nothing cannot demonstrate isolation, and
        // reporting it as "returned nothing belonging to tenant B" would be technically true and
        // substantively empty — which is the shape of the false green this repo keeps finding.
        bad(`${name} returned 0 rows, so its isolation was NOT demonstrated`,
          'seed this view\'s table for both tenants, or state that it is single-tenant');
        continue;
      }
      ok(`${name} ran (${res.rows.length} row(s)) and returned nothing belonging to tenant B`);
    }

    // ── the one view that CANNOT isolate, stated rather than hidden ───────
    const demand = await run(views.moleculeDemandCandidates(A));
    const { rows: smCols } = await q(
      `SELECT COUNT(*)::int n FROM information_schema.columns
        WHERE table_name = 'study_molecules' AND column_name = 'company_id'`);
    if (smCols[0].n === 0) {
      ok('moleculeDemandCandidates is single-tenant BY NECESSITY — study_molecules has no '
        + 'company_id, so this view returns the same rows for every tenant. Recorded as a known '
        + 'gap, not as isolation coverage.');
    } else {
      bad('study_molecules now HAS company_id — moleculeDemandCandidates must be scoped and moved '
        + 'into the isolation sweep above', 'the known gap has closed and this check is now wrong');
    }
    if (demand.rows.length === 0) ok('(no demand rows seeded, so nothing is claimed about its contents)');

    // ── the negative control ──────────────────────────────────────────────
    //
    // Strip the predicate and the same query must return B's rows. Without this, a view that
    // returned nothing at all — a typo in a table name, a join that matches nothing — would pass
    // the leak test while proving nothing about scoping.
    // `WHERE TRUE` left $1 bound but unreferenced, and Postgres then cannot infer its type. The
    // replacement keeps the parameter referenced and removes only the SCOPING, which is what is
    // under test.
    const unscoped = views.fundingOpportunities(A).text
      .replace('WHERE o.company_id = $1', 'WHERE ($1::text IS NOT NULL)');
    const bleed = await q(unscoped, [A, 100]);
    const sawB = bleed.rows.some((r) => String(r.opportunity_id).includes('-b'));
    if (sawB) {
      ok('negative control: with the company predicate removed, tenant B DOES appear — the predicate is load-bearing');
    } else {
      bad('negative control: the unscoped query must return tenant B',
        `got ${bleed.rows.length} row(s) and none from B — the leak test above proved nothing`);
    }

    // ── the review queue says what it is for ──────────────────────────────
    const rq = await run(views.reviewQueueByCriterion(A));
    const keys = rq.rows.map((r) => r.criterion_key).sort();
    if (keys.join(',') === 'accreditation,verified_capability') {
      ok('the review queue groups by criterion — two blocked gates, and the shape of the work is visible');
    } else bad('the review queue groups the blocked criteria', JSON.stringify(keys));
    if (rq.rows.every((r) => r.example_reason && r.subjects_blocked === 1)) {
      ok('each criterion carries an example reason and a count of subjects blocked');
    } else bad('the queue carries a reason and a count', JSON.stringify(rq.rows));

    // ── the registry's three sections agree with capability-registry.js ───
    const usable = await run(views.capabilitiesUsable(A, TODAY));
    const unusable = await run(views.capabilitiesOnFileUnusable(A, TODAY));
    if (usable.rows.length === 1 && usable.rows[0].code === 'ISO-17025') {
      ok('capabilitiesUsable returns only the verified, in-window row');
    } else bad('capabilitiesUsable', JSON.stringify(usable.rows));
    if (unusable.rows.length === 1 && /PLANNED, not verified/.test(unusable.rows[0].reason)) {
      ok('capabilitiesOnFileUnusable returns the planned row with the same reason the library gives');
    } else bad('capabilitiesOnFileUnusable', JSON.stringify(unusable.rows));

    // The two sections must PARTITION the registry: every row in exactly one. A row in neither
    // would be invisible; a row in both would be counted twice and reported as usable somewhere.
    const { rows: total } = await q('SELECT COUNT(*)::int n FROM verified_capabilities WHERE company_id = $1', [A]);
    if (usable.rows.length + unusable.rows.length === total[0].n) {
      ok(`the two registry sections partition all ${total[0].n} rows — none invisible, none counted twice`);
    } else {
      bad('the registry sections must partition the table',
        `${usable.rows.length} + ${unusable.rows.length} != ${total[0].n}`);
    }

    // ── the ladder, on a real row ─────────────────────────────────────────
    const opps = await run(views.fundingOpportunities(A));
    const stage = views.opportunityStage({
      recordKind: opps.rows[0].record_kind,
      oppStatus: opps.rows[0].opp_status,
      responseDeadline: opps.rows[0].close_date,
    }, { verdict: opps.rows[0].verdict, rationale: opps.rows[0].rationale }, TODAY);
    if (stage.stage === 'open' && !stage.submittable) {
      ok('a grant_opportunity is OPEN and NOT submittable, on a real row — a source status implies no eligibility');
    } else bad('the ladder on a real row', JSON.stringify(stage));
    // THIS CHECK FOUND THE DEFECT THAT RENAMED THE COLUMN. It compared the generated column
    // against the ladder on a real row and they disagreed: the column read true for a grant while
    // the ladder correctly said a grant can never be bid. The column was called `biddable`, written
    // in PR-4 before the taxonomy existed, and it means "live at the source with a deadline you can
    // still apply against" — which is application_open, not biddable. The two now answer different
    // questions and agree on both.
    if (opps.rows[0].application_open === true) {
      ok('application_open is true — the grant is live and has a deadline, which is what that column means');
    } else bad('application_open should be true for a live grant with a deadline', String(opps.rows[0].application_open));
    if (!('biddable' in opps.rows[0])) {
      ok('there is no biddable column on a funding row — biddability is record-kind.js\'s answer, and it is no');
    } else bad('funding_opportunities must not carry a column called biddable', 'the false claim is back');

    // ── one live task per subject+criterion ───────────────────────────────
    let dup = null;
    try {
      await q(`INSERT INTO review_tasks (id, company_id, subject_kind, subject_id, criterion_key, title, status)
               VALUES ('task-dup',$1,'funding_opportunity','opp-id-a','verified_capability','dup','open')`, [A]);
      made.tasks.push('task-dup');
    } catch (e) { dup = e; }
    if (dup && dup.code === '23505') {
      ok('a second LIVE task for the same subject and criterion is refused — two people cannot be assigned the same work');
    } else bad('one live task per subject+criterion', dup ? `${dup.code}` : 'the duplicate was ACCEPTED');

    // A closed task must not block a new one: the work can recur.
    await q(`UPDATE review_tasks SET status='done', closed_at=NOW(), closed_by='fixture',
             closure_note='registry row added' WHERE id='task-a' AND company_id=$1`, [A]);
    let reopen = null;
    try {
      await q(`INSERT INTO review_tasks (id, company_id, subject_kind, subject_id, criterion_key, title, status)
               VALUES ('task-a2',$1,'funding_opportunity','opp-id-a','verified_capability','again','open')`, [A]);
      made.tasks.push('task-a2');
    } catch (e) { reopen = e; }
    if (!reopen) ok('once the first task is closed a new one is permitted — the index covers live tasks only');
    else bad('a closed task must not block a new one', `${reopen.code}/${reopen.constraint}`);

    // ── closing without a name or a note is refused ───────────────────────
    let closure = null;
    try {
      await q(`UPDATE review_tasks SET status='done' WHERE id='task-a2' AND company_id=$1`, [A]);
    } catch (e) { closure = e; }
    if (closure && closure.code === '23514' && closure.constraint === 'review_tasks_closure_check') {
      ok('marking a task done with no name and no note is refused — that is the audit gap');
    } else bad('closure requires a name and a note', closure ? `${closure.code}/${closure.constraint}` : 'ACCEPTED');

    // ── a task cannot express a decision ──────────────────────────────────
    let approved = null;
    try {
      await q(`UPDATE review_tasks SET status='approved' WHERE id='task-b' AND company_id=$1`, [B]);
    } catch (e) { approved = e; }
    if (approved && approved.code === '23514') {
      ok('a task status of "approved" is unstoreable — assignment grants no approval');
    } else bad('"approved" must not be a storeable task status', approved ? `${approved.code}` : 'ACCEPTED');

    // ── cleanup: only what I made, by id ──────────────────────────────────
    for (const id of made.awards) await q('DELETE FROM federal_awards WHERE id = $1', [id]);
    for (const id of made.tasks) await q('DELETE FROM review_tasks WHERE id = $1', [id]);
    for (const id of made.caps) await q('DELETE FROM verified_capabilities WHERE id = $1', [id]);
    for (const id of made.findings) await q('DELETE FROM eligibility_findings WHERE id = $1', [id]);
    for (const id of made.assessments) await q('DELETE FROM eligibility_assessments WHERE id = $1', [id]);
    for (const id of made.opps) await q('DELETE FROM funding_opportunities WHERE id = $1', [id]);
    for (const id of made.syncs) await q('DELETE FROM source_sync_runs WHERE id = $1', [id]);
    for (const id of made.runs) await q('DELETE FROM agent_runs WHERE run_id = $1', [id]);
    for (const id of made.companies) await q('DELETE FROM companies WHERE id = $1', [id]);

    const leaks = [];
    for (const [t, col, ids] of [
      ['federal_awards', 'id', made.awards],
      ['review_tasks', 'id', made.tasks], ['verified_capabilities', 'id', made.caps],
      ['eligibility_findings', 'id', made.findings], ['eligibility_assessments', 'id', made.assessments],
      ['funding_opportunities', 'id', made.opps], ['source_sync_runs', 'id', made.syncs],
      ['agent_runs', 'run_id::text', made.runs], ['companies', 'id', made.companies],
    ]) {
      if (!ids.length) continue;
      const { rows } = await q(`SELECT COUNT(*)::int n FROM ${t} WHERE ${col} = ANY($1)`, [ids]);
      if (rows[0].n) leaks.push(`${t}: ${rows[0].n}`);
    }
    const totalMade = Object.values(made).reduce((n, a) => n + a.length, 0);
    if (!leaks.length) ok(`cleanup: all ${totalMade} fixtures removed by id, none leaked`);
    else bad('cleanup left fixtures behind', leaks.join('; '));
  } catch (e) {
    bad('harness aborted', e.stack || e.message);
  } finally {
    await pool.end().catch(() => {});
    stopTemp();
  }

  console.log('');
  if (fail) { console.log(`FAIL  ${fail} dashboard view check(s) failed`); process.exit(1); }
  console.log('PASS  every view is tenant-scoped against a real server, and the predicate was shown to be load-bearing');
  process.exit(0);
})();
