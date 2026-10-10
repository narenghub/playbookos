#!/usr/bin/env node
// ── EXECUTE THE SCOPE QC-PARTNER QUERIES AGAINST A REAL POSTGRES. ─────────────
//
//   scripts/check-lab-delegates-sql.js      → exit 0 = the queries run AND the list is not alphabetical
//
// This exists because the thing that was wrong twice was not something a parser can see. Both
// broken versions were valid SQL that returned sixty rows and reported success; what was wrong was
// WHICH sixty rows, and that only shows up when the query runs against data.
//
// So this checker seeds a `labs` table deliberately rigged so that an alphabetical result and a
// correct result look nothing alike: the API manufacturers are given A-names (the real ones were
// ACS Dobfar, Aesica, AGC Biologics, Ajinomoto, Alexion) and the genuine laboratories are given
// names late in the alphabet. If the ordering collapses to `name` again, the manufacturers come
// back to the top and these assertions fail.
//
// Skips cleanly (exit 0) where no Postgres is available, so preflight still runs on a bare laptop.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { labDelegateSql, labShapeAuditSql } = require('../src/lib/events/lab-delegates');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(String(d).split('\n').map((l) => '          ' + l).join('\n')); };

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
const findInitdb = () => BIN.find((d) => fs.existsSync(path.join(d, 'initdb'))) || null;

let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/labdeleg-');
  const asRoot = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asRoot ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { stdio: 'pipe' });
  try {
    if (asRoot) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55997 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asRoot };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55997`;
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

const url = process.env.MOLSEARCH_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set MOLSEARCH_PG_URL or install initdb)');
  console.log('SKIP  lab delegate queries not executed — this check needs a server');
  process.exit(0);
}

// The real column set, and a population rigged against the alphabet. Every row here is EU with a
// contact on file, which is the exact condition that made the two broken orderings constant.
const SCHEMA = `
CREATE TABLE labs (
  id BIGSERIAL PRIMARY KEY, name TEXT, name_normalized TEXT, city TEXT, country TEXT,
  region TEXT, status TEXT, contact_name TEXT, contact_email TEXT,
  research_capable BOOLEAN, gmp_capable BOOLEAN, notes TEXT, address TEXT);

-- API MANUFACTURERS AND CDMOS, with the A-names that led the broken list. Not laboratories.
INSERT INTO labs (name, city, country, region, status, contact_email) VALUES
  ('ACS Dobfar SpA',            'Milan',     'ITA', 'eu-south', 'prospect', 'a@acsdobfar.example'),
  ('Aesica Pharmaceuticals GmbH','Monheim',  'DEU', 'eu-west',  'prospect', 'a@aesica.example'),
  ('AGC Biologics SPA',         'Bresso',    'ITA', 'eu-south', 'prospect', 'a@agc.example'),
  ('Ajinomoto Omnichem',        'Wetteren',  'BEL', 'eu-west',  'prospect', 'a@ajinomoto.example'),
  ('Alexion Pharma International Operations Limited','Dublin','IRL','eu-west','prospect','a@alexion.example');

-- GENUINE CONTRACT LABORATORIES, named late in the alphabet on purpose.
INSERT INTO labs (name, city, country, region, status, contact_email) VALUES
  ('Zeta Analytical Laboratories Ltd', 'Cambridge', 'GBR', 'eu-west',  'prospect', 'z@zeta.example'),
  ('Wessling Laboratorien GmbH',       'Altenberge','DEU', 'eu-west',  'prospect', 'w@wessling.example'),
  ('Villani Analitica Srl',            'Bologna',   'ITA', 'eu-south', 'prospect', 'v@villani.example'),
  ('Tentamus Pharma Services',         'Berlin',    'DEU', 'eu-west',  'prospect', 't@tentamus.example'),
  ('Synlab Microbiology Services',     'Barcelona', 'ESP', 'eu-south', 'prospect', 's@synlab.example');

-- The brand-name labs, which describe themselves least and matter most.
INSERT INTO labs (name, city, country, region, status, contact_email) VALUES
  ('Eurofins BioPharma Product Testing Spain', 'Madrid', 'ESP', 'eu-south', 'prospect', 'e@ef.example'),
  ('Intertek Pharmaceutical Services',         'Manchester','GBR','eu-west','prospect', 'i@intertek.example');

-- MUST NOT APPEAR: a partner, a declined site, a numbered shell, and a non-EU lab that may appear
-- but must rank below the European ones.
INSERT INTO labs (name, city, country, region, status, contact_email) VALUES
  ('Rigel Analytical Laboratories',   'Lyon',   'FRA', 'eu-west', 'active',   'r@rigel.example'),
  ('Quasar Testing Services',         'Porto',  'PRT', 'eu-south','rejected', 'q@quasar.example'),
  ('9231-9110 Quebec Inc Laboratoire','Quebec', 'CAN', 'na-east', 'prospect', 'n@num.example'),
  ('Pacific Analytical Laboratories', 'Seattle','USA', 'na-west', 'prospect', 'p@pac.example');
