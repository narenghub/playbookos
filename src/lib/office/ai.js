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
// ── THE MOST THIS CALL CAN COST (B2.5b, corrected per the owner's §4 of 2026-11-25) ────────
//
// A hold has to bound the worst case, not guess the likely one, so every term here rounds AGAINST
// us and the figure is deliberately larger than the call will be:
//
//   • OUTPUT is the expensive side and its ceiling is exact: the request sends `max_tokens`, so
//     the provider cannot bill more output than that. llm.js defaults it to 1024 when unset, and
//     the builder below mirrors that default rather than this file assuming one.
//   • INPUT is bounded by the UTF-8 BYTE LENGTH of the serialized request. Anthropic's tokenizer
//     is a byte-level BPE whose base vocabulary contains all 256 byte values, so a token is never
//     fewer than one byte of input: the byte count is a BOUND, not an estimate.
//   • The RATE comes from llm.ratesFor, the conservative list price with intro discounts ignored on
//     purpose, falling back to the most expensive tier for an unrecognised model.
//
// ── WHAT THIS REPLACES, AND WHY THE OWNER WAS RIGHT TO REJECT IT ───────────
//
// The previous version divided CHARACTER length by three and added a flat 512-token envelope. The
// owner's correction — *"three characters per token is not a guaranteed maximum token count"* — is
// correct, and the counter-examples are ordinary rather than exotic:
//
//   • `薬` is ONE character, three UTF-8 bytes, at least one token. chars/3 scores it as 0.33
//     tokens, so a page of Japanese or Chinese supplier mail underestimated by roughly 3x — and
//     this platform's procurement correspondence is full of exactly that.
//   • base64, hashes and identifiers run nearer one token per two characters.
//   • an emoji is one or two characters and several tokens.
//
// Each of those made the hold SMALLER than the charge, which is the one direction a ceiling must
// never round. The envelope constant was the same kind of guess: generous today, and silently
// insufficient the moment tool definitions or attachments join the body.
//
// Both are now MEASURED over the real request, built by `llm.buildRequestBody` — the same function
// that builds what is sent. One builder, so the body that is charged for and the body that is
// bounded cannot drift, and anything later added to the request is inside the bound by
// construction rather than by somebody remembering to widen a constant.
function maxChargeUsd({ capability, system, prompt, maxTokens }) {
  const model = llm.resolveModel(capability);
  const [inRate, outRate] = llm.ratesFor(model);
  const body = llm.buildRequestBody({ model, system, prompt, maxTokens });
  const inTokens = llm.maxInputTokens(body);
  // From the BODY, not from the argument: llm.js applies its own default when maxTokens is unset,
  // and reading it back from the body is what keeps the two in step.
  const outTokens = Number(body.max_tokens);
  const usd = inTokens * inRate + outTokens * outRate;
  // Never zero: a $0 hold reserves nothing while looking like a reservation, and the table refuses
  // it. A floor of one ten-thousandth of a cent keeps the smallest conceivable call reservable.
  return Math.max(usd, 0.000001);
}

/**
 * Settle or release a hold without ever letting that bookkeeping break the call it belongs to.
 *
 * A reservation that cannot be reconciled is a reporting defect; failing the AI result over it
 * would turn an accounting problem into an outage, and the hold expires on its own window in any
 * case. So this logs and returns.
 */
