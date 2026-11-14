// ── THE SIGNATURE THE SENDER SERVICE CHECKS ──────────────────────────────────
//
// One definition of the canonical string, shared by the service and its client, because two
// implementations of the same signature is how authentication quietly stops authenticating — the
// same argument mailer.js makes about two implementations of the same digest.
//
// ── WHY THIS IS ITS OWN FILE ─────────────────────────────────────────────────
//
// The client lives in the application and needs sign(). The service lives in its own process and
// needs it too. If the client imported it from the service's module, the application would be
// importing the module that holds the send-capable credential — which is exactly the dependency
// the out-of-process split exists to remove. Found by writing it the wrong way round first.
//
// Nothing here touches a credential, a provider, or the network.
//
// ── WHAT THE SIGNATURE COVERS, AND WHY EACH PART ─────────────────────────────
//
//   method     so a signature for a POST cannot be replayed against another verb
//   path       so a signature for /send cannot be lifted onto another endpoint
//   timestamp  so an intercepted request cannot be replayed later (the service bounds the skew)
//   body       so a valid signature cannot be moved onto a DIFFERENT message, which is what makes
//              this authentication of a request rather than a password
//   nonce      OPTIONAL, and only the worker path uses it. A timestamp bounds a replay to the skew
//              window; it does not prevent one inside it. A nonce the verifier records once turns
//              "recently signed" into "signed and not seen before".
//
// ── WHY THE NONCE IS OPTIONAL HERE RATHER THAN A SECOND MODULE ───────────────
//
// A worker-only copy of this function would be a second implementation of the same signature,
// which the first paragraph exists to prevent. So the nonce is additive instead: with no nonce the
// returned string is BYTE-IDENTICAL to what it has always been, so the sender service and its
// client are untouched. sender-signature.test.js pins that byte for byte.
//
// One consequence, stated because it is the kind of thing that is obvious only after it bites.
// `M\nP\nT\nnonce=abc\nBODY` can be produced two ways: nonce `abc` with body `BODY`, or no nonce
// with a body beginning `nonce=abc\n`. That collision is unreachable because no endpoint accepts
// both forms — the sender service never passes a nonce, worker authentication REQUIRES one of a
// fixed shape, and `path` is itself signed, so a signature cannot move between them. Tested
// rather than argued.

'use strict';

const crypto = require('crypto');

function signingString({ method, path, timestamp, nonce, body }) {
  const n = (nonce === undefined || nonce === null || nonce === '') ? '' : `nonce=${nonce}\n`;
  return `${method}\n${path}\n${timestamp}\n${n}${body}`;
}

function sign(secret, parts) {
  return crypto.createHmac('sha256', secret).update(signingString(parts)).digest('hex');
}

/**
 * Constant-time comparison that cannot throw on a length mismatch.
 *
 * timingSafeEqual throws when the buffers differ in length, and a thrown comparison in a signature
 * check is an authentication bypass waiting for an over-broad catch.
 */
function sameSignature(a, b) {
  const x = Buffer.from(String(a == null ? '' : a), 'utf8');
  const y = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

module.exports = { sign, signingString, sameSignature };
