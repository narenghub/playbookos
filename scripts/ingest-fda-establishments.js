// ── AROS sourcing: ingest FDA's establishment register (DECRS) ──
//
// Downloads the public 2.3 MB zip, parses drls_reg.txt, upserts into fda_establishments.
// No API key, no per-row cost, no cross-database call — the file is a plain public download
// and dmf_holders is already in this database, so the whole join is self-contained here.
//
//   node scripts/ingest-fda-establishments.js            # DRY RUN, reports what it would write
//   node scripts/ingest-fda-establishments.js --execute
//   node scripts/ingest-fda-establishments.js --execute --force   # re-ingest an unchanged file
//
// A FLOOR, NOT A TARGET. The register held 10,454 rows when this was written. Anything near
// zero means the fetch returned an error page or the publication moved, and loading THAT would
// empty the table behind a green log line. Borrowed from AROS's own mirror job, which learned
// this the same way.
const MIN_ROWS = 1000;

const AdmZip = require('adm-zip');
const { query } = require('../src/lib/db');
const { parseDecrs } = require('../src/lib/fda/establishments');

const URL = 'https://www.accessdata.fda.gov/cder/drls_reg.zip';
const MEMBER = 'drls_reg.txt';
const UA = 'playnexa/aros-sourcing (+https://app.playnexa.ai)';

const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');
const FORCE = argv.includes('--force');

async function main() {
  console.log(`fetching ${URL}`);
  const t0 = Date.now();
  const res = await fetch(URL, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`FDA returned HTTP ${res.status}`);
  const lastModified = res.headers.get('last-modified');
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`  ${buf.length} bytes (${(buf.length / 1048576).toFixed(2)} MB) in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`  last-modified: ${lastModified || '(none)'}`);

  // A zip starts "PK". Checking before handing 2.3 MB to the unzipper turns an HTML error
  // page into a clear message instead of a stack trace about a corrupt archive.
  if (buf.slice(0, 2).toString('hex') !== '504b') {
    throw new Error('response is not a zip — FDA probably served an error page');
  }

  // Has anything changed since the last run? The header is the cheapest possible check and
  // makes a quarterly cron a no-op on the days nothing was republished.
  if (!FORCE && lastModified) {
    const prev = await query(
      `SELECT source_last_modified, COUNT(*)::int n FROM fda_establishments
        GROUP BY 1 ORDER BY n DESC LIMIT 1`).catch(() => ({ rows: [] }));
    if (prev.rows[0] && prev.rows[0].source_last_modified === lastModified) {
      console.log(`\nalready ingested this publication (${prev.rows[0].n} rows) — nothing to do.`);
      console.log('re-run with --force to reload it anyway.');
      return;
    }
  }

  const entry = new AdmZip(buf).getEntry(MEMBER);
  if (!entry) throw new Error(`${MEMBER} not found in the zip`);
  const rows = parseDecrs(entry.getData().toString('utf8'));
  console.log(`\nparsed ${rows.length} establishment rows`);
  if (rows.length < MIN_ROWS) {
    throw new Error(`only ${rows.length} rows parsed (floor is ${MIN_ROWS}) — refusing to load`);
  }

  const api = rows.filter(r => r.is_api_manufacturer).length;
  const agents = rows.filter(r => r.is_us_agent).length;
  const noFei = rows.filter(r => !r.fei_number).length;
  const withEmail = rows.filter(r => r.establishment_contact_email).length;
  const countries = {};
  for (const r of rows) if (r.country) countries[r.country] = (countries[r.country] || 0) + 1;
  const top = Object.entries(countries).sort((a, b) => b[1] - a[1]).slice(0, 8);

  console.log(`  API MANUFACTURE:            ${api}`);
  console.log(`  registrant is a US agent:   ${agents}`);
  console.log(`  no FEI number:              ${noFei}`);
  console.log(`  establishment email present:${withEmail}`);
  console.log(`  top countries:              ${top.map(([k, v]) => `${k}=${v}`).join(' ')}`);

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing written. Re-run with --execute.');
    return;
  }

  let written = 0;
  for (const r of rows) {
    await query(
      `INSERT INTO fda_establishments
         (fei_number, duns_number, firm_name, firm_normalized, address, country, operations,
          is_api_manufacturer, establishment_contact_name, establishment_contact_email,
          registrant_name, registrant_contact_email, is_us_agent, exclusion_flag,
          source_last_modified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (fei_number, firm_name) DO UPDATE SET
         duns_number = EXCLUDED.duns_number,
         firm_normalized = EXCLUDED.firm_normalized,
         address = EXCLUDED.address,
         country = EXCLUDED.country,
         operations = EXCLUDED.operations,
         is_api_manufacturer = EXCLUDED.is_api_manufacturer,
         establishment_contact_name = EXCLUDED.establishment_contact_name,
         establishment_contact_email = EXCLUDED.establishment_contact_email,
         registrant_name = EXCLUDED.registrant_name,
         registrant_contact_email = EXCLUDED.registrant_contact_email,
         is_us_agent = EXCLUDED.is_us_agent,
         exclusion_flag = EXCLUDED.exclusion_flag,
         source_last_modified = EXCLUDED.source_last_modified,
         ingested_at = NOW()`,
      [r.fei_number, r.duns_number, r.firm_name, r.firm_normalized, r.address, r.country,
       r.operations, r.is_api_manufacturer, r.establishment_contact_name,
       r.establishment_contact_email, r.registrant_name, r.registrant_contact_email,
       r.is_us_agent, r.exclusion_flag, lastModified]);
    written++;
  }
  const total = (await query('SELECT COUNT(*)::int n FROM fda_establishments')).rows[0].n;
  console.log(`\n✅ upserted ${written} rows; table now holds ${total}`);
}

main().then(() => process.exit(0), (e) => {
  console.error('FDA establishment ingest error:', e.message);
  process.exit(1);
});
