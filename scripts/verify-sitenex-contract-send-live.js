// ── Emailing a contract: verified against the real database (self-cleaning) ─────
//
// DEFAULT IS A DRY RUN. It exercises everything up to the provider call — the preview, every refusal, the
// confirmation requirement, the scoping, the status/sent_at transaction and the send log — by substituting
// the mailer. Nothing leaves the building.
//
//   railway ssh 'node scripts/verify-sitenex-contract-send-live.js'              # dry run
//   railway ssh 'node scripts/verify-sitenex-contract-send-live.js --send <addr>' # ONE real email
//
// The --send form sends exactly one email, to an address given on the command line, and refuses a bare
// --send with no address. There is no default recipient on purpose: a verification script with a hardcoded
// address is one edit away from mailing a real client.
//
// Cleanup is BY EXPLICIT ID and asserts only that its own rows are gone.

const jwt = require('jsonwebtoken');
const AdmZip = require('adm-zip');
const { query } = require('../src/lib/db');
const mailer = require('../src/lib/mailer');

const PORT = process.env.PORT || 3000;
const args = process.argv.slice(2);
const sendIdx = args.indexOf('--send');
const REAL_TO = sendIdx !== -1 ? args[sendIdx + 1] : null;
if (sendIdx !== -1 && (!REAL_TO || REAL_TO.startsWith('--') || !/@/.test(REAL_TO))) {
  console.error('⛔ --send needs an email address: --send you@yourdomain.com');
  console.error('   There is no default. A verification with a hardcoded recipient is one edit away from');
  console.error('   mailing a real client.');
  process.exit(2);
}

let fail = 0;
const made = { deals: [], contracts: [], partners: [], users: [] };
const SENT = [];

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
  return { status: r.status, body: j || {}, raw: text };
};

// THE MAILER IS REPLACED unless --send was given. Replaced rather than relying on a missing API key,
// because the key IS present in production and the whole point of running this there is to use the real
// database — so the one thing that must not be real is the provider call.
const realSend = mailer.sendEmailDetailed;
if (!REAL_TO) {
  mailer.sendEmailDetailed = async (opts) => {
    SENT.push(opts);
    return { ok: true, id: 'dryrun_' + Date.now(), error: null };
  };
} else {
  mailer.sendEmailDetailed = async (opts) => {
    SENT.push(opts);
    return realSend(opts);
  };
}

