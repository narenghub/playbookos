// ── CAN ANYTHING GET PAST THE SENDER SERVICE? ────────────────────────────────
//
//   node --test src/services/sender/server.test.js
//
// Spec A milestone 6, item 1. The service exists so that a compromised application cannot send
// mail. It therefore has to refuse requests that dispatch() would never make — because the threat
// model is precisely that the caller is not dispatch().
//
// Every refusal asserts a PROVIDER-INVOCATION COUNT, including the zeroes. The transport under
// test is a counter; no credential, no network, nothing leaves this process.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const http = require('http');
const fs = require('fs');
const path = require('path');

const S = require('./server');
const { sign } = require('../../lib/outbound/sender-signature');
const LEDGER = require('../../lib/outbound/ledger');

const SECRET = 'test-secret-not-a-credential';
const EXTERNAL = 'buyer@acme-pharma.test';
const INTERNAL = 'ops@abiozen.com';
const ENV = { SENDER_SERVICE_SECRET: SECRET, COMPANY_DOMAINS: 'abiozen.com,adificetechnologies.com' };

const MESSAGE = { to: EXTERNAL, subject: 'Quotation QT-9001', raw: 'UkFXLUJZVEVT', mailbox: 'sales@abiozen.com' };

/** The digest the service computes, from the bytes in the request. */
const digestOf = (m) => LEDGER.digestOf({
  to: Array.isArray(m.to) ? m.to.join(', ') : String(m.to),
  subject: `raw:${m.subject}`,
  html: String(m.raw),
});

function counter() {
  const sends = [];
  return { sends, send: async (m) => { sends.push(m.to); return { ok: true, id: `p-${sends.length}`, meta: { threadId: 't-1' } }; } };
}

function fakeLedger({ priorClaim = null, beginFails = false, throwOnBegin = false } = {}) {
  const rows = [];
  return {
    rows,
    beginAttempt: async (a) => {
      if (throwOnBegin) throw new Error('database unreachable');
      rows.push({ kind: 'PREPARED', to: a.to });
      if (beginFails) return { ok: false, error: 'schema not applied' };
      return { ok: true, id: 'att-1',
        blocked: async (why, scope) => rows.push({ kind: 'BLOCKED', scope, why }),
        claim: async () => { rows.push({ kind: 'CLAIMED' }); return { ok: true }; },
        accepted: async (id) => rows.push({ kind: 'PROVIDER_ACCEPTED', id }),
        rejected: async (e) => rows.push({ kind: 'PROVIDER_REJECTED', e }),
        unknown: async (e) => rows.push({ kind: 'OUTCOME_UNKNOWN', e }) };
    },
    priorClaim: async () => priorClaim,
  };
}

const allow = { assertSendAllowed: async () => ({ allowed: true }) };
const deny = { assertSendAllowed: async () => ({ allowed: false, reason: 'STOPPED_BY_POLICY: capability:email.send', scope: 'capability:email.send' }) };

/** A signed request, as the client would make it. */
function signed(payload, { secret = SECRET, timestamp = Date.now(), p = '/send' } = {}) {
  const raw = JSON.stringify(payload);
  return { raw, timestamp, signature: sign(secret, { method: 'POST', path: p, timestamp, body: raw }) };
}

async function call(payload, over = {}, reqOver = {}) {
  const c = over.transport || counter();
  const deps = {
    env: over.env || ENV,
    gate: over.gate || allow,
    ledger: over.ledger || fakeLedger(),
    handlers: { gmail_cphi: c.send },
    now: over.now,
  };
  const out = await S.handleSend({ ...signed(payload, reqOver), ...(reqOver.override || {}) }, deps);
  return { out, sends: c.sends, ledger: deps.ledger };
}

const GOOD = (m = MESSAGE) => ({
  message: m, transport: 'gmail_cphi', idempotencyKey: 'inq-1001',
  approvalId: 'apv-1001', expectedDigest: digestOf(m), workflow: 'inquiry', agent: 'inquiry-agent',
});

// ═══ 1. THE PERMITTED PATH, or every refusal below proves nothing ═══════════

test('1. a fully governed external send is transmitted once', async () => {
  const { out, sends, ledger } = await call(GOOD());
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(out.body.ok, true);
  assert.strictEqual(sends.length, 1);
  assert.deepStrictEqual(ledger.rows.map((r) => r.kind),
    ['PREPARED', 'CLAIMED', 'PROVIDER_ACCEPTED']);
});

