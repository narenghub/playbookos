// ── CPHI sourcing Step 1: FDA Drug Master File ingest ──
//
// Downloads the quarterly DMF list from fda.gov and loads it into dmf_holders.
// Download + parse live in src/lib/dmf/fda-file.js so this script and the read-only matching
// report run the identical fetch; this file owns only the write.
//
// IDEMPOTENT: dmf_number is the FDA's own stable key, so the load is an upsert. Re-running
// replaces every row cleanly and never duplicates. Rows absent from a later quarterly file are
// NOT deleted — FDA does not remove DMFs, it flags them inactive, so a row that stops being
// republished is worth noticing, not worth destroying.
//
// Run:
//   node scripts/ingest-dmf.js            # DRY RUN — downloads, parses, reports, writes nothing
//   node scripts/ingest-dmf.js --execute  # loads into dmf_holders
//
// --execute requires scripts/migrate-dmf.js to have been applied first.

const { LIST_PAGE, fetchAndParseDmf } = require('../src/lib/dmf/fda-file');

const EXECUTE = process.argv.includes('--execute');
const CHUNK = 500;

async function main() {
  const { rows, meta } = await fetchAndParseDmf();

  console.log(`FDA DMF list page: ${LIST_PAGE}`);
  console.log(`  resolved file   : ${meta.label}`);
  console.log(`  url             : ${meta.url}`);
  if (meta.receivedBy) console.log(`  DMFs received by: ${meta.receivedBy}`);
  if (meta.currentThrough) console.log(`  current through : DMF ${meta.currentThrough}`);
  console.log(`  downloaded      : ${(meta.bytes / 1048576).toFixed(2)} MB`);

  const activeII = rows.filter((r) => r.status === 'A' && r.dmf_type === 'II').length;
  console.log(`\nparsed        : ${rows.length} rows (source_file="${meta.sourceFile}"${meta.skipped ? `, ${meta.skipped} skipped as blank/malformed` : ''})`);
  console.log(`active Type II: ${activeII}`);

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing written. Re-run with --execute (after scripts/migrate-dmf.js).');
    return;
  }

  const { query } = require('../src/lib/db');
  const COLS = 9;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values = slice.flatMap((r) => [
      r.dmf_number, r.status, r.dmf_type, r.submit_date, r.holder,
      r.subject, r.holder_normalized, r.subject_normalized, r.source_file,
    ]);
    const tuples = slice
      .map((_, n) => `(${Array.from({ length: COLS }, (_, k) => `$${n * COLS + k + 1}`).join(',')})`)
      .join(',');
    await query(
      `INSERT INTO dmf_holders
         (dmf_number, status, dmf_type, submit_date, holder, subject, holder_normalized, subject_normalized, source_file)
       VALUES ${tuples}
       ON CONFLICT (dmf_number) DO UPDATE SET
         status = EXCLUDED.status,
         dmf_type = EXCLUDED.dmf_type,
         submit_date = EXCLUDED.submit_date,
         holder = EXCLUDED.holder,
         subject = EXCLUDED.subject,
         holder_normalized = EXCLUDED.holder_normalized,
         subject_normalized = EXCLUDED.subject_normalized,
         source_file = EXCLUDED.source_file,
         ingested_at = NOW()`,
      values,
    );
    written += slice.length;
  }
  console.log(`\n✅ ingested ${written} rows into dmf_holders (source_file="${meta.sourceFile}")`);
}

main().then(() => process.exit(0), (e) => { console.error('DMF ingest error:', e.message); process.exit(1); });
