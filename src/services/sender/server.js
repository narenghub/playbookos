// ── THE SENDER SERVICE ───────────────────────────────────────────────────────
//
//   node src/services/sender/start.js            # a separate process, separate credential
//
// Spec A milestone 6, item 1: an out-of-process sender with exclusive access to send-capable
// credentials, which INDEPENDENTLY enforces authorization, STOPs, approved payload digest,
// idempotency and auditability.
//
// ── WHY "INDEPENDENTLY" IS THE WHOLE POINT ───────────────────────────────────
//
// dispatch() already enforces all five. If this service simply trusted dispatch's word, moving the
// credential out of process would buy only one thing: an attacker inside the application could no
// longer read the key. Useful, but it could still ASK the service to send anything, which is the
// same outcome by a politer route.
//
// So every check is made again here, from this process's own sources of truth:
//
//   - the STOPs are read from the database by this process, not accepted as a claim
//   - the digest is recomputed from the bytes in THIS request, not compared to a number the
//     caller supplied about itself
//   - idempotency is resolved against the ledger by this process
//   - the ledger row is written by this process, so the audit trail does not depend on the
//     application being honest about what it asked for
//
// The duplication is deliberate. Defence in depth means the second check does not trust the first,
// and a second check that reads the first check's answer is not a second check.
//
// ── WHAT THIS PROCESS TRUSTS ─────────────────────────────────────────────────
//
// One thing: that a request carrying a valid HMAC came from something holding SENDER_SERVICE_SECRET.
// That secret authenticates the CALLER. It is not an email credential and cannot send anything by
// itself — every request it signs is still subject to every check below. An attacker with the
// secret gains the ability to ask, not the ability to send.
//
// ── WHAT IT REFUSES ──────────────────────────────────────────────────────────
//
// Unsigned or badly signed requests, replays (the signature covers a timestamp and the body),
// external recipients with no approval and no digest, digest mismatches, duplicates, anything a
// STOP covers, and anything at all if the STOP state or the ledger cannot be read. Fail closed, in
// a process whose only job is to send — so there is nothing to weigh against refusing.

'use strict';

const http = require('http');

const GATE = require('../../lib/email-gate');
const LEDGER = require('../../lib/outbound/ledger');
const RECIPIENTS = require('../../lib/outbound/recipients');
const GMAIL = require('../../lib/outbound/transports/gmail');
const { sign, signingString, sameSignature } = require('../../lib/outbound/sender-signature');

const MAX_BODY = 12 * 1024 * 1024;        // a message with an attachment, and no more
const MAX_SKEW_MS = 5 * 60 * 1000;        // a signature older than this is a replay

// The transports this service is willing to send through, by name. The application cannot name a
// transport this process has never heard of.
const HANDLERS = Object.freeze({
  gmail_cphi: GMAIL.send,
  gmail_outreach: GMAIL.send,
  gmail_probe: GMAIL.send,
});


const refuse = (status, phase, error, extra = {}) =>
  ({ status, body: { ok: false, phase, error, providerResponded: false, dispatched: false, ...extra } });

/**
 * The /send handler, as a pure function of its inputs. Exported so the controls can drive every
 * refusal without a socket — the HTTP layer below is a thin wrapper over this.
 */