// ═══ 2. AUTHENTICATION — THE CALLER IS NOT ASSUMED TO BE dispatch() ════════

test('2. an unsigned request is refused — 0 invocations', async () => {
  const { out, sends } = await call(GOOD(), {}, { override: { signature: null, timestamp: null } });
  assert.strictEqual(sends.length, 0);
  assert.strictEqual(out.status, 401);
  assert.strictEqual(out.body.phase, 'unsigned');
});

test('2b. a signature from the wrong secret is refused — 0 invocations', async () => {
  const { out, sends } = await call(GOOD(), {}, { secret: 'not-the-secret' });
  assert.strictEqual(sends.length, 0);
  assert.strictEqual(out.body.phase, 'bad_signature');
});

test('2c. a replayed request is refused once it is stale — 0 invocations', async () => {
  const old = Date.now() - (S.MAX_SKEW_MS + 60000);
  const { out, sends } = await call(GOOD(), {}, { timestamp: old });
  assert.strictEqual(sends.length, 0);
  assert.strictEqual(out.body.phase, 'stale_signature');
});

test('2d. a signature cannot be lifted onto a DIFFERENT message — 0 invocations', async () => {
  // This is what makes it authentication of a request rather than a password. The signature covers
  // the body, so swapping the payload under a valid signature fails.
  const honest = GOOD();
  const { raw, signature, timestamp } = signed(honest);
  const tampered = JSON.stringify({ ...honest, message: { ...MESSAGE, to: 'elsewhere@evil.test' } });
  assert.notStrictEqual(raw, tampered);

  const c = counter();
  const out = await S.handleSend({ raw: tampered, signature, timestamp },
    { env: ENV, gate: allow, ledger: fakeLedger(), handlers: { gmail_cphi: c.send } });
  assert.strictEqual(c.sends.length, 0, 'a valid signature was reused on a different message');
  assert.strictEqual(out.body.phase, 'bad_signature');
});

test('2e. with no secret configured the service refuses everything — 0 invocations', async () => {
  const { out, sends } = await call(GOOD(), { env: { COMPANY_DOMAINS: 'abiozen.com' } });
  assert.strictEqual(sends.length, 0);
  assert.strictEqual(out.status, 503);
  assert.strictEqual(out.body.phase, 'service_misconfigured');
});

// ═══ 3. IT RE-CHECKS EVERYTHING, INDEPENDENTLY ═════════════════════════════

test('3. a signed request for an external recipient with no approval is refused — 0 invocations', async () => {
  // dispatch() would never send this. The service refuses it anyway, because the threat model is
  // that the caller is NOT dispatch.
  const { out, sends } = await call({ ...GOOD(), approvalId: null, expectedDigest: null });
  assert.strictEqual(sends.length, 0, 'the service accepted an unapproved external send');
  assert.strictEqual(out.status, 403);
  assert.strictEqual(out.body.needsApproval, true);
});

test('3b. a digest mismatch is refused, computed from THESE bytes — 0 invocations', async () => {
  const approvedFor = digestOf(MESSAGE);
  const tampered = { ...MESSAGE, raw: 'VEFNUEVSRUQ' };
  const { out, sends } = await call({ ...GOOD(tampered), expectedDigest: approvedFor });
  assert.strictEqual(sends.length, 0);
  assert.strictEqual(out.body.phase, 'digest_mismatch');
});

test('3c. a STOP read by THIS process refuses the send — 0 invocations', async () => {
  const { out, sends, ledger } = await call(GOOD(), { gate: deny });
  assert.strictEqual(sends.length, 0);
  assert.strictEqual(out.status, 403);
  assert.strictEqual(out.body.stopped, true);
  assert.ok(ledger.rows.some((r) => r.kind === 'BLOCKED' && r.scope === 'capability:email.send'));
});

test('3d. an unreadable STOP state fails closed — 0 invocations', async () => {
  const { out, sends } = await call(GOOD(), {
    gate: { assertSendAllowed: async () => { throw new Error('kill state unknown'); } },
  });
  assert.strictEqual(sends.length, 0);
  assert.strictEqual(out.body.phase, 'authorization_undetermined');
});

test('3e. a duplicate idempotencyKey is refused — 0 invocations', async () => {
  const { out, sends } = await call(GOOD(), {
    ledger: fakeLedger({ priorClaim: { id: 'att-earlier', outcome: 'PROVIDER_ACCEPTED' } }),
  });
  assert.strictEqual(sends.length, 0);
  assert.strictEqual(out.status, 409);
  assert.strictEqual(out.body.phase, 'refused_duplicate');
});

