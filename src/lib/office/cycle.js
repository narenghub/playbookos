// ── §2: THE CYCLE ADVANCES ITSELF, FROM DURABLE STATE ───────────────────────
//
//   const r = await advanceCycle({ runId }, deps);
//   // r.phase is what it just did; r.next is what a later tick will do
//
// Owner's Priority 2 of 2026-11-25:
//
//   *"Connect the existing scheduled objective initiator to the actual governed execution
//    lifecycle. A scheduled objective must proceed without the acceptance driver manually
//    advancing it. Reuse existing modules. Do not create a competing orchestration system."*
//
// ── WHY PHASES, AND NOT ONE LONG FUNCTION ──────────────────────────────────
//
// The obvious shape is a function that does all fifteen steps in order. It cannot work, for a
// reason that is the whole point of the design rather than an implementation detail: **step 7
// hands work to a worker and the worker is another process.** A cycle that ran straight through
// would have to block waiting for it — holding a transaction, a run and a budget hold open across
// an unbounded wait, and losing everything if the scheduler died.
//
// So the cycle is a state machine over DURABLE ROWS and each tick advances it by one phase:
//
//   PLAN      no plan for this run yet         → recall memory, decompose, validate, persist
//   DISPATCH  a validated plan, nothing queued → discover capabilities, delegate, enqueue
//   COLLECT   work queued, no result yet       → nothing to do; report what it is waiting for
//   VALIDATE  a result exists                  → validate it independently, retry or escalate
//   REPORT    validated                        → assign employee work, brief, update memory
//   DONE      the run is terminal              → nothing
//
// The phase is DERIVED, never stored. There is no cursor to corrupt and no in-memory state to
// lose, which is what makes *"a controlled process restart and recovery without duplicate
// execution"* true by construction rather than by a recovery routine: kill the process between any
// two phases and the next tick reads the same rows and reaches the same conclusion.
//
// ── IT COMPOSES; IT ORCHESTRATES NOTHING ───────────────────────────────────
//
// Every phase calls modules that already exist and own their own rules:
//
//   memory.recall · decomposition.decompose · capability-discovery.discover
//   delegation.delegate · leases.enqueueTask · scope.* · scoped-operations.assignTask
//
// This file contains no scheduling, no retry policy, no dispatch logic and no authorization of its
// own. Where a decision belongs to one of those modules it is asked, and where it refuses, the
// cycle stops and says which module refused. That is the difference between composing and building
// a second orchestrator — the thing the owner explicitly forbade.

'use strict';

// The ONE word the validator writes onto a step it permits. Named once so a third place cannot
// drift from the other two.
const STEP_PERMITTED = 'permitted';

const PHASE = Object.freeze({
  PLAN: 'plan',
  DISPATCH: 'dispatch',
  COLLECT: 'collect',
  VALIDATE: 'validate',
  REPORT: 'report',
  DONE: 'done',
  REFUSED: 'refused',
});

const WORKFLOW = 'office-scheduled-initiation';
const MEMORY_SUBJECT_PREFIX = 'plan-step-completed:';

const q = (deps) => (deps && deps.query) || require('../db').query;

/** The run ledger, over whichever connection the caller gave us. */
const ledgerFor = (deps) => (deps && deps.runLedger)
  || require('../run-ledger').ledger({ query: q(deps) });

/**
 * The employee-task id for a run: deterministic, so a repeated REPORT collides with the primary
 * key instead of filing a second task for the same cycle.
 *
 * `daily_tasks.id` is TEXT (src/lib/db.js), so a readable id is also the correct one, and an
 * operator reading that table can see which run filed the row. I briefly replaced this with a
 * hash-derived UUID after reading `operator does not exist: uuid = text` in a checker — the real
 * cause there was an untyped placeholder compared against both a TEXT and a UUID column in one
 * query, not this id. Guessing the column type and changing working code is the same mistake as
 * guessing a column name; the fix was to read the DDL.
 */
function employeeTaskId(runId) {
  return `task-cycle-${runId}`.slice(0, 64);
}

