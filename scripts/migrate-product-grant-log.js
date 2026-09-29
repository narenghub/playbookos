// ── Migration: an append-only audit log for product grants ────────────────────
//
// user_products records the CURRENT state: granted_at and granted_by for a row that exists. It cannot
// record a REVOKE, because a revoke deletes the row and takes its own history with it. "Manohar lost
// abiozen at some point, nobody knows when or who did it" is exactly the question you have on the day
// it matters.
//
// WHY A SEPARATE TABLE AND NOT A revoked_at COLUMN. A soft-delete would mean every reader of
// user_products must remember `WHERE revoked_at IS NULL`, and forgetting it GRANTS access — the
// product boundary would read a revoked row as a live grant. That is a fail-open design. Keeping
// user_products as "the row exists or it does not" keeps the boundary's query trivially correct, and
// the history lives somewhere that cannot be forgotten into a security hole.
//
// No foreign key to users, deliberately: deleting a user must not delete the record of what they were
// granted. user_email is denormalised for the same reason — the log has to stay readable after the row
// it refers to is gone.
//
// Run:  railway ssh 'node scripts/migrate-product-grant-log.js'

const { query } = require('../src/lib/db');

(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS user_product_grants_log (
        id          BIGSERIAL PRIMARY KEY,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        user_id     TEXT NOT NULL,
        user_email  TEXT,                  -- denormalised: readable after the user row is deleted
        product     TEXT NOT NULL,
        action      TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
        actor_id    TEXT,                  -- the super_admin who did it; NULL for the backfill
        actor_email TEXT,
        source      TEXT NOT NULL          -- 'backfill' | 'invite_accept' | 'admin_edit' | 'user_deleted'
      );
      CREATE INDEX IF NOT EXISTS idx_upgl_user    ON user_product_grants_log (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_upgl_created ON user_product_grants_log (created_at DESC);
    `);
    console.log('✅ user_product_grants_log created/verified');

    // Seed the existing grants. A log that starts today would make the 119 rows already in
    // user_products look unexplained — worse than no log, because it reads as "granted by nobody".
    // created_at is taken from granted_at so the timeline is real rather than all-today. Idempotent: it
    // refuses to seed twice.
    const already = (await query(`SELECT COUNT(*)::int n FROM user_product_grants_log WHERE source = 'backfill'`)).rows[0].n;
    if (already > 0) {
      console.log(`↷ backfill already seeded (${already} rows) — skipping`);
    } else {
      const r = await query(`
        INSERT INTO user_product_grants_log (created_at, user_id, user_email, product, action, actor_id, actor_email, source)
        SELECT p.granted_at, p.user_id, u.email, p.product, 'grant',
               NULLIF(p.granted_by, 'backfill'), NULL, 'backfill'
          FROM user_products p LEFT JOIN users u ON u.id = p.user_id`);
      console.log(`✅ seeded ${r.rowCount} existing grant(s) as source='backfill'`);
    }

    const tot = (await query(`SELECT action, source, COUNT(*)::int n FROM user_product_grants_log GROUP BY 1,2 ORDER BY 3 DESC`)).rows;
    tot.forEach(t => console.log(`   ${t.action.padEnd(7)} ${t.source.padEnd(14)} ${t.n}`));
    process.exit(0);
  } catch (e) { console.error('❌', e.message); process.exit(1); }
})();
