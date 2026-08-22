// ── content_queue migration (additive, standalone, NOT wired into boot) ──
// Backs the multi-product content pipeline (src/lib/agents/content/). A generated draft per
// source item, product-scoped (golfnex, abiozen, future products), with a review lifecycle.
//
// Deliberately NOT LinkedIn-shaped: no post ids, no image URNs, no molecule columns. The
// existing linkedin_content_queue table is left completely untouched.
//
// Standalone on purpose: nothing imports it, so it does NOT run on boot. Run manually when
// ready, e.g.:
//   node scripts/migrate-content-queue.js
// or in the Railway container (no psql):
//   railway ssh 'node scripts/migrate-content-queue.js'
//
// Manual rollback:
//   DROP TABLE IF EXISTS content_queue;

const { initDB, query } = require('../src/lib/db');

async function migrateContentQueue() {
  await initDB(); // ensures base schema exists before we create alongside it

  await query(`
    CREATE TABLE IF NOT EXISTS content_queue (
      id           BIGSERIAL PRIMARY KEY,
      product      TEXT NOT NULL,                       -- 'golfnex', 'abiozen', future products
      source_ref   TEXT,                                -- what it was generated from (e.g. article URL)
      topic        TEXT,                                -- classifier category
      segment      TEXT,                                -- who it is for
      headline     TEXT NOT NULL,
      body         TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'draft',       -- draft | approved | rejected | published
      reviewed_by  TEXT,
      reviewed_at  TIMESTAMPTZ,
      edited       BOOLEAN NOT NULL DEFAULT FALSE,
      cost_usd     NUMERIC(10,4),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (product, source_ref)                      -- dedup: one draft per source item
    );
    CREATE INDEX IF NOT EXISTS idx_cq_product_status_created ON content_queue (product, status, created_at);
  `);

  console.log('✅ content_queue schema applied (content_queue + idx_cq_product_status_created)');
  process.exit(0);
}

migrateContentQueue().catch(e => { console.error('content_queue migration error:', e.message); process.exit(1); });
