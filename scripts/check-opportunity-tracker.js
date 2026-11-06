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

h('8. DUPLICATE DETECTION IS ADVISORY, NOT A MERGE');
if (T.titleSimilarity('Blood Type IVD Reagents', 'Blood Type IVD Reagents') === 1) ok('identical titles score 1');
else bad('identical titles did not score 1');
if (T.titleSimilarity('Reagents for Roche', 'Lawn mowing services') < 0.2) ok('unrelated titles score low');
else bad('unrelated titles scored high');
if (T.titleSimilarity('', 'anything') === 0) ok('an empty title scores 0 rather than dividing by zero');
else bad('empty title similarity is wrong');

console.log(`\n${bar()}`);
console.log(`  ${pass} assertion(s) passed · ${fail} failed`);
if (fail) { console.log('\nFAIL  the tracker does not hold as claimed.\n'); process.exit(1); }
console.log('\nPASS  the export cannot hand Excel a formula, normalisation never invents a value,');
console.log('      and no quantity of indicative evidence produces QUALIFIED.\n');
