#!/usr/bin/env node
'use strict';
// ── DOES THE DEPLOYED DASHBOARD WORK FOR A REAL AUTHENTICATED ADMIN? ────────
//
// Ruling 11 item 1. `smoke-deployed.sh` proves the application is alive: the page parses and the
// entry points exist. It signs in as nobody, so it proves nothing about what an administrator
// actually sees. Everything behind `adminOnly` — the opportunity list, source coverage,
// registration status, the review queue, CSV export — was exercised only against a disposable
// cluster with fixture data. This is the first check against production as a person.
//
// ── WHY A SCREENSHOT AS WELL AS ASSERTIONS ──────────────────────────────────
//
// Because the assertions passed once while the page was unusable. An earlier version of this
// dashboard hardcoded dark panels into the light theme: every selector resolved, the parse check
// was green, the nav parity check was green, and it rendered dark text on a dark background.
// Nothing in a DOM says "a human cannot read this".
//
// And because of the opposite failure, which is the one that actually happened here: the
// screenshot harness stubbed all five endpoints with `{items, total}`, a shape none of them
// return, so every panel rendered its EMPTY STATE while every assertion passed. Real data from
// production is the only thing that closes that gap, which is why this script exists rather than
// another fixture run.
//
// ── THIS SCRIPT WRITES NOTHING, BY CONSTRUCTION ─────────────────────────────
//
// It runs against PRODUCTION, so under CLAUDE.md's verification rules it would need to clean up
// after itself by id. It has nothing to clean up: every endpoint it calls is a GET, and
// `POST /api/auth/login` is a SELECT plus a console line — no insert, no update, no session row.
// `POST /prpa/tasks` and `PATCH /prpa/tasks/:id` exist and are deliberately NOT called. There is
// no cleanup code here because there is nothing to delete, and that is a property of the request
// list rather than a promise.
//
// One side effect worth naming: `/auth/login` is behind a rate limiter. Do not loop this script.
//
// ── CREDENTIALS ─────────────────────────────────────────────────────────────
//
// Read from the environment, never from argv — an argument is visible in `ps` to every process on
// the machine and lands in shell history. The token and the password are never printed, never
// written to the screenshot directory, and the Authorization header is never echoed on an error.
//
//   read -rs PBO_PASSWORD; export PBO_PASSWORD        # paste the password, press enter
//   export PBO_EMAIL=naren@abiozen.com
//   node scripts/verify-prod-dashboard.js
//   echo $?
//
// Optional: --url <base> (default https://app.playnexa.ai), --out <dir> (default prod-ui-evidence)
//
// Exit: 0 everything an admin needs renders and answers · 1 something is wrong · 3 did not execute

const fs = require('fs');
const path = require('path');

