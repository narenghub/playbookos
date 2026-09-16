// ── Abiozen sourcing: research institutions schema (additive, standalone, NOT on boot) ──
//
// One row per INSTITUTION that runs clinical trials — the universities, hospitals, cancer
// centres and research institutes that buy research chemicals. Abiozen's customer side.
//
// NOT research_organizations, which already exists. That table holds 222 trial SPONSORS
// resolved through Apollo by the Research Intelligence agent — who is RUNNING a trial, usually
// a pharma company. This is the SITES where trials are physically conducted. A sponsor buys
// nothing from a catalogue; a university hospital lab does.
//
// SOURCED ENTIRELY FROM DATA WE ALREADY HOLD. clinical_studies.raw_json retains the registry's
// full record, whose contactsLocationsModule carries facility, city, state, country and a
// contacts array with name/phone/email per site. No new API calls, no enrichment step — which
// is the whole reason this source was chosen over the alternatives, all of which died at
// enrichment (Places cannot tell a CRO from big pharma; the FDA register only reaches
// manufacturers; NIH RePORTER has the best addresses of any of them and NO email field at all).
//
// normalized_name is the natural key. Deliberately a LIGHT fold — lowercase, strip punctuation
// — not the DMF matcher's generic-word stripping: there "pharmaceuticals ltd" carried no
// identity, here "University" and "Hospital" ARE the identity, and folding them would merge
// Boston University into Boston Children's Hospital. The cost is that spelling variants of one
// institution stay separate rows, which is the safer error for a list someone will email.
//
// Run manually:
//   node scripts/migrate-research-institutions.js
//   railway ssh 'node scripts/migrate-research-institutions.js'
//
// Manual rollback:
//   DROP TABLE IF EXISTS research_institutions;

const { initDB, query } = require('../src/lib/db');

async function migrateResearchInstitutions() {
  await initDB();

  await query(`
    CREATE TABLE IF NOT EXISTS research_institutions (
      id              BIGSERIAL PRIMARY KEY,
      name            TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      city            TEXT,
      state           TEXT,
      country         TEXT,
      -- academic | hospital | cancer_centre | institute. 'other' never persists: the parser
      -- treats it as out-of-ICP and drops the row, so the column is always a real category.
      facility_type   TEXT NOT NULL,
      study_count     INTEGER NOT NULL DEFAULT 0,  -- trials this site ran; the activity proxy
      contact_name    TEXT,
      contact_email   TEXT,   -- registry-published; ~22% of rows carry one
      first_seen      DATE,   -- earliest trial start we have for this site
      last_seen       DATE,   -- latest; a site last seen in 2013 is not an active lab
      source          TEXT NOT NULL DEFAULT 'clinicaltrials.gov',
      refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (normalized_name)
    );

    -- the page's default cut: ICP categories in the US/EU that carry a contact
    CREATE INDEX IF NOT EXISTS idx_ri_country_type ON research_institutions (country, facility_type);
    CREATE INDEX IF NOT EXISTS idx_ri_email ON research_institutions ((contact_email IS NOT NULL));
    CREATE INDEX IF NOT EXISTS idx_ri_studies ON research_institutions (study_count DESC);
  `);

  const cols = await query(
    `SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_name='research_institutions'`);
  console.log(`✅ research_institutions ready (${cols.rows[0].n} columns)`);
  process.exit(0);
}

migrateResearchInstitutions().catch(e => {
  console.error('research institutions migration error:', e.message);
  process.exit(1);
});
