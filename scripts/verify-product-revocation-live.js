// ── A REVOKE IS LIVE ON THE NEXT REQUEST — proved, not asserted (self-cleaning) ──
//
// Guard 2 is the one claim here that a unit test cannot really settle: "changes apply immediately, not
// at next login". A test can show the JWT has no products in it; only a live request can show that the
// SAME token stops working the moment the grant is removed.
//
// So: create a temporary user, mint ONE token for it, confirm a product route works, revoke the product
// through the real admin route, and re-use THE SAME TOKEN. If the 403 appears without a new login, the
// boundary is reading the table and not the token.
//
// Run:  railway ssh 'node scripts/verify-product-revocation-live.js'

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('../src/lib/db');

const TAG = 'verify-revocation-' + Date.now();
const EMAIL = `${TAG}@example.invalid`;
const PORT = process.env.PORT || 3000;
let id = null, superUser = null, fail = 0;

const check = (label, a, e) => { const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) fail++; console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : `  → expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`}`); };

const hit = async (method, path, token, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = JSON.parse(await r.text()); } catch (_) {}
  return { status: r.status, body: j };
};

(async () => {
  try {
    superUser = (await query(`SELECT id, email, role FROM users WHERE role='super_admin' AND is_active=1 LIMIT 1`)).rows[0];
    const adminToken = jwt.sign({ id: superUser.id, email: superUser.email, role: superUser.role }, process.env.JWT_SECRET, { expiresIn: '5m' });

    id = crypto.randomUUID();
    await query(`INSERT INTO users (id,email,name,role,is_active,joined_at,permissions_version)
                 VALUES ($1,$2,'Revocation Fixture','partner',1,NOW(),1)`, [id, EMAIL]);
    // ONE token, minted once, re-used throughout. This is the whole point of the exercise.
    const userToken = jwt.sign({ id, email: EMAIL, role: 'partner' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    console.log(`fixture: ${EMAIL}\n  one token minted, never refreshed\n`);

    console.log('grant sitenex through the admin route:');
    const g = await hit('PUT', `/api/users/${id}/products`, adminToken, { products: ['sitenex'] });
    check('PUT returns 200', g.status, 200);
    check('and reports what changed', g.body.added, ['sitenex']);
    console.log(`     summary: ${g.body.summary}`);
    check('and says it is immediate', /immediately/.test(g.body.takes_effect || ''), true);

    console.log('\nthe SAME token, before and after a revoke:');
    const before = await hit('GET', '/api/sitenex/deals', userToken);
    check('GET /api/sitenex/deals works while sitenex is held', before.status, 200);

    const rev = await hit('PUT', `/api/users/${id}/products`, adminToken, { products: [] });
    check('revoke returns 200', rev.status, 200);
    check('and names what was lost', rev.body.removed, ['sitenex']);
    console.log(`     summary: ${rev.body.summary}`);

    const after = await hit('GET', '/api/sitenex/deals', userToken);
    check('the SAME token is now refused — no new login, no token expiry', after.status, 403);
    console.log(`     refused by: ${after.body.error} (${after.body.reason || after.body.code || ''})`);

    console.log('\nthe audit trail:');
    const log = (await query(
      `SELECT product, action, source, actor_email FROM user_product_grants_log WHERE user_id=$1 ORDER BY id`, [id])).rows;
    check('two entries — the grant and the revoke', log.map(l => `${l.action} ${l.product}`), ['grant sitenex', 'revoke sitenex']);
    check('both attributed to the super admin', [...new Set(log.map(l => l.actor_email))], [superUser.email]);
    check("both marked source='admin_edit'", [...new Set(log.map(l => l.source))], ['admin_edit']);
    check('and the revoke survives although the user_products row is gone',
      (await query(`SELECT COUNT(*)::int n FROM user_products WHERE user_id=$1`, [id])).rows[0].n, 0);

    console.log('\nguard 1, live:');
    const selfNarrow = await hit('PUT', `/api/users/${superUser.id}/products`, adminToken, { products: ['abiozen'] });
    check('a super admin cannot narrow themselves', selfNarrow.status, 403);
    check('with the reason named', selfNarrow.body.code, 'self_narrow');
    const supers = (await query(`SELECT COUNT(*)::int n FROM users WHERE role='super_admin' AND is_active=1`)).rows[0].n;
    console.log(`     (${supers} active super admin${supers === 1 ? ' — so the last-super-admin guard also applies to this account' : 's'})`);
    check('and their products are untouched',
      (await query(`SELECT COUNT(*)::int n FROM user_products WHERE user_id=$1`, [superUser.id])).rows[0].n, 7);
  } catch (e) { fail++; console.error('ERROR:', e.message); }
  finally {
    if (id) {
      await query(`DELETE FROM product_shadow_log WHERE user_id=$1`, [id]).catch(() => {});
      await query(`DELETE FROM user_product_grants_log WHERE user_id=$1`, [id]).catch(() => {});
      await query(`DELETE FROM user_products WHERE user_id=$1`, [id]).catch(() => {});
      await query(`DELETE FROM users WHERE id=$1 AND email LIKE 'verify-revocation-%'`, [id]).catch(() => {});
    }
    const leaked = (await query(`SELECT COUNT(*)::int n FROM users WHERE email LIKE 'verify-revocation-%'`)).rows[0].n;
    console.log(`\ncleanup: fixture deleted, ${leaked} leaked`);
    if (leaked) fail++;
    console.log(fail === 0 ? '\n✅ ALL CHECKS PASSED — a revoke takes effect on the next request'
                           : `\n❌ ${fail} CHECK(S) FAILED`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
