// ── CPHI sourcing: exhibitor-match schema (additive, standalone, NOT wired into boot) ──
//
// One row per (event, DMF holder): is this API manufacturer on the show floor, at which booth,
// and how confident is the name match.
//
// molecules_covered is DENORMALISED on purpose. It is the demand-rank at the time of the run —
// derived from study_molecules + clinical_studies + molecule_dmf_matches, all of which move
// when the quarterly DMF file lands. Storing it makes each run a dated snapshot you can compare
// quarter to quarter, which recomputing on read would destroy.
//
// review_status gates two different problems:
//   auto_confirmed  exact/core name match - same legal entity, safe to act on.
//   entity_review   `prefix` match. The BOOTH is right but the entity may be a parent or
//                   sibling (UMICORE ARGENTINA SA -> UMICORE AG & CO. KG). Fine for a
//                   conversation on the floor, wrong for a contract.
//   unreviewed      `token` match. ~50% wrong. Never act on it unverified.
//
// Standalone: nothing imports it, so it does NOT run on boot. Run manually:
//   node scripts/migrate-cphi-exhibitors.js
//
// Manual rollback:
//   DROP TABLE IF EXISTS cphi_exhibitor_matches;

const { initDB, query } = require('../src/lib/db');

async function migrateCphiExhibitors() {
  await initDB();

  await query(`
    CREATE TABLE IF NOT EXISTS cphi_exhibitor_matches (
      id                BIGSERIAL PRIMARY KEY,
      event_slug        TEXT NOT NULL,          -- e.g. 'cphi-milan-2026'
      holder            TEXT NOT NULL,          -- DMF holder, verbatim from dmf_holders
      holder_normalized TEXT NOT NULL,          -- join key back to dmf_holders
      exhibiting        BOOLEAN NOT NULL,
      exhibitor_name    TEXT,                   -- the name as it appears on the CPHI stand
      booth             TEXT,
      hall              TEXT,                   -- leading digits of the booth (CPHI hall number)
      match_tier        TEXT,                   -- exact | core | prefix | token
      molecules_covered INTEGER NOT NULL DEFAULT 0,
      review_status     TEXT NOT NULL DEFAULT 'unreviewed',
      searched_terms    TEXT,                   -- what we actually queried, for auditing a miss
      checked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_cem_unique ON cphi_exhibitor_matches (event_slug, holder_normalized);
    CREATE INDEX IF NOT EXISTS idx_cem_exhibiting ON cphi_exhibitor_matches (event_slug, exhibiting, molecules_covered DESC);
    CREATE INDEX IF NOT EXISTS idx_cem_review ON cphi_exhibitor_matches (review_status);
    CREATE INDEX IF NOT EXISTS idx_cem_holder ON cphi_exhibitor_matches (holder_normalized);
  `);

  console.log('✅ CPHI schema applied (cphi_exhibitor_matches)');
  process.exit(0);
}

migrateCphiExhibitors().catch(e => { console.error('CPHI migration error:', e.message); process.exit(1); });
