// ── B3.3: GOVERNED MULTI-AGENT DELEGATION ───────────────────────────────────
//
// One agent asks another to do governed work. What crosses the boundary is a CONTEXT, never a
// company id — the same structural choice as office/run.js and office/memory.js, and for the same
// reason: a validation check would have to be remembered, and could be relaxed by a later caller
// with a reason.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
//
// Carried constraint: "Do not introduce competing identity or company authorization systems."
//
// So this module adds no authorization model. It composes the ones that exist:
//
//   office/context.js   mints the child context by DERIVING the parent's — deriveContext refuses
//                       to change the company, so there is no code path from here to another one
//   office/run.js       the child run's company is read from the stored objective, not passed
//   autonomy.js         the kill switch, consulted per delegation
//   office/budget.js    the objective's budget, read off the context
//   office/scope.js     every read and write, company-scoped
//
// There is a second, OLDER dispatch spine in this repository: src/lib/agents/gate.js, with
// callAgent/callTool, a permissions resolve() and the tool_call_audit table. It is not used here,
// and the reason is architectural rather than preference. gate.js keys authorization off a `user`
// and a `product`/`tenantId` — it passes `product` as the company scope key to checkStopped. An
// autonomous office run has no user, and its company is a `companies` row, not a product. Routing
// office delegation through it would mean maintaining two answers to "which company is this for",
// which is exactly the competing-authorization-system the owner ruled out. Adopting it would mean
// bridging the two models; retiring it is a decision about user-initiated product tool calls,
// which this module does not touch. That choice is the owner's, and it is recorded as an open
// question rather than settled here by implication.
//
// ── THE SIX THINGS CHECKED BEFORE A CHILD RUN EXISTS ───────────────────────
//
//   1. the target agent is in a CLOSED registry, with a declared capability. An agent name from a
//      model, a memory or a plan cannot name something that is not there.
//   2. the parent run is alive. Delegating from a finished run produces an orphan whose costs
//      nobody is watching.
//   3. the delegation depth is bounded. Without this, A delegates to B delegates to A is a loop
//      that spends real money.
//   4. the autonomy tier permits it, and `bounded` is not authorized for any company.
//   5. the kill switch is clear — asked as a consequential caller, because creating a child run is
//      minting authorization, not thinking. An unreadable stop state refuses.
//   6. the objective has a finite authorized budget (B2.5a). The child gets the SAME objective, so
//      its spend aggregates against the parent's ceiling and cannot be given one of its own.
//
// Every one of those is recorded. `policy_decision` on the delegation row is the verdict, and the
// row is written BEFORE the child run is started — so a delegation with no evidence cannot happen.

'use strict';

const crypto = require('crypto');
const scope = require('./scope');
const { assertContext, deriveContext } = require('./context');
const autonomy = require('../autonomy');

/** How deep a delegation chain may go. Root is depth 0, so this permits parent → child → grandchild. */
const MAX_DEPTH = 3;

/**
 * THE CLOSED REGISTRY OF DELEGABLE AGENTS.
 *
 * `capability` is the kill-switch capability the delegated work consumes, so an operator can stop
 * it by name. `consequential` says whether the child may have an effect outside the platform —
 * and none of these may, because every consequential effect still goes through the approval
 * boundary in office/approval.js, which is not reachable from a delegation.
 */
const DELEGABLE = Object.freeze({
  'procurement-agent': Object.freeze({
    workflow: 'delegated-procurement-research',
    capability: 'llm.call',
    consequential: false,
    summary: 'researches suppliers and prepares material for a human-approved RFQ',
  }),
  'sales-agent': Object.freeze({
    workflow: 'delegated-sales-research',
    capability: 'llm.call',
    consequential: false,
    summary: 'analyses pipeline state for this company',
  }),
  'seo-agent': Object.freeze({
    workflow: 'delegated-seo-analysis',
    capability: 'llm.call',
    consequential: false,
    summary: 'analyses search performance for this company',
  }),
});

// Load-time: every delegable agent's capability must be one the kill switch knows, or it could not
// be stopped by name — the false-safety shape K8 exists to prevent.
for (const [name, def] of Object.entries(DELEGABLE)) {
  if (!autonomy.CAPABILITIES.includes(def.capability)) {
    throw new Error(`delegable agent '${name}' names capability '${def.capability}', which the `
      + 'kill switch does not know');
  }
  if (def.consequential) {
    throw new Error(`delegable agent '${name}' is marked consequential: a delegation may not carry `
      + 'out a consequential action. That boundary is office/approval.js and is not reachable here.');
  }
}

// Declared where they are defined, so an operator can stop any delegated workflow or agent by name.
autonomy.registerScopes({
  workflows: Object.values(DELEGABLE).map((d) => d.workflow),
  agents: Object.keys(DELEGABLE),
});

const refuse = (code, detail, extra = {}) => ({ ok: false, refused: code, detail, ...extra });

