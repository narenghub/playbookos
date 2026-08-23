// ── tool_call_audit migration (additive, standalone, NOT wired into boot) ──
// Backs the tool-call gate (src/lib/agents/gate.js): one row per gated agent/tool call —
// the authorisation decision (allow|deny + rule + explain), execution success/failure, cost,
// tokens, latency, and the args/result payloads. This is the tool-call audit sink that no
// existing table provided (agent_activity_log is agent-run granularity with no product,
// tool, cost, latency, or decision columns).
//
// product is NOT NULL and tenant_id is present-but-null ON PURPOSE: the diagnostic warned
// that agent_activity_log has no product column and retrofitting tenancy later means
// migrating every governance table. Carry both from day one.
//
// Standalone on purpose: nothing imports it, so it does NOT run on boot. Run manually:
//   node scripts/migrate-tool-audit.js
//   railway ssh 'node scripts/migrate-tool-audit.js'
//
// Manual rollback:
//   DROP TABLE IF EXISTS tool_call_audit;

const { initDB, query } = require('../src/lib/db');

async function migrateToolAudit() {
  await initDB(); // ensures base schema exists before we create alongside it

  await query(`
    CREATE TABLE IF NOT EXISTS tool_call_audit (
      id               BIGSERIAL PRIMARY KEY,
      actor_user_id    TEXT,
      actor_agent      TEXT,
      product          TEXT NOT NULL,                 -- REQUIRED; tenancy retrofit is the thing to avoid
      tenant_id        TEXT,                          -- null today, present from day one
      tool_name        TEXT NOT NULL,
      feature_key      TEXT,
      args             JSONB,
      result           JSONB,
      success          BOOLEAN NOT NULL,
      error            TEXT,
      decision         TEXT NOT NULL CHECK (decision IN ('allow','deny')),
      decision_rule    INTEGER,
      decision_explain TEXT,
      cost_usd         NUMERIC(10,4),
      tokens_input     INTEGER,
      tokens_output    INTEGER,
      latency_ms       INTEGER,
      idempotency_key  TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- dedup replayed calls, but only when an idempotency key is supplied (partial unique)
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tca_product_idem
      ON tool_call_audit (product, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tca_product_created ON tool_call_audit (product, created_at);
    CREATE INDEX IF NOT EXISTS idx_tca_actor_created   ON tool_call_audit (actor_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tca_tool_created    ON tool_call_audit (tool_name, created_at);
  `);

  console.log('✅ tool_call_audit schema applied (table + idx_tca_product_idem partial-unique + 3 indexes)');
  process.exit(0);
}

migrateToolAudit().catch(e => { console.error('tool-audit migration error:', e.message); process.exit(1); });
