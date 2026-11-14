// ── MACHINE IDENTITY: THE TABLES ─────────────────────────────────────────────
//
// M7.1. A worker is NOT a row in `users`. That table is email / name / role / password_hash /
// github_username — a human table — and a machine placed in it silently inherits every role check
// ever written for humans, including ones written later by somebody who never heard of the Mac
// mini. Separate tables, separate middleware, separate vocabulary.
//
// ── WHY THREE TABLES AND NOT ONE ─────────────────────────────────────────────
//
//   worker_identities          who may act, and with which secret
//   worker_enrollment_tokens   how a worker FIRST obtains a secret, exactly once
//   worker_request_nonces      which requests have already been seen
//
// The enrollment table exists so that no human ever has to carry a long-lived worker secret from
// one machine to another. An operator mints a short-lived single-use token; the worker exchanges
// it for a secret it then keeps in the macOS Keychain. After that exchange the secret exists in
// exactly two places — sealed in this database, and in the Keychain — and in neither case in a
// chat log, a terminal history, or a password manager.
//
// ── THE SECRET COLUMNS ───────────────────────────────────────────────────────
//
// HMAC is symmetric: the verifier must hold the same bytes the signer holds, so a digest is not an
// option the way it is for a password. The secret is therefore SEALED (AES-256-GCM, see
// secrets.js) rather than stored as plaintext, so that a database dump on its own does not yield a
// usable worker credential — it also needs the sealing key, which lives only in the environment.
//
// `secret_previous` plus `rotation_expires_at` is what makes rotation not an outage: both secrets
// verify during the overlap, so a worker that has not yet picked up the new one keeps working, and
// the old one dies on a deadline rather than on a deploy.
//
// `scheme` is recorded per row and not assumed. Today it is only 'hmac-sha256'. If this is ever
// moved to an asymmetric signature — which would be strictly better, since the database would then
// hold a public key and no credential at all — that is a new scheme value and a second verify
// branch, not a migration of this table. The column is the whole reason that stays cheap.
//
// ── REVOCATION ───────────────────────────────────────────────────────────────
//
// `revoked_at` is set, never cleared, and the row is never deleted: the evidence that a worker
// existed and was revoked is worth more than the tidiness of removing it. Un-revoking is not an
// operation. A machine that should act again enrols again, which is cheap and leaves a record.

'use strict';

const DDL = [
  `CREATE TABLE IF NOT EXISTS worker_identities (
     id                  TEXT PRIMARY KEY,
     label               TEXT NOT NULL,
     scheme              TEXT NOT NULL DEFAULT 'hmac-sha256',
     secret_current      TEXT NOT NULL,
     secret_previous     TEXT,
     rotated_at          TIMESTAMPTZ,
     rotation_expires_at TIMESTAMPTZ,
     capabilities        TEXT[] NOT NULL DEFAULT '{}',
     host_fingerprint    TEXT,
     enrolled_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     enrolled_by         TEXT,
     last_seen_at        TIMESTAMPTZ,
     revoked_at          TIMESTAMPTZ,
     revoked_by          TEXT,
     revoked_reason      TEXT
   )`,

  // The token itself is never stored — only its digest, so a database read cannot enrol a worker.
  `CREATE TABLE IF NOT EXISTS worker_enrollment_tokens (
     token_digest       TEXT PRIMARY KEY,
     label              TEXT NOT NULL,
     capabilities       TEXT[] NOT NULL DEFAULT '{}',
     created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_by         TEXT,
     expires_at         TIMESTAMPTZ NOT NULL,
     consumed_at        TIMESTAMPTZ,
     consumed_by_worker TEXT
   )`,

  // One row per authenticated request. The PRIMARY KEY is the replay check: a second INSERT of the
  // same nonce raises a unique violation, which is Postgres answering the question rather than this
  // code checking-then-inserting and losing a race to itself.
  `CREATE TABLE IF NOT EXISTS worker_request_nonces (
     nonce     TEXT PRIMARY KEY,
     worker_id TEXT NOT NULL,
     seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // Pruning is by age over the skew window. Without this index the prune is a sequential scan over
  // a table that grows with every request the worker ever makes.
  `CREATE INDEX IF NOT EXISTS idx_worker_nonces_seen_at ON worker_request_nonces (seen_at)`,

  `CREATE INDEX IF NOT EXISTS idx_worker_identities_live
     ON worker_identities (id) WHERE revoked_at IS NULL`,
];

/** The capability a worker acts under. Deliberately NOT deployment.execute — see auth.js. */
const WORKER_CAPABILITY = 'worker.execute';

/** Worker ids and nonces are fixed-shape hex. The shape is part of the security argument. */
const WORKER_ID_SHAPE = /^wkr_[0-9a-f]{32}$/;
const NONCE_SHAPE = /^[0-9a-f]{32}$/;

module.exports = {
  DDL, WORKER_CAPABILITY, WORKER_ID_SHAPE, NONCE_SHAPE,
  TABLES: {
    identities: 'worker_identities',
    tokens: 'worker_enrollment_tokens',
    nonces: 'worker_request_nonces',
  },
};
