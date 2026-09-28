// ── ACBM migration (additive, standalone, NOT wired into boot) ──
// Backs the ACBM referral pipeline: ACBM is a REFERRAL PARTNER, not a billed account.
// There is no per-account billing here — acbm_deals tracks the CLIENT deals ACBM refers,
// one row per deal, hanging off the prospects row the deal came from (product='acbm').
//
// Column types are matched to what the DB actually holds, NOT to the spec's shorthand:
//   • prospects.id is BIGSERIAL → bigint, so acbm_deals.prospect_id is BIGINT.
//   • users.id is declared `id TEXT PRIMARY KEY` (src/lib/db.js:39). The VALUES are UUID
//     strings, but the COLUMN is text, so owner_user_id / assigned_to are TEXT. A
//     `UUID REFERENCES users(id)` FK is rejected by Postgres — uuid and text are not
//     comparable types. Same choice as every existing FK to users
//     (scripts/migrate-permissions.js:55,59,68).
//
// PRICES ARE DELIBERATELY NULL. setup_fee_cents / monthly_cents are nullable and seeded
// NULL because pricing is not decided. Anything reading acbm_packages MUST refuse to
// render a package whose price is null rather than printing $0.
//
// Standalone on purpose: nothing imports it, so it does NOT run on boot. Run manually:
//   node scripts/migrate-acbm.js
//   railway ssh 'node scripts/migrate-acbm.js'
//
// Re-runnable: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, and the package
// seed is ON CONFLICT (code) DO NOTHING — a second run will NOT clobber prices or copy
// edited after the first run.
//
// Manual rollback (child tables first — FKs; the trigger dies with its table):
//   DROP TRIGGER IF EXISTS trg_acbm_deals_updated_at ON acbm_deals;
//   DROP FUNCTION IF EXISTS acbm_touch_updated_at();
//   DROP TABLE IF EXISTS acbm_projects;
//   DROP TABLE IF EXISTS acbm_intake;
//   DROP TABLE IF EXISTS acbm_deals;
//   DROP TABLE IF EXISTS acbm_packages;
//   ALTER TABLE prospects
//     DROP COLUMN IF EXISTS site_url,            DROP COLUMN IF EXISTS site_score,
//     DROP COLUMN IF EXISTS site_findings,       DROP COLUMN IF EXISTS recommended_package,
//     DROP COLUMN IF EXISTS owner_name,          DROP COLUMN IF EXISTS owner_email,
//     DROP COLUMN IF EXISTS owner_source;

const { initDB, query } = require('../src/lib/db');

