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
// ── SPEC A MILESTONE 6, ITEM 4: THE LAST REAL-SEND PATH ─────────────────────
//
// This was the final tracked outbound violation: a script that genuinely transmits, outside
// dispatch, with its own gate and its own ledger attempt. It is not an agent, so no agent-level
// control reached it.
//
// It now routes through dispatch() like everything else. Note what that costs here: NOTHING. The
// probe's recipient is `<token>@abiozen.com` — a non-existent mailbox on OUR OWN domain, which is
// the whole point of the probe and which recipients.isExternal() classifies as INTERNAL. So
// dispatch applies the STOPs, the ledger, the idempotency key and the digest, and does not demand
// an approval the probe has no business holding.
//
// The script keeps its own three-way exit (0 proven / 1 failed / 3 refused by policy), because
// "the kill switch refused the probe" must never read as "the bounce detector is broken".
const { dispatch } = require('../src/lib/outbound/dispatch');

// Distinct from 0 (proven) and 1 (failed): the probe was REFUSED by policy and never ran. A
// refusal reported as a pass would say the bounce gate is proven when nothing was tested, and
// reported as a failure would say the detector is broken when it was never exercised.
const EXIT_REFUSED_BY_POLICY = 3;
const { initDB, query } = require('../src/lib/db');
const { readOnlyClientFor } = require('../src/lib/gmail/client');
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
    // READ-ONLY. This script reads the mailbox to find the NDR; it cannot send with this client,
    // and does not need to — dispatch does the sending.
    const g = await readOnlyClientFor(FROM);
    if (g.error) { bad('authorise', g.error); return; }
    ok(`authorised as ${g.profile.emailAddress} (${g.scopeSet})`);

    // ── THE KILL SWITCH, BEFORE ANYTHING AT ALL ──────────────────────────
    //
    // This script TRANSMITS. It is operator-run rather than a cron, and --execute is required, but
    // neither of those is the kill switch: a global `email.send` STOP exists precisely so that ONE
    // instruction halts every outbound path, and an operator script that ignores it is a hole in a
    // control only worth anything when it is total. CEO authorization 2026-11-10 item A.
    //
    // CHECKED BEFORE THE FIXTURE INSERT, not beside the send. A refusal after the insert would
    // leave an outreach_sends row behind for a probe that never happened — cleanup exists, but the
    // cheapest way not to leak a fixture is not to create one. Nothing has been written at this
    // point, so the early return is clean.
    //
    // Scoped as its own workflow so a deliberate probe can be permitted while campaigns stay
    // contained — and refused by a global or capability stop regardless of that.
    // Asked BEFORE the fixture insert, so a refusal leaves no outreach_sends row behind for a
    // probe that never happened. dispatch asks again at the moment of sending — this is not a
    // substitute for that check, it is an early exit that avoids creating a fixture for nothing.
    const gate = await require('../src/lib/email-gate').assertSendAllowed({
      capability: 'email.send', workflow: 'bounce-probe', agent: 'verify-bounce-detection',
      to: target,
    });
    if (!gate.allowed) {
      say(`\n  REFUSED  ${gate.reason}`);
      say('\n  Nothing was sent and no fixture was written. This is not a failure of the bounce');
      say('  detector — it is the kill switch doing its job. Lift the stop deliberately if the');
      say('  probe is wanted. A verification that bypasses the brake verifies nothing.\n');
      process.exit(EXIT_REFUSED_BY_POLICY);
    }

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
    const sent = await dispatch({
      message: {
        to: target,
        subject: `Delivery probe ${token}`,
        mailbox: FROM,
        raw: msg.raw,
      },
      transport: 'gmail_probe',
      idempotencyKey: `outreach_sends:${sendIds[0]}`,
      workflow: 'bounce-probe',
      agent: 'verify-bounce-detection',
    });

    if (!sent.ok) {
      if (sent.stopped) {
        say(`\n  REFUSED  ${sent.error}`);
        say('\n  Nothing was sent. This is the kill switch, not a broken detector.\n');
        process.exit(EXIT_REFUSED_BY_POLICY);
      }
      if (sent.dispatched) {
        bad('the probe may have been transmitted but the outcome is unknown', sent.error);
        return;
      }
      bad('the probe was refused before transmission, so the detector was not exercised', sent.error);
      return;
    }
    const res = { data: { id: (sent.meta && sent.meta.messageId) || sent.id } };
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
