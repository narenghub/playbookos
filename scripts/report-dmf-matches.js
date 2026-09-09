// ── CPHI sourcing Step 1: matching report (READ-ONLY) ──
//
// Runs src/lib/dmf/match against every distinct study_molecules name and prints the numbers
// that decide whether this pipeline is worth building. Writes NOTHING — not dmf_holders, not
// molecule_dmf_matches — so it runs before the migration is applied.
//
// It pulls the DMF file from FDA rather than from dmf_holders for that same reason: the report
// has to work before the tables exist.
//
// Run:  node scripts/report-dmf-matches.js

const { fetchAndParseDmf } = require('../src/lib/dmf/fda-file');
const {
  buildSubjectIndex, matchMolecule, normalizeMolecule, isSaltFormOf,
} = require('../src/lib/dmf/match');

/** Exact + salt_form + contained only — the matcher as it would be WITHOUT the annotated tier. */
function matchWithoutAnnotated(name, index) {
  const base = normalizeMolecule(name);
  if (!base) return false;
  if (index.bySubject.has(base)) return true;
  const first = base.split(' ')[0];
  if ([...(index.byFirstToken.get(first) || [])].some((s) => isSaltFormOf(s, base))) return true;
  return base.length >= 7 && index.subjects.some((s) => ` ${s} `.includes(` ${base} `));
}

async function main() {
  const { rows, meta } = await fetchAndParseDmf();

  console.log('══════════ INGEST ══════════');
  console.log(`file             ${meta.label}   (source_file="${meta.sourceFile}")`);
  console.log(`url              ${meta.url}`);
  console.log(`DMFs received by ${meta.receivedBy}; list current through DMF ${meta.currentThrough}`);
  console.log(`downloaded       ${(meta.bytes / 1048576).toFixed(2)} MB`);
  console.log(`rows parsed      ${rows.length}${meta.skipped ? `   (${meta.skipped} skipped blank/malformed)` : ''}`);

  const index = buildSubjectIndex(rows);
  console.log(`active Type II   ${index.considered}   (${index.subjects.length} distinct normalised subjects)`);

  const { query } = require('../src/lib/db');
  const res = await query(
    `SELECT DISTINCT ON (LOWER(molecule_name)) molecule_name, molecule_type
       FROM study_molecules ORDER BY LOWER(molecule_name)`,
  );
  const mols = res.rows;

  const results = mols.map((m) => {
    const hit = matchMolecule(m.molecule_name, index);
    return { ...m, ...(hit || { tier: null, dmfNumbers: [], holders: [] }) };
  });
  const matched = results.filter((r) => r.tier);

  console.log('\n══════════ MATCH RATE ══════════');
  console.log(`study_molecules distinct names   ${results.length}`);
  console.log(`matched to >=1 active Type II    ${matched.length}   (${(100 * matched.length / results.length).toFixed(1)}%)`);
  console.log('\nby tier:');
  for (const t of ['exact', 'salt_form', 'annotated', 'contained']) {
    const n = matched.filter((r) => r.tier === t).length;
    console.log(`  ${t.padEnd(12)}${String(n).padStart(5)}   ${(100 * n / results.length).toFixed(1)}% of all names, ${(100 * n / matched.length).toFixed(1)}% of matches`);
  }

  console.log('\nby molecule_type:');
  const types = [...new Set(results.map((r) => r.molecule_type || '(null)'))];
  for (const t of types.sort()) {
    const sub = results.filter((r) => (r.molecule_type || '(null)') === t);
    const m = sub.filter((r) => r.tier).length;
    console.log(`  ${t.padEnd(20)}${String(m).padStart(4)}/${String(sub.length).padEnd(5)} ${(100 * m / sub.length).toFixed(0)}%`);
  }

  const without = results.filter((r) => matchWithoutAnnotated(r.molecule_name, index)).length;
  const gain = matched.length - without;
  console.log('\n══════════ ANNOTATED-TIER GAIN (measured) ══════════');
  console.log(`without annotated  ${without}/${results.length}   ${(100 * without / results.length).toFixed(1)}%`);
  console.log(`with annotated     ${matched.length}/${results.length}   ${(100 * matched.length / results.length).toFixed(1)}%`);
  console.log(`gain               +${gain} molecules   +${(100 * gain / results.length).toFixed(1)} pp`);

  // Ranked by the MATCHED DMF SUBJECT, not the source name. study_molecules legitimately
  // holds the same substance under several names from different studies ("Semaglutide" and
  // "Semaglutide USP Reference Standard" are separate rows with separate provenance, and
  // collapsing them upstream would destroy that) — but a supplier ranking must count the
  // substance once. Grouping here gets both.
  console.log('\n══════════ TOP 20 SUBSTANCES BY DMF HOLDER COUNT ══════════');
  console.log('Grouped by matched DMF subject; source names that collapsed are listed under each.\n');
  const bySubject = new Map();
  for (const r of matched) {
    const g = bySubject.get(r.matchedSubject) || { subject: r.matchedSubject, holders: r.holders, tiers: new Set(), names: [] };
    if (r.holders.length > g.holders.length) g.holders = r.holders;
    g.tiers.add(r.tier);
    g.names.push(r.molecule_name);
    bySubject.set(r.matchedSubject, g);
  }
  const top = [...bySubject.values()]
    .sort((a, b) => b.holders.length - a.holders.length || a.subject.localeCompare(b.subject))
    .slice(0, 20);
  for (const [i, g] of top.entries()) {
    const tiers = [...g.tiers].join('+');
    console.log(`${String(i + 1).padStart(3)}. ${String(g.holders.length).padStart(3)} holders  ${tiers.padEnd(22)} ${g.subject}`);
    console.log(`      from ${g.names.length} source name${g.names.length > 1 ? 's' : ''}: ${g.names.join(' | ')}`);
  }
  console.log(`\ndistinct substances matched: ${bySubject.size}  (from ${matched.length} source names)`);

  const contained = matched.filter((r) => r.tier === 'contained');
  console.log(`\n══════════ ALL CONTAINED-TIER MATCHES (${contained.length}) ══════════`);
  console.log('Low confidence by construction — every one listed for review.\n');
  for (const r of contained) {
    console.log(`  ${r.molecule_name}   [${r.molecule_type}]`);
    console.log(`      subject "${r.matchedSubject}"   ${r.dmfNumbers.length} DMF   ${r.holders.slice(0, 3).join('; ')}`);
  }
}

main().then(() => process.exit(0), (e) => { console.error('report error:', e); process.exit(1); });
