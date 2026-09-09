// ── CPHI sourcing: build the floor briefing document ──
//
// Renders cphi_exhibitor_matches + the demand data into a single self-contained HTML page to
// work from on the show floor. READ-ONLY against the database.
//
// Regenerate after each quarterly re-run (ingest-dmf -> match-dmf-molecules ->
// lookup-cphi-exhibitors -> this), so the booth numbers and the demand ranking stay in step.
//
// Run:  node scripts/build-cphi-briefing.js [outfile]

const fs = require('fs');
const { query } = require('../src/lib/db');
const { DEMAND_SQL } = require('../src/lib/dmf/demand');

const EVENT = 'cphi-milan-2026';
const OUT = process.argv[2] || 'cphi-milan-briefing.html';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Title-case a shouting FDA holder string without mangling acronyms. */
function tidy(name) {
  return String(name || '').split(/\s+/).map((w) => {
    if (w.length <= 3 && w === w.toUpperCase()) return w;          // LLC, BV, MSN, TAPI
    if (/^[A-Z]+$/.test(w) && w.length <= 5) return w;
    return w.charAt(0) + w.slice(1).toLowerCase();
  }).join(' ');
}

/** The one line that says why you are standing at this booth. */
function askFor(row) {
  const thin = row.thin || [];
  if (thin.length) {
    const sole = thin.filter((t) => t.holders === 1);
    const lead = sole.length ? sole[0] : thin[0];
    const who = lead.holders === 1 ? 'the only active US DMF holder' : `one of just ${lead.holders} active US DMF holders`;
    return `They are ${who} for <strong>${esc(lead.name)}</strong>. Ask about current capacity, lead time, and whether they would support a second-source qualification.`;
  }
  const tops = (row.topmols || []).slice(0, 3).map((m) => m.name);
  return `Covers ${row.molecules_covered} molecule${row.molecules_covered === 1 ? '' : 's'} in the pipeline${tops.length ? ` — ${tops.map(esc).join(', ')}` : ''}. Ask for their current DMF list and which of these they can supply.`;
}

