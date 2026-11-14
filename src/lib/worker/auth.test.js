// ── WORKER AUTHENTICATION: WHAT A FAKE DATABASE CAN AND CANNOT PROVE ─────────
//
// These tests drive authenticateWorker against an in-memory fake. That is the right tool for the
// ORDER and the LOGIC of the checks — shape before database, skew before secret, revocation before
// opening a secret, nonce after signature — because each of those is a property of this file.
//
// It is the WRONG tool for arbitration. The nonce's uniqueness and the enrollment token's
// single-use come from Postgres: `ON CONFLICT (nonce) DO NOTHING RETURNING` and
// `UPDATE … WHERE consumed_at IS NULL RETURNING`. A fake that emulates those emulates the thing
// under test, and this project has already paid for that mistake — `priorClaim` was present in a
// fake ledger and absent from the real one, so the control passed while production had no control
// at all.
//
// So the fake here REFUSES to emulate a conflict it was not explicitly told about, and the real
// properties are proven in scripts/check-worker-identity-db.js against a live cluster. If that
// script is not run, these tests do not cover replay.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const AUTH = require('./auth');
const SECRETS = require('./secrets');
const SCHEMA = require('./identity-schema');

const ENV = { WORKER_SECRET_SEAL_KEY: 'a'.repeat(64) };
const NOW = 1_763_000_000_000;
const WORKER = 'wkr_' + 'b'.repeat(32);
// The character must be HEX: the nonce shape is /^[0-9a-f]{32}$/, so nonce('a') is not a typo
// that fails loosely — it is refused as malformed, which once made a rotation test look like a
// signature failure. Only 0-9a-f are valid here.
const nonce = (c = 'c') => {
  if (!/^[0-9a-f]$/.test(c)) throw new Error(`nonce() needs a hex character, got '${c}'`);
  return c.repeat(32);
};

/**
 * The smallest fake that can answer this module's four queries. It tracks nonces in a Set so the
 * ON CONFLICT path is reachable, and throws on any SQL it does not recognise rather than returning
 * an empty result — an unrecognised query that answers `{rows: []}` is how a test passes without
 * exercising anything.
 */
function fakeDb({ row, nonces = new Set(), failNonceInsert = false } = {}) {
  const seen = { lastSeenUpdates: 0, nonceInserts: 0 };
  const query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT id, label, scheme')) {
      return { rows: row && row.id === params[0] ? [row] : [] };
    }
    if (s.startsWith(`INSERT INTO ${SCHEMA.TABLES.nonces}`)) {
      seen.nonceInserts += 1;
      if (failNonceInsert) throw new Error('nonce table unavailable');
      if (nonces.has(params[0])) return { rows: [] };      // what ON CONFLICT DO NOTHING returns
      nonces.add(params[0]);
      return { rows: [{ nonce: params[0] }] };
    }
    if (s.includes('SET last_seen_at = NOW()')) { seen.lastSeenUpdates += 1; return { rows: [] }; }
    throw new Error(`fakeDb was asked an unrecognised query: ${s.slice(0, 70)}`);
  };
  return { query, seen, nonces };
}

function liveWorker(secret, over = {}) {
  return {
    id: WORKER,
    label: 'mac-mini-1',
    scheme: 'hmac-sha256',
    secret_current: SECRETS.seal(secret, ENV),
    secret_previous: null,
    rotation_expires_at: null,
    capabilities: [SCHEMA.WORKER_CAPABILITY],
    revoked_at: null,
    revoked_reason: null,
    ...over,
  };
}

/**
 * A correctly signed request, so each test can spoil exactly one thing.
 *
 * The override is applied BEFORE signing — so spoiling `body` or `nonce` produces a request that is
 * correctly signed for different content, which is the tampering case. `signature` is the one field
 * that must be applied AFTER, or the freshly computed value would overwrite the spoiled one and the
 * test would silently assert nothing. Found by the test failing.
 */
