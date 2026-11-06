#!/usr/bin/env node
// ── THE FEDERAL CONTRACTS PAGE, PHOTOGRAPHED AGAINST THE REAL STACK ──────────
//
//   node scripts/screenshot-prpa-tracker.js [outDir]
//
// Ruling 27 item 2 asks for a dashboard. This proves the dashboard RENDERS, with real data, by
// opening it in a real browser and photographing it.
//
// ── NO STUBS, DELIBERATELY ───────────────────────────────────────────────────
//
// scripts/screenshot-prpa-page.js serves public/ with a stubbed API, which is the right trade for
// the older page. This one runs the whole stack instead: a disposable Postgres cluster, the
// migrator, the real routers, a real JWT, and the committed SAM.gov records imported through the
// real endpoint. A screenshot of stubbed JSON proves the HTML renders; this proves the PRODUCT
// renders, including the staleness banner, the empty-registry warning and the unconfirmed-field
// markers — every one of which is computed server-side from real rows.
//
// It also fails on a console error. A page that throws on load still photographs: the 2026-09-30
// outage was a blank SPA behind a green /health, and a screenshot of a page that rendered nothing
// would have looked fine in a report.
//
// Exit status is the verdict. 3 = could not execute.

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Client } = require('pg');
const { pgBinCandidates, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const OUT = process.argv[2]
  || '/tmp/claude-0/-home-claude/a0303f00-5fe1-5ee7-be5c-5412f357070f/scratchpad/prpa-shots';
const PGPORT = process.env.SHOT_PGPORT || '55447';
const APPPORT = Number(process.env.SHOT_PORT || 5601);

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };

let temp = null;
function startCluster() {
  const dir = pgBinCandidates()[0];
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/prpa-shot-');
  const asPostgres = process.getuid && process.getuid() === 0;
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, encoding: 'utf8', stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p ${PGPORT} -c listen_addresses=' start -w`);
  } catch (e) { console.error(`  (cluster start failed: ${e.message})`); return null; }
  temp = { base, dir, asPostgres };
  return base;
}
function stopCluster() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch { /* going away anyway */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch { /* temp dir */ }
}

