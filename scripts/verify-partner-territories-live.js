// ── Multi-partner SiteNex, END TO END against the real database (self-cleaning) ──
//
// What a module test cannot settle, and this can:
//   • the PARTIAL UNIQUE INDEX really refuses the same exclusive territory to a second partner — a fake
//     models the constraint, the database IS the constraint;
//   • territory scoping over REAL prospect data, with the assertion that every returned row is actually in
//     the patch (a scope that returned everything would pass a count check and fail this one);
//   • FAIL CLOSED before any grant: reachable, and empty, with a sentence explaining why;
//   • several users at one firm share a partner_id and so see each other's work, which is the agreement.
//
// Two fixture partners, because "sees their own" is satisfied by a query returning everything when there is
// only one partner's data to return. Cleanup is BY EXPLICIT ID and asserts only that its own rows are gone.
//
// Run:  railway ssh 'node scripts/verify-partner-territories-live.js'

const jwt = require('jsonwebtoken');
const { query } = require('../src/lib/db');
const PORT = process.env.PORT || 3000;
const made = { partners: [], users: [], terr: [], regs: [] };
let fail = 0;
const ck = (l,a,e) => { const ok = JSON.stringify(a)===JSON.stringify(e); if(!ok) fail++;
  console.log(`  ${ok?'✅':'❌'} ${l}${ok?'':`  → expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`}`); };