async function main() {
  const summary = (await query(
    `SELECT review_status, match_tier, COUNT(*)::int AS n, SUM(molecules_covered)::int AS mols
       FROM cphi_exhibitor_matches WHERE event_slug = $1 GROUP BY 1,2`, [EVENT],
  )).rows;
  const count = (rs, tier) => summary.filter((s) => rs.includes(s.review_status) && (!tier || s.match_tier === tier))
    .reduce((a, b) => a + b.n, 0);

  const rows = (await query(
    `WITH demand AS (
       SELECT LOWER(sm.molecule_name) AS k, MIN(sm.molecule_name) AS nm,
              COUNT(DISTINCT sm.study_id) AS studies,
              SUM(COALESCE(cs.enrollment_count,0)) AS patients,
              COUNT(DISTINCT sm.study_id) FILTER (WHERE cs.phase='Phase 3') AS ph3,
              COUNT(DISTINCT sm.study_id) FILTER (WHERE cs.phase='Phase 2') AS ph2
         FROM study_molecules sm JOIN clinical_studies cs ON cs.id = sm.study_id GROUP BY 1),
     sc AS (SELECT *, ${DEMAND_SQL} AS score FROM demand),
     hold AS (SELECT LOWER(m.molecule_name) AS k, COUNT(DISTINCT d.holder_normalized)::int AS nh
                FROM molecule_dmf_matches m JOIN dmf_holders d ON d.dmf_number=m.dmf_number
               WHERE m.review_status='auto_confirmed' GROUP BY 1),
     link AS (SELECT DISTINCT d.holder_normalized AS hn, sc.k, sc.nm, sc.score, sc.studies, sc.ph3, hold.nh
                FROM molecule_dmf_matches m JOIN dmf_holders d ON d.dmf_number=m.dmf_number
                JOIN sc ON sc.k=LOWER(m.molecule_name) JOIN hold ON hold.k=sc.k
               WHERE m.review_status='auto_confirmed')
     SELECT c.holder, c.exhibitor_name, c.booth, c.hall, c.match_tier, c.review_status,
            c.molecules_covered,
            (SELECT json_agg(json_build_object('name', x.nm, 'holders', x.nh, 'studies', x.studies, 'ph3', x.ph3) ORDER BY x.score DESC)
               FROM (SELECT * FROM link l WHERE l.hn=c.holder_normalized AND l.nh<=3 ORDER BY l.score DESC LIMIT 4) x) AS thin,
            (SELECT json_agg(json_build_object('name', y.nm) ORDER BY y.score DESC)
               FROM (SELECT * FROM link l2 WHERE l2.hn=c.holder_normalized ORDER BY l2.score DESC LIMIT 3) y) AS topmols
       FROM cphi_exhibitor_matches c
      WHERE c.event_slug=$1 AND c.review_status IN ('auto_confirmed','entity_review')
      ORDER BY c.molecules_covered DESC, c.holder`, [EVENT],
  )).rows;

  const token = (await query(
    `SELECT holder, exhibitor_name, booth, molecules_covered FROM cphi_exhibitor_matches
      WHERE event_slug=$1 AND review_status='unreviewed' AND match_tier='token'
      ORDER BY molecules_covered DESC, holder`, [EVENT],
  )).rows;

  const absent = (await query(
    `SELECT holder, molecules_covered FROM cphi_exhibitor_matches
      WHERE event_slug=$1 AND NOT exhibiting AND molecules_covered >= 3
      ORDER BY molecules_covered DESC, holder`, [EVENT],
  )).rows;

  const byHall = {};
  for (const r of rows) (byHall[r.hall || '?'] ||= []).push(r);

  const priority = rows.filter((r) => r.molecules_covered >= 5);
  const rest = rows.filter((r) => r.molecules_covered < 5);

  const chip = (t) => `<span class="thin-chip">${esc(t.name)} <b>${t.holders === 1 ? 'sole' : t.holders}</b></span>`;
  const tierBadge = (r) => r.review_status === 'entity_review'
    ? '<span class="badge badge-caveat" title="Right stand, possibly a parent or sibling legal entity">entity</span>'
    : `<span class="badge badge-ok">${esc(r.match_tier)}</span>`;

  const bigRow = (r, i) => `
      <li class="co">
        <div class="co-rank"><span class="rk">${i + 1}</span><span class="mc">${r.molecules_covered}</span><span class="mcl">mol</span></div>
        <div class="co-main">
          <div class="co-head">
            <h3>${esc(tidy(r.holder))}</h3>
            <a class="booth" href="#hall-${esc(r.hall)}">${esc(r.booth)}</a>
            ${tierBadge(r)}
          </div>
          <p class="co-sub">Stand reads <em>${esc(r.exhibitor_name)}</em> · Hall ${esc(r.hall)}</p>
          ${(r.thin || []).length ? `<div class="thin-row">${(r.thin || []).map(chip).join('')}</div>` : ''}
          <p class="ask">${askFor(r)}</p>
          ${r.review_status === 'entity_review' ? `<p class="caveat">Contract caution: the DMF is filed by <b>${esc(r.holder)}</b>, the stand is <b>${esc(r.exhibitor_name)}</b>. Same group, possibly a different legal entity — confirm which entity holds the file before any paperwork.</p>` : ''}
        </div>
      </li>`;

  const smallRow = (r) => `
        <tr>
          <td class="n">${r.molecules_covered}</td>
          <td>${esc(tidy(r.holder))}${r.review_status === 'entity_review' ? ' <span class="badge badge-caveat">entity</span>' : ''}</td>
          <td class="mono">${esc(r.booth)}</td>
          <td class="mono dim">${esc(r.hall)}</td>
          <td class="dim">${(r.thin || []).length ? (r.thin || []).map((t) => `${esc(t.name)}${t.holders === 1 ? ' (sole)' : ''}`).join(', ') : '—'}</td>
        </tr>`;

  const html = `<title>Milan Sourcing Floor Plan</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Source+Sans+3:ital,wght@0,400;0,600;1,400&family=IBM+Plex+Mono:wght@400;600&display=swap">
<style>
:root{
  --ground:#FAF9F6; --panel:#FFFFFF; --edge:#E3E0D9; --edge-soft:#EDEAE3;
  --text:#1C2126; --muted:#6E7681; --dim:#8B929B;
  --ink:#1A3A5C; --ink-soft:#E8EDF3;
  --leverage:#A2551A; --leverage-soft:#F7EDE2;
  --caveat:#5F5A7A; --caveat-soft:#EEECF4;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --sans:"Source Sans 3",system-ui,-apple-system,Segoe UI,sans-serif;
  --disp:"Archivo","Source Sans 3",system-ui,sans-serif;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#14171C; --panel:#191D23; --edge:#2B313A; --edge-soft:#232830;
  --text:#E6E8EA; --muted:#98A0AB; --dim:#78808B;
  --ink:#8FB4DA; --ink-soft:#1B2733;
  --leverage:#D89552; --leverage-soft:#2A2118;
  --caveat:#A9A2C7; --caveat-soft:#221F2C;
}}
:root[data-theme="dark"]{
  --ground:#14171C; --panel:#191D23; --edge:#2B313A; --edge-soft:#232830;
  --text:#E6E8EA; --muted:#98A0AB; --dim:#78808B;
  --ink:#8FB4DA; --ink-soft:#1B2733;
  --leverage:#D89552; --leverage-soft:#2A2118;
  --caveat:#A9A2C7; --caveat-soft:#221F2C;
}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--text);font-family:var(--sans);font-size:16px;line-height:1.55;margin:0}
.wrap{max-width:940px;margin:0 auto;padding:40px 22px 90px}
h1,h2,h3{font-family:var(--disp);text-wrap:balance;margin:0}
h1{font-size:2.05rem;font-weight:700;letter-spacing:-.02em;line-height:1.15}
h2{font-size:1.12rem;font-weight:700;letter-spacing:-.01em}
h3{font-size:1.02rem;font-weight:600}
.eyebrow{font-family:var(--disp);font-size:.72rem;font-weight:600;letter-spacing:.13em;text-transform:uppercase;color:var(--ink)}
.lede{color:var(--muted);max-width:64ch;margin:12px 0 0}
header{border-bottom:2px solid var(--ink);padding-bottom:26px}
.meta{font-family:var(--mono);font-size:.78rem;color:var(--dim);margin-top:14px;display:flex;gap:18px;flex-wrap:wrap}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:1px;background:var(--edge);border:1px solid var(--edge);margin:28px 0 8px}
.stat{background:var(--panel);padding:13px 15px}
.stat .v{font-family:var(--mono);font-size:1.5rem;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1}
.stat .k{font-size:.75rem;color:var(--muted);margin-top:3px}

section{margin-top:46px}
.sec-head{display:flex;align-items:baseline;gap:12px;border-bottom:1px solid var(--edge);padding-bottom:9px;margin-bottom:6px}
.sec-head .count{font-family:var(--mono);font-size:.8rem;color:var(--dim)}
.sec-note{color:var(--muted);font-size:.92rem;margin:10px 0 22px;max-width:66ch}

ol.colist{list-style:none;padding:0;margin:0;display:flex;flex-direction:column}
.co{display:grid;grid-template-columns:60px 1fr;gap:18px;padding:20px 0;border-bottom:1px solid var(--edge-soft)}
.co-rank{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;line-height:1.2;padding-top:2px}
.co-rank .rk{display:block;font-size:.75rem;color:var(--dim)}
.co-rank .mc{display:block;font-size:1.35rem;font-weight:600;color:var(--ink)}
.co-rank .mcl{display:block;font-size:.66rem;color:var(--dim);letter-spacing:.06em;text-transform:uppercase}
.co-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.booth{font-family:var(--mono);font-size:.9rem;font-weight:600;background:var(--ink);color:var(--ground);padding:2px 9px;border-radius:2px;text-decoration:none;letter-spacing:.02em}
.co-sub{margin:5px 0 0;font-size:.86rem;color:var(--muted)}
.co-sub em{font-style:normal;color:var(--text)}
.ask{margin:10px 0 0;font-size:.93rem;color:var(--muted);max-width:70ch}
.ask strong{color:var(--text);font-weight:600}
.caveat{margin:9px 0 0;font-size:.85rem;color:var(--caveat);background:var(--caveat-soft);border-left:2px solid var(--caveat);padding:8px 12px;max-width:70ch}
.thin-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:11px}
.thin-chip{font-size:.78rem;font-family:var(--mono);background:var(--leverage-soft);color:var(--leverage);padding:2px 8px;border-radius:2px;white-space:nowrap}
.thin-chip b{font-weight:600}

.badge{font-family:var(--mono);font-size:.66rem;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:2px}
.badge-ok{background:var(--ink-soft);color:var(--ink)}
.badge-caveat{background:var(--caveat-soft);color:var(--caveat)}

.tbl-scroll{overflow-x:auto;border:1px solid var(--edge)}
table{border-collapse:collapse;width:100%;font-size:.9rem;background:var(--panel)}
th{font-family:var(--disp);font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);text-align:left;padding:9px 12px;border-bottom:1px solid var(--edge);white-space:nowrap}
td{padding:8px 12px;border-bottom:1px solid var(--edge-soft);vertical-align:top}
tr:last-child td{border-bottom:none}
td.n{font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--ink);font-weight:600;width:44px}
td.mono,.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
td.dim,.dim{color:var(--muted)}

.halls{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:1px;background:var(--edge);border:1px solid var(--edge)}
.hall{background:var(--panel);padding:11px 13px}
.hall h4{font-family:var(--mono);font-size:.85rem;margin:0 0 6px;color:var(--ink);font-weight:600}
.hall p{margin:0;font-size:.79rem;color:var(--muted);line-height:1.5}

.warn{border:1px solid var(--caveat);background:var(--caveat-soft);padding:14px 16px;margin-bottom:20px}
.warn p{margin:0;font-size:.9rem;color:var(--text)}
footer{margin-top:60px;padding-top:20px;border-top:1px solid var(--edge);font-size:.82rem;color:var(--dim)}
a{color:var(--ink)}
@media (max-width:620px){.co{grid-template-columns:48px 1fr;gap:12px}.wrap{padding:26px 15px 70px}h1{font-size:1.6rem}}
</style>

<div class="wrap">
<header>
  <p class="eyebrow">CPHI Milan 2026 · 6–8 October · Fiera Milano</p>
  <h1>Milan Sourcing Floor Plan</h1>
  <p class="lede">Every API manufacturer on the Milan floor that holds an active US Type&nbsp;II drug master file for a molecule our recruiting-trial pipeline needs — ranked by how many of those molecules they cover.</p>
  <div class="meta">
    <span>${rows.length} stands to visit</span><span>of ${count(['auto_confirmed','entity_review','unreviewed'])} DMF holders checked</span><span>FDA DMF list 2Q2026</span><span>generated ${new Date().toISOString().slice(0, 10)}</span>
  </div>
</header>

<div class="stats">
  <div class="stat"><div class="v">${rows.length}</div><div class="k">confident matches</div></div>
  <div class="stat"><div class="v">${new Set(rows.map((r) => r.booth)).size}</div><div class="k">distinct booths</div></div>
  <div class="stat"><div class="v">${priority.length}</div><div class="k">cover 5+ molecules</div></div>
  <div class="stat"><div class="v">${rows.filter((r) => (r.thin || []).length).length}</div><div class="k">hold a thin-supply API</div></div>
  <div class="stat"><div class="v">${count(['entity_review'])}</div><div class="k">entity caution</div></div>
</div>

<section>
  <div class="sec-head"><h2>Work these first</h2><span class="count">${priority.length} stands · 5+ molecules each</span></div>
  <p class="sec-note">An amber chip marks a molecule with three or fewer active US Type&nbsp;II DMF holders. <b>sole</b> means this company is the only one — that is the conversation worth having.</p>
  <ol class="colist">${priority.map(bigRow).join('')}</ol>
</section>

<section>
  <div class="sec-head"><h2>The rest of the list</h2><span class="count">${rest.length} stands · 1–4 molecules</span></div>
  <p class="sec-note">Same confidence, lower coverage. Worth a pass if you have floor time near their hall.</p>
  <div class="tbl-scroll"><table>
    <thead><tr><th>Mol</th><th>Company</th><th>Booth</th><th>Hall</th><th>Thin-supply molecules</th></tr></thead>
    <tbody>${rest.map(smallRow).join('')}</tbody>
  </table></div>
</section>

<section>
  <div class="sec-head"><h2>Routing by hall</h2><span class="count">${Object.keys(byHall).length} halls</span></div>
  <p class="sec-note">The same ${rows.length} stands grouped for walking, busiest hall first.</p>
  <div class="halls">
    ${Object.entries(byHall).sort((a, b) => b[1].length - a[1].length).map(([h, list]) => `
    <div class="hall" id="hall-${esc(h)}">
      <h4>Hall ${esc(h)} · ${list.length}</h4>
      <p>${list.sort((a, b) => b.molecules_covered - a.molecules_covered).map((r) => `${esc(r.booth)} ${esc(tidy(r.holder).split(' ').slice(0, 2).join(' '))}`).join(' · ')}</p>
    </div>`).join('')}
  </div>
</section>

<section>
  <div class="sec-head"><h2>Right booth, check the entity</h2><span class="count">${count(['entity_review'])} companies</span></div>
  <p class="sec-note">The stand is the right company to talk to. The name on it is not the name on the drug master file — usually a parent, a sibling, or another site of the same group. Irrelevant to a conversation, decisive on a contract.</p>
  <div class="tbl-scroll"><table>
    <thead><tr><th>Mol</th><th>DMF filed by</th><th>Stand reads</th><th>Booth</th></tr></thead>
    <tbody>${rows.filter((r) => r.review_status === 'entity_review').map((r) => `
      <tr><td class="n">${r.molecules_covered}</td><td>${esc(r.holder)}</td><td class="dim">${esc(r.exhibitor_name)}</td><td class="mono">${esc(r.booth)}</td></tr>`).join('')}
    </tbody>
  </table></div>
</section>

<section>
  <div class="sec-head"><h2>Unverified</h2><span class="count">${token.length} possible matches</span></div>
  <div class="warn"><p><b>Do not walk to these on the strength of this list.</b> These were matched on a single shared brand word, and roughly half are wrong — <em>Auro Peptides</em> matched <em>BCN Peptides</em>, <em>Anhui Poly Pharm</em> matched <em>Hainan Poly Pharm</em>. Some are right (Polpharma, Aurisco). Confirm the company on the CPHI app before spending a slot.</p></div>
  <div class="tbl-scroll"><table>
    <thead><tr><th>Mol</th><th>DMF holder</th><th>Possible stand</th><th>Booth</th></tr></thead>
    <tbody>${token.map((r) => `
      <tr><td class="n">${r.molecules_covered}</td><td>${esc(r.holder)}</td><td class="dim">${esc(r.exhibitor_name)}</td><td class="mono">${esc(r.booth)}</td></tr>`).join('')}
    </tbody>
  </table></div>
</section>

<section>
  <div class="sec-head"><h2>Not on the floor</h2><span class="count">${absent.length} holders, 3+ molecules each</span></div>
  <p class="sec-note">These supply molecules we need and are not exhibiting at Milan. They need a different route — direct approach, or a distributor who is on the floor.</p>
  <div class="tbl-scroll"><table>
    <thead><tr><th>Mol</th><th>DMF holder</th></tr></thead>
    <tbody>${absent.map((r) => `<tr><td class="n">${r.molecules_covered}</td><td>${esc(r.holder)}</td></tr>`).join('')}</tbody>
  </table></div>
</section>

<footer>
  <p>Demand is scored from recruiting trials in the Clinical Demand pipeline: study count &times;3, Phase&nbsp;3 &times;5, Phase&nbsp;2 &times;2, plus a capped enrolment term. Supplier data is the FDA Drug Master File list, 2nd Quarter 2026, active Type&nbsp;II only — drug substances, not packaging or excipients. Booths are from CPHI's public exhibitor directory. Regenerate with <span class="mono">scripts/build-cphi-briefing.js</span> after the next quarterly DMF file.</p>
</footer>
</div>
`;

  fs.writeFileSync(OUT, html);
  console.log(`wrote ${OUT}  (${rows.length} confident, ${token.length} unverified, ${absent.length} absent)`);
}

main().then(() => process.exit(0), (e) => { console.error('briefing error:', e.message); process.exit(1); });
