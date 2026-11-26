// ── B3.2: DYNAMIC OBJECTIVE DECOMPOSITION ───────────────────────────────────
//
// An objective becomes a bounded, ordered plan of steps. The proposal may come from a model; the
// authorization never does.
//
// THE OWNER'S INSTRUCTION, WHICH IS THE WHOLE DESIGN:
//
//   "Agent-generated plans are proposals, not authorization. Every proposed step must be
//    independently validated against company scope, capability permissions, execution eligibility,
//    STOP controls, approval requirements and budget."
//
// So this module is two halves that do not trust each other:
//
//   propose()   turns an objective (and, optionally, a model's suggestion) into candidate steps.
//               It may be wrong, adversarial, or model-generated. Nothing it returns is permitted
//               to execute.
//   validate()  recomputes all six properties FROM AUTHORITATIVE SOURCES and judges every step.
//               It reads nothing from the proposal except which step types were chosen and the
//               typed arguments for them.
//
// ── WHAT "INDEPENDENTLY VALIDATED" HAS TO MEAN HERE ────────────────────────
//
// It is not enough to check a field the proposal supplied. A proposal that says
// `capability: 'email.send', approved: true, companyId: 'abiozen', budgetUsd: 1000` must gain
// nothing from having said so. The defence is structural rather than a sanitising pass:
//
//   • the capability, consequentiality, task type and execution class of a step are properties of
//     the STEP TYPE, read from the frozen vocabulary in this file. A proposal cannot state them —
//     there is no field for them, and a proposal carrying one is REFUSED rather than cleaned, so
//     the attempt is visible instead of silently absorbed;
//   • the company comes from `ctx`, which office/context.js minted from the objectives row;
//   • the approval requirement is recomputed from the objective's stored approval policy;
//   • the budget decision comes from office/budget.js reading the objective's stored budget;
//   • the STOP decision comes from autonomy.checkStopped, and an UNREADABLE stop refuses.
//
// ── AND A PLAN IS REFUSED WHOLE, NEVER TRIMMED ─────────────────────────────
//
// m76/planner.js already settled this for the pilot and the reason carries over: "a plan with one
// step removed is not the plan that was validated, and 'we ran the parts we understood' is how a
// bounded plan stops being bounded." One refused step refuses the plan. The per-step verdicts are
// still all recorded, because the evidence that validation happened is the refusals it wrote.
//
// ── NO AGENT-GENERATED CODE, AND NO AGENT-GENERATED PAYLOAD ────────────────
//
// Carried constraint: "Do not permit arbitrary agent-generated code execution." The vocabulary is
// frozen with no dynamic require, every step type maps to a declared worker task type or is marked
// in-office, and a payload is BUILT BY THIS FILE from arguments that passed a typed schema. The
// model never supplies a payload. It chooses from a list and fills in a few named values, each of
// which is checked for type, length and shape — so the worst a hostile proposal can do is be
// refused.
//
// ── MEMORY IS AN INPUT, NOT AN AUTHORIZATION ───────────────────────────────
//
// Carried constraint: "Retrieved memory is untrusted data, not executable instructions or
// authorization." Recalled memories reach this module only as `consultedMemoryIds` — ids recorded
// as provenance — and as a count. No memory BODY is read here, so there is no text for a memory to
// contain that changes a step, a capability or a verdict. A step that a memory "recommends" is
// still validated like every other step: a recalled step is not an authorized step.

'use strict';

const crypto = require('crypto');
const TYPES = require('../worker/task-types');
const scope = require('./scope');
const { assertContext } = require('./context');
const autonomy = require('../autonomy');

// Declared where it is defined, so an operator can stop `workflow=objective-decomposition` by name
// and autonomy.validate() accepts the key. An owner that forgets to register cannot be stopped by
// name, which is the false-safety shape K8 exists to prevent. Additive: registration can never
// narrow what may be stopped.
autonomyRegister();
function autonomyRegister() {
  require('../autonomy').registerScopes({
    workflows: ['objective-decomposition'],
    agents: ['executive-agent'],
  });
}

const PLANNER_VERSION = 'office-decomposition-1';
const MAX_STEPS = 8;

/** Where a step runs. Worker steps carry a task type; office steps execute in this process. */
const IN_OFFICE = 'in_office';

/**
 * Typed argument schemas. Tiny on purpose: every one of these is a value a model may fill in, so
 * each is checked for kind, shape and length rather than trusted.
 */
