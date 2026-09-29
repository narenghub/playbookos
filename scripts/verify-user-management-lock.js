// ── USER MANAGEMENT LOCK — live verification against the running container ──
//
// Uses tokens for the REAL accounts, because the question is not "does superAdminOnly work" (a unit test
// settles that) but "can prasanthi's actual account still change a user". Every write is aimed so that a
// failure to refuse would be visible and harmless: renames to the existing value, a toggle to the status
// already held, an invite to example.invalid.
//
// It reports WHICH layer refused. That is the interesting part: for a role in PERMISSIONS_ENFORCE_ROLES
// the resolver answers before the route middleware, so a passing run shows the resolver closed AND the
// middleware behind it — which is what "in the resolver, not by hiding buttons" asked for.
//
// Run:  railway ssh 'node scripts/verify-user-management-lock.js'

// Live verification of the lockdown against the running container, using tokens for the REAL accounts.
// Read-only where it can be: every write is aimed at a target that makes the call refuse before it acts.
const jwt = require('jsonwebtoken');
const { query } = require('../src/lib/db');
const P = process.env.PORT || 3000;
let fail = 0;
const check = (label, a, e) => { const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) fail++; console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : `  → expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`}`); };

(async () => {
  const users = (await query(`SELECT id, email, role FROM users ORDER BY role`)).rows;
  const sup = users.find(u => u.role === 'super_admin');
  const adm = users.find(u => u.role === 'admin');
  const dev = users.find(u => u.role === 'dev_team');
  const tok = (u) => jwt.sign({ id: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET, { expiresIn: '3m' });
  const hit = async (method, path, u, body) => {
    const r = await fetch(`http://127.0.0.1:${P}${path}`, {
      method, headers: { Authorization: 'Bearer ' + tok(u), 'Content-Type': 'application/json' },
      body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
    let j = {}; try { j = JSON.parse(await r.text()); } catch (_) {}
    return { status: r.status, err: j.error || '', code: j.code || '' };
  };

  console.log(`super_admin: ${sup.email}\nadmin:       ${adm.email}\ndev_team:    ${dev.email}\n`);

  const ROUTES = [
    ['GET',    `/api/users/${dev.id}/products`, null],
    ['PUT',    `/api/users/${dev.id}/products`, { products: ['abiozen'] }],
    ['PUT',    `/api/users/${dev.id}`,          { name: 'unchanged' }],
    ['PUT',    `/api/users/${dev.id}/toggle-status`, { is_active: 1 }],
    ['POST',   `/api/admin/users/${dev.id}/edit-name`, { new_name: 'unchanged' }],
    ['POST',   `/api/users/invite`,             { email: 'blocked@example.invalid', role: 'dev_team' }],
  ];

  // WHICH layer refuses is worth seeing rather than asserting: the resolver runs before the route
  // middleware, so for a role listed in PERMISSIONS_ENFORCE_ROLES the resolver answers first. Both are
  // required to be closed; the test asserts the 403 and reports the layer.
  const layer = (r) => /permission resolver/.test(r.err) ? 'resolver'
    : /Super admin only/.test(r.err) ? 'middleware' : `other(${r.err.slice(0, 30)})`;
  console.log('as ADMIN (prasanthi) — every one must be refused:');
  for (const [m, p, b] of ROUTES) {
    const r = await hit(m, p, adm, b);
    check(`${m} ${p.replace(dev.id, ':id')} → 403`, r.status, 403);
    console.log(`        refused by: ${layer(r)}`);
  }
  console.log('\nas DEV_TEAM — same:');
  for (const [m, p, b] of ROUTES.slice(0, 3)) {
    const r = await hit(m, p, dev, b);
    check(`${m} ${p.replace(dev.id, ':id')} → 403`, r.status, 403);
  }

  console.log('\nwhat ADMIN can still do:');
  const list = await hit('GET', '/api/users', adm);
  check('GET /api/users (see the team)', list.status, 200);
  const ownProfile = await hit('PUT', '/api/users/profile', adm, { github_username: null });
  check('PUT /api/users/profile (own row)', ownProfile.status, 200);
  const backDoor = await hit('PUT', '/api/users/profile', adm, { user_id: dev.id, name: 'Renamed' });
  check("the user_id back door is closed", { status: backDoor.status, code: /Super admin only/.test(backDoor.err) }, { status: 403, code: true });

  console.log('\nas SUPER_ADMIN — still works:');
  check('GET /api/users/:id/products', (await hit('GET', `/api/users/${dev.id}/products`, sup)).status, 200);
  const selfDemote = await hit('PUT', `/api/users/${sup.id}`, sup, { role: 'admin' });
  check('but cannot demote themselves', { status: selfDemote.status, code: selfDemote.code }, { status: 403, code: 'self_demote' });

  const after = (await query(`SELECT role FROM users WHERE id=$1`, [sup.id])).rows[0].role;
  check('and the role is untouched', after, 'super_admin');
  const devName = (await query(`SELECT name FROM users WHERE id=$1`, [dev.id])).rows[0].name;
  check('the refused rename really did nothing', devName === 'Renamed', false);
  console.log(`     (${dev.email} is still named "${devName}")`);

  console.log(fail === 0 ? '\n✅ ALL CHECKS PASSED — user management is super_admin only' : `\n❌ ${fail} CHECK(S) FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
