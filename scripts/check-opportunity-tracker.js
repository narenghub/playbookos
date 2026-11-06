#!/usr/bin/env node
// ── THE TRACKER'S GUARDS, PROVED BY ATTEMPTING WHAT THEY FORBID ──────────────
//
//   node scripts/check-opportunity-tracker.js
//
// Pure: no database, no network. The database behaviour (versioning, the partial unique index,
// the generated is_biddable column) is proved by scripts/prpa-tracker-demo.js against a disposable
// cluster on real data.
'use strict';

const C = require('../src/lib/office/opportunity-csv');
const N = require('../src/lib/office/opportunity-normalize');
const Q = require('../src/lib/office/opportunity-qualify');
const T = require('../src/lib/office/opportunity-tracker');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 240)}`); };
const bar = () => '─'.repeat(78);
const h = (t) => console.log(`\n${bar()}\n${t}\n${bar()}`);
const refused = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

h('1. THE EXPORT CANNOT HAND EXCEL A FORMULA');
// A CSV export is normally assumed inert. It is not: Excel evaluates a cell starting with = + - @
// as a formula, and this data is imported from files third parties produce.
for (const hostile of ['=cmd|\' /c calc\'!A1', '+1+1', '-2+3', '@SUM(A1)', '\tleading tab']) {
  const c = C.cell(hostile);
  if (c.startsWith('"\'') && C.wouldNeutralise(hostile)) ok(`${JSON.stringify(hostile.slice(0, 18))} → neutralised`);
  else bad(`${JSON.stringify(hostile)} was exported unneutralised`, c);
}
if (!C.wouldNeutralise('36C25027Q0032') && C.cell('36C25027Q0032') === '"36C25027Q0032"') {
  ok('an ordinary solicitation number is NOT mangled — the guard is narrow');
} else bad('a normal value was altered');
{
  const csv = C.toExcelCsv([{ key: 'a', label: 'A' }], [{ a: 'x' }]);
  if (csv.charCodeAt(0) === 0xfeff) ok('UTF-8 BOM present, so Excel on Windows reads it as UTF-8');
  else bad('no BOM — non-ASCII agency names would render as mojibake');
  if (csv.includes('\r\n')) ok('CRLF line endings');
  else bad('no CRLF');
}
{
  // A long all-digit identifier loses precision as a number; a leading zero disappears entirely.
  const c1 = C.cell('0123456', { forceText: true });
  const c2 = C.cell('1234567890123456789', { forceText: true });
  if (c1.startsWith('"\'') && c2.startsWith('"\'')) ok('long/leading-zero numeric identifiers forced to text');
  else bad('a numeric identifier would be mangled by Excel', `${c1} ${c2}`);
}

h('2. THE PARSER REFUSES MALFORMED INPUT RATHER THAN GUESSING');
{
  const { headers, rows } = C.parseCsv('a,b\r\n"x,1","y\nz"\r\n');
  if (headers.length === 2 && rows[0].a === 'x,1' && rows[0].b === 'y\nz') {
    ok('quoted fields carrying commas and newlines survive intact');
  } else bad('quoted field parsing is wrong', JSON.stringify(rows[0]));
}
{
  const { rows } = C.parseCsv('a\r\n"say ""hi"""\r\n');
  if (rows[0].a === 'say "hi"') ok('doubled quotes unescape correctly');
  else bad('quote unescaping is wrong', rows[0].a);
}
for (const [input, why] of [
  ['a,b\r\n1\r\n', 'a row with too few fields'],
  ['a,b\r\n1,2,3\r\n', 'a row with too many fields'],
  ['a,a\r\n1,2\r\n', 'a duplicate header'],
  ['a,\r\n1,2\r\n', 'an empty header cell'],
  ['a\r\n"unterminated\r\n', 'an unterminated quoted field'],
]) {
  const e = refused(() => C.parseCsv(input));
  if (e) ok(`${why} → REFUSED`);
  else bad(`${why} was accepted — a shifted row imports one column into another`);
}

h('3. NORMALISATION NEVER INVENTS A VALUE');
for (const [v, why] of [['', 'empty'], ['TBD', 'TBD'], ['soon', 'prose'], ['Q3', 'a quarter']]) {
  const r = N.parseDate(v);
  if (r.value === null) ok(`date ${JSON.stringify(v)} → null${r.issue ? ' with a reason' : ''}`);
  else bad(`date ${JSON.stringify(v)} produced ${r.value}`);
}
if (N.parseDate('2026-11-09').value === '2026-11-09') ok('a real ISO date parses');
else bad('a real date failed to parse');
if (N.parseDate('11/09/2026').value === '2026-11-09') ok('US format parses');
else bad('US date format failed');
if (N.parseDate('2026-02-30').value === null) ok('2026-02-30 is refused as not a real date');
else bad('an impossible date was accepted');
for (const [v, why] of [['', 'empty'], ['N/A', 'N/A'], ['see attachment', 'prose'], ['-5', 'negative']]) {
  const r = N.parseMoney(v);
  if (r.value === null) ok(`value ${JSON.stringify(v)} → null, NOT zero (${why})`);
  else bad(`value ${JSON.stringify(v)} produced ${r.value}`);
}
if (N.parseMoney('$1,250,000.50').value === 1250000.5) ok('a formatted dollar amount parses');
else bad('a real money value failed');
// The one that matters most: an unrecognised notice type must never become biddable.
for (const [v, exp] of [['Award Notice', 'award'], ['Sources Sought', 'sources_sought'],
  ['Combined Synopsis/Solicitation', 'combined_synopsis'], ['Presolicitation', 'presolicitation'],
  ['Something New', 'unknown'], ['', 'unknown']]) {
  const r = N.parseNoticeType(v);
  if (r.value === exp) ok(`notice type ${JSON.stringify(v || '(blank)')} → ${exp}`);
  else bad(`notice type ${JSON.stringify(v)} → ${r.value}, expected ${exp}`);
}
if (N.parseNoticeType('Something New').value !== 'solicitation') {
  ok('an UNRECOGNISED type never becomes "solicitation" — that would make an award biddable');
} else bad('an unknown type defaulted to solicitation');
for (const [v, why] of [['12345', 'five digits'], ['abcdef', 'letters'], ['', 'empty']]) {
  if (N.parseNaics(v).value === null) ok(`NAICS ${JSON.stringify(v)} → null (${why})`);
  else bad(`NAICS ${JSON.stringify(v)} was accepted`);
}
if (N.parseNaics('541380').value === '541380') ok('a real NAICS parses');
else bad('a real NAICS failed');

h('4. MULTI-COLUMN FIELDS TAKE THE FIRST NON-BLANK, IN PRIORITY ORDER');
// SAM exports both SetASide (text) and SetASideCode. Keeping only one header per field meant the
// empty code column won and every set-aside was blank on real data.
{
  const { mapping, unmatched } = N.mapHeaders(['Sol#', 'Department/Ind.Agency', 'SetASideCode', 'SetASide', 'Title']);
  if ((mapping.solicitation_number || []).includes('Sol#')) ok("SAM's `Sol#` maps to solicitation_number");
  else bad('Sol# did not map — records would fall back to the notice id, which changes per amendment');
  if ((mapping.agency || []).includes('Department/Ind.Agency')) ok('`Department/Ind.Agency` maps to agency');
  else bad('the real agency column did not map');
  if ((mapping.set_aside || []).length === 2 && mapping.set_aside[0] === 'SetASide') {
    ok('both set-aside columns kept, descriptive one first');
  } else bad('set-aside columns were discarded or mis-ordered', JSON.stringify(mapping.set_aside));
  const r = N.normalizeRow({ 'Sol#': 'X1', Title: 'T', SetASideCode: '', SetASide: 'Total Small Business', __row: 2 }, mapping);
  if (r.record && r.record.set_aside === 'Total Small Business') ok('the blank code column is skipped for the populated one');
  else bad('set_aside came out blank', JSON.stringify(r.record && r.record.set_aside));
  if (!unmatched.length) ok('no header left unmatched');
}
{
  const m = N.mapHeaders(['Sol#', 'Title']).mapping;
  const a = N.normalizeRow({ 'Sol#': 'X', Title: 'T', __row: 2 }, m);
  const b = N.normalizeRow({ 'Sol#': 'X', Title: 'T', __row: 9 }, m);
  if (a.record.content_hash === b.record.content_hash) ok('the content hash ignores row position — re-imports stay idempotent');
  else bad('identical content hashed differently');
  const c = N.normalizeRow({ 'Sol#': 'X', Title: 'T (Amendment 1)', __row: 2 }, m);
  if (c.record.content_hash !== a.record.content_hash) ok('changed content hashes differently — an amendment is detectable');
  else bad('changed content hashed identically');
}
{
  const m = N.mapHeaders(['Sol#', 'Title']).mapping;
  const r = N.normalizeRow({ 'Sol#': '', Title: 'T', __row: 2 }, m);
  if (r.rejected) ok('a row with no identity is REJECTED, not imported with a generated id');
  else bad('an unidentifiable row was imported');
}

