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

const DEVOPS_SCHEMA = require('./dev-operators-schema');

const newWorkerId = () => `wkr_${crypto.randomBytes(16).toString('hex')}`;
const q = (deps) => deps.query || require('../db').query;

/**
 * Does this database hold the development operator registry?
 *
 * `to_regclass` rather than a catalog join, and for the reason the recovery module gives for the
 * same call: it distinguishes "the table is absent" — a definite no — from "the query failed",
 * which is not an answer. A failure here is NOT treated as absence, because absence is the
 * permissive branch: a database that cannot be interrogated would otherwise fall through to the
 * production regime and mint without a principal.
 */
async function devRegistryPresent(deps) {
  let r;
  try {
    r = await q(deps)(
      `SELECT to_regclass('${DEVOPS_SCHEMA.TABLES.operators}') IS NOT NULL AS present`);
  } catch (e) {
    throw new Error('could not determine whether the development operator registry is present, so '
      + 'the authorization regime for this mint is unknown. Refusing rather than defaulting to the '
      + `permissive branch (${String(e && e.message).slice(0, 160)})`);
  }
  return Boolean(r.rows[0] && r.rows[0].present);
}

async function migrateWorkerIdentity(query) {
  for (const sql of SCHEMA.DDL) await query(sql);
  // Migration 62's THIRD call site, and it is the one that actually creates `worker_identities`.
  // The installer is idempotent and asks whether each table exists before altering it, so calling
  // it from migrateOffice and migrateWorkerTasks as well is harmless — but neither of those creates
  // this table, so in a harness that runs them FIRST both calls correctly skipped the identity half
  // and the column was silently absent. The check reported it as "1 of 2 columns": the both-ends
  // pattern working exactly as designed and simply not having enough ends.
  await require('./synthetic-isolation').installSyntheticIsolation(query);
  // And the grants are made write-once BY THE DATABASE, after the columns exist. I had claimed this
  // property from the absence of UPDATE statements; attempting one showed both grant columns were
  // freely writable. See grant-immutability.js.
  await require('./grant-immutability').installGrantImmutability(query);
  return { ok: true, statements: SCHEMA.DDL.length };
}

// ── MINT ─────────────────────────────────────────────────────────────────────

/**
 * Returns the token ONCE. It is not stored and cannot be recovered; only its digest is kept.
 * A caller that loses it mints another.
 */