(async () => {
  try {
    console.log(REAL_TO ? `MODE: REAL SEND, once, to ${REAL_TO}\n` : 'MODE: dry run — the mailer is substituted, nothing is sent\n');

    const sup = (await query(`SELECT id, email, role FROM users WHERE role='super_admin' AND is_active=1 LIMIT 1`)).rows[0];
    if (!sup) throw new Error('no active super_admin to act as');
    const staff = jwt.sign({ id: sup.id, email: sup.email, role: sup.role }, process.env.JWT_SECRET, { expiresIn: '10m' });

    console.log('0. THE SCHEMA');
    const sa = (await query(`SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name='sitenex_contracts' AND column_name='sent_at'`)).rows[0];
    ok('sitenex_contracts.sent_at is a nullable timestamptz',
       sa && /timestamp with time zone/.test(sa.data_type) && sa.is_nullable === 'YES', JSON.stringify(sa));
    const sc = (await query(`SELECT column_name FROM information_schema.columns
      WHERE table_name='sitenex_contract_sends'`)).rows.map(r => r.column_name);
    for (const c of ['contract_id', 'to_email', 'cc_email', 'from_email', 'subject', 'status', 'provider_id', 'sent_by', 'sent_at']) {
      ok(`sitenex_contract_sends.${c}`, sc.includes(c), 'missing');
    }

    console.log('\n1. A DEAL AND A CONTRACT, with a partner on it');
    const pid = (await query(
      `INSERT INTO partners (name, primary_contact_email) VALUES ('VERIFY SEND Partner','verify-send-partner@example.invalid')
       ON CONFLICT (name) DO UPDATE SET status='active' RETURNING id`)).rows[0].id;
    made.partners.push(pid);
    const clientEmail = REAL_TO || 'verify-send-client@example.invalid';
    const dealId = (await query(
      `INSERT INTO sitenex_deals (partner_id, owner_user_id, status, package_code, company_name, contact_name,
         contact_title, contact_email, client_address, duration_weeks, value_cents, monthly_cents, created_at, updated_at)
       VALUES ($1,$2,'proposal_sent','P2','VERIFY SEND Client Ltd','Test Recipient','Owner',$3,
               '1 Verify St, Chicago, IL 60601',3,450000,9900,NOW(),NOW()) RETURNING id`,
      [pid, sup.id, clientEmail])).rows[0].id;
    made.deals.push(dealId);
    await query(`INSERT INTO sitenex_deal_payments (deal_id, seq, label, amount_cents, due_trigger)
                 VALUES ($1,1,'Deposit',225000,'on_signature'),($1,2,'On launch',225000,'on_launch')`, [dealId]);
    const gen = await hit('POST', '/api/sitenex/contracts', staff, { deal_id: dealId });
    check('contract generated', gen.status, 201);
    const cid = gen.body.contract && gen.body.contract.id;
    if (cid) made.contracts.push(cid);
    const no = gen.body.contract && gen.body.contract.contract_no;

    console.log('\n2. THE PREVIEW — what a send WOULD do, before one happens');
    const pv = await hit('GET', `/api/sitenex/contracts/${cid}/send`, staff);
    check('preview reads', pv.status, 200);
    check('  to = the snapshotted client email', pv.body.to, clientEmail);
    check('  cc = the partner on the contract', pv.body.cc, 'verify-send-partner@example.invalid');
    ok('  from is the AUTHORIZED domain', /adificetechnologies\.com/.test(pv.body.from || ''), pv.body.from);
    ok('  the subject names the contract', (pv.body.subject || '').includes(no), pv.body.subject);
    ok('  the price the note will state', /\$4,500/.test(pv.body.price || ''), pv.body.price);
    check('  can_send', pv.body.can_send, true);
    check('  and NOTHING was sent by a preview', SENT.length, 0);

    console.log('\n3. THE REFUSALS');
    const noConfirm = await hit('POST', `/api/sitenex/contracts/${cid}/send`, staff, {});
    check('no confirm_to → refused, naming the address', [noConfirm.status, noConfirm.body.code, noConfirm.body.to],
          [400, 'confirm_mismatch', clientEmail]);
    const wrong = await hit('POST', `/api/sitenex/contracts/${cid}/send`, staff, { confirm_to: 'someone@else.invalid' });
    check('wrong confirm_to → refused', [wrong.status, wrong.body.code], [400, 'confirm_mismatch']);
    check('  still nothing sent', SENT.length, 0);
    check('  and nothing logged', (await query(`SELECT COUNT(*)::int n FROM sitenex_contract_sends WHERE contract_id=$1`, [cid])).rows[0].n, 0);
    check('  and the contract is untouched',
          (await query(`SELECT status, sent_at FROM sitenex_contracts WHERE id=$1`, [cid])).rows[0].status, 'generated');

    console.log('\n4. THE SEND');
    const sent = await hit('POST', `/api/sitenex/contracts/${cid}/send`, staff, { confirm_to: clientEmail });
    check('accepted', sent.status, 200);
    if (sent.status !== 200) console.log('     body:', JSON.stringify(sent.body));
    check('  exactly one email', SENT.length, 1);
    const m = SENT[0] || {};
    check('  to', m.to, clientEmail);
    check('  cc', m.cc, 'verify-send-partner@example.invalid');
    ok('  one attachment, named for the contract', m.attachments && m.attachments.length === 1
       && String(m.attachments[0].filename).startsWith(no), JSON.stringify(m.attachments && m.attachments[0] && m.attachments[0].filename));
    // THE ATTACHMENT IS THE STORED DOCUMENT, and it opens.
    const buf = m.attachments[0].content;
    ok('  the attachment is the stored .docx', Buffer.isBuffer(buf) && buf.subarray(0, 4).toString('hex') === '504b0304', 'not a zip');
    const text = new AdmZip(buf).readAsText('word/document.xml').replace(/<[^>]+>/g, ' ');
    ok('  and it really contains the client and the price',
       text.includes('VERIFY SEND Client Ltd') && text.includes('4,500'), 'content missing');
    ok('  the note states the price', /\$4,500/.test(m.html || ''), 'no price in the covering note');
    ok('  the note asks them to sign and return', /sign and return/i.test(m.html || ''), '');
    ok('  provider id came back', !!sent.body.provider_id, JSON.stringify(sent.body));

    console.log('\n5. STATUS AND sent_at, IN ONE TRANSACTION');
    const after = (await query(`SELECT status, sent_at FROM sitenex_contracts WHERE id=$1`, [cid])).rows[0];
    check('  status', after.status, 'sent');
    ok('  sent_at stamped', !!after.sent_at, String(after.sent_at));

    console.log('\n6. THE SEND LOG — proof of what went where');
    const log = (await query(
      `SELECT to_email, cc_email, from_email, subject, file_name, file_size, status, provider_id, error, sent_by
         FROM sitenex_contract_sends WHERE contract_id=$1`, [cid])).rows;
    check('  one row', log.length, 1);
    const L = log[0] || {};
    check('  to', L.to_email, clientEmail);
    check('  cc', L.cc_email, 'verify-send-partner@example.invalid');
    check('  status', L.status, 'sent');
    check('  sent_by', L.sent_by, sup.id);
    ok('  provider id recorded', !!L.provider_id, String(L.provider_id));
    ok('  subject recorded', (L.subject || '').includes(no), L.subject);
    ok('  file name and size recorded', !!L.file_name && L.file_size > 5000, `${L.file_name} / ${L.file_size}`);
    check('  no error on a success', L.error, null);

    console.log('\n7. A SUPERSEDED CONTRACT CANNOT BE SENT');
    const regen = await hit('POST', '/api/sitenex/contracts', staff, { deal_id: dealId });
    if (regen.body.contract) made.contracts.push(regen.body.contract.id);
    check('  regenerated', regen.status, 201);
    const before = SENT.length;
    const stale = await hit('POST', `/api/sitenex/contracts/${cid}/send`, staff, { confirm_to: clientEmail });
    check('  the superseded one refuses', [stale.status, stale.body.code], [400, 'not_current']);
    check('  and sent nothing', SENT.length, before);

    console.log('\n8. SCOPING AND THE GATE');
    const uid = require('crypto').randomUUID();
    const pEmail = `verify-send-user-${Date.now()}@example.invalid`;
    await query(`INSERT INTO users (id,email,name,role,is_active,joined_at,permissions_version,partner_id)
                 VALUES ($1,$2,'Verify Send Partner User','partner',1,NOW(),1,$3)`, [uid, pEmail, pid]);
    await query(`INSERT INTO user_products (user_id, product) VALUES ($1,'sitenex') ON CONFLICT DO NOTHING`, [uid]);
    made.users.push(uid);
    const ptok = jwt.sign({ id: uid, email: pEmail, role: 'partner' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    check('  a partner cannot preview', (await hit('GET', `/api/sitenex/contracts/${regen.body.contract.id}/send`, ptok)).status, 403);
    check('  a partner cannot send', (await hit('POST', `/api/sitenex/contracts/${regen.body.contract.id}/send`, ptok, { confirm_to: clientEmail })).status, 403);
    check('  but can still list and download', (await hit('GET', '/api/sitenex/contracts', ptok)).status, 200);
    check('  and nothing was sent by any of that', SENT.length, before);

    if (REAL_TO) {
      console.log(`\n📧 ONE REAL EMAIL WAS SENT to ${REAL_TO} — check that inbox. Provider id: ${sent.body.provider_id}`);
    }
  } catch (e) { fail++; console.error('ERROR:', e.message, e.stack ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : ''); }
  finally {
    mailer.sendEmailDetailed = realSend;
    for (const id of made.contracts) {
      await query(`DELETE FROM sitenex_contract_sends WHERE contract_id=$1`, [id]).catch(() => {});
      await query(`DELETE FROM sitenex_contracts WHERE id=$1`, [id]).catch(() => {});
    }
    for (const id of made.deals) {
      await query(`DELETE FROM sitenex_deal_payments WHERE deal_id=$1`, [id]).catch(() => {});
      await query(`DELETE FROM sitenex_contracts WHERE deal_id=$1`, [id]).catch(() => {});
      await query(`DELETE FROM sitenex_deals WHERE id=$1`, [id]).catch(() => {});
    }
    for (const id of made.users) {
      await query(`DELETE FROM user_products WHERE user_id=$1`, [id]).catch(() => {});
      await query(`DELETE FROM users WHERE id=$1 AND email LIKE 'verify-send-%'`, [id]).catch(() => {});
    }
    for (const id of made.partners) await query(`DELETE FROM partners WHERE id=$1`, [id]).catch(() => {});

    let left = 0;
    for (const id of made.contracts) left += (await query(`SELECT COUNT(*)::int n FROM sitenex_contracts WHERE id=$1`, [id])).rows[0].n;
    for (const id of made.deals) left += (await query(`SELECT COUNT(*)::int n FROM sitenex_deals WHERE id=$1`, [id])).rows[0].n;
    for (const id of made.users) left += (await query(`SELECT COUNT(*)::int n FROM users WHERE id=$1`, [id])).rows[0].n;
    for (const id of made.partners) left += (await query(`SELECT COUNT(*)::int n FROM partners WHERE id=$1`, [id])).rows[0].n;
    console.log(`\ncleanup: ${made.contracts.length} contract(s), ${made.deals.length} deal(s), `
      + `${made.users.length} user(s), ${made.partners.length} partner(s) removed; ${left} of mine remain`);
    if (left) fail++;
    console.log(fail === 0 ? '\n✅ ALL CHECKS PASSED' : `\n❌ ${fail} CHECK(S) FAILED`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
