// ── (2) a partner's own book · (3) country · (5) region on the contract register ──
//
// Three additive columns, each with a different relationship to "what do we do about existing rows", which is
// the part worth reading.
//
// ── 2. prospects.source_partner_id — A PARTNER'S OWN BOOK ─────────────────────
//
// A prospect a partner brought us is THEIRS: visible to them and to staff, and never to another partner
// REGARDLESS OF TERRITORY. That last clause is the whole point. Territory answers "which of OUR leads may you
// work"; it has no business answering "may you see the business your competitor introduced", and a shared or
// overlapping territory would otherwise do exactly that.
//
// NULL means OURS — a prospect we scraped and scored — and those stay territory-scoped as before. Nullable with
// no default: every existing row came from our own Places enumeration, so NULL is a fact about all 1,524 of
// them and nothing is invented.
//
// ── 3. prospects.country, DEFAULT 'US' ───────────────────────────────────────
//
// THIS default DOES backfill every existing row, and here that is correct rather than a guess — the opposite of
// the status_changed_at case, which taught the lesson. But the FIRST version of this check was wrong about WHY,
// and the check caught it: it tested `prospects.state`, on the assumption that every row has one. 1,525 do not
// — `state` was added for SiteNex and the GolfNex/Favly/Linkabl rows predate it — so the migration refused to
// run, which is the correct behaviour for a claim it could not verify.
//
// The evidence that DOES exist is the address: every one of the 4,663 rows carries either a ", XX" US state
// suffix on its region or a ", XX 00000" US ZIP in its address. That is what is checked now. So 'US' is a
// measurement after all, just not the measurement I first reached for.
//
// ── 5. sitenex_contracts.region — ATTRIBUTION ON THE REGISTER ────────────────
//
// So the register reads "ACBM Partners · Rockford, IL" rather than just the partner. SNAPSHOT, like every other
// client detail on that table: a prospect's region can be re-enumerated, and a contract must keep saying what
// it said. Existing contracts stay NULL — the region at the time they were generated is not recoverable, and
// inventing today's would be a guess about history. The register renders a partner with no region as just the
// partner.
//
// IDEMPOTENT. Safe to re-run.
//
// Manual rollback:
//   ALTER TABLE prospects DROP COLUMN IF EXISTS source_partner_id, DROP COLUMN IF EXISTS country;
//   ALTER TABLE sitenex_contracts DROP COLUMN IF EXISTS region;
//
// Run:  railway ssh 'node scripts/migrate-partner-book-country-region.js'

const { query } = require('../src/lib/db');

// A US ADDRESS, as Places writes one. Used only to VERIFY the country backfill, never to derive a value — a row
// matching neither pattern is a row we cannot claim is American, and the migration stops rather than guess.
//
//   region  'Rockford, IL'                       → ', XX' at the end
//   address '412 W Main St, Rockford, IL 61101'   → ', XX 00000'
//
// Deliberately NOT `prospects.state`: that column exists for SiteNex and is NULL on the 1,525 rows that
// predate it, so a check against it refuses a claim that is in fact true. The address is the thing every row
// has, which is why it is the thing to check.
const US_REGION = String.raw`, [A-Z]{2}$`;
const US_ZIP = String.raw`, [A-Z]{2} [0-9]{5}`;

