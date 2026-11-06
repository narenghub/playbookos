#!/usr/bin/env node
// ── RENDER THE TRACKER AS A PAGE, FROM THE DEMO'S OWN OUTPUT ─────────────────
//
//   node scripts/prpa-render-tracker.js
//
// Reads rows.json and summary.json written by prpa-tracker-demo.js and renders a single static
// page. It invents nothing: every number on the page comes from the JSON, and if the JSON is
// absent it refuses rather than rendering an empty shell that looks like a working product.
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = process.env.PRPA_OUT || '/tmp/claude-0/-home-claude/a0303f00-5fe1-5ee7-be5c-5412f357070f/scratchpad/prpa-out';
const rowsPath = path.join(DIR, 'rows.json');
const sumPath = path.join(DIR, 'summary.json');

for (const p of [rowsPath, sumPath]) {
  if (!fs.existsSync(p)) {
    console.error(`FAIL  ${p} does not exist. Run scripts/prpa-tracker-demo.js first.`);
    console.error('      Refusing to render a page with no data behind it.');
    process.exit(1);
  }
}
const rows = JSON.parse(fs.readFileSync(rowsPath, 'utf8'));
const S = JSON.parse(fs.readFileSync(sumPath, 'utf8'));

const esc = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');
const money = (v) => (v === null || v === undefined ? '' : `$${Number(v).toLocaleString('en-US')}`);

// Days until deadline, from the summary's generation time so the page is self-consistent.
const now = new Date(S.generated_at);
const daysLeft = (v) => (v ? Math.round((new Date(v) - now) / 864e5) : null);

const VERDICT_ORDER = { QUALIFIED: 0, NEEDS_REVIEW: 1, NOT_QUALIFIED: 2, 'NOT ASSESSED': 3 };
const sorted = [...rows].sort((a, b) => {
  const va = VERDICT_ORDER[a.verdict || 'NOT ASSESSED'] ?? 9;
  const vb = VERDICT_ORDER[b.verdict || 'NOT ASSESSED'] ?? 9;
  if (va !== vb) return va - vb;
  const da = a.response_deadline ? new Date(a.response_deadline).getTime() : Infinity;
  const db = b.response_deadline ? new Date(b.response_deadline).getTime() : Infinity;
  return da - db;
});

