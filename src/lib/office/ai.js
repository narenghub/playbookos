// PlayNexa AI Office — K5/K6: the governed AI invocation.
//
// THE ONLY WAY THE KERNEL CALLS A MODEL. The ruled chain, and where each link is enforced:
//
//   AI capability request   → `capability` ('fast' | 'balanced' | 'deep'), never a literal pin
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
const { assertContext } = require('./context');

const PROVIDER = 'anthropic';      // the only provider the first kernel workflow needs (Decision 5)
const CAPABILITIES = Object.freeze(['fast', 'balanced', 'deep']);

// Normalize provider usage into kernel field names. Anthropic's `input_tokens`/`output_tokens` are
// a wire detail; if they reached the Executive Agent, swapping providers would edit every agent.
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
    return { ok: false, accounted: true, text: null, json: null, ...base, error: r.error, stopped: !!r.stopped };
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
    return { ok: false, accounted: true, text: null, json: null, ...base,
      error: r.error, cost_row_id: costRow ? costRow.id : null };
  }

  return {
    ok: true, accounted: true,
    text: r.text ?? null,
    json: r.json ?? null,
    ...base,
    cost_row_id: costRow ? costRow.id : null,
  };
}

module.exports = { governedCall, normalizeUsage, CAPABILITIES, PROVIDER };