async function migrateAcbm() {
  await initDB(); // ensures base schema (users, prospects deps) exists before we create alongside it

  // ── 1. prospects additions (product='acbm' rows use these; existing rows keep NULLs) ──
  // Deliberately plain TEXT/INT with no CHECK constraints, matching the existing prospects
  // columns (status, unreachable_reason and booking_platform carry their vocabularies as
  // comments too). Keeping it consistent also keeps this script re-runnable, since
  // ADD CONSTRAINT has no IF NOT EXISTS form.
  await query(`
    ALTER TABLE prospects ADD COLUMN IF NOT EXISTS site_url            TEXT;
    ALTER TABLE prospects ADD COLUMN IF NOT EXISTS site_score          INTEGER;
    ALTER TABLE prospects ADD COLUMN IF NOT EXISTS site_findings       JSONB;
    ALTER TABLE prospects ADD COLUMN IF NOT EXISTS recommended_package TEXT;
    ALTER TABLE prospects ADD COLUMN IF NOT EXISTS owner_name          TEXT;
    ALTER TABLE prospects ADD COLUMN IF NOT EXISTS owner_email         TEXT;
    ALTER TABLE prospects ADD COLUMN IF NOT EXISTS owner_source        TEXT;
  `);
  // site_score is 0-100 and HIGHER = WORSE (it scores how bad the current site is, so the
  // worst sites sort first). site_findings holds the structured detection detail behind it.
  // recommended_package is an acbm_packages.code ('P1'|'P2'|'P3'), left unconstrained so a
  // prospect can be scored before the package it points at is active.
  // owner_source: places | facebook | instagram | sos | manual
  await query(`
    COMMENT ON COLUMN prospects.site_score IS '0-100, HIGHER = WORSE (how bad the current site is)';
    COMMENT ON COLUMN prospects.site_findings IS 'structured detection detail behind site_score';
    COMMENT ON COLUMN prospects.recommended_package IS 'acbm_packages.code — P1 | P2 | P3';
    COMMENT ON COLUMN prospects.owner_source IS 'places | facebook | instagram | sos | manual';
  `);
  // ACBM's prime pool is ordered by site_score DESC (higher = worse = better prospect), NOT by
  // booking_platform polarity, so idx_prospects_prime — partial on `booking_platform IS NULL AND
  // reachable = true` — cannot serve it. This is its sibling: same partial-index trick, ACBM's
  // axis. Config names the axis via primeBy:'site_score' (prospecting/config.js).
  await query(`
    CREATE INDEX IF NOT EXISTS idx_prospects_site_score
      ON prospects (product, site_score DESC)
      WHERE status = 'qualified';
  `);

  // ── 2. acbm_packages — the offer catalogue ──
  // included / not_included are both NOT NULL: a package must state what it does NOT cover,
  // because that is what stops a client expecting content writing or a booking system.
  await query(`
    CREATE TABLE IF NOT EXISTS acbm_packages (
      id              SERIAL PRIMARY KEY,
      code            TEXT UNIQUE NOT NULL,          -- P1 | P2 | P3
      name            TEXT NOT NULL,
      summary         TEXT,
      included        JSONB NOT NULL,                -- array of strings
      not_included    JSONB NOT NULL,                -- array of strings; required, never omitted
      setup_fee_cents INTEGER,                       -- NULLABLE ON PURPOSE — not priced yet
      monthly_cents   INTEGER,                       -- NULLABLE ON PURPOSE — not priced yet
      typical_weeks   INTEGER,
      active          BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);

  // ── 3. acbm_deals — one row per client deal ACBM refers ──
  await query(`
    CREATE TABLE IF NOT EXISTS acbm_deals (
      id                   SERIAL PRIMARY KEY,
      prospect_id          BIGINT REFERENCES prospects(id),   -- prospects.id is BIGSERIAL
      package_code         TEXT REFERENCES acbm_packages(code),
      status               TEXT NOT NULL,                     -- vocabulary in COMMENT, not a CHECK (see below)
      owner_user_id        TEXT REFERENCES users(id),         -- users.id is TEXT, not uuid
      referred_by          TEXT,                              -- 'acbm', or NULL if self-sourced
      proposal_url         TEXT,
      contract_envelope_id TEXT,                               -- from the e-sign provider
      signed_at            TIMESTAMPTZ,
      value_cents          INTEGER,
      monthly_cents        INTEGER,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_acbm_deals_status   ON acbm_deals (status);
    CREATE INDEX IF NOT EXISTS idx_acbm_deals_prospect ON acbm_deals (prospect_id);
    CREATE INDEX IF NOT EXISTS idx_acbm_deals_owner    ON acbm_deals (owner_user_id);
  `);
  // No CHECK on status ON PURPOSE. inquiries.status shipped with one and it was dropped
  // (src/lib/db.js:846) once the lifecycle outgrew the original six values; a deal pipeline
  // will grow the same way (proposal_viewed, negotiating, on_hold are all plausible), and a
  // constraint dropped under deadline pressure is worse than one that was never there. The
  // vocabulary lives in a comment, exactly as prospects.status and unreachable_reason do.
  await query(`
    COMMENT ON COLUMN acbm_deals.status IS 'new | contacted | proposal_sent | signed | intake | building | live | lost (not CHECK-constrained — the pipeline is expected to grow)';
    COMMENT ON COLUMN acbm_deals.referred_by IS '''acbm'', or NULL if self-sourced';
    COMMENT ON COLUMN acbm_deals.contract_envelope_id IS 'envelope id from the e-sign provider';
    COMMENT ON COLUMN acbm_deals.updated_at IS 'maintained by trigger trg_acbm_deals_updated_at — never set it by hand';
  `);

  // updated_at trigger. A column named updated_at that silently means created_at is a trap,
  // and deal status changes are the thing someone will want to audit. A BEFORE UPDATE trigger
  // cannot be forgotten by a future writer; a convention can. This is the FIRST trigger in
  // this codebase — there were none before, so the function is namespaced to acbm to avoid
  // colliding with any later generic one. Idempotent: CREATE OR REPLACE + DROP IF EXISTS.
  await query(`
    CREATE OR REPLACE FUNCTION acbm_touch_updated_at() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_acbm_deals_updated_at ON acbm_deals;
    CREATE TRIGGER trg_acbm_deals_updated_at
      BEFORE UPDATE ON acbm_deals
      FOR EACH ROW EXECUTE FUNCTION acbm_touch_updated_at();
  `);

  // ── 4. acbm_intake — what the client still owes us before building can start ──
  // deal_id is UNIQUE: one intake per deal.
  await query(`
    CREATE TABLE IF NOT EXISTS acbm_intake (
      id            SERIAL PRIMARY KEY,
      deal_id       INTEGER UNIQUE REFERENCES acbm_deals(id),
      fields        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- what the client supplied
      required      JSONB NOT NULL,                      -- what this package needs
      completed_at  TIMESTAMPTZ,
      last_nudge_at TIMESTAMPTZ,
      nudge_count   INTEGER NOT NULL DEFAULT 0
    );
  `);

  // ── 5. acbm_projects — the build, once intake is done ──
  await query(`
    CREATE TABLE IF NOT EXISTS acbm_projects (
      id            SERIAL PRIMARY KEY,
      deal_id       INTEGER UNIQUE REFERENCES acbm_deals(id),
      status        TEXT NOT NULL,                       -- vocabulary in COMMENT, not a CHECK
      assigned_to   TEXT REFERENCES users(id),           -- users.id is TEXT, not uuid
      target_launch DATE,
      launched_at   TIMESTAMPTZ,
      notes         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_acbm_projects_status   ON acbm_projects (status);
    CREATE INDEX IF NOT EXISTS idx_acbm_projects_assigned ON acbm_projects (assigned_to);
  `);
  await query(`
    COMMENT ON COLUMN acbm_projects.status IS 'queued | in_progress | review | launched (not CHECK-constrained — same reasoning as acbm_deals.status)';
  `);

  // ── 6. Seed the packages ──
  // Prices stay NULL. ON CONFLICT DO NOTHING so re-running never overwrites prices or copy
  // that was edited after the first run.
  //
  // P2's `included` keeps the spec's own phrasing ("Everything in Launch (P1)") rather than
  // copying P1's six lines, so the two cannot drift apart. `not_included` IS expanded in
  // full for both, because a client-facing exclusions list has to stand on its own.
  const P1_NOT_INCLUDED = ['content writing', 'photography', 'logo design', 'paid ads management', 'e-commerce', 'booking system'];
  const packages = [
    {
      code: 'P1', name: 'Launch',
      summary: 'New site for a business with none.',
      included: ['5-8 pages', 'mobile-first build', 'domain + hosting setup', 'Google Business Profile claimed and connected', 'contact form', 'basic analytics'],
      not_included: P1_NOT_INCLUDED,
      typical_weeks: 4, active: true,
    },
    {
      code: 'P2', name: 'Renew',
      summary: 'Rebuild of an existing site.',
      included: ['Everything in Launch (P1)', 'content migration', '301 redirect map from old URLs', 'before/after performance report'],
      not_included: [...P1_NOT_INCLUDED, 'new content creation'],
      typical_weeks: 3, active: true,
    },
    {
      // Inactive: scoped but not sold yet (active=false, prices NULL). The exclusions are the
      // long pole on a 16-week platform build — store accounts, underwriting, content and
      // third-party running costs are all client-side, and saying so here is what stops the
      // "I thought the app included the App Store account" conversation.
      code: 'P3', name: 'Platform',
      summary: 'Web + mobile app, booking, catalogue, accounts, payments, admin dashboard.',
      included: ['web app', 'mobile app', 'booking', 'catalogue', 'customer accounts', 'payments', 'admin dashboard'],
      not_included: [
        'Apple Developer and Google Play account setup and annual fees',
        'App store submission, review responses and resubmissions',
        'Payment processor account setup and merchant underwriting',
        'Content: copy, photography, and product data entry',
        'Third-party service costs (maps, SMS, push notifications, email)',
        'Offline mode and background sync',
        'Data migration from an existing system',
        'Multi-language and localisation',
        'HIPAA, PCI-DSS or SOC 2 compliance work',
        'Integration with existing back-office, ERP or POS systems',
        'Ongoing hosting and infrastructure costs (passed through at cost)',
      ],
      typical_weeks: 16, active: false,
    },
  ];

  for (const p of packages) {
    await query(
      `INSERT INTO acbm_packages (code, name, summary, included, not_included, setup_fee_cents, monthly_cents, typical_weeks, active)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,NULL,NULL,$6,$7)
       ON CONFLICT (code) DO NOTHING`,
      [p.code, p.name, p.summary, JSON.stringify(p.included), JSON.stringify(p.not_included), p.typical_weeks, p.active]);
  }

  const seeded = (await query(
    `SELECT code, name, typical_weeks, active, setup_fee_cents, monthly_cents,
            jsonb_array_length(included) AS included_n, jsonb_array_length(not_included) AS not_included_n
       FROM acbm_packages ORDER BY code`)).rows;
  console.table(seeded);

  console.log('✅ ACBM schema applied — prospects +7 columns (site_url, site_score, site_findings, recommended_package, owner_name, owner_email, owner_source); tables acbm_packages, acbm_deals, acbm_intake, acbm_projects; 5 indexes; packages P1/P2 active + P3 inactive, all prices NULL by design.');
  process.exit(0);
}

migrateAcbm().catch(e => { console.error('ACBM migration error:', e.message); process.exit(1); });
