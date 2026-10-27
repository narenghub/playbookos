// ── THE OUTREACH AGENT ───────────────────────────────────────────────────────
//
// Everything the need-based campaign does on its own: find who is due, check nobody has replied,
// send, file, watch for delivery failures, and say what happened.
//
// It exists as a module rather than a script because PlayNexa runs its agents on cron and a
// command somebody has to type is not an agent. scripts/send-outreach.js and
// scripts/scan-bounces.js are now thin wrappers over these functions, so what runs unattended at
// 9am is byte-identical to what a dry run prints.
//
// ── THE RULE THIS WHOLE FILE IS SHAPED BY ────────────────────────────────────
//
// Silence must never be mistaken for success. Over two days this campaign produced: a demand
// count that deleted a customer whose company field was blank; a department check that dropped 22
// of 25 labs and reported them as "not routed"; a bounce gate that read a table nothing wrote to
// and reported 0.0%; and a scanner that fixed the gate and whose own first run also reported
// 0.0%. Every one looked exactly like a healthy run.
//
// So every function here returns counts for what it DID NOT do as well as what it did, and the
// daily report names the people who were skipped rather than counting them. A number nobody can
// act on is how the next one of these goes unnoticed for a week.
'use strict';

const { query } = require('../db');
const { renderNeed, needStepsOf, NEED_CAMPAIGNS } = require('../campaigns/needs');
const { buildQueue, varsFor } = require('../campaigns/outreach-queue');
const { gmailClientFor } = require('../gmail/client');
const { buildMessage } = require('../gmail/message');
const { replyState } = require('../gmail/thread');
const { labelForNeed, labelThread, ensureNeedLabels } = require('../gmail/labels');
const { SIG_NAME } = require('../campaigns/cphi-followup');

const DEFAULT_FROM = process.env.OUTREACH_FROM || 'sales@abiozen.com';
const DEFAULT_REPLY_TO = process.env.OUTREACH_REPLY_TO || 'naren@abiozen.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stepDef = (need, n) => (NEED_CAMPAIGNS[need] || { steps: [] }).steps.find((s) => s.step === n) || null;

// ── BOUNCE CLASSIFICATION ────────────────────────────────────────────────────
//
// A three-digit number is not a status code. The first version matched a bare /55[0-9]/ and
// classified "We need 550 grams of the compound" as a hard bounce — and since a delivery report
// quotes the original exchange, a buyer's own reply lands in the text being scanned. A reply read
// as a failure would stop that person's sequence permanently, which is the worst outcome here.
//
// The second version allowed "550 <Capitalised word>" and still matched "550 grams", because the
// pattern carries the `i` flag and [A-Z] matches lower case. Case cannot carry meaning in a
// case-insensitive regex.
//
// So a numeric code counts only with an enhanced status after it (550 5.1.1 …). "550 No such user
// here" is still caught, by the phrase list. The cost is missing a bare code with no wording,
// which is rare — and a missed bounce is far safer than a reply misread as a failure.
const CODE_HARD = String.raw`(?:^|[^\d.])5[0-5]\d\s+\d\.\d\.\d|\b5\.1\.[12]\b`;
const CODE_SOFT = String.raw`(?:^|[^\d.])4[0-5]\d\s+\d\.\d\.\d|\b4\.2\.2\b`;

const HARD = new RegExp(`${CODE_HARD}|does ?n'?o?t? exist|no such user|user unknown|unknown user|address rejected|recipient rejected|mailbox unavailable|account (has been )?disabled|no longer (with|at)`, 'i');
const SOFT = new RegExp(`${CODE_SOFT}|over quota|quota exceeded|mailbox full|temporar|greylist|try again later`, 'i');

/** hard | soft | unknown. An out-of-office is 'unknown', which is the important case. */
function classifyBounce(text) {
  const t = String(text || '');
  if (HARD.test(t)) return 'hard';
  if (SOFT.test(t)) return 'soft';
  return 'unknown';
}

