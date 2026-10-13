#!/usr/bin/env node
// ── WHAT ACTUALLY HAPPENED TO EVERY CPHI MESSAGE ──────────────────────────────
//
//   railway ssh 'node scripts/audit-cphi-delivery.js'            → the audit, read-only
//   railway ssh 'node scripts/audit-cphi-delivery.js --no-dns'    → skip the MX checks
//
// Read-only. Sends nothing, writes nothing.
//
// ── WHAT CANNOT BE KNOWN, SAID FIRST ─────────────────────────────────────────
//
// Naren asked how many were delivered and how many were not. Email cannot answer the first half.
// There is no delivery receipt in SMTP and none in the Gmail API: a server accepts a message for
// relay and what happens next — inbox, spam folder, silent discard — is invisible to the sender.
// Any tool reporting "98% delivered" for ordinary mail is reporting "accepted for relay".
//
// So this reports three states and names them honestly:
//
//   FAILED          a bounce came back. Proof of failure, with the reason.
//   CANNOT RECEIVE  the domain has no MX record or does not exist. Proof the address was never
//                   going to work — and knowable WITHOUT sending, which is the useful part for
//                   addresses transcribed by hand from business cards.
//   NO FAILURE      sent, nothing came back. The strongest claim the protocol supports. Most of
//                   these did arrive; some fraction will be sitting in a junk folder and no API
//                   will ever tell us which.
//
// Replies are reported too, because a reply is the only POSITIVE proof of delivery there is. A
// human answering is worth more than any delivery metric.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { isEvent } = require('../src/lib/events/registry');
const { gmailClientFor } = require('../src/lib/gmail/client');
const { readBounce, classifyBounce, bounceQuery, domainAcceptsMail } = require('../src/lib/gmail/bounces');
const { replyState } = require('../src/lib/gmail/thread');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EVENT = arg('event', 'cphi-milan-2026');
const FROM_MAILBOX = arg('from', 'naren@abiozen.com');
const DAYS = parseInt(arg('days', '14'), 10);
const NO_DNS = process.argv.includes('--no-dns');

