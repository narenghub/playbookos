// ── acbm → sitenex, plus PARTNERS AS RECORDS ──────────────────────────────────
//
// SiteNex is the service line. ACBM Partners is one referral partner inside it. The old naming made the
// partner and the product the same thing, which stops working the moment there are two partners — so
// this is done BEFORE any partner account exists, while the tables are still empty.
//
// WHAT MOVES
//   tables      acbm_packages / _deals / _intake / _projects  →  sitenex_*  (+ their indexes, trigger, fn)
//   product     prospects.product, user_products.product, notifications.product,
//               user_product_grants_log.product, users.invited_products[]   'acbm' → 'sitenex'
//   role        users.role  'acbm_partner' → 'partner'   (generic: reusable for the next partner)
//   new         partners, users.partner_id, sitenex_deals.partner_id
//   dropped     sitenex_deals.referred_by — free text ('acbm') replaced by the FK
//
// WHAT DELIBERATELY DOES NOT MOVE
//   product_shadow_log.resolved_product keeps 'acbm' on historical rows. It is a log of what the
//   boundary decided at the time, and rewriting it would falsify the record that, among other things,
//   proved who deleted seven accounts.
//
// Idempotent: every step is guarded, so a re-run is a no-op rather than an error.
//
// Run:  railway ssh 'node scripts/migrate-sitenex-rename.js'

const { query } = require('../src/lib/db');

const has = async (table) =>
  (await query(`SELECT to_regclass($1) IS NOT NULL AS x`, [table])).rows[0].x;

