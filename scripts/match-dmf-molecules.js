// ── CPHI sourcing Step 1: persist molecule → DMF matches ──
//
// Reads dmf_holders (so it runs against what was actually ingested, not a fresh download),
// matches every distinct study_molecules name, and writes molecule_dmf_matches.
//
// REVIEW GATE. The three deterministic tiers (exact / salt_form / annotated) are written
// 'auto_confirmed'. The `contained` tier is written on the column DEFAULT, 'unreviewed' —
// it is roughly half wrong on live data, but it is also the only tier that reaches biologics
// whose registry subject carries a prefix, so it is kept and surfaced rather than discarded.
// Nothing downstream may use a row whose review_status is still 'unreviewed'.
//
// IDEMPOTENT: unique on (molecule_name, dmf_number). Re-running refreshes tier and subject.
// A human's review_status is PRESERVED on re-run — a re-match must never silently un-confirm
// or un-reject a row someone has already judged.
//
// Run:
//   node scripts/match-dmf-molecules.js            # DRY RUN
//   node scripts/match-dmf-molecules.js --execute  # writes molecule_dmf_matches

const { buildSubjectIndex, matchMolecule } = require('../src/lib/dmf/match');
const { query } = require('../src/lib/db');

const EXECUTE = process.argv.includes('--execute');
const TRUSTED = new Set(['exact', 'salt_form', 'annotated']);
const CHUNK = 500;

async function main() {
  const dmf = await query('SELECT dmf_number, status, dmf_type, holder, subject FROM dmf_holders');
  if (!dmf.rows.length) throw new Error('dmf_holders is empty — run scripts/ingest-dmf.js --execute first.');
  const index = buildSubjectIndex(dmf.rows);
  console.log(`dmf_holders rows      ${dmf.rows.length}`);
  console.log(`active Type II indexed ${index.considered}  (${index.subjects.length} distinct subjects)`);

  const mols = (await query(
    `SELECT DISTINCT ON (LOWER(molecule_name)) molecule_name, molecule_type
       FROM study_molecules ORDER BY LOWER(molecule_name)`,
  )).rows;
  console.log(`study_molecules names  ${mols.length}`);

  const pending = [];
  const byTier = {};
  for (const m of mols) {
    const hit = matchMolecule(m.molecule_name, index);
    if (!hit) continue;
    byTier[hit.tier] = (byTier[hit.tier] || 0) + 1;
    const review = TRUSTED.has(hit.tier) ? 'auto_confirmed' : 'unreviewed';
    for (const dmfNumber of hit.dmfNumbers) {
      pending.push([m.molecule_name, dmfNumber, hit.tier, review, hit.matchedSubject]);
    }
  }

  console.log('\nmolecules matched by tier:');
  for (const t of ['exact', 'salt_form', 'annotated', 'contained']) {
    console.log(`  ${t.padEnd(12)}${String(byTier[t] || 0).padStart(5)}`);
  }
  console.log(`\n(molecule, dmf) pairs to write: ${pending.length}`);

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing written. Re-run with --execute.');
    return;
  }

  let written = 0;
  for (let i = 0; i < pending.length; i += CHUNK) {
    const slice = pending.slice(i, i + CHUNK);
    const values = slice.flat();
    const tuples = slice.map((_, n) => `($${n * 5 + 1},$${n * 5 + 2},$${n * 5 + 3},$${n * 5 + 4},$${n * 5 + 5})`).join(',');
    await query(
      `INSERT INTO molecule_dmf_matches (molecule_name, dmf_number, match_tier, review_status, matched_subject)
       VALUES ${tuples}
       ON CONFLICT (molecule_name, dmf_number) DO UPDATE SET
         match_tier = EXCLUDED.match_tier,
         matched_subject = EXCLUDED.matched_subject,
         -- A human verdict outranks the matcher. Only rows still sitting on the default are
         -- allowed to move, so re-running never un-confirms or un-rejects someone's review.
         review_status = CASE
           WHEN molecule_dmf_matches.review_status IN ('confirmed', 'rejected')
             THEN molecule_dmf_matches.review_status
           ELSE EXCLUDED.review_status
         END,
         matched_at = NOW()`,
      values,
    );
    written += slice.length;
  }

  const summary = (await query(
    `SELECT match_tier, review_status, COUNT(*)::int AS pairs, COUNT(DISTINCT molecule_name)::int AS molecules
       FROM molecule_dmf_matches GROUP BY 1, 2 ORDER BY 1, 2`,
  )).rows;
  console.log(`\n✅ wrote ${written} pairs into molecule_dmf_matches\n`);
  console.log('tier          review_status      pairs  molecules');
  for (const r of summary) {
    console.log(`  ${r.match_tier.padEnd(12)}${r.review_status.padEnd(18)}${String(r.pairs).padStart(6)}${String(r.molecules).padStart(11)}`);
  }
}

main().then(() => process.exit(0), (e) => { console.error('match error:', e.message); process.exit(1); });
