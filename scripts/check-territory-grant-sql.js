#!/usr/bin/env node
// ── EXECUTE THE TERRITORY GRANT'S QUERIES AGAINST A REAL POSTGRES. ────────────
//
//   scripts/check-territory-grant-sql.js      → exit 0 = every query runs and scopes correctly
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
//
// scripts/grant-partner-territory.js was written to answer "can the partner now SEE the list",
// because POST /api/sitenex/territories only restates its own insert. On its first live run it
// granted both territories to the first partner firm and then died on the next statement:
//
//     grant-partner-territory failed: column "status" does not exist
//
// `users` has id, email, name, role, github_username, invite_token, invited_at, joined_at,
// password_hash, is_active, created_at — and no `status`. I guessed the column. So the write landed
// and the verification never ran: the one thing the script existed to do is the one thing it did
// not do, and it exited non-zero having fully succeeded.
//
// AND THE TEST I WROTE FOR IT PASSED. It asserted `/FROM users WHERE partner_id = \$1/` matched the
// source. It did match. A grep proves the words are present; it cannot prove the query runs. That
// is the same mistake as the lab ordering this morning — an assertion made where the failure cannot
// occur — and the answer is the same: execute the statement against the real schema.
//
// Skips cleanly (exit 0) where no Postgres is available.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { territoryScopeSql, DIMENSION_COLUMN } = require('../src/lib/products/territory-scope');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(String(d).split('\n').map((l) => '          ' + l).join('\n')); };

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
const findInitdb = () => BIN.find((d) => fs.existsSync(path.join(d, 'initdb'))) || null;

let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/territory-');
  const asRoot = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asRoot ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { stdio: 'pipe' });
  try {
    if (asRoot) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55996 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asRoot };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55996`;
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
  console.log('SKIP  territory grant queries not executed — this check needs a server');
  process.exit(0);
}

// THE REAL COLUMN SETS, copied from src/lib/db.js and the migrations rather than from memory —
// memory is what produced `status`. users.id is TEXT; is_active is INTEGER; joined_at is TEXT, which
// is its own old bug (CASE types text and timestamptz cannot be matched, live, in front of a
// blocked partner). None of those are tidied here: the point is to run against what production has.
const SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL, github_username TEXT, invite_token TEXT,
  invited_at TEXT, joined_at TEXT, password_hash TEXT,
  is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT NOW(),
  partner_id INTEGER, invited_partner_id INTEGER);
CREATE TABLE partners (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, status TEXT, primary_contact_email TEXT);
CREATE TABLE partner_territories (
  id SERIAL PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL, value TEXT NOT NULL,
  exclusive BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (partner_id, dimension, value));
CREATE UNIQUE INDEX uq_partner_territories_exclusive
  ON partner_territories (dimension, value) WHERE exclusive;
CREATE TABLE prospects (
  id SERIAL PRIMARY KEY, product TEXT NOT NULL, place_id TEXT NOT NULL, name TEXT NOT NULL,
  subtype TEXT, region TEXT, state TEXT, country TEXT DEFAULT 'US',
  source_partner_id INTEGER REFERENCES partners(id),
  status TEXT NOT NULL DEFAULT 'new');

INSERT INTO partners (id, name, status) VALUES (1, 'Partner One', 'active'), (2, 'Partner Two', 'active');
SELECT setval('partners_id_seq', 2);

-- Four accounts, covering the states that actually occur. The real fault behind the blocked partner
-- was an account that
-- had accepted an invite but whose users.partner_id was never set, so it saw nothing forever.
INSERT INTO users (id, email, name, role, partner_id, is_active, invite_token, joined_at) VALUES
  ('u-p1-joined','joined@partner-one.example','Joined User','partner', 1, 1, NULL, '2026-10-01T00:00:00Z'),
  ('u-p1-invited','invited@partner-one.example','Invited User','partner', 1, 1, 'tok-pending', NULL),
  ('u-p2','someone@partner-two.example','Someone','partner',    2, 1, NULL, '2026-10-01T00:00:00Z'),
  ('u-staff','staff@example.com','Staff User','super_admin',   NULL, 1, NULL, '2026-01-01T00:00:00Z');

-- The prospect geography, in the shape territory-sizing.js reported from production: region values
-- carry the state inside them, "state" is BLANK on every row, country is 'US' on every row.
INSERT INTO prospects (product, place_id, name, subtype, region, state, country, source_partner_id) VALUES
  ('sitenex','p1','Chicago Machine A','machine_shop','Chicago, IL',  NULL,'US',NULL),
  ('sitenex','p2','Chicago Pharmacy B','pharmacy',    'Chicago, IL',  NULL,'US',NULL),
  ('sitenex','p3','Rockford Tool C',  'machine_shop','Rockford, IL', NULL,'US',NULL),
  ('sitenex','p4','Peoria Funeral D', 'funeral',     'Peoria, IL',   NULL,'US',NULL),
  ('sitenex','p5','Suburb Dental E',  'dental',      'Northwest suburbs, Chicago, IL', NULL,'US',NULL),
  -- Their OWN introduction, outside every granted patch: always visible to them.
  ('sitenex','p6','Partner One Own Lead F','legal',  'Peoria, IL',   NULL,'US',1),
  -- Another partner's introduction, INSIDE the granted patch: never visible to them.
  ('sitenex','p7','Other Partner Lead G','hvac',     'Chicago, IL',  NULL,'US',2),
  -- A different product must never leak through a SiteNex territory.
  ('golfnex','p8','Golf Range H',     'range',       'Chicago, IL',  NULL,'US',NULL);
`;

