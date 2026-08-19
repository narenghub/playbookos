// ── Multi-product event ingestion migration (E0, additive, standalone, NOT wired) ──
// Backs POST /api/events/ingest (src/lib/events/ingest.js). Two tables:
//   event_sources   — per-product bearer credentials (hashed) + optional allow-list
//   ingested_events — the single jsonb-payload event sink, idempotent per (product, key)
//
// Standalone on purpose: nothing imports it, so it does NOT run on boot. Run manually:
//   node scripts/migrate-events.js
// or in the Railway container:
//   railway ssh 'node scripts/migrate-events.js'
//
// Touches no existing table and no existing route. Manual rollback:
//   DROP TABLE IF EXISTS ingested_events;
//   DROP TABLE IF EXISTS event_sources;

const { initDB, query } = require('../src/lib/db');

async function migrateEvents() {
  await initDB();

  await query(`
    -- Per-product ingestion credentials. Adding a product = INSERT a row (see
    -- scripts/seed-golfnex-source.js) — no code change. Secrets are stored hashed;
    -- secret_hash_next holds a second active hash during rotation.
    CREATE TABLE IF NOT EXISTS event_sources (
      product          TEXT PRIMARY KEY,
      secret_hash      TEXT NOT NULL UNIQUE,
      secret_hash_next TEXT,
      is_active        BOOLEAN NOT NULL DEFAULT TRUE,
      allowed_events   TEXT[],
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      rotated_at       TIMESTAMPTZ
    );

    -- The single multi-product event sink. One jsonb payload; envelope columns typed.
    -- UNIQUE(product, idempotency_key) IS the idempotency guarantee (not app logic).
    CREATE TABLE IF NOT EXISTS ingested_events (
      id                BIGSERIAL PRIMARY KEY,
      product           TEXT NOT NULL,
      event             TEXT NOT NULL,
      occurred_at       TIMESTAMPTZ NOT NULL,
      received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      idempotency_key   TEXT NOT NULL,
      payload           JSONB NOT NULL,
      payload_hash      TEXT NOT NULL,          -- sha256(payload) — replay vs key-reuse
      status            TEXT NOT NULL DEFAULT 'valid',   -- valid | quarantined
      quarantine_reason TEXT,
      UNIQUE (product, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_ie_product_event_time ON ingested_events (product, event, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_ie_status ON ingested_events (status);
  `);

  console.log('✅ Event ingestion schema applied (event_sources, ingested_events + indexes)');
  process.exit(0);
}

migrateEvents().catch(e => { console.error('Event-ingestion migration error:', e.message); process.exit(1); });
