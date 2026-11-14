// ── AUTHENTICATING A WORKER REQUEST ──────────────────────────────────────────
//
// M7.1. One function answers one question: did this request come from a live enrolled worker, and
// has this exact request been seen before? Nothing here decides what the worker may then DO —
// that is authorizeWorkerAction below, and keeping the two apart is why a bug in one cannot grant
// the other.
//
// ── WHY NOT A JWT ────────────────────────────────────────────────────────────
//
// core.js issues `{ id, email, role }` with `expiresIn: '7d'`. On an always-on desktop that is a
// seven-day bearer credential carrying a human's role, replayable by anyone who reads it once, and
// revocable only by changing the global signing secret — which signs out every human too. A
// per-request signature over a per-worker secret is revocable for one machine, in one row, now.
//
// ── THE ORDER OF THE CHECKS IS THE DESIGN ────────────────────────────────────
//
//   1. shape        a malformed id or nonce is rejected before it reaches the database
//   2. skew         a stale timestamp is rejected before a secret is opened
//   3. identity     unknown id → refused
//   4. revocation   terminal, and checked before the secret is touched because revoking
//                   OVERWRITES the secret — there is nothing left to verify against
//   5. signature    current secret, then the previous one if still inside the rotation overlap
//   6. nonce        recorded ONLY NOW. Recording it earlier would let an unauthenticated caller
//                   fill the table with nonces of its choosing and pre-burn the ones a real
//                   worker is about to use — a denial of service handed out for free.
//
// Step 6 after step 5 is the part most likely to be "simplified" by a later reader, so it is
// stated as a reason rather than an ordering.
//
// ── WHAT THIS DELIBERATELY DOES NOT HIDE ─────────────────────────────────────
//
// The refusal codes distinguish unknown from revoked from badly-signed. That tells an
// unauthenticated caller whether a worker id exists. Worker ids are 128 bits of CSPRNG, so
// enumeration is not a practical attack, and in this codebase an illegible refusal has cost far
// more than a legible one. It is a trade accepted on purpose, not an oversight.

'use strict';

const SIG = require('../outbound/sender-signature');
const SCHEMA = require('./identity-schema');
const SECRETS = require('./secrets');
const IDENTITY = require('./identity');

// Tighter than the sender service's five minutes. With a nonce the window is not what prevents a
// replay, so this only has to be generous enough for a clock that NTP keeps within a second or two.
const MAX_SKEW_MS = 2 * 60 * 1000;

const refuse = (status, code, detail, extra = {}) => ({ ok: false, status, code, detail, ...extra });

/**
 * @returns {{ok: true, workerId, label, capabilities, usedPreviousSecret: boolean}}
 *        | {{ok: false, status, code, detail}}
 */
