// ── Emailing a contract to the client: sent_at, and a send log ─────────────────
//
// Two additive things.
//
// 1. sitenex_contracts.sent_at — stamped in the SAME TRANSACTION as the status move to 'sent'. The
//    register's "sent" count must not depend on somebody remembering to change a dropdown after the
//    email has gone, because they will not, and then the register is quietly wrong about what has
//    actually reached a client.
//
// 2. sitenex_contract_sends — one row per SEND ATTEMPT, successful or not. The question this answers is
//    "what went where, when, and who did it", which is not answerable from sitenex_contracts: that holds
//    only the latest state, so a resend to a corrected address overwrites the fact that the first one
//    went somewhere else. An append-only log is the only shape that can prove it.
//
//    The recipient addresses are SNAPSHOT here too, for the same reason the contract snapshots the
//    client: if this joined to the contract, correcting a typo in client_email would silently rewrite
//    history into a claim that the first email went to the right place.
//
//    Failures are logged as well as successes. A send that Resend refused is a thing that happened, and
//    "we tried twice and both bounced" is exactly the kind of question this exists for.
//
// IDEMPOTENT. Safe to re-run.
//
// Manual rollback:
//   DROP TABLE IF EXISTS sitenex_contract_sends;
//   ALTER TABLE sitenex_contracts DROP COLUMN IF EXISTS sent_at;
//
// Run:  railway ssh 'node scripts/migrate-sitenex-contract-sends.js'

const { query } = require('../src/lib/db');

(async () => {
  try {
    await query(`ALTER TABLE sitenex_contracts ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ`);
    await query(`COMMENT ON COLUMN sitenex_contracts.sent_at IS $c$When the contract was emailed to the client. Set in the SAME transaction as status='sent', so the register cannot claim a contract is sent without a time, or hold a time for one that is not.$c$`);
    console.log('✅ sitenex_contracts.sent_at');

    await query(`
      CREATE TABLE IF NOT EXISTS sitenex_contract_sends (
        id           SERIAL PRIMARY KEY,
        contract_id  INTEGER NOT NULL REFERENCES sitenex_contracts(id) ON DELETE CASCADE,
        contract_no  TEXT,                      -- snapshot, so the log reads without a join
        to_email     TEXT NOT NULL,             -- SNAPSHOT: what we actually sent to, not what the row says now
        cc_email     TEXT,
        from_email   TEXT NOT NULL,
        subject      TEXT NOT NULL,
        file_name    TEXT,
        file_size    INTEGER,
        status       TEXT NOT NULL,             -- sent | failed
        provider_id  TEXT,                      -- Resend's message id, when there is one
        error        TEXT,                      -- why, when there is not
        sent_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
        sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_sitenex_sends_contract ON sitenex_contract_sends (contract_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sitenex_sends_at ON sitenex_contract_sends (sent_at DESC)`);
    await query(`COMMENT ON TABLE sitenex_contract_sends IS $c$APPEND-ONLY log of every attempt to email a contract, successful or not. Answers "what went where, when, and who sent it" — which sitenex_contracts cannot, because it holds only the latest state, so a resend to a corrected address would overwrite the fact that the first one went elsewhere. Addresses are SNAPSHOT for the same reason. Never updated, never deleted except with its contract.$c$`);
    await query(`COMMENT ON COLUMN sitenex_contract_sends.status IS $c$sent | failed. A refused send is a thing that happened and is logged too — "we tried twice and both bounced" is exactly what this exists to answer.$c$`);
    await query(`COMMENT ON COLUMN sitenex_contract_sends.sent_by IS $c$ON DELETE SET NULL: deleting a user must not delete the proof of what was sent.$c$`);
    console.log('✅ sitenex_contract_sends');

    console.log('\nverification:');
    const sa = (await query(`SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name='sitenex_contracts' AND column_name='sent_at'`)).rows[0];
    console.log(`  sitenex_contracts.sent_at: ${sa && sa.data_type}, nullable=${sa && sa.is_nullable}`);
    if (!sa || !/timestamp/.test(sa.data_type)) throw new Error('sent_at is missing or not a timestamp');
    if (sa.is_nullable !== 'YES') throw new Error('sent_at must be NULLABLE — most contracts have not been sent');

    const cols = (await query(`SELECT column_name FROM information_schema.columns
      WHERE table_name='sitenex_contract_sends' ORDER BY ordinal_position`)).rows.map(r => r.column_name);
    console.log(`  sitenex_contract_sends: ${cols.length} columns — ${cols.join(', ')}`);
    for (const need of ['contract_id', 'to_email', 'cc_email', 'subject', 'sent_at', 'sent_by', 'provider_id']) {
      if (!cols.includes(need)) throw new Error(`missing column: ${need}`);
    }
    const chk = (await query(`SELECT COUNT(*)::int n FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      WHERE t.relname='sitenex_contract_sends' AND c.contype='c'`)).rows[0].n;
    console.log(`  CHECK constraints: ${chk} (must be 0 — the vocabulary is a COMMENT)`);
    if (chk !== 0) throw new Error('a CHECK constraint was created');
    const rows = (await query(`SELECT COUNT(*)::int n FROM sitenex_contract_sends`)).rows[0].n;
    console.log(`  rows: ${rows}`);

    console.log('\n✅ DONE');
    process.exit(0);
  } catch (e) { console.error('❌', e.message); process.exit(1); }
})();