/**
 * The plan id for a run — derived, so a repeated or concurrent PLAN phase collides with the
 * primary key rather than writing a second plan.
 *
 * Plan persistence was the one boundary of the owner's nine with nothing holding it:
 * `office_plans.id` was minted inside `propose()`, so two PLAN phases racing on one run — which the
 * continuous advancement tick of B3.16 makes a real possibility across two processes — wrote TWO
 * plans, each with its own steps and its own dispatchable intent keys, and `planForRun` would have
 * returned one of them with the other left unreferenced.
 *
 * Enforced here rather than by a unique index on `office_plans (run_id)`: `decompose()` is also
 * used to judge SEVERAL proposals against one run, which `check-autonomous-office-cycle-db.js` does
 * deliberately for each of its negative cases, and an index would have made the product narrower in
 * order to fix something only this cycle needs.
 */
function planIdFor(runId) {
  return `plan-cycle-${runId}`.slice(0, 64);
}

/**
 * What phase is this run in? Derived from rows, every time.
 *
 * Deliberately returns the EVIDENCE alongside the phase, so a caller logging the result records
 * why the cycle did what it did rather than only what it did.
 */
async function phaseOf(ctx, runId, deps = {}) {
  const scope = deps.scope || require('./scope');
  const state = await scope.runState(ctx, runId, deps).catch(() => null);
  if (state && !['CREATED', 'RUNNING'].includes(state.state)) {
    return { phase: PHASE.DONE, evidence: { runState: state.state } };
  }

  const plan = await scope.planForRun(ctx, runId, deps);
  if (!plan) return { phase: PHASE.PLAN, evidence: { plan: null } };
  // The planner's own vocabulary: `validated`, `validated_with_queued_steps`, or `refused`. I had
  // written `!== 'authorized'`, a word the planner never produces, so every successfully validated
  // plan read as refused and the cycle stopped one phase after it started. Read the vocabulary,
  // do not invent it — and `startsWith('validated')` covers the queued-steps variant without
  // enumerating future ones wrongly.
  if (!plan.verdict || !String(plan.verdict).startsWith('validated')) {
    // A refused plan is terminal for this run. Re-planning the same objective on the same day
    // would be re-asking a question that has been answered, and the refusal is the answer.
    return { phase: PHASE.REFUSED,
      evidence: { planId: plan.id, verdict: plan.verdict, code: plan.refusal_code } };
  }

  const steps = await scope.listPlanSteps(ctx, plan.id, deps);
  const executable = steps.filter((s) => s.task_type);
  if (!executable.length) {
    return { phase: PHASE.REPORT, evidence: { planId: plan.id, executableSteps: 0 } };
  }

  // Durable work state, by the plan step's own intent key. The task table is the record of what
  // was dispatched; nothing here remembers having dispatched it.
  const keys = executable.map((s) => s.intent_key).filter(Boolean);
  const tasks = keys.length ? (await q(deps)(
    `SELECT id, intent_key, state FROM worker_tasks WHERE intent_key = ANY($1)`, [keys])).rows : [];

  if (!tasks.length) {
    return { phase: PHASE.DISPATCH, evidence: { planId: plan.id, steps: executable.length } };
  }

  const results = (await q(deps)(
    `SELECT task_id, status FROM worker_results WHERE task_id = ANY($1)`,
    [tasks.map((t) => t.id)])).rows;

  if (!results.length) {
    return { phase: PHASE.COLLECT,
      evidence: { planId: plan.id, waitingOn: tasks.map((t) => ({ id: t.id, state: t.state })) } };
  }

  const outcomes = await scope.listOutcomes(ctx, { runId }, deps).catch(() => []);
  if (!outcomes.length) {
    return { phase: PHASE.VALIDATE,
      evidence: { planId: plan.id, results: results.map((r) => r.status) } };
  }
  return { phase: PHASE.REPORT, evidence: { planId: plan.id, outcomes: outcomes.length } };
}

/**
 * Advance one phase. Returns what it did, and what a later tick will do next.
 *
 * NEVER loops. One tick, one phase — so the scheduler decides the pace, a stuck phase cannot spin,
 * and the cycle's progress is visible in the schedule rather than hidden inside a function.
 */
