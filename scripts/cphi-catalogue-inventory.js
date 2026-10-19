#!/usr/bin/env node
// ── WHAT THE SUPPLIERS ACTUALLY SENT ──────────────────────────────────────────
//
//   railway ssh 'node scripts/cphi-catalogue-inventory.js'
//
// Read-only. Downloads nothing, writes nothing. It lists every attachment sitting in the replied
// threads, with its type and size, and says which ones a parser could read.
//
// ── WHY THIS RUNS BEFORE THE PARSER IS WRITTEN ───────────────────────────────
//
// The job is "categorise the product lists into what we can list and what we cannot". The instinct
// is to write the categoriser. But nothing in this repo can read a spreadsheet today — there is no
// xlsx or PDF library in package.json — so the first real question is which formats arrived, and
// in what proportion.
//
// If they are all .xlsx, one dependency does the whole job. If half are PDF scans of a printed
// price list, no library helps and the honest answer is that somebody types them. If three of them
// are 40-page company brochures with no product table at all, they are not catalogues and no
// amount of parsing will make them one.
//
// Guessing wrong here means a week spent on a PDF pipeline for two files, or an afternoon's work
// that turns out to cover 90% of the material. One read-only pass settles it.
//
// It also answers a question nobody has asked yet and should have: how much of the demand is
// actually in hand. Eleven suppliers replying is a good headline; eleven suppliers who sent a
// two-line "nice to meet you" with no list attached is a different situation, and the status board
// cannot tell those apart.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { isEvent } = require('../src/lib/events/registry');
const { gmailClientFor } = require('../src/lib/gmail/client');
const { readIncoming } = require('../src/lib/gmail/incoming');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EVENT = arg('event', 'cphi-milan-2026');
const FROM_MAILBOX = arg('from', 'naren@abiozen.com');

// What a parser could do with each type, stated honestly rather than optimistically. A scanned PDF
// and a text PDF have the same extension and completely different prospects.
function readability(mime, filename) {
  const f = String(filename || '').toLowerCase();
  if (/\.(xlsx|xlsm)$/.test(f)) return { can: 'yes', how: 'SheetJS — one dependency, reads rows directly' };
  if (/\.xls$/.test(f)) return { can: 'yes', how: 'SheetJS reads legacy xls too' };
  if (/\.(csv|tsv|txt)$/.test(f)) return { can: 'yes', how: 'no dependency needed' };
  if (/\.pdf$/.test(f)) return { can: 'maybe', how: 'pdf-parse IF the text layer exists; a scan needs OCR or typing' };
  if (/\.(docx?|rtf)$/.test(f)) return { can: 'maybe', how: 'a product table in Word is usually irregular — inspect one first' };
  if (/\.(png|jpe?g|gif|webp|heic)$/.test(f)) return { can: 'no', how: 'an image of a list. OCR or type it' };
  if (/\.(zip|rar|7z)$/.test(f)) return { can: 'unpack', how: 'adm-zip is already a dependency — look inside first' };
  return { can: 'unknown', how: `unrecognised type (${mime || 'no mime'})` };
}

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const say = (s = '') => console.log(s);

