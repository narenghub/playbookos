// ── MULTI-PARTNER SITENEX: territories, and out-of-territory lead registration ──
//
// ONE PRODUCT, MANY PARTNERS. Packages, prices, the contract template and the revenue tiers are identical
// for every partner; only TERRITORY and achieved volume differ. Nothing here is per-partner commercial
// terms, and nothing here is a product key — a product per partner would mean a user_products row per
// partner, a route-map entry per partner, and a nav tab per partner, which is a migration every time
// somebody signs a new one.
//
// ── WHY (dimension, value) AND NOT COLUMNS ────────────────────────────────────
//
// One partner will be geographic ('Rockford'), another vertical ('machine_shop'), a third both, and a
// fourth statewide ('IL'). Columns would mean region TEXT, subtype TEXT, state TEXT with most of them NULL
// on every row, a three-way OR in every query, and an ALTER the first time somebody is scoped by something
// else. A generic pair takes all four shapes today and the fifth without a migration.
//
// ── THE PARTIAL UNIQUE INDEX IS THE POINT ─────────────────────────────────────
//
// UNIQUE (dimension, value) WHERE exclusive — so the DATABASE refuses to grant the same exclusive territory
// to two partners. Not left to the UI and not left to the handler: two partners both holding 'Rockford' is
// the same collision as two partners both seeing a deal, one layer up, where it is harder to see and shows
// up as an argument about commission rather than as an error. A non-exclusive row is still allowed to
// overlap, which is what makes a shared or trial territory expressible.
//
// ── OUT-OF-TERRITORY LEADS ────────────────────────────────────────────────────
//
// A partner may still register a business outside their territory; it lands pending_approval rather than
// auto-confirming, and staff approve or reject WITH A STATED REASON before any work is done. The reason is
// NOT NULL on a rejection for the obvious human cause: "rejected" with no reason is the start of an
// argument, and the partner is owed the sentence.
//
// IDEMPOTENT. Safe to re-run.
//
// Manual rollback:
//   DROP TABLE IF EXISTS sitenex_lead_registrations;
//   DROP TABLE IF EXISTS partner_territories;
//
// Run:  railway ssh 'node scripts/migrate-partner-territories.js'

const { query } = require('../src/lib/db');

const DIMENSIONS = ['region', 'subtype', 'state'];

