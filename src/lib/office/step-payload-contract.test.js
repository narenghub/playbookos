// ── A STEP'S PAYLOAD MUST BE ONE ITS HANDLER ACCEPTS ────────────────────────
//
//   node --test src/lib/office/step-payload-contract.test.js
//
// decomposition.js had a load-time check already: every step in the vocabulary must name a task
// type the registry knows. It passed. `operations.daily_report` named `report.daily_operations`,
// which exists, is declared read-only and re-executable, and has a handler.
//
// The step's `payloadFor` returned `{ asOf }`. The handler's first act is to require
// `payload.facts` to be an array. Nothing in the repository compared the two, because until the
// cycle ran unattended no office plan step had ever reached a real worker — the acceptance driver
// asserted that steps were ENQUEUED. So the first plan that was actually executed produced
// `handler_threw: payload.facts must be an array`, and the defect had been shipped behind a
// passing check for as long as the vocabulary had existed.
//
// The registry check measured that a NAME resolved. This file measures what was wanted: that the
// thing the planner mints can be executed by the code that will receive it. It is written as a
// loop over the vocabulary rather than as a test of the one known offender, so the next step type
// added inherits the check instead of repeating the outage.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const DECOMP = require('./decomposition');
const EXECUTOR = require('../../worker-client/executor');
const TYPES = require('../worker/task-types');

/** Arguments that satisfy each declared validator, used to exercise `payloadFor` honestly. */
const ARG_FIXTURES = {
  asOf: '2026-11-25',
  focus: 'approvals',
  supplierId: 'sup-1',
  moleculeName: 'Metformin HCl',
  facts: [
    { id: 'f1', kind: 'assay', molecule: 'Metformin HCl', status: 'open', units: 2 },
    { id: 'f2', kind: 'shipment', molecule: 'Metformin HCl', status: 'closed', units: 1 },
  ],
};

/** The one task type whose handler cannot be exercised without doing the forbidden thing. */
const NOT_EXECUTED_HERE = 'synthetic.crash_test';

const vocabulary = () => DECOMP.STEP_VOCABULARY || DECOMP.stepVocabulary || null;

test('1. every declared argument has a fixture, or this file is testing less than it claims', () => {
  const vocab = vocabulary();
  assert.ok(vocab, 'the step vocabulary is not exported; this test cannot measure anything');
  for (const [stepType, def] of Object.entries(vocab)) {
    for (const name of Object.keys(def.args || {})) {
      assert.ok(Object.hasOwn(ARG_FIXTURES, name),
        `${stepType} declares argument \`${name}\` and this test has no fixture for it, so the `
        + 'payload below would be built from undefined and prove nothing');
    }
  }
});

test('2. DECISIVE: every step with a task type produces a payload its handler ACCEPTS', async () => {
  const vocab = vocabulary();
  let measured = 0;
  const skippedTypes = [];

  for (const [stepType, def] of Object.entries(vocab)) {
    if (!def.taskType) continue;                       // thinking or approval steps execute nowhere
    if (def.taskType === NOT_EXECUTED_HERE) {
      // synthetic.crash_test refuses unless four deliberate conditions hold, and arranging them
      // would be a deliberate crash, which the owner forbids. So its payload contract is NOT
      // measured here. Named rather than filtered by a predicate, so adding a second unmeasured
      // type is a visible edit to this file.
      skippedTypes.push(def.taskType);
      continue;
    }
    const { handler, code } = EXECUTOR.handlerFor(def.taskType);
    if (!handler) {
      // A declared task type with no handler is a different gap, and task-types.js owns it. What
      // must not happen is a step whose handler EXISTS and refuses the payload.
      assert.ok(['no_handler'].includes(code),
        `${stepType} → ${def.taskType}: ${code}`);
      continue;
    }

    const args = {};
    for (const name of Object.keys(def.args || {})) args[name] = ARG_FIXTURES[name];

    // The validators first: a payload built from arguments the step itself would refuse is not
    // evidence about the handler.
    for (const [name, validate] of Object.entries(def.args || {})) {
      assert.strictEqual(validate(args[name]), null,
        `${stepType}: fixture for \`${name}\` is not valid by the step's own validator`);
    }

    const payload = def.payloadFor(args);
    const out = await handler.run(payload, { signal: new AbortController().signal });
    const problems = handler.validateOutput(out, payload);
    assert.deepStrictEqual(problems, [],
      `${stepType} → ${def.taskType}: the handler ran but its own output validation refused`);
    measured++;
  }

  assert.ok(measured >= 2,
    `only ${measured} executable step type(s) were measured; the loop is not reaching the vocabulary`);
  assert.deepStrictEqual([...new Set(skippedTypes)].filter((t) => t !== NOT_EXECUTED_HERE), [],
    'a task type other than the crash test went unmeasured');
});

test('3. the regression itself: a daily report WITHOUT facts is refused at planning, not at the worker', () => {
  const vocab = vocabulary();
  const def = vocab['operations.daily_report'];
  assert.ok(def, 'the step type was removed rather than repaired');

  // The planner now declares `facts`, so a plan that omits them never becomes a task. Before the
  // repair this argument did not exist and the omission was invisible until execution.
  assert.ok(Object.hasOwn(def.args, 'facts'),
    'facts is not a declared argument, so a step can still be minted without them');
  assert.ok(def.args.facts(undefined), 'an absent facts argument must be refused');
  assert.ok(def.args.facts([]), 'an empty facts array must be refused: a report of nothing is not a report');
  assert.ok(def.args.facts([{ id: 'x', kind: 'not_a_kind', status: 'open' }]),
    'an unknown fact kind must be refused by the planner, as the handler refuses it');
  assert.strictEqual(def.args.facts(ARG_FIXTURES.facts), null);
});

test('4. and the deterministic planner does not propose it without a fact source', () => {
  // The office path has no operations-facts reader. The honest consequence is that this step is
  // NOT proposed there — rather than proposed with empty facts, which would render a report of
  // zero as though zero had been measured.
  const objective = { objectiveId: 'obj-1', kpi_metric: 'revenue_usd' };
  const bare = DECOMP.deterministicCandidates({ objective, asOf: '2026-11-25' });
  assert.ok(!bare.candidates.some((c) => c.stepType === 'operations.daily_report'),
    'a daily report was proposed with no facts to compute it from');

  const withFacts = DECOMP.deterministicCandidates({
    objective, asOf: '2026-11-25', operationsFacts: ARG_FIXTURES.facts,
  });
  const step = withFacts.candidates.find((c) => c.stepType === 'operations.daily_report');
  assert.ok(step, 'a caller that HAS facts still cannot get the step proposed');
  assert.deepStrictEqual(step.args.facts, ARG_FIXTURES.facts);
});

test('5. the executable step the cycle actually dispatches still works end to end', async () => {
  // operations.liveness_checkpoint is what the office cycle now delegates. If this breaks, the
  // unattended cycle has no dispatchable step at all and check-unattended-cycle-db.js would be
  // asserting a cycle that does nothing.
  const def = vocabulary()['operations.liveness_checkpoint'];
  assert.strictEqual(def.taskType, 'synthetic.echo');
  assert.ok(TYPES.isKnown(def.taskType));
  const { handler } = EXECUTOR.handlerFor(def.taskType);
  const payload = def.payloadFor({});
  const out = await handler.run(payload, { signal: new AbortController().signal });
  assert.deepStrictEqual(handler.validateOutput(out, payload), []);
});
