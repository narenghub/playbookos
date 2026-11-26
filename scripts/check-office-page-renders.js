#!/usr/bin/env node
// ── THE AUTONOMOUS OFFICE SCREEN, RENDERED IN A REAL BROWSER ─────────────────
//
//   node scripts/check-office-page-renders.js    exit 0 = it renders and tells the truth
//                                                 exit 3 = NOT EXECUTED (no browser available)
//
// Modelled on `check-approvals-page-renders.js`, which exists because the Approvals screen shipped
// to production and never rendered: it asked for an element id that does not exist, got null,
// returned at its own guard, and 105 preflight checks stayed green — because every one of them
// measured something that was true (the script parses; the page is registered; the render neither
// threw nor rejected). **A check that proves the code is well-formed is not a check that proves the
// screen works.**
//
// So this drives the REAL dispatcher — `navigate('office-command')`, the same function the sidebar
// calls — against the REAL index.html in a REAL browser, and asserts on the content element the
// shell actually paints into.
//
// ── AND IT ASSERTS WHAT THE PAGE MUST NEVER SAY ─────────────────────────────
//
// Rendering is the easy half. The owner's Priority 2 lists ten things to see, and this batch's whole
// subject has been figures that look calm when nobody can support them. So the fixtures include a
// REFUSAL, an UNREADABLE section, a MISSING fact and an UNVERIFIED capability, and each is asserted
// to appear AS SUCH rather than as an empty row, a zero, or a green chip.
//
// `fetch` only is stubbed. `API` is a module-scoped const in index.html and cannot be reassigned
// from outside — which is correct anyway, because stubbing `API` would stop this from exercising the
// real URL construction, and the method and query string are part of what is under test.
//
// No server, no database, no network beyond the local static file server.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const INDEX = path.join(ROOT, 'index.html');

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => {
  fail += 1;
  console.error(`  FAIL  ${m}${d ? `\n        ${String(d).slice(0, 500)}` : ''}`);
};
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n── ${m} ──\n`);

// ── THE FIXTURE: one snapshot that exercises every branch worth seeing ───────
//
// Deliberately NOT all-healthy. An all-green fixture proves the happy path renders and says nothing
// about the five states this page exists to distinguish — and a fixture where every number is 1 is
// how a check that sums the wrong column still passes.
const SNAPSHOT = {
  companyId: 'abiozen',
  at: '2026-11-26T15:04:05.000Z',
  onlineWithinSeconds: 180,
  workers: [
    { id: 'wkr_cloud01', name: 'cloud-dev-railway', kind: 'cloud_eligible_only', status: 'online',
      lastAuthenticatedAt: '2026-11-26T15:03:30.000Z', lastAuthenticatedAgeSeconds: 35,
      declaredCapabilities: ['worker.execute'],
      capabilityAvailability: [{ capability: 'worker.execute', availability: 'declared',
        why: 'granted by the server and the worker is authenticating' }],
      revokedAt: null, revokedReason: null, enrolledAt: '2026-11-20T10:00:00.000Z' },
    { id: 'wkr_imac01', name: 'imac-office', kind: 'gui_session_node', status: 'online',
      lastAuthenticatedAt: '2026-11-26T15:02:05.000Z', lastAuthenticatedAgeSeconds: 120,
      declaredCapabilities: ['worker.execute', 'exec:hardware', 'exec:gui'],
      capabilityAvailability: [
        { capability: 'worker.execute', availability: 'declared', why: 'granted' },
        { capability: 'exec:hardware', availability: 'declared', why: 'granted' },
        { capability: 'exec:gui', availability: 'unverified',
          why: 'a GUI capability is a GRANT, not evidence that an eligible desktop session exists' }],
      revokedAt: null, revokedReason: null, enrolledAt: '2026-11-17T09:00:00.000Z' },
    { id: 'wkr_old01', name: 'mac-mini-spare', kind: 'hardware_node', status: 'unknown',
      lastAuthenticatedAt: null, lastAuthenticatedAgeSeconds: null,
      declaredCapabilities: ['worker.execute', 'exec:hardware'],
      capabilityAvailability: [
        { capability: 'worker.execute', availability: 'unreachable', why: 'the worker is unknown' },
        { capability: 'exec:hardware', availability: 'unreachable', why: 'the worker is unknown' }],
      revokedAt: null, revokedReason: null, enrolledAt: '2026-11-25T09:00:00.000Z' },
    { id: 'wkr_gone01', name: 'decommissioned-node', kind: 'cloud_eligible_only', status: 'revoked',
      lastAuthenticatedAt: '2026-11-24T08:00:00.000Z', lastAuthenticatedAgeSeconds: 200000,
      declaredCapabilities: ['worker.execute'],
      capabilityAvailability: [{ capability: 'worker.execute', availability: 'unreachable',
        why: 'the worker is revoked' }],
      revokedAt: '2026-11-25T08:00:00.000Z', revokedReason: 'retired by the operator',
      enrolledAt: '2026-11-01T09:00:00.000Z' },
  ],
  workersUnreadable: false,
  liveCapabilities: ['exec:hardware', 'worker.execute'],
  work: {
    byState: { pending: 4, leased: 1, completed: 17, failed: 2 },
    blockedBacklog: [{ taskType: 'desktop.capture_once', pending: 3,
      requiredCapability: 'exec:gui', servableNow: false }],
    servableBacklog: [{ taskType: 'synthetic.echo', pending: 1,
      requiredCapability: null, servableNow: true }],
  },
  objectives: [
    { id: 'obj-abiozen-rfq', objective: 'First governed supplier RFQ', status: 'active',
      autonomyTier: 'supervised', budgetUsd: 10,
      spend: { measuredUsd: 1.25, heldUsd: 0.4, remainingUsd: 8.35, unmeasuredCalls: 0,
        unresolvedExposureUsd: 0, unresolvedCount: 0, staleHoldCount: 1 } },
    { id: 'obj-abiozen-seo', objective: 'Molecule page coverage', status: 'paused',
      autonomyTier: 'supervised', budgetUsd: 5,
      spend: { measuredUsd: 0, heldUsd: null, remainingUsd: null, unmeasuredCalls: 2,
        unresolvedExposureUsd: 2.5, unresolvedCount: 1, staleHoldCount: 0 } },
  ],
  history: [
    { run_id: '11111111-1111-4111-8111-111111111111', objective_id: 'obj-abiozen-rfq',
      workflow: 'office-scheduled-initiation', agent: 'office-initiator', state: 'RUNNING',
      attempt: 1, created_at: '2026-11-26T12:00:00.000Z', started_at: '2026-11-26T12:00:01.000Z',
      ended_at: null, stopped_by: null },
    { run_id: '22222222-2222-4222-8222-222222222222', objective_id: 'obj-abiozen-rfq',
      workflow: 'office-scheduled-initiation', agent: 'office-initiator', state: 'SUCCEEDED',
      attempt: 1, created_at: '2026-11-25T12:00:00.000Z', started_at: '2026-11-25T12:00:01.000Z',
      ended_at: '2026-11-25T12:04:00.000Z', stopped_by: null },
    { run_id: '33333333-3333-4333-8333-333333333333', objective_id: 'obj-abiozen-seo',
      workflow: 'office-scheduled-initiation', agent: 'office-initiator', state: 'FAILED',
      attempt: 2, created_at: '2026-11-24T12:00:00.000Z', started_at: '2026-11-24T12:00:01.000Z',
      ended_at: '2026-11-24T12:09:00.000Z', stopped_by: null },
  ],
  livePhases: [{ runId: '11111111-1111-4111-8111-111111111111',
    objectiveId: 'obj-abiozen-rfq', phase: 'collect',
    evidence: { planId: 'plan-cycle-1111', runAgeMinutes: 184 } }],
  schedulerHeartbeats: [{ name: 'office-cycle-advance', at: '2026-11-26T15:03:50.000Z',
    ageSeconds: 15, detail: 'firing' }],
  stops: [{ scope_type: 'capability', scope_key: 'email.send',
    reason: 'held since 2026-11-03 pending the restoration package', set_by: 'naren',
    set_at: '2026-11-03T00:00:00.000Z' }],
  openAlerts: [
    { id: 'alert-backlog_blocked_on_capability-desktop.capture_once:exec:gui',
      code: 'backlog_blocked_on_capability', subject: 'desktop.capture_once:exec:gui',
      severity: 'warning', detail: '3 desktop.capture_once task(s) wait for exec:gui',
      first_seen_at: '2026-11-26T09:00:00.000Z', last_seen_at: '2026-11-26T15:00:00.000Z',
      occurrences: 72 },
    { id: 'alert-unresolved_financial_exposure-obj-abiozen-seo',
      code: 'unresolved_financial_exposure', subject: 'obj-abiozen-seo', severity: 'critical',
      detail: '$2.5 is held in an unresolved financial state', occurrences: 5,
      first_seen_at: '2026-11-26T14:00:00.000Z', last_seen_at: '2026-11-26T15:00:00.000Z' },
  ],
  refusals: [],
  operationalFacts: [
    { kind: 'employee_assignments', label: 'tasks assigned for 2026-11-26', value: 0,
      unit: 'count', status: 'missing', source: 'identity/scoped-operations.tasksFor',
      detail: '0 rows are attributed to this company while 4213 row(s) in the same table have no '
        + 'owner — the figure cannot be supported until attribution is applied',
      newestRecord: null, parts: null },
    { kind: 'task_completion', label: 'tasks completed of those assigned for 2026-11-26', value: 0,
      unit: 'count', status: 'measured_zero', source: 'identity/scoped-operations.tasksFor',
      detail: 'no tasks were assigned for this day, so none could be completed',
      newestRecord: null, parts: { assigned: 0, completed: 0 } },
    { kind: 'milestones', label: 'milestones not yet achieved', value: 3, unit: 'count',
      status: 'stale', source: 'identity/scoped-operations.milestonesFor',
      detail: 'the newest record behind this figure is 315 day(s) old, past the 7-day bound',
      newestRecord: '2026-01-15', parts: { total: 4, open: 3 } },
    { kind: 'objectives', label: 'active objectives', value: 1, unit: 'count',
      status: 'measured', source: 'office/scope.listObjectives', detail: null,
      newestRecord: null, parts: { total: 2, active: 1 } },
    { kind: 'execution_outcomes', label: 'recorded execution outcomes', value: null,
      unit: 'count', status: 'unavailable', source: 'office/scope.listOutcomes',
      detail: 'the read failed: simulated outage', newestRecord: null, parts: null },
  ],
  factQuality: { unattributed: { daily_tasks: 4213 }, unattributedError: null, degraded: [],
    supportable: 2, total: 5 },
  unreadable: [{ section: 'refusals', error: 'simulated outage' }],
};

function serve() {
  const server = http.createServer((req, res) => {
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

/** Load the real page, drive the real dispatcher, return what the shell holds. */
async function render(reply, { chromium }, origin, { status = 200 } = {}) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript((args) => {
      window.__calls = [];
      window.fetch = async (url, opts) => {
        const u = String(url);
        // The METHOD is recorded, because "this page cannot write" is the claim and a GET-only
        // call log is the evidence for it.
        window.__calls.push({ url: u, method: (opts && opts.method) || 'GET' });
        const isOffice = u.indexOf('/office/command-center') !== -1;
        return new Response(JSON.stringify(isOffice ? args.reply : {}), {
          status: isOffice ? args.status : 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
    }, { reply, status });

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)));

    await page.goto(`${origin}/`, { waitUntil: 'load' });
    const out = await page.evaluate(async () => {
      navigate('office-command');                        // THE REAL DISPATCHER
      // Captured SYNCHRONOUSLY, before yielding: navigate() paints "Loading..." and the page paints
      // its own first line before its first await, so both happen in this tick. Reading after an
      // await would show only the settled state and would pass on the broken file.
      const immediate = document.getElementById('content').innerHTML;
      for (let i = 0; i < 80; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        if (document.getElementById('content').innerHTML.indexOf('Reading the office…') === -1) break;
      }
      return {
        immediate,
        html: document.getElementById('content').innerHTML,
        title: (document.getElementById('page-title') || {}).textContent || '',
        calls: window.__calls.slice(),
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
    console.log('SKIP  the Autonomous Office screen was NOT rendered — this check needs a browser');
    process.exit(3);
  }

  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    // ══ 1. IT PAINTS, WHICH IS THE DEFECT THAT SHIPPED ONCE ══════════════
    head('1. it paints over the shell, in the dispatching tick');

    const r = await render(SNAPSHOT, { chromium }, origin);

    if (r.immediate.indexOf('Reading the office…') !== -1) {
      ok('the page paints over the shell\'s "Loading..." in the tick navigate() runs in — the '
        + 'assertion that would have caught the Approvals defect');
    } else bad('the page did not paint; the shell\'s placeholder survived navigate()', r.immediate);

    if (r.html.indexOf('Loading...') === -1 && r.html.indexOf('Reading the office…') === -1) {
      ok('and the settled screen is the page rather than a placeholder');
    } else bad('a placeholder is still on screen', r.html.slice(0, 400));

    if (!r.errors.length) ok('no page error was raised while rendering');
    else bad('the page raised an error', r.errors.join(' · '));

    if (r.title === 'Autonomous Office') {
      ok('the shell\'s title says Autonomous Office, so the titles map has the id');
    } else bad(`the page title is "${r.title}"`);

    // ══ 2. EVERY ONE OF THE TEN THINGS THE OWNER ASKED TO SEE ════════════
    head('2. the ten things the owner asked to see are on the screen');

    const want = [
      ['company objectives and progress', ['First governed supplier RFQ', 'Molecule page coverage']],
      ['agent activity', ['office-initiator', 'office-scheduled-initiation']],
      ['cloud and iMac worker availability', ['cloud-dev-railway', 'imac-office', 'hardware (iMac class)']],
      ['employee assignments and completion', ['tasks assigned for 2026-11-26', 'tasks completed of those']],
      ['current execution phases', ['collect']],
      ['durable history', ['SUCCEEDED', 'FAILED', 'attempt 2']],
      ['pending, blocked, failed and completed work', ['pending', 'Blocked backlog', 'failed', 'completed']],
      ['budget, held, measured and unresolved', ['Budget', 'Held', 'Measured', 'Unresolved']],
      ['STOP controls in force', ['email.send', 'pending the restoration package']],
      ['alerts and recovery', ['unresolved_financial_exposure', 'backlog_blocked_on_capability']],
      ['measured, missing, stale and unavailable facts',
        ['measured zero', 'missing', 'stale', 'unavailable']],
    ];
    const absent = want.filter(([, needles]) => !needles.every((n) => r.html.indexOf(n) !== -1));
    if (!absent.length) {
      ok(`all ${want.length} required views are present, each by its own content`);
    } else {
      bad('required views are missing from the rendered page',
        absent.map(([label, needles]) => `${label}: `
          + needles.filter((n) => r.html.indexOf(n) === -1).join(' / ')).join(' | '));
    }

    // ══ 3. WHAT IT MUST NOT SAY ══════════════════════════════════════════
    head('3. a figure nobody can support is not drawn as a figure');

    // THE ASSERTION THIS PAGE EXISTS FOR. The employee-assignment fact is 0 with 4,213 unattributed
    // rows behind it, which is `missing` — and a screen that prints "0" beside the others makes it
    // indistinguishable from a quiet day.
    if (/missing/.test(r.html) && r.html.indexOf('4213') !== -1) {
      ok('the unsupportable zero carries its MISSING status and the unattributed row count that '
        + 'explains it — a "0 tasks assigned" read from a table full of unowned rows is a number '
        + 'nobody can back');
    } else bad('an unsupportable zero was drawn without its reason', r.html.slice(0, 400));

    if (r.html.indexOf('cannot be supported') !== -1 && r.html.indexOf('of 5 figures') !== -1) {
      ok('and the page states how many figures cannot be supported, so a briefing built on them is '
        + 'not read as a statement of fact');
    } else bad('the fact-quality summary is missing');

    if (r.html.indexOf('unverified') !== -1) {
      ok('exec:gui is shown as UNVERIFIED — a GUI grant is not evidence of a live desktop session, '
        + 'and a screen showing it as capacity is how a GUI task reaches a machine with none');
    } else bad('a granted-but-unverified capability was shown as available');

    if (r.html.indexOf('never authenticated') !== -1) {
      ok('a worker that has never authenticated says so rather than reading as offline');
    } else bad('unknown and offline were not told apart on screen');

    if (r.html.indexOf('could not be read: refusals') !== -1
      && r.html.indexOf('NOT empty') !== -1) {
      ok('the unreadable section is NAMED at the top of the page, with the warning that anything '
        + 'below it that looks quiet may not be');
    } else bad('an unreadable section was not reported on screen', r.html.slice(0, 600));

    if (r.html.indexOf('unknown') !== -1) {
      ok('a money figure with an unknown part reads "unknown" rather than showing a total that '
        + 'looks safe');
    } else bad('a null money figure was rendered as a number');

    // ══ 4. IT CANNOT ACT ═════════════════════════════════════════════════
    head('4. it reads, and it is the only thing it does');

    const nonGet = r.calls.filter((c) => c.method !== 'GET');
    if (!nonGet.length) {
      ok(`all ${r.calls.length} request(s) were GETs — the page has no write path to misuse, which `
        + 'is how "reuse Agent Control for actions" is honoured rather than promised');
    } else bad('the page issued a non-GET request', JSON.stringify(nonGet));

    const officeCalls = r.calls.filter((c) => c.url.indexOf('/office/command-center') !== -1);
    if (officeCalls.length === 1) {
      ok(`one read of ${officeCalls[0].url.replace(/^.*\/api/, '/api')} — and no companyId, because `
        + 'the company comes from the caller\'s own memberships unless one is chosen');
    } else bad(`${officeCalls.length} reads of the command-centre route`, JSON.stringify(officeCalls));

    if (r.html.indexOf("navigate('agent-control')") !== -1
      || r.html.indexOf('ocToAgentControl') !== -1) {
      ok('the one action offered is a LINK to Agent Control, which already holds the authorization '
        + 'for stopping things');
    } else bad('the Agent Control hand-off is missing from the page');

    // ══ 5. A REFUSAL IS NOT AN IDLE OFFICE ═══════════════════════════════
    head('5. a refusal renders as a refusal');

    {
      const refused = await render(
        { error: 'no company context for this session', code: 'company_unresolved',
          detail: 'naren holds no active company membership, so there is no pipeline to show.' },
        { chromium }, origin, { status: 403 });

      if (refused.html.indexOf('NOT an idle office') !== -1
        && refused.html.indexOf('company_unresolved') !== -1) {
        ok('a refusal says in words that this is NOT an idle office, and names the code — the '
          + 'commonest refusal on a fresh deployment is "no active company membership", which is '
          + 'the expected answer until the reviewed backfill is applied');
      } else bad('a refusal rendered as something other than a refusal',
        refused.html.slice(0, 500));

      if (refused.html.indexOf('never inferred from an email domain') !== -1) {
        ok('and it explains that memberships are granted explicitly, so the empty screen is not '
          + 'read as a bug to be worked around');
      } else bad('the refusal gave the reader nothing to act on');

      if (!refused.errors.length) ok('the refusal path raised no page error either');
      else bad('the refusal path threw', refused.errors.join(' · '));
    }

    // ══ 6. WHAT THIS DOES NOT ESTABLISH ══════════════════════════════════
    head('6. what this does not establish');

    note('NOT established: that the data is right. The snapshot is a FIXTURE — this check proves '
      + 'the page tells the truth about what it is given, and check-command-center-db.js is what '
      + 'proves the read model tells the truth about the database');
    note('NOT established: role access. That is nav-model.test.js (the admin-only gate, read out of '
      + 'passesPageReads itself), nav-product-coverage.test.js and verify-classic-nav-parity.js, '
      + 'where exactly two roles gain the page and partner, the three directors, dev_team and '
      + 'support_team do not');
    note('NOT established: anything about production. Nothing here is deployed');
  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log(`\n${fail ? 'FAIL' : 'OK'}  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
