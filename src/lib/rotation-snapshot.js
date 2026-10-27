// ── WHERE A PRE-ROTATION FINGERPRINT SET IS KEPT ─────────────────────────────
//
// The first design put it in /tmp/fp.json on the Railway container. That could not work, and the
// reason is worth keeping written down: rotated environment variables only take effect after a
// redeploy, and a redeploy replaces the container. The file was therefore guaranteed to be deleted
// between being written and being read — and the failure would surface as "no snapshot to compare
// against" at the one moment when the before-state no longer existed anywhere.
//
// Postgres survives the redeploy, and it stays reachable after the database password rotates
// because it is the same database with a new credential.
//
// `query` is injected rather than imported so this is testable against a throwaway cluster:
// src/lib/db.js forces TLS, which a local `initdb -A trust` server will refuse. Injection also
// means the check script exercises THIS code rather than its own copy of the SQL — the
// route-outreach lesson, where a second copy of a filter queued five internal records for cold
// outreach because it had drifted from the original.
'use strict';

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS rotation_snapshots (
  label        TEXT PRIMARY KEY,
  taken_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  taken_commit TEXT,
  salt         TEXT NOT NULL,
  fingerprints JSONB NOT NULL
)`;

async function ensureTable(query) {
  await query(TABLE_SQL);
  // Added after the first live run, where --health passed and reported "all healthy after rotation"
  // while every credential was still the leaked one. A row that records WHEN the comparison passed
  // is what lets --health refuse to answer before the rotation has actually been proven.
  await query('ALTER TABLE rotation_snapshots ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ');
  await query('ALTER TABLE rotation_snapshots ADD COLUMN IF NOT EXISTS verified_commit TEXT');
}

// Refuses to overwrite unless forced. Taking a second snapshot AFTER rotating would replace the
// before-state with the after-state, and the comparison would then report every credential
// unchanged — which reads either as "the rotation failed" or, if someone inverts it, as a pass on a
// rotation that never happened. Neither is recoverable, because the original values are gone.
async function save(query, { label, commit, snap, force = false }) {
  await ensureTable(query);
  const existing = await query('SELECT taken_at, verified_at FROM rotation_snapshots WHERE label = $1', [label]);
  if (existing.rows.length && !force) {
    return {
      saved: false,
      refused: true,
      takenAt: existing.rows[0].taken_at,
      verifiedAt: existing.rows[0].verified_at || null,
    };
  }
  await query(
    `INSERT INTO rotation_snapshots (label, taken_at, taken_commit, salt, fingerprints)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (label) DO UPDATE
       SET taken_at = $2, taken_commit = $3, salt = $4, fingerprints = $5`,
    [label, snap.takenAt, commit || null, snap.salt, JSON.stringify(snap.fingerprints)],
  );
  return { saved: true, count: Object.keys(snap.fingerprints).length };
}

async function load(query, label) {
  await ensureTable(query);
  const r = await query('SELECT * FROM rotation_snapshots WHERE label = $1', [label]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const iso = (v) => (v instanceof Date ? v.toISOString() : (v ? String(v) : null));
  return {
    takenAt: iso(row.taken_at),
    commit: row.taken_commit || null,
    verifiedAt: iso(row.verified_at),
    verifiedCommit: row.verified_commit || null,
    salt: row.salt,
    // node-postgres returns jsonb already parsed; a pg version or a driver swap that returns text
    // would otherwise make every fingerprint lookup silently undefined, which reads as "newly set"
    // for every credential and passes the run.
    fingerprints: typeof row.fingerprints === 'string' ? JSON.parse(row.fingerprints) : row.fingerprints,
  };
}

async function remove(query, label) {
  const r = await query('DELETE FROM rotation_snapshots WHERE label = $1', [label]);
  return r.rowCount;
}

// Marks the comparison as passed WITHOUT deleting the row, and blanks the digests in the same
// statement so nothing derived from a secret stays stored. The row is then evidence that the
// rotation was proven and when, which is what --health consults before it is willing to describe
// production as healthy "after rotation" — the claim it made once while nothing had rotated.
async function markVerified(query, label, commit) {
  const r = await query(
    `UPDATE rotation_snapshots
        SET verified_at = NOW(), verified_commit = $2, salt = '', fingerprints = '{}'::jsonb
      WHERE label = $1
      RETURNING verified_at`,
    [label, commit || null],
  );
  return r.rows.length ? r.rows[0].verified_at : null;
}

module.exports = { TABLE_SQL, ensureTable, save, load, remove, markVerified };
