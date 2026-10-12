#!/usr/bin/env node
// ── EXECUTE THE SUPPLIER CROSS-CHECK AGAINST A REAL POSTGRES ──────────────────
//
//   scripts/check-supplier-classify-sql.js    → exit 0 = the queries run and decide correctly
//
// classify-by-supplier-list.js names columns across THREE tables none of which it owns:
// dmf_holders (status, dmf_type, holder, holder_normalized), suppliers (name, country,
// gmp_certified) and cphi_exhibitor_matches (role, holder, holder_normalized, event_slug). On
// 2026-10-12 a script guessed `users.status`, wrote successfully, and then died in its own
// verification — so the one thing it existed to prove was the one thing it did not prove. A test
// that greps for the words in a query cannot catch that. This runs the real function.
//
// It also pins the decision that matters most: an unsearchable name must come back INCONCLUSIVE and
// never as a buyer. Naren's rule is "if not in the supplier list, add them as a buyer", and the
// whole risk is a "not found" that is really a search that could not run.
//
// Skips cleanly (exit 0) where no Postgres is available.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(String(d).split('\n').map((l) => '          ' + l).join('\n')); };

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
const findInitdb = () => BIN.find((d) => fs.existsSync(path.join(d, 'initdb'))) || null;

let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/supclass-');
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
  console.log('SKIP  supplier cross-check queries not executed — this check needs a server');
  process.exit(0);
}

// Column sets copied from scripts/migrate-dmf.js and src/lib/db.js, not from memory — memory is
// what produced `users.status`.
const SCHEMA = `
CREATE TABLE dmf_holders (
  dmf_number INTEGER PRIMARY KEY, status TEXT, dmf_type TEXT, submit_date DATE,
  holder TEXT NOT NULL, subject TEXT NOT NULL,
  holder_normalized TEXT, subject_normalized TEXT, source_file TEXT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE suppliers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT, region TEXT,
  contact_email TEXT, contact_name TEXT, website TEXT, specialties TEXT,
  reliability_score INTEGER DEFAULT 50, avg_response_days REAL DEFAULT 3,
  gmp_certified INTEGER DEFAULT 0, total_orders INTEGER DEFAULT 0,
  created_at TEXT DEFAULT NOW(), updated_at TEXT DEFAULT NOW());
CREATE TABLE cphi_exhibitor_matches (
  id SERIAL PRIMARY KEY, event_slug TEXT NOT NULL, holder TEXT NOT NULL,
  holder_normalized TEXT NOT NULL, exhibiting BOOLEAN DEFAULT FALSE,
  role TEXT NOT NULL, role_note TEXT, review_status TEXT,
  met_in_person BOOLEAN DEFAULT FALSE, linkedin_connected BOOLEAN DEFAULT FALSE,
  notes TEXT, checked_at TIMESTAMPTZ,
  UNIQUE (event_slug, role, holder_normalized));

-- Granules: a real API supplier, active Type II DMFs under a name that normalises to
-- "granules india". The contact's card says "Granules India Limited".
INSERT INTO dmf_holders (dmf_number, status, dmf_type, holder, subject, holder_normalized) VALUES
  (11001,'A','II','Granules India Limited','Metformin Hydrochloride','granules india'),
  (11002,'A','II','Granules India Limited','Paracetamol','granules india'),
  (11003,'I','II','Granules India Ltd','Ibuprofen','granules india'),
  -- A packaging-only filer, to prove active-Type-II is counted separately from "has any DMF".
  (11010,'A','IV','Cartonage Partners SA','Printed carton','cartonage partners'),
  -- A company whose name starts with "gp", which must NOT be reachable by a two-letter prefix.
  (11020,'A','II','GPC Biotech Unrelated','Something Else','gpc biotech unrelated');

INSERT INTO suppliers (id, name, country, gmp_certified) VALUES
  ('s-matrix','Matrix Fine Sciences','IN',1);

INSERT INTO cphi_exhibitor_matches (event_slug, holder, holder_normalized, role) VALUES
  -- holder_normalized is normalizeCompany(holder) — see set-contact-role.js. It keeps industry
  -- words: "sintaho pharmaceutical", NOT the brand core "sintaho". Seeding the core made the
  -- role-filter assertion below pass without matching anything, which is a worse failure than a
  -- red test: it would have stayed green with the role filter removed.
  ('cphi-milan-2026','Sintaho Pharmaceutical','sintaho pharmaceutical','supplier'),
  ('cphi-milan-2026','A-S Medication Solutions','a s medication solutions','buyer');
`;

