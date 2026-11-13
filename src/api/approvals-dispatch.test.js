// ── CAN A CLICK ON THE APPROVALS SCREEN SEND SOMETHING IT SHOULD NOT? ────────
//
//   node --test src/api/approvals-dispatch.test.js
//
// Spec A milestone 6 last mile, item 4: prove that denial, tampering, duplicate clicks and STOP
// activation result in ZERO provider invocations.
//
// Driven over real HTTP against the real router, with the provider as a counter. Every control
// asserts an invocation count, including every zero — "the response said 409" is not evidence that
// nothing left, and this project has twice mistaken one for the other.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'approvals-dispatch-test';

const assert = require('node:assert');
const { test } = require('node:test');
const http = require('http');
const express = require('express');
const fs = require('fs');
const path = require('path');

const OUTREACH = require('../lib/agents/outreach-approval');
const D = require('../lib/outbound/dispatch');
const LEDGER = require('../lib/outbound/ledger');

const CONTACT = 'l.segala@nordkem.test';
const RAW = Buffer.from('From: naren@abiozen.com\r\nTo: l.segala@nordkem.test\r\n\r\nHi Luca.').toString('base64url');
const ENV = { COMPANY_DOMAINS: 'abiozen.com,adificetechnologies.com' };

const digestOf = (m) => LEDGER.digestOf({
  to: m.to, subject: `raw:${m.subject}`, html: String(m.raw),
});

// ── THE WORLD, MOCKED ───────────────────────────────────────────────────────
//
// The router is real. Everything it reaches is a double, including the provider, which is a
// counter. Nothing in this process holds a credential or can open a socket to Google.

function world({ stopped = false } = {}) {
  const sends = [];
  const rows = new Map();          // approval_queue
  const ledgerRows = [];           // email_log

  const id = 'ap-run-1-outreach.email.send-4821-abc123';
  const payload = {
    to: CONTACT, subject: 'Re: CPHI Milan', raw: RAW, mailbox: 'naren@abiozen.com',
    transport: 'gmail_cphi', thread_id: null, campaign: 'supplier', step: 2,
    contact_ref: '4821', preview: '<p>Hi Luca.</p>',
  };
  payload.transport_digest = digestOf(payload);
  rows.set(id, {
    id, company_id: 'abiozen', run_id: 'run-1', action_kind: OUTREACH.ACTION_KIND,
    action_payload: payload, status: 'approved', resolved_at: new Date().toISOString(),
    resolved_by: 'naren@abiozen.com', released_at: null, released_by: null,
    reason: `outreach email to ${CONTACT}`, created_at: new Date().toISOString(),
    workflow: 'cphi-followup', agent: 'cphi-runner',
  });

  const UNSAFE = ['CLAIMED', 'PROVIDER_ACCEPTED', 'OUTCOME_UNKNOWN', 'RECONCILED'];
  const ledger = {
    rows: ledgerRows,
    beginAttempt: async (a) => {
      const row = { id: `att-${ledgerRows.length + 1}`, outcome: 'PREPARED',
        claimRef: a.claimRef, approvalId: a.approvalId };
      ledgerRows.push(row);
      const set = (o, x = {}) => { row.outcome = o; Object.assign(row, x); };
      return { ok: true, id: row.id,
        blocked: async (why, scope) => set('BLOCKED', { scope, why }),
        claim: async () => set('CLAIMED'),
        accepted: async (p) => set('PROVIDER_ACCEPTED', { provider_id: p }),
        rejected: async (e) => set('PROVIDER_REJECTED', { e }),
        unknown: async (e) => set('OUTCOME_UNKNOWN', { e }) };
    },
    priorClaim: async (ref, { excludeId } = {}) => ledgerRows.find((r) =>
      r.claimRef === ref && r.id !== excludeId && UNSAFE.includes(r.outcome)) || null,
  };

  const gate = { assertSendAllowed: async () => (stopped
    ? { allowed: false, reason: 'STOPPED_BY_POLICY: capability:email.send — all platform email held',
      scope: 'capability:email.send' }
    : { allowed: true }) };

  return { sends, rows, ledger, ledgerRows, gate, approvalId: id, payload,
    transport: { send: async (m) => { sends.push(m.to); return { ok: true, id: `gmail-${sends.length + 0}`, meta: { threadId: 't-1' } }; } } };
}

/**
 * The real route, with its collaborators injected.
 *
 * The router requires its modules at call time (`require` inside the handler), which is what makes
 * this possible without a database: the cache is primed with doubles before the handler runs.
 */
