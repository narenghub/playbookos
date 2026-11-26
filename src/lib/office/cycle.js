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
  // B3.18: the run's own state could not be read. Distinct from DONE and from PLAN, because
  // treating it as either is a lie — see the note in phaseOf.
  UNKNOWN: 'unknown',
});

const WORKFLOW = 'office-scheduled-initiation';
const MEMORY_SUBJECT_PREFIX = 'plan-step-completed:';

// ── THE BOUND ON A REFUSED OR WAITING RUN (B3.18) ────────────────────────────
//
// Owner's Priority 3: *"no silent catch blocks, indefinite phase loops or falsely completed
// objectives"*, and every failure must produce *"a truthful durable state, bounded recovery or a
// visible escalation"*.
//
// A run whose authorization has been withdrawn, or whose dispatched work no worker ever claims,
// would otherwise be re-selected and re-refused by every tick for ever. So each of those refusals
// is given a GRACE WINDOW, measured from the run's own `created_at` — which is already durable, and
// needs no counter of my own that a restart could lose. Inside the window the tick simply declines
// to act, because the condition may well clear (an objective un-paused, a worker coming online) and
// that is the bounded recovery. Past it, the refusal becomes a visible escalation and, where the
// condition cannot clear by itself, a terminal FAILED run.
//
// An operator-activated STOP is deliberately NOT bounded this way: see the guard refusal handling.
/**
 * The grace window in force for this call.
 *
 * `deps.graceMinutes` exists so a check can reach the escalation without waiting an hour of real
 * time — `agent_runs.created_at` is immutable (the transition guard refuses to let it change), so a
 * run cannot be aged by an UPDATE and the window is the only adjustable end of the comparison.
 *
 * It is a seam, and it is a fail-SAFE one in a way the `--business-day` seam of B3.20 is not:
 * shortening this window makes the cycle escalate and stop SOONER. It cannot authorize a phase, it
 * cannot extend the window past the configured value's purpose, and the worst a caller can do with
 * it is raise an alarm early. That is why it needs no production refusal of its own, and the
 * production path passes none: the cron calls `advanceCycle` with `{}`.
 */
const graceOf = (deps) => (deps && typeof deps.graceMinutes === 'number'
  ? Math.max(0, deps.graceMinutes)
  : PHASE_GRACE_MINUTES);

const PHASE_GRACE_MINUTES = (() => {
  const raw = Number.parseInt(process.env.OFFICE_PHASE_GRACE_MINUTES || '60', 10);
  if (!Number.isFinite(raw)) return 60;
  return Math.min(1440, Math.max(1, raw));
})();

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
 * Canonical JSON: keys sorted at every depth, so two structurally equal values compare equal
 * whatever order Postgres returned their jsonb keys in.
 */
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

/**
 * Did the WORKER do what the PLAN asked? One criterion per task type, declared.
 *
 * ── THE DEFECT THIS REPLACES, WHICH IS THE WORST OF ITS KIND SO FAR ─────────
 *
 * The previous version read:
 *
 *     JSON.stringify(res.output).includes(String((step.payload && step.payload.echo) || '')
 *       .slice(0, 24))
 *
 * No step this cycle has ever minted carries an `echo` field — the one executable step is
 * `operations.liveness_checkpoint`, whose payload is `{hello:'office-checkpoint'}`. So the needle
 * was `String(undefined || '')`, the empty string, and `''.includes` — rather,
 * `anything.includes('')` — is ALWAYS TRUE. Every result that the handler called SUCCEEDED passed
 * "independent validation", including output with nothing whatever to do with the plan, which
 * B3.18's second negative path submitted on purpose and watched sail through.
 *
 * Three claims in this repository rested on that line: B3.10's *"independent result validation"*,
 * B3.13's *"a LATER process validating the result independently of the handler that produced it"*,
 * and B3.16's *"validated independently on a LATER tick"*. The sequencing in all three was real —
 * a different process did read the result afterwards — and the COMPARISON was vacuous. An empty
 * needle is the string-shaped form of `<=` being satisfied by zero.
 *
 * ── AND WHY AN UNDECLARED TYPE IS NOT VALIDATED ─────────────────────────────
 *
 * A type with no criterion here returns `no_independent_criterion`, which makes the outcome
 * `partial` and opens an exception. That is deliberately inconvenient: the alternative is a default
 * of "true", which is exactly how the vacuous check survived. A new executable step type must
 * therefore say what success looks like from the PLAN's side, not only from its handler's.
 */
