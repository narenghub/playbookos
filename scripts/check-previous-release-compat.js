#!/usr/bin/env node
// ── DOES THE CURRENTLY DEPLOYED RELEASE STILL RUN ON THE MIGRATED SCHEMA? ────
//
//   node scripts/check-previous-release-compat.js [ref]        (default: origin/main)
//   echo $?
//
// Ruling 32 gate 3: "Verify that the previous application release remains operational against the
// migrated schema."
//
// ── WHY THIS IS THE ROLLBACK QUESTION ────────────────────────────────────────
//
// Every rollback plan in this repository says the same thing: the migration is additive, so
// recovering from a bad deploy means redeploying the previous image, not touching the database.
// That sentence has been written in three documents and tested in none of them.
//
// If it is wrong, it is wrong at the worst possible moment — production is broken, the migration
// has already run, and the recovery procedure does not work. So this boots the ACTUAL deployed
// release against a database the NEW migrator has migrated, and asks whether it serves.
//
// ── IT ALSO TESTS THE ROLLING DEPLOY ─────────────────────────────────────────
//
// The old release still applies its own migration chain at boot — that is the thing this release
// removes. So during a rollback the old container runs ~12 DDL migrations against the new schema.
// Whether that is harmless is not obvious, and it is asserted here rather than assumed: the schema
// is checked again afterwards, through the same readiness check the new server uses.
//
// Nothing here touches production. One disposable cluster, created and destroyed.
//
// Exit: 0 compatible · 1 not · 3 could not execute.

'use strict';

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client } = require('pg');
const { pgBinCandidates, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const REF = process.argv[2] || 'origin/main';
const PGPORT = process.env.COMPAT_PGPORT || '55465';
const APPPORT = Number(process.env.COMPAT_PORT || 5607);

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

let temp = null; let BIN = null; let worktree = null;
function sh(cmd) {
  const asPostgres = process.getuid && process.getuid() === 0;
  const withPath = `PATH=${BIN}:$PATH ${cmd}`;
  return execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(withPath)}` : withPath],
    { env: { ...process.env, PATH: `${BIN}:${process.env.PATH}` }, encoding: 'utf8', stdio: 'pipe' });
}
function startCluster() {
  BIN = pgBinCandidates()[0];
  if (!BIN) return null;
  const base = fs.mkdtempSync('/var/tmp/prpa-compat-');
  const asPostgres = process.getuid && process.getuid() === 0;
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    sh(`initdb -D ${base}/data ${INITDB_FLAGS}`);
    sh(`pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p ${PGPORT} -c listen_addresses=' start -w`);
  } catch (e) { console.error(`  (cluster start failed: ${e.message})`); return null; }
  temp = { base };
  return base;
}
function cleanup() {
  if (temp) {
    try { sh(`pg_ctl -D ${temp.base}/data -m immediate stop`); } catch { /* going away */ }
    try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch { /* temp */ }
  }
  if (worktree) {
    try { execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: path.join(__dirname, '..'), stdio: 'pipe' }); } catch { /* best effort */ }
    try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

function get(p, token) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: APPPORT, path: p, method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      timeout: 8000,
    }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.end();
  });
}

async function waitForHealth(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await get('/health');
    if (r.status === 200) return r;
    await new Promise((s) => setTimeout(s, 1000));
  }
  return null;
}

