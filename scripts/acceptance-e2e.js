#!/usr/bin/env node
'use strict';
// ── MINIMUM END-TO-END ACCEPTANCE TEST ──────────────────────────────────────
//
// Ruling 8 item 5: one real solicitation through source ingestion, deduplication, amendment
// detection, eligibility assessment, capability evidence, dashboard display and owner review.
// Ruling 8 item 7: demonstrate the dashboard against the ACTUAL backend, in an isolated
// environment, rather than against stubbed data.
//
// ── WHY THIS EXISTS, STATED PLAINLY ─────────────────────────────────────────
//
// Preflight was 52/52 and the dashboard passed 26 UI assertions, and NONE OF THE FIVE PRPA
// ENDPOINTS HAD EVER RETURNED A 200. Every one answered HTTP 500 the first time a real request
// reached it. The UI tests ran against stubbed responses, so they proved the page could render a
// shape nobody had ever received. That is the precise gap between "the checks pass" and "the
// product works", and this script exists to close it: it stands up the real server against a real
// database, drives the real endpoints with a real token, and looks at the real page.
//
// ── WHAT IS REAL HERE AND WHAT IS NOT ───────────────────────────────────────
//
// REAL: the server (server.js, full boot chain), the schema (the real migrations), the ingestion
// path (sync-run.js, the same functions a scheduled sync calls), the qualification engine, the
// HTTP endpoints, the JWT, and the browser.
//
// REAL BUT NOT SAM.GOV: the ingested record is a LIVE Grants.gov opportunity, fetched over the
// network at run time. The ruling asks for a SAM.gov solicitation; SAM.gov requires an api_key
// that does not exist, and obtaining it is the authorization still outstanding. Grants.gov is a
// real federal source with no key, so the pipeline is exercised with a genuinely real record
// rather than a fabricated one — and every stage below says which of the two it is proving.
//
// The SAM-specific leg (sam-gov.js amendment detection) is exercised against its own fixtures in
// stage 3 and labelled as such. Its field names remain unverified until a key exists; that is
// recorded, not glossed.
//
// ── ISOLATION ───────────────────────────────────────────────────────────────
//
// A disposable cluster, created and destroyed by this script. It refuses a hosted-looking URL
// outright, because it WRITES: migrations, a company, an agent run, ingested rows, a review task.
//
// Usage: node scripts/acceptance-e2e.js [--keep]
// Exit:  0 every stage passed · 1 a stage failed · 2 not executed (no Postgres)

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const PORT = 3991;
const PGPORT = 55990;
const ADMIN = { email: 'acceptance@example.invalid', password: 'AcceptanceOnly123' };
const OUT = path.join(process.cwd(), 'ui-evidence');

let fail = 0;
const stages = [];
function stage(n, title) { console.log(`\n${'─'.repeat(78)}\nSTAGE ${n} — ${title}\n${'─'.repeat(78)}`); }
const ok = (m) => { console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 600)}`); };
const note = (m) => console.log(`  note  ${m}`);
function record(name, passed) { stages.push({ name, passed }); }

let temp = null;
function startCluster() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/accept-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p ${PGPORT} -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable`;
}
function stopCluster() {
  if (!temp || process.argv.includes('--keep')) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) { /* best effort */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

if (process.env.ACCEPTANCE_PG_URL) {
  for (const re of [/railway/i, /rlwy\.net/i, /amazonaws/i, /supabase/i, /neon\.tech/i, /prod/i]) {
    if (re.test(process.env.ACCEPTANCE_PG_URL)) {
      console.log('  FAIL  refusing a hosted-looking database — this test MIGRATES and WRITES');
      process.exit(1);
    }
  }
}
const url = process.env.ACCEPTANCE_PG_URL || startCluster();
if (!url) {
  console.log('SKIP  acceptance test not executed — needs Postgres');
  process.exit(EXIT_NOT_EXECUTED);
}

function postJson(u, body) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const payload = JSON.stringify(body);
    const req = https.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'playbookos-acceptance/1.0' },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end(payload);
  });
}

