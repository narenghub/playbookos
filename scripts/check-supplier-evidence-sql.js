#!/usr/bin/env node
// ── EXECUTE THE SUPPLIER-EVIDENCE QUERIES, AND ASSERT THE ORDER THEY PRODUCE ─
//
//   scripts/check-supplier-evidence-sql.js   → exit 0 = the SQL runs and the ordering is right
//
// TWO FAILURES, BOTH OF WHICH HAVE ALREADY HAPPENED IN THIS REPOSITORY.
//
//  1. THE SQL PARSES AND DOES NOT RUN. `= ANY($1)`, `LIKE ANY($2)` and a
//     `COUNT(*) FILTER (WHERE ...)` all parse and then fail against real column sets. `column
//     "status" does not exist` shipped past node --check and the whole unit suite once, and the
//     write it preceded landed.
//
//  2. THE SQL RUNS AND RANKS WRONGLY. Twice, a day apart, a lab query shipped whose ORDER BY
//     terms were all constant — so it ran ALPHABETICALLY and led with the wrong sixty rows. Valid
//     SQL, plausible output, wrong answer. So the population here is RIGGED AGAINST THE ALPHABET
//     and against the platform's own scores: the supplier the evidence should pick is named last
//     alphabetically and carries the LOWEST reliability_score, so an ordering that quietly falls
//     back to either one fails here rather than in front of a supplier.
//
// WHY IT MATTERS THAT THE EVIDENCE CLASSES ARE COMPARED IN ORDER RATHER THAN SUMMED: a weighted
// total lets a reliability_score of 95 — a number somebody typed, where 50 means "nobody has
// said" — outvote an active FDA drug-substance filing. Case 2 below is exactly that inversion.
//
// Skips cleanly (exit 0) where no Postgres is available, so preflight runs on a bare laptop.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ev = require('../src/lib/office/supplier-evidence');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(String(d).split('\n').map((l) => '          ' + l).join('\n')); };

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
const findInitdb = () => BIN.find((d) => fs.existsSync(path.join(d, 'initdb'))) || null;

