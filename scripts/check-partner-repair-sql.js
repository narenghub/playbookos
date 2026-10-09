#!/usr/bin/env node
// ── EXECUTE THE PARTNER REPAIR'S SQL AGAINST A REAL POSTGRES. ─────────────────
//
//   scripts/check-partner-repair-sql.js      → exit 0 = the statements run on real column types
//
// WHY THIS EXISTS: the repair shipped with
//
//     joined_at = CASE WHEN $2 THEN NOW() ELSE joined_at END
//
// and failed on the live database with "CASE types text and timestamp with time zone cannot be
// matched", because users.joined_at is TEXT — /auth/accept-invite writes an ISO string into it —
// so NOW() in the other branch is a type Postgres will not reconcile. `node --check` passed. The
// unit suite passed. It failed on the one machine that matters, in front of a partner who was
// already blocked, and it was the SECOND type mismatch to reach production in a day.
//
// A one-off operations script is exactly where this bites hardest: it runs once, under pressure,
// against production, with no second chance to notice. So its statements get the same treatment as
// the molecule search and the sponsor ranking — run them on a real server, with the real column
// types, before anyone runs them for real.
//
// Skips cleanly (exit 0) where no Postgres is available.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log('          ' + String(d).split('\n').join('\n          ')); };

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
const findInitdb = () => BIN.find((d) => fs.existsSync(path.join(d, 'initdb'))) || null;

let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/partnerrepair-');
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
  console.log('SKIP  partner repair SQL not executed — this check needs a server');
  process.exit(0);
}

// The REAL column types, copied from src/lib/db.js. joined_at is TEXT, and that is the whole point:
// declaring it timestamptz here would make this check pass while production still failed.
const SCHEMA = `
CREATE TABLE partners (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, primary_contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, role TEXT,
  invited_at TEXT, joined_at TEXT, password_hash TEXT,
  invite_token TEXT, invited_products TEXT[], invited_by TEXT,
  excluded_from_scoring BOOLEAN, is_active INTEGER DEFAULT 1,
  partner_id INTEGER REFERENCES partners(id),
  invited_partner_id INTEGER REFERENCES partners(id));
CREATE TABLE user_products (
  user_id TEXT, product TEXT, granted_by TEXT, granted_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, product));
CREATE TABLE user_product_grants_log (
  id BIGSERIAL PRIMARY KEY, user_id TEXT, user_email TEXT, product TEXT,
  action TEXT, actor_id TEXT, source TEXT, at TIMESTAMPTZ DEFAULT NOW());
-- source_partner_id, NOT partner_id. The first version of this fixture invented a partner_id
-- column on prospects, which made the repair script's count query look correct here while it threw
-- in production and had its error swallowed by a .catch() that returned 0. A fixture that models a
-- column the real schema does not have is worse than no fixture.
CREATE TABLE outreach_prospects (id BIGSERIAL PRIMARY KEY, source_partner_id INTEGER);
CREATE TABLE partner_territories (
  id SERIAL PRIMARY KEY, partner_id INTEGER REFERENCES partners(id),
  dimension TEXT, value TEXT, exclusive BOOLEAN DEFAULT FALSE, created_by TEXT);

INSERT INTO partners (name, status) VALUES ('ACBM Partners', 'active');
-- The live account's exact shape: a password, NO joined_at, no partner_id, products parked.
INSERT INTO users (id, email, role, password_hash, joined_at, invited_products, invited_by, excluded_from_scoring)
  VALUES ('u-partner', 'partner@example.test', 'partner', 'hash', NULL, ARRAY['sitenex'], 'u-super', TRUE);
-- An account that already joined: its join date must never be overwritten.
INSERT INTO users (id, email, role, password_hash, joined_at, invited_by)
  VALUES ('u-old', 'old@example.test', 'partner', 'hash', '2026-01-01T00:00:00.000Z', 'u-super');
`;

