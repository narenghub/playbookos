// ── CPHI Event Agent: entity_note + not_found tier (additive, standalone, NOT wired into boot) ──
//
// DELIBERATE DEVIATION FROM THE SPEC, worth reading before you look for a `cphi_exhibitors`
// table. The spec asks for a new table with that name; `cphi_exhibitor_matches` already exists
// (scripts/migrate-cphi-exhibitors.js), already holds all 286 rows for cphi-milan-2026, and
// already carries every column the spec lists under a different name:
//
//     spec                       existing
//     event                      event_slug
//     holder / exhibitor_name    same
//     exhibiting / booth / hall  same
//     match_tier                 same (but NULL, not 'not_found', when nothing matched)
//     review_status              same
//     molecules_covered          same
//     checked_at                 same
//     unique (event, holder)     unique (event_slug, holder_normalized)
//     entity_note                MISSING
//
// Creating the second table would fork the data and leave the routes reading whichever one was
// written last. So this migration closes the two real gaps instead:
//   1. adds entity_note
//   2. normalises match_tier to 'not_found' rather than NULL, so the column is never null and
//      the API can filter on it uniformly
// and backfills entity_note for the parent/sibling cases the spec names.
//
// Run manually:
//   node scripts/migrate-cphi-entity-note.js
//
// Manual rollback:
//   ALTER TABLE cphi_exhibitor_matches DROP COLUMN IF EXISTS entity_note;
//   UPDATE cphi_exhibitor_matches SET match_tier = NULL WHERE match_tier = 'not_found';

const { initDB, query } = require('../src/lib/db');

async function migrateCphiEntityNote() {
  await initDB();

  await query(`
    ALTER TABLE cphi_exhibitor_matches ADD COLUMN IF NOT EXISTS entity_note TEXT;

    -- match_tier is now total: every row says what happened, including "nothing matched".
    UPDATE cphi_exhibitor_matches SET match_tier = 'not_found' WHERE match_tier IS NULL;

    -- The index the Event Agent page's default query needs (exhibiting, ranked by coverage).
    CREATE INDEX IF NOT EXISTS idx_cem_event_exh_mol
      ON cphi_exhibitor_matches (event_slug, exhibiting, molecules_covered DESC);
  `);

  // Backfill the parent/sibling note. Every entity_review row is one by construction: the tier
  // is 'prefix', which means one company name is a prefix of the other rather than equal, and
  // on live data that is nearly always a group relationship (Umicore Argentina vs Umicore AG,
  // Cambrex Charles City vs Cambrex, Zydus Worldwide DMCC vs Zydus Pharmaceuticals USA).
  const upd = await query(
    `UPDATE cphi_exhibitor_matches
        SET entity_note = 'Booth is correct, legal entity may differ: the DMF is filed by "'
                          || holder || '" but the stand reads "' || exhibitor_name
                          || '". Same group — confirm which entity holds the file before contracting.'
      WHERE review_status = 'entity_review' AND entity_note IS NULL
      RETURNING holder`,
  );

  const tiers = await query(
    `SELECT match_tier, COUNT(*)::int n FROM cphi_exhibitor_matches GROUP BY 1 ORDER BY 1`,
  );

  console.log(`✅ CPHI entity_note applied (${upd.rows.length} parent/sibling notes backfilled)`);
  console.log('   match_tier now:', tiers.rows.map(r => `${r.match_tier}=${r.n}`).join(' '));
  process.exit(0);
}

migrateCphiEntityNote().catch(e => { console.error('CPHI entity-note migration error:', e.message); process.exit(1); });
