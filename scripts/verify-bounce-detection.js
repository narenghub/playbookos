#!/usr/bin/env node
// ── PROVE THE BOUNCE DETECTOR BY CAUSING A BOUNCE ────────────────────────────
//
//   railway ssh 'node scripts/verify-bounce-detection.js'            # dry run: explains, sends nothing
//   railway ssh 'node scripts/verify-bounce-detection.js --execute'
//
// Exit 0 = a real delivery failure was produced and scan-bounces found it.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// scan-bounces reported "0 message(s) from a postmaster" and "0.0%". That is consistent with a
// clean list. It is equally consistent with a Gmail query that does not match how bounces arrive
// in this mailbox, a scope that cannot read them, or a classifier that recognises nothing — and
// all four produce byte-identical output.
//
// This is the same shape as the defect it was built to fix. send-outreach's 5% gate read a table
// nothing wrote to and reported 0.0%; the fix was a scanner; and the scanner's first run also
// reported 0.0%. A number that cannot distinguish "nothing wrong" from "not working" is not
// evidence, however many layers deep it is.
//
// So this makes a real failure happen and checks that the detector catches it end to end: the
// send, the NDR arriving, the Gmail search, the classifier, the address match, and the row.
//
// ── WHY IT IS SAFE ───────────────────────────────────────────────────────────
//
// The message goes to a non-existent mailbox at abiozen.com — our own domain. Nobody receives it,
// no third-party reputation is touched, and Google Workspace returns a 550 for an unknown local
// user at a domain it hosts, which is exactly the kind of failure the real list will produce.
//
// Cleanup follows the repo rule: it deletes ONLY the rows it created, by id recorded at insert
// time, and asserts those specific rows are gone rather than asserting a table is empty.
'use strict';

const crypto = require('crypto');
const { initDB, query } = require('../src/lib/db');
const { gmailClientFor } = require('../src/lib/gmail/client');
const { buildMessage } = require('../src/lib/gmail/message');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EXECUTE = has('execute');
const FROM = arg('mailbox', 'sales@abiozen.com');
const WAIT_S = Math.max(30, Math.min(900, parseInt(arg('wait', '240'), 10) || 240));

const say = (s = '') => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (m) => say(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; say(`  FAIL  ${m}`); if (d) say(`          ${d}`); };