/**
 * Delegate governed work from the run carrying `parentCtx` to another agent.
 *
 * NOTE THE SIGNATURE. There is no `companyId`, no `budgetUsd` and no `objectiveId`: the company and
 * objective come from the parent context, the budget is read off it by office/budget.js, and the
 * child's own context is DERIVED rather than built. A caller that wanted a different company would
 * have to resolve a context for it, which means reading it from stored state.
 *
 * @returns {{ok:true, childRunId, childContext, delegationId, depth}}
 *        | {{ok:false, refused, detail}}
 */
async function delegate(parentCtx, { toAgent, callingAgent, reason, intentKey = null,
  maxDepth = MAX_DEPTH } = {}, deps = {}) {
  assertContext(parentCtx);
  if (!parentCtx.runId) {
    return refuse('no_parent_run',
      'a delegation must come from a live run: the child inherits its position in the run tree, '
      + 'and a delegation with no parent has no tree to join');
  }
  if (!parentCtx.objectiveId) {
    return refuse('no_objective', 'a delegation must belong to an objective');
  }
  if (!callingAgent) return refuse('no_calling_agent', 'dispatch evidence must name the caller');
  if (!reason || String(reason).trim().length < 10) {
    return refuse('no_reason',
      'a delegation must say why, in at least 10 characters — the same rule the kill switch applies '
      + 'to a stop, and for the same purpose: incident reconstruction');
  }

  // ── 1. THE TARGET AGENT IS IN THE REGISTRY ───────────────────────────────
  const def = DELEGABLE[toAgent];
  if (!def) {
    return refuse('unknown_target_agent',
      `'${toAgent}' is not a delegable agent (${Object.keys(DELEGABLE).join(', ')}). An agent name `
      + 'that reached this function from a model, a plan or a memory names nothing.');
  }

  // ── 2. THE PARENT RUN IS ALIVE ───────────────────────────────────────────
  //
  // Read through the scoped accessor, so a parent run of another company reads as absent — which
  // is the right answer, not an error to be worked around.
  let parent;
  try {
    parent = await scope.runState(parentCtx, parentCtx.runId, deps);
  } catch (e) {
    return refuse('parent_unreadable',
      `the parent run could not be read (${e.message}) — an unreadable parent is not a live one`);
  }
  if (!parent) {
    return refuse('parent_not_in_company_scope',
      `run ${parentCtx.runId} is not readable for company ${parentCtx.companyId}`);
  }
  if (parent.state !== 'RUNNING') {
    return refuse('parent_not_running',
      `the parent run is ${parent.state}; delegating from a run that is not RUNNING produces a `
      + 'child whose cost and outcome nobody is waiting for');
  }

  // ── 3. DEPTH ─────────────────────────────────────────────────────────────
  let depth;
  try {
    depth = (await scope.delegationDepth(parentCtx, parentCtx.runId, {}, deps)).depth;
  } catch (e) {
    return refuse('depth_unreadable',
      `the delegation depth could not be measured (${e.message}) — an unmeasured depth is not a `
      + 'depth within bounds');
  }
  const childDepth = depth + 1;
  if (childDepth > maxDepth) {
    return refuse('delegation_too_deep',
      `this run is already at depth ${depth}; a child would be ${childDepth} and the bound is `
      + `${maxDepth}. Without a bound, A delegating to B delegating to A is a loop that spends `
      + 'real money.',
      { depth, childDepth, maxDepth });
  }

  // ── 4. THE AUTONOMY TIER ─────────────────────────────────────────────────
  //
  // Read from the stored objective, not from the context — the context carries it, but the
  // objective row is the authoritative copy and this is the gate, so it asks the source.
  let objective;
  try {
    objective = await scope.getObjective(parentCtx, parentCtx.objectiveId, deps);
  } catch (e) {
    return refuse('objective_unreadable', `the objective could not be read (${e.message})`);
  }
  if (!objective) {
    return refuse('objective_not_in_company_scope',
      `objective ${parentCtx.objectiveId} is not readable for company ${parentCtx.companyId}`);
  }
  if (objective.status !== 'active') {
    return refuse('objective_not_active',
      `objective ${parentCtx.objectiveId} is ${objective.status}; delegation is not a way to carry `
      + 'on work the CEO has switched off');
  }
  const tier = objective.autonomy_tier;
  if (tier !== 'supervised') {
    return refuse('autonomy_tier_forbids_delegation',
      `autonomy tier '${tier}' may not delegate. 'none' may observe, analyse and report; `
      + "'bounded' is not authorized for any company; an unknown tier fails closed.",
      { tier });
  }

  // ── 5. THE KILL SWITCH ───────────────────────────────────────────────────
  //
  // Consequential: true, deliberately. Creating a child run is minting authorization for work that
  // will spend money, not thinking about it — so a global stop, a stop on the delegated workflow
  // or a stop on the target agent all prevent it, and an UNREADABLE stop state refuses rather than
  // returning the read-only path's null.
  let stopped;
  try {
    stopped = await autonomy.checkStopped({
      capability: def.capability,
      workflow: def.workflow,
      agent: toAgent,
      company: parentCtx.companyId,
    }, { consequential: true, deps });
  } catch (e) {
    return refuse('killswitch_unreadable',
      `the stop state could not be read (${e.message}) — an unreadable stop is not permission`);
  }
  if (stopped && stopped.unknown === true) {
    return refuse('killswitch_unreadable', `the stop state is unknowable: ${stopped.reason}`);
  }
  if (stopped) {
    return refuse('stopped_by_policy',
      `a stop is in force at ${stopped.scope_type}`
      + `${stopped.scope_key ? `=${stopped.scope_key}` : ''}: ${stopped.reason}`,
      { stop: stopped });
  }

  // ── 6. THE BUDGET ────────────────────────────────────────────────────────
  //
  // The child's spend aggregates against the SAME objective, because the child run carries the
  // same objective_id and office_cost_ledger is summed per objective. So there is no child budget
  // to raise — and no parameter here through which one could be supplied, which is the structural
  // half of B2.5a's child-bypass requirement.
  const budget = require('./budget');
  let budgetDecision;
  try {
    budgetDecision = await budget.enforceHierarchy(parentCtx, {
      objectiveId: parentCtx.objectiveId, criticality: 'routine', autonomous: true,
    }, deps);
  } catch (e) {
    return refuse('budget_unreadable',
      `the budget could not be read (${e.message}) — an unreadable budget is not permission`);
  }
  if (!budgetDecision.allow) {
    return refuse('budget_refused', budgetDecision.reason,
      { needsBudgetOrException: budgetDecision.needsBudgetOrException === true });
  }

  // ── THE CHILD RUN ────────────────────────────────────────────────────────
  //
  // Created through the run ledger with the company READ from the stored objective by
  // beginObjectiveRun — this function never passes a company. The parent and root are passed so
  // the child joins the tree rather than starting a new one.
  const L = deps.ledger || require('../run-ledger').ledger({ query: deps && deps.query });
  const key = intentKey || `delegate-${parentCtx.runId}-${toAgent}-${crypto.randomBytes(6).toString('hex')}`;

  let created;
  try {
    created = await L.createRun({
      trigger: 'office',
      triggerDetail: `delegation/${callingAgent}->${toAgent}`,
      workflow: def.workflow,
      agent: toAgent,
      product: 'internal',
      intentKey: key,
      parentRunId: parentCtx.runId,
      rootRunId: parent.root_run_id || undefined,
      objectiveId: parentCtx.objectiveId,
      companyId: parentCtx.companyId,
      maxRuntimeMinutes: 30,
    });
  } catch (e) {
    return refuse('child_run_not_created',
      `the child run could not be created (${e.message}) — a delegation that cannot be recorded in `
      + 'the ledger does not happen');
  }
  if (created.duplicate) {
    return refuse('duplicate_delegation',
      `another process already owns the intent ${key}`, { intentKey: created.intentKey });
  }

  // ── THE DISPATCH EVIDENCE ────────────────────────────────────────────────
  //
  // Written immediately after the child run exists and BEFORE the child is handed its context, so
  // there is no window in which a child is executing with no record of who dispatched it. If this
  // write fails the delegation is refused and the child run is finished as FAILED: a child nobody
  // can attribute is worse than a delegation that did not happen.
  const delegationId = `dg-${created.runId}`;
  try {
    await scope.recordDelegation(parentCtx, {
      id: delegationId,
      parentRunId: parentCtx.runId,
      childRunId: created.runId,
      callingAgent,
      targetAgent: toAgent,
      workflow: def.workflow,
      capability: def.capability,
      autonomyTier: tier,
      policyDecision: budgetDecision.objective
        ? `allowed: tier ${tier}, stop clear, objective budget `
          + `${Math.round(budgetDecision.objective.fraction * 100)}% used`
        : `allowed: tier ${tier}, stop clear, ${budgetDecision.budgetException
          ? `budget exception ${budgetDecision.budgetException.id}` : 'enterprise cap only'}`,
      depth: childDepth,
      reason: String(reason).trim(),
    }, deps);
  } catch (e) {
    try { await L.finish(created.runId, { state: 'FAILED', error: `delegation not recorded: ${e.message}` }); }
    catch (_) {}
    return refuse('delegation_not_recorded',
      `the dispatch record could not be written (${e.message}); the child run was failed rather `
      + 'than left executing unattributed');
  }

  return {
    ok: true,
    delegationId,
    childRunId: created.runId,
    depth: childDepth,
    // DERIVED, not built. deriveContext keeps office/context.js's brand and refuses to change the
    // company, so what the child receives is this company's context carrying the child's run — and
    // the child has no way to widen it.
    childContext: deriveContext(parentCtx, { runId: created.runId }),
    policyDecision: { tier, capability: def.capability, workflow: def.workflow,
      budget: budgetDecision },
  };
}

module.exports = { delegate, DELEGABLE, MAX_DEPTH };
