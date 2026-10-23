// ── ONE COPY OF THE SEND LOOP, FOR THE CLI AND THE CRON BOTH ──────────────────
//
// This was the body of scripts/run-cphi-followup.js. It moved here the moment a second caller
// appeared, because the alternative — a cron with its own copy of "who is due and what do we send
// them" — is the exact shape of the two worst bugs in this campaign's short history: two
// hand-written copies of the stale-row query, one of which named a column that did not exist, and
// two places that defaulted to the event slug `cphi` when the real slug is `cphi-milan-2026`, so
// the export cheerfully reported twenty contacts as the whole list while sixty-one sat invisible.
//
// Two copies of a rule means one of them is wrong and nothing tells you which.
//
// ── WHY THE WINDOW MAKES A CRON NECESSARY, NOT OPTIONAL ──────────────────────
//
// On the first live run 54 of 72 contacts were skipped for being outside 09:30–17:00 in their own
// time zone. That is the feature working — but it means a single run reaches only whoever happens
// to be at their desk at that moment. India, China and Italy are never all inside the window at
// once, so the campaign only completes if something runs through the day. Naren is travelling; that
// something cannot be him typing `railway ssh`.
//
// ── WHAT THIS REFUSES TO DO ──────────────────────────────────────────────────
//
// Every one of these would be a worse outcome than sending nothing today:
//
//   · send to somebody who has replied            → stop-on-reply, checked immediately before send
//   · send twice                                   → a UNIQUE claim row, taken before Gmail is called
//   · send at 2am local                            → the recipient's window, from their dialling code
//   · greet somebody by the wrong name             → rendering is fatal without a usable first name
//   · send to a contact with no segment            → no role, no campaign, no message
//   · send fifteen messages in the same second     → spacing between sends
//
// None of these are defaults a flag can override. They are the reason this is worth running at all
// rather than pasting into Gmail by hand.
'use strict';

const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const { isEvent } = require('../events/registry');
const { gmailClientFor } = require('../gmail/client');
const { buildMessage } = require('../gmail/message');
const { replyState } = require('../gmail/thread');
const { ensureCampaignLabels, labelThread, labelForCampaign } = require('../gmail/labels');
const { render, stepDef, stepsOf, campaignFor } = require('./cphi-followup');
const { zoneForContact, withinWindow } = require('./send-window');
const { splitName } = require('./name-split');

const ATTACHMENT = path.join(__dirname, '..', '..', '..', 'assets', 'abiozen-model.pdf');
const SIG_NAME = 'Naren Boda';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the follow-up campaign once.
 *
 * Options: { event, fromMailbox, redirectTo, campaign, max, execute, ignoreWindow,
 *            spacingMs: [min, max], log, deps }
 *
 * Returns a summary: { dryRun, candidates, due, batch, sent, failed, skipped, needGreeting,
 *                      unfiled, folders, unconfirmed }.
 *
 * It THROWS on a precondition that makes sending unsafe — a bad event slug, a missing one-pager, an
 * unusable mailbox. The caller decides whether that is an exit code or an alert; a library that
 * calls process.exit kills a web server.
 */