function independentCriterion(step, output) {
  const taskType = step && step.task_type;
  const planned = (step && step.payload) || {};
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { validated: false, reason: 'the stored output is not an object' };
  }

  if (taskType === 'synthetic.echo') {
    // The handler returns `{echoed: payload, steps}`, so the plan can check the one thing it
    // actually asked for: that the payload which came back is the payload it minted.
    const criterion = 'output.echoed equals the payload the plan minted';
    if (!Object.prototype.hasOwnProperty.call(output, 'echoed')) {
      return { validated: false, criterion, reason: 'the output carries no `echoed`' };
    }
    if (canonical(output.echoed) !== canonical(planned)) {
      return { validated: false, criterion,
        reason: 'the echoed payload is not the payload the plan minted' };
    }
    return { validated: true, criterion };
  }

  return { validated: false,
    reason: `no_independent_criterion: ${taskType || 'an untyped step'} declares no way for the `
      + 'plan to check its result, so this cycle cannot claim to have validated it independently' };
}

/** How old is this run, in minutes? Null when the run is not visible to this context. */
async function runAgeMinutesOf(ctx, runId, deps = {}) {
  const scope = deps.scope || require('./scope');
  try {
    const st = await scope.runState(ctx, runId, deps);
    if (!st || !st.created_at) return null;
    return (Date.now() - new Date(st.created_at).getTime()) / 60000;
  } catch (_) { return null; }
}

/**
 * A phase boundary refused by the guard. Decides what the refusal MEANS for the run.
 *
 * ── THREE KINDS OF REFUSAL, AND THEY MUST NOT BE TREATED ALIKE ──────────────
 *
 * **An operator STOP is not an incident.** It is a deliberate, reversible halt whose durable state
 * is the stop row itself, and B3.16 demonstrated a stopped cycle RESUMING with no restart once the
 * stop was lifted. So a STOP refuses the phase and does nothing else: no escalation (an exception
 * queue that fills up when an operator uses the kill switch is an alarm that trains people to
 * ignore it) and above all no terminal state, because ending the run would destroy exactly the work
 * the operator intends to resume. A stop may last for days and that is legitimate.
 *
 * **A withdrawn authorization can clear, but usually will not.** A paused objective may be resumed;
 * a suspended company may be reinstated. Inside the grace window the tick declines and says why —
 * that is the bounded recovery. Past it the run is escalated AND ended FAILED, because a run nobody
 * is going to re-authorize must not sit in the live set for ever, and it must certainly not end up
 * SUCCEEDED.
 *
 * **An unreadable answer is transient until it isn't.** Same treatment as the above, deliberately:
 * refuse inside the window, escalate and fail past it. An hour of unreadable company status is not
 * a blip, and \"I could not tell\" must never become \"carry on\".
 *
 * The run is ended with an EXPLICIT state. `finish` would otherwise derive one from the run's
 * events, and a run that had succeeded at several phases before its authorization was withdrawn
 * would derive SUCCEEDED — a falsely completed objective, which is the thing the owner's Priority 3
 * names first.
 */
