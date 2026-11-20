// ── THE PILOT TABLES MUST NOT BREAK DEVELOPMENT IDENTIFICATION ──────────────
//
//   node --test scripts/db-identity-pilot.test.js
//
// On 2026-11-20, applying the M7.6 pilot migration made `db-identity.js` refuse:
//
//     verdict: unidentified
//     4 table(s) that are neither empty nor part of M7: m76_goals, m76_plan_steps, …
//     REFUSED: not identified as development (unidentified).
//
// The check was right. It declined to call a database "development" because it contained tables it
// could not account for, and every script gating on it then refused — the state report, the M7.5
// driver, the guards. That is the correct order of events: the gate held and nothing ran.
//
// The fix imports the pilot's table names from `src/lib/m76/schema.js` instead of hand-copying
// them. These tests pin both halves: the pilot schema is now recognised, and a genuinely unknown
// table still is not.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ID = require('./lib/db-identity');
const M76 = require('../src/lib/m76/schema');

/**
 * A query stub for `identifyDatabase`. It answers the table listing and the two production probes,
 * and nothing else — anything the function asks that is not scripted is a change worth noticing.
 */
function stubFor(tables, { stops = [], populated = [] } = {}) {
  return async (sql) => {
    // `pg_tables` / `tablename`, which is what identifyDatabase actually queries. The first
    // version of this stub answered `information_schema.tables` / `table_name` — written from
    // assumption rather than from the function — so every case returned an empty table list and
    // four assertions passed for the wrong reason while four others failed confusingly.
    if (/FROM pg_tables/i.test(sql)) {
      return { rows: tables.map((tablename) => ({ tablename })) };
    }
    if (/FROM autonomy_stops/i.test(sql)) return { rows: stops };
    const m = /FROM (\w+) LIMIT 1/i.exec(sql);
    if (m) return { rows: populated.includes(m[1]) ? [{ present: 1 }] : [] };
    return { rows: [] };
  };
}

const M7_ONLY = [
  'autonomy_stops', 'autonomy_events', 'agent_runs', 'agent_run_events',
  'worker_identities', 'worker_enrollment_tokens', 'worker_request_nonces',
  'worker_tasks', 'worker_results', 'worker_audit',
];

// ── THE REGRESSION ──────────────────────────────────────────────────────────

test('DECISIVE: a database carrying the pilot tables is still DEVELOPMENT', async () => {
  const id = await ID.identifyDatabase(stubFor([...M7_ONLY, ...M76.TABLES]));
  assert.equal(id.verdict, 'development', id.detail);
  assert.match(id.detail, /M7\.6 development pilot/,
    'the operator should be able to see that the pilot schema is present');
});

test('the pilot tables are IMPORTED from their own declaration, not hand-copied', () => {
  // The hand-written M7 list was short by seven tables once. A second hand-written list would be
  // a second chance to make that mistake.
  const src = fs.readFileSync(path.join(__dirname, 'lib', 'db-identity.js'), 'utf8');
  assert.match(src, /require\('\.\.\/\.\.\/src\/lib\/m76\/schema'\)\.TABLES/,
    'the pilot table names must come from src/lib/m76/schema.js');
  assert.deepEqual(ID.M76_PILOT_TABLES, M76.TABLES);
  for (const t of M76.TABLES) {
    assert.ok(ID.EXPECTED_TABLES.includes(t), `${t} is not recognised`);
  }
});

test('a database with ONLY the pilot tables is still development', async () => {
  // The order migrations run in is not guaranteed, and a half-migrated dev database must not read
  // as unidentified and block the very script that would finish migrating it.
  const id = await ID.identifyDatabase(stubFor([...M76.TABLES]));
  assert.equal(id.verdict, 'development', id.detail);
});

test('an empty database is still development', async () => {
  const id = await ID.identifyDatabase(stubFor([]));
  assert.equal(id.verdict, 'development');
  assert.match(id.detail, /empty/);
});

// ── AND THE CONTROL: IT STILL REFUSES WHAT IT SHOULD ────────────────────────

test('DECISIVE: a table nobody can account for is STILL unidentified', async () => {
  // Without this, the fix above could have been "recognise everything", which would have removed
  // the only thing stopping these scripts running against a database they do not understand.
  const id = await ID.identifyDatabase(stubFor([...M7_ONLY, ...M76.TABLES, 'customer_invoices']));
  assert.equal(id.verdict, 'unidentified');
  assert.match(id.detail, /customer_invoices/);
});

test('an m76-looking table that is not declared is still unidentified', async () => {
  // Prefix matching would have been the lazy fix: `t.startsWith('m76_')` would accept anything
  // somebody named that way, including a table this repository has never heard of.
  const id = await ID.identifyDatabase(stubFor([...M7_ONLY, 'm76_customer_emails']));
  assert.equal(id.verdict, 'unidentified');
  assert.match(id.detail, /m76_customer_emails/);
});

test("production's three STOP rows still produce a production fingerprint", async () => {
  const id = await ID.identifyDatabase(stubFor([...M7_ONLY, ...M76.TABLES], {
    stops: [{ scope_type: 'capability', scope_key: 'email.send' }],
  }));
  assert.equal(id.verdict, 'production_fingerprint');
  assert.ok(id.findings.some((f) => /email\.send/.test(f)));
});

test('a populated production business table still produces a fingerprint', async () => {
  const id = await ID.identifyDatabase(stubFor([...M7_ONLY, ...M76.TABLES, 'users'], {
    populated: ['users'],
  }));
  assert.equal(id.verdict, 'production_fingerprint');
});

test('the pilot tables cannot mask a production fingerprint', async () => {
  // The dangerous shape: a recognised-table addition that makes the function return early before
  // the production probes run. Order matters, so it is asserted.
  const src = fs.readFileSync(path.join(__dirname, 'lib', 'db-identity.js'), 'utf8');
  const fingerprintAt = src.indexOf('PRODUCTION_FINGERPRINT');
  const positiveAt = src.indexOf('3. POSITIVE IDENTIFICATION');
  assert.ok(fingerprintAt !== -1 && positiveAt !== -1 && fingerprintAt < positiveAt,
    'production fingerprinting must happen BEFORE positive identification');
});