async function main() {
  h(`PREVIOUS RELEASE (${REF}) AGAINST THE MIGRATED SCHEMA`);

  const repo = path.join(__dirname, '..');
  let sha;
  try {
    sha = execFileSync('git', ['rev-parse', '--short', REF], { cwd: repo, encoding: 'utf8' }).trim();
  } catch {
    console.log(`\nSKIP  cannot resolve ${REF}. This proved NOTHING.\n`);
    process.exit(EXIT_NOT_EXECUTED);
  }
  const base = startCluster();
  if (!base) { console.log('\nSKIP  no PostgreSQL toolchain. This proved NOTHING.\n'); process.exit(EXIT_NOT_EXECUTED); }

  const url = `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable`;
  const adminEmail = 'compat-fixture@example.invalid';
  const adminPassword = require('crypto').randomBytes(18).toString('hex');
  const jwtSecret = require('crypto').randomBytes(32).toString('hex');

  let child = null;
  try {
    // ── 1. MIGRATE WITH THE NEW MIGRATOR ──────────────────────────────────────
    h('1. THE NEW MIGRATOR BUILDS THE SCHEMA');
    process.env.DATABASE_URL = url;
    process.env.ADMIN_EMAIL = adminEmail;
    process.env.ADMIN_PASSWORD = adminPassword;
    process.env.JWT_SECRET = jwtSecret;
    process.env.PRPA_COMPANY_SLUG = 'abiozen';

    const owner = new Client({ connectionString: url });
    await owner.connect();
    const q = (s, p) => owner.query(s, p);
    const mig = await require('../src/lib/migrate-all').runAll(q, { seeds: false, log: () => {} });
    if (!mig.ok) { bad('the migration failed', mig.failed.map((f) => f.error).join(' | ')); throw new Error('stop'); }
    ok(`${mig.steps.length} step(s) applied`);

    const before = (await q(`SELECT COUNT(*)::int n FROM pg_tables WHERE schemaname='public'`)).rows[0].n;
    ok(`${before} table(s) present after migration`);

    // Real rows, so "it starts" is not the only thing proved.
    const T = require('../src/lib/office/opportunity-tracker');
    const CO = (await q(`SELECT id FROM companies WHERE slug='abiozen'`)).rows[0].id;
    const csv = fs.readFileSync(path.join(repo, 'fixtures', 'sam-opportunities-real-2026-11-06.csv'), 'utf8');
    const imp = await T.importCsv(q, { companyId: CO, importedBy: 'compat', csvText: csv, sourceDetail: 'compat fixture' });
    ok(`${imp.outcome.inserted.length} opportunity row(s) imported into the migrated schema`);
    await owner.end();

    // ── 2. CHECK OUT THE DEPLOYED RELEASE ─────────────────────────────────────
    h(`2. THE DEPLOYED RELEASE — ${REF} (${sha})`);
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'prpa-prev-'));
    fs.rmSync(worktree, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'add', '--detach', worktree, REF], { cwd: repo, stdio: 'pipe' });
    ok(`checked out into a worktree`);

    // Its own node_modules would be a fresh install of the same package.json; symlinking the
    // repository's is faster and is what a redeployed image would effectively have.
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(worktree, 'node_modules'));

    const prevBoot = fs.readFileSync(path.join(worktree, 'server.js'), 'utf8').split('\n')[2] || '';
    if (/initDB\(\)\.then/.test(prevBoot)) {
      ok('it still migrates at boot — so this also tests ~12 DDL migrations re-run over the new schema');
    } else {
      ok('it does not migrate at boot');
    }

    // ── 3. BOOT IT ────────────────────────────────────────────────────────────
    h('3. DOES IT START, AND DOES IT SERVE?');
    child = spawn(process.execPath, ['server.js'], {
      cwd: worktree,
      env: {
        ...process.env,
        DATABASE_URL: url,
        JWT_SECRET: jwtSecret,
        ADMIN_EMAIL: adminEmail,
        ADMIN_PASSWORD: adminPassword,
        PORT: String(APPPORT),
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs = [];
    child.stdout.on('data', (d) => logs.push(d.toString()));
    child.stderr.on('data', (d) => logs.push(d.toString()));
    let exited = null;
    child.on('exit', (code) => { exited = code; });

    const health = await waitForHealth();
    if (exited !== null) {
      bad(`the previous release EXITED with code ${exited} instead of starting`,
        logs.join('').split('\n').filter(Boolean).slice(-6).join(' | ').slice(0, 400));
      throw new Error('stop');
    }
    if (!health) {
      bad('the previous release never answered /health within 60s',
        logs.join('').split('\n').filter(Boolean).slice(-6).join(' | ').slice(0, 400));
      throw new Error('stop');
    }
    ok(`/health answered 200: ${health.body.slice(0, 80)}`);
    let hj = null; try { hj = JSON.parse(health.body); } catch { /* not json */ }
    if (hj && hj.db === 'connected') ok('…and reports the database connected');
    else bad('/health does not report the database connected', health.body.slice(0, 120));

    // It must actually serve the application, not just a health endpoint. That distinction is the
    // whole of the 2026-09-30 outage.
    const anon = await get('/api/auth/me');
    if (anon.status === 401 || anon.status === 403) ok(`/api/auth/me 401s anonymously (${anon.status})`);
    else bad(`/api/auth/me returned ${anon.status} for an anonymous request`);

    const spa = await get('/');
    if (spa.status === 200 && /<title>|checkAuth/.test(spa.body)) ok('the SPA is served');
    else bad(`the SPA did not render (status ${spa.status})`);

    // ── 4. DID ITS BOOT MIGRATIONS DAMAGE THE NEW SCHEMA? ─────────────────────
    h('4. AFTER THE OLD RELEASE RAN ITS OWN MIGRATIONS OVER THE NEW SCHEMA');
    const after = new Client({ connectionString: url });
    await after.connect();
    const aq = (s, p) => after.query(s, p);
    const nowTables = (await aq(`SELECT COUNT(*)::int n FROM pg_tables WHERE schemaname='public'`)).rows[0].n;
    if (nowTables >= before) ok(`${nowTables} table(s) — none lost (was ${before})`);
    else bad(`table count fell from ${before} to ${nowTables}`);

    const ready = await require('../src/lib/schema-ready').check(aq);
    if (ready.ready) ok('the schema still passes the NEW release\'s readiness check — a roll-forward still works');
    else bad('the old release left the schema unable to start the new one', JSON.stringify(ready));

    const opps = (await aq(`SELECT COUNT(*)::int n FROM federal_opportunities`)).rows[0].n;
    if (opps === imp.outcome.inserted.length) ok(`all ${opps} PRPA row(s) survived the old release booting over them`);
    else bad(`PRPA rows changed: ${imp.outcome.inserted.length} → ${opps}`);

    const auditOk = (await aq(`SELECT to_regclass('public.opportunity_audit_events') IS NOT NULL AS p`)).rows[0].p;
    if (auditOk) ok('the PRPA tables are untouched by the old release');
    else bad('a PRPA table disappeared');
    await after.end();
  } catch (e) {
    if (!/^stop$/.test(e.message)) bad('the check could not complete', e.message.split('\n')[0]);
  } finally {
    if (child && child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    cleanup();
  }

  console.log(`\n${'─'.repeat(78)}`);
  console.log(`  ${pass} assertion(s) passed · ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  the previous release does NOT run against the migrated schema.');
    console.log('      The rollback plan in every deployment document is "redeploy the previous');
    console.log('      image". That plan does not work, and it must be fixed before release.\n');
    process.exit(1);
  }
  console.log('\nPASS  the deployed release starts, serves, and leaves the new schema intact.');
  console.log('      Rollback by redeploying the previous image is a working recovery path.\n');
  process.exit(0);
}

main().catch((e) => { console.error(`\ncheck-previous-release-compat: ${e.stack || e.message}\n`); cleanup(); process.exit(1); });
