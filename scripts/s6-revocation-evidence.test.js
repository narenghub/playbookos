// ── S6 MUST FAIL IF REVOCATION ENFORCEMENT STOPS WORKING ────────────────────
//
//   node --test scripts/s6-revocation-evidence.test.js
//
// On 2026-11-23 S6 reported PASS — `a revoked fixture identity cannot claim (nothing_to_do)` — and
// the pass did not hold. `LEASES.claimTask` has no identity predicate at all: its selection is
// `WHERE state='PENDING' AND cancel_requested_at IS NULL`. The refusal meant the QUEUE WAS EMPTY,
// which is what a valid identity would also have received, because cleanup had just drained it.
// The assertion was `claimAfter.ok === false`, so the scenario could not fail.
//
// The database said so independently: the fixture identity's row read `last seen never`, and
// `last_seen_at` advances on EVERY successful authentication before any route logic. The
// enforcement path was never reached once.
//
// These tests pin the layer that DOES enforce it, with no database and no Mac, and — the point of
// the file — they discriminate: each one has a control that fails if enforcement is removed.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const AUTH = require('../src/lib/worker/auth');

const WORKER_ID = 'wkr_7ef7aea9124f9a6180d2a72b0b393c56';

/** Answers findWorker's SELECT, and nothing else — an unscripted query is a change worth noticing. */
function identityStub(row) {
  return async (sql, params) => {
    if (/FROM worker_identities WHERE id = \$1/.test(sql)) {
      assert.equal(params[0], WORKER_ID);
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  };
}

const revokedRow = {
  id: WORKER_ID, label: 'fixture-revocation', scheme: 'hmac-sha256',
  secret_current: null, secret_previous: null, rotation_expires_at: null,
  capabilities: ['worker.execute'],
  revoked_at: new Date('2026-11-23T20:55:38.546Z'), revoked_reason: 'M7.6 acceptance fixture revocation',
  last_seen_at: null,
};

/** The same identity with enforcement's input removed — the mutation. */
const liveRow = { ...revokedRow, revoked_at: null, revoked_reason: null };

const signed = () => ({
  workerId: WORKER_ID,
  method: 'POST',
  path: '/api/worker/heartbeat',
  timestamp: Date.now(),
  nonce: 'a'.repeat(32),
  body: JSON.stringify({ runId: '00000000-0000-0000-0000-000000000000' }),
  signature: 'f'.repeat(64),
});

// ── ENFORCEMENT ─────────────────────────────────────────────────────────────

test('DECISIVE: authenticateWorker refuses a revoked identity with 401 revoked', async () => {
  const r = await AUTH.authenticateWorker(signed(), { query: identityStub(revokedRow) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.equal(r.code, 'revoked');
  assert.match(r.detail, /revoked/);
});

test('DECISIVE: the refusal reads revoked_at — it is not refusing everything', async () => {
  // THE MUTATION. Clear revoked_at and the verdict must stop being 'revoked'. Without this, the
  // test above is satisfied by an authenticator that refuses every request, which is exactly the
  // non-discriminating shape that made the original S6 pass meaningless.
  const r = await AUTH.authenticateWorker(signed(), { query: identityStub(liveRow) });
  assert.notEqual(r.code, 'revoked',
    'a live identity must not be refused as revoked — enforcement must depend on revoked_at');
  // It still fails, at the CREDENTIAL stage, which is correct: this fixture row carries no usable
  // sealed secret and the signature is fabricated. Which stage it reaches is the point — the
  // identity was accepted and the credential was not. (Asserting `bad_signature` specifically was
  // wrong: with secret_current null the honest answer is secret_unreadable, and pinning the wrong
  // one would have made this test fail for a reason that has nothing to do with revocation.)
  assert.ok(['bad_signature', 'secret_unreadable'].includes(r.code),
    `expected a credential-stage refusal, got ${r.code}`);
});

test('revocation is checked BEFORE the secret is opened', async () => {
  // Order is a property: a revoked identity whose sealed secret is unreadable must still be
  // refused as revoked rather than as a server fault, so that revocation cannot be masked by a
  // credential problem.
  const r = await AUTH.authenticateWorker(signed(), {
    query: identityStub({ ...revokedRow, secret_current: 'not-decryptable', scheme: 'hmac-sha256' }),
  });
  assert.equal(r.code, 'revoked');
});

test('an unknown identity is distinguishable from a revoked one', async () => {
  const r = await AUTH.authenticateWorker(signed(), { query: identityStub(null) });
  assert.equal(r.code, 'unknown_worker',
    'the codes must stay distinguishable: an audit that cannot tell these apart is less useful');
});

// ── THE CLASSIFICATION S6 DEPENDS ON ────────────────────────────────────────
//
// The driver cannot be required here — it refuses production at module load, by design — so these
// are static assertions about the list it classifies probe results with.

const DRIVER = fs.readFileSync(path.join(__dirname, 'm7-6-dev-driver.js'), 'utf8');

test('DECISIVE: S6 counts revoked as an identity rejection, and lease_not_live as success', async () => {
  const list = /AUTH_REJECTION_CODES = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(DRIVER);
  assert.ok(list, 'the rejection-code list must exist');
  const codes = [...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

  assert.ok(codes.includes('revoked'), 'revoked must count as an identity rejection');
  assert.ok(codes.includes('unknown_worker'));
  assert.ok(codes.includes('bad_signature'));
  // The discriminator. 409 lease_not_live is what a VALID identity gets from the heartbeat probe
  // when it holds no live lease. If that were treated as a rejection, the pre-revocation control
  // would never pass and S6 would report UNTESTED for ever.
  assert.ok(!codes.includes('lease_not_live'),
    'lease_not_live means the identity was ACCEPTED and must not count as a rejection');
  assert.ok(!codes.includes('nothing_to_do'),
    'nothing_to_do is an empty queue — the exact code that produced the false PASS');
});

test('S6 asserts the specific revoked code, not merely that something was refused', () => {
  // EXECUTABLE lines only. The first version of this assertion searched the raw slice for
  // `claimAfter` and failed — on the COMMENT that explains why claimAfter was removed. That is the
  // fourth time in this work that a guard has fired on the prose documenting the rule instead of on
  // a violation of it, so: strip comments before asserting about code.
  const raw = DRIVER.slice(DRIVER.indexOf('S6. a revoked identity'), DRIVER.indexOf('S7. the output bound'));
  const s6 = raw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.match(s6, /after\.status === 401 && after\.code === 'revoked'/,
    "the pass condition must name 401/'revoked' — 'ok === false' is what failed before");
  assert.ok(!/claimAfter/.test(s6), 'the claimTask-based evidence must be gone');
  assert.ok(!/LEASES\.claimTask/.test(s6), 'and claimTask must not be consulted here at all');
});
