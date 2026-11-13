#!/usr/bin/env node
// ── THE WHOLE THING, END TO END, OVER HTTP ───────────────────────────────────
//
//   node scripts/demo-approval-dispatch-e2e.js
//
// Spec A milestone 6 last mile, item 6: one complete workflow in an isolated environment with a
// mocked provider, reporting ACTUAL state transitions.
//
// ── WHAT IS REAL ─────────────────────────────────────────────────────────────
//
// The approvals router (src/api/approvals.routes.js) mounted in express and driven over a real
// socket. The approval lifecycle. The governed dispatch boundary. The campaign copy, the MIME
// builder, the digest. The sender service — its real handleSend, with its real signature check,
// reached through its real HTTP client.
//
// ── WHAT IS MOCKED ───────────────────────────────────────────────────────────
//
// The database (approval rows in a Map, the ledger in an array), auth (one admin), the kill switch
// (a variable), and THE PROVIDER (a counter). No credential exists in either process; the sender
// service is handed a transport that counts.
//
// So: two processes' worth of code, one socket between them, and nothing that can reach Google.
//
// Exit 0 only if every transition and every invocation count is as stated.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'PLACEHOLDER-not-a-secret';
// A PLACEHOLDER, and the naming matters: scripts/check-secrets.js flags a hard-coded fallback
// whose value does not announce itself as fake, and the repository's convention for these is
// PLACEHOLDER-/REPLACE_ME_. This value authenticates nothing outside this process.
process.env.SENDER_SERVICE_SECRET = 'PLACEHOLDER-not-a-secret-local-demo-only';

const http = require('http');
const express = require('express');

const FOLLOWUP = require('../src/lib/campaigns/cphi-followup');
const { buildMessage } = require('../src/lib/gmail/message');
const OUTREACH = require('../src/lib/agents/outreach-approval');
const D = require('../src/lib/outbound/dispatch');
const LEDGER = require('../src/lib/outbound/ledger');
const SENDER = require('../src/services/sender/server');
const SENDER_CLIENT = require('../src/lib/outbound/transports/sender-client');

const FROM = 'naren@abiozen.com';
const ADMIN = 'naren@abiozen.com';
const ENV = { COMPANY_DOMAINS: 'abiozen.com,adificetechnologies.com',
  SENDER_SERVICE_SECRET: process.env.SENDER_SERVICE_SECRET };

let fail = 0;
const line = (s = '') => console.log(s);
const rule = (c = '─') => line(c.repeat(78));
const check = (ok, what, detail) => {
  if (!ok) fail += 1;
  line(`  ${ok ? ' ok ' : 'FAIL'}  ${what}${detail ? `\n          ${detail}` : ''}`);
};

// ── THE PROVIDER: A COUNTER, INSIDE THE SENDER SERVICE ──────────────────────
const provider = { calls: [] };
const providerTransport = async (m) => {
  provider.calls.push({ to: m.to, bytes: (m.raw || '').length });
  return { ok: true, id: `gmail-${provider.calls.length}`, providerResponded: true,
    meta: { threadId: `thread-${provider.calls.length}` } };
};

// ── THE LEDGER: ONE ROW PER ATTEMPT, UPDATED IN PLACE, AS THE REAL ONE IS ───
const transitions = [];
const ledgerRows = [];
const UNSAFE = ['CLAIMED', 'PROVIDER_ACCEPTED', 'OUTCOME_UNKNOWN', 'RECONCILED'];
const ledger = {
  beginAttempt: async (a) => {
    const row = { id: `att-${ledgerRows.length + 1}`, outcome: 'PREPARED', claimRef: a.claimRef,
      approvalId: a.approvalId, to: a.to };
    ledgerRows.push(row);
    transitions.push([row.id, 'PREPARED', `claim ${a.claimRef}`]);
    const set = (o, note) => { row.outcome = o; transitions.push([row.id, o, note || '']); };
    return { ok: true, id: row.id,
      blocked: async (why, scope) => set('BLOCKED', `scope ${scope}`),
      claim: async () => { set('CLAIMED', 'responsibility taken, before the provider call'); return { ok: true }; },
      accepted: async (p) => set('PROVIDER_ACCEPTED', `provider id ${p}`),
      rejected: async (e) => set('PROVIDER_REJECTED', String(e)),
      unknown: async (e) => set('OUTCOME_UNKNOWN', String(e)) };
  },
  priorClaim: async (ref, { excludeId } = {}) => ledgerRows.find((r) =>
    r.claimRef === ref && r.id !== excludeId && UNSAFE.includes(r.outcome)) || null,
};