function signed(secret, over = {}) {
  const req = {
    workerId: WORKER,
    method: 'POST',
    path: '/api/worker/lease',
    timestamp: String(NOW),
    nonce: nonce(),
    body: '{"want":1}',
    ...over,
  };
  const out = { ...req, signature: AUTH.signRequest(secret, req)['x-worker-signature'] };
  if (Object.prototype.hasOwnProperty.call(over, 'signature')) out.signature = over.signature;
  return out;
}

const run = (req, db, over = {}) =>
  AUTH.authenticateWorker(req, { query: db.query, env: ENV, now: () => NOW, ...over });

// ═══ THE HAPPY PATH EXISTS ONLY TO MAKE THE REFUSALS MEANINGFUL ════════════

test('0. a correctly signed request from a live worker authenticates', async () => {
  const secret = SECRETS.newSecret();
  const db = fakeDb({ row: liveWorker(secret) });
  const r = await run(signed(secret), db);

  assert.strictEqual(r.ok, true, r.detail);
  assert.strictEqual(r.workerId, WORKER);
  assert.strictEqual(r.usedPreviousSecret, false);
  assert.deepStrictEqual(r.capabilities, [SCHEMA.WORKER_CAPABILITY]);
  assert.strictEqual(db.seen.lastSeenUpdates, 1, 'liveness was not recorded');
});

// ═══ 1. REVOKED CANNOT AUTHENTICATE (M7.5 acceptance 1, auth half) ═════════

test('1. a revoked worker is refused, and its secret is not even consulted', async () => {
  const secret = SECRETS.newSecret();

  // Revocation overwrites the secret columns, so the stored value is not openable at all. If the
  // revocation check were moved after the signature step, this row would produce
  // 'secret_unreadable' (a 503 that reads like OUR outage) instead of 'revoked' (a 401 that reads
  // like the truth). The code it returns is therefore evidence of the ordering.
  const db = fakeDb({ row: liveWorker(secret, {
    revoked_at: new Date(NOW - 1000).toISOString(),
    revoked_reason: 'laptop stolen',
    secret_current: 'revoked',
    secret_previous: null,
  }) });

  const r = await run(signed(secret), db);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.code, 'revoked');
  assert.match(r.detail, /laptop stolen/);
  assert.strictEqual(db.seen.nonceInserts, 0, 'a revoked request still burned a nonce');
});

// ═══ 2. TAMPERED AND REPLAYED REQUESTS FAIL (M7.5 acceptance 6) ════════════

test('2a. every signed field is actually covered — changing any one breaks the signature', async () => {
  const secret = SECRETS.newSecret();
  const base = signed(secret);

  // If a field were left out of the signing string, swapping it would still verify. This is the
  // test that would have caught a signature that covered only the body.
  for (const [field, value] of [
    ['method', 'GET'],
    ['path', '/api/worker/results'],
    ['body', '{"want":99}'],
    ['nonce', nonce('d')],
  ]) {
    const db = fakeDb({ row: liveWorker(secret) });
    const r = await run({ ...base, [field]: value }, db);
    assert.strictEqual(r.ok, false, `${field} is not covered by the signature`);
    assert.strictEqual(r.code, 'bad_signature', `${field}: ${r.code}`);
  }
});

test('2b. a signature from a DIFFERENT worker secret does not verify', async () => {
  const mine = SECRETS.newSecret();
  const theirs = SECRETS.newSecret();
  const db = fakeDb({ row: liveWorker(mine) });
  const r = await run(signed(theirs), db);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'bad_signature');
});

test('2c. a replayed request is refused the second time, and the nonce is what refuses it', async () => {
  const secret = SECRETS.newSecret();
  const db = fakeDb({ row: liveWorker(secret) });
  const req = signed(secret);

  const first = await run(req, db);
  assert.strictEqual(first.ok, true, first.detail);

  // Byte-identical replay, inside the skew window, with a perfectly valid signature. The timestamp
  // cannot catch this — that is precisely why the nonce exists.
  const second = await run(req, db);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.code, 'replayed');
  assert.strictEqual(db.seen.nonceInserts, 2);
});

