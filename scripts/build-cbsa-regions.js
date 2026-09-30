// ── Build REGIONS from the OMB/Census CBSA delineation file ────────────────────
//
// Read-only: prints the per-state CBSA counts and can emit a REGIONS map. Makes NO Places calls and writes
// nothing to the database — see docs/REGION_SOURCE_REPORT.md for what the numbers mean.
//
// The source is list1_<year>.xlsx from census.gov. An xlsx is a zip of XML, so adm-zip (already a
// dependency — the FDA DMF import uses the same trick) is enough; no spreadsheet library needed.
//
//   curl -sL -o /tmp/list1_2023.xlsx \
//     https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx
//   node scripts/build-cbsa-regions.js /tmp/list1_2023.xlsx [--metro-only] [--emit]
//
// A CBSA spanning states is counted ONCE PER STATE, because each state's run has to search it.

const AdmZip = require('adm-zip');

const file = process.argv[2] || '/tmp/list1_2023.xlsx';
const metroOnly = process.argv.includes('--metro-only');
const emit = process.argv.includes('--emit');

function sheetRows(zip) {
  const shared = zip.readAsText('xl/sharedStrings.xml');
  const strings = [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  const sheet = zip.readAsText('xl/worksheets/sheet1.xml');
  // BOTH cell shapes. A self-closing <c/> with only the greedy form lets the match run on to the NEXT
  // cell's </c>, so values land in the wrong column — that silently lost 577 of 1,915 rows on the first
  // attempt and produced per-state counts that were wrong by a third.
  const CELL = /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const rows = [];
  for (const r of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of r[1].matchAll(CELL)) {
      const [, col, attrs, inner] = c;
      if (inner == null) continue;
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      if (v == null) continue;
      cells[col] = /t="s"/.test(attrs) ? strings[+v] : v;
    }
    rows.push(cells);
  }
  return rows;
}

const rows = sheetRows(new AdmZip(file));
const hdrIdx = rows.findIndex(r => Object.values(r).some(v => /CBSA Title/i.test(String(v))));
if (hdrIdx < 0) { console.error('could not find the header row — is this list1_<year>.xlsx?'); process.exit(1); }
const hdr = rows[hdrIdx];
const col = n => Object.keys(hdr).find(k => String(hdr[k]).trim().toLowerCase() === n.toLowerCase());
const C = { cbsa: col('CBSA Code'), title: col('CBSA Title'),
            type: col('Metropolitan/Micropolitan Statistical Area'), state: col('State Name') };
for (const [k, v] of Object.entries(C)) if (!v) { console.error(`missing column: ${k}`); process.exit(1); }

const data = rows.slice(hdrIdx + 1).filter(r => r[C.title]);
const per = new Map(), seen = new Set();
for (const r of data) {
  const state = String(r[C.state] || '').trim();
  const isMetro = /^Metro/i.test(String(r[C.type]));
  if (!state || (metroOnly && !isMetro)) continue;
  const key = state + '|' + r[C.cbsa];
  if (seen.has(key)) continue;
  seen.add(key);
  if (!per.has(state)) per.set(state, []);
  per.get(state).push({ title: String(r[C.title]).trim(), metro: isMetro });
}

const out = [...per.entries()].map(([state, list]) => ({
  state, metro: list.filter(x => x.metro).length, micro: list.filter(x => !x.metro).length,
  total: list.length, titles: list.map(x => x.title).sort(),
})).sort((a, b) => a.state.localeCompare(b.state));

const cbsas = new Set(data.map(r => r[C.cbsa]));
console.log(`${data.length} county rows · ${cbsas.size} distinct CBSAs · ${out.length} states/territories`);
console.log(`${out.reduce((a, b) => a + b.total, 0)} CBSA-state pairs${metroOnly ? ' (metropolitan only)' : ''}\n`);
for (const s of out) {
  console.log(`  ${s.state.padEnd(22)}${String(s.metro).padStart(3)} metro ${String(s.micro).padStart(4)} micro ${String(s.total).padStart(5)} total`);
}
if (emit) {
  // REGIONS wants the strings Places will search. CBSA titles are already the right shape.
  const REGIONS = Object.fromEntries(out.map(s => [s.state, s.titles]));
  require('fs').writeFileSync('/tmp/REGIONS.json', JSON.stringify(REGIONS, null, 1));
  console.log('\nwrote /tmp/REGIONS.json — NOT installed into tiles.js; that is a deliberate step');
}
