// ── THE PLANNER, AND WHY IT REFUSES MORE THAN IT PRODUCES ───────────────────
//
// M7.6 asks for "an AI planner generating a bounded task plan". This is the deterministic first
// version, and it makes no model call at all.
//
// That is deliberate. The pipeline under test is goal → plan → policy → dispatch → execute →
// validate → report. If the planner were a model call on day one, every failure anywhere in that
// chain would first have to be distinguished from "the model said something different this time".
// A deterministic planner makes the rest of the pipeline the thing being tested, and it is what
// the replay case needs.
//
// ── THE VOCABULARY IS CLOSED, LIKE THE HANDLER TABLE ───────────────────────
//
// `executor.js` holds a frozen HANDLERS map with no dynamic require, because "a vocabulary that
// changes shape with the environment is not a closed vocabulary". The same reasoning applies one
// level up: a planner that can emit an arbitrary step type is an arbitrary-code-execution request
// waiting for a handler to exist.
//
// So STEP_VOCABULARY is frozen, every step maps to a task type declared in task-types.js, and
// `validateShape` refuses a plan containing anything else.
//
// ── AND AN UNKNOWN STEP REFUSES THE WHOLE PLAN ─────────────────────────────
//
// Not the step. The plan. A plan with one step removed is not the plan that was validated, and
// "we ran the parts we understood" is how a bounded plan stops being bounded. This matters most
// for the phase-2 model-assisted planner, where the model's output is DATA to be validated and
// never an instruction: it may propose steps, and it cannot widen the vocabulary.

'use strict';

const crypto = require('crypto');
const TYPES = require('../worker/task-types');
const SYNTHETIC = require('./synthetic');

const PLANNER_VERSION = 'deterministic-1';

/**
 * Every step this planner may emit. `taskType` must exist in the worker task vocabulary — asserted
 * at module load below, so a typo is a startup failure rather than a dispatch-time refusal.
 */
const STEP_VOCABULARY = Object.freeze({
  // A cheap round trip before the real work. It proves the worker is responsive and claiming, and
  // gives the plan a second step so ordering and idempotency are exercised by the pilot itself.
  'operations.liveness_checkpoint': Object.freeze({
    taskType: 'synthetic.echo',
    summary: 'confirms the worker is claiming and reporting before the report is attempted',
    payloadFor: () => ({ hello: 'm76-checkpoint' }),
  }),
  'operations.daily_report': Object.freeze({
    taskType: 'report.daily_operations',
    summary: 'computes the daily scientific operations summary from synthetic facts',
    payloadFor: ({ asOf, facts }) => ({ asOf, facts }),
  }),
});

// Load-time check: the vocabulary cannot reference a task type that does not exist.
for (const [stepType, def] of Object.entries(STEP_VOCABULARY)) {
  if (!TYPES.isKnown(def.taskType)) {
    throw new Error(`m76 step '${stepType}' maps to unknown task type '${def.taskType}'`);
  }
}

/**
 * The goals this planner recognises. Anything else is refused — a planner that improvises a plan
 * for an unrecognised goal is the opposite of bounded, and "it did something reasonable" is not a
 * property anyone can rely on.
 */
