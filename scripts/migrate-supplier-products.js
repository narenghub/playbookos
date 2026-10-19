#!/usr/bin/env node
// ── THE REVIEW TABLE BETWEEN A SUPPLIER PDF AND THE MARKETPLACE ──────────────
//
//   railway ssh 'node scripts/migrate-supplier-products.js'
//
// Re-runnable throughout.
//
// Ten CPHI suppliers sent product lists — thirteen PDFs, one spreadsheet, two screenshots. The
// temptation is to parse them straight into abiozen.com. This table exists to stop that.
//
// PDF extraction is lossy in a way that is specific and dangerous here: a column shifts and row
// 12's name pairs with row 13's number. On a pharma listing that is not a typo, it is a different
// molecule, and the person who discovers it is the buyer who ordered against it. So every
// extracted row lands here as `pending`, carrying the file and the exact source line it came
// from, and a human approves it before anything is published.
//
// ── RE-EXTRACTION MUST NEVER OVERWRITE A HUMAN DECISION ─────────────────────
//
// The same PDF will be parsed again — when the parser improves, when a supplier sends a revision.
// The upsert below updates the EXTRACTED fields and deliberately leaves review_status,
// reviewed_by, reviewed_at and review_note alone. Without that, improving the parser would
// silently reset every approval and rejection made so far, and the second review would look
// exactly like the first.
'use strict';

const { initDB, query } = require('../src/lib/db');

async function main() {
  await initDB();

  await query(`
    CREATE TABLE IF NOT EXISTS supplier_products (
      id                  BIGSERIAL PRIMARY KEY,
      event_slug          TEXT NOT NULL,
      contact_id          BIGINT REFERENCES cphi_exhibitor_contacts(id) ON DELETE SET NULL,
      supplier            TEXT NOT NULL,
      supplier_normalized TEXT NOT NULL,

      -- WHAT WAS READ
      product_name        TEXT,
      cas                 TEXT,            -- checksum-validated at extraction; see lib/catalogue/cas.js
      grade               TEXT,            -- api | intermediate | ksm | peptide | impurity | excipient
      markers             TEXT,            -- JSON array: DMF, CEP, GMP, USP, EP …
      confidence          TEXT,            -- high | medium | low | none
      name_source         TEXT,            -- same-line | after-cas | line-N-above | sheet

      -- WHERE IT CAME FROM. A wrong row has to be traceable to its file and line, or the review
      -- is somebody guessing against a PDF they have to find first.
      source_file         TEXT,
      source_line         TEXT,

      -- WHAT THE CLASSIFIER SUGGESTED. A sort order for a human, never an approval.
      suggested           TEXT,            -- list | second_source | hold | reject
      suggested_reason    TEXT,
      priority            INTEGER NOT NULL DEFAULT 0,

      -- WHAT A HUMAN DECIDED. Never written by the extractor.
      review_status       TEXT NOT NULL DEFAULT 'pending',
      reviewed_by         TEXT,
      reviewed_at         TIMESTAMPTZ,
      review_note         TEXT,

      -- ── COMMERCIAL vs RESEARCH USE ────
      -- The marketplace must never render a listing without this. The first extraction run put
      -- Orforglipron, Inclisiran and Nusinersen at the top of the "list first" pile; all are under
      -- patent and one is not yet approved. See useClass() in src/lib/catalogue/classify.js.
      use_class           TEXT,            -- commercial | rnd_only | unknown
      listing_notice      TEXT,            -- the restriction the listing must carry, or NULL
      patent_check        TEXT,            -- why this row was restricted

      published_at        TIMESTAMPTZ,
      extracted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Dropped and re-added rather than added tolerantly: widening a CHECK means replacing it, and
  // "add, ignore already exists" leaves an older narrower version in place while the file reads
  // correctly. That exact mistake cost a production run on cphi_exhibitor_matches.
  await query(`ALTER TABLE supplier_products DROP CONSTRAINT IF EXISTS sp_review_valid`);
  await query(`ALTER TABLE supplier_products ADD CONSTRAINT sp_review_valid
                 CHECK (review_status IN ('pending','approved','rejected','held'))`);
  // Added after the table shipped, so existing deployments pick them up.
  await query(`
    ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS use_class      TEXT;
    ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS listing_notice TEXT;
    ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS patent_check   TEXT;
  `);
  await query(`ALTER TABLE supplier_products DROP CONSTRAINT IF EXISTS sp_use_valid`);
  await query(`ALTER TABLE supplier_products ADD CONSTRAINT sp_use_valid
                 CHECK (use_class IS NULL OR use_class IN ('commercial','rnd_only','unknown'))`);

  await query(`ALTER TABLE supplier_products DROP CONSTRAINT IF EXISTS sp_suggested_valid`);
  await query(`ALTER TABLE supplier_products ADD CONSTRAINT sp_suggested_valid
                 CHECK (suggested IS NULL OR suggested IN ('list','second_source','hold','reject'))`);

  // One row per (event, supplier, molecule). COALESCE because a row may legitimately have no CAS
  // or no name, and a NULL in a unique index defeats the uniqueness it was added for.
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_products
      ON supplier_products (event_slug, supplier_normalized,
                            COALESCE(cas, ''), lower(COALESCE(product_name, '')));
    CREATE INDEX IF NOT EXISTS idx_sp_review   ON supplier_products (review_status, priority DESC);
    CREATE INDEX IF NOT EXISTS idx_sp_cas      ON supplier_products (cas) WHERE cas IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sp_supplier ON supplier_products (event_slug, supplier_normalized);
    CREATE INDEX IF NOT EXISTS idx_sp_pending  ON supplier_products (event_slug, priority DESC)
      WHERE review_status = 'pending';
  `);

  await query(`
    COMMENT ON COLUMN supplier_products.review_status IS
      'Set by a human only. The extractor upserts every other column and must never touch this one — re-parsing a PDF would otherwise reset every approval already made.';
    COMMENT ON COLUMN supplier_products.cas IS
      'Checksum-validated at extraction. A value here passed the CAS check digit; it is not merely shaped like one.';
    COMMENT ON COLUMN supplier_products.listing_notice IS
      'If present, the marketplace MUST display this on the listing and must not offer a commercial quote without a freedom-to-operate check.';
    COMMENT ON COLUMN supplier_products.source_line IS
      'The verbatim line the row was read from, so a wrong pairing can be checked against the PDF without hunting for it.';
  `);

  const n = (await query(`SELECT COUNT(*)::int c FROM supplier_products`)).rows[0].c;
  const byStatus = (await query(
    `SELECT review_status, COUNT(*)::int c FROM supplier_products GROUP BY 1 ORDER BY 2 DESC`)).rows;

  console.log('✅ supplier_products ready.');
  console.log(`   ${n} row(s)`);
  for (const r of byStatus) console.log(`      ${r.review_status.padEnd(10)} ${r.c}`);
  console.log('\n   Next: node scripts/cphi-catalogue-extract.js\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('migrate-supplier-products failed:', e && e.message ? e.message : e);
  process.exit(1);
});