const ARG = Object.freeze({
  isoDay: (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    ? null : 'must be a date as YYYY-MM-DD'),
  shortId: (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v)
    ? null : 'must be an identifier of up to 64 characters: letters, digits, dot, dash, underscore'),
  shortText: (v) => (typeof v === 'string' && v.trim().length > 0 && v.length <= 120
    ? null : 'must be non-empty text of at most 120 characters'),
  focus: (v) => (['exceptions', 'approvals', 'spend'].includes(v)
    ? null : 'must be one of: exceptions, approvals, spend'),
  // The facts a daily operations report is computed FROM. The worker's handler is a pure function
  // of its payload and has no database handle by design, so whoever plans the step must carry the
  // facts — and must carry them in the shape the handler accepts, or the task fails at execution
  // time rather than at planning time. That is what happened: the step below passed `{asOf}` only,
  // the vocabulary's load-time check confirmed the TASK TYPE existed, nobody checked the PAYLOAD
  // CONTRACT, and the first plan ever to reach a real worker produced
  // `handler_threw: payload.facts must be an array`. The registry check measured the wrong thing.
  operationsFacts: (v) => {
    if (!Array.isArray(v) || !v.length) return 'must be a non-empty array of operations facts';
    if (v.length > 200) return 'must be at most 200 facts; a larger report is a different task';
    const KINDS = ['assay', 'batch', 'qc_check', 'inquiry', 'shipment'];
    const STATUSES = ['open', 'closed', 'blocked'];
    for (const f of v) {
      if (!f || typeof f !== 'object') return 'each fact must be an object';
      if (!KINDS.includes(f.kind)) return `each fact.kind must be one of: ${KINDS.join(', ')}`;
      if (!STATUSES.includes(f.status)) return `each fact.status must be one of: ${STATUSES.join(', ')}`;
      if (typeof f.id !== 'string' || !f.id) return 'each fact needs a string id';
    }
    return null;
  },
});

/**
 * THE CLOSED VOCABULARY.
 *
 * Each entry declares what the step IS. None of it is proposable: a proposal names a `stepType` and
 * supplies `args`, and everything else below is read from here.
 *
 *   capability     the autonomy capability the step consumes, for the STOP check and the
 *                  permission check. `null` means it consumes none (a scoped read of the company's
 *                  own rows), and that is not a way to escape the other five gates.
 *   consequential  whether the step has an effect outside the platform. A consequential step may
 *                  only PREPARE; releasing is approval.release, which is not in this vocabulary and
 *                  cannot be reached from a plan.
 *   taskType       the worker task type it dispatches to, or null for in-office execution.
 */
const STEP_VOCABULARY = Object.freeze({
  'observe.objective_state': Object.freeze({
    summary: 'reads this company\'s own objective, spend, exceptions and approvals',
    taskType: null,
    capability: null,
    consequential: false,
    args: Object.freeze({}),
    payloadFor: () => ({}),
  }),
  'intelligence.summarise_state': Object.freeze({
    summary: 'one governed AI call that summarises the observed state for a briefing',
    taskType: null,
    capability: 'llm.call',
    consequential: false,
    args: Object.freeze({ focus: ARG.focus }),
    payloadFor: (a) => ({ focus: a.focus }),
  }),
  'operations.liveness_checkpoint': Object.freeze({
    summary: 'a cheap worker round trip, so a plan proves the execution path before relying on it',
    taskType: 'synthetic.echo',
    capability: 'worker.execute',
    consequential: false,
    args: Object.freeze({}),
    payloadFor: () => ({ hello: 'office-checkpoint' }),
  }),
  'operations.daily_report': Object.freeze({
    summary: 'renders an internal operations summary from data already in the database',
    taskType: 'report.daily_operations',
    capability: 'worker.execute',
    consequential: false,
    args: Object.freeze({ asOf: ARG.isoDay, facts: ARG.operationsFacts }),
    payloadFor: (a) => ({ asOf: a.asOf, facts: a.facts }),
  }),
  // A CONSEQUENTIAL step, present because without one the approval gate below would be untested —
  // "a test whose every fixture takes the same branch tests one branch" (task-types.js's own
  // practice). PREPARE only: it produces an approval request for a human, and the release is
  // approval.release, which no plan can name.
  'outreach.prepare_rfq': Object.freeze({
    summary: 'PREPARES a supplier RFQ for human approval',
    taskType: null,
    capability: 'email.send',
    consequential: true,
    // Declared, so "a plan cannot release anything" is a property of the data rather than of this
    // file's prose. Every consequential step must carry it, asserted at load below, and
    // check-office-decomposition-db.js asserts that this module reaches no release path at all.
    prepareOnly: true,
    args: Object.freeze({ supplierId: ARG.shortId, moleculeName: ARG.shortText }),
    payloadFor: (a) => ({ supplier_id: a.supplierId, molecule_name: a.moleculeName }),
  }),
  // A HARDWARE_REQUIRED step, present for the same reason: the execution-eligibility gate needs a
  // case that is not cloud-eligible, or that gate is decoration.
  'operations.hardware_rehearsal': Object.freeze({
    summary: 'development-only hardware recovery rehearsal — HARDWARE_REQUIRED, so a cloud worker '
      + 'can never claim it',
    taskType: 'synthetic.crash_test',
    capability: 'worker.execute',
    consequential: false,
    args: Object.freeze({}),
    payloadFor: () => ({}),
  }),
});

// Load-time: the vocabulary cannot name a task type that does not exist, and a worker step must
// have one. A typo is a startup failure rather than a dispatch-time surprise.
for (const [stepType, def] of Object.entries(STEP_VOCABULARY)) {
  if (def.taskType !== null && !TYPES.isKnown(def.taskType)) {
    throw new Error(`office step '${stepType}' maps to unknown task type '${def.taskType}'`);
  }
  if (def.capability !== null && !autonomy.CAPABILITIES.includes(def.capability)) {
    throw new Error(`office step '${stepType}' names capability '${def.capability}', which the `
      + `kill switch does not know — it could not be stopped by name`);
  }
  // A consequential step may only PREPARE. Releasing an approved action is approval.release, which
  // this vocabulary cannot name and this module does not require. Adding a consequential step
  // without `prepareOnly` is a startup failure, so the property cannot be lost by omission.
  if (def.consequential && def.prepareOnly !== true) {
    throw new Error(`office step '${stepType}' is consequential and does not declare prepareOnly: `
      + 'a plan may prepare a consequential action and may never carry one out');
  }
}