(async () => {
  try {
    // ── 1. territories ────────────────────────────────────────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS partner_territories (
        id          SERIAL PRIMARY KEY,
        partner_id  INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
        dimension   TEXT NOT NULL,              -- region | subtype | state (COMMENT, not a CHECK)
        value       TEXT NOT NULL,              -- 'Rockford' | 'machine_shop' | 'IL'
        exclusive   BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE (partner_id, dimension, value)
      );
    `);
    // ON DELETE CASCADE on partner_id: a territory has no meaning without its partner. Contrast
    // users.partner_id, which is deliberately RESTRICT — deleting a partner must not delete the people.
    // created_by is SET NULL: deleting a user must not delete the grant or its history.
    await query(`CREATE INDEX IF NOT EXISTS idx_partner_territories_partner ON partner_territories (partner_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_partner_territories_lookup ON partner_territories (dimension, value)`);

    // THE EXCLUSIVITY CONSTRAINT. A partial unique index, so it binds only the exclusive rows.
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_territories_exclusive
                 ON partner_territories (dimension, value) WHERE exclusive`);

    await query(`COMMENT ON TABLE partner_territories IS $c$Which prospects a partner may see. ONE PRODUCT, MANY PARTNERS: packages, prices, the contract template and the revenue tiers are identical for everyone — only territory and achieved volume differ. A product per partner would mean a user_products row, a route-map entry and a nav tab per partner, i.e. a migration every time one signs.$c$`);
    await query(`COMMENT ON COLUMN partner_territories.dimension IS $c$region | subtype | state. A generic (dimension, value) pair rather than three columns because one partner is geographic, another vertical, a third both, and a fourth statewide — columns would be mostly NULL and would need an ALTER for the fifth shape. A COMMENT and not a CHECK, as everywhere else here.$c$`);
    await query(`COMMENT ON COLUMN partner_territories.exclusive IS $c$TRUE: nobody else may hold this (dimension, value) — enforced by the partial unique index uq_partner_territories_exclusive, in the DATABASE. Two partners both holding 'Rockford' is the same collision as two partners both seeing a deal, one layer up where it surfaces as an argument about commission rather than as an error. FALSE allows deliberate overlap, which is how a shared or trial territory is expressed.$c$`);
    console.log('✅ partner_territories + the exclusivity index');

    // ── 2. lead registration ──────────────────────────────────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS sitenex_lead_registrations (
        id              SERIAL PRIMARY KEY,
        partner_id      INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
        prospect_id     BIGINT REFERENCES prospects(id) ON DELETE SET NULL,
        -- The business, as the partner described it. Snapshot rather than joined for the same reason the
        -- contract register snapshots: the claim must show what was actually registered, and a prospect row
        -- can be edited or deleted afterwards.
        business_name   TEXT NOT NULL,
        address         TEXT,
        region          TEXT,
        state           TEXT,
        subtype         TEXT,
        status          TEXT NOT NULL,          -- confirmed | pending_approval | rejected (COMMENT)
        in_territory    BOOLEAN NOT NULL,       -- the verdict AT REGISTRATION TIME
        matched_on      TEXT,                   -- 'region=Rockford', for the audit
        decided_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
        decided_at      TIMESTAMPTZ,
        decision_reason TEXT,                   -- required on a rejection, in the handler
        registered_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_sitenex_leadreg_partner ON sitenex_lead_registrations (partner_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sitenex_leadreg_status ON sitenex_lead_registrations (status)`);
    // A CONFIRMED registration CLAIMS the prospect: nobody else may confirm the same one. Partial again, so
    // a rejected or pending claim does not block a later legitimate one.
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_sitenex_leadreg_claim
                 ON sitenex_lead_registrations (prospect_id)
                 WHERE prospect_id IS NOT NULL AND status = 'confirmed'`);
    await query(`COMMENT ON TABLE sitenex_lead_registrations IS $c$A partner claiming a business. In territory it confirms immediately; OUT of territory it lands pending_approval and staff approve or reject with a stated reason before any work is done — the backstop, expected to be rare. in_territory records the verdict AT REGISTRATION TIME, because territories change and the question "was this in their patch when they registered it" must stay answerable.$c$`);
    await query(`COMMENT ON COLUMN sitenex_lead_registrations.status IS $c$confirmed | pending_approval | rejected. Default is decided by the handler from the territory match, never supplied by the caller.$c$`);
    await query(`COMMENT ON COLUMN sitenex_lead_registrations.decision_reason IS $c$Why staff approved or rejected. REQUIRED on a rejection, enforced in the handler: "rejected" with no reason is the start of an argument, and the partner is owed the sentence.$c$`);
    console.log('✅ sitenex_lead_registrations');

    // ── verification ──────────────────────────────────────────────────────────
    console.log('\nverification:');
    for (const t of ['partner_territories', 'sitenex_lead_registrations']) {
      const n = (await query(`SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_name=$1`, [t])).rows[0].n;
      const rows = (await query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
      console.log(`  ${t}: ${n} columns, ${rows} rows`);
      if (!n) throw new Error(`${t} was not created`);
    }

    const idx = (await query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename IN ('partner_territories','sitenex_lead_registrations') ORDER BY indexname`)).rows;
    for (const i of idx) console.log(`  ${i.indexname}`);
    const excl = idx.find(i => i.indexname === 'uq_partner_territories_exclusive');
    if (!excl) throw new Error('the exclusivity index is missing');
    if (!/UNIQUE/i.test(excl.indexdef) || !/WHERE exclusive/i.test(excl.indexdef)) {
      throw new Error(`the exclusivity index is not a partial UNIQUE: ${excl.indexdef}`);
    }
    console.log(`  → ${excl.indexdef}`);

    // PROVE IT REFUSES. A constraint nobody has seen reject anything is a constraint nobody knows works —
    // and this one is the whole reason the table exists. Done inside a transaction that is rolled back, so
    // the probe writes nothing.
    const probe = await (async () => {
      const { withTransaction } = require('../src/lib/db');
      try {
        await withTransaction(async (c) => {
          const a = (await c.query(`INSERT INTO partners (name) VALUES ('__probe A__')
                                    ON CONFLICT (name) DO UPDATE SET status='active' RETURNING id`)).rows[0].id;
          const b = (await c.query(`INSERT INTO partners (name) VALUES ('__probe B__')
                                    ON CONFLICT (name) DO UPDATE SET status='active' RETURNING id`)).rows[0].id;
          await c.query(`INSERT INTO partner_territories (partner_id, dimension, value, exclusive)
                         VALUES ($1,'region','__ProbeTown__',TRUE)`, [a]);
          await c.query(`INSERT INTO partner_territories (partner_id, dimension, value, exclusive)
                         VALUES ($1,'region','__ProbeTown__',TRUE)`, [b]);
          throw new Error('NOT_REFUSED');
        });
        return 'NOT_REFUSED';
      } catch (e) { return e.message; }
    })();
    if (probe === 'NOT_REFUSED') throw new Error('two partners were both granted the same exclusive territory');
    console.log(`  exclusivity PROVED: a second partner claiming the same region was refused`);
    console.log(`    (${probe.split('\n')[0].slice(0, 90)})`);
    const leftover = (await query(
      `SELECT COUNT(*)::int n FROM partners WHERE name LIKE '__probe %__'`)).rows[0].n;
    console.log(`  probe rows left behind: ${leftover} (must be 0 — the probe runs in a rolled-back transaction)`);
    if (leftover) throw new Error('the probe leaked rows');

    const chk = (await query(`SELECT COUNT(*)::int n FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      WHERE t.relname IN ('partner_territories','sitenex_lead_registrations') AND c.contype='c'`)).rows[0].n;
    console.log(`  CHECK constraints: ${chk} (must be 0 — the vocabularies are COMMENTs)`);
    if (chk) throw new Error('a CHECK constraint was created');

    console.log(`\n  dimensions the code understands: ${DIMENSIONS.join(', ')}`);
    console.log('\n✅ DONE');
    process.exit(0);
  } catch (e) { console.error('❌', e.message); process.exit(1); }
})();
