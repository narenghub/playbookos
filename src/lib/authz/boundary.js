// ── THE UNIFIED AUTHORIZATION BOUNDARY (Decision 1, 2026-11-25) ─────────────
//
// Owner decision: *"BRIDGE, DO NOT RETIRE. The existing office authorization kernel shall be the
// authoritative foundation for autonomous execution. Preserve gate.js compatibility for existing
// human-initiated product operations. Introduce a controlled adapter so both human-initiated and
// autonomous operations ultimately use consistent authorization policies."*
//
// And: *"Update Gate 3 to require traversal of the unified authorization boundary rather than
// mandatory traversal of the legacy gate.js filename."*
//
// This file is that boundary. It is what Gate 3 now means.
//
// ── THE AUDIT THE OWNER ASKED FOR, BEFORE ANY BEHAVIOUR CHANGED ────────────
//
// Measured 2026-11-25 across src/, scripts/ and server.js: **gate.js has NO production callers.**
// `callAgent`, `callTool` and `gated` are referenced from `src/lib/agents/gate.test.js` and from
// nowhere else that executes; `src/lib/cron-alerts.js` mentions the file in a comment about its
// dependency-injection style, and `src/lib/agents/contract.js` describes it in prose. So "preserve
// existing security behaviour for every legacy caller" has exactly one caller to preserve — the
// test suite — and the migration risk is near zero. That is a finding, not a licence: the owner
// said do not retire it, and it is not retired.
//
// ── TWO DOORS, ONE SPINE, AND NEITHER INVENTS WHAT IT LACKS ────────────────
//
//   authorizeHumanToolCall  a person acting through a product. Authority comes from the USER's
//                           permissions (permissions/resolve.js) and the product's own
//                           restrictions. Unchanged from gate.js's spine — the logic is the same
//                           logic, which is how legacy behaviour is preserved by construction
//                           rather than by promise.
//
//   authorizeAgentAction    an autonomous run. Authority comes from the AUTHORIZED OBJECTIVE, RUN
//                           AND AGENT CONTEXT that office/context.js minted from stored state.
//                           **No human user is invented for it** — there is no `user` parameter,
//                           so there is nothing to fabricate, and `actor_user_id` on the audit row
//                           is NULL because no person did this.
//
// Both go through one spine that consults the same controls in the same order and writes the same
// evidence. What differs is where authority comes FROM, which is the thing that genuinely differs.
//
// ── A PRODUCT IS NOT A COMPANY ─────────────────────────────────────────────
//
// gate.js put its `product` into the kill switch's company slot. The company is now resolved
// through `authz/product-company.js` — an explicit, reviewed mapping — and every non-answer
// (missing, ambiguous, suspended, revoked, expired, unreadable) is a REFUSAL on the autonomous
// path. On the human path an unmapped product does not refuse, because refusing would break
// callers whose authority never depended on a company in the first place; it is recorded as
// `company_resolution` on the audit row so the gap is visible rather than assumed away.
//
// ── THE COMPATIBILITY STOP CHECK, AND WHY IT IS ADDITIVE ───────────────────
//
// Production `autonomy_stops` rows written through gate.js carry `scope_type='company'` with a
// PRODUCT as the key. If this boundary only asked about the resolved company, those existing rows
// would stop matching — an operator's halt would silently stop halting, which is the worst
// possible direction for a security change. So the human path asks about BOTH keys and refuses if
// EITHER matches. It can therefore refuse where the old gate refused and in more cases besides,
// never fewer. That is the only shape of change that preserves existing security behaviour.
//
// ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
//
// It does not replace office/approval.js, office/budget.js or office/scope.js. It CONSULTS them:
// approvals and budgets are enforced where they already live, and this boundary refuses if they
// refuse. Reimplementing either here would be the second competing model the owner ruled out.

'use strict';

const autonomy = require('../autonomy');
const PRODUCT_COMPANY = require('./product-company');

/** The evidence every decision records, whoever made it. */
const EVIDENCE_FIELDS = Object.freeze(['actor', 'company', 'product', 'capability', 'tool',
  'workflow', 'agent', 'decision', 'decision_rule', 'company_resolution']);

const DENY = (rule, explain, extra = {}) => ({
  allowed: false, decision: 'deny', decision_rule: rule, explain, ...extra });

/**
 * Consult the kill switch and say plainly which of the three answers came back.
 *
 * `consequential: true` always, on both paths. checkStopped's read-only concession — only a
 * capability-scoped stop matches, and an unreadable stop state returns null — is right for an
 * agent in the middle of reasoning and wrong for an authorization decision: a decision taken while
 * the kill state cannot be read is a decision taken without consulting it.
 */
