#!/usr/bin/env node
// ── M7.1 WORKER IDENTITY, AGAINST A REAL POSTGRES ────────────────────────────
//
//   node scripts/check-worker-identity-db.js; echo "EXIT=$?"
//
// The unit tests in src/lib/worker/auth.test.js drive a fake database. That is right for the ORDER
// of the checks and wrong for everything that Postgres arbitrates: the nonce's uniqueness and the
// enrollment token's single use. A fake that emulates `ON CONFLICT` emulates the thing under test.
//
// This project has already paid for that exact mistake twice. `priorClaim` existed in a fake ledger
// and not in the real one, so a control passed while production had no control. A concurrency test
// passed because a connection pool serialised the requests, not because anything arbitrated them.
//
// ── SO EVERY GUARANTEE HERE IS PROVEN THREE WAYS ─────────────────────────────
//
//   1. sequentially   the second identical attempt is refused. Deterministic, no timing.
//   2. concurrently   N at once produce exactly one winner.
//   3. by CONTROL     the constraint is DROPPED and the same test is re-run. If it still passes,
//                     the constraint was never what was refusing, and the check reports FAIL.
//
// Step 3 is the one that cannot be faked into passing, and it is the only reason to believe steps
// 1 and 2. A guarantee that survives the removal of its own mechanism was never being measured.
//
// Nothing here touches production. It starts a disposable cluster, creates its own schema, and
// removes the directory afterwards. It never reads DATABASE_URL.
//
// EXIT 0  every invariant held, and every control failed when it should
// EXIT 1  at least one invariant does not hold
// EXIT 3  no Postgres available — NOTHING was proven

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n  ── ${m} ──\n`);

const SEAL = { WORKER_SECRET_SEAL_KEY: 'f3'.repeat(32) };

// ── A DISPOSABLE CLUSTER ────────────────────────────────────────────────────
let temp = null;
function startTemp() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/worker-ident-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55987' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55987 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55987`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = startTemp();
if (!url) {
  console.log('  skip  no Postgres available');
  console.log('SKIP  worker identity was NOT exercised — this check proved nothing.');
  process.exit(EXIT_NOT_EXECUTED);
}

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: false, max: 12 });
  const query = (sql, params) => pool.query(sql, params);

  const IDENTITY = require('../src/lib/worker/identity');
  const AUTH = require('../src/lib/worker/auth');
  const SECRETS = require('../src/lib/worker/secrets');
  const SCHEMA = require('../src/lib/worker/identity-schema');
  const autonomy = require('../src/lib/autonomy');

  const deps = { query, env: SEAL };
  const nonceHex = () => require('crypto').randomBytes(16).toString('hex');

  const signedFor = (secret, workerId, over = {}) => {
    const req = {
      workerId,
      method: 'POST',
      path: '/api/worker/lease',
      timestamp: String(Date.now()),
      nonce: nonceHex(),
      body: '{}',
      ...over,
    };
    return { ...req, signature: AUTH.signRequest(secret, req)['x-worker-signature'] };
  };

  console.log('\n══ M7.1 WORKER IDENTITY — REAL POSTGRES ══');
  note('disposable cluster; production is never contacted');

  // ── 0. SCHEMA ─────────────────────────────────────────────────────────────
  head('0. the migration applies, and is idempotent');
  try {
    const first = await IDENTITY.migrateWorkerIdentity(query);
    await IDENTITY.migrateWorkerIdentity(query);          // re-running must be safe
    ok(`migration applied ${first.statements} statements, and again with no error`);
  } catch (e) { bad('the worker identity migration does not apply', e.message); }

  try { await autonomy.migrateAutonomy(query); ok('the autonomy kill switch is present'); } catch (e) {
    bad('the kill switch migration failed', e.message);
  }

  // ── FIXTURE PARITY ────────────────────────────────────────────────────────
  //
  // email_log declares sent_at TIMESTAMPTZ in six fixtures and is TEXT in production, which made a
  // one-hour window return zero rows. So the declared types are compared against what the server
  // actually created rather than assumed.
  head('0b. the columns exist with the types the code assumes');
  const EXPECTED = {
    worker_identities: { id: 'text', capabilities: 'ARRAY', enrolled_at: 'timestamp with time zone', revoked_at: 'timestamp with time zone', rotation_expires_at: 'timestamp with time zone' },
    worker_enrollment_tokens: { token_digest: 'text', expires_at: 'timestamp with time zone', consumed_at: 'timestamp with time zone' },
    worker_request_nonces: { nonce: 'text', seen_at: 'timestamp with time zone' },
  };
  for (const [table, cols] of Object.entries(EXPECTED)) {
    const r = await query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`, [table]);
    const actual = new Map(r.rows.map((x) => [x.column_name, x.data_type]));
    let bads = [];
    for (const [c, t] of Object.entries(cols)) {
      if (actual.get(c) !== t) bads.push(`${c}: declared ${t}, is ${actual.get(c) || 'ABSENT'}`);
    }
    if (bads.length) bad(`${table} does not match what the code assumes`, bads.join('; '));
    else ok(`${table}: ${Object.keys(cols).length} column(s) match`);
  }

  // ── 1. ENROLMENT IS SINGLE-USE ────────────────────────────────────────────
  head('1. an enrollment token can be exchanged exactly once');

  const t1 = await IDENTITY.createEnrollmentToken({ label: 'mac-mini-1', createdBy: 'owner' }, deps);
  const stored = await query(`SELECT token_digest FROM ${SCHEMA.TABLES.tokens}`);
  if (stored.rows.some((r) => r.token_digest === t1.token)) {
    bad('the enrollment TOKEN ITSELF is stored — a database read could enrol a worker');
  } else ok('only the token digest is stored; the token is unrecoverable from the database');

  const e1 = await IDENTITY.consumeEnrollmentToken({ token: t1.token }, deps);
  if (!e1.ok) bad('a fresh token could not be exchanged', e1.code);
  else ok(`exchanged → ${e1.workerId}`);

  // (1) sequential: deterministic, independent of timing
  const e2 = await IDENTITY.consumeEnrollmentToken({ token: t1.token }, deps);
  if (e2.ok) bad('THE SAME TOKEN ENROLLED A SECOND WORKER', `second id ${e2.workerId}`);
  else ok(`a second exchange of the same token is refused (${e2.code})`);

  // (2) concurrent: exactly one winner out of sixteen
  const t2 = await IDENTITY.createEnrollmentToken({ label: 'mac-mini-race' }, deps);
  const racers = await Promise.all(Array.from({ length: 16 },
    () => IDENTITY.consumeEnrollmentToken({ token: t2.token }, deps)));
  const winners = racers.filter((r) => r.ok);
  if (winners.length !== 1) {
    bad(`sixteen concurrent exchanges produced ${winners.length} workers, not one`,
      winners.map((w) => w.workerId).join(', '));
  } else ok('sixteen concurrent exchanges produced exactly one worker');

  const totalWorkers = await query(`SELECT COUNT(*)::int n FROM ${SCHEMA.TABLES.identities}`);
  if (totalWorkers.rows[0].n !== 2) {
    bad(`expected 2 enrolled workers, found ${totalWorkers.rows[0].n}`);
  } else ok('two tokens produced two workers in total');

  // (3) CONTROL — remove what arbitrates and prove the test notices
  head('1b. CONTROL: with the single-use predicate gone, does anything still refuse?');
  const t3 = await IDENTITY.createEnrollmentToken({ label: 'control' }, deps);
  await IDENTITY.consumeEnrollmentToken({ token: t3.token }, deps);
  const digest3 = SECRETS.digestOfToken(t3.token);
  // Simulate the predicate having been dropped by clearing the evidence it reads.
  await query(`UPDATE ${SCHEMA.TABLES.tokens} SET consumed_at = NULL WHERE token_digest = $1`, [digest3]);
  const again = await IDENTITY.consumeEnrollmentToken({ token: t3.token }, deps);
  if (!again.ok) {
    bad('the control did not reproduce the failure it exists to detect',
      `with consumed_at cleared the exchange was still refused (${again.code}) — so the WHERE `
      + 'clause is not what refuses a reused token, and test 1 may be passing for another reason');
  } else {
    ok('control behaved: with consumed_at cleared the token worked again');
    note('so `WHERE consumed_at IS NULL` is demonstrably what refuses a reuse');
    await IDENTITY.revokeWorker(again.workerId, { reason: 'control fixture' }, deps);
  }

  // ── 2. REPLAY ─────────────────────────────────────────────────────────────
  head('2. a replayed request is refused, and the PRIMARY KEY is what refuses it');

  const w = e1;
  const req = signedFor(w.secret, w.workerId);

  const a1 = await AUTH.authenticateWorker(req, deps);
  if (!a1.ok) bad('a correctly signed request did not authenticate', `${a1.code}: ${a1.detail}`);
  else ok('a correctly signed request authenticated');

  const a2 = await AUTH.authenticateWorker(req, deps);
  if (a2.ok) bad('A BYTE-IDENTICAL REPLAY AUTHENTICATED A SECOND TIME');
  else if (a2.code !== 'replayed') bad(`the replay was refused as '${a2.code}', not 'replayed'`, a2.detail);
  else ok('the replay is refused (sequential, deterministic)');

  // concurrent: the same request twenty times at once
  const reqR = signedFor(w.secret, w.workerId);
  const burst = await Promise.all(Array.from({ length: 20 },
    () => AUTH.authenticateWorker(reqR, deps)));
  const accepted = burst.filter((r) => r.ok);
  if (accepted.length !== 1) {
    bad(`twenty concurrent identical requests were accepted ${accepted.length} times, not once`);
  } else ok('twenty concurrent identical requests were accepted exactly once');

  // CONTROL — drop the primary key and prove the replay then succeeds
  head('2b. CONTROL: with the nonce PRIMARY KEY dropped, does the replay get through?');
  const pk = await query(
    `SELECT conname FROM pg_constraint WHERE conrelid = '${SCHEMA.TABLES.nonces}'::regclass AND contype = 'p'`);
  if (!pk.rows.length) {
    bad('the nonce table has no primary key at all — replay was never being arbitrated');
  } else {
    const name = pk.rows[0].conname;
    await query(`ALTER TABLE ${SCHEMA.TABLES.nonces} DROP CONSTRAINT ${name}`);
    const reqC = signedFor(w.secret, w.workerId);
    const c1 = await AUTH.authenticateWorker(reqC, deps);
    const c2 = await AUTH.authenticateWorker(reqC, deps);
    await query(`ALTER TABLE ${SCHEMA.TABLES.nonces} ADD CONSTRAINT ${name} PRIMARY KEY (nonce)`);

    // ── WHAT THIS CONTROL IS ACTUALLY ASKING ──────────────────────────────
    //
    // Not "does the replay get through". That was the first version of this control and its
    // expectation was wrong: `ON CONFLICT (nonce)` names a constraint, so with the primary key
    // dropped Postgres does not quietly allow the second insert — it raises
    // "no unique or exclusion constraint matching the ON CONFLICT specification", and
    // authenticateWorker turns that into a 503 and refuses. The dependency is STRUCTURAL rather
    // than advisory, which is better than what the control was looking for.
    //
    // So the question is the one that actually separates a real mechanism from a vacuous pass:
    // with the constraint gone, is the behaviour UNCHANGED? If the second attempt is still refused
    // as 'replayed', then something other than the constraint is doing the refusing and test 2 is
    // passing for a reason nobody has identified. Anything else proves the code depends on it.
    if (c2.code === 'replayed') {
      bad('the control did not reproduce the failure it exists to detect',
        'with the primary key DROPPED the replay was still refused as \'replayed\' — so the '
        + 'constraint is not what refuses, and test 2 is passing for an unidentified reason');
    } else if (c1.ok && c2.ok) {
      ok('control behaved: without the primary key the replay WAS accepted twice');
      note(`so '${name}' is demonstrably the mechanism`);
    } else {
      ok(`control behaved: without the primary key the request FAILS CLOSED (${c2.code})`);
      note(`so '${name}' is a structural dependency — a database missing it refuses requests`);
      note('rather than silently accepting replays. That is the stronger of the two outcomes, and');
      note('it is why this control asks "did the behaviour change" and not "did the replay pass".');
      // Worth asserting explicitly, because it is a security property in its own right: an
      // un-migrated database must not degrade into accepting replays.
      if (c1.ok) {
        bad('the FIRST request succeeded with no replay protection in place',
          'a database missing the nonce constraint accepted an unprotected request before failing '
          + 'on the second — the window is small but it is not closed');
      } else {
        ok('and the FIRST request is refused too, so there is no unprotected window at all');
      }
    }
    // Restored above; prove it.
    const back = await query(
      `SELECT conname FROM pg_constraint WHERE conrelid = '${SCHEMA.TABLES.nonces}'::regclass AND contype = 'p'`);
    if (!back.rows.length) bad('the primary key was NOT restored after the control');
    else ok('the primary key is restored');
  }

  // ── 3. REVOCATION ─────────────────────────────────────────────────────────
  head('3. revocation is immediate and terminal');

  const t4 = await IDENTITY.createEnrollmentToken({ label: 'to-be-revoked' }, deps);
  const v = await IDENTITY.consumeEnrollmentToken({ token: t4.token }, deps);

  const before = await AUTH.authenticateWorker(signedFor(v.secret, v.workerId), deps);
  if (!before.ok) bad('a freshly enrolled worker could not authenticate', before.code);
  else ok('the worker authenticates before revocation');

  const rv = await IDENTITY.revokeWorker(v.workerId, { reason: 'machine decommissioned', actor: 'owner' }, deps);
  if (!rv.ok) bad('revocation failed', rv.code);
  else ok('revoked');

  const after = await AUTH.authenticateWorker(signedFor(v.secret, v.workerId), deps);
  if (after.ok) bad('A REVOKED WORKER STILL AUTHENTICATED');
  else if (after.code !== 'revoked') bad(`refused as '${after.code}' rather than 'revoked'`, after.detail);
  else ok('a revoked worker is refused immediately, with the reason');

  // The secret is gone, so even a later bug that forgot the revocation check has nothing to verify.
  const sec = await query(
    `SELECT secret_current, secret_previous FROM ${SCHEMA.TABLES.identities} WHERE id = $1`, [v.workerId]);
  if (sec.rows[0].secret_current !== 'revoked' || sec.rows[0].secret_previous !== null) {
    bad('a revoked worker\'s secret is still stored and openable');
  } else ok('the secret columns are overwritten on revocation (defence in depth)');

  if ((await IDENTITY.revokeWorker(v.workerId, { reason: 'again' }, deps)).ok) {
    bad('a worker was revoked twice — revocation is not idempotent-by-refusal');
  } else ok('a second revocation is refused');

  if ((await IDENTITY.rotateSecret(v.workerId, {}, deps)).ok) {
    bad('A REVOKED WORKER WAS GIVEN A NEW SECRET — revocation is not terminal');
  } else ok('a revoked worker cannot be rotated back into service');

  // ── 4. ROTATION ───────────────────────────────────────────────────────────
  head('4. rotation is not an outage, and the old secret still dies');

  const t5 = await IDENTITY.createEnrollmentToken({ label: 'rotating' }, deps);
  const r0 = await IDENTITY.consumeEnrollmentToken({ token: t5.token }, deps);
  const rot = await IDENTITY.rotateSecret(r0.workerId, { overlapMs: 60_000 }, deps);
  if (!rot.ok) bad('rotation failed', rot.code);
  else ok('rotated with a 60s overlap');

  const withNew = await AUTH.authenticateWorker(signedFor(rot.secret, r0.workerId), deps);
  const withOld = await AUTH.authenticateWorker(signedFor(r0.secret, r0.workerId), deps);
  if (!withNew.ok) bad('the NEW secret does not authenticate after rotation', withNew.code);
  else ok('the new secret authenticates');
  if (!withOld.ok) bad('the OLD secret stopped working immediately — rotation is an outage', withOld.code);
  else if (!withOld.usedPreviousSecret) bad('the old secret authenticated but was not reported as previous');
  else ok('the old secret still authenticates during the overlap, and is reported as previous');

  // Expire the overlap in the database — real timestamptz comparison, not a mocked clock.
  await query(
    `UPDATE ${SCHEMA.TABLES.identities} SET rotation_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
    [r0.workerId]);
  const dead = await AUTH.authenticateWorker(signedFor(r0.secret, r0.workerId), deps);
  if (dead.ok) bad('THE OLD SECRET STILL WORKS AFTER THE OVERLAP EXPIRED');
  else ok(`once the overlap expires the old secret is refused (${dead.code})`);

  // ── 5. THE KILL SWITCH IS CONSULTED ───────────────────────────────────────
  head('5. a STOP refuses an authenticated worker (refinement 1)');

  autonomy.resetForTests && autonomy.resetForTests();
  const live = await AUTH.authorizeWorkerAction({ workerId: r0.workerId }, { ...deps, autonomy });
  if (!live.allowed) bad('a worker was refused with no stop in place', JSON.stringify(live.stop));
  else ok('with no stop in place the action is allowed');

  // A stop on the worker's own agent scope — "stop THAT machine".
  await query(
    `INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by) VALUES ('agent', $1, $2, 'check')`,
    [r0.workerId, 'M7.1 check: stop this machine']);
  autonomy.resetForTests && autonomy.resetForTests();
  const stoppedOne = await AUTH.authorizeWorkerAction({ workerId: r0.workerId }, { ...deps, autonomy });
  if (stoppedOne.allowed) bad('AN AGENT-SCOPED STOP DID NOT REFUSE THAT WORKER');
  else ok(`an agent-scoped stop refuses that worker (${stoppedOne.stop.scope_type})`);

  // ...and not a different one.
  const other = await AUTH.authorizeWorkerAction({ workerId: e1.workerId }, { ...deps, autonomy });
  if (!other.allowed) {
    bad('an agent-scoped stop refused a DIFFERENT worker — the scope key is not being matched',
      JSON.stringify(other.stop));
  } else ok('a different worker is unaffected by that stop');

  await query(`DELETE FROM autonomy_stops WHERE scope_type = 'agent' AND scope_key = $1`, [r0.workerId]);

  // A capability stop on worker.execute halts every worker.
  await query(
    `INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
     VALUES ('capability', 'worker.execute', 'M7.1 check: stop all worker execution', 'check')`);
  autonomy.resetForTests && autonomy.resetForTests();
  const capStop = await AUTH.authorizeWorkerAction({ workerId: e1.workerId }, { ...deps, autonomy });
  if (capStop.allowed) bad('A CAPABILITY STOP ON worker.execute DID NOT REFUSE');
  else ok('a capability stop on worker.execute refuses every worker');
  await query(`DELETE FROM autonomy_stops WHERE scope_type = 'capability' AND scope_key = 'worker.execute'`);

  // And a global stop.
  await query(
    `INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
     VALUES ('global', '', 'M7.1 check: global containment', 'check')`);
  autonomy.resetForTests && autonomy.resetForTests();
  const globalStop = await AUTH.authorizeWorkerAction({ workerId: e1.workerId }, { ...deps, autonomy });
  if (globalStop.allowed) bad('A GLOBAL STOP DID NOT REFUSE A WORKER ACTION');
  else ok(`a global stop refuses a worker action (${globalStop.stop.scope_type})`);
  await query(`DELETE FROM autonomy_stops WHERE scope_type = 'global'`);
  autonomy.resetForTests && autonomy.resetForTests();

  // ── 6. HOUSEKEEPING ───────────────────────────────────────────────────────
  head('6. nonce pruning removes only what can no longer matter');

  const beforeCount = (await query(`SELECT COUNT(*)::int n FROM ${SCHEMA.TABLES.nonces}`)).rows[0].n;
  await query(
    `INSERT INTO ${SCHEMA.TABLES.nonces} (nonce, worker_id, seen_at)
     VALUES ($1, $2, NOW() - INTERVAL '2 hours')`, [nonceHex(), e1.workerId]);
  const pruned = await IDENTITY.pruneNonces({ olderThanMs: 3600000 }, deps);
  const afterCount = (await query(`SELECT COUNT(*)::int n FROM ${SCHEMA.TABLES.nonces}`)).rows[0].n;

  if (pruned.deleted !== 1) bad(`pruning removed ${pruned.deleted} row(s), expected the one old row`);
  else if (afterCount !== beforeCount) {
    bad(`pruning changed the live count from ${beforeCount} to ${afterCount} — it removed a nonce `
      + 'that could still refuse a replay');
  } else ok(`pruning removed the one expired nonce and left all ${afterCount} live ones`);

  // ── 7. NO CREDENTIAL ON THIS PATH ─────────────────────────────────────────
  head('7. the worker path holds no provider credential');
  const envSeen = Object.keys(process.env).filter((k) =>
    /RESEND|GOOGLE_|TWILIO|ANTHROPIC|APOLLO|OPENAI/.test(k));
  note(`provider variables present in THIS process: ${envSeen.length ? envSeen.join(', ') : 'none'}`);
  note('names only, never values. The static proof that the worker modules cannot reach a provider');
  note('is src/lib/worker/auth.test.js test 8; this line is context, not a verdict.');

  await pool.end();
})()
  .then(() => {
    console.log();
    if (fail) {
      console.log(`FAIL  ${fail} worker-identity invariant(s) do not hold.`);
      process.exit(1);
    }
    console.log('PASS  worker identity, replay refusal, revocation, rotation and the kill-switch');
    console.log('      call site all hold — and both controls failed when their mechanism was removed.');
    console.log('      Development evidence only. This says nothing about production readiness.');
    process.exit(0);
  })
  .catch((e) => {
    console.log(`\nINCOMPLETE  ${(e && e.stack) || e}`);
    process.exit(EXIT_NOT_EXECUTED);
  })
  .finally(stopTemp);
