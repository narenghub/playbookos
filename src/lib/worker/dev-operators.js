// ── AUTHENTICATING A DEVELOPMENT OPERATOR ────────────────────────────────────
//
// Owner's directive of 2026-11-27: *"A registry lookup alone is not authentication. Bind the
// enrollment operation to a genuinely authenticated administrative execution context. Demonstrate
// that an unauthorized caller cannot borrow an approved operator's email or identifier. Enforce
// this authorization at the enrollment-token creation sink, not only in the CLI wrapper."*
//
// ── THE PRINCIPAL CANNOT BE FABRICATED, AND THAT IS THE WHOLE DESIGN ─────────
//
// The weak version of this module would export `verifyOperator(label)` returning true or false, and
// the sink would take an operator's email or id as an argument. Then anybody who could call the
// sink could name the approved operator and be believed — which is identification wearing
// authentication's clothes, and is exactly what the owner's sentence rules out.
//
// Instead `authenticate()` is the only function anywhere that can produce a principal, because the
// principal is branded with a `Symbol` held in this module's scope and exported nowhere. A caller
// can construct an object with the same `operatorId`, `label` and `allowedCapabilities` — and
// `isAuthenticatedOperator()` returns false for it, because the brand is not a field that can be
// guessed, spelled, or copied out of a log. There is no string an attacker can learn that
// substitutes for having presented the credential.
//
// This is capability-style authority rather than claim-style: holding the object IS the proof, and
// the object can only come from a successful constant-time credential comparison against this
// database. `scripts/check-dev-operator-registry-db.js` asserts the forged-object case directly,
// because a security property with no negative test is a comment.
//
// ── WHY POSSESSION OF A CREDENTIAL AND NOT POSSESSION OF DATABASE_URL ────────
//
// The owner's objection to the previous state was that *"the mint was authenticated by possession
// of the development DATABASE_URL and by nothing else, and the token row recorded no operator at
// all."* Reaching this module still requires the development `DATABASE_URL` — it has to, since the
// registry is in that database. What changed is that `DATABASE_URL` is no longer SUFFICIENT: the
// caller must additionally present a credential bound to a named, scoped, revocable row, and the
// mint records which row authorized it. Ambient access to the environment is no longer authority.
//
// ── CONSTANT TIME, AND WHY IT MATTERS EVEN HERE ──────────────────────────────
//
// `timingSafeEqual` on the digests, not `===`. The comparison happens inside a container nobody
// else can reach today, which is an argument about today's topology rather than about the code, and
// the cost of doing it properly is one function call.
//
// ── EVERY OUTCOME IS A ROW ───────────────────────────────────────────────────
//
// GRANTED and DENIED both append to `dev_operator_auth_events`, for the reason K4 ruling 12 gives:
// an email is not a record. An impersonation attempt that leaves no trace cannot be distinguished
// afterwards from one that never happened. The event row never contains the credential, the digest,
// or any prefix of either.

'use strict';

const crypto = require('node:crypto');
const SCHEMA = require('./dev-operators-schema');
const DEV_IDENTITY = require('./dev-identity');

/**
 * The brand. Private to this module by construction: it is never exported, never serialised, and
 * never appears in a log, so no caller can reproduce it on an object of their own.
 */
const AUTHENTICATED = Symbol('devOperatorAuthenticated');

const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32 });
const SCHEME = 'scrypt-n16384-r8-p1';
const MIN_CREDENTIAL_LENGTH = 32;

const q = (deps) => (deps && deps.query) || require('../db').query;

