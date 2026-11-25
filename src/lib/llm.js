// PlaybookOS — the ONE shared Anthropic Messages API wrapper.
//
// Every agent used to re-implement the same fetch to api.anthropic.com inline (classify,
// infer-molecules, outreach, seo-agent, core.runClaudeAnalysis). This centralizes that call
// so a new content agent doesn't add a sixth copy, and so cost is computed uniformly.
//
//   callClaude({ model, system, prompt, maxTokens, expectJson }) -> { text, json, usage, costUsd, error }
//
// Hard contract (callers already depend on this shape):
//   • NEVER THROWS. Any failure — missing key, network throw, non-200, non-JSON body — is
//     returned as { error }, never raised.
//   • model is REQUIRED. No default — callers choose the model deliberately (cost/quality).
//   • system is OPTIONAL and is OMITTED from the request when absent, so a no-system call is
//     byte-identical to the old inline calls (none of which sent a system prompt).
//   • usage is the raw Anthropic usage object ({input_tokens, output_tokens}) or null.
//   • costUsd is computed from usage + a conservative per-model rate table, so cost fuses can
//     read one uniform number instead of each agent hardcoding rates.
//   • expectJson=true parses the text with the existing parseClaudeJSON. Unparseable output is
//     NOT an error — it returns { json: null } (plus text/usage) so callers keep their own
//     "unparseable X" messaging. error is reserved for genuine call failures.
const { parseClaudeJSON, extractClaudeText } = require('./agent-core');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Conservative STANDARD list prices ($/token); intro discounts ignored ON PURPOSE so any cost
// fuse over-estimates (trips earlier, never later) — same philosophy as the RI orchestrator.
// Matched by model-id PREFIX so dated ids (…-20251001) resolve to the right family.
const RATES = [
  ['claude-fable-5',  10.00 / 1e6, 50.00 / 1e6],
  ['claude-mythos-5', 10.00 / 1e6, 50.00 / 1e6],
  ['claude-opus-4',    5.00 / 1e6, 25.00 / 1e6],
  ['claude-sonnet',    3.00 / 1e6, 15.00 / 1e6],
  ['claude-haiku',     1.00 / 1e6,  5.00 / 1e6],
];
function ratesFor(model) {
  const m = String(model || '');
  for (const [prefix, inR, outR] of RATES) if (m.startsWith(prefix)) return [inR, outR];
  return [5.00 / 1e6, 25.00 / 1e6]; // unknown model → opus-tier (conservative over-estimate)
}
/**
 * The exact request body sent to the provider.
 *
 * Exported so the spend ceiling can be computed from the REQUEST rather than from an estimate of
 * it. Anything added here — tool definitions, attachments, extra messages — is covered by
 * `maxInputTokens` below automatically, which is the property that matters: a new field must not
 * silently fall outside the bound that authorizes the spend.
 */
function buildRequestBody({ model, system, prompt, maxTokens }) {
  const body = {
    model,
    max_tokens: maxTokens || 1024,
    messages: [{ role: 'user', content: String(prompt == null ? '' : prompt) }],
  };
  if (system) body.system = system; // omitted when absent → identical to a no-system call
  return body;
}

/**
 * A CONSERVATIVE bound on the text input tokens a request can consume — and the limits of that
 * claim are stated below, because the previous version of this comment overclaimed.
 *
 * ── WHAT THIS REPLACED, AND WHY IT HAD TO GO ───────────────────────────────
 *
 * The ceiling divided character length by three. That is not a maximum for anything:
 *
 *   • `薬` is ONE character, three UTF-8 bytes, and at least one token — so chars/3 scores it as
 *     0.33 tokens. A page of Japanese or Chinese supplier correspondence underestimated by ~3x,
 *     and this platform's procurement mail is full of it.
 *   • base64, hashes and identifiers tokenize at roughly one token per two or three characters.
 *   • an emoji is one or two characters, four or more bytes, and several tokens.
 *
 * Byte length is strictly better than that in every one of those cases, which is why it is used.
 *
 * ── WHAT IT IS NOT: A UNIVERSALLY PROVEN BILLING BOUND ─────────────────────
 *
 * I previously wrote that this is a proven bound because Anthropic's tokenizer is a byte-level BPE
 * whose base vocabulary holds all 256 byte values. The owner's §3 of 2026-11-25 rejects that
 * claim and is right to. Two separate problems with it:
 *
 *   1. The tokenizer's internals are an INFERENCE, not something this codebase can verify. If the
 *      vocabulary does not in fact contain every byte, a multi-byte character could in principle
 *      cost more tokens than it has bytes.
 *   2. More importantly, BILLING IS NOT ONLY TEXT INPUT TOKENS. A request may be billed for
 *      prompt-cache writes and reads, extended thinking, server-side tool use, and images — none
 *      of which are a function of the serialized text's length. A bound on text input tokens
 *      bounds exactly that and says nothing about the rest.
 *
 * So the honest statement is: **a conservative estimate of text input tokens, under the stated
 * assumption, and not a guarantee about the invoice.** This function is named for what it computes.
 *
 * ── WHY THE CEILING IS STILL SAFE WITHOUT THAT GUARANTEE ───────────────────
 *
 * Because the per-call figure is not the control. Three things are, and they do not depend on this
 * estimate being right:
 *
 *   • the OBJECTIVE ceiling is enforced on MEASURED costs from the provider's own usage block, so
 *     an under-estimated call still consumes its real cost against the budget once settled;
 *   • settlement corrects the hold downward to that measured cost, and `cost_known: false` settles
 *     with no figure rather than zero;
 *   • an unresolved charge keeps counting with no window (§4b), so the failure mode of a wrong
 *     estimate is a budget that refuses EARLIER than necessary, not one that over-spends.
 *
 * The one thing this estimate must not do is be systematically too low, because the hold is taken
 * before the call. That is why every term rounds against us, and why a request growing a field it
 * does not serialize here would be a real defect — which is what `buildRequestBody` prevents by
 * being the same function that builds what is sent.
 *
 * The live-model procedure (docs/office/live-model-verification-procedure.md) reconciles held
 * against measured per call, with the inequality as an abort condition. Until that has run, this
 * is an argued estimate and not a measured one.
 */
