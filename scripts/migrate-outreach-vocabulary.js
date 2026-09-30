// ── Expand the status vocabulary, and split CHANNEL out of it ──────────────────
//
// Two fields, not one. STATUS is where the conversation is (10 values, in funnel order). CHANNEL is how we
// last touched them (email / phone / linkedin / in_person / other). Folding them together would have given
// emailed_no_reply vs called_no_reply and doubled the list for no gain.
//
// Still NO CHECK CONSTRAINT. The vocabulary is a COMMENT plus the validated array in
// src/lib/outreach/registry.js. This is the second time the list has grown, which is the argument.
//
// 'interested' IS NOT MAPPED. It was never a stage — it was a feeling, and it shared its next action with
// in_conversation. If any row still carries it, this migration ABORTS and asks, because a guess that looks
// like data is worse than a migration that stops.
//
// Run:  railway ssh 'node scripts/migrate-outreach-vocabulary.js'

const { query } = require('../src/lib/db');
const { STATUS_DEFS, CHANNELS, LEGACY_STATUS_MAP, DEFAULT_STATUS } = require('../src/lib/outreach/registry');

(async () => {
  try {
    // 1. REFUSE FIRST, on anything needing a human decision — before ANY statement, DDL included. This used
    //    to run after the ALTER TABLEs, which made its own "nothing has been changed" message untrue: two
    //    columns and two indexes were already there. A refusal that has half-run is not a refusal.
    //    Checked on the EVENT LOG as well as the current status: an entity can have moved on from
    //    'interested' while its history still carries the word, and rewriting only current rows would leave
    //    a value in the log that is in no vocabulary.
    const ambiguous = (await query(
      `SELECT 'outreach.status' AS col, COUNT(*)::int n FROM outreach WHERE status = 'interested'
       UNION ALL SELECT 'outreach_events.to_status', COUNT(*)::int FROM outreach_events WHERE to_status = 'interested'
       UNION ALL SELECT 'outreach_events.from_status', COUNT(*)::int FROM outreach_events WHERE from_status = 'interested'`
    )).rows.filter(r => r.n > 0);
    if (ambiguous.length) {
      console.error(`\n⛔ 'interested' is still present:`);
      for (const r of ambiguous) console.error(`     ${r.n} row(s) in ${r.col}`);
      console.error(`   It was never a stage and it has no automatic mapping: in_conversation and quote_sent`);
      console.error(`   are both plausible and they imply different next actions. Decide per row, then re-run.`);
      console.error(`   NOTHING has been changed — this check runs before any statement, DDL included.\n`);
      process.exit(1);
    }
    console.log("✅ no 'interested' rows — safe to proceed");

    // 2. CHANNEL, on both tables. On `outreach` it is the LAST touch; on `outreach_events` it is what THAT
    //    touch was — the same relationship status has to from_status/to_status.
    await query(`ALTER TABLE outreach ADD COLUMN IF NOT EXISTS channel TEXT`);
    await query(`ALTER TABLE outreach_events ADD COLUMN IF NOT EXISTS channel TEXT`);
    await query(`CREATE INDEX IF NOT EXISTS idx_outreach_channel ON outreach (channel) WHERE channel IS NOT NULL`);
    await query(`CREATE INDEX IF NOT EXISTS idx_outreach_ev_channel ON outreach_events (channel) WHERE channel IS NOT NULL`);
    console.log('✅ channel on outreach and outreach_events');

    // 3. The mappings that ARE unambiguous.
    let moved = 0;
    for (const [from, to] of Object.entries(LEGACY_STATUS_MAP)) {
      const a = await query(`UPDATE outreach SET status=$2 WHERE status=$1`, [from, to]);
      const b = await query(`UPDATE outreach_events SET to_status=$2 WHERE to_status=$1`, [from, to]);
      const c = await query(`UPDATE outreach_events SET from_status=$2 WHERE from_status=$1`, [from, to]);
      const n = (a.rowCount || 0) + (b.rowCount || 0) + (c.rowCount || 0);
      moved += n;
      console.log(`${n ? '✅' : '↷ '} ${from} → ${to}: ${a.rowCount} status, ${b.rowCount} to_status, ${c.rowCount} from_status`);
    }
    console.log(`   ${moved} value(s) rewritten in total`);

    // 4. The vocabulary, as a comment. Includes sort_order, so the funnel is documented where the data is.
    const lines = STATUS_DEFS.map(s => `${String(s.order).padStart(2)}  ${s.key.padEnd(16)}${s.means}`).join('\n');
    await query(`COMMENT ON COLUMN outreach.status IS $c$Where the conversation is. Funnel order:
${lines}

The default is '${DEFAULT_STATUS}' and it NEEDS NO ROW — the absence of an outreach row IS the default.
Deliberately NOT a CHECK constraint: inquiries.status shipped with one and it had to be dropped when the
lifecycle grew, and this list has now grown twice. Validated in src/lib/outreach/registry.js.
'interested' was removed: it was never a stage, it was a feeling sharing a next action with in_conversation.$c$`);
    await query(`COMMENT ON COLUMN outreach.channel IS $c$How we LAST touched them: ${CHANNELS.join(' | ')}.
A separate field from status ON PURPOSE — email and phone are methods at the same stage, not stages, so
folding them in would double the status list for no gain. NULLABLE: a status change is not always a touch
(disqualifying a chain from the desk), and an unrecorded channel must not be guessed.$c$`);
    await query(`COMMENT ON COLUMN outreach_events.channel IS $c$The channel of THIS touch, the way to_status
is the status of THIS touch. Lets "who is calling and who is emailing" be answered per person, which the
current channel on outreach cannot: that one only remembers the most recent.$c$`);
    console.log('✅ comments (vocabulary + sort_order + why channel is separate)');

    // 5. VERIFY.
    console.log('\nverification:');
    const bad = (await query(
      `SELECT status, COUNT(*)::int n FROM outreach WHERE status <> ALL($1) GROUP BY 1`,
      [STATUS_DEFS.map(s => s.key)])).rows;
    console.log(`  rows outside the vocabulary: ${bad.length ? bad.map(b => b.status + '=' + b.n).join(' ') : '0'}`);
    const chk = (await query(`SELECT COUNT(*)::int n FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      WHERE t.relname='outreach' AND c.contype='c'`)).rows[0].n;
    console.log(`  CHECK constraints on outreach: ${chk} (must be 0)`);
    const cols = (await query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE column_name='channel' AND table_name IN ('outreach','outreach_events') ORDER BY 1`)).rows;
    console.log(`  channel columns: ${cols.map(c => c.table_name).join(', ')}`);
    const rows = (await query(`SELECT COUNT(*)::int n FROM outreach`)).rows[0].n;
    const evs = (await query(`SELECT COUNT(*)::int n FROM outreach_events`)).rows[0].n;
    console.log(`  outreach ${rows} rows, outreach_events ${evs} rows`);
    if (bad.length || chk !== 0 || cols.length !== 2) { console.error('\n❌ verification failed'); process.exit(1); }
    console.log('\n✅ DONE');
    process.exit(0);
  } catch (e) { console.error('❌', e.message); process.exit(1); }
})();