async function stopState(scopes, deps) {
  // `deps.autonomy` FIRST. gate.js took its kill switch from deps for a stated reason — its tests
  // are deliberately hermetic, and "a check that reached for a live connection would make them
  // fail closed and DENY everything, and the denial would look like correct behaviour rather than
  // a wiring mistake." Reading the module directly here dropped that injection point, and the
  // effect was the reverse and worse: an injected STOP was ignored and the action was ALLOWED.
  // gate.test.js caught it, which is what those tests are for.
  const kill = (deps && deps.autonomy) || autonomy;
  try {
    const hit = await kill.checkStopped(scopes, { consequential: true, deps });
    if (hit && hit.unknown === true) return { kind: 'unreadable', stop: hit };
    if (hit) return { kind: 'stopped', stop: hit };
    return { kind: 'clear', stop: null };
  } catch (e) {
    return { kind: 'unreadable', stop: { reason: e.message } };
  }
}

/**
 * A PERSON acting through a product.
 *
 * Decision order, unchanged from gate.js's spine: kill switch, then permissions. The switch is
 * first because a stop is not an authorization question — a permitted actor must still be stopped.
 */
async function authorizeHumanToolCall({ user, product, featureKey, toolName, actorAgent = null,
  tenantId = null } = {}, deps = {}) {
  if (!user || !user.id) {
    // NO INVENTED USER, in either direction. An autonomous caller that wandered in here does not
    // get a synthetic person; it is told to use the other door.
    return DENY('no_actor',
      'the human path requires an authenticated user. An autonomous run has none and must use '
      + 'authorizeAgentAction, which derives its authority from the objective, run and agent '
      + 'context instead of from a person.',
      { company_resolution: 'not_attempted' });
  }

  // The company, through the explicit mapping. Recorded either way; never assumed from `product`.
  const mapped = await PRODUCT_COMPANY.companyForProduct(product, deps);
  const companyId = mapped.ok ? mapped.companyId : null;
  const companyResolution = mapped.ok ? `mapped:${mapped.companyId}` : `unresolved:${mapped.reason}`;

  // BOTH keys — the resolved company and, for compatibility, the product as a company key. See the
  // header: existing production stop rows carry the product there, and this must not stop honouring
  // them.
  const asks = [];
  if (companyId) asks.push({ company: companyId, agent: actorAgent || undefined, capability: toolName });
  asks.push({ company: product, agent: actorAgent || undefined, capability: toolName });

  for (const scopes of asks) {
    const s = await stopState(scopes, deps);
    if (s.kind === 'unreadable') {
      // The phrase "kill-switch check failed" is kept deliberately: gate.test.js asserts on it,
      // and that assertion is the legacy contract this bridge promised to preserve. Changing the
      // wording would have been a behaviour change nobody intended, discovered by a test that was
      // right to object.
      return DENY('autonomy_stop_unreadable',
        `STOPPED_BY_POLICY: kill-switch check failed (${s.stop && s.stop.reason}) — an unreadable `
        + 'stop is not permission', { company: companyId, product, company_resolution: companyResolution });
    }
    if (s.kind === 'stopped') {
      return DENY('autonomy_stop',
        `STOPPED_BY_POLICY: ${s.stop.scope_type}`
        + `${s.stop.scope_key ? `:${s.stop.scope_key}` : ''} — ${s.stop.reason}`,
        { stopped_by_policy: true, stop: s.stop, company: companyId, product,
          company_resolution: companyResolution });
    }
  }

  // The user's own permissions, from the existing resolver. Fail CLOSED on a resolver error, which
  // is what gate.js did and what preserving its behaviour means.
  const doResolve = deps.resolve || require('../permissions/resolve').resolve;
  let decision;
  try {
    decision = await doResolve(user || {}, featureKey, deps.resolveDeps || {});
  } catch (e) {
    decision = { allowed: false, rule: null, explain: `resolver error: ${e.message}` };
  }
  if (!(decision && decision.allowed === true)) {
    return DENY(decision ? decision.rule : null,
      decision ? decision.explain : 'no decision', {
        company: companyId, product, company_resolution: companyResolution, permissions: decision });
  }

  return { allowed: true, decision: 'allow',
    decision_rule: decision.rule, explain: decision.explain,
    actor: { kind: 'human', userId: user.id, role: user.role || null },
    company: companyId, product, tenantId, capability: toolName,
    company_resolution: companyResolution };
}

/**
 * AN AUTONOMOUS RUN acting under an authorized objective.
 *
 * Authority is derived, never supplied: the company and objective come from `ctx`, which
 * office/context.js minted from the objectives row and brands with a module-private Symbol, so a
 * hand-built look-alike is refused. There is no `user`, no `companyId` and no `product` parameter.
 *
 * The six controls are enforced INDEPENDENTLY, each by the module that owns it, and any one of them
 * refusing refuses the action:
 *
 *   company scope        the context itself (assertContext) plus the scoped read of the objective
 *   capability           the kill switch's closed capability vocabulary
 *   STOP controls        autonomy.checkStopped on company, workflow, agent and capability
 *   revocation           the objective must still be ACTIVE; a revoked worker/membership is
 *                        enforced by the accessors this calls, not re-implemented here
 *   approvals            office/approval.js — consulted, not reimplemented
 *   budget               office/budget.js — a metered action takes a HOLD before it runs (B2.5b)
 */