function digest(credential, saltHex) {
  return crypto
    .scryptSync(Buffer.from(String(credential), 'utf8'), Buffer.from(saltHex, 'hex'),
      SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
    .toString('hex');
}

function newOperatorId() {
  return `devop_${crypto.randomBytes(12).toString('hex')}`;
}

async function record({ operatorId = null, labelAttempted = null, outcome, code, detail = null },
  deps = {}) {
  try {
    await q(deps)(
      `INSERT INTO ${SCHEMA.TABLES.events} (operator_id, label_attempted, outcome, code, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [operatorId, labelAttempted, outcome, code, detail ? JSON.stringify(detail) : null],
    );
  } catch (e) {
    // A registry that refuses to authenticate because it could not write its own audit row would
    // convert an unwritable log into an outage. The refusal still stands on its own return value;
    // this only loses the record, and the caller's own logging will show the outcome.
    if (process.env.NODE_ENV !== 'test') {
      process.stderr.write(`dev_operator_event_not_written ${String(e.message).slice(0, 160)}\n`);
    }
  }
}

// ── PROVISIONING ─────────────────────────────────────────────────────────────

/**
 * Provisions one development operator. The credential is supplied by the caller and is never
 * returned, logged or stored — only its scrypt digest is kept.
 *
 * Refuses unless the database positively identifies as an isolated development database.
 */
async function provisionOperator({
  label, credential, allowedCapabilities = [], note = null,
} = {}, deps = {}) {
  if (!label || !String(label).trim()) return { ok: false, code: 'no_label' };
  if (!credential || String(credential).length < MIN_CREDENTIAL_LENGTH) {
    return { ok: false, code: 'credential_too_short',
      detail: `a development operator credential must be at least ${MIN_CREDENTIAL_LENGTH} `
        + 'characters; it is the only thing standing between ambient database access and an '
        + 'authorized mint' };
  }

  const ident = await DEV_IDENTITY.identifyIsolatedDevelopment(q(deps));
  if (!ident.ok) {
    return { ok: false, code: `database_${ident.verdict}`, detail: ident.detail };
  }

  const caps = [...new Set(allowedCapabilities.map((c) => String(c)))];
  for (const c of caps) {
    if (SCHEMA.PROHIBITED_CAPABILITIES.includes(c)) {
      // Refused here as well as by the CHECK constraint: this message says which capability and
      // why, where Postgres would say only that a constraint was violated.
      return { ok: false, code: 'prohibited_capability',
        detail: `${c} may never be granted to a development operator` };
    }
  }

  const id = newOperatorId();
  const salt = crypto.randomBytes(16).toString('hex');

  try {
    await q(deps)(
      `INSERT INTO ${SCHEMA.TABLES.operators}
         (id, label, scheme, credential_salt, credential_digest, allowed_capabilities,
          synthetic_only_required, is_active, created_note)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, TRUE, $7)`,
      [id, String(label).trim(), SCHEME, salt, digest(credential, salt), caps, note],
    );
  } catch (e) {
    if (/uq_dev_operators_live_label/.test(String(e.message))) {
      return { ok: false, code: 'label_already_live',
        detail: `a live development operator already holds the label ${label}; revoke it first` };
    }
    return { ok: false, code: 'insert_failed', detail: String(e.message).slice(0, 200) };
  }

  await record({ operatorId: id, labelAttempted: String(label).trim(), outcome: 'GRANTED',
    code: 'provisioned', detail: { allowedCapabilities: caps } }, deps);

  return { ok: true, operatorId: id, label: String(label).trim(), allowedCapabilities: caps };
}

// ── AUTHENTICATION ───────────────────────────────────────────────────────────

/**
 * Authenticates a development operator by credential possession.
 *
 * Returns { ok: true, principal } — the ONLY way a principal is ever produced — or
 * { ok: false, code }. Never returns a principal for an unknown, inactive or revoked operator, and
 * never for a database that does not positively identify as isolated development.
 */
async function authenticate({ label, credential } = {}, deps = {}) {
  const attempted = label ? String(label).trim() : null;

  if (!attempted || !credential) {
    await record({ labelAttempted: attempted, outcome: 'DENIED', code: 'incomplete' }, deps);
    return { ok: false, code: 'incomplete' };
  }

  const ident = await DEV_IDENTITY.identifyIsolatedDevelopment(q(deps));
  if (!ident.ok) {
    // Deliberately NOT recorded as an event: the events table lives in the database whose identity
    // just failed to be established, so writing there is exactly what must not happen yet.
    return { ok: false, code: `database_${ident.verdict}`, detail: ident.detail };
  }

  let row;
  try {
    const r = await q(deps)(
      `SELECT id, label, credential_salt, credential_digest, allowed_capabilities,
              synthetic_only_required, is_active, revoked_at
         FROM ${SCHEMA.TABLES.operators}
        WHERE lower(label) = lower($1) AND revoked_at IS NULL`,
      [attempted],
    );
    row = r.rows[0];
  } catch (e) {
    return { ok: false, code: 'registry_unreadable', detail: String(e.message).slice(0, 200) };
  }

  if (!row) {
    await record({ labelAttempted: attempted, outcome: 'DENIED', code: 'unknown_operator' }, deps);
    return { ok: false, code: 'unknown_operator' };
  }
  if (row.revoked_at) {
    await record({ operatorId: row.id, labelAttempted: attempted, outcome: 'DENIED',
      code: 'revoked' }, deps);
    return { ok: false, code: 'revoked' };
  }
  if (!row.is_active) {
    await record({ operatorId: row.id, labelAttempted: attempted, outcome: 'DENIED',
      code: 'inactive' }, deps);
    return { ok: false, code: 'inactive' };
  }

  const presented = Buffer.from(digest(credential, row.credential_salt), 'hex');
  const stored = Buffer.from(String(row.credential_digest), 'hex');
  const matches = presented.length === stored.length
    && crypto.timingSafeEqual(presented, stored);

  if (!matches) {
    await record({ operatorId: row.id, labelAttempted: attempted, outcome: 'DENIED',
      code: 'bad_credential' }, deps);
    return { ok: false, code: 'bad_credential' };
  }

  // `synthetic_only_required` is read from the row rather than assumed, even though a CHECK
  // constraint makes false unreachable. If that constraint is ever dropped, this reads the truth
  // instead of a belief about it.
  if (row.synthetic_only_required !== true) {
    await record({ operatorId: row.id, labelAttempted: attempted, outcome: 'DENIED',
      code: 'operator_not_synthetic_only' }, deps);
    return { ok: false, code: 'operator_not_synthetic_only' };
  }

  await q(deps)(
    `UPDATE ${SCHEMA.TABLES.operators} SET last_authenticated_at = NOW() WHERE id = $1`, [row.id]);
  await record({ operatorId: row.id, labelAttempted: attempted, outcome: 'GRANTED',
    code: 'authenticated' }, deps);

  const principal = {
    operatorId: row.id,
    label: row.label,
    allowedCapabilities: [...(row.allowed_capabilities || [])],
    syntheticOnlyRequired: true,
    /** Durable attribution for the mint. Not a secret and not an authority. */
    attribution: `dev_operator:${row.id}`,
  };
  Object.defineProperty(principal, AUTHENTICATED, { value: true, enumerable: false });
  return { ok: true, principal: Object.freeze(principal) };
}

/**
 * The sink's gate. True only for an object produced by `authenticate()` in this process.
 *
 * A caller-supplied object carrying the same fields returns false, which is the property the
 * owner's "cannot borrow an approved operator's email or identifier" requirement names.
 */
function isAuthenticatedOperator(principal) {
  return Boolean(principal) && typeof principal === 'object' && principal[AUTHENTICATED] === true;
}

// ── REVOCATION ───────────────────────────────────────────────────────────────

/** Sets `revoked_at`, never cleared. Un-revoking is not an operation; provision again instead. */
async function revokeOperator({ operatorId, reason = null } = {}, deps = {}) {
  if (!operatorId) return { ok: false, code: 'no_operator_id' };
  const r = await q(deps)(
    `UPDATE ${SCHEMA.TABLES.operators}
        SET revoked_at = NOW(), is_active = FALSE, revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id, label`,
    [operatorId, reason],
  );
  if (!r.rows.length) return { ok: false, code: 'not_live' };
  await record({ operatorId, labelAttempted: r.rows[0].label, outcome: 'GRANTED', code: 'revoked',
    detail: reason ? { reason } : null }, deps);
  return { ok: true, operatorId, label: r.rows[0].label };
}

module.exports = {
  provisionOperator, authenticate, isAuthenticatedOperator, revokeOperator,
  MIN_CREDENTIAL_LENGTH, SCHEME,
};
