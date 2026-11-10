#!/usr/bin/env node
// ── DID THE TWO GMAIL SENDERS TRANSMIT WHILE EMAIL WAS SUPPOSED TO BE HELD? ──
//
//   railway ssh --service playbookos 'node /app/scripts/audit-gmail-during-containment.js'
//
// READ-ONLY. No INSERT, no UPDATE, no DELETE, no provider call. Exit 0 = nothing transmitted
// during the window. Exit 1 = something did, and this prints exactly what.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// Three STOPs were set on 3 November and the containment was believed total. It was not. Until
// the S1 deploy on 10 November, src/lib/campaigns/cphi-runner.js and src/lib/agents/outreach-agent.js
// sent through Gmail with NO kill-switch check at all — gated only by an environment variable.
//
// Section 7b of confirm-legacy-email-state.js then reported both variables as TRUE in production.
// So for roughly seven days, two senders were enabled, running on crons, and outside the stop that
// everything else obeyed. Whether they actually transmitted depends on whether their queues had
// due work — and that is a question about data, not about code.
//
// Section 9 of the containment report cannot answer it: it reads email_log, which only the Resend
// path writes. The answer lives in the DOMAIN CLAIM TABLES, which those senders do write, and
// which record a Gmail message id once the provider confirms.
//
// A claimed row with NO message id is its own answer and is reported separately: it means a send
// was attempted and nobody knows whether it left.

'use strict';

// The moment the first containment stop was recorded. Anything confirmed after this was sent while
// the platform was believed to be held.
const CONTAINMENT_FROM = '2026-11-03T13:42:33Z';

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };
const field = (k, v) => console.log(`    ${String(k).padEnd(34)} ${v}`);
const note = (m) => console.log(`  --    ${m}`);

(async () => {
  const { query } = require('../src/lib/db');

  console.log('\n══ GMAIL TRANSMISSION DURING THE CONTAINMENT WINDOW (READ-ONLY) ══\n');
  field('window opens', CONTAINMENT_FROM);
  field('now', new Date().toISOString());

  const exists = async (t) => (await query(
    `SELECT to_regclass($1) IS NOT NULL AS yes`, [t])).rows[0].yes;

  // ── CPHI ────────────────────────────────────────────────────────────────
  console.log('\n  ── cphi-runner (gmail) ──\n');
  if (!await exists('cphi_followup_sends')) {
    note('cphi_followup_sends does not exist — this sender has never run here. UNKNOWN, not zero.');
  } else {
    const r = await query(
      `SELECT
         COUNT(*) FILTER (WHERE sent_at >= $1 AND gmail_message_id IS NOT NULL)::int AS confirmed,
         COUNT(*) FILTER (WHERE claimed_at >= $1 AND gmail_message_id IS NULL AND error IS NULL)::int AS unconfirmed,
         COUNT(*) FILTER (WHERE claimed_at >= $1 AND error IS NOT NULL)::int AS errored,
         COUNT(*)::int AS all_time
       FROM cphi_followup_sends`, [CONTAINMENT_FROM]);
    const c = r.rows[0];
    field('rows all time', c.all_time);
    field('CONFIRMED sent in window', c.confirmed);
    field('claimed, never confirmed', c.unconfirmed);
    field('claimed, errored', c.errored);
    if (c.confirmed > 0) {
      bad(`${c.confirmed} CPHI message(s) were confirmed sent by Gmail during the containment window`);
      const who = await query(
        `SELECT to_email, campaign, step, sent_at FROM cphi_followup_sends
          WHERE sent_at >= $1 AND gmail_message_id IS NOT NULL
          ORDER BY sent_at LIMIT 25`, [CONTAINMENT_FROM]);
      for (const x of who.rows) {
        console.log(`          ${x.sent_at.toISOString()}  ${x.to_email}  ${x.campaign} step ${x.step}`);
      }
      if (c.confirmed > 25) console.log(`          … and ${c.confirmed - 25} more`);
    } else ok('no CPHI message was confirmed sent during the window');
    if (c.unconfirmed > 0) {
      note(`${c.unconfirmed} claimed row(s) carry no message id: a send was attempted and whether it`);
      note('left is UNKNOWN. Those are the rows a human should look at.');
    }
  }

  // ── OUTREACH ────────────────────────────────────────────────────────────
  console.log('\n  ── outreach-agent (gmail) ──\n');
  if (!await exists('outreach_sends')) {
    note('outreach_sends does not exist — this sender has never run here. UNKNOWN, not zero.');
  } else {
    // sent_at DEFAULTS to NOW() on the CLAIM, so it alone is not evidence of transmission.
    // `confirmed` and rfc822_id are. The distinction is the whole point of this audit.
    const r = await query(
      `SELECT
         COUNT(*) FILTER (WHERE sent_at >= $1 AND (confirmed OR rfc822_id IS NOT NULL))::int AS confirmed,
         COUNT(*) FILTER (WHERE sent_at >= $1 AND NOT confirmed AND rfc822_id IS NULL)::int AS unconfirmed,
         COUNT(*) FILTER (WHERE sent_at >= $1 AND channel = 'verify')::int AS probes,
         COUNT(*)::int AS all_time
       FROM outreach_sends`, [CONTAINMENT_FROM]);
    const c = r.rows[0];
    field('rows all time', c.all_time);
    field('CONFIRMED sent in window', c.confirmed);
    field('claimed, never confirmed', c.unconfirmed);
    field('of which verification probes', c.probes);
    if (c.confirmed > 0) {
      bad(`${c.confirmed} outreach message(s) were confirmed sent during the containment window`);
      const who = await query(
        `SELECT to_email, need, step, channel, sent_at FROM outreach_sends
          WHERE sent_at >= $1 AND (confirmed OR rfc822_id IS NOT NULL)
          ORDER BY sent_at LIMIT 25`, [CONTAINMENT_FROM]);
      for (const x of who.rows) {
        console.log(`          ${x.sent_at.toISOString()}  ${x.to_email}  ${x.channel}/${x.need} step ${x.step}`);
      }
      if (c.confirmed > 25) console.log(`          … and ${c.confirmed - 25} more`);
    } else ok('no outreach message was confirmed sent during the window');
    if (c.unconfirmed > 0) {
      note(`${c.unconfirmed} claimed row(s) are unconfirmed — attempted, outcome unknown.`);
    }
  }

  console.log('\n  ── what this does and does not establish ──\n');
  note('ESTABLISHES: whether the two ungoverned Gmail senders confirmed any transmission while');
  note('the platform was believed held. It reads the tables those senders actually write.');
  note('DOES NOT establish inbox delivery, and does not cover a send that failed before its claim');
  note('row was written — though the claim is written FIRST precisely so that window is tiny.');

  console.log(fail
    ? `\nFAIL  ${fail} finding(s): email left the building during the containment window.\n`
    : '\nPASS  no confirmed Gmail transmission during the containment window.\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('audit failed:', e && e.message); process.exit(1); });
