#!/usr/bin/env node
// ── END-TO-END: IMPORT → NORMALISE → DEDUPE → ASSESS → CONFIRM → EXPORT ──────
//
//   node scripts/prpa-tracker-demo.js
//
// Ruling 21 priority 3, on REAL publicly available SAM.gov data. Runs entirely on a disposable
// PostgreSQL cluster: no production database, no production credentials, nothing provisioned.
//
// ── WHAT IS REAL HERE AND WHAT IS NOT ────────────────────────────────────────
//
// REAL: the 82 opportunities. Harvested 2026-11-06 from sam.gov/api/prod/sgs/v1/search/ — the
// JSON backend of the SAM.gov web UI, on the sam.gov host, no API key. Real notice ids, real
// solicitation numbers, real agencies, real deadlines. Every record carries its canonical
// sam.gov/opp/<id>/view link so any row can be checked against the source.
//
// NOT REAL, AND LABELLED EVERYWHERE IT APPEARS: the capability registry in pass B. Abiozen's
// actual registry holds ZERO verified capabilities — measured on 2026-11-05 by
// capability-evidence-inventory.js across two entities. So pass A, which is the truthful run, can
// only ever return NEEDS_REVIEW or NOT_QUALIFIED. Pass B exists solely to show the engine CAN
// return QUALIFIED when real evidence is present, and its verdicts are about fixture evidence.
//
// Reporting pass B's verdicts as Abiozen's qualification status would be exactly the fabrication
// ruling 21 priority 3 forbids.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

const v3 = require('../src/lib/office/intake-schema');
const v4 = require('../src/lib/office/opportunity-schema');
const T = require('../src/lib/office/opportunity-tracker');
const { pgBinCandidates, INITDB_FLAGS } = require('./lib/pg-cluster');

const PGPORT = process.env.PGPORT_TEST || '55441';
const EXIT_NOT_EXECUTED = 3;
const CSV = path.join(__dirname, '..', 'fixtures', 'sam-opportunities-real-2026-11-06.csv');
const OUTDIR = process.env.PRPA_OUT || '/tmp/claude-0/-home-claude/a0303f00-5fe1-5ee7-be5c-5412f357070f/scratchpad/prpa-out';
const CO = 'co-bbb13600-5966-4bb4-a569-2df76c5abba8';   // Abiozen LLC, the one active company

const bar = (c = '─') => c.repeat(78);
const h = (t) => console.log(`\n${bar()}\n${t}\n${bar()}`);

