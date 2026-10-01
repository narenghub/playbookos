// ── SiteNex Phase 3: the deal WRITE path, a payment schedule, and a contract register ──
//
// Three things, all additive. Nothing is dropped, nothing is renamed, and every existing writer of
// sitenex_deals keeps working: every new column is NULLABLE or carries a DEFAULT, because
// src/lib/outreach/index.js inserts a deal on `won` with five columns and a NOT NULL addition here
// would turn that into a 500 at the moment somebody marks a prospect won.
//
// 1. sitenex_deals gains the CLIENT and the TERMS. Until now a deal was a status, a package and two
//    money columns — nothing that said who the client is, so a contract could not be generated from
//    it without somebody retyping the business's details.
//
// 2. sitenex_deal_payments is a CHILD TABLE, not columns. The number of installments is a commercial
//    decision per deal: 50/50 on one, three stages on another, monthly on a retainer. Columns would
//    mean payment_1_cents … payment_4_cents and a cap chosen by whoever wrote the migration.
//    The schedule must SUM TO value_cents — enforced in the handler, not here, because the rule spans
//    rows and a CHECK cannot see its siblings. A trigger could, and is deliberately not used: it
//    would fire mid-transaction while a schedule is being rewritten row by row.
//
// 3. sitenex_contracts SNAPSHOTS the client and partner details rather than joining to the deal. The
//    register has to show what each contract ACTUALLY SAID — if a client later corrects their address
//    and the register joins, every historical contract silently rewrites itself to an address that
//    was never in the signed document. Regeneration writes a NEW ROW and marks the old one
//    superseded; nothing is ever overwritten.
//
//    contract_no comes from a real SEQUENCE (SN-2026-0001). This is the first sequence in the repo:
//    a MAX(contract_no)+1 would hand two concurrent requests the same number, and there is no useful
//    recovery from two different documents numbered SN-2026-0007.
//
//    File bytes live in Postgres as BYTEA. Railway's filesystem does not survive a deploy, so a
//    contract written to public/ would be a dead download link the next time anything shipped. This
//    is also the first BYTEA column in the repo.
//
// IDEMPOTENT: every statement is IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, and the sequence is
// created only when to_regclass says it is absent. Safe to re-run.
//
// Manual rollback (nothing here is destructive, so this is only if the feature is abandoned):
//   DROP TABLE IF EXISTS sitenex_contracts; DROP TABLE IF EXISTS sitenex_deal_payments;
//   DROP SEQUENCE IF EXISTS sitenex_contract_no_seq;
//   ALTER TABLE sitenex_deals DROP COLUMN IF EXISTS company_name, DROP COLUMN IF EXISTS contact_name, ...
//
// Run:  railway ssh 'node scripts/migrate-sitenex-phase3.js'

const { query } = require('../src/lib/db');

// Added to sitenex_deals. Every one nullable: a deal is created early, from a phone call, and the
// client's details arrive later — requiring them at insert would mean no deal can be logged until
// somebody has the full address, which is exactly when a pipeline stops being used.
const DEAL_COLUMNS = [
  ['company_name',     'TEXT',    'the client business as it should appear on a contract — NOT a join to prospects.name, which is the Places listing and is often abbreviated'],
  ['contact_name',     'TEXT',    'the person signing'],
  ['contact_title',    'TEXT',    'their role, for the signature block'],
  ['contact_email',    'TEXT',    'where the contract goes'],
  ['contact_phone',    'TEXT',    null],
  ['client_address',   'TEXT',    'full postal address for the contract header; free text because a US address is not worth normalising for this volume'],
  ['duration_weeks',   'INTEGER', 'agreed duration, which may differ from the package typical_weeks — that is the catalogue default, this is what was sold'],
  ['starts_at_intake', 'BOOLEAN', 'TRUE: the clock starts when intake completes, not at signature. Default TRUE because that is the standing arrangement, and a contract that dates the start from signature while the client has not yet sent content is a dispute waiting to happen'],
  ['terms_note',       'TEXT',    'anything agreed verbally that has to appear in the document'],
];