const stop = { active: false };
const gate = { assertSendAllowed: async () => (stop.active
  ? { allowed: false, reason: 'STOPPED_BY_POLICY: capability:email.send — all platform email held',
    scope: 'capability:email.send' }
  : { allowed: true }) };

// ── THE APPROVAL STORE, WITH THE REAL CLAIM SEMANTICS ───────────────────────
const approvals = new Map();
const approvalStore = {
  approval: {
    prepare: async (ctx, { id, actionKind, actionPayload, reason }) => {
      if (approvals.has(id)) throw new Error('duplicate key value violates unique constraint');
      approvals.set(id, { id, company_id: 'abiozen', run_id: ctx.runId, action_kind: actionKind,
        action_payload: actionPayload, reason, status: 'pending',
        created_at: new Date().toISOString(), resolved_at: null, resolved_by: null,
        released_at: null, released_by: null, workflow: 'cphi-followup', agent: 'cphi-runner' });
      return { approvalId: id, status: 'pending' };
    },
    // The arbitration point, modelled on scope.claimApprovalRelease: ONE decision, in the
    // condition, not a SELECT the caller is trusted to have done.
    release: async (ctx, { approvalId, releasedBy }) => {
      const r = approvals.get(approvalId);
      if (!r) return { released: false, reason: 'not_found' };
      if (r.status !== 'approved' || r.released_at) {
        return { released: false, reason: r.released_at ? 'already_released' : `not_approved (${r.status})`,
          status: r.status };
      }
      r.released_at = new Date().toISOString();
      r.released_by = releasedBy;
      return { released: true, actionKind: r.action_kind, actionPayload: r.action_payload,
        releasedAt: r.released_at };
    },
  },
};

// ── MOUNT THE REAL ROUTER WITH DOUBLES UNDERNEATH ───────────────────────────
function mountApprovals(senderUrl) {
  const prime = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };

  prime('../src/lib/core', {
    authMiddleware: (req, res, next) => { req.user = { email: ADMIN, role: 'super_admin' }; next(); },
    adminOnly: (req, res, next) => next(),
  });
  prime('../src/lib/office/context', {
    resolveCompanyForReadSession: async () => ({ ok: true, companyId: 'abiozen', runId: 'run-e2e',
      context: { companyId: 'abiozen', runId: 'run-e2e' } }),
  });
  prime('../src/lib/office/scope', {
    approvalForReview: async (ctx, id) => approvals.get(id) || null,
    decideApproval: async () => ({ ok: true }),
  });
  prime('../src/lib/agents/outreach-approval', {
    ...OUTREACH,
    releaseOutreachEmail: (ctx, args) => OUTREACH.releaseOutreachEmail(ctx, args, approvalStore),
  });
  prime('../src/lib/outbound/dispatch', {
    ...D,
    // The transport is the REAL sender-service client, pointed at the real service over a socket.
    dispatch: (args) => D.dispatch(args, {
      env: ENV, gate, ledger,
      transports: {
        gmail_cphi: SENDER_CLIENT.transportFor('gmail_cphi',
          { url: senderUrl, secret: process.env.SENDER_SERVICE_SECRET }),
      },
    }),
  });

  delete require.cache[require.resolve('../src/api/approvals.routes')];
  const router = require('../src/api/approvals.routes');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

function req(server, method, p, body) {
  const data = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request({ method, hostname: '127.0.0.1', port: server.address().port, path: p,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
    (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }); } catch (e) { resolve({ status: res.statusCode, body: { raw: b } }); } });
    });
    r.on('error', reject);
    r.end(data || undefined);
  });
}

