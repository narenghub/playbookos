// ── Migration: pending product grants on an invite ────────────────────────────
//
// Products are chosen when the invite is SENT but written to `user_products` when it is ACCEPTED.
// That is deliberate. An invite that is never accepted, or is sent to the wrong address and revoked,
// must leave no grant behind: a row in user_products is the thing the boundary reads, and it should
// exist only for an account somebody actually holds. So the choice is parked here first.
//
//   users.invited_products TEXT[]   the products chosen at invite time; consumed and cleared on accept
//   users.invited_by       TEXT     the super_admin who chose them, carried into user_products.granted_by
//
// Nullable with no default, so an existing row and a legacy invite are indistinguishable from
// "nothing chosen", which correctly grants nothing. Idempotent — safe to re-run.
//
// Run:  railway ssh 'node scripts/migrate-invite-products.js'

const { query } = require('../src/lib/db');

(async () => {
  try {
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_products TEXT[]`);
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by TEXT`);
    const cols = (await query(`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'users' AND column_name IN ('invited_products','invited_by')
       ORDER BY column_name`)).rows;
    if (cols.length !== 2) throw new Error(`expected 2 columns after ALTER, found ${cols.length}`);
    cols.forEach(c => console.log(`✅ users.${c.column_name} — ${c.data_type}, nullable=${c.is_nullable}`));

    // Anyone mid-invite right now predates product selection: they will be granted nothing on accept,
    // which is the safe direction, but it is worth knowing who so they can be topped up by hand.
    const pending = (await query(`
      SELECT email, role, invited_at FROM users
       WHERE invite_token IS NOT NULL AND joined_at IS NULL ORDER BY invited_at`)).rows;
    if (!pending.length) console.log('no invites outstanding — nothing predates product selection');
    else {
      console.log(`\n⚠ ${pending.length} outstanding invite(s) with no products chosen (they will accept holding nothing):`);
      pending.forEach(p => console.log(`   ${p.email} (${p.role}) invited ${p.invited_at}`));
    }
    process.exit(0);
  } catch (e) { console.error('❌', e.message); process.exit(1); }
})();
