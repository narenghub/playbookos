#!/usr/bin/env node
// ── THE BUYING UNIT IS A LAB, NOT AN INSTITUTION ──────────────────────────────
//
//   railway ssh 'node scripts/migrate-research-labs.js'
//
// Safe to re-run. Creates nothing that already exists; writes no contacts.
//
// ── WHY THIS IS NOT research_institutions WITH MORE COLUMNS ──────────────────
//
// "Oxford" does not source a synthesised molecule. A named group inside Oxford does, on a specific
// grant, for a specific target, with a specific person who signs. research_institutions is a
// PLACES table built from trial-site listings: one row per institution, study_count as an activity
// proxy, and a registry contact on ~22% of rows. It answers "who runs trials where". It cannot
// answer "whose discovery programme needs a compound made", because that is a different person at
// a different stage of the pipeline — usually a different building.
//
// So the unit here is the lab: a principal investigator, their institution, what they work on,
// whether they currently hold money, and when they were last active. An institution is the billing
// entity; the lab is the customer.
//
// ── THE CONTACT WE ALREADY HAVE IS THE WRONG CONTACT ─────────────────────────
//
// research_institutions.contact_email comes from the registry's contactsLocationsModule. Those
// addresses are published so that PATIENTS CAN ENROL IN A TRIAL. Mailing them about chemical
// supply is a different purpose from the one they were published for, which is a GDPR
// purpose-limitation problem in the EU and UK regardless of consent language, and it is also
// simply the wrong desk — a recruitment coordinator cannot buy a molecule and will mark it spam.
// On a domain whose reputation is already thin from outreach volume, that is the expensive kind of
// wrong. Those rows stay where they are and are not migrated into research_people.
//
// What belongs here instead is published FOR scientific correspondence or as public grant record:
//   · a corresponding author's email, printed in their own paper so colleagues can write to them
//     about that work — which is exactly what we would be writing about;
//   · a public award record naming the PI, their institution and what they were funded to do.
//
// Hence the provenance columns. They are not bureaucracy: source_url and published_for are how we
// answer an objection in writing, and email_basis is how we keep guessed addresses out of the
// sender. See the comment on email_basis — that column is the one protecting the domain.
'use strict';

const { initDB, query } = require('../src/lib/db');