(async () => {
  rule('═');
  line('APPROVE → RELEASE → DISPATCH, END TO END, TWO PROCESSES, ONE SOCKET');
  line('Spec A milestone 6 last mile · mocked provider · no credential in either process');
  rule('═');

  // ── THE SENDER SERVICE, IN ITS OWN SERVER ─────────────────────────────────
  const sender = SENDER.createServer({
    env: ENV, gate, ledger,
    handlers: { gmail_cphi: providerTransport },
  });
  await new Promise((r) => sender.listen(0, '127.0.0.1', r));
  const senderUrl = `http://127.0.0.1:${sender.address().port}`;

  const app = mountApprovals(senderUrl);
  const api = http.createServer(app);
  await new Promise((r) => api.listen(0, '127.0.0.1', r));

  const ui = (p, body) => req(api, body === undefined ? 'GET' : 'POST', `/api${p}`, body);

  try {
    line();
    line(`  sender service     ${senderUrl}  (holds the transport; in production, the credential)`);
    line(`  application        127.0.0.1:${api.address().port}  (holds a signing secret only)`);
    line();

    // ══ 1. THE AGENT PREPARES ══════════════════════════════════════════════
    rule(); line('1 · THE AGENT QUEUES A DECISION'); rule(); line();

    const contact = { id: 4821, name: 'Luca Segàla', company: 'Nordkem SpA',
      email: 'l.segala@nordkem.test' };
    const rendered = FOLLOWUP.render('supplier', 2,
      { first: contact.name.split(' ')[0], company: contact.company, event: 'CPHI Milan' });
    const msg = buildMessage({
      from: { name: FOLLOWUP.SIG_NAME, email: FROM },
      to: { name: contact.name, email: contact.email },
      subject: rendered.subject || `Re: CPHI Milan — ${contact.company}`,
      text: rendered.text, html: rendered.html, references: [], attachments: [],
    });

    const queued = await OUTREACH.prepareOutreachEmail({ runId: 'run-e2e', companyId: 'abiozen' }, {
      to: contact.email, subject: msg.headers.Subject, raw: msg.raw, mailbox: FROM,
      transport: 'gmail_cphi', campaign: 'supplier', step: 2, contactRef: String(contact.id),
      preview: rendered.html,
    }, approvalStore);

    line(`  approval           ${queued.approvalId}`);
    line(`  digest             ${queued.transportDigest}  (over ${msg.raw.length} raw bytes)`);
    check(queued.prepared === true, 'queued for a human');

    let detail = await ui(`/approvals/${queued.approvalId}`);
    line(`  ui_state           ${detail.body.ui_state}`);
    line(`  can_dispatch       ${detail.body.can_dispatch}`);
    check(detail.body.ui_state === 'pending', 'the screen shows PENDING');
    check(detail.body.can_dispatch === false, 'and offers no dispatch button yet');

    // ══ 2. DISPATCH BEFORE A DECISION ══════════════════════════════════════
    line();
    rule(); line('2 · SOMEONE POSTS /dispatch ANYWAY, BEFORE DECIDING'); rule(); line();

    let r = await ui(`/approvals/${queued.approvalId}/dispatch`, {});
    line(`  HTTP               ${r.status} ${r.body.code}`);
    line(`  ui_state           ${r.body.ui_state}`);
    check(r.status === 409 && provider.calls.length === 0,
      `refused, provider invocations: ${provider.calls.length} (expected 0)`);

    // ══ 3. THE HUMAN DECIDES ═══════════════════════════════════════════════
    line();
    rule(); line('3 · NARESH APPROVES'); rule(); line();

    approvals.get(queued.approvalId).status = 'approved';
    approvals.get(queued.approvalId).resolved_at = new Date().toISOString();
    approvals.get(queued.approvalId).resolved_by = ADMIN;

    detail = await ui(`/approvals/${queued.approvalId}`);
    line(`  ui_state           ${detail.body.ui_state}`);
    line(`  can_dispatch       ${detail.body.can_dispatch}`);
    check(detail.body.ui_state === 'approved', 'the screen shows APPROVED');
    check(detail.body.can_dispatch === true, 'and now offers the dispatch button');

    // ══ 4. A STOP IS IN FORCE ══════════════════════════════════════════════
    line();
    rule(); line('4 · A STOP IS ACTIVE — THE BUTTON IS PRESSED'); rule(); line();

    stop.active = true;
    r = await ui(`/approvals/${queued.approvalId}/dispatch`, {});
    stop.active = false;
    line(`  HTTP               ${r.status} ${r.body.code}`);
    line(`  ui_state           ${r.body.ui_state}`);
    line(`  detail             ${String(r.body.detail || '').slice(0, 64)}…`);
    check(provider.calls.length === 0,
      `a STOP refused an approved dispatch, provider invocations: ${provider.calls.length} (expected 0)`);
    check(r.body.ui_state === 'blocked', 'reported as BLOCKED, not FAILED');

    // That spent the approval — one decision authorises one attempt. Re-prepare and re-approve,
    // which is the honest cost of the design and worth showing rather than hiding.
    line();
    line('  → the approval is now spent. Re-preparing and re-approving, as the design requires.');
    const again = await OUTREACH.prepareOutreachEmail({ runId: 'run-e2e-2', companyId: 'abiozen' }, {
      to: contact.email, subject: msg.headers.Subject, raw: msg.raw, mailbox: FROM,
      transport: 'gmail_cphi', campaign: 'supplier', step: 2, contactRef: String(contact.id),
      preview: rendered.html,
    }, approvalStore);
    approvals.get(again.approvalId).status = 'approved';
    approvals.get(again.approvalId).resolved_by = ADMIN;
    line(`  new approval       ${again.approvalId}`);

    // ══ 5. TEN SIMULTANEOUS CLICKS ═════════════════════════════════════════
    line();
    rule(); line('5 · THE OPERATOR DOUBLE-CLICKS. TEN REQUESTS IN FLIGHT AT ONCE.'); rule(); line();

    const all = await Promise.all(Array.from({ length: 10 },
      () => ui(`/approvals/${again.approvalId}/dispatch`, {})));
    const ok = all.filter((x) => x.status === 200);
    const codes = {};
    for (const x of all) { const k = `${x.status} ${x.body.code || x.body.ui_state}`; codes[k] = (codes[k] || 0) + 1; }

    for (const [k, n] of Object.entries(codes)) line(`  ${String(n).padStart(2)} ×  ${k}`);
    line();
    check(ok.length === 1, `exactly one request succeeded (${ok.length})`);
    check(provider.calls.length === 1,
      `provider invocations: ${provider.calls.length} (expected 1) — one decision, one send`);
    check(ok[0] && ok[0].body.ui_state === 'delivered_to_provider',
      `the winner reports DELIVERED TO PROVIDER (${ok[0] && ok[0].body.provider_id})`);
    check(all.filter((x) => x.status !== 200).every((x) => x.body.provider_invocations === 0),
      'and every loser reports 0 provider invocations');

    // ══ 6. TAMPERING ═══════════════════════════════════════════════════════
    line();
    rule(); line('6 · THE STORED PAYLOAD IS ALTERED, THEN DISPATCHED'); rule(); line();

    const third = await OUTREACH.prepareOutreachEmail({ runId: 'run-e2e-3', companyId: 'abiozen' }, {
      to: contact.email, subject: msg.headers.Subject, raw: msg.raw, mailbox: FROM,
      transport: 'gmail_cphi', campaign: 'supplier', step: 3, contactRef: String(contact.id),
      preview: rendered.html,
    }, approvalStore);
    approvals.get(third.approvalId).status = 'approved';
    approvals.get(third.approvalId).resolved_by = ADMIN;
    approvals.get(third.approvalId).action_payload.raw =
      Buffer.from('a completely different letter').toString('base64url');

    const before = provider.calls.length;
    r = await ui(`/approvals/${third.approvalId}/dispatch`, {});
    line(`  HTTP               ${r.status} ${r.body.code}`);
    line(`  ui_state           ${r.body.ui_state}`);
    check(provider.calls.length === before,
      `provider invocations unchanged at ${provider.calls.length} — the tampered payload never left`);
    check(r.body.code === 'approved_payload_altered', 'refused at the digest comparison');

    // ══ 7. THE TRANSITIONS ═════════════════════════════════════════════════
    line();
    rule(); line('7 · ACTUAL LEDGER STATE TRANSITIONS'); rule(); line();
    line('  attempt   outcome              detail');
    line('  ' + '-'.repeat(72));
    for (const [id, outcome, note] of transitions) {
      line(`  ${id.padEnd(9)} ${outcome.padEnd(20)} ${String(note).slice(0, 40)}`);
    }
    line();
    const accepted = transitions.filter(([, o]) => o === 'PROVIDER_ACCEPTED').length;
    const blocked = transitions.filter(([, o]) => o === 'BLOCKED').length;

    // ── TWO ROWS PER SEND, ONE PROVIDER INVOCATION ──────────────────────────
    //
    // Deliberate, and my first expectation here (exactly one) was wrong. The milestone requires
    // the sender service to enforce auditability INDEPENDENTLY, so each layer writes its own
    // record: dispatch logs the application's intent under `<key>`, the service logs the request
    // it actually served under `sender:<key>`. One provider invocation, two audit rows, and that
    // is the honest shape of a two-layer boundary — a service whose row depended on the
    // application's would not be independent.
    //
    // CONSEQUENCE WORTH NAMING: a report that counts MAY_HAVE_LEFT rows per transport will now
    // double-count every send. executionByTransport() groups by transport and both rows carry the
    // same transport name, so the containment arithmetic needs a decision before this is
    // deployed — either group by the claim_ref namespace or count the service's rows only.
    check(provider.calls.length === 1,
      `one provider invocation (${provider.calls.length}), whatever the row count`);
    check(accepted === 2,
      `two PROVIDER_ACCEPTED rows for one send (${accepted}) — one per layer, by design`);
    check(blocked >= 1, `every refusal recorded (${blocked} BLOCKED)`);

    const appRow = ledgerRows.find((r) => r.claimRef && !r.claimRef.startsWith('sender:'));
    const svcRow = ledgerRows.find((r) => r.claimRef && r.claimRef.startsWith('sender:'));
    check(!!appRow && !!svcRow,
      'the two rows are distinguishable by their claim namespace, so an auditor can tell '
      + 'the application\'s intent from the service\'s own record');

    // ══ 8. CREDENTIAL ISOLATION, OBSERVED ══════════════════════════════════
    line();
    rule(); line('8 · THE SENDER SERVICE AS AN INDEPENDENT PROCESS'); rule(); line();

    // An unsigned request straight to the service, bypassing the application entirely.
    const unsigned = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ message: { to: contact.email, subject: 'x', raw: msg.raw,
        mailbox: FROM }, transport: 'gmail_cphi', idempotencyKey: 'forged-1' });
      const rq = http.request({ method: 'POST', hostname: '127.0.0.1',
        port: sender.address().port, path: '/send',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') })); });
      rq.on('error', reject);
      rq.end(body);
    });
    line(`  unsigned POST      ${unsigned.status} ${unsigned.body.phase}`);
    check(unsigned.status === 401 && provider.calls.length === 1,
      `an unsigned request was refused; provider invocations still ${provider.calls.length}`);

    const appCode = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'api', 'approvals.routes.js'), 'utf8');
    const holdsCredential = /RESEND_API_KEY|GOOGLE_REFRESH_TOKEN|transports\/gmail|googleapis/
      .test(require('./js-lex').blankCommentsOnly(appCode));
    line(`  app holds a key    ${holdsCredential}`);
    check(holdsCredential === false,
      'the application route holds no send-capable credential and cannot reach a provider directly');

    // ══ VERDICT ════════════════════════════════════════════════════════════
    line();
    rule('═');
    if (fail) {
      line(`FAIL  ${fail} check(s) did not hold. The last mile is NOT as described.`);
      process.exitCode = 1;
      return;
    }
    line('PASS  pending → approved → blocked (STOP) → re-approved → delivered_to_provider.');
    line(`      1 provider invocation across 13 dispatch requests.`);
    line('      0 invocations from: undecided, STOPped, 9 duplicate clicks, tampered, unsigned.');
    rule('═');
  } finally {
    await new Promise((r) => api.close(r));
    await new Promise((r) => sender.close(r));
  }
})().catch((e) => {
  console.error(`\nFAILED: ${(e && e.stack) || e}`);
  process.exit(1);
});