h('5. DATES ARE COERCED, NEVER String().slice() — REGRESSION');
// Postgres hands back a Date. String(new Date()).slice(0,10) is "Mon Nov 09", which compares
// GREATER than "2026-12-30" because "M" > "2". The first real run therefore told us every
// opportunity needed the SAM registration renewed, and the deadline-has-passed check could never
// fire. Both were confident, plausible, wrong business advice.
{
  const d = new Date('2026-11-09T20:00:00Z');
  if (Q.isoDay(d) === '2026-11-09') ok('a Date object coerces to an ISO day');
  else bad('Date coercion is wrong', Q.isoDay(d));
  if (String(d).slice(0, 10) > '2026-12-30') ok('…and the naive String().slice() really is wrong — proved, not asserted');
  else bad('the regression premise no longer holds; revisit this test');
  if (Q.isoDay(d) < '2026-12-30') ok('the coerced value compares correctly against the registration expiry');
  else bad('coerced comparison is still wrong');
  for (const v of [null, undefined, '', 'nonsense', new Date('x')]) {
    if (Q.isoDay(v) === null) ok(`isoDay(${JSON.stringify(String(v).slice(0, 12))}) → null`);
    else bad(`isoDay produced ${Q.isoDay(v)}`);
  }
}

h('6. QUALIFICATION: INDICATIVE EVIDENCE NEVER QUALIFIES');
const base = {
  notice_type: 'solicitation', status: 'open', naics_code: '541380',
  response_deadline: '2026-12-01T00:00:00Z', deadline_confirmed_at: '2026-11-06T00:00:00Z',
  title: 'Analytical testing services', set_aside: null,
};
const TODAY = '2026-11-06';
const cap = (o) => Object.assign({ id: 'c1', kind: 'capability', business_line: 'analytical_services', name: 'c' }, o);
for (const cls of ['catalog_listing', 'synthesis_prediction', 'supplier_relationship']) {
  const r = Q.assess(base, [cap({ evidence_class: cls })], { today: TODAY });
  if (r.verdict === 'NEEDS_REVIEW' && r.missing_requirements.length) ok(`${cls} alone → NEEDS_REVIEW, missing named`);
  else bad(`${cls} produced ${r.verdict}`, JSON.stringify(r));
}
{
  const r = Q.assess(base, [cap({ evidence_class: 'method_validated' })], { today: TODAY });
  if (r.verdict === 'QUALIFIED' && r.evidence_capability_ids.length) ok('a sufficient class DOES qualify, naming its evidence');
  else bad(`sufficient evidence produced ${r.verdict}`, JSON.stringify(r));
}
{
  const r = Q.assess(base, [cap({ evidence_class: 'accreditation', valid_until: '2026-01-01' })], { today: TODAY });
  if (r.verdict === 'NEEDS_REVIEW' && r.reasons.some((x) => /EXPIRED/.test(x))) ok('EXPIRED sufficient evidence → NEEDS_REVIEW, not QUALIFIED');
  else bad(`expired evidence produced ${r.verdict}`, JSON.stringify(r.reasons));
}
{
  const r = Q.assess({ ...base, notice_type: 'award' }, [cap({ evidence_class: 'method_validated' })], { today: TODAY });
  if (r.verdict === 'NOT_QUALIFIED') ok('an AWARD notice → NOT_QUALIFIED whatever the evidence says');
  else bad(`an award produced ${r.verdict}`);
}
{
  const r = Q.assess({ ...base, notice_type: 'sources_sought' }, [cap({ evidence_class: 'method_validated' })], { today: TODAY });
  if (r.verdict === 'NOT_QUALIFIED' && /market research/i.test(r.reasons[0])) ok('SOURCES SOUGHT → NOT_QUALIFIED, and says why');
  else bad(`sources sought produced ${r.verdict}`);
}
{
  const r = Q.assess({ ...base, response_deadline: '2026-10-01T00:00:00Z' }, [cap({ evidence_class: 'method_validated' })], { today: TODAY });
  if (r.verdict === 'NOT_QUALIFIED' && /passed/.test(r.reasons[0])) ok('a deadline already passed → NOT_QUALIFIED');
  else bad(`a passed deadline produced ${r.verdict}`, JSON.stringify(r.reasons));
}
{
  const r = Q.assess({ ...base, deadline_confirmed_at: null }, [cap({ evidence_class: 'method_validated' })], { today: TODAY });
  if (r.verdict === 'NEEDS_REVIEW' && r.missing_requirements.some((m) => /confirmation/.test(m))) {
    ok('an unconfirmed deadline holds the verdict at NEEDS_REVIEW even with sufficient evidence');
  } else bad(`unconfirmed deadline produced ${r.verdict}`);
}