async function handleSend({ raw, signature, timestamp, method = 'POST', path: p = '/send' }, deps = {}) {
  const env = deps.env || process.env;
  const gate = deps.gate || GATE;
  const ledger = deps.ledger || LEDGER;
  const recipients = deps.recipients || RECIPIENTS;
  const handlers = deps.handlers || HANDLERS;
  const now = deps.now || Date.now;

  // ── 1. IS THIS REQUEST FROM SOMETHING ALLOWED TO ASK? ─────────────────────
  const secret = env.SENDER_SERVICE_SECRET;
  if (!secret) {
    // No secret configured means every request is unauthenticated. Refusing beats serving.
    return refuse(503, 'service_misconfigured',
      'SENDER_SERVICE_SECRET is not set, so no request can be authenticated — refusing all sends');
  }
  if (!signature || !timestamp) {
    return refuse(401, 'unsigned', 'a send request must carry a timestamp and a signature');
  }
  const skew = Math.abs(now() - Number(timestamp));
  if (!Number.isFinite(skew) || skew > MAX_SKEW_MS) {
    return refuse(401, 'stale_signature',
      `the signature's timestamp is ${Number.isFinite(skew) ? `${Math.round(skew / 1000)}s` : 'not a number'} `
      + 'from now; a replayed request is refused');
  }
  if (!sameSignature(signature, sign(secret, { method, path: p, timestamp, body: raw }))) {
    // The signature covers the BODY, so a valid signature cannot be lifted onto a different
    // message — which is what makes this authentication rather than a password.
    return refuse(401, 'bad_signature', 'the signature does not match this request');
  }

  // ── 2. IS IT A REQUEST AT ALL? ────────────────────────────────────────────
  let req;
  try { req = JSON.parse(raw); } catch (e) {
    return refuse(400, 'malformed', `the request body is not JSON (${e.message})`);
  }
  const { message, transport, idempotencyKey, approvalId = null, expectedDigest = null,
    workflow = null, agent = null, companyId = null } = req || {};

  if (!message || typeof message !== 'object') {
    return refuse(400, 'malformed', 'a send request needs a message object');
  }
  const { to, subject, raw: payload } = message;
  if (!to || !subject || !payload) {
    return refuse(400, 'malformed',
      'a message needs a recipient, a subject and a prepared payload');
  }
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    return refuse(400, 'malformed',
      'an idempotencyKey is required: without one a retry cannot be told from a second message');
  }
  const send = handlers[transport];
  if (!send) {
    return refuse(400, 'unknown_transport',
      `this service does not serve transport ${JSON.stringify(transport)}`);
  }

  // ── 3. INSIDE OR OUTSIDE? DECIDED HERE, FROM THIS PROCESS'S CONFIGURATION ─
  let external;
  try {
    external = recipients.isExternal(to, env);
  } catch (e) {
    return refuse(422, 'unclassifiable',
      `the recipients could not be classified as inside or outside the company (${e.message})`);
  }

  // ── 4. APPROVAL, REQUIRED AGAIN HERE ──────────────────────────────────────
  //
  // Not because dispatch might have forgotten, but because this process does not take dispatch's
  // word for anything. A caller that signs a request for an external recipient without an approval
  // is refused by the service as surely as by the boundary.
  if (external && (!approvalId || !expectedDigest)) {
    return refuse(403, 'needs_approval',
      'an external recipient requires both an approvalId and an expectedDigest',
      { needsApproval: true, external: true });
  }

  // ── 5. THE LEDGER, WRITTEN BY THIS PROCESS ────────────────────────────────
  const actualDigest = LEDGER.digestOf({
    to: Array.isArray(to) ? to.join(', ') : String(to),
    subject: `raw:${subject}`,
    html: String(payload),
  });

  let att;
  try {
    att = await ledger.beginAttempt({
      transport, provider: 'gmail', to, subject,
      workflow, agent, companyId, approvalId,
      claimRef: idempotencyKey, consequential: true,
    }, deps.ledgerDeps);
  } catch (e) {
    return refuse(503, 'ledger_unreachable',
      `the outbound ledger could not be reached (${e.message}) — nothing was sent`);
  }
  if (!att || !att.ok) {
    return refuse(503, 'ledger_refused',
      `the outbound ledger refused the attempt: ${(att && att.error) || 'no record created'}`);
  }

  // ── 6. IDEMPOTENCY, RESOLVED HERE ─────────────────────────────────────────
  if (typeof ledger.priorClaim !== 'function') {
    await att.blocked('the ledger cannot answer whether this was already sent', 'idempotency_unknown');
    return refuse(503, 'idempotency_unavailable',
      'this ledger provides no priorClaim(), so a duplicate cannot be distinguished from a first '
      + 'attempt — failing closed');
  }
  let prior;
  try {
    prior = await ledger.priorClaim(idempotencyKey, { excludeId: att.id }, deps.ledgerDeps);
  } catch (e) {
    await att.blocked(`idempotency could not be established (${e.message})`, 'idempotency_unknown');
    return refuse(503, 'idempotency_unknown',
      `whether this message was already sent could not be established (${e.message})`);
  }
  if (prior) {
    await att.blocked(`duplicate of ${prior.id} (${prior.outcome})`, 'duplicate_dispatch');
    return refuse(409, 'refused_duplicate',
      `a message with this idempotencyKey already reached ${prior.outcome}; not sending again`,
      { duplicateOf: prior.id, priorOutcome: prior.outcome });
  }

  // ── 7. THE DIGEST, RECOMPUTED FROM THESE BYTES ────────────────────────────
  //
  // From the payload in THIS request. The caller's claim about what it is sending is not an input.
  if (expectedDigest && actualDigest !== expectedDigest) {
    const why = `the approved payload digest ${expectedDigest} does not match the message in this `
      + `request (${actualDigest}) — nothing was transmitted`;
    await att.blocked(why, 'approval:digest_mismatch');
    return refuse(409, 'digest_mismatch', why, { stopped: true, expectedDigest, actualDigest });
  }

  // ── 8. THE STOPS, READ FROM THE DATABASE BY THIS PROCESS ──────────────────
  let decision;
  try {
    decision = await gate.assertSendAllowed({
      capability: 'email.send', workflow, agent, company: companyId, to,
      approvalId, digest: actualDigest,
    }, deps.gateDeps);
  } catch (e) {
    await att.blocked(`the authorization gate could not be consulted (${e.message})`,
      'authorization_undetermined');
    return refuse(503, 'authorization_undetermined',
      `the authorization gate could not be consulted (${e.message}) — failing closed`);
  }
  if (!decision || !decision.allowed) {
    const why = (decision && decision.reason) || 'the gate returned no decision';
    await att.blocked(why, (decision && decision.scope) || 'authorization_undetermined');
    return refuse(403, 'stopped_by_policy', why, { stopped: true });
  }

  // ── 9. CLAIM, THEN TRANSMIT ───────────────────────────────────────────────
  await att.claim();
  let result;
  try {
    result = await send(message, deps.transportDeps);
  } catch (e) {
    await att.unknown(e.message);
    return { status: 502,
      body: { ok: false, phase: 'transport_unknown', error: e.message,
        providerResponded: false, dispatched: true, transport } };
  }

  if (result && result.ok) {
    await att.accepted(result.id || null);
    return { status: 200,
      body: { ok: true, id: result.id || null, phase: 'provider_accepted', error: null,
        providerResponded: true, dispatched: true, transport,
        digest: actualDigest, meta: result.meta || null } };
  }
  await att.rejected((result && result.error) || 'the transport reported no result');
  return { status: 502,
    body: { ok: false, phase: 'provider_rejected',
      error: (result && result.error) || 'the transport reported no result',
      providerResponded: !!(result && result.providerResponded), dispatched: true, transport } };
}