/**
 * Fields a PROPOSAL may never carry. Each is something the validator computes from an authoritative
 * source, so a proposal supplying one is attempting to supply its own authorization.
 *
 * REFUSED, not stripped. Stripping would let the attempt succeed quietly minus its effect, and the
 * thing worth knowing is that it was made.
 */
const FORBIDDEN_PROPOSAL_FIELDS = Object.freeze([
  'companyId', 'company_id', 'capability', 'consequential', 'taskType', 'task_type',
  'executionClass', 'execution_class', 'requiresApproval', 'requires_approval', 'approved',
  'budgetUsd', 'budget_usd', 'autonomyTier', 'autonomy_tier', 'verdict', 'status',
  'payload', 'payloadDigest', 'payload_digest', 'intentKey', 'intent_key',
]);

/** Stable JSON: keys sorted at every depth, so a digest survives a round trip through JSONB. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function digestOf(payload) {
  return crypto.createHash('sha256')
    .update(canonical(payload === undefined ? null : payload)).digest('hex');
}

const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('hex')}`;

const refuse = (code, detail, extra = {}) => ({ ok: false, refused: code, detail, ...extra });

// ── PROPOSE ─────────────────────────────────────────────────────────────────

/**
 * Turn a candidate step list into a plan structure. Accepts the shape a model would emit —
 * `[{ stepType, args }]` — and nothing more.
 *
 * This produces a PROPOSAL. It is deliberately permissive about what it is handed and strict about
 * what it emits: the payload is built here from checked arguments, the digest is computed here, and
 * the intent key is namespaced to this plan so two plans for one objective cannot collide on
 * `uq_worker_tasks_intent` or inherit each other's attempt history.
 *
 * @returns {{ok:true, plan}} | {{ok:false, refused, detail}}
 */
function propose(ctx, { candidates, proposer = 'deterministic', consultedMemoryIds = [],
  planId: givenPlanId = null } = {}) {
  assertContext(ctx);
  if (!ctx.objectiveId) return refuse('no_objective', 'a plan must belong to an objective');
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return refuse('empty_proposal', 'a plan with no steps is not a plan');
  }
  if (candidates.length > MAX_STEPS) {
    return refuse('too_many_steps',
      `${candidates.length} steps proposed; the bound is ${MAX_STEPS}`);
  }

  // A CALLER MAY SUPPLY THE ID, and one caller does for a reason worth stating: the office cycle
  // derives it from the run, so that two concurrent PLAN phases collide on this table's primary key
  // instead of writing two plans with two sets of dispatchable intent keys (B3.17). Every other
  // caller gets a fresh id, which is what keeps `check-autonomous-office-cycle-db.js` able to judge
  // several proposals against one run.
  const planId = givenPlanId || newId('plan');
  const steps = [];
  const seenIntents = new Set();

  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      return refuse('malformed_step', `step ${i + 1} is not an object`);
    }

    // The forbidden-field check comes FIRST, before the step type is even looked up, so a proposal
    // that tries to assert its own capability is refused by name rather than being quietly
    // overwritten by the vocabulary's value.
    const asserted = FORBIDDEN_PROPOSAL_FIELDS.filter((f) => f in c);
    if (asserted.length) {
      return refuse('proposal_asserted_authorization',
        `step ${i + 1} supplies ${asserted.join(', ')} — a proposal may name a step type and its `
        + 'arguments only. These values are computed from the objective, the vocabulary and the '
        + 'kill switch, and a proposal that states them is attempting to authorize itself.');
    }

    const def = STEP_VOCABULARY[c.stepType];
    if (!def) {
      return refuse('unknown_step_type',
        `step ${i + 1} is '${c.stepType}', which is not in the closed vocabulary `
        + `(${Object.keys(STEP_VOCABULARY).join(', ')}). The whole plan is refused: a plan with an `
        + 'uninterpretable step removed is not the plan that was proposed.');
    }

    // Arguments: every declared one required, nothing undeclared accepted.
    const args = (c.args && typeof c.args === 'object' && !Array.isArray(c.args)) ? c.args : {};
    const declared = Object.keys(def.args);
    const extra = Object.keys(args).filter((k) => !declared.includes(k));
    if (extra.length) {
      return refuse('unknown_argument',
        `step '${c.stepType}' was given ${extra.join(', ')}, which it does not declare`);
    }
    for (const name of declared) {
      const problem = def.args[name](args[name]);
      if (problem) {
        return refuse('bad_argument', `step '${c.stepType}' argument '${name}' ${problem}`);
      }
    }

    const payload = def.payloadFor(args);
    const intentKey = `plan-${planId}-s${i + 1}`;
    if (seenIntents.has(intentKey)) {
      return refuse('duplicate_intent_key', `two steps share the intent key ${intentKey}`);
    }
    seenIntents.add(intentKey);

    steps.push({
      planId,
      stepId: `s${i + 1}`,
      ordinal: i + 1,
      stepType: c.stepType,
      // All four read from the vocabulary, never from the proposal.
      taskType: def.taskType,
      capability: def.capability,
      consequential: def.consequential,
      executionClass: def.taskType === null ? IN_OFFICE : TYPES.executionClassOf(def.taskType),
      payload,
      payloadDigest: digestOf(payload),
      intentKey,
      // Computed by validate(), from the objective's stored policy. Present here only so the
      // persisted row has a column value; validate() overwrites it from the authoritative source
      // and the check asserts the two can disagree.
      requiresApproval: def.consequential,
    });
  }

  return {
    ok: true,
    plan: {
      planId,
      objectiveId: ctx.objectiveId,
      planner: PLANNER_VERSION,
      proposer,
      steps,
      // Provenance only. Nothing downstream reads a memory body, and these ids grant nothing.
      consultedMemoryIds: consultedMemoryIds.slice(0, 32),
    },
  };
}

