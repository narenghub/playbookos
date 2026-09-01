// ── notifications migration (additive, standalone, NOT wired into boot) ──
// The feed behind the pnav top-bar bell — the reason to open the console daily. One row per
// event worth surfacing: a draft awaiting approval, an agent run that errored, a cost fuse hit,
// an expired connection, a completed run. Written fire-and-forget by src/lib/notify.js so a
// failed insert can never affect the thing that triggered it.
//
//   product      null for platform-level events (e.g. the RI cost fuse); else the product key.
//   kind         approval_pending | agent_failed | budget | connection_expired | run_complete
//   severity     info | warning | error
//   link_page    which SPA page the notification opens (e.g. content-studio, prospects).
//
// Standalone on purpose: nothing imports it, so it does NOT run on boot. Run manually:
//   node scripts/migrate-notifications.js
//   railway ssh 'node scripts/migrate-notifications.js'
//
// Manual rollback:
//   DROP TABLE IF EXISTS notifications;

const { initDB, query } = require('../src/lib/db');

async function migrateNotifications() {
  await initDB(); // ensures base schema exists before we create alongside it

  await query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id          BIGSERIAL PRIMARY KEY,
      product     TEXT,                          -- null for platform-level
      kind        TEXT NOT NULL,                 -- approval_pending | agent_failed | budget | connection_expired | run_complete
      severity    TEXT NOT NULL,                 -- info | warning | error
      title       TEXT NOT NULL,
      body        TEXT,
      link_page   TEXT,                          -- which SPA page to open
      read_at     TIMESTAMPTZ,                   -- null = unread
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_read_created ON notifications (read_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_product_created ON notifications (product, created_at DESC);
  `);

  console.log('✅ notifications schema applied (notifications + idx_notifications_read_created + idx_notifications_product_created)');
  process.exit(0);
}

migrateNotifications().catch(e => { console.error('notifications migration error:', e.message); process.exit(1); });
