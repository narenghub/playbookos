#!/usr/bin/env node
// ── THE APPROVALS SCREEN, RENDERED IN A REAL BROWSER ─────────────────────────
//
//   node scripts/check-approvals-page-renders.js
//
// CEO authorization 2026-11-11, S2 approvals UI hotfix item 3: "Add a browser-level regression
// test that uses the real page dispatcher and verifies that the Approvals page replaces
// `Loading...`."
//
// ── WHY THIS FILE HAD TO EXIST ───────────────────────────────────────────────
//
// On 2026-11-11 the Approvals screen shipped to production and never rendered. `approvalsPage`
// asked for `document.getElementById('page-content')`, an id that exists nowhere in index.html,
// got null, and returned at its own `if (!host) return;` guard. 105 preflight checks were green.
//
// They were green because every one of them measured something that was TRUE:
//   · check-spa-parse.js — the script parses. It did.
//   · nav parity        — the page is registered in `pages`. It was.
//   · navigate()'s guards — the render did not throw, and did not reject. It returned cleanly.
//
// Nothing anywhere rendered the page and looked at the result. That is the whole gap, and it is
// the same gap as 30 September reached from a different direction: a check that proves the code
// is well-formed is not a check that proves the screen works.
//
// So this test drives the REAL dispatcher — `navigate('approvals')`, the same function the sidebar
// calls — against the REAL index.html in a REAL browser, and asserts on the content element the
// shell actually paints into. A test that called `approvalsPage()` directly, or that asserted on a
// host it chose itself, would have passed on the broken file.
//
// ── WHAT IS STUBBED, AND WHAT IS NOT ─────────────────────────────────────────
//
// `fetch` only. `API` is a module-scoped `const` in index.html and cannot be reassigned from
// outside, so the seam is one layer lower — which is correct anyway: stubbing `API` would stop the
// test from exercising the real URL construction, and the `?status=undefined` half of this bug
// lived precisely in that URL.
//
// No server, no database, no network. Exit 0 all pass, 1 any failure.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const INDEX = path.join(ROOT, 'index.html');

let pass = 0;
let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.error(`  FAIL  ${m}${d ? `\n        ${String(d).slice(0, 400)}` : ''}`); };

// A fixture that exercises every field apRow reads, so a row that renders proves the row builder
// ran rather than proving an empty string concatenated cleanly.
const ONE_APPROVAL = {
  id: 'apv-test-0001',
  subject: 'Quotation QT-TEST-0001 — Gemcitabine 12 kg',
  action_kind: 'buyer_email',
  to: 'buyer@acme-pharma.test',
  cc: [],
  from: 'Abiozen Sales <sales@abiozen.com>',
  signed_by: 'Abiozen Sales',
  status: 'pending',
  reason: 'Awaiting a human decision. The buyer has not received this.',
  commercial: { total: 48150, currency: 'USD' },
  validity: null,
};