/**
 * The deterministic proposer: what to do about an objective, chosen from its stored KPI metric.
 *
 * Deterministic FIRST, exactly as m76/planner.js argued: if the only proposer were a model call,
 * every failure in validation, persistence or dispatch would first have to be distinguished from
 * "the model said something different this time".
 */
function deterministicCandidates({ objective, asOf, priorStepTypes = [], operationsFacts = null } = {}) {
  // ── MEMORY INFORMS THE PLAN, AND CANNOT WIDEN IT (B3.2 + B3.1a) ──────────
  //
  // Owner, 2026-11-24: *"Do not mark memory-driven planning complete. The demonstrated memory
  // integration changes reporting, not yet planning."* This is the half that was missing.
  //
  // `priorStepTypes` is what this objective has already been recorded as completing. The CALLER
  // derives it from memory — from the structured subject of a prior outcome, never from a memory
  // BODY — and this function then INTERSECTS it with the closed vocabulary before using it. So:
  //
  //   • memory changes WHICH already-authorized steps are proposed. That is a real effect on the
  //     plan, and it is what makes a second run differ from the first.
  //   • memory cannot add a step type, because a value outside the vocabulary survives the
  //     intersection as nothing at all. An adversarial memory naming `shell.run` contributes
  //     exactly zero candidates rather than one refused plan — and nothing it can say reaches a
  //     capability, a company, a budget or an approval, all of which validate() recomputes.
  //   • the ignored count travels back, because a memory proposing steps nobody recognises is
  //     something an operator should see rather than something silently dropped.
  const recognised = priorStepTypes.filter((t) => Object.hasOwn(STEP_VOCABULARY, t));
  const ignored = priorStepTypes.length - recognised.length;
  const done = new Set(recognised);

  const candidates = [{ stepType: 'observe.objective_state', args: {} }];

  // The liveness checkpoint proves the execution path before the plan relies on it. Worth doing
  // once; worth SKIPPING on a later run that already has it, which is the whole point of asking
  // memory what happened before.
  if (!done.has('operations.liveness_checkpoint')) {
    candidates.push({ stepType: 'operations.liveness_checkpoint', args: {} });
  }

  if (objective && objective.kpi_metric === 'qualified_supplier_quotes_received') {
    candidates.push({ stepType: 'intelligence.summarise_state', args: { focus: 'approvals' } });
  } else if (Array.isArray(operationsFacts) && operationsFacts.length) {
    // ONLY when the caller actually has facts. A report step is proposed from the facts it will
    // be computed from, never from an intention to find some later: the handler is a pure
    // function of its payload, so a step minted without them is a task that cannot succeed.
    // No office caller supplies facts yet — there is no operations-facts reader on this path —
    // so this branch is currently unreached, and that absence is a tracked gap rather than a
    // plan that fails at the worker.
    candidates.push({ stepType: 'operations.daily_report', args: { asOf, facts: operationsFacts } });
  }

  return { candidates, informedBy: recognised, ignoredPriorSteps: ignored };
}

/**
 * The step types a set of recalled memories says this objective has already completed.
 *
 * Reads ONLY the structured `subject` field, by exact prefix match, and never the body. A memory
 * body is prose written for a person; parsing it to drive a decision is precisely the "executable
 * instructions" the owner's constraint rules out. The subject is a key this system wrote itself.
 */
const STEP_MEMORY_PREFIX = 'plan-step-completed:';
function priorStepsFromMemories(memories) {
  if (!Array.isArray(memories)) return [];
  const out = [];
  for (const m of memories) {
    const subject = m && typeof m.subject === 'string' ? m.subject : '';
    if (!subject.startsWith(STEP_MEMORY_PREFIX)) continue;
    const after = subject.slice(STEP_MEMORY_PREFIX.length);
    // `objectiveId/stepType` — take the step type, and only if the vocabulary knows it.
    const stepType = after.includes('/') ? after.slice(after.lastIndexOf('/') + 1) : after;
    if (Object.hasOwn(STEP_VOCABULARY, stepType)) out.push(stepType);
  }
  return [...new Set(out)];
}

/**
 * Parse a model's reply into candidates. The model's output is DATA.
 *
 * It is parsed, not evaluated. A reply that is not JSON, not an array of `{stepType, args}`, or
 * that names anything outside the vocabulary is refused — by propose(), using exactly the same code
 * path as a hand-written proposal, because a model-shaped bypass is what a separate path would be.
 */
