// ── CPHI sourcing: demand-first target sizing (READ-ONLY) ──
//
// Inverts the approach. Rather than enumerating all 2,989 Milan exhibitors and asking which
// ones we care about, this starts from the demand side we already have — the molecules a
// recruiting trial pipeline needs — and walks out to their DMF holders. That set is the only
// list worth checking against CPHI, and it is a few hundred companies rather than three
// thousand.
//
// Writes nothing. Reads dmf_holders + molecule_dmf_matches + study_molecules + clinical_studies.
//
// Only review_status='auto_confirmed' matches are followed: the substring ('contained') tier is
// ~50% wrong and must not put a company on a target list until a human has confirmed it.
//
// Run:  node scripts/report-demand-targets.js [topN]        (default 100)

const { query } = require('../src/lib/db');
const { DEMAND_SQL } = require('../src/lib/dmf/demand');

const TOP_N = Number(process.argv[2] || 100);

const DEMAND_CTE = `
  demand AS (
    SELECT LOWER(sm.molecule_name) AS k,
           MIN(sm.molecule_name)    AS display_name,
           COUNT(DISTINCT sm.study_id) AS studies,
           SUM(COALESCE(cs.enrollment_count, 0)) AS patients,
           COUNT(DISTINCT sm.study_id) FILTER (WHERE cs.phase = 'Phase 3') AS ph3,
           COUNT(DISTINCT sm.study_id) FILTER (WHERE cs.phase = 'Phase 2') AS ph2
      FROM study_molecules sm
      JOIN clinical_studies cs ON cs.id = sm.study_id
     GROUP BY 1
  ),
  sourceable AS (
    SELECT d.* FROM demand d
     WHERE EXISTS (SELECT 1 FROM molecule_dmf_matches m
                    WHERE LOWER(m.molecule_name) = d.k AND m.review_status = 'auto_confirmed')
  ),
  scored AS (SELECT *, ${DEMAND_SQL} AS score FROM sourceable),
  top AS (SELECT * FROM scored ORDER BY score DESC, studies DESC LIMIT $1)
`;

