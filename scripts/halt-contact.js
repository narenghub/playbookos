#!/usr/bin/env node
// ── TAKE ONE PERSON OUT OF AN AUTOMATED SEQUENCE ─────────────────────────────
//
//   railway ssh 'node scripts/halt-contact.js --event=scope-europe-2026 --email=paul@muralhealth.com'
//   railway ssh 'node scripts/halt-contact.js --event=... --email=... --reason="replying by hand" --execute'
//   railway ssh 'node scripts/halt-contact.js --event=... --email=... --resume --execute'
//
// Dry run unless --execute. Sends nothing, ever.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// Paul Diercksen of Mural Health wrote to Naren directly two days after SCOPE, asking about the
// trial feed. He got a personal reply. He was also still sitting in the campaign as "not yet
// contacted", so the Monday run would have opened with "Following up from SCOPE — the trial feed
// I showed you" on top of a live conversation he had started himself.
//
// There is no error in that. Every component behaves correctly: he has a role, a campaign, an
// address and no state row. The system cannot know a human already answered him outside it, and
// the cost of that gap falls entirely on the warmest lead in the list.
//
// So a human needs a way to say "I have this one" that the automation respects. A halted row does
// that: the runner checks status === 'halted' and skips, and because the row is keyed per
// (event, contact, campaign) it survives re-runs and re-seeds.
//
// Use it the moment a real conversation starts. Reply-sync catches people who answer a campaign
// email; it cannot catch someone who writes to you out of the blue, which is exactly the person
// you least want to send a template to.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { campaignFor } = require('../src/lib/campaigns/cphi-followup');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};

const EVENT = arg('event', '');
const EMAIL = String(arg('email', '')).trim().toLowerCase();
const REASON = arg('reason', 'handled personally — live conversation outside the campaign');
const RESUME = has('resume');
const EXECUTE = has('execute');

const say = (s = '') => console.log(s);

async function main() {
  if (!EVENT || !EMAIL) {
    console.error('need --event=<slug> and --email=<address>');
    process.exit(1);
  }
  await initDB();

  const c = (await query(
    `SELECT id, name, company, email, role FROM cphi_exhibitor_contacts
      WHERE event_slug = $1 AND lower(email) = $2`, [EVENT, EMAIL])).rows[0];

  if (!c) {
    console.error(`no contact with email ${EMAIL} at event ${EVENT}`);
    process.exit(1);
  }

  const campaign = campaignFor(EVENT, c.role);
  if (!campaign) {
    say(`\n   ${c.name} (${c.company}) has role "${c.role}", which has no campaign at ${EVENT}.`);
    say('   They receive nothing already — no halt needed.\n');
    process.exit(0);
  }

  const st = (await query(
    `SELECT status, step_sent, halted_reason FROM cphi_followup_state
      WHERE event_slug = $1 AND contact_id = $2 AND campaign = $3`, [EVENT, c.id, campaign])).rows[0];

  say(`\n── ${RESUME ? 'resume' : 'halt'}  ${EVENT}${EXECUTE ? '' : '   ** DRY RUN **'}\n`);
  say(`   ${c.name} — ${c.company}`);
  say(`   ${c.email}  ·  role ${c.role}  ·  campaign ${campaign}`);
  say(`   current: ${st ? `${st.status}, ${st.step_sent} step(s) sent` : 'no sequence started'}`);
  if (st && st.halted_reason) say(`   reason:  ${st.halted_reason}`);

  if (!RESUME && st && st.status === 'replied') {
    say('\n   Already marked replied — the sequence has stopped on its own. Nothing to do.\n');
    process.exit(0);
  }

  if (!EXECUTE) {
    say(`\n   Would ${RESUME ? 'set this sequence back to active' : 'halt this sequence'}.`);
    say('   Re-run with --execute.\n');
    process.exit(0);
  }

  if (RESUME) {
    const r = await query(
      `UPDATE cphi_followup_state SET status = 'active', halted_reason = NULL, updated_at = NOW()
        WHERE event_slug = $1 AND contact_id = $2 AND campaign = $3 AND status = 'halted'
        RETURNING id`, [EVENT, c.id, campaign]);
    say(r.rows.length ? `\n   ✅ resumed — next run may contact them again.\n`
      : '\n   nothing to resume (not halted).\n');
    process.exit(0);
  }

  // step_sent stays at whatever it was: halting is not the same as un-sending, and a resumed
  // sequence must pick up where it stopped rather than start again from step 1.
  await query(`
    INSERT INTO cphi_followup_state (event_slug, contact_id, campaign, step_sent, status, halted_reason)
    VALUES ($1, $2, $3, 0, 'halted', $4)
    ON CONFLICT (event_slug, contact_id, campaign) DO UPDATE SET
      status = 'halted', halted_reason = EXCLUDED.halted_reason, updated_at = NOW()`,
  [EVENT, c.id, campaign, REASON]);

  say(`\n   ✅ halted — ${c.name} will receive nothing from this campaign.`);
  say(`      reason recorded: ${REASON}`);
  say('      Undo with --resume --execute.\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('halt-contact failed:', e && e.message ? e.message : e);
  process.exit(1);
});
