#!/usr/bin/env node
// ── VALIDATE THE EXPORTED CSV, INDEPENDENTLY OF THE CODE THAT WROTE IT ───────
//
//   node scripts/validate-export-csv.js [path-to-csv] [path-to-summary.json]
//
// Ruling 23 item 6: "Regenerate and validate the corrected Excel-compatible CSV. Test dates,
// deadlines, source URLs, missing values, duplicates, amendments, and qualification labels.
// Include the data harvest timestamp."
//
// ── WHY THIS DOES NOT IMPORT THE EXPORTER ────────────────────────────────────
//
// The obvious implementation reuses opportunity-csv.js to parse what opportunity-csv.js wrote.
// That proves the module is self-consistent and nothing else: a bug in the writer reproduced in
// the reader cancels out and the check goes green. The Posted Date column shipped "Thu Nov 05"
// to a CEO precisely because every piece of code that touched it agreed with every other piece.
//
// So this file parses the bytes with its own small parser and checks values against independent
// expectations — RFC 4180 structure, ISO date shapes, URL syntax, cross-field agreement — rather
// than against the functions that produced them.
'use strict';

const fs = require('fs');
const path = require('path');

const CSV = process.argv[2] || '/tmp/claude-0/-home-claude/a0303f00-5fe1-5ee7-be5c-5412f357070f/scratchpad/prpa-out/abiozen-federal-opportunities.csv';
const SUMMARY = process.argv[3] || path.join(path.dirname(CSV), 'summary.json');