test('2d. a stale timestamp is refused before any database work happens', async () => {
  const secret = SECRETS.newSecret();
  const db = fakeDb({ row: liveWorker(secret) });
  const old = String(NOW - AUTH.MAX_SKEW_MS - 1000);
  const r = await run(signed(secret, { timestamp: old }), db);

  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'stale_signature');
  assert.strictEqual(db.seen.nonceInserts, 0);

  // A timestamp in the FUTURE is equally refused — Math.abs, not a one-sided comparison.
  const ahead = String(NOW + AUTH.MAX_SKEW_MS + 1000);
  const r2 = await run(signed(secret, { timestamp: ahead }), db);
  assert.strictEqual(r2.code, 'stale_signature', 'a future timestamp was accepted');
});

// ═══ 3. THE ORDERING THAT PROTECTS THE NONCE TABLE ═════════════════════════

test('3. an UNAUTHENTICATED caller cannot burn a nonce a real worker is about to use', async () => {
  // The attack this prevents: if the nonce were recorded before the signature was checked, anyone
  // who can reach the endpoint could pre-insert nonces and make a legitimate worker's next request
  // look like a replay. A denial of service handed out for free.
  const secret = SECRETS.newSecret();
  const shared = new Set();
  const victimNonce = nonce('e');

  const attacker = fakeDb({ row: liveWorker(secret), nonces: shared });
  const forged = { ...signed(secret, { nonce: victimNonce }), signature: 'deadbeef' };
  const bad = await run(forged, attacker);
  assert.strictEqual(bad.code, 'bad_signature');
  assert.strictEqual(attacker.seen.nonceInserts, 0, 'an unsigned request reached the nonce table');
  assert.strictEqual(shared.has(victimNonce), false, 'the attacker burned the victim\'s nonce');

  // The real worker now uses that same nonce successfully.
  const victim = fakeDb({ row: liveWorker(secret), nonces: shared });
  const good = await run(signed(secret, { nonce: victimNonce }), victim);
  assert.strictEqual(good.ok, true, good.detail);
});

// ═══ 4. SHAPE, AND WHY THE SHAPE IS LOAD-BEARING ═══════════════════════════

test('4. malformed ids and nonces are refused without touching the database', async () => {
  const secret = SECRETS.newSecret();
  const cases = [
    [{ workerId: 'naren@abiozen.com' }, 'malformed_worker_id'],
    [{ workerId: 'wkr_short' }, 'malformed_worker_id'],
    [{ nonce: 'abc' }, 'malformed_nonce'],
    [{ nonce: 'A'.repeat(32) }, 'malformed_nonce'],       // uppercase is not the enrolled shape
    [{ signature: undefined }, 'unsigned'],
    [{ nonce: undefined }, 'unsigned'],
    [{ timestamp: undefined }, 'unsigned'],
  ];
  for (const [over, code] of cases) {
    const db = fakeDb({ row: liveWorker(secret) });
    const r = await run(signed(secret, over), db);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, code, `${JSON.stringify(over)} gave ${r.code}`);
    assert.strictEqual(db.seen.nonceInserts, 0);
  }

  // The nonce shape is what makes the signing-string collision documented in
  // sender-signature.js unreachable here: 'nonce=abc' as a short literal cannot be presented.
  assert.ok(!SCHEMA.NONCE_SHAPE.test('abc'));
});

test('4b. an unknown worker id is refused', async () => {
  const db = fakeDb({ row: null });
  const r = await run(signed(SECRETS.newSecret()), db);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'unknown_worker');
});

// ═══ 5. ROTATION IS NOT AN OUTAGE, AND THE OLD SECRET STILL DIES ═══════════

