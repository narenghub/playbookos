// ── SiteNex Phase 3, END TO END against the real database (self-cleaning) ──────
//
// What a module test cannot settle, and this can:
//   • the new COLUMNS exist with the types the code assumes (a fake agrees with either answer);
//   • a BYTEA round-trip really returns the bytes that went in — the first BYTEA column in this repo;
//   • the SEQUENCE hands out distinct numbers;
//   • the ROUTES return the shape the UI reads (a module test cannot see a route dropping a field, which
//     is how the outreach → deal link once worked and was invisible);
//   • the contract document really is a .docx with the client's details in it.
//
// CLEANUP IS BY EXPLICIT ID, and it asserts only that ITS OWN rows are gone — never that a table is
// empty. See CLAUDE.md: a verification that demands an empty table fails for ever once the product is
// used, and the obvious fix is to widen the DELETE.
//
// Run:  railway ssh 'node scripts/verify-sitenex-phase3-live.js'

const jwt = require('jsonwebtoken');
const AdmZip = require('adm-zip');
const { query } = require('../src/lib/db');

const PORT = process.env.PORT || 3000;
let fail = 0;
const made = { deals: [], contracts: [], partners: [], users: [] };

const check = (label, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : `  → expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`}`);
};
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? '✅' : '❌'} ${label}${cond ? '' : '  → ' + detail}`); };

const hit = async (method, path, token, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch (_) {}
  return { status: r.status, body: j || {}, raw: text, ctype: r.headers.get('content-type') };
};

