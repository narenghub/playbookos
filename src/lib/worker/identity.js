// ── ENROLMENT, ROTATION, REVOCATION ──────────────────────────────────────────
//
// M7.1. Everything that creates, changes or ends a machine identity. Nothing here authenticates a
// request — that is auth.js, and the split is deliberate: this module is called by operators, that
// one is called by every worker request, and giving them the same entry point is how an endpoint
// ends up able to mint the credential it is supposed to be checking.
//
// ── ENROLMENT IS TWO ACTS BY TWO PARTIES ─────────────────────────────────────
//
//   1. An operator mints a single-use, short-lived token. They see it once.
//   2. The worker exchanges it for its id and secret. The token is burned in the exchange.
//
// The alternative — an operator generates a secret and pastes it onto the machine — puts a
// long-lived credential through a clipboard, a terminal history and probably a chat window. This
// shape means the secret is generated at the moment of use and never exists anywhere a human can
// accidentally keep it.
//
// ── THE BURN IS ARBITRATED BY POSTGRES, NOT BY THIS CODE ─────────────────────
//
// `UPDATE … WHERE consumed_at IS NULL … RETURNING` is one statement. Two workers presenting the
// same token concurrently: exactly one gets a row back. A read-then-write would lose that race to
// itself, and it would lose it rarely, which is worse than losing it often.
//
// ── THE ORDER OF BURN AND INSERT, AND WHY THIS WAY ROUND ─────────────────────
//
// The token is burned BEFORE the identity row is written. If the insert then fails, the token is
// spent and no worker exists: the operator mints another, which is a minor annoyance. The other
// order fails the other way — an identity exists and the token is still live, so it could enrol a
// SECOND worker sharing nothing but the operator's intent. One of those failures is inconvenient
// and the other is a duplicate credential, so the order is chosen rather than incidental. Where a
// transaction is available it is used and the question does not arise.

'use strict';

const crypto = require('crypto');
const SCHEMA = require('./identity-schema');
const SECRETS = require('./secrets');

const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;
const DEFAULT_ROTATION_OVERLAP_MS = 60 * 60 * 1000;

const newWorkerId = () => `wkr_${crypto.randomBytes(16).toString('hex')}`;
const q = (deps) => deps.query || require('../db').query;

async function migrateWorkerIdentity(query) {
  for (const sql of SCHEMA.DDL) await query(sql);
  return { ok: true, statements: SCHEMA.DDL.length };
}

// ── MINT ─────────────────────────────────────────────────────────────────────

/**
 * Returns the token ONCE. It is not stored and cannot be recovered; only its digest is kept.
 * A caller that loses it mints another.
 */
async function createEnrollmentToken({
  label, capabilities = [SCHEMA.WORKER_CAPABILITY], ttlMs = DEFAULT_TOKEN_TTL_MS, createdBy = null,
} = {}, deps = {}) {
  if (!label || !String(label).trim()) throw new Error('an enrollment token needs a label');
  const now = deps.now ? deps.now() : Date.now();
  const token = SECRETS.newEnrollmentToken();
  const expiresAt = new Date(now + Number(ttlMs));

  await q(deps)(
    `INSERT INTO ${SCHEMA.TABLES.tokens} (token_digest, label, capabilities, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [SECRETS.digestOfToken(token), String(label).trim(), capabilities, createdBy, expiresAt.toISOString()],
  );

  return { token, expiresAt: expiresAt.toISOString(), label: String(label).trim(), capabilities };
}

// ── EXCHANGE ─────────────────────────────────────────────────────────────────

/**
 * Exchanges a token for an identity. Returns { ok: true, workerId, secret } once, or
 * { ok: false, code } — never a partially-created worker.
 *
 * `secret` is returned here and nowhere else, ever. It goes into the macOS Keychain on the worker
 * and is sealed in the database on this side.
 */
async function consumeEnrollmentToken({ token, hostFingerprint = null } = {}, deps = {}) {
  if (!token) return { ok: false, code: 'no_token' };
  const query = q(deps);
  const digest = SECRETS.digestOfToken(token);

  // Fail before burning anything if the environment cannot seal. Otherwise a misconfigured
  // deployment spends the operator's token to discover its own missing variable.
  try { SECRETS.sealingKey(deps.env || process.env); } catch (e) {
    return { ok: false, code: 'cannot_seal', detail: e.message };
  }

  const burned = await query(
    `UPDATE ${SCHEMA.TABLES.tokens}
        SET consumed_at = NOW()
      WHERE token_digest = $1 AND consumed_at IS NULL AND expires_at > NOW()
      RETURNING label, capabilities`,
    [digest],
  );

  if (!burned.rows.length) {
    // The verdict is already settled; this read only makes the REASON legible in a log. It cannot
    // change the answer, which is why it is safe to do after the fact.
    const why = await query(
      `SELECT consumed_at, expires_at FROM ${SCHEMA.TABLES.tokens} WHERE token_digest = $1`, [digest],
    );
    if (!why.rows.length) return { ok: false, code: 'unknown_token' };
    if (why.rows[0].consumed_at) return { ok: false, code: 'token_already_used' };
    return { ok: false, code: 'token_expired' };
  }

  const { label, capabilities } = burned.rows[0];
  const workerId = newWorkerId();
  const secret = SECRETS.newSecret();

  await query(
    `INSERT INTO ${SCHEMA.TABLES.identities}
       (id, label, scheme, secret_current, capabilities, host_fingerprint, enrolled_by)
     VALUES ($1, $2, 'hmac-sha256', $3, $4, $5, $6)`,
    [workerId, label, SECRETS.seal(secret, deps.env || process.env), capabilities,
      hostFingerprint, `enrollment:${digest.slice(0, 12)}`],
  );

  await query(
    `UPDATE ${SCHEMA.TABLES.tokens} SET consumed_by_worker = $2 WHERE token_digest = $1`,
    [digest, workerId],
  );

  return { ok: true, workerId, secret, label, capabilities };
}

// ── LOOK UP ──────────────────────────────────────────────────────────────────

/** The row as stored. Secrets stay sealed; only auth.js opens them, and only to verify. */
async function findWorker(workerId, deps = {}) {
  if (!workerId || !SCHEMA.WORKER_ID_SHAPE.test(String(workerId))) return null;
  const r = await q(deps)(
    `SELECT id, label, scheme, secret_current, secret_previous, rotation_expires_at,
            capabilities, revoked_at, revoked_reason, last_seen_at
       FROM ${SCHEMA.TABLES.identities} WHERE id = $1`,
    [String(workerId)],
  );
  return r.rows[0] || null;
}

async function listWorkers({ includeRevoked = false } = {}, deps = {}) {
  const r = await q(deps)(
    `SELECT id, label, capabilities, enrolled_at, last_seen_at, revoked_at, revoked_reason
       FROM ${SCHEMA.TABLES.identities}
      ${includeRevoked ? '' : 'WHERE revoked_at IS NULL'}
      ORDER BY enrolled_at DESC`,
  );
  return r.rows;
}

// ── ROTATE ───────────────────────────────────────────────────────────────────

/**
 * Issues a new secret and keeps the old one valid for an overlap, so rotation is not an outage for
 * a worker that has not yet collected the new one. The old secret dies on a deadline in the
 * database, not on a restart.
 *
 * Returns the new secret once. A revoked worker cannot be rotated — revocation is terminal.
 */
async function rotateSecret(workerId, {
  overlapMs = DEFAULT_ROTATION_OVERLAP_MS, actor = null,
} = {}, deps = {}) {
  const env = deps.env || process.env;
  try { SECRETS.sealingKey(env); } catch (e) {
    return { ok: false, code: 'cannot_seal', detail: e.message };
  }
  const now = deps.now ? deps.now() : Date.now();
  const secret = SECRETS.newSecret();

  const r = await q(deps)(
    `UPDATE ${SCHEMA.TABLES.identities}
        SET secret_previous      = secret_current,
            secret_current       = $2,
            rotated_at           = NOW(),
            rotation_expires_at  = $3
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [String(workerId), SECRETS.seal(secret, env), new Date(now + Number(overlapMs)).toISOString()],
  );

  if (!r.rows.length) return { ok: false, code: 'unknown_or_revoked' };
  void actor;
  return { ok: true, workerId: String(workerId), secret, overlapEndsAt: new Date(now + Number(overlapMs)).toISOString() };
}