async function main() {
  process.env.DATABASE_URL = url;
  process.env.JWT_SECRET = 'acceptance-only-not-a-real-secret';
  process.env.ADMIN_EMAIL = ADMIN.email;
  process.env.ADMIN_PASSWORD = ADMIN.password;
  fs.mkdirSync(OUT, { recursive: true });

  const db = require('../src/lib/db');
  const { migrateOffice } = require('../src/lib/office/schema');
  const { migrateConnectors } = require('../src/lib/connectors/schema');
  const { resolveCompanyContext } = require('../src/lib/office/context');
  const grants = require('../src/lib/connectors/grants-gov');
  const sync = require('../src/lib/connectors/sync-run');
  const sam = require('../src/lib/connectors/sam-gov');
  const { assess } = require('../src/lib/procurement/qualify');
  const { biddability } = require('../src/lib/procurement/record-kind');

  // ── STAGE 0: schema, VIA THE REAL BOOT CHAIN ─────────────────────────────
  //
  // The first version of this stage called the migrations itself, in the order I assumed, and
  // failed: migrateOffice ALTERs agent_runs, which migrateRuns creates, and server.js runs them in
  // that order. Reimplementing a boot sequence is how a test ends up proving something the product
  // never does — so the product's own boot is what runs here, and the test asserts the result.
  stage(0, 'SCHEMA — the REAL boot chain, on an empty database');
  let s0 = true;
  let bootServer = null;
  try {
    bootServer = spawn('node', ['server.js'], {
      env: {
        ...process.env, DATABASE_URL: url, PORT: String(PORT), NODE_ENV: 'development',
        JWT_SECRET: process.env.JWT_SECRET, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
      },
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bootLog = '';
    bootServer.stdout.on('data', (d) => { bootLog += d; });
    bootServer.stderr.on('data', (d) => { bootLog += d; });

    let healthy = false;
    for (let i = 0; i < 120; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) { healthy = true; break; } } catch (_) { /* wait */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!healthy) { bad('the real server never became healthy on a clean database', bootLog); s0 = false; } else {
      ok('server answered /health on a clean database');
      // /health proves the LISTENER bound, not that boot finished. The boot chain ends in
      // process.exit(1) on any failure and used to reach it AFTER app.listen — so the server
      // answered /health and then died. Waiting is the whole assertion.
      await new Promise((r) => setTimeout(r, 10000));
      if (bootServer.exitCode === null) {
        ok('STILL ALIVE 10s later — the full boot chain completed, not merely the listener');
      } else {
        bad(`the server EXITED ${bootServer.exitCode} after answering /health — boot did not complete`, bootLog);
        s0 = false;
      }
      if (/DB init error|CRITICAL/.test(bootLog)) {
        bad('the boot log contains an init error or CRITICAL line', bootLog.split('\n').filter((l) => /DB init error|CRITICAL/.test(l)).join(' | '));
        s0 = false;
      } else ok('no DB init error and no CRITICAL line in the boot log');
    }

    // migrateConnectors is NOT in server.js's boot chain, so the 12 PRPA tables do not exist after
    // a real boot. Applied here explicitly — and that gap is a release blocker in its own right,
    // not a quirk of this script.
    await migrateConnectors(db.query);
    note('migrateConnectors was applied by THIS SCRIPT. It is absent from server.js\'s boot chain, '
      + 'so a real deployment creates NONE of the 12 PRPA tables.');

    const { rows } = await db.query(
      "SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public'");
    ok(`${rows[0].n} tables created on a clean database`);

    for (const t of ['companies', 'source_connectors', 'funding_opportunities', 'solicitations',
      'solicitation_amendments', 'verified_capabilities', 'review_tasks', 'supplier_outreach_log']) {
      const r = await db.query(
        "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1) p", [t]);
      if (r.rows[0].p) ok(`${t} present`);
      else { bad(`${t} MISSING after migration`); s0 = false; }
    }
    // migrateConnectors is NOT in server.js's boot chain. Applied explicitly here, and that gap
    // is itself a release blocker rather than an incidental detail of this script.
    note('migrateConnectors is applied by THIS SCRIPT. It is not in server.js\'s boot chain, so a '
      + 'real deploy creates none of the 12 PRPA tables — see the readiness matrix.');
  } catch (e) { bad('schema stage threw', e.message); s0 = false; }
  record('0 schema', s0);

  // ── STAGE 0b: company + write context ────────────────────────────────────
  stage('0b', 'COMPANY AND WRITE CONTEXT — derived, never supplied');
  let ctx = null; let s0b = true;
  try {
    await db.query(
      `INSERT INTO companies (id, slug, display_name, status) VALUES ('co_accept','abiozen','Abiozen LLC','active')
       ON CONFLICT (id) DO NOTHING`);

    // AN OBJECTIVE IS REQUIRED, and that is the kernel working rather than a fixture problem.
    // agent_runs carries a composite MATCH FULL foreign key on (objective_id, company_id): a run
    // may have neither, or both, but never a company without an objective. So agent work cannot
    // be attributed to a company without also being attributed to a stated objective of that
    // company — which is the governance property K2 exists to provide, discovered here by
    // violating it.
    await db.query(
      `INSERT INTO objectives (id, company_id, objective, priority, autonomy_tier, approval_policy, status, created_by)
       VALUES ('obj_accept','co_accept','Acceptance test objective','P1','supervised','all_consequential','draft','acceptance')
       ON CONFLICT (id) DO NOTHING`);
    // Columns taken from src/lib/runs.js, not guessed: run_id is a UUID, root_run_id and product
    // and trigger and state are NOT NULL, and there is no agent_name / status / started_at.
    const runId = '11111111-1111-4111-8111-111111111111';
    await db.query(
      `INSERT INTO agent_runs (run_id, root_run_id, trigger, product, agent, state, company_id, objective_id)
       VALUES ($1,$1,'manual','abiozen','acceptance','RUNNING','co_accept','obj_accept')
       ON CONFLICT (run_id) DO NOTHING`, [runId]);
    // The INGESTION path uses a RUN-derived context, not the read-session resolver. A read session
    // may never be handed to a kernel writer, and using the right one here is part of the test.
    ctx = await resolveCompanyContext({ runId });
    ok(`write context resolved from run ${runId.slice(0, 8)}… → company ${ctx.companyId}`);
  } catch (e) { bad('could not establish a write context', e.message); s0b = false; }
  record('0b company context', s0b);
  if (!ctx) { return finish(); }

  // ── STAGE 1: SOURCE INGESTION, over the network, through the real path ───
  stage(1, 'SOURCE INGESTION — a LIVE federal record through sync-run.js');
  let s1 = true; let ingested = null; let syncId = null;
  try {
    const res = await postJson(grants.SEARCH_URL, { keyword: 'pharmaceutical', rows: 5 });
    const hits = (res && res.data && res.data.oppHits) || [];
    if (!hits.length) { bad('the live source returned no records — cannot run the acceptance test'); s1 = false; } else {
      ok(`fetched ${hits.length} LIVE record(s) from ${grants.SEARCH_URL}`);
      const normalized = hits.map((hhit) => grants.normalizeSearchHit(hhit, { companyId: ctx.companyId }));
      const usable = normalized.filter((n) => !n.skip);
      ok(`${usable.length} normalised, ${normalized.length - usable.length} skipped for a missing natural key`);

      const begun = await sync.beginSync(ctx, { sourceKey: 'grants_gov', runId: '11111111-1111-4111-8111-111111111111' });
      syncId = begun.syncId || begun.id || begun;
      await sync.chargeCalls(ctx, syncId, 1);
      const up = await sync.upsertFundingOpportunities(ctx, syncId, normalized);
      await sync.completeSync(ctx, syncId, { highWaterMark: new Date().toISOString().slice(0, 10) });
      ok(`ingested: ${up.inserted} inserted, ${up.updated} updated`);

      const { rows } = await db.query(
        'SELECT opportunity_id, title, close_date, doc_type, opp_status, application_open FROM funding_opportunities WHERE company_id=$1 ORDER BY opportunity_id',
        [ctx.companyId]);
      ingested = rows[0];
      if (rows.length) ok(`${rows.length} row(s) stored; first: ${String(ingested.title).slice(0, 60)}`);
      else { bad('nothing was stored'); s1 = false; }
    }
  } catch (e) { bad('ingestion stage threw', e.message); s1 = false; }
  record('1 ingestion', s1);

  // ── STAGE 2: DEDUPLICATION ───────────────────────────────────────────────
  stage(2, 'DEDUPLICATION — the same records again must not duplicate');
  let s2 = true;
  try {
    const before = (await db.query('SELECT COUNT(*)::int n FROM funding_opportunities WHERE company_id=$1', [ctx.companyId])).rows[0].n;
    const res = await postJson(grants.SEARCH_URL, { keyword: 'pharmaceutical', rows: 5 });
    const hits = (res && res.data && res.data.oppHits) || [];
    const normalized = hits.map((hhit) => grants.normalizeSearchHit(hhit, { companyId: ctx.companyId }));
    const s = await sync.beginSync(ctx, { sourceKey: 'grants_gov', runId: '11111111-1111-4111-8111-111111111111' });
    const sid2 = s.syncId || s.id || s;
    await sync.chargeCalls(ctx, sid2, 1);
    const up2 = await sync.upsertFundingOpportunities(ctx, sid2, normalized);
    await sync.completeSync(ctx, sid2, { highWaterMark: new Date().toISOString().slice(0, 10) });
    const after = (await db.query('SELECT COUNT(*)::int n FROM funding_opportunities WHERE company_id=$1', [ctx.companyId])).rows[0].n;
    if (after === before) ok(`row count unchanged at ${after} — ON CONFLICT dedupe held (${up2.updated} updated, ${up2.inserted} inserted)`);
    else { bad(`duplicates created: ${before} → ${after}`); s2 = false; }
    if (up2.inserted === 0) ok('the second pass inserted nothing, as it must');
    else { bad(`${up2.inserted} row(s) inserted on a repeat of identical input`); s2 = false; }
  } catch (e) { bad('dedupe stage threw', e.message); s2 = false; }
  record('2 deduplication', s2);

  // ── STAGE 3: AMENDMENT DETECTION ─────────────────────────────────────────
  stage(3, 'AMENDMENT DETECTION — a changed deadline must be noticed and ranked');
  let s3 = true;
  try {
    // SAM-SPECIFIC LEG. SAM.gov returns only the latest version of a notice, so an amendment is
    // DETECTED by diffing polls rather than read from a history. Exercised here against the
    // connector's own normaliser. The field NAMES remain unverified until a key exists.
    const first = sam.normalizeNotice({
      noticeId: 'ACCEPT-1', type: 'Solicitation', baseType: 'Sources Sought',
      responseDeadLine: '2026-12-01T17:00:00Z', active: 'Yes', title: 'API supply',
    });
    const second = sam.normalizeNotice({
      noticeId: 'ACCEPT-1', type: 'Solicitation', baseType: 'Sources Sought',
      responseDeadLine: '2026-11-10T17:00:00Z', active: 'Yes', title: 'API supply',
    });
    const amend = sam.detectAmendment(first, second);
    if (amend.amended && amend.significance === 'deadline_moved') {
      ok(`deadline move detected and ranked: ${amend.changes[0].from} → ${amend.changes[0].to}`);
    } else { bad('a moved deadline was not detected as such', JSON.stringify(amend)); s3 = false; }

    const div = sam.typeDiverged(second);
    if (div.diverged) ok('type divergence detected on a single snapshot (Sources Sought → Solicitation)');
    else { bad('the base/current type transition was missed'); s3 = false; }

    // Persist it, through the real table and its constraints.
    await db.query(
      `INSERT INTO solicitations (id, company_id, source_key, notice_id, record_kind, active, response_deadline, raw_json)
       VALUES ('sol_accept',$1,'sam_gov','ACCEPT-1','solicitation',TRUE,'2026-11-10T17:00:00Z','{}'::jsonb)`,
      [ctx.companyId]);
    await db.query(
      `INSERT INTO solicitation_amendments
         (id, company_id, solicitation_id, notice_id, significance, changed_fields, previous_values, new_values)
       VALUES ('amd_accept',$1,'sol_accept','ACCEPT-1',$2,$3,'{}'::jsonb,'{}'::jsonb)`,
      [ctx.companyId, amend.significance, amend.changes.map((c) => c.field)]);
    const open = (await db.query("SELECT response_open FROM solicitations WHERE id='sol_accept'")).rows[0];
    ok(`amendment persisted; response_open computed by the server as ${open.response_open}`);
    note('SAM leg only: these field names come from documentation, not from a live response.');
  } catch (e) { bad('amendment stage threw', e.message); s3 = false; }
  record('3 amendment detection', s3);

  // ── STAGE 4: ELIGIBILITY ASSESSMENT ──────────────────────────────────────
  stage(4, 'ELIGIBILITY ASSESSMENT — on the record that was actually ingested');
  let s4 = true;
  try {
    const asOf = new Date().toISOString().slice(0, 10);
    const rec = {
      recordKind: ingested && ingested.doc_type === 'forecast' ? 'forecast' : 'grant_opportunity',
      responseDeadline: ingested && ingested.close_date ? new Date(ingested.close_date).toISOString().slice(0, 10) : null,
      sourceUrl: 'https://www.grants.gov/',
    };
    const verdict = assess({ record: rec, asOf });
    const b = biddability(rec);
    ok(`verdict: ${verdict.verdict} (record kind ${rec.recordKind}, biddable ${b.biddable})`);
    const blockers = (verdict.findings || []).filter((f) => f.result === 'fail');
    for (const f of blockers.slice(0, 2)) ok(`  blocker: ${f.criterion_key} — ${String(f.reason).slice(0, 90)}`);
    if (verdict.verdict === 'NOT_QUALIFIED' && blockers.some((f) => f.criterion_key === 'record_kind_biddable')) {
      ok('a grant is correctly NOT_QUALIFIED on a category error, not on a data gap');
    } else if (verdict.verdict === 'NEEDS_REVIEW') {
      ok('NEEDS_REVIEW — a data gap, which is the right answer when evidence is absent');
    } else { bad(`unexpected verdict ${verdict.verdict}`); s4 = false; }
  } catch (e) { bad('eligibility stage threw', e.message); s4 = false; }
  record('4 eligibility', s4);

  // ── STAGE 5: CAPABILITY EVIDENCE ─────────────────────────────────────────
  stage(5, 'CAPABILITY EVIDENCE — an empty registry must block, not pass');
  let s5 = true;
  try {
    const n = (await db.query('SELECT COUNT(*)::int n FROM verified_capabilities WHERE company_id=$1', [ctx.companyId])).rows[0].n;
    ok(`verified_capabilities holds ${n} row(s) for this company`);
    // The constraint is the evidence: a 'verified' row without its five fields must be refused.
    let refused = null;
    try {
      // Every NOT NULL column is supplied, so the ONLY thing missing is the EVIDENCE. The first
      // version omitted `code` too and was refused by the not-null constraint instead — the
      // insert failed, the test "passed" in spirit, and it had proved nothing about evidence.
      // Asserting the specific constraint name is what caught that.
      await db.query(
        `INSERT INTO verified_capabilities
           (id, company_id, kind, code, name, responsible_entity, verification_status)
         VALUES ('cap_bad',$1,'accreditation','iso17025','ISO 17025','Abiozen Scientific','verified')`,
        [ctx.companyId]);
    } catch (e) { refused = e; }
    if (refused && /verified_requires_evidence/.test(refused.constraint || refused.message)) {
      ok('a capability claiming verified WITHOUT evidence is refused by the server');
    } else { bad('an unevidenced capability was accepted as verified', refused ? refused.message : 'ACCEPTED'); s5 = false; }
  } catch (e) { bad('capability stage threw', e.message); s5 = false; }
  record('5 capability evidence', s5);

  // ── STAGE 6: DASHBOARD AGAINST THE REAL BACKEND ──────────────────────────
  stage(6, 'DASHBOARD — the REAL server, the REAL endpoints, a REAL token');
  let s6 = true;
  const server = bootServer;   // the SAME process stage 0 booted — one server, one boot chain
  try {
    const base = `http://127.0.0.1:${PORT}`;
    const up = server && server.exitCode === null;
    if (!up) { bad('the server from stage 0 is not running'); s6 = false; } else {
      ok('using the server booted in stage 0 — no second boot, no second port');

      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ADMIN),
      });
      const token = (await login.json()).token;
      if (token) ok(`logged in through the real auth endpoint (token ${token.length} chars)`);
      else { bad('login failed'); s6 = false; }

      // THE CHECK THAT WAS NEVER RUN BEFORE.
      for (const ep of ['review-queue', 'capabilities', 'opportunities', 'connectors', 'tasks']) {
        const r = await fetch(`${base}/api/prpa/${ep}`, { headers: { Authorization: `Bearer ${token}` } });
        const body = await r.text();
        if (r.status === 200) ok(`GET /api/prpa/${ep} → 200 (${body.length} bytes)`);
        else { bad(`GET /api/prpa/${ep} → ${r.status}`, body.slice(0, 200)); s6 = false; }
      }

      // ── NEGATIVE CONTROLS OVER HTTP (ruling 9 item 5) ──────────────────
      //
      // A suite of 200s proves the happy path and nothing about the gate. Until these ran, every
      // assertion in this file was compatible with an endpoint that served anybody — which, given
      // this is a procurement pipeline with supplier pricing in it, is the failure that matters.
      for (const ep of ['opportunities', 'export/opportunities.csv']) {
        const anon = await fetch(`${base}/api/prpa/${ep}`);
        if (anon.status === 401) ok(`NEGATIVE: unauthenticated GET /api/prpa/${ep} → 401`);
        else { bad(`unauthenticated GET /api/prpa/${ep} → ${anon.status}, expected 401`); s6 = false; }

        const garbage = await fetch(`${base}/api/prpa/${ep}`, { headers: { Authorization: 'Bearer not-a-real-token' } });
        if (garbage.status === 401) ok(`NEGATIVE: forged token on /api/prpa/${ep} → 401`);
        else { bad(`forged token on /api/prpa/${ep} → ${garbage.status}, expected 401`); s6 = false; }
      }

      // A REAL non-admin user. The role is read from the DATABASE, not from the token, so a
      // hand-minted JWT would not exercise adminOnly — the user has to exist and be non-admin.
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync('SupportOnly123', 10);
      await db.query(
        `INSERT INTO users (id, email, name, role, password_hash, is_active)
         VALUES ('u_support','support@example.invalid','Support User','support_team',$1,1)
         ON CONFLICT (email) DO NOTHING`, [hash]);
      const supLogin = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'support@example.invalid', password: 'SupportOnly123' }),
      });
      const supToken = (await supLogin.json()).token;
      if (supToken) {
        for (const ep of ['opportunities', 'export/opportunities.csv']) {
          const r = await fetch(`${base}/api/prpa/${ep}`, { headers: { Authorization: `Bearer ${supToken}` } });
          if (r.status === 403) ok(`NEGATIVE: authenticated NON-ADMIN on /api/prpa/${ep} → 403`);
          else { bad(`non-admin on /api/prpa/${ep} → ${r.status}, expected 403`); s6 = false; }
        }
      } else { bad('could not log in as the non-admin fixture user — the 403 control did not run'); s6 = false; }

      // ── CSV EXPORT OVER HTTP (ruling 9 item 1) ─────────────────────────
      //
      // export.js is unit-tested, but nothing had ever fetched this endpoint. The unit tests
      // cannot see the Content-Type header, the filename, or whether the route is even wired.
      {
        // A hostile value, stored the way a source would store it, so the neutralisation is
        // proven on the REAL response body rather than on a function call.
        await db.query(
          `UPDATE funding_opportunities SET title = $1
            WHERE company_id = $2 AND opportunity_id = (
              SELECT opportunity_id FROM funding_opportunities WHERE company_id = $2 ORDER BY opportunity_id LIMIT 1)`,
          ['=cmd|\' /C calc\'!A0', ctx.companyId]);

        const r = await fetch(`${base}/api/prpa/export/opportunities.csv`, { headers: { Authorization: `Bearer ${token}` } });
        const csv = await r.text();
        if (r.status === 200) ok('GET /api/prpa/export/opportunities.csv → 200');
        else { bad(`CSV export → ${r.status}`, csv.slice(0, 200)); s6 = false; }

        const ctype = r.headers.get('content-type') || '';
        if (/text\/csv/.test(ctype)) ok(`Content-Type is ${ctype}`);
        else { bad(`Content-Type is "${ctype}", expected text/csv`); s6 = false; }

        const disp = r.headers.get('content-disposition') || '';
        if (/attachment; *filename=/.test(disp)) ok(`Content-Disposition: ${disp}`);
        else { bad(`Content-Disposition is "${disp}", expected an attachment filename`); s6 = false; }

        const header = (csv.split('\n')[0] || '');
        const required = ['source_url', 'record_kind', 'qualification_verdict', 'blocking_reasons',
          'rule_set_version', 'evaluated_as_of'];
        const missing = required.filter((c) => !header.includes(c));
        if (!missing.length) ok('every mandatory column is present in the delivered header');
        else { bad(`the delivered CSV is missing mandatory column(s): ${missing.join(', ')}`, header); s6 = false; }

        // THE INJECTION CHECK, on the wire. A cell opening with = + - @ is executed by Excel and
        // Sheets on open; the file is the attack. It must arrive neutralised, not merely be
        // neutralisable.
        if (/=cmd/.test(csv)) {
          const line = csv.split('\n').find((l) => /=cmd/.test(l)) || '';
          const idx = line.indexOf('=cmd');
          const prefix = line.slice(Math.max(0, idx - 2), idx);
          if (prefix.includes("'")) ok(`the hostile cell arrived neutralised (prefixed with an apostrophe)`);
          else { bad('a formula cell was delivered WITHOUT neutralisation', line.slice(0, 120)); s6 = false; }
        } else {
          bad('the hostile value never reached the export — the injection control did not run',
            'it proves nothing when the row it targets is absent');
          s6 = false;
        }
      }

      // ── TENANT ISOLATION OVER HTTP ─────────────────────────────────────
      //
      // The export cannot be tested by seeding a second company and checking its rows are absent,
      // because with two active companies the read-session resolver REFUSES outright. That refusal
      // IS the isolation behaviour at the HTTP layer for this release, so it is what gets asserted —
      // and asserting it here is what makes the single-company resolver's safety a measured claim
      // rather than a design intention. Row-level scoping is covered separately by
      // check-dashboard-views-db.js.
      {
        await db.query(
          `INSERT INTO companies (id, slug, display_name, status)
           VALUES ('co_second','second','Second Tenant','active') ON CONFLICT (id) DO NOTHING`);
        const r = await fetch(`${base}/api/prpa/export/opportunities.csv`, { headers: { Authorization: `Bearer ${token}` } });
        const body = await r.text();
        if (r.status !== 200 && /no user-to-company mapping|2 active companies/.test(body)) {
          ok('TENANT ISOLATION: with a second active company the export REFUSES rather than guessing');
        } else if (r.status === 200) {
          bad('with two active companies the export still returned data',
            'it cannot know whose data that is — this would be a silent cross-tenant read');
          s6 = false;
        } else {
          bad(`refused, but not for the tenancy reason: ${body.slice(0, 160)}`); s6 = false;
        }
        await db.query("DELETE FROM companies WHERE id='co_second'");
        const back = await fetch(`${base}/api/prpa/export/opportunities.csv`, { headers: { Authorization: `Bearer ${token}` } });
        if (back.status === 200) ok('and it resolves again once the ambiguity is removed');
        else { bad(`the export did not recover after removing the second company: ${back.status}`); s6 = false; }
      }

      // And the page itself, driven through the SPA's own router.
      // PLAYWRIGHT IS OPTIONAL, ON PURPOSE.
      //
      // The HTTP stages above are the substance: five endpoints, their auth gates, the CSV and its
      // injection protection. The browser adds the screenshot and the "no error banner" check,
      // which are worth having and are not worth making this script unrunnable on a machine that
      // has no Chromium. Anyone validating this on their own laptop should get the eight stages
      // that need only Node and Postgres, and a clear note about the one they are not getting —
      // rather than a stack trace that looks like the product is broken.
      let chromium = null;
      try { ({ chromium } = require('playwright')); } catch (_) { chromium = null; }
      if (!chromium) {
        note('playwright is not installed, so the browser checks are SKIPPED and no screenshot is');
        note('taken. Everything above this line still ran: the five endpoints, 401/403 controls,');
        note('the CSV export and tenant isolation were all exercised over real HTTP.');
        note('To include them: npx playwright install chromium');
      } else {
      const browser = await chromium.launch({ args: ['--no-proxy-server', '--no-sandbox'] });
      for (const v of [{ n: 'real-backend-desktop', w: 1440, h: 1000 }, { n: 'real-backend-phone', w: 390, h: 844 }]) {
        const c = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2 });
        const page = await c.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await c.addInitScript((t) => { try { localStorage.setItem('pbo_token', t); } catch (_) { /* ignore */ } }, token);
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        await page.evaluate(async () => { if (typeof window.navigate === 'function') await window.navigate('prpa-command'); });
        await page.waitForTimeout(2500);
        const file = path.join(OUT, `${v.n}.png`);
        await page.screenshot({ path: file, fullPage: true });
        const text = await page.evaluate(() => document.body.innerText || '');
        if (/Some panels could not load/.test(text)) {
          bad(`${v.n}: the page is showing its error banner against the real backend`,
            text.split('\n').slice(0, 6).join(' | '));
          s6 = false;
        } else ok(`${v.n}: rendered against the real backend with no error banner`);
        if (!errors.length) ok(`${v.n}: no page errors`);
        else { bad(`${v.n}: ${errors.length} page error(s)`, errors.join(' | ')); s6 = false; }
        console.log(`        screenshot: ${file}`);
        await c.close();
      }
      await browser.close();
      }
    }
  } catch (e) { bad('dashboard stage threw', e.message); s6 = false; } finally {
    if (server) server.kill('SIGKILL');
  }
  record('6 dashboard on real backend', s6);

  // ── STAGE 7: OWNER REVIEW ────────────────────────────────────────────────
  stage(7, 'OWNER REVIEW — assignment that grants no approval');
  let s7 = true;
  try {
    await db.query(
      `INSERT INTO review_tasks (id, company_id, subject_kind, subject_id, criterion_key, title, status, priority)
       VALUES ('rt_accept',$1,'funding_opportunity','acc-1','sam_registration','Confirm SAM registration','open','high')`,
      [ctx.companyId]);
    ok('a review task was opened against the blocking gate');
    let refused = null;
    try {
      await db.query("UPDATE review_tasks SET status='approved' WHERE id='rt_accept'");
    } catch (e) { refused = e; }
    if (refused) ok('a task cannot be moved to "approved" — assignment is not authority');
    else { bad('review_tasks accepted an approval status', 'assignment must never grant approval'); s7 = false; }
  } catch (e) { bad('owner review stage threw', e.message); s7 = false; }
  record('7 owner review', s7);

  return finish();
}

function finish() {
  console.log(`\n${'═'.repeat(78)}\nACCEPTANCE SUMMARY\n${'═'.repeat(78)}`);
  for (const s of stages) console.log(`  ${s.passed ? 'PASS' : 'FAIL'}  ${s.name}`);
  const passed = stages.filter((s) => s.passed).length;
  console.log(`\n  ${passed} of ${stages.length} stages passed.`);
  console.log('\n  SCOPE: the ingested record is a LIVE Grants.gov opportunity, not a SAM.gov');
  console.log('  solicitation — SAM.gov needs an api_key that does not exist yet. The pipeline is');
  console.log('  identical for both; only the source adapter differs, and the SAM adapter\'s field');
  console.log('  names stay unverified until that key exists.');
  console.log('');
  return fail ? 1 : 0;
}

main()
  .then((c) => { stopCluster(); process.exit(c); })
  .catch((e) => { stopCluster(); console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
