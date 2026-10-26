#!/usr/bin/env node
// ── SEND THE NEED-BASED SEQUENCES ────────────────────────────────────────────
//
//   railway ssh 'node scripts/send-outreach.js'                         # dry run
//   railway ssh 'node scripts/send-outreach.js --to=naren@abiozen.com --execute --max=1'
//   railway ssh 'node scripts/send-outreach.js --execute --max=8'
//   railway ssh 'node scripts/send-outreach.js --execute --max=8 --need=discovery'
//
// Dry run unless --execute. THE FIRST REAL SEND SHOULD GO TO YOURSELF with --to.
//
// ── WHAT THIS DOES THAT THE DRY RUN DOES NOT ─────────────────────────────────
//
// Only one thing: it calls Gmail. The queue, the routing, the evidence sentence and the rendering
// all come from the same modules scripts/route-outreach.js prints, so that command is evidence
// about this one rather than a second implementation.
//
// ── THE ORDER OF OPERATIONS IS THE SAFETY PROPERTY ───────────────────────────
//
// 1. Check for a reply at the LAST possible moment, not when the queue was built. A reply that
//    arrived two seconds ago still stops the sequence.
// 2. Claim the slot in outreach_sends BEFORE calling Gmail. The UNIQUE index on
//    (channel, ref, step) is what makes a double-send impossible, including between two runs
//    racing. Sending first and recording after means a crash between them leaves a message
//    delivered and unrecorded, and the next run sends it again.
// 3. Send.
// 4. File the thread, and report a filing failure rather than throwing. By then the message has
//    left: Gmail cannot unsend it, and treating a label error as a send error would record that
//    the message "may or may not have gone" when the truth is that it went and is unfiled.
//
// ── THE MAILBOX ──────────────────────────────────────────────────────────────
//
// sales@abiozen.com, which completed warmup on 4 October. naren@abiozen.com has never been
// enrolled, so sending from it would put this batch through an unwarmed mailbox — the condition
// the last 2,946 emails went out under, with no way to tell how many arrived.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { renderNeed, NEED_CAMPAIGNS, needStepsOf } = require('../src/lib/campaigns/needs');
const { buildQueue, varsFor } = require('../src/lib/campaigns/outreach-queue');
const { gmailClientFor } = require('../src/lib/gmail/client');
const { buildMessage } = require('../src/lib/gmail/message');
const { replyState } = require('../src/lib/gmail/thread');
const { labelForNeed, labelThread, ensureNeedLabels } = require('../src/lib/gmail/labels');
const { SIG_NAME } = require('../src/lib/campaigns/cphi-followup');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};

const EXECUTE = has('execute');
const FROM = arg('from', 'sales@abiozen.com');
const REDIRECT_TO = arg('to', '') || null;
const ONLY = arg('need', '');
const MAX = Math.max(1, Math.min(50, parseInt(arg('max', '8'), 10) || 8));
// Bounce rate is what damages a warmed domain fastest, and this mailbox took six weeks to warm.
const BOUNCE_LIMIT = Number(arg('bounce-limit', '5')) / 100;
const [SPACE_MIN, SPACE_MAX] = [45000, 95000];

const say = (s = '') => console.log(s);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => SPACE_MIN + Math.floor(Math.random() * (SPACE_MAX - SPACE_MIN));

/** The step definition for a need, by number. */
const stepDef = (need, n) => (NEED_CAMPAIGNS[need] || { steps: [] }).steps.find((s) => s.step === n) || null;

