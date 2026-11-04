#!/usr/bin/env node
// ── WHAT IS ACTUALLY IN THESE THREADS ────────────────────────────────────────
//
//   railway ssh 'node scripts/cphi-evidence-probe.js'
//   railway ssh 'node scripts/cphi-evidence-probe.js --supplier=Alivus'
//   railway ssh 'node scripts/cphi-evidence-probe.js --report=json'
//
// READ-ONLY. No INSERT, UPDATE, DELETE or CREATE. Nothing is sent, no Gmail draft is created, and
// no file is written to disk — attachments are fetched into memory, identified, and discarded.
//
// ── THREE QUESTIONS, ONE PASS ───────────────────────────────────────────────
//
// 1. WHO IS ON EACH THREAD. Tiger Hu (Suzhou Motif) wrote "I'd like to introduce my colleague, Chi
//    Zhang, our Vice President of Sales" and then addressed Chi directly — "Chi, could you please
//    share with Naren... our full product catalogue". Chi is not in our contact list, so the one
//    person who was told to send us the catalogue is invisible to us. If he was a recipient on that
//    message his address is in the thread's own headers, which is authorized source evidence. The
//    alternative — guessing an address from a name and a domain — is how you mail a stranger.
//
// 2. WHAT EACH ATTACHMENT REALLY IS. The extractor routes on filename extension, so
//    `XNK-API-LIST-260924(2)(1).doc` was skipped on its name alone. A `.doc` from a supplier
//    exporting out of an unfamiliar tool is frequently RTF or HTML — plain text, readable today.
//    This reads the first bytes and says. It identifies and does not extract: a heuristic scraper
//    over a legacy Word binary produces a molecule name glued to the wrong CAS number, which is a
//    different substance wearing the confidence of a clean parse.
//
// 3. WHAT IS INSIDE THE ATTACHED EMAILS. Three replies carry a `.eml`, all three skipped as "not a
//    product list format", and they hold the best evidence in the mailbox:
//
//      Alivus     `RE: Book1.xlsx.eml`  — Rakesh: "the attached email which I had shared with
//                                         Palash earlier." The ORIGINAL list, forwarded to us by
//                                         the supplier. **No access to a departed employee's
//                                         mailbox is required, and none is attempted here.**
//      Chieron    `RE: Following up…`   — Sajan's earlier reply, the one he asked us to look for in
//                                         our spam folder. It was attached to his second message.
//      ScinoPharm `RE: …_Abiozen.eml`   — Candice's product-list website.
//
// This script impersonates nobody but the campaign's own mailbox, which is the mailbox that holds
// these threads.
'use strict';

// stdout is claimed before any other require: a payload mode must own the stream before a
// dependency gets a chance to print its startup warnings into the document. See
// scripts/lib/clean-stdout.js.
const { payloadMode } = require('./lib/clean-stdout');
const REPORT = ((process.argv.find((a) => a.startsWith('--report=')) || '').split('=')[1] || '').toLowerCase();
const REPORTING = REPORT === 'json';
const out = REPORTING ? payloadMode() : null;

const { initDB, query } = require('../src/lib/db');
const { isEvent } = require('../src/lib/events/registry');
const { gmailClientFor } = require('../src/lib/gmail/client');
const { readIncoming, otherParticipants } = require('../src/lib/gmail/incoming');
const { sniff } = require('../src/lib/catalogue/file-format');
const { partsOf } = require('../src/lib/catalogue/rfc822');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EVENT = arg('event', 'cphi-milan-2026');
const FROM_MAILBOX = arg('from', 'naren@abiozen.com');
const ONLY = arg('supplier', null);

if (REPORT && !REPORTING) {
  console.error(`--report=${REPORT} is not a format. Use --report=json.`);
  process.exit(2);
}

const say = (s = '') => (REPORTING ? null : console.log(s));
const kb = (n) => `${Math.round(n / 1024)} KB`;

