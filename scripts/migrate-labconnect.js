// ── LABCONNECT SCHEMA ─────────────────────────────────────────────────────────
//
//   railway ssh 'node scripts/migrate-labconnect.js'
//
// Three tables for the LabConnect directory: the labs, a canonical test catalogue, and what each
// lab charges for each test.
//
// ── WHY `labs` IS NOT `partners` ──────────────────────────────────────────────
//
// There is already a partner table with territories, scoping and an approval queue, and a lab is
// obviously "a partner". Reusing it would have been one afternoon less work and it is the wrong
// call, for a reason that is structural rather than tidiness:
//
//   `partners` belongs to SiteNex. `sitenex_deals.partner_id` references it, and the SiteNex
//   Partners page lists EVERY row in it. Put 1,200 labs in there and a partner's territory screen
//   becomes a list of laboratories, the partner count on that page stops meaning anything, and
//   `partnerScopeSql` starts deciding visibility for rows it was never written for.
//
// So the pattern is reused and the rows are not. `region` here plays the part `partner_territories`
// plays there, and `lab_tests` plays the part a territory grant plays — except that a capability is
// explicitly NOT exclusive, which is the other inversion. In SiteNex an exclusive patch protects a
// partner's prospecting investment and the database enforces one holder. Here you want many labs per
// test so an order can be routed on price, turnaround and capacity; exclusivity would be a defect.
//
// ── WHAT `status` MEANS, AND WHY IT STARTS AT 'discovered' ────────────────────
//
// Most rows will arrive from the FDA register, which means the lab has not been contacted, has not
// agreed to anything, and does not know it is in here. That is 'discovered', and it must be
// distinguishable from a lab that has actually signed up, because routing an order to a firm that
// never agreed to receive one is the worst failure this product has. Only 'active' can take an
// order, and the route that assigns work asserts it.
//
// Idempotent: CREATE TABLE IF NOT EXISTS and ADD COLUMN IF NOT EXISTS throughout. Safe to re-run.

const { initDB, query } = require('../src/lib/db');