function serve() {
  const server = http.createServer((req, res) => {
    // Only index.html and its siblings; anything else 404s rather than silently returning the page.
    const name = (req.url || '/').split('?')[0];
    const file = name === '/' ? INDEX : path.join(ROOT, name.replace(/^\/+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    const type = file.endsWith('.js') ? 'application/javascript'
      : file.endsWith('.css') ? 'text/css' : 'text/html';
    res.writeHead(200, { 'Content-Type': type });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/**
 * Loads index.html with `fetch` replaced, drives the real dispatcher, and returns what the shell's
 * content element holds afterwards.
 *
 * `reply` is whatever /api/approvals should resolve to — including an `{error}` payload, because
 * API() does NOT throw on a non-2xx: it resolves with the body. A test that expected a rejection
 * would be testing a helper this app does not have.
 */
async function render(reply, { chromium }, origin) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript((payload) => {
      window.__calls = [];
      window.fetch = async (url, opts) => {
        const u = String(url);
        window.__calls.push(u);
        const body = u.indexOf('/api/approvals') === 0 || u.indexOf('/approvals') !== -1
          ? payload : {};
        return new Response(JSON.stringify(body), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      };
    }, reply);

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)));

    await page.goto(origin + '/', { waitUntil: 'load' });
    // No token is set, so boot lands on the auth screen without touching the network. #content is
    // in the static markup either way, which is the point: the dispatcher paints into it whether
    // or not the shell is visible.
    const out = await page.evaluate(async () => {
      navigate('approvals');                      // THE REAL DISPATCHER
      // CAPTURED SYNCHRONOUSLY, before yielding. navigate() paints "Loading..." and then calls the
      // page function, which paints its own first line BEFORE its first await — so both happen in
      // this one tick, and this single read is what separates a working screen from the broken one:
      //   fixed  → "Reading what is waiting…"   (the page replaced the shell's paint)
      //   broken → "Loading..."                 (the page returned on a null host, painting nothing)
      // Reading it after an await would show only the settled state and would pass either way.
      const immediate = document.getElementById('content').innerHTML;
      for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        if (document.getElementById('content').innerHTML.indexOf('Reading what is waiting') === -1) break;
      }
      return {
        immediate,
        html: document.getElementById('content').innerHTML,
        title: (document.getElementById('page-title') || {}).textContent || '',
        calls: window.__calls.slice(),
        apvStatus: window._apvState && window._apvState.status,
        otherPageSize: window._apState && window._apState.pageSize,
        otherTotal: window._apState && window._apState.total,
      };
    });
    out.errors = errors;
    return out;
  } finally {
    await browser.close();
  }
}

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (e) {
    console.log('  skip  playwright is not available');
    console.log('SKIP  the Approvals screen was NOT rendered — this check needs a browser');
    process.exit(3);
  }

  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    // ══ 1. THE EMPTY QUEUE — THE CASE THAT WAS BROKEN IN PRODUCTION ════════
    {
      const r = await render(
        { approvals: [], count: 0, company_id: 'abiozen-test', note: 'read from the kernel' },
        { chromium }, origin);

      // THE ASSERTION THAT WOULD HAVE CAUGHT THE PRODUCTION DEFECT.
      if (r.immediate.indexOf('Reading what is waiting') !== -1) {
        ok('the page paints over the shell\'s "Loading..." in the dispatching tick');
      } else bad('the page did not paint — the shell\'s "Loading..." survived navigate()', r.immediate);

      if (r.immediate.indexOf('Loading...') === -1) {
        ok('and nothing of the shell\'s placeholder is left behind');
      } else bad('"Loading..." is still on screen after navigate() — this is the shipped defect', r.immediate);

      if (r.html.indexOf('Loading...') === -1) {
        ok('the settled screen is the Approvals page, not a placeholder');
      } else bad('the content element is still showing "Loading..." — the screen did not render', r.html);

      if (/Nothing with this status is waiting/.test(r.html)) {
        ok('an empty queue renders its own empty state');
      } else bad('the empty state did not render', r.html);

      if (r.html.indexOf('abiozen-test') !== -1) {
        ok('and it names the company it read from, so an empty list is attributable');
      } else bad('the empty state does not name the company', r.html);

      if (r.title === 'Approvals') ok('the dispatcher set the page title');
      else bad(`page title is ${JSON.stringify(r.title)}`);

      // The ?status=undefined half of the defect. Asserted on the URL the REAL API() built.
      const call = r.calls.filter((u) => u.indexOf('/approvals') !== -1)[0] || '';
      if (/status=pending/.test(call)) {
        ok('it requested status=pending — its own state, not another screen\'s');
      } else bad('the request did not carry status=pending', call || '(no /approvals call was made)');
      if (!/status=undefined/.test(call)) ok('and never status=undefined');
      else bad('the state collision is still live — status=undefined was requested', call);

      if (!r.errors.length) ok('no uncaught page error');
      else bad('an uncaught error fired during render', r.errors.join(' | '));
    }

    // ══ 2. A POPULATED QUEUE ═══════════════════════════════════════════════
    {
      const r = await render(
        { approvals: [ONE_APPROVAL], count: 1, company_id: 'abiozen-test', note: 'one waiting' },
        { chromium }, origin);

      if (r.html.indexOf('Loading...') === -1) ok('a populated queue replaces "Loading..." too');
      else bad('populated render left "Loading..." on screen', r.html);

      if (r.html.indexOf('Quotation QT-TEST-0001') !== -1) {
        ok('the row renders its subject');
      } else bad('the approval row did not render', r.html);

      if (r.html.indexOf('buyer@acme-pharma.test') !== -1) {
        ok('and the recipient, which is what the human is deciding about');
      } else bad('the row does not show the recipient', r.html);

      if (/Nothing with this status is waiting/.test(r.html) === false) {
        ok('and it does NOT also claim the queue is empty');
      } else bad('a populated queue rendered the empty state as well', r.html);

      // The screen must never imply the buyer received anything.
      if (!/\bsent\b/i.test(r.html.replace(/Abiozen Sales/g, ''))) {
        ok('nothing on the screen says the message was sent');
      } else bad('the screen contains the word "sent" — a draft must never read as delivered', r.html);
    }

    // ══ 3. A FAILURE MUST NOT LOOK LIKE AN EMPTY QUEUE ═════════════════════
    //
    // This is the assertion with the most value in it. "No approvals" and "the queue could not be
    // read" are opposite facts that render almost identically if nobody insists otherwise.
    {
      const r = await render({ error: 'kernel unreachable', code: 'kernel_down' },
        { chromium }, origin);

      if (/This is NOT an empty queue/.test(r.html)) {
        ok('an API failure says so, loudly, instead of rendering silence');
      } else bad('a failed read did not announce itself', r.html);

      if (/Nothing with this status is waiting/.test(r.html) === false) {
        ok('and it does not render the empty state');
      } else bad('a FAILURE rendered as an empty queue — the exact confusion this must prevent', r.html);

      if (r.html.indexOf('kernel unreachable') !== -1 || r.html.indexOf('kernel_down') !== -1) {
        ok('and it shows the reason, so the failure can be reported');
      } else bad('the failure card does not carry the reason', r.html);
    }

    // ══ 4. STATE ISOLATION ═════════════════════════════════════════════════
    {
      const r = await render(
        { approvals: [], count: 0, company_id: 'abiozen-test', note: '' }, { chromium }, origin);

      if (r.apvStatus === 'pending') ok('_apvState belongs to Approvals and holds its status');
      else bad(`_apvState.status is ${JSON.stringify(r.apvStatus)}`);

      if (r.otherPageSize === 50 && r.otherTotal === 0) {
        ok('_apState still belongs to the other screen — the rename touched nothing of its');
      } else bad(`the other screen's state was disturbed: pageSize=${r.otherPageSize} total=${r.otherTotal}`);
    }
  } catch (e) {
    bad(`the harness itself failed: ${(e && e.message) || e}`);
  } finally {
    server.close();
  }

  console.log(`\n  ${pass} assertion(s) passed · ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  the Approvals screen does not render correctly.');
    process.exit(1);
  }
  console.log('\nPASS  the real dispatcher renders the Approvals screen, a failure is distinguishable');
  console.log('      from an empty queue, and the two screens no longer share a global.');
  process.exit(0);
})();