async function settleHold(ctx, reservation, { costUsd, costKnown, costLedgerId = null,
  zeroChargeEvidence = null }, deps) {
  if (!reservation) return null;
  try {
    if (costKnown === true && Number(costUsd) === 0) {
      // A MEASURED zero. The hold goes back — but if the request was dispatched, releasing it
      // needs evidence, because "it failed so it was free" is precisely the assumption the owner
      // forbade. The caller supplies what it knows; `releaseSpend` refuses the release otherwise
      // and the hold stays live, which is the safe direction.
      return await scope.releaseSpend(ctx, { reservationId: reservation.id,
        zeroChargeEvidence: zeroChargeEvidence
          || 'the provider was never reached: a policy stop, a missing credential or a rejected '
             + 'capability refused this call before any request was sent, so no charge exists' },
      deps);
    }
    return await scope.settleSpend(ctx, {
      reservationId: reservation.id, costUsd, costKnown, costLedgerId,
    }, deps);
  } catch (e) {
    console.error(`[office/ai] reservation ${reservation.id} could not be reconciled `
      + `(${e.message}); it will expire at ${reservation.expires_at}`);
    return null;
  }
}

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

  // ── K5 / B2.5b: A HOLD BEFORE THE CALL, NOT A VERDICT AFTER IT ───────────
  //
  // Both caps must be satisfied: the enterprise cap is PER DAY and resets; an objective's budget
  // is a TOTAL for its life. "Do not allow a $10 objective to consume $50 simply because
  // enterprise budget remains."
  //
  // WHAT THIS REPLACED, AND WHY IT HAD TO. Until B2.5b this was `enforceHierarchy` — ask the
  // budget, then call the provider, then record the cost. Check-then-act, with two holes:
  //
  //   • CONCURRENCY. Two calls both read the same spend, both find headroom, and both spend. The
  //     limit held only for callers that happened not to overlap.
  //   • MAGNITUDE. The gate asked "is there headroom", never "is there headroom for THIS call".
  //     One call against a $0.05 objective could cost $5, and the refusal arrived on the call
  //     after it. The owner put it exactly: *"Prevent unauthorized expenditure before a metered
  //     call, not merely after the budget has been exceeded."*
  //
  // So the money is held FIRST, for the most this call can cost, atomically against the objective
  // (scope.reserveSpend serializes on the objectives row). The provider is reached only if the
  // hold succeeded, and the hold is reconciled to the real cost afterwards — in a `finally`, so a
  // throw cannot leak it.
  //
  // The objective's budget is still never caller-supplied: `authorizeSpend` reads it from the
  // locked objectives row, and there is no autonomy flag to pass (B2.5b).
  //
  // `refuseOnUnmeasured` is deliberately NOT set here. Unknown cost fails closed at RELEASE, in
  // consequentialReleaseGate, because blocking the AI call would destroy the text and the cost row
  // a human is meant to review. Unmeasured calls still raise the tier by one, so they tighten the
  // assessment without inventing a dollar figure.
  const worstCaseUsd = maxChargeUsd({ capability, system, prompt, maxTokens });
  const budgetDecision = await budget.authorizeSpend(ctx, {
    objectiveId: ctx.objectiveId || null,
    runId: ctx.runId,
    maxUsd: worstCaseUsd,
    reason: `${capability} call for ${workflow || 'office'}/${agent || 'agent'}`
      + `${purpose ? ` — ${purpose}` : ''}`,
    criticality,
  }, deps);

  if (!budgetDecision.allow) {
    // Nothing reached the provider, so cost is a KNOWN ZERO and no ledger row is owed. Filing a
    // $0.00 row here would pad the ledger with non-events and make "zero spend" ambiguous.
    console.warn(`[BUDGET_REFUSED] ${workflow || 'office'}/${agent || '?'} `
      + `(${budgetDecision.scope}): ${budgetDecision.reason}`);
    return { ok: false, accounted: true, text: null, json: null, ...llm.COST_NONE,
      refusedBy: 'budget', budgetScope: budgetDecision.scope, budget: budgetDecision,
      capability, criticality, maxUsd: worstCaseUsd,
      error: `BUDGET_REFUSED: ${budgetDecision.reason}` };
  }
  const reservation = budgetDecision.reservation || null;

  const model = llm.resolveModel(capability);

  // ── THE HOLD BECOMES FINANCIALLY LIVE BEFORE THE REQUEST GOES ───────────
  //
  // Owner's §4 of 2026-11-25: *"expiration of a reservation must not automatically restore
  // spending authority when the provider may already have processed the request."* From this write
  // onward the hold no longer lapses with its window — it keeps consuming the objective's ceiling
  // until the charge is reconciled or proven not to have happened.
  //
  // BEFORE, not after, and that ordering is the whole value: marked after the call, a process
  // killed mid-request leaves a hold still labelled `reserved`, which expires into headroom the
  // provider has already billed. The gap a crash can still exploit is now one statement wide.
  //
  // A failure to record it does NOT abandon the call — that would turn an accounting write into an
  // outage — but it is logged loudly, because it is the one condition under which the old defect
  // can still occur.
  if (reservation) {
    try {
      await scope.markDispatched(ctx, { reservationId: reservation.id,
        state: 'dispatch_attempted',
        note: `dispatched to ${PROVIDER} as ${model}` }, deps);
    } catch (e) {
      console.error(`[office/ai] reservation ${reservation.id} could NOT be marked dispatched `
        + `(${e.message}) — if this process dies now, the hold may expire into headroom the `
        + 'provider has already billed');
    }
  }

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
    // NOTHING WAS SPENT, so the hold goes straight back rather than sitting until it expires. An
    // abandoned hold is not a correctness problem — reserveSpend ignores an expired one — but it
    // blocks a concurrent call for the rest of its window, which for a misconfigured key would
    // mean every call failing AND the budget looking full.
    await settleHold(ctx, reservation, { costUsd: 0, costKnown: true }, deps);
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
    //
    // The HOLD IS NOT RELEASED HERE, and that is deliberate. Tokens may well have been spent — the
    // charge is real and only the evidence of it failed to persist — so handing the headroom back
    // would let the next call spend money this one already did. The hold stands and expires on its
    // own window, which is the conservative direction: it over-reserves rather than under-counts.
    return {
      ok: false, accounted: false, text: null, json: null, ...base,
      error: `AI cost evidence could not be persisted, so the result is withheld: ${e.message}`,
      accounting_error: e.message,
      reservation_id: reservation ? reservation.id : null,
      reservation_left_held: reservation ? true : false,
    };
  }

  // ── RECONCILE THE HOLD WITH WHAT IT ACTUALLY COST ────────────────────────
  //
  // After the cost row, so the ledger is the authoritative figure and the reservation points at
  // it. `costKnown: false` settles with NO dollar amount: an unmeasured call is not a free one,
  // and writing 0 would make "zero spend" ambiguous (the C1 rule).
  await settleHold(ctx, reservation, {
    costUsd: base.costKnown ? base.costUsd : null,
    costKnown: base.costKnown === true,
    costLedgerId: costRow && costRow.id !== undefined ? costRow.id : null,
  }, deps);

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
  // Exported so the spend ceiling can be tested directly. It is the figure that authorizes every
  // metered call, and a bound nothing can assert on is a bound nobody checks.
  maxChargeUsd,
  CAPABILITIES, PROVIDER, CONFIG_FAILURES };
