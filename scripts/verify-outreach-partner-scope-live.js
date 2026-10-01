// ── PARTNER-SCOPED OUTREACH, against the real database (self-cleaning) ─────────
//
// TWO PARTNERS, because "A sees their own" is satisfied by a query that returns everything when only one
// partner has data. The second fixture is what makes every assertion here mean something.
//
// What only a live run can settle: that the expression unique index really lets two partners hold a record on
// ONE prospect while still refusing two staff rows, and that every HTTP route returns the scoped answer — a
// module test cannot see a route that forgets to pass the scope.
//
// Run:  railway ssh 'node scripts/verify-outreach-partner-scope-live.js'

const jwt = require('jsonwebtoken');
const { query } = require('../src/lib/db');
const PORT = process.env.PORT || 3000;
const made = { partners: [], users: [], outreach: [] };
let fail = 0;
const ck = (l, a, e) => { const ok = JSON.stringify(a) === JSON.stringify(e); if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${l}${ok ? '' : `  → expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`}`); };
const ok = (l, c, d) => { if (!c) fail++; console.log(`  ${c ? '✅' : '❌'} ${l}${c ? '' : '  → ' + d}`); };

(async () => {
  try {
    const sup = (await query(`SELECT id,email,role FROM users WHERE role='super_admin' AND is_active=1 LIMIT 1`)).rows[0];
    const staff = jwt.sign({ id: sup.id, email: sup.email, role: sup.role }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const hit = async (m, p, tok, b) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: m,
        headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: b === undefined ? undefined : JSON.stringify(b) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };

    // Two partners, each with a user and the SAME territory so both can legitimately reach one prospect.
    const mkP = async (n) => { const id = (await query(`INSERT INTO partners (name) VALUES ($1)
      ON CONFLICT (name) DO UPDATE SET status='active' RETURNING id`, [n])).rows[0].id; made.partners.push(id); return id; };
    const pa = await mkP('VERIFY OS A'), pb = await mkP('VERIFY OS B');
    const mkU = async (l, pid) => {
      const id = require('crypto').randomUUID();
      const email = `verify-os-${l}-${Date.now()}@example.invalid`;
      await query(`INSERT INTO users (id,email,name,role,is_active,joined_at,permissions_version,partner_id)
                   VALUES ($1,$2,$3,'partner',1,NOW(),1,$4)`, [id, email, 'OS ' + l, pid]);
      await query(`INSERT INTO user_products (user_id,product) VALUES ($1,'sitenex') ON CONFLICT DO NOTHING`, [id]);
      made.users.push(id);
      return jwt.sign({ id, email, role: 'partner' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    };
    const ua = await mkU('a', pa), ub = await mkU('b', pb);
    // A SHARED (non-exclusive) territory, which is exactly the case where two partners can reach one prospect.
    const p = (await query(`SELECT id, name, region FROM prospects WHERE product='sitenex'
      AND region IS NOT NULL AND status='qualified' LIMIT 1`)).rows[0];
    for (const pid of [pa, pb]) {
      await query(`INSERT INTO partner_territories (partner_id, dimension, value, exclusive, created_by)
                   VALUES ($1,'region',$2,FALSE,$3) ON CONFLICT DO NOTHING`, [pid, p.region, sup.id]);
    }
    console.log(`fixtures: partners ${pa}/${pb}, both on region '${p.region}', prospect ${p.id} (${p.name})\n`);

    console.log('1. BOTH partners record on the SAME prospect');
    const wa = await hit('PUT', '/api/outreach', ua,
      { entity_type: 'prospect', entity_id: p.id, status: 'contacted', note: 'A rang them', channel: 'phone' });
    ck('A writes', [wa.status, wa.body.to], [200, 'contacted']);
    const wb = await hit('PUT', '/api/outreach', ub,
      { entity_type: 'prospect', entity_id: p.id, status: 'quote_sent', note: 'B sent a price', channel: 'email' });
    ck('B writes', [wb.status, wb.body.to], [200, 'quote_sent']);
    const rows = (await query(
      `SELECT id, partner_id, status, note FROM outreach WHERE entity_type='prospect' AND entity_id=$1
        ORDER BY partner_id`, [String(p.id)])).rows;
    rows.forEach(r => made.outreach.push(r.id));
    ck('  TWO rows exist, one per partner', rows.length, 2);
    ck('  and they are theirs', rows.map(r => r.partner_id), [pa, pb]);
    ok("  A's note was not overwritten by B", rows[0].note === 'A rang them' && rows[1].note === 'B sent a price',
       JSON.stringify(rows.map(r => r.note)));

    console.log('\n2. A NEVER SEES B');
    const ra = await hit('GET', `/api/outreach?entity_type=prospect&ids=${p.id}`, ua);
    const rb = await hit('GET', `/api/outreach?entity_type=prospect&ids=${p.id}`, ub);
    ck('A reads their own status', ra.body.statuses[String(p.id)].status, 'contacted');
    ck('B reads theirs', rb.body.statuses[String(p.id)].status, 'quote_sent');
    ck("  A's note is A's", ra.body.statuses[String(p.id)].note, 'A rang them');
    ck("  B's note is B's", rb.body.statuses[String(p.id)].note, 'B sent a price');
    const ha = await hit('GET', `/api/outreach/history?entity_type=prospect&entity_id=${p.id}`, ua);
    const hb = await hit('GET', `/api/outreach/history?entity_type=prospect&entity_id=${p.id}`, ub);
    ck("A's history is one event", (ha.body.events || []).length, 1);
    ck("B's history is one event", (hb.body.events || []).length, 1);
    ok("  and A's event is not B's", (ha.body.events[0] || {}).note === 'A rang them', JSON.stringify(ha.body.events));
    const sa = await hit('GET', '/api/outreach/summary?entity_type=prospect&total=100', ua);
    ck("A's funnel counts A's row", sa.body.counts.contacted, 1);
    ck("  and NOT B's", sa.body.counts.quote_sent, 0);
    const aa = await hit('GET', '/api/outreach/activity?days=7', ua);
    ck("A's activity counts one touch", (aa.body.rows || []).reduce((n, r) => n + r.n, 0), 1);
    const oa = await hit('GET', '/api/outreach/overview?days=7', ua);
    ck("A's overview too", oa.body.total_events, 1);

    console.log('\n3. STAFF SEE BOTH');
    const sAll = await hit('GET', '/api/outreach/activity?days=7', staff);
    const mine = (sAll.body.rows || []).filter(r => /verify-os-/.test(r.by_email || ''));
    ck('staff see both partners\' touches', mine.reduce((n, r) => n + r.n, 0), 2);

    console.log('\n4. THE DATABASE STILL REFUSES TWO STAFF ROWS FOR ONE ENTITY');
    const ws = await hit('PUT', '/api/outreach', staff,
      { entity_type: 'prospect', entity_id: p.id, status: 'contacted', note: 'ours' });
    ck('staff write succeeds', ws.status, 200);
    const after = (await query(`SELECT id, partner_id FROM outreach WHERE entity_type='prospect' AND entity_id=$1`,
      [String(p.id)])).rows;
    after.forEach(r => { if (!made.outreach.includes(r.id)) made.outreach.push(r.id); });
    ck('  now THREE rows: two partners and ours', after.length, 3);
    const ws2 = await hit('PUT', '/api/outreach', staff,
      { entity_type: 'prospect', entity_id: p.id, status: 'won', note: 'ours again' });
    ck('a SECOND staff write UPDATES rather than inserting', ws2.status, 200);
    const after2 = (await query(`SELECT COUNT(*)::int n FROM outreach WHERE entity_type='prospect' AND entity_id=$1`,
      [String(p.id)])).rows[0].n;
    ck('  still three rows', after2, 3);
    ok('  and ours now reads won',
       (await query(`SELECT status FROM outreach WHERE entity_type='prospect' AND entity_id=$1 AND partner_id IS NULL`,
         [String(p.id)])).rows[0].status === 'won', 'the staff row did not update');
    ck("  and A's is untouched",
       (await query(`SELECT status FROM outreach WHERE entity_type='prospect' AND entity_id=$1 AND partner_id=$2`,
         [String(p.id), pa])).rows[0].status, 'contacted');
  } catch (e) { fail++; console.error('ERROR:', e.message, (e.stack || '').split('\n')[1]); }
  finally {
    for (const id of made.outreach) await query(`DELETE FROM outreach WHERE id=$1`, [id]).catch(() => {});
    for (const id of made.users) {
      await query(`DELETE FROM user_products WHERE user_id=$1`, [id]).catch(() => {});
      await query(`DELETE FROM users WHERE id=$1 AND email LIKE 'verify-os-%'`, [id]).catch(() => {});
    }
    for (const id of made.partners) await query(`DELETE FROM partners WHERE id=$1`, [id]).catch(() => {});
    let left = 0;
    for (const id of made.outreach) left += (await query(`SELECT COUNT(*)::int n FROM outreach WHERE id=$1`, [id])).rows[0].n;
    for (const id of made.users) left += (await query(`SELECT COUNT(*)::int n FROM users WHERE id=$1`, [id])).rows[0].n;
    for (const id of made.partners) left += (await query(`SELECT COUNT(*)::int n FROM partners WHERE id=$1`, [id])).rows[0].n;
    console.log(`\ncleanup: ${made.outreach.length} outreach row(s), ${made.users.length} user(s), `
      + `${made.partners.length} partner(s) removed; ${left} of mine remain`);
    if (left) fail++;
    console.log(fail === 0 ? '\n✅ ALL CHECKS PASSED — A never sees B' : `\n❌ ${fail} CHECK(S) FAILED`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