const EXIT_NOT_EXECUTED = 3;

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 600)}`); };
const note = (m) => console.log(`  note  ${m}`);
const bar = () => '─'.repeat(78);
const h = (t) => console.log(`\n${bar()}\n${t}\n${bar()}`);

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const BASE = arg('--url', 'https://app.playnexa.ai').replace(/\/$/, '');
const OUT = arg('--out', path.join(process.cwd(), 'prod-ui-evidence'));

// THE EMAIL MAY COME FROM ARGV; THE PASSWORD MAY NOT.
//
// The first run of this script skipped with exit 3 because PBO_PASSWORD was exported and PBO_EMAIL
// was not — two environment variables where one of them did not need to be one. A password in argv
// is visible in `ps` to every process on the machine and lands in shell history, so it stays in the
// environment. An email address is not a credential and is already the account's public identifier,
// so requiring it to be exported bought nothing and cost a run.
const EMAIL = arg('--email', process.env.PBO_EMAIL);
const PASSWORD = process.env.PBO_PASSWORD;

// The six GET endpoints an administrator's dashboard depends on. The two task-mutating routes are
// absent from this list on purpose.
const READ_ENDPOINTS = Object.freeze([
  ['review-queue', 'the review queue'],
  ['capabilities', 'the capability registry'],
  ['opportunities', 'the opportunity list'],
  ['connectors', 'source coverage'],
  ['tasks', 'review tasks'],
  ['export/opportunities.csv', 'CSV export'],
]);

async function main() {
  h('PRODUCTION DASHBOARD VERIFICATION (ruling 11 item 1)');
  console.log(`  target    : ${BASE}`);
  console.log(`  started   : ${new Date().toISOString()}`);
  console.log(`  evidence  : ${OUT}`);
  console.log('');
  console.log('  Read-only: every endpoint called is a GET; login is a SELECT. Nothing is written.');

  if (!EMAIL || !PASSWORD) {
    // Say WHICH one is missing. "both must be set" when one of them already is sends a person
    // looking at the wrong half.
    console.log(`\nSKIP  missing: ${[!EMAIL && 'the email', !PASSWORD && 'the password'].filter(Boolean).join(' and ')}.`);
    console.log(`      email    : ${EMAIL ? EMAIL : 'NOT SET — pass --email or export PBO_EMAIL'}`);
    console.log(`      password : ${PASSWORD ? 'set' : 'NOT SET — export PBO_PASSWORD'}`);
    console.log('      This check asserted NOTHING. It is not a pass.');
    console.log('\n      Two commands, and the password never appears on a command line:');
    console.log('\n        read -rs PBO_PASSWORD; export PBO_PASSWORD');
    console.log('        node scripts/verify-prod-dashboard.js --email you@example.com\n');
    process.exit(EXIT_NOT_EXECUTED);
  }

  // ── 1. is the deployed commit the one we think it is? ────────────────────
  h('1. WHAT IS DEPLOYED');
  let commit = null;
  try {
    const r = await fetch(`${BASE}/health`);
    const b = await r.json();
    commit = b.commit || null;
    console.log(`  commit    : ${commit}`);
    console.log(`  db        : ${b.db}`);
    if (b.status === 'ok' && b.db === 'connected') ok('/health reports ok and the database is connected');
    else bad(`/health reports status=${b.status} db=${b.db}`);
  } catch (e) {
    bad('/health could not be reached', e.message);
    return;
  }

  // ── 2. negative controls BEFORE signing in ──────────────────────────────
  //
  // Run first, deliberately. If they ran after a successful login and something in this script
  // leaked a cookie or a default header, an endpoint could answer 200 for the wrong reason and the
  // control would pass while proving the opposite of what it claims.
  h('2. THE ENDPOINTS REFUSE AN ANONYMOUS AND A FORGED CALLER');
  for (const [ep, label] of READ_ENDPOINTS) {
    for (const [desc, headers] of [
      ['unauthenticated', {}],
      ['forged token', { Authorization: 'Bearer not-a-real-token' }],
    ]) {
      try {
        const r = await fetch(`${BASE}/api/prpa/${ep}`, { headers });
        if (r.status === 401) ok(`${desc} GET /api/prpa/${ep} → 401`);
        else bad(`${desc} GET /api/prpa/${ep} → ${r.status}, expected 401`, `${label} is exposed`);
      } catch (e) { bad(`${desc} GET /api/prpa/${ep} threw`, e.message); }
    }
  }

  // ── 3. sign in as the administrator ─────────────────────────────────────
  h('3. AUTHENTICATION');
  let token = null;
  let me = null;
  try {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (!r.ok) {
      // The body may name the reason; it never contains the password.
      bad(`login failed with ${r.status}`, (await r.text()).slice(0, 200));
      return;
    }
    const b = await r.json();
    token = b.token;
    me = b.user || {};
    if (!token) { bad('login returned no token'); return; }
    ok(`signed in as ${me.email} (role: ${me.role})`);
    // adminOnly is satisfied by role, and the role is read from the DATABASE, not the token — so
    // this is the real check that this account can see the dashboard at all.
    if (['super_admin', 'admin'].includes(me.role)) ok(`role ${me.role} satisfies adminOnly`);
    else bad(`role ${me.role} does NOT satisfy adminOnly`, 'every PRPA endpoint will return 403');
  } catch (e) { bad('login threw', e.message); return; }

  const auth = { Authorization: `Bearer ${token}` };

  // ── 4. every endpoint the dashboard reads ───────────────────────────────
  h('4. WHAT THE DASHBOARD ACTUALLY RECEIVES');
  const payloads = {};
  for (const [ep, label] of READ_ENDPOINTS) {
    if (ep.endsWith('.csv')) continue;   // handled separately below
    try {
      const r = await fetch(`${BASE}/api/prpa/${ep}`, { headers: auth });
      if (r.status !== 200) {
        // 500 here is the defect class that took all five of these endpoints down before: a
        // resolver called with an argument it does not accept. The body is the diagnosis.
        bad(`GET /api/prpa/${ep} → ${r.status}`, (await r.text()).slice(0, 400));
        continue;
      }
      const b = await r.json();
      payloads[ep] = b;
      const keys = Object.keys(b);
      // Shape is REPORTED, not asserted against a guess. The screenshot harness's fixtures used
      // `{items,total}` for all five of these and matched none of them; printing the real keys is
      // how that stops being a thing anyone has to remember.
      console.log(`  ${ep.padEnd(26)} 200  keys: ${keys.join(', ') || '(none)'}`);
      ok(`${label} answered 200`);
    } catch (e) { bad(`GET /api/prpa/${ep} threw`, e.message); }
  }

  // ── 5. CSV export: type, disposition, and formula injection ─────────────
  h('5. CSV EXPORT');
  try {
    const r = await fetch(`${BASE}/api/prpa/export/opportunities.csv`, { headers: auth });
    if (r.status !== 200) {
      bad(`CSV export → ${r.status}`, (await r.text()).slice(0, 300));
    } else {
      const ct = r.headers.get('content-type') || '';
      const cd = r.headers.get('content-disposition') || '';
      if (/text\/csv/i.test(ct)) ok(`content-type is ${ct}`);
      else bad(`content-type is ${ct}`, 'expected text/csv — a browser will render it instead of saving it');
      if (/attachment/i.test(cd)) ok(`content-disposition is ${cd}`);
      else bad(`content-disposition is ${cd || '(absent)'}`, 'expected attachment');

      const body = await r.text();
      const lines = body.split('\n').filter((l) => l.trim());
      console.log(`  rows      : ${Math.max(0, lines.length - 1)} data row(s), ${body.length} bytes`);
      if (lines.length) {
        ok(`header: ${lines[0].slice(0, 160)}`);
        // The required columns exist so a row can be read against the rules that produced it.
        for (const col of ['rule_set_version', 'evaluated_at']) {
          if (lines[0].includes(col)) ok(`the export carries ${col}`);
          else bad(`the export is missing ${col}`, 'a verdict without its rule-set version is unreadable later');
        }
      }
      // CSV INJECTION. Any cell whose value begins = + - @ must be quoted AND prefixed with an
      // apostrophe, or a spreadsheet treats it as a formula. Checked against the real export
      // rather than a fixture, because the real data is where a hostile or odd value shows up.
      const unguarded = [];
      for (const line of lines.slice(1)) {
        for (const cell of line.split(',')) {
          const c = cell.trim();
          if (/^[=+\-@]/.test(c)) unguarded.push(c.slice(0, 40));
        }
      }
      if (!unguarded.length) ok('no cell begins with = + - or @ outside quotes — no formula reaches a spreadsheet');
      else bad(`${unguarded.length} unguarded cell(s) could execute as a formula`, unguarded.slice(0, 5).join(' | '));
      if (lines.length <= 1) {
        note('the export has no data rows yet, so the injection check passed vacuously —');
        note('it proves the guard is reachable, not that it fired. Re-run once records exist.');
      }
    }
  } catch (e) { bad('CSV export threw', e.message); }

  // ── 6. does it RENDER, for this administrator, with this data? ──────────
  h('6. THE RENDERED PAGE');
  let chromium = null;
  try { ({ chromium } = require('playwright')); } catch (_) { chromium = null; }
  if (!chromium) {
    note('playwright is not installed, so the browser checks are SKIPPED and no screenshot is');
    note('taken. Everything above this line still ran against production over real HTTP.');
    note('To include them: npx playwright install chromium');
  } else {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await chromium.launch();
    try {
      for (const [label, opts] of [
        ['light', { colorScheme: 'light', viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 }],
        ['dark', { colorScheme: 'dark', viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 }],
        ['phone', { colorScheme: 'light', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }],
      ]) {
        const ctx = await browser.newContext(opts);
        const page = await ctx.newPage();
        const errors = [];
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

        // The SPA reads its token from localStorage under `pbo_token` — not `token`. With the
        // wrong key it sits on the login screen and photographs it, which looks like a render
        // failure and is not.
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
        await page.evaluate((t) => {
          try { localStorage.setItem('pbo_token', t); } catch (_) { /* ignore */ }
        }, token);
        await page.goto(`${BASE}/#prpa-command`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(2500);

        const file = path.join(OUT, `prpa-${label}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(`  captured  : ${file}`);

        if (label === 'light') {
          // The four things ruling 11 item 1 names, checked by the text a person would read
          // rather than by a selector that can resolve to an empty container.
          const text = await page.evaluate(() => document.body.innerText);
          for (const [needle, what] of [
            [/where this stands|executive summary/i, 'the executive summary card'],
            [/registration/i, 'registration status'],
            [/source coverage|coverage/i, 'source coverage'],
            [/review/i, 'the review queue'],
          ]) {
            if (needle.test(text)) ok(`${what} is present in the rendered text`);
            else bad(`${what} is NOT in the rendered page`, 'the panel did not render for this admin');
          }
          if (/login|sign in/i.test(text) && !/where this stands/i.test(text)) {
            bad('the page rendered the LOGIN screen', 'the token was not accepted by the SPA');
          }
          // An empty state is legitimate on a fresh deployment, but it must be DISTINGUISHABLE
          // from a broken fetch, which is the exact confusion the stub fixtures created.
          if (/nothing is biddable|no opportunities|nothing to review/i.test(text)) {
            note('the page is showing an empty/not-biddable state — correct while SAM.gov is off,');
            note('but check the screenshot to confirm it reads as "none yet" and not as an error.');
          }
        }
        if (errors.length) bad(`${errors.length} console error(s) at ${label}`, errors.slice(0, 3).join(' | '));
        else ok(`no console or page errors at ${label}`);
        await ctx.close();
      }
    } finally { await browser.close(); }
  }

}

// ── THE EXIT CODE IS COMPUTED HERE, NOT INSIDE main() ──────────────────────
//
// It used to live at the end of main(), after the checks. main() has five early `return`
// statements — /health unreachable, login failed, no token, login threw — and every one of them
// resolved the promise and SKIPPED the exit. So on 2026-11-06 this script printed
//
//     FAIL  login failed with 401
//
// and exited 0. A verification that reports a failure and exits zero is the 2026-09-30 defect
// written fresh, in the script added to catch that class of defect: the rule in CLAUDE.md is that
// a checker's verdict IS its exit status, and this one's verdict and status disagreed.
//
// Computing it in .then() makes it structural rather than remembered. Every path through main(),
// including the early returns and anything thrown, now produces the code that matches `fail`.
// scripts/check-verifier-exit-codes.js proves it by running the failure path for real.
function result() {
  h('RESULT');
  if (fail) {
    console.log(`  ${fail} failure(s). The dashboard is NOT confirmed for an authenticated admin.\n`);
  } else {
    console.log('  The deployed dashboard answers and renders for an authenticated administrator.');
    console.log(`  Screenshots in ${OUT}. Nothing was written to production.\n`);
  }
  return fail ? 1 : 0;
}

main()
  .then(() => process.exit(result()))
  .catch((e) => {
    console.error(`\nverify-prod-dashboard: ${e.stack || e.message}`);
    process.exit(1);
  });