const OURS = `product = 'sitenex' AND source_partner_id IS NULL`;

(async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  const q = (sql, params) => client.query(sql, params);
  try {
    await client.connect();
    await client.query(SCHEMA);
    ok('built the REAL users, partners, partner_territories and prospects column sets');

    // ── 1. THE QUERY THAT KILLED THE FIRST LIVE RUN ────
    try {
      const r = await q(
        `SELECT id, email, role, is_active, invite_token, joined_at
           FROM users WHERE partner_id = $1 ORDER BY email`, [1]);
      if (r.rows.length !== 2) bad("both of partner one's accounts are found", `got ${r.rows.length}`);
      else ok('the partner-account lookup RUNS and finds both accounts (this is what said "column status does not exist")');
    } catch (e) {
      bad('execute the partner-account lookup', e.message);
    }

    // And the column that was guessed must stay gone, so the next guess fails here too.
    try {
      await q(`SELECT status FROM users LIMIT 1`);
      bad('users has no `status` column', 'it does now — the fixture has drifted from production');
    } catch (_) { ok('users still has no `status` column, which is why the guess failed'); }

    // ── 2. NO TERRITORY = NOTHING OF OURS, BUT THEIR OWN BOOK STAYS THEIRS ────
    const held = { id: 'u-p1-joined', role: 'partner' };
    let scope = await territoryScopeSql(held, 'p', 1, { query: q });
    let n = (await q(`SELECT COUNT(*)::int n FROM prospects p WHERE p.product = 'sitenex' AND ${scope.sql}`,
      scope.params)).rows[0].n;
    if (scope.isStaff) bad('a partner account must not resolve as staff', 'isStaff was true');
    else if (n !== 1) {
      bad('with no territory, a partner sees ONLY their own introductions',
        `saw ${n}, expected 1 (their own lead) — fail closed on ours, never on theirs`);
    } else ok('no territory → 1 row: their own lead only. Fails closed on ours, not on theirs');

    // ── 3. THE GRANT, AND THE COUNT THE SCRIPT REPORTS ────
    for (const value of ['Chicago, IL', 'Rockford, IL']) {
      await q(`INSERT INTO partner_territories (partner_id, dimension, value, exclusive, created_by)
               VALUES ($1,'region',$2,false,NULL)`, [1, value]);
      // The per-grant count the dry run prints, built the way the script builds it.
      const c = (await q(`SELECT COUNT(*)::int n FROM prospects WHERE ${OURS} AND ${DIMENSION_COLUMN.region} = $1`,
        [value])).rows[0].n;
      if (!c) bad(`the per-grant count for ${value} runs and is non-zero`, `got ${c}`);
    }
    ok('both grants insert non-exclusively and their per-grant counts run');

    scope = await territoryScopeSql(held, 'p', 1, { query: q });
    const rows = (await q(
      `SELECT p.name FROM prospects p WHERE p.product = 'sitenex' AND ${scope.sql} ORDER BY p.name`,
      scope.params)).rows.map((r) => r.name);
    ok(`after the grant the partner sees ${rows.length}: ${rows.join(' · ')}`);

    // ── 4. WHAT MUST AND MUST NOT BE IN THERE ────
    const has = (frag) => rows.some((r) => r.includes(frag));
    if (!has('Chicago Machine A') || !has('Chicago Pharmacy B') || !has('Rockford Tool C')) {
      bad('every granted-region prospect is visible', rows.join(', '));
    } else ok('all three prospects inside the granted regions are visible');

    if (!has('Partner One Own Lead F')) {
      bad("a partner's OWN introduction is visible even outside the patch",
        'Peoria is not granted, but a business they brought us is theirs and a patch we drew does not decide that');
    } else ok("their own Peoria lead is visible despite Peoria not being granted");

    if (has('Other Partner Lead G')) {
      bad("another partner's introduction must NEVER be visible",
        'it sits in Chicago, which IS granted — this is exactly the case a non-exclusive overlap creates');
    } else ok("partner two's Chicago lead stays invisible — what makes a shared patch safe");

    if (has('Peoria Funeral D')) bad('an ungranted region must not leak', 'Peoria Funeral D appeared');
    else ok('Peoria, which was not granted, does not leak');

    if (has('Suburb Dental E')) {
      bad('"Northwest suburbs, Chicago, IL" is a SEPARATE region value',
        'it matched a grant of "Chicago, IL" — if this ever passes, the suburbs are being handed over silently');
    } else ok('the Chicago suburbs are a separate value and are NOT included — as the 147-row gap predicted');

    if (has('Golf Range H')) bad('another product must not leak through a SiteNex territory', 'golfnex row appeared');
    else ok('the golfnex row does not leak through a SiteNex territory');

    // ── 5. STAFF AND THE OTHER PARTNER ────
    const staffScope = await territoryScopeSql({ id: 'u-staff', role: 'super_admin' }, 'p', 1, { query: q });
    if (!staffScope.isStaff || staffScope.sql !== 'TRUE') {
      bad('staff see everything', `isStaff=${staffScope.isStaff} sql=${staffScope.sql}`);
    } else ok('staff resolve to TRUE and are unaffected by the grant');

    const otherScope = await territoryScopeSql({ id: 'u-p2', role: 'partner' }, 'p', 1, { query: q });
    const otherRows = (await q(
      `SELECT p.name FROM prospects p WHERE p.product = 'sitenex' AND ${otherScope.sql} ORDER BY p.name`,
      otherScope.params)).rows.map((r) => r.name);
    if (otherRows.length !== 1 || !otherRows[0].includes('Other Partner Lead G')) {
      bad('granting partner one a patch must not widen partner two', otherRows.join(', ') || 'none');
    } else ok('partner two still sees only its own lead — the grant did not widen anyone else');

    // ── 6. THE EXCLUSIVITY INDEX ────
    // Non-exclusive is what the script defaults to, and the reason is this index: an exclusive grant
    // locks the value against every other partner, including your own future one.
    await q(`INSERT INTO partner_territories (partner_id, dimension, value, exclusive)
             VALUES (2,'region','Chicago, IL',false)`);
    ok('a second partner CAN be granted the same region non-exclusively');
    try {
      await q(`INSERT INTO partner_territories (partner_id, dimension, value, exclusive)
               VALUES (2,'region','Rockford, IL',true)`);
      // It succeeded because partner one holds Rockford NON-exclusively. Now the reverse must fail.
      await q(`INSERT INTO partner_territories (partner_id, dimension, value, exclusive)
               VALUES (1,'subtype','pharmacy',true)`);
      await q(`INSERT INTO partner_territories (partner_id, dimension, value, exclusive)
               VALUES (2,'subtype','pharmacy',true)`);
      bad('the exclusivity index refuses a second exclusive holder', 'both exclusive inserts succeeded');
    } catch (e) {
      if (e.code === '23505') ok('a second EXCLUSIVE holder of one value is refused by the partial unique index');
      else bad('the exclusivity failure is a unique violation', `${e.code}: ${e.message}`);
    }

    // ── 7. A GRANT THAT MATCHES NOTHING ────
    // state is blank on every row, exactly as production reports. A state grant inserts, succeeds,
    // reads back correctly and conveys no access at all.
    const stateMatches = (await q(
      `SELECT COUNT(*)::int n FROM prospects WHERE ${OURS} AND ${DIMENSION_COLUMN.state} = $1`, ['IL'])).rows[0].n;
    if (stateMatches !== 0) {
      bad('the fixture must reproduce the blank state column', `got ${stateMatches}`);
    } else ok('a state grant would match 0 rows — the silent no-op the script now refuses');

    console.log('');
    console.log(fail
      ? `FAIL  ${fail} problem(s) with the territory grant queries`
      : 'PASS  every territory query runs, the patch scopes correctly, and nobody else was widened');
  } catch (e) {
    if (!fail) bad('unexpected failure', e.stack || e.message);
    console.log('\nFAIL  the territory grant queries did not check out');
  } finally {
    try { await client.end(); } catch (_) {}
    stopTemp();
  }
  process.exit(fail ? 1 : 0);
})();