function candidatesFromModelText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return refuse('model_said_nothing', 'the governed AI call produced no text to parse');
  }
  // Models like to wrap JSON in prose or a fence. Taking the outermost array is a parsing
  // convenience and nothing more: whatever comes out still goes through propose().
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) {
    return refuse('model_output_not_json', 'no JSON array of steps in the model\'s reply');
  }
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return refuse('model_output_not_json', `the model\'s step list did not parse: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    return refuse('model_output_not_json', 'the model\'s step list is not an array');
  }
  return { ok: true, candidates: parsed };
}

// ── VALIDATE ────────────────────────────────────────────────────────────────

/** The six gates, named so a verdict can say which one refused. */
const GATES = Object.freeze(['company_scope', 'capability_permission', 'execution_eligibility',
  'stop_controls', 'approval_requirement', 'budget']);

/**
 * Independently validate a proposed plan.
 *
 * Every gate recomputes its answer from an authoritative source. The proposal contributes the step
 * types and their arguments; it contributes nothing to the verdict.
 *
 * @returns {{ok:boolean, verdict, planId, steps, refused?, detail?, gates}}
 */
async function validate(ctx, plan, deps = {}) {
  assertContext(ctx);
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    return refuse('empty_plan', 'there is nothing to validate');
  }

  // ── GATE 1: COMPANY SCOPE ────────────────────────────────────────────────
  //
  // Read the objective through the scoped accessor. If it comes back null the objective is not this
  // company's — and that is the honest reading of a null: the predicate is `company_id = ctx`, so a
  // missing row means "not yours OR not there", and neither is a plan that may proceed.
  const objective = await scope.getObjective(ctx, plan.objectiveId, deps);
  if (!objective) {
    return refuse('objective_not_in_company_scope',
      `objective ${plan.objectiveId} is not readable for company ${ctx.companyId} — a plan cannot `
      + 'be validated against an objective this context does not reach');
  }
  if (plan.objectiveId !== ctx.objectiveId) {
    return refuse('objective_mismatch',
      `the plan names objective ${plan.objectiveId} and the context carries ${ctx.objectiveId}`);
  }
  if (objective.status !== 'active') {
    return refuse('objective_not_active',
      `objective ${plan.objectiveId} is ${objective.status}; a plan is validated against an active `
      + 'objective or not at all');
  }

  // ── GATE 6 (ONCE, PER OBJECTIVE): BUDGET ─────────────────────────────────
  //
  // Asked once rather than per step, because an objective budget is one fact about the objective.
  // Asked FIRST among the plan-wide gates and asked AUTONOMOUSLY: a plan is decomposition for
  // unattended execution, so a budgetless objective refuses here exactly as B2.5a requires. The
  // budget travels on the context, which was minted from the objectives row — nothing in the plan
  // can raise it.
  const budget = require('./budget');
  let budgetDecision;
  try {
    budgetDecision = await budget.enforceHierarchy(ctx, {
      objectiveId: plan.objectiveId, criticality: 'routine',
    }, deps);
  } catch (e) {
    return refuse('budget_unreadable',
      `the budget could not be read (${e.message}) — an unreadable budget is not permission`);
  }
  if (!budgetDecision.allow) {
    return refuse('budget_refused', budgetDecision.reason,
      { gate: 'budget', needsBudgetOrException: budgetDecision.needsBudgetOrException === true });
  }

  // ── THE PER-STEP GATES ───────────────────────────────────────────────────
  //
  // What may this fleet execute? Read once: the set of execution capabilities declared by workers
  // that are enrolled and not revoked. A step needing one nobody declares is not refused — it
  // queues, which is the owner's rule for hardware-only work — but it IS reported, because a
  // backlog nobody can drain is something an operator has to see.
  let fleetCapabilities = null;
  try {
    fleetCapabilities = await workerCapabilities(deps);
  } catch (e) {
    return refuse('fleet_unreadable',
      `worker capabilities could not be read (${e.message}) — execution eligibility cannot be `
      + 'decided, and an undecided gate is not a passed one');
  }

  const verdicts = [];
  let firstRefusal = null;

  for (const s of plan.steps) {
    const def = STEP_VOCABULARY[s.stepType];
    const v = { stepId: s.stepId, stepType: s.stepType, gates: {} };

    // The step as persisted must still be the step the vocabulary describes. This is what catches a
    // row altered between proposal and validation — the same discipline m76 applies to payload
    // digests, applied to the fields that decide authorization.
    if (!def) {
      v.verdict = 'refused'; v.refusalCode = 'unknown_step_type';
      v.refusalDetail = `'${s.stepType}' is not in the closed vocabulary`;
      verdicts.push(v); firstRefusal = firstRefusal || v; continue;
    }
    if (s.capability !== def.capability || s.consequential !== def.consequential
        || s.taskType !== def.taskType) {
      v.verdict = 'refused'; v.refusalCode = 'step_contradicts_vocabulary';
      v.refusalDetail = `step '${s.stepType}' carries capability=${s.capability}, `
        + `consequential=${s.consequential}, taskType=${s.taskType}; the vocabulary says `
        + `${def.capability}, ${def.consequential}, ${def.taskType}`;
      verdicts.push(v); firstRefusal = firstRefusal || v; continue;
    }
    if (s.payloadDigest !== digestOf(s.payload)) {
      v.verdict = 'refused'; v.refusalCode = 'payload_digest_mismatch';
      v.refusalDetail = `step '${s.stepId}' payload does not match the digest it was validated `
        + 'under, so the plan that would run is not the plan that was proposed';
      verdicts.push(v); firstRefusal = firstRefusal || v; continue;
    }

    // ── GATE 1 (per step): COMPANY SCOPE ─────────────────────────────────
    //
    // The payload is built by this file from checked arguments, so there is no company field in it
    // by construction — and this asserts that rather than assuming it, because "by construction"
    // is a claim about code that can change.
    const strayCompany = findCompanyField(s.payload);
    if (strayCompany) {
      v.verdict = 'refused'; v.refusalCode = 'step_names_a_company';
      v.refusalDetail = `step '${s.stepId}' payload carries ${strayCompany}; company scope comes `
        + 'from the resolved context and a step may not name one';
      verdicts.push(v); firstRefusal = firstRefusal || v; continue;
    }
    v.gates.company_scope = 'ok';

    // ── GATE 2: CAPABILITY PERMISSION ────────────────────────────────────
    //
    // Two questions, and they are different. Is this capability one the platform knows how to stop
    // by name? And does this objective's AUTONOMY TIER permit a step of this kind?
    //
    // The tier is the substance. `none` may observe and report and nothing else; `supervised` may
    // prepare a consequential action for a human; `bounded` is NOT AUTHORIZED for any company, so
    // an objective carrying it fails closed rather than being treated as the most permissive tier
    // — an unknown or unsupported tier refusing is the rule the dependency plan states.
    if (def.capability !== null && !autonomy.CAPABILITIES.includes(def.capability)) {
      v.verdict = 'refused'; v.refusalCode = 'capability_not_stoppable';
      v.refusalDetail = `'${def.capability}' is not a kill-switch capability, so this step could `
        + 'not be stopped by name';
      verdicts.push(v); firstRefusal = firstRefusal || v; continue;
    }
    const tier = objective.autonomy_tier;
    if (tier !== 'none' && tier !== 'supervised') {
      v.verdict = 'refused'; v.refusalCode = 'autonomy_tier_not_authorized';
      v.refusalDetail = `objective autonomy tier '${tier}' is not an authorized tier for planned `
        + 'execution (none, supervised). An unknown or unsupported tier fails closed.';
      verdicts.push(v); firstRefusal = firstRefusal || v; continue;
    }
    if (def.consequential && tier === 'none') {
      v.verdict = 'refused'; v.refusalCode = 'tier_forbids_consequential';
      v.refusalDetail = `step '${s.stepType}' is consequential and this objective's tier is 'none', `
        + 'which may observe, analyse and report only';
      verdicts.push(v); firstRefusal = firstRefusal || v; continue;
    }
    v.gates.capability_permission = `ok (tier ${tier})`;

    // ── GATE 3: EXECUTION ELIGIBILITY ────────────────────────────────────
    const execClass = def.taskType === null ? IN_OFFICE : TYPES.executionClassOf(def.taskType);
    if (execClass !== s.executionClass) {
      v.verdict = 'refused'; v.refusalCode = 'execution_class_mismatch';
      v.refusalDetail = `step '${s.stepId}' claims ${s.executionClass}; the registry says ${execClass}`;
      verdicts.push(v); firstRefusal = firstRefusal || v; continue;
    }
    if (def.taskType === null) {
      v.gates.execution_eligibility = 'in-office';
      v.executesOn = IN_OFFICE;
    } else {
      const needed = TYPES.requiredCapabilityOf(def.taskType);
      const capable = needed === null || fleetCapabilities.has(needed);
      v.executesOn = execClass;
      v.requiredCapability = needed;
      if (capable) {
        v.gates.execution_eligibility = needed === null ? 'cloud-eligible' : `a worker declares ${needed}`;
      } else {
        // NOT a refusal. "Hardware-only work must queue safely without consuming retry attempts or
        // being claimed by cloud workers" — so the step is eligible and waits. Refusing it here
        // would make a correct plan fail because a machine is currently unenrolled, and the obvious
        // next fix would be to let cloud workers claim hardware work.
        v.gates.execution_eligibility = `queued: no enrolled worker declares ${needed}`;
        v.awaitingCapableWorker = needed;
      }
    }

    // ── GATE 4: STOP CONTROLS ────────────────────────────────────────────
    //
    // Consulted PER STEP, with that step's own capability, because a stop on `email.send` must not
    // be answered by having asked about `worker.execute`. An UNREADABLE stop state refuses: it is
    // the absence of an answer, not a clear one, and the distinction is the one R1 draws between a
    // deliberate stop and an unknowable one.
    // ── WHY THIS ASKS AS A CONSEQUENTIAL CALLER, EVEN FOR A READ-ONLY STEP ──
    //
    // autonomy.checkStopped has two deliberate concessions to read-only callers: a stop on
    // anything other than a capability does not match ("thinking is not acting"), and an
    // UNREADABLE stop state returns null rather than refusing ("kill-state is unknowable: a
    // consequential action is refused; analysis continues").
    //
    // Both are right for an agent in the middle of reasoning. Neither is right here. Producing a
    // validated plan is minting the authorization a later dispatch will rely on, so a global stop,
    // a stop on this workflow, or a stop on this agent must prevent new plans from being minted
    // even when every step in them is a read — and a stop state that cannot be READ means this
    // gate did not answer, which by this function's own rule is not a passed gate.
    //
    // The cost is honest and worth stating: while `autonomy_stops` is unreadable, no plan can be
    // validated. That does not block observation or reporting, which take the read-only path
    // elsewhere; it blocks the creation of new authorization, which is the thing that should stop
    // when the kill switch cannot be consulted.
    let stopped;
    try {
      stopped = await autonomy.checkStopped({
        ...(def.capability === null ? {} : { capability: def.capability }),
        workflow: plan.workflow || 'objective-decomposition',
        agent: plan.agent || 'executive-agent',
        company: ctx.companyId,
      }, { consequential: true, deps });
    } catch (e) {
      v.verdict = 'refused'; v.refusalCode = 'killswitch_unreadable';
      v.refusalDetail = `the stop state could not be read (${e.message})`;
      verdicts.push(v); firstRefusal = firstRefusal || v; continue;
    }
    if (stopped && stopped.unknown === true) {
      v.verdict = 'refused'; v.refusalCode = 'killswitch_unreadable';
      v.refusalDetail = `the stop state is unknowable: ${stopped.reason}`;
      verdicts.push(v); firstRefusal = firstRefusal || v; continue;
    }
    if (stopped) {
      v.verdict = 'refused'; v.refusalCode = 'stopped_by_policy';
      v.refusalDetail = `a stop is in force at ${stopped.scope_type}`
        + `${stopped.scope_key ? `=${stopped.scope_key}` : ''}: ${stopped.reason}`;
      verdicts.push(v); firstRefusal = firstRefusal || v; continue;
    }
    v.gates.stop_controls = def.capability === null
      ? 'clear (no capability consumed; global, workflow and agent scopes still consulted)'
      : `clear for ${def.capability}`;

    // ── GATE 5: APPROVAL REQUIREMENT ─────────────────────────────────────
    //
    // RECOMPUTED from the objective's stored approval policy, and then compared with what the
    // proposal claimed. The comparison is the point: a proposal that said a consequential step
    // needs no approval does not get its way, and the disagreement is RECORDED rather than quietly
    // corrected, because a proposal trying to skip the approval boundary is the single most
    // important thing a reviewer could want to know.
    const requiresApproval = def.consequential
      && (objective.approval_policy === 'all_consequential' || objective.approval_policy === undefined);
    v.requiresApproval = requiresApproval;
    if (s.requiresApproval !== requiresApproval) {
      v.verdict = 'refused'; v.refusalCode = 'approval_requirement_contradicted';
      v.refusalDetail = `step '${s.stepId}' was proposed with requiresApproval=${s.requiresApproval} `
        + `and the objective's policy '${objective.approval_policy}' makes it ${requiresApproval}`;
      verdicts.push(v); firstRefusal = firstRefusal || v; continue;
    }
    v.gates.approval_requirement = requiresApproval
      ? 'a human approval is required before this step has any external effect'
      : 'not consequential — no approval boundary';

    // ── GATE 6 (per step): THE BUDGET DECISION ALREADY TAKEN ─────────────
    v.gates.budget = budgetDecision.objective
      ? `objective budget $${budgetDecision.objective.budgetUsd}, `
        + `${Math.round(budgetDecision.objective.fraction * 100)}% used`
      : (budgetDecision.budgetException
        ? `unmetered under budget exception ${budgetDecision.budgetException.id}`
        : 'enterprise cap only');

    // Every gate must have answered. A step with a missing gate is not a validated step — this
    // catches a future edit that adds a gate and forgets a branch, which is how a gate stops being
    // consulted without anybody noticing.
    const unanswered = GATES.filter((g) => !(g in v.gates));
    if (unanswered.length) {
      v.verdict = 'refused'; v.refusalCode = 'gate_not_evaluated';
      v.refusalDetail = `${unanswered.join(', ')} did not produce an answer for this step`;
      verdicts.push(v); firstRefusal = firstRefusal || v; continue;
    }

    v.verdict = 'permitted';
    verdicts.push(v);
  }

  const queued = verdicts.filter((v) => v.awaitingCapableWorker);
  if (firstRefusal) {
    return {
      ok: false,
      refused: firstRefusal.refusalCode,
      detail: firstRefusal.refusalDetail,
      verdict: 'refused',
      planId: plan.planId,
      steps: verdicts,
      refusedStepId: firstRefusal.stepId,
      gates: GATES,
    };
  }
  return {
    ok: true,
    verdict: queued.length ? 'validated_with_queued_steps' : 'validated',
    planId: plan.planId,
    steps: verdicts,
    queuedSteps: queued.map((v) => ({ stepId: v.stepId, awaiting: v.awaitingCapableWorker })),
    gates: GATES,
  };
}