let pass = 0; let fail = 0; let warn = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 220)}`); };
const note = (m) => { warn++; console.log(`  NOTE  ${m}`); };
const bar = () => '─'.repeat(78);
const h = (t) => console.log(`\n${bar()}\n${t}\n${bar()}`);

if (!fs.existsSync(CSV)) {
  console.error(`FAIL  no CSV at ${CSV}. Run scripts/prpa-tracker-demo.js first.`);
  console.error('      Refusing to report a validation result for a file that does not exist.');
  process.exit(1);
}
const raw = fs.readFileSync(CSV);
const text = raw.toString('utf8');

// ── an independent RFC 4180 parser ──────────────────────────────────────────
function parse(s) {
  const recs = []; let rec = []; let f = ''; let q = false; let i = 0;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  while (i < s.length) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i += 1; continue; }
      f += c; i += 1; continue;
    }
    if (c === '"') { q = true; i += 1; continue; }
    if (c === ',') { rec.push(f); f = ''; i += 1; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      rec.push(f); f = ''; recs.push(rec); rec = []; i += 1; continue;
    }
    f += c; i += 1;
  }
  rec.push(f); if (rec.length > 1 || rec[0] !== '') recs.push(rec);
  return recs;
}

h('1. THE FILE OPENS CORRECTLY IN EXCEL');
if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) ok('UTF-8 BOM present (Excel on Windows reads it as UTF-8)');
else bad('no UTF-8 BOM — non-ASCII agency names would render as mojibake');
const crlf = (text.match(/\r\n/g) || []).length;
const bareLf = (text.match(/(?<!\r)\n/g) || []).length;
if (crlf > 0) ok(`CRLF line endings (${crlf} found)`);
else bad('no CRLF line endings');
if (bareLf === 0) ok('no bare LF outside quoted fields');
else note(`${bareLf} bare LF — acceptable only inside quoted cells; checked structurally below`);

const recs = parse(text);
const headers = recs[0];
const rows = recs.slice(1).filter((r) => r.length > 1 || r[0] !== '');
if (rows.length) ok(`${rows.length} data row(s), ${headers.length} column(s)`);
else bad('no data rows');
const ragged = rows.filter((r) => r.length !== headers.length);
if (!ragged.length) ok('every row has exactly the header column count');
else bad(`${ragged.length} ragged row(s) — a shifted row imports one column into another`);

h('2. NO CELL CAN EXECUTE IN EXCEL');
// The attack this prevents: a solicitation titled =cmd|' /c calc'!A1. A CSV is normally assumed
// inert; it is not, and this data comes from files third parties produce.
const dangerous = [];
rows.forEach((r, ri) => r.forEach((c, ci) => {
  if (/^[=+\-@\t\r]/.test(c)) dangerous.push(`row ${ri + 2} col "${headers[ci]}": ${JSON.stringify(c.slice(0, 24))}`);
}));
if (!dangerous.length) ok('no cell begins with = + - @ tab or CR');
else bad(`${dangerous.length} cell(s) would be evaluated as a formula`, dangerous.slice(0, 3).join(' · '));

h('3. DATES AND DEADLINES');
const col = (n) => headers.indexOf(n);
const idx = {
  sol: col('Solicitation Number'), posted: col('Posted Date'), deadline: col('Response Deadline'),
  hasTime: col('Deadline Has Time'), confirmed: col('Deadline Confirmed'), url: col('Source Link'),
  verdict: col('Abiozen Qualification'), basis: col('Verdict Basis'), biddable: col('Biddable'),
  version: col('Version'), notice: col('Notice ID'), naics: col('NAICS'), type: col('Notice Type'),
  bid: col('Bid / No-Bid'),
};
for (const [k, v] of Object.entries(idx)) {
  if (v < 0) bad(`expected column for "${k}" is missing from the header`);
}
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MIN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/;
// THE REGRESSION THAT SHIPPED: "Thu Nov 05" instead of 2026-11-05.
const WEEKDAY = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/;
const badPosted = rows.filter((r) => r[idx.posted] && !ISO_DAY.test(r[idx.posted]));
if (!badPosted.length) ok(`every Posted Date is YYYY-MM-DD (${rows.filter((r) => r[idx.posted]).length} populated)`);
else bad(`${badPosted.length} Posted Date(s) are not ISO`, badPosted.slice(0, 3).map((r) => r[idx.posted]).join(', '));
const weekdayDates = rows.filter((r) => WEEKDAY.test(r[idx.posted] || '') || WEEKDAY.test(r[idx.deadline] || ''));
if (!weekdayDates.length) ok('no date rendered as a weekday string — the String(date).slice bug is absent');
else bad(`${weekdayDates.length} date(s) rendered as "Thu Nov 05" form`, weekdayDates[0][idx.posted]);
const badDeadline = rows.filter((r) => r[idx.deadline] && !ISO_DAY.test(r[idx.deadline]) && !ISO_MIN.test(r[idx.deadline]));
if (!badDeadline.length) ok('every Response Deadline is ISO day or "YYYY-MM-DD HH:MM UTC"');
else bad(`${badDeadline.length} deadline(s) malformed`, badDeadline.slice(0, 2).map((r) => r[idx.deadline]).join(' · '));
// A deadline carrying a time must say so, and one that does not must not pretend precision.
const timeMismatch = rows.filter((r) => {
  const hasT = r[idx.hasTime] === 'yes';
  const looksPrecise = ISO_MIN.test(r[idx.deadline] || '');
  return r[idx.deadline] && hasT !== looksPrecise;
});
if (!timeMismatch.length) ok('Deadline Has Time agrees with the rendered precision on every row');
else bad(`${timeMismatch.length} row(s) claim a time they do not render, or render one they do not claim`);
const past = rows.filter((r) => {
  const d = (r[idx.deadline] || '').slice(0, 10);
  return ISO_DAY.test(d) && d < new Date().toISOString().slice(0, 10);
});
if (past.length) note(`${past.length} row(s) have a deadline already in the past — expected as the set ages`);
else ok('no deadline is already past');

h('4. SOURCE LINKS');
const urls = rows.map((r) => r[idx.url]).filter(Boolean);
const badUrl = urls.filter((u) => { try { const x = new URL(u); return x.protocol !== 'https:'; } catch (_) { return true; } });
if (!badUrl.length) ok(`all ${urls.length} source links are syntactically valid https URLs`);
else bad(`${badUrl.length} malformed or non-https source link(s)`, badUrl.slice(0, 2).join(' '));
const samLinks = urls.filter((u) => /^https:\/\/sam\.gov\/opp\/[0-9a-f]{32}\/view$/.test(u));
if (samLinks.length === urls.length) ok('every link is a canonical sam.gov/opp/<32-hex>/view URL');
else note(`${urls.length - samLinks.length} link(s) are not the canonical sam.gov notice form`);
if (urls.length === rows.length) ok('every row carries a source link');
else bad(`${rows.length - urls.length} row(s) have no source link — ruling 21 item 3 requires them kept`);

h('5. MISSING VALUES ARE EMPTY, NOT INVENTED');
const valueCol = col('Estimated Value (USD)');
const ctCol = col('Contract Type');
const zeroes = rows.filter((r) => r[valueCol] === '0' || r[valueCol] === '0.00' || r[valueCol] === '$0');
if (!zeroes.length) ok('no Estimated Value rendered as 0 — absent and zero are different facts');
else bad(`${zeroes.length} row(s) show a zero value where the source said nothing`);
const emptyValue = rows.filter((r) => !r[valueCol]).length;
const emptyCt = rows.filter((r) => !r[ctCol]).length;
note(`Estimated Value empty on ${emptyValue}/${rows.length}, Contract Type empty on ${emptyCt}/${rows.length}`);
note('  both are NOT CARRIED by the SAM search index — empty here is the honest rendering');
const sentinels = rows.filter((r) => r.some((c) => /^(N\/A|NULL|undefined|NaN|Invalid Date|TBD)$/i.test(c)));
if (!sentinels.length) ok('no cell contains undefined, NaN, Invalid Date or a sentinel string');
else bad(`${sentinels.length} row(s) carry a sentinel value`, sentinels[0].find((c) => /undefined|NaN|Invalid/i.test(c)));

h('6. DUPLICATES AND AMENDMENTS');
const sols = rows.map((r) => r[idx.sol]);
const dupSol = sols.filter((s, i) => sols.indexOf(s) !== i);
if (!dupSol.length) ok('no solicitation number appears twice — only current versions are exported');
else bad(`${dupSol.length} duplicate solicitation number(s)`, [...new Set(dupSol)].slice(0, 3).join(', '));
const notices = rows.map((r) => r[idx.notice]).filter(Boolean);
const dupNotice = notices.filter((s, i) => notices.indexOf(s) !== i);
if (!dupNotice.length) ok('no notice id appears twice');
else note(`${[...new Set(dupNotice)].length} notice id(s) repeat — SAM itself carries duplicate postings`);
const amended = rows.filter((r) => Number(r[idx.version]) > 1);
if (amended.length) ok(`${amended.length} row(s) are amended versions (version > 1), and only the current one is present`);
else note('no amended versions in this export');
const badVersion = rows.filter((r) => !/^\d+$/.test(r[idx.version] || '') || Number(r[idx.version]) < 1);
if (!badVersion.length) ok('every row carries a positive integer version');
else bad(`${badVersion.length} row(s) have a malformed version`);

h('7. QUALIFICATION LABELS CANNOT MISLEAD');
const VERDICTS = new Set(['QUALIFIED', 'NOT_QUALIFIED', 'NEEDS_REVIEW', 'NOT ASSESSED']);
const badVerdict = rows.filter((r) => !VERDICTS.has(r[idx.verdict]));
if (!badVerdict.length) ok('every qualification label is one of the three verdicts or NOT ASSESSED');
else bad(`${badVerdict.length} unexpected qualification label(s)`, badVerdict[0][idx.verdict]);
// THE CONTROL RULING 22 ITEM 1 ASKED FOR, checked in the artifact rather than in the database.
const fixtureQualified = rows.filter((r) => r[idx.verdict] === 'QUALIFIED' && /FIXTURE/i.test(r[idx.basis] || ''));
if (!fixtureQualified.length) ok('no row is QUALIFIED on a FIXTURE basis — the label cannot be stripped by export');
else bad(`${fixtureQualified.length} row(s) export as QUALIFIED on fixture evidence`);
const qualified = rows.filter((r) => r[idx.verdict] === 'QUALIFIED');
if (!qualified.length) ok('0 rows QUALIFIED — consistent with an empty real capability registry');
else note(`${qualified.length} row(s) QUALIFIED — check the Verdict Basis column on each`);
const biddableNotBiddableType = rows.filter((r) => r[idx.biddable] === 'yes'
  && !/^(solicitation|combined_synopsis)$/.test(r[idx.type]));
if (!biddableNotBiddableType.length) ok('nothing is marked biddable that is not a solicitation or combined synopsis');
else bad(`${biddableNotBiddableType.length} non-biddable notice type(s) marked biddable`, biddableNotBiddableType[0][idx.type]);
const biddableUnconfirmed = rows.filter((r) => r[idx.biddable] === 'yes' && r[idx.confirmed] !== 'yes');
if (!biddableUnconfirmed.length) ok('nothing is biddable without a confirmed deadline');
else bad(`${biddableUnconfirmed.length} row(s) biddable with an unconfirmed deadline`);

h('8. THE HARVEST TIMESTAMP TRAVELS WITH THE DATA');
if (fs.existsSync(SUMMARY)) {
  const S = JSON.parse(fs.readFileSync(SUMMARY, 'utf8'));
  const p = S.provenance || {};
  for (const [k, label] of [['harvested_at', 'harvest timestamp'], ['harvest_route', 'source route'],
    ['route_status', 'route caveat'], ['fixture_sha256', 'input sha256']]) {
    if (p[k]) ok(`${label}: ${String(p[k]).slice(0, 72)}`);
    else bad(`provenance is missing ${label}`);
  }
  if ((p.unconfirmed_fields || []).length) ok(`${p.unconfirmed_fields.length} field(s) explicitly listed as unconfirmed`);
  else bad('provenance does not distinguish confirmed from unconfirmed fields');
  if (S.generated_at) ok(`export generated_at ${S.generated_at}`);
  else bad('no generation timestamp');
} else bad(`no summary.json beside the CSV at ${SUMMARY} — provenance cannot be checked`);

console.log(`\n${bar()}`);
console.log(`  ${pass} check(s) passed · ${fail} failed · ${warn} note(s)`);
if (fail) { console.log('\nFAIL  the exported CSV does not validate.\n'); process.exit(1); }
console.log('\nPASS  the export opens correctly in Excel, executes nothing, invents nothing, and');
console.log('      carries its own provenance. Validated by an independent parser.\n');