async function main() {
  await initDB();
  if (!isEvent(EVENT)) { console.log(`✗ "${EVENT}" is not an event.`); process.exit(1); }

  const sends = (await query(
    `SELECT s.id, s.campaign, s.step, s.to_email, s.sent_at, s.gmail_thread_id, s.error,
            c.name, c.company, c.id AS contact_id
       FROM cphi_followup_sends s
       JOIN cphi_exhibitor_contacts c ON c.id = s.contact_id
      WHERE s.event_slug = $1
      ORDER BY c.company, s.step`, [EVENT])).rows;

  console.log(`── ${EVENT} · delivery audit  (read-only)\n`);
  if (!sends.length) { console.log('   nothing has been sent yet.\n'); return; }

  const confirmed = sends.filter((s) => s.sent_at);
  const unconfirmed = sends.filter((s) => !s.sent_at);
  console.log(`   ${confirmed.length} message(s) accepted by Gmail`
    + `${unconfirmed.length ? `, ${unconfirmed.length} claimed but never confirmed` : ''}\n`);

  const g = await gmailClientFor(FROM_MAILBOX);
  if (g.error) { console.log(`   ✗ cannot act as ${FROM_MAILBOX}: ${g.error}`); process.exit(1); }

  // ── 1. BOUNCES: PROOF OF FAILURE ────
  const bounces = [];
  try {
    const list = (await g.gmail.users.messages.list({
      userId: 'me', q: bounceQuery(DAYS), maxResults: 200,
    })).data.messages || [];
    for (const m of list) {
      const full = (await g.gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' })).data;
      const b = readBounce(full);
      if (b.isBounce) bounces.push(b);
    }
  } catch (e) {
    console.log(`   ⚠ could not search for bounces: ${(e && e.message) || e}`);
    console.log('     The rest of the audit still runs, but FAILED cannot be reported.\n');
  }

  // Match on recipient address — the one field a DSN is guaranteed to carry.
  const bounceFor = new Map();
  for (const b of bounces) {
    for (const r of b.recipients) {
      const key = String(r).toLowerCase();
      // Keep the worst one: a permanent failure outranks a delay for the same address.
      const prev = bounceFor.get(key);
      if (!prev || (b.permanent && !prev.permanent)) bounceFor.set(key, b);
    }
  }
  console.log(`   ${bounces.length} bounce message(s) in the last ${DAYS} days,`
    + ` naming ${bounceFor.size} distinct address(es)\n`);

  // ── 2. MX: KNOWABLE WITHOUT SENDING ────
  const mx = new Map();
  if (!NO_DNS) {
    const domains = [...new Set(confirmed.map((s) => String(s.to_email).split('@')[1]).filter(Boolean))];
    let unknown = 0;
    for (const d of domains) {
      const r = await domainAcceptsMail(`x@${d}`);
      mx.set(d, r);
      if (r.ok === null) unknown += 1;
    }
    if (unknown === domains.length && domains.length) {
      console.log(`   ⚠ every MX lookup failed (${domains.length} domains) — this host has no DNS.`);
      console.log('     Treating that as "unknown", NOT as bad addresses.\n');
    }
  }

  // ── 3. REPLIES: THE ONLY POSITIVE PROOF ────
  const replied = [];
  const threads = [...new Set(confirmed.map((s) => s.gmail_thread_id).filter(Boolean))];
  for (const t of threads) {
    const rs = await replyState(g.gmail, t, FROM_MAILBOX);
    if (rs.replied) replied.push(t);
  }

  // ── THE REPORT ────
  const failed = [];
  const cannotReceive = [];
  const noFailure = [];

  for (const s of confirmed) {
    const b = bounceFor.get(String(s.to_email).toLowerCase());
    const domain = String(s.to_email).split('@')[1] || '';
    const m = mx.get(domain);
    if (b) failed.push({ s, b });
    else if (m && m.ok === false) cannotReceive.push({ s, m });
    else noFailure.push(s);
  }

  if (failed.length) {
    console.log(`   ✗ FAILED — ${failed.length} message(s) bounced:\n`);
    for (const { s, b } of failed) {
      console.log(`      ${s.name} — ${s.company}`);
      console.log(`         ${s.to_email}  (${s.campaign}/${s.step})`);
      console.log(`         ${b.permanent ? 'PERMANENT' : 'temporary — Gmail keeps retrying'}`
        + `${b.status ? ` · ${b.status}` : ''}`);
      if (b.diagnostic) console.log(`         ${b.diagnostic}`);
      const c = classifyBounce(b);
      console.log(`         [${c.kind}] ${b.permanent ? c.advice
        : 'No action — a 4.x.x clears itself or becomes a hard bounce later.'}`);
      console.log();
    }
    // The shape of the failures matters more than the count. Several sender-side rejections at once
    // is a deliverability problem, and it also means the "no failure" group cannot be trusted:
    // a server that refuses our mail outright is in the minority — far more will have accepted it
    // and filed it as junk, silently.
    const kinds = {};
    for (const { s, b } of failed) kinds[classifyBounce(b).kind] = (kinds[classifyBounce(b).kind] || 0) + 1;
    console.log(`      by cause: ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
    const dataProblems = (kinds.bad_mailbox || 0) + (kinds.no_such_domain || 0) + (kinds.likely_bad_address || 0);
    const senderSide = (kinds.sender_blocked || 0) + (kinds.policy_reject || 0);
    if (dataProblems) {
      console.log(`\n      ${dataProblems} of ${failed.length} point at the ADDRESS — re-read those cards.`);
    }
    if (senderSide >= 2) {
      console.log(`\n      ⚠ ${senderSide} are the recipient's server refusing mail rather than a bad`);
      console.log(`        address. Two or more of those together is worth checking before re-typing`);
      console.log(`        anything: node scripts/check-email-auth.js`);
    } else if (senderSide === 1) {
      console.log(`\n      1 is a sender-side refusal. One in a run of this size is ordinary — a single`);
      console.log(`        strict tenant, not a pattern. Not worth acting on by itself.`);
    }
    console.log();
  } else {
    console.log('   ✅ FAILED — none. No bounce came back for any address.\n');
  }

  if (cannotReceive.length) {
    console.log(`   ✗ CANNOT RECEIVE — ${cannotReceive.length} address(es) on a domain that takes no mail:\n`);
    for (const { s, m } of cannotReceive) {
      console.log(`      ${s.name} — ${s.company}`);
      console.log(`         ${s.to_email} — ${m.reason}`);
      console.log(`         Almost certainly a transcription error. Re-read the card.`);
      console.log();
    }
  }

  console.log(`   NO FAILURE REPORTED — ${noFailure.length} message(s).`);
  console.log('      Sent, nothing came back. This is the strongest claim email supports:');
  console.log('      there is no delivery receipt in SMTP, so "delivered" is not knowable.\n');

  console.log(`   ↩ REPLIED — ${replied.length} thread(s). The only POSITIVE proof of delivery.`);
  if (replied.length) {
    const who = confirmed.filter((s) => replied.includes(s.gmail_thread_id));
    for (const s of who) console.log(`      ${s.name} — ${s.company} (${s.campaign})`);
  }
  console.log();

  if (unconfirmed.length) {
    console.log(`   ⚠ ${unconfirmed.length} claimed with no Gmail id — may or may not have gone:`);
    for (const s of unconfirmed) {
      console.log(`      ${s.name} — ${s.company}${s.error ? ` · ${s.error}` : ''}`);
    }
    console.log();
  }

  // Bounces naming an address that is not ours at all: worth seeing, because it usually means a
  // forwarding address or a distribution list that rewrote the recipient.
  const ours = new Set(confirmed.map((s) => String(s.to_email).toLowerCase()));
  const strays = [...bounceFor.keys()].filter((k) => !ours.has(k));
  if (strays.length) {
    console.log(`   ⟡ ${strays.length} bounce(s) name an address not in this campaign:`);
    for (const k of strays.slice(0, 10)) console.log(`      ${k}`);
    console.log('      Usually a forwarding address or a list that rewrote the recipient —');
    console.log('      the person may still not have received it. Worth a look.\n');
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('audit-cphi-delivery failed:', e && e.message ? e.message : e);
  process.exit(1);
});