/**
 * The execution capabilities the current fleet declares.
 *
 * Enrolled and not revoked only. A revoked worker's capabilities are not the fleet's capabilities,
 * and counting them would have a plan report a hardware step as executable because a machine that
 * has been taken out of service once declared it.
 */
async function workerCapabilities(deps = {}) {
  const query = deps.query || require('../db').query;
  const IDENT = require('../worker/identity-schema');
  const res = await query(
    `SELECT capabilities FROM ${IDENT.TABLES.identities}
      WHERE revoked_at IS NULL AND enrolled_at IS NOT NULL`);
  const set = new Set();
  for (const row of res.rows) for (const c of (row.capabilities || [])) set.add(c);
  return set;
}

/** Any field anywhere in a payload that names a company. */
function findCompanyField(value, path = 'payload') {
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findCompanyField(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const k of Object.keys(value)) {
    if (/^company(_?id)?$/i.test(k) || /^companyId$/.test(k)) return `${path}.${k}`;
    const hit = findCompanyField(value[k], `${path}.${k}`);
    if (hit) return hit;
  }
  return null;
}

// ── PERSIST ─────────────────────────────────────────────────────────────────

/**
 * Store a proposal and its validation verdict, through the kernel accessors.
 *
 * The ORDER is the evidence: the plan and its steps are written as 'proposed' FIRST, then the
 * verdict is written on top. So a refused plan leaves a durable record of what was proposed and
 * why it was refused — and a crash between the two leaves a plan that is visibly unvalidated
 * rather than one that looks approved.
 */