async function authorizeAgentAction(ctx, { capability, workflow, agent, toolName = null,
  consequential = false, maxUsd = null, reason = null } = {}, deps = {}) {
  const CTX = require('../office/context');
  try {
    CTX.assertContext(ctx);
  } catch (e) {
    return DENY('no_company_context',
      `an autonomous action requires a context produced by office/context.js: ${e.message}`,
      { company_resolution: 'not_attempted' });
  }
  if (!ctx.runId) {
    return DENY('no_run',
      'an autonomous action must belong to a run: the audit trail is keyed to it, and an action '
      + 'with no run cannot be attributed');
  }
  if (!capability || !autonomy.CAPABILITIES.includes(capability)) {
    return DENY('capability_not_stoppable',
      `"${capability}" is not a kill-switch capability, so this action could not be halted by name`,
      { company: ctx.companyId });
  }

  const evidence = { actor: { kind: 'agent', agent: agent || null, runId: ctx.runId },
    company: ctx.companyId, product: null, capability, tool: toolName,
    workflow: workflow || null, agent: agent || null,
    company_resolution: 'derived_from_context' };

  // ── REVOCATION: the objective must still be active ──────────────────────
  const scope = require('../office/scope');
  let objective = null;
  if (ctx.objectiveId) {
    try {
      objective = await scope.getObjective(ctx, ctx.objectiveId, deps);
    } catch (e) {
      return DENY('objective_unreadable', `the objective could not be read (${e.message})`, evidence);
    }
    if (!objective) {
      return DENY('objective_not_in_company_scope',
        `objective ${ctx.objectiveId} is not readable for company ${ctx.companyId}`, evidence);
    }
    if (objective.status !== 'active') {
      return DENY('authorization_revoked',
        `objective ${ctx.objectiveId} is ${objective.status}; the authority this action would act `
        + 'under has been withdrawn', evidence);
    }
  }

  // ── STOP CONTROLS ───────────────────────────────────────────────────────
  const s = await stopState({ company: ctx.companyId, agent: agent || undefined,
    workflow: workflow || undefined, capability }, deps);
  if (s.kind === 'unreadable') {
    return DENY('autonomy_stop_unreadable',
      `the kill state could not be determined (${s.stop && s.stop.reason}) — an unreadable stop is `
      + 'not permission', evidence);
  }
  if (s.kind === 'stopped') {
    return DENY('autonomy_stop',
      `STOPPED_BY_POLICY: ${s.stop.scope_type}`
      + `${s.stop.scope_key ? `:${s.stop.scope_key}` : ''} — ${s.stop.reason}`,
      { ...evidence, stopped_by_policy: true, stop: s.stop });
  }

  // ── APPROVALS: consulted where they live ────────────────────────────────
  //
  // A consequential autonomous action needs a human approval that has been RELEASED, and that
  // question belongs to office/approval.js and office/scope.js. This boundary refuses when they
  // refuse; it does not re-derive the answer, because a second implementation of "is this
  // approved" is the competing model the owner ruled out.
  if (consequential) {
    const policy = objective ? objective.approval_policy : null;
    if (policy !== 'all_consequential') {
      return DENY('approval_policy_unknown',
        `the objective's approval policy is "${policy}"; a consequential autonomous action is `
        + 'refused unless the policy requires an approval that can be checked', evidence);
    }
    return { allowed: false, decision: 'deny', decision_rule: 'needs_released_approval',
      explain: 'a consequential action is authorized by a RELEASED approval, which is '
        + 'office/approval.js\'s release path — this boundary does not substitute for it',
      needsApproval: true, ...evidence };
  }

  // ── BUDGET: a metered action HOLDS the money first ──────────────────────
  let reservation = null;
  if (maxUsd !== null) {
    const budget = require('../office/budget');
    const b = await budget.authorizeSpend(ctx, {
      objectiveId: ctx.objectiveId || null, runId: ctx.runId, maxUsd,
      reason: reason || `${workflow || 'office'}/${agent || 'agent'} ${capability}`,
    }, deps);
    if (!b.allow) {
      return DENY('budget_refused', b.reason,
        { ...evidence, needsBudgetOrException: b.needsBudgetOrException === true });
    }
    reservation = b.reservation;
  }

  return { allowed: true, decision: 'allow', decision_rule: 'agent_context',
    explain: `derived from objective ${ctx.objectiveId || '(none)'} on run ${ctx.runId} for `
      + `company ${ctx.companyId}`,
    reservation, ...evidence };
}

module.exports = {
  authorizeHumanToolCall, authorizeAgentAction, stopState, EVIDENCE_FIELDS,
};
