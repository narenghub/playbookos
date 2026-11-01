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

  const reqBody = {
    model: resolvedModel,
    max_tokens: maxTokens || 1024,
    messages: [{ role: 'user', content: String(prompt == null ? '' : prompt) }],
  };
  if (system) reqBody.system = system; // omitted when absent → identical to a no-system call

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
  callClaude, costOf, ratesFor, ANTHROPIC_URL, ANTHROPIC_VERSION };
