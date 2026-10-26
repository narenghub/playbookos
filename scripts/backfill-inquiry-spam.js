#!/usr/bin/env node
// ── RUN THE SPAM GATE OVER THE ROWS THAT PREDATE IT ──────────────────────────
//
//   railway ssh 'node scripts/backfill-inquiry-spam.js'              # DRY RUN — changes nothing
//   railway ssh 'node scripts/backfill-inquiry-spam.js --execute'
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// The gate was written in September 2026 after nine of eleven open inquiries turned out to be
// reply-bait. It works: given the ten external rows in the table on 2026-10-26 it marks seven as
// spam and lets the three real buyers through, with no overlap. But it only ever ran on mail
// arriving AFTER it shipped, so the rows from July, August and early September were never judged
// by it and still sit in the table as ordinary inquiries.
//
// That is not cosmetic. Those seven are counted as external demand, which is how "real buyers"
// reads as eleven when it is four — and the whole reason this month's reporting was wrong in the
// flattering direction. Each of them also received four automated emails and three follow-ups
// before anyone noticed, which is the behaviour the gate exists to prevent.
//
// ── WHAT IT WILL AND WILL NOT TOUCH ──────────────────────────────────────────
//
// Two conditions, both required, and deliberately narrower than the live gate:
//
//   1. NO SUBSTANCE. No molecule, no quantity, no company. The live gate's safety property is that
//      a buyer who says what they want is never spam whatever else the message looks like, and
//      that property is worth more here than in the live path: this is a bulk UPDATE over
//      historical rows, run once, by someone who will not re-read every line.
//   2. THE GATE FIRES on the stored name and address.
//
// Historical rows do not keep the original subject or body, so only the display-name signal can be
// evaluated. That makes this strictly WEAKER than the live gate — it can miss spam, which is the
// safe direction. It cannot invent a verdict the live gate would not also reach.
//
// Rows already marked spam are skipped. Rows with a quote, an order or any substance are never
// considered. Every id it changes is printed, and the dry run prints exactly the same list, so the
// decision to execute is made against the real list rather than a count.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { classifyInquirySpam } = require('../src/lib/agents/inquiry-spam');

const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');

const say = (s = '') => console.log(s);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

async function main() {
  await initDB();

  // Only rows with no commercial substance are even candidates. Expressed in SQL rather than in JS
  // so a row with a molecule can never reach the classifier by accident.
  const rows = (await query(`
    SELECT i.id, i.buyer_name, i.buyer_email, i.buyer_company, i.molecule_name,
           i.quantity_requested, i.status, i.created_at, i.total_emails_sent, i.followups_sent,
           (SELECT COUNT(*)::int FROM inquiry_quotes q WHERE q.inquiry_id = i.id) quotes
      FROM inquiries i
     WHERE COALESCE(i.status, '') <> 'spam'
       AND COALESCE(NULLIF(TRIM(i.molecule_name), ''), NULL) IS NULL
       AND COALESCE(i.quantity_requested, 0) = 0
       AND COALESCE(NULLIF(TRIM(i.buyer_company), ''), NULL) IS NULL
     ORDER BY i.created_at`)).rows;

  say(`\n── spam backfill${EXECUTE ? '' : '  ·  DRY RUN'}\n`);
  say(`   ${rows.length} row(s) with no molecule, no quantity and no company — the only candidates.\n`);

  const employees = ['Naresh Boda', 'Palash Das', 'Manohar Inakollu', 'Navya Reddy'];
  const hits = [];
  const spared = [];

  for (const r of rows) {
    // A row that was quoted is somebody we did business with, whatever it looks like now.
    if (r.quotes > 0) { spared.push([r, 'has a quote']); continue; }
    const v = classifyInquirySpam({
      fromName: r.buyer_name,
      fromEmail: r.buyer_email,
      weEverEmailed: false,
      employeeNames: employees,
    });
    if (v.spam) hits.push([r, v]); else spared.push([r, 'gate did not fire']);
  }

  say('   ══ WOULD BE MARKED SPAM ════════════════════════════════════════════');
  if (!hits.length) say('      (none)');
  for (const [r, v] of hits) {
    const age = Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000);
    say(`      ${pad(`${age}d`, 6)}${pad(r.buyer_name || '(no name)', 20)}${pad(r.buyer_email, 38)}`
      + `${pad(r.status || '', 17)}${r.total_emails_sent || 0} email(s) sent`);
    say(`             ↳ ${v.reasons.join(' · ')}`);
  }

  say('\n   ══ LEFT ALONE ══════════════════════════════════════════════════════');
  if (!spared.length) say('      (none)');
  for (const [r, why] of spared) {
    say(`      ${pad(r.buyer_name || '(no name)', 20)}${pad(r.buyer_email, 38)}${why}`);
  }

  const sent = hits.reduce((a, [r]) => a + (Number(r.total_emails_sent) || 0), 0);
  say(`\n   ${hits.length} row(s) to reclassify · ${sent} automated email(s) already went to them`);

  if (!EXECUTE) {
    say('\n   DRY RUN — nothing changed. Re-run with --execute to apply.\n');
    return;
  }
  if (!hits.length) { say('\n   Nothing to do.\n'); return; }

  // By explicit id, one at a time, counting what actually changed rather than trusting the plan.
  let changed = 0;
  for (const [r] of hits) {
    const res = await query(
      `UPDATE inquiries SET status = 'spam', updated_at = NOW()
        WHERE id = $1 AND COALESCE(status,'') <> 'spam'`, [r.id]);
    changed += res.rowCount || 0;
  }
  say(`\n   ✅ ${changed} row(s) reclassified as spam.`);
  if (changed !== hits.length) {
    say(`   ⚠ expected ${hits.length}. A row changed underneath this run — re-run the dry run.`);
  }
  say('   Re-run scripts/revenue-pipeline.js: the external count should drop by exactly this many.\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('backfill-inquiry-spam failed:', e && e.message ? e.message : e);
  process.exit(1);
});