let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/supplierev-');
  const asRoot = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asRoot ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { stdio: 'pipe' });
  try {
    if (asRoot) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55994 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asRoot };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55994`;
}
function stopTemp() {
  if (!temp) return;
  try {
    execFileSync('sh', ['-c', temp.asRoot
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { stdio: 'pipe' });
  } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.SUPPLIEREV_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set SUPPLIEREV_PG_URL or install initdb)');
  console.log('SKIP  supplier-evidence SQL not executed — this check needs a server');
  process.exit(0);
}

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: url, ssl: false });
  const q = (t, p) => P.query(t, p);
  try {
    // The real column sets, as the shipped schema declares them. A fixture that invents columns
    // would prove the query runs against the fixture and nothing else.
    await q(`CREATE TABLE rfq_requests (
               id TEXT PRIMARY KEY, molecule_name TEXT NOT NULL, cas_number TEXT,
               target_quantity TEXT, target_purity TEXT, gmp_required INTEGER DEFAULT 0,
               status TEXT DEFAULT 'pending')`);
    await q(`CREATE TABLE suppliers (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT,
               region TEXT CHECK (region IN ('apac','india','china','europe','us')),
               contact_email TEXT, contact_name TEXT, website TEXT, specialties TEXT,
               reliability_score INTEGER DEFAULT 50 CHECK (reliability_score BETWEEN 0 AND 100),
               avg_response_days REAL DEFAULT 3, gmp_certified INTEGER DEFAULT 0,
               total_orders INTEGER DEFAULT 0)`);
    await q(`CREATE TABLE supplier_outreach_log (
               id TEXT PRIMARY KEY, rfq_id TEXT, supplier_id TEXT, email_sent_to TEXT,
               email_subject TEXT, email_body TEXT, sent_at TEXT, replied_at TEXT,
               reply_text TEXT, status TEXT, claimed_at TIMESTAMPTZ)`);
    await q(`CREATE TABLE dmf_holders (
               dmf_number INTEGER PRIMARY KEY, status TEXT, dmf_type TEXT, submit_date DATE,
               holder TEXT NOT NULL, subject TEXT NOT NULL,
               holder_normalized TEXT, subject_normalized TEXT, source_file TEXT,
               ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

    await q(`INSERT INTO rfq_requests (id, molecule_name, cas_number, target_quantity,
               target_purity, gmp_required, status)
             VALUES ('rfq-ev','Clopidogrel Bisulfate','120202-66-6','1kg','99%',1,'sent')`);

    // ── THE POPULATION, RIGGED ────────────────────────────────────────────
    //
    //   Alpha Labs     reliability 95, GMP, replied 2/2, NO DMF   ← wins on every typed column
    //   Zeta Pharma    reliability 40, GMP, never contacted, DMF  ← LAST alphabetically, LOWEST
    //                                                               score, and the right answer
    //   Mid Chemicals  reliability 70, NOT GMP, DMF               ← a GMP-required RFQ excludes it
    //   Spent Organics reliability 99, GMP, DMF                   ← already consumed for this RFQ
    //   Noreply Inc    reliability 88, GMP, DMF, no contact_email  ← nowhere to send
    await q(`INSERT INTO suppliers (id,name,country,region,contact_email,reliability_score,
               avg_response_days,gmp_certified,total_orders) VALUES
               ('s-alpha','Alpha Labs','India','india','a@alpha.invalid',95,1,1,10),
               ('s-zeta','Zeta Pharma','India','india','z@zeta.invalid',40,9,1,0),
               ('s-mid','Mid Chemicals','India','india','m@mid.invalid',70,2,0,5),
               ('s-spent','Spent Organics','India','india','s@spent.invalid',99,1,1,20),
               ('s-noreply','Noreply Inc','India','india',NULL,88,1,1,3)`);

    await q(`INSERT INTO supplier_outreach_log (id,rfq_id,supplier_id,sent_at,replied_at,status)
             VALUES ('o1','rfq-other','s-alpha','2026-10-01','2026-10-02','replied'),
                    ('o2','rfq-other2','s-alpha','2026-10-03','2026-10-04','replied'),
                    ('o3','rfq-ev','s-spent','2026-10-05',NULL,'sent')`);

    // Holder names in the FDA's shouting-caps legal form, which is the whole reason the match
    // runs through the tiered matcher rather than string equality.
    await q(`INSERT INTO dmf_holders (dmf_number,status,dmf_type,holder,subject,subject_normalized)
             VALUES (1001,'A','II','ZETA PHARMA PVT LTD','Clopidogrel Bisulfate','clopidogrel bisulfate'),
                    (1002,'A','II','MID CHEMICALS LIMITED','Clopidogrel Bisulfate','clopidogrel bisulfate'),
                    (1003,'A','II','SPENT ORGANICS LTD','Clopidogrel Bisulfate','clopidogrel bisulfate'),
                    (1004,'A','II','NOREPLY INC','Clopidogrel Bisulfate','clopidogrel bisulfate'),
                    (1005,'I','II','INACTIVE FILER LTD','Clopidogrel Bisulfate','clopidogrel bisulfate'),
                    (1006,'A','III','ALPHA LABS LTD','Clopidogrel packaging','clopidogrel bisulfate')`);

    // ── 1. EVERY STATEMENT RUNS ───────────────────────────────────────────
    const rfq = (await q(ev.SQL.rfq, ['rfq-ev'])).rows[0];
    if (rfq && rfq.molecule_name === 'Clopidogrel Bisulfate') ok('SQL.rfq runs');
    else bad('SQL.rfq did not return the RFQ', JSON.stringify(rfq));

    const suppliers = (await q(ev.SQL.suppliers)).rows;
    if (suppliers.length === 5) ok('SQL.suppliers runs and reads every declared column');
    else bad(`SQL.suppliers returned ${suppliers.length} rows, expected 5`);

    const consumed = (await q(ev.SQL.consumed, ['rfq-ev'])).rows;
    if (consumed.length === 1 && consumed[0].supplier_id === 's-spent') ok('SQL.consumed runs and is scoped to THIS RFQ');
    else bad('SQL.consumed is wrong', JSON.stringify(consumed));

    const replies = (await q(ev.SQL.replies)).rows;
    const al = replies.find((r) => r.supplier_id === 's-alpha');
    if (al && al.sent === 2 && al.replied === 2) ok('SQL.replies runs — COUNT(*) FILTER executes and counts correctly');
    else bad('SQL.replies is wrong', JSON.stringify(replies));

    const [eq, like] = ev.dmfTerms('Clopidogrel Bisulfate');
    const dmfRows = (await q(ev.SQL.dmf, [eq, like])).rows;
    if (dmfRows.length === 4) ok('SQL.dmf runs — = ANY($1) and LIKE ANY($2) both execute');
    else bad(`SQL.dmf returned ${dmfRows.length} rows, expected 4 active type II`, JSON.stringify(dmfRows.map((r) => r.dmf_number)));
    if (!dmfRows.some((r) => r.status === 'I')) ok('an INACTIVE DMF is excluded by the query');
    else bad('an inactive DMF was returned');
    if (!dmfRows.some((r) => r.dmf_type !== 'II')) ok('a type III (packaging) DMF is excluded — only drug substances count');
    else bad('a non-type-II DMF was returned');

    // ── 2. THE TIERING ────────────────────────────────────────────────────
    const zeta = ev.acceptDmf(dmfRows, 'Zeta Pharma');
    if (zeta.safe.length === 1 && zeta.safe[0].dmf_number === 1001) {
      ok('"ZETA PHARMA PVT LTD" matches "Zeta Pharma" at a tier safe enough to act on');
    } else bad('the DMF holder did not match its supplier', JSON.stringify(zeta));
    const alphaDmf = ev.acceptDmf(dmfRows, 'Alpha Labs');
    if (!alphaDmf.safe.length) ok('Alpha Labs has NO accepted DMF — its only filing was type III and never returned');
    else bad('Alpha Labs was credited with a DMF it does not hold', JSON.stringify(alphaDmf.safe));

    // ── 3. THE ORDER ──────────────────────────────────────────────────────
    const rows = ev.buildEvidence({ rfq, suppliers, consumed, replies, dmfRows });
    const ordered = ev.rankEvidence(rows);
    const names = ordered.map((r) => r.supplier.name);

    if (!names.includes('Spent Organics')) ok('a supplier already consumed for THIS RFQ is not eligible');
    else bad('a consumed supplier was offered again');
    if (!names.includes('Noreply Inc')) ok('a supplier with no contact_email is not eligible');
    else bad('a supplier with nowhere to send was offered');

    if (names[0] === 'Zeta Pharma') {
      ok('THE ORDERING PICKS Zeta Pharma: last alphabetically, LOWEST reliability score, and the '
        + 'only eligible supplier with an active type II DMF for this molecule');
    } else {
      bad('the ordering did not pick the supplier the evidence supports — if it picked Alpha Labs '
        + 'the typed columns outvoted an FDA filing; if it picked by name the ordering collapsed '
        + 'to the alphabet', names.join(' > '));
    }

    const mid = ordered.find((r) => r.supplier.name === 'Mid Chemicals');
    if (mid && names.indexOf('Mid Chemicals') === names.length - 1) {
      ok('a NON-GMP supplier ranks last on a GMP-required RFQ, even holding a DMF');
    } else bad('GMP is not the first comparison', names.join(' > '));

    // THE NEGATIVE CONTROL FOR THE GMP CLASS. With GMP not required, Mid Chemicals must rise —
    // otherwise the GMP term might be doing nothing and the order coming from somewhere else.
    const noGmp = ev.rankEvidence(ev.buildEvidence({
      rfq: { ...rfq, gmp_required: 0 }, suppliers, consumed, replies, dmfRows,
    })).map((r) => r.supplier.name);
    if (noGmp.indexOf('Mid Chemicals') < noGmp.indexOf('Alpha Labs')) {
      ok('and with GMP NOT required it rises above a GMP supplier with no DMF — the GMP term is '
        + 'load-bearing, not decoration');
    } else bad('dropping the GMP requirement changed nothing, so that term was never measured', noGmp.join(' > '));

    // A zero denominator must not be scored as a zero rate: an untried supplier is an absence of
    // evidence, not a bad record.
    const untried = { supplier: { name: 'U', reliability_score: 50, avg_response_days: 3, total_orders: 0 },
      dmfSafe: [], dmfWeak: [], sent: 0, replied: 0, gmpRequired: false, gmpOk: true, eligible: true };
    const unresponsive = { supplier: { name: 'R', reliability_score: 50, avg_response_days: 3, total_orders: 0 },
      dmfSafe: [], dmfWeak: [], sent: 5, replied: 0, gmpRequired: false, gmpOk: true, eligible: true };
    if (ev.compareEvidence(untried, unresponsive) < 0) {
      ok('an untried supplier ranks ABOVE one with five unanswered RFQs — no evidence beats '
        + 'negative evidence, and "0 of 0" is not a zero rate');
    } else if (ev.compareEvidence(untried, unresponsive) === 0) {
      bad('an untried supplier and one that has ignored five RFQs are TIED on every evidence '
        + 'term, which leaves the NAME TIEBREAK deciding between them');
    } else {
      bad('an untried supplier ranks BELOW one with five unanswered RFQs — a zero denominator is '
        + 'being scored as a zero rate');
    }
    // The names are deliberately 'U' and 'R' so that if the evidence terms tie, the alphabet
    // decides AGAINST the expected answer and the assertion above fails loudly.
    if (ev.responsivenessClass({ sent: 2, replied: 1 }) === 0
        && ev.responsivenessClass({ sent: 0, replied: 0 }) === 1
        && ev.responsivenessClass({ sent: 5, replied: 0 }) === 2) {
      ok('responsiveness is three states: replied / never contacted / contacted and never replied');
    } else bad('responsiveness collapsed back to two states');

    // ── 4. IT WRITES NOTHING ──────────────────────────────────────────────
    const sql = Object.values(ev.SQL).join('\n').toUpperCase();
    if (/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b|\bALTER\b|\bDROP\b/.test(sql)) {
      bad('a mutating statement appears in the evidence SQL — this module must be read-only');
    } else ok('every evidence statement is a SELECT — the module cannot write');

    const before = (await q(`SELECT (SELECT COUNT(*) FROM supplier_outreach_log) a,
                                    (SELECT COUNT(*) FROM suppliers) b,
                                    (SELECT COUNT(*) FROM dmf_holders) c`)).rows[0];
    if (before.a === '3' && before.b === '5' && before.c === '6') {
      ok('and the fixture rows are untouched after every query ran');
    } else bad('the row counts changed while reading', JSON.stringify(before));
  } catch (e) {
    bad('unexpected error', e.stack || e.message);
  } finally {
    try { await P.end(); } catch (_) {}
    stopTemp();
  }

  console.log(fail
    ? `\nFAIL  ${fail} supplier-evidence assertion(s) failed`
    : '\nPASS  the supplier-evidence SQL runs and the ordering follows the evidence, not the '
      + 'alphabet and not the typed scores');
  process.exit(fail ? 1 : 0);
})();