test('3f. an unavailable or unreachable ledger refuses — 0 invocations', async () => {
  for (const ledger of [fakeLedger({ beginFails: true }), fakeLedger({ throwOnBegin: true })]) {
    const { out, sends } = await call(GOOD(), { ledger });
    assert.strictEqual(sends.length, 0);
    assert.strictEqual(out.status, 503);
  }
});

test('3g. an unknown transport is refused, never defaulted — 0 invocations', async () => {
  const { out, sends } = await call({ ...GOOD(), transport: 'smtp_direct' });
  assert.strictEqual(sends.length, 0);
  assert.strictEqual(out.body.phase, 'unknown_transport');
});

test('3h. an internal recipient needs no approval — the alert channel survives', async () => {
  const m = { ...MESSAGE, to: INTERNAL };
  const { out, sends } = await call({ message: m, transport: 'gmail_cphi', idempotencyKey: 'ops-1' });
  assert.strictEqual(out.body.ok, true, JSON.stringify(out.body));
  assert.strictEqual(sends.length, 1);
});

// ═══ 4. CREDENTIAL ISOLATION — THE STRUCTURAL PROPERTY ═════════════════════

test('4. exactly one module imports the send-capable transport, and it is this service', () => {
  // The whole point of milestone 6. If any module in the application tree imports
  // transports/gmail.js, the credential is back in the application process.
  const ROOT = path.join(__dirname, '..', '..', '..');
  const LEX = require('../../../scripts/js-lex');
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'test-fixtures'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (e.name.endsWith('.js')) out.push(path.relative(ROOT, full));
    }
    return out;
  };

  // blankCommentsOnly, NOT blankNonCode. blankNonCode blanks string literals — including the
  // path inside require('...') — so a search of blanked code for a require path can never match
  // and the assertion below would pass on an empty list no matter what the tree contained. I had
  // written exactly that, and it passed vacuously.
  const requiresTransport = (rel) => {
    const code = LEX.blankCommentsOnly(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    return /require\(\s*['"`][^'"`]*transports\/gmail['"`]\s*\)/.test(code);
  };

  // THE PRECONDITION. The detector must find the one importer we know exists, or this control is
  // asserting nothing. A vacuous pass here would report perfect credential isolation in a tree
  // where every module imported the credential.
  assert.ok(requiresTransport('src/services/sender/server.js'),
    'the detector cannot even see the sender service\'s own require — it matches nothing, so the '
    + 'assertion below would pass vacuously');

  const importers = walk(ROOT).filter((rel) => {
    if (rel === 'src/lib/outbound/transports/gmail.js') return false;
    if (rel.endsWith('.test.js')) return false;
    return requiresTransport(rel);
  });

  assert.deepStrictEqual(importers, ['src/services/sender/server.js'],
    'the send-capable Gmail transport is imported by something other than the sender service:\n  '
    + importers.join('\n  '));
});

test('4b. the service client holds no credential and cannot reach a provider', () => {
  const LEX = require('../../../scripts/js-lex');
  const code = LEX.blankNonCode(
    fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'outbound', 'transports', 'sender-client.js'), 'utf8'));
  for (const t of ['RESEND_API_KEY', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_SERVICE_ACCOUNT_JSON',
    'googleapis', 'users.messages.send', 'gmailClientFor']) {
    assert.ok(!code.includes(t), `the sender client references ${t}`);
  }
  // It signs with the service secret, which authenticates a conversation, not an action.
  assert.ok(code.includes('SENDER_SERVICE_SECRET'), 'the client does not sign its requests');
});

test('4c. the signature module touches no credential, provider or socket', () => {
  // It is shared by the service and the client. If it grew a dependency on either, the split
  // would close again through it.
  const LEX = require('../../../scripts/js-lex');
  const code = LEX.blankNonCode(
    fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'outbound', 'sender-signature.js'), 'utf8'));
  for (const t of ['require(', 'http', 'googleapis', 'KEY', 'TOKEN']) {
    if (t === 'require(') {
      const requires = code.match(/require\(/g) || [];
      assert.strictEqual(requires.length, 1, 'the signature module requires more than crypto');
      continue;
    }
    assert.ok(!code.includes(t), `the signature module references ${t}`);
  }
});

// ═══ 5. OVER A REAL SOCKET, END TO END ═════════════════════════════════════

test('5. the client and the service agree over HTTP — refused, then permitted', async () => {
  // The two halves are written against one signing definition; this proves they actually agree on
  // the wire, which a unit test on either side alone cannot.
  const c = counter();
  const ledger = fakeLedger();
  const server = S.createServer({
    env: ENV, gate: allow, ledger, handlers: { gmail_cphi: c.send },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    const client = require('../../lib/outbound/transports/sender-client');
    const t = client.transportFor('gmail_cphi', { url, secret: SECRET });

    // (a) external, no approval → refused over the wire, 0 invocations
    const refused = await t.send({ ...MESSAGE, _dispatch: { idempotencyKey: 'wire-1' } });
    assert.strictEqual(c.sends.length, 0, 'an unapproved external send crossed the wire');
    assert.strictEqual(refused.ok, false);
    assert.match(refused.error, /needs_approval/);

    // (b) approved, digest matching → one send
    const ok = await t.send({ ...MESSAGE,
      _dispatch: { idempotencyKey: 'wire-2', approvalId: 'apv-1', digest: digestOf(MESSAGE),
        workflow: 'inquiry', agent: 'inquiry-agent' } });
    assert.strictEqual(ok.ok, true, ok.error);
    assert.strictEqual(c.sends.length, 1);
    assert.strictEqual(ok.meta.threadId, 't-1');

    // (c) health says nothing about whether sending is permitted
    const health = await new Promise((res, rej) => {
      http.get(`${url}/health`, (r) => { let b = ''; r.on('data', (x) => { b += x; }); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
    });
    assert.strictEqual(health.ok, true);
    // THE HANDLERS THIS SERVICE IS RUNNING WITH — one, here, because that is what was injected.
    // This asserted all three, which passed only because /health reported the module constant
    // regardless of what the process actually served: a server serving one transport announced
    // three, and the deployment smoke test's transport check was reading a compile-time fact as a
    // runtime one. The expectation encoded the bug.
    assert.deepStrictEqual(health.transports, ['gmail_cphi'],
      '/health does not report the handlers this service is actually running with');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('5b. an unreachable service is OUTCOME_UNKNOWN, never a clean failure', async () => {
  // A timeout or a broken connection may mean the message went. The client throws, so dispatch
  // records OUTCOME_UNKNOWN — the one state that is never eligible for automatic retry.
  const client = require('../../lib/outbound/transports/sender-client');
  const t = client.transportFor('gmail_cphi', { url: 'http://127.0.0.1:1', secret: SECRET });
  await assert.rejects(
    () => t.send({ ...MESSAGE, _dispatch: { idempotencyKey: 'x' } }),
    /may or may not have been sent/);
});

// ═══ 6. THE NON-SENDING WRITES ═════════════════════════════════════════════

test('6. the write endpoint runs only named operations', async () => {
  let ran = null;
  const writes = { file_thread: async (p) => { ran = p; return { ok: true }; } };
  const deps = { env: ENV, writes };

  const good = await S.handleWrite(
    signed({ op: 'file_thread', params: { mailbox: 'a@abiozen.com', threadId: 't', folder: 'Supplier' } },
      { p: '/write' }), deps);
  assert.strictEqual(good.status, 200);
  assert.strictEqual(ran.folder, 'Supplier');

  const bad = await S.handleWrite(
    signed({ op: 'users.messages.send', params: {} }, { p: '/write' }), deps);
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.phase, 'unknown_operation');
});

test('6b. the write endpoint is authenticated too', async () => {
  const r = await S.handleWrite({ raw: '{"op":"file_thread"}', signature: 'nope', timestamp: Date.now() },
    { env: ENV });
  assert.strictEqual(r.status, 401);
});

// ═══ 8. THE TWO LAYERS, OVER ONE LEDGER — THE CROSS-LAYER CONTROLS ═════════
//
// Both defects below were invisible to every unit suite in this repository, because each layer's
// suite exercises that layer alone and each layer was correct about itself. They appeared on the
// first run of dispatch() and the service together, sharing one email_log, as production does.

test('8. dispatch through the REAL service, over one shared ledger, sends exactly once', async () => {
  // THE DEFECT THIS ENCODES. dispatch opens a ledger attempt with claimRef = idempotencyKey and
  // CLAIMS it before calling the transport — correct, responsibility must be durable first. The
  // transport is this service, which opened its own attempt under THE SAME claimRef, ran
  // priorClaim, found dispatch's CLAIMED row, and refused. Every send through the service was a
  // duplicate of itself.
  const D = require('../../lib/outbound/dispatch');
  const CLIENT = require('../../lib/outbound/transports/sender-client');

  const calls = [];
  const rows = [];
  const UNSAFE = ['CLAIMED', 'PROVIDER_ACCEPTED', 'OUTCOME_UNKNOWN', 'RECONCILED'];
  const shared = {
    rows,
    beginAttempt: async (a) => {
      const row = { id: `att-${rows.length + 1}`, outcome: 'PREPARED', claimRef: a.claimRef };
      rows.push(row);
      const set = (o) => { row.outcome = o; };
      return { ok: true, id: row.id,
        blocked: async () => set('BLOCKED'), claim: async () => { set('CLAIMED'); return { ok: true }; },
        accepted: async () => set('PROVIDER_ACCEPTED'), rejected: async () => set('PROVIDER_REJECTED'),
        unknown: async () => set('OUTCOME_UNKNOWN') };
    },
    priorClaim: async (ref, { excludeId } = {}) => rows.find((r) =>
      r.claimRef === ref && r.id !== excludeId && UNSAFE.includes(r.outcome)) || null,
  };

  const server = S.createServer({
    env: ENV, gate: allow, ledger: shared,
    handlers: { gmail_cphi: async (m) => { calls.push(m.to); return { ok: true, id: 'g-1', providerResponded: true, meta: { threadId: 't-1' } }; } },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const m = { to: EXTERNAL, subject: 'Quotation QT-9001', raw: 'UkFXLUJZVEVT', mailbox: 'sales@abiozen.com' };
    const r = await D.dispatch({
      message: m, transport: 'gmail_cphi', idempotencyKey: 'xlayer-1',
      approvalId: 'apv-1', expectedDigest: D.transmittedDigest(m),
    }, {
      env: ENV, gate: allow, ledger: shared,
      transports: { gmail_cphi: CLIENT.transportFor('gmail_cphi', { url, secret: SECRET }) },
    });

    assert.strictEqual(r.ok, true,
      `a send through the real service was refused: ${r.error}. If this says "refused_duplicate" `
      + 'or names a duplicate, the two layers are sharing a claim namespace again.');
    assert.strictEqual(calls.length, 1, `${calls.length} provider invocations for one send`);

    // Two audit rows, one per layer, distinguishable. Independent auditability is a milestone
    // requirement, so the service's row must not depend on the application's.
    const app = rows.filter((x) => x.claimRef === 'xlayer-1');
    const svc = rows.filter((x) => x.claimRef === 'sender:xlayer-1');
    assert.strictEqual(app.length, 1, 'dispatch wrote no row of its own');
    assert.strictEqual(svc.length, 1, 'the service wrote no row of its own, so it is not independent');
    assert.strictEqual(svc[0].outcome, 'PROVIDER_ACCEPTED');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('8b. and a REPLAYED request to the service is still refused as a duplicate', async () => {
  // The other half: namespacing must not have switched the service's own idempotency off. It
  // protects against a duplicate REQUEST TO SEND, which is the threat this layer owns.
  const rows = [{ id: 'att-prior', claimRef: 'sender:replay-1', outcome: 'CLAIMED' }];
  const c = counter();
  const out = await S.handleSend(signed({
    message: { to: EXTERNAL, subject: 'S', raw: 'UkFX', mailbox: 'sales@abiozen.com' },
    transport: 'gmail_cphi', idempotencyKey: 'replay-1',
    approvalId: 'apv-1', expectedDigest: digestOf({ to: EXTERNAL, subject: 'S', raw: 'UkFX' }),
  }), {
    env: ENV, gate: allow, handlers: { gmail_cphi: c.send },
    ledger: {
      beginAttempt: async (a) => { rows.push({ id: 'att-new', claimRef: a.claimRef, outcome: 'PREPARED' }); return { ok: true, id: 'att-new', blocked: async () => {}, claim: async () => ({ ok: true }), accepted: async () => {}, rejected: async () => {}, unknown: async () => {} }; },
      priorClaim: async (ref, { excludeId } = {}) => rows.find((r) => r.claimRef === ref && r.id !== excludeId && r.outcome === 'CLAIMED') || null,
    },
  });
  assert.strictEqual(c.sends.length, 0, 'a replayed request to the service was served again');
  assert.strictEqual(out.body.phase, 'refused_duplicate');
});