(async () => {
  if (!isEvent(EVENT)) { console.error(`✗ "${EVENT}" is not an event`); process.exit(1); }
  await initDB();

  const threads = (await query(
    `SELECT st.thread_id, c.id AS contact_id, c.name, c.company, c.email
       FROM cphi_followup_state st
       JOIN cphi_exhibitor_contacts c ON c.id = st.contact_id
      WHERE st.event_slug = $1 AND st.status = 'replied' AND st.thread_id IS NOT NULL
      ORDER BY c.company`, [EVENT])).rows
    .filter((r) => !ONLY || new RegExp(ONLY, 'i').test(r.company));

  if (!threads.length) { say('   nothing to probe.\n'); if (REPORTING) out.emitJson({ threads: [] }); return; }

  const g = await gmailClientFor(FROM_MAILBOX);
  if (g.error) { console.error(`   ✗ cannot act as ${FROM_MAILBOX}: ${g.error}`); process.exit(1); }

  say(`\n── ${EVENT} · evidence probe · READ-ONLY, nothing written or sent\n`);

  // Every address already known to us, so a newly-seen participant stands out as a finding rather
  // than being lost in a list of people we have on file.
  const known = new Set((await query(
    `SELECT LOWER(email) e FROM cphi_exhibitor_contacts WHERE email IS NOT NULL`)).rows.map((r) => r.e));
  known.add(String(FROM_MAILBOX).toLowerCase());

  const record = [];

  for (const t of threads) {
    let msgs;
    try {
      msgs = ((await g.gmail.users.threads.get(
        { userId: 'me', id: t.thread_id, format: 'full' })).data.messages) || [];
    } catch (e) {
      say(`── ${t.company}\n   ✗ cannot read thread — ${(e && e.message) || e}\n`);
      record.push({ company: t.company, error: String((e && e.message) || e) });
      continue;
    }

    const entry = { company: t.company, contact: t.name, contact_email: t.email,
      thread_id: t.thread_id, participants: [], attachments: [] };

    // ── 1. PARTICIPANTS ──
    const seen = new Map();
    for (const m of msgs) {
      const p = readIncoming(m);
      if (!p.fromEmail || p.fromEmail === String(FROM_MAILBOX).toLowerCase()) continue;
      for (const a of otherParticipants(m.payload, FROM_MAILBOX)) {
        if (!seen.has(a.email.toLowerCase())) seen.set(a.email.toLowerCase(), a);
      }
      if (!seen.has(p.fromEmail)) seen.set(p.fromEmail, { name: p.from, email: p.fromEmail });
    }

    say(`── ${t.company}  (${t.name})`);
    for (const a of seen.values()) {
      const isNew = !known.has(a.email.toLowerCase());
      entry.participants.push({ name: a.name || null, email: a.email, known_contact: !isNew });
      say(`   ${isNew ? '➕ NOT IN CONTACTS' : '   on file         '}  ${(a.name || '').slice(0, 34).padEnd(36)} ${a.email}`);
    }

    // ── 2 & 3. ATTACHMENTS, BY THEIR BYTES ──
    for (const m of msgs) {
      const p = readIncoming(m);
      if (!p.fromEmail || p.fromEmail === String(FROM_MAILBOX).toLowerCase()) continue;
      for (const a of p.attachments) {
        let bytes;
        try {
          const att = await g.gmail.users.messages.attachments.get(
            { userId: 'me', messageId: m.id, id: a.attachmentId });
          bytes = Buffer.from(String(att.data.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        } catch (e) {
          say(`   ✗ ${a.filename}: cannot fetch — ${(e && e.message) || e}`);
          continue;
        }

        const s = sniff(bytes, a.filename);
        const rec = { filename: a.filename, bytes: bytes.length, declared_mime: a.mimeType || null,
          actual_format: s.format, readable: s.readable, extension_mismatch: s.mismatch,
          note: s.note, nested: null };
        say(`   📎 ${a.filename}`);
        say(`        ${kb(bytes.length).padEnd(10)} bytes say: ${s.format.padEnd(8)}`
          + `${s.mismatch ? ' ⚠ EXTENSION MISMATCH' : ''}${s.readable ? '  (text extractable)' : ''}`);
        say(`        ${s.note}`);

        // An attached email: open it and report what IT carries.
        if (s.format === 'rfc822' || /\.eml$/i.test(a.filename) || /rfc822/i.test(a.mimeType || '')) {
          const inner = partsOf(bytes);
          if (!inner.ok) {
            say(`        ↳ could not open this message: ${inner.reason}`);
            rec.nested = { ok: false, reason: inner.reason };
          } else {
            const inAtt = inner.parts.filter((q) => q.isAttachment);
            say(`        ↳ ATTACHED EMAIL — ${inner.subject || '(no subject)'}`);
            say(`             from ${inner.from || '(unknown)'}`);
            say(`             to   ${inner.to || '(unknown)'}${inner.cc ? `  ·  cc ${inner.cc}` : ''}`);
            say(`             date ${inner.date || '(unknown)'}`);
            rec.nested = { ok: true, subject: inner.subject, from: inner.from, to: inner.to,
              cc: inner.cc, date: inner.date, attachments: [] };
            if (!inAtt.length) say('             (no attachments of its own)');
            for (const q of inAtt) {
              const qs = sniff(q.bytes, q.filename || '');
              say(`             📎 ${q.filename || '(unnamed)'}  ${kb(q.bytes.length)}  → ${qs.format}`
                + `${qs.readable ? '  (text extractable)' : ''}`);
              rec.nested.attachments.push({ filename: q.filename, bytes: q.bytes.length,
                actual_format: qs.format, readable: qs.readable });
            }
          }
        }
        entry.attachments.push(rec);
      }
    }
    say('');
    record.push(entry);
  }

  // ── THE FINDINGS, GATHERED ──
  const newPeople = record.flatMap((e) => (e.participants || [])
    .filter((p) => !p.known_contact).map((p) => ({ company: e.company, ...p })));
  const mismatches = record.flatMap((e) => (e.attachments || [])
    .filter((a) => a.extension_mismatch).map((a) => ({ company: e.company, ...a })));
  const nested = record.flatMap((e) => (e.attachments || [])
    .filter((a) => a.nested && a.nested.ok && a.nested.attachments.length)
    .map((a) => ({ company: e.company, outer: a.filename, ...a.nested })));

  if (!REPORTING) {
    say('── FINDINGS ──\n');
    say(`   ${newPeople.length} participant(s) on a thread who are NOT in our contacts`);
    for (const p of newPeople) say(`      ${p.company}: ${p.name || '(no name)'} <${p.email}>`);
    say(`\n   ${mismatches.length} attachment(s) whose bytes disagree with their extension`);
    for (const m of mismatches) {
      say(`      ${m.company}: ${m.filename} — is ${m.actual_format}`
        + `${m.readable ? ', and its text IS extractable' : ''}`);
    }
    say(`\n   ${nested.length} attached email(s) carrying attachments of their own`);
    for (const n of nested) {
      say(`      ${n.company}: ${n.outer}`);
      say(`         "${n.subject}" from ${n.from}`);
      for (const q of n.attachments) say(`         → ${q.filename} (${q.actual_format})`);
    }
    say('\n   Nothing was written, sent, drafted or saved to disk.\n');
  } else {
    out.emitJson({
      event: EVENT, generated_at: new Date().toISOString(),
      wrote_nothing: true, sent_nothing: true, saved_nothing: true,
      findings: { unknown_participants: newPeople, extension_mismatches: mismatches, nested_emails: nested },
      threads: record,
    });
  }
  process.exit(0);
})().catch((e) => {
  console.error(`\ncphi-evidence-probe failed: ${(e && e.stack) || e}\n`);
  process.exit(1);
});