// ── THE NON-SENDING WRITES THAT STILL NEED THE CREDENTIAL ───────────────────
//
// Filing a thread under a label is `threads.modify` — a write, so a read-only token cannot do it,
// and `gmail.modify` permits `messages.send`. So an agent holding a token good enough to label is
// holding a token good enough to send, which is the separation undone through a side door.
//
// These therefore live here, with the credential. They are NOT sends: nothing leaves the building,
// nobody receives anything, and no approval or digest applies. They are also deliberately NOT
// gated on the STOPs — a hold on outbound email is not a reason to stop filing threads that have
// already arrived, and refusing to label during a containment would make the containment harder
// to clean up afterwards.
//
// Operations are named, from a fixed table. The application cannot ask this process to run
// arbitrary Gmail calls with a send-capable credential.
const WRITES = Object.freeze({
  file_thread: ({ mailbox, threadId, folder }, deps) =>
    GMAIL.fileThread({ mailbox, threadId, folder }, deps),
  ensure_labels: ({ mailbox, set }, deps) =>
    GMAIL.ensureLabels({ mailbox, set }, deps),
});

/** The /write handler. Same authentication, no approval axis, fixed operation table. */
async function handleWrite({ raw, signature, timestamp, method = 'POST', path: p = '/write' }, deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const writes = deps.writes || WRITES;

  const secret = env.SENDER_SERVICE_SECRET;
  if (!secret) {
    return refuse(503, 'service_misconfigured', 'SENDER_SERVICE_SECRET is not set — refusing all requests');
  }
  if (!signature || !timestamp) {
    return refuse(401, 'unsigned', 'a write request must carry a timestamp and a signature');
  }
  const skew = Math.abs(now() - Number(timestamp));
  if (!Number.isFinite(skew) || skew > MAX_SKEW_MS) {
    return refuse(401, 'stale_signature', 'the signature\'s timestamp is too far from now');
  }
  if (!sameSignature(signature, sign(secret, { method, path: p, timestamp, body: raw }))) {
    return refuse(401, 'bad_signature', 'the signature does not match this request');
  }

  let req;
  try { req = JSON.parse(raw); } catch (e) {
    return refuse(400, 'malformed', `the request body is not JSON (${e.message})`);
  }
  const op = writes[req && req.op];
  if (!op) {
    return refuse(400, 'unknown_operation',
      `this service does not perform ${JSON.stringify(req && req.op)}; known: ${Object.keys(writes).join(', ')}`);
  }

  try {
    const out = await op(req.params || {}, deps.transportDeps);
    return { status: 200, body: { ok: out && out.ok !== false, result: out || null } };
  } catch (e) {
    // Reported, never thrown onward: a filing failure must not be mistaken for a send failure.
    return { status: 502, body: { ok: false, phase: 'write_failed', error: (e && e.message) || String(e) } };
  }
}

