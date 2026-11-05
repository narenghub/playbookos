#!/usr/bin/env node
'use strict';
// ── UI RENDERING CHECK WITH SCREENSHOTS (ruling 6 item 9) ───────────────────
//
// Serves public/index.html over a tiny static server, stubs the API, opens the Federal Pipeline
// page and photographs it in both themes and at phone width.
//
// ── WHY A SCREENSHOT AND NOT ONLY AN ASSERTION ──────────────────────────────
//
// Because the assertions already passed once while the page was unusable. The first version of
// this dashboard hardcoded dark panels into a light theme: every selector resolved, every element
// was present, the parse check was green and the nav parity check was green — and it rendered dark
// text on a dark background. Nothing in the DOM says "a human cannot read this". Only a picture
// does. So this captures images AND asserts what a picture cannot: that the page's container
// rendered, that no console or page error fired, and that the entry points exist.
//
// ── WHAT THIS PROVES, AND WHAT IT DOES NOT ──────────────────────────────────
//
// THE API IS STUBBED. These images prove RENDERING — that the inline scripts parse, that
// pages['prpa-command'] is reachable and callable, that the handler produces visible content, that
// the colours work in light and dark, and that it survives phone width. They prove NOTHING about
// API integration or real data shapes; those are covered by the endpoint tests and the
// tenant-isolation checks in preflight.
//
// Running the real server was the first approach and it does not work on a bare database: the
// server begins listening, answers /health, and then EXITS on a boot migration —
// "DB init error: relation supplier_outreach_log does not exist". The health poll saw it up and
// the browser arrived after it had gone, which is a neat illustration of why CLAUDE.md says
// /health proves the server is alive and not that the application is. That gap is a pre-existing
// condition of an empty database and is recorded, not worked around.
//
// Usage: node scripts/screenshot-prpa-page.js [outDir]
// Exit:  0 captured and clean · 1 a capture or an assertion failed

const fs = require('fs');
const path = require('path');
const http = require('http');