const DAEMONS = ['mailer-daemon@*', 'postmaster@*'];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Every text/* part of a MIME tree, decoded. A report often hides the address in a nested part. */
function collectText(part, acc = []) {
  if (!part) return acc.join('\n');
  if (part.body && part.body.data && /^text\//.test(part.mimeType || '')) {
    try { acc.push(Buffer.from(part.body.data, 'base64').toString('utf8')); } catch (_) { /* skip */ }
  }
  for (const p of part.parts || []) collectText(p, acc);
  return acc.join('\n');
}

/**
 * Find delivery failures and record them.
 *
 * Matched against outreach_sends, never guessed: a report naming an address we never wrote to is
 * somebody else's problem arriving in a shared mailbox, and counting it would poison the rate
 * that decides whether the next batch may go.
 */
async function scanBounces(opts = {}) {
  const mailbox = opts.mailbox || DEFAULT_FROM;
  const days = Math.max(1, Math.min(90, opts.days || 14));
  const execute = !!opts.execute;
  const say = opts.log || (() => {});
  const out = { scanned: 0, found: [], recorded: 0, unmatched: 0, stopped: 0, rate: 0, sent: 0 };

  const ours = new Set(
    (await query('SELECT DISTINCT LOWER(to_email) e FROM outreach_sends')).rows.map((r) => r.e));
  out.sent = (await query('SELECT COUNT(*)::int n FROM outreach_sends')).rows[0].n;
  if (!ours.size) { say('   nothing sent yet, so nothing can have bounced'); return out; }

  const g = opts.gmail ? { gmail: opts.gmail } : await gmailClientFor(mailbox);
  if (g.error) throw new Error(`cannot read ${mailbox}: ${g.error}`);

  const after = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10).replace(/-/g, '/');
  const q = `(${DAEMONS.map((d) => `from:${d}`).join(' OR ')}) after:${after}`;
  const list = await g.gmail.users.messages.list({ userId: 'me', q, maxResults: 200 });
  const ids = (list.data.messages || []).map((m) => m.id);
  out.scanned = ids.length;

  for (const id of ids) {
    let msg;
    try {
      msg = await g.gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    } catch (e) { say(`   ⚠ could not read ${id}: ${e.message}`); continue; }
    const headers = Object.fromEntries(
      (msg.data.payload.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
    const hay = `${headers.subject || ''}\n${collectText(msg.data.payload)}`;
    const kind = classifyBounce(hay);
    const hits = [...new Set((hay.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))]
      .filter((e) => ours.has(e));
    if (!hits.length) { out.unmatched += 1; continue; }
    for (const e of hits) out.found.push({ email: e, kind, detail: (headers.subject || '').slice(0, 180) });
  }

  out.rate = out.sent ? new Set(out.found.map((f) => f.email)).size / out.sent : 0;
  if (!execute) return out;

  for (const f of out.found) {
    // Idempotent on (email, detail): re-running must not inflate the rate and eventually gate the
    // campaign on its own repetition.
    const r = await query(
      `INSERT INTO outreach_bounces (email, kind, detail)
       SELECT $1, $2, $3
        WHERE NOT EXISTS (SELECT 1 FROM outreach_bounces
                           WHERE LOWER(email)=LOWER($1) AND COALESCE(detail,'')=COALESCE($3,''))
       RETURNING id`, [f.email, f.kind, f.detail]);
    out.recorded += r.rowCount || 0;
  }

  const hard = [...new Set(out.found.filter((f) => f.kind === 'hard').map((f) => f.email))];
  if (hard.length) {
    const u = await query(
      `UPDATE outreach_state SET status='bounced', updated_at=NOW()
        WHERE LOWER(email) = ANY($1) AND status <> 'bounced'`, [hard]);
    out.stopped = u.rowCount || 0;
  }
  return out;
}

/**
 * Send whatever is due.
 *
 * Order of operations IS the safety property:
 *   1. reply check at the last possible moment, not when the queue was built
 *   2. claim the slot in outreach_sends BEFORE calling Gmail — the UNIQUE index is what makes a
 *      double-send impossible, including between two runs racing
 *   3. send
 *   4. file, reporting a label failure rather than throwing: by then the message has left, and
 *      treating a filing error as a send error records that it "may or may not have gone" when
 *      the truth is that it went and is unfiled
 */
async function runOutreach(opts = {}) {
  const FROM = opts.from || DEFAULT_FROM;
  const REPLY_TO = opts.replyTo || DEFAULT_REPLY_TO;
  const REDIRECT_TO = opts.redirectTo || null;
  const ONLY = opts.need || '';
  const MAX = Math.max(1, Math.min(50, opts.max || 8));
  const EXECUTE = !!opts.execute;
  const BOUNCE_LIMIT = opts.bounceLimit == null ? 0.05 : opts.bounceLimit;
  const [SPACE_MIN, SPACE_MAX] = opts.spacingMs || [45000, 95000];
  const say = opts.log || (() => {});

  const out = {
    dryRun: !EXECUTE, from: FROM, redirectTo: REDIRECT_TO,
    routed: 0, due: 0, batch: 0, sent: 0, failed: 0, unconfirmed: 0,
    skipped: {}, declined: [], unfiled: [], repliedNow: [], sentTo: [],
    bounceRate: 0, stopped: false,
  };

  // ── THE GATE, AND IT ONLY MEANS SOMETHING BECAUSE scanBounces FEEDS IT ────
  const b = (await query(`
    SELECT (SELECT COUNT(*)::int FROM outreach_sends) AS sent,
           (SELECT COUNT(DISTINCT LOWER(email))::int FROM outreach_bounces) AS bounced`)).rows[0];
  out.bounceRate = b.sent ? b.bounced / b.sent : 0;
  if (out.bounceRate > BOUNCE_LIMIT) {
    out.stopped = `bounce rate ${(out.bounceRate * 100).toFixed(1)}% is over the `
      + `${(BOUNCE_LIMIT * 100).toFixed(0)}% limit — verify the remaining addresses before sending more`;
    say(`   ✋ ${out.stopped}`);
    return out;
  }

  const all = await buildQueue(query);
  const routed = all.filter((r) => r.route && (!ONLY || r.route.need === ONLY));
  out.routed = routed.length;
  // The ones nobody will ever write to, with the field that is missing. Carried into the report,
  // because "22 not routed" is what hid a broken department check for a day.
  out.declined = all.filter((r) => !r.route).map((r) => ({ who: r.who, org: r.org, why: r.why }));

  const states = (await query('SELECT * FROM outreach_state')).rows;
  const byKey = new Map(states.map((s) => [`${s.channel}\u0000${s.ref}`, s]));

  const now = new Date();
  const queue = [];
  const skipped = { replied: 0, done: 0, notDue: 0, halted: 0, bounced: 0, cannotRender: 0 };

  for (const r of routed) {
    const st = byKey.get(`${r.channel}\u0000${r.ref}`) || null;
    if (st && st.status === 'replied') { skipped.replied += 1; continue; }
    if (st && st.status === 'halted') { skipped.halted += 1; continue; }
    if (st && st.status === 'bounced') { skipped.bounced += 1; continue; }

    const steps = needStepsOf(r.route.need);
    const nextStep = (st ? st.step_sent : 0) + 1;
    if (!steps.includes(nextStep)) { skipped.done += 1; continue; }
    if (st && st.next_due_at && new Date(st.next_due_at) > now) { skipped.notDue += 1; continue; }

    // A greeting that cannot be rendered is fatal by design: "Hi ," or a silent downgrade from
    // "Dear Professor Ball" to "Hi Nicholas" is worse than not sending.
    try { renderNeed(r.route.need, nextStep, varsFor(r)); } catch (e) {
      skipped.cannotRender += 1;
      out.declined.push({ who: r.who, org: r.org, why: e.message });
      continue;
    }
    queue.push({ ...r, state: st, nextStep });
  }

  out.skipped = skipped;
  out.due = queue.length;
  if (!queue.length) return out;

  const batch = queue.slice(0, MAX);
  out.batch = batch.length;
  if (!EXECUTE) {
    for (const q of batch) {
      const m = renderNeed(q.route.need, q.nextStep, varsFor(q));
      say(`      ${q.route.need}/${q.nextStep}  ${q.who} <${REDIRECT_TO || q.email}>`);
      say(`         ${m.isFollowUp ? 'replies in-thread' : `subject: ${m.subject}`}`);
      say(`         ${m.text.split('\n')[0]}`);
    }
    return out;
  }

  const g = await gmailClientFor(FROM);
  if (g.error) throw new Error(`cannot act as ${FROM}: ${g.error} — nothing is sent until that is fixed`);
  say(`   authorised as ${g.profile.emailAddress} via ${g.via} (${g.scopeSet})`);

  const folders = await ensureNeedLabels(g.gmail, FROM);
  if (!folders.ok) {
    say('   ⚠ folders could not be set up — threads will be UNFILED, and an unfiled thread is one');
    say('     whose reply never stops the sequence:');
    for (const e of folders.errors) say(`     ${e}`);
  }

  for (const q of batch) {
    const who = `${q.who} <${REDIRECT_TO || q.email}>`;
    const st = q.state;

    if (st && st.thread_id) {
      const rs = await replyState(g.gmail, st.thread_id, FROM);
      if (rs.replied === null) { say(`   — ${who}: cannot tell whether they replied (${rs.error}). Skipped.`); continue; }
      if (rs.replied) {
        await query(
          `UPDATE outreach_state SET status='replied', replied_at=NOW(), updated_at=NOW() WHERE id=$1`,
          [st.id]);
        out.repliedNow.push(q.who);
        say(`   ✓ ${who}: REPLIED — sequence stopped.`);
        continue;
      }
    }

    const m = renderNeed(q.route.need, q.nextStep, varsFor(q));

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

    try {
      const refs = (st && st.refs_chain ? st.refs_chain : '').split(/\s+/).filter(Boolean);
      const first = st && st.thread_id
        ? (await query('SELECT subject FROM outreach_sends WHERE channel=$1 AND ref=$2 AND step=1',
          [q.channel, q.ref])).rows[0]
        : null;
      const msg = buildMessage({
        from: { name: SIG_NAME, email: FROM },
        to: { name: q.who, email: REDIRECT_TO || q.email },
        // Sent from the warmed mailbox, answered to Naren's. Receiving needs no warmup, so the
        // reply lands where he reads it while the send rides the reputation sales@ has built.
        replyTo: { name: SIG_NAME, email: REPLY_TO },
        subject: m.subject || `Re: ${(first && first.subject) || 'our note'}`,
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

      const folder = labelForNeed(q.route.need);
      let filed = null;
      if (folder) filed = await labelThread(g.gmail, FROM, threadId, folder);
      if (!folder || !filed.ok) {
        out.unfiled.push({ who: q.who, threadId, why: folder ? filed.error : 'no folder' });
      }

      if (REDIRECT_TO) {
        out.sent += 1;
        say(`   ✅ ${who}  ${q.route.need}/${q.nextStep}  thread ${threadId}  (test — ${q.who} untouched)`);
        if (batch.indexOf(q) < batch.length - 1) await sleep(5000);
        continue;
      }

      await query('UPDATE outreach_sends SET rfc822_id=$2, thread_id=$3, confirmed=TRUE WHERE id=$1',
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

      out.sent += 1;
      out.sentTo.push({ who: q.who, email: q.email, need: q.route.need, step: q.nextStep,
        subject: m.subject, evidence: q.route.evidence });
      say(`   ✅ ${who}  ${q.route.need}/${q.nextStep}  thread ${threadId}`);
    } catch (e) {
      out.failed += 1;
      // The claim row stays, unconfirmed. Deliberate: it records that a send was attempted and we
      // do not know whether it left. A human decides, rather than the next run guessing.
      if (claimId) out.unconfirmed += 1;
      say(`   ✗ ${who}: ${e.message}`);
    }

    if (batch.indexOf(q) < batch.length - 1) {
      await sleep(SPACE_MIN + Math.floor(Math.random() * (SPACE_MAX - SPACE_MIN)));
    }
  }

  return out;
}

module.exports = {
  runOutreach, scanBounces, classifyBounce,
  HARD, SOFT, DEFAULT_FROM, DEFAULT_REPLY_TO,
};