let temp = null;
function startCluster() {
  let dir = null;
  for (const d of pgBinCandidates()) { dir = d; break; }
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/prpa-demo-');
  const asPostgres = process.getuid && process.getuid() === 0;
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, encoding: 'utf8', stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p ${PGPORT} -c listen_addresses=' start -w`);
  } catch (e) {
    console.error(`cluster start failed: ${e.message}`);
    return null;
  }
  temp = { base, dir, asPostgres };
  return base;
}
function stopCluster() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) { /* best effort */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

// Fixture capabilities for pass B ONLY. Every name begins with FIXTURE so the label travels with
// the data into any export, screenshot or report that quotes it.
const FIXTURE_CAPABILITIES = [
  { id: 'cap-fx-1', kind: 'service_capability', evidence_class: 'method_validated', business_line: 'analytical_services', name: 'FIXTURE: validated HPLC assay method', valid_until: '2027-06-30' },
  { id: 'cap-fx-2', kind: 'capability', evidence_class: 'prior_delivery', business_line: 'molecule_commerce', name: 'FIXTURE: prior delivery of a reference standard', valid_until: null },
  { id: 'cap-fx-3', kind: 'capability', evidence_class: 'stock_on_hand', business_line: 'scientific_fulfillment', name: 'FIXTURE: stock on hand, laboratory consumables', valid_until: '2027-01-31' },
  { id: 'cap-fx-4', kind: 'capability', evidence_class: 'catalog_listing', business_line: 'custom_synthesis', name: 'FIXTURE: catalogue listing only (INDICATIVE — must not qualify)', valid_until: null },
  { id: 'cap-fx-5', kind: 'accreditation', evidence_class: 'accreditation', business_line: 'analytical_services', name: 'FIXTURE: ISO 17025 accreditation, EXPIRED', valid_until: '2026-01-01' },
];

async function main() {
  h('PRPA FEDERAL CONTRACT TRACKER — END-TO-END ON REAL SAM.gov DATA');
  if (!fs.existsSync(CSV)) {
    console.log(`\nSKIP  no data file at ${CSV}. This demonstrated NOTHING.\n`);
    process.exit(EXIT_NOT_EXECUTED);
  }
  const base = startCluster();
  if (!base) {
    console.log('\nSKIP  no complete PostgreSQL server toolchain. This demonstrated NOTHING.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }
  fs.mkdirSync(OUTDIR, { recursive: true });
  const url = `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable`;
  const client = new Client({ connectionString: url });
  await client.connect();
  const q = (sql, p) => client.query(sql, p);

  try {
    // ── 0. the schema this runs on ──────────────────────────────────────────
    await q(`CREATE TABLE companies (id TEXT PRIMARY KEY, slug TEXT, name TEXT, status TEXT, UNIQUE (id, status))`);
    await q(`CREATE TABLE solicitations (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
               record_kind TEXT, active BOOLEAN DEFAULT true, response_deadline DATE, UNIQUE (id, company_id))`);
    await q(`CREATE TABLE verified_capabilities (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
               kind TEXT, evidence_class TEXT, business_line TEXT, name TEXT, valid_until DATE, UNIQUE (id, company_id))`);
    await q(`CREATE TABLE source_connectors (source_key TEXT PRIMARY KEY, display_name TEXT, kind TEXT,
               auth_mode TEXT, access_mode TEXT, daily_call_ceiling INT, activated BOOLEAN, notes TEXT)`);
    await q(`CREATE TABLE skus (id TEXT PRIMARY KEY, name TEXT)`);
    await q(`CREATE TABLE suppliers (id TEXT PRIMARY KEY, name TEXT)`);
    await q(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, role TEXT, is_active INT DEFAULT 1)`);
    await q(`INSERT INTO companies VALUES ($1,'abiozen','Abiozen LLC','active')`, [CO]);
    await q(`INSERT INTO users (id,email,role,is_active) VALUES ('u1','naren@abiozen.com','super_admin',1)`);
    for (const s of v3.DDL) await q(s);
    for (const s of v4.DDL) await q(s);
    console.log(`  schema: v3 (${v3.DDL.length} statements) + v4 (${v4.DDL.length} statements) on a disposable cluster`);

    // ── 1. IMPORT ───────────────────────────────────────────────────────────
    h('1. IMPORT — real SAM.gov CSV, SAM\'s own column names');
    const csvText = fs.readFileSync(CSV, 'utf8');
    const r1 = await T.importCsv(q, {
      companyId: CO, importedBy: 'naren@abiozen.com', csvText,
      sourceDetail: `${path.basename(CSV)} — harvested 2026-11-06 from sam.gov/api/prod/sgs/v1/search/ (web UI backend, no API key)`,
    });
    console.log(`  imported ${r1.outcome.inserted.length} new · ${r1.outcome.amended.length} amended · `
      + `${r1.outcome.unchanged.length} already held · ${r1.outcome.rejected.length} rejected`);
    console.log(`  csv sha256 ${r1.sha256.slice(0, 16)}…`);
    if (r1.unmatchedHeaders.length) console.log(`  columns not mapped: ${r1.unmatchedHeaders.join(', ')}`);
    const withIssues = r1.issues.length;
    console.log(`  ${withIssues} record(s) carried a normalisation issue — kept, with the issue recorded`);
    for (const i of r1.issues.slice(0, 3)) console.log(`      ${i.solicitation_number}: ${i.issues[0]}`);

    // ── 2. DEDUPE — re-import the identical file ────────────────────────────
    h('2. DEDUPE — the same file again, then an amendment');
    const r2 = await T.importCsv(q, {
      companyId: CO, importedBy: 'naren@abiozen.com', csvText,
      sourceDetail: 'same file re-imported to prove idempotence',
    });
    console.log(`  re-import: ${r2.outcome.inserted.length} new, ${r2.outcome.unchanged.length} recognised as already held`);
    if (r2.outcome.inserted.length === 0) console.log('  → tier 1 holds: identical content creates no duplicate');
    else console.log('  → PROBLEM: re-importing created rows');

    // An amendment: same solicitation number, a changed deadline.
    const target = (await q(
      `SELECT * FROM federal_opportunities WHERE company_id=$1 AND is_current AND response_deadline IS NOT NULL
       ORDER BY solicitation_number LIMIT 1`, [CO])).rows[0];
    const amended = { ...target };
    amended.response_deadline = new Date(new Date(target.response_deadline).getTime() + 14 * 864e5).toISOString();
    amended.title = `${target.title} (Amendment 0001)`;
    const { contentHash } = require('../src/lib/office/opportunity-normalize');
    amended.content_hash = contentHash(amended);
    const batch3 = await T.createBatch(q, {
      companyId: CO, source: 'url', importedBy: 'naren@abiozen.com',
      sourceDetail: `amendment observed for ${target.solicitation_number}`,
    });
    const r3 = await T.importRecords(q, { companyId: CO, batchId: batch3, records: [amended] });
    const versions = (await q(
      `SELECT version_seq, is_current, response_deadline FROM federal_opportunities
        WHERE company_id=$1 AND solicitation_number=$2 ORDER BY version_seq`,
      [CO, target.solicitation_number])).rows;
    console.log(`  amendment to ${target.solicitation_number}: ${r3.amended.length} new version`);
    console.log(`  versions now held: ${versions.map((v) => `v${v.version_seq}${v.is_current ? ' (current)' : ''} deadline ${String(v.response_deadline).slice(0, 10)}`).join('  |  ')}`);
    console.log('  → the superseded version is kept, which is what an audit of an assessment needs');
    const dups = (await q(`SELECT COUNT(*)::int n FROM opportunity_duplicate_candidates WHERE company_id=$1`, [CO])).rows[0].n;
    console.log(`  tier 3: ${dups} possible cross-number duplicate(s) recorded for a human — none merged`);

    // ── 3. ASSESS — pass A, Abiozen's ACTUAL registry (empty) ───────────────
    h('3. ASSESS — PASS A: against Abiozen\'s ACTUAL capability registry');
    console.log('  Abiozen holds ZERO verified capabilities. Measured 2026-11-05 across two');
    console.log('  entities by capability-evidence-inventory.js. So this is the truthful run.');
    const passA = await T.assessAll(q, { companyId: CO, assessedBy: 'engine:pass-a-real', capabilities: [] });
    const tally = (rs) => rs.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
    console.log(`  ${JSON.stringify(tally(passA))}`);
    const qualifiedA = passA.filter((r) => r.verdict === 'QUALIFIED').length;
    console.log(`  QUALIFIED: ${qualifiedA} — and it must be 0, because there is no evidence to qualify on.`);

    // ── 4. ASSESS — pass B, FIXTURE capabilities ────────────────────────────
    h('4. ASSESS — PASS B: against FIXTURE capabilities (NOT Abiozen\'s real evidence)');
    for (const c of FIXTURE_CAPABILITIES) {
      await q(`INSERT INTO verified_capabilities (id,company_id,kind,evidence_class,business_line,name,valid_until)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [c.id, CO, c.kind, c.evidence_class, c.business_line, c.name, c.valid_until]);
    }
    const passB = await T.assessAll(q, {
      companyId: CO, assessedBy: 'engine:pass-b-FIXTURE', capabilities: FIXTURE_CAPABILITIES,
    });
    console.log(`  ${JSON.stringify(tally(passB))}`);
    console.log('  Every verdict here is about FIXTURE evidence. It shows the engine can reach');
    console.log('  QUALIFIED when evidence exists; it says nothing about Abiozen\'s real position.');
    const indicativeOnly = passB.filter((r) => (r.missing_requirements || []).some((m) => /custom_synthesis/.test(m)));
    console.log(`  ${indicativeOnly.length} opportunit(y/ies) were held at NEEDS_REVIEW because the only`);
    console.log('  custom-synthesis evidence is a catalogue listing — indicative, never sufficient.');
    if (JSON.stringify(tally(passA)) === JSON.stringify(tally(passB))) {
      console.log('\n  NOTE: pass A and pass B tally IDENTICALLY, and that is not a bug. No deadline');
      console.log('  has been confirmed yet at this point in the workflow, and an unconfirmed');
      console.log('  deadline holds a verdict at NEEDS_REVIEW regardless of evidence. Pass C below,');
      console.log('  after confirmation, is what shows evidence changing the verdict.');
    }

    // ── 5. CONFIRM A DEADLINE ───────────────────────────────────────────────
    h('5. CONFIRM DEADLINE — nothing is biddable until a person confirms it');
    const before = (await q(`SELECT COUNT(*)::int n FROM federal_opportunities WHERE company_id=$1 AND is_biddable`, [CO])).rows[0].n;
    const toConfirm = (await q(
      `SELECT o.id, o.solicitation_number FROM federal_opportunities o
        WHERE o.company_id=$1 AND o.is_current AND o.response_deadline IS NOT NULL
          AND o.notice_type IN ('solicitation','combined_synopsis') AND o.status='open'
        ORDER BY o.response_deadline LIMIT 5`, [CO])).rows;
    for (const t of toConfirm) await T.confirmDeadline(q, { companyId: CO, opportunityId: t.id, confirmedBy: 'naren@abiozen.com' });
    const after = (await q(`SELECT COUNT(*)::int n FROM federal_opportunities WHERE company_id=$1 AND is_biddable`, [CO])).rows[0].n;
    console.log(`  biddable before confirmation: ${before}   after confirming ${toConfirm.length}: ${after}`);
    console.log('  → is_biddable is a generated column; an unconfirmed deadline cannot make it true');

    // ── 5b. ASSESS — PASS C: fixture evidence AND a confirmed deadline ──────
    h('5b. ASSESS — PASS C: FIXTURE evidence, after deadline confirmation');
    console.log('  The only run in which QUALIFIED is reachable: evidence present AND a person has');
    console.log('  confirmed the deadline. Still FIXTURE evidence, so still not Abiozen\'s position.');
    const passC = await T.assessAll(q, {
      companyId: CO, assessedBy: 'engine:pass-c-FIXTURE-confirmed', capabilities: FIXTURE_CAPABILITIES,
    });
    console.log(`  ${JSON.stringify(tally(passC))}`);
    const qc = passC.filter((r) => r.verdict === 'QUALIFIED');
    console.log(`  QUALIFIED: ${qc.length} — each with named evidence and at least one business line`);
    for (const r of qc.slice(0, 4)) {
      console.log(`      ${r.opportunity.solicitation_number}  ${String(r.opportunity.title).slice(0, 48)}`);
      console.log(`          lines: ${r.business_lines.join(', ')}`);
      console.log(`          evidence: ${r.evidence_capability_ids.join(', ')}`);
    }
    if (!qc.length) {
      console.log('      none — so either no confirmed opportunity maps to a line with sufficient');
      console.log('      fixture evidence, or the engine cannot reach QUALIFIED. Both are reportable.');
    }

    // ── 6. FILTER ───────────────────────────────────────────────────────────
    h('6. FILTER (ruling 21 item 4)');
    const all = await T.listOpportunities(q, CO);
    const fl = async (label, f) => {
      const rows = await T.listOpportunities(q, CO, f);
      console.log(`  ${label.padEnd(44)} ${String(rows.length).padStart(3)} row(s)`);
      return rows;
    };
    console.log(`  ${'all current'.padEnd(44)} ${String(all.length).padStart(3)} row(s)`);
    await fl('agency contains "VETERANS"', { agency: 'VETERANS' });
    await fl('NAICS 541380 (testing laboratories)', { naics: '541380' });
    await fl('notice type = solicitation', { noticeType: 'solicitation' });
    await fl('deadline on or before 2026-11-30', { deadlineBefore: '2026-11-30' });
    await fl('biddable only', { biddableOnly: true });
    await fl('verdict NEEDS_REVIEW', { verdict: 'NEEDS_REVIEW' });
    await fl('business line analytical_services', { businessLine: 'analytical_services' });

    // ── 7. EXPORT ───────────────────────────────────────────────────────────
    h('7. EXPORT — CSV that Excel opens correctly');
    const rows = await T.listOpportunities(q, CO);
    const csv = T.exportCsv(rows);
    const outCsv = path.join(OUTDIR, 'abiozen-federal-opportunities.csv');
    fs.writeFileSync(outCsv, csv, 'utf8');
    console.log(`  ${rows.length} rows → ${outCsv}  (${csv.length} bytes)`);
    console.log(`  UTF-8 BOM: ${csv.charCodeAt(0) === 0xfeff ? 'present' : 'MISSING'} · `
      + `CRLF: ${csv.includes('\r\n') ? 'yes' : 'NO'} · columns: ${T.EXPORT_COLUMNS.length}`);
    const neutralised = rows.filter((r) => /^[=+\-@]/.test(String(r.title || ''))).length;
    console.log(`  ${neutralised} title(s) began with a formula character and were neutralised for Excel`);

    // A small JSON side-car so the HTML view and the report read the same numbers.
    const summary = {
      generated_at: new Date().toISOString(),
      source: 'sam.gov/api/prod/sgs/v1/search/ (SAM.gov web UI backend, no API key) — harvested 2026-11-06',
      csv_sha256: r1.sha256,
      imported: r1.outcome.inserted.length,
      amendments: r3.amended.length,
      re_import_duplicates_created: r2.outcome.inserted.length,
      duplicate_candidates: dups,
      total_current: rows.length,
      biddable: after,
      notice_type_mix: rows.reduce((a, r) => { a[r.notice_type] = (a[r.notice_type] || 0) + 1; return a; }, {}),
      pass_a_real_registry: tally(passA),
      pass_b_fixture_registry: tally(passB),
      pass_c_fixture_after_confirmation: tally(passC),
      pass_c_qualified_examples: qc.slice(0, 5).map((r) => ({
        solicitation_number: r.opportunity.solicitation_number,
        title: r.opportunity.title,
        business_lines: r.business_lines,
        evidence: r.evidence_capability_ids,
      })),
      abiozen_verified_capabilities: 0,
    };
    fs.writeFileSync(path.join(OUTDIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    fs.writeFileSync(path.join(OUTDIR, 'rows.json'), `${JSON.stringify(rows, null, 2)}\n`);
    console.log(`  summary → ${path.join(OUTDIR, 'summary.json')}`);

    h('RESULT');
    console.log(`  ${rows.length} real federal opportunities imported from SAM.gov, deduplicated,`);
    console.log('  assessed, deadline-confirmed and exported. No production database was touched,');
    console.log('  no credential was used, and nothing was provisioned.');
    console.log(`\n  Abiozen qualified for ${qualifiedA} of them on the real registry — because the`);
    console.log('  registry is empty. That is the finding, not a failure of the engine.');
    return 0;
  } finally {
    try { await client.end(); } catch (_) { /* */ }
    stopCluster();
  }
}

main()
  .then((c) => process.exit(c))
  .catch((e) => { stopCluster(); console.error('\nFAILED:', e && e.stack ? e.stack : e); process.exit(1); });
