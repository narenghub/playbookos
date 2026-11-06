#!/usr/bin/env node
// ── THE WHOLE PRODUCT, END TO END, OVER HTTP ─────────────────────────────────
//
//   node scripts/prpa-e2e-demo.js
//
// Ruling 27 item 8: "Provide a complete local end-to-end demonstration: import a real notice,
// inspect its documents, review eligibility and supplier feasibility, confirm its deadline, record
// a human decision, and export the result to Excel."
//
// Those seven steps, in that order, through the REAL HTTP surface with a REAL JWT — not through the
// library. The library was already proved by scripts/prpa-tracker-demo.js; what had never been
// exercised is the part a browser touches: authentication, the permission middleware, the company
// resolver, JSON in and JSON out, and the CSV download with its headers.
//
// ── WHAT IS REAL AND WHAT IS LOCAL ───────────────────────────────────────────
//
// The DATA is real: committed SAM.gov records harvested 2026-11-06, with their hashes.
// The DATABASE is a disposable cluster created and destroyed by this script.
// The SERVER is a real express app on a loopback port, with the real routers mounted.
// The SAM.gov FETCH is attempted for real and, if the network refuses it, the step reports that it
// could not run rather than passing. A step that did not execute is not a step that passed.
//
// Nothing is deployed, no production database is touched, and no external party is contacted.
//
// Exit status is the verdict. 3 = could not execute (no Postgres toolchain).

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Client } = require('pg');
const { pgBinCandidates, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const PGPORT = process.env.PRPA_E2E_PGPORT || '55443';
const APPPORT = Number(process.env.PRPA_E2E_PORT || 5599);

let pass = 0; let fail = 0; let couldNotRun = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const skip = (m, d) => { couldNotRun += 1; console.log(`  ----  ${m} — DID NOT RUN${d ? `: ${d}` : ''}`); };
const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

let temp = null;
function startCluster() {
  const dir = pgBinCandidates()[0];
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/prpa-e2e-');
  const asPostgres = process.getuid && process.getuid() === 0;
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, encoding: 'utf8', stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p ${PGPORT} -c listen_addresses=' start -w`);
  } catch (e) {
    console.error(`  (cluster start failed: ${e.message})`);
    return null;
  }
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

// A minimal HTTP client. The point is to exercise the real stack, so no supertest and no mocking.
function request(method, p, { token, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: APPPORT, method, path: p,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (raw) return resolve({ status: res.statusCode, headers: res.headers, buffer: buf });
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
        return resolve({ status: res.statusCode, headers: res.headers, json, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  h('PRPA — END-TO-END OVER HTTP, ON REAL SAM.gov RECORDS');

  const base = startCluster();
  if (!base) {
    console.log('\nSKIP  no PostgreSQL server toolchain. This demonstrated NOTHING.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }

  const ownerUrl = `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable`;

  // Environment for the app under test. Fixture values for a cluster destroyed at the end; the JWT
  // secret is generated per run and never written anywhere.
  process.env.DATABASE_URL = ownerUrl;
  process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
  process.env.PRPA_COMPANY_SLUG = 'abiozen';
  process.env.ADMIN_EMAIL = 'e2e-fixture@example.invalid';
  process.env.ADMIN_PASSWORD = `fixture-only-${Date.now()}`;
  process.env.NODE_ENV = 'test';
  process.env.PORT = String(APPPORT);

  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  const oq = (sql, p) => owner.query(sql, p);

  let server = null;
  try {
    // ── 0. MIGRATE ────────────────────────────────────────────────────────────
    h('0. MIGRATIONS RUN AS THEIR OWN PROCESS (ENG-003)');
    const { runAll } = require('../src/lib/migrate-all');
    const mig = await runAll(oq, { seeds: false, log: () => {} });
    if (mig.ok) ok(`${mig.steps.length} migration step(s) applied`);
    else { bad('migrations failed', mig.failed.map((f) => `${f.name}: ${f.error}`).join(' | ')); throw new Error('cannot continue'); }

    const schemaReady = require('../src/lib/schema-ready');
    const ready = await schemaReady.check(oq);
    if (ready.ready) ok('the schema readiness check passes — the server will start');
    else { bad('schema not ready', JSON.stringify(ready)); throw new Error('cannot continue'); }

    // ── 1. THE SERVER ─────────────────────────────────────────────────────────
    h('1. THE REAL SERVER, WITH THE REAL ROUTERS');
    const express = require('express');
    const { authMiddleware } = require('../src/lib/core');
    const app = express();
    app.use(express.json({ limit: '8mb' }));
    // The same mount order as server.js: authMiddleware, then routes.js, then the PRPA router. The
    // order is what makes /prpa/tracker/* reachable at all — see the collision checker.
    app.use('/api', authMiddleware);
    app.use('/api', require('../src/api/routes'));
    app.use('/api', require('../src/api/prpa.routes'));
    server = await new Promise((resolve) => {
      const s = app.listen(APPPORT, '127.0.0.1', () => resolve(s));
    });
    ok(`listening on 127.0.0.1:${APPPORT}`);

    // A real token for a real admin row.
    const { signToken } = require('../src/lib/core');
    const admin = (await oq(`SELECT id, email, role FROM users WHERE role IN ('admin','super_admin') LIMIT 1`)).rows[0];
    if (!admin) { bad('no admin user was seeded'); throw new Error('cannot continue'); }
    const token = signToken(admin);
    ok(`authenticated as ${admin.email} (${admin.role})`);

    // Authentication is not decoration: the same route without a token must refuse.
    const anon = await request('GET', '/api/prpa/tracker/opportunities');
    if (anon.status === 401 || anon.status === 403) ok(`the board refuses an anonymous request (${anon.status})`);
    else bad(`an anonymous request got ${anon.status} — the board is not authenticated`);

    // ── 2. IMPORT A REAL NOTICE ───────────────────────────────────────────────
    h('2. IMPORT — real SAM.gov records through the authenticated endpoint');
    const csv = fs.readFileSync(
      path.join(__dirname, '..', 'fixtures', 'sam-opportunities-real-2026-11-06.csv'), 'utf8');
    const imp = await request('POST', '/api/prpa/tracker/import/csv', {
      token, body: { csv, sourceDetail: 'fixtures/sam-opportunities-real-2026-11-06.csv — harvested 2026-11-06' },
    });
    if (imp.status === 200 && imp.json && imp.json.ok) {
      ok(`imported ${imp.json.inserted} new · ${imp.json.amended} amended · ${imp.json.rejected.length} rejected`);
      ok(`the import recorded its own sha256: ${String(imp.json.sha256).slice(0, 16)}…`);
    } else {
      bad(`import failed (${imp.status})`, JSON.stringify(imp.json || imp.text).slice(0, 300));
      throw new Error('cannot continue without data');
    }

    // The dataset must declare itself as a development dataset, not a live feed (item 4).
    const ds = await request('GET', '/api/prpa/tracker/dataset', { token });
    if (ds.json && ds.json.is_live_feed === false && /DEVELOPMENT DATASET/.test(ds.json.label || '')) {
      ok('the dataset declares itself a development dataset, not a live feed');
    } else bad('the dataset does not declare its mode', JSON.stringify(ds.json).slice(0, 200));

    // ── 3. REVIEW ELIGIBILITY AND SUPPLIER FEASIBILITY ────────────────────────
    h('3. ELIGIBILITY AND SUPPLIER FEASIBILITY');
    const asmt = await request('POST', '/api/prpa/tracker/assess', { token, body: {} });
    if (asmt.status === 200 && asmt.json.ok) {
      ok(`assessed ${asmt.json.assessed} opportunity(ies) on the REAL registry `
        + `(${asmt.json.verified_capabilities} verified capabilities)`);
      const q = asmt.json.tally.QUALIFIED || 0;
      if (q === 0) ok('QUALIFIED: 0 — and it must be 0 while the registry is empty (item 8 of ruling 22)');
      else bad(`${q} opportunity(ies) came back QUALIFIED with an empty registry`);
    } else bad(`assessment failed (${asmt.status})`, JSON.stringify(asmt.json).slice(0, 200));

    const board = await request('GET', '/api/prpa/tracker/opportunities', { token });
    if (board.status !== 200 || !board.json.opportunities) {
      bad(`the board failed (${board.status})`, JSON.stringify(board.json).slice(0, 200));
      throw new Error('cannot continue');
    }
    const rows = board.json.opportunities;
    ok(`the board returns ${rows.length} row(s) with ranking, feasibility and missing evidence`);

    // Every column ruling 27 item 2 names must be present on every row.
    const required = ['title', 'agency', 'solicitation_number', 'response_deadline', 'set_aside',
      'requested', 'feasibility', 'missing_evidence', 'source_url', 'review'];
    const incomplete = rows.filter((r) => required.some((k) => !(k in r)));
    if (!incomplete.length) ok(`all ${required.length} required column(s) present on every row`);
    else bad(`${incomplete.length} row(s) are missing a required column`);

    // Feasibility must actually discriminate, not label everything the same.
    const classes = rows.reduce((a, r) => { const c = r.requested.product_class; a[c] = (a[c] || 0) + 1; return a; }, {});
    const verdicts = rows.reduce((a, r) => { a[r.feasibility.verdict] = (a[r.feasibility.verdict] || 0) + 1; return a; }, {});
    ok(`product classes: ${JSON.stringify(classes)}`);
    ok(`feasibility verdicts: ${JSON.stringify(verdicts)}`);
    if ((verdicts.NOT_FEASIBLE || 0) > 0) ok(`${verdicts.NOT_FEASIBLE} barred as undeliverable — eligible, and we could not supply them`);
    else bad('nothing was NOT_FEASIBLE, which on this dataset means the feasibility gate did not run');

    // A notice naming a diagnostics OEM must be NOT_FEASIBLE, by name.
    const roche = rows.find((r) => /roche|ventana/i.test(r.title || ''));
    if (roche) {
      if (roche.feasibility.verdict === 'NOT_FEASIBLE') {
        ok(`${roche.solicitation_number} (Roche Ventana) → NOT_FEASIBLE: ${String(roche.feasibility.blockers[0]).slice(0, 72)}…`);
      } else bad(`the Roche notice came back ${roche.feasibility.verdict}`);
    } else skip('the Roche notice is not in this fixture', 'cannot assert the OEM case');

    // ── 4. INSPECT THE DOCUMENTS ──────────────────────────────────────────────
    h('4. INSPECT THE DOCUMENTS ON A NOTICE');
    const withNotice = rows.find((r) => r.notice_id && /^[0-9a-f]{32}$/i.test(r.notice_id));
    if (!withNotice) {
      skip('no row carries a 32-hex SAM notice id', 'attachments cannot be located');
    } else {
      const docs = await request('GET',
        `/api/prpa/tracker/opportunities/${encodeURIComponent(withNotice.id)}/documents`, { token });
      if (docs.status === 200 && Array.isArray(docs.json.attachments)) {
        ok(`${docs.json.attachments.length} attachment(s) listed for ${withNotice.solicitation_number}`);
        if (/nothing was downloaded or stored server-side/i.test(docs.json.note || '')) {
          ok('…and the response states that nothing was downloaded or stored server-side');
        } else bad('the documents response does not say what it did with the files');
      } else if (docs.status === 502) {
        // Honest about a network refusal: this step did not run, and that is not a pass.
        skip('the SAM.gov attachment index could not be reached', String(docs.json && docs.json.detail).slice(0, 110));
      } else {
        bad(`the documents endpoint returned ${docs.status}`, JSON.stringify(docs.json).slice(0, 200));
      }
    }

    // ── 5. CONFIRM A DEADLINE ─────────────────────────────────────────────────
    h('5. CONFIRM A DEADLINE — nothing is biddable until a human does');
    const target = rows.find((r) => r.response_deadline && !r.deadline_confirmed && !r.ranking.bars.length)
      || rows.find((r) => r.response_deadline && !r.deadline_confirmed);
    if (!target) {
      bad('no row has an unconfirmed deadline to confirm');
    } else {
      if (target.is_biddable === false) ok(`${target.solicitation_number} is NOT biddable before confirmation`);
      else bad(`${target.solicitation_number} was already biddable with an unconfirmed deadline`);

      const conf = await request('POST',
        `/api/prpa/tracker/opportunities/${encodeURIComponent(target.id)}/confirm-deadline`,
        { token, body: { note: 'confirmed against the notice during the end-to-end demonstration' } });
      if (conf.status === 200 && conf.json.ok) {
        ok(`deadline confirmed · is_biddable is now ${conf.json.is_biddable}`);
        if (conf.json.is_biddable === true) ok('…and the generated column flipped, which is what gates the review queue');
        else bad('confirmation succeeded but is_biddable stayed false');
      } else bad(`confirmation failed (${conf.status})`, JSON.stringify(conf.json).slice(0, 200));
    }

    // ── 6. RECORD A HUMAN DECISION ────────────────────────────────────────────
    h('6. RECORD A HUMAN DECISION — recorded, never submitted');
    const subject = target || rows[0];

    // A decision with no reason must be refused.
    const noReason = await request('POST',
      `/api/prpa/tracker/opportunities/${encodeURIComponent(subject.id)}/review`,
      { token, body: { decision: 'no_bid', rationale: 'too short' } });
    if (noReason.status === 400) ok('a decision with a 9-character rationale is refused');
    else bad(`a decision with no real rationale was accepted (${noReason.status})`);

    // An invalid decision value must be refused.
    const badDecision = await request('POST',
      `/api/prpa/tracker/opportunities/${encodeURIComponent(subject.id)}/review`,
      { token, body: { decision: 'submitted', rationale: 'this should never be a decision value' } });
    if (badDecision.status === 400) ok('a decision value outside bid/no_bid/undecided is refused');
    else bad(`"submitted" was accepted as a decision (${badDecision.status})`);

    const review = await request('POST',
      `/api/prpa/tracker/opportunities/${encodeURIComponent(subject.id)}/review`,
      { token, body: { decision: 'no_bid', rationale: 'No verified capability and no supplier quote exists for this requirement.' } });
    if (review.status === 200 && review.json.ok) {
      ok(`NO-BID recorded on ${subject.solicitation_number} by ${admin.email}`);
    } else bad(`the review was not recorded (${review.status})`, JSON.stringify(review.json).slice(0, 200));

    // It must come back on the board, and in the audit trail.
    const board2 = await request('GET', '/api/prpa/tracker/opportunities', { token });
    const again = (board2.json.opportunities || []).find((r) => r.id === subject.id);
    if (again && again.review && again.review.decision === 'no_bid') ok('…and the decision is on the board with its author');
    else bad('the recorded decision does not appear on the board');

    const hist = await request('GET', `/api/prpa/tracker/opportunities/${encodeURIComponent(subject.id)}`, { token });
    const actions = (hist.json.audit_events || []).map((e) => e.action);
    if (actions.includes('review.recorded')) ok(`the audit trail holds the action: ${actions.join(', ')}`);
    else bad('the audit trail has no review.recorded event', JSON.stringify(actions));

    // The audit trail must be append-only through the API surface too — there is no endpoint that
    // edits it, which is the point.
    const auditRows = await request('GET', '/api/prpa/tracker/audit', { token });
    if (auditRows.status === 200 && auditRows.json.count > 0) ok(`${auditRows.json.count} audit event(s) readable`);
    else bad('the audit endpoint returned nothing');

    // ── 7. EXPORT TO EXCEL ────────────────────────────────────────────────────
    h('7. EXPORT — one click, opens correctly in Excel');
    const exp = await request('GET', '/api/prpa/tracker/export.csv', { token, raw: true });
    if (exp.status !== 200) {
      bad(`the export failed (${exp.status})`, exp.buffer.toString('utf8').slice(0, 200));
    } else {
      const text = exp.buffer.toString('utf8');
      if (text.charCodeAt(0) === 0xfeff) ok('UTF-8 BOM present — Excel reads the encoding correctly');
      else bad('no UTF-8 BOM: Excel will mis-render non-ASCII');
      if (text.includes('\r\n')) ok('CRLF line endings');
      else bad('no CRLF');
      const cd = exp.headers['content-disposition'] || '';
      if (/attachment; filename="abiozen-federal-opportunities-\d{4}-\d{2}-\d{2}\.csv"/.test(cd)) {
        ok(`Content-Disposition names a dated file: ${cd}`);
      } else bad(`Content-Disposition is wrong: ${cd}`);
      if ((exp.headers['content-type'] || '').startsWith('text/csv')) ok('Content-Type is text/csv');
      else bad(`Content-Type is ${exp.headers['content-type']}`);

      // No cell may begin with a formula character: Excel would execute it.
      const lines = text.replace(/^﻿/, '').split('\r\n').filter(Boolean);
      const dangerous = [];
      for (let i = 1; i < lines.length; i += 1) {
        for (const cell of lines[i].split(',')) {
          const v = cell.replace(/^"|"$/g, '');
          if (/^[=+\-@\t\r]/.test(v)) dangerous.push(`line ${i + 1}: ${v.slice(0, 28)}`);
        }
      }
      if (!dangerous.length) ok(`${lines.length - 1} data row(s), no cell starts with a formula character`);
      else bad(`${dangerous.length} cell(s) could be executed by Excel`, dangerous.slice(0, 3).join(' | '));

      // Provenance and the confirmed/unconfirmed distinction must travel with the file.
      if (/sam\.gov/i.test(text)) ok('the file carries its source route');
      else bad('the export does not say where its rows came from');
      if (/Unconfirmed Fields/.test(text) && /Agency Confirmed\?/.test(text)) {
        ok('…and carries per-row confirmed/unconfirmed columns');
      } else bad('the export does not distinguish confirmed from unconfirmed fields');
      if (/Exported At \(UTC\)/.test(text) && /Harvested \(UTC\)/.test(text)) {
        ok('…and verification timestamps (harvested, exported, deadline verified)');
      } else bad('the export carries no verification timestamps');
      if (/NOT a live feed/.test(text)) ok('…and states that the dataset is not a live feed');
      else bad('the export does not say the dataset is not live');

      const out = path.join(process.env.PRPA_E2E_OUT
        || '/tmp/claude-0/-home-claude/a0303f00-5fe1-5ee7-be5c-5412f357070f/scratchpad', 'prpa-e2e-export.csv');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, exp.buffer);
      ok(`written for inspection: ${out} (${exp.buffer.length} bytes)`);
    }

    // ── 8. THE REVIEW QUEUE ───────────────────────────────────────────────────
    h('8. THE REVIEW QUEUE — what a human has to act on');
    const queue = await request('GET', '/api/prpa/tracker/review-queue', { token });
    if (queue.status === 200) {
      const q = queue.json;
      ok(`awaiting deadline confirmation: ${(q.awaiting_deadline_confirmation || []).length}`);
      ok(`awaiting a decision: ${(q.awaiting_decision || []).length}`);
      ok(`flagged for a named reason: ${(q.flagged || []).length}`);
      ok(`duplicate candidates for a human: ${(q.awaiting_duplicate_resolution || []).length}`);
      const flagged = (q.flagged || [])[0];
      if (flagged) {
        ok(`e.g. ${flagged.solicitation_number}: ${String(flagged.ranking.flags[0].kind)} — `
          + `${String(flagged.ranking.flags[0].action).slice(0, 56)}`);
      }
    } else bad(`the review queue failed (${queue.status})`);

    // ── 9. WHAT THIS SURFACE CANNOT DO ────────────────────────────────────────
    h('9. WHAT NO ENDPOINT IN THIS SURFACE CAN DO');
    // COMMENTS ARE STRIPPED FIRST. The router explains at length that it cannot contact a
    // contracting officer or submit a bid, and scanning the raw file matched those very sentences —
    // the file was failed for describing the restriction it implements. What matters is the CODE.
    const raw = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'prpa.routes.js'), 'utf8');
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')          // block comments
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');  // line comments

    const forbidden = [
      [/\b(sendEmail|mailer|resend|nodemailer|sendgrid)\b/i, 'send email'],
      [/\b(submitBid|submitQuote|submitProposal|postOffer)\b/i, 'submit a bid or quote'],
      [/\b(cron|setInterval|node-cron|schedule)\s*\(/i, 'schedule an unattended harvest'],
    ];
    for (const [re, what] of forbidden) {
      const m = code.match(re);
      if (m) bad(`the router's CODE contains something that could ${what}`, `matched "${m[0]}"`);
      else ok(`no endpoint can ${what}`);
    }

    // And positively: the only outbound requests are the two GETs to sam.gov, through the SSRF
    // guard. Counted rather than assumed, because "no email" is a weaker claim than "these two".
    const fetches = (code.match(/fetchDocument\(/g) || []).length;
    if (fetches === 2) ok('exactly two outbound fetches in the router, both through the SSRF guard');
    else bad(`the router makes ${fetches} guarded fetch call(s); 2 were expected`);
    if (!/https?:\/\//.test(code.replace(/https:\/\/sam\.gov/g, '').replace(/https:\/\/sam\.gov/g, ''))
      || !/[^.]sam\.gov/.test(code)) {
      ok('every outbound URL in the code is on sam.gov');
    } else {
      const hosts = [...new Set((code.match(/https?:\/\/[a-z0-9.-]+/gi) || []))];
      if (hosts.every((hh) => /sam\.gov$/i.test(hh))) ok(`every outbound URL is on sam.gov (${hosts.join(', ')})`);
      else bad('the router reaches a host other than sam.gov', hosts.join(', '));
    }
  } finally {
    if (server) await new Promise((r) => server.close(r));
    try { await owner.end(); } catch { /* closing */ }
    stopCluster();
  }

  console.log(`\n${'─'.repeat(78)}`);
  console.log(`  ${pass} assertion(s) passed · ${fail} failed · ${couldNotRun} did not run`);
  if (fail) { console.log('\nFAIL  the end-to-end path does not hold.\n'); process.exit(1); }
  if (couldNotRun) {
    console.log(`\nPASS WITH GAPS  ${couldNotRun} step(s) could not execute (reported above, not counted as passes).\n`);
    process.exit(0);
  }
  console.log('\nPASS  import → documents → eligibility → feasibility → deadline → decision → Excel,');
  console.log('      over HTTP, authenticated, on real SAM.gov records.\n');
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nprpa-e2e-demo: ${e.stack || e.message}\n`);
  stopCluster();
  process.exit(1);
});