const counts = rows.reduce((a, r) => { const k = r.verdict || 'NOT ASSESSED'; a[k] = (a[k] || 0) + 1; return a; }, {});
const biddable = rows.filter((r) => r.is_biddable).length;
const typeMix = Object.entries(S.notice_type_mix || {}).sort((a, b) => b[1] - a[1]);

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Abiozen Federal Opportunities</title>
<style>
  :root{
    --bg:#f7f7f5; --panel:#fff; --ink:#1a1a18; --muted:#6b6b66; --line:#e3e3df;
    --q:#1a7f4b; --qbg:#e8f5ee; --r:#8a6400; --rbg:#fdf4e0; --n:#8a2f2f; --nbg:#fbeceb;
    --accent:#2d4a7c;
  }
  @media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){
    --bg:#16161a; --panel:#1e1e24; --ink:#ecece8; --muted:#9a9a93; --line:#31313a;
    --q:#5fd398; --qbg:#13302240; --r:#e0b351; --rbg:#3a2e1040; --n:#f0877f; --nbg:#3a181640;
    --accent:#8fb4ee;
  }}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{max-width:1500px;margin:0 auto;padding:28px 16px 56px}
  header h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
  header p{margin:0;color:var(--muted);font-size:13px}
  .warn{margin:18px 0;padding:12px 14px;border-left:3px solid var(--r);
        background:var(--rbg);border-radius:0 6px 6px 0;font-size:13px}
  .warn b{color:var(--r)}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
  .card .n{font-size:26px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .card .l{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-top:2px}
  .mix{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:18px;font-size:13px}
  .mix span{display:inline-block;margin-right:16px;color:var(--muted)}
  .mix b{color:var(--ink);font-variant-numeric:tabular-nums}
  table{width:100%;border-collapse:collapse;background:var(--panel);
        border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:12.5px}
  th{text-align:left;padding:9px 10px;background:color-mix(in srgb,var(--panel) 88%,var(--ink));
     font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
     border-bottom:1px solid var(--line);white-space:nowrap}
  td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:none}
  .chip{display:inline-block;padding:1px 7px;border-radius:20px;font-size:10.5px;font-weight:600;
        letter-spacing:.02em;white-space:nowrap}
  .QUALIFIED{background:var(--qbg);color:var(--q)}
  .NEEDS_REVIEW{background:var(--rbg);color:var(--r)}
  .NOT_QUALIFIED{background:var(--nbg);color:var(--n)}
  .sol{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;white-space:nowrap}
  .ttl{max-width:330px}
  .ttl a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line)}
  .ttl a:hover{border-bottom-color:var(--accent)}
  .miss{color:var(--muted);font-size:11px;max-width:300px;display:block;margin-top:3px}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .h2{font-size:14px;margin:22px 0 10px;letter-spacing:-.01em}
  .gaps{display:grid;grid-template-columns:repeat(auto-fit,minmax(255px,1fr));gap:10px;margin-bottom:8px}
  .gap{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:11px 13px}
  .gs{font-size:10px;font-weight:700;letter-spacing:.07em;margin-bottom:4px}
  .gs.COVERED{color:var(--q)} .gs.FIXTURE_ONLY{color:var(--r)} .gs.EXPIRED{color:var(--n)}
  .gs\\ NO\\ EVIDENCE,.gs{color:var(--n)}
  .gl{font-size:12.5px;font-weight:600;margin-bottom:5px}
  .gn{margin:0;padding-left:15px;color:var(--muted);font-size:11px;line-height:1.55}
  .rev-no_bid{background:var(--nbg);color:var(--n)}
  .rev-bid{background:var(--qbg);color:var(--q)}
  .rev-undecided{background:var(--rbg);color:var(--r)}
  .restrict{color:var(--n);font-weight:600}
  .soon{color:var(--n);font-weight:600}
  .bid{color:var(--q);font-weight:600}
  footer{margin-top:22px;color:var(--muted);font-size:11.5px;line-height:1.7}
  code{font-family:ui-monospace,Menlo,monospace;font-size:11px;background:var(--bg);padding:1px 4px;border-radius:3px}
</style></head><body><div class="wrap">

<header>
  <h1>Abiozen LLC — Federal Contract Opportunities</h1>
  <p>${rows.length} current records · generated ${esc(S.generated_at)} · source: ${esc(S.source)}</p>
</header>

<div class="warn">
  <b>Qualification shown is from the FIXTURE pass.</b> Abiozen's real capability registry holds
  <b>${S.abiozen_verified_capabilities} verified capabilities</b>${S.fixture_capabilities_seeded ? ` (${S.fixture_capabilities_seeded} fixture rows exist and are deliberately uncountable)` : ''}, so on the real registry every one of these is
  NEEDS_REVIEW or NOT_QUALIFIED and none is QUALIFIED. The verdicts below exist to show the engine
  reaches a verdict and names its evidence — they are not Abiozen's qualification status.
  The <b>opportunities themselves are real</b>: every solicitation number and link resolves on SAM.gov.
</div>

<div class="cards">
  <div class="card"><div class="n">${rows.length}</div><div class="l">opportunities</div></div>
  <div class="card"><div class="n" style="color:var(--q)">${counts.QUALIFIED || 0}</div><div class="l">qualified (fixture)</div></div>
  <div class="card"><div class="n" style="color:var(--r)">${counts.NEEDS_REVIEW || 0}</div><div class="l">needs review</div></div>
  <div class="card"><div class="n" style="color:var(--n)">${counts.NOT_QUALIFIED || 0}</div><div class="l">not qualified</div></div>
  <div class="card"><div class="n">${biddable}</div><div class="l">biddable</div></div>
  <div class="card"><div class="n">${S.duplicate_candidates || 0}</div><div class="l">dup candidates</div></div>
  <div class="card"><div class="n">${S.amendments || 0}</div><div class="l">amendments</div></div>
  <div class="card"><div class="n">${(S.bid_reviews || []).find((b) => b.decision === 'no_bid')?.n || 0}</div><div class="l">no-bid</div></div>