(async () => {
  try {
    const sup = (await query(`SELECT id, email, role FROM users WHERE role='super_admin' AND is_active=1 LIMIT 1`)).rows[0];
    if (!sup) throw new Error('no active super_admin to act as');
    const staffToken = jwt.sign({ id: sup.id, email: sup.email, role: sup.role }, process.env.JWT_SECRET, { expiresIn: '10m' });

    console.log('0. THE SCHEMA IS WHAT THE CODE ASSUMES');
    const cols = Object.fromEntries((await query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name='sitenex_deals'`)).rows.map(r => [r.column_name, r]));
    for (const c of ['company_name', 'contact_name', 'contact_email', 'client_address', 'terms_note']) {
      ok(`sitenex_deals.${c} is nullable text`, cols[c] && cols[c].data_type === 'text' && cols[c].is_nullable === 'YES',
         JSON.stringify(cols[c]));
    }
    ok('starts_at_intake is boolean', cols.starts_at_intake && cols.starts_at_intake.data_type === 'boolean',
       JSON.stringify(cols.starts_at_intake));
    const fb = (await query(`SELECT data_type FROM information_schema.columns
      WHERE table_name='sitenex_contracts' AND column_name='file_bytes'`)).rows[0];
    check('sitenex_contracts.file_bytes is bytea', fb && fb.data_type, 'bytea');

    console.log('\n1. FIXTURES — two partners, so "sees only their own" is a real assertion');
    const mkPartner = async (name) => {
      const id = (await query(
        `INSERT INTO partners (name, primary_contact_email) VALUES ($1,$2)
         ON CONFLICT (name) DO UPDATE SET status='active' RETURNING id`,
        [name, name.toLowerCase().replace(/\W+/g, '') + '@example.invalid'])).rows[0].id;
      made.partners.push(id); return id;
    };
    const pa = await mkPartner('VERIFY P3 Partner A');
    const pb = await mkPartner('VERIFY P3 Partner B');
    const mkUser = async (label, partnerId) => {
      const id = require('crypto').randomUUID();
      const email = `verify-p3-${label}-${Date.now()}@example.invalid`;
      await query(`INSERT INTO users (id,email,name,role,is_active,joined_at,permissions_version,partner_id)
                   VALUES ($1,$2,$3,'partner',1,NOW(),1,$4)`, [id, email, 'P3 ' + label, partnerId]);
      await query(`INSERT INTO user_products (user_id, product) VALUES ($1,'sitenex') ON CONFLICT DO NOTHING`, [id]);
      made.users.push(id);
      return { id, email, token: jwt.sign({ id, email, role: 'partner' }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
    };
    const ua = await mkUser('a', pa);
    const ub = await mkUser('b', pb);
    console.log(`     partners ${pa}/${pb}, users ${ua.email} / ${ub.email}`);

    console.log('\n2. THE WRITE PATH — and partner_id never from the body');
    const d1 = await hit('POST', '/api/sitenex/deals', staffToken, {
      company_name: 'VERIFY Acme Machine Works LLC', contact_name: 'Dale Prentice', contact_title: 'Owner',
      contact_email: 'dale@verify.invalid', contact_phone: '(815) 555-0142',
      client_address: '412 W Main St, Rockford, IL 61101', package_code: 'P2',
      duration_weeks: 3, value_cents: 450000, monthly_cents: 9900,
      partner_id: pb });                                  // ← must be IGNORED
    check('POST creates a deal', d1.status, 201);
    if (d1.body.deal) made.deals.push(d1.body.deal.id);
    check('  and partner_id from the BODY was ignored', d1.body.deal && d1.body.deal.partner_id, null);
    check('  starts_at_intake defaulted TRUE', d1.body.deal && d1.body.deal.starts_at_intake, true);
    const dealId = d1.body.deal && d1.body.deal.id;

    // One deal in each partner's book, written directly so the scoping test has something to scope.
    const mkDeal = async (partnerId, company, value) => {
      const id = (await query(
        `INSERT INTO sitenex_deals (partner_id, owner_user_id, status, package_code, company_name,
           contact_name, contact_email, client_address, duration_weeks, value_cents, created_at, updated_at)
         VALUES ($1,$2,'new','P2',$3,'A Person','p@example.invalid','1 Test St, Chicago, IL',3,$4,NOW(),NOW())
         RETURNING id`, [partnerId, sup.id, company, value])).rows[0].id;
      made.deals.push(id); return id;
    };
    const dA = await mkDeal(pa, 'VERIFY A Client', 100000);
    const dB = await mkDeal(pb, 'VERIFY B Client', 700000);

    console.log('\n3. SCOPING — in the WHERE, including the single-row read');
    const idsOf = (b) => (b.columns || []).flatMap(c => c.deals.map(x => x.id));
    const boardA = await hit('GET', '/api/sitenex/deals', ua.token);
    const boardB = await hit('GET', '/api/sitenex/deals', ub.token);
    check("partner A's board holds their deal", idsOf(boardA.body).includes(dA), true);
    check("  and NOT partner B's", idsOf(boardA.body).includes(dB), false);
    check("partner B's board holds theirs and not A's",
          [idsOf(boardB.body).includes(dB), idsOf(boardB.body).includes(dA)], [true, false]);
    check('  neither sees the self-sourced one', [idsOf(boardA.body).includes(dealId), idsOf(boardB.body).includes(dealId)], [false, false]);
    check("the single-row read is scoped too", (await hit('GET', `/api/sitenex/deals/${dA}`, ub.token)).status, 404);
    check('  and open to the partner who owns it', (await hit('GET', `/api/sitenex/deals/${dA}`, ua.token)).status, 200);
    check('a partner cannot WRITE', (await hit('POST', '/api/sitenex/deals', ua.token, { company_name: 'X' })).status, 403);

    console.log('\n4. THE PAYMENT SCHEDULE — the sum rule, in the handler');
    const bad = await hit('PUT', `/api/sitenex/deals/${dealId}/payments`, staffToken,
      { payments: [{ label: 'Deposit', amount_cents: 225000, due_trigger: 'on_signature' }] });
    check('an unbalanced schedule is refused', [bad.status, bad.body.code], [400, 'unbalanced_schedule']);
    check('  and nothing was written',
          (await query(`SELECT COUNT(*)::int n FROM sitenex_deal_payments WHERE deal_id=$1`, [dealId])).rows[0].n, 0);
    const good = await hit('PUT', `/api/sitenex/deals/${dealId}/payments`, staffToken, { payments: [
      { label: 'Deposit', amount_cents: 225000, due_trigger: 'on_signature' },
      { label: 'On launch', amount_cents: 225000, due_trigger: 'on_launch' }] });
    check('a balanced schedule is accepted', [good.status, good.body.total_cents], [200, 450000]);
    check('  two rows, seq 1 and 2', good.body.payments.map(p => p.seq), [1, 2]);

    console.log('\n5. THE CONTRACT — a real .docx, in Postgres, with the right words in it');
    const c1 = await hit('POST', '/api/sitenex/contracts', staffToken, { deal_id: dealId });
    check('generated', c1.status, 201);
    if (c1.body.contract) made.contracts.push(c1.body.contract.id);
    const no1 = c1.body.contract && c1.body.contract.contract_no;
    ok('numbered SN-YYYY-NNNN', /^SN-\d{4}-\d{4}$/.test(no1 || ''), String(no1));
    ok('the file is more than a stub', (c1.body.contract && c1.body.contract.file_size) > 5000,
       String(c1.body.contract && c1.body.contract.file_size));

    // BYTEA ROUND TRIP. The first BYTEA column here, so this is the check that it behaves.
    const stored = (await query(`SELECT file_bytes, file_size, client_company, package_name, payments
                                   FROM sitenex_contracts WHERE id=$1`, [c1.body.contract.id])).rows[0];
    ok('the stored value is a Buffer', Buffer.isBuffer(stored.file_bytes), typeof stored.file_bytes);
    check('  byte length matches what we recorded', stored.file_bytes.length, stored.file_size);
    check('  and it is a zip (a .docx is one)', stored.file_bytes.subarray(0, 4).toString('hex'), '504b0304');
    const text = new AdmZip(stored.file_bytes).readAsText('word/document.xml').replace(/<[^>]+>/g, ' ');
    for (const probe of ['VERIFY Acme Machine Works LLC', 'Dale Prentice', '412 W Main St', no1,
                         'NOT BEEN REVIEWED BY AN ATTORNEY', '4,500', '2,250']) {
      ok(`  the document says "${String(probe).slice(0, 34)}"`, text.includes(probe), 'absent');
    }
    ok('  and contains no unresolved placeholder', !/\{\{/.test(text), 'a {{placeholder}} reached the document');
    check('the SNAPSHOT copied the client, not a join', stored.client_company, 'VERIFY Acme Machine Works LLC');
    ok('  and the schedule as signed', Array.isArray(stored.payments) && stored.payments.length === 2,
       JSON.stringify(stored.payments));

    console.log('\n6. REGENERATION — a new row, the old one superseded, never overwritten');
    const c2 = await hit('POST', '/api/sitenex/contracts', staffToken, { deal_id: dealId });
    check('a second contract is created', c2.status, 201);
    if (c2.body.contract) made.contracts.push(c2.body.contract.id);
    ok('  with a DIFFERENT number (the sequence works)', c2.body.contract.contract_no !== no1,
       `${no1} vs ${c2.body.contract.contract_no}`);
    const old = (await query(`SELECT status, superseded_by FROM sitenex_contracts WHERE id=$1`, [c1.body.contract.id])).rows[0];
    check('  the first is superseded, naming its replacement', [old.status, old.superseded_by],
          ['superseded', c2.body.contract.id]);

    console.log('\n7. THE DOWNLOAD — the bytes come back over HTTP, and are scoped');
    const dl = await fetch(`http://127.0.0.1:${PORT}/api/sitenex/contracts/${c2.body.contract.id}/file`,
      { headers: { Authorization: 'Bearer ' + staffToken } });
    check('200 with the Word content type', [dl.status, /wordprocessingml/.test(dl.headers.get('content-type') || '')], [200, true]);
    const got = Buffer.from(await dl.arrayBuffer());
    check('  the bytes survive the round trip intact', got.subarray(0, 4).toString('hex'), '504b0304');
    const dl401 = await fetch(`http://127.0.0.1:${PORT}/api/sitenex/contracts/${c2.body.contract.id}/file`);
    check('  and a bare request with NO header is 401 (so a plain href cannot work)', dl401.status, 401);
    check("  a partner cannot download a self-sourced contract",
          (await hit('GET', `/api/sitenex/contracts/${c2.body.contract.id}/file`, ua.token)).status, 404);

    console.log('\n8. THE REGISTER AND ITS TOTALS');
    await query(`UPDATE sitenex_contracts SET status='signed' WHERE id=$1`, [c2.body.contract.id]);
    const reg = await hit('GET', '/api/sitenex/contracts', staffToken);
    check('the register reads', reg.status, 200);
    const mine = (reg.body.contracts || []).filter(c => made.contracts.includes(c.id));
    check('  both of my contracts are in it', mine.length, 2);
    ok('  signed one-time includes mine', reg.body.totals.signed_one_time_cents >= 450000,
       String(reg.body.totals.signed_one_time_cents));
    ok('  annualised = one-time + 12 × monthly',
       reg.body.totals.annualised_cents === reg.body.totals.signed_one_time_cents + reg.body.totals.signed_monthly_cents * 12,
       JSON.stringify(reg.body.totals));
    ok('  the superseded one is counted as superseded', reg.body.totals.superseded_count >= 1,
       String(reg.body.totals.superseded_count));

    console.log('\n9. THE CALL SCRIPT, from a real scored prospect');
    const p = (await query(
      `SELECT id, name FROM prospects WHERE product='sitenex' AND site_score IS NOT NULL
         AND site_findings->>'unscannable' IS NULL ORDER BY site_score DESC LIMIT 1`)).rows[0];
    if (!p) { console.log('  ↷  no scored sitenex prospect to use'); }
    else {
      const sc = await hit('GET', `/api/sitenex/prospects/${p.id}/content`, staffToken);
      check(`content for "${p.name}"`, sc.status, 200);
      ok('  an opening', (sc.body.call.opening || '').length > 30, sc.body.call.opening);
      ok('  findings, ranked', Array.isArray(sc.body.call.what_they_have) && sc.body.call.what_they_have.length > 0, '');
      ok('  the exclusions, for the caller', Array.isArray(sc.body.call.what_this_is_not), '');
      ok('  objections', (sc.body.call.objections || []).length >= 4, '');
      ok('  an email with a subject and a body', !!(sc.body.email.subject && sc.body.email.body), '');
      ok('  and NO greeting or sign-off in the body',
         !/^(hi|hello|dear)\b/i.test(sc.body.email.body) && !/regards|sincerely/i.test(sc.body.email.body), '');
      check('  priced:false while packages are unpriced', sc.body.call.priced, false);
    }
  } catch (e) { fail++; console.error('ERROR:', e.message, e.stack ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : ''); }
  finally {
    // BY ID. Children first, so the FKs allow it. Nothing here deletes by time or by pattern.
    for (const id of made.contracts) await query(`DELETE FROM sitenex_contracts WHERE id=$1`, [id]).catch(() => {});
    for (const id of made.deals) {
      await query(`DELETE FROM sitenex_deal_payments WHERE deal_id=$1`, [id]).catch(() => {});
      await query(`DELETE FROM sitenex_contracts WHERE deal_id=$1`, [id]).catch(() => {});
      await query(`DELETE FROM sitenex_deals WHERE id=$1`, [id]).catch(() => {});
    }
    for (const id of made.users) {
      await query(`DELETE FROM user_products WHERE user_id=$1`, [id]).catch(() => {});
      await query(`DELETE FROM user_product_grants_log WHERE user_id=$1`, [id]).catch(() => {});
      await query(`DELETE FROM product_shadow_log WHERE user_id=$1`, [id]).catch(() => {});
      await query(`DELETE FROM users WHERE id=$1 AND email LIKE 'verify-p3-%'`, [id]).catch(() => {});
    }
    for (const id of made.partners) await query(`DELETE FROM partners WHERE id=$1`, [id]).catch(() => {});

    // Only MY rows. "the table is empty" is a fact about today, not a property of this script.
    let left = 0;
    const count = async (sql, p) => (await query(sql, p)).rows[0].n;
    for (const id of made.deals) left += await count(`SELECT COUNT(*)::int n FROM sitenex_deals WHERE id=$1`, [id]);
    for (const id of made.contracts) left += await count(`SELECT COUNT(*)::int n FROM sitenex_contracts WHERE id=$1`, [id]);
    for (const id of made.users) left += await count(`SELECT COUNT(*)::int n FROM users WHERE id=$1`, [id]);
    for (const id of made.partners) left += await count(`SELECT COUNT(*)::int n FROM partners WHERE id=$1`, [id]);
    console.log(`\ncleanup: ${made.deals.length} deal(s), ${made.contracts.length} contract(s), `
      + `${made.users.length} user(s), ${made.partners.length} partner(s) removed; ${left} of mine remain`);
    if (left) fail++;
    console.log(fail === 0 ? '\n✅ ALL CHECKS PASSED — the write path, the schedule rule, and a real .docx in Postgres'
                           : `\n❌ ${fail} CHECK(S) FAILED`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