async function handleGuardRefusal({ guard, runId, resolved, phase, evidence, agent, ageMinutes },
  deps = {}) {
  const scope = deps.scope || require('./scope');
  const GUARD = deps.phaseGuard || require('./phase-guard');

  const base = {
    ok: false, phase: phase || PHASE.UNKNOWN, next: phase || PHASE.UNKNOWN,
    refusal: { code: guard.code, detail: guard.detail },
    revalidated: false, evidence,
  };

  if (guard.code === GUARD.CODES.STOPPED) {
    return { ...base, next: phase, stopped: true, stop: guard.stop || null,
      // An unknown kill state is NOT an operator stop; it is an outage that refuses, and it is
      // reported as such so a reader can tell the two apart.
      killStateUnknown: !!guard.unknown };
  }

  const grace = graceOf(deps);
  const past = typeof ageMinutes === 'number' && ageMinutes > grace;
  if (!past) {
    return { ...base, withinGrace: true, graceMinutes: grace,
      ageMinutes: ageMinutes === null ? null : Math.round(ageMinutes) };
  }

  // ── PAST THE WINDOW: ESCALATE VISIBLY, THEN END IT TRUTHFULLY ─────────────
  let escalationError = null;
  try {
    await scope.openException(resolved, {
      // Derived, so the escalation is ONE row however many ticks pass through here — the same
      // idempotency B3.17 measured for every other effect of this cycle.
      id: `ex-guard-${runId}`.slice(0, 64),
      runId,
      source: 'office/cycle:phase-guard',
      reason: `authorization could not be revalidated at the ${phase || 'context'} boundary `
        + `(${guard.code}): ${guard.detail}`,
      severity: 'high',
      slaHours: 24,
    }, deps);
  } catch (e) {
    if (!e || e.code !== '23505') escalationError = e.message;
  }

  let terminal = null; let terminalError = null;
  try {
    const f = await ledgerFor(deps).finish(runId, {
      state: 'FAILED',
      error: `${guard.code}: ${guard.detail}`,
    });
    terminal = f && f.state ? f.state : null;
    if (f && f.ok === false) terminalError = f.error || 'the terminal transition did not persist';
  } catch (e) { terminalError = e.message; }

  return { ...base, next: PHASE.DONE, escalated: !escalationError, escalationError,
    terminal, terminalError, graceMinutes: grace,
    ageMinutes: Math.round(ageMinutes) };
}

/**
 * What phase is this run in? Derived from rows, every time.
 *
 * Deliberately returns the EVIDENCE alongside the phase, so a caller logging the result records
 * why the cycle did what it did rather than only what it did.
 */
