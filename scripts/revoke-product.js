#!/usr/bin/env node
// ── TAKE A PRODUCT OFF ONE ACCOUNT, BY NAME, WITH AN AUDIT TRAIL. ─────────────
//
//   railway ssh 'node scripts/revoke-product.js'                                  # dry run: who holds what they should not
//   railway ssh 'node scripts/revoke-product.js --email a@b.com --product internal --execute'
//
// WHY THIS EXISTS: repairing the ACBM Partners account printed its grants, and they read
// `internal, sitenex`. `internal` is the pseudo-product covering the user list, user and role
// administration, company targets, team performance — and PUT /api/users/:id/products, which
// decides what any account may reach.
//
// src/lib/products/route-map.js states the invariant in its own words: "a partner account is simply
// never granted it, so a tier mistake alone cannot expose any of this." That is defence in depth —
// those routes carry a role gate too, and this account's role is `partner`, so this is a REMOVED
// SAFETY LAYER rather than a proven exposure. It is still the one mistake in the grant system that
// does not announce itself, and src/api/invite-products.test.js has a test named "a partner never
// receives 'internal' — it is not implicit in anything". The invariant is tested on the invite path
// and was violated anyway, which means it arrived by another route: an explicit choice at invite
// time, or the admin products screen.
//
// ── RULES ────
//
// Revoking is safer than granting, but it is still a write to production against a live account, so
// it follows the same discipline as the repair beside it: --email and --product are both required,
// one row is deleted by the pair, the deletion is audited, and the dry run names every account
// holding something its role says it should not.
'use strict';

const { query } = require('../src/lib/db');
const { isExternalRole } = require('../src/lib/roles');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
};

const EMAIL = (arg('email') || '').trim().toLowerCase();
const PRODUCT = (arg('product') || '').trim();
const EXECUTE = process.argv.includes('--execute');

// Products an OUTSIDE account must never hold. `internal` is the whole reason this list exists.
const NEVER_EXTERNAL = ['internal'];

async function main() {
  const rows = (await query(
    `SELECT u.id, u.email, u.role, u.partner_id, p.product
       FROM users u JOIN user_products p ON p.user_id = u.id
      ORDER BY u.email, p.product`)).rows;

  if (!EMAIL || !PRODUCT) {
    console.log('── revoke product · DRY RUN (no --email / --product given)\n');
    const suspect = rows.filter((r) => isExternalRole(r.role) && NEVER_EXTERNAL.includes(r.product));
    if (suspect.length) {
      console.log(`⚠ ${suspect.length} grant(s) an OUTSIDE account must not hold:\n`);
      for (const r of suspect) {
        console.log(`   ${r.email.padEnd(34)} role=${r.role.padEnd(10)} holds "${r.product}"`);
        console.log(`      → node scripts/revoke-product.js --email ${r.email} --product ${r.product} --execute`);
      }
    } else {
      console.log('✅ no external account holds a product reserved for internal use.');
    }

    const byUser = new Map();
    for (const r of rows) {
      if (!byUser.has(r.email)) byUser.set(r.email, { role: r.role, partner_id: r.partner_id, products: [] });
      byUser.get(r.email).products.push(r.product);
    }
    console.log('\nall accounts and their grants:');
    for (const [email, u] of byUser) {
      const ext = isExternalRole(u.role) ? '  [EXTERNAL]' : '';
      console.log(`  ${email.padEnd(34)} ${u.role.padEnd(16)} ${u.products.join(', ')}${ext}`);
    }
    return;
  }

  const u = (await query('SELECT * FROM users WHERE LOWER(email) = $1', [EMAIL])).rows[0];
  if (!u) throw new Error(`No account with email ${EMAIL}`);
  const held = rows.filter((r) => r.id === u.id).map((r) => r.product);
  if (!held.includes(PRODUCT)) {
    console.log(`── ${EMAIL} does not hold "${PRODUCT}" (holds: ${held.join(', ') || 'nothing'}). Nothing to do.`);
    return;
  }

  const remaining = held.filter((p) => p !== PRODUCT);
  console.log('── revoke product\n');
  console.log(`  account    ${u.email}  (${u.role}${isExternalRole(u.role) ? ', EXTERNAL' : ''})`);
  console.log(`  revoking   ${PRODUCT}`);
  console.log(`  remaining  ${remaining.join(', ') || 'NONE'}`);
  if (!remaining.length) {
    console.log('  ⚠ this leaves the account with NO products, so it will log in and see an empty shell.');
    console.log('    That may be correct, but decide it rather than discover it.');
  }
  if (isExternalRole(u.role) && NEVER_EXTERNAL.includes(PRODUCT)) {
    console.log(`  ↳ "${PRODUCT}" is reserved for internal accounts — removing it restores the documented invariant.`);
  }

  if (!EXECUTE) { console.log('\n  DRY RUN — nothing written. Add --execute.'); return; }

  // One row, by the (user, product) pair. Never by role, domain or pattern.
  const del = await query(
    `DELETE FROM user_products WHERE user_id = $1 AND product = $2`, [u.id, PRODUCT]);
  if (del.rowCount !== 1) throw new Error(`expected to delete exactly 1 row, deleted ${del.rowCount}`);

  // Audited the same way every grant is, so the history of an account's access is in one table and
  // a revocation is not the one event missing from it.
  await query(
    `INSERT INTO user_product_grants_log (user_id, user_email, product, action, actor_id, source)
     VALUES ($1,$2,$3,'revoke',$4,'revoke_product_script')`,
    [u.id, u.email, PRODUCT, null]);

  const after = (await query(
    `SELECT product FROM user_products WHERE user_id = $1 ORDER BY product`, [u.id])).rows.map((r) => r.product);
  console.log(`\n  ✅ revoked. ${u.email} now holds: ${after.join(', ') || 'NOTHING'}`);
  if (after.includes(PRODUCT)) throw new Error('the product is still held — investigate');
}

main().then(() => process.exit(0))
      .catch((e) => { console.error('revoke error:', e.message); process.exit(1); });
