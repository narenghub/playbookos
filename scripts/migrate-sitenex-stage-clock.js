// ── status_changed_at: how long a deal has been in its CURRENT stage ───────────
//
// The board wants "days in current stage" and there was no column that could answer it. `updated_at` is
// maintained by trg_sitenex_deals_updated_at on EVERY update, so it answers a different question — "days
// since anyone last touched this" — and a deal whose address was corrected yesterday would have read as
// having just entered its stage. Rendering one as the other is the kind of number that looks like data.
//
// BACKFILL, precisely:
//   • rows where updated_at = created_at have never been updated, so their status is the one they were
//     created with and it has held since created_at. That is a FACT and is backfilled.
//   • any other row cannot be answered. Its status may have changed at any point between the two
//     timestamps, and picking either end is a guess. Those stay NULL and the board says "stage age not
//     recorded" rather than inventing a figure.
//
// From here on the write path maintains it: set on insert by the DEFAULT, and moved by PUT only when the
// status value actually changes — not on every update, which would recreate the problem this fixes.
//
// IDEMPOTENT. Safe to re-run.
//
// Manual rollback:  ALTER TABLE sitenex_deals DROP COLUMN IF EXISTS status_changed_at;
//
// Run:  railway ssh 'node scripts/migrate-sitenex-stage-clock.js'

const { query } = require('../src/lib/db');

(async () => {
  try {
    const existed = (await query(
      `SELECT COUNT(*)::int n FROM information_schema.columns
        WHERE table_name='sitenex_deals' AND column_name='status_changed_at'`)).rows[0].n > 0;

    await query(`ALTER TABLE sitenex_deals ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ DEFAULT NOW()`);
    await query(`COMMENT ON COLUMN sitenex_deals.status_changed_at IS $c$When the status last CHANGED — not when the row was last touched. updated_at is moved by a trigger on every update, so it cannot answer "how long has this been in this stage". Maintained by the write path: set by DEFAULT on insert, moved by PUT only when the status value actually differs. NULL means not recorded, which is the honest answer for a row that predates this column and had already been updated at least once; the board says so rather than showing a number.$c$`);
    console.log(existed ? '↷  sitenex_deals.status_changed_at already existed' : '✅ sitenex_deals.status_changed_at');

    // The backfill, only where it is a fact. `status_changed_at IS NULL` guards re-runs; a row ADDED with
    // the DEFAULT already has a value, so this only ever touches rows that predate the column.
    const back = await query(
      `UPDATE sitenex_deals SET status_changed_at = created_at
        WHERE status_changed_at IS NULL AND updated_at = created_at`);
    const unknowable = (await query(
      `SELECT COUNT(*)::int n FROM sitenex_deals WHERE status_changed_at IS NULL`)).rows[0].n;
    console.log(`✅ backfilled ${back.rowCount} never-updated row(s) from created_at`);
    console.log(`${unknowable ? '⚠️ ' : '✅'} ${unknowable} row(s) left NULL — their status may have changed at any `
      + `point between created_at and updated_at, so any value would be a guess`);

    console.log('\nverification:');
    const col = (await query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name='sitenex_deals' AND column_name='status_changed_at'`)).rows[0];
    console.log(`  ${col.data_type}, nullable=${col.is_nullable}, default=${col.column_default}`);
    if (!/timestamp with time zone/.test(col.data_type)) throw new Error('wrong type');
    if (col.is_nullable !== 'YES') throw new Error('must be NULLABLE — "not recorded" has to be expressible');
    if (!/now\(\)/i.test(col.column_default || '')) throw new Error('must DEFAULT NOW() so new rows start their clock');

    const rows = (await query(
      `SELECT id, status, status_changed_at IS NULL AS unknown,
              EXTRACT(DAY FROM NOW() - status_changed_at)::int AS days
         FROM sitenex_deals ORDER BY id`)).rows;
    console.log(`  ${rows.length} deal(s):`);
    for (const r of rows) {
      console.log(`    #${r.id} ${r.status} — ${r.unknown ? 'stage age NOT RECORDED' : r.days + ' day(s) in stage'}`);
    }

    console.log('\n✅ DONE');
    process.exit(0);
  } catch (e) { console.error('❌', e.message); process.exit(1); }
})();
