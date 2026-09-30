// ── THE SUPER ADMIN EDIT BUG — verified with a token that claims the OLD role ──
//
// The bug was that authMiddleware copied the role out of the JWT, so naren's pre-promotion session got
// "Super admin only" 403s on every user-management write while his newer session worked.
//
// So the verification has to use a token that DISAGREES with the database. A token minted from the DB
// role proves nothing — that is what passed while the bug was live.
//
// Every write is aimed at a disposable fixture, and the fixture is deleted afterwards.
//
// Run:  railway ssh 'node scripts/verify-stale-token-writes.js'

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('../src/lib/db');

const TAG = 'verify-stale-' + Date.now();
const P = process.env.PORT || 3000;
let fixture = null, superFx = null, fail = 0;

const check = (label, a, e) => { const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) fail++; console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : `  → expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`}`); };

(async () => {
  try {
    const sup = (await query(`SELECT id, email, role FROM users WHERE role='super_admin' AND is_active=1 LIMIT 1`)).rows[0];
    // The whole point: claim 'admin', which is what his browser was sending.
    const stale = jwt.sign({ id: sup.id, email: sup.email, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const fresh = jwt.sign({ id: sup.id, email: sup.email, role: 'super_admin' }, process.env.JWT_SECRET, { expiresIn: '5m' });

    fixture = crypto.randomUUID();
    await query(`INSERT INTO users (id,email,name,role,is_active,joined_at,permissions_version)
                 VALUES ($1,$2,'Stale Token Fixture','dev_team',1,NOW(),1)`, [fixture, `${TAG}@example.invalid`]);
    console.log(`super_admin in the DB: ${sup.email} (${sup.role})`);
    console.log(`token used below claims: role='admin'  ← the stale session\n`);

    const hit = async (method, path, token, body) => {
      const r = await fetch(`http://127.0.0.1:${P}${path}`, {
        method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
      const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (_) {}
      return { status: r.status, err: j.error || '', raw: t.slice(0, 120) };
    };

    const WRITES = [
      ['GET',  `/api/users/${fixture}/products`,             null,                                      'read grants + history'],
      ['PUT',  `/api/users/${fixture}/products`,             { products: ['abiozen', 'sitenex'] },         'grant products'],
      ['POST', `/api/admin/users/${fixture}/edit-name`,      { name: 'Renamed By Stale Token' },        'Edit name (the Actions menu)'],
      ['PUT',  `/api/users/profile`,                         { user_id: fixture, whatsapp_number: '+15555550222' }, 'Set WhatsApp'],
      ['PUT',  `/api/users/${fixture}/toggle-status`,         { is_active: 0 },                          'Set Inactive'],
      ['PUT',  `/api/users/${fixture}/toggle-status`,         { is_active: 1 },                          'Set Active'],
      ['POST', `/api/admin/users/${fixture}/reset-password`,  {},                                        'Reset password'],
      ['PUT',  `/api/users/${fixture}`,                       { role: 'support_team' },                  'change role'],
    ];
    console.log('with the STALE token — every one must SUCCEED:');
    for (const [m, p, b, label] of WRITES) {
      const r = await hit(m, p, stale, b);
      check(`${label.padEnd(30)} ${m} ${p.replace(fixture, ':id')}`, r.status < 400, true);
      if (r.status >= 400) console.log(`        ${r.status} ${r.raw}`);
    }

    const row = (await query(`SELECT name, role, whatsapp_number FROM users WHERE id=$1`, [fixture])).rows[0];
    check('the writes really landed', row.name, 'Renamed By Stale Token');
    console.log(`     fixture row: ${JSON.stringify(row)}`);
    const held = (await query(`SELECT product FROM user_products WHERE user_id=$1 ORDER BY product`, [fixture])).rows.map(r => r.product);
    check('and the grants landed', held, ['abiozen', 'sitenex']);

    console.log('\nthe same stale token must still be refused where it should be:');
    // AGAINST A FIXTURE SUPER ADMIN, not the real one. This used to PUT { role: 'admin' } onto the live
    // super_admin and rely on the expected 403 to keep it harmless. naren@abiozen.com is the ONLY active
    // super_admin, so the single run where that guard failed to fire would have demoted the account with
    // nobody left able to restore it. The refusal is what is being tested; it cannot also be the safeguard.
    superFx = crypto.randomUUID();
    const superEmail = `verify-stale-super-${Date.now()}@example.invalid`;
    await query(`INSERT INTO users (id,email,name,role,is_active,joined_at,permissions_version)
                 VALUES ($1,$2,'Stale Guard Fixture','super_admin',1,NOW(),1)`, [superFx, superEmail]);
    const fxStale = jwt.sign({ id: superFx, email: superEmail, role: 'super_admin' },
                             process.env.JWT_SECRET, { expiresIn: '5m' });
    const selfDemote = await hit('PUT', `/api/users/${superFx}`, fxStale, { role: 'admin' });
    check('cannot demote itself', selfDemote.status, 403);
    check('  and the role really is untouched',
      (await query(`SELECT role FROM users WHERE id=$1`, [superFx])).rows[0].role, 'super_admin');

    console.log('\nand a token claiming MORE than the database allows is still refused:');
    const adm = (await query(`SELECT id, email FROM users WHERE role='admin' AND is_active=1 LIMIT 1`)).rows[0];
    if (adm) {
      const liar = jwt.sign({ id: adm.id, email: adm.email, role: 'super_admin' }, process.env.JWT_SECRET, { expiresIn: '5m' });
      const r = await hit('PUT', `/api/users/${fixture}/products`, liar, { products: [] });
      check(`${adm.email} claiming super_admin → 403`, r.status, 403);
      console.log(`        refused with: ${r.err.slice(0, 60)}`);
    }

    const freshCheck = await hit('GET', `/api/users/${fixture}/products`, fresh);
    check('a correct token still works too', freshCheck.status, 200);
  } catch (e) { fail++; console.error('ERROR:', e.message); }
  finally {
    for (const fx of [fixture, superFx]) {
      if (!fx) continue;
      for (const t of ['user_product_grants_log', 'user_products', 'product_shadow_log']) {
        await query(`DELETE FROM ${t} WHERE user_id=$1`, [fx]).catch(() => {});
      }
      await query(`DELETE FROM users WHERE id=$1 AND email LIKE 'verify-stale-%'`, [fx]).catch(() => {});
    }
    // A leftover ACTIVE super_admin is a privilege leak, so it is named rather than folded into the count.
    if (superFx && (await query(`SELECT COUNT(*)::int n FROM users WHERE id=$1`, [superFx])).rows[0].n) {
      fail++; console.error(`❌ the fixture SUPER ADMIN ${superFx} was not removed`);
    }
    const leaked = (await query(`SELECT COUNT(*)::int n FROM users WHERE email LIKE 'verify-stale-%'`)).rows[0].n;
    console.log(`\ncleanup: ${leaked} leaked`);
    if (leaked) fail++;
    console.log(fail === 0 ? '\n✅ ALL CHECKS PASSED — a pre-promotion token no longer locks a super_admin out'
                           : `\n❌ ${fail} CHECK(S) FAILED`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