const RECOGNISED_GOALS = Object.freeze([
  Object.freeze({
    kind: 'daily_operations_report',
    // Narrow on purpose. Widening this is a deliberate edit, visible in a diff.
    match: /\b(daily|today'?s)\b[\s\S]*\boperations\b[\s\S]*\breport\b/i,
    steps: Object.freeze(['operations.liveness_checkpoint', 'operations.daily_report']),
  }),
]);

const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('hex')}`;

/**
 * Turn a stated goal into a bounded plan.
 *
 * @returns {{ok: true, plan}} | {{ok: false, refused: string, detail: string}}
 */
function plan({ goalId, text, asOf, seed = 'm76', factCount = SYNTHETIC.DEFAULT_COUNT } = {}) {
  if (!goalId) return { ok: false, refused: 'no_goal_id', detail: 'a plan must belong to a goal' };
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, refused: 'empty_goal', detail: 'the goal has no text to recognise' };
  }
  if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    return { ok: false, refused: 'no_as_of', detail: 'a report needs an as-of date (YYYY-MM-DD)' };
  }

  const recognised = RECOGNISED_GOALS.find((g) => g.match.test(text));
  if (!recognised) {
    return {
      ok: false,
      refused: 'unrecognised_goal',
      detail: `this planner recognises ${RECOGNISED_GOALS.length} goal kind(s) and this is not one `
        + 'of them. It will not improvise a plan for a goal it does not understand.',
    };
  }

  const { facts } = SYNTHETIC.generate({ asOf, seed, count: factCount });
  const planId = newId('m76plan');
  const steps = recognised.steps.map((stepType, i) => {
    const def = STEP_VOCABULARY[stepType];
    return {
      stepId: `s${i + 1}`,
      ordinal: i + 1,
      stepType,
      taskType: def.taskType,
      payload: def.payloadFor({ asOf, facts }),
      // Per-plan, so two plans for the same goal cannot collide on `uq_worker_tasks_intent` and
      // cannot inherit each other's attempt history — the lesson from the M7.5 acceptance runs.
      intentKey: `m76-${planId}-s${i + 1}`,
    };
  });

  return {
    ok: true,
    plan: {
      planId, goalId, planner: PLANNER_VERSION, goalKind: recognised.kind, asOf, seed, steps,
    },
  };
}

/**
 * Shape validation, separate from `plan()` so that a plan from ANY source can be checked — which
 * is the hook the phase-2 model-assisted planner will go through. It answers one question: is
 * every part of this plan inside the closed vocabulary?
 *
 * @returns {string[]} problems; empty means the shape is acceptable
 */
function validateShape(candidate) {
  const problems = [];
  if (!candidate || typeof candidate !== 'object') return ['the plan is not an object'];
  if (!candidate.planId) problems.push('the plan has no planId');
  if (!candidate.goalId) problems.push('the plan has no goalId');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(candidate.asOf))) problems.push('asOf is not YYYY-MM-DD');
  if (!Array.isArray(candidate.steps) || candidate.steps.length === 0) {
    problems.push('the plan has no steps');
    return problems;
  }
  if (candidate.steps.length > 8) {
    problems.push(`the plan has ${candidate.steps.length} steps; the pilot bound is 8`);
  }
  const seenIds = new Set();
  const seenIntents = new Set();
  for (const s of candidate.steps) {
    if (!s || typeof s !== 'object') { problems.push('a step is not an object'); continue; }
    const def = STEP_VOCABULARY[s.stepType];
    if (!def) {
      problems.push(`step '${s.stepType}' is not in the closed vocabulary `
        + `(${Object.keys(STEP_VOCABULARY).join(', ')})`);
      continue;
    }
    if (s.taskType !== def.taskType) {
      problems.push(`step '${s.stepType}' must map to task type '${def.taskType}', not '${s.taskType}'`);
    }
    if (!s.stepId) problems.push('a step has no stepId');
    else if (seenIds.has(s.stepId)) problems.push(`duplicate stepId '${s.stepId}'`);
    else seenIds.add(s.stepId);
    if (!s.intentKey) problems.push(`step '${s.stepId}' has no intentKey`);
    else if (seenIntents.has(s.intentKey)) problems.push(`duplicate intentKey '${s.intentKey}'`);
    else seenIntents.add(s.intentKey);
    if (s.intentKey && !String(s.intentKey).startsWith(`m76-${candidate.planId}-`)) {
      problems.push(`step '${s.stepId}' has an intentKey outside its own plan's namespace`);
    }
  }
  return problems;
}

module.exports = {
  plan, validateShape, STEP_VOCABULARY, RECOGNISED_GOALS, PLANNER_VERSION,
};
