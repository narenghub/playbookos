// ── EVERY MODEL CALL, METERED AND ATTRIBUTED ─────────────────────────────────
//
//   meteredCall({ agent, workflow, model, prompt, system, maxTokens, expectJson })
//
// One chokepoint between this platform's agents and the Anthropic API. It calls
// llm.callClaude and records what the call cost, who spent it and whether it worked.
//
// ── WHAT WAS ACTUALLY WRONG, WHICH IS MORE THAN COST ─────────────────────────
//
// Eight agents — sales, procurement, inquiry, reorder, research, growth, email-engine and meet —
// each carried their own 12-line `callClaude` that fetched api.anthropic.com directly. They were
// near-identical copies, and every one of them bypassed the whole of llm.js:
//
//   • THE KILL SWITCH. llm.callClaude checks `llm.call` against autonomy.checkStopped. Eight
//     agents were outside it, so stopping LLM spend stopped three callers and left eight running.
//     That is the part of this that is a safety defect rather than an accounting one.
//   • THE TIMEOUT. A direct fetch with no AbortController waits as long as the provider takes. A
//     cron that hangs on one request does not finish, and the next one starts behind it.
//   • COST. No usage was read, so nothing could be counted. 42 crons, no figure anywhere.
//   • THE FAILURE SHAPES. A timeout and a network error were indistinguishable, and a timeout is
//     the one failure where tokens were plausibly spent for nothing.
//
// So this is not a reporting feature with a safety side effect; it is the reverse.
//
// ── IT NEVER THROWS, AND NEITHER DOES THE RECORDING ──────────────────────────
//
// llm.callClaude returns `{ error }` rather than throwing, and every caller here is a cron in the
// middle of work. That contract is preserved exactly: meteredCall returns whatever callClaude
// returned, untouched.
//
// The spend write is wrapped separately and can only ever log. An unwritable ledger must not take
// down the agent whose spend it was recording — losing the measurement is bad, losing the briefing
// is worse. But it is NOT silent: mailer.js's post-mortem is the standing argument here ("every
// layer did the right local thing and the aggregate was silence"), so a failed write prints a
// findable line naming the agent and the reason.

'use strict';

const llm = require('./llm');

// Resolved lazily so this module can be required by tests that have no database.
let _query = null;
function q(deps) {
  if (deps && deps.query) return deps.query;
  if (!_query) _query = require('./db').query;
  return _query;
}

/**
 * Record one model call. Returns true if the row landed.
 *
 * NEVER THROWS. Reports, and lets the caller carry on.
 */
async function recordSpend(row, deps = {}) {
  try {
    await q(deps)(
      `INSERT INTO llm_spend_log
         (agent, workflow, provider, model, tokens_input, tokens_output,
          cost_usd, cost_known, ok, error, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [row.agent, row.workflow || null, row.provider || 'anthropic', row.model,
        row.tokensInput ?? null, row.tokensOutput ?? null,
        // The database CHECK refuses a row that claims a cost it does not know, and refuses one
        // that carries a cost while claiming not to. Normalised here so a caller cannot produce
        // the forbidden pair and lose the row to a constraint violation.
        row.costKnown ? (row.costUsd ?? 0) : null,
        Boolean(row.costKnown),
        row.ok !== false, row.error ? String(row.error).slice(0, 500) : null,
        row.durationMs ?? null]
    );
    return true;
  } catch (e) {
    console.error(`[SPEND UNRECORDED] ${row.agent}/${row.workflow || 'unlabelled'} `
      + `· ${row.model} · ${e && e.message ? e.message : e}`);
    return false;
  }
}

/**
 * Call the model and record what it cost.
 *
 * `agent` is REQUIRED and has no default. A ledger whose rows say "unknown" answers the total but
 * not the only question a total provokes, which is where the money went.
 *
 * Returns llm.callClaude's result unchanged — `{ text, json, usage, costUsd, costKnown, error }`.
 */
async function meteredCall({ agent, workflow = null, ...spec }, deps = {}) {
  if (!agent) throw new Error('meteredCall requires an `agent`: unattributed spend is a number nobody can act on');
  if (!spec.model) throw new Error('meteredCall requires a `model`: llm.js has no default on purpose');

  const started = Date.now();
  const res = await llm.callClaude(spec);
  const durationMs = Date.now() - started;

  // `stopped` is a refusal by the kill switch — nothing left the process, so it is a KNOWN zero
  // rather than an unknown. It is still recorded: a stop that silently produced no evidence would
  // make "spend went to zero" and "the agents stopped running" look identical in this table.
  await recordSpend({
    agent,
    workflow,
    model: llm.resolveModel(spec.model),
    tokensInput: res.usage ? res.usage.input_tokens : null,
    tokensOutput: res.usage ? res.usage.output_tokens : null,
    costUsd: res.costUsd,
    costKnown: res.costKnown !== false,
    ok: !res.error,
    error: res.error,
    durationMs,
  }, deps);

  return res;
}

module.exports = { meteredCall, recordSpend };
