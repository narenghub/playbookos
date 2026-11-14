// ── THE SIGNING STRING, PINNED ───────────────────────────────────────────────
//
// M7.1 added an optional `nonce` to signingString so that worker authentication could have replay
// protection without a second implementation of the same signature. The whole safety of that
// change rests on one property: with no nonce, the string is what it always was. If that drifts,
// every already-signed sender-service request stops verifying, and the failure would look like a
// credential problem rather than a signature-format change.
//
// So the no-nonce form is pinned as a literal, not as a re-derivation. A test that rebuilt the
// expected string from the same template literal the implementation uses would pass for any
// template and prove nothing.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sign, signingString, sameSignature } = require('./sender-signature');

test('1. with no nonce the string is byte-identical to the original four-line form', () => {
  const parts = { method: 'POST', path: '/send', timestamp: '1731600000000', body: '{"a":1}' };

  // Written out by hand. This is the literal the sender service and its client have always signed.
  assert.strictEqual(signingString(parts), 'POST\n/send\n1731600000000\n{"a":1}');

  // And the absent key, the explicit undefined, the null and the empty string are all the same
  // request. A caller that passes `nonce: undefined` must not sign something different from a
  // caller that omits it.
  for (const nonce of [undefined, null, '']) {
    assert.strictEqual(signingString({ ...parts, nonce }), signingString(parts),
      `nonce: ${JSON.stringify(nonce)} changed the no-nonce string`);
  }
});

test('2. a nonce is covered by the signature, and changing it changes the signature', () => {
  const base = { method: 'POST', path: '/worker/lease', timestamp: '1731600000000', body: '{}' };
  const a = sign('s', { ...base, nonce: 'a'.repeat(32) });
  const b = sign('s', { ...base, nonce: 'b'.repeat(32) });

  assert.notStrictEqual(a, b, 'two nonces produced the same signature — the nonce is not signed');

  // And it is positioned before the body, so a body containing newlines cannot swallow it.
  assert.strictEqual(signingString({ ...base, nonce: 'abc' }),
    'POST\n/worker/lease\n1731600000000\nnonce=abc\n{}');
});

test('3. THE COLLISION IS REAL, and is unreachable only because no endpoint accepts both forms', () => {
  // This is the honest version of the design note. The two strings ARE equal:
  const withNonce = signingString({
    method: 'POST', path: '/p', timestamp: '1', nonce: 'abc', body: 'BODY',
  });
  const withoutNonce = signingString({
    method: 'POST', path: '/p', timestamp: '1', body: 'nonce=abc\nBODY',
  });
  assert.strictEqual(withNonce, withoutNonce,
    'the collision this test documents has disappeared — if signingString changed shape, re-reason '
    + 'about it rather than deleting this test');

  // So the separation cannot come from the string. It comes from the verifiers: the sender service
  // never passes a nonce, and worker authentication requires one matching /^[0-9a-f]{32}$/.
  // `abc` is not of that shape, so the forged pairing cannot be presented to the worker path at
  // all, and the sender path would reject a nonce it does not know to supply.
  assert.ok(!/^[0-9a-f]{32}$/.test('abc'),
    'the worker nonce shape no longer excludes a short literal — the collision is now reachable');
});

test('4. sameSignature does not throw on a length mismatch, and rejects it', () => {
  // timingSafeEqual throws when lengths differ. A thrown comparison inside a try/catch that
  // answers "allow" is an authentication bypass, so this is load-bearing rather than cosmetic.
  assert.strictEqual(sameSignature('abc', 'abcd'), false);
  assert.strictEqual(sameSignature('', 'a'), false);
  assert.strictEqual(sameSignature(null, undefined), true);   // both normalise to ''
  assert.strictEqual(sameSignature('abc', 'abc'), true);
});
