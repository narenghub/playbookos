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
function costOf(usage, model) {
  if (!usage) return 0;
  const [inR, outR] = ratesFor(model);
  return (usage.input_tokens || 0) * inR + (usage.output_tokens || 0) * outR;
}

async function callClaude({ model, system, prompt, maxTokens, expectJson = false, apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  if (!model) return { error: 'model is required' };
  if (!apiKey) return { error: 'ANTHROPIC_API_KEY not configured' };

  const reqBody = {
    model,
    max_tokens: maxTokens || 1024,
    messages: [{ role: 'user', content: String(prompt == null ? '' : prompt) }],
  };
  if (system) reqBody.system = system; // omitted when absent → identical to a no-system call

  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify(reqBody),
    });
  } catch (e) {
    return { error: 'Claude request failed: ' + (e && e.message ? e.message : String(e)) };
  }

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { error: `Claude ${res.status}: ${String(t).slice(0, 200)}` };
  }

  let body;
  try { body = await res.json(); }
  catch (e) { return { error: 'Claude response not JSON: ' + (e && e.message ? e.message : String(e)) }; }

  const text = extractClaudeText(body);
  const usage = body.usage || null;
  const out = { text, usage, costUsd: costOf(usage, model) };
  if (expectJson) out.json = parseClaudeJSON(text); // null (not an error) when unparseable
  return out;
}

module.exports = { callClaude, costOf, ratesFor, ANTHROPIC_URL, ANTHROPIC_VERSION };