test('5a. during the overlap BOTH secrets verify', async () => {
  const oldS = SECRETS.newSecret();
  const newS = SECRETS.newSecret();
  const row = liveWorker(newS, {
    secret_previous: SECRETS.seal(oldS, ENV),
    rotation_expires_at: new Date(NOW + 60_000).toISOString(),
  });

  const a = await run(signed(newS), fakeDb({ row }));
  assert.strictEqual(a.ok, true, a.detail);
  assert.strictEqual(a.usedPreviousSecret, false);

  const b = await run(signed(oldS, { nonce: nonce('f') }), fakeDb({ row }));
  assert.strictEqual(b.ok, true, b.detail);
  assert.strictEqual(b.usedPreviousSecret, true,
    'the previous secret verified but was not reported as such — rotation would be invisible');
});

test('5b. once the overlap has passed the old secret is dead', async () => {
  const oldS = SECRETS.newSecret();
  const newS = SECRETS.newSecret();
  const row = liveWorker(newS, {
    secret_previous: SECRETS.seal(oldS, ENV),
    rotation_expires_at: new Date(NOW - 1).toISOString(),   // expired one millisecond ago
  });

  const r = await run(signed(oldS), fakeDb({ row }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'bad_signature', 'an expired previous secret still authenticated');

  // And the current one is unaffected by the expiry.
  const ok = await run(signed(newS, { nonce: nonce('a') }), fakeDb({ row }));
  assert.strictEqual(ok.ok, true, ok.detail);
});

// ═══ 6. FAILING CLOSED, AND SAYING WHOSE PROBLEM IT IS ═════════════════════

test('6. when our own state is unreadable the request is refused as OUR fault, not the worker\'s', async () => {
  const secret = SECRETS.newSecret();

  // (a) a secret sealed under a different key
  const wrongKey = fakeDb({ row: liveWorker(secret, {
    secret_current: SECRETS.seal(secret, { WORKER_SECRET_SEAL_KEY: '9'.repeat(64) }),
  }) });
  const a = await run(signed(secret), wrongKey);
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.code, 'secret_unreadable');
  assert.strictEqual(a.status, 503);
  assert.strictEqual(a.serverFault, true,
    'a sealing-key problem was reported as a worker problem — the next person debugs the Mac mini');

  // (b) the replay check itself is unavailable. Refuse: replay cannot be ruled out, and an
  // authenticated-but-unverifiable request is exactly the one not to let through.
  const noNonces = fakeDb({ row: liveWorker(secret), failNonceInsert: true });
  const b = await run(signed(secret), noNonces);
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.code, 'replay_check_unavailable');
  assert.strictEqual(b.serverFault, true);

  // (c) identity unreadable
  const broken = { query: async () => { throw new Error('connection reset'); } };
  const c = await AUTH.authenticateWorker(signed(secret),
    { query: broken.query, env: ENV, now: () => NOW });
  assert.strictEqual(c.code, 'identity_unavailable');
  assert.strictEqual(c.serverFault, true);
});

test('6b. with no sealing key configured, nothing authenticates', async () => {
  const secret = SECRETS.newSecret();
  const db = fakeDb({ row: liveWorker(secret) });
  const r = await AUTH.authenticateWorker(signed(secret), { query: db.query, env: {}, now: () => NOW });
  assert.strictEqual(r.ok, false, 'a deployment with no sealing key authenticated a worker');
  assert.strictEqual(r.code, 'secret_unreadable');
});

// ═══ 7. AUTHORIZATION IS A DIFFERENT QUESTION FROM AUTHENTICATION ══════════

test('7a. a STOP refuses an authenticated worker — the capability is CONSULTED, not just declared', async () => {
  // Refinement 1. Registering worker.execute makes a stop expressible; this call site is what
  // makes it effective. The test asserts the scopes actually passed, because a call that consulted
  // the kill switch with the wrong scopes would pass a looser test while enforcing nothing.
  const asked = [];
  const autonomy = {
    checkStopped: async (scopes) => {
      asked.push(scopes);
      return { scope_type: 'global', scope_key: '', reason: 'containment' };
    },
  };
  const r = await AUTH.authorizeWorkerAction({ workerId: WORKER }, { autonomy });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.stop.reason, 'containment');
  assert.deepStrictEqual(asked[0], { agent: WORKER, capability: 'worker.execute' });
});

