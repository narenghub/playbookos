#!/usr/bin/env node
// ── FILE EVERY CPHI THREAD ALREADY SENT INTO ITS FOLDER ───────────────────────
//
//   railway ssh 'node scripts/label-cphi-threads.js'            → what would be filed, nothing done
//   railway ssh 'node scripts/label-cphi-threads.js --execute'  → applies the labels
//
// The runner now labels each thread as it sends. This is for the ones that went out before it did,
// and as the repair for any thread that sent successfully while labelling was refused — the runner
// prints "⚠ UNFILED" in that case and keeps going, which is correct, and this is how that gets
// cleaned up afterwards.
//
// ── WHY THIS IS SAFE TO RE-RUN ───────────────────────────────────────────────
//
// `addLabelIds` is a set operation. Applying a label a thread already carries changes nothing, so
// there is no state to track, nothing to deduplicate, and no row to write. Run it as often as you
// like. That is also why nothing here records what it did: the answer to "is it filed?" lives in
// Gmail, and a column saying so would be a second copy of the truth that can disagree with it.
//
// It labels the whole THREAD, not the message we sent, so a reply that has already arrived is filed
// with it. Labels are only ADDED — nothing is removed, nothing is archived, nothing is moved out of
// the inbox. Filing in Gmail is additive, and a script that quietly archived his CPHI mail would be
// a very unpleasant surprise in an airport.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { isEvent, EVENTS } = require('../src/lib/events/registry');
const { gmailClientFor } = require('../src/lib/gmail/client');
const { ensureCampaignLabels, labelThread, labelForCampaign } = require('../src/lib/gmail/labels');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EVENT = arg('event', 'cphi-milan-2026');
const FROM_MAILBOX = arg('from', 'naren@abiozen.com');
const EXECUTE = process.argv.includes('--execute');

async function main() {
  await initDB();
  if (!isEvent(EVENT)) {
    console.log(`✗ "${EVENT}" is not an event. Known: ${EVENTS.map((e) => e.slug).join(', ')}`);
    process.exit(1);
  }

  console.log(`── ${EVENT} · filing sent threads · ${EXECUTE ? 'APPLYING' : 'dry run'}\n`);

  // One row per thread. A three-step sequence shares one thread, so DISTINCT keeps this from
  // calling threads.modify three times for the same conversation.
  const rows = (await query(
    `SELECT DISTINCT s.gmail_thread_id, s.campaign, c.name, c.company, c.email
       FROM cphi_followup_sends s
       JOIN cphi_exhibitor_contacts c ON c.id = s.contact_id
      WHERE s.event_slug = $1
        AND s.gmail_thread_id IS NOT NULL
        AND s.sent_at IS NOT NULL
      ORDER BY s.campaign, c.company`, [EVENT])).rows;

  if (!rows.length) {
    console.log('   no confirmed sends with a thread id yet — nothing to file.');
    console.log('   The runner labels each thread as it sends, so this stays empty unless a send');
    console.log('   succeeded while labelling was refused.\n');
    return;
  }

  const byCampaign = {};
  const noFolder = [];
  for (const r of rows) {
    const folder = labelForCampaign(r.campaign);
    if (!folder) { noFolder.push(r); continue; }
    (byCampaign[folder] = byCampaign[folder] || []).push(r);
  }

  for (const [folder, list] of Object.entries(byCampaign)) {
    console.log(`   ${folder}  —  ${list.length} thread(s)`);
    for (const r of list) console.log(`      ${r.name} — ${r.company}  ·  thread ${r.gmail_thread_id}`);
    console.log();
  }
  if (noFolder.length) {
    console.log(`   ⚠ ${noFolder.length} thread(s) are in a campaign with no folder — left alone:`);
    for (const r of noFolder) console.log(`      ${r.name} — ${r.company} [campaign ${r.campaign}]`);
    console.log();
  }

  if (!EXECUTE) {
    console.log('   DRY RUN — nothing filed. Re-run with --execute.\n');
    return;
  }

  const g = await gmailClientFor(FROM_MAILBOX);
  if (g.error) {
    console.log(`   ✗ cannot act as ${FROM_MAILBOX}: ${g.error}`);
    process.exit(1);
  }
  console.log(`   authorised as ${g.profile.emailAddress} via ${g.via} (${g.scopeSet})\n`);

  const folders = await ensureCampaignLabels(g.gmail, FROM_MAILBOX);
  if (!folders.ok) {
    // Here, unlike in the runner, this IS the whole job. Nothing has been sent and nothing is
    // waiting on it, so there is no reason to carry on and report success over a refusal.
    console.log('   ✗ the folders could not be created:');
    for (const e of folders.errors) console.log(`     ${e}`);
    console.log(`     Labels need gmail.modify; this token resolved to ${g.scopeSet}.\n`);
    process.exit(1);
  }

  let filed = 0;
  const failures = [];
  for (const [folder, list] of Object.entries(byCampaign)) {
    for (const r of list) {
      const res = await labelThread(g.gmail, FROM_MAILBOX, r.gmail_thread_id, folder);
      if (res.ok) { filed += 1; console.log(`   ✅ ${r.name} — ${r.company}  →  ${folder}`); }
      else { failures.push({ r, folder, why: res.error }); console.log(`   ✗ ${r.name}: ${res.error}`); }
    }
  }

  console.log(`\n   ${filed} thread(s) filed, ${failures.length} failed.`);
  console.log('   Labels were added only. Nothing was removed, archived, or moved out of the inbox.\n');
  if (failures.length) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('label-cphi-threads failed:', e && e.message ? e.message : e);
  process.exit(1);
});
