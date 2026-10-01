// ── RENAME + PARTNERS + ROW-LEVEL DEAL SCOPING, live (self-cleaning) ──
//
// Two REAL partner rows and three real deals, because a single partner proves nothing: with one partner,
// "returns everything" and "returns their own" are the same answer. Deals and the second partner record
// are deleted in the finally, with a leak check that asserts sitenex_deals is back to 0 and partners
// back to 1.
//
// Run:  railway ssh 'node scripts/verify-partner-deal-scope-live.js'

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('../src/lib/db');
const P = process.env.PORT || 3000;
// Hoisted so the `finally` can delete BY ID. They used to be declared inside the try, which is why the
// cleanup reached for a timestamp instead — and a ten-minute window against production would have taken
// out any unassigned deal somebody had just created.
let fail = 0, fixtures = [], dealIds = [], partnerBId = null;
const check = (l, a, e) => { const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) fail++; console.log(`  ${ok ? '✅' : '❌'} ${l}${ok ? '' : `  → expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`}`); };

(async () => {
  try {
    const sup = (await query(`SELECT id,email,role FROM users WHERE role='super_admin' AND is_active=1 LIMIT 1`)).rows[0];
    const tok = (u) => jwt.sign({ id: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const hit = async (p, u) => { const r = await fetch(`http://127.0.0.1:${P}${p}`, { headers: { Authorization: 'Bearer ' + tok(u) } });
      const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (_) {}
      return { status: r.status, body: j, raw: t.slice(0, 140) }; };

    console.log('1. THE NEW ROUTES WORK (as super_admin)');
    for (const p of ['/api/sitenex/prospects', '/api/sitenex/deals', '/api/sitenex/packages']) {
      const r = await hit(p, sup);
      check(`GET ${p}`, r.status, 200);
      if (r.status !== 200) console.log('      ' + r.raw);
    }
    const prospects = await hit('/api/sitenex/prospects', sup);
    check('the prospect list is not empty after the product rename', (prospects.body.total || 0) > 1000, true);
    console.log(`     total prospects visible: ${prospects.body.total}`);
    const deals = await hit('/api/sitenex/deals', sup);
    check("staff see 'all partners'", deals.body.scope, 'all partners');

    console.log('\n2. THE OLD ROUTES ARE GONE');
    for (const p of ['/api/acbm/prospects', '/api/acbm/deals', '/api/acbm/packages']) {
      const r = await hit(p, sup);
      check(`GET ${p} → not 200`, r.status !== 200, true);
      console.log(`      ${r.status} ${String(r.body.error || '').slice(0, 44)}`);
    }

    console.log('\n3. PARTNERS ARE RECORDS');
    const pt = (await query(`SELECT id, name, primary_contact_email, status FROM partners ORDER BY id`)).rows;
    check('one partner record', pt.length, 1);
    check('and it is ACBM Partners', pt[0].name, 'ACBM Partners');
    console.log(`     id=${pt[0].id} ${pt[0].name} <${pt[0].primary_contact_email}> ${pt[0].status}`);
    const cols = (await query(`SELECT column_name FROM information_schema.columns WHERE table_name='sitenex_deals' ORDER BY 1`)).rows.map(r => r.column_name);
    check('sitenex_deals has partner_id', cols.includes('partner_id'), true);
    check('and referred_by is gone', cols.includes('referred_by'), false);
    check('users has partner_id', (await query(`SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_name='users' AND column_name='partner_id'`)).rows[0].n, 1);

    console.log('\n4. ROW-LEVEL DEAL SCOPING, with two real partner rows');
    partnerBId = (await query(`INSERT INTO partners (name, primary_contact_email) VALUES ('VERIFY Partner B','b@example.invalid') ON CONFLICT (name) DO UPDATE SET status='active' RETURNING id`)).rows[0].id;
    const pb = partnerBId;
    const mk = async (label, partnerId) => {
      const id = crypto.randomUUID();
      await query(`INSERT INTO users (id,email,name,role,is_active,joined_at,permissions_version,partner_id)
                   VALUES ($1,$2,$3,'partner',1,NOW(),1,$4)`, [id, `verify-${label}-${Date.now()}@example.invalid`, label, partnerId]);
      await query(`INSERT INTO user_products (user_id, product, granted_by) VALUES ($1,'sitenex','verify') ON CONFLICT DO NOTHING`, [id]);
      fixtures.push(id);
      return { id, email: `v-${label}`, role: 'partner' };
    };
    const ua = await mk('partnerA', pt[0].id);
    const ub = await mk('partnerB', pb);
    // one deal each, plus a self-sourced one
    for (const [pid, note] of [[pt[0].id, 'A'], [pb, 'B'], [null, 'self']]) {
      const r = await query(`INSERT INTO sitenex_deals (status, partner_id, created_at, updated_at)
                             VALUES ('new',$1,NOW(),NOW()) RETURNING id`, [pid]);
      dealIds.push(r.rows[0].id);
    }
    const idsOf = (b) => (b.columns || []).flatMap(c => c.deals.map(d => d.id)).sort((x, y) => x - y);
    const ra = await hit('/api/sitenex/deals', ua);
    const rb = await hit('/api/sitenex/deals', ub);
    check('partner A sees exactly their own 1 deal', idsOf(ra.body), [dealIds[0]]);
    check('partner B sees exactly their own 1 deal', idsOf(rb.body), [dealIds[1]]);
    check('neither sees the self-sourced deal', [...idsOf(ra.body), ...idsOf(rb.body)].includes(dealIds[2]), false);
    check("both report scope 'own partner only'", [ra.body.scope, rb.body.scope], ['own partner only', 'own partner only']);
    const rs = await hit('/api/sitenex/deals', sup);
    check('staff see all three', idsOf(rs.body).length >= 3, true);
    // Prospects are now TERRITORY-scoped rather than refused (2026-10-01). This fixture holds no territory,
    // so it reaches the route and sees nothing — the fail-closed half, which is the half worth checking live.
    const pr = await hit('/api/sitenex/prospects', ua);
    check('a partner reaches SiteNex Prospects', pr.status, 200);
    check('  and sees none, holding no territory', (pr.body && pr.body.total), 0);
  } catch (e) { fail++; console.error('ERROR:', e.message); }
  finally {
    for (const id of fixtures) {
      await query(`DELETE FROM user_products WHERE user_id=$1`, [id]).catch(() => {});
      await query(`DELETE FROM product_shadow_log WHERE user_id=$1`, [id]).catch(() => {});
      await query(`DELETE FROM user_product_grants_log WHERE user_id=$1`, [id]).catch(() => {});
      await query(`DELETE FROM users WHERE id=$1 AND email LIKE 'verify-%'`, [id]).catch(() => {});
    }
    // BY ID. The three deals this script inserted, and nothing else — the previous version's second clause
    // (`partner_id IS NULL AND status='new' AND created_at > NOW() - INTERVAL '10 minutes'`) matched any
    // unassigned new deal in that window, whoever made it.
    for (const id of dealIds) await query(`DELETE FROM sitenex_deals WHERE id=$1`, [id]).catch(() => {});
    if (partnerBId) await query(`DELETE FROM partners WHERE id=$1`, [partnerBId]).catch(() => {});
    const leakU = (await query(`SELECT COUNT(*)::int n FROM users WHERE email LIKE 'verify-partner%'`)).rows[0].n;
    // MY rows, not the tables. `sitenex_deals` being empty and `partners` holding exactly 1 are facts about
    // today; the moment a real deal or a second partner exists, an assertion on those numbers fails forever
    // and the obvious fix is to widen the DELETE above.
    const leakD = dealIds.length
      ? (await query(`SELECT COUNT(*)::int n FROM sitenex_deals WHERE id = ANY($1)`, [dealIds])).rows[0].n : 0;
    const leakP = partnerBId
      ? (await query(`SELECT COUNT(*)::int n FROM partners WHERE id = $1`, [partnerBId])).rows[0].n : 0;
    console.log(`\ncleanup: ${leakU} user(s), ${leakD} of my ${dealIds.length} deal(s), ${leakP} partner row(s) left behind`);
    if (leakU || leakD || leakP) fail++;
    console.log(fail === 0 ? '\n✅ ALL CHECKS PASSED — rename complete, partners are records, deals are partner-scoped'
                           : `\n❌ ${fail} CHECK(S) FAILED`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