(async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query(SCHEMA);
    ok('schema and fixtures load');

    // The real function, against the real column sets.
    const { supplierEvidence } = require('./classify-by-supplier-list');
    // The checker's own client, injected. Nothing here touches db.js or its pool.
    const ev = (company) => supplierEvidence(company, { query: (t, p) => client.query(t, p) });

    // ── 1. THE QUERIES RUN AT ALL ────
    let granules;
    try {
      granules = await ev('Granules India Limited');
      ok('the three queries execute against the real column sets');
    } catch (e) {
      bad('a query does not run — a guessed column', e.message);
      throw e;
    }

    // ── 2. A REAL SUPPLIER IS FOUND, FOR THE RIGHT REASON ────
    if (granules.supplier && /active Type II/.test(granules.why)) ok(`Granules → supplier (${granules.why})`);
    else bad('Granules is not recognised as a supplier', JSON.stringify(granules, null, 2));

    // Active Type II must be counted, not merely "has rows": the inactive row must not inflate it.
    if (/\b2 active Type II/.test(granules.why)) ok('only ACTIVE Type II DMFs are counted (2 of 3)');
    else bad('the active Type II count is wrong', granules.why);

    // ── 3. THE DECISION THAT MATTERS: AN UNSEARCHABLE NAME IS NOT A BUYER ────
    // "GP-Pharm" has brand core "gp". canAnchor refuses it, so nothing can be found — and calling
    // that a buyer would file a drug-product maker into the wrong campaign on a search that never
    // ran. It must come back inconclusive.
    const gp = await ev('GP-Pharm');
    if (gp.searchable === false && gp.supplier === false) ok('GP-Pharm → INCONCLUSIVE, not buyer');
    else bad('GP-Pharm was decided on an unrunnable search', JSON.stringify(gp, null, 2));
    if (/too short or too generic/.test(gp.why)) ok('and it says why, so a human can finish it');
    else bad('the inconclusive reason is not explained', gp.why);

    // The near-miss must not have been reached by a two-letter prefix.
    if (!/GPC Biotech/.test(gp.detail.join(' '))) ok('a 2-char core does not match "GPC Biotech"');
    else bad('"gp" matched an unrelated company — the anchor guard is not applied', gp.detail.join('\n'));

    // ── 4. A GENUINE ABSENCE IS A BUYER ────
    // Searchable name, nothing anywhere. This is the case Naren's rule is actually about.
    const buyer = await ev('Northwind Clinical Distributors');
    if (buyer.supplier === false && buyer.searchable === true) ok('an absent, searchable name → buyer');
    else bad('a genuine absence was not decided', JSON.stringify(buyer, null, 2));

    // ── 5. DMFs THAT ARE NOT DRUG SUBSTANCES ────
    // A packaging filer is in the register but files no Type II. It still counts as a supplier hit
    // (they are in the register) but the reason must NOT claim active Type II, because that is what
    // somebody reads before sending a sourcing request.
    const carton = await ev('Cartonage Partners SA');
    if (carton.supplier && /no active Type II/.test(carton.why)) ok('a packaging-only filer is not called an API source');
    else bad('a Type IV filer is reported as having active Type II', JSON.stringify(carton, null, 2));

    // ── 6. PRIOR-SHOW CLASSIFICATION COUNTS ────
    const sintaho = await ev('Sintaho Pharmaceutical');
    if (sintaho.supplier && /another show/.test(sintaho.why)) ok('already supplier at a show → supplier');
    else bad('a prior show classification was not found', JSON.stringify(sintaho, null, 2));

    // ── 7. OUR OWN TABLE COUNTS ────
    const matrix = await ev('Matrix Fine Sciences');
    if (matrix.supplier) ok('our own suppliers table is consulted');
    else bad('the suppliers table was not consulted', JSON.stringify(matrix, null, 2));

    // ── 8. A BUYER-ONLY SHOW ROW IS NOT SUPPLIER EVIDENCE ────
    // The prior-show query filters role='supplier'. If it did not, every classified contact would
    // read as a supplier and the rule would always answer "supplier".
    const asm = await ev('A-S Medication Solutions');
    const reachable = (await client.query(
      `SELECT COUNT(*)::int n FROM cphi_exhibitor_matches WHERE holder_normalized = $1`,
      ['a s medication solutions'])).rows[0].n;
    if (!reachable) bad('the buyer fixture is not reachable by name — the next assertion is vacuous');
    else if (asm.supplier === false) ok('a role=buyer show row is not supplier evidence (row IS findable)');
    else bad('a buyer row was read as supplier evidence', JSON.stringify(asm, null, 2));
  } catch (e) {
    if (!fail) bad('checker threw', e && e.message);
  } finally {
    try { await client.end(); } catch (_) {}
    stopTemp();
  }
  console.log(fail ? `FAIL  ${fail} problem(s)` : 'PASS  the supplier cross-check runs and decides correctly');
  process.exit(fail ? 1 : 0);
})();