h('7. A SET-ASIDE WE CANNOT MEET IS A HARD NO; A LAPSED REGISTRATION IS NOT');
{
  const r = Q.assess({ ...base, set_aside: 'Service-Disabled Veteran-Owned Small Business (SDVOSB) Set-Aside' },
    [cap({ evidence_class: 'method_validated' })], { today: TODAY });
  if (r.verdict === 'NOT_QUALIFIED' && r.missing_requirements.some((m) => /Service-Disabled/.test(m))) {
    ok('an SDVOSB set-aside without the certification → NOT_QUALIFIED, certification named');
  } else bad(`set-aside produced ${r.verdict}`, JSON.stringify(r));
}
{
  // Ruling 15 item 9: a future expiry that can be renewed is NOT a permanent disqualification.
  const r = Q.assess({ ...base, response_deadline: '2027-03-01T00:00:00Z' },
    [cap({ evidence_class: 'method_validated' })], { today: TODAY, samRegistrationExpires: '2026-12-30' });
  if (r.verdict === 'NEEDS_REVIEW' && r.reasons.some((x) => /NOT a disqualification/.test(x))) {
    ok('a deadline after the SAM expiry → NEEDS_REVIEW, explicitly not a disqualification');
  } else bad(`post-expiry deadline produced ${r.verdict}`, JSON.stringify(r.reasons));
  const r2 = Q.assess({ ...base, response_deadline: '2027-03-01T00:00:00Z' },
    [cap({ evidence_class: 'method_validated' })], { today: TODAY, samRegistrationExpires: '2026-12-30', registrationRenewed: true });
  if (r2.verdict === 'QUALIFIED') ok('…and once renewed, the same opportunity qualifies');
  else bad(`renewed registration still produced ${r2.verdict}`, JSON.stringify(r2.missing_requirements));
}
{
  const r = Q.assess({ ...base, naics_code: '111110', title: 'Lawn mowing', description: '' },
    [cap({ evidence_class: 'method_validated' })], { today: TODAY });
  if (r.verdict === 'NOT_QUALIFIED' && /business line/.test(r.reasons[0])) ok('an opportunity outside every Abiozen line → NOT_QUALIFIED');
  else bad(`an out-of-scope opportunity produced ${r.verdict}`, JSON.stringify(r.reasons));
}
{
  const r = Q.assess(base, [], { today: TODAY });
  if (r.verdict !== 'QUALIFIED' && r.evidence_capability_ids.length === 0) {
    ok('an EMPTY capability registry can never produce QUALIFIED — Abiozen\'s actual state');
  } else bad(`an empty registry produced ${r.verdict}`);
}

