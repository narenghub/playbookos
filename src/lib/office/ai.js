// PlayNexa AI Office — K5/K6: the governed AI invocation.
//
// THE ONLY WAY THE KERNEL CALLS A MODEL. The ruled chain, and where each link is enforced:
//
//   AI capability request   → `capability` ('fast' | 'balanced' | 'deep'), never a literal pin
//   budget check            → K5, ACTIVE: both the enterprise daily cap and the objective's total
//                             budget must allow the call, BEFORE the provider is reached
//   selected provider       → returned and persisted, not assumed
//   selected model          → resolved from the alias, literal id recorded so a past decision
//                             stays explicable (AI_PROVIDER_FABRIC.md step 3)
//   bounded invocation      → llm.js's AbortController; 'unbounded' is not expressible
//   normalized result       → provider wire shapes DO NOT LEAVE THIS FILE
//   normalized usage        → { inputTokens, outputTokens }, not Anthropic's field names
//   cost                    → or an explicit UNKNOWN; never silently zero
//   evidence                → office_cost_ledger, welded to (run_id, company_id) by K1
//
// ── WHY THE CONTEXT CANNOT BE SUPPLIED AS A COMPANY ID ──────────────────────
//
// governedCall takes a RESOLVED, FROZEN office context — the object resolveCompanyContext or
// beginObjectiveRun produced — and assertContext refuses anything else, including a plain object
// that merely has the right shape. There is no companyId parameter, so an agent cannot name a
// company for its own spend any more than it can name one for its own run.
//
// ── FAIL CLOSED ON ACCOUNTING, WHICH IS THE WHOLE POINT ─────────────────────
//
// If the cost evidence cannot be persisted, this function DOES NOT RETURN THE TEXT. It reports
// { ok: false, accounted: false } and withholds the output.
//
// That is deliberate and it is the same shape as the RFQ identity guard's
// `decision_not_persisted`: an unaccounted AI call whose output is still usable is an AI call
// outside the budget, and a budget with a bypass is not a budget. The alternative — return the
// text and log a warning — would mean the first thing to break under load is the one control that
// bounds spend, and nothing downstream would notice.
//
// A call that is STOPPED BY POLICY or that never reached the provider is NOT an accounting
// failure: nothing was spent, so there is nothing to account for. Those return ok:false with
// accounted:true and a known-zero cost.

const llm = require('../llm');
const scope = require('./scope');
const budget = require('./budget');
const { assertContext } = require('./context');

const PROVIDER = 'anthropic';      // the only provider the first kernel workflow needs (Decision 5)
const CAPABILITIES = Object.freeze(['fast', 'balanced', 'deep']);

// Normalize provider usage into kernel field names. Anthropic's `input_tokens`/`output_tokens` are
// a wire detail; if they reached the Executive Agent, swapping providers would edit every agent.
// ── MODEL FAILURE SEMANTICS (ruling §5) ─────────────────────────────────────
//
//   "Do not let { error } silently become 'no AI result available' inside the governed path."
//
// A provider failure is CLASSIFIED, because the right response differs sharply and collapsing them
// is how a misconfiguration hides as flakiness:
//
//   model_invalid  a pinned model that does not exist or was rejected. A CONFIGURATION DEFECT. It
//                  will fail identically on every retry, for ever, and nothing in this repository
//                  validates a model id — so without this it is indistinguishable from the provider
//                  having a bad minute. Queued for a human.
//   auth           a rejected or missing key. Also a configuration defect. Queued.
//   rate_limited   real but transient-ish; not queued, because flooding the queue with 429s buries
//                  the two classes above.
//   timeout        bounded abort. Ordinary. Not queued (ruling §14).
//   transient      5xx, network. Ordinary. Not queued.
//
// Only the configuration classes reach the human queue. That is the distinction §14 asks for
// between a defect somebody must fix and a provider having a bad minute.
const CONFIG_FAILURES = Object.freeze(['model_invalid', 'auth']);

