#!/usr/bin/env node
// ── THE DEVELOPMENT OPERATOR REGISTRY, AGAINST A REAL POSTGRES ───────────────
//
//   node scripts/check-dev-operator-registry-db.js; echo "EXIT=$?"
//
// Owner directive of 2026-11-27, Option A: *"Add positive and negative integration tests covering
// the registry, authenticated minting, impersonation attempts, revocation, concurrent token
// exchange, production database refusal and synthetic-only restrictions."*
//
// ── WHY A REAL DATABASE AND NOT A FAKE ───────────────────────────────────────
//
// Three of the properties here are arbitrated by Postgres and by nothing else:
//
//   • `dev_operators_synthetic_only_required` and `dev_operators_no_privileged_caps` are CHECK
//     constraints. A fake that emulates them emulates the thing under test, and the owner's
//     standing instruction is explicit: *"Do not treat the absence of UPDATE statements as proof of
//     database-enforced immutability."*
//   • the single-use enrollment token is an atomic `UPDATE … WHERE consumed_at IS NULL … RETURNING`.
//     This project has already paid for testing that against a fake twice over — a concurrency test
//     that passed because a connection pool serialised the requests rather than because anything
//     arbitrated them.
//
// So the concurrency section below issues both exchanges on SEPARATE pooled connections and starts
// them before awaiting either.
//
// ── THE COVERAGE SECTION IS THE ONE THAT PREVENTS SILENT DRIFT ───────────────
//
// `src/lib/worker/dev-identity.js` hand-writes four table names, because `autonomy.js` and
// `runs.js` export migrate functions and no DDL array. A hand-written list is a liability this
// repo has already paid for: `db-identity.js` records that its own list *"was short by seven
// tables, because it was written from memory rather than from the migrations."*
//
// Section 0 therefore RUNS the real development migrations and asserts that everything they create
// is covered by the declared set. The list cannot go stale silently; this turns red the moment it
// does.

'use strict';

