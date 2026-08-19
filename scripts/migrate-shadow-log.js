// ── permission_shadow_log migration (additive, standalone, NOT wired into boot) ──
// Backs P3 shadow mode (src/lib/permissions/shadow.js): the resolver's opinion is compared
// to the live gate on each request and only DISAGREEMENTS are recorded here. Observation
// only — this table never affects a response.
//
// Standalone on purpose: nothing imports it, so it does NOT run on boot. Run manually when
// ready, e.g.:
//   node scripts/migrate-shadow-log.js
// or in the Railway container (no psql):
//   railway ssh 'node scripts/migrate-shadow-log.js'
//
// Manual rollback:
//   DROP TABLE IF EXISTS permission_shadow_log;

const { initDB, query } = require('../src/lib/db');

async function migrateShadowLog() {
  await initDB(); // ensures base schema exists before we create alongside it

  await query(`
    CREATE TABLE IF NOT EXISTS permission_shadow_log (
      id                BIGSERIAL PRIMARY KEY,
      user_id           TEXT,
      role              TEXT,
      feature_key       TEXT,
      method            TEXT,
      path              TEXT,
      gate_decision     TEXT,          -- 'allow' | 'deny' (effective outcome of the live gate)
      resolver_decision TEXT,          -- 'allow' | 'deny' | 'unmapped_route' | 'error'
      resolver_rule     INTEGER,       -- which precedence rule fired (null when not resolved)
      resolver_explain  TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_psl_feature_created ON permission_shadow_log (feature_key, created_at);
  `);

  console.log('✅ Shadow schema applied (permission_shadow_log + idx_psl_feature_created)');
  process.exit(0);
}

migrateShadowLog().catch(e => { console.error('Shadow-log migration error:', e.message); process.exit(1); });
