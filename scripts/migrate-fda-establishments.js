// ── AROS sourcing: FDA establishment registration schema (additive, standalone, NOT on boot) ──
//
// Two tables, the same split the DMF work uses:
//
//   fda_establishments          FDA CDER's DECRS publication verbatim, plus four columns
//                               computed at ingest because each is a filter or a join key.
//   dmf_establishment_matches   the join from a DMF holder (dmf_holders, already here) to a
//                               registered establishment, carrying the TIER that produced it.
//
// WHY THIS LIVES IN PLAYNEXA AND TOUCHES NO OTHER DATABASE. Both halves are already
// reachable: dmf_holders is in this database, and the establishment file is a 2.3 MB public
// download from accessdata.fda.gov. AROS mirrors the same file for its own supplier
// verification, but reading ACROSS to it would couple two services' schemas for data that
// can simply be fetched. Two mirrors of a public file is not duplication worth avoiding —
// a cross-database read is.
//
// THE NATURAL KEY IS THE SITE, NOT THE FIRM. FEI alone is wrong — the source carries 7-digit,
// 10-digit and zero-padded forms of one number, and 201 of 10,454 rows have no FEI at all.
// (fei_number, firm_name) is ALSO wrong, and measurably so: 160 keys are duplicated across 222
// rows, and 158 of those differ on ADDRESS — one firm, several registered sites. 81 differ on
// OPERATIONS, which is worse than losing a row:
//
//     Lifecore Biomedical, LLC  fei=1000115753  MANUFACTURE
//     Lifecore Biomedical, LLC  fei=1000115753  ANALYSIS; API MANUFACTURE; LABEL; PACK
//
// Collapsing those keeps whichever arrived last, so a site can silently lose the
// API MANUFACTURE flag the entire ICP filter runs on.
//
// site_key is md5 over the triple, computed at ingest rather than a UNIQUE on the three columns
// directly, because address is nullable and Postgres treats NULLs as distinct — two rows with no
// address would never conflict and would duplicate on every re-run.
//
// FOUR COMPUTED COLUMNS, stored rather than derived on read, because every one is a filter the
// page runs on every request:
//
//   firm_normalized     the org-name fold. This is the DMF join key; recomputing it in a query
//                       forfeits the index, exactly as holder_normalized would.
//   country             parsed from the address tail — "…, France (FRA)". The geographic
//                       filter is the whole ICP cut for a US/EU sales motion, and re-deriving
//                       it per query means a regex over 10k rows to answer "is this German".
//   is_api_manufacturer OPERATIONS contains API MANUFACTURE. A regulator-verified statement of
//                       what the site does — the single best qualifying signal in the file.
//   is_us_agent         the REGISTRANT contact is a third-party US agent (Registrar Corp and
//                       friends), not the manufacturer. 597 rows point at registrarcorp.com
//                       alone. Without this flag someone mails a thousand compliance
//                       intermediaries believing they are talking to the plant.
//
// Standalone on purpose: nothing imports it, so it does NOT run on boot. Run manually:
//   node scripts/migrate-fda-establishments.js
//   railway ssh 'node scripts/migrate-fda-establishments.js'
//
// Manual rollback:
//   DROP TABLE IF EXISTS dmf_establishment_matches;
//   DROP TABLE IF EXISTS fda_establishments;

const { initDB, query } = require('../src/lib/db');

async function migrateFdaEstablishments() {
  await initDB();

  await query(`
    CREATE TABLE IF NOT EXISTS fda_establishments (
      id                    BIGSERIAL PRIMARY KEY,
      site_key              TEXT NOT NULL, -- md5(fei | firm_name | address); one row per SITE
      fei_number            TEXT,          -- nullable: 201 registered rows carry none
      duns_number           TEXT,
      firm_name             TEXT NOT NULL,
      firm_normalized       TEXT NOT NULL, -- org-name fold; the DMF join key
      address               TEXT,
      country               TEXT,          -- ISO-3 parsed from the address tail
      operations            TEXT,          -- "ANALYSIS; API MANUFACTURE; PACK; STERILIZE"
      is_api_manufacturer   BOOLEAN NOT NULL DEFAULT FALSE,
      establishment_contact_name   TEXT,
      establishment_contact_email  TEXT,   -- a real person at the firm; 100% populated
      registrant_name              TEXT,
      registrant_contact_email     TEXT,   -- often a US AGENT, not the firm — see is_us_agent
      is_us_agent           BOOLEAN NOT NULL DEFAULT FALSE,
      exclusion_flag        TEXT,
      source_last_modified  TEXT,          -- the FDA response header; makes a re-run a no-op
      ingested_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (site_key)
    );

    CREATE INDEX IF NOT EXISTS idx_fda_est_firm_norm ON fda_establishments (firm_normalized);
    -- the page's default filter, as one index: API manufacturers in a given country
    CREATE INDEX IF NOT EXISTS idx_fda_est_icp
      ON fda_establishments (is_api_manufacturer, country);

    CREATE TABLE IF NOT EXISTS dmf_establishment_matches (
      id                  BIGSERIAL PRIMARY KEY,
      holder              TEXT NOT NULL,
      holder_normalized   TEXT NOT NULL,
      dmf_count           INTEGER NOT NULL DEFAULT 0,  -- active Type II filings; the size proxy
      establishment_id    BIGINT REFERENCES fda_establishments(id) ON DELETE CASCADE,
      fei_number          TEXT,
      match_tier          TEXT NOT NULL,   -- exact | core | not_found. Never NULL: the column
                                           -- is total so the API filters on it uniformly.
      -- exact/core are auto_confirmed. Anything looser is held: the Baxter Oncology GmbH and
      -- Sanofi Aventis US cases are real companies whose DMF-holding entity and registered
      -- establishment are DIFFERENT legal entities, and a matcher cannot tell that apart from
      -- a coincidence without a human.
      review_status       TEXT NOT NULL DEFAULT 'unreviewed',
      matched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (holder_normalized)
    );

    CREATE INDEX IF NOT EXISTS idx_dmf_est_tier ON dmf_establishment_matches (match_tier);
    CREATE INDEX IF NOT EXISTS idx_dmf_est_count ON dmf_establishment_matches (dmf_count);
  `);

  const t = await query(
    `SELECT table_name, (SELECT COUNT(*)::int FROM information_schema.columns c
                          WHERE c.table_name = t.table_name) AS cols
       FROM information_schema.tables t
      WHERE table_schema='public' AND table_name IN ('fda_establishments','dmf_establishment_matches')
      ORDER BY 1`);
  console.log('✅ FDA establishment schema applied');
  for (const r of t.rows) console.log(`   ${r.table_name}  (${r.cols} columns)`);
  process.exit(0);
}

migrateFdaEstablishments().catch(e => {
  console.error('FDA establishment migration error:', e.message);
  process.exit(1);
});
