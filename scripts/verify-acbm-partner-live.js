// ── acbm_partner, END TO END, against the LIVE container (self-cleaning) ──
//
// Every other check of this role is a unit test against code I also wrote. This one inserts a real
// users row with role='acbm_partner' and a real user_products row holding ['acbm'], then makes real
// HTTP requests through the actual middleware chain — permissions resolver, then product boundary,
// then the tier gate — and asserts what comes back. The fixture is deleted in a finally and its email
// is prefixed so a leak is obvious.
//
// Worth doing before a real person gets this account, because the unit tests cannot see the ORDER the
// middleware runs in, and the three layers 403 with different bodies.
//
// Run:  railway ssh 'node scripts/verify-acbm-partner-live.js'

const jwt = require('jsonwebtoken');
const { query } = require('../src/lib/db');

const TAG = 'verify-acbm-partner-' + Date.now();
const EMAIL = `${TAG}@example.invalid`;
const PORT = process.env.PORT || 3000;
let id = null, fail = 0;

const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
};

const hit = async (method, path) => {
  const token = jwt.sign({ id, email: EMAIL, role: 'acbm_partner' }, process.env.JWT_SECRET, { expiresIn: '2m' });
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { Authorization: 'Bearer ' + token } });
  let body = {};
  try { body = JSON.parse(await r.text()); } catch (_) {}
  // Which LAYER refused, from the shape of the body. Each one has a distinct error string, which is
  // the only way to tell from outside that the chain is wired the way the design says.
  const layer = r.status < 400 ? 'allowed'
    : /permission resolver/.test(body.error || '') ? 'resolver'
    : /product boundary/.test(body.error || '') ? 'boundary'
    : /Admin only|Super admin only|lacks|has no/.test(body.error || '') ? 'tier/role'
    : `other(${body.error || r.status})`;
  return { status: r.status, layer };
};

(async () => {
  try {
    id = require('crypto').randomUUID();
    await query(`INSERT INTO users (id, email, name, role, is_active, joined_at, permissions_version)
                 VALUES ($1, $2, 'ACBM Partner Fixture', 'acbm_partner', 1, NOW(), 1)`, [id, EMAIL]);
    await query(`INSERT INTO user_products (user_id, product, granted_by) VALUES ($1, 'acbm', 'verify-script')`, [id]);
    const held = (await query(`SELECT product FROM user_products WHERE user_id = $1`, [id])).rows.map(r => r.product);
    console.log(`fixture: ${EMAIL}\n  role=acbm_partner  user_products=[${held.join(', ')}]\n`);
    check("the fixture holds acbm and NOT internal", held.sort(), ['acbm']);

    console.log('\nWHAT IT CAN REACH:');
    check('GET /api/acbm/deals    → allowed', await hit('GET', '/api/acbm/deals'), { status: 200, layer: 'allowed' });
    check('GET /api/acbm/packages → allowed', await hit('GET', '/api/acbm/packages'), { status: 200, layer: 'allowed' });
    check('GET /api/roles         → allowed (the nav needs it)', await hit('GET', '/api/roles'), { status: 200, layer: 'allowed' });
    check('GET /api/auth/me       → allowed', await hit('GET', '/api/auth/me'), { status: 200, layer: 'allowed' });
    check('GET /api/agent/tasks/my → allowed', await hit('GET', '/api/agent/tasks/my'), { status: 200, layer: 'allowed' });

    console.log('\nWHAT IT CANNOT — and WHICH layer says no:');
    const prospects = await hit('GET', '/api/acbm/prospects');
    check('GET /api/acbm/prospects → 403 (our lead list)', prospects.status, 403);
    console.log(`      refused by: ${prospects.layer}`);
    for (const [m, p] of [['GET', '/api/users'], ['GET', '/api/admin/adoption'], ['GET', '/api/targets'],
                          ['GET', '/api/performance/alerts'], ['GET', '/api/prospects'],
                          ['GET', '/api/products/grantable'], ['GET', '/api/notifications']]) {
      const r = await hit(m, p);
      check(`${m} ${p} → 403`, r.status, 403);
      console.log(`      refused by: ${r.layer}`);
    }

    console.log('\nAND THE INVITE ROUTE, which decides what other accounts hold:');
    const inv = await hit('POST', '/api/users/invite');
    check('POST /api/users/invite → 403', inv.status, 403);
    console.log(`      refused by: ${inv.layer}`);

    const blocked = (await query(`SELECT method, path, resolved_product FROM product_shadow_log
      WHERE user_id = $1 AND would_block ORDER BY id`, [id])).rows;
    console.log(`\nboundary BLOCKs recorded for the fixture: ${blocked.length}`);
    blocked.forEach(b => console.log(`  ${b.method} ${b.path} → ${b.resolved_product}`));
  } catch (e) {
    fail++; console.error('ERROR:', e.message);
  } finally {
    if (id) {
      await query(`DELETE FROM product_shadow_log WHERE user_id = $1`, [id]).catch(() => {});
      await query(`DELETE FROM user_products WHERE user_id = $1`, [id]).catch(() => {});
      await query(`DELETE FROM users WHERE id = $1 AND email LIKE 'verify-acbm-partner-%'`, [id]).catch(() => {});
    }
    const leaked = (await query(`SELECT COUNT(*)::int n FROM users WHERE email LIKE 'verify-acbm-partner-%'`)).rows[0].n;
    const leakedGrants = (await query(`SELECT COUNT(*)::int n FROM user_products WHERE granted_by = 'verify-script'`)).rows[0].n;
    console.log(`\ncleanup: fixture deleted, ${leaked} user row(s) and ${leakedGrants} grant(s) leaked`);
    if (leaked || leakedGrants) fail++;
    console.log(fail === 0 ? '\n✅ ALL CHECKS PASSED — the acbm_partner shape is safe to hand to a real person'
                           : `\n❌ ${fail} CHECK(S) FAILED — do not create the accounts`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
