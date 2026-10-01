// ── Emailing a contract: verified against the real database (self-cleaning) ─────
//
// ⚠️  THE SEND CANNOT BE STUBBED FROM HERE. This script talks to the running server over HTTP, and that is
//     a DIFFERENT PROCESS with its own module instances — so replacing mailer.sendEmailDetailed in this
//     process does nothing to the route. The first version of this file did exactly that, called itself a
//     dry run, and sent a real email to verify-send-client@example.invalid. Resend accepted it and returned
//     a message id; `.invalid` cannot resolve, so it bounced rather than reaching a person, but the script
//     had lied about what it was doing.
//
//     So there is no pretend send. DEFAULT MODE RUNS ONLY THE PARTS THAT DO NOT SEND — the schema, the
//     preview, every refusal, the superseded guard and the partner gate — and says plainly which steps it
//     skipped. The parts that need a send are covered by src/api/sitenex-phase3.test.js, where the mailer
//     IS in the same process and really is substituted.
//
//   railway ssh 'node scripts/verify-sitenex-contract-send-live.js'               # no email is sent
//   railway ssh 'node scripts/verify-sitenex-contract-send-live.js --send <addr>' # ONE real email
//
// The --send form sends exactly one real email, to an address given on the command line, and refuses a bare
// --send. There is no default recipient on purpose: a verification script with a hardcoded address is one
// edit away from mailing a real client.
//
// Cleanup is BY EXPLICIT ID and asserts only that its own rows are gone.

const jwt = require('jsonwebtoken');
const AdmZip = require('adm-zip');
const { query } = require('../src/lib/db');

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

// Deliberately NOT substituting anything. See the header: this process is not the server's, so a
// substitution here would change nothing except what this script believes about itself.

(async () => {
  try {
    console.log(REAL_TO
      ? `MODE: REAL SEND — exactly one email, to ${REAL_TO}\n`
      : 'MODE: no-send — the refusals, the preview and the gates. Steps 4-6 need a real send and are\n'
        + '        SKIPPED; they are covered by src/api/sitenex-phase3.test.js, which can substitute the\n'
        + '        mailer because it runs in the same process as the route.\n');

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
    // In --send mode the PARTNER email is the real address too, so the cc does not go to a non-resolving
    // domain. A deliberate bounce is a small, permanent cost to sender reputation, and this script would
    // generate one every run. In no-send mode it stays .invalid, where nothing is delivered anyway.
    const partnerEmail = REAL_TO || 'verify-send-partner@example.invalid';
    const pid = (await query(
      `INSERT INTO partners (name, primary_contact_email) VALUES ('VERIFY SEND Partner',$1)
       ON CONFLICT (name) DO UPDATE SET status='active', primary_contact_email=$1 RETURNING id`,
      [partnerEmail])).rows[0].id;
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
    check('  cc = the partner on the contract', pv.body.cc, partnerEmail);
    ok('  from is the AUTHORIZED domain', /adificetechnologies\.com/.test(pv.body.from || ''), pv.body.from);
    ok('  the subject names the contract', (pv.body.subject || '').includes(no), pv.body.subject);
    ok('  the price the note will state', /\$4,500/.test(pv.body.price || ''), pv.body.price);
    check('  can_send', pv.body.can_send, true);
    // Evidenced by the LOG, the only thing this process can see. A preview that sent would have written
    // a row; SENT.length was a count in this process, which the route never touches.
    check('  and a preview wrote no send row',
          (await query(`SELECT COUNT(*)::int n FROM sitenex_contract_sends WHERE contract_id=$1`, [cid])).rows[0].n, 0);

    console.log('\n3. THE REFUSALS');
    const noConfirm = await hit('POST', `/api/sitenex/contracts/${cid}/send`, staff, {});
    check('no confirm_to → refused, naming the address', [noConfirm.status, noConfirm.body.code, noConfirm.body.to],
          [400, 'confirm_mismatch', clientEmail]);
    const wrong = await hit('POST', `/api/sitenex/contracts/${cid}/send`, staff, { confirm_to: 'someone@else.invalid' });
    check('wrong confirm_to → refused', [wrong.status, wrong.body.code], [400, 'confirm_mismatch']);
    check('  and nothing logged', (await query(`SELECT COUNT(*)::int n FROM sitenex_contract_sends WHERE contract_id=$1`, [cid])).rows[0].n, 0);
    check('  and the contract is untouched',
          (await query(`SELECT status, sent_at FROM sitenex_contracts WHERE id=$1`, [cid])).rows[0].status, 'generated');

    if (!REAL_TO) {
      console.log('\n4-6. THE SEND, THE STAMP AND THE LOG — SKIPPED (they need a real email).');
      console.log('      Covered by src/api/sitenex-phase3.test.js: the attachment is the stored .docx, the');
      console.log('      status and sent_at move in one transaction, the log records the provider id, a failed');
      console.log('      send is logged and marks nothing, and a send that goes but is not recorded says so.');
      console.log('      To check it for real:  --send <your own address>');
    } else {
      console.log('\n4. THE SEND');
      const sent = await hit('POST', `/api/sitenex/contracts/${cid}/send`, staff, { confirm_to: clientEmail });
      check('accepted', sent.status, 200);
      if (sent.status !== 200) console.log('     body:', JSON.stringify(sent.body));
      ok('  provider id came back', !!sent.body.provider_id, JSON.stringify(sent.body));
      check('  it reports the recipient it used', sent.body.to, clientEmail);

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
      check('  cc', L.cc_email, partnerEmail);
      check('  status', L.status, 'sent');
      check('  sent_by', L.sent_by, sup.id);
      ok('  provider id recorded', !!L.provider_id, String(L.provider_id));
      ok('  subject recorded', (L.subject || '').includes(no), L.subject);
      ok('  file name and size recorded', !!L.file_name && L.file_size > 5000, `${L.file_name} / ${L.file_size}`);
      check('  no error on a success', L.error, null);
      ok('  and the provider id in the log matches the response', L.provider_id === sent.body.provider_id,
         `${L.provider_id} vs ${sent.body.provider_id}`);
    }

    console.log('\n7. A SUPERSEDED CONTRACT CANNOT BE SENT');
    const regen = await hit('POST', '/api/sitenex/contracts', staff, { deal_id: dealId });
    if (regen.body.contract) made.contracts.push(regen.body.contract.id);
    check('  regenerated', regen.status, 201);
    const sendsBefore = (await query(`SELECT COUNT(*)::int n FROM sitenex_contract_sends`)).rows[0].n;
    const stale = await hit('POST', `/api/sitenex/contracts/${cid}/send`, staff, { confirm_to: clientEmail });
    check('  the superseded one refuses', [stale.status, stale.body.code], [400, 'not_current']);
    // A refused send writes no log row. Measured as a DELTA over the whole table, because this script has no
    // visibility into the server's mailer and the log is the only evidence available to it.
    check('  and logged nothing',
          (await query(`SELECT COUNT(*)::int n FROM sitenex_contract_sends`)).rows[0].n, sendsBefore);

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
    check('  and none of that wrote a send row',
          (await query(`SELECT COUNT(*)::int n FROM sitenex_contract_sends`)).rows[0].n, sendsBefore);

    if (REAL_TO) {
      console.log(`\n📧 ONE REAL EMAIL WAS SENT to ${REAL_TO} — check that inbox.`);
    }
  } catch (e) { fail++; console.error('ERROR:', e.message, e.stack ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : ''); }
  finally {
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
