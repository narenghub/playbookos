// ── AROS sourcing: join DMF holders to FDA establishment registrations ──
//
// Both sides are already in this database: dmf_holders (the quarterly DMF list) and
// fda_establishments (the register, ingested by scripts/ingest-fda-establishments.js).
// No network, no API key, no cross-database read.
//
//   node scripts/match-dmf-establishments.js             # DRY RUN
//   node scripts/match-dmf-establishments.js --execute
//
// SCOPED TO ACTIVE TYPE II. Type II is the drug-substance file — an API. The other types are
// packaging, excipients and container closure, which are different businesses selling to a
// different buyer, and inactive filings describe a company that used to do this.
//
// ONE ROW PER HOLDER, BUT A HOLDER MAY MATCH SEVERAL SITES. 908 firms in the register hold
// more than one registered site, so "which site is this holder" has a real answer to choose.
// The representative is picked deliberately rather than by whatever the index returns first:
//
//   1. prefer a site registered for API MANUFACTURE   — the qualifying operation; a firm's
//                                                       packaging site is not the API plant
//   2. then prefer a site whose country parsed        — a site we cannot place geographically
//                                                       is one the ICP filter cannot judge
//   3. then lowest id                                 — stable, so a re-run does not churn
//
// The other sites are not lost: they stay in fda_establishments, and a page that wants every
// site for a firm can join on firm_normalized.

const { query } = require('../src/lib/db');
const { matchTier, reviewStatusFor } = require('../src/lib/fda/establishments');

const EXECUTE = process.argv.includes('--execute');

// US + EU/EEA + UK + Switzerland: the market AROS sells into. Kept here rather than in the
// library because it is a commercial definition, not a fact about the FDA file.
const US_EU = new Set([
  'USA', 'GBR', 'CHE', 'NOR', 'ISL', 'LIE',
  'AUT', 'BEL', 'BGR', 'HRV', 'CYP', 'CZE', 'DNK', 'EST', 'FIN', 'FRA', 'DEU', 'GRC',
  'HUN', 'IRL', 'ITA', 'LVA', 'LTU', 'LUX', 'MLT', 'NLD', 'POL', 'PRT', 'ROU', 'SVK',
  'SVN', 'ESP', 'SWE',
]);

async function main() {
  const holders = (await query(
    `SELECT holder_normalized, MIN(holder) AS holder, COUNT(*)::int AS dmf_count
       FROM dmf_holders
      WHERE dmf_type = 'II' AND status = 'A'
      GROUP BY holder_normalized
      ORDER BY MIN(holder)`)).rows;

  // The whole register, in memory. 10,452 rows is nothing, and doing this as 2,209 SQL
  // round trips would be slower than the ingest it follows.
  const sites = (await query(
    `SELECT id, fei_number, firm_name, firm_normalized, country, is_api_manufacturer
       FROM fda_establishments ORDER BY id`)).rows;

  // Index by the two things matchTier compares, so the scan is a lookup rather than
  // 2,209 x 10,452 string comparisons.
  const byName = new Map();
  for (const s of sites) {
    if (!byName.has(s.firm_normalized)) byName.set(s.firm_normalized, []);
    byName.get(s.firm_normalized).push(s);
  }

  function pickSite(candidates) {
    return candidates.slice().sort((a, b) =>
      (b.is_api_manufacturer - a.is_api_manufacturer)
      || ((b.country ? 1 : 0) - (a.country ? 1 : 0))
      || (a.id - b.id))[0];
  }

  const tally = { exact: 0, core: 0, not_found: 0 };
  const rows = [];
  for (const h of holders) {
    let tier = null, site = null;
    // exact first: the folded names are identical.
    const exact = byName.get(require('../src/lib/fda/establishments').normalizeName(h.holder));
    if (exact && exact.length) { tier = 'exact'; site = pickSite(exact); }
    if (!tier) {
      // core: identical once the generic vocabulary is dropped. Scan, because the core fold
      // is many-to-one and an index on it would still need the tier check.
      const cands = [];
      for (const s of sites) if (matchTier(h.holder, s.firm_name) === 'core') cands.push(s);
      if (cands.length) { tier = 'core'; site = pickSite(cands); }
    }
    tally[tier || 'not_found']++;
    rows.push({ ...h, tier: tier || 'not_found', site });
  }

  const joined = rows.filter(r => r.site);
  const api = joined.filter(r => r.site.is_api_manufacturer).length;
  const countries = {};
  for (const r of joined) if (r.site.country) countries[r.site.country] = (countries[r.site.country] || 0) + 1;
  const icp = joined.filter(r =>
    r.site.is_api_manufacturer && US_EU.has(r.site.country) && r.dmf_count >= 1 && r.dmf_count <= 3);

  console.log(`holders (active Type II): ${holders.length}`);
  console.log(`register sites:           ${sites.length}\n`);
  console.log(`JOINED: ${joined.length}  (${(100 * joined.length / holders.length).toFixed(1)}%)`);
  console.log(`   exact      ${tally.exact}`);
  console.log(`   core       ${tally.core}`);
  console.log(`   not_found  ${tally.not_found}`);
  console.log(`\nof the joined:`);
  console.log(`   API MANUFACTURE            ${api}  (${(100 * api / joined.length).toFixed(1)}%)`);
  console.log(`   countries: ${Object.entries(countries).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`\nICP SLICE (API MANUFACTURE + US/EU + 1-3 DMF filings): ${icp.length}`);

  if (!EXECUTE) { console.log('\nDRY RUN — nothing written. Re-run with --execute.'); return; }

  await query('TRUNCATE dmf_establishment_matches RESTART IDENTITY');
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const vals = [];
    const tuples = slice.map((r, j) => {
      const b = j * 7;
      vals.push(r.holder, r.holder_normalized, r.dmf_count,
        r.site ? r.site.id : null, r.site ? r.site.fei_number : null,
        r.tier, reviewStatusFor(r.tier));
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
    }).join(',');
    await query(
      `INSERT INTO dmf_establishment_matches
         (holder, holder_normalized, dmf_count, establishment_id, fei_number, match_tier, review_status)
       VALUES ${tuples}
       ON CONFLICT (holder_normalized) DO UPDATE SET
         holder = EXCLUDED.holder, dmf_count = EXCLUDED.dmf_count,
         establishment_id = EXCLUDED.establishment_id, fei_number = EXCLUDED.fei_number,
         match_tier = EXCLUDED.match_tier, review_status = EXCLUDED.review_status,
         matched_at = NOW()`, vals);
    written += slice.length;
  }
  console.log(`\n✅ wrote ${written} match rows`);
}

main().then(() => process.exit(0), (e) => {
  console.error('match error:', e.message);
  process.exit(1);
});