(async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query(SCHEMA);
    ok('built users/partners/user_products with the REAL column types (joined_at TEXT)');

    // ── THE STATEMENT THAT FAILED IN PRODUCTION ────
    const UPDATE = `UPDATE users
                       SET partner_id = $1,
                           joined_at  = COALESCE(joined_at, $2)
                     WHERE id = $3
                     RETURNING id, email, role, partner_id, joined_at`;

    const iso = new Date().toISOString();
    let row;
    try {
      row = (await client.query(UPDATE, [1, iso, 'u-partner'])).rows[0];
      ok('the repair UPDATE runs');
    } catch (e) {
      bad('the repair UPDATE runs', e.message);
      throw e;
    }

    if (row.partner_id !== 1) bad('partner_id is set', `got ${row.partner_id}`);
    else ok('partner_id set to the named partner');
    if (row.joined_at !== iso) bad('joined_at is set when it was NULL', `got ${row.joined_at}`);
    else ok('joined_at set, as an ISO string — the same format accept-invite writes');

    // ── AND THE ONE THE OLD VERSION WOULD HAVE GOT WRONG ────
    const old = (await client.query(UPDATE, [1, iso, 'u-old'])).rows[0];
    if (old.joined_at !== '2026-01-01T00:00:00.000Z') {
      bad('an existing join date is NEVER overwritten',
        `was 2026-01-01T00:00:00.000Z, now ${old.joined_at} — COALESCE is what prevents this`);
    } else ok('an account that already joined keeps its original join date');

    // Prove the old shape really was broken, so this check cannot be quietly "simplified" back.
    try {
      await client.query(
        `UPDATE users SET joined_at = CASE WHEN $1 THEN NOW() ELSE joined_at END WHERE id = $2`,
        [true, 'u-partner']);
      bad('the CASE/NOW() form is still rejected by Postgres',
        'it SUCCEEDED here, so this guard no longer proves anything — check the column type');
    } catch (e) {
      if (/cannot be matched|types text and timestamp/i.test(e.message)) {
        ok('the CASE/NOW() form is still rejected — this check is testing the real failure');
      } else {
        bad('the CASE/NOW() form fails for the EXPECTED reason', e.message);
      }
    }

    // ── THE GRANT STATEMENTS, which run in the same script ────
    try {
      await client.query(
        `INSERT INTO user_products (user_id, product, granted_by) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, product) DO NOTHING`, ['u-partner', 'sitenex', 'u-super']);
      await client.query(
        `INSERT INTO user_product_grants_log (user_id, user_email, product, action, actor_id, source)
         VALUES ($1,$2,$3,'grant',$4,'repair_partner_link')`,
        ['u-partner', 'partner@example.test', 'sitenex', 'u-super']);
      await client.query(`UPDATE users SET invited_products = NULL WHERE id = $1`, ['u-partner']);
      ok('the grant insert, the audit log insert and the clear all run');
    } catch (e) {
      bad('the grant statements run', e.message);
    }

    const held = (await client.query(
      `SELECT product FROM user_products WHERE user_id = $1`, ['u-partner'])).rows.map((r) => r.product);
    if (held.join() !== 'sitenex') bad('the grant landed', JSON.stringify(held));
    else ok('the authorised product is now held');

    const logged = (await client.query(
      `SELECT source FROM user_product_grants_log WHERE user_id = $1`, ['u-partner'])).rows;
    if (logged.length !== 1 || logged[0].source !== 'repair_partner_link') {
      bad('the grant is audited with its own source', JSON.stringify(logged));
    } else ok('audited as repair_partner_link — every route to a grant lands in one table');

    // ── THE REVOKE, which runs against a live account and must not over-delete ────
    await client.query(
      `INSERT INTO user_products (user_id, product, granted_by) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, product) DO NOTHING`, ['u-partner', 'internal', 'u-super']);
    await client.query(
      `INSERT INTO user_products (user_id, product, granted_by) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, product) DO NOTHING`, ['u-old', 'internal', 'u-super']);

    const del = await client.query(
      `DELETE FROM user_products WHERE user_id = $1 AND product = $2`, ['u-partner', 'internal']);
    if (del.rowCount !== 1) {
      bad('the revoke deletes EXACTLY one row', `deleted ${del.rowCount} — by (user, product), never by pattern`);
    } else ok('the revoke deletes exactly one row, by the (user, product) pair');

    const other = (await client.query(
      `SELECT COUNT(*)::int n FROM user_products WHERE user_id = $1 AND product = 'internal'`,
      ['u-old'])).rows[0].n;
    if (other !== 1) bad('another account holding the same product is untouched', `got ${other}`);
    else ok('another account holding the same product is untouched');

    const kept = (await client.query(
      `SELECT product FROM user_products WHERE user_id = $1 ORDER BY product`, ['u-partner'])).rows.map((r) => r.product);
    if (kept.join() !== 'sitenex') bad('the account keeps its other products', JSON.stringify(kept));
    else ok('the account keeps its other products');

    await client.query(
      `INSERT INTO user_product_grants_log (user_id, user_email, product, action, actor_id, source)
       VALUES ($1,$2,$3,'revoke',$4,'revoke_product_script')`,
      ['u-partner', 'partner@example.test', 'internal', null]);
    const revLog = (await client.query(
      `SELECT action FROM user_product_grants_log WHERE user_id = $1 AND action = 'revoke'`,
      ['u-partner'])).rows;
    if (revLog.length !== 1) bad('a revocation is audited like a grant', JSON.stringify(revLog));
    else ok('a revocation is audited too — the one event that must not be missing from the history');

    // ── THE QUERIES THAT REPORT WHAT A PARTNER WILL SEE ────
    //
    // These are the ones that were silently wrong: a count against a partner_id column that
    // prospects do not have, inside a .catch() that returned 0. Run them for real so a missing
    // column is a FAILURE here rather than a confident zero in front of the person waiting on it.
    try {
      await client.query(
        `SELECT COUNT(*)::int n FROM outreach_prospects WHERE source_partner_id = $1`, [1]);
      ok('the prospect count uses source_partner_id — the column that exists');
    } catch (e) {
      bad('the prospect count runs against the real schema', e.message);
    }
    try {
      await client.query(
        `SELECT dimension, value, exclusive FROM partner_territories
          WHERE partner_id = $1 ORDER BY dimension, value`, [1]);
      ok('the territory read runs');
    } catch (e) {
      bad('the territory read runs', e.message);
    }
    // And prove the OLD query really was broken, so it cannot quietly come back.
    try {
      await client.query(`SELECT COUNT(*) FROM outreach_prospects WHERE partner_id = $1`, [1]);
      bad('prospects still have NO partner_id column',
        'the query SUCCEEDED — if prospects have grown a partner_id, the territory-scope decision ' +
        'about who owns a lead has changed and src/lib/products/territory-scope.js must be re-read');
    } catch (e) {
      if (/column .*partner_id.* does not exist/i.test(e.message)) {
        ok('prospects have no partner_id — the old count was querying nothing, as suspected');
      } else {
        bad('the old query fails for the EXPECTED reason', e.message);
      }
    }

    // Replay: the script may be run twice by someone unsure whether it worked.
    await client.query(UPDATE, [1, new Date().toISOString(), 'u-partner']);
    await client.query(
      `INSERT INTO user_products (user_id, product, granted_by) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, product) DO NOTHING`, ['u-partner', 'sitenex', 'u-super']);
    const after = (await client.query(
      `SELECT COUNT(*)::int n FROM user_products WHERE user_id = $1`, ['u-partner'])).rows[0].n;
    if (after !== 1) bad('a second run cannot double-grant', `${after} rows`);
    else ok('a second run is harmless — no double grant, no moved join date');

  } catch (e) {
    if (!fail) bad('unexpected error', e.message);
  } finally {
    try { await client.end(); } catch (_) {}
    stopTemp();
  }

  if (fail) { console.error(`FAIL  ${fail} check(s) failed`); process.exit(1); }
  console.log('PASS  the partner repair SQL runs on real column types and is safe to replay');
})();
