#!/usr/bin/env node
// ── DRAFT THE ANSWER TO EACH SUPPLIER WHO REPLIED ─────────────────────────────
//
//   railway ssh 'node scripts/draft-cphi-replies.js'            → shows what it would draft
//   railway ssh 'node scripts/draft-cphi-replies.js --execute'   → creates Gmail drafts
//
// ── IT DRAFTS. IT DOES NOT SEND. ─────────────────────────────────────────────
//
// Every other message in this campaign went to somebody who had not yet spoken to us, where a
// well-made template is the right tool. These eight have spoken. One asked a question, one pointed
// at a colleague, several attached a catalogue — and a template fired into a live conversation
// answers the question nobody asked and reads, correctly, as a machine.
//
// So this writes a Gmail draft into each thread, in reply to THEIR latest message, and stops.
// Naren opens eight drafts, adds the sentence only he can add, and presses send. That is a few
// minutes of work and it is the difference between a reply and a response.
//
// Nothing here writes to the campaign tables either: a draft is not a send, and the sequence for
// these contacts is already stopped at `replied`, which is correct and must stay that way.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { isEvent } = require('../src/lib/events/registry');
const { gmailClientFor } = require('../src/lib/gmail/client');
const { buildMessage } = require('../src/lib/gmail/message');
const { readIncoming, looksLikeCatalogue } = require('../src/lib/gmail/incoming');
const { splitName } = require('../src/lib/campaigns/name-split');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EVENT = arg('event', 'cphi-milan-2026');
const FROM_MAILBOX = arg('from', 'naren@abiozen.com');
const EXECUTE = process.argv.includes('--execute');

const SIG_NAME = 'Naren Boda';
const SIG_ROLE = 'Director, Abiozen LLC';
const SIG_TEL = '+1 (773) 964-5150';

// ── THE TWO VERSIONS, AND WHY THERE ARE TWO ──────────────────────────────────
//
// Naren's instruction: "once we review all the product as per demand, then we will schedule
// onboarding through the supplier platform, where you can upload selected product. From there we
// directly take and enter into the marketplace."
//
// Somebody who attached a catalogue needs that exact message. Somebody who replied WITHOUT one
// cannot be told we are reviewing a list we do not have — so they get the same next step with the
// list asked for first. Sending the catalogue version to a man who sent no catalogue is how you
// look like you did not read his email.
//
// The portal is described, not named. AROS is in early release, and naming a product to a supplier
// invites "send me the link" before there is a link to send. The capability is real and the
// sentence is true either way; swap in the name when the login page exists.
function body({ first, hasCatalogue }) {
  const thanks = hasCatalogue
    ? 'Thank you — the product list came through, and that is exactly what I needed.'
    : 'Thank you for coming back to me.';

  const ask = hasCatalogue ? '' : `
The one thing I still need is your full product list — the complete catalogue rather than only the molecules we discussed in Milan. Where a DMF is on file, and indicative lead times, would let us answer a buyer without coming back to you first.
`;

  const review = hasCatalogue
    ? 'We are reviewing it now against the demand we are holding, and I will come back to you with the molecules we want to take forward.'
    : 'Once it reaches me we will review it against the demand we are holding, and I will come back with the molecules we want to take forward.';

  return `Hi ${first},

${thanks}
${ask}
${review}

The step after that is onboarding you on our supplier portal. You get an account, you upload the products we have agreed with their documentation, and from there we publish them to the Abiozen marketplace directly. That way nothing is re-typed between us, and you keep control of what is listed and what is not.

Nothing is needed from you in the meantime. If anything changes on your side — new capacity, a molecule you would like us to push — send it over and I will fold it in.

Best regards,
${SIG_NAME}
${SIG_ROLE}
${FROM_MAILBOX} · ${SIG_TEL}`;
}

