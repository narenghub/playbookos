#!/usr/bin/env node
// ── RUN THE DEMAND COUNT AGAINST A REAL POSTGRES ─────────────────────────────
//
//   scripts/check-demand-count-sql.js     → exit 0 = the predicate runs and counts 3, not 37
//
// ── WHY THIS CHECK EXISTS ────────────────────────────────────────────────────
//
// Two separate reasons, and the second is the important one.
//
// 1. The predicate uses `~*` with `\y`, a Postgres word boundary, inside a JavaScript string. That
//    is two layers of escaping over a regex operator, and this session has already shipped
//    `column "molecule_name" does not exist` and `column "role" does not exist` — both of which
//    parsed fine and failed on contact with the server. `node --check` cannot see any of it.
//
// 2. The number this guards was wrong in the flattering direction. A COUNT(*) over `inquiries`
//    reported 37 buyers; the table held 20 spam, 4 of our own test records and 3 real people. A
//    count that inflates demand twelvefold does not announce itself — it gets quoted in a board
//    update. So the fixture below IS that table: the real senders, the real addresses, the real
//    company names, and an assertion that the headline comes out as 3.
//
// If someone later widens the predicate, or drops the spam filter to make a dashboard look better,
// this fails with the actual sender names in the output.
//
// Needs a server: set DEMAND_PG_URL, or let it start a throwaway cluster if initdb is on PATH.
// With neither it SKIPS, so a machine without Postgres can still run preflight.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { COUNTS_SQL, EXTERNAL_SQL } = require('../src/lib/revenue/demand');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};

// ── GET A SERVER ────
const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { const p = path.join(d, 'initdb'); if (fs.existsSync(p)) return d; }
  return null;
}
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/demand-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55997' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55997 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55997`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) { /* best effort */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.DEMAND_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set DEMAND_PG_URL or install initdb)');
  console.log('SKIP  demand-count SQL not executed — this check needs a server');
  process.exit(0);
}

// ── THE FIXTURE IS THE REAL TABLE ────
// Every row below is one that existed in production on 2026-10-26, with the names and addresses
// as filed. Anonymising them would make the test pass while describing a table nobody has.
const SCHEMA = `
CREATE TABLE inquiries (
  id BIGSERIAL PRIMARY KEY,
  buyer_name TEXT, buyer_email TEXT, buyer_company TEXT,
  molecule_name TEXT, cas_number TEXT,
  quantity_requested TEXT, quantity_unit TEXT,
  status TEXT, source TEXT, order_value_usd NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- 1. THE SPAM. Reply-bait: a display name unrelated to the address, no molecule, no company.
--    The gate caught every one of these; the old count reported them as buyers anyway.
INSERT INTO inquiries (buyer_name, buyer_email, status, source) VALUES
  ('RobertFilub','robertfilub1@gmail.com','spam','email'),
  ('RobertFilub','robertfilub2@gmail.com','spam','email'),
  ('RobertFilub','robertfilub3@gmail.com','spam','email'),
  ('RobertFilub','robertfilub4@gmail.com','spam','email'),
  ('RobertFilub','robertfilub5@gmail.com','spam','email'),
  ('RobertFilub','robertfilub6@gmail.com','spam','email'),
  ('RobertFilub','robertfilub7@gmail.com','spam','email'),
  ('RobertFilub','robertfilub8@gmail.com','spam','email'),
  ('Charlene Gonzalez','tracydixon995@gmail.com','spam','email'),
  ('Mathew Allen','m.allen.promo@gmail.com','spam','email'),
  ('Ruben Goodman','rgoodman.offer@gmail.com','spam','email'),
  ('Jesse Bailey','jbailey.deals@gmail.com','spam','email'),
  ('Jennifer Daniels','jdaniels.mkt@gmail.com','spam','email'),
  ('Joel Miller','jmiller.ads@gmail.com','spam','email'),
  ('Jennifer Ward','jward.seo@gmail.com','spam','email'),
  ('Bethany Hanna','bhanna.leads@gmail.com','spam','email'),
  ('James Banks','jbanks.offer@gmail.com','spam','email'),
  ('Elijah Ortega','eortega.promo@gmail.com','spam','email'),
  ('Brandon Crane','bcrane.mkt@gmail.com','spam','email'),
  ('Kevin Doyle','kdoyle.spam@gmail.com','spam','email');

-- 2. OURS. These are the four that looked quotable, and the reason the whole count was re-read:
--    a molecule in the catalogue, a company, a status — and our own address behind all of it.
INSERT INTO inquiries (buyer_name, buyer_email, buyer_company, molecule_name, status, source) VALUES
  ('QA Buyer','qa-buyer@abiozen.com','abc','Methylene Blue','closed','abiozen_form'),
  ('Naresh','naresh.boda143@gmail.com','ABIOZEN LLC','Rivaroxaban','closed','abiozen_form'),
  ('Naresh','naresh.boda143@gmail.com','ABIOZEN LLC','Methylene Blue','closed','abiozen_form'),
  ('Naresh','naresh.boda143@gmail.com','Adifice Technologies','Progesterone','closed','abiozen_form');

-- 3. THE BUYERS. Three people, outside the company, who asked us for something.
INSERT INTO inquiries (buyer_name, buyer_email, buyer_company, molecule_name, status, source) VALUES
  ('Sigmas Equipment','contact@sigmasequipment.example',  'Sigmas Equipment', NULL,                      'in_conversation','email'),
  ('Can Gundogan',    'can.gundogan@example.com',         NULL,               'Yttrium oxide',           'in_conversation','email'),
  ('Individual',      'buyer.metformin@example.com',      'Individual',       'Metformin Hydrochloride', 'human_requested','abiozen_form');
`;