</div>

<div class="mix">
  ${typeMix.map(([t, n]) => `<span>${esc(t)} <b>${n}</b></span>`).join('')}
</div>

<h2 class="h2">Capability coverage — what Abiozen must produce before anything can qualify</h2>
<div class="gaps">
${(S.capability_gaps || []).map((g) => `
  <div class="gap">
    <div class="gs ${esc(g.status)}">${esc(g.status.replace(/_/g, ' '))}</div>
    <div class="gl">${esc(g.label)}</div>
    ${(g.needs || []).length ? `<ul class="gn">${g.needs.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
  </div>`).join('')}
</div>

<h2 class="h2">Open solicitations</h2>

<table>
<thead><tr>
  <th>Fit</th><th>Review</th><th>Solicitation #</th><th>Title</th><th>Agency</th>
  <th>NAICS</th><th>Eligibility restriction</th><th class="num">Deadline</th>
  <th class="num">Days</th><th>Biddable</th>
</tr></thead><tbody>
${sorted.map((r) => {
    const d = daysLeft(r.response_deadline);
    const v = r.verdict || 'NOT ASSESSED';
    return `<tr>
  <td><span class="chip ${esc(v)}">${esc(v.replace(/_/g, ' '))}</span></td>
  <td>${r.bid_decision ? `<span class="chip rev-${esc(r.bid_decision)}">${esc(r.bid_decision.replace('_', '-'))}</span>` : '<span style="color:var(--muted);font-size:11px">—</span>'}
      ${r.bid_rationale ? `<span class="miss">${esc(String(r.bid_rationale).slice(0, 90))}</span>` : ''}</td>
  <td class="sol">${esc(r.solicitation_number)}${r.version_seq > 1 ? ` <span style="color:var(--muted)">v${r.version_seq}</span>` : ''}</td>
  <td class="ttl">${r.source_url ? `<a href="${esc(r.source_url)}">${esc(String(r.title).slice(0, 92))}</a>` : esc(String(r.title).slice(0, 92))}
      ${(r.missing_requirements || []).length ? `<span class="miss">missing: ${esc((r.missing_requirements || []).slice(0, 2).join(' · '))}</span>` : ''}</td>
  <td>${esc(String(r.agency || '—').replace(/, DEPARTMENT OF$/, '').slice(0, 26))}</td>
  <td class="sol">${esc(r.naics_code || '—')}</td>
  <td style="font-size:11px">${r.set_aside ? `<span class="restrict">${esc(String(r.set_aside).slice(0, 44))}</span>` : '<span style="color:var(--muted)">open to all</span>'}</td>
  <td class="num">${esc(day(r.response_deadline) || '—')}${r.deadline_has_time ? '' : '<span style="color:var(--muted)"> ?</span>'}</td>
  <td class="num ${d !== null && d <= 7 ? 'soon' : ''}">${d === null ? '—' : d}</td>
  <td class="${r.is_biddable ? 'bid' : ''}">${r.is_biddable ? 'yes' : 'no'}</td>

</tr>`;
  }).join('\n')}
</tbody></table>

<footer>
  <b>Reading this table.</b> <code>Days</code> counts from the generation time above.
  A <code>?</code> beside a deadline means the source gave a date with no usable time of day — the
  stored value is dated 00:00 UTC and must be confirmed against the notice before it is relied on.
  <code>Biddable</code> is a generated database column: it requires a current record, open status,
  a solicitation or combined-synopsis notice type, a deadline, <em>and</em> a human confirmation of
  that deadline. Nothing here authorizes a bid; committing the company is a separate, separately
  guarded act.<br>
  Of the ${rows.length} records, only the Solicitation and Combined Synopsis/Solicitation types are
  biddable at all. Sources Sought, Special Notice and Presolicitation are market research, intent
  notices and advance warnings respectively.
</footer>
</div></body></html>
`;

const out = path.join(DIR, 'tracker.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`PASS  rendered ${rows.length} rows → ${out} (${html.length} bytes)`);
console.log(`      verdicts: ${JSON.stringify(counts)} · biddable ${biddable}`);
