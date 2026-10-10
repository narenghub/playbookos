#!/usr/bin/env node
// ── EXECUTE THE SCOPE QC-PARTNER QUERIES AGAINST A REAL POSTGRES. ─────────────
//
//   scripts/check-lab-delegates-sql.js      → exit 0 = the queries run AND the list is not alphabetical
//
// This exists because the thing that was wrong three times was not something a parser can see. All
// three broken versions were valid SQL returning sixty rows that reported success; what was wrong
// was WHICH sixty, and that only shows up when the query runs against data.
//
// ── AND THE FIRST VERSION OF THIS CHECKER PASSED THE THIRD BUG ───────────────
//
// It seeded 7 European labs and queried with a LIMIT of 60, so the limit never bit and the ordering
// never had to break a tie. Production had 111 European survivors against the same limit of 60:
// every boolean constant across them, `name` deciding the list. The checker asserted "not in name
// order" and was satisfied, because the condition that CAUSES the bug was absent from the fixture.
//
// So the fixture is now built to make the limit bite. More European, contactable, shape-passing
// labs than the limit asks for, all of them with a contact on file — the exact state of the real
// table. If the ordering has nothing that varies, this now comes back in strict alphabetical order
// and fails, which is what should have happened the first time.
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

// The real column set, and a population built to make the LIMIT bite — which is what the first
// version of this file failed to do. Names are chosen so that an alphabetical result and a correct
// result cannot be confused: the firms that must NOT lead are given A-names.
const SCHEMA = `
CREATE TABLE labs (
  id BIGSERIAL PRIMARY KEY, name TEXT, name_normalized TEXT, city TEXT, country TEXT,
  region TEXT, status TEXT, contact_name TEXT, contact_email TEXT,
  research_capable BOOLEAN DEFAULT FALSE, gmp_capable BOOLEAN DEFAULT FALSE,
  notes TEXT, address TEXT);

-- 1. THE API MANUFACTURERS that filled the second broken list. They do not read like labs.
INSERT INTO labs (name, city, country, region, status, contact_email) VALUES
  ('ACS Dobfar SpA',             'Milan',    'ITA','eu-south','prospect','a@acsdobfar.example'),
  ('Aesica Pharmaceuticals GmbH','Monheim',  'DEU','eu-west', 'prospect','a@aesica.example'),
  ('AGC Biologics SPA',          'Bresso',   'ITA','eu-south','prospect','a@agc.example'),
  ('Ajinomoto Omnichem',         'Wetteren', 'BEL','eu-west', 'prospect','a@ajinomoto.example');

-- 2. THE ORIGINATORS whose "Laboratories" is historical. These led the THIRD broken list.
INSERT INTO labs (name, city, country, region, status, contact_email) VALUES
  ('Abbott Laboratories GmbH',           'Wiesbaden','DEU','eu-west','prospect','a@abbott.example'),
  ('AbbVie Deutschland Laboratories',    'Ludwigshafen','DEU','eu-west','prospect','a@abbvie.example'),
  ('Alexion Pharma Laboratories Limited','Dublin',  'IRL','eu-west','prospect','a@alexion.example'),
  ('Takeda Austria Laboratories GmbH',   'Linz',    'AUT','eu-west','prospect','a@takeda.example');

-- 3. REGISTER-FLAGGED API MANUFACTURERS. The name reads like a lab; the register says it tests its
--    own product. "notes" is exactly that flag, written by scripts/seed-labs-from-fda.js.
INSERT INTO labs (name, city, country, region, status, contact_email, notes) VALUES
  ('Aarti Analytical Laboratories','Dublin','IRL','eu-west','prospect','a@aarti.example',
   'FDA register: also an API manufacturer — may be testing its own product, not a contract lab.'),
  ('Abo Testing Services BV','Rotterdam','NLD','eu-west','prospect','a@abo.example',
   'FDA register: also an API manufacturer — may be testing its own product, not a contract lab.');

-- 4. DUPLICATE ESTABLISHMENTS OF ONE FIRM IN ONE CITY. Three registered sites, one target — these
--    ate three of the sixty slots in the third broken list.
INSERT INTO labs (name, name_normalized, city, country, region, status, contact_email) VALUES
  ('Almac Pharma Services Limited','almac pharma services','Craigavon','GBR','eu-west','prospect','a@almac.example'),
  ('Almac Pharma Services Limited','almac pharma services','Craigavon','GBR','eu-west','prospect','a@almac.example'),
  ('Almac Pharma Services Limited','almac pharma services','Craigavon','GBR','eu-west','prospect','a@almac.example'),
  -- A different CITY of the same firm is a different conversation and must survive separately.
  ('Almac Pharma Services (Ireland) Limited','almac pharma services','Dundalk','IRL','eu-west','prospect','a@almac-ie.example');

-- 5. THE SCALE SIGNAL. One firm with many registered sites — the only continuous measure on this
--    table, and the term that stops the ordering collapsing. Named with a Z so that if it leads,
--    it can only be because "sites" ranked it there and not the alphabet.
INSERT INTO labs (name, name_normalized, city, country, region, status, contact_email)
SELECT 'Zenith Analytical Laboratories ' || g, 'zenith analytical laboratories',
       'City ' || g, 'DEU', 'eu-west', 'prospect', 'z@zenith.example'
  FROM generate_series(1, 9) g;

-- 6. THE BRANDS that describe themselves least and matter most.
INSERT INTO labs (name, city, country, region, status, contact_email) VALUES
  ('Eurofins BioPharma Product Testing Spain','Madrid','ESP','eu-south','prospect','e@ef.example'),
  ('Intertek Pharmaceutical Services','Manchester','GBR','eu-west','prospect','i@intertek.example');

-- 7. WEAK-TOKEN BUT GENUINE contract labs. Only "Laboratories"/"Labs" in the name, so they must
--    rank BELOW the strong-token firms but must not be excluded.
INSERT INTO labs (name, city, country, region, status, contact_email)
SELECT 'Wessling Laboratorien ' || g, 'Town ' || g, 'DEU', 'eu-west', 'prospect', 'w@wess.example'
  FROM generate_series(1, 20) g;

-- 8. STRONG-TOKEN labs, enough of them to overflow the limit on their own. Late alphabet on
--    purpose: these must fill the top of the list.
INSERT INTO labs (name, city, country, region, status, contact_email)
SELECT 'Villani Analitica Srl ' || g, 'Comune ' || g, 'ITA', 'eu-south', 'prospect', 'v@vil.example'
  FROM generate_series(1, 20) g;

-- 9. MUST NOT APPEAR AT ALL: a partner, a declined site. Plus a numbered shell and a non-European
--    lab, which may appear but must rank below every named European one.
INSERT INTO labs (name, city, country, region, status, contact_email) VALUES
  ('Rigel Analytical Laboratories',    'Lyon',   'FRA','eu-west', 'active',  'r@rigel.example'),
  ('Quasar Testing Services',          'Porto',  'PRT','eu-south','rejected','q@quasar.example'),
  ('9231-9110 Quebec Inc Laboratoire', 'Quebec', 'CAN','na-east', 'prospect','n@num.example'),
  ('Pacific Analytical Laboratories',  'Seattle','USA','na-west', 'prospect','p@pac.example');

-- name_normalized is NOT NULL in the real schema and is the dedupe key; fill the ones left blank.
UPDATE labs SET name_normalized = lower(regexp_replace(name, '[^a-zA-Z0-9 ]', '', 'g'))
 WHERE name_normalized IS NULL;
`;