h('8. THE NAIVE DATE COERCION CANNOT COME BACK');
// It has been wrong twice: once in the qualification engine, once in the capability gap report.
// Both times it produced confident wrong advice rather than an error. A sweep is cheaper than a
// third occurrence.
{
  const fsx = require('fs'); const pathx = require('path');
  const dir = pathx.join(__dirname, '..', 'src', 'lib', 'office');
  const offenders = [];
  for (const f of fsx.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    if (f === 'iso-day.js') continue;                     // the one place that may discuss it
    const src = fsx.readFileSync(pathx.join(dir, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    // String(<anything date-ish>).slice(0, 10) — the exact shape that broke twice.
    const re = /String\(\s*[A-Za-z_$][\w.$]*(valid_to|valid_until|deadline|_at|_date|date)[\w.$]*\s*\)\s*\.slice\(\s*0\s*,\s*10\s*\)/i;
    if (re.test(src)) offenders.push(f);
  }
  if (!offenders.length) ok('no String(<date>).slice(0,10) anywhere in src/lib/office');
  else bad('the naive date coercion is back', offenders.join(', '));
  const iso = require('../src/lib/office/iso-day');
  if (iso.isoDay(new Date('2026-01-01')) === '2026-01-01') ok('the shared isoDay handles a Date');
  else bad('shared isoDay is wrong');
  if (!iso.onOrBefore(null, '2026-11-06') && !iso.onOrAfter(null, '2026-11-06')) {
    ok('a NULL date is neither past nor future — it is unknown, and both helpers say so');
  } else bad('a null date was treated as a real one');
}

h('8. DUPLICATE DETECTION IS ADVISORY, NOT A MERGE');
if (T.titleSimilarity('Blood Type IVD Reagents', 'Blood Type IVD Reagents') === 1) ok('identical titles score 1');
else bad('identical titles did not score 1');
if (T.titleSimilarity('Reagents for Roche', 'Lawn mowing services') < 0.2) ok('unrelated titles score low');
else bad('unrelated titles scored high');
if (T.titleSimilarity('', 'anything') === 0) ok('an empty title scores 0 rather than dividing by zero');
else bad('empty title similarity is wrong');

h('9. RANKING ORDERS ATTENTION, AND NEVER OUTRANKS AN ELIGIBILITY BAR');
{
  const RK = require('../src/lib/office/opportunity-rank');
  const T0 = '2026-11-06';
  const base = { solicitation_number: 'X1', notice_type: 'solicitation', status: 'open',
    response_deadline: '2026-11-26T00:00:00Z', business_lines: ['molecule_commerce'],
    verdict: 'NEEDS_REVIEW', title: 'Reference standards', estimated_value_usd: null };

  // A barred item must sort below an unattractive but eligible one, however large it is.
  const barred = { ...base, solicitation_number: 'BARRED', estimated_value_usd: 50000000 };
  const ver = { BARRED: { eligible: false, bar: 'SDVOSB set-aside' } };
  const order = RK.rankAll([barred, { ...base, solicitation_number: 'OK' }], { today: T0, verification: ver });
  if (order[0].solicitation_number === 'OK' && order[1].ranking.tier === 'BARRED') {
    ok('an ineligible $50M opportunity sorts BELOW an eligible one — a bar is a floor, not a penalty');
  } else bad('a barred opportunity outranked an eligible one', order.map((o) => o.solicitation_number).join(','));

  for (const [t, why] of [['award', 'an award notice'], ['special_notice', 'a special notice'],
    ['justification', 'a sole-source justification']]) {
    const r = RK.rank({ ...base, notice_type: t }, { today: T0 });
    if (r.bars.some((b) => b.kind === RK.BAR_KINDS.NOT_BIDDABLE)) ok(`${why} → BARRED`);
    else bad(`${why} was not barred`, JSON.stringify(r.bars));
  }
  // A sources sought is NOT barred — responding is how you reach the RFP.
  for (const [t, tier] of [['sources_sought', 'MARKET ENTRY'], ['presolicitation', 'MARKET ENTRY']]) {
    const r = RK.rank({ ...base, notice_type: t }, { today: T0 });
    if (!r.bars.length && r.ranking === undefined && r.tier === tier) ok(`${t} → ${tier}, not barred`);
    else if (!r.bars.length && r.tier === tier) ok(`${t} → ${tier}, not barred`);
    else bad(`${t} was barred or mis-tiered`, `${r.tier} bars=${JSON.stringify(r.bars)}`);
  }
  {
    // …and it still sorts below real biddable work.
    const se = { ...base, solicitation_number: 'SS', notice_type: 'sources_sought' };
    const sol = { ...base, solicitation_number: 'SOL' };
    const o = RK.rankAll([se, sol], { today: T0 });
    if (o[0].solicitation_number === 'SOL') ok('market-entry items sort below biddable solicitations');
    else bad('a sources sought outranked a solicitation');
  }
  {
    const r = RK.rank({ ...base, response_deadline: '2026-10-01T00:00:00Z' }, { today: T0 });
    if (r.bars.some((b) => b.kind === RK.BAR_KINDS.DEADLINE_PASSED)) ok('a passed deadline → BARRED');
    else bad('a passed deadline was not barred');
  }
  // MARGIN: never scored without both a value and a quote, and it says why.
  {
    const r = RK.rank(base, { today: T0 });
    if (r.components.margin === 0 && r.notes.some((n) => /MARGIN NOT SCORED/.test(n))) {
      ok('margin scores 0 and states WHY, rather than being silently dropped');
    } else bad('margin was scored without a value', JSON.stringify(r.components));
    const r2 = RK.rank({ ...base, estimated_value_usd: 250000 }, { today: T0 });
    if (r2.components.margin === 0 && r2.notes.some((n) => /MARGIN NOT SCORED/.test(n))) {
      ok('a contract VALUE alone still does not produce a margin — that is revenue, not margin');
    } else bad('a value alone produced a margin score', JSON.stringify(r2.notes.filter((n) => /MARGIN/.test(n))));
  }
  // Verified capability is the only route to the top band, and it is currently unreachable.
  {
    const nr = RK.rank(base, { today: T0 });
    const qd = RK.rank({ ...base, verdict: 'QUALIFIED' }, { today: T0 });
    if (qd.score > nr.score) ok('a QUALIFIED verdict scores above NEEDS_REVIEW');
    else bad('verified capability did not raise the score');
    if (nr.notes.some((n) => /no verified capability/.test(n))) ok('…and NEEDS_REVIEW says so in its notes');
    else bad('a NEEDS_REVIEW rank did not explain itself');
  }
  // SUPERSEDED BY RULING 24. This previously asserted that a brand-name hint raises risk but does
  // NOT bar, on the reasoning that 36C25627Q0074 is a Roche buy with no OEM requirement — which is
  // true about ELIGIBILITY and irrelevant to FULFILMENT. We cannot source Roche consumables
  // whether or not the notice demands an authorization letter, so the correct behaviour is a bar.
  // The old assertion was not wrong about eligibility; it was answering the wrong question.
  {
    const r = RK.rank({ ...base, title: 'Roche Ventana reagents and consumables' }, { today: T0 });
    if (r.bars.some((b) => b.kind === RK.BAR_KINDS.NOT_FEASIBLE)) {
      ok('a named-OEM consumable buy is BARRED on fulfilment, independently of eligibility');
    } else bad('an OEM consumable buy was not barred', JSON.stringify(r.bars));
  }
  // Sole-source language is a bar; "brand name or equal" is not.
  for (const t of ['Notice of Intent to Sole Source', 'The Government intends to award on a non-competitive basis',
    'Only one responsible source and no other supplies will satisfy', 'Sole source to Alcami Corporation']) {
    const r = RK.rank({ ...base, title: t }, { today: T0 });
    if (r.bars.some((b) => b.kind === RK.BAR_KINDS.SOLE_SOURCE)) ok(`"${t.slice(0, 38)}…" → BARRED as sole source`);
    else bad(`sole-source language was not barred: ${t}`, JSON.stringify(r.bars));
  }
  // Also superseded, and the distinction is worth keeping explicit: "brand name or equal" means
  // equivalents are INVITED, so it is not a sole-source bar — but a dilatometer is instrument
  // hardware, which Abiozen cannot supply through a chemical channel. Not barred for the reason it
  // used to be tested for; barred for a different and correct one.
  {
    const r = RK.rank({ ...base, title: 'Brand Name or Equal NETZSCH Dil 502 Supreme dilatometer' }, { today: T0 });
    if (!r.bars.some((b) => b.kind === RK.BAR_KINDS.SOLE_SOURCE)) {
      ok('"brand name or equal" is NOT a sole-source bar — equivalents are invited');
    } else bad('an "or equal" notice was barred as sole source', JSON.stringify(r.bars));
    if (r.bars.some((b) => b.kind === RK.BAR_KINDS.NOT_FEASIBLE)) {
      ok('…but it IS barred on fulfilment: instrument hardware needs a dealer agreement');
    } else bad('instrument hardware was not barred on fulfilment');
  }
  {
    const soon = RK.rank({ ...base, response_deadline: '2026-11-08T00:00:00Z' }, { today: T0 });
    if (soon.notes.some((n) => /too little time/.test(n))) ok('a deadline 2 days out is flagged as too little time');
    else bad('an imminent deadline was not flagged');
  }
}

h('10. ELIGIBLE IS NOT FULFILLABLE (ruling 24 items 3, 4, 6)');
{
  const F = require('../src/lib/office/fulfillment-feasibility');
  const RK = require('../src/lib/office/opportunity-rank');
  const T1 = '2026-11-06';
  const open = { notice_type: 'solicitation', status: 'open', set_aside: null,
    response_deadline: '2026-12-15T00:00:00Z', estimated_value_usd: null };

  // THE CASE THIS EXISTS FOR: unrestricted, NAICS-matched, says "reagent", and unfulfillable.
  const roche = { ...open, solicitation_number: 'ROCHE', naics_code: '325413', psc_code: '6550',
    title: '6550-- Roche Ventana Reagents IDIQ', description: 'reagents for the existing Roche Ventana stainers' };
  const fr = F.assessFeasibility(roche, { today: T1 });
  if (fr.verdict === 'NOT_FEASIBLE' && fr.product_class === 'oem_diagnostic_consumable') {
    ok('an unrestricted, NAICS-matched "reagent" buy from a named OEM → NOT_FEASIBLE');
  } else bad(`the Roche case came out ${fr.verdict} / ${fr.product_class}`);
  if (fr.checks.supplier_availability.status === 'blocked'
      && /small-molecule/i.test(fr.checks.supplier_availability.detail)) {
    ok('…and supplier_availability is BLOCKED, naming the channel that does not reach it');
  } else bad('supplier availability did not block', JSON.stringify(fr.checks.supplier_availability));
  if (fr.confidence === 0) ok('a blocked check collapses confidence to 0');
  else bad(`confidence was ${fr.confidence} despite a blocker`);

  // Ruling 24 item 6 stated as an assertion: a chemical supplier never fills an OEM order.
  for (const m of ['Abbott Architect', 'Beckman Coulter', 'Cepheid GeneXpert', 'bioMerieux Vitek', 'Bio-Rad']) {
    const r = F.assessFeasibility({ ...open, solicitation_number: m, title: `${m} reagents and consumables` }, { today: T1 });
    if (r.verdict === 'NOT_FEASIBLE') ok(`${m} consumables → NOT_FEASIBLE`);
    else bad(`${m} was judged ${r.verdict}`);
  }
  {
    const r = F.assessFeasibility({ ...open, solicitation_number: 'INS', title: 'Brand Name or Equal NETZSCH Dil 502 Supreme dilatometer' }, { today: T1 });
    if (r.verdict === 'NOT_FEASIBLE' && r.product_class === 'instrument_hardware') {
      ok('instrument hardware → NOT_FEASIBLE, a dealer agreement not a chemical supply chain');
    } else bad(`instrument came out ${r.verdict}/${r.product_class}`);
  }

  // The positive control: something inside the channel is UNPROVEN, not feasible, and not blocked.
  {
    const r = F.assessFeasibility({ ...open, solicitation_number: 'SYN',
      title: 'Synthesis and Distribution of Drugs of Abuse and Related Compounds',
      description: 'custom synthesis of reference standards' }, { today: T1 });
    if (r.verdict === 'UNPROVEN' && !r.blockers.length) ok('a custom-synthesis buy → UNPROVEN, not blocked');
    else bad(`custom synthesis came out ${r.verdict}`, JSON.stringify(r.blockers));
    if (r.checks.supplier_availability.status === 'unknown'
        && /NO SUPPLIER QUOTE/i.test(r.checks.supplier_availability.detail)) {
      ok('…and it is UNKNOWN rather than ok, because no supplier quote exists');
    } else bad('in-channel availability claimed OK without a quote', JSON.stringify(r.checks.supplier_availability));
  }

  // All seven named checks exist, and UNKNOWN never reads as a pass.
  const need = ['proprietary_oem', 'oem_authorization', 'supplier_availability',
    'minimum_order_quantity', 'fulfilment_lead_time', 'required_certifications', 'estimated_gross_margin'];
  const got = Object.keys(F.assessFeasibility({ ...open, solicitation_number: 'Z', title: 'something' }, { today: T1 }).checks);
  const missing = need.filter((n) => !got.includes(n));
  if (!missing.length) ok(`all seven ruling-24 checks are present (${got.length})`);
  else bad('missing check(s)', missing.join(', '));
  {
    const r = F.assessFeasibility({ ...open, solicitation_number: 'U', title: 'Miscellaneous supplies' }, { today: T1 });
    if (r.verdict !== 'FEASIBLE') ok('an unclassifiable notice is never FEASIBLE — unknown is not a pass');
    else bad('an unknown product class was judged feasible');
  }
  // Margin is never invented.
  {
    const r = F.assessFeasibility({ ...open, solicitation_number: 'M', title: 'research chemicals', estimated_value_usd: 500000 }, { today: T1 });
    if (r.checks.estimated_gross_margin.status === 'unknown' && /no supplier quote/i.test(r.checks.estimated_gross_margin.detail)) {
      ok('a contract value with no supplier quote → margin UNKNOWN, not a guess');
    } else bad('margin was estimated without a cost', JSON.stringify(r.checks.estimated_gross_margin));
    const r2 = F.assessFeasibility({ ...open, solicitation_number: 'M2', title: 'research chemicals', estimated_value_usd: 100000 },
      { today: T1, supplierQuotes: { M2: { cost: 70000 } } });
    if (r2.checks.estimated_gross_margin.status === 'ok' && Math.abs(r2.checks.estimated_gross_margin.value - 0.3) < 1e-9) {
      ok('with BOTH a value and a quote, margin is computed (30%) — the check is a gate, not a wall');
    } else bad('margin was not computed when both sides existed', JSON.stringify(r2.checks.estimated_gross_margin));
  }
  // An empty certification registry cannot satisfy a stated certification requirement.
  {
    const r = F.assessFeasibility({ ...open, solicitation_number: 'C', title: 'analytical testing services',
      description: 'laboratory must hold ISO 17025 accreditation' }, { today: T1, capabilities: [] });
    if (r.checks.required_certifications.status === 'blocked') ok('a stated ISO requirement against an empty registry → BLOCKED');
    else bad('a certification requirement passed with no certifications held', JSON.stringify(r.checks.required_certifications));
  }
  // And the ranking must bar it, not merely dock points.
  {
    const r = RK.rank(roche, { today: T1 });
    if (r.bars.some((b) => b.kind === RK.BAR_KINDS.NOT_FEASIBLE)) ok('the ranker BARS an unfulfillable notice rather than docking it');
    else bad('an unfulfillable notice was only penalised', JSON.stringify(r.bars));
    if (r.score === 0) ok('…and its score floors at 0 rather than going negative');
    else bad(`barred score was ${r.score}`);
  }
}

// ── 11. THE RESEARCH-CHEMICAL / CLINICAL-DIAGNOSTIC LINE (ruling 24 item 6) ───
// "Do not infer that BLDpharm, ChemScene, or other chemical suppliers can fulfill Roche, Abbott, or
// similar OEM-specific orders." The word that breaks this is "reagent": it appears in both trades,
// and the research_chemical pattern matches it. These cases are the ones that were misread on the
// real board, kept here so a later widening of the chemical patterns cannot quietly re-break them.
{
  // Required here rather than relied on from section 10: those bindings are block-scoped, and
  // reaching for them across blocks is what threw ReferenceError the last two times.
  const F = require('../src/lib/office/fulfillment-feasibility.js');
  const RK = require('../src/lib/office/opportunity-rank.js');
  const T1 = '2026-11-06';
  const open = { notice_type: 'solicitation', status: 'open', response_deadline: '2026-12-10' };

  const cases = [
    ['Flow Cytometry Reagents', 'RFI for flow cytometry reagents for the clinical laboratory',
      'clinical_diagnostic_consumable', 'a flow-cytometry reagent buy is NOT a research chemical'],
    ['6550--VISN 4 Coagulation Testing', 'coagulation testing reagents and controls for VISN 4 laboratories',
      'clinical_diagnostic_consumable', 'coagulation reagents classify as clinical diagnostics, not chemicals'],
    ['6505--MVAHCS FDG Radiopharmaceutical', 'requires FDG (Fluorodeoxyglucose F18) with the salient characteristics below',
      'radiopharmaceutical', 'FDG classifies as a radiopharmaceutical, not a 6505 pharmaceutical to source'],
    ['H365--ANNUAL MEDICAL GAS TESTING', 'annual medical gas testing and certification at the medical center',
      'facility_service', 'medical gas testing classifies as a facility service'],
    ['JBA Deicer IDIQ', 'indefinite delivery contract for runway deicer',
      'facility_service', 'the deicer IDIQ classifies as a facility service, not a chemical buy'],
    ['68--AMMONIUM HYDROXIDE', 'ammonium hydroxide, reagent grade chemical, bulk',
      'research_chemical', 'a genuine bulk chemical still classifies as research_chemical'],
    // A three-letter word must not decide a product class. "TIP" is NSF's Directorate for
    // Technology, Innovation and Partnerships, and it classified a funding announcement as a
    // consumables buy, which put it in the wave-1 top ten.
    ['NSF X-Labs Initiative - From Sequence to Function',
      'The NSF Directorate for Technology, Innovation and Partnerships (TIP) announces its intent to solicit proposals',
      'unknown', 'the acronym TIP no longer reads as a pipette tip'],
    ['Pipette tips and centrifuge tubes', 'bulk laboratory consumables',
      'lab_consumable_generic', '…while a real pipette tip still classifies as a consumable'],
    ['Building America Subject Matter Expert Technical Support',
      'help buildings industry stakeholders scale up new construction and building envelope retrofits',
      'unrelated', 'a buildings-industry contract classifies as another industry, not a chemical buy'],
  ];
  for (const [title, description, expect, label] of cases) {
    const got = F.classifyProduct({ title, description }).product_class;
    if (got === expect) ok(label);
    else bad(`${label} — expected ${expect}, got ${got}`, `${title}`);
  }

  // Each out-of-reach class must BAR, not merely dock. A class that classifies correctly but still
  // scores is the same false green in a different place.
  for (const cls of ['clinical_diagnostic_consumable', 'radiopharmaceutical', 'facility_service', 'unrelated']) {
    const [title, description] = cases.find((c) => c[2] === cls);
    const opp = { ...open, solicitation_number: `X-${cls}`, title, description, business_lines: ['molecule_commerce'] };
    const f = F.assessFeasibility(opp, { today: T1, capabilities: [] });
    if (f.verdict === 'NOT_FEASIBLE') ok(`${cls} → NOT_FEASIBLE`);
    else bad(`${cls} was not NOT_FEASIBLE`, f.verdict);
    const r = RK.rank(opp, { today: T1 });
    if (r.bars.some((b) => b.kind === RK.BAR_KINDS.NOT_FEASIBLE)) ok(`…and the ranker bars it`);
    else bad(`${cls} ranked without a feasibility bar`, JSON.stringify(r.bars));
  }

  // A blank set-aside field must not read as "unrestricted" when the notice body says otherwise.
  // SAM's search index did exactly this for N0010426REJ97, and the engine scored it as open.
  {
    const base = { ...open, solicitation_number: 'SA-1', title: '68--AMMONIUM HYDROXIDE',
      description: 'NOTICE OF TOTAL SMALL BUSINESS SET-ASIDE (DEV 2026-O0037)(FEB 2026)|1||',
      business_lines: ['molecule_commerce'] };
    const blank = RK.rank({ ...base, set_aside: '' }, { today: T1 });
    // It raises a FLAG, and must not also dock the score: docking it pushed the only direct
    // chemical product fit on the real board out of the top ten, below a vaccine RFP.
    if (blank.flags.some((f) => f.kind === 'SET_ASIDE_UNVERIFIED')) ok('a blank set-aside field with a set-aside clause in the text raises a flag');
    else bad('the set-aside conflict raised no flag', JSON.stringify(blank.flags));
    if (blank.notes.some((n) => /SET-ASIDE CONFLICT/.test(n))) ok('…and the conflict is reported in the notes');
    else bad('the set-aside conflict was not surfaced', JSON.stringify(blank.notes));
    const clean = RK.rank({ ...base, description: 'bulk reagent grade chemical', set_aside: '' }, { today: T1 });
    if (blank.components.eligibility === clean.components.eligibility) {
      ok('…and it does NOT dock the score — an unknown is a reason to verify, not to hide the row');
    } else {
      bad('a set-aside flag also docked the score, which buries the row',
        `${blank.components.eligibility} vs ${clean.components.eligibility}`);
    }
    // And a populated field must NOT trip the conflict — the check is for absence, not disagreement.
    const populated = RK.rank({ ...base, set_aside: 'Total Small Business Set-Aside (FAR 19.5)' }, { today: T1 });
    if (!populated.flags.some((f) => f.kind === 'SET_ASIDE_UNVERIFIED')) ok('…and a populated set-aside field does not trip it');
    else bad('a populated set-aside field falsely reported a conflict');
  }

  // And the classes must be declared. An undeclared class string is a silent typo away from
  // falling through every does_not_reach check.
  for (const cls of ['clinical_diagnostic_consumable', 'radiopharmaceutical', 'facility_service']) {
    if (F.PRODUCT_CLASSES.includes(cls)) ok(`${cls} is a declared product class`);
    else bad(`${cls} is used but not declared in PRODUCT_CLASSES`);
  }
}

console.log(`\n${bar()}`);
console.log(`  ${pass} assertion(s) passed · ${fail} failed`);
if (fail) { console.log('\nFAIL  the tracker does not hold as claimed.\n'); process.exit(1); }
console.log('\nPASS  the export cannot hand Excel a formula, normalisation never invents a value,');
console.log('      and no quantity of indicative evidence produces QUALIFIED.\n');