async function persist(ctx, plan, validation, { runId }, deps = {}) {
  assertContext(ctx);
  const created = await scope.createPlan(ctx,
    { id: plan.planId, runId, proposer: plan.proposer, planner: plan.planner }, deps);
  for (const s of plan.steps) await scope.recordPlanStep(ctx, s, deps);

  if (validation) {
    for (const v of (validation.steps || [])) {
      await scope.setStepVerdict(ctx, {
        planId: plan.planId,
        stepId: v.stepId,
        verdict: v.verdict || null,
        refusalCode: v.refusalCode || null,
        refusalDetail: v.refusalDetail || null,
      }, deps);
    }
    await scope.setPlanVerdict(ctx, {
      planId: plan.planId,
      status: validation.ok ? 'validated' : 'refused',
      // A PLAN-LEVEL refusal — budget, an inactive objective, a company-scope failure — returns
      // before any step is judged, so it carries no per-step verdict and, in the first version,
      // no plan verdict either. `office_plans_verdict_paired` refused the row (a verdict and the
      // time it was reached must arrive together), persist threw, and every plan-level refusal
      // came back as `plan_not_recorded` — the right refusal lost behind a bookkeeping error, with
      // the reason discarded. The constraint caught it, which is what it is for.
      verdict: validation.verdict || (validation.ok ? 'validated' : 'refused'),
      refusalCode: validation.ok ? null : (validation.refused || 'refused'),
      refusalDetail: validation.ok ? null : (validation.detail || null),
    }, deps);
  }
  return created;
}

