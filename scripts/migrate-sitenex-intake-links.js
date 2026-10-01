// ── (6) TOKENISED CLIENT INTAKE — schema ───────────────────────────────────────
//
//   railway ssh 'node scripts/migrate-sitenex-intake-links.js'
//
// Two tables and four columns. The client gets one link per deal, uses it across several sessions over
// several weeks, and never gets an account.
//
// ── WHY THE TOKEN IS STORED AS A HASH ────────────────────────────────────────
//
// It is a BEARER CREDENTIAL: whoever holds the string can write files against a deal. Storing it in
// plaintext means a database read, a leaked backup, a screenshot of a query result or an over-broad
// SELECT in some future admin page hands over every live upload link at once. So the column is
// token_hash and the token itself is NEVER written anywhere — it exists in the issuing response and
// in the client's email, and nowhere else. See src/lib/sitenex/intake-token.js for the hash choice.
//
// token_tail (last 4 characters) is stored deliberately, and is NOT a weakening: 4 characters of a
// 43-character base64url string is not a credential, and without it staff have no way to tell which
// link a client is quoting when they say it does not work.
//
// ── WHY THE PARTIAL UNIQUE INDEX ─────────────────────────────────────────────
//
// "Re-issuing invalidates the previous token" is a rule, and a rule the UI enforces is a rule that
// holds until somebody writes a second code path. UNIQUE (deal_id) WHERE revoked_at IS NULL makes the
// DATABASE refuse a second live link on one deal — the same reasoning as the exclusivity index on
// partner_territories. The issuing handler revokes the old row and inserts the new one in one
// transaction, so the index is satisfied by construction and would fire only on a bug.
//
// ── WHY BYTEA, STATED AS THE INTERIM IT IS ───────────────────────────────────
//
// Bytes belong in object storage; there is no S3 SDK and no bucket env var in this project, so wiring
// one is its own piece of work. Until then file_bytes is BYTEA under hard caps — 10MB per file, 50MB
// per deal — and VIDEO IS REFUSED OUTRIGHT rather than accepted, because one phone clip is 50-500MB
// and would bloat every backup from here on. storage_key is in the table from day one so the S3 cutover
// is "write the key instead of the bytes" and not a migration: a row is readable from whichever of the
// two is populated.
//
// IDEMPOTENT. Every statement is IF NOT EXISTS, so a re-run changes nothing.
//
// ROLLBACK (destroys uploads — the files are the client's only copy here):
//   DROP TABLE IF EXISTS sitenex_intake_files;
//   DROP TABLE IF EXISTS sitenex_intake_links;
//   ALTER TABLE sitenex_projects DROP COLUMN IF EXISTS brief, DROP COLUMN IF EXISTS brief_model,
//     DROP COLUMN IF EXISTS brief_generated_at, DROP COLUMN IF EXISTS brief_error;

const { initDB, query } = require('../src/lib/db');