async function main() {
  const totals = (await query(
    `SELECT (SELECT COUNT(DISTINCT LOWER(molecule_name)) FROM study_molecules)::int AS all_molecules,
            (SELECT COUNT(DISTINCT LOWER(molecule_name)) FROM molecule_dmf_matches
              WHERE review_status = 'auto_confirmed')::int AS sourceable_molecules,
            (SELECT COUNT(DISTINCT d.holder_normalized) FROM molecule_dmf_matches m
               JOIN dmf_holders d ON d.dmf_number = m.dmf_number
              WHERE m.review_status = 'auto_confirmed')::int AS all_holders`,
  )).rows[0];

  console.log('══════════ THE POOL ══════════');
  console.log(`distinct molecules in study_molecules        ${totals.all_molecules}`);
  console.log(`  of those, sourceable (>=1 confirmed DMF)   ${totals.sourceable_molecules}`);
  console.log(`distinct DMF holders across ALL of them      ${totals.all_holders}   <- the hard ceiling on lookups`);

  // How the lookup count grows with the cut depth.
  console.log('\n══════════ HOLDERS BY CUT DEPTH ══════════');
  for (const n of [25, 50, 100, 150, 200, 318]) {
    const r = (await query(
      `WITH ${DEMAND_CTE}
       SELECT COUNT(DISTINCT d.holder_normalized)::int AS holders,
              COUNT(DISTINCT t.k)::int AS molecules
         FROM top t
         JOIN molecule_dmf_matches m ON LOWER(m.molecule_name) = t.k AND m.review_status = 'auto_confirmed'
         JOIN dmf_holders d ON d.dmf_number = m.dmf_number`, [n],
    )).rows[0];
    console.log(`  top ${String(n).padStart(3)} molecules -> ${String(r.holders).padStart(4)} distinct holders`);
  }

  // The headline set.
  const set = (await query(
    `WITH ${DEMAND_CTE}
     SELECT COUNT(DISTINCT t.k)::int AS molecules,
            COUNT(DISTINCT d.holder_normalized)::int AS holders,
            COUNT(*)::int AS pairs
       FROM top t
       JOIN molecule_dmf_matches m ON LOWER(m.molecule_name) = t.k AND m.review_status = 'auto_confirmed'
       JOIN dmf_holders d ON d.dmf_number = m.dmf_number`, [TOP_N],
  )).rows[0];

  console.log(`\n══════════ TOP ${TOP_N} BY CLINICAL DEMAND ══════════`);
  console.log(`molecules                 ${set.molecules}`);
  console.log(`DISTINCT DMF HOLDERS      ${set.holders}   <- the CPHI lookup list`);
  console.log(`molecule-holder pairs     ${set.pairs}`);

  const top = (await query(
    `WITH ${DEMAND_CTE}
     SELECT t.display_name, t.studies, t.patients, t.ph3, t.ph2, ROUND(t.score::numeric, 1) AS score,
            COUNT(DISTINCT d.holder_normalized)::int AS holders
       FROM top t
       JOIN molecule_dmf_matches m ON LOWER(m.molecule_name) = t.k AND m.review_status = 'auto_confirmed'
       JOIN dmf_holders d ON d.dmf_number = m.dmf_number
      GROUP BY t.display_name, t.studies, t.patients, t.ph3, t.ph2, t.score
      ORDER BY t.score DESC, t.studies DESC LIMIT 25`, [TOP_N],
  )).rows;

  console.log('\ntop 25 of them:');
  console.log(`  ${'score'.padStart(6)} ${'std'.padStart(4)} ${'ph3'.padStart(4)} ${'ph2'.padStart(4)} ${'patients'.padStart(9)} ${'DMFs'.padStart(5)}  molecule`);
  for (const r of top) {
    console.log(`  ${String(r.score).padStart(6)} ${String(r.studies).padStart(4)} ${String(r.ph3).padStart(4)} ${String(r.ph2).padStart(4)} ${String(r.patients).padStart(9)} ${String(r.holders).padStart(5)}  ${r.display_name}`);
  }

  // Concentration: how much of the lookup list is carried by how few companies.
  const conc = (await query(
    `WITH ${DEMAND_CTE},
     h AS (SELECT d.holder_normalized, MIN(d.holder) AS holder, COUNT(DISTINCT t.k)::int AS molecules
             FROM top t
             JOIN molecule_dmf_matches m ON LOWER(m.molecule_name) = t.k AND m.review_status = 'auto_confirmed'
             JOIN dmf_holders d ON d.dmf_number = m.dmf_number
            GROUP BY 1)
     SELECT holder, molecules FROM h ORDER BY molecules DESC, holder LIMIT 15`, [TOP_N],
  )).rows;
  console.log('\nmost-connected holders in that list (they cover the most in-demand molecules):');
  for (const r of conc) console.log(`  ${String(r.molecules).padStart(3)} molecules  ${r.holder}`);

  const single = (await query(
    `WITH ${DEMAND_CTE},
     h AS (SELECT d.holder_normalized, COUNT(DISTINCT t.k)::int AS molecules
             FROM top t
             JOIN molecule_dmf_matches m ON LOWER(m.molecule_name) = t.k AND m.review_status = 'auto_confirmed'
             JOIN dmf_holders d ON d.dmf_number = m.dmf_number
            GROUP BY 1)
     SELECT COUNT(*) FILTER (WHERE molecules = 1)::int AS one_molecule_only, COUNT(*)::int AS total FROM h`, [TOP_N],
  )).rows[0];
  console.log(`\n${single.one_molecule_only} of ${single.total} holders appear for only ONE of the top ${TOP_N} molecules.`);
}

main().then(() => process.exit(0), (e) => { console.error('report error:', e.message); process.exit(1); });
