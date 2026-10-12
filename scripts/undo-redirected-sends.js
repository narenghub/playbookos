#!/usr/bin/env node
// ── UNDO A TEST SEND THAT RECORDED ITSELF AGAINST A REAL CONTACT ──────────────
//
//   railway ssh 'node scripts/undo-redirected-sends.js'            → dry run
//   railway ssh 'node scripts/undo-redirected-sends.js --execute'  → removes them
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// run-cphi-followup.js has a --to= flag that redirects every message to one address while
// rendering the real content for the real contact, so the first send can be checked in Naren's own
// inbox rather than in TAPI's. The first use of it worked — and then recorded the send against the
// REAL contact: a claim row at step 1 and a sequence state saying step 1 was sent.
//
// The consequence is the opposite of what a test should do. The UNIQUE claim blocks a re-send, so
// Luca Segàla was marked as followed up and would never actually have received anything. A test
// that silently removes somebody from the campaign is worse than no test.
//
// The runner no longer writes anything in redirect mode. This removes what the earlier run wrote.
//
// ── HOW A REDIRECTED SEND IS IDENTIFIED ──────────────────────────────────────
//
// `cphi_followup_sends.to_email` is the address the message actually went to. A row whose
// to_email differs from the contact's own email was redirected — there is no other way for those
// to disagree. That is a fact in the data rather than a guess, which is what makes this safe to
// automate.
//
// Rows are deleted BY ID, never by pattern or timestamp — CLAUDE.md, and the reason is that this
// runs against production and cleanup is the part nobody reads.
'use strict';

const { initDB, query } = require('../src/lib/db');

const EXECUTE = process.argv.includes('--execute');

async function main() {
  await initDB();
  console.log('── redirected sends recorded against real contacts\n');

  const rows = (await query(
    `SELECT s.id, s.event_slug, s.contact_id, s.campaign, s.step, s.to_email, s.sent_at,
            s.gmail_thread_id, c.name, c.email AS contact_email, c.company
       FROM cphi_followup_sends s
       JOIN cphi_exhibitor_contacts c ON c.id = s.contact_id
      WHERE lower(s.to_email) <> lower(c.email)
      ORDER BY s.id`)).rows;

  if (!rows.length) {
    console.log('   none — every recorded send went to the contact it is filed against.\n');
    return;
  }

  console.log(`   ${rows.length} send row(s) went somewhere other than the contact's own address:\n`);
  for (const r of rows) {
    console.log(`   ${r.name} — ${r.company}`);
    console.log(`      filed as ${r.campaign}/${r.step}, sent to ${r.to_email}`);
    console.log(`      their actual address is ${r.contact_email}`);
    console.log(`      thread ${r.gmail_thread_id || '(none)'} — the message in Naren's mailbox STAYS;`);
    console.log(`      only the record that blocks their real send is removed.`);
    console.log();
  }

  // The sequence state to reset: only for (contact, campaign) pairs whose ONLY recorded sends were
  // redirected. A contact with both a real send and a test one keeps their state — unwinding a
  // genuine send is not this script's business.
  const states = (await query(
    `SELECT st.id, st.contact_id, st.campaign, st.step_sent, c.name, c.company
       FROM cphi_followup_state st
       JOIN cphi_exhibitor_contacts c ON c.id = st.contact_id
      WHERE EXISTS (SELECT 1 FROM cphi_followup_sends s
                     JOIN cphi_exhibitor_contacts c2 ON c2.id = s.contact_id
                    WHERE s.contact_id = st.contact_id AND s.campaign = st.campaign
                      AND lower(s.to_email) <> lower(c2.email))
        AND NOT EXISTS (SELECT 1 FROM cphi_followup_sends s
                     JOIN cphi_exhibitor_contacts c2 ON c2.id = s.contact_id
                    WHERE s.contact_id = st.contact_id AND s.campaign = st.campaign
                      AND lower(s.to_email) = lower(c2.email))`)).rows;

  if (states.length) {
    console.log(`   ${states.length} sequence state(s) exist only because of a redirected send:\n`);
    for (const s of states) {
      console.log(`      ${s.name} — ${s.company}: ${s.campaign} at step ${s.step_sent} → removed, back to due`);
    }
    console.log();
  }

  if (!EXECUTE) {
    console.log('   DRY RUN — nothing written. Re-run with --execute.\n');
    return;
  }

  // By id. Recorded first, deleted exactly, checked after.
  const sendIds = rows.map((r) => r.id);
  const stateIds = states.map((s) => s.id);

  for (const id of stateIds) await query(`DELETE FROM cphi_followup_state WHERE id = $1`, [id]);
  for (const id of sendIds) await query(`DELETE FROM cphi_followup_sends WHERE id = $1`, [id]);

  // last_emailed_at was set by the redirected run too, and it is what the export uses to exclude
  // somebody from a list. Cleared only for the contacts whose state was removed entirely.
  let cleared = 0;
  for (const s of states) {
    const r = await query(
      `UPDATE cphi_exhibitor_contacts SET last_emailed_at = NULL, updated_at = NOW()
        WHERE id = $1 RETURNING id`, [s.contact_id]);
    cleared += r.rowCount;
  }

  const stillThere = (await query(
    `SELECT COUNT(*)::int n FROM cphi_followup_sends WHERE id = ANY($1)`, [sendIds])).rows[0].n;
  const statesLeft = stateIds.length
    ? (await query(`SELECT COUNT(*)::int n FROM cphi_followup_state WHERE id = ANY($1)`, [stateIds])).rows[0].n
    : 0;

  console.log(`   ✅ ${sendIds.length} send row(s) removed, ${stateIds.length} state row(s) removed,`);
  console.log(`      ${cleared} last_emailed_at cleared.`);
  if (stillThere || statesLeft) {
    console.log(`   ✗ ${stillThere} send(s) and ${statesLeft} state(s) are still present.`);
    process.exit(1);
  }
  console.log(`\n   Those contacts are due again. The test messages in Naren's own mailbox are`);
  console.log(`   untouched — they are his to read or delete.\n`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('undo-redirected-sends failed:', e && e.message ? e.message : e);
  process.exit(1);
});