const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n  ── ${m} ──\n`);

const SEAL = { WORKER_SECRET_SEAL_KEY: 'a7'.repeat(32) };

const { startTemp: __startTemp, stopTemp } = require('./lib/pg-legacy-harness');
const url = __startTemp('dev-operators');
if (!url) {
  console.log('  skip  no Postgres available');
  console.log('SKIP  the development operator registry was NOT exercised — this proved nothing.');
  process.exit(EXIT_NOT_EXECUTED);
}

/** Did this throw, and did the message say the right thing? */
async function refuses(label, fn, mustMatch) {
  try {
    await fn();
    bad(label, 'it returned instead of refusing');
    return null;
  } catch (e) {
    const msg = String(e && e.message);
    if (mustMatch && !mustMatch.test(msg)) {
      bad(label, `refused, but for the wrong reason: ${msg.slice(0, 180)}`);
      return msg;
    }
    ok(label);
    return msg;
  }
}

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: false, max: 12 });
  const query = (sql, params) => pool.query(sql, params);

  const IDENTITY = require('../src/lib/worker/identity');
  const SCHEMA = require('../src/lib/worker/identity-schema');
  const DEVOPS = require('../src/lib/worker/dev-operators');
  const DEVOPS_SCHEMA = require('../src/lib/worker/dev-operators-schema');
  const DEV_IDENTITY = require('../src/lib/worker/dev-identity');

  const deps = { query, env: SEAL };
  const CRED = `cred_${'x'.repeat(40)}`;

  console.log('\n══ DEVELOPMENT OPERATOR REGISTRY — REAL POSTGRES ══');
  note('disposable cluster; production is never contacted');

  // ── 0. THE DECLARED SET COVERS WHAT THE MIGRATIONS ACTUALLY CREATE ────────
  head('0. the declared development table set is not stale');

  const STEPS = [
    () => require('../src/lib/autonomy').migrateAutonomy(query),
    () => require('../src/lib/runs').migrateRuns(query),
    () => require('../src/lib/office/schema').migrateOffice(query),
    () => require('../src/lib/worker/identity').migrateWorkerIdentity(query),
    () => require('../src/lib/worker/leases').migrateWorkerTasks(query),
    () => require('../src/lib/worker/audit').migrateWorkerAudit(query),
    // m76/schema's migrate takes a DEPS OBJECT, not a query function — `migrate(query)` would
    // silently fall through to `require('../db').query` and talk to whatever DATABASE_URL names,
    // which in this process is nothing and in a developer's shell could be anything at all. It
    // failed loudly here (ECONNREFUSED 127.0.0.1:5432) only because no default is configured.
    () => require('../src/lib/m76/schema').migrate({ query }),
    () => DEVOPS_SCHEMA.migrateDevOperators(query),
  ];
  for (const step of STEPS) await step();
  ok(`${STEPS.length} development migration steps applied`);

  // Idempotent, asserted rather than assumed: the real dev path reruns these.
  for (const step of STEPS) await step();
  ok('the development migration steps are idempotent');

  const present = (await query(
    `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename`)
  ).rows.map((r) => String(r.tablename).toLowerCase());
  const declared = DEV_IDENTITY.declaredTables();

  if (!present.length) {
    bad('the migrations created no tables', 'every comparison below would be vacuous');
  } else {
    const missing = present.filter((t) => !declared.has(t));
    if (missing.length) {
      bad('dev-identity.js does not declare every table the development migrations create',
        `undeclared: ${missing.join(', ')} — add them to the declared set or to UNDERIVABLE_TABLES`);
    } else {
      ok(`all ${present.length} created tables are covered by the declared set`);
    }
    // The converse, so the assertion above cannot pass by declaring everything: each hand-written
    // name must actually be created by the migrations.
    const phantom = DEV_IDENTITY.UNDERIVABLE_TABLES.filter((t) => !present.includes(t));
    if (phantom.length) {
      bad('UNDERIVABLE_TABLES names tables the migrations do not create',
        `phantom: ${phantom.join(', ')}`);
    } else {
      ok('every hand-written name in UNDERIVABLE_TABLES is really created by a migration');
    }
  }

  const ident = await DEV_IDENTITY.identifyIsolatedDevelopment(query);
  if (ident.ok && ident.verdict === 'isolated_development') {
    ok(`positive identification: ${ident.detail}`);
  } else {
    bad('a freshly migrated development database does not identify as isolated development',
      `${ident.verdict}: ${ident.detail}`);
  }

  // ── 1. THE DATABASE ENFORCES THE TWO PROHIBITIONS ─────────────────────────
  head('1. synthetic-only and capability prohibitions are CHECK constraints, not conventions');

  // Written as explicit statements rather than through the module, deliberately: the point is that
  // the DATABASE refuses, however the insert arrives, including from a caller nobody has written.
  try {
    await query(
      `INSERT INTO ${DEVOPS_SCHEMA.TABLES.operators}
         (id, label, credential_salt, credential_digest, synthetic_only_required)
       VALUES ('devop_raw1', 'raw-1', 'aa', 'bb', FALSE)`);
    bad('a raw INSERT set synthetic_only_required = FALSE',
      'the CHECK constraint is absent or not load-bearing');
  } catch (e) {
    if (/dev_operators_synthetic_only_required/.test(String(e.message))) {
      ok('the database refuses synthetic_only_required = FALSE, from a raw INSERT');
    } else {
      bad('the raw INSERT failed for the wrong reason', String(e.message).slice(0, 180));
    }
  }

  for (const capability of DEVOPS_SCHEMA.PROHIBITED_CAPABILITIES) {
    try {
      await query(
        `INSERT INTO ${DEVOPS_SCHEMA.TABLES.operators}
           (id, label, credential_salt, credential_digest, allowed_capabilities)
         VALUES ($1, $2, 'aa', 'bb', ARRAY[$3]::TEXT[])`,
        [`devop_raw_${capability.replace(/\W/g, '')}`, `raw-${capability}`, capability]);
      bad(`a raw INSERT granted ${capability}`, 'the CHECK constraint is not load-bearing');
    } catch (e) {
      if (/dev_operators_no_privileged_caps/.test(String(e.message))) {
        ok(`the database refuses ${capability} in an operator's scope, from a raw INSERT`);
      } else {
        bad(`the ${capability} INSERT failed for the wrong reason`, String(e.message).slice(0, 180));
      }
    }
  }

  // A positive control for the same constraint, so the three assertions above cannot be passing
  // because every INSERT fails.
  try {
    await query(
      `INSERT INTO ${DEVOPS_SCHEMA.TABLES.operators}
         (id, label, credential_salt, credential_digest, allowed_capabilities)
       VALUES ('devop_control', 'control-row', 'aa', 'bb', ARRAY['exec:synthetic']::TEXT[])`);
    ok('an ordinary operator row still inserts — the constraints are not refusing everything');
    await query(`DELETE FROM ${DEVOPS_SCHEMA.TABLES.operators} WHERE id = 'devop_control'`);
  } catch (e) {
    bad('a legitimate operator row was refused', String(e.message).slice(0, 180));
  }

  // ── 2. PROVISIONING ──────────────────────────────────────────────────────
  head('2. provisioning');

  const short = await DEVOPS.provisionOperator(
    { label: 'too-short', credential: 'abc', allowedCapabilities: [SCHEMA.WORKER_CAPABILITY] },
    deps);
  if (!short.ok && short.code === 'credential_too_short') ok('a short credential is refused');
  else bad('a short credential was accepted', JSON.stringify(short));

  const prohibited = await DEVOPS.provisionOperator(
    { label: 'wants-hardware', credential: CRED, allowedCapabilities: ['exec:hardware'] }, deps);
  if (!prohibited.ok && prohibited.code === 'prohibited_capability') {
    ok('exec:hardware is refused at provisioning, with a message naming the capability');
  } else {
    bad('exec:hardware was accepted at provisioning', JSON.stringify(prohibited));
  }

  const prov = await DEVOPS.provisionOperator({
    label: 'owner@example.test',
    credential: CRED,
    allowedCapabilities: [SCHEMA.WORKER_CAPABILITY],
    note: 'provisioned by scripts/check-dev-operator-registry-db.js',
  }, deps);
  if (prov.ok && /^devop_/.test(prov.operatorId)) ok(`provisioned ${prov.operatorId}`);
  else { bad('provisioning failed', JSON.stringify(prov)); }

  const dup = await DEVOPS.provisionOperator({
    label: 'OWNER@EXAMPLE.TEST', credential: CRED,
    allowedCapabilities: [SCHEMA.WORKER_CAPABILITY],
  }, deps);
  if (!dup.ok && dup.code === 'label_already_live') {
    ok('a second live operator cannot take the same label, case-insensitively');
  } else {
    bad('a duplicate live label was accepted', JSON.stringify(dup));
  }

  // ── 3. AUTHENTICATION, POSITIVE ──────────────────────────────────────────
  head('3. authentication');

  const auth = await DEVOPS.authenticate({ label: 'owner@example.test', credential: CRED }, deps);
  if (auth.ok && DEVOPS.isAuthenticatedOperator(auth.principal)) {
    ok('the correct credential authenticates and yields a principal');
  } else {
    bad('authentication with the correct credential failed', JSON.stringify(auth));
  }
  const principal = auth.principal;

  if (principal && principal.attribution === `dev_operator:${prov.operatorId}`) {
    ok('the principal carries durable attribution naming the operator row');
  } else {
    bad('the principal does not carry attribution', JSON.stringify(principal));
  }

  const stamped = (await query(
    `SELECT last_authenticated_at FROM ${DEVOPS_SCHEMA.TABLES.operators} WHERE id = $1`,
    [prov.operatorId])).rows[0];
  if (stamped && stamped.last_authenticated_at) ok('last_authenticated_at is recorded');
  else bad('last_authenticated_at was not recorded');

  // ── 4. AUTHENTICATION, NEGATIVE ──────────────────────────────────────────
  const cases = [
    ['an unknown label', { label: 'nobody@example.test', credential: CRED }, 'unknown_operator'],
    ['a wrong credential', { label: 'owner@example.test', credential: `${CRED}z` }, 'bad_credential'],
    ['a missing credential', { label: 'owner@example.test' }, 'incomplete'],
    ['a missing label', { credential: CRED }, 'incomplete'],
  ];
  for (const [what, args, expected] of cases) {
    const r = await DEVOPS.authenticate(args, deps);
    if (!r.ok && r.code === expected && !r.principal) ok(`${what} is refused (${expected})`);
    else bad(`${what} was not refused as ${expected}`, JSON.stringify(r));
  }

  // ── 5. IMPERSONATION ─────────────────────────────────────────────────────
  head('5. an approved operator\'s identifiers cannot be borrowed');

  const forged = {
    operatorId: prov.operatorId,
    label: 'owner@example.test',
    allowedCapabilities: [SCHEMA.WORKER_CAPABILITY],
    syntheticOnlyRequired: true,
    attribution: `dev_operator:${prov.operatorId}`,
  };
  if (!DEVOPS.isAuthenticatedOperator(forged)) {
    ok('an object carrying every field of a real principal is not authenticated');
  } else {
    bad('a hand-built object passed as an authenticated principal',
      'the brand is guessable or enumerable — this is the whole security property');
  }

  // And it must not be reachable by copying the symbol off a real principal either.
  if (principal) {
    const copied = { ...principal };
    if (!DEVOPS.isAuthenticatedOperator(copied)) {
      ok('a spread copy of a real principal loses the brand');
    } else {
      bad('spreading a principal carried the brand', 'the brand must be non-enumerable');
    }
  }

  await refuses('the sink refuses a forged principal',
    () => IDENTITY.createEnrollmentToken(
      { label: 'w', operator: forged, capabilities: [SCHEMA.WORKER_CAPABILITY] }, deps),
    /identification, not\s+authentication|requires an authenticated/);

  await refuses('the sink refuses a borrowed email in createdBy, with no principal',
    () => IDENTITY.createEnrollmentToken(
      { label: 'w', createdBy: 'owner@example.test' }, deps),
    /requires an authenticated development operator/);

  await refuses('the sink refuses a borrowed operator id in createdBy',
    () => IDENTITY.createEnrollmentToken(
      { label: 'w', createdBy: `dev_operator:${prov.operatorId}` }, deps),
    /requires an authenticated development operator/);

  // ── 6. THE SINK, WITH THE REGISTRY PRESENT ───────────────────────────────
  head('6. minting under the registry regime');

  await refuses('null attribution is refused',
    () => IDENTITY.createEnrollmentToken({ label: 'w' }, deps),
    /requires an authenticated development operator/);

  await refuses('unrestricted enrollment is refused',
    () => IDENTITY.createEnrollmentToken(
      { label: 'w', operator: principal, syntheticOnly: false }, deps),
    /unrestricted enrollment is prohibited/);

  for (const capability of DEVOPS_SCHEMA.PROHIBITED_CAPABILITIES) {
    await refuses(`${capability} is refused at the sink`,
      () => IDENTITY.createEnrollmentToken(
        { label: 'w', operator: principal, capabilities: [capability] }, deps),
      new RegExp(`${capability.replace(':', ':')} may not be granted|not scoped to grant`));
  }

  await refuses('a capability outside the operator\'s scope is refused',
    () => IDENTITY.createEnrollmentToken(
      { label: 'w', operator: principal, capabilities: ['exec:something-else'] }, deps),
    /not scoped to grant/);

  const minted = await IDENTITY.createEnrollmentToken({
    label: 'm7-dev-cloud-worker-test', operator: principal,
    capabilities: [SCHEMA.WORKER_CAPABILITY],
  }, deps);
  if (minted && minted.token && minted.syntheticOnly === true) {
    ok('an authenticated operator mints a synthetic-only token');
  } else {
    bad('minting with an authenticated principal failed', JSON.stringify(minted));
  }

  const row = (await query(
    `SELECT created_by, synthetic_only FROM ${SCHEMA.TABLES.tokens}
      WHERE label = 'm7-dev-cloud-worker-test'`)).rows[0];
  if (row && row.created_by === `dev_operator:${prov.operatorId}`) {
    ok('the token row records which operator authorized the mint');
  } else {
    bad('the mint was not attributed to the operator', JSON.stringify(row));
  }
  if (row && row.synthetic_only === true) ok('the token is synthetic-only in the database');
  else bad('the token is not synthetic-only', JSON.stringify(row));

  // ── 7. SINGLE USE, EXPIRY, AND CONCURRENT EXCHANGE ───────────────────────
  head('7. the token is single-use and expiring, arbitrated by Postgres');

  const first = await IDENTITY.consumeEnrollmentToken({ token: minted.token }, deps);
  if (first.ok && first.workerId && first.secret) ok('the token exchanges once');
  else bad('the first exchange failed', JSON.stringify({ ...first, secret: undefined }));

  const second = await IDENTITY.consumeEnrollmentToken({ token: minted.token }, deps);
  if (!second.ok && second.code === 'token_already_used') ok('the same token cannot be reused');
  else bad('a consumed token exchanged again', JSON.stringify({ ...second, secret: undefined }));

  const raceToken = await IDENTITY.createEnrollmentToken({
    label: 'race', operator: principal, capabilities: [SCHEMA.WORKER_CAPABILITY],
  }, deps);
  // Both exchanges are STARTED before either is awaited, on a pool with room for both, so the
  // arbitration is Postgres's and not the pool's.
  const [a, b] = await Promise.all([
    IDENTITY.consumeEnrollmentToken({ token: raceToken.token }, deps),
    IDENTITY.consumeEnrollmentToken({ token: raceToken.token }, deps),
  ]);
  const winners = [a, b].filter((r) => r.ok);
  if (winners.length === 1) ok('exactly one of two concurrent exchanges succeeds');
  else bad(`${winners.length} of two concurrent exchanges succeeded`, 'expected exactly one');

  const expired = await IDENTITY.createEnrollmentToken({
    label: 'expired', operator: principal, capabilities: [SCHEMA.WORKER_CAPABILITY], ttlMs: 1,
  }, deps);
  await new Promise((r) => setTimeout(r, 50));
  const exp = await IDENTITY.consumeEnrollmentToken({ token: expired.token }, deps);
  if (!exp.ok && exp.code === 'token_expired') ok('an expired token is refused');
  else bad('an expired token exchanged', JSON.stringify({ ...exp, secret: undefined }));

  // ── 8. REVOCATION ───────────────────────────────────────────────────────
  head('8. revocation');

  const rev = await DEVOPS.revokeOperator(
    { operatorId: prov.operatorId, reason: 'end of check' }, deps);
  if (rev.ok) ok('the operator is revoked');
  else bad('revocation failed', JSON.stringify(rev));

  const afterRev = await DEVOPS.authenticate(
    { label: 'owner@example.test', credential: CRED }, deps);
  if (!afterRev.ok && afterRev.code === 'unknown_operator') {
    ok('a revoked operator can no longer authenticate');
  } else {
    bad('a revoked operator authenticated', JSON.stringify(afterRev));
  }

  const again = await DEVOPS.revokeOperator({ operatorId: prov.operatorId }, deps);
  if (!again.ok && again.code === 'not_live') ok('revoking twice is refused, not silently repeated');
  else bad('a second revocation succeeded', JSON.stringify(again));

  const stillThere = (await query(
    `SELECT revoked_at, is_active FROM ${DEVOPS_SCHEMA.TABLES.operators} WHERE id = $1`,
    [prov.operatorId])).rows[0];
  if (stillThere && stillThere.revoked_at && stillThere.is_active === false) {
    ok('the revoked row is kept, with revoked_at set and is_active false');
  } else {
    bad('the revoked row is wrong or was deleted', JSON.stringify(stillThere));
  }

  // The principal obtained BEFORE revocation must not keep minting. This is the one that would be
  // easy to get wrong: the object is still in hand and still branded.
  await refuses('a principal held from before revocation cannot mint',
    () => IDENTITY.createEnrollmentToken(
      { label: 'after-revocation', operator: principal,
        capabilities: [SCHEMA.WORKER_CAPABILITY] }, deps),
    /revoked|not live|no longer|unknown/i);

  // ── 9. REFUSALS ARE ROWS ────────────────────────────────────────────────
  head('9. every refusal left a record');

  const events = (await query(
    `SELECT outcome, code, COUNT(*)::int n FROM ${DEVOPS_SCHEMA.TABLES.events}
      GROUP BY outcome, code ORDER BY code`)).rows;
  const denied = events.filter((e) => e.outcome === 'DENIED').map((e) => e.code);
  for (const expected of ['unknown_operator', 'bad_credential', 'incomplete']) {
    if (denied.includes(expected)) ok(`a DENIED row exists for ${expected}`);
    else bad(`no DENIED row for ${expected}`, `codes present: ${denied.join(', ') || 'none'}`);
  }
  const granted = events.filter((e) => e.outcome === 'GRANTED').map((e) => e.code);
  for (const expected of ['provisioned', 'authenticated', 'revoked']) {
    if (granted.includes(expected)) ok(`a GRANTED row exists for ${expected}`);
    else bad(`no GRANTED row for ${expected}`, `codes present: ${granted.join(', ') || 'none'}`);
  }

  const leaked = (await query(
    `SELECT COUNT(*)::int n FROM ${DEVOPS_SCHEMA.TABLES.events}
      WHERE detail::text LIKE $1 OR label_attempted LIKE $1`, [`%${CRED}%`])).rows[0].n;
  if (leaked === 0) ok('no event row contains the credential');
  else bad(`${leaked} event row(s) contain the credential`, 'a log is not a place for a credential');

  // ── 10. A DATABASE THAT IS NOT ISOLATED DEVELOPMENT IS REFUSED ──────────
  head('10. the registry does not authorize anything outside its own environment');

  // `users` is the production business table whose ABSENCE is the isolation property. Creating one
  // here makes this database stop identifying as isolated development, which must shut the registry
  // regime down rather than fall through to the permissive branch.
  await query('CREATE TABLE users (id TEXT PRIMARY KEY)');

  const identNow = await DEV_IDENTITY.identifyIsolatedDevelopment(query);
  if (!identNow.ok && identNow.verdict === 'undeclared' && identNow.undeclared.includes('users')) {
    ok('an undeclared table makes identification fail, naming the table');
  } else {
    bad('an undeclared table did not fail identification', JSON.stringify(identNow));
  }

  const prov2 = await DEVOPS.provisionOperator(
    { label: 'post@example.test', credential: CRED,
      allowedCapabilities: [SCHEMA.WORKER_CAPABILITY] }, deps);
  if (!prov2.ok && /^database_/.test(prov2.code)) {
    ok('provisioning is refused on a database that is not isolated development');
  } else {
    bad('provisioning succeeded on an unidentified database', JSON.stringify(prov2));
  }

  const auth2 = await DEVOPS.authenticate(
    { label: 'owner@example.test', credential: CRED }, deps);
  if (!auth2.ok && /^database_/.test(auth2.code)) {
    ok('registry access is refused on a database that is not isolated development');
  } else {
    bad('registry access succeeded on an unidentified database', JSON.stringify(auth2));
  }

  await refuses('the sink refuses to mint when the registry is present but identification fails',
    () => IDENTITY.createEnrollmentToken({ label: 'w', operator: principal }, deps),
    /does not identify as an isolated development database/);

  await query('DROP TABLE users');
  ok('the control table is removed');

  // ── 10b. THE VERIFIED-ADMINISTRATOR PATH SURVIVES THE REGISTRY'S ARRIVAL ──
  head('10b. an administrator-authorized widening mint still works alongside the registry');

  // This is a REGRESSION test for a real break. The first version of the gate engaged on the
  // registry table's PRESENCE, so once `m7-dev-migrate.js` created `dev_operators`, the fixture in
  // `scripts/check-m7-dev-environment-db.js` — which builds an administrator precisely to exercise
  // the widening path for a Mac-mini-style worker — was refused, and that check stopped executing.
  // Preflight returned exit 2 with `1 did not execute`. The gate now engages on the PRINCIPAL, so
  // the two regimes coexist, and this asserts it here rather than relying on a downstream check to
  // notice.
  const adminId = await require('./lib/fixture-admin').fixtureAdmin(query);
  if (adminId) ok('a fixture administrator exists (which creates a users table)');
  else bad('the fixture administrator could not be created');

  const registryStillThere = (await query(
    `SELECT to_regclass('${DEVOPS_SCHEMA.TABLES.operators}') IS NOT NULL AS present`)
  ).rows[0].present;
  if (registryStillThere) ok('the registry is still present, so both regimes are in play at once');
  else bad('the registry vanished', 'this section would prove nothing without it');

  const widened = await IDENTITY.createEnrollmentToken({
    label: 'mac-mini-style', syntheticOnly: false, createdBy: adminId,
  }, deps);
  if (widened && widened.token && widened.syntheticOnly === false) {
    ok('a verified administrator still mints a widened token with the registry present');
  } else {
    bad('the administrator-authorized widening path broke', JSON.stringify(widened));
  }

  // And the registry regime is still closed in the same database: a principal requires positive
  // identification, which a populated `users` table defeats.
  await refuses('a development principal is still refused once users exists',
    () => IDENTITY.createEnrollmentToken(
      { label: 'w', operator: principal, capabilities: [SCHEMA.WORKER_CAPABILITY] }, deps),
    /does not identify as an isolated development database/);

  await query('DROP TABLE IF EXISTS users CASCADE');
  ok('the fixture administrator table is removed');

  // ── 11. WITHOUT THE REGISTRY, PRODUCTION'S REGIME IS UNCHANGED ──────────
  head('11. a database with no registry keeps production\'s authorization exactly');

  await query(`DROP TABLE ${DEVOPS_SCHEMA.TABLES.events}`);
  await query(`DROP TABLE ${DEVOPS_SCHEMA.TABLES.operators}`);

  const legacy = await IDENTITY.createEnrollmentToken({
    label: 'legacy-unattributed', capabilities: [SCHEMA.WORKER_CAPABILITY],
  }, deps);
  if (legacy && legacy.token) {
    ok('an unattributed non-widening mint still works where no registry exists');
    note('this is production\'s existing behaviour and is deliberately untouched');
  } else {
    bad('the pre-existing mint path broke', JSON.stringify(legacy));
  }

  await refuses('a development principal is refused where no registry exists',
    () => IDENTITY.createEnrollmentToken(
      { label: 'w', operator: principal, capabilities: [SCHEMA.WORKER_CAPABILITY] }, deps),
    /holds no development operator registry/);

  await refuses('widening still requires a verified administrator',
    () => IDENTITY.createEnrollmentToken(
      { label: 'w', syntheticOnly: false }, deps),
    /requires createdBy naming an administrator/);

  await pool.end();

  console.log(`\n── ${fail ? `${fail} FAILED` : 'every assertion held'}`);
  if (fail) {
    console.log('\nFAIL  the development operator registry does not hold its properties.');
    process.exit(1);
  }
  console.log('\nPASS  registry, authenticated minting, impersonation refusal, revocation,');
  console.log('      concurrent exchange, environment refusal and synthetic-only all hold.');
  process.exit(0);
})()
  .catch((e) => {
    console.log(`\nFAIL  the check itself threw: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  })
  .finally(stopTemp);
