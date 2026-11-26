// ── CAN THE PLAN CHECK THE RESULT AT ALL? ───────────────────────────────────
//
// `office/cycle.js`'s VALIDATE phase claims to validate a worker's result INDEPENDENTLY of the
// handler that produced it — against what the plan asked for rather than against the handler's own
// contract. Three separate pieces of evidence in this repository rest on that claim.
//
// For as long as the claim existed, the comparison was:
//
//     JSON.stringify(output).includes(String((step.payload && step.payload.echo) || '').slice(0, 24))
//
// and no step this cycle mints has an `echo` field. The needle was the empty string, and
// `anything.includes('')` is always true, so every result the handler called SUCCEEDED passed.
// B3.18's second negative path submitted output with nothing to do with the plan and watched it
// validate.
//
// These tests exist because an end-to-end scenario cannot catch that. The happy path satisfies a
// vacuous criterion and a real one identically — the only way to tell them apart is to feed in
// output that SHOULD be refused, which is what every case below does.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { independentCriterion } = require('./cycle');

const echoStep = (payload) => ({
  step_id: 's1', task_type: 'synthetic.echo', payload,
});

test('the payload the plan minted, echoed back, validates', () => {
  const payload = { hello: 'office-checkpoint' };
  const r = independentCriterion(echoStep(payload), { echoed: payload, steps: 0 });
  assert.equal(r.validated, true);
  assert.match(r.criterion, /echoed/);
});

test('key order does not decide it: jsonb returns what it likes', () => {
  const r = independentCriterion(
    echoStep({ a: 1, b: { c: 2, d: 3 } }),
    { echoed: { b: { d: 3, c: 2 }, a: 1 }, steps: 0 },
  );
  assert.equal(r.validated, true);
});

test('THE REGRESSION: a payload with no `echo` field plus unrelated output is REFUSED', () => {
  // This is the exact shape the old line passed. `{hello:'office-checkpoint'}` is the payload the
  // only executable step in the vocabulary actually carries, and the output is deliberately
  // unrelated. If this ever goes green while the output is unrelated, the criterion has become
  // vacuous again.
  const r = independentCriterion(
    echoStep({ hello: 'office-checkpoint' }),
    { unrelated: 'this is not what the plan asked for' },
  );
  assert.equal(r.validated, false);
  assert.match(r.reason, /no `echoed`/);
});

test('an echoed payload that differs from the plan is refused, and says so', () => {
  const r = independentCriterion(
    echoStep({ hello: 'office-checkpoint' }),
    { echoed: { hello: 'something else entirely' }, steps: 0 },
  );
  assert.equal(r.validated, false);
  assert.match(r.reason, /not the payload the plan minted/);
});

test('output that is not an object at all is refused rather than coerced', () => {
  for (const output of [null, 'a string', 42, ['an', 'array']]) {
    const r = independentCriterion(echoStep({ hello: 'x' }), output);
    assert.equal(r.validated, false, `${JSON.stringify(output)} must not validate`);
  }
});

test('an UNDECLARED task type is not validated — it is named as having no criterion', () => {
  // The important half is that the default is NOT true. A type nobody has written a criterion for
  // produces a `partial` outcome and an escalation, which is inconvenient on purpose: a default of
  // "validated" is how the vacuous comparison survived three pieces of acceptance evidence.
  const r = independentCriterion(
    { step_id: 's9', task_type: 'operations.something_new', payload: { a: 1 } },
    { whatever: true },
  );
  assert.equal(r.validated, false);
  assert.match(r.reason, /no_independent_criterion/);
  assert.match(r.reason, /operations\.something_new/);
});

test('an empty planned payload still has to be echoed as an empty payload', () => {
  // The degenerate case the old code was most wrong about: with nothing in the payload, there is
  // still something to check — that the worker echoed nothing back, rather than anything at all.
  assert.equal(independentCriterion(echoStep({}), { echoed: {}, steps: 0 }).validated, true);
  assert.equal(
    independentCriterion(echoStep({}), { echoed: { surprise: 1 }, steps: 0 }).validated, false);
});
