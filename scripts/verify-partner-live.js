// ── partner, END TO END, against the LIVE container (self-cleaning) ──
//
// Every other check of this role is a unit test against code I also wrote. This one inserts a real
// users row with role='partner' and a real user_products row holding ['sitenex'], then makes real
// HTTP requests through the actual middleware chain — permissions resolver, then product boundary,
// then the tier gate — and asserts what comes back. The fixture is deleted in a finally and its email
// is prefixed so a leak is obvious.
//
// Worth doing before a real person gets this account, because the unit tests cannot see the ORDER the
// middleware runs in, and the three layers 403 with different bodies.
//
// Run:  railway ssh 'node scripts/verify-partner-live.js'

const jwt = require('jsonwebtoken');
const { query } = require('../src/lib/db');

const TAG = 'verify-partner-' + Date.now();
const EMAIL = `${TAG}@example.invalid`;
const PORT = process.env.PORT || 3000;
let id = null, fail = 0;

const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
};

const hit = async (method, path) => {
  const token = jwt.sign({ id, email: EMAIL, role: 'partner' }, process.env.JWT_SECRET, { expiresIn: '2m' });
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
  // RETURNS { status, layer } AND NOTHING ELSE. Every check in this file compares this object whole against
  // an expected literal, so adding a third key — I added `body` — makes all of them fail on the extra
  // property while reporting nothing about what changed. The one place that needs the payload uses hitBody
  // below instead.
  return { status: r.status, layer };
};

// The same request, returning the payload. For the assertion that moved out of the status code: prospects is
// no longer REFUSED but territory-scoped, so "reachable AND empty, and it says why" is the claim, and that
// lives in the body.
const hitBody = async (method, path) => {
  const token = jwt.sign({ id, email: EMAIL, role: 'partner' }, process.env.JWT_SECRET, { expiresIn: '2m' });
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { Authorization: 'Bearer ' + token } });
  let body = {};
  try { body = JSON.parse(await r.text()); } catch (_) {}
  return { status: r.status, body };
};

(async () => {
  try {
    id = require('crypto').randomUUID();
    await query(`INSERT INTO users (id, email, name, role, is_active, joined_at, permissions_version)
                 VALUES ($1, $2, 'Partner Fixture', 'partner', 1, NOW(), 1)`, [id, EMAIL]);
    await query(`INSERT INTO user_products (user_id, product, granted_by) VALUES ($1, 'sitenex', 'verify-script')`, [id]);
    const held = (await query(`SELECT product FROM user_products WHERE user_id = $1`, [id])).rows.map(r => r.product);
    console.log(`fixture: ${EMAIL}\n  role=partner  user_products=[${held.join(', ')}]\n`);
    check("the fixture holds sitenex and NOT internal", held.sort(), ['sitenex']);

    console.log('\nWHAT IT CAN REACH:');
    check('GET /api/sitenex/deals    → allowed', await hit('GET', '/api/sitenex/deals'), { status: 200, layer: 'allowed' });
    check('GET /api/sitenex/packages → allowed', await hit('GET', '/api/sitenex/packages'), { status: 200, layer: 'allowed' });
    // REFUSED, and that is the fix rather than a regression. buildNav used to `await API('/roles')` inside a
    // try/catch that swallowed the error, so a failed request WIDENED the nav. Tiers now come from
    // currentUser via /auth/me — the same call that decides whether the app renders at all — so the nav no
    // longer depends on this route and a partner has no reason to reach the role catalogue. Asserting the
    // 403 is what proves the dependency was actually removed rather than merely tidied.
    check('GET /api/roles         → REFUSED (the nav no longer depends on it)',
          await hit('GET', '/api/roles'), { status: 403, layer: 'resolver' });
    check('GET /api/auth/me       → allowed', await hit('GET', '/api/auth/me'), { status: 200, layer: 'allowed' });
    check('GET /api/agent/tasks/my → allowed', await hit('GET', '/api/agent/tasks/my'), { status: 200, layer: 'allowed' });

    console.log('\nWHAT IT CANNOT — and WHICH layer says no:');
    // REVERSED 2026-10-01. Reachable now, and scoped to the partner's granted territory. The fixture has no
    // partner_territories row, so the honest assertion is 200 WITH NO ROWS — which is the fail-closed
    // behaviour, and the one that would be a leak if it went the other way.
    const prospects = await hitBody('GET', '/api/sitenex/prospects');
    check('GET /api/sitenex/prospects → 200 (reachable)', prospects.status, 200);
    check('  …and EMPTY, because this fixture holds no territory', (prospects.body && prospects.body.total), 0);
    check('  …and it says so rather than looking broken',
          /no territory yet/.test((prospects.body && prospects.body.scope_note) || ''), true);
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
      await query(`DELETE FROM users WHERE id = $1 AND email LIKE 'verify-partner-%'`, [id]).catch(() => {});
    }
    const leaked = (await query(`SELECT COUNT(*)::int n FROM users WHERE email LIKE 'verify-partner-%'`)).rows[0].n;
    const leakedGrants = (await query(`SELECT COUNT(*)::int n FROM user_products WHERE granted_by = 'verify-script'`)).rows[0].n;
    console.log(`\ncleanup: fixture deleted, ${leaked} user row(s) and ${leakedGrants} grant(s) leaked`);
    if (leaked || leakedGrants) fail++;
    console.log(fail === 0 ? '\n✅ ALL CHECKS PASSED — the partner shape is safe to hand to a real person'
                           : `\n❌ ${fail} CHECK(S) FAILED — do not create the accounts`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