async function phaseOf(ctx, runId, deps = {}) {
  const scope = deps.scope || require('./scope');

  // ── AN UNREADABLE STATE IS NOT A LIVE RUN ─────────────────────────────────
  //
  // This was `.catch(() => null)`, and `null` then meant the same thing as "no row yet": the cycle
  // carried on as though the run were CREATED. So a transient database failure on THIS read — the
  // one read that decides whether the run is already finished — made a TERMINAL run look live, and
  // the tick would re-run REPORT against a completed objective: re-assigning the employee task,
  // re-writing memory, re-counting the briefing. An error standing in for a value, in the place
  // where the value is the stop condition. B3.18's tenth negative path.
  //
  // Unreadable is now its own phase. The caller does nothing and reports why; the next tick asks
  // again, and a database that stays unreadable is the recovery reaper's business (`staleRuns`),
  // not something this function may paper over.
  let state;
  try {
    state = await scope.runState(ctx, runId, deps);
  } catch (e) {
    return { phase: PHASE.UNKNOWN, evidence: { runStateUnreadable: e.message } };
  }
  if (state && !['CREATED', 'RUNNING'].includes(state.state)) {
    return { phase: PHASE.DONE, evidence: { runState: state.state } };
  }
  // Carried out of here so the phase handlers can bound themselves against the run's own age
  // without a second read. Absent only for a run this context cannot see, which the context guard
  // below refuses anyway.
  const runAgeMinutes = state && state.created_at
    ? (Date.now() - new Date(state.created_at).getTime()) / 60000
    : null;

  // Every phase below is reported WITH the run's age, so a handler can bound itself and a log
  // line says how long the run has been in this condition.
  const out = (phase, evidence) => ({ phase, evidence: { ...evidence, runAgeMinutes } });

  const plan = await scope.planForRun(ctx, runId, deps);
  if (!plan) return out(PHASE.PLAN, { plan: null });
  // The planner's own vocabulary: `validated`, `validated_with_queued_steps`, or `refused`. I had
  // written `!== 'authorized'`, a word the planner never produces, so every successfully validated
  // plan read as refused and the cycle stopped one phase after it started. Read the vocabulary,
  // do not invent it — and `startsWith('validated')` covers the queued-steps variant without
  // enumerating future ones wrongly.
  if (!plan.verdict || !String(plan.verdict).startsWith('validated')) {
    // A refused plan is terminal for this run. Re-planning the same objective on the same day
    // would be re-asking a question that has been answered, and the refusal is the answer.
    return out(PHASE.REFUSED,
      { planId: plan.id, verdict: plan.verdict, code: plan.refusal_code });
  }

  const steps = await scope.listPlanSteps(ctx, plan.id, deps);
  const executable = steps.filter((s) => s.task_type);
  if (!executable.length) {
    return out(PHASE.REPORT, { planId: plan.id, executableSteps: 0 });
  }

  // Durable work state, by the plan step's own intent key. The task table is the record of what
  // was dispatched; nothing here remembers having dispatched it.
  const keys = executable.map((s) => s.intent_key).filter(Boolean);
  const tasks = keys.length ? (await q(deps)(
    `SELECT id, intent_key, state FROM worker_tasks WHERE intent_key = ANY($1)`, [keys])).rows : [];

  if (!tasks.length) {
    return out(PHASE.DISPATCH, { planId: plan.id, steps: executable.length });
  }

  const results = (await q(deps)(
    `SELECT task_id, status FROM worker_results WHERE task_id = ANY($1)`,
    [tasks.map((t) => t.id)])).rows;

  if (!results.length) {
    return out(PHASE.COLLECT,
      { planId: plan.id, waitingOn: tasks.map((t) => ({ id: t.id, state: t.state })) });
  }

  const outcomes = await scope.listOutcomes(ctx, { runId }, deps).catch(() => []);
  if (!outcomes.length) {
    return out(PHASE.VALIDATE, { planId: plan.id, results: results.map((r) => r.status) });
  }
  return out(PHASE.REPORT, { planId: plan.id, outcomes: outcomes.length });
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
  const GUARD = deps.phaseGuard || require('./phase-guard');

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
  // ── THE NARROW CONTEXT, KEPT ONLY TO RECORD A REFUSAL (B3.18) ─────────────
  //
  // `resolveObjectiveContext` refuses an objective that is not active — correctly — so a run whose
  // objective is PAUSED mid-execution could not resolve a context at all, and this function
  // returned `{ok:false, reason:'no resolvable company context'}`: nothing durable written, the run
  // still in the live set, and the scheduler re-refusing it every tick for ever. The refusal was
  // right and its handling was an indefinite phase loop.
  //
  // So the run-scoped context is kept when the objective context cannot be built. It carries the
  // company and the objective and NOTHING that authorizes anything — no tier, no budget — and it is
  // used for exactly one thing: letting the guard name the reason and write the durable record.
  // It is never passed to a phase handler, which is why `resolved` stays null.
  let diagnostic = null;
  if (!resolved) {
    let fromRun = null;
    try {
      fromRun = await context.resolveCompanyContext({ runId }, deps);
    } catch (_) { fromRun = null; }
    diagnostic = fromRun;
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
    // With a company in hand the condition is REPORTABLE, and the guard is the one place that
    // decides what it is: a paused objective, a withdrawn company authorization, or a read that
    // failed. Without one, there is nothing to say and nobody to say it to.
    if (diagnostic && diagnostic.companyId) {
      const guard = await GUARD.revalidate(diagnostic, { workflow, agent, phase: null }, deps);
      const age = await runAgeMinutesOf(diagnostic, runId, deps);
      return handleGuardRefusal({
        guard: guard.ok
          // The guard found nothing wrong, so the objective context failed for a reason it does not
          // cover. Reported as unreadable rather than as an authorization withdrawal, because
          // claiming the latter would be inventing a cause.
          ? { ok: false, code: 'objective_context_unbuildable',
            detail: 'the objective context could not be built although company, objective status '
              + 'and kill state all read as permitting it' }
          : guard,
        runId, resolved: diagnostic, phase: null, evidence: { runAgeMinutes: age }, agent,
        ageMinutes: age,
      }, deps);
    }
    return { ok: false, phase: null,
      reason: 'the run has no resolvable company context, so nothing may be done for it' };
  }

  const { phase, evidence } = await phaseOf(resolved, runId, deps);

  // ── UNREADABLE: DO NOTHING, TRUTHFULLY ──────────────────────────────────
  // Not DONE (which would abandon a live run) and not PLAN (which would re-plan a finished one).
  if (phase === PHASE.UNKNOWN) {
    return { ok: false, phase: PHASE.UNKNOWN, next: PHASE.UNKNOWN,
      reason: "the run's own state could not be read, so no phase may be chosen for it",
      evidence };
  }

  // ── REVALIDATE AUTHORIZATION AT THIS BOUNDARY (B3.18) ───────────────────
  //
  // Owner's Priority 3: *"Revalidate authorization at sensitive phase boundaries."* Asked at EVERY
  // non-terminal phase rather than at the ones that look consequential, because "which phases are
  // sensitive" is the sort of judgement that goes stale the moment a phase grows a new effect —
  // and because the cost is three reads against the run the tick has already fetched.
  //
  // A run already DONE or REFUSED is not asked: there is nothing left to authorize, and asking
  // would turn a withdrawn authorization into an escalation about work that had already stopped.
  if (phase !== PHASE.DONE && phase !== PHASE.REFUSED) {
    const guard = await GUARD.revalidate(resolved, { workflow, agent, phase }, deps);
    if (!guard.ok) {
      return handleGuardRefusal({
        guard, runId, resolved, phase, evidence, agent,
        ageMinutes: evidence ? evidence.runAgeMinutes : null,
      }, deps);
    }
  }

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
    case PHASE.COLLECT: {
      // Deliberately does nothing. The alternative — waiting — is what makes a cycle fragile: a
      // scheduler blocked on another process holds a run open across an unbounded wait and loses
      // it on restart. Reporting what it is waiting for is the useful act.
      //
      // ── BUT A WAIT MUST BE BOUNDED (B3.18, negative path 1) ───────────
      //
      // \"Worker unavailable\" is not an error anywhere: DISPATCH enqueues successfully, the task
      // sits PENDING because no worker holds the capability or none is online, and COLLECT reports
      // `waitingOn` — politely, for ever. Nothing was wrong with any single tick, and a run could
      // wait for weeks with no record anybody would ever read. That is the \"indefinite phase loop\"
      // in its quietest form: no duplication, no failure, no progress.
      //
      // Past the grace window the wait becomes ONE visible escalation. The run is deliberately NOT
      // ended: the task is durably enqueued and a worker coming online later will still execute it,
      // so killing the run would discard real work. The exception is the record a human reads, and
      // a run that stops reporting entirely is already the recovery reaper's business.
      const waitingTooLong = typeof evidence.runAgeMinutes === 'number'
        && evidence.runAgeMinutes > graceOf(deps);
      let waitEscalationError = null;
      if (waitingTooLong) {
        try {
          await scope.openException(resolved, {
            id: `ex-wait-${runId}`.slice(0, 64), runId, source: 'office/cycle:collect',
            reason: `delegated work has been waiting ${Math.round(evidence.runAgeMinutes)} minutes `
              + `with no result: ${(evidence.waitingOn || []).length} task(s) still unclaimed or `
              + 'unfinished — no worker may be available for the capability they require',
            severity: 'high', slaHours: 24,
          }, deps);
        } catch (e) { if (!e || e.code !== '23505') waitEscalationError = e.message; }
      }
      return { ok: true, phase: PHASE.COLLECT, next: PHASE.VALIDATE,
        waitingOn: evidence.waitingOn || [], revalidated: true,
        waitingTooLong, escalated: waitingTooLong && !waitEscalationError, waitEscalationError,
        graceMinutes: graceOf(deps), evidence };
    }

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
        const check = res && res.status === 'SUCCEEDED'
          ? independentCriterion(step, res.output)
          : { validated: false, reason: res ? `handler reported ${res.status}` : 'no result' };
        verdicts.push({ taskId: t.id, stepId: step && step.step_id,
          taskState: t.state,
          handlerVerdict: res ? res.status : null,
          independentlyValidated: check.validated,
          criterion: check.criterion || null,
          reason: check.validated ? null : check.reason });
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
      // ── AND A FAILED REPORT MUST NOT COMPLETE THE OBJECTIVE (B3.18) ──
      //
      // Negative path 10: *"reporting or memory persistence failure"*. `finish(runId, {})` derives
      // the terminal state from the run's EVENTS — and a memory write that fails is not an event,
      // so a run whose continuity record never persisted, or whose employee task was refused, ended
      // **SUCCEEDED**. A falsely completed objective, which is the first thing the owner's Priority
      // 3 forbids, and the next cycle would then plan as though this one had remembered nothing
      // while the run said it had succeeded.
      //
      // So the persistence failures are collected FIRST and passed to `finish` as an error, which
      // makes the derived state PARTIAL (or FAILED when nothing succeeded) — never SUCCEEDED — and
      // one escalation is opened so a human sees it. A refusal to assign (`ok === false`) counts;
      // having NOBODY to assign to (`assignment === null`, no members in the company) does not,
      // because a measured zero is not a failure.
      const reportFailures = [];
      if (memoryErrors.length) {
        reportFailures.push(`${memoryErrors.length} memory write(s) failed: `
          + memoryErrors.map((m) => m.error).join('; '));
      }
      if (assignment && assignment.ok === false) {
        reportFailures.push(`the employee task was refused: ${assignment.code || ''} `
          + `${assignment.detail || assignment.error || ''}`.trim());
      }
      if (!remembered.length && !skippedMemories.length && steps.length) {
        reportFailures.push('no memory was written and none was already present, so the next '
          + 'cycle cannot be informed by this one');
      }
      // ── AND AN OUTCOME THAT IS NOT `achieved` IS NOT A SUCCESS ───────
      //
      // B3.18's negative path 2: an invalid worker result makes VALIDATE record `partial` and open
      // an exception — correctly — and then REPORT called `finish({})`, which derives the terminal
      // state from EVENTS. A partial outcome is a row, not an event, so the run ended **SUCCEEDED**
      // with an open exception against it: the queue said one thing and the run said another, and
      // the run is what a dashboard shows. Recorded as a report failure so the state is derived
      // from it, but NOT escalated again — VALIDATE already opened `ex-cycle-<runId>` for exactly
      // this, and a second exception for one problem is how an alarm becomes noise.
      const unachieved = (outcomes || []).filter((o) => o.outcome && o.outcome !== 'achieved');
      if (unachieved.length) {
        reportFailures.push(`${unachieved.length} outcome(s) are not 'achieved' `
          + `(${unachieved.map((o) => o.outcome).join(', ')}), so this objective did not complete`);
      }

      // The escalation is for PERSISTENCE failures only — the ones nothing else has recorded. The
      // unachieved-outcome entry above is excluded on purpose: VALIDATE already escalated it.
      const persistenceFailures = reportFailures.filter((f) => !/outcome\(s\) are not/.test(f));
      let reportEscalationError = null;
      if (persistenceFailures.length) {
        try {
          await scope.openException(resolved, {
            id: `ex-report-${runId}`.slice(0, 64), runId, source: 'office/cycle:report',
            reason: `the reporting phase did not persist what it reported: `
              + persistenceFailures.join(' · '),
            severity: 'high', slaHours: 24,
          }, deps);
        } catch (e) { if (!e || e.code !== '23505') reportEscalationError = e.message; }
      }

      const LEDGER = ledgerFor(deps);
      let terminal = null; let terminalError = null;
      try {
        const f = await LEDGER.finish(runId, reportFailures.length
          ? { error: reportFailures.join(' · ') }
          : {});
        terminal = f && f.state ? f.state : null;
        if (f && f.ok === false) terminalError = f.error || 'the terminal transition did not persist';
      } catch (e) { terminalError = e.message; }

      return { ok: (remembered.length > 0 || skippedMemories.length > 0)
          && reportFailures.length === 0 && !terminalError,
        phase: PHASE.REPORT, next: PHASE.DONE, revalidated: true,
        briefing, assignment, remembered, skippedMemories, memoryErrors,
        reportFailures, persistenceFailures,
        escalated: persistenceFailures.length > 0 && !reportEscalationError,
        reportEscalationError,
        terminal, terminalError, evidence };
    }

    // ── REFUSED: a refusal is an ANSWER, so the run must END ────────────
    //
    // This said *"a refused plan is terminal for this run"* and then did nothing about it: it
    // returned `{ok:false, next:'done'}` and left the run RUNNING, so `phaseOf` derived REFUSED
    // again on the next tick, and again, for ever. The same indefinite phase loop the missing
    // terminal transition caused in B3.16, in the one branch where the cycle had already decided
    // there was nothing more to do. Found while mapping B3.18's negative path 8 — a plan refused
    // for insufficient budget is the commonest way to reach here.
    //
    // FAILED rather than a derived state: a run whose plan was refused has achieved nothing, and
    // `finish({})` would have derived SUCCEEDED from the absence of failure events.
    case PHASE.REFUSED: {
      let refusedEscalationError = null;
      try {
        await scope.openException(resolved, {
          id: `ex-refused-${runId}`.slice(0, 64), runId, source: 'office/cycle:refused',
          reason: `the plan for this run was refused (${(evidence && evidence.code) || 'no code'}, `
            + `verdict ${(evidence && evidence.verdict) || 'unknown'}); no work was authorized`,
          severity: 'high', slaHours: 24,
        }, deps);
      } catch (e) { if (!e || e.code !== '23505') refusedEscalationError = e.message; }

      let terminal = null; let terminalError = null;
      try {
        const f = await ledgerFor(deps).finish(runId, {
          state: 'FAILED',
          error: `plan refused: ${(evidence && evidence.code) || 'no code'}`,
        });
        terminal = f && f.state ? f.state : null;
        if (f && f.ok === false) terminalError = f.error || 'the terminal transition did not persist';
      } catch (e) { terminalError = e.message; }

      return { ok: false, phase: PHASE.REFUSED, next: PHASE.DONE,
        reason: 'the plan for this run was refused; re-planning would re-ask an answered question',
        escalated: !refusedEscalationError, refusedEscalationError,
        terminal, terminalError, evidence };
    }

    case PHASE.DONE:
    default:
      return { ok: true, phase: PHASE.DONE, next: PHASE.DONE, evidence };
  }
}

module.exports = {
  advanceCycle, phaseOf, PHASE, WORKFLOW, MEMORY_SUBJECT_PREFIX, PHASE_GRACE_MINUTES,
  // Exported so the criterion can be tested directly. It is the line that decides whether this
  // cycle may claim to have validated a result independently, and for as long as it was
  // `anything.includes('')` that claim was false — a property worth a test of its own rather than
  // only an end-to-end scenario that happens to exercise it.
  independentCriterion,
};
