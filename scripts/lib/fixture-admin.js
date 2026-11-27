// ── A FIXTURE ADMINISTRATOR, FOR CHECKS THAT NEED A WIDENED WORKER ──────────
//
// Sixth directive, 2026-11-27. `createEnrollmentToken` now refuses to mint a widened grant —
// `synthetic_only: false`, `exec:hardware` or `exec:gui` — unless `createdBy` names an active,
// internal `admin` or `super_admin`. That requirement is the point: the owner asked me to verify
// that *"ordinary callers cannot mint unrestricted identities"*, and before this they could.
//
// Seventeen checks are ordinary callers minting unrestricted identities, because their subject is
// leasing, cycle or capability mechanics rather than isolation. They are not exempt from the rule;
// they have to name an administrator like anything else does. This gives them one that is visibly a
// fixture, so a reader of the `worker_enrollment_tokens` audit trail can tell a check's mint from
// an operator's.
//
// **It creates a real user row, deliberately.** A stub id would make the refusal above vacuous for
// every check that uses it — the actor is RESOLVED and checked against `users`, so an id belonging
// to nobody is refused, which is the whole mechanism. The row is found-or-created and idempotent,
// so repeated calls in one run reuse it.

'use strict';

const FIXTURE_ADMIN_ID = 'fixture-admin-worker-grants';
const FIXTURE_ADMIN_EMAIL = 'fixture-admin@fixture.invalid';

/**
 * @returns {Promise<string>} the fixture administrator's user id, suitable as `createdBy`.
 */
async function fixtureAdmin(query) {
  // ── THE NARROW HARNESSES DO NOT HAVE A `users` TABLE ──────────────────────
  //
  // Four worker harnesses migrate only the worker schema, because until now nothing about enrolling
  // a worker touched `users`. The new rule — widening a grant requires a verified administrator —
  // introduces that coupling deliberately, and those four reported INCOMPLETE with
  // `relation "users" does not exist`, which is the coupling being real rather than a defect.
  //
  // So the table is created here when absent, with the four columns the authorization actually
  // reads, copied from `db.js`'s own DDL (`is_active` is INTEGER there, not BOOLEAN — which is
  // worth getting right, because `is_active = false` would be a type error and `0` is what the
  // real schema stores). `CREATE TABLE IF NOT EXISTS` means a harness that ran the full schema is
  // untouched and keeps its real table.
  await query(
    `CREATE TABLE IF NOT EXISTS users (
       id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
       role TEXT NOT NULL, github_username TEXT, invite_token TEXT,
       invited_at TEXT, joined_at TEXT, password_hash TEXT,
       is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT NOW()
     )`);

  const existing = await query(
    'SELECT id, role, is_active FROM users WHERE id = $1', [FIXTURE_ADMIN_ID]);
  if (existing.rows.length) {
    const u = existing.rows[0];
    // Repair rather than assume: a previous run's cleanup may have deactivated it, and an inactive
    // actor is refused by the gate — which would read as "the gate is broken" rather than "the
    // fixture is stale".
    if (u.role !== 'super_admin' || !u.is_active) {
      await query(
        `UPDATE users SET role = 'super_admin', is_active = 1 WHERE id = $1`, [FIXTURE_ADMIN_ID]);
    }
    return FIXTURE_ADMIN_ID;
  }
  await query(
    `INSERT INTO users (id, email, name, role, is_active, password_hash)
     VALUES ($1, $2, 'Fixture Admin (worker grants)', 'super_admin', 1, 'x')
     ON CONFLICT (id) DO NOTHING`,
    [FIXTURE_ADMIN_ID, FIXTURE_ADMIN_EMAIL]);
  return FIXTURE_ADMIN_ID;
}

module.exports = { fixtureAdmin, FIXTURE_ADMIN_ID, FIXTURE_ADMIN_EMAIL };
