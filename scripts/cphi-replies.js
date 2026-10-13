#!/usr/bin/env node
// ── THE REPLY QUEUE: WHO ANSWERED AND WHAT THEY SENT ──────────────────────────
//
//   railway ssh 'node scripts/cphi-replies.js'              → the queue
//   railway ssh 'node scripts/cphi-replies.js --full'        → whole message bodies
//
// Read-only. Sends nothing, writes nothing, downloads nothing.
//
// Eight CPHI suppliers answered inside a day. The point of a queue rather than an inbox is that it
// puts the ONE thing that matters in front — whether a product catalogue is attached — because
// that file is the supply data the marketplace is short of, and it is what decides whether this
// contact moves to onboarding or needs another email.
//
// Ordered with catalogues first. An inbox is chronological, which is the wrong order for work.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { isEvent } = require('../src/lib/events/registry');
const { gmailClientFor } = require('../src/lib/gmail/client');
const { readIncoming, looksLikeCatalogue } = require('../src/lib/gmail/incoming');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EVENT = arg('event', 'cphi-milan-2026');
const FROM_MAILBOX = arg('from', 'naren@abiozen.com');
const FULL = process.argv.includes('--full');

const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

async function main() {
  await initDB();
  if (!isEvent(EVENT)) { console.log(`✗ "${EVENT}" is not an event.`); process.exit(1); }

  const rows = (await query(
    `SELECT st.id AS state_id, st.campaign, st.thread_id, st.replied_at, st.step_sent,
            c.id AS contact_id, c.name, c.company, c.email, c.title
       FROM cphi_followup_state st
       JOIN cphi_exhibitor_contacts c ON c.id = st.contact_id
      WHERE st.event_slug = $1 AND st.status = 'replied' AND st.thread_id IS NOT NULL
      ORDER BY st.replied_at`, [EVENT])).rows;

  console.log(`── ${EVENT} · replies  (read-only)\n`);
  if (!rows.length) {
    console.log('   nobody has replied yet.\n');
    return;
  }

  const g = await gmailClientFor(FROM_MAILBOX);
  if (g.error) { console.log(`   ✗ cannot act as ${FROM_MAILBOX}: ${g.error}`); process.exit(1); }

  const entries = [];
  for (const r of rows) {
    let msgs = [];
    try {
      msgs = ((await g.gmail.users.threads.get({
        userId: 'me', id: r.thread_id, format: 'full',
      })).data.messages) || [];
    } catch (e) {
      entries.push({ r, error: (e && e.message) || String(e) });
      continue;
    }
    // Their messages only — ours are in the thread too and are not news.
    const theirs = msgs.map(readIncoming)
      .filter((m) => m.fromEmail && m.fromEmail !== String(FROM_MAILBOX).toLowerCase());
    if (!theirs.length) { entries.push({ r, error: 'no inbound message found in the thread' }); continue; }
    entries.push({ r, msgs: theirs });
  }

  // Catalogues first: that is the order the work should be done in, not the order it arrived.
  entries.sort((a, b) => {
    const score = (e) => (e.msgs ? (e.msgs.some((m) => m.hasCatalogue) ? 2 : (e.msgs.some((m) => m.attachments.length) ? 1 : 0)) : -1);
    return score(b) - score(a);
  });

  let withCatalogue = 0;
  let needsReading = 0;

  for (const e of entries) {
    const { r } = e;
    console.log(`── ${r.name} — ${r.company}`);
    if (r.title) console.log(`   ${r.title}`);
    console.log(`   ${r.email}  ·  ${r.campaign}/step ${r.step_sent}`
      + `${r.replied_at ? `  ·  replied ${new Date(r.replied_at).toISOString().slice(0, 16).replace('T', ' ')}` : ''}`);

    if (e.error) { console.log(`   ✗ ${e.error}\n`); continue; }

    const atts = e.msgs.flatMap((m) => m.attachments);
    const cats = atts.filter(looksLikeCatalogue);
    if (cats.length) {
      withCatalogue += 1;
      console.log(`   📎 CATALOGUE: ${cats.map((a) => `${a.filename} (${kb(a.size)})`).join(', ')}`);
      const others = atts.filter((a) => !looksLikeCatalogue(a));
      if (others.length) console.log(`      also: ${others.map((a) => a.filename).join(', ')}`);
    } else if (atts.length) {
      console.log(`   📎 ${atts.map((a) => `${a.filename} (${kb(a.size)})`).join(', ')}`);
      console.log('      Not a parseable catalogue — read it by hand.');
    } else {
      needsReading += 1;
      console.log('   (no attachment — the answer is in the words)');
    }

    for (const m of e.msgs) {
      const body = FULL ? m.text : m.text.split('\n').slice(0, 8).join('\n');
      const clipped = !FULL && m.text.split('\n').length > 8;
      console.log(`\n   ┌ ${m.date}`);
      for (const line of (body || '(empty)').split('\n')) console.log(`   │ ${line}`);
      if (clipped) console.log('   │ … (--full for the rest)');
      console.log('   └');
    }
    console.log();
  }

  console.log(`   ${entries.length} repl${entries.length === 1 ? 'y' : 'ies'}`
    + ` · ${withCatalogue} with a catalogue attached`
    + ` · ${needsReading} to read and answer by hand\n`);
  console.log('   Draft responses:  node scripts/draft-cphi-replies.js');
  console.log('   That writes Gmail DRAFTS in each thread. Nothing is sent.\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('cphi-replies failed:', e && e.message ? e.message : e);
  process.exit(1);
});
