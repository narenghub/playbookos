// ── THE SENDER SERVICE, AS A TRANSPORT ───────────────────────────────────────
//
//   registerTransport('gmail_cphi', senderClient.transportFor('gmail_cphi'));
//
// Spec A milestone 6, item 1. This is what the APPLICATION process registers. It holds no email
// credential, cannot construct a Gmail client, and has no code path to a provider: it signs a
// request and posts it to the sender service, which holds the only send-capable credential and
// re-checks every invariant for itself.
//
// ── WHAT MOVED, AND WHAT THAT BUYS ───────────────────────────────────────────
//
// Before: dispatch() → in-process Gmail transport → Google. The key was in the application's
// environment, so any code in the application could in principle reach it.
//
// After: dispatch() → this client → HTTP → sender service → Google. The application's environment
// holds SENDER_SERVICE_SECRET, which authenticates a REQUEST and sends nothing by itself. Every
// request it signs is still subject to the service's own STOP, approval, digest and idempotency
// checks. An attacker in the application gains the ability to ask, not the ability to send.
//
// ── WHY A SIGNING SECRET IS NOT JUST A SMALLER KEY ───────────────────────────
//
// A Gmail credential authorizes an ACTION: hold it and you can send what you like to whom you
// like. The signing secret authorizes a CONVERSATION: hold it and you can ask a service that will
// then refuse you on five separate grounds. The asymmetry is the point, and it is why the service
// re-checks rather than trusting what it is told.
//
// ── TIMEOUTS, AND WHY A TIMEOUT IS NOT A FAILURE ─────────────────────────────
//
// If the request times out, the service may have sent the message. That is OUTCOME_UNKNOWN, never
// "failed" — the distinction decides whether a retry is safe, and the service's own ledger row is
// the authority on what actually happened. This client never retries.

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

// The SIGNATURE module, not the service module. Importing the service here would pull the
// send-capable Gmail transport into the application process and undo the whole separation — which
// is what the first draft of this file did.
const { sign } = require('../sender-signature');

const DEFAULT_TIMEOUT_MS = 30000;

/** POST a signed request. Resolves { status, body } or rejects. */
function post(url, { raw, signature, timestamp, timeoutMs }, deps = {}) {
  if (deps.request) return deps.request(url, { raw, signature, timestamp });

  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(raw),
        'x-sender-signature': signature,
        'x-sender-timestamp': String(timestamp),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { parsed = { ok: false, error: `the sender service returned non-JSON: ${body.slice(0, 200)}` }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.setTimeout(timeoutMs || DEFAULT_TIMEOUT_MS, () => {
      req.destroy(new Error('the sender service did not answer in time; the message may have been sent'));
    });
    req.on('error', reject);
    req.end(raw);
  });
}

/**
 * A transport for one named channel. dispatch() calls send(message); this signs the request and
 * posts it. The `_dispatch` envelope dispatch attaches carries the approval and digest, so the
 * service receives what it needs to check for itself.
 */
function transportFor(transport, opts = {}) {
  return {
    async send(message, deps = {}) {
      const env = deps.env || process.env;
      const url = opts.url || env.SENDER_SERVICE_URL;
      const secret = opts.secret || env.SENDER_SERVICE_SECRET;

      if (!url) {
        return { ok: false, providerResponded: false,
          error: 'SENDER_SERVICE_URL is not set, so there is no sender to ask — nothing was sent' };
      }
      if (!secret) {
        return { ok: false, providerResponded: false,
          error: 'SENDER_SERVICE_SECRET is not set, so a request cannot be signed — nothing was sent' };
      }

      const d = message._dispatch || {};
      // Only what the service needs. The `_dispatch` envelope is unwrapped into explicit fields so
      // the wire format is a stated contract rather than whatever dispatch happened to attach.
      const payload = {
        message: {
          to: message.to, subject: message.subject, raw: message.raw,
          mailbox: message.mailbox, threadId: message.threadId,
        },
        transport,
        idempotencyKey: d.idempotencyKey || message.idempotencyKey,
        approvalId: d.approvalId || null,
        expectedDigest: d.digest || null,
        workflow: d.workflow || null,
        agent: d.agent || null,
        companyId: d.companyId || null,
      };

      const raw = JSON.stringify(payload);
      const timestamp = (deps.now || Date.now)();
      const signature = sign(secret, { method: 'POST', path: '/send', timestamp, body: raw });

      let res;
      try {
        res = await post(`${url.replace(/\/$/, '')}/send`,
          { raw, signature, timestamp, timeoutMs: opts.timeoutMs }, deps);
      } catch (e) {
        // The service may have transmitted before the connection broke. Thrown, so dispatch
        // records OUTCOME_UNKNOWN rather than a clean failure.
        throw new Error(`the sender service could not be reached (${e.message}); `
          + 'the message may or may not have been sent');
      }

      const b = res.body || {};
      if (res.status === 200 && b.ok) {
        return { ok: true, id: b.id || null, providerResponded: true, meta: b.meta || null };
      }
      // A refusal by the service. Returned, not thrown: the service's own ledger row already says
      // what happened, and nothing was transmitted on any of its refusal paths.
      return {
        ok: false,
        providerResponded: !!b.providerResponded,
        error: `the sender service refused (${res.status} ${b.phase || 'unknown'}): ${b.error || 'no reason given'}`,
        meta: b.meta || null,
      };
    },
  };
}

module.exports = { transportFor, post, DEFAULT_TIMEOUT_MS };

// ── THE NON-SENDING WRITES ───────────────────────────────────────────────────
//
// Filing a thread and creating labels need `threads.modify`, which permits `messages.send`. So the
// agents cannot hold a token good enough to do them — the service does them instead, and this is
// how the agents ask. Same signature, different endpoint, fixed operation names.
//
// Reported, never thrown. By the time filing happens the message has left and cannot be unsent; a
// filing failure treated as a send failure would turn "it went and is sitting unfiled" into "it may
// or may not have gone", which is strictly worse information.
async function write(op, params, deps = {}, opts = {}) {
  const env = deps.env || process.env;
  const url = opts.url || env.SENDER_SERVICE_URL;
  const secret = opts.secret || env.SENDER_SERVICE_SECRET;
  if (!url || !secret) {
    return { ok: false, error: 'the sender service is not configured (SENDER_SERVICE_URL/SECRET)' };
  }

  const raw = JSON.stringify({ op, params });
  const timestamp = (deps.now || Date.now)();
  const signature = sign(secret, { method: 'POST', path: '/write', timestamp, body: raw });

  try {
    const res = await post(`${url.replace(/\/$/, '')}/write`,
      { raw, signature, timestamp, timeoutMs: opts.timeoutMs }, deps);
    const b = res.body || {};
    if (res.status === 200 && b.ok) return b.result || { ok: true };
    return { ok: false, error: b.error || `the sender service refused the write (${res.status})` };
  } catch (e) {
    return { ok: false, error: `the sender service could not be reached (${(e && e.message) || e})` };
  }
}

const fileThread = ({ mailbox, threadId, folder }, deps = {}, opts = {}) =>
  write('file_thread', { mailbox, threadId, folder }, deps, opts);

const ensureLabels = ({ mailbox, set }, deps = {}, opts = {}) =>
  write('ensure_labels', { mailbox, set }, deps, opts);

module.exports.write = write;
module.exports.fileThread = fileThread;
module.exports.ensureLabels = ensureLabels;
