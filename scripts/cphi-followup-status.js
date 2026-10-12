#!/usr/bin/env node
// ── WHERE THE CPHI CAMPAIGN ACTUALLY IS ───────────────────────────────────────
//
//   railway ssh 'node scripts/cphi-followup-status.js'
//
// Read-only. Writes nothing, sends nothing.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// On 12 Oct the release was running through `railway ssh` when the connection dropped:
//
//     Connection to ssh.railway.com closed by remote host.
//     client_loop: send disconnect: Broken pipe
//
// The runner died mid-list. Nothing is corrupted — the UNIQUE claim on
// (event, contact, campaign, step) means a re-run cannot double-send — but the terminal scrollback
// is now the only record of who got one, and it ends in the middle. A campaign whose state can
// only be read from a dead terminal is not a campaign you can resume with confidence.
//
// The row that matters most is a CLAIM WITH NO GMAIL MESSAGE ID. The runner claims the slot before
// it calls Gmail, so that row means the message may or may not have been accepted — and it blocks
// the retry, by design, because under-sending is recoverable by a person and double-sending to
// somebody who shook your hand is not. Those are listed first and loudest.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { isEvent } = require('../src/lib/events/registry');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EVENT = arg('event', 'cphi-milan-2026');

async function main() {
  await initDB();
  if (!isEvent(EVENT)) { console.log(`✗ "${EVENT}" is not an event.`); process.exit(1); }

  console.log(`── ${EVENT} · campaign status  (read-only)\n`);

  // ── THE ONE STATE THAT NEEDS A HUMAN ────
  const unconfirmed = (await query(
    `SELECT s.id, s.campaign, s.step, s.to_email, s.claimed_at, s.error, c.name, c.company
       FROM cphi_followup_sends s
       JOIN cphi_exhibitor_contacts c ON c.id = s.contact_id
      WHERE s.event_slug = $1 AND s.sent_at IS NULL
      ORDER BY s.claimed_at`, [EVENT])).rows;

  if (unconfirmed.length) {
    console.log(`   ⚠ ${unconfirmed.length} CLAIMED SEND(S) WITH NO GMAIL ID — may or may not have gone:\n`);
    for (const r of unconfirmed) {
      console.log(`      ${r.name} — ${r.company}`);
      console.log(`         ${r.campaign}/${r.step} to ${r.to_email}, claimed ${new Date(r.claimed_at).toISOString()}`);
      console.log(`         ${r.error ? `error: ${r.error}` : 'no error recorded — the process died before Gmail answered'}`);
      console.log(`         Check the Sent folder for ${r.to_email}. If it IS there, nothing to do.`);
      console.log(`         If it is NOT, free the slot:  DELETE FROM cphi_followup_sends WHERE id = ${r.id};\n`);
    }
  } else {
    console.log('   ✅ no half-finished sends — every claim has a Gmail message id.\n');
  }

  // ── WHAT HAS GONE, BY CAMPAIGN ────
  const sent = (await query(
    `SELECT campaign, step, COUNT(*)::int n, MIN(sent_at) first_at, MAX(sent_at) last_at
       FROM cphi_followup_sends
      WHERE event_slug = $1 AND sent_at IS NOT NULL
      GROUP BY campaign, step ORDER BY campaign, step`, [EVENT])).rows;

  console.log('   SENT');
  if (!sent.length) console.log('      nothing yet.');
  for (const r of sent) {
    console.log(`      ${r.campaign.padEnd(9)} step ${r.step}  ${String(r.n).padStart(3)} message(s)`
      + `   ${new Date(r.first_at).toISOString().slice(11, 16)}–${new Date(r.last_at).toISOString().slice(11, 16)} UTC`);
  }

  // ── SEQUENCE STATE ────
  const states = (await query(
    `SELECT campaign, status, COUNT(*)::int n FROM cphi_followup_state
      WHERE event_slug = $1 GROUP BY campaign, status ORDER BY campaign, status`, [EVENT])).rows;
  console.log('\n   SEQUENCES');
  if (!states.length) console.log('      none started.');
  for (const r of states) console.log(`      ${r.campaign.padEnd(9)} ${r.status.padEnd(10)} ${String(r.n).padStart(3)}`);

  const replied = (await query(
    `SELECT c.name, c.company, s.campaign, s.replied_at FROM cphi_followup_state s
       JOIN cphi_exhibitor_contacts c ON c.id = s.contact_id
      WHERE s.event_slug = $1 AND s.status = 'replied' ORDER BY s.replied_at DESC`, [EVENT])).rows;
  if (replied.length) {
    console.log(`\n   ↩ ${replied.length} REPLIED — sequence stopped, these are yours to answer:`);
    for (const r of replied) {
      console.log(`      ${r.name} — ${r.company} (${r.campaign})`
        + `${r.replied_at ? ` · ${new Date(r.replied_at).toISOString().slice(0, 16).replace('T', ' ')}` : ''}`);
    }
  }

  // ── WHO HAS STILL HAD NOTHING ────
  // The join mirrors the runner's own due-query: a role, an email, and no step-1 send.
  const never = (await query(
    `SELECT c.name, c.company, x.role
       FROM cphi_exhibitor_contacts c
       JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
      WHERE c.event_slug = $1 AND c.email IS NOT NULL AND c.email <> '' AND x.role IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM cphi_followup_sends s
                         WHERE s.contact_id = c.id AND s.event_slug = c.event_slug)
      ORDER BY x.role, c.company`, [EVENT])).rows;

  console.log(`\n   NOT YET CONTACTED — ${never.length} contact(s) with a role and an email:`);
  for (const r of never) console.log(`      ${r.role.padEnd(17)} ${r.name} — ${r.company}`);

  // Contacts the campaign can never reach, so the number above is not mistaken for the whole list.
  const unreachable = (await query(
    `SELECT c.name, c.company, c.email, c.greeting_name, x.role
       FROM cphi_exhibitor_contacts c
       LEFT JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
      WHERE c.event_slug = $1
        AND (c.email IS NULL OR c.email = '' OR x.role IS NULL)
      ORDER BY c.company`, [EVENT])).rows;
  if (unreachable.length) {
    console.log(`\n   ⟡ ${unreachable.length} contact(s) the campaign CANNOT reach:`);
    for (const r of unreachable) {
      const why = !r.email ? 'no email' : !r.role ? 'no role, so no campaign' : '?';
      console.log(`      ${r.name} — ${r.company}  (${why})`);
    }
  }

  console.log(`\n   To continue the release:`);
  console.log(`      node scripts/run-cphi-followup.js --max=80 --ignore-window --execute`);
  console.log(`   Safe to re-run: the UNIQUE claim per (contact, campaign, step) refuses a second send.\n`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('cphi-followup-status failed:', e && e.message ? e.message : e);
  process.exit(1);
});