async function authenticateWorker({
  workerId, method, path, timestamp, nonce, body = '', signature,
} = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now ? deps.now() : Date.now();
  const query = deps.query || require('../db').query;

  // ── 1. SHAPE ──────────────────────────────────────────────────────────────
  if (!workerId || !signature || !timestamp || !nonce) {
    return refuse(401, 'unsigned',
      'a worker request must carry a worker id, a timestamp, a nonce and a signature');
  }
  if (!SCHEMA.WORKER_ID_SHAPE.test(String(workerId))) {
    return refuse(401, 'malformed_worker_id', 'the worker id is not of the enrolled shape');
  }
  if (!SCHEMA.NONCE_SHAPE.test(String(nonce))) {
    // The shape is load-bearing, not cosmetic: it is what makes the signing-string collision
    // documented in sender-signature.js unreachable on this path.
    return refuse(401, 'malformed_nonce', 'the nonce must be 32 lowercase hex characters');
  }

  // ── 2. SKEW ───────────────────────────────────────────────────────────────
  const skew = Math.abs(now - Number(timestamp));
  if (!Number.isFinite(skew) || skew > MAX_SKEW_MS) {
    return refuse(401, 'stale_signature',
      `the timestamp is ${Number.isFinite(skew) ? `${Math.round(skew / 1000)}s` : 'not a number'} `
      + `from now; the limit is ${MAX_SKEW_MS / 1000}s`);
  }

  // ── 3. IDENTITY ───────────────────────────────────────────────────────────
  let row;
  try {
    row = await IDENTITY.findWorker(workerId, { ...deps, query });
  } catch (e) {
    // Identity state is unknowable. Fail closed, and say whose fault it is.
    return refuse(503, 'identity_unavailable', `worker identity could not be read: ${e.message}`,
      { serverFault: true });
  }
  if (!row) return refuse(401, 'unknown_worker', 'no worker is enrolled under that id');

  // ── 4. REVOCATION — terminal, and before the secret is opened ─────────────
  if (row.revoked_at) {
    return refuse(401, 'revoked',
      `this worker was revoked${row.revoked_reason ? `: ${row.revoked_reason}` : ''}`);
  }
  if (row.scheme !== 'hmac-sha256') {
    return refuse(503, 'unsupported_scheme',
      `this worker is enrolled under scheme '${row.scheme}', which this verifier cannot check`,
      { serverFault: true });
  }

  // ── 5. SIGNATURE ──────────────────────────────────────────────────────────
  const parts = { method, path, timestamp: String(timestamp), nonce: String(nonce), body: String(body) };
  const candidates = [{ sealed: row.secret_current, previous: false }];
  const overlapLive = row.rotation_expires_at && new Date(row.rotation_expires_at).getTime() > now;
  if (row.secret_previous && overlapLive) {
    candidates.push({ sealed: row.secret_previous, previous: true });
  }

  let matched = null;
  for (const c of candidates) {
    let secret;
    try {
      secret = SECRETS.open(c.sealed, env);
    } catch (e) {
      // A secret we cannot open is our problem, not the caller's. Refusing is right; refusing with
      // 'bad_signature' would send the next person to debug the worker.
      return refuse(503, 'secret_unreadable',
        `a stored worker secret could not be opened: ${e.message}`, { serverFault: true });
    }
    if (SIG.sameSignature(signature, SIG.sign(secret, parts))) { matched = c; break; }
  }
  if (!matched) return refuse(401, 'bad_signature', 'the signature does not match this request');

  // ── 6. NONCE — recorded only now that the request is proven authentic ─────
  let claimed;
  try {
    claimed = await query(
      `INSERT INTO ${SCHEMA.TABLES.nonces} (nonce, worker_id) VALUES ($1, $2)
       ON CONFLICT (nonce) DO NOTHING RETURNING nonce`,
      [String(nonce), row.id],
    );
  } catch (e) {
    return refuse(503, 'replay_check_unavailable',
      `the nonce could not be recorded, so replay cannot be ruled out: ${e.message}`,
      { serverFault: true });
  }
  if (!claimed.rows.length) {
    // Postgres arbitrated this, not a read-then-write. Two identical requests in flight at once:
    // exactly one is served.
    return refuse(401, 'replayed', 'this exact request has already been seen');
  }

  // Best-effort liveness. A failure here must not fail an authenticated request.
  try {
    await query(`UPDATE ${SCHEMA.TABLES.identities} SET last_seen_at = NOW() WHERE id = $1`, [row.id]);
  } catch { /* observability, not authentication */ }

  return {
    ok: true,
    workerId: row.id,
    label: row.label,
    capabilities: row.capabilities || [],
    usedPreviousSecret: matched.previous,
  };
}

// ── AUTHORIZATION, WHICH IS A DIFFERENT QUESTION ─────────────────────────────

/**
 * Whether an authenticated worker may act right now. Consults the EXISTING kill switch — this is
 * the call site refinement 1 exists to insist upon.
 *
 * Registering `worker.execute` in autonomy's CAPABILITIES makes a stop expressible and
 * unbypassable. It does NOT make anything consult it. This function is that consultation, and
 * M7.2 must call it at lease issuance, at result acceptance, and mid-flight for anything
 * long-running. A worker that polls a verdict it never checks is the defect class this project has
 * paid for repeatedly.
 *
 * `worker.execute` is passed, never `deployment.execute`. Running a bounded worker task does not
 * grant permission to deploy software, and the two capabilities are never aliased.
 *
 * @returns {{allowed: true} | {allowed: false, stop: {scope_type, scope_key, reason, unknown?}}}
 */
async function authorizeWorkerAction({
  workerId, company = null, workflow = null, capability = SCHEMA.WORKER_CAPABILITY,
} = {}, deps = {}) {
  const autonomy = deps.autonomy || require('../autonomy');
  if (capability === 'deployment.execute') {
    // Not a stop — a refusal to even ask. A worker path must not be able to request deployment
    // authority, so this cannot be reached by passing a different argument.
    throw new Error('a worker may not act under deployment.execute; worker.execute is a separate capability');
  }
  const stop = await autonomy.checkStopped(
    { agent: workerId, capability, ...(company ? { company } : {}), ...(workflow ? { workflow } : {}) },
    { consequential: true, deps },
  );
  return stop ? { allowed: false, stop } : { allowed: true };
}

/** What a worker must send. Exported so the macOS client and the tests cannot drift from it. */
function signRequest(secret, { workerId, method, path, timestamp, nonce, body = '' }) {
  return {
    'x-worker-id': String(workerId),
    'x-worker-timestamp': String(timestamp),
    'x-worker-nonce': String(nonce),
    'x-worker-signature': SIG.sign(secret, {
      method, path, timestamp: String(timestamp), nonce: String(nonce), body: String(body),
    }),
  };
}

module.exports = { authenticateWorker, authorizeWorkerAction, signRequest, MAX_SKEW_MS };
