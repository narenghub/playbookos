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
let id = null, superUser = null, superFixtureId = null, fail = 0;

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

    console.log('\nguard 1, live — against a FIXTURE super admin, never the real one:');
    // THIS USED TO PUT PRODUCTS ONTO THE LIVE SUPER ADMIN and expect a 403 to make it harmless. On
    // 2026-09-30 it got a 200 and the write landed on naren@abiozen.com, because the 7 rows had been
    // deliberately removed the day before: with 0 held, setting ['abiozen'] REMOVES nothing, so it is a
    // widening, which the guard allows by design. The assertion `products are untouched === 7` had encoded
    // the pre-removal state. Two lessons, and the second is the one that matters:
    //   • an expectation built from live account state goes stale when somebody changes that account;
    //   • a verification must not WRITE to rows it did not create, not merely not delete them. "It will be
    //     refused anyway" is a prediction, and the run where the prediction is wrong is the run that
    //     mutates a privileged account with no undo.
    // So guard 1 now runs entirely against a fixture super_admin that this script creates and deletes.
    superFixtureId = crypto.randomUUID();
    const superEmail = `${TAG}-super@example.invalid`;
    await query(`INSERT INTO users (id,email,name,role,is_active,joined_at,permissions_version)
                 VALUES ($1,$2,'Guard Fixture','super_admin',1,NOW(),1)`, [superFixtureId, superEmail]);
    for (const p of ['abiozen', 'golfnex']) {
      await query(`INSERT INTO user_products (user_id, product) VALUES ($1,$2)
                   ON CONFLICT DO NOTHING`, [superFixtureId, p]);
    }
    const fixtureToken = jwt.sign({ id: superFixtureId, email: superEmail, role: 'super_admin' },
                                  process.env.JWT_SECRET, { expiresIn: '5m' });

    // Narrowing: two held, one requested. This is the case the guard exists for.
    const selfNarrow = await hit('PUT', `/api/users/${superFixtureId}/products`, fixtureToken, { products: ['abiozen'] });
    check('a super admin cannot narrow themselves', selfNarrow.status, 403);
    check('with the reason named', selfNarrow.body.code, 'self_narrow');
    check('and their products are untouched',
      (await query(`SELECT COUNT(*)::int n FROM user_products WHERE user_id=$1`, [superFixtureId])).rows[0].n, 2);

    // And the boundary case that made the old test pass for the wrong reason: WIDENING yourself is allowed,
    // so a 200 here is correct behaviour and not a hole in the guard.
    const selfWiden = await hit('PUT', `/api/users/${superFixtureId}/products`, fixtureToken,
                                { products: ['abiozen', 'golfnex', 'favly'] });
    check('but WIDENING yourself is allowed — it is not an escalation', selfWiden.status, 200);
    check('  and it actually applied',
      (await query(`SELECT COUNT(*)::int n FROM user_products WHERE user_id=$1`, [superFixtureId])).rows[0].n, 3);

    const supers = (await query(`SELECT COUNT(*)::int n FROM users WHERE role='super_admin' AND is_active=1`)).rows[0].n;
    console.log(`     (${supers} active super admin(s) while this fixture exists — it is removed below)`);
  } catch (e) { fail++; console.error('ERROR:', e.message); }
  finally {
    for (const fx of [id, superFixtureId]) {
      if (!fx) continue;
      await query(`DELETE FROM product_shadow_log WHERE user_id=$1`, [fx]).catch(() => {});
      await query(`DELETE FROM user_product_grants_log WHERE user_id=$1`, [fx]).catch(() => {});
      await query(`DELETE FROM user_products WHERE user_id=$1`, [fx]).catch(() => {});
      await query(`DELETE FROM users WHERE id=$1 AND email LIKE 'verify-revocation-%'`, [fx]).catch(() => {});
    }
    // A leftover ACTIVE super_admin would be a real privilege leak, so it is checked by name rather than
    // folded into the generic count below.
    const leftSuper = superFixtureId
      ? (await query(`SELECT COUNT(*)::int n FROM users WHERE id=$1`, [superFixtureId])).rows[0].n : 0;
    if (leftSuper) { fail++; console.error(`❌ the fixture SUPER ADMIN ${superFixtureId} was not removed`); }
    const leaked = (await query(`SELECT COUNT(*)::int n FROM users WHERE email LIKE 'verify-revocation-%'`)).rows[0].n;
    console.log(`\ncleanup: fixture deleted, ${leaked} leaked`);
    if (leaked) fail++;
    console.log(fail === 0 ? '\n✅ ALL CHECKS PASSED — a revoke takes effect on the next request'
                           : `\n❌ ${fail} CHECK(S) FAILED`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