async function main() {
  await initDB();

  // A guard, FIRST and before any DDL, so a refusal is honest when it says nothing was changed.
  // migrate-sitenex-phase3.js learned this the hard way: its refusal ran after the ALTERs.
  for (const t of ['sitenex_deals', 'sitenex_intake', 'sitenex_projects']) {
    const { rows } = await query(`SELECT to_regclass($1) AS t`, [t]);
    if (!rows[0].t) {
      console.error(`❌ ${t} does not exist — run scripts/migrate-sitenex-rename.js (and the base schema it renames) first. Nothing has been changed.`);
      process.exit(1);
    }
  }

  // ── 1. the links ───────────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS sitenex_intake_links (
      id                SERIAL PRIMARY KEY,
      deal_id           INTEGER NOT NULL REFERENCES sitenex_deals(id) ON DELETE CASCADE,
      token_hash        TEXT NOT NULL UNIQUE,   -- sha256(token) hex. The token is never stored.
      token_tail        TEXT NOT NULL,          -- last 4 chars, so staff can identify a link
      expires_at        TIMESTAMPTZ NOT NULL,
      revoked_at        TIMESTAMPTZ,
      revoked_by        TEXT REFERENCES users(id),
      issued_by         TEXT REFERENCES users(id),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at      TIMESTAMPTZ,
      -- RATE LIMIT ACCOUNTING, on the row rather than in process memory. An in-process counter
      -- resets on every deploy and is not shared between instances, which makes it decorative on
      -- Railway. These four are read and written under SELECT ... FOR UPDATE so two concurrent
      -- uploads cannot both pass the last byte of a cap.
      request_count     INTEGER NOT NULL DEFAULT 0,
      bytes_uploaded    BIGINT  NOT NULL DEFAULT 0,
      window_started_at TIMESTAMPTZ,
      window_requests   INTEGER NOT NULL DEFAULT 0
    );
  `);
  // ONE LIVE LINK PER DEAL, enforced by the database.
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_sitenex_intake_link_live
                 ON sitenex_intake_links (deal_id) WHERE revoked_at IS NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_sitenex_intake_links_deal
                 ON sitenex_intake_links (deal_id)`);
  await query(`
    COMMENT ON COLUMN sitenex_intake_links.token_hash IS
      'sha256 hex of the bearer token. The token itself is NEVER stored — see src/lib/sitenex/intake-token.js';
    COMMENT ON INDEX uniq_sitenex_intake_link_live IS
      'one live link per deal: re-issuing must revoke the previous row in the same transaction';
  `);

  // ── 2. the uploads ─────────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS sitenex_intake_files (
      id           SERIAL PRIMARY KEY,
      deal_id      INTEGER NOT NULL REFERENCES sitenex_deals(id) ON DELETE CASCADE,
      link_id      INTEGER REFERENCES sitenex_intake_links(id) ON DELETE SET NULL,
      field        TEXT,                      -- which required item this answers ('logo', 'photos', …)
      file_name    TEXT NOT NULL,
      content_type TEXT NOT NULL,
      file_size    INTEGER NOT NULL,
      file_bytes   BYTEA,                     -- INTERIM. NULL once storage_key is populated.
      storage_key  TEXT,                      -- the S3 future. Exactly one of these two is set.
      uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sitenex_intake_files_deal ON sitenex_intake_files (deal_id);
  `);
  await query(`
    COMMENT ON COLUMN sitenex_intake_files.file_bytes IS
      'INTERIM storage. Caps enforced in src/lib/sitenex/intake-token.js: 10MB/file, 50MB/deal, video refused';
  `);

  // ── 3. the brief, on the project (item 7) ──────────────────────────────────
  //
  // ON THE PROJECT AND NOT ON THE TASK, because the brief describes the build and outlives any one
  // task row, and because the task has to be complete WITHOUT it. brief_error is a column rather than
  // a log line so a failure is visible next to the thing it failed to produce, and regeneration is a
  // button somebody can press instead of a question somebody has to ask.
  for (const [col, type] of [['brief', 'TEXT'], ['brief_model', 'TEXT'],
                             ['brief_generated_at', 'TIMESTAMPTZ'], ['brief_error', 'TEXT']]) {
    await query(`ALTER TABLE sitenex_projects ADD COLUMN IF NOT EXISTS ${col} ${type}`);
  }

  const n = (await query(`SELECT COUNT(*)::int c FROM sitenex_intake_links`)).rows[0].c;
  const f = (await query(`SELECT COUNT(*)::int c FROM sitenex_intake_files`)).rows[0].c;
  console.log(`✅ intake links schema applied — sitenex_intake_links (${n} rows), sitenex_intake_files (${f} rows), sitenex_projects +4 brief columns, 1 partial unique index (one live link per deal).`);
  process.exit(0);
}

main().catch(e => { console.error('intake-links migration error:', e.message); process.exit(1); });
