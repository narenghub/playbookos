#!/usr/bin/env node
// ── A TABLE FOR TRIAL SITES ───────────────────────────────────────────────────
//
//   railway ssh 'node scripts/migrate-study-sites.js'
//
// Re-runnable: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS throughout.
//
// 86,514 site rows were sitting inside clinical_studies.raw_json, unqueryable. Oxford showed 4
// studies instead of 46 because only locations_countries was stored, so a trial's facilities could
// not be joined to anything.
//
// ── WHY facility_normalized IS A COLUMN AND NOT A VIEW ───────────────────────
//
// Grouping has to happen on the normalised key, and normalising 86k rows inside every query would
// make the institution search unusable. It is written once, at parse time, by
// src/lib/agents/research-intelligence/sites.js — which is also where the rule lives, so the
// column and the rule cannot drift.
//
// ── WHY anonymised IS A COLUMN AND NOT A FILTER AT READ TIME ─────────────────
//
// "Novartis Investigative Site" (2,192 rows) and "Research Site" (1,836) are sponsor placeholders.
// They are real evidence that a trial recruits in a city and must be kept; they are not
// institutions and must never reach an institution league table. Deciding that per query would
// mean every caller re-implementing the rule, and the first one to forget puts "Research Site" at
// the top of the list.
'use strict';

const { initDB, query } = require('../src/lib/db');

async function main() {
  await initDB();

  await query(`
    CREATE TABLE IF NOT EXISTS study_sites (
      id                  BIGSERIAL PRIMARY KEY,
      nct_id              TEXT NOT NULL,
      facility            TEXT,            -- verbatim, as published
      facility_normalized TEXT,            -- the grouping key; see sites.js
      anonymised          BOOLEAN NOT NULL DEFAULT FALSE,
      city                TEXT,
      state               TEXT,
      country             TEXT,
      zip                 TEXT,
      status              TEXT,            -- RECRUITING | COMPLETED | …, per site
      parsed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- One row per (trial, facility, place). A trial legitimately lists the same hospital twice
    -- with different statuses across amendments, and re-parsing must not duplicate rows, so the
    -- backfill deletes a study's rows and re-inserts them rather than relying on a key that
    -- cannot be made honest. COALESCE keeps NULLs from defeating the uniqueness.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_study_sites
      ON study_sites (nct_id, COALESCE(facility_normalized, ''), COALESCE(city, ''), COALESCE(country, ''));

    CREATE INDEX IF NOT EXISTS idx_ss_norm    ON study_sites (facility_normalized)
      WHERE anonymised = FALSE;
    CREATE INDEX IF NOT EXISTS idx_ss_country ON study_sites (country);
    CREATE INDEX IF NOT EXISTS idx_ss_nct     ON study_sites (nct_id);
    CREATE INDEX IF NOT EXISTS idx_ss_city    ON study_sites (country, city);
  `);

  // ── RECORD THE ATTEMPT, NOT THE OUTCOME ────
  // The backfill originally skipped work by asking "does this study already have rows in
  // study_sites?". 275 of 3,287 studies have NO sites published at all, so they never produce a
  // row, so they were never skipped — they would be re-read on every run forever and the
  // remaining-count could never reach zero. "Run it again until it says 0" was unachievable.
  //
  // Parsing is an event that happened whether or not it found anything, so it is recorded on the
  // study.
  await query(`
    ALTER TABLE clinical_studies ADD COLUMN IF NOT EXISTS sites_parsed_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_cs_sites_parsed ON clinical_studies (sites_parsed_at)
      WHERE sites_parsed_at IS NULL;
  `);

  // Studies already parsed under the old rule keep their work: mark them rather than redo them.
  const marked = await query(`
    UPDATE clinical_studies cs SET sites_parsed_at = NOW()
     WHERE sites_parsed_at IS NULL
       AND EXISTS (SELECT 1 FROM study_sites ss WHERE ss.nct_id = cs.nct_id)`);
  if (marked.rowCount) console.log(`   marked ${marked.rowCount} already-parsed study record(s)`);

  await query(`
    COMMENT ON COLUMN study_sites.anonymised IS
      $c$TRUE where the published facility name is a sponsor placeholder — "Novartis Investigative
Site", "Research Site", "Clinical Trial Site" — or where no facility was named at all. These rows
are kept because they prove a trial recruits in that city, and excluded from institution counts
because they are not institutions. Industry sponsors anonymise far more often than academic ones,
so institution-level views are systematically blind to those sponsors: a property of the registry,
not of this code.$c$;
  `);

  const n = (await query(`SELECT COUNT(*)::int n FROM study_sites`)).rows[0].n;
  const cols = (await query(
    `SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_name='study_sites'`)).rows[0].n;
  console.log(`✅ study_sites ready — ${cols} columns, ${n} row(s) present.`);
  if (!n) console.log('   Next:  node scripts/backfill-study-sites.js --execute');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('migrate-study-sites failed:', e && e.message ? e.message : e);
  process.exit(1);
});