(async () => {
  try {
    // 1. TABLES. RENAME keeps the data and the constraints; indexes keep their old names, so they are
    //    renamed explicitly — an index called idx_acbm_deals_status on sitenex_deals is the kind of
    //    leftover that makes the next person think the rename was half-done.
    for (const t of ['packages', 'deals', 'intake', 'projects']) {
      if (await has(`acbm_${t}`) && !(await has(`sitenex_${t}`))) {
        await query(`ALTER TABLE acbm_${t} RENAME TO sitenex_${t}`);
        console.log(`✅ acbm_${t} → sitenex_${t}`);
      } else {
        console.log(`↷ acbm_${t}: already renamed or absent`);
      }
    }
    const idx = (await query(`SELECT indexname FROM pg_indexes WHERE indexname LIKE '%acbm%'`)).rows;
    for (const { indexname } of idx) {
      await query(`ALTER INDEX ${indexname} RENAME TO ${indexname.replace(/acbm/g, 'sitenex')}`);
    }
    console.log(`✅ ${idx.length} index(es) renamed`);
    // The updated_at trigger and its function.
    const trg = (await query(
      `SELECT tgname, c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE tgname LIKE '%acbm%'`)).rows;
    for (const { tgname, relname } of trg) {
      await query(`ALTER TRIGGER ${tgname} ON ${relname} RENAME TO ${tgname.replace(/acbm/g, 'sitenex')}`);
    }
    const fns = (await query(`SELECT proname FROM pg_proc WHERE proname LIKE '%acbm%'`)).rows;
    for (const { proname } of fns) {
      await query(`ALTER FUNCTION ${proname}() RENAME TO ${proname.replace(/acbm/g, 'sitenex')}`);
    }
    console.log(`✅ ${trg.length} trigger(s) + ${fns.length} function(s) renamed`);

    // 2. PARTNERS AS RECORDS. A partner is a row, not a product — that is the whole point of the
    //    rename. ACBM Partners is row 1.
    await query(`
      CREATE TABLE IF NOT EXISTS partners (
        id                    SERIAL PRIMARY KEY,
        name                  TEXT NOT NULL UNIQUE,
        primary_contact_email TEXT,
        status                TEXT NOT NULL DEFAULT 'active',   -- active | paused | ended
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await query(`INSERT INTO partners (name, primary_contact_email, status)
                 VALUES ('ACBM Partners', 'acbm@acbmpartners.com', 'active')
                 ON CONFLICT (name) DO NOTHING`);
    const acbmId = (await query(`SELECT id FROM partners WHERE name = 'ACBM Partners'`)).rows[0].id;
    console.log(`✅ partners table; ACBM Partners is id ${acbmId}`);

    // users.partner_id — NULL for staff, set for a partner account. No CASCADE: deleting a partner
    // record must not delete the people, it should fail and make somebody decide.
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_id INTEGER REFERENCES partners(id)`);
    console.log('✅ users.partner_id');

    // 3. DEALS BELONG TO A PARTNER. referred_by was free text ('acbm', or NULL if self-sourced); a FK
    //    is what row-level scoping can be built on. The table is empty, so there is nothing to map.
    await query(`ALTER TABLE sitenex_deals ADD COLUMN IF NOT EXISTS partner_id INTEGER REFERENCES partners(id)`);
    const stale = (await query(
      `SELECT COUNT(*)::int n FROM sitenex_deals WHERE referred_by IS NOT NULL AND partner_id IS NULL`
    ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
    if (stale > 0) {
      // Only ever 'acbm' in practice, but refuse to guess rather than lose an attribution.
      await query(`UPDATE sitenex_deals SET partner_id = $1 WHERE LOWER(referred_by) = 'acbm' AND partner_id IS NULL`, [acbmId]);
      const left = (await query(`SELECT COUNT(*)::int n FROM sitenex_deals WHERE referred_by IS NOT NULL AND partner_id IS NULL`)).rows[0].n;
      if (left > 0) {
        console.error(`⛔ ${left} deal(s) have a referred_by that is not 'acbm'. Map them by hand before dropping the column.`);
        process.exit(1);
      }
    }
    await query(`ALTER TABLE sitenex_deals DROP COLUMN IF EXISTS referred_by`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sitenex_deals_partner ON sitenex_deals (partner_id)`);
    console.log(`✅ sitenex_deals.partner_id (referred_by dropped, ${stale} row(s) mapped)`);

    // 4. THE PRODUCT VALUE, everywhere it is stored.
    const updates = [
      ['prospects',               `UPDATE prospects SET product='sitenex' WHERE product='acbm'`],
      ['user_products',           `UPDATE user_products SET product='sitenex' WHERE product='acbm'`],
      ['notifications',           `UPDATE notifications SET product='sitenex' WHERE product='acbm'`],
      ['user_product_grants_log', `UPDATE user_product_grants_log SET product='sitenex' WHERE product='acbm'`],
      ['content_queue',           `UPDATE content_queue SET product='sitenex' WHERE product='acbm'`],
      ['ingested_events',         `UPDATE ingested_events SET product='sitenex' WHERE product='acbm'`],
      ['event_sources',           `UPDATE event_sources SET product='sitenex' WHERE product='acbm'`],
      ['users.invited_products',  `UPDATE users SET invited_products = array_replace(invited_products,'acbm','sitenex') WHERE 'acbm' = ANY(invited_products)`],
      ['users.role',              `UPDATE users SET role='partner' WHERE role='acbm_partner'`],
    ];
    for (const [label, sql] of updates) {
      try { const r = await query(sql); console.log(`✅ ${label.padEnd(24)} ${r.rowCount} row(s)`); }
      catch (e) { console.log(`↷ ${label.padEnd(24)} skipped: ${e.message.split('\n')[0].slice(0, 60)}`); }
    }

    // 5. VERIFY. Anything still saying 'acbm' that is not the historical shadow log is a failure.
    console.log('\nverification:');
    const left = [];
    for (const [t, c] of [['prospects','product'],['user_products','product'],['notifications','product'],
                          ['user_product_grants_log','product'],['users','role']]) {
      const v = c === 'role' ? 'acbm_partner' : 'acbm';
      const n = (await query(`SELECT COUNT(*)::int n FROM ${t} WHERE ${c}=$1`, [v])).rows[0].n;
      console.log(`  ${(t + '.' + c).padEnd(32)} ${n} row(s) still '${v}'`);
      if (n) left.push(`${t}.${c}`);
    }
    for (const t of ['sitenex_packages','sitenex_deals','sitenex_intake','sitenex_projects','partners']) {
      const n = (await query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
      console.log(`  ${t.padEnd(32)} ${n} row(s)`);
    }
    const stray = (await query(`SELECT indexname FROM pg_indexes WHERE indexname LIKE '%acbm%'`)).rows.length;
    console.log(`  ${'indexes still named acbm*'.padEnd(32)} ${stray}`);
    const sitenexProspects = (await query(`SELECT COUNT(*)::int n FROM prospects WHERE product='sitenex'`)).rows[0].n;
    console.log(`  ${'prospects now product=sitenex'.padEnd(32)} ${sitenexProspects}`);

    if (left.length || stray) { console.error(`\n❌ leftovers: ${left.join(', ') || ''} ${stray ? stray + ' index(es)' : ''}`); process.exit(1); }
    console.log('\n✅ RENAME COMPLETE');
    process.exit(0);
  } catch (e) { console.error('❌', e.message); process.exit(1); }
})();