test('7b. with no stop the action is allowed, and consequential is asserted', async () => {
  let opts = null;
  const autonomy = { checkStopped: async (_s, o) => { opts = o; return null; } };
  const r = await AUTH.authorizeWorkerAction(
    { workerId: WORKER, company: 'abiozen', workflow: 'wf-1' }, { autonomy },
  );
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(opts.consequential, true,
    'a worker action was checked as read-only reasoning, which a global stop does not halt');
});

test('7c. a worker can NEVER act under deployment.execute (capability decision, 2026-11-14)', async () => {
  // Running a bounded worker task must not implicitly grant permission to deploy software. This
  // throws rather than returning a refusal, because a caller passing this capability is a
  // programming error and must not be absorbed as a routine denial.
  const autonomy = { checkStopped: async () => null };
  await assert.rejects(
    () => AUTH.authorizeWorkerAction({ workerId: WORKER, capability: 'deployment.execute' }, { autonomy }),
    /separate capability/,
  );

  // And the two names are distinct in the vocabulary itself, not aliases.
  const { CAPABILITIES } = require('../autonomy');
  assert.ok(CAPABILITIES.includes('worker.execute'), 'worker.execute is not a stoppable capability');
  assert.ok(!CAPABILITIES.includes('deployment.execute'),
    'deployment.execute became implementable as a side effect of M7.1');
});

// ═══ 8. THE WORKER HOLDS NO PROVIDER CREDENTIAL (M7.5 acceptance 5, static half) ═══

test('8. nothing under src/lib/worker references a provider credential or an outbound path', async () => {
  const fs = require('fs');
  const path = require('path');
  const LEX = require('../../../scripts/js-lex');

  const dir = __dirname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
  assert.ok(files.length >= 4, `expected the worker modules, found ${files.length}`);

  for (const f of files) {
    // blankCommentsOnly, NOT blankNonCode: blankNonCode blanks string literals too, which would
    // blank the very require paths this test is looking for and pass vacuously. That exact mistake
    // was made in M5 and found only because the control was re-read.
    const code = LEX.blankCommentsOnly(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const forbidden of ['RESEND_API_KEY', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_SERVICE_ACCOUNT_JSON',
      'googleapis', 'TWILIO_AUTH_TOKEN', 'DATABASE_URL', 'outbound/dispatch', 'outbound/transports']) {
      assert.ok(!code.includes(forbidden), `${f} references ${forbidden}`);
    }
  }

  // Precondition: the lexer actually returned the code. If blankCommentsOnly ever starts blanking
  // identifiers, every assertion above would pass on an empty string.
  const sample = LEX.blankCommentsOnly(fs.readFileSync(path.join(dir, 'auth.js'), 'utf8'));
  assert.ok(sample.includes('authenticateWorker'),
    'the lexer blanked the code, so the loop above proved nothing');
});

test('9. a worker id is unguessable, and ids do not collide', () => {
  const IDENTITY = require('./identity');
  const ids = new Set(Array.from({ length: 500 }, () => IDENTITY.newWorkerId()));
  assert.strictEqual(ids.size, 500, 'worker ids collided');
  for (const id of ids) assert.ok(SCHEMA.WORKER_ID_SHAPE.test(id), `${id} is not of the enrolled shape`);

  // 16 bytes of CSPRNG. Asserted on the shape rather than on entropy, which a test cannot measure,
  // but the source is crypto.randomBytes and that is what the shape is derived from.
  assert.strictEqual(crypto.randomBytes(16).toString('hex').length, 32);
});
