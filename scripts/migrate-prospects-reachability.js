// ── prospects reachability migration (additive, standalone, NOT wired into boot) ──
// Adds the two columns that let the Prospects page tell a REACHED-but-no-booking-platform
// facility (a true prime target — visit the site) apart from one that was QUALIFIED but never
// actually reachable (dead/403/timeout — needs a phone call, and must NOT sort into the top of
// the prime pool by review count).
//
//   reachable          BOOLEAN   -- null = not yet qualified; true = homepage fetched; false = unreachable
//   unreachable_reason TEXT      -- 403 | dns | timeout | http_error | empty  (null unless reachable=false)
//
// The qualifier already knew this (qualifyFacility distinguishes them internally) but discarded
// it: it wrote only booking_platform (null for BOTH cases). See src/lib/agents/prospecting/.
//
// Standalone on purpose: nothing imports it, so it does NOT run on boot. Run manually:
//   node scripts/migrate-prospects-reachability.js
//   railway ssh 'node scripts/migrate-prospects-reachability.js'
//
// Manual rollback:
//   ALTER TABLE prospects DROP COLUMN IF EXISTS reachable, DROP COLUMN IF EXISTS unreachable_reason;

const { initDB, query } = require('../src/lib/db');

async function migrateProspectsReachability() {
  await initDB(); // ensures base schema exists before we alter alongside it

  await query(`
    ALTER TABLE prospects ADD COLUMN IF NOT EXISTS reachable          BOOLEAN;
    ALTER TABLE prospects ADD COLUMN IF NOT EXISTS unreachable_reason TEXT;
    -- The true prime pool: qualified, no booking platform, and actually reachable. A partial
    -- index keeps the page's default filter fast without bloating writes on the other rows.
    CREATE INDEX IF NOT EXISTS idx_prospects_prime
      ON prospects (product, rating_count DESC)
      WHERE status = 'qualified' AND booking_platform IS NULL AND reachable = true;
  `);

  console.log('✅ prospects reachability schema applied (reachable + unreachable_reason + idx_prospects_prime)');
  process.exit(0);
}

migrateProspectsReachability().catch(e => { console.error('prospects reachability migration error:', e.message); process.exit(1); });
