// ── THE DEVELOPMENT OPERATOR REGISTRY: THE TABLES ────────────────────────────
//
// Owner's directive of 2026-11-27, Option A: *"Introduce a narrowly scoped `dev_operators` registry
// through the development migration path. Preserve the absence of production business tables,
// including `users`."*
//
// ── WHY THIS TABLE HAD TO EXIST ──────────────────────────────────────────────
//
// `scripts/enroll-worker-no-transcript.js` verifies `--operator` against `users`. The isolated
// development database has no `users` table, and that absence is not an oversight —
// `scripts/m7-dev-migrate.js` treats it as the isolation property itself: *"the dev database has no
// schema in which business data COULD be written, which is a stronger isolation property than any
// amount of configuration."* Measured 2026-11-28: `to_regclass('public.users')` is null there.
//
// So the authenticated enrollment path could not run, and the two obvious fixes were both wrong.
// Adding `users` makes `scripts/lib/db-identity.js` classify the database as
// `production_fingerprint` the moment an administrator row exists (its step 2 probes every
// production table with `SELECT 1 … LIMIT 1`, and any row is a finding) — weakening the one check
// that separates development from production in order to satisfy an authorization check. Relaxing
// the operator requirement reverses the owner's fifth directive, which added it precisely because
// *"the mint was authenticated by possession of the development DATABASE_URL and by nothing else."*
//
// This is the third option: a table that is not `users`, holds no business data, and is declared.
//
// `identity-schema.js` makes the same argument in the other direction — *"A worker is NOT a row in
// `users`. That table is email / name / role / password_hash … a human table, and a machine placed
// in it silently inherits every role check ever written for humans."* A development operator is not
// a platform user either: it authorizes exactly one act, in exactly one environment, and inheriting
// the human role machinery is the thing to avoid, not to reuse.
//
// ── WHAT MAKES THIS AUTHENTICATION AND NOT IDENTIFICATION ────────────────────
//
// Owner, same directive: *"A registry lookup alone is not authentication. … Demonstrate that an
// unauthorized caller cannot borrow an approved operator's email or identifier."*
//
// So `label` carries NO authority. It is a human-readable name and nothing else, and the module
// that reads this table will not grant anything on the strength of it. Authority comes from
// presenting a credential whose scrypt digest matches `credential_digest` — possession, verified in
// constant time. Knowing that `naren@abiozen.com` is the approved operator is therefore worth
// nothing, which is the property the owner asked to be demonstrated.
//
// The credential is DIGESTED, not sealed. Unlike a worker's HMAC secret — where the verifier must
// hold the same bytes, which is why `worker_identities.secret_current` is sealed rather than hashed
// — nothing here ever needs the credential back. A one-way digest is therefore available, and a
// database dump yields no usable operator credential even with the sealing key.
//
// ── TWO RULES ARE ENFORCED BY THE DATABASE, NOT BY CODE ──────────────────────
//
// Owner's standing instruction: *"Do not treat the absence of UPDATE statements as proof of
// database-enforced immutability."* So the two prohibitions that matter are CHECK constraints:
//
//   dev_operators_synthetic_only_required   synthetic_only_required cannot be set false, ever
//   dev_operators_no_privileged_caps        exec:hardware and exec:gui cannot appear in scope
//
// A future caller that tries to widen a development operator is refused by Postgres, on every path
// including the ones nobody has written yet. A code-only guard would be a statement about today's
// callers.
//
// ── REFUSALS ARE ROWS ────────────────────────────────────────────────────────
//
// `dev_operator_auth_events` is append-only and records DENIED as well as GRANTED, for the reason
// K4 ruling 12 gives: an email is not a record. A failed impersonation attempt that leaves no trace
// is indistinguishable from one that never happened.

'use strict';

const TABLES = Object.freeze({
  operators: 'dev_operators',
  events: 'dev_operator_auth_events',
});

/** Capabilities a development operator may never hold, enforced below by the database. */
const PROHIBITED_CAPABILITIES = Object.freeze(['exec:hardware', 'exec:gui']);

const DDL = [
  `CREATE TABLE IF NOT EXISTS dev_operators (
     id                      TEXT PRIMARY KEY,
     label                   TEXT NOT NULL,
     scheme                  TEXT NOT NULL DEFAULT 'scrypt-n16384-r8-p1',
     credential_salt         TEXT NOT NULL,
     credential_digest       TEXT NOT NULL,
     allowed_capabilities    TEXT[] NOT NULL DEFAULT '{}',
     synthetic_only_required BOOLEAN NOT NULL DEFAULT TRUE,
     is_active               BOOLEAN NOT NULL DEFAULT TRUE,
     created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     created_note            TEXT,
     last_authenticated_at   TIMESTAMPTZ,
     revoked_at              TIMESTAMPTZ,
     revoked_reason          TEXT,
     CONSTRAINT dev_operators_synthetic_only_required
       CHECK (synthetic_only_required),
     CONSTRAINT dev_operators_no_privileged_caps
       CHECK (NOT (allowed_capabilities && ARRAY['exec:hardware', 'exec:gui']::TEXT[])),
     CONSTRAINT dev_operators_revocation_is_inactive
       CHECK (revoked_at IS NULL OR is_active = FALSE)
   )`,

  // One live operator per label. Partial, so a revoked row keeps its label rather than blocking
  // re-provisioning — the same reasoning `worker_identities` gives for never deleting a revoked
  // row: the evidence is worth more than the tidiness.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_dev_operators_live_label
     ON dev_operators (lower(label)) WHERE revoked_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS dev_operator_auth_events (
     id              BIGSERIAL PRIMARY KEY,
     at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     operator_id     TEXT,
     label_attempted TEXT,
     outcome         TEXT NOT NULL,
     code            TEXT NOT NULL,
     detail          JSONB,
     CONSTRAINT dev_operator_auth_events_outcome
       CHECK (outcome IN ('GRANTED', 'DENIED'))
   )`,

  `CREATE INDEX IF NOT EXISTS idx_dev_operator_auth_events_at
     ON dev_operator_auth_events (at DESC)`,
];

async function migrateDevOperators(query) {
  for (const stmt of DDL) await query(stmt);
}

module.exports = { DDL, TABLES, PROHIBITED_CAPABILITIES, migrateDevOperators };