async function main() {
  await initDB();

  await query(`
    -- ── THE LAB ────
    CREATE TABLE IF NOT EXISTS research_labs (
      id                BIGSERIAL PRIMARY KEY,
      institution_id    BIGINT,          -- logical FK -> research_institutions.id, when resolvable
      institution_name  TEXT NOT NULL,   -- verbatim as the source wrote it; resolution comes later
      normalized_name   TEXT NOT NULL,   -- institution, normalised, for joining to the places table
      country           TEXT,
      city              TEXT,

      pi_name           TEXT NOT NULL,   -- the person who leads the discovery work
      pi_name_normalized TEXT NOT NULL,
      department        TEXT,

      -- WHAT THEY WORK ON, in their own words: a grant title, a paper title, a target.
      -- Free text on purpose. The structured version lives in research_interests.
      focus             TEXT,

      -- ── THE TWO SIGNALS THAT DECIDE WHO IS WORTH WRITING TO ────
      -- Money, and recency. A lab with a live award is a lab with a budget; a lab last seen in
      -- 2015 is a lab that has moved on, retired, or closed. research_institutions got this wrong
      -- by ranking on study_count, which rewards big hospitals for having existed.
      funding_source    TEXT,            -- nih_reporter | cordis | ukri | …
      funding_id        TEXT,            -- the public award number, so a human can check us
      funding_end       DATE,            -- past this date, assume no budget until re-checked
      funding_amount    NUMERIC(14,2),   -- public record; informs whether to quote at all
      last_active       DATE,            -- latest publication or award activity we can see
      evidence_count    INTEGER NOT NULL DEFAULT 0,  -- papers/awards behind this row

      source            TEXT NOT NULL,   -- europepmc | nih_reporter | cordis | ukri | manual
      source_url        TEXT,            -- the exact record. Every claim must be checkable.
      collected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      refreshed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      UNIQUE (pi_name_normalized, normalized_name)
    );

    CREATE INDEX IF NOT EXISTS idx_rl_inst    ON research_labs (normalized_name);
    CREATE INDEX IF NOT EXISTS idx_rl_country ON research_labs (country);
    -- the real working cut: funded, recent, somewhere we can ship to
    CREATE INDEX IF NOT EXISTS idx_rl_live    ON research_labs (country, funding_end DESC NULLS LAST);
    CREATE INDEX IF NOT EXISTS idx_rl_active  ON research_labs (last_active DESC NULLS LAST);

    -- ── THE PERSON ────
    CREATE TABLE IF NOT EXISTS research_people (
      id              BIGSERIAL PRIMARY KEY,
      lab_id          BIGINT NOT NULL,   -- logical FK -> research_labs.id
      full_name       TEXT NOT NULL,
      title           TEXT,
      email           TEXT,

      -- pi: leads the programme and decides. co_investigator: named on the award.
      -- lab_manager: places the actual order. core_facility: buys for a whole department and is
      -- the highest-volume contact in the building. tech_transfer: signs the MTA.
      role_category   TEXT NOT NULL DEFAULT 'pi'
        CHECK (role_category IN ('pi','co_investigator','lab_manager','core_facility','tech_transfer')),

      -- ── THE COLUMN THAT PROTECTS THE SENDING DOMAIN ────
      -- 'published'        the person printed this address themselves for correspondence about
      --                    this work. Mailable.
      -- 'pattern_inferred' we guessed it from an institutional pattern (first.last@ox.ac.uk).
      --                    NOT mailable. Guessed addresses are the single fastest way to a bounce
      --                    rate that gets a domain filtered, and we already carry reputation
      --                    damage from outreach volume. They are kept only so that a human can
      --                    confirm one deliberately, which promotes it to 'confirmed'.
      -- 'confirmed'        a human verified it, or the person replied from it.
      email_basis     TEXT NOT NULL DEFAULT 'published'
        CHECK (email_basis IN ('published','pattern_inferred','confirmed')),

      -- Provenance. Written on every row, because "where did you get my address" is a question we
      -- must be able to answer with a URL and a date, not a shrug.
      source          TEXT NOT NULL,
      source_url      TEXT,
      published_for   TEXT,              -- e.g. 'scientific correspondence (corresponding author)'
      collected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      UNIQUE (lab_id, email)
    );

    CREATE INDEX IF NOT EXISTS idx_rp_lab   ON research_people (lab_id);
    CREATE INDEX IF NOT EXISTS idx_rp_role  ON research_people (role_category);
    CREATE INDEX IF NOT EXISTS idx_rp_email ON research_people (lower(email));
    -- the sendable set, in one index: a published or confirmed address and nothing guessed
    CREATE INDEX IF NOT EXISTS idx_rp_mailable ON research_people (email_basis)
      WHERE email IS NOT NULL AND email_basis <> 'pattern_inferred';

    -- ── WHAT THEY WORK ON, JOINED TO WHAT WE CAN MAKE ────
    -- The reason to build any of this. A lab is reachable; a lab whose published compound we can
    -- quote is PERSUADABLE, because the first line of the email is about their own work rather
    -- than about us. molecule_name is matched against the same dictionary the catalogue extractor
    -- uses, so "can we make this" is answerable in the same query as "who needs it made".
    CREATE TABLE IF NOT EXISTS research_interests (
      id             BIGSERIAL PRIMARY KEY,
      lab_id         BIGINT NOT NULL,    -- logical FK -> research_labs.id
      kind           TEXT NOT NULL CHECK (kind IN ('molecule','target','modality','indication')),
      value          TEXT NOT NULL,      -- as written in the source
      normalized     TEXT NOT NULL,      -- lowercased/trimmed, for matching
      cas            TEXT,               -- when the source names one, checksum-validated upstream
      evidence_url   TEXT,
      first_seen     DATE,
      last_seen      DATE,
      mentions       INTEGER NOT NULL DEFAULT 1,
      UNIQUE (lab_id, kind, normalized)
    );

    CREATE INDEX IF NOT EXISTS idx_ri2_lab  ON research_interests (lab_id);
    CREATE INDEX IF NOT EXISTS idx_ri2_norm ON research_interests (kind, normalized);
    CREATE INDEX IF NOT EXISTS idx_ri2_cas  ON research_interests (cas) WHERE cas IS NOT NULL;

    -- ── DO NOT CONTACT ────
    -- Separate table, keyed on the address, deliberately NOT a flag on research_people: an
    -- objection must survive the row being deleted and re-ingested next week from the same public
    -- source. A flag on a re-created row is not a suppression list, it is a promise we break
    -- automatically on the next refresh. Checked before every send.
    CREATE TABLE IF NOT EXISTS contact_suppression (
      email        TEXT PRIMARY KEY,
      reason       TEXT NOT NULL,   -- objection | unsubscribe | bounce_hard | manual
      note         TEXT,
      added_by     TEXT,
      added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const counts = (await query(`
    SELECT (SELECT COUNT(*)::int FROM research_labs)        labs,
           (SELECT COUNT(*)::int FROM research_people)      people,
           (SELECT COUNT(*)::int FROM research_interests)   interests,
           (SELECT COUNT(*)::int FROM contact_suppression)  suppressed,
           (SELECT COUNT(*)::int FROM research_institutions) institutions,
           (SELECT COUNT(*)::int FROM research_institutions
             WHERE contact_email IS NOT NULL)               registry_contacts
  `)).rows[0];

  console.log('\n✅ research_labs / research_people / research_interests / contact_suppression ready\n');
  console.log(`   labs                       ${counts.labs}`);
  console.log(`   people                     ${counts.people}`);
  console.log(`   interests                  ${counts.interests}`);
  console.log(`   suppressed                 ${counts.suppressed}`);
  console.log(`   institutions (places)      ${counts.institutions}`);
  console.log(`   registry contacts there    ${counts.registry_contacts}   ← recruitment desks, NOT migrated`);
  console.log('\n   Next: scripts/probe-research-sources.js to confirm the live field shapes,');
  console.log('   then the ingest. Nothing writes a contact until that probe passes.\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('migrate-research-labs failed:', e && e.message ? e.message : e);
  process.exit(1);
});