async function runFollowups(opts = {}) {
  const EVENT = opts.event || 'cphi-milan-2026';
  const FROM_MAILBOX = opts.fromMailbox || 'naren@abiozen.com';
  const REDIRECT_TO = opts.redirectTo || null;
  const CAMPAIGN = opts.campaign || null;
  const MAX = opts.max == null ? 5 : opts.max;
  const EXECUTE = !!opts.execute;
  const IGNORE_WINDOW = !!opts.ignoreWindow;
  const [SPACE_MIN, SPACE_MAX] = opts.spacingMs || [40000, 90000];
  const say = opts.log || (() => {});
  const deps = opts.deps || {};
  const getClient = deps.gmailClientFor || gmailClientFor;

  if (!isEvent(EVENT)) throw new Error(`"${EVENT}" is not an event`);
  if (!Number.isInteger(MAX) || MAX < 1) throw new Error('max must be a positive integer');

  const out = {
    dryRun: !EXECUTE, event: EVENT, from: FROM_MAILBOX, redirectTo: REDIRECT_TO,
    candidates: 0, due: 0, batch: 0, sent: 0, failed: 0,
    skipped: {}, needGreeting: [], unfiled: [], folders: null, unconfirmed: 0,
  };

  say(`── CPHI follow-up · ${EXECUTE ? 'SENDING' : 'dry run'} · max ${MAX}\n`);
  if (REDIRECT_TO) {
    say(`   ⚠ EVERY message is redirected to ${REDIRECT_TO}.`);
    say(`     The content is still rendered for the real contact, so this is a true test of what`);
    say(`     they would receive — but nobody else gets anything.`);
    // THE BUG THIS LINE EXISTS BECAUSE OF. The first redirected send recorded itself against the
    // real contact: Luca Segàla's state said step 1 was sent, and the UNIQUE claim row then blocked
    // the real send — so the test quietly ensured he would never receive it. A redirected message
    // is a test of rendering and delivery, not a step in anybody's sequence.
    say(`     NOTHING IS RECORDED: no claim row, no sequence state, no last_emailed_at. The real`);
    say(`     contact is untouched and still due.\n`);
  }

  // The attachment is a real file on disk, read once. A first message that should carry the
  // one-pager and silently does not is the failure the whole campaign was built around avoiding.
  let pdf = null;
  try {
    pdf = fs.readFileSync(ATTACHMENT);
    say(`   attachment: ${path.basename(ATTACHMENT)} (${pdf.length.toLocaleString()} bytes)`);
  } catch (e) {
    throw new Error(`the one-pager is missing at ${ATTACHMENT} — step 1 of every sequence `
      + `attaches it, and every supplier at the show asked the question it answers. Not sending.`);
  }

  // ── WHO IS DUE ────
  // A contact is due when they have a role (therefore a campaign), an email, a usable greeting,
  // and either no sequence yet or a sequence whose next step is due.
  const rows = (await query(
    `SELECT c.id, c.company, c.name, c.greeting_name, c.email, c.phone_mobile, c.phone_office,
            x.role,
            s.id AS state_id, s.campaign, s.step_sent, s.status, s.next_due_at,
            s.thread_id, s.last_rfc822_id, s.refs_chain
       FROM cphi_exhibitor_contacts c
       JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
       LEFT JOIN cphi_followup_state s
              ON s.contact_id = c.id AND s.event_slug = c.event_slug
      WHERE c.event_slug = $1
        AND c.email IS NOT NULL AND c.email <> ''
        AND x.role IS NOT NULL
      ORDER BY c.company, c.name`, [EVENT])).rows;

  const now = new Date();
  const queue = [];
  const skipped = { replied: 0, done: 0, notDue: 0, window: 0, noGreeting: 0, noCampaign: 0, halted: 0 };
  const noCampaignWho = [];
  const needGreeting = [];

  for (const r of rows) {
    // Per event: a role shared between shows must not inherit another show's copy.
    const campaign = r.campaign || campaignFor(EVENT, r.role);
    if (!campaign) {
      skipped.noCampaign += 1;
      // NAMED, not just counted. A bare count is how twenty SCOPE contacts sat unsent for a week
      // while the run reported success.
      noCampaignWho.push(`${r.name || r.email} <${r.email}> · role ${r.role}`);
      continue;
    }
    if (CAMPAIGN && campaign !== CAMPAIGN) continue;
    if (r.status === 'replied') { skipped.replied += 1; continue; }
    if (r.status === 'halted') { skipped.halted += 1; continue; }

    const steps = stepsOf(campaign);
    const nextStep = (r.step_sent || 0) + 1;
    if (!steps.includes(nextStep)) { skipped.done += 1; continue; }

    // A greeting we cannot derive is fatal by design. Seven names on this list cannot be split, and
    // "Hi ," to somebody met four days ago is worse than sending nothing.
    const split = splitName(r.name);
    const first = (r.greeting_name && r.greeting_name.trim()) || (split.safe ? split.first : null);
    if (!first) {
      skipped.noGreeting += 1;
      needGreeting.push({ id: r.id, name: r.name, company: r.company, suggestion: split.first, why: split.why });
      continue;
    }

    if (r.next_due_at && new Date(r.next_due_at) > now) { skipped.notDue += 1; continue; }

    const zone = zoneForContact(r);
    const w = withinWindow(now, zone);
    if (!IGNORE_WINDOW && !w.ok) { skipped.window += 1; continue; }

    queue.push({ ...r, campaign, nextStep, first, zone, local: w.localTime });
  }

  out.candidates = rows.length;
  out.due = queue.length;
  out.skipped = skipped;
  out.noCampaignWho = noCampaignWho;
  out.needGreeting = needGreeting;

  say(`   ${rows.length} contact(s) with a role and an email`);
  say(`   ${queue.length} due right now\n`);
  const skipLine = Object.entries(skipped).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ');
  if (skipLine) say(`   skipped: ${skipLine}`);

  // NAME the no-copy skips. A counter reading "noCampaign 3" is indistinguishable from a healthy
  // run at a glance, and that is exactly how twenty SCOPE contacts sat unsent for a week while
  // every run reported success. These people are waiting on copy that does not exist yet; they
  // should be impossible to overlook until it does.
  if (noCampaignWho.length) {
    say(`\n   ⚠ ${noCampaignWho.length} contact(s) have NO COPY for this event and received nothing:`);
    for (const who of noCampaignWho) say(`        ${who}`);
    say('      Not a failure — a sequence nobody has written. Write it, or accept the silence');
    say('      deliberately. Do NOT hand them another event\'s letter.');
  }
  say('');

  if (needGreeting.length) {
    say(`   ⚠ ${needGreeting.length} contact(s) are held because the greeting cannot be derived:`);
    for (const n of needGreeting) {
      say(`      ${n.name.padEnd(22)} ${n.company}`);
      say(`         ${n.why}`);
      say(`         UPDATE cphi_exhibitor_contacts SET greeting_name = '<given name>' WHERE id = ${n.id};`);
    }
    say();
  }

  if (!queue.length) { say('   nothing to send.\n'); return out; }

  const batch = queue.slice(0, MAX);
  out.batch = batch.length;
  say(`   ── the next ${batch.length}:\n`);
  for (const q of batch) {
    const def = stepDef(q.campaign, q.nextStep);
    const o = render(q.campaign, q.nextStep, { first: q.first, company: q.company });
    say(`      ${q.campaign}/${q.nextStep}  ${q.name} <${REDIRECT_TO || q.email}>`);
    say(`         ${q.company}  ·  ${q.local || '??'} local${q.zone ? ` (${q.zone.zone})` : ''}`);
    say(`         "Hi ${q.first}"  ·  ${o.isFollowUp ? 'replies in-thread' : `subject: ${o.subject}`}`
      + `${def.attach ? '  ·  + one-pager' : ''}`);
  }
  say();

  if (!EXECUTE) {
    say('   DRY RUN — nothing sent. Re-run with --execute.');
    say(`   First send should go to yourself:  --to=${FROM_MAILBOX} --execute --max=1\n`);
    return out;
  }

  // ── AUTH ────
  const g = await getClient(FROM_MAILBOX);
  if (g.error) {
    throw new Error(`cannot act as ${FROM_MAILBOX}: ${g.error} — run scripts/check-gmail-send.js; `
      + `nothing is sent until that passes`);
  }
  say(`   authorised as ${g.profile.emailAddress} via ${g.via} (${g.scopeSet})\n`);

  // ── THE THREE FOLDERS ────
  // Made now, before anything is sent, so a scope problem is reported once at the top rather than
  // once per message — and so the sidebar is right even on a run where nothing turns out to be due.
  const folders = await ensureCampaignLabels(g.gmail, FROM_MAILBOX);
  out.folders = folders;
  if (folders.ok) {
    const made = Object.values(folders.labels).filter((l) => l.created).map((l) => l.name);
    say(`   folders: ${Object.values(folders.labels).map((l) => l.name).join(' · ')}`
      + `${made.length ? `  (created ${made.join(', ')})` : ''}\n`);
  } else {
    // Not fatal. An unfiled thread is one drag in the UI; a message not sent because the filing
    // failed is a contact who shook his hand and heard nothing.
    say(`   ⚠ the folders could not be set up — messages will send UNFILED:`);
    for (const e of folders.errors) say(`     ${e}`);
    say(`     Labels need gmail.modify; this token resolved to ${g.scopeSet}.\n`);
  }

  for (const q of batch) {
    const who = `${q.name} <${REDIRECT_TO || q.email}>`;

    // ── STOP ON REPLY, CHECKED NOW AND NOT EARLIER ────
    // The queue was built a moment ago; a reply could have arrived since. This is the last possible
    // moment to find out, so it is where the check belongs.
    if (q.thread_id) {
      const rs = await replyState(g.gmail, q.thread_id, FROM_MAILBOX);
      if (rs.replied === null) {
        say(`   — ${who}: cannot tell whether they replied (${rs.error}). Skipped.`);
        continue;
      }
      if (rs.replied) {
        await query(
          `UPDATE cphi_followup_state SET status='replied', replied_at=NOW(), updated_at=NOW()
            WHERE id = $1`, [q.state_id]);
        say(`   ✓ ${who}: REPLIED — sequence stopped.`);
        continue;
      }
      if (rs.autoReplies.length) say(`     (${rs.autoReplies.length} auto-reply seen — not a reply)`);
    }

    const def = stepDef(q.campaign, q.nextStep);
    const rendered = render(q.campaign, q.nextStep, { first: q.first, company: q.company });

    // ── CLAIM THE SLOT BEFORE CALLING GMAIL ────
    // The UNIQUE constraint is what makes a double-send impossible. If this insert is refused the
    // step has already been claimed by another run, and we must not send.
    let claimId = null;
    if (!REDIRECT_TO) {
      try {
        const claim = await query(
          `INSERT INTO cphi_followup_sends
             (event_slug, contact_id, campaign, step, to_email, subject)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [EVENT, q.id, q.campaign, q.nextStep, q.email, rendered.subject || '(in-thread)']);
        claimId = claim.rows[0].id;
      } catch (e) {
        if (e.code === '23505') { say(`   — ${who}: step ${q.nextStep} already claimed. Not sending.`); continue; }
        throw e;
      }
    }

    try {
      const refs = (q.refs_chain || '').split(/\s+/).filter(Boolean);
      const msg = buildMessage({
        from: { name: SIG_NAME, email: FROM_MAILBOX },
        to: { name: q.name, email: REDIRECT_TO || q.email },
        // A follow-up has no subject of its own: Gmail shows "Re: <original>" when it is threaded.
        subject: rendered.subject || `Re: ${(await originalSubject(EVENT, q)) || 'CPHI Milan'}`,
        text: rendered.text, html: rendered.html,
        inReplyTo: rendered.isFollowUp ? q.last_rfc822_id : null,
        references: rendered.isFollowUp ? refs : [],
        attachments: def.attach
          ? [{ filename: 'abiozen-model.pdf', contentType: 'application/pdf', content: pdf }] : [],
      });

      const res = await g.gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: msg.raw, ...(q.thread_id ? { threadId: q.thread_id } : {}) },
      });

      const threadId = res.data.threadId;

      // ── FILE IT ────
      // After the send, and reported rather than thrown. By this point the message has left: Gmail
      // cannot unsend it, and the claim row below must record that it went. A label failure treated
      // as a send failure would leave an unconfirmed claim saying the message "may or may not have
      // gone" when the truth is that it went and is merely sitting in the inbox unfiled.
      const folder = labelForCampaign(q.campaign);
      let filed = null;
      if (folder) {
        // The whole thread, not just this message: their reply arrives in the same thread, and
        // threads.modify is what makes a `label:supplier` search match it too.
        filed = await labelThread(g.gmail, FROM_MAILBOX, threadId, folder);
      }
      const filedNote = folder
        ? (filed.ok ? `  → ${folder}` : `  ⚠ UNFILED (${filed.error})`)
        : `  ⚠ UNFILED (no folder for campaign "${q.campaign}")`;
      if (!folder || !filed.ok) {
        out.unfiled.push({ name: q.name, company: q.company, threadId, campaign: q.campaign,
          why: folder ? filed.error : `no folder for campaign "${q.campaign}"` });
      }

      if (REDIRECT_TO) {
        out.sent += 1;
        say(`   ✅ ${who}  ${q.campaign}/${q.nextStep}${def.attach ? ' + pdf' : ''}  thread ${threadId}${filedNote}`);
        say(`      (test — ${q.name} is untouched and still due; the test message is filed under`);
        say(`       ${folder || 'nothing'} so you can see the folder works. Delete it when you have looked.)`);
        if (batch.indexOf(q) < batch.length - 1) await sleep(5000);
        continue;
      }

      await query(
        `UPDATE cphi_followup_sends
            SET gmail_message_id=$2, gmail_thread_id=$3, rfc822_message_id=$4, sent_at=NOW()
          WHERE id = $1`, [claimId, res.data.id, threadId, msg.messageId]);

      const chain = [...refs, msg.messageId].join(' ');
      const nextDef = stepDef(q.campaign, q.nextStep + 1);
      const nextDue = nextDef ? new Date(Date.now() + nextDef.delayDays * 86400000) : null;

      await query(
        `INSERT INTO cphi_followup_state
           (event_slug, contact_id, campaign, step_sent, status, next_due_at,
            thread_id, last_rfc822_id, refs_chain)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (event_slug, contact_id, campaign) DO UPDATE
           SET step_sent=EXCLUDED.step_sent, status=EXCLUDED.status,
               next_due_at=EXCLUDED.next_due_at, thread_id=EXCLUDED.thread_id,
               last_rfc822_id=EXCLUDED.last_rfc822_id, refs_chain=EXCLUDED.refs_chain,
               updated_at=NOW()`,
        [EVENT, q.id, q.campaign, q.nextStep, nextDef ? 'active' : 'completed',
         nextDue, threadId, msg.messageId, chain]);

      await query(
        `UPDATE cphi_exhibitor_contacts SET last_emailed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [q.id]);

      out.sent += 1;
      say(`   ✅ ${who}  ${q.campaign}/${q.nextStep}${def.attach ? ' + pdf' : ''}  thread ${threadId}${filedNote}`);
    } catch (e) {
      out.failed += 1;
      if (REDIRECT_TO) { say(`   ✗ ${who}: ${(e && e.message) || e}`); continue; }
      // The claim STAYS, carrying the error. It blocks a blind retry and shows up as a row needing
      // a human — which is the right side to err on when the question is "did that actually send?"
      if (claimId) {
        await query(`UPDATE cphi_followup_sends SET error = $2 WHERE id = $1`,
          [claimId, (e && e.message) || String(e)]);
      }
      say(`   ✗ ${who}: ${(e && e.message) || e}`);
      say(`     The claim row is kept with the error, so this will not be retried blindly.`);
    }

    // Fifteen messages leaving one human mailbox in the same second is itself the tell.
    if (batch.indexOf(q) < batch.length - 1) {
      await sleep(SPACE_MIN + Math.floor(Math.random() * Math.max(1, SPACE_MAX - SPACE_MIN)));
    }
  }

  say(`\n   ${out.sent} sent, ${out.failed} failed.`);
  out.unconfirmed = (await query(
    `SELECT COUNT(*)::int n FROM cphi_followup_sends WHERE event_slug=$1 AND sent_at IS NULL`,
    [EVENT])).rows[0].n;
  if (out.unconfirmed) {
    say(`   ⚠ ${out.unconfirmed} claimed send(s) have no Gmail id — they may or may not have gone.`);
    say(`     SELECT * FROM cphi_followup_sends WHERE sent_at IS NULL;`);
  }
  if (out.unfiled.length) {
    say(`   ⚠ ${out.unfiled.length} thread(s) sent but UNFILED — repair with:`);
    say(`     node scripts/label-cphi-threads.js --execute`);
  }
  say();
  return out;
}

/** The subject of step 1, so a follow-up can say "Re: <that>" when threading. */
async function originalSubject(event, q) {
  const r = await query(
    `SELECT subject FROM cphi_followup_sends
      WHERE event_slug=$1 AND contact_id=$2 AND campaign=$3 AND step=1`,
    [event, q.id, q.campaign]);
  return r.rows[0] ? r.rows[0].subject : null;
}

module.exports = { runFollowups, ATTACHMENT, SIG_NAME };
