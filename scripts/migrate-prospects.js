// ── prospects migration (additive, standalone, NOT wired into boot) ──
// Backs the GolfNex prospecting enumerator (src/lib/agents/prospecting/). One row per
// distinct facility discovered via Google Places, deduped by place_id, product-scoped.
//
// product is NOT NULL from day one (same tenancy reasoning as everywhere else). booking_
// platform / qualified_at stay null until the (later) booking-signature qualifier runs.
//
// Standalone on purpose: nothing imports it, so it does NOT run on boot. Run manually:
//   node scripts/migrate-prospects.js
//   railway ssh 'node scripts/migrate-prospects.js'
//
// Manual rollback:
//   DROP TABLE IF EXISTS prospects;

const { initDB, query } = require('../src/lib/db');

async function migrateProspects() {
  await initDB(); // ensures base schema exists before we create alongside it

  await query(`
    CREATE TABLE IF NOT EXISTS prospects (
      id               BIGSERIAL PRIMARY KEY,
      product          TEXT NOT NULL,                 -- 'golfnex'
      place_id         TEXT NOT NULL,                 -- Google Places id, the dedup key
      name             TEXT NOT NULL,
      address          TEXT,
      phone            TEXT,
      website          TEXT,
      types            TEXT[],
      rating           NUMERIC(2,1),
      rating_count     INTEGER,
      subtype          TEXT,                          -- which query found it: course | range | simulator
      region           TEXT,                          -- which tile found it (NOT authoritative geography)
      state            TEXT,                          -- 2-letter state derived from address (authoritative)
      booking_platform TEXT,                          -- null until qualified
      qualified_at     TIMESTAMPTZ,
      reject_reason    TEXT,                          -- why status='rejected' (e.g. non-IL address)
      notes            TEXT,                          -- free-text notes from the Prospects page
      status           TEXT NOT NULL DEFAULT 'new',   -- new | qualified | enriched | contacted | rejected
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (product, place_id)
    );
    -- notes was added after the table shipped; ensure it exists on already-created tables.
    ALTER TABLE prospects ADD COLUMN IF NOT EXISTS notes TEXT;
    CREATE INDEX IF NOT EXISTS idx_prospects_product_status   ON prospects (product, status);
    CREATE INDEX IF NOT EXISTS idx_prospects_product_platform ON prospects (product, booking_platform);
  `);

  console.log('✅ prospects schema applied (prospects + idx_prospects_product_status + idx_prospects_product_platform)');
  process.exit(0);
}

migrateProspects().catch(e => { console.error('prospects migration error:', e.message); process.exit(1); });
