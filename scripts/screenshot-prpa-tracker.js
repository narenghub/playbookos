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
    app.use('/api', require('../src/api/decisions.routes'));
    app.use('/api', require('../src/api/spend.routes'));
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
    //
    // THE ROW MUST BE ONE THE BOARD ACTUALLY SHOWS, and picking it by SQL cannot know that.
    //
    // This used to be `ORDER BY response_deadline LIMIT 1` — the earliest deadline, which is the row
    // most likely to be EXPIRED. The board's default filter is `work`, meaning rows with no bars, and
    // a passed deadline is a bar (BAR_KINDS.DEADLINE_PASSED). So on 2026-11-07 this check went red
    // with "the recorded human decision appears — NOT FOUND in the rendered page" having changed
    // nothing: the fixture's earliest deadline is 2026-11-06T20:00, it was live the day before and
    // past the day after, and the decided row dropped out of the view being photographed.
    //
    // A check that fails by calendar is worse than no check. It would have gone red every day from
    // now on, for a page that renders correctly — and a checker whose red nobody believes is the
    // 2026-09-30 root cause, one level up.
    //
    // So the row is chosen through the API the page itself reads, by the property the page itself
    // filters on: no bars. Ranking is computed, not stored, so SQL cannot answer this.
    const get = (p) => new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: APPPORT, path: p, method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') })); });
      req.on('error', reject); req.end();
    });
    const listed = await get('/api/prpa/tracker/opportunities');
    if (listed.status !== 200) { bad(`could not list opportunities (${listed.status})`, listed.body.slice(0, 200)); throw new Error('stop'); }
    const all = JSON.parse(listed.body).opportunities || JSON.parse(listed.body);
    const unbarred = all.filter((r) => r.ranking && r.ranking.bars && r.ranking.bars.length === 0);

    // When the fixture ages out entirely, say THAT, rather than reporting the page as broken. This is
    // the difference between a failure somebody can act on and one that sends them into the renderer.
    // NOT EXERCISED: this branch is reached only when every fixture notice has aged out, and there is
    // no way to reach it here without either waiting months or giving this harness a test-only
    // override, which is its own defect. Reasoned, not proved — said plainly rather than counted as
    // coverage. The count in the ok() below is the early warning: when "N of 80 unbarred" approaches
    // zero, the fixture needs refreshing before this fires.
    if (!unbarred.length) {
      bad(`every one of the ${all.length} fixture notices is now barred — the FIXTURE has expired, the page has not`,
        'refresh fixtures/sam-opportunities-real-*.csv from SAM.gov. The board renders only unbarred '
        + 'rows by default, so there is nothing for this check to photograph.');
      throw new Error('stop');
    }

    const target = unbarred[0];
    await post(`/api/prpa/tracker/opportunities/${target.id}/confirm-deadline`, {});
    await post(`/api/prpa/tracker/opportunities/${target.id}/review`, {
      decision: 'no_bid',
      rationale: 'No verified capability and no supplier quote exists for this requirement.',
    });
    ok(`one deadline confirmed and one NO-BID recorded on an unbarred row (${unbarred.length} of ${all.length} unbarred), so those states are visible`);

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

    // ── THE DECISION QUEUE, ON THE SAME REAL STACK ───────────────────────────
    //
    // Added here rather than in its own harness because the expensive part — a disposable cluster,
    // the migrator, real routers, a real JWT and imported SAM.gov records — is already standing,
    // and the queue's largest source is this very board.
    //
    // WHY A RENDER CHECK AND NOT JUST THE ROUTE TESTS. On 2026-11-09 I changed the board's API to
    // return bid positions, reported it done, and the page had no column for them — the owner found
    // that, not me. Unit tests on the route would have passed. This opens the page.
    const navDq = await page.evaluate(async () => {
      if (typeof window.navigate !== 'function') return 'navigate() is not reachable';
      await window.navigate('decisions');
      await new Promise((r) => setTimeout(r, 2500));
      return 'ok';
    });
    if (navDq === 'ok') ok('navigate("decisions") is reachable and ran');
    else bad(`the decision queue is unreachable: ${navDq}`);

    const dq = await page.evaluate(() => document.getElementById('content').innerText);

    // The page must say what it is and that it does not act. Both are rendered from the API
    // payload, so this also proves the route answered rather than 404ing into the SPA shell.
    if (/decision/i.test(dq)) ok('the decision queue page rendered');
    else bad('the decision queue page rendered nothing recognisable');
    if (/Every decision is made on the page named/i.test(dq)) {
      ok('…and states on screen that it performs nothing');
    } else bad('the page does not state that it only shows decisions');

    // THE HEADLINE MUST NOT CLAIM CALM WITHOUT HAVING ESTABLISHED IT. On this fixture every store
    // exists, so either items are listed or all seven were read and found empty. What must NEVER
    // appear is an all-clear beside a source that failed.
    const dqApi = await page.evaluate(async () => {
      const r = await fetch('/api/decisions', {
        headers: { Authorization: `Bearer ${localStorage.getItem('pbo_token')}` },
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    });
    if (dqApi.status === 200) ok('GET /api/decisions answered 200');
    else bad(`GET /api/decisions answered ${dqApi.status}`, JSON.stringify(dqApi.body).slice(0, 300));

    if (dqApi.body && Array.isArray(dqApi.body.sources)) {
      const names = dqApi.body.sources.map((x) => x.source);
      if (names.length === 7) ok(`all seven sources reported: ${names.join(', ')}`);
      else bad(`${names.length} source(s) reported, expected 7`, names.join(', '));

      const broken = dqApi.body.sources.filter((x) => !x.ok).map((x) => x.source);
      if (!broken.length) ok('every source was readable on a freshly migrated database');
      else bad(`source(s) unreadable against a fresh migration: ${broken.join(', ')}`,
        JSON.stringify(dqApi.body.degraded).slice(0, 400));

      // The invariant, checked against the real payload rather than a unit fixture.
      const claimsCalm = /Nothing is waiting/.test(dqApi.body.headline || '');
      if (!claimsCalm || dqApi.body.complete) ok('the headline claims calm only when every source was read');
      else bad('the headline says nothing is waiting while a source could not be read',
        `headline="${dqApi.body.headline}" degraded=${JSON.stringify(dqApi.body.degraded)}`);
    } else bad('the response carries no per-source report, so a failed source would be invisible');

    await page.screenshot({ path: path.join(OUT, 'decision-queue.png'), fullPage: true });
    ok(`decision queue → ${path.join(OUT, 'decision-queue.png')}`);

    // ── AI SPEND, ON THE SAME REAL STACK ─────────────────────────────────────
    //
    // The fixture database has no spend rows, which is the MOST important case to render: an empty
    // ledger must read as "nothing recorded", never as a confident $0.00 — and a MISSING ledger
    // must not render as $0.00 at all. A page that reports zero spend when it cannot read the
    // table gives the most expensive wrong answer available to it, because it looks like good news.
    const navSp = await page.evaluate(async () => {
      if (typeof window.navigate !== 'function') return 'navigate() is not reachable';
      await window.navigate('spend');
      await new Promise((r) => setTimeout(r, 2000));
      return 'ok';
    });
    if (navSp === 'ok') ok('navigate("spend") is reachable and ran');
    else bad(`the spend page is unreachable: ${navSp}`);

    const sp = await page.evaluate(() => document.getElementById('content').innerText);
    if (/model API/i.test(sp)) ok('the spend page rendered');
    else bad('the spend page rendered nothing recognisable', sp.slice(0, 200));
    if (/does not cap it/i.test(sp)) ok('…and states that it measures rather than caps');
    else bad('the page does not say it only measures');
    if (/no calls recorded/i.test(sp)) ok('an empty ledger reads as "no calls recorded", not as a clean $0');
    else bad('an empty ledger did not state that nothing was recorded', sp.slice(0, 300));

    const spApi = await page.evaluate(async () => {
      const r = await fetch('/api/spend?days=30', {
        headers: { Authorization: `Bearer ${localStorage.getItem('pbo_token')}` },
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    });
    if (spApi.status === 200) ok('GET /api/spend answered 200');
    else bad(`GET /api/spend answered ${spApi.status}`, JSON.stringify(spApi.body).slice(0, 300));
    if (spApi.body && spApi.body.total && typeof spApi.body.total.unmeasured_calls === 'number') {
      ok('the total carries its unmeasured-call count, so a dollar figure cannot be read alone');
    } else bad('the total does not carry unmeasured_calls');

    await page.screenshot({ path: path.join(OUT, 'ai-spend.png'), fullPage: true });
    ok(`ai spend → ${path.join(OUT, 'ai-spend.png')}`);

    // ── THE FAILURE PATH, WHICH IS THE ONE THAT BROKE ────────────────────────
    //
    // Both pages shipped green here and died in production on their FIRST load, because
    // `window.API` is `fetch(...).then(r => r.json())` and does not throw on a non-2xx. A 503
    // arrived as a normal value carrying `{ error, code }`, the try/catch never fired, and the
    // renderer indexed into fields that were not there: "Cannot read properties of undefined
    // (reading 'length')" and "(reading 'usd')".
    //
    // Every assertion above exercised the HAPPY path, which is exactly why none of them caught it.
    // This substitutes an API that answers the way a real 503 does and asserts the pages render a
    // failure rather than throwing — and, for spend, that the failure is not a confident $0.00.
    const failModes = await page.evaluate(async () => {
      // STUBBED AT `fetch`, NOT AT `window.API`. The first version of this check replaced
      // window.API and changed nothing: API is a module-scoped `const` and the pages close over
      // that binding, so both pages rendered real data and the check passed against the happy
      // path it was written to avoid. The pages reach the network through the global `fetch`.
      const realFetch = window.fetch;
      const out = {};
      const errors = [];
      const onErr = (e) => errors.push(String(e.message || e));
      window.addEventListener('error', onErr);
      try {
        // Exactly the shape src/api/*.routes.js returns on a 503: no items, no total.
        window.fetch = async (url, init) => {
          const u = String(url);
          if (/\/api\/spend/.test(u)) {
            return new Response(JSON.stringify({
              error: 'the spend ledger has not been created yet — this is NOT a spend of $0',
              code: 'ledger_missing', detail: 'run: node scripts/migrate-connectors.js',
            }), { status: 503, headers: { 'Content-Type': 'application/json' } });
          }
          if (/\/api\/decisions/.test(u)) {
            return new Response(JSON.stringify({
              error: '2 active companies exist and this system has no user-to-company mapping',
              code: 'company_unresolved',
            }), { status: 503, headers: { 'Content-Type': 'application/json' } });
          }
          return realFetch(url, init);
        };

        await window.navigate('decisions');
        await new Promise((r) => setTimeout(r, 600));
        out.decisions = document.getElementById('content').innerText;

        await window.navigate('spend');
        await new Promise((r) => setTimeout(r, 600));
        out.spend = document.getElementById('content').innerText;
      } finally {
        window.fetch = realFetch;
        window.removeEventListener('error', onErr);
      }
      out.errors = errors;
      return out;
    });

    if (!failModes.errors.length) ok('neither page throws when the API answers with an error body');
    else bad(`${failModes.errors.length} error(s) thrown on the failure path`, failModes.errors.join(' | '));

    if (/could not load/i.test(failModes.decisions)) ok('the decision queue renders the server error');
    else bad('the decision queue did not render the error', failModes.decisions.slice(0, 200));
    if (/not an empty queue/i.test(failModes.decisions)) {
      ok('…and refuses to read as "nothing is waiting"');
    } else bad('the failed decision queue does not say it is not empty');
    if (/2 active companies/.test(failModes.decisions)) ok('…and shows the actual reason, not a generic message');
    else bad('the server\'s reason was swallowed', failModes.decisions.slice(0, 200));

    if (/could not be read/i.test(failModes.spend)) ok('the spend page renders the server error');
    else bad('the spend page did not render the error', failModes.spend.slice(0, 200));
    if (/not a spend of \$0/i.test(failModes.spend)) {
      ok('…and refuses to read as $0.00, which would look like good news');
    } else bad('the failed spend page does not deny a $0 reading');
    if (/migrate-connectors/.test(failModes.spend)) ok('…and carries the detail that says how to fix it');
    else bad('the fix detail was dropped', failModes.spend.slice(0, 200));

    await page.screenshot({ path: path.join(OUT, 'failure-paths.png'), fullPage: true });
    ok(`failure path → ${path.join(OUT, 'failure-paths.png')}`);

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
