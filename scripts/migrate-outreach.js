// ── ONE outreach status system for every list ──────────────────────────────────
//
// Six separate status columns would have drifted within a month, so there is one table keyed on
// (entity_type, entity_id). entity_id is TEXT so it works for a BIGSERIAL prospect and a TEXT lead
// without a second design.
//
// NO CHECK CONSTRAINT on status. inquiries.status shipped with one and it was dropped once the lifecycle
// outgrew the original six values; this will grow the same way. The vocabulary is a COMMENT and an array
// in src/lib/outreach/registry.js, validated by the API so a typo is still rejected at the edge.
//
// 'new' NEEDS NO ROW — the absence of a row IS 'new'. That keeps 1,524 untouched prospects out of the
// table entirely, and it is why every count has to add the implicit remainder.
//
// THE EVENTS TABLE IS THE POINT. Current status tells you 50 rows say 'contacted'. It cannot tell you
// Vinitha contacted 50 companies last week. The log gives who, when, and what changed.
//
// Run:  railway ssh 'node scripts/migrate-outreach.js'

const { query } = require('../src/lib/db');
const { STATUSES } = require('../src/lib/outreach/registry');

(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS outreach (
        id                SERIAL PRIMARY KEY,
        entity_type       TEXT NOT NULL,
        entity_id         TEXT NOT NULL,
        product           TEXT NOT NULL,
        status            TEXT NOT NULL,
        owner_user_id     TEXT REFERENCES users(id),
        last_contacted_at TIMESTAMPTZ,
        next_action_at    TIMESTAMPTZ,
        note              TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (entity_type, entity_id)
      );
    `);
    // product is indexed on its own because every read is scoped by it (products/held.js), and
    // (entity_type, status) because that is exactly the summary bar's query.
    await query(`CREATE INDEX IF NOT EXISTS idx_outreach_product   ON outreach (product)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_outreach_type_stat ON outreach (entity_type, status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_outreach_owner     ON outreach (owner_user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_outreach_next      ON outreach (next_action_at) WHERE next_action_at IS NOT NULL`);
    console.log('✅ outreach');

    await query(`
      CREATE TABLE IF NOT EXISTS outreach_events (
        id          SERIAL PRIMARY KEY,
        outreach_id INTEGER NOT NULL REFERENCES outreach(id) ON DELETE CASCADE,
        from_status TEXT,
        to_status   TEXT NOT NULL,
        by_user_id  TEXT,
        by_email    TEXT,
        note        TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // by_user_id has NO foreign key, and by_email is denormalised, for the same reason as
    // user_product_grants_log: "who contacted these 50 companies" must still be answerable after the
    // person leaves and their users row is deleted.
    await query(`CREATE INDEX IF NOT EXISTS idx_outreach_ev_created ON outreach_events (created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_outreach_ev_user    ON outreach_events (by_user_id, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_outreach_ev_o       ON outreach_events (outreach_id, created_at DESC)`);
    console.log('✅ outreach_events');

    // The vocabulary as a COMMENT, deliberately not a constraint.
    await query(`COMMENT ON COLUMN outreach.status IS $c$${STATUSES.join(' | ')}
new = no contact yet (the default; NO ROW is needed for it)
contacted = reached out, no reply yet
no_response = reached out repeatedly, nothing back
in_progress = a conversation is happening
interested = positive signal, not closed
not_interested = declined
won = signed / now a customer
disqualified = wrong fit, chain, out of business
Deliberately NOT a CHECK constraint: inquiries.status shipped with one and it was dropped when the
lifecycle grew. Validated in src/lib/outreach/registry.js instead.$c$`);
    await query(`COMMENT ON TABLE outreach IS 'One status row per (entity_type, entity_id) across every list. Absence of a row means status new.'`);
    await query(`COMMENT ON TABLE outreach_events IS 'Append-only log of every status change: who, when, from what to what. Answers "how many did X contact last week", which current status cannot.'`);
    console.log('✅ comments (the vocabulary lives here, not in a CHECK)');

    // ── verify ──
    const cols = (await query(`SELECT column_name FROM information_schema.columns WHERE table_name='outreach' ORDER BY ordinal_position`)).rows.map(r => r.column_name);
    console.log(`\noutreach columns: ${cols.join(', ')}`);
    const ev = (await query(`SELECT column_name FROM information_schema.columns WHERE table_name='outreach_events' ORDER BY ordinal_position`)).rows.map(r => r.column_name);
    console.log(`outreach_events:  ${ev.join(', ')}`);
    const uniq = (await query(`SELECT indexdef FROM pg_indexes WHERE tablename='outreach' AND indexdef LIKE '%UNIQUE%'`)).rows;
    console.log(`unique constraint: ${uniq.length ? uniq[0].indexdef.replace(/.*USING btree /, '') : 'MISSING'}`);
    const chk = (await query(`SELECT COUNT(*)::int n FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      WHERE t.relname='outreach' AND c.contype='c'`)).rows[0].n;
    console.log(`CHECK constraints on outreach: ${chk} (must be 0 — the vocabulary is a comment)`);
    if (chk !== 0) { console.error('❌ a CHECK constraint exists; that is the thing this deliberately avoids'); process.exit(1); }
    console.log(`rows: outreach ${(await query(`SELECT COUNT(*)::int n FROM outreach`)).rows[0].n}, events ${(await query(`SELECT COUNT(*)::int n FROM outreach_events`)).rows[0].n}`);
    console.log('\n✅ DONE');
    process.exit(0);
  } catch (e) { console.error('❌', e.message); process.exit(1); }
})();