(async () => {
  try {
    // ── 2 ─────────────────────────────────────────────────────────────────────
    await query(`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS source_partner_id INTEGER REFERENCES partners(id)`);
    await query(`COMMENT ON COLUMN prospects.source_partner_id IS $c$The partner who brought us this business. NULL = OURS (scraped and scored). A partner's own book is visible to THEM and to STAFF, and never to another partner REGARDLESS OF TERRITORY — territory answers "which of our leads may you work", not "may you see the business your competitor introduced", and a shared territory would otherwise leak exactly that.$c$`);
    await query(`CREATE INDEX IF NOT EXISTS idx_prospects_source_partner ON prospects (source_partner_id) WHERE source_partner_id IS NOT NULL`);
    console.log('✅ prospects.source_partner_id');

    // ── 3 ─────────────────────────────────────────────────────────────────────
    // CHECKED BEFORE BACKFILLED. ADD COLUMN ... DEFAULT fills every existing row, which is only acceptable
    // when the value is a fact about all of them — so the claim is tested first.
    const already = (await query(`SELECT COUNT(*)::int n FROM information_schema.columns
      WHERE table_name='prospects' AND column_name='country'`)).rows[0].n > 0;
    if (!already) {
      const odd = (await query(
        `SELECT id, name, product, region, LEFT(COALESCE(address,''), 70) AS address FROM prospects
          WHERE NOT (region ~ $1 OR address ~ $2) LIMIT 10`, [US_REGION, US_ZIP])).rows;
      const oddCount = (await query(
        `SELECT COUNT(*)::int n FROM prospects WHERE NOT (region ~ $1 OR address ~ $2)`,
        [US_REGION, US_ZIP])).rows[0].n;
      if (oddCount) {
        console.error(`\n⛔ ${oddCount} prospect(s) carry no US state or ZIP in their region or address:`);
        odd.forEach(r => console.error(`     #${r.id} ${r.product} ${r.name} — ${r.region} / ${r.address}`));
        console.error(`   DEFAULT 'US' would stamp a country onto rows it cannot vouch for. Give those rows a`);
        console.error(`   country first, or add the column with no default and backfill the ones you can.`);
        console.error(`   Nothing has been changed.\n`);
        process.exit(1);
      }
      const total = (await query(`SELECT COUNT(*)::int n FROM prospects`)).rows[0].n;
      console.log(`✅ all ${total} prospects carry a US state or ZIP, so DEFAULT 'US' is a measurement, not a guess`);
    }
    await query(`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'US'`);
    await query(`COMMENT ON COLUMN prospects.country IS $c$ISO 3166-1 alpha-2, DEFAULT 'US'. A territory dimension, so a partner can be granted a country. The default DOES backfill existing rows, which is correct here and was CHECKED before being relied on: every row carries a US state suffix on its region or a US ZIP in its address. Checked against the address rather than prospects.state, which is NULL on the 1,525 rows that predate it — a check against state refused a claim that was in fact true. Contrast status_changed_at, where the same ADD COLUMN DEFAULT quietly invented a measurement.$c$`);
    await query(`CREATE INDEX IF NOT EXISTS idx_prospects_country ON prospects (country)`);
    console.log(`✅ prospects.country`);

    // ── 5 ─────────────────────────────────────────────────────────────────────
    await query(`ALTER TABLE sitenex_contracts ADD COLUMN IF NOT EXISTS region TEXT`);
    await query(`COMMENT ON COLUMN sitenex_contracts.region IS $c$Where the client is, SNAPSHOT at generation so the register reads "ACBM Partners · Rockford, IL". Snapshot like every other client detail here: a prospect's region can be re-enumerated and a contract must keep saying what it said. NULL on contracts that predate this column — the region at the time is not recoverable, and today's would be a guess about history.$c$`);
    console.log('✅ sitenex_contracts.region');

    // ── verification ──────────────────────────────────────────────────────────
    console.log('\nverification:');
    const cols = (await query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE (table_name='prospects' AND column_name IN ('source_partner_id','country'))
           OR (table_name='sitenex_contracts' AND column_name='region')
        ORDER BY table_name, column_name`)).rows;
    for (const c of cols) {
      console.log(`  ${c.table_name}.${c.column_name}: ${c.data_type}, nullable=${c.is_nullable}, default=${c.column_default || 'none'}`);
    }
    if (cols.length !== 3) throw new Error(`expected 3 columns, found ${cols.length}`);
    const spid = cols.find(c => c.column_name === 'source_partner_id');
    if (spid.column_default) throw new Error('source_partner_id must have NO default — NULL means ours, and that is a fact per row');
    const ctry = cols.find(c => c.column_name === 'country');
    if (!/US/.test(ctry.column_default || '')) throw new Error("country must DEFAULT 'US'");

    const counts = (await query(
      `SELECT COUNT(*)::int total,
              COUNT(source_partner_id)::int partner_sourced,
              COUNT(*) FILTER (WHERE country = 'US')::int us,
              COUNT(*) FILTER (WHERE country IS NULL)::int no_country
         FROM prospects`)).rows[0];
    console.log(`  prospects: ${counts.total} total · ${counts.partner_sourced} partner-sourced · `
      + `${counts.us} US · ${counts.no_country} with no country`);
    if (counts.no_country) throw new Error('some prospects have no country, so the backfill did not take');

    console.log('\n✅ DONE');
    process.exit(0);
  } catch (e) { console.error('❌', e.message); process.exit(1); }
})();