function maxInputTokens(body) {
  return Buffer.byteLength(JSON.stringify(body), 'utf8');
}

// ── C1: UNKNOWN COST IS NOT ZERO ────────────────────────────────────────────
//
// This returned 0 when `usage` was absent. A $100/day budget built on that would treat every call
// it could not measure as FREE, which is the one thing the budget exists to prevent — and it would
// do so silently, because $0.00 looks like a successful measurement of a cheap call.
//
// Three states, kept distinct:
//   • usage present            → costUsd computed,     costKnown true  (may legitimately be 0)
//   • no call was attempted    → costUsd 0,            costKnown true  (nothing was spent)
//   • call attempted, no usage → costUsd null,         costKnown FALSE (tokens may have been spent)
//
// A REAL zero and an UNKNOWN must stay distinguishable: a prompt that returns no output tokens
// genuinely costs the input tokens and nothing more, and that is a measurement, not an absence.
function costOf(usage, model) {
  if (!usage) return { costUsd: null, costKnown: false };
  const [inR, outR] = ratesFor(model);
  return {
    costUsd: (usage.input_tokens || 0) * inR + (usage.output_tokens || 0) * outR,
    costKnown: true,
  };
}

// Nothing left this process, so nothing was spent. Distinct from "we could not tell".
const COST_NONE = Object.freeze({ costUsd: 0, costKnown: true });
// The request went out and we never learned what it consumed.
const COST_UNKNOWN = Object.freeze({ costUsd: null, costKnown: false });

// ── C2: EVERY AUTONOMOUS PROVIDER REQUEST HAS A FINITE UPPER BOUND ──────────
//
// AI_PROVIDER_FABRIC.md named this the dangerous omission: "Every AI call in the system can hang
// indefinitely, inside a cron that has no timeout either, with withAlerts only firing on a throw.
// A hung Claude call is invisible to every monitor in the system." The K4 reaper now reclassifies
// such a run — but a reaper should not be how a hung LLM call terminates.
//
// 120s per the fabric's own target, not outbound/http.js's 15s: that bound is right for a JSON API
// and wrong for a generation. The AbortController MECHANISM is adopted from there rather than a
// second timeout primitive being invented.
//
// A caller may raise or lower it with justification, but it can never be removed: 0, null,
// Infinity and negatives all resolve to the default, because "unbounded" is not a policy an
// autonomous kernel may express.
const DEFAULT_LLM_TIMEOUT_MS = 120000;
const MIN_LLM_TIMEOUT_MS = 1000;
function boundedTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LLM_TIMEOUT_MS;
  return Math.max(MIN_LLM_TIMEOUT_MS, Math.floor(n));
}

// ── C4: CAPABILITY ALIASES (AI_PROVIDER_FABRIC.md step 3) ───────────────────
//
// The fabric measured the consequence of literal pins: four model families across nineteen call
// sites, TWO OF THEM STALE, and llm.js silently billing any unrecognised id at opus rates — so a
// drifted pin is also a mispriced one. An alias means a pin change edits one line.
//
// The literal id is still returned in the result so a past decision stays explicable, exactly as
// the fabric requires.
//
// HONEST LIMIT ON THESE PINS: only `claude-haiku-4-5-20251001` has production evidence behind it
// (it is the id in the platform's own integration record). The other two are carried over from
// existing call sites and are NOT verified here — nothing in this repository validates a model id,
// and a wrong one fails silently. The kernel therefore defaults to `fast`.
const MODEL_ALIASES = Object.freeze({
  fast: 'claude-haiku-4-5-20251001',
  balanced: 'claude-sonnet-5',
  deep: 'claude-opus-4-8',
});
function resolveModel(model) {
  if (!model) return null;
  return MODEL_ALIASES[model] || String(model);
}

