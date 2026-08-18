// ── Permission schema migration (additive, standalone, NOT wired into boot) ────
// Creates the tables that back the code-defined permission registry
// (src/lib/permissions/registry.js). Tables only — no data backfill, no role
// templates seeded (templates are derived from observed behaviour in a later step).
//
// This is a STANDALONE script on purpose: nothing in the app imports it, so it does
// NOT run on server boot. Run it manually when ready, e.g.:
//   node scripts/migrate-permissions.js
// or in the Railway container:
//   railway ssh 'node scripts/migrate-permissions.js'
//
// Touches existing schema in exactly one additive way: adds users.permissions_version
// (the cache-invalidation counter middleware bumps on any permission change).
//
// NOTE ON ID TYPES: users.id is TEXT in this repo (see src/lib/db.js). The spec asked
// for `integer references users(id)`, but an INTEGER FK against a TEXT primary key is
// rejected by Postgres, so every user-id column below is TEXT to keep the FKs +
// ON DELETE CASCADE working. permission_audit_log.actor_user_id / target_user_id have
// no FK (per spec) but are TEXT so they can actually store a users.id value.
//
// Manual rollback:
//   ALTER TABLE users DROP COLUMN IF EXISTS permissions_version;
//   DROP TABLE IF EXISTS permission_audit_log;
//   DROP TABLE IF EXISTS user_spend_limits;
//   DROP TABLE IF EXISTS user_feature_overrides;
//   DROP TABLE IF EXISTS role_template_grants;
//   DROP TABLE IF EXISTS role_templates;

const { initDB, query } = require('../src/lib/db');

async function migratePermissions() {
  await initDB(); // ensures base schema (incl. users) exists before we FK to it

  await query(`
    -- 1. Role templates: named permission bundles (super_admin, sales_team, …).
    --    Derived later from observed behaviour; NOT seeded here.
    CREATE TABLE IF NOT EXISTS role_templates (
      role_key   TEXT PRIMARY KEY,
      label      TEXT,
      description TEXT,
      is_system  BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- 2. Which registry feature_keys a template grants. feature_key is deliberately
    --    NOT a foreign key — the registry lives in code, not the DB.
    CREATE TABLE IF NOT EXISTS role_template_grants (
      role_key    TEXT NOT NULL REFERENCES role_templates(role_key),
      feature_key TEXT NOT NULL,
      PRIMARY KEY (role_key, feature_key)
    );

    -- 3. Per-user allow/deny overrides on top of the template.
    CREATE TABLE IF NOT EXISTS user_feature_overrides (
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      feature_key TEXT NOT NULL,
      effect      TEXT NOT NULL CHECK (effect IN ('allow','deny')),
      reason      TEXT,
      granted_by  TEXT REFERENCES users(id),
      granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ,
      PRIMARY KEY (user_id, feature_key)
    );
    CREATE INDEX IF NOT EXISTS idx_ufo_user ON user_feature_overrides (user_id);

    -- 4. Per-user spend caps by spend_kind (llm/apollo/email/image) and period.
    CREATE TABLE IF NOT EXISTS user_spend_limits (
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      spend_kind  TEXT NOT NULL,
      period      TEXT NOT NULL CHECK (period IN ('day','week','month')),
      limit_value NUMERIC NOT NULL,
      PRIMARY KEY (user_id, spend_kind, period)
    );

    -- 5. Append-only audit trail of every permission change.
    CREATE TABLE IF NOT EXISTS permission_audit_log (
      id             BIGSERIAL PRIMARY KEY,
      actor_user_id  TEXT,            -- no FK (spec); TEXT to hold a users.id value
      target_user_id TEXT,
      action         TEXT NOT NULL,
      feature_key    TEXT,
      before         JSONB,
      after          JSONB,
      reason         TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pal_target  ON permission_audit_log (target_user_id);
    CREATE INDEX IF NOT EXISTS idx_pal_created ON permission_audit_log (created_at);

    -- Cache-invalidation counter: any permission change bumps this; middleware
    -- recomputes a user's effective permissions when its cached value is stale.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions_version INTEGER NOT NULL DEFAULT 0;
  `);

  console.log('✅ Permission schema applied (role_templates, role_template_grants, user_feature_overrides, user_spend_limits, permission_audit_log, users.permissions_version)');
  process.exit(0);
}

migratePermissions().catch(e => { console.error('Permission migration error:', e.message); process.exit(1); });