// ── THE HTTP WRAPPER ────────────────────────────────────────────────────────
//
// Thin on purpose: read the body, call handleSend, write the answer. No decision is made here, so
// there is nothing here to get wrong that the controls above do not already cover.

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let over = false;
    req.on('data', (c) => {
      raw += c;
      if (raw.length > MAX_BODY && !over) { over = true; reject(new Error('request body too large')); }
    });
    req.on('end', () => { if (!over) resolve(raw); });
    req.on('error', reject);
  });
}

function createServer(deps = {}) {
  return http.createServer(async (req, res) => {
    const reply = (status, body) => {
      const s = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
      res.end(s);
    };

    // Liveness only. It says nothing about whether sending is permitted — a STOP in force is not
    // a sick service, and conflating the two is how a held channel reads as an outage.
    if (req.method === 'GET' && req.url === '/health') {
      return reply(200, { ok: true, service: 'sender', transports: Object.keys(HANDLERS) });
    }
    const isSend = req.method === 'POST' && req.url === '/send';
    const isWrite = req.method === 'POST' && req.url === '/write';
    if (!isSend && !isWrite) {
      return reply(404, { ok: false, error: 'only POST /send, POST /write and GET /health' });
    }

    let raw;
    try { raw = await readBody(req); } catch (e) {
      return reply(413, { ok: false, phase: 'malformed', error: e.message });
    }

    try {
      const handler = isSend ? handleSend : handleWrite;
      const out = await handler({
        raw,
        signature: req.headers['x-sender-signature'],
        timestamp: req.headers['x-sender-timestamp'],
        method: 'POST', path: isSend ? '/send' : '/write',
      }, deps);
      return reply(out.status, out.body);
    } catch (e) {
      // An unexpected throw must not look like a refusal with a known cause, and must not look
      // like a success either.
      console.error(`[sender] unhandled: ${(e && e.stack) || e}`);
      return reply(500, { ok: false, phase: 'service_fault', error: 'the sender service faulted',
        providerResponded: false, dispatched: false });
    }
  });
}

module.exports = { createServer, handleSend, handleWrite, HANDLERS, WRITES, MAX_SKEW_MS };
