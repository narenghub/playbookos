// ── permission_enforce_denials migration (additive, standalone, NOT wired into boot) ──
// Backs P3 enforcement instrumentation (src/lib/permissions/enforce.js): when the resolver
// ENFORCES a deny for a role listed in PERMISSIONS_ENFORCE_ROLES, the middleware returns 403
// and records the denial here. Observation only — the write is fire-and-forget and can never
// affect the 403 or the request. Unlike the shadow log (which only captures disagreements),
// this table captures every enforced 403, since enforcement masks the shadow signal.
//
// Standalone on purpose: nothing imports it, so it does NOT run on boot. Run manually when
// ready, e.g.:
//   node scripts/migrate-enforce-denials.js
// or in the Railway container (no psql):
//   railway ssh 'node scripts/migrate-enforce-denials.js'
//
// Manual rollback:
//   DROP TABLE IF EXISTS permission_enforce_denials;

const { initDB, query } = require('../src/lib/db');

async function migrateEnforceDenials() {
  await initDB(); // ensures base schema exists before we create alongside it

  await query(`
    CREATE TABLE IF NOT EXISTS permission_enforce_denials (
      id                BIGSERIAL PRIMARY KEY,
      user_id           TEXT,
      role              TEXT,
      feature_key       TEXT,
      method            TEXT,
      path              TEXT,
      resolver_rule     INTEGER,       -- which precedence rule denied (null when not resolved)
      resolver_explain  TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ped_created ON permission_enforce_denials (created_at);
    CREATE INDEX IF NOT EXISTS idx_ped_user_created ON permission_enforce_denials (user_id, created_at);
  `);

  console.log('✅ Enforce-denials schema applied (permission_enforce_denials + idx_ped_created + idx_ped_user_created)');
  process.exit(0);
}

migrateEnforceDenials().catch(e => { console.error('Enforce-denials migration error:', e.message); process.exit(1); });
