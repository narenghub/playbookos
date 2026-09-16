// ── Abiozen sourcing: build research_institutions from clinical_studies.raw_json ──
//
// A parse, not a fetch. Everything comes from rows already in this database — no network, no
// API key, no per-row cost.
//
//   node scripts/build-research-institutions.js              # DRY RUN, reports the counts
//   node scripts/build-research-institutions.js --execute
//   node scripts/build-research-institutions.js --all        # include non-ICP, for measuring
//
// IDEMPOTENT: unique on normalized_name, so a re-run after more studies are ingested refreshes
// counts and dates in place rather than duplicating.

const { query } = require('../src/lib/db');
const { collectInstitutions, facilityType, isPlaceholder } = require('../src/lib/institutions/parse');

const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');
const ALL = argv.includes('--all');

const EU = new Set(['Austria','Belgium','Bulgaria','Croatia','Cyprus','Czechia','Czech Republic',
  'Denmark','Estonia','Finland','France','Germany','Greece','Hungary','Ireland','Italy','Latvia',
  'Lithuania','Luxembourg','Malta','Netherlands','Poland','Portugal','Romania','Slovakia',
  'Slovenia','Spain','Sweden','Switzerland','Norway','Iceland','United Kingdom']);
const isUsEu = (c) => c === 'United States' || EU.has(c);

async function main() {
  const studies = (await query(
    `SELECT raw_json, start_date, first_posted_date, ingested_at
       FROM clinical_studies WHERE raw_json IS NOT NULL`)).rows;
  console.log(`studies with raw_json: ${studies.length}`);

  const map = collectInstitutions(studies, { icpOnly: !ALL });
  const rows = [...map.values()];
  const usEu = rows.filter(r => isUsEu(r.country));
  const withEmail = rows.filter(r => r.contact_email);
  const icpDefault = usEu.filter(r => r.contact_email);

  const byType = {};
  for (const r of rows) byType[r.facility_type] = (byType[r.facility_type] || 0) + 1;
  const byCountry = {};
  for (const r of usEu) byCountry[r.country] = (byCountry[r.country] || 0) + 1;

  console.log(`\ninstitutions parsed:        ${rows.length}${ALL ? '  (--all: ICP filter OFF)' : ''}`);
  console.log(`  US/EU:                    ${usEu.length}`);
  console.log(`  with a contact email:     ${withEmail.length}  (${(100 * withEmail.length / (rows.length || 1)).toFixed(0)}%)`);
  console.log(`  DEFAULT CUT (US/EU + email): ${icpDefault.length}`);
  console.log(`  by type:    ${Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`  by country: ${Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  if (!EXECUTE) { console.log('\nDRY RUN — nothing written. Re-run with --execute.'); return; }

  const COLS = 12, CHUNK = 400;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const vals = [];
    const tuples = slice.map((r, j) => {
      const b = j * COLS;
      vals.push(r.name, r.normalized, r.city, r.state, r.country, r.facility_type,
        r.study_count, r.contact_name, r.contact_email,
        r.first_seen || null, r.last_seen || null, 'clinicaltrials.gov');
      return '(' + Array.from({ length: COLS }, (_, k) => `$${b + k + 1}`).join(',') + ')';
    }).join(',');
    await query(
      `INSERT INTO research_institutions
         (name, normalized_name, city, state, country, facility_type, study_count,
          contact_name, contact_email, first_seen, last_seen, source)
       VALUES ${tuples}
       ON CONFLICT (normalized_name) DO UPDATE SET
         name = EXCLUDED.name, city = EXCLUDED.city, state = EXCLUDED.state,
         country = EXCLUDED.country, facility_type = EXCLUDED.facility_type,
         study_count = EXCLUDED.study_count,
         -- never blank a contact we already hold because a later parse saw fewer contacts
         contact_name = COALESCE(EXCLUDED.contact_name, research_institutions.contact_name),
         contact_email = COALESCE(EXCLUDED.contact_email, research_institutions.contact_email),
         first_seen = LEAST(research_institutions.first_seen, EXCLUDED.first_seen),
         last_seen = GREATEST(research_institutions.last_seen, EXCLUDED.last_seen),
         refreshed_at = NOW()`, vals);
    written += slice.length;
  }
  const total = (await query('SELECT COUNT(*)::int n FROM research_institutions')).rows[0].n;
  console.log(`\n✅ upserted ${written}; table holds ${total}`);
}

main().then(() => process.exit(0), (e) => {
  console.error('build error:', e.message);
  process.exit(1);
});