async function createEnrollmentToken({
  label, capabilities = [SCHEMA.WORKER_CAPABILITY], ttlMs = DEFAULT_TOKEN_TTL_MS, createdBy = null,
  // Migration 62. Defaults to RESTRICTED: an operator who says nothing about isolation gets the
  // safe answer, and widening is a thing somebody had to type. `false` is accepted only as the
  // literal boolean, so a truthy value cannot widen a worker by accident.
  syntheticOnly = true,
  // ── THE DEVELOPMENT OPERATOR PRINCIPAL (Option A, owner directive 2026-11-27) ──
  //
  // An unforgeable object from `dev-operators.authenticate()`, or null. NOT an email, NOT an id:
  // *"Demonstrate that an unauthorized caller cannot borrow an approved operator's email or
  // identifier."* A string can be borrowed from a log; this object cannot be constructed outside
  // that function, because its brand is a Symbol that module never exports.
  operator = null,
} = {}, deps = {}) {
  if (!label || !String(label).trim()) throw new Error('an enrollment token needs a label');

  // ── WHICH AUTHORIZATION REGIME APPLIES IS DECIDED BY THE DATABASE ─────────
  //
  // Owner: *"Enforce this authorization at the enrollment-token creation sink, not only in the CLI
  // wrapper."* So the regime is not a flag a caller passes — a flag can be set by anybody who can
  // call this function, which is the hole being closed. It is read from the database itself.
  //
  // The registry regime engages when BOTH hold:
  //
  //   1. `dev_operators` exists — this database has opted into the registry, and
  //   2. the database positively identifies as isolated development.
  //
  // Two conditions, not one, and deliberately so. On (1) alone, a production database that somehow
  // acquired the table would switch production into the development regime, which is the wrong
  // direction for a mistake to travel. On (2) alone, every disposable test cluster in `scripts/`
  // would suddenly require a principal, so the gate would have been introduced by breaking
  // thirty checks — and a gate that noisy gets relaxed rather than understood.
  //
  // A database that has the registry but fails identification is refused outright. That is the
  // fail-closed direction: `cannot_tell` is a refusal, never permission.
  // ── WHAT ENGAGES THE REGISTRY REGIME IS THE PRINCIPAL, NOT THE TABLE ──────
  //
  // The first version of this gate engaged on the registry table's PRESENCE, and that was too
  // broad. `scripts/check-m7-dev-environment-db.js` enrols a Mac-mini-style worker with
  // `syntheticOnly: false`, authorized by `lib/fixture-admin.fixtureAdmin()` — which creates a
  // `users` table and an administrator row precisely to exercise the verified-administrator
  // widening path. Once the development migration also created `dev_operators`, that fixture held
  // both, so the gate refused a mint the owner had explicitly told me to preserve, and the check
  // stopped executing. Preflight reported `1 did not execute`, exit 2, DO NOT PUSH — which is the
  // discipline working: a check that does not run is not a check that passed.
  //
  // So the three paths are now distinguished by HOW the mint is authorized:
  //
  //   operator principal supplied  → the registry regime: identification, synthetic-only, scope
  //   no principal, `users` exists → the pre-existing path, byte-for-byte unchanged
  //   no principal, no `users`     → refused where a registry exists (null attribution)
  //
  // Note what this does NOT pretend to defend against. A caller holding the development
  // `DATABASE_URL` could create a `users` table and an admin row itself — but that same access can
  // INSERT into `worker_enrollment_tokens` directly and skip this function altogether, so arbitrary
  // write access was never in this sink's threat model. What is in scope is that a CALLER of this
  // function cannot self-authorize, and that holds. A populated `users` in the real development
  // database would also make `scripts/lib/db-identity.js` report `production_fingerprint` and every
  // development script refuse, which is a separate and much louder alarm.
  const registryPresent = await devRegistryPresent(deps);
  if (operator) {
    if (!registryPresent) {
      throw new Error('a development operator principal was supplied, but this database holds no '
        + 'development operator registry. A development credential must not authorize a mint '
        + 'anywhere else');
    }
    // The brand is checked FIRST, before any query: an object that is not an authenticated
    // principal should not cause this function to go near the database at all, and the refusal
    // reason should be the honest one rather than whatever the database happens to say next.
    const DEVOPS = require('./dev-operators');
    if (!DEVOPS.isAuthenticatedOperator(operator)) {
      // Covers a bare email, an operator id, and a hand-built object carrying the right-looking
      // fields. None of them has the brand, so none of them is authentication.
      throw new Error(
        'this development database requires an authenticated development operator to mint an '
        + 'enrollment token. Pass the principal returned by dev-operators.authenticate(); an '
        + 'email, an operator id, or an object resembling a principal is identification, not '
        + 'authentication, and is refused');
    }

    const DEV_IDENTITY = require('./dev-identity');
    const ident = await DEV_IDENTITY.identifyIsolatedDevelopment(q(deps));
    if (!ident.ok) {
      throw new Error(
        `this database holds the ${DEVOPS_SCHEMA.TABLES.operators} registry but does not identify `
        + `as an isolated development database (${ident.verdict}: ${ident.detail}). Refusing to `
        + 'mint: a registry credential must not authorize anything outside the environment it was '
        + 'provisioned for');
    }

    // Synthetic-only is mandatory here and is not negotiable by argument. The owner's directive:
    // *"Synthetic-only enrollment is mandatory. Hardware and GUI capability grants are prohibited
    // for the cloud worker. Unrestricted enrollment is prohibited."*
    if (syntheticOnly !== true) {
      throw new Error('unrestricted enrollment is prohibited in the development environment: '
        + 'syntheticOnly must be true');
    }
    for (const c of capabilities) {
      if (DEVOPS_SCHEMA.PROHIBITED_CAPABILITIES.includes(c)) {
        throw new Error(`${c} may not be granted by a development operator`);
      }
      if (!operator.allowedCapabilities.includes(c)) {
        throw new Error(`the authenticated operator ${operator.operatorId} is not scoped to grant `
          + `${c}; its scope is [${operator.allowedCapabilities.join(', ')}]`);
      }
    }

    // ── THE PRINCIPAL IS RE-VALIDATED AT THE MINT, NOT ONLY AT AUTHENTICATION ──
    //
    // A principal is an object, and an object outlives the row it was derived from. Without this
    // read, an operator revoked thirty seconds ago keeps minting for as long as some caller still
    // holds the object it obtained beforehand — which makes revocation an intention rather than a
    // control. The owner's directive lists revocation among the things that must be enforced, so
    // the authority is checked against the registry at the moment it is exercised.
    //
    // Found by the negative test in scripts/check-dev-operator-registry-db.js, which asserted that
    // a principal held from before revocation cannot mint, and failed against the first version of
    // this branch.
    let live;
    try {
      const r = await q(deps)(
        `SELECT is_active, revoked_at, allowed_capabilities, synthetic_only_required
           FROM ${DEVOPS_SCHEMA.TABLES.operators} WHERE id = $1`, [operator.operatorId]);
      live = r.rows[0];
    } catch (e) {
      throw new Error('the authenticated operator could not be re-validated against the registry, '
        + `so its authority is unknown. Refusing (${String(e && e.message).slice(0, 120)})`);
    }
    if (!live) {
      throw new Error(`the authenticated operator ${operator.operatorId} is no longer in the `
        + 'registry; its principal is stale and authorizes nothing');
    }
    if (live.revoked_at || live.is_active !== true) {
      throw new Error(`the authenticated operator ${operator.operatorId} has been revoked; a `
        + 'principal obtained before revocation authorizes nothing');
    }
    if (live.synthetic_only_required !== true) {
      throw new Error(`the authenticated operator ${operator.operatorId} is no longer marked `
        + 'synthetic-only; refusing rather than minting under an authority that changed shape');
    }
    // Scope is re-read too, for the same reason: the principal's copy was accurate when it was
    // made, and a narrowed scope must bind immediately rather than at the next authentication.
    for (const c of capabilities) {
      if (!(live.allowed_capabilities || []).includes(c)) {
        throw new Error(`the operator ${operator.operatorId}'s current scope does not include `
          + `${c}; the principal's copy is stale`);
      }
    }

    // Durable attribution, taken from the principal rather than from the caller's `createdBy`.
    // A caller cannot attribute a mint to an operator it did not authenticate as.
    createdBy = operator.attribution;
  } else if (registryPresent) {
    // ── NULL ATTRIBUTION IS REFUSED IN THE ISOLATED DEVELOPMENT ENVIRONMENT ──
    //
    // Owner's directive: *"Null operator attribution must be refused."* Reached only where the
    // registry exists AND there is no `users` table to authorize the mint the pre-existing way —
    // which is exactly the real development database, and is not any fixture that builds an
    // administrator for itself.
    let hasUsers;
    try {
      const r = await q(deps)("SELECT to_regclass('users') IS NOT NULL AS present");
      hasUsers = Boolean(r.rows[0] && r.rows[0].present);
    } catch (e) {
      throw new Error('could not determine whether an administrator table exists, so the '
        + 'authorization regime for this mint is unknown. Refusing rather than defaulting to the '
        + `permissive branch (${String(e && e.message).slice(0, 120)})`);
    }
    if (!hasUsers) {
      throw new Error(
        'this development database requires an authenticated development operator to mint an '
        + 'enrollment token. Pass the principal returned by dev-operators.authenticate(); an '
        + 'email, an operator id, or an object resembling a principal is identification, not '
        + 'authentication, and is refused');
    }
  }

  // ── A PRIVILEGED GRANT REQUIRES A VERIFIED ADMINISTRATOR, AT THE SINK ─────
  //
  // Owner, sixth directive: *"Inspect every caller of createEnrollmentToken and every direct worker
  // identity creation path. Verify that ordinary callers cannot mint unrestricted identities."*
  // Measured before writing this: they could. `createEnrollmentToken({syntheticOnly: false})`
  // succeeded for any caller of the module, and so did a mint with `createdBy: null`.
  //
  // The check is HERE rather than in `enroll-worker-no-transcript.js`, where I first put it, for
  // B3.11a's reason: a gate in one caller is a statement about that caller, and a gate at the sink
  // is on every path including the ones nobody has written yet. The script's copy is now redundant
  // and kept only because it refuses earlier, with a better message, before anything is minted.
  //
  // `--operator` being *identification, not authentication* is the owner's point 3 and is a
  // separate, larger piece: this resolves and CHECKS the named actor against persisted state, which
  // is strictly better than recording a string, and it is still not proof that the person at the
  // keyboard is that actor. Point 3's authenticated path is tracked separately and this does not
  // claim to be it.
  const wantsWidening = syntheticOnly === false
    || capabilities.some((c) => c === 'exec:hardware' || c === 'exec:gui');
  if (wantsWidening) {
    if (!createdBy) {
      throw new Error(
        'minting a token that widens a worker — synthetic_only false, or exec:hardware/exec:gui — '
        + 'requires createdBy naming an administrator. A privileged grant attributed to nobody is '
        + 'the hole this refusal closes');
    }
    const actor = await q(deps)(
      'SELECT id, role, is_active FROM users WHERE id = $1', [String(createdBy)]);
    const u = actor.rows[0];
    if (!u) throw new Error(`createdBy ${createdBy} is not a user, so it cannot authorize a widened grant`);
    if (!u.is_active) throw new Error(`createdBy ${createdBy} is a deactivated account`);
    const { isExternalRole } = require('../roles');
    if (isExternalRole(u.role)) {
      throw new Error(`createdBy ${createdBy} holds the external role "${u.role}" — a partner is `
        + 'not an administrator of this platform');
    }
    if (!['super_admin', 'admin'].includes(String(u.role))) {
      throw new Error(`createdBy ${createdBy} holds the role "${u.role}"; widening a worker grant `
        + 'requires admin or super_admin');
    }
  }

  const now = deps.now ? deps.now() : Date.now();
  const token = SECRETS.newEnrollmentToken();
  const expiresAt = new Date(now + Number(ttlMs));

  await q(deps)(
    `INSERT INTO ${SCHEMA.TABLES.tokens}
       (token_digest, label, capabilities, created_by, expires_at, synthetic_only)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [SECRETS.digestOfToken(token), String(label).trim(), capabilities, createdBy,
      expiresAt.toISOString(), syntheticOnly !== false],
  );

  return { token, expiresAt: expiresAt.toISOString(), label: String(label).trim(), capabilities,
    syntheticOnly: syntheticOnly !== false };
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
      RETURNING label, capabilities, synthetic_only`,
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

  const { label, capabilities, synthetic_only: syntheticOnly } = burned.rows[0];
  const workerId = newWorkerId();
  const secret = SECRETS.newSecret();

  await query(
    `INSERT INTO ${SCHEMA.TABLES.identities}
       (id, label, scheme, secret_current, capabilities, host_fingerprint, enrolled_by,
        synthetic_only)
     VALUES ($1, $2, 'hmac-sha256', $3, $4, $5, $6, $7)`,
    [workerId, label, SECRETS.seal(secret, deps.env || process.env), capabilities,
      hostFingerprint, `enrollment:${digest.slice(0, 12)}`,
      // Carried from the token the operator issued, never defaulted here: a value invented at
      // exchange time would mean the identity's restriction came from the code rather than from
      // the authorization, which is the distinction `capabilities` is built on one column over.
      syntheticOnly !== false],
  );

  await query(
    `UPDATE ${SCHEMA.TABLES.tokens} SET consumed_by_worker = $2 WHERE token_digest = $1`,
    [digest, workerId],
  );

  return { ok: true, workerId, secret, label, capabilities, syntheticOnly };
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

  // Refinement 2: revocation must reach a LIVE LEASE, not wait for its ceiling. Lazily required so
  // that identity.js carries no load-time dependency on the task layer — a worker can be enrolled
  // and revoked in a deployment where the task tables do not exist yet, and that must not throw.
  let leases = { closed: [], tasks: [] };
  try {
    leases = await require('./leases').releaseLeasesOfWorker(
      String(workerId), { reason: `revoked: ${String(reason).trim()}` }, deps);
  } catch (e) {
    // A revocation that half-succeeds must still be a revocation: the identity is already dead
    // above, and authentication refuses it from here on. The lease cleanup failing is reported
    // rather than swallowed, and the reaper remains the backstop.
    leases = { closed: [], tasks: [], error: e.message };
  }

  return { ok: true, workerId: r.rows[0].id, label: r.rows[0].label, leases };
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