function classifyProviderFailure(r) {
  if (!r || !r.error) return null;
  if (r.stopped) return 'stopped_by_policy';
  if (r.timedOut) return 'timeout';
  const status = r.status;
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  // Anthropic answers an unknown model with 404, and a malformed request naming one with 400.
  if (status === 404) return 'model_invalid';
  if (status === 400 && /model/i.test(String(r.error))) return 'model_invalid';
  if (typeof status === 'number' && status >= 500) return 'transient';
  if (/not configured/i.test(String(r.error))) return 'auth';
  return 'transient';
}

function normalizeUsage(usage) {
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
  };
}

/**
 * Invoke a model under governance. Returns a normalized result; never throws for a provider
 * failure, and never returns usable text that has not been accounted for.
 *
 * ctx   — a frozen office context (from beginObjectiveRun or resolveCompanyContext)
 * spec  — { capability, prompt, system, maxTokens, timeoutMs, agent, workflow, purpose }
 */
async function governedCall(ctx, spec, deps = {}) {
  assertContext(ctx);
  const {
    capability = 'fast', prompt, system = null, maxTokens,
    timeoutMs, agent = null, workflow = null, purpose = null,
    // 'routine' is the STRICTER default, deliberately: critical, recovery and observability work
    // is exempt from the spend limit, so a caller that forgets to declare its criticality gets
    // refused when the budget is exhausted rather than silently exempted. Same shape as
    // `consequential` defaulting to true in approval.release.
    criticality = 'routine',
  } = spec || {};

  if (!ctx.runId) {
    // Cost evidence is welded to (run_id, company_id). Without a run there is nowhere to file it,
    // so the call is refused rather than made unaccountably.
    return { ok: false, accounted: false, text: null, json: null,
      error: 'governedCall requires a context carrying a runId: AI spend must attach to a run' };
  }
  if (!CAPABILITIES.includes(capability)) {
    return { ok: false, accounted: true, text: null, json: null, ...llm.COST_NONE,
      error: `unknown capability "${capability}" — expected one of ${CAPABILITIES.join(', ')}` };
  }

  // ── K5 BUDGET ENFORCEMENT, ACTIVATED ──────────────────────────────────────
  //
  // Both caps must be satisfied: the enterprise cap is PER DAY and resets; an objective's budget
  // is a TOTAL for its life. "Do not allow a $10 objective to consume $50 simply because
  // enterprise budget remains."
  //
  // The objective's budget is READ FROM THE RESOLVED CONTEXT, which read it from the stored
  // objective. There is no parameter through which a caller could raise its own ceiling — the same
  // structural choice as the company never being caller-supplied.
  //
  // `refuseOnUnmeasured` is deliberately NOT set here. Unknown cost fails closed at RELEASE, in
  // consequentialReleaseGate, because blocking the AI call would destroy the text and the cost row
  // a human is meant to review. Unmeasured calls still raise the tier by one, so they tighten the
  // assessment without inventing a dollar figure.
  const budgetDecision = await budget.enforceHierarchy(ctx, {
    objectiveId: ctx.objectiveId || null,
    criticality,
    objectiveBudgetUsd: ctx.budgetUsd === undefined ? null : ctx.budgetUsd,
  }, deps);

  if (!budgetDecision.allow) {
    // Nothing reached the provider, so cost is a KNOWN ZERO and no ledger row is owed. Filing a
    // $0.00 row here would pad the ledger with non-events and make "zero spend" ambiguous.
    console.warn(`[BUDGET_REFUSED] ${workflow || 'office'}/${agent || '?'} `
      + `(${budgetDecision.scope}): ${budgetDecision.reason}`);
    return { ok: false, accounted: true, text: null, json: null, ...llm.COST_NONE,
      refusedBy: 'budget', budgetScope: budgetDecision.scope, budget: budgetDecision,
      capability, criticality,
      error: `BUDGET_REFUSED: ${budgetDecision.reason}` };
  }

  const model = llm.resolveModel(capability);
  const r = await llm.callClaude({
    model: capability,            // llm.js resolves the alias; the literal id comes back in r.model
    system, prompt, maxTokens, timeoutMs,
    ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
  });

  const usage = normalizeUsage(r.usage);
  const base = {
    provider: PROVIDER,
    model: r.model || model,
    capability,
    usage,
    costUsd: r.costUsd ?? null,
    costKnown: r.costKnown === true,
    timedOut: r.timedOut === true,
    timeoutMs: r.timeoutMs ?? null,
    company_id: ctx.companyId,
    objective_id: ctx.objectiveId || null,
    run_id: ctx.runId,
    workflow, agent, purpose,
  };

  // ── Nothing was spent: no accounting row is owed ─────────────────────────
  // A policy stop, a missing key or a rejected capability never reached the provider. Filing a
  // $0.00 row for those would pad the ledger with non-events and make "zero spend" ambiguous.
  if (r.stopped || (r.error && r.costKnown === true && r.costUsd === 0)) {
    const failure = classifyProviderFailure(r);
    let exceptionId = null;
    if (CONFIG_FAILURES.includes(failure)) {
      try {
        exceptionId = `ex-ai-${failure}-${ctx.runId}`;
        await scope.openException(ctx, {
          id: exceptionId, runId: ctx.runId, source: 'office/ai',
          reason: `provider ${failure}: ${r.error} (provider=${PROVIDER}, model=${base.model}) — `
            + 'a configuration defect, not a transient failure: it will recur identically until changed',
          severity: 'critical', slaHours: 4,
        }, deps);
      } catch (_) { exceptionId = null; }
    }
    return { ok: false, accounted: true, text: null, json: null, ...base, error: r.error,
      stopped: !!r.stopped, provider_failure: failure,
      needs_human: CONFIG_FAILURES.includes(failure), exception_id: exceptionId };
  }

  // ── Everything from here consumed, or may have consumed, provider tokens ──
  // including a timeout and an HTTP error, which is why they are accounted BEFORE being reported.
  let costRow = null;
  try {
    costRow = await scope.recordCost(ctx, {
      runId: ctx.runId,
      provider: PROVIDER,
      model: base.model,
      tokensInput: usage ? usage.inputTokens : null,
      tokensOutput: usage ? usage.outputTokens : null,
      costUsd: base.costKnown ? base.costUsd : null,
      costKnown: base.costKnown,
      agent, workflow,
    }, deps);
  } catch (e) {
    // THE FAIL-CLOSED BRANCH. The text is withheld even on an otherwise successful call.
    return {
      ok: false, accounted: false, text: null, json: null, ...base,
      error: `AI cost evidence could not be persisted, so the result is withheld: ${e.message}`,
      accounting_error: e.message,
    };
  }

  if (r.error) {
    const failure = classifyProviderFailure(r);
    const needsHuman = CONFIG_FAILURES.includes(failure);
    // A configuration defect is filed for a human. A transient one is not — the run's own
    // terminal state and the cost row are already durable evidence of it.
    let exceptionId = null;
    if (needsHuman) {
      try {
        exceptionId = `ex-ai-${failure}-${ctx.runId}`;
        await scope.openException(ctx, {
          id: exceptionId, runId: ctx.runId, source: 'office/ai',
          reason: `provider ${failure}: ${r.error} (provider=${PROVIDER}, model=${base.model}, `
            + `capability=${capability}) — this will fail identically on every retry until a human changes the configuration`,
          severity: 'critical', slaHours: 4,
        }, deps);
      } catch (_) { exceptionId = null; }
    }
    return { ok: false, accounted: true, text: null, json: null, ...base,
      error: r.error, provider_failure: failure, needs_human: needsHuman,
      exception_id: exceptionId, cost_row_id: costRow ? costRow.id : null };
  }

  return {
    ok: true, accounted: true,
    text: r.text ?? null,
    json: r.json ?? null,
    ...base,
    cost_row_id: costRow ? costRow.id : null,
  };
}

module.exports = { governedCall, normalizeUsage, classifyProviderFailure,
  CAPABILITIES, PROVIDER, CONFIG_FAILURES };
