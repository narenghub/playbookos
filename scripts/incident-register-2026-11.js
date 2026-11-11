#!/usr/bin/env node
// ── THE 25 MESSAGES THAT LEFT DURING THE GLOBAL STOP ─────────────────────────
//
//   railway ssh --service playbookos 'node /app/scripts/incident-register-2026-11.js'
//   …                                 'node /app/scripts/incident-register-2026-11.js --csv'
//
// READ-ONLY. No INSERT, UPDATE or DELETE. No provider call, no mailbox access, no draft, no
// label change. CEO Authorization B, 2026-11-10.
//
// One row per confirmed transmission between the capability stop and the S1 deploy, with what the
// database can actually establish about each — and an explicit UNKNOWN where it cannot.
//
// ── WHAT THIS CAN AND CANNOT KNOW ────────────────────────────────────────────
//
// It reads the senders' own claim and state tables. That gives the provider message id, the
// workflow, the timestamp, sender, recipient, subject, the sequence's reply state and its current
// follow-up position — all durable facts written at the time.
//
// It does NOT read mailboxes. "Replied" here means the reply-sync job recorded a reply against
// that sequence, which is the platform's own record and not an independent check of the inbox.
// Where that job has not run since, a reply may exist and be unrecorded. Reported as RECORDED /
// NONE RECORDED, never as a bare yes/no, because the difference matters to whoever follows up.
//
// COMMERCIAL CONTENT is judged from what was STORED. outreach_sends keeps the opening sentence in
// `evidence`; cphi_followup_sends keeps only the subject. So for CPHI the body was never retained
// and the honest answer is UNKNOWN — not "no". A register that reports absence of evidence as
// evidence of absence is the same defect as the report that said no email had left at all.

'use strict';

const CONTAINMENT_FROM = '2026-11-03T13:42:33Z';   // capability:email.send set
const CONTAINMENT_TO   = '2026-11-10T17:10:00Z';   // S1 deploy closed the gap
const CSV = process.argv.includes('--csv');

// Words that would make a message commercially consequential rather than exploratory.
const COMMERCIAL = /\b(quote|quotation|price|pricing|\$|usd|per kg|per gram|invoice|purchase order|\bPO\b|accept|accepted|proceed|confirm your order|terms|payment)\b/i;

// ── WHAT `evidence` ACTUALLY IS, AND WHY THE FIRST VERSION OF THIS OVERSTATED ──
//
// outreach_sends.evidence holds ONE SENTENCE — the personalisation opener, e.g. "I came across
// your work on site-selective catalysis through 2R35GM132092-06 (running to May 2029)." It is not
// the message body; the body was never retained.
//
// The first version of this register reported "no commercial language found" on that basis, and
// the CEO read a summary line saying 0 of 25 carried commercial language. That is a conclusion
// about the whole message drawn from its first sentence — absence of evidence presented as
// evidence of absence, which is the precise error that produced this incident. Corrected rather
// than left standing: the opening line is reported as what it is, and the rest as unverifiable.
function classify(text) {
  if (text === null || text === undefined || String(text).trim() === '') {
    return 'UNKNOWN — body not retained';
  }
  return COMMERCIAL.test(String(text))
    ? 'YES — commercial language in the opening line'
    : 'PARTIAL — opening line is clean; remainder of the body was not retained';
}

