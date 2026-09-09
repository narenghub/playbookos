// ── CPHI sourcing Step 1: DMF ingest schema (additive, standalone, NOT wired into boot) ──
//
// Two tables:
//
//   dmf_holders            one row per FDA Drug Master File. The quarterly XLSX verbatim,
//                          plus two normalized columns computed at ingest time.
//   molecule_dmf_matches   the join from a Clinical Demand molecule to a DMF, carrying the
//                          TIER that produced it so precision can be judged per tier rather
//                          than as one blended number, plus a review gate for the one tier
//                          that cannot be trusted unattended.
//
// dmf_number is the natural primary key — it is the FDA's own identifier, stable across
// quarterly files, and the thing an ON CONFLICT re-ingest keys on.
//
// The normalized columns are stored, not computed on read, because both are join keys:
// subject_normalized is what molecule matching hits (indexed), and holder_normalized is what
// Step 2 will join to CPHI exhibitor names. Recomputing either in a query would forfeit
// the index.
//
// Standalone on purpose: nothing imports it, so it does NOT run on boot. Run manually:
//   node scripts/migrate-dmf.js
//   railway ssh 'node scripts/migrate-dmf.js'
//
// Manual rollback:
//   DROP TABLE IF EXISTS molecule_dmf_matches; DROP TABLE IF EXISTS dmf_holders;

const { initDB, query } = require('../src/lib/db');

async function migrateDmf() {
  await initDB(); // ensures base schema exists before we create alongside it

  await query(`
    CREATE TABLE IF NOT EXISTS dmf_holders (
      dmf_number          INTEGER PRIMARY KEY,
      status              TEXT,          -- A = active, I = inactive (FDA's own flag)
      dmf_type            TEXT,          -- I..V; only II is a drug substance
      submit_date         DATE,
      holder              TEXT NOT NULL,
      subject             TEXT NOT NULL,
      holder_normalized   TEXT,          -- org-name fold, for the Step-2 CPHI company join
      subject_normalized  TEXT,          -- molecule fold, for Step-1 matching
      source_file         TEXT,          -- e.g. "2Q2026-EXCEL" — which quarterly file this row came from
      ingested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_dmf_subject_norm ON dmf_holders (subject_normalized);
    CREATE INDEX IF NOT EXISTS idx_dmf_holder_norm  ON dmf_holders (holder_normalized);
    -- The matcher only ever reads ACTIVE TYPE II (drug substances). Types III/IV/V are
    -- packaging and excipients and must never reach a molecule match.
    CREATE INDEX IF NOT EXISTS idx_dmf_status_type  ON dmf_holders (status, dmf_type);

    CREATE TABLE IF NOT EXISTS molecule_dmf_matches (
      id            BIGSERIAL PRIMARY KEY,
      molecule_name TEXT NOT NULL,       -- verbatim as it appears in study_molecules
      dmf_number    INTEGER NOT NULL,
      match_tier    TEXT NOT NULL,       -- exact | salt_form | annotated | contained
      -- Review gate. The 'contained' (substring) tier is ~50% wrong on live data — it reads
      -- "89 Zr daratumumab" as a daratumumab source and "20% dronabinol in sesame oil" as a
      -- sesame-oil source — but it is also the ONLY tier that reaches biologics whose registry
      -- subject carries a prefix ("recombinant interleukin 2 aldesleukin"). So it is kept and
      -- recorded, never discarded, and gated here: nothing reaches the CPHI target list unless
      -- review_status <> 'unreviewed'. The three deterministic tiers are written as
      -- 'auto_confirmed'; only 'contained' lands on the DEFAULT.
      review_status TEXT NOT NULL DEFAULT 'unreviewed',  -- unreviewed | auto_confirmed | confirmed | rejected
      matched_subject TEXT,              -- the DMF subject that produced the hit; the report
                                         -- groups on this so one molecule counts once even when
                                         -- study_molecules holds it under several source names
      matched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- One row per (molecule, DMF). A molecule can reach the same DMF via more than one tier;
    -- the ingest keeps the STRONGEST tier and this constraint is what enforces that.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mdm_unique ON molecule_dmf_matches (molecule_name, dmf_number);
    CREATE INDEX IF NOT EXISTS idx_mdm_molecule ON molecule_dmf_matches (molecule_name);
    -- The target-list query is "everything not awaiting review", so index the gate.
    CREATE INDEX IF NOT EXISTS idx_mdm_review ON molecule_dmf_matches (review_status, match_tier);
    CREATE INDEX IF NOT EXISTS idx_mdm_subject ON molecule_dmf_matches (matched_subject);
  `);

  console.log('✅ DMF schema applied (dmf_holders + molecule_dmf_matches)');
  process.exit(0);
}

migrateDmf().catch(e => { console.error('DMF migration error:', e.message); process.exit(1); });