const OUT = process.argv[2] || path.join(process.cwd(), 'ui-evidence');
const PORT = 3977;
const ROOT = path.join(process.cwd(), 'public');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 600)}`); };

// Stub payloads shaped like the real endpoints. Deliberately include an UNKNOWN and a
// NEEDS_REVIEW, because those are the states the page must render legibly and the ones a cheerful
// fixture would leave untested.
// SHAPES TAKEN FROM routes.js, NOT INVENTED. The first version of these stubs returned
// {items, total} for all five endpoints, which matches none of them — so every panel rendered its
// EMPTY state, the screenshot showed "No opportunities ingested yet", and all the assertions passed
// anyway. A rendering check that photographs the empty state and calls it green is exactly the
// false-green this script exists to prevent, so the payloads now mirror the real keys
// (by_criterion / usable+on_file_unusable / opportunities / connectors / tasks) and there is an
// assertion below that the page rendered the DATA.
const AS_OF = '2026-11-05';
const STUBS = {
  '/api/auth/me': { user: { id: 'fixture', email: 'fixture-admin@example.invalid', role: 'super_admin', name: 'Fixture Admin' } },
  '/api/prpa/opportunities': {
    as_of: AS_OF,
    opportunities: [
      // FIELD NAMES AND STAGE VALUES TAKEN FROM routes.js AND views.js. My first fixture used
      // `agency`, `identifier`, `qualification_verdict` and stage 'OPEN'; the page reads
      // `agency_name`, `opportunity_number`, `verdict` and lowercase stages — so every cell showed
      // "unknown" and every badge said NOT OPEN, and the screenshot looked like three page bugs
      // that were really one wrong fixture. Guessing a shape twice is how a fixture ends up
      // testing itself.
      {
        id: 'o1', record_kind: 'grant_opportunity', title: 'DoW Joint Warfighter Medical Research Award',
        agency_name: 'Defense Health Agency Contracting Activity', opportunity_number: 'HT942526JWMRPMMRDA',
        close_date: '2026-11-16', source_url: 'https://www.grants.gov/search-results-detail/362857',
        opp_status: 'posted', stage: 'open', verdict: 'NOT_QUALIFIED',
        stage_reasons: { open: 'the close date is in the future', submittable: 'a grant is not biddable' },
      },
      {
        // Deliberately full of nulls. UNKNOWN is the state the page must render legibly, and a
        // cheerful fixture never exercises prpaU() — the null source_url here is what exposed the
        // href attribute escape.
        id: 'o2', record_kind: 'forecast', title: 'Forecasted API supply programme',
        agency_name: null, opportunity_number: null, close_date: null, source_url: null,
        opp_status: 'forecasted', stage: 'none', verdict: 'NEEDS_REVIEW',
        stage_reasons: { open: 'a forecast has nothing to respond to yet' },
      },
    ],
  },
  '/api/prpa/review-queue': {
    as_of: AS_OF,
    by_criterion: [
      {
        criterion_key: 'sam_registration', label: 'SAM registration',
        subjects_blocked: 2,
        example_reason: 'no SAM registration record was supplied, so registration status cannot be determined',
      },
      {
        criterion_key: 'capability_match', label: 'Capability match',
        subjects_blocked: null,
        example_reason: 'no capability registry was supplied',
      },
    ],
    items: [{ id: 'r1', title: 'Verify A2LA certificate 1234.01', status: 'open', priority: 'high', due_date: '2026-11-20', owner: null }],
  },
  '/api/prpa/capabilities': {
    as_of: AS_OF,
    usable: [],
    on_file_unusable: [
      { capability: 'ISO 9001', responsible_entity: 'Abiozen Scientific', verification_status: 'pending', valid_to: '2020-01-01', unusable_reason: 'expired' },
    ],
  },
  '/api/prpa/connectors': {
    as_of: AS_OF,
    connectors: [
      { source: 'grants.gov', status: 'read_only', last_run_at: AS_OF, mode: 'api' },
      { source: 'sam.gov', status: 'NOT_AUTHORIZED', last_run_at: null, mode: 'manual' },
    ],
  },
  '/api/prpa/tasks': {
    as_of: AS_OF,
    tasks: [{ id: 't1', title: 'Confirm filed name for CRO360', status: 'open', priority: 'high', owner: null, due_date: null }],
  },
};

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url.startsWith('/api/') || url === '/health') {
        const body = url === '/health'
          ? { status: 'ok', db: 'stubbed' }
          : (STUBS[url] || { items: [], total: 0 });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(body));
      }
      const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) { bad('public/index.html not found'); return 1; }
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${PORT}`;
  ok(`serving public/ with stubbed API on ${base}`);

  const { chromium } = require('playwright');
  // --no-proxy-server is REQUIRED, not tidiness: this container routes outbound HTTPS through an
  // agent proxy and Chromium honours those settings, so a request to 127.0.0.1 can be sent to the
  // proxy and come back ERR_CONNECTION_REFUSED while a plain fetch to the same URL answers 200.
  const browser = await chromium.launch({ args: ['--no-proxy-server', '--no-sandbox'] });
  const captured = [];

  try {
    for (const v of [
      { name: 'federal-pipeline-desktop-light', width: 1440, height: 1000, scheme: 'light' },
      { name: 'federal-pipeline-desktop-dark', width: 1440, height: 1000, scheme: 'dark' },
      { name: 'federal-pipeline-phone', width: 390, height: 844, scheme: 'light' },
    ]) {
      const ctx = await browser.newContext({
        viewport: { width: v.width, height: v.height },
        deviceScaleFactor: 2,
        colorScheme: v.scheme,
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

      // A token in localStorage puts the SPA past its auth gate without a login form whose
      // selectors are not the thing under test.
      // The key is `pbo_token`, not `token`. With the wrong key the SPA sat on its login screen and
      // this check reported "a blank page" — which was true of what it photographed and false about
      // the application.
      await ctx.addInitScript(() => {
        try { localStorage.setItem('pbo_token', 'fixture-token'); } catch (_) { /* ignore */ }
      });
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);

      // Call the SPA's own router, which is what the nav onclick does. An async handler that was
      // declared inside a block throws ReferenceError here and renders nothing — the Annex B trap
      // CLAUDE.md documents.
      // navigate() is the SPA's router and is what every nav onclick calls. `pages` and `API` are
      // top-level `const`, which does NOT create a window property — so looking for window.pages
      // found undefined and told me the router was missing when it was simply not global. A
      // `function` declaration like navigate() does become a window property, which is why this
      // works and the first attempt did not.
      const nav = await page.evaluate(async () => {
        try {
          if (typeof window.navigate === 'function') {
            await window.navigate('prpa-command');
            return 'navigate(prpa-command)';
          }
          return null;
        } catch (e) { return `THREW: ${e.message}`; }
      });
      await page.waitForTimeout(1500);

      const file = path.join(OUT, `${v.name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      captured.push(file);

      if (nav && !/^THREW/.test(nav)) ok(`${v.name}: reached the page via ${nav}`);
      else bad(`${v.name}: could not render the page`, nav || 'neither pages[] nor showPage was callable');

      const text = await page.evaluate(() => document.body.innerText || '');
      if (text.trim().length > 60) ok(`${v.name}: rendered ${text.trim().length} chars of text`);
      else bad(`${v.name}: rendered almost no text — a blank page`, text);

      // THE DATA ASSERTION. Character count alone passed while every panel showed its empty state,
      // because the stubs had the wrong shape and the page fell back to "No opportunities ingested
      // yet". So require content that can ONLY come from the stub payload, and refuse the page if
      // an empty-state string is still showing.
      const marker = 'DoW Joint Warfighter';
      if (text.includes(marker)) ok(`${v.name}: rendered stub DATA, not the empty state`);
      else bad(`${v.name}: the page is showing its empty state — the stubs are not reaching it`,
        text.slice(0, 400));
      const emptyStates = ['No opportunities ingested yet', 'No connectors registered', 'No open tasks'];
      const stillEmpty = emptyStates.filter((s) => text.includes(s));
      if (!stillEmpty.length) ok(`${v.name}: no panel is in its empty state`);
      else bad(`${v.name}: ${stillEmpty.length} panel(s) still empty`, stillEmpty.join(' | '));

      // UNKNOWN must render as UNKNOWN — not blank, not a dash, not 0. The nulls in the fixture
      // exist to force that path.
      if (/unknown/i.test(text)) ok(`${v.name}: UNKNOWN values render as UNKNOWN`);
      else bad(`${v.name}: no UNKNOWN rendered, though the fixture contains nulls`, text.slice(0, 300));

      // NO MARKUP MAY LEAK INTO VISIBLE TEXT. prpaU() returns HTML for an unknown value, and
      // dropping that into href="..." closed the attribute early and printed the rest of the tag
      // on the page. The fixture's null source_url forces that path on every run, so this
      // assertion is load-bearing rather than theoretical.
      const leaked = [/target="_blank"/, /rel="noopener"/, /style="color:/, /<\/?[a-z]+>/i]
        .filter((re) => re.test(text));
      if (!leaked.length) ok(`${v.name}: no HTML leaked into visible text`);
      else bad(`${v.name}: raw markup is rendering as text — an attribute was escaped`,
        text.split('\n').filter((l) => /target=|rel=|style="color:/.test(l)).slice(0, 3).join(' | '));

      // And no empty href, which looks clickable and goes nowhere.
      const emptyHref = await page.evaluate(() => document.querySelectorAll('a[href=""]').length);
      if (!emptyHref) ok(`${v.name}: no empty-href links`);
      else bad(`${v.name}: ${emptyHref} link(s) with an empty href`);

      if (!errors.length) ok(`${v.name}: no console or page errors`);
      else bad(`${v.name}: ${errors.length} console error(s)`, errors.join(' | '));

      // CONTRAST. The defect a screenshot caught last time was dark panels in a light theme, so it
      // is asserted as well as photographed: sample the rendered colours and refuse a pairing a
      // person could not read.
      const contrast = await page.evaluate(() => {
        const lum = (c) => {
          const m = String(c).match(/\d+(\.\d+)?/g);
          if (!m || m.length < 3) return null;
          const [r, g, b] = m.slice(0, 3).map(Number).map((x) => {
            const s = x / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const bgOf = (el) => {
          let n = el;
          while (n) {
            const c = getComputedStyle(n).backgroundColor;
            if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
            n = n.parentElement;
          }
          return getComputedStyle(document.body).backgroundColor;
        };
        const out = [];
        const nodes = [...document.querySelectorAll('h1,h2,h3,.card-title,td,th,p,div')]
          .filter((el) => el.offsetParent !== null
            && (el.innerText || '').trim().length > 2
            && el.children.length === 0)
          .slice(0, 160);
        for (const el of nodes) {
          const fg = lum(getComputedStyle(el).color);
          const bg = lum(bgOf(el));
          if (fg === null || bg === null) continue;
          const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
          if (ratio < 3) {
            out.push({ text: (el.innerText || '').trim().slice(0, 50), ratio: Math.round(ratio * 100) / 100 });
          }
        }
        return { checked: nodes.length, low: out };
      });
      if (contrast.checked === 0) {
        bad(`${v.name}: no text nodes to contrast-check — the check would pass vacuously`);
      } else if (!contrast.low.length) {
        ok(`${v.name}: all ${contrast.checked} visible text nodes clear 3:1 contrast`);
      } else {
        bad(`${v.name}: ${contrast.low.length} of ${contrast.checked} text nodes below 3:1 contrast`,
          contrast.low.slice(0, 6).map((x) => `"${x.text}" @ ${x.ratio}:1`).join(' | '));
      }

      await ctx.close();
    }

    // The entry points check-spa-parse.js requires, asserted in a live browser.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    // ONLY the function declarations are testable from here. `API` and `pages` are top-level
    // `const`, so they are module-scope bindings and never window properties — asserting on
    // window.pages reports undefined for a perfectly healthy app. Their presence is checked by
    // check-spa-parse.js, which parses the SOURCE, and that is the right tool for it. Asserting it
    // here as well would have produced a check that fails whenever the app is correct.
    const entry = await page.evaluate(() => ({
      navigate: typeof window.navigate,
      checkAuth: typeof window.checkAuth,
      buildNav: typeof window.buildNav,
    }));
    await ctx.close();
    for (const k of ['navigate', 'checkAuth', 'buildNav']) {
      if (entry[k] === 'function') ok(`entry point ${k}() is a live global`);
      else bad(`entry point ${k} is ${entry[k]}, expected function`);
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n  captured ${captured.length} image(s):`);
  for (const c of captured) console.log(`    ${c}`);
  return fail ? 1 : 0;
}

main()
  .then((c) => {
    console.log(fail ? `\nFAIL  UI rendering check: ${fail} failure(s)` : '\nPASS  UI rendering check');
    process.exit(c);
  })
  .catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(1);
  });