async function main() {
  await initDB();

  say(`\n── outreach · ${EXECUTE ? 'SENDING' : 'dry run'} · from ${FROM} · max ${MAX}\n`);
  if (REDIRECT_TO) {
    say(`   ⚠ EVERY message is redirected to ${REDIRECT_TO}.`);
    say('     The content is still rendered for the real contact, so this is a true test of what');
    say('     they would receive — but nobody else gets anything.');
    // The bug this line exists because of, in the CPHI runner: the first redirected send recorded
    // itself against the real contact, so the test quietly ensured he would never receive it.
    say('     NOTHING IS RECORDED: no claim row, no sequence state. The real contact is untouched');
    say('     and still due.\n');
  }

  // ── BOUNCE GATE, BEFORE ANYTHING ────
  const b = (await query(`
    SELECT (SELECT COUNT(*)::int FROM outreach_sends) AS sent,
           (SELECT COUNT(DISTINCT LOWER(email))::int FROM outreach_bounces) AS bounced`)).rows[0];
  const rate = b.sent ? b.bounced / b.sent : 0;
  if (b.sent) {
    say(`   deliverability: ${b.bounced} bounce(s) in ${b.sent} send(s) — ${(rate * 100).toFixed(1)}%`);
  }
  if (rate > BOUNCE_LIMIT) {
    say(`\n   ✋ STOPPED. Bounce rate ${(rate * 100).toFixed(1)}% is over the ${(BOUNCE_LIMIT * 100).toFixed(0)}% limit.`);
    say('      sales@abiozen.com took six weeks to warm and is the only warmed mailbox there is.');
    say('      Verify the remaining addresses before sending more.\n');
    process.exit(1);
  }

  // ── THE QUEUE, FROM THE SAME MODULE THE DRY RUN PRINTS ────
  const all = await buildQueue(query);
  const routed = all.filter((r) => r.route && (!ONLY || r.route.need === ONLY));

  // ── WHO IS DUE ────
  const states = (await query('SELECT * FROM outreach_state')).rows;
  const byKey = new Map(states.map((s) => [`${s.channel}\u0000${s.ref}`, s]));

  const now = new Date();
  const queue = [];
  const skipped = { replied: 0, done: 0, notDue: 0, halted: 0, bounced: 0, noGreeting: 0 };

  for (const r of routed) {
    const st = byKey.get(`${r.channel}\u0000${r.ref}`) || null;
    if (st && st.status === 'replied') { skipped.replied += 1; continue; }
    if (st && st.status === 'halted') { skipped.halted += 1; continue; }
    if (st && st.status === 'bounced') { skipped.bounced += 1; continue; }

    const steps = needStepsOf(r.route.need);
    const nextStep = (st ? st.step_sent : 0) + 1;
    if (!steps.includes(nextStep)) { skipped.done += 1; continue; }
    if (st && st.next_due_at && new Date(st.next_due_at) > now) { skipped.notDue += 1; continue; }

    // A greeting that cannot be rendered is fatal by design — "Hi ," or a silent downgrade from
    // "Dear Professor Ball" to "Hi Nicholas" is worse than not sending.
    try {
      renderNeed(r.route.need, nextStep, varsFor(r));
    } catch (e) {
      skipped.noGreeting += 1;
      say(`   — ${r.who}: ${e.message}`);
      continue;
    }

    queue.push({ ...r, state: st, nextStep });
  }

  say(`   ${routed.length} routed · ${queue.length} due now`);
  const skipLine = Object.entries(skipped).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ');
  if (skipLine) say(`   skipped: ${skipLine}`);
  if (!queue.length) { say('\n   nothing to send.\n'); return; }

  const batch = queue.slice(0, MAX);
  say(`\n   ── the next ${batch.length}:\n`);
  for (const q of batch) {
    const m = renderNeed(q.route.need, q.nextStep, varsFor(q));
    say(`      ${pad(`${q.route.need}/${q.nextStep}`, 24)}${q.who} <${REDIRECT_TO || q.email}>`);
    say(`         ${m.isFollowUp ? 'replies in-thread' : `subject: ${m.subject}`}`);
    say(`         ${m.text.split('\n')[0]}`);
  }
  say('');

  if (!EXECUTE) {
    say('   DRY RUN — nothing sent. Re-run with --execute.');
    say(`   First real send should go to yourself:  --to=${FROM} --execute --max=1\n`);
    return;
  }

  // ── AUTH ────
  const g = await gmailClientFor(FROM);
  if (g.error) {
    throw new Error(`cannot act as ${FROM}: ${g.error} — nothing is sent until that is fixed`);
  }
  say(`   authorised as ${g.profile.emailAddress} via ${g.via} (${g.scopeSet})\n`);

  // Folders first, so a scope problem is reported once at the top rather than once per message.
  const folders = await ensureNeedLabels(g.gmail, FROM);
  if (folders.ok) {
    const made = Object.values(folders.labels).filter((l) => l.created).map((l) => l.name);
    say(`   folders: ${Object.values(folders.labels).map((l) => l.name).join(' · ')}`
      + `${made.length ? `  (created ${made.join(', ')})` : ''}\n`);
  } else {
    say('   ⚠ folders could not be set up — messages will send UNFILED, and reply-sync finds');
    say('     replies by walking labelled threads, so an unfiled thread is one whose reply never');
    say('     stops the sequence:');
    for (const e of folders.errors) say(`     ${e}`);
    say('');
  }

  let sent = 0; let failed = 0;
  const unfiled = [];

  for (const q of batch) {
    const who = `${q.who} <${REDIRECT_TO || q.email}>`;
    const st = q.state;

    // ── 1. STOP ON REPLY, CHECKED NOW ────
    if (st && st.thread_id) {
      const rs = await replyState(g.gmail, st.thread_id, FROM);
      if (rs.replied === null) { say(`   — ${who}: cannot tell whether they replied (${rs.error}). Skipped.`); continue; }
      if (rs.replied) {
        await query(
          `UPDATE outreach_state SET status='replied', replied_at=NOW(), updated_at=NOW() WHERE id=$1`,
          [st.id]);
        say(`   ✓ ${who}: REPLIED — sequence stopped.`);
        continue;
      }
    }

    const m = renderNeed(q.route.need, q.nextStep, varsFor(q));

    // ── 2. CLAIM BEFORE CALLING GMAIL ────
    let claimId = null;
    if (!REDIRECT_TO) {
      try {
        const claim = await query(
          `INSERT INTO outreach_sends (channel, ref, need, step, to_email, subject, evidence)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [q.channel, q.ref, q.route.need, q.nextStep, q.email,
            m.subject || '(in-thread)', q.route.evidence]);
        claimId = claim.rows[0].id;
      } catch (e) {
        if (e.code === '23505') { say(`   — ${who}: step ${q.nextStep} already claimed. Not sending.`); continue; }
        throw e;
      }
    }

    // ── 3. SEND ────
    try {
      const refs = (st && st.refs_chain ? st.refs_chain : '').split(/\s+/).filter(Boolean);
      const firstSubject = st && st.thread_id
        ? (await query(
          `SELECT subject FROM outreach_sends WHERE channel=$1 AND ref=$2 AND step=1`,
          [q.channel, q.ref])).rows[0]
        : null;
      const msg = buildMessage({
        from: { name: SIG_NAME, email: FROM },
        to: { name: q.who, email: REDIRECT_TO || q.email },
        subject: m.subject || `Re: ${(firstSubject && firstSubject.subject) || 'our note'}`,
        text: m.text,
        html: m.html,
        inReplyTo: m.isFollowUp && st ? st.last_rfc822_id : null,
        references: m.isFollowUp ? refs : [],
        attachments: [],
      });

      const res = await g.gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: msg.raw, ...(st && st.thread_id ? { threadId: st.thread_id } : {}) },
      });
      const threadId = res.data.threadId;

      // ── 4. FILE IT — reported, never thrown ────
      const folder = labelForNeed(q.route.need);
      let filed = null;
      if (folder) filed = await labelThread(g.gmail, FROM, threadId, folder);
      const note = folder
        ? (filed.ok ? `  → ${folder}` : `  ⚠ UNFILED (${filed.error})`)
        : `  ⚠ UNFILED (no folder for need "${q.route.need}")`;
      if (!folder || !filed.ok) {
        unfiled.push({ who: q.who, threadId, why: folder ? filed.error : 'no folder' });
      }

      if (REDIRECT_TO) {
        sent += 1;
        say(`   ✅ ${who}  ${q.route.need}/${q.nextStep}  thread ${threadId}${note}`);
        say(`      (test — ${q.who} is untouched and still due)`);
        if (batch.indexOf(q) < batch.length - 1) await sleep(5000);
        continue;
      }

      await query(
        `UPDATE outreach_sends SET rfc822_id=$2, thread_id=$3, confirmed=TRUE WHERE id=$1`,
        [claimId, msg.messageId, threadId]);

      const chain = [...refs, msg.messageId].join(' ');
      const next = stepDef(q.route.need, q.nextStep + 1);
      const nextDue = next ? new Date(Date.now() + next.delayDays * 86400000) : null;

      await query(
        `INSERT INTO outreach_state
           (channel, ref, email, need, step_sent, status, next_due_at,
            thread_id, last_rfc822_id, refs_chain, last_sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (channel, ref) DO UPDATE
           SET step_sent=EXCLUDED.step_sent, status=EXCLUDED.status,
               next_due_at=EXCLUDED.next_due_at, thread_id=EXCLUDED.thread_id,
               last_rfc822_id=EXCLUDED.last_rfc822_id, refs_chain=EXCLUDED.refs_chain,
               last_sent_at=NOW(), updated_at=NOW()`,
        [q.channel, q.ref, q.email, q.route.need, q.nextStep,
          next ? 'active' : 'done', nextDue, threadId, msg.messageId, chain]);

      sent += 1;
      say(`   ✅ ${who}  ${q.route.need}/${q.nextStep}  thread ${threadId}${note}`);
    } catch (e) {
      failed += 1;
      // The claim row stays, unconfirmed. That is deliberate: it records that a send was attempted
      // and we do not know whether it left. A human decides, rather than the next run guessing.
      say(`   ✗ ${who}: ${e.message}`);
      if (claimId) {
        say(`      claim ${claimId} is UNCONFIRMED — check the Sent folder before retrying.`);
      }
    }

    if (batch.indexOf(q) < batch.length - 1) {
      const ms = jitter();
      say(`      …${Math.round(ms / 1000)}s`);
      await sleep(ms);
    }
  }

  say(`\n   ${sent} sent · ${failed} failed`);
  if (unfiled.length) {
    say(`\n   ⚠ ${unfiled.length} thread(s) are UNFILED — their replies will not stop the sequence:`);
    for (const u of unfiled) say(`      ${u.who}  thread ${u.threadId}  (${u.why})`);
  }
  say('');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('send-outreach failed:', e && e.message ? e.message : e);
  process.exit(1);
});
