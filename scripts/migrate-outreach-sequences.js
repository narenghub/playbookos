#!/usr/bin/env node
// ── STATE FOR NEED-BASED OUTREACH ────────────────────────────────────────────
//
//   railway ssh 'node scripts/migrate-outreach-sequences.js'
//
// Safe to re-run. Creates nothing that exists; writes no data.
//
// ── WHY NOT REUSE THE CPHI TABLES ────────────────────────────────────────────
//
// cphi_followup_state is keyed on cphi_exhibitor_contacts.id — people met at a specific show.
// These contacts come from research_labs and inquiries, and more sources will follow. A foreign
// key to a table that does not hold them would mean either widening that table with rows that are
// not exhibitors, or a nullable key that stops enforcing anything.
//
// So the subject is (channel, ref): 'research_lab' + a lab id, 'inquiry' + an inquiry id. The
// channel says which table the ref means, the same shape lead_deliveries already uses.
//
// ── THE UNIQUE CONSTRAINT IS THE WHOLE SAFETY PROPERTY ───────────────────────
//
// A double-send to a professor is not a cosmetic failure; it is the thing that makes a cold email
// look automated and gets the domain reported. The runner claims its slot by INSERTing into
// outreach_sends BEFORE it calls Gmail, so two runs racing cannot both send step 1: the second
// insert is refused by the constraint and that run declines to send.
//
// That ordering matters. Sending first and recording after means a crash between the two leaves a
// message delivered and unrecorded, and the next run sends it again.
'use strict';

const { initDB, query } = require('../src/lib/db');

const NEEDS = ['discovery', 'clinical_api', 'custom_synthesis', 'catalogue_api', 'reference_standard'];
const STATUSES = ['active', 'replied', 'done', 'halted', 'bounced'];

async function main() {
  await initDB();

  await query(`
    -- ── WHERE EACH CONTACT IS IN THEIR SEQUENCE ────
    CREATE TABLE IF NOT EXISTS outreach_state (
      id             BIGSERIAL PRIMARY KEY,
      channel        TEXT NOT NULL,          -- research_lab | inquiry
      ref            TEXT NOT NULL,          -- the id within that channel
      email          TEXT NOT NULL,
      need           TEXT NOT NULL CHECK (need IN (${NEEDS.map((n) => `'${n}'`).join(',')})),

      step_sent      INTEGER NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN (${STATUSES.map((s) => `'${s}'`).join(',')})),
      next_due_at    TIMESTAMPTZ,

      -- Threading, so a follow-up lands under the original rather than as a new message.
      thread_id      TEXT,
      last_rfc822_id TEXT,
      refs_chain     TEXT,

      replied_at     TIMESTAMPTZ,
      last_sent_at   TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- One sequence per person per channel. Two rows for the same lab would chase them twice.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_outreach_state_subject
      ON outreach_state (channel, ref);
    CREATE INDEX IF NOT EXISTS idx_outreach_state_due
      ON outreach_state (status, next_due_at);

    -- ── EVERY MESSAGE, CLAIMED BEFORE IT IS SENT ────
    CREATE TABLE IF NOT EXISTS outreach_sends (
      id          BIGSERIAL PRIMARY KEY,
      channel     TEXT NOT NULL,
      ref         TEXT NOT NULL,
      need        TEXT NOT NULL,
      step        INTEGER NOT NULL,
      to_email    TEXT NOT NULL,
      subject     TEXT,
      rfc822_id   TEXT,
      thread_id   TEXT,
      -- The opening sentence as it was actually sent. Stored because it is a claim we made about
      -- that person, and when somebody replies "that is not my grant" we need to see what went.
      evidence    TEXT,
      confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
      sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- THE DOUBLE-SEND GUARD. Claimed before Gmail is called, so two runs racing cannot both send.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_outreach_sends_step
      ON outreach_sends (channel, ref, step);
    CREATE INDEX IF NOT EXISTS idx_outreach_sends_sent
      ON outreach_sends (sent_at DESC);

    -- ── BOUNCES ────
    -- Bounce rate is what damages a warmed domain fastest, and sales@abiozen.com took six weeks
    -- to warm. Recorded per address so a run can refuse to continue above a threshold.
    CREATE TABLE IF NOT EXISTS outreach_bounces (
      id         BIGSERIAL PRIMARY KEY,
      email      TEXT NOT NULL,
      kind       TEXT,                       -- hard | soft | complaint
      detail     TEXT,
      noticed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_outreach_bounces_email ON outreach_bounces (LOWER(email));
  `);

  const c = (await query(`
    SELECT (SELECT COUNT(*)::int FROM outreach_state)   AS states,
           (SELECT COUNT(*)::int FROM outreach_sends)   AS sends,
           (SELECT COUNT(*)::int FROM outreach_bounces) AS bounces`)).rows[0];

  console.log('\n✅ outreach_state · outreach_sends · outreach_bounces ready\n');
  console.log(`   sequences  ${c.states}`);
  console.log(`   sends      ${c.sends}`);
  console.log(`   bounces    ${c.bounces}`);
  console.log(`\n   needs: ${NEEDS.join(', ')}`);
  console.log('   (channel, ref, step) is UNIQUE — the runner claims a slot before calling Gmail,');
  console.log('   so two runs racing cannot both send the same step to the same person.\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('migrate-outreach-sequences failed:', e && e.message ? e.message : e);
  process.exit(1);
});