function mountRoute(w) {
  // Prime the module cache with doubles for exactly the three collaborators the handler reaches.
  const resolve = (rel) => require.resolve(rel);

  const scopePath = resolve('../lib/office/scope');
  const dispatchPath = resolve('../lib/outbound/dispatch');
  const outreachPath = resolve('../lib/agents/outreach-approval');
  const corePath = resolve('../lib/core');
  const ctxPath = resolve('../lib/office/context');
  const saved = {};
  for (const p of [scopePath, dispatchPath, outreachPath, corePath, ctxPath]) {
    saved[p] = require.cache[p];
  }

  require.cache[corePath] = { id: corePath, filename: corePath, loaded: true, exports: {
    authMiddleware: (req, res, next) => { req.user = { email: 'naren@abiozen.com', role: 'super_admin' }; next(); },
    adminOnly: (req, res, next) => next(),
  } };
  require.cache[ctxPath] = { id: ctxPath, filename: ctxPath, loaded: true, exports: {
    resolveCompanyForReadSession: async () => ({ ok: true, companyId: 'abiozen', runId: 'run-1',
      context: { companyId: 'abiozen', runId: 'run-1' } }),
  } };
  require.cache[scopePath] = { id: scopePath, filename: scopePath, loaded: true, exports: {
    approvalForReview: async (ctx, id) => w.rows.get(id) || null,
    decideApproval: async () => ({ ok: true }),
  } };
  require.cache[outreachPath] = { id: outreachPath, filename: outreachPath, loaded: true, exports: {
    ...OUTREACH,
    releaseOutreachEmail: (ctx, args) => OUTREACH.releaseOutreachEmail(ctx, args, {
      approval: {
        release: async (c, { approvalId, releasedBy }) => {
          const r = w.rows.get(approvalId);
          if (!r) return { released: false, reason: 'not_found' };
          // ── THE ARBITRATION POINT, as one statement ────────────────────────
          // A second caller finds released_at already set. This is what makes a duplicate click
          // safe regardless of what the browser does.
          if (r.released_at) return { released: false, reason: 'already_released' };
          if (r.status !== 'approved') return { released: false, reason: `not_approved (${r.status})`, status: r.status };
          r.released_at = new Date().toISOString();
          r.released_by = releasedBy;
          return { released: true, actionKind: r.action_kind, actionPayload: r.action_payload,
            releasedAt: r.released_at };
        },
      },
    }),
  } };
  require.cache[dispatchPath] = { id: dispatchPath, filename: dispatchPath, loaded: true, exports: {
    ...D,
    dispatch: (args) => D.dispatch(args, {
      env: ENV, gate: w.gate, ledger: w.ledger, transports: { gmail_cphi: w.transport },
    }),
  } };

  delete require.cache[resolve('./approvals.routes')];
  const router = require('./approvals.routes');
  const app = express();
  app.use(express.json());
  app.use('/api', router);

  const restore = () => {
    for (const [p, mod] of Object.entries(saved)) {
      if (mod) require.cache[p] = mod; else delete require.cache[p];
    }
    delete require.cache[resolve('./approvals.routes')];
  };
  return { app, restore };
}

function request(server, method, p, body) {
  const data = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      method, hostname: '127.0.0.1', port: server.address().port, path: p,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }); } catch (e) { resolve({ status: res.statusCode, body: { raw: b } }); } });
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

/** Run one scenario against a live server. */
async function scenario(w, fn) {
  const { app, restore } = mountRoute(w);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(server);
  } finally {
    await new Promise((r) => server.close(r));
    restore();
  }
}

// ═══ 1. THE PERMITTED PATH ═════════════════════════════════════════════════

test('1. an approved outreach message dispatches once, and reports the state', async () => {
  const w = world();
  await scenario(w, async (server) => {
    const r = await request(server, 'POST', `/api/approvals/${w.approvalId}/dispatch`, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.ui_state, 'delivered_to_provider');
    assert.strictEqual(r.body.provider_invocations, 1);
    assert.strictEqual(w.sends.length, 1);
    assert.deepStrictEqual(w.ledgerRows.map((x) => x.outcome), ['PROVIDER_ACCEPTED'],
      'the ledger does not show exactly one attempt reaching the provider');
    assert.strictEqual(w.rows.get(w.approvalId).released_by, 'naren@abiozen.com');
  });
});