(async () => {
  try {
    // ── 1. the client and the terms on the deal ───────────────────────────────
    for (const [col, type] of DEAL_COLUMNS) {
      const def = col === 'starts_at_intake' ? ' DEFAULT TRUE' : '';
      await query(`ALTER TABLE sitenex_deals ADD COLUMN IF NOT EXISTS ${col} ${type}${def}`);
    }
    for (const [col, , comment] of DEAL_COLUMNS) {
      if (comment) await query(`COMMENT ON COLUMN sitenex_deals.${col} IS $c$${comment}$c$`);
    }
    console.log(`✅ sitenex_deals: ${DEAL_COLUMNS.length} columns (all nullable — existing writers unaffected)`);

    // ── 2. the payment schedule ───────────────────────────────────────────────
    await query(`
      CREATE TABLE IF NOT EXISTS sitenex_deal_payments (
        id           SERIAL PRIMARY KEY,
        deal_id      INTEGER NOT NULL REFERENCES sitenex_deals(id) ON DELETE CASCADE,
        seq          INTEGER NOT NULL,           -- 1,2,3… the order they fall due
        label        TEXT NOT NULL,              -- 'Deposit', 'On first draft', 'On launch'
        amount_cents INTEGER NOT NULL,
        due_trigger  TEXT,                       -- vocabulary in the COMMENT, not a CHECK
        due_date     DATE,                       -- set when the trigger is a calendar date
        status       TEXT NOT NULL DEFAULT 'due',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (deal_id, seq)
      );
    `);
    // ON DELETE CASCADE, unlike outreach's owner_user_id which is SET NULL: a payment line has no
    // meaning without its deal, whereas an outreach row outlives the person who wrote it.
    await query(`CREATE INDEX IF NOT EXISTS idx_sitenex_payments_deal ON sitenex_deal_payments (deal_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sitenex_payments_status ON sitenex_deal_payments (status)`);
    // No CHECK on either vocabulary — the same decision as outreach.status and for the same reason:
    // inquiries.status shipped with one and it had to be dropped the first time the lifecycle grew.
    await query(`COMMENT ON COLUMN sitenex_deal_payments.due_trigger IS $c$When this installment falls due: on_signature | on_intake_complete | on_first_draft | on_launch | monthly | date (use due_date). A COMMENT and not a CHECK, deliberately — see outreach.status for the argument.$c$`);
    await query(`COMMENT ON COLUMN sitenex_deal_payments.status IS $c$due | invoiced | paid | waived. Default 'due'.$c$`);
    await query(`COMMENT ON TABLE sitenex_deal_payments IS $c$Installments for one deal. A CHILD TABLE because the installment count is a commercial decision per deal — 50/50 here, three stages there — which columns cannot express without a cap. The schedule MUST sum to sitenex_deals.value_cents; that is enforced in the handler, because the rule spans rows and a CHECK cannot see its siblings.$c$`);
    console.log('✅ sitenex_deal_payments');

    // ── 3. the contract register ──────────────────────────────────────────────
    // The sequence, not MAX()+1. Two concurrent requests would get the same number, and two documents
    // numbered SN-2026-0007 is not a recoverable state.
    const seqExists = (await query(`SELECT to_regclass('sitenex_contract_no_seq') IS NOT NULL AS ok`)).rows[0].ok;
    if (!seqExists) {
      await query(`CREATE SEQUENCE sitenex_contract_no_seq START WITH 1 INCREMENT BY 1`);
      console.log('✅ sequence sitenex_contract_no_seq created');
    } else {
      console.log('↷  sequence sitenex_contract_no_seq already exists');
    }

    await query(`
      CREATE TABLE IF NOT EXISTS sitenex_contracts (
        id                  SERIAL PRIMARY KEY,
        contract_no         TEXT NOT NULL UNIQUE,     -- SN-2026-0001, from the sequence
        deal_id             INTEGER NOT NULL REFERENCES sitenex_deals(id) ON DELETE RESTRICT,
        partner_id          INTEGER REFERENCES partners(id),
        -- ── SNAPSHOT. Deliberately duplicated from the deal, never joined. ──
        client_company      TEXT NOT NULL,
        client_contact      TEXT,
        client_title        TEXT,
        client_email        TEXT,
        client_phone        TEXT,
        client_address      TEXT,
        partner_name        TEXT,
        partner_email       TEXT,
        package_code        TEXT,
        package_name        TEXT,
        included            JSONB,                    -- the scope AS SIGNED
        not_included        JSONB,                    -- and the exclusions AS SIGNED
        value_cents         INTEGER,
        monthly_cents       INTEGER,
        duration_weeks      INTEGER,
        starts_at_intake    BOOLEAN,
        terms_note          TEXT,
        payments            JSONB,                    -- the schedule AS SIGNED
        -- ── the document ──
        template_version    TEXT NOT NULL,            -- which template produced it
        file_name           TEXT NOT NULL,
        file_bytes          BYTEA NOT NULL,           -- Railway's disk does not survive a deploy
        file_size           INTEGER NOT NULL,
        -- ── the register's own bookkeeping ──
        status              TEXT NOT NULL DEFAULT 'generated',
        superseded_by       INTEGER REFERENCES sitenex_contracts(id),
        generated_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_sitenex_contracts_deal ON sitenex_contracts (deal_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sitenex_contracts_partner ON sitenex_contracts (partner_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sitenex_contracts_status ON sitenex_contracts (status)`);
    await query(`COMMENT ON TABLE sitenex_contracts IS $c$One row per GENERATED CONTRACT DOCUMENT, with the client and partner details SNAPSHOT rather than joined. The register must show what each contract actually said: if a client corrects their address later and this joined to the deal, every historical contract would silently rewrite itself to an address that was never in the signed document. Regeneration inserts a NEW ROW and sets superseded_by on the old one — nothing is ever overwritten.$c$`);
    await query(`COMMENT ON COLUMN sitenex_contracts.status IS $c$generated | sent | signed | superseded | void. Default 'generated'.$c$`);
    await query(`COMMENT ON COLUMN sitenex_contracts.file_bytes IS $c$The .docx itself. In Postgres and not on disk because Railway's filesystem is ephemeral — a file written to public/ becomes a dead download link on the next deploy.$c$`);
    await query(`COMMENT ON COLUMN sitenex_contracts.generated_by IS $c$ON DELETE SET NULL: deleting a user must not delete the contract register. RESTRICT would make deleting a user fail with a foreign-key error instead.$c$`);
    console.log('✅ sitenex_contracts');

    // ── verification ──────────────────────────────────────────────────────────
    console.log('\nverification:');
    const dealCols = (await query(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name='sitenex_deals' AND column_name = ANY($1) ORDER BY column_name`,
      [DEAL_COLUMNS.map(c => c[0])])).rows;
    console.log(`  sitenex_deals new columns: ${dealCols.length}/${DEAL_COLUMNS.length}`);
    const notNull = dealCols.filter(c => c.is_nullable === 'NO' && !/starts_at_intake/.test(c.column_name));
    if (notNull.length) throw new Error(`these must be NULLABLE or the won-hook insert breaks: ${notNull.map(c => c.column_name).join(', ')}`);
    const sai = dealCols.find(c => c.column_name === 'starts_at_intake');
    console.log(`  starts_at_intake default: ${sai && sai.column_default}`);
    if (!sai || !/true/i.test(sai.column_default || '')) throw new Error('starts_at_intake must DEFAULT TRUE');

    for (const t of ['sitenex_deal_payments', 'sitenex_contracts']) {
      const n = (await query(`SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_name=$1`, [t])).rows[0].n;
      const rows = (await query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
      console.log(`  ${t}: ${n} columns, ${rows} rows`);
      if (!n) throw new Error(`${t} was not created`);
    }
    // No CHECK constraints anywhere — the vocabularies are COMMENTs, as everywhere else here.
    const checks = (await query(
      `SELECT t.relname, COUNT(*)::int n FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
        WHERE t.relname IN ('sitenex_deal_payments','sitenex_contracts') AND c.contype='c' GROUP BY 1`)).rows;
    // NOT NULL is contype 'c'? No — it is attnotnull, not a pg_constraint row. So any 'c' here is a real CHECK.
    console.log(`  CHECK constraints: ${checks.length ? checks.map(c => c.relname + '=' + c.n).join(' ') : '0'} (must be 0)`);
    if (checks.length) throw new Error('a CHECK constraint was created — the vocabulary belongs in a COMMENT');

    const bytea = (await query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name='sitenex_contracts' AND column_name='file_bytes'`)).rows[0];
    console.log(`  file_bytes type: ${bytea && bytea.data_type} (must be bytea)`);
    if (!bytea || bytea.data_type !== 'bytea') throw new Error('file_bytes must be BYTEA');

    const seqNow = (await query(`SELECT last_value, is_called FROM sitenex_contract_no_seq`)).rows[0];
    console.log(`  sequence last_value=${seqNow.last_value} is_called=${seqNow.is_called}`);

    console.log('\n✅ DONE');
    process.exit(0);
  } catch (e) { console.error('❌', e.message); process.exit(1); }
})();