// ── REVOKE ───────────────────────────────────────────────────────────────────

/**
 * Terminal. The row is kept, `revoked_at` is set once and never cleared, and there is no un-revoke:
 * a machine that should act again enrols again, which leaves a record of the decision.
 *
 * Both secret columns are overwritten here rather than left sealed in place. Authentication already
 * refuses a revoked row, so this is defence in depth — it means a later bug that forgets the
 * revocation check still has nothing to verify against.
 *
 * NOTE for M7.2: this ends authentication immediately. It does NOT by itself invalidate a lease the
 * worker already holds — leases do not exist yet. Killing a live lease on revocation is a stated
 * M7.2 requirement and must not be assumed to fall out of this function.
 */
async function revokeWorker(workerId, { reason, actor = null } = {}, deps = {}) {
  if (!reason || !String(reason).trim()) return { ok: false, code: 'reason_required' };
  const r = await q(deps)(
    `UPDATE ${SCHEMA.TABLES.identities}
        SET revoked_at = NOW(), revoked_by = $2, revoked_reason = $3,
            secret_current = 'revoked', secret_previous = NULL, rotation_expires_at = NULL
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id, label`,
    [String(workerId), actor, String(reason).trim()],
  );
  if (!r.rows.length) return { ok: false, code: 'unknown_or_already_revoked' };
  return { ok: true, workerId: r.rows[0].id, label: r.rows[0].label };
}

// ── HOUSEKEEPING ─────────────────────────────────────────────────────────────

/**
 * Nonces older than the replay window can never make a request succeed, so they are only cost.
 * Deletes by age over this table alone — it holds nothing but request nonces, so there is no
 * "recent rows" hazard of the kind the verification scripts warn about.
 */
async function pruneNonces({ olderThanMs } = {}, deps = {}) {
  const cutoff = new Date((deps.now ? deps.now() : Date.now()) - Number(olderThanMs || 3600000));
  const r = await q(deps)(
    `DELETE FROM ${SCHEMA.TABLES.nonces} WHERE seen_at < $1::timestamptz`, [cutoff.toISOString()],
  );
  return { deleted: r.rowCount || 0, cutoff: cutoff.toISOString() };
}

/**
 * Makes every live worker id stoppable by an operator, by registering it as an `agent` scope. A
 * worker whose id is not a known scope key can still be stopped globally or by capability; this is
 * what makes "stop THAT machine" expressible in the existing kill switch.
 */
async function registerWorkerScopes(deps = {}) {
  const autonomy = deps.autonomy || require('../autonomy');
  const rows = await listWorkers({}, deps);
  return autonomy.registerScopes({ agents: rows.map((r) => r.id) });
}

module.exports = {
  migrateWorkerIdentity,
  createEnrollmentToken, consumeEnrollmentToken,
  findWorker, listWorkers,
  rotateSecret, revokeWorker,
  pruneNonces, registerWorkerScopes,
  newWorkerId,
  DEFAULT_TOKEN_TTL_MS, DEFAULT_ROTATION_OVERLAP_MS,
};