test('1b. and the detail route names the state rather than leaving the browser to infer it', async () => {
  const w = world();
  await scenario(w, async (server) => {
    const before = await request(server, 'GET', `/api/approvals/${w.approvalId}`);
    assert.strictEqual(before.body.ui_state, 'approved');
    assert.strictEqual(before.body.can_dispatch, true);

    await request(server, 'POST', `/api/approvals/${w.approvalId}/dispatch`, {});

    const after = await request(server, 'GET', `/api/approvals/${w.approvalId}`);
    assert.strictEqual(after.body.ui_state, 'delivered_or_unknown');
    assert.strictEqual(after.body.can_dispatch, false,
      'the button would still be offered after the approval was spent');
  });
});

// ═══ 2. DENIAL — 0 INVOCATIONS ═════════════════════════════════════════════

test('2. a REJECTED approval dispatches nothing — 0 invocations', async () => {
  const w = world();
  w.rows.get(w.approvalId).status = 'rejected';
  await scenario(w, async (server) => {
    const r = await request(server, 'POST', `/api/approvals/${w.approvalId}/dispatch`, {});
    assert.strictEqual(w.sends.length, 0, 'a rejected message was transmitted');
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'not_approved');
    assert.strictEqual(r.body.ui_state, 'blocked');
    assert.strictEqual(r.body.provider_invocations, 0);
  });
});

test('2b. a PENDING approval dispatches nothing — 0 invocations', async () => {
  const w = world();
  w.rows.get(w.approvalId).status = 'pending';
  await scenario(w, async (server) => {
    const r = await request(server, 'POST', `/api/approvals/${w.approvalId}/dispatch`, {});
    assert.strictEqual(w.sends.length, 0, 'an undecided message was transmitted');
    assert.strictEqual(r.body.ui_state, 'pending');
    assert.strictEqual(r.body.provider_invocations, 0);
  });
});

test('2c. an approval of ANOTHER KIND cannot be spent here — 0 invocations', async () => {
  // A buyer quotation is excluded deliberately: the inquiry agent releases those after re-comparing
  // the commercial terms against current figures, and releasing one here would skip that.
  const w = world();
  w.rows.get(w.approvalId).action_kind = 'buyer.email.send';
  await scenario(w, async (server) => {
    const r = await request(server, 'POST', `/api/approvals/${w.approvalId}/dispatch`, {});
    assert.strictEqual(w.sends.length, 0);
    assert.strictEqual(r.body.code, 'unsupported_action_kind');
    assert.match(r.body.detail, /commercial terms/);
  });
});

// ═══ 3. TAMPERING — 0 INVOCATIONS ══════════════════════════════════════════

test('3. a payload altered after approval dispatches nothing — 0 invocations', async () => {
  const w = world();
  w.rows.get(w.approvalId).action_payload.raw = Buffer.from('a different letter').toString('base64url');
  await scenario(w, async (server) => {
    const r = await request(server, 'POST', `/api/approvals/${w.approvalId}/dispatch`, {});
    assert.strictEqual(w.sends.length, 0, 'a tampered payload was transmitted');
    assert.strictEqual(r.body.code, 'approved_payload_altered');
    assert.strictEqual(r.body.ui_state, 'blocked');
    assert.strictEqual(r.body.provider_invocations, 0);
  });
});

test('3b. a swapped recipient dispatches nothing — 0 invocations', async () => {
  const w = world();
  w.rows.get(w.approvalId).action_payload.to = 'someone-else@elsewhere.test';
  await scenario(w, async (server) => {
    const r = await request(server, 'POST', `/api/approvals/${w.approvalId}/dispatch`, {});
    assert.strictEqual(w.sends.length, 0, 'an approved message was redirected and still sent');
    assert.strictEqual(r.body.code, 'approved_payload_altered');
  });
});

// ═══ 4. DUPLICATE CLICKS — ONE SEND, NEVER TWO ═════════════════════════════

test('4. clicking twice in sequence sends once', async () => {
  const w = world();
  await scenario(w, async (server) => {
    const first = await request(server, 'POST', `/api/approvals/${w.approvalId}/dispatch`, {});
    const second = await request(server, 'POST', `/api/approvals/${w.approvalId}/dispatch`, {});
    assert.strictEqual(first.status, 200);
    assert.strictEqual(w.sends.length, 1, `the second click sent again (${w.sends.length} total)`);
    assert.strictEqual(second.status, 409);
    assert.ok(['already_released', 'not_approved'].includes(second.body.code), second.body.code);
    assert.strictEqual(second.body.provider_invocations, 0);
  });
});