// The limit MUST be smaller than the European survivor pool, or the fixture cannot reproduce the
// bug. Asserted below rather than assumed.
const LIMIT = 20;

(async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query(SCHEMA);
    ok('built the real labs shape and a population that makes the LIMIT bite');

    // ── 1. THE QUERIES RUN ────
    let rows;
    try {
      rows = (await client.query(labDelegateSql(LIMIT))).rows;
      ok(`labDelegateSql runs — ${rows.length} row(s) at a limit of ${LIMIT}`);
    } catch (e) {
      bad('execute labDelegateSql', e.message + (e.position ? ` (position ${e.position})` : ''));
      throw e;
    }
    let audit;
    try {
      audit = (await client.query(labShapeAuditSql())).rows[0];
      ok('labShapeAuditSql runs — ' + JSON.stringify(audit));
    } catch (e) {
      bad('execute labShapeAuditSql', e.message + (e.position ? ` (position ${e.position})` : ''));
      throw e;
    }

    const names = rows.map((r) => r.name);
    const has = (frag) => names.some((n) => n.toLowerCase().includes(frag.toLowerCase()));

    // ── 2. THE FIXTURE ACTUALLY REPRODUCES THE BUG'S PRECONDITION ────
    // This is the assertion whose absence let the third bug through. If the European survivor pool
    // is not bigger than the limit, the ordering is never asked to break a tie and every assertion
    // below is vacuous.
    if (!(audit.kept_eu > LIMIT)) {
      bad('the fixture must overflow the limit, or this whole file proves nothing',
        `kept_eu=${audit.kept_eu}, limit=${LIMIT} — the first version of this checker had 7 vs 60 ` +
        'and passed a list that was alphabetical in production');
    } else ok(`${audit.kept_eu} European survivors against a limit of ${LIMIT} — the tie MUST be broken`);
    if (rows.length !== LIMIT) {
      bad('the limit bites', `got ${rows.length} rows, expected ${LIMIT}`);
    } else ok(`the limit bites: exactly ${LIMIT} rows came back`);

    // ── 3. THE LIST IS NOT ALPHABETICAL. ────
    // The direct statement of the bug, now asked under the conditions that produce it.
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    if (names.every((n, i) => n === sorted[i])) {
      bad('the result is in pure alphabetical order — the ordering has collapsed a FOURTH time',
        names.join('\n'));
    } else ok('the result is NOT in name order, under the conditions that caused the collapse');

    // ── 4. THE FIRMS THAT LED EACH BROKEN LIST ARE ABSENT ────
    const manufacturers = ['ACS Dobfar', 'Aesica', 'AGC Biologics', 'Ajinomoto'];
    const leakedMfr = manufacturers.filter(has);
    if (leakedMfr.length) {
      bad('API manufacturers and CDMOs are filtered out', `${leakedMfr.join(', ')} came back`);
    } else ok('the firms that led the SECOND broken list are absent (shape test)');

    const originators = ['Abbott', 'AbbVie', 'Alexion', 'Takeda'];
    const leakedOrig = originators.filter(has);
    if (leakedOrig.length) {
      bad('originator pharma companies are filtered out',
        `${leakedOrig.join(', ')} came back — "Abbott Laboratories GmbH" led the THIRD broken list`);
    } else ok('the originators that led the THIRD broken list are absent (name list)');

    const flagged = ['Aarti', 'Abo Testing'];
    const leakedFlag = flagged.filter(has);
    if (leakedFlag.length) {
      bad("the register's own API-manufacturer flag is respected",
        `${leakedFlag.join(', ')} came back — notes says it tests its own product`);
    } else ok("the register's API-manufacturer flag excludes two lab-shaped names");

    // ── 5. STRONG TOKENS LEAD, WEAK ONES SURVIVE BELOW THEM ────
    // "Laboratories" alone is weak — it is in Abbott's name. A firm saying ANALYTICAL or TESTING is
    // selling analysis. Both are kept; the strong ones rank first.
    const firstWeak = names.findIndex((n) => /Wessling/.test(n));
    const lastStrong = names.reduce((acc, n, i) => (/Analitica|Analytical|Testing|Eurofins|Intertek/.test(n) ? i : acc), -1);
    if (firstWeak !== -1 && firstWeak < lastStrong) {
      bad('a name that merely says "Laboratorien" must rank below one selling analysis',
        names.map((n, i) => `${i}: ${n}`).join('\n'));
    } else ok('strong-signal labs lead; weak-signal ones rank below but are not excluded');

    // ── 6. THE SCALE SIGNAL IS DOING WORK ────
    // Zenith has 9 registered sites and a Z-name. If it is in the list, only `sites` can have put
    // it there — which is the term that stops the collapse.
    const zenith = rows.findIndex((r) => /Zenith/.test(r.name));
    if (zenith === -1) {
      bad('the multi-site firm ranks in on scale', 'Zenith Analytical (9 sites) did not make the list');
    } else if (zenith > LIMIT / 2) {
      bad('a 9-site firm should rank high, not scrape in', `Zenith is at position ${zenith}`);
    } else ok(`the 9-site firm ranks at position ${zenith} on scale alone, despite a Z-name`);

    // ── 7. DUPLICATE ESTABLISHMENTS DO NOT EAT THE LIST ────
    // Asked of the WHOLE result set, not the top 20. The first version of this assertion looked for
    // the Dundalk site inside a limit of 20 and failed — but Almac is a weak-token name, so it sits
    // below 32 strong-token firms and was never deduped at all. "Below the limit" and "deduped
    // away" are different answers and a test must not confuse them.
    const all = (await client.query(labDelegateSql(500))).rows.map((r) => r.name + ' @ ' + r.city);
    const craigavon = all.filter((n) => /Almac Pharma Services Limited @ Craigavon/.test(n)).length;
    if (craigavon !== 1) {
      bad('three registered sites of one firm in one city are ONE target',
        `"Almac Pharma Services Limited @ Craigavon" appears ${craigavon} time(s) — three ` +
        'establishments ate three of sixty slots in production');
    } else ok('three establishments of one firm in one city collapse to one row');
    if (!all.some((n) => /Almac Pharma Services \(Ireland\) Limited @ Dundalk/.test(n))) {
      bad('a different CITY of the same firm is a different target',
        'the Dundalk site shares name_normalized with Craigavon and must NOT be deduped away');
    } else ok('the same firm in another city keeps its own row');
    // And the top-20 ranking must not contain the Craigavon duplicate either.
    const almacTop = names.filter((n) => /Almac Pharma Services Limited/.test(n)).length;
    if (almacTop > 1) bad('no duplicate survives into the ranked list', `${almacTop} Almac rows in the top ${LIMIT}`);
    else ok(`no duplicate establishment survives into the ranked top ${LIMIT}`);

    // ── 8. STATUS STILL EXCLUDES PARTNERS AND DECLINED SITES ────
    if (has('Rigel')) bad("a lab already 'active' is a partner, not a target", 'Rigel came back');
    else ok("'active' labs excluded — they are partners, not recruitment targets");
    if (has('Quasar')) bad("'rejected' labs stay out", 'Quasar came back');
    else ok("'rejected' labs excluded");

    // ── 9. EUROPE LEADS ────
    const firstNonEu = rows.findIndex((r) => !/^eu/.test(r.region || ''));
    const lastEu = rows.reduce((acc, r, i) => (/^eu/.test(r.region || '') ? i : acc), -1);
    if (firstNonEu !== -1 && firstNonEu < lastEu) {
      bad('European labs lead — the show is in Barcelona',
        rows.map((r, i) => `${i}: ${r.name} [${r.region}]`).join('\n'));
    } else ok('every European lab ranks above every non-European one');

    // ── 10. THE AUDIT EXPLAINS EACH STAGE ────
    // The previous audit reported only the name filter, which is why the third version looked fine.
    const expect = (k, v, why) => {
      if (audit[k] !== v) bad(`audit.${k} = ${v}`, `got ${audit[k]} — ${why}`);
      else ok(`audit.${k} = ${v} — ${why}`);
    };
    expect('api_manufacturer_flag', 2, "the register's own flag, counted separately so it is visible");
    expect('originator', 4, 'the originators, counted rather than silently vanishing');
    if (!(audit.kept < audit.reads_like_a_lab)) {
      bad('the audit shows the later stages removing rows',
        `kept=${audit.kept} vs reads_like_a_lab=${audit.reads_like_a_lab}`);
    } else ok(`audit: ${audit.reads_like_a_lab} read like labs → ${audit.kept} kept after the flag and the originators`);
    if (!(audit.kept_eu_companies < audit.kept_eu)) {
      bad('the audit shows duplicate establishments', `companies=${audit.kept_eu_companies}, rows=${audit.kept_eu}`);
    } else ok(`audit: ${audit.kept_eu} European rows are ${audit.kept_eu_companies} distinct companies`);

    console.log('');
    console.log(fail
      ? `FAIL  ${fail} problem(s) with the SCOPE lab delegate queries`
      : 'PASS  the queries run, exclude manufacturers and originators, dedupe sites, and are NOT alphabetical');
  } catch (e) {
    if (!fail) bad('unexpected failure', e.stack || e.message);
    console.log('\nFAIL  the SCOPE lab delegate queries did not check out');
  } finally {
    try { await client.end(); } catch (_) {}
    stopTemp();
  }
  process.exit(fail ? 1 : 0);
})();
