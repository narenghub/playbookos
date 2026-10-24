#!/usr/bin/env node
// ── P0 · OUTCOME GROUND TRUTH ────────────────────────────────────────────────
//
//   railway ssh 'node scripts/migrate-lead-outcomes.js'
//
// Safe to re-run. Creates nothing that exists; writes no data.
//
// ── WHY THIS IS P0 AND NOT P4 ────────────────────────────────────────────────
//
// Every score the platform will eventually compute — ICP fit, intent, contactability, opportunity
// value — is a hypothesis until something records what actually happened to the leads already
// delivered. A score with no outcome history behind it is precisely the "high numerical score
// disguising weak evidence" the architecture warns against, and no amount of model work fixes it:
// you cannot learn from outcomes you never wrote down.
//
// It is also the cheapest thing on the roadmap. Two tables and a view.
//
// ── TWO PRINCIPLES MADE STRUCTURAL ───────────────────────────────────────────
//
// "EVERY LEAD MUST HAVE A REASON" — lead_deliveries.reason is NOT NULL. It is not possible to
// record that we gave a customer a prospect without recording why we thought it was one. A
// principle enforced by a column survives the week everybody is busy; a principle in a document
// does not.
//
// "PRESERVE HISTORY RATHER THAN OVERWRITING" — lead_outcomes is append-only, enforced by a trigger
// that refuses UPDATE and DELETE. A status column that gets overwritten destroys the exact thing
// that makes the data valuable: a lead marked not_relevant in March and won in June is the most
// informative record in the table, and a mutable column would have kept only the ending.
//
// Current state is therefore DERIVED (see lead_current_state) rather than stored. That is slower
// and correct.
'use strict';

const { initDB, query } = require('../src/lib/db');

// The vocabulary from the execution directive. A CHECK rather than free text, so a typo cannot
// quietly create a thirteenth outcome nobody aggregates.
const OUTCOMES = ['viewed', 'useful', 'not_relevant', 'wrong_company', 'wrong_contact',
  'contacted', 'responded', 'meeting_booked', 'qualified', 'opportunity_created', 'won', 'lost'];

async function main() {
  await initDB();

  await query(`
    -- ── WHAT WE GAVE SOMEONE, AND WHY ────
    CREATE TABLE IF NOT EXISTS lead_deliveries (
      id              BIGSERIAL PRIMARY KEY,
      customer_key    TEXT NOT NULL,          -- who received it: 'mural-health', 'chemscene'
      campaign_key    TEXT,                   -- optional: the campaign or cut it came from

      -- WHAT was recommended, kept as a type plus a reference rather than a foreign key, because
      -- a lead may be a trial, a lab, a supplier product or something not yet invented. The type
      -- says which table the reference means.
      subject_type    TEXT NOT NULL,          -- clinical_study | research_lab | supplier_product
      subject_ref     TEXT NOT NULL,          -- NCT id, lab id, product id

      source          TEXT NOT NULL,          -- the pipeline that produced it
      -- NOT NULL on purpose. "Every lead must have a reason" is only true if it cannot be skipped.
      reason          TEXT NOT NULL,
      evidence_url    TEXT,                   -- where a human can check the claim
      confidence      REAL,                   -- our own, at delivery time

      delivery_method TEXT,                   -- csv | email | api | portal
      delivered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_ld_customer ON lead_deliveries (customer_key, delivered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ld_subject  ON lead_deliveries (subject_type, subject_ref);
    CREATE INDEX IF NOT EXISTS idx_ld_source   ON lead_deliveries (source);

    -- ── WHAT HAPPENED NEXT, APPEND-ONLY ────
    CREATE TABLE IF NOT EXISTS lead_outcomes (
      id            BIGSERIAL PRIMARY KEY,
      delivery_id   BIGINT NOT NULL REFERENCES lead_deliveries(id) ON DELETE RESTRICT,
      outcome       TEXT NOT NULL CHECK (outcome IN (${OUTCOMES.map((o) => `'${o}'`).join(',')})),
      revenue_value NUMERIC(14,2),            -- only meaningful on 'won'
      reason        TEXT,                     -- a rejection reason is training data; record it
      recorded_by   TEXT,                     -- person or process
      occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_lo_delivery ON lead_outcomes (delivery_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lo_outcome  ON lead_outcomes (outcome, occurred_at DESC);
  `);

  // ── APPEND-ONLY, ENFORCED ────
  // A comment saying "do not update this table" is a request. A trigger is a guarantee, and the
  // history is the asset: the same lead refused in one quarter and won in the next is the most
  // informative row we will ever hold, and only survives if nothing can overwrite it.
  await query(`
    CREATE OR REPLACE FUNCTION lead_outcomes_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION
        'lead_outcomes is append-only: record a new outcome row instead of changing an old one. '
        'The history of what happened to a lead IS the ground truth this table exists to hold.';
    END;
    $$ LANGUAGE plpgsql;
  `);
  await query(`DROP TRIGGER IF EXISTS trg_lead_outcomes_no_update ON lead_outcomes`);
  await query(`
    CREATE TRIGGER trg_lead_outcomes_no_update
      BEFORE UPDATE OR DELETE ON lead_outcomes
      FOR EACH ROW EXECUTE FUNCTION lead_outcomes_append_only();
  `);

  // ── CURRENT STATE, DERIVED ────
  // Not stored. The latest outcome per delivery is a query, so the history stays intact and the
  // "current" answer can never drift from the events that produced it.
  await query(`
    CREATE OR REPLACE VIEW lead_current_state AS
    SELECT d.id AS delivery_id, d.customer_key, d.campaign_key, d.subject_type, d.subject_ref,
           d.source, d.reason, d.evidence_url, d.confidence, d.delivered_at,
           o.outcome AS current_outcome, o.occurred_at AS outcome_at,
           o.revenue_value, o.reason AS outcome_reason,
           (SELECT COUNT(*)::int FROM lead_outcomes x WHERE x.delivery_id = d.id) AS outcome_events
      FROM lead_deliveries d
      LEFT JOIN LATERAL (
        SELECT * FROM lead_outcomes o2
         WHERE o2.delivery_id = d.id
         ORDER BY o2.occurred_at DESC, o2.id DESC
         LIMIT 1
      ) o ON TRUE;
  `);

  const c = (await query(`
    SELECT (SELECT COUNT(*)::int FROM lead_deliveries) deliveries,
           (SELECT COUNT(*)::int FROM lead_outcomes)   outcomes`)).rows[0];

  console.log('\n✅ lead_deliveries · lead_outcomes · lead_current_state ready\n');
  console.log(`   deliveries  ${c.deliveries}`);
  console.log(`   outcomes    ${c.outcomes}`);
  console.log(`   outcome vocabulary: ${OUTCOMES.join(', ')}`);
  console.log('\n   reason is NOT NULL on a delivery — a lead without a stated reason cannot be recorded.');
  console.log('   lead_outcomes refuses UPDATE and DELETE — correct a mistake by appending, not editing.\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('migrate-lead-outcomes failed:', e && e.message ? e.message : e);
  process.exit(1);
});