(async () => {
  try {
    const sup = (await query(`SELECT id,email,role FROM users WHERE role='super_admin' AND is_active=1 LIMIT 1`)).rows[0];
    const staff = jwt.sign({id:sup.id,email:sup.email,role:sup.role}, process.env.JWT_SECRET, {expiresIn:'10m'});
    const hit = async (m,p,tok,b) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {method:m,
      headers:{Authorization:'Bearer '+tok,'Content-Type':'application/json'}, body:b===undefined?undefined:JSON.stringify(b)});
      return { status:r.status, body: await r.json().catch(()=>({})) }; };

    // two partners, two users
    const mkP = async (n) => { const id=(await query(`INSERT INTO partners (name) VALUES ($1)
      ON CONFLICT (name) DO UPDATE SET status='active' RETURNING id`,[n])).rows[0].id; made.partners.push(id); return id; };
    const pa = await mkP('VERIFY TERR A'), pb = await mkP('VERIFY TERR B');
    const mkU = async (l,pid) => { const id=require('crypto').randomUUID();
      const email=`verify-terr-${l}-${Date.now()}@example.invalid`;
      await query(`INSERT INTO users (id,email,name,role,is_active,joined_at,permissions_version,partner_id)
                   VALUES ($1,$2,$3,'partner',1,NOW(),1,$4)`,[id,email,'Terr '+l,pid]);
      await query(`INSERT INTO user_products (user_id,product) VALUES ($1,'sitenex') ON CONFLICT DO NOTHING`,[id]);
      made.users.push(id);
      return jwt.sign({id,email,role:'partner'}, process.env.JWT_SECRET, {expiresIn:'10m'}); };
    const ua = await mkU('a', pa), ub = await mkU('b', pb);

    console.log('1. FAIL CLOSED before any grant');
    const before = await hit('GET','/api/sitenex/prospects',ua);
    ck('reachable', before.status, 200);
    ck('  and EMPTY — no territory means nothing, never everything', before.body.total, 0);
    ck('  and it says why', /no territory yet/.test(before.body.scope_note||''), true);
    // TRUE since 2026-10-01: outreach is partner-scoped now, so a partner records their own calls and
    // outreach.partner_id keeps A's out of B's sight. This asserted FALSE while outreach was staffOnly, and the
    // flag survives rather than being deleted — it is the server's answer to "may this caller use outreach",
    // and the screen already asks.
    ck('  outreach is reported usable now that it is partner-scoped', before.body.can_track_outreach, true);

    console.log('\n2. GRANT a real region, from real data');
    const region = (await query(`SELECT region, COUNT(*)::int n FROM prospects
      WHERE product='sitenex' AND region IS NOT NULL AND status='qualified'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 1`)).rows[0];
    console.log(`     using region '${region.region}' (${region.n} qualified prospects)`);
    const g = await hit('POST','/api/sitenex/territories',staff,{partner_id:pa,dimension:'region',value:region.region});
    ck('granted', g.status, 201);
    if (g.body.territory) made.terr.push(g.body.territory.id);

    console.log('\n3. THE DATABASE refuses the same exclusive region to partner B');
    const clash = await hit('POST','/api/sitenex/territories',staff,{partner_id:pb,dimension:'region',value:region.region});
    ck('409', clash.status, 409);
    ck('  code', clash.body.code, 'territory_taken');
    ck('  names the holder', clash.body.held_by, 'VERIFY TERR A');

    console.log('\n4. A sees their patch; B still sees nothing');
    const after = await hit('GET','/api/sitenex/prospects',ua);
    ck('A sees rows', after.body.total > 0, true);
    console.log(`     A sees ${after.body.total}; scope='${after.body.scope}'; territories=${JSON.stringify(after.body.territories)}`);
    const outside = (after.body.items||[]).filter(x => x.region !== region.region);
    ck('  every row is IN the territory', outside.length, 0);
    ck('B still sees nothing', (await hit('GET','/api/sitenex/prospects',ub)).body.total, 0);
    ck('staff see everything', (await hit('GET','/api/sitenex/prospects',staff)).body.total > after.body.total, true);

    console.log('\n5. REGISTRATION: in territory confirms, out of territory waits');
    const inT = (after.body.items||[])[0];
    const r1 = await hit('POST','/api/sitenex/lead-registrations',ua,{prospect_id:inT.id});
    ck('in-territory → confirmed', [r1.status, r1.body.registration && r1.body.registration.status], [201,'confirmed']);
    if (r1.body.registration) made.regs.push(r1.body.registration.id);
    const far = (await query(`SELECT id, name, region FROM prospects WHERE product='sitenex'
      AND region IS NOT NULL AND region <> $1 LIMIT 1`,[region.region])).rows[0];
    const r2 = await hit('POST','/api/sitenex/lead-registrations',ua,{prospect_id:far.id});
    ck('out-of-territory → pending_approval', [r2.status, r2.body.registration && r2.body.registration.status], [201,'pending_approval']);
    if (r2.body.registration) made.regs.push(r2.body.registration.id);
    ck('  a partner cannot read that prospect', (await hit('GET',`/api/sitenex/prospects/${far.id}/content`,ua)).status, 404);
    ck('  nor decide its own claim', (await hit('PUT',`/api/sitenex/lead-registrations/${r2.body.registration.id}`,ua,{status:'confirmed'})).status, 403);
    const noReason = await hit('PUT',`/api/sitenex/lead-registrations/${r2.body.registration.id}`,staff,{status:'rejected'});
    ck('  a rejection with no reason is refused', [noReason.status, noReason.body.code], [400,'reason_required']);
    const dec = await hit('PUT',`/api/sitenex/lead-registrations/${r2.body.registration.id}`,staff,
      {status:'rejected',decision_reason:'Outside the agreed patch for this partner.'});
    ck('  and with one, it decides', [dec.status, dec.body.registration.status], [200,'rejected']);

    console.log('\n6. SEVERAL USERS, ONE FIRM — they are one partner and see each other\'s work');
    const ua2 = await mkU('a2', pa);
    const seen = await hit('GET','/api/sitenex/lead-registrations',ua2);
    ck('a second user at partner A sees A\'s registrations', seen.body.total >= 2, true);
    ck('  and the same territory', (await hit('GET','/api/sitenex/prospects',ua2)).body.total, after.body.total);
  } catch (e) { fail++; console.error('ERROR:', e.message, (e.stack||'').split('\n')[1]); }
  finally {
    for (const id of made.regs) await query(`DELETE FROM sitenex_lead_registrations WHERE id=$1`,[id]).catch(()=>{});
    for (const id of made.terr) await query(`DELETE FROM partner_territories WHERE id=$1`,[id]).catch(()=>{});
    for (const id of made.users) { await query(`DELETE FROM user_products WHERE user_id=$1`,[id]).catch(()=>{});
      await query(`DELETE FROM users WHERE id=$1 AND email LIKE 'verify-terr-%'`,[id]).catch(()=>{}); }
    for (const id of made.partners) await query(`DELETE FROM partners WHERE id=$1`,[id]).catch(()=>{});
    let left=0;
    for (const id of made.users) left += (await query(`SELECT COUNT(*)::int n FROM users WHERE id=$1`,[id])).rows[0].n;
    for (const id of made.partners) left += (await query(`SELECT COUNT(*)::int n FROM partners WHERE id=$1`,[id])).rows[0].n;
    console.log(`\ncleanup: ${made.partners.length} partner(s), ${made.users.length} user(s), ${made.terr.length} territory(s), ${made.regs.length} registration(s) removed; ${left} of mine remain`);
    if (left) fail++;
    console.log(fail===0 ? '\n✅ ALL CHECKS PASSED' : `\n❌ ${fail} CHECK(S) FAILED`);
    process.exit(fail===0?0:1);
  }
})();