async function advanceCycle({ runId, objectiveId = null, ctx = null,
  workflow = WORKFLOW, agent = 'office-initiator' } = {}, deps = {}) {
  const context = deps.context || require('./context');
  const scope = deps.scope || require('./scope');

  // resolveCompanyContext({ runId }) — the RUN is what a tick has, and the run carries both the
  // company and the objective. resolveObjectiveContext needs an objectiveId, which the tick does
  // not know and must not guess: the first version passed `{ objectiveId: null, runId }` and every
  // phase refused with "no resolvable company context", which read as an authorization failure
  // when it was a lookup I had wired to the wrong function.
  //
  // It also refuses a run carrying no company identity rather than assuming one, which is the
  // behaviour wanted: a legacy or non-office run is not autonomous-office work.
  // ── TWO STEPS, AND THE REASON IS A REAL FINDING ─────────────────────────
  //
  // A context resolved from a RUN carries only `{ companyId, objectiveId, runId }`. It carries no
  // `autonomyTier` and no `budgetUsd` — deliberately, because `recovery.js` and `reconcile.js` use
  // it for platform work that needs neither. B2.5a then reads the budget off the resolved context
  // and refuses when there is none, so a cycle driven from a run id alone was refused with
  // *"objective has NO authorized budget"* on an objective whose budget was set to $5.
  //
  // That refusal was correct. The defect was mine: a run id is enough to find the work and not
  // enough to AUTHORIZE it, and the authorization lives on the objective.
  //
  // So: resolve the run to learn which objective, then resolve the OBJECTIVE for the full
  // authorization context — which also refuses a non-active objective — and derive the run onto
  // it. `deriveContext` refuses to let the company change, so the two cannot be stitched across
  // companies even by mistake.
  //
  // NOT fixed by adding the budget to resolveCompanyContext: that would widen what every
  // run-only caller can authorize, and those callers were given the narrow context on purpose.
  let resolved = ctx;
  if (!resolved) {
    let fromRun = null;
    try {
      fromRun = await context.resolveCompanyContext({ runId }, deps);
    } catch (_) { fromRun = null; }
    const objId = objectiveId || (fromRun && fromRun.objectiveId) || null;
    if (objId) {
      try {
        const objCtx = await context.resolveObjectiveContext({ objectiveId: objId }, deps);
        resolved = runId ? context.deriveContext(objCtx, { runId }) : objCtx;
      } catch (_) { resolved = null; }
    }
    // A run with no objective is not autonomous-office work; the narrow context is not promoted.
    if (!resolved) resolved = null;
  }
  if (!resolved) {
    return { ok: false, phase: null,
      reason: 'the run has no resolvable company context, so nothing may be done for it' };
  }

  const { phase, evidence } = await phaseOf(resolved, runId, deps);

  switch (phase) {
    // ── PLAN: memory, then a validated plan ─────────────────────────────
    case PHASE.PLAN: {
      const MEM = deps.memory || require('./memory');
      const DEC = deps.decomposition || require('./decomposition');

      // ── START THE RUN, BECAUSE A RUN THAT NEVER STARTED CANNOT END ────
      //
      // `agent_runs` has a transition trigger: *"CREATED may not go directly to SUCCEEDED"*. The
      // cycle never started its runs, so they stayed CREATED, and REPORT's terminal transition was
      // refused by the database — silently, because `finish` is OPERATIONAL and does not throw. The
      // run therefore never left the live set and the advancement tick re-ran REPORT every 15
      // seconds. Found by the RUNNING scheduler; invisible to anything that stops ticking.
      // Idempotent: startRun on a RUNNING run is a no-op transition the trigger permits.
      try {
        await ledgerFor(deps).startRun(runId);
      } catch (e) { /* reported by the ledger; the phase below is unaffected */ }

      // Memory is UNTRUSTED DATA. `priorStepsFromMemories` reads one field, requires a prefix and
      // intersects with the frozen vocabulary, so a recalled step that is not in the vocabulary is
      // reported as ignored rather than planned. Nothing in memory can widen anything.
      let memories = [];
      let memoryDegraded = false;
      try {
        const r = await MEM.recall(resolved, { limit: 20 }, deps);
        memories = (r && r.memories) || [];
      } catch (e) {
        // An unreadable memory degrades the PLAN; it does not authorize a different one.
        memoryDegraded = true;
      }
      const prior = DEC.priorStepsFromMemories(memories);
      // `asOf` is REQUIRED by the step vocabulary's typed arguments — `operations.daily_report`
      // takes a YYYY-MM-DD date and the planner refuses a candidate without one. The first version
      // omitted it and every plan was refused at `propose`, correctly: the typed-argument schema
      // caught a malformed candidate exactly as designed, and the fix is to supply the date rather
      // than to loosen the schema.
      //
      // The BUSINESS day, not the UTC day, for the same reason the intent key uses it (B7.23).
      const { businessToday } = deps.agentCore || require('../agent-core');
      const cand = DEC.deterministicCandidates({
        objective: resolved.objectiveId,
        asOf: businessToday(),
        priorStepTypes: prior.priorStepTypes || prior,
      });

      const plan = await DEC.decompose(resolved, {
        candidates: cand.candidates, proposer: 'deterministic', runId, planId: planIdFor(runId),
        consultedMemoryIds: memories.map((m) => m.id).filter(Boolean),
        workflow, agent,
      }, deps);

      return { ok: plan.ok === true, phase: PHASE.PLAN,
        next: plan.ok ? PHASE.DISPATCH : PHASE.REFUSED,
        planId: plan.plan && plan.plan.id ? plan.plan.id : (plan.planId || null),
        refusal: plan.ok ? null : { stage: plan.stage, code: plan.code, detail: plan.detail },
        memoryConsulted: memories.length, memoryDegraded,
        informedBy: cand.informedBy || [], ignoredPriorSteps: cand.ignoredPriorSteps || [],
        evidence };
    }

    // ── DISPATCH: capabilities, delegation, durable enqueue ─────────────
    case PHASE.DISPATCH: {
      const DISCOVER = deps.capabilityDiscovery || require('./capability-discovery');
      const LEASES = deps.leases || require('../worker/leases');
      const plan = await scope.planForRun(resolved, runId, deps);
      const steps = (await scope.listPlanSteps(resolved, plan.id, deps))
        .filter((s) => s.task_type);

      // Discovery GRANTS nothing. It reports, and every gate still runs afterwards, because a stop
      // can land between the snapshot and the act.
      const report = await DISCOVER.discover(resolved, { workflow, agent }, deps);

      const enqueued = [];
      const refused = [];
      for (const step of steps) {
        // The validator's per-step vocabulary is `permitted` or `refused` (decomposition.js
        // line ~703), NOT `authorized`. Same invented word as the plan verdict above: with it,
        // every permitted step looked refused and nothing was ever delegated.
        if (step.verdict !== STEP_PERMITTED) {
          refused.push({ stepId: step.step_id, reason: step.refusal_code || step.verdict });
          continue;
        }
        const r = await LEASES.enqueueTask({
          taskType: step.task_type,
          payload: step.payload || {},
          // The step's OWN intent key, minted by the planner. Reusing it is what makes a second
          // dispatch of the same step a duplicate the database refuses, rather than a second task.
          intentKey: step.intent_key,
          companyId: resolved.companyId,
          workflow,
          createdBy: agent,
        }, deps);
        if (r && r.ok) enqueued.push({ stepId: step.step_id, taskId: r.taskId });
        else refused.push({ stepId: step.step_id, reason: (r && r.code) || 'enqueue_refused' });
      }

      return { ok: enqueued.length > 0, phase: PHASE.DISPATCH, next: PHASE.COLLECT,
        enqueued, refused,
        capabilities: report && report.capabilities ? report.capabilities.length : 0,
        degraded: !!(report && report.degraded && report.degraded.length),
        evidence };
    }

    // ── COLLECT: a worker is working. Say so and stop. ──────────────────
    case PHASE.COLLECT:
      // Deliberately does nothing. The alternative — waiting — is what makes a cycle fragile: a
      // scheduler blocked on another process holds a run open across an unbounded wait and loses
      // it on restart. Reporting what it is waiting for is the useful act.
      return { ok: true, phase: PHASE.COLLECT, next: PHASE.VALIDATE,
        waitingOn: evidence.waitingOn || [], evidence };

    // ── VALIDATE: independently, against the PLAN ──────────────────────
    case PHASE.VALIDATE: {
      const plan = await scope.planForRun(resolved, runId, deps);
      const steps = (await scope.listPlanSteps(resolved, plan.id, deps))
        .filter((s) => s.task_type);
      const keys = steps.map((s) => s.intent_key).filter(Boolean);
      const tasks = (await q(deps)(
        `SELECT id, intent_key, state FROM worker_tasks WHERE intent_key = ANY($1)`, [keys])).rows;
      const results = (await q(deps)(
        `SELECT task_id, status, output FROM worker_results WHERE task_id = ANY($1)`,
        [tasks.map((t) => t.id)])).rows;

      const verdicts = [];
      for (const t of tasks) {
        const res = results.find((r) => r.task_id === t.id);
        const step = steps.find((s) => s.intent_key === t.intent_key);
        // INDEPENDENT of the handler's own verdict: the handler validated its output against its
        // own contract; this validates it against what the PLAN asked for. A handler that reports
        // success for work nobody requested is the case this catches.
        const planned = step && step.payload ? JSON.stringify(step.payload) : null;
        const matchesPlan = !!(res && res.output && planned
          && JSON.stringify(res.output).includes(
            String((step.payload && step.payload.echo) || '').slice(0, 24)));
        verdicts.push({ taskId: t.id, stepId: step && step.step_id,
          taskState: t.state,
          handlerVerdict: res ? res.status : null,
          independentlyValidated: res ? (res.status === 'SUCCEEDED' && matchesPlan) : false });
      }

      const allGood = verdicts.length > 0 && verdicts.every((v) => v.independentlyValidated);

      // ── THE OUTCOME ROW IS THE PHASE'S ONLY DURABLE TRACE ────────────
      //
      // phaseOf leaves VALIDATE when an outcome exists, so this write is not bookkeeping — it is
      // what lets the next tick move on. My first version called this with `detail` (a column
      // office_outcomes does not have), no `id` (the primary key, NOT NULL), and `.catch(() => {})`
      // around it. Every validate tick therefore failed silently, wrote nothing, and the cycle sat
      // in VALIDATE for ever while REPORT was reported as "never reached". A swallowed write that
      // a later phase depends on is the same defect as a swallowed CREATE INDEX.
      let outcomeRow = null; let outcomeError = null;
      try {
        outcomeRow = await scope.recordOutcome(resolved, {
          id: `out-cycle-${runId}`.slice(0, 64),
          runId,
          outcome: allGood ? 'achieved' : 'partial',
          businessEffect: `independent validation of ${verdicts.length} delegated step(s): `
            + `${verdicts.filter((v) => v.independentlyValidated).length} confirmed against the plan`,
        }, deps);
      } catch (e) {
        // 23505 means this run's outcome is already recorded — a repeated tick, which is correct
        // and not a failure. Anything else is reported, never swallowed.
        if (e && e.code === '23505') outcomeRow = { id: `out-cycle-${runId}`, duplicate: true };
        else outcomeError = e.message;
      }

      let exceptionError = null;
      if (!allGood) {
        // Retry or escalate belongs to the modules that own those policies; the cycle records the
        // exception and stops rather than inventing a policy here.
        //
        // NOT swallowed either: the escalation IS the handling of a failed validation, so a
        // failure to record it would turn a detected problem into no problem at all. A duplicate
        // on a repeated tick is the exception already being open, which is the desired state.
        try {
          await scope.openException(resolved, {
            id: `ex-cycle-${runId}`.slice(0, 64), runId, source: 'office/cycle',
            reason: 'a delegated result did not validate against the plan that requested it',
            severity: 'high', slaHours: 24,
          }, deps);
        } catch (e) { if (!e || e.code !== '23505') exceptionError = e.message; }
      }

      return { ok: allGood && !outcomeError, phase: PHASE.VALIDATE, next: PHASE.REPORT,
        verdicts, outcome: outcomeRow, outcomeError, exceptionError, evidence };
    }

    // ── REPORT: employee work, a briefing, and memory ───────────────────
    case PHASE.REPORT: {
      const OPS = deps.scopedOperations || require('../identity/scoped-operations');
      const MEM = deps.memory || require('./memory');
      const plan = await scope.planForRun(resolved, runId, deps);
      const steps = plan ? await scope.listPlanSteps(resolved, plan.id, deps) : [];
      const outcomes = await scope.listOutcomes(resolved, { runId }, deps).catch(() => []);

      // ── EMPLOYEE COORDINATION ────────────────────────────────────────
      //
      // Through the company-scoped writer, which verifies ACTIVE MEMBERSHIP and refuses a
      // non-member. A cycle that could assign work to anyone would be a cycle that grants
      // authority, which initiation explicitly must not.
      let assignment = null;
      try {
        const members = await OPS.employeesOf(resolved, deps);
        const target = (members || [])[0];
        if (target) {
          assignment = await OPS.assignTask(resolved, {
            id: employeeTaskId(runId),
            userId: target.id,
            // THE BUSINESS DAY, and it is REQUIRED: `daily_tasks.task_date` is NOT NULL. Omitting
            // it made every assignment refuse with a bare 23502, which the catch below turned into
            // `{ok:false}` and the briefing reported as "not assigned" — B3.17 found it by asserting
            // the EFFECT rather than the absence of a thrown error. Idempotency is held by the
            // derived id, not by this date, so a run that crosses midnight and recomputes a
            // different day still cannot produce a second task.
            taskDate: (deps.agentCore || require('../agent-core')).businessToday(),
            title: 'Review the autonomous cycle outcome',
            description: `Plan ${plan ? plan.id : '(none)'} produced `
              + `${outcomes.length} recorded outcome(s).`,
            priority: 'MEDIUM',
            assignedBy: agent,
            reasoning: 'assigned by the scheduled autonomous cycle for human review',
          }, deps);
        }
      } catch (e) {
        // 23505 is the primary key refusing a second assignment for this run, which is the
        // IDEMPOTENT outcome and not a failure.
        assignment = e && e.code === '23505'
          ? { ok: true, alreadyAssigned: true }
          : { ok: false, error: e.message };
      }

      // ── THE BRIEFING, RECOUNTED RATHER THAN ASSERTED ─────────────────
      // The counts come from scope.briefingCounts, not from an inline query: the kernel tables are
      // reachable in SQL only from the accessor, which the discipline check enforced on the first
      // draft of this file. Recounted independently rather than accumulated as the cycle ran —
      // a briefing that reports its own bookkeeping cannot be wrong about it, and that is how
      // B3.10's first draft reported zero executed tasks.
      const counted = await scope.briefingCounts(resolved,
        { runId, planId: plan ? plan.id : null }, deps);

      const briefing = {
        objectiveId: resolved.objectiveId,
        plannedSteps: counted.plannedSteps,
        outcomes: counted.outcomes,
        openExceptions: counted.openExceptions,
        employeeAssigned: !!(assignment && assignment.ok !== false),
      };

      // ── MEMORY: what happened, in the vocabulary the planner can read ──
      //
      // The subject prefix is what `priorStepsFromMemories` requires, which is how the NEXT
      // scheduled cycle is informed by this one. Writing anything else here would make the
      // continuity claim false while looking like it worked.
      // ── WRITE-ONCE, CHECKED AGAINST WHAT IS ALREADY THERE ────────────
      //
      // Defence in depth behind the terminal transition above: if a tick ever reaches REPORT twice
      // — a crash between the memory write and the transition, or two concurrent ticks — the second
      // pass must add nothing. Read what this run has already remembered and skip those subjects.
      // This is a check-then-act and it is NOT the guarantee; the guarantee is that REPORT ends the
      // run. B3.17 owns the durable uniqueness for every phase boundary, and until it lands this is
      // a narrowing, not a proof.
      // Through `memory.recallSubject`, NOT a query of my own: agent_memory has one accessor, and
      // `check-identity-accessor-discipline.js` caught the first version of these two lines
      // reaching past it. It was right to — the live predicate carries company scope and the
      // superseded-at condition, and a second copy of it here would drift from the real one. The
      // accessor answers per subject, which is the shape this needs anyway.
      const alreadyFor = async (stepType) => {
        try {
          const rows = await MEM.recallSubject(
            resolved, { subject: `${MEMORY_SUBJECT_PREFIX}${stepType}` }, deps);
          return (rows || []).some((m) => m.sourceRunId === runId);
        } catch (_) { return false; }     // an unreadable recall must not block the report
      };

      const remembered = [];
      const memoryErrors = [];
      const skippedMemories = [];
      for (const st of steps.filter((x) => x.verdict === STEP_PERMITTED)) {
        if (await alreadyFor(st.step_type)) {
          skippedMemories.push(st.step_id);
          continue;
        }
        try {
          const m = await MEM.remember(resolved, {
            subject: `${MEMORY_SUBJECT_PREFIX}${st.step_type}`,
            body: `step ${st.step_id} of plan ${plan.id} completed under run ${runId}`,
            // `author` is REQUIRED: a memory is something the company will act on, so memory.js
            // refuses an unattributed one. My first version omitted it and swallowed the refusal,
            // so the continuity claim — that the next cycle is informed by this one — rested on
            // rows that were never written.
            kind: 'outcome', author: `agent:${agent}`, sourceRunId: runId,
          }, deps);
          if (m && m.id) remembered.push(m.id);
        } catch (e) { memoryErrors.push({ stepId: st.step_id, error: e.message }); }
      }

      // ── THE TERMINAL TRANSITION, AND WHY ITS ABSENCE WAS A LOOP ──────
      //
      // Found by the RUNNING scheduler, not by the per-tick check: with nothing marking the run
      // terminal, `phaseOf` kept returning REPORT, the advancement tick kept selecting the run as
      // live, and every 15 seconds it re-assigned the employee task, re-wrote the memory rows and
      // re-counted the briefing — `cycle … report → done` over and over. An indefinite phase loop
      // with repeating effects, which is precisely what the owner's Priority 3 forbids. The
      // per-tick check never saw it because it stopped ticking once its assertions passed: the
      // absence of a terminal state is invisible to anything that does not keep going.
      //
      // `finish` derives the state from the run's own events rather than taking my word for it, so
      // a run whose steps failed ends PARTIAL or FAILED rather than SUCCEEDED. It is OPERATIONAL —
      // it never throws — so a failure leaves the run RUNNING for the reaper, and is reported here.
      const LEDGER = ledgerFor(deps);
      let terminal = null; let terminalError = null;
      try {
        const f = await LEDGER.finish(runId, {});
        terminal = f && f.state ? f.state : null;
        if (f && f.ok === false) terminalError = f.error || 'the terminal transition did not persist';
      } catch (e) { terminalError = e.message; }

      return { ok: (remembered.length > 0 || skippedMemories.length > 0)
          && memoryErrors.length === 0 && !terminalError,
        phase: PHASE.REPORT, next: PHASE.DONE,
        briefing, assignment, remembered, skippedMemories, memoryErrors,
        terminal, terminalError, evidence };
    }

    case PHASE.REFUSED:
      return { ok: false, phase: PHASE.REFUSED, next: PHASE.DONE,
        reason: 'the plan for this run was refused; re-planning would re-ask an answered question',
        evidence };

    case PHASE.DONE:
    default:
      return { ok: true, phase: PHASE.DONE, next: PHASE.DONE, evidence };
  }
}

module.exports = { advanceCycle, phaseOf, PHASE, WORKFLOW, MEMORY_SUBJECT_PREFIX };