/**
 * Propose and validate in one call — the shape a caller wants, with no way to get the first without
 * the second. A function that returned a proposal alone would be the one a future caller reached
 * for when validation was inconvenient.
 */
async function decompose(ctx, { candidates, proposer = 'deterministic', runId,
  consultedMemoryIds = [], workflow, agent, planId = null } = {}, deps = {}) {
  const proposed = propose(ctx, { candidates, proposer, consultedMemoryIds, planId });
  if (!proposed.ok) return { ok: false, stage: 'propose', ...proposed };

  const plan = { ...proposed.plan, workflow, agent };
  const validation = await validate(ctx, plan, deps);

  // ── A BOOKKEEPING FAILURE MUST NOT REPLACE A SECURITY REFUSAL ────────────
  //
  // Persisted either way, normally: a refusal is evidence, and a refused plan that left no record
  // would make "was this validated?" unanswerable after the fact.
  //
  // But a plan refused because the OBJECTIVE IS NOT THIS COMPANY'S cannot be persisted at all —
  // `office_plans` has a composite foreign key to `objectives (id, company_id)`, which is the
  // point of it. Attempting the write anyway made createPlan throw, and the returned refusal
  // became `plan_not_recorded`: the cross-company finding replaced by a storage error. Measured in
  // check-autonomous-office-cycle-db.js, whose cross-company negative case read as a bug in
  // persistence.
  //
  // So a scope-level refusal skips persistence and keeps its own reason, and any OTHER persistence
  // failure is reported ALONGSIDE the validation verdict rather than instead of it.
  const UNPERSISTABLE = ['objective_not_in_company_scope', 'objective_mismatch'];
  if (!validation.ok && UNPERSISTABLE.includes(validation.refused)) {
    return { ok: false, stage: 'validate', refused: validation.refused, detail: validation.detail,
      plan, validation, persisted: null,
      notRecorded: 'a plan for an objective outside this company cannot be stored — the composite '
        + 'foreign key refuses it, which is the same guarantee that refused the plan' };
  }

  let persisted = null;
  try {
    persisted = await persist(ctx, plan, validation, { runId }, deps);
  } catch (e) {
    return { ok: false,
      stage: validation.ok ? 'persist' : 'validate',
      refused: validation.ok ? 'plan_not_recorded' : validation.refused,
      detail: validation.ok ? e.message : validation.detail,
      recordingError: e.message,
      plan, validation };
  }
  return { ok: validation.ok, stage: validation.ok ? 'validated' : 'validate',
    plan, validation, persisted,
    ...(validation.ok ? {} : { refused: validation.refused, detail: validation.detail }) };
}

module.exports = {
  PLANNER_VERSION, MAX_STEPS, IN_OFFICE, STEP_VOCABULARY, FORBIDDEN_PROPOSAL_FIELDS, GATES, ARG,
  propose, validate, persist, decompose,
  deterministicCandidates, candidatesFromModelText, priorStepsFromMemories,
  STEP_MEMORY_PREFIX,
  digestOf, canonical, workerCapabilities, findCompanyField,
  // Exported so the payload contract can be measured against the real handlers
  // (src/lib/office/step-payload-contract.test.js). Frozen, so a reader cannot alter it.
  STEP_VOCABULARY,
};
