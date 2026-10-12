#!/usr/bin/env node
// ── STATE FOR THE POST-CPHI FOLLOW-UP SEQUENCES ───────────────────────────────
//
//   railway ssh 'node scripts/migrate-cphi-followup.js'
//
// Re-runnable: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout.
//
// ── TWO TABLES, AND THE SECOND ONE IS THE SAFETY ─────────────────────────────
//
// `cphi_followup_state` is where each contact is in their sequence. `cphi_followup_sends` is one
// row per message, with
//
//     UNIQUE (event_slug, contact_id, campaign, step)
//
// which is the guard that makes a double-send impossible rather than unlikely. The runner CLAIMS
// the row before it calls Gmail and fills in the message ids afterwards, so:
//
//   · a crash between the claim and the send leaves a claimed row with no message id. That blocks
//     a re-send, and the runner reports it as needing a human. UNDER-sending is recoverable by a
//     person; double-sending to somebody who shook your hand is not.
//   · two runners racing cannot both claim the same step, because the database refuses the second.
//   · a failed send records the error on the claim instead of vanishing, so the next run does not
//     silently try again forever.
//
// Everything else in this system fails closed by convention. This one fails closed by constraint,
// which is the only kind that holds when somebody is tired and re-runs a command.
'use strict';

const { initDB, query } = require('../src/lib/db');

async function main() {
  await initDB();

  await query(`
    CREATE TABLE IF NOT EXISTS cphi_followup_state (
      id              BIGSERIAL PRIMARY KEY,
      event_slug      TEXT NOT NULL,
      contact_id      BIGINT NOT NULL REFERENCES cphi_exhibitor_contacts(id) ON DELETE CASCADE,
      campaign        TEXT NOT NULL,          -- supplier | buyer | partner
      step_sent       INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'active',  -- active|replied|completed|halted
      halted_reason   TEXT,
      next_due_at     TIMESTAMPTZ,
      -- Gmail's own grouping, and the RFC822 chain every OTHER client threads by. Both are needed:
      -- threadId alone threads correctly in Naren's mailbox and incorrectly in the recipient's.
      thread_id       TEXT,
      last_rfc822_id  TEXT,
      refs_chain      TEXT,                   -- space-joined Message-IDs, oldest first
      replied_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- One sequence per contact per campaign. A contact legitimately appears in only one campaign,
    -- but the key carries the campaign so that a reassignment creates a NEW sequence rather than
    -- silently continuing the old one at whatever step it had reached.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cfs_unique
      ON cphi_followup_state (event_slug, contact_id, campaign);
    CREATE INDEX IF NOT EXISTS idx_cfs_due
      ON cphi_followup_state (status, next_due_at);
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS cphi_followup_sends (
      id                BIGSERIAL PRIMARY KEY,
      event_slug        TEXT NOT NULL,
      contact_id        BIGINT NOT NULL REFERENCES cphi_exhibitor_contacts(id) ON DELETE CASCADE,
      campaign          TEXT NOT NULL,
      step              INTEGER NOT NULL,
      to_email          TEXT NOT NULL,
      subject           TEXT,
      -- NULL until Gmail confirms. A claimed row with no gmail_message_id is a send that may or
      -- may not have happened, which is exactly the state a human should look at.
      gmail_message_id  TEXT,
      gmail_thread_id   TEXT,
      rfc822_message_id TEXT,
      claimed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at           TIMESTAMPTZ,
      error             TEXT,
      -- THE DOUBLE-SEND GUARD. Not a convention, a constraint.
      CONSTRAINT uq_cphi_followup_send UNIQUE (event_slug, contact_id, campaign, step)
    );
    CREATE INDEX IF NOT EXISTS idx_cfsend_contact ON cphi_followup_sends (contact_id);
    CREATE INDEX IF NOT EXISTS idx_cfsend_unconfirmed
      ON cphi_followup_sends (sent_at) WHERE sent_at IS NULL;
  `);

  await query(`
    COMMENT ON TABLE cphi_followup_sends IS
      $c$One row per message in the post-CPHI follow-up. The row is CLAIMED before Gmail is called
and completed afterwards, so a crash in between leaves a claim with no gmail_message_id — which
blocks a re-send and is reported for a human. Under-sending is recoverable; sending twice to
somebody you met in person is not. The UNIQUE on (event, contact, campaign, step) is what makes
that a guarantee rather than an intention.$c$;
  `);

  // A greeting the splitter could not derive. Six names on the CPHI list cannot be split safely —
  // "Zhu Yijun", "Lina", "B. Shalini Reddy", "Udaya Sagar G.", "Vinod J", "Zhu Jiang" — and
  // rendering refuses rather than greeting somebody wrongly. This is where the human answer lives.
  await query(`
    ALTER TABLE cphi_exhibitor_contacts
      ADD COLUMN IF NOT EXISTS greeting_name TEXT;
  `);

  const counts = (await query(`
    SELECT (SELECT COUNT(*)::int FROM cphi_followup_state) state,
           (SELECT COUNT(*)::int FROM cphi_followup_sends) sends,
           (SELECT COUNT(*)::int FROM cphi_exhibitor_contacts WHERE greeting_name IS NOT NULL) greets
  `)).rows[0];
  console.log('✅ follow-up schema applied.');
  console.log(`   cphi_followup_state  ${counts.state} row(s)`);
  console.log(`   cphi_followup_sends  ${counts.sends} row(s)`);
  console.log(`   greeting overrides   ${counts.greets}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('migrate-cphi-followup failed:', e && e.message ? e.message : e);
  process.exit(1);
});
