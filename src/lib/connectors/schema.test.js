// ── THE CONTROLS THAT LIVE IN THE DATABASE, NOT IN A CODE PATH ──────────────
//
//   node --test src/lib/connectors/schema.test.js
//
// sync-run.test.js proves the application refuses the wrong things. This file proves the ENGINE
// does too, because the application is one caller among several and the next one will be written
// by somebody who has not read it. src/lib/office/schema.js puts it plainly: a constraint in the
// schema "fires on the write, from inside the engine, whoever is connected and whatever they
// forgot."
//
// These read the DDL text rather than a live cluster. That is a real limit and worth naming: this
// asserts the migration SAYS the right thing, not that a server accepted it. Applying it against
// a throwaway cluster is PR-2's production-validation step and is not authorized yet (ruling 8 —
// no production migrations). What this does catch is the migration drifting away from the design
// without anybody noticing, which is the failure that actually happens.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { DDL, CONNECTOR_SEED, CONNECTOR_TABLES, GLOBAL_TABLES, migrateConnectors } = require('./schema');

const ddl = DDL.join('\n;\n');
const stmtFor = (re) => DDL.find((s) => re.test(s)) || '';

// ── tenant isolation, engine-side ───────────────────────────────────────────

test('every tenant table declares company_id NOT NULL — new tables are owed no legacy latitude', () => {
  for (const t of CONNECTOR_TABLES) {
    const s = stmtFor(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`));
    assert.ok(s, `no CREATE TABLE for ${t}`);
    assert.match(s, /company_id\s+TEXT NOT NULL REFERENCES companies\(id\)/,
      `${t}.company_id must be NOT NULL and reference companies — a nullable tenant column on a `
      + 'new table reopens the MATCH FULL evasion the kernel exists to close');
  }
});

test('the run linkage is MATCH FULL, not the MATCH SIMPLE default', () => {
  const s = stmtFor(/fk_source_sync_runs_run_company/);
  assert.match(s, /FOREIGN KEY \(run_id, company_id\) REFERENCES agent_runs \(run_id, company_id\)/);
  assert.match(s, /MATCH FULL/,
    'MATCH SIMPLE passes if any column is NULL, which on a nullable company_id is an evasion');
  assert.match(s, /NOT VALID/,
    'existing agent_runs history must not be re-examined; new writes are still enforced');
});

test('run_id is NOT NULL, which is what forces every sync inside an agent_run', () => {
  const s = stmtFor(/CREATE TABLE IF NOT EXISTS source_sync_runs/);
  assert.match(s, /run_id\s+UUID NOT NULL/);
  // Under MATCH FULL with company_id NOT NULL the pair can never be half-present anyway, so this
  // makes the consequence explicit instead of leaving it to be rediscovered as a constraint error.
});

test('source_connectors deliberately carries no company_id, and is excluded from the tenant list', () => {
  const s = stmtFor(/CREATE TABLE IF NOT EXISTS source_connectors/);
  assert.ok(!/company_id/.test(s),
    'that USAspending needs no key is a fact about the world, not tenant data');
  for (const g of GLOBAL_TABLES) assert.ok(!CONNECTOR_TABLES.includes(g), `${g} must not be listed as tenant-scoped`);
});

// ── idempotency, engine-side ────────────────────────────────────────────────

test('the natural key is a UNIQUE INDEX — §15 cannot be an application-side check', () => {
  assert.match(ddl, /CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_natural_key\s+ON federal_awards \(company_id, source_key, award_key\)/,
    'two concurrent syncs both read "absent" and both insert unless the database refuses the second');
});

test('the natural key is scoped by company, so two tenants can hold the same public award', () => {
  const m = ddl.match(/idx_fa_natural_key\s+ON federal_awards \(([^)]+)\)/);
  assert.ok(m, 'index not found');
  assert.equal(m[1].split(',')[0].trim(), 'company_id',
    'company_id must lead the unique key — Abiozen and CRO360 may both track the same award');
});

// ── the sentinel ────────────────────────────────────────────────────────────

test("'-NONE-' is unstoreable in parent_piid, not merely discouraged", () => {
  const s = stmtFor(/CREATE TABLE IF NOT EXISTS federal_awards/);
  assert.match(s, /CONSTRAINT federal_awards_parent_sentinel_check/);
  assert.match(s, /parent_piid IS NULL OR parent_piid NOT IN \('-NONE-', 'NONE', ''\)/);
  // PR-1 measured 3 of 10 awards carrying it. Stored verbatim, every later join on parent_piid
  // matches unrelated standalone awards — a wrong answer, not an empty one.
});

// ── the ceiling ─────────────────────────────────────────────────────────────

test('the call ceiling is enforced by a CHECK, so the engine refuses the overrun too', () => {
  const s = stmtFor(/CREATE TABLE IF NOT EXISTS source_sync_runs/);
  assert.match(s, /calls_made >= 0 AND \(call_ceiling IS NULL OR calls_made <= call_ceiling\)/);
});

test('a ceiling of zero is not expressible — null means unmetered', () => {
  const s = stmtFor(/CREATE TABLE IF NOT EXISTS source_connectors/);
  assert.match(s, /daily_call_ceiling IS NULL OR daily_call_ceiling > 0/,
    'a ceiling of 0 would read as "no quota" to a careless caller and "never sync" to a careful one');
});

test('only the five real statuses are accepted', () => {
  const s = stmtFor(/CREATE TABLE IF NOT EXISTS source_sync_runs/);
  assert.match(s, /status IN \('running','completed','failed','ceiling_reached','refused'\)/);
});

// ── the seed is the control for rulings 3 and 5 ─────────────────────────────

test('ruling 5: SAM.gov is seeded prepared-but-not-activated, at the personal-key ceiling', () => {
  const sam = CONNECTOR_SEED.find((c) => c.source_key === 'sam_gov');
  assert.ok(sam);
  assert.strictEqual(sam.activated, false, 'ruling 5 — not activated until access and quotas are verified');
  assert.strictEqual(sam.daily_call_ceiling, 10,
    'the personal-key limit. If activated before a system account exists, the ceiling stops it at '
    + 'ten calls rather than letting it 429 mid-page and leave a false watermark');
  assert.match(sam.notes, /2026-12-30/, 'the registration expiry belongs on the record');
});

test('ruling 3: the two portals are manual_assisted, which beginSync refuses', () => {
  for (const key of ['fedconnect', 'hhs_sbcx']) {
    const c = CONNECTOR_SEED.find((x) => x.source_key === key);
    assert.ok(c, `${key} not seeded`);
    assert.equal(c.access_mode, 'manual_assisted');
    assert.equal(c.auth_mode, 'portal_login');
    assert.strictEqual(c.activated, false);
  }
  const fc = CONNECTOR_SEED.find((x) => x.source_key === 'fedconnect');
  assert.match(fc.notes, /UNKNOWN, not denied/,
    'we measured a 302 to a sign-in page; that is not evidence that no API exists');
});

test('ruling 4: Grants.gov is kind=funding and says so in its notes', () => {
  const g = CONNECTOR_SEED.find((c) => c.source_key === 'grants_gov');
  assert.equal(g.kind, 'funding');
  assert.equal(g.auth_mode, 'none');
  assert.match(g.notes, /never procurement revenue/);
  assert.match(g.notes, /forecast is a PLAN/, 'the biddability trap belongs on the record');
});

test('USAspending is the only source seeded active, and its caveats travel with it', () => {
  const active = CONNECTOR_SEED.filter((c) => c.activated);
  assert.deepEqual(active.map((c) => c.source_key), ['usaspending']);
  const u = active[0];
  assert.strictEqual(u.daily_call_ceiling, null, 'no published quota — not a quota of nothing');
  assert.match(u.notes, /OBLIGATIONS at action time, not outlays/);
  assert.match(u.notes, /withheld ~90 days/);
  assert.match(u.notes, /not name matching/);
});

test('no seeded ceiling is invented — every one is null or a documented number', () => {
  for (const c of CONNECTOR_SEED) {
    if (c.daily_call_ceiling !== null) {
      assert.equal(c.source_key, 'sam_gov',
        `${c.source_key} has a ceiling of ${c.daily_call_ceiling} but no published limit — an `
        + 'invented number looks like knowledge');
    }
  }
});

// ── the migration runner ────────────────────────────────────────────────────

test('re-running the seed never flips activated — that is an operational decision, not a migration', async () => {
  const seen = [];
  await migrateConnectors(async (sql, params) => {
    seen.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { rows: [] };
  });
  const upserts = seen.filter((s) => /INSERT INTO source_connectors/.test(s.sql));
  assert.equal(upserts.length, CONNECTOR_SEED.length);
  for (const u of upserts) {
    const doUpdate = u.sql.slice(u.sql.indexOf('DO UPDATE SET'));
    assert.ok(!/\bactivated\b/.test(doUpdate),
      'a migration re-run must not quietly switch a source on — or off');
    assert.match(doUpdate, /notes\s+= EXCLUDED\.notes/, 'corrected notes should still propagate');
  }
});

test('the migration only swallows the three "already exists" codes', async () => {
  // A migration that hides a real error is worse than one that fails — the office schema's words.
  await assert.rejects(
    migrateConnectors(async () => { const e = new Error('permission denied'); e.code = '42501'; throw e; }),
    /connector schema failed on/);

  let applied = 0;
  await migrateConnectors(async () => {
    applied += 1;
    if (applied <= DDL.length) { const e = new Error('already exists'); e.code = '42P07'; throw e; }
    return { rows: [] };
  });
  assert.ok(applied > DDL.length, 'duplicate-object errors are survivable and the seed still runs');
});

test('the rollback is documented in the file, and drops in dependency order', () => {
  const src = require('node:fs').readFileSync(require.resolve('./schema'), 'utf8');
  const rb = src.slice(src.indexOf('ROLLBACK'), src.indexOf('ROLLBACK') + 400);
  for (const t of [...CONNECTOR_TABLES, ...GLOBAL_TABLES]) {
    assert.ok(rb.includes(`DROP TABLE IF EXISTS ${t}`), `${t} missing from the documented rollback`);
  }
  assert.ok(rb.indexOf('federal_awards') < rb.indexOf('source_connectors'),
    'children drop before the table they reference');
});