async function main() {
  await initDB();
  if (!isEvent(EVENT)) { console.error(`✗ "${EVENT}" is not an event.`); process.exit(1); }

  const rows = (await query(
    `SELECT st.thread_id, st.campaign, c.name, c.company
       FROM cphi_followup_state st
       JOIN cphi_exhibitor_contacts c ON c.id = st.contact_id
      WHERE st.event_slug = $1 AND st.status = 'replied' AND st.thread_id IS NOT NULL
      ORDER BY c.company`, [EVENT])).rows;

  say(`\n── ${EVENT} · what the suppliers sent back  (read-only)\n`);
  if (!rows.length) { say('   nobody has replied yet.\n'); return; }

  const g = await gmailClientFor(FROM_MAILBOX);
  if (g.error) { console.error(`   ✗ cannot act as ${FROM_MAILBOX}: ${g.error}`); process.exit(1); }

  const withFiles = [];
  const withoutFiles = [];
  const byType = new Map();
  let unreadable = 0;

  for (const r of rows) {
    let msgs;
    try {
      msgs = ((await g.gmail.users.threads.get({ userId: 'me', id: r.thread_id, format: 'full' })).data.messages) || [];
    } catch (e) {
      say(`   ⚠ ${r.company}: cannot read the thread — ${(e && e.message) || e}`);
      continue;
    }

    // Only THEIR messages. Our own one-pager is attached to every outbound step, and counting it
    // would report a catalogue from every supplier including the ones who sent nothing.
    const theirs = msgs
      .map((m) => readIncoming(m))
      .filter((p) => p.fromEmail && p.fromEmail !== String(FROM_MAILBOX).toLowerCase());

    const files = [];
    for (const p of theirs) for (const a of p.attachments) files.push(a);

    if (!files.length) { withoutFiles.push(r); continue; }
    withFiles.push({ r, files });

    for (const f of files) {
      const rd = readability(f.mimeType, f.filename);
      const ext = (f.filename.match(/\.[a-z0-9]+$/i) || ['(none)'])[0].toLowerCase();
      const k = `${ext} · ${rd.can}`;
      byType.set(k, (byType.get(k) || 0) + 1);
      if (rd.can === 'no') unreadable += 1;
    }
  }

  say(`   ${withFiles.length} of ${rows.length} replied contacts sent at least one file.\n`);

  for (const { r, files } of withFiles) {
    say(`   ${r.company}  —  ${r.name}  (${r.campaign})`);
    for (const f of files) {
      const rd = readability(f.mimeType, f.filename);
      const mark = { yes: '✅', maybe: '◐ ', no: '✗ ', unpack: '📦', unknown: '? ' }[rd.can] || '? ';
      say(`      ${mark} ${f.filename}`);
      say(`         ${kb(f.size)} · ${f.mimeType}`);
      say(`         ${rd.how}`);
    }
    say();
  }

  if (withoutFiles.length) {
    say(`   ${withoutFiles.length} replied WITHOUT a file — these are conversations, not catalogues:`);
    for (const r of withoutFiles) say(`      ${r.company} — ${r.name}`);
    say(`      Worth re-reading: a supplier who answered but sent nothing may have put the list in`);
    say(`      the message body, or may be waiting for a question before sending anything.`);
    say();
  }

  say('   by file type:');
  for (const [k, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    say(`      ${String(n).padStart(3)}  ${k}`);
  }
  say();

  // ── WHAT TO DO NEXT, DECIDED BY WHAT IS ACTUALLY THERE ────
  const parseable = [...byType.entries()]
    .filter(([k]) => / · yes$/.test(k)).reduce((a, [, n]) => a + n, 0);
  const maybe = [...byType.entries()]
    .filter(([k]) => / · maybe$/.test(k)).reduce((a, [, n]) => a + n, 0);

  say('   READ OF THIS:');
  if (parseable === 0 && maybe === 0) {
    say('      Nothing here can be parsed. Whatever arrives next has to be typed, and the');
    say('      sensible move is to ask suppliers for a spreadsheet rather than build an OCR step.');
  } else if (parseable >= maybe) {
    say(`      ${parseable} file(s) are directly readable. One dependency (SheetJS) covers them,`);
    say('      which makes the extractor worth writing now.');
  } else {
    say(`      Only ${parseable} file(s) are directly readable against ${maybe} that may not be.`);
    say('      Inspect one of the uncertain ones by hand before committing to a PDF pipeline.');
  }
  if (unreadable) {
    say(`      ${unreadable} file(s) are images of a list. No library solves those — ask the`);
    say('      supplier for the underlying file; they will have one.');
  }
  say();
  say('   Next: scripts/cphi-catalogue-extract.js (not written yet — this run decides its shape).\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('cphi-catalogue-inventory failed:', e && e.message ? e.message : e);
  process.exit(1);
});