async function main() {
  console.log(`\n${'─'.repeat(78)}\nFEDERAL CONTRACTS — SCREENSHOT AGAINST THE REAL STACK\n${'─'.repeat(78)}`);

  let chromium;
  try { ({ chromium } = require('playwright')); } catch {
    console.log('\nSKIP  playwright is not available. This proved NOTHING.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }
  const base = startCluster();
  if (!base) { console.log('\nSKIP  no PostgreSQL toolchain. This proved NOTHING.\n'); process.exit(EXIT_NOT_EXECUTED); }

  const ownerUrl = `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable`;
  process.env.DATABASE_URL = ownerUrl;
  process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
  process.env.PRPA_COMPANY_SLUG = 'abiozen';
  process.env.ADMIN_EMAIL = 'shot-fixture@example.invalid';
  process.env.ADMIN_PASSWORD = `fixture-only-${Date.now()}`;
  process.env.NODE_ENV = 'test';

  fs.mkdirSync(OUT, { recursive: true });
  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  const oq = (sql, p) => owner.query(sql, p);

  let server = null; let browser = null;
  try {
    const mig = await require('../src/lib/migrate-all').runAll(oq, { seeds: false, log: () => {} });
    if (!mig.ok) { bad('migrations failed', mig.failed.map((f) => f.error).join(' | ')); throw new Error('stop'); }
    ok(`${mig.steps.length} migration step(s) applied`);

    // Serve public/ AND the real API from one origin, as the deployed app does.
    const express = require('express');
    const { authMiddleware, signToken } = require('../src/lib/core');
    const app = express();
    app.use(express.json({ limit: '8mb' }));
    app.use('/api', authMiddleware);
    app.use('/api', require('../src/api/routes'));
    app.use('/api', require('../src/api/prpa.routes'));
    app.use(express.static(path.join(__dirname, '..', 'public')));
    server = await new Promise((r) => { const s = app.listen(APPPORT, '127.0.0.1', () => r(s)); });
    ok(`serving the real app on 127.0.0.1:${APPPORT}`);

    const admin = (await oq(`SELECT id, email, role FROM users WHERE role IN ('admin','super_admin') LIMIT 1`)).rows[0];
    const token = signToken(admin);

    // Import and assess through the real endpoints, so the page shows what the product produces.
    const csv = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sam-opportunities-real-2026-11-06.csv'), 'utf8');
    const post = (p, body) => new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port: APPPORT, path: p, method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') })); });
      req.on('error', reject); req.write(payload); req.end();
    });
    const imp = await post('/api/prpa/tracker/import/csv', { csv, sourceDetail: 'fixtures/sam-opportunities-real-2026-11-06.csv' });
    if (imp.status !== 200) { bad(`import failed (${imp.status})`, imp.body.slice(0, 200)); throw new Error('stop'); }
    ok(`imported ${JSON.parse(imp.body).inserted} real notice(s)`);
    await post('/api/prpa/tracker/assess', {});

    // Confirm one deadline and record one decision, so the screenshot shows the states a reviewer
    // will actually see rather than a board on which nothing has happened.
    const rows = (await oq(
      `SELECT id FROM federal_opportunities
        WHERE company_id = (SELECT id FROM companies WHERE slug='abiozen')
          AND is_current AND response_deadline IS NOT NULL
        ORDER BY response_deadline LIMIT 1`)).rows;
    if (rows.length) {
      await post(`/api/prpa/tracker/opportunities/${rows[0].id}/confirm-deadline`, {});
      await post(`/api/prpa/tracker/opportunities/${rows[0].id}/review`, {
        decision: 'no_bid',
        rationale: 'No verified capability and no supplier quote exists for this requirement.',
      });
      ok('one deadline confirmed and one NO-BID recorded, so those states are visible');
    }

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });

    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    // A bare "Failed to load resource: 500" names neither the URL nor the reason, which is useless
    // for fixing it. The response hook records both.
    const failedRequests = [];
    page.on('response', async (r) => {
      if (r.status() < 400) return;
      let body = '';
      try { body = (await r.text()).slice(0, 180); } catch { body = '(unreadable)'; }
      failedRequests.push(`${r.status()} ${r.url().replace(`http://127.0.0.1:${APPPORT}`, '')} :: ${body}`);
    });

    // The token goes into localStorage under the key the SPA reads, before any script runs.
    await page.addInitScript((t) => { localStorage.setItem('pbo_token', t); }, token);
    await page.goto(`http://127.0.0.1:${APPPORT}/`, { waitUntil: 'networkidle' });

    // navigate() is the SPA's own router — the same function every sidebar onclick calls.
    const nav = await page.evaluate(async () => {
      if (typeof window.navigate !== 'function') return 'navigate() is not reachable';
      await window.navigate('prpa-tracker');
      return 'ok';
    });
    if (nav === 'ok') ok('navigate("prpa-tracker") is reachable and ran');
    else bad(nav);

    await page.waitForTimeout(2500);

    // What must be ON the page. Asserted against rendered text, because "it photographed" is not
    // "it worked" — a page that threw mid-render still produces an image.
    const text = await page.evaluate(() => document.getElementById('content').innerText);
    const checks = [
      [/DEVELOPMENT DATASET/i, 'the staleness banner is shown'],
      [/CAPABILITY REGISTRY IS EMPTY/i, 'the empty-registry warning is shown'],
      [/Federal contracts/i, 'the page title rendered'],
      [/Export to Excel/i, 'the export button is present'],
      [/unconfirmed/i, 'unconfirmed deadlines are marked as such'],
      [/NO-BID/i, 'the recorded human decision appears'],
    ];
    for (const [re, label] of checks) {
      if (re.test(text)) ok(label);
      else bad(`${label} — NOT FOUND in the rendered page`);
    }
    const rowCount = await page.evaluate(() => document.querySelectorAll('#prpa-table tbody tr').length);
    if (rowCount > 0) ok(`${rowCount} opportunity row(s) rendered in the table`);
    else bad('the table rendered no rows');

    await page.screenshot({ path: path.join(OUT, 'prpa-tracker-board.png'), fullPage: true });
    ok(`board → ${path.join(OUT, 'prpa-tracker-board.png')}`);

    // The detail view, which is where the evidence and the decision controls live.
    const opened = await page.evaluate(async () => {
      const a = document.querySelector('#prpa-table tbody tr a');
      if (!a) return 'no row link';
      a.click();
      return 'ok';
    });
    if (opened === 'ok') {
      await page.waitForTimeout(2000);
      const dtext = await page.evaluate(() => {
        const d = document.getElementById('prpa-detail');
        return d ? d.innerText : '';
      });
      if (/Fulfilment checks/i.test(dtext)) ok('the detail view shows the seven fulfilment checks');
      else bad('the detail view did not render its checks');
      if (/recorded only/i.test(dtext)) ok('…and states that a decision is recorded, never submitted');
      else bad('the detail view does not say a decision is only recorded');
      await page.screenshot({ path: path.join(OUT, 'prpa-tracker-detail.png'), fullPage: true });
      ok(`detail → ${path.join(OUT, 'prpa-tracker-detail.png')}`);
    } else bad(`could not open a row: ${opened}`);

    if (failedRequests.length) {
      console.log('\n  failing requests:');
      for (const f of failedRequests) console.log(`      ${f}`);
    }
    if (!errors.length) ok('no page errors and no console errors');
    else bad(`${errors.length} page/console error(s)`, failedRequests.join('\n          ') || errors.slice(0, 4).join(' | '));
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((r) => server.close(r));
    try { await owner.end(); } catch { /* closing */ }
    stopCluster();
  }

  console.log(`\n${'─'.repeat(78)}\n  ${pass} assertion(s) passed · ${fail} failed`);
  if (fail) { console.log('\nFAIL  the page does not render as claimed.\n'); process.exit(1); }
  console.log('\nPASS  the dashboard renders real data, with its provenance and its warnings.\n');
  process.exit(0);
}

main().catch((e) => { console.error(`\nscreenshot-prpa-tracker: ${e.stack || e.message}\n`); stopCluster(); process.exit(1); });