`;

(async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query(SCHEMA);
    ok('built the real labs shape and a population rigged against the alphabet');

    // ── 1. THE QUERIES RUN ────
    let rows;
    try {
      rows = (await client.query(labDelegateSql(60))).rows;
      ok(`labDelegateSql runs — ${rows.length} row(s)`);
    } catch (e) {
      bad('execute labDelegateSql', e.message + (e.position ? ` (position ${e.position})` : ''));
      throw e;
    }
    let audit;
    try {
      audit = (await client.query(labShapeAuditSql())).rows[0];
      ok(`labShapeAuditSql runs — ${audit.eligible} eligible, ${audit.reads_like_a_lab} read like a lab`);
    } catch (e) {
      bad('execute labShapeAuditSql', e.message + (e.position ? ` (position ${e.position})` : ''));
      throw e;
    }

    const names = rows.map((r) => r.name);
    const has = (frag) => names.some((n) => n.toLowerCase().includes(frag.toLowerCase()));

    // ── 2. THE MANUFACTURERS ARE GONE, NOT MERELY DEMOTED ────
    // This is the assertion the two broken versions would fail. Note it is about PRESENCE: on this
    // tab a CDMO is the wrong company to walk up to, so a late row is still a wrong row.
    const manufacturers = ['ACS Dobfar', 'Aesica', 'AGC Biologics', 'Ajinomoto', 'Alexion'];
    const leaked = manufacturers.filter(has);
    if (leaked.length) {
      bad('API manufacturers and CDMOs are filtered out of the QC tab',
        `${leaked.join(', ')} came back — these are the exact firms that filled the broken list`);
    } else ok('the five firms that filled the broken list are all absent');

    // ── 3. THE REAL LABORATORIES SURVIVED ────
    // A filter that simply shortens the list is no better than the bug. Both halves have to hold.
    const real = ['Zeta Analytical', 'Wessling Laboratorien', 'Villani Analitica',
                  'Tentamus Pharma Services', 'Synlab Microbiology'];
    const missing = real.filter((n) => !has(n));
    if (missing.length) {
      bad('genuine contract laboratories are kept', `${missing.join(', ')} were dropped`);
    } else ok('all five genuine laboratories survive the filter, late alphabet and all');

    // ── 4. THE BRANDS THAT DO NOT DESCRIBE THEMSELVES ────
    for (const brand of ['Eurofins', 'Intertek']) {
      if (!has(brand)) bad(`${brand} is kept`, 'the largest contract testing firms must not be filtered out');
      else ok(`${brand} survives — a brand name is not a disqualification`);
    }

    // ── 5. STATUS STILL EXCLUDES PARTNERS AND DECLINED SITES ────
    if (has('Rigel')) bad("a lab already 'active' is a partner, not a target", 'Rigel came back');
    else ok("'active' labs excluded — they are partners, not recruitment targets");
    if (has('Quasar')) bad("'rejected' labs stay out", 'Quasar came back');
    else ok("'rejected' labs excluded");

    // ── 6. EUROPE LEADS, AND A NUMBERED SHELL SINKS ────
    const firstNonEu = rows.findIndex((r) => !/^eu/.test(r.region || ''));
    const lastEu = rows.reduce((acc, r, i) => (/^eu/.test(r.region || '') ? i : acc), -1);
    if (firstNonEu !== -1 && firstNonEu < lastEu) {
      bad('European labs lead — the show is in Barcelona',
        names.map((n, i) => `${i}: ${n} [${rows[i].region}]`).join('\n'));
    } else ok('every European lab ranks above every non-European one');

    const numbered = names.findIndex((n) => /^[0-9]/.test(n));
    if (numbered !== -1 && numbered < names.length - 1) {
      // It need not be dead last overall, but it must sit below every named European lab.
      const namedEuBelow = rows.slice(numbered + 1).filter((r) => /^eu/.test(r.region || '') && !/^[0-9]/.test(r.name));
      if (namedEuBelow.length) {
        bad('a registry-numbered name sinks below real ones',
          `${namedEuBelow.map((r) => r.name).join(', ')} ranked below a numbered company`);
      } else ok('the registry-numbered company sinks below every named European lab');
    } else ok('the registry-numbered company sinks to the bottom');

    // ── 7. THE LIST IS NOT ALPHABETICAL. ────
    // The direct statement of the bug. Two separate scripts produced a list that happened to be in
    // name order; if that ever holds again, this fails regardless of why.
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    if (names.length > 2 && names.every((n, i) => n === sorted[i])) {
      bad('the result is in pure alphabetical order — the ordering has collapsed again',
        names.join('\n'));
    } else ok('the result is NOT in name order, which is the whole point of this file');

    // ── 8. THE AUDIT NUMBERS ARE THE ONES THAT WOULD HAVE CAUGHT THIS ────
    if (audit.eligible !== 14) bad('the audit counts every eligible lab', `eligible=${audit.eligible}, expected 14`);
    else ok('audit: 14 eligible by status (the partner and the declined site excluded)');
    if (audit.reads_like_a_lab !== audit.eligible - 5) {
      bad('the audit reports exactly the five manufacturers as dropped',
        `reads_like_a_lab=${audit.reads_like_a_lab}, expected ${audit.eligible - 5}`);
    } else ok(`audit: ${audit.eligible - audit.reads_like_a_lab} dropped — the five manufacturers, counted and visible`);
    if (audit.eu_reads_like_a_lab >= audit.eu) {
      bad('the EU audit also reflects the filter', `eu=${audit.eu}, eu_reads_like_a_lab=${audit.eu_reads_like_a_lab}`);
    } else ok(`audit: ${audit.eu_reads_like_a_lab} of ${audit.eu} European rows read like a lab`);

    console.log('');
    console.log(fail
      ? `FAIL  ${fail} problem(s) with the SCOPE lab delegate queries`
      : 'PASS  the lab delegate queries run, exclude manufacturers, keep real labs, and are not alphabetical');
  } catch (e) {
    if (!fail) bad('unexpected failure', e.stack || e.message);
    console.log('\nFAIL  the SCOPE lab delegate queries did not check out');
  } finally {
    try { await client.end(); } catch (_) {}
    stopTemp();
  }
  process.exit(fail ? 1 : 0);
})();