(async () => {
  const { query } = require('../src/lib/db');
  const rows = [];

  const present = async (t) => (await query(`SELECT to_regclass($1) IS NOT NULL AS yes`, [t])).rows[0].yes;

  // ── CPHI ────────────────────────────────────────────────────────────────
  if (await present('cphi_followup_sends')) {
    const r = await query(
      `SELECT s.gmail_message_id, s.rfc822_message_id, s.sent_at, s.to_email, s.subject,
              s.campaign, s.step, s.error,
              st.status AS seq_status, st.replied_at, st.step_sent, st.next_due_at
         FROM cphi_followup_sends s
         LEFT JOIN cphi_followup_state st
           ON st.event_slug = s.event_slug AND st.contact_id = s.contact_id AND st.campaign = s.campaign
        WHERE s.sent_at >= $1::timestamptz AND s.sent_at < $2::timestamptz
          AND s.gmail_message_id IS NOT NULL
        ORDER BY s.sent_at`, [CONTAINMENT_FROM, CONTAINMENT_TO]);
    for (const x of r.rows) {
      rows.push({
        provider_message_id: x.gmail_message_id,
        rfc822_id: x.rfc822_message_id || '',
        workflow: `cphi-followup / ${x.campaign} step ${x.step}`,
        sent_at: x.sent_at.toISOString(),
        sender: 'naren@abiozen.com (Naren Boda)',
        recipient: x.to_email,
        subject: x.subject || '(threaded reply — no subject of its own)',
        replied: x.replied_at ? `RECORDED ${x.replied_at.toISOString()}` : 'none recorded',
        commercial: classify(null),           // CPHI retains no body
        sequence_now: x.seq_status || 'UNKNOWN',
        followed_by: x.next_due_at ? `next step due ${x.next_due_at.toISOString()}` : 'no further step scheduled',
      });
    }
  }

  // ── OUTREACH ────────────────────────────────────────────────────────────
  if (await present('outreach_sends')) {
    const r = await query(
      `SELECT s.rfc822_id, s.sent_at, s.to_email, s.subject, s.channel, s.need, s.step,
              s.evidence, s.confirmed,
              st.status AS seq_status, st.replied_at, st.next_due_at
         FROM outreach_sends s
         LEFT JOIN outreach_state st ON st.channel = s.channel AND st.ref = s.ref
        WHERE s.sent_at >= $1::timestamptz AND s.sent_at < $2::timestamptz
          AND (s.confirmed OR s.rfc822_id IS NOT NULL)
        ORDER BY s.sent_at`, [CONTAINMENT_FROM, CONTAINMENT_TO]);
    for (const x of r.rows) {
      rows.push({
        provider_message_id: x.rfc822_id || '(confirmed, id not retained)',
        rfc822_id: x.rfc822_id || '',
        workflow: `outreach / ${x.channel}-${x.need} step ${x.step}`,
        sent_at: x.sent_at.toISOString(),
        sender: 'sales@abiozen.com (Naren Boda, reply-to naren@abiozen.com)',
        recipient: x.to_email,
        subject: x.subject || '(threaded reply — no subject of its own)',
        replied: x.replied_at ? `RECORDED ${x.replied_at.toISOString()}` : 'none recorded',
        commercial: classify(x.evidence),
        sequence_now: x.seq_status || 'UNKNOWN',
        followed_by: x.next_due_at ? `next step due ${x.next_due_at.toISOString()}` : 'no further step scheduled',
      });
    }
  }

  rows.sort((a, b) => a.sent_at.localeCompare(b.sent_at));

  if (CSV) {
    const cols = ['sent_at', 'workflow', 'sender', 'recipient', 'subject', 'provider_message_id',
      'replied', 'commercial', 'sequence_now', 'followed_by'];
    console.log(cols.join(','));
    for (const r of rows) {
      console.log(cols.map((c) => `"${String(r[c] || '').replace(/"/g, '""')}"`).join(','));
    }
    process.exit(0);
  }

  console.log('\n══ INCIDENT REGISTER — TRANSMISSIONS DURING THE GLOBAL STOP (READ-ONLY) ══\n');
  console.log(`    window        ${CONTAINMENT_FROM}  →  ${CONTAINMENT_TO}`);
  console.log(`    messages      ${rows.length}`);
  console.log(`    generated     ${new Date().toISOString()}\n`);

  let needsReview = 0;
  rows.forEach((r, i) => {
    // A message needs a human if somebody replied, or if it carried commercial language, or if the
    // sequence is still live and will chase them again.
    const reasons = [];
    if (r.replied.startsWith('RECORDED')) reasons.push('recipient replied');
    if (r.commercial.startsWith('YES')) reasons.push('commercial language');
    if (r.commercial.startsWith('UNKNOWN')) reasons.push('body not retained — content unverifiable');
    if (r.commercial.startsWith('PARTIAL')) reasons.push('only the opening line was retained');
    if (/due/.test(r.followed_by) && r.sequence_now === 'active') reasons.push('sequence still active');
    if (reasons.length) needsReview += 1;

    console.log(`  ${String(i + 1).padStart(2)}. ${r.sent_at}  ${r.recipient}`);
    console.log(`      workflow    ${r.workflow}`);
    console.log(`      sender      ${r.sender}`);
    console.log(`      subject     ${String(r.subject).slice(0, 80)}`);
    console.log(`      message id  ${r.provider_message_id}`);
    console.log(`      replied     ${r.replied}`);
    console.log(`      commercial  ${r.commercial}`);
    console.log(`      sequence    ${r.sequence_now} · ${r.followed_by}`);
    console.log(`      REVIEW      ${reasons.length ? reasons.join('; ') : 'none required'}`);
    console.log('');
  });

  console.log(`  ── summary ──\n`);
  console.log(`    total                      ${rows.length}`);
  console.log(`    replies RECORDED           ${rows.filter((r) => r.replied.startsWith('RECORDED')).length}`);
  console.log(`    commercial in opening line ${rows.filter((r) => r.commercial.startsWith('YES')).length}`);
  console.log(`    opening line clean, rest unknown  ${rows.filter((r) => r.commercial.startsWith('PARTIAL')).length}`);
  console.log(`    body not retained at all   ${rows.filter((r) => r.commercial.startsWith('UNKNOWN')).length}`);
  console.log('');
  console.log('    NO MESSAGE IN THIS REGISTER HAS BEEN FULLY READ. 19 retain one sentence, 6 retain');
  console.log('    nothing. A count of zero commercial messages cannot be stated from this data.');
  console.log(`    sequences still active     ${rows.filter((r) => r.sequence_now === 'active').length}`);
  console.log(`    REQUIRE HUMAN REVIEW       ${needsReview}\n`);

  console.log('  --    "replied" is the platform\'s own record from the reply-sync job, NOT an independent');
  console.log('  --    inbox check. A reply may exist unrecorded. Nothing here opened a mailbox.');
  console.log('  --    CPHI retains NO body. outreach retains ONE SENTENCE — the personalisation opener,');
  console.log('  --    not the message. Neither supports a statement that a message was non-commercial.');
  console.log('  --    Absence of evidence is not evidence of absence; that error is what produced');
  console.log('  --    this incident in the first place.\n');
  process.exit(0);
})().catch((e) => { console.error('register failed:', e && e.message); process.exit(1); });