test('4b. TEN SIMULTANEOUS clicks send once — the release claim is the serialisation point', async () => {
  // Concurrency safety, item 2. Nothing here depends on the browser disabling a button: all ten
  // requests are in flight before any has answered.
  const w = world();
  await scenario(w, async (server) => {
    const all = await Promise.all(Array.from({ length: 10 },
      () => request(server, 'POST', `/api/approvals/${w.approvalId}/dispatch`, {})));

    assert.strictEqual(w.sends.length, 1,
      `${w.sends.length} provider invocations from 10 concurrent clicks — one decision must ` +
      'authorise exactly one send');
    const ok = all.filter((r) => r.status === 200);
    assert.strictEqual(ok.length, 1, `${ok.length} responses claimed success`);
    for (const r of all.filter((x) => x.status !== 200)) {
      assert.strictEqual(r.body.provider_invocations, 0);
    }
  });
});

test('4c. and the idempotency key is derived from the APPROVAL, not the request', async () => {
  // So a retry, a double-submit and a duplicate click all collapse onto one ledger claim. Asserted
  // on the source because the behaviour above would also pass if the key were random and the
  // release claim alone were doing the work — and then a released-but-undispatched approval could
  // be re-dispatched.
  const LEX = require('../../scripts/js-lex');
  const code = LEX.blankCommentsOnly(fs.readFileSync(path.join(__dirname, 'approvals.routes.js'), 'utf8'));
  assert.match(code, /idempotencyKey:\s*`approval:\$\{row\.id\}`/,
    'the idempotency key is not derived from the approval id');
});

// ═══ 5. STOP ACTIVATION — 0 INVOCATIONS ════════════════════════════════════

test('5. a STOP refuses an approved dispatch — 0 invocations', async () => {
  const w = world({ stopped: true });
  await scenario(w, async (server) => {
    const r = await request(server, 'POST', `/api/approvals/${w.approvalId}/dispatch`, {});
    assert.strictEqual(w.sends.length, 0, 'a STOP was in force and the message went anyway');
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'stopped_by_policy');
    assert.strictEqual(r.body.ui_state, 'blocked');
    assert.strictEqual(r.body.provider_invocations, 0);
    assert.ok(w.ledgerRows.some((x) => x.outcome === 'BLOCKED'),
      'the refusal left no ledger row to audit');
  });
});

test('5b. a human approval does NOT override a STOP, and the screen says so', async () => {
  // The screen must not let an operator conclude the button is broken, nor that it overrode a hold.
  const w = world({ stopped: true });
  await scenario(w, async (server) => {
    const r = await request(server, 'POST', `/api/approvals/${w.approvalId}/dispatch`, {});
    assert.match(r.body.detail, /approval is spent/i,
      'the response does not tell the operator what became of their decision');
  });
});

// ═══ 6. THE UI RENDERS THE SERVER'S VERDICT, NOT ITS OWN ═══════════════════

test('6. the screen names all six states and computes none of them', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  for (const state of ['pending', 'approved', 'dispatching', 'delivered_to_provider',
    'blocked', 'failed']) {
    assert.ok(html.includes(`${state}:`) || html.includes(`'${state}'`),
      `the screen has no rendering for the ${state} state`);
  }
  // It must read ui_state off the response rather than deriving one.
  assert.match(html, /apStateChip\(d\.ui_state\)/,
    'the detail view does not render the server-named state');
  assert.match(html, /\(r && r\.ui_state\)/,
    'the dispatch handler infers a state instead of reading the one it was given');
  assert.match(html, /d\.can_dispatch/,
    'the screen decides for itself whether dispatch is possible');
});

test('6b. the handler is assigned to window as an async function expression', () => {
  // Annex B hoists a plain `function` out of a block but NOT an `async function`, so a
  // block-scoped async handler throws ReferenceError on click and does nothing visible. CLAUDE.md
  // names this specifically, and an inline onclick cannot reach it.
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /window\.apDispatch\s*=\s*async function apDispatch\(/,
    'apDispatch is not assigned to window as an async function expression');
  assert.match(html, /onclick="window\.apDispatch\(/,
    'nothing on the screen calls apDispatch');
});

// ═══ 7. NO SEND-CAPABLE CREDENTIAL IN THIS PROCESS ═════════════════════════

test('7. the route reaches a provider only through dispatch, and holds no credential', () => {
  const LEX = require('../../scripts/js-lex');
  const code = LEX.blankCommentsOnly(fs.readFileSync(path.join(__dirname, 'approvals.routes.js'), 'utf8'));
  for (const t of ['RESEND_API_KEY', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_SERVICE_ACCOUNT_JSON',
    'googleapis', 'users.messages.send', 'transports/gmail', 'gmailClientFor']) {
    assert.ok(!code.includes(t), `the approvals route references ${t}`);
  }
  assert.match(code, /require\(['"]\.\.\/lib\/outbound\/dispatch['"]\)/,
    'the route does not go through the governed boundary at all');
});