async function callClaude({ model, system, prompt, maxTokens, expectJson = false,
  apiKey = process.env.ANTHROPIC_API_KEY, timeoutMs } = {}) {
  if (!model) return { error: 'model is required', ...COST_NONE };
  const resolvedModel = resolveModel(model);
  if (!apiKey) return { error: 'ANTHROPIC_API_KEY not configured', model: resolvedModel, ...COST_NONE };

  // ── THE KILL SWITCH — THINKING, NOT ACTING ───────────────────────────────
  //
  // Checked as NON-consequential, which has two consequences that are the point of the design:
  //
  //   1. A global stop does not halt reasoning. "Stop every external action but keep analysing what
  //      happened" has to be expressible, and it would not be if a global stop silenced the
  //      analysis needed to understand the incident that caused it.
  //   2. Kill-state being unreadable does not halt reasoning either. An LLM call has no effect
  //      outside this process; refusing it during a database blip would take out diagnosis for no
  //      safety gain.
  //
  // `llm.call` remains independently stoppable, so spend or a misbehaving prompt loop can still be
  // cut. Spend CEILINGS are P0.9 and deliberately not here.
  try {
    const { checkStopped, recordRefusal } = require('./autonomy');
    const blocked = await checkStopped({ capability: 'llm.call' }, { consequential: false });
    if (blocked) {
      const reason = `STOPPED_BY_POLICY: ${blocked.scope_type}`
        + `${blocked.scope_key ? `:${blocked.scope_key}` : ''} — ${blocked.reason}`;
      console.warn(`[STOPPED_BY_POLICY] llm.call (${resolvedModel}): ${reason}`);
      recordRefusal({ stop: blocked, what: 'llm.call', detail: { model: resolvedModel } });
      // Nothing left the process, so cost is a known zero rather than an unknown.
      return { error: reason, stopped: true, model: resolvedModel, ...COST_NONE };
    }
  } catch (_) {
    // Read-only: a broken switch does not block thinking. Deliberate, and the inverse of mailer.js.
  }

  // ONE BUILDER, so the body that is SENT and the body that is MEASURED for the spend ceiling
  // cannot drift. This was inline here, and office/ai.js estimated the token count from
  // `system.length + prompt.length` — a second, looser expression of the same request. Two
  // expressions of "what is being sent" is how a ceiling stops covering the thing it bounds, which
  // is the defect this repository has already recorded about approval digests.
  const reqBody = buildRequestBody({ model: resolvedModel, system, prompt, maxTokens });

  const bound = boundedTimeout(timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), bound);

  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });
  } catch (e) {
    // An abort and a network failure are reported differently on purpose: `timedOut` is what a
    // caller keys off to decide whether the provider may still be working on the request, and a
    // timeout is the one failure where tokens were plausibly consumed with no usage returned.
    const aborted = e && (e.name === 'AbortError' || controller.signal.aborted);
    clearTimeout(timer);
    return aborted
      ? { error: `Claude request aborted after ${bound}ms (provider did not respond)`,
          timedOut: true, timeoutMs: bound, model: resolvedModel, ...COST_UNKNOWN }
      : { error: 'Claude request failed: ' + (e && e.message ? e.message : String(e)),
          model: resolvedModel, ...COST_UNKNOWN };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    // The request reached the provider; it may have consumed tokens before failing.
    return { error: `Claude ${res.status}: ${String(t).slice(0, 200)}`, status: res.status,
      model: resolvedModel, ...COST_UNKNOWN };
  }

  let body;
  try { body = await res.json(); }
  catch (e) {
    return { error: 'Claude response not JSON: ' + (e && e.message ? e.message : String(e)),
      model: resolvedModel, ...COST_UNKNOWN };
  }

  const text = extractClaudeText(body);
  const usage = body.usage || null;
  const cost = costOf(usage, model);          // rates resolve on the ALIAS-OR-LITERAL the caller gave
  const out = { text, usage, model: resolvedModel, timeoutMs: bound, ...cost };
  if (expectJson) out.json = parseClaudeJSON(text); // null (not an error) when unparseable
  return out;
}

module.exports = {
  DEFAULT_LLM_TIMEOUT_MS, MIN_LLM_TIMEOUT_MS, boundedTimeout,
  MODEL_ALIASES, resolveModel, COST_NONE, COST_UNKNOWN,
  callClaude, costOf, ratesFor, buildRequestBody, maxInputTokens,
  ANTHROPIC_URL, ANTHROPIC_VERSION };