async function migrate() {
  await initDB();

  await query(`
    CREATE TABLE IF NOT EXISTS labs (
      id                 BIGSERIAL PRIMARY KEY,
      name               TEXT NOT NULL,
      name_normalized    TEXT NOT NULL,          -- the dedupe key across sources

      -- PROVENANCE. 'fda_register' means nobody has spoken to them; 'self_onboard' means the lab
      -- filled the form in itself. The difference decides whether an order may be routed here, so
      -- it is a column and not a note.
      source             TEXT NOT NULL DEFAULT 'fda_register',
      fda_establishment_id BIGINT REFERENCES fda_establishments(id) ON DELETE SET NULL,
      fei_number         TEXT,
      duns_number        TEXT,

      address            TEXT,
      city               TEXT,
      state              TEXT,                   -- US only, two letters, from the address tail
      country            TEXT,                   -- ISO-3
      -- THE ROUTING KEY. NULL is meaningful: it means the location could not be determined, and
      -- those rows are shown separately rather than filed somewhere plausible. See
      -- src/lib/labconnect/region.js for why a US-agent address never produces one.
      region             TEXT,

      contact_name       TEXT,
      contact_email      TEXT,
      contact_phone      TEXT,
      website            TEXT,

      -- discovered → invited → onboarding → active → (paused | rejected)
      -- Only 'active' may receive an order.
      status             TEXT NOT NULL DEFAULT 'discovered',
      status_note        TEXT,

      -- The two sides of the business, as the CEO framed them: research molecules and GMP
      -- molecules. They are different regulatory worlds, and a lab may serve one and not the
      -- other, so this is two booleans rather than one tier.
      research_capable   BOOLEAN NOT NULL DEFAULT FALSE,
      gmp_capable        BOOLEAN NOT NULL DEFAULT FALSE,

      -- [{ body: 'A2LA', certificate: '1234.01', scope_url: '...', expires_on: '2027-03-01' }]
      -- JSONB because accreditation shape differs by body and country, and because the scope
      -- document is the thing that actually decides whether a lab may run a given test.
      accreditations     JSONB NOT NULL DEFAULT '[]'::jsonb,

      notes              TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- One row per firm per site. The FDA register is already deduped by site_key, but a
    -- self-onboarding lab can arrive for a site already discovered, so the constraint is on the
    -- normalized name plus the address rather than on the FDA id, which a self-onboard lacks.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_labs_identity
      ON labs (name_normalized, COALESCE(address, ''));

    -- The directory's default view: active labs in a region.
    CREATE INDEX IF NOT EXISTS idx_labs_region_status ON labs (region, status);
    CREATE INDEX IF NOT EXISTS idx_labs_country ON labs (country);
    CREATE INDEX IF NOT EXISTS idx_labs_name_norm ON labs (name_normalized);
  `);

  // ── the canonical test list ─────────────────────────────────────────────────
  // WHY A CATALOGUE AND NOT FREE TEXT. Labs set their own prices, which was the CEO's decision —
  // so the directory has to be able to say "these four labs run this test, at these prices". That
  // comparison is only possible if both labs are describing the SAME test. Free text gives
  // "Dissolution", "dissolution testing (USP <711>)" and "Diss." as three different tests.
  await query(`
    CREATE TABLE IF NOT EXISTS test_catalogue (
      code            TEXT PRIMARY KEY,         -- 'assay_hplc', 'dissolution', 'sterility'
      name            TEXT NOT NULL,
      category        TEXT NOT NULL,            -- 'identity' | 'assay' | 'impurities' | 'micro' | 'physical' | 'stability'
      typical_method  TEXT,                     -- 'USP <711>', 'HPLC-UV', 'ICP-MS'
      -- Does running this for a GMP release require the lab to be GMP-registered? Drives which
      -- labs may even be offered the order, and is a property of the TEST, not of the lab.
      gmp_relevant    BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order      INTEGER NOT NULL DEFAULT 100,
      active          BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS lab_tests (
      id              BIGSERIAL PRIMARY KEY,
      lab_id          BIGINT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
      test_code       TEXT NOT NULL REFERENCES test_catalogue(code),

      -- THE LAB'S OWN PRICE. Nullable on purpose: a lab that will run a test but has not given a
      -- price is still routable (the order gets quoted), and a NULL here must never render as $0
      -- the way an unpriced SiteNex package must not.
      price_cents     INTEGER,
      currency        TEXT NOT NULL DEFAULT 'USD',
      turnaround_days INTEGER,

      -- Accredited FOR THIS TEST, which is narrower than the lab holding an accreditation at all.
      -- A lab can be ISO 17025 accredited and have this particular method outside its scope.
      accredited      BOOLEAN NOT NULL DEFAULT FALSE,
      gmp             BOOLEAN NOT NULL DEFAULT FALSE,
      notes           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      -- One price per lab per test. NOT a partial unique index on an "exclusive" flag, which is
      -- what the SiteNex territory table has — many labs per test is the point here.
      -- (Double quotes, not backticks: this is inside a JS template literal and a backtick here
      --  closes the string, which is exactly how the first version of this file failed to parse.)
      UNIQUE (lab_id, test_code)
    );

    CREATE INDEX IF NOT EXISTS idx_lab_tests_code ON lab_tests (test_code);
    CREATE INDEX IF NOT EXISTS idx_lab_tests_lab ON lab_tests (lab_id);
  `);

  // A starting catalogue. Deliberately small and ordinary — the tests a QC order actually asks
  // for — because a catalogue of 200 invented codes is worse than one of 14 real ones that a lab
  // can be asked to price. ON CONFLICT DO NOTHING so a re-run never overwrites an edited row.
  const SEED = [
    ['identification',   'Identification (ID)',              'identity',   'FTIR / HPLC retention', true,  10],
    ['assay_hplc',       'Assay by HPLC',                    'assay',      'HPLC-UV',               true,  20],
    ['related_subs',     'Related substances / impurities',  'impurities', 'HPLC-UV',               true,  30],
    ['residual_solvents','Residual solvents',                'impurities', 'GC headspace',          true,  40],
    ['elemental_imp',    'Elemental impurities',             'impurities', 'ICP-MS, ICH Q3D',       true,  50],
    ['water_content',    'Water content',                    'physical',   'Karl Fischer',          true,  60],
    ['dissolution',      'Dissolution',                      'physical',   'USP <711>',             true,  70],
    ['uniformity',       'Uniformity of dosage units',       'physical',   'USP <905>',             true,  80],
    ['particle_size',    'Particle size distribution',       'physical',   'Laser diffraction',     false, 90],
    ['micro_limits',     'Microbial limits',                 'micro',      'USP <61> / <62>',       true, 100],
    ['sterility',        'Sterility',                        'micro',      'USP <71>',              true, 110],
    ['endotoxin',        'Bacterial endotoxins',             'micro',      'USP <85> LAL',          true, 120],
    ['potency_797',      'Potency (compounded preparation)', 'assay',      'USP <797>',             true, 130],
    ['stability_icha',   'Stability study (ICH)',            'stability',  'ICH Q1A(R2)',           true, 140],
    ['characterisation', 'Molecule characterisation (R&D)',  'identity',   'NMR / MS / HPLC',       false, 150],
  ];
  let seeded = 0;
  for (const [code, name, category, method, gmp, sort] of SEED) {
    const r = await query(
      `INSERT INTO test_catalogue (code, name, category, typical_method, gmp_relevant, sort_order)
            VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING`,
      [code, name, category, method, gmp, sort]);
    seeded += r.rowCount || 0;
  }

  const counts = (await query(
    `SELECT (SELECT COUNT(*)::int FROM labs) labs,
            (SELECT COUNT(*)::int FROM test_catalogue) tests,
            (SELECT COUNT(*)::int FROM lab_tests) lab_tests`)).rows[0];

  console.log('LabConnect schema ready.');
  console.log(`  labs            ${counts.labs}`);
  console.log(`  test_catalogue  ${counts.tests}  (${seeded} inserted this run)`);
  console.log(`  lab_tests       ${counts.lab_tests}`);
  console.log('\nNext: scripts/seed-labs-from-fda.js to populate labs from the FDA register.');
}

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch((e) => {
    console.error('migration failed:', e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = { migrate };
