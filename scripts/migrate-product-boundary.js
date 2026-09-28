// ── PRODUCT BOUNDARY migration (additive, standalone, NOT wired into boot) ──
//
// Two tables and a wide backfill. NO BEHAVIOUR CHANGE: nothing reads user_products until the
// middleware ships, and the middleware starts in shadow mode.
//
// BACKFILL IS DELIBERATELY WIDE — every existing user gets every product.
//   • NOT derived from each role's current nav. Nav is presentation-only and computed from role,
//     so deriving from it would bake a presentation artifact into the security model — the exact
//     confusion this whole piece exists to fix.
//   • Backfilling wide is also what makes shadow mode readable: if every user holds every product,
//     the middleware is a strict no-op for everyone who exists today, so ANY would_block entry in
//     the shadow log is a real finding about the route map rather than a backfill artifact.
//
// product_shadow_log records EVERY evaluated request, not only would-blocks. Without the
// denominator the result is unreadable: "zero blocks" across 3 requests means nothing, across
// 40,000 it means the map is right.
//
// Standalone: nothing imports this, so it does NOT run on boot. Run manually:
//   node scripts/migrate-product-boundary.js
//   railway ssh 'node scripts/migrate-product-boundary.js'
//
// THE BACKFILL REFUSES TO RUN TWICE. A re-run cannot tell "revoked" from "never granted", so it
// would silently re-grant a product somebody deliberately took away. That guard is STRUCTURAL, not
// a comment somebody reads after the damage: if user_products already has rows, the script exits
// non-zero and does nothing unless passed --force. A one-time operation is enforced as one.
// The two CREATE TABLEs are still idempotent, so re-running to ensure schema is safe — it is only
// the grant loop that is gated.
//
// Manual rollback:
//   DROP TABLE IF EXISTS product_shadow_log;
//   DROP TABLE IF EXISTS user_products;

const { initDB, query } = require('../src/lib/db');
// Backfill set comes from the MAP, not a second hand-kept list: every real product plus the
// 'internal' pseudo-product. Adding a product to PRODUCTS is therefore enough.
const { GRANTABLE } = require('../src/lib/products/route-map');
const FORCE = process.argv.includes('--force');

async function migrateProductBoundary() {
  await initDB();

  // 1. Who holds which product. Rows, not an array on users: indexable, joinable, and one product
  // can be granted or revoked without a read-modify-write of somebody else's grants.
  await query(`
    CREATE TABLE IF NOT EXISTS user_products (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product    TEXT NOT NULL,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      granted_by TEXT,                       -- users.id of the grantor, or 'backfill'
      PRIMARY KEY (user_id, product)
    );
    CREATE INDEX IF NOT EXISTS idx_user_products_product ON user_products (product);
  `);
  await query(`
    COMMENT ON TABLE user_products IS 'Which products a user may reach. Enforced by the product-boundary middleware (PRODUCT_BOUNDARY_MODE). A user with no row for a product cannot reach that product''s routes once mode=enforce.';
  `);

  // 2. Shadow log. Every evaluated request, so the denominator exists.
  await query(`
    CREATE TABLE IF NOT EXISTS product_shadow_log (
      id                BIGSERIAL PRIMARY KEY,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_id           TEXT,
      role              TEXT,
      method            TEXT NOT NULL,
      path              TEXT NOT NULL,
      resolved_product  TEXT,                -- null = the map could not resolve one (fails closed later)
      user_products     TEXT[],              -- what the caller held at the time
      would_block       BOOLEAN NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_psl_created     ON product_shadow_log (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_psl_would_block ON product_shadow_log (would_block, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_psl_path        ON product_shadow_log (path);
  `);

  // 3. Wide backfill: every existing user × every grantable product — ONCE.
  const existing = (await query(`SELECT COUNT(*)::int n FROM user_products`)).rows[0].n;
  if (existing > 0 && !FORCE) {
    console.error(`\n⛔ REFUSING TO BACKFILL: user_products already has ${existing} row(s).`);
    console.error(`   A re-run cannot tell "revoked" from "never granted", so it would silently`);
    console.error(`   re-grant products somebody deliberately took away.`);
    console.error(`   The two tables above are created/verified — that part is idempotent and is done.`);
    console.error(`   If you genuinely want to re-grant every product to every user: --force\n`);
    process.exit(1);
  }
  if (existing > 0 && FORCE) {
    console.log(`⚠  --force: re-granting over ${existing} existing row(s). Any deliberate revocation will be undone.`);
  }
  const users = (await query(`SELECT id, email FROM users`)).rows;
  let granted = 0;
  for (const u of users) {
    for (const p of GRANTABLE) {
      const r = await query(
        `INSERT INTO user_products (user_id, product, granted_by) VALUES ($1,$2,'backfill')
         ON CONFLICT (user_id, product) DO NOTHING`, [u.id, p]);
      granted += r.rowCount || 0;
    }
  }

  const total = (await query(`SELECT COUNT(*)::int n FROM user_products`)).rows[0].n;
  const holders = (await query(
    `SELECT COUNT(DISTINCT user_id)::int users, COUNT(*)::int rows FROM user_products`)).rows[0];
  const shortfall = (await query(
    `SELECT u.email, COUNT(up.product)::int held FROM users u
       LEFT JOIN user_products up ON up.user_id = u.id
      GROUP BY u.email HAVING COUNT(up.product) <> $1 ORDER BY 2`, [GRANTABLE.length])).rows;

  console.log(`users: ${users.length} · grantable: ${GRANTABLE.length} (${GRANTABLE.join(', ')})`);
  console.log(`granted this run: ${granted} · user_products rows now: ${total} (expected ${users.length * GRANTABLE.length})`);
  console.log(`distinct holders: ${holders.users}`);
  if (shortfall.length) {
    console.log(`\n⚠ users NOT holding everything (shadow-mode noise will come from these):`);
    shortfall.forEach(r => console.log(`   ${r.email}: ${r.held}`));
  } else {
    console.log(`every user holds every product → the middleware is a strict no-op for everyone who exists today`);
  }
  console.log('\n✅ product boundary schema applied (user_products + product_shadow_log). NO behaviour change: nothing reads these yet.');
  process.exit(0);
}

migrateProductBoundary().catch(e => { console.error('product boundary migration error:', e.message); process.exit(1); });