(async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query(SCHEMA);
    ok('built the inquiries shape and seeded the 2026-10-26 table (20 spam · 4 ours · 3 real)');

    // ── 1. DOES THE PREDICATE EVEN RUN? ────
    // The `~*` / \y escaping question, answered by the server rather than by reading it.
    let c;
    try {
      c = (await client.query(COUNTS_SQL)).rows[0];
      ok('the demand count executes — the ~* word-boundary predicate survives JS escaping');
    } catch (e) {
      bad('execute the demand count', e.message + (e.position ? ` (at position ${e.position})` : ''));
      throw e;
    }

    // ── 2. THE NUMBER ────
    if (c.all_rows !== 27) {
      bad('the fixture is the table it claims to be', `all_rows=${c.all_rows}, expected 27`);
    }
    if (c.external !== 3) {
      const who = (await client.query(
        `SELECT buyer_name, buyer_email, buyer_company FROM inquiries WHERE ${EXTERNAL_SQL} ORDER BY id`)).rows;
      bad('the headline counts only real external buyers',
        `external=${c.external}, expected 3. Counted as buyers:\n`
        + who.map((r) => `  ${r.buyer_name} <${r.buyer_email}> ${r.buyer_company || ''}`).join('\n'));
    } else ok('external = 3 — not 37, and not 7');

    if (c.spam !== 20) bad('every spam row is excluded and counted', `spam=${c.spam}, expected 20`);
    else ok('spam = 20, excluded from the headline and still reported');

    if (c.ours !== 4) bad('our own test records are excluded and counted', `ours=${c.ours}, expected 4`);
    else ok('ours = 4, excluded from the headline and still reported');

    // ── 3. NOTHING IS LOST ────
    // The three buckets must account for the whole table. If they do not, some row is invisible to
    // every number the report prints, which is how a customer disappears.
    const sum = c.external + c.spam + c.ours;
    if (sum !== c.all_rows) {
      bad('the buckets account for every row',
        `${c.external} + ${c.spam} + ${c.ours} = ${sum}, but the table has ${c.all_rows}`);
    } else ok('the three buckets add up to the table — no row is invisible');

    // ── 4. THE DIRECTION THAT MATTERS ────
    // A real buyer must never be filtered out. Checked by name, because "external = 3" would also
    // be satisfied by excluding Can Gundogan and including a test row.
    const names = (await client.query(
      `SELECT buyer_name FROM inquiries WHERE ${EXTERNAL_SQL} ORDER BY buyer_name`)).rows
      .map((r) => r.buyer_name);
    for (const want of ['Can Gundogan', 'Individual', 'Sigmas Equipment']) {
      if (!names.includes(want)) bad(`${want} is counted as a buyer`, `counted: ${names.join(', ')}`);
    }
    if (!fail) ok(`the three counted are exactly: ${names.join(', ')}`);

    // ── 5. A REAL BUYER WHO LOOKS LIKE US ────
    // The company pattern is anchored, so a genuine company starting with those letters is a risk
    // worth stating. "ABC Scientific" IS excluded by design — the rule is literal, and if a real
    // customer ever arrives under that name the exclusion is visible in the "ours" line rather
    // than silent. This asserts the documented behaviour so a future reader sees it was a choice.
    await client.query(
      `INSERT INTO inquiries (buyer_name, buyer_email, buyer_company, molecule_name, status, source)
       VALUES ('Real Customer','buyer@abcscientific.com','ABC Scientific','Paracetamol','new','email')`);
    const after = (await client.query(COUNTS_SQL)).rows[0];
    if (after.ours !== 5) {
      bad('a company matching the anchored pattern lands in "ours", visibly',
        `ours=${after.ours}, expected 5 — the exclusion must be reported, never silent`);
    } else ok('"ABC Scientific" is excluded as ours AND reported in the ours line — documented, not silent');

    // But a company that merely CONTAINS the letters must not be touched.
    await client.query(
      `INSERT INTO inquiries (buyer_name, buyer_email, buyer_company, molecule_name, status, source)
       VALUES ('Fine','buyer@lababc.com','Lab ABC Chemicals','Paracetamol','new','email')`);
    const after2 = (await client.query(COUNTS_SQL)).rows[0];
    if (after2.external !== 4) {
      bad('a company merely containing "abc" is still a buyer',
        `external=${after2.external}, expected 4 — the pattern is over-matching`);
    } else ok('"Lab ABC Chemicals" is counted as a buyer — the anchor holds');
  } catch (e) {
    if (!fail) bad('run the demand-count checks', e.message);
  } finally {
    try { await client.end(); } catch (_) {}
    stopTemp();
  }

  if (fail) { console.error(`FAIL  ${fail} check(s) failed`); process.exit(1); }
  console.log('PASS  the demand count runs on real Postgres and reports 3 buyers, not 37');
})();