async function main() {
  await initDB();

  // A unique, obviously-fake local part. The token lets the scan find this specific failure and
  // nothing else, and makes the fixture unmistakable to anyone who sees it in a table.
  const token = `bounce-probe-${crypto.randomBytes(6).toString('hex')}`;
  const target = `${token}@abiozen.com`;

  say('\n── verify bounce detection\n');
  say(`   target   ${target}`);
  say('   This address does not exist at our own domain, so Workspace will refuse it with a 550.');
  say('   Nobody receives anything and no outside reputation is involved.\n');

  if (!EXECUTE) {
    say('   DRY RUN — nothing sent. Re-run with --execute.');
    say('   It sends one message, waits for the NDR, then runs the real scan logic against it.\n');
    return;
  }

  const sendIds = [];
  const bounceIds = [];

  try {
    const g = await gmailClientFor(FROM);
    if (g.error) { bad('authorise', g.error); return; }
    ok(`authorised as ${g.profile.emailAddress} (${g.scopeSet})`);

    // ── THE FIXTURE ────
    // scan-bounces only records a failure for an address in outreach_sends — a bounce naming
    // somebody we never wrote to is not ours to count. So the probe needs a send row, and that
    // row is a fixture we remove.
    const ins = await query(
      `INSERT INTO outreach_sends (channel, ref, need, step, to_email, subject, evidence)
       VALUES ('verify', $1, 'discovery', 1, $2, $3, 'bounce detection probe') RETURNING id`,
      [token, target, `probe ${token}`]);
    sendIds.push(ins.rows[0].id);
    ok(`fixture send row ${ins.rows[0].id} recorded for ${target}`);

    // ── CAUSE THE FAILURE ────
    const msg = buildMessage({
      from: { name: 'Abiozen', email: FROM },
      to: { name: 'Bounce Probe', email: target },
      subject: `Delivery probe ${token}`,
      text: `This message is a deliverability self-test (${token}). It is addressed to a mailbox `
        + 'that does not exist, so it should fail. Nobody reads this.\n',
      html: `<p>This message is a deliverability self-test (${token}). It is addressed to a mailbox `
        + 'that does not exist, so it should fail. Nobody reads this.</p>',
    });
    await g.gmail.users.messages.send({ userId: 'me', requestBody: { raw: msg.raw } });
    ok('probe sent');

    // ── WAIT FOR THE NDR ────
    // Most bounces from one's own Workspace domain return in seconds; some take minutes.
    say(`\n   waiting up to ${WAIT_S}s for the delivery failure to come back…`);
    let seen = null;
    const deadline = Date.now() + WAIT_S * 1000;
    while (Date.now() < deadline && !seen) {
      await sleep(15000);
      const r = await g.gmail.users.messages.list({
        userId: 'me', q: `"${token}" newer_than:1d`, maxResults: 20,
      });
      for (const m of r.data.messages || []) {
        const full = await g.gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata' });
        const from = (full.data.payload.headers || [])
          .find((h) => h.name.toLowerCase() === 'from');
        if (from && /mailer-daemon|postmaster/i.test(from.value)) { seen = { id: m.id, from: from.value }; break; }
      }
      if (!seen) say(`      …${Math.round((deadline - Date.now()) / 1000)}s left`);
    }

    if (!seen) {
      bad('a delivery failure came back',
        `nothing from a postmaster within ${WAIT_S}s. Either Workspace accepted mail for a `
        + 'non-existent local user, or this mailbox cannot see the NDR.');
    } else {
      ok(`NDR received from ${seen.from}`);

      // ── DOES THE REAL SCANNER FIND IT? ────
      // Run the shipped script rather than reimplementing its logic here, so what is proven is
      // what actually runs on a real batch.
      const { execFileSync } = require('child_process');
      let out = '';
      try {
        out = execFileSync('node', [`${__dirname}/scan-bounces.js`, '--execute', '--days=1'],
          { encoding: 'utf8' });
      } catch (e) { out = String((e.stdout || '') + (e.stderr || '')); }

      if (!out.includes(target)) {
        bad('scan-bounces found the probe', `the address does not appear in its output:\n${out.split('\n').slice(0, 25).join('\n')}`);
      } else ok('scan-bounces reported the probe address');

      const row = (await query(
        'SELECT id, kind FROM outreach_bounces WHERE LOWER(email) = LOWER($1)', [target])).rows[0];
      if (!row) {
        bad('the bounce was recorded', 'no row in outreach_bounces for the probe address');
      } else {
        bounceIds.push(row.id);
        ok(`recorded in outreach_bounces as "${row.kind}"`);
        if (row.kind !== 'hard') {
          bad('an unknown recipient is classified hard',
            `classified "${row.kind}" — a dead address must stop the sequence, not be retried`);
        }
      }
    }
  } finally {
    // ── CLEANUP: ONLY WHAT WE MADE, BY ID ────
    for (const id of bounceIds) await query('DELETE FROM outreach_bounces WHERE id = $1', [id]);
    for (const id of sendIds) await query('DELETE FROM outreach_sends WHERE id = $1', [id]);
    const leftB = bounceIds.length
      ? (await query('SELECT COUNT(*)::int n FROM outreach_bounces WHERE id = ANY($1)', [bounceIds])).rows[0].n : 0;
    const leftS = sendIds.length
      ? (await query('SELECT COUNT(*)::int n FROM outreach_sends WHERE id = ANY($1)', [sendIds])).rows[0].n : 0;
    if (leftB || leftS) bad('fixtures removed', `${leftB} bounce + ${leftS} send row(s) left behind`);
    else say(`\n  ok    fixtures removed (${sendIds.length} send, ${bounceIds.length} bounce)`);
  }

  if (fail) {
    say(`\nFAIL  ${fail} check(s) failed — the bounce gate is NOT proven. Treat "0.0%" as unknown.\n`);
    process.exit(1);
  }
  say('\nPASS  a real delivery failure was produced, detected, classified hard and recorded.');
  say('      The 5% gate in send-outreach is now measuring something.\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('verify-bounce-detection failed:', e && e.message ? e.message : e);
  process.exit(1);
});