async function main() {
  await initDB();
  if (!isEvent(EVENT)) { console.log(`✗ "${EVENT}" is not an event.`); process.exit(1); }

  const rows = (await query(
    `SELECT st.thread_id, st.campaign, c.name, c.company, c.email, c.greeting_name
       FROM cphi_followup_state st
       JOIN cphi_exhibitor_contacts c ON c.id = st.contact_id
      WHERE st.event_slug = $1 AND st.status = 'replied' AND st.thread_id IS NOT NULL
      ORDER BY c.company`, [EVENT])).rows;

  console.log(`── ${EVENT} · drafting replies · ${EXECUTE ? 'WRITING DRAFTS' : 'dry run'}\n`);
  if (!rows.length) { console.log('   nobody has replied yet.\n'); return; }

  const g = await gmailClientFor(FROM_MAILBOX);
  if (g.error) { console.log(`   ✗ cannot act as ${FROM_MAILBOX}: ${g.error}`); process.exit(1); }

  let drafted = 0;
  const skipped = [];

  for (const r of rows) {
    const split = splitName(r.name);
    const first = (r.greeting_name && r.greeting_name.trim()) || (split.safe ? split.first : null);
    if (!first) {
      // The same rule as the campaign: a greeting we cannot derive is fatal, not defaulted.
      skipped.push({ r, why: `no usable first name (${split.why})` });
      continue;
    }

    let msgs;
    try {
      msgs = ((await g.gmail.users.threads.get({ userId: 'me', id: r.thread_id, format: 'full' })).data.messages) || [];
    } catch (e) {
      skipped.push({ r, why: `cannot read the thread: ${(e && e.message) || e}` });
      continue;
    }

    const theirs = msgs.map((m) => ({ raw: m, parsed: readIncoming(m) }))
      .filter((x) => x.parsed.fromEmail && x.parsed.fromEmail !== String(FROM_MAILBOX).toLowerCase());
    if (!theirs.length) { skipped.push({ r, why: 'no inbound message in the thread' }); continue; }

    const last = theirs[theirs.length - 1];
    const hasCatalogue = theirs.some((x) => x.parsed.attachments.some(looksLikeCatalogue));

    // A draft already sitting in this thread means somebody has been here. Do not add a second.
    let existing = [];
    try {
      existing = ((await g.gmail.users.drafts.list({ userId: 'me', maxResults: 100 })).data.drafts) || [];
    } catch (_) { /* a failed list must not block the draft */ }
    if (existing.some((d) => d.message && d.message.threadId === r.thread_id)) {
      skipped.push({ r, why: 'a draft already exists in this thread' });
      continue;
    }

    // Thread properly: In-Reply-To and References from THEIR message, so it lands under their
    // reply rather than starting a parallel branch in their client.
    const theirId = (last.raw.payload.headers.find((h) => /^message-id$/i.test(h.name)) || {}).value || null;
    const theirRefs = ((last.raw.payload.headers.find((h) => /^references$/i.test(h.name)) || {}).value || '')
      .split(/\s+/).filter(Boolean);
    const subject = last.parsed.subject.replace(/^\s*(re:\s*)+/i, '');

    const text = body({ first, hasCatalogue });
    console.log(`   ${r.name} — ${r.company}  ${hasCatalogue ? '[catalogue received]' : '[no catalogue yet]'}`);
    if (!EXECUTE) {
      console.log(`      would draft in thread ${r.thread_id}, replying to ${last.parsed.fromEmail}`);
      console.log(`      "Hi ${first}," · ${text.split('\n').length} lines\n`);
      drafted += 1;
      continue;
    }

    const msg = buildMessage({
      from: { name: SIG_NAME, email: FROM_MAILBOX },
      to: { name: r.name, email: last.parsed.fromEmail || r.email },
      subject: `Re: ${subject}`,
      text,
      html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#15202b;max-width:620px">${
        text.split('\n\n').map((p) => `<p style="margin:0 0 13px 0">${p.replace(/\n/g, '<br>')}</p>`).join('')
      }</div>`,
      inReplyTo: theirId,
      references: theirRefs.length ? theirRefs : (theirId ? [theirId] : []),
    });

    const res = await g.gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw: msg.raw, threadId: r.thread_id } },
    });
    drafted += 1;
    console.log(`      ✅ draft ${res.data.id} created in thread ${r.thread_id}\n`);
  }

  if (skipped.length) {
    console.log(`   ${skipped.length} not drafted:`);
    for (const s of skipped) console.log(`      ${s.r.name} — ${s.r.company}: ${s.why}`);
    console.log();
  }

  if (!EXECUTE) {
    console.log(`   ${drafted} would be drafted. DRY RUN — nothing written.`);
    console.log('   Re-run with --execute.\n');
    return;
  }
  console.log(`   ${drafted} draft(s) waiting in Gmail. NOTHING WAS SENT.`);
  console.log('   Open each one, add the line only you can add, and send it.\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('draft-cphi-replies failed:', e && e.message ? e.message : e);
  process.exit(1);
});
