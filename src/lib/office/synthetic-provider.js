// ── THE SYNTHETIC PROVIDER SEAM (B2.10 stage 4) ─────────────────────────────
//
// Owner's approval, 2026-11-26: *"The three development decisions are approved under the conditions
// previously specified"* — the second of which was a synthetic provider injection seam for B2.10
// stage 4. And requirement 6: *"For B2.10, demonstrate the complete connected eleven-stage workflow
// after implementing the synthetic provider seam. Eleven independently passing stages are not
// sufficient if the actual workflow cannot traverse them consecutively."*
//
// ── WHAT WAS STOPPING THE WORKFLOW ─────────────────────────────────────────
//
// Stage 4 is `renderGovernedRFQ`, which calls `office/ai.js governedCall`, which calls
// `llm.callClaude`. There is no key in development and paid provider execution is not authorized,
// so stage 4 halted and stages 5-11 were only ever demonstrated independently, each from a fixture
// standing in for the previous stage's output. That is eleven passing stages and no workflow, and
// the difference is exactly what requirement 6 names.
//
// ── WHY A NAMED RESPONDER AND NOT AN INJECTED FUNCTION ─────────────────────
//
// The obvious seam is `deps.callProvider = async (req) => ...`, and it is the wrong one. The
// standing instruction is *"Do not permit arbitrary agent-generated code execution"*, and a
// function-shaped seam is precisely a place where a value that came from a plan, a memory or a
// model could become code. A plan is data; data must not be able to name a function.
//
// So the seam is a BOOLEAN that selects a responder written here, in the repository, reviewed:
//
//     governedCall(ctx, spec, { syntheticProvider: true })
//
// `true` is the only accepted value. An object, a function, a string naming a module — all refused.
// What runs is the code below and nothing else, so the worst a compromised caller can do is get a
// deterministic canned answer on a development database.
//
// ── AND WHY IT CANNOT RUN IN PRODUCTION ────────────────────────────────────
//
// The conditions are B3.20's, deliberately: the same shape, for the same reason, and the module
// that owns them is reused rather than copied. Non-production environment, and a database that is
// identifiably development or a disposable test cluster. A refusal is a refusal — `governedCall`
// does NOT fall back to the real provider, because a seam that silently becomes a paid call when
// its gate declines is worse than no seam.
//
// ── THE OUTPUT CAN NEVER BE MISTAKEN FOR A MODEL'S ─────────────────────────
//
// Every response carries `provider: 'synthetic'`, `synthetic: true`, and a `SYNTHETIC` marker
// inside the text itself. The provenance row, the cost ledger and anything reading the result see
// a different provider from `anthropic`, so a synthetic run cannot be reported later as a live
// model verification — which is a thing this project has an open requirement about, and the one
// way this seam could do real damage.
//
// Cost is $0 and `costKnown: true`, which is honest and is NOT the "failed therefore free"
// assumption: no request was dispatched, and that is evidence rather than an inference. The
// evidence string is returned so the settlement can record it.

'use strict';

const crypto = require('crypto');

/** The provider string. Deliberately not 'anthropic'. */
const SYNTHETIC_PROVIDER = 'synthetic';

/** The marker that appears in every synthetic response body. */
const MARKER = '[SYNTHETIC-DEV-RESPONSE]';

const REFUSAL = Object.freeze({
  NOT_TRUE: 'synthetic_provider_must_be_exactly_true',
  PRODUCTION_ENV: 'node_env_is_production',
  NOT_DEVELOPMENT_DB: 'database_is_not_identifiably_development',
  DB_UNKNOWABLE: 'database_identity_could_not_be_established',
});

/**
 * May this call use the synthetic responder?
 *
 * Reuses `business-day-override.js`'s database conditions rather than restating them: there is one
 * answer to "is this a development database" in this repository and a second copy would be a
 * second thing to keep correct.
 *
 * @returns {Promise<{allowed:boolean, reason?:string, detail:string}>}
 */
async function authorizeSyntheticProvider(flag, { env = process.env, query = null } = {}) {
  // EXACTLY true. `'true'`, `1`, `{}` and a function are all refused, and the refusal names the
  // reason rather than coercing — a truthy value arriving from JSON is the shape that turns a
  // boolean seam back into an arbitrary one.
  if (flag !== true) {
    return { allowed: false, reason: REFUSAL.NOT_TRUE,
      detail: `syntheticProvider must be the boolean true, not ${typeof flag}: a seam that accepts `
        + 'any truthy value accepts a value that came from data, and a function-shaped seam is a '
        + 'place where data becomes code' };
  }

  if (String(env.NODE_ENV) === 'production') {
    return { allowed: false, reason: REFUSAL.PRODUCTION_ENV,
      detail: 'NODE_ENV=production: a synthetic response must never enter a production run, '
        + 'because a run that executed against a canned answer and a run that executed against a '
        + 'model are indistinguishable afterwards unless the provenance says so — and by then the '
        + 'decision has been made' };
  }

  const OVERRIDE = require('./business-day-override');
  const q = query || require('../db').query;

  let disposable = { yes: false, detail: 'not asked' };
  try {
    disposable = await OVERRIDE.isDisposableCluster(q);
  } catch (_) { /* falls through to the identity question, which refuses on failure */ }
  if (disposable.yes) {
    return { allowed: true, detail: `disposable test cluster (${disposable.detail})` };
  }

  const DI = require('../../../scripts/lib/db-identity');
  let id = null;
  try {
    id = await DI.identifyDatabase(q);
  } catch (e) {
    return { allowed: false, reason: REFUSAL.DB_UNKNOWABLE,
      detail: `the database could not be identified (${e.message}) — cannot_tell is a refusal, not `
        + 'permission' };
  }
  if (!id || id.verdict === DI.VERDICT.CANNOT_TELL) {
    return { allowed: false, reason: REFUSAL.DB_UNKNOWABLE,
      detail: `the database identity is ${id ? id.verdict : 'unavailable'}` };
  }
  if (id.verdict !== DI.VERDICT.DEVELOPMENT) {
    return { allowed: false, reason: REFUSAL.NOT_DEVELOPMENT_DB,
      detail: `the database identifies as ${id.verdict}` };
  }
  return { allowed: true, detail: 'development database, non-production environment' };
}

/**
 * The responder. Deterministic, shaped like `llm.callClaude`'s return, and obviously synthetic.
 *
 * ── WHY DETERMINISTIC ─────────────────────────────────────────────────────
 *
 * A stage that passes because the canned answer happened to parse, and fails tomorrow because a
 * random one did not, teaches nothing. The response is a pure function of the request, so a stage
 * that traverses once traverses every time — and a stage that fails fails for a reason in the code.
 *
 * ── WHY IT ANSWERS IN THE SHAPE THE CALLER ASKED FOR ──────────────────────
 *
 * `governedCall`'s callers parse what comes back. A responder that always returned the same string
 * would make stage 4 pass and stage 5 fail on a parse error that is the responder's fault, which
 * would send the next person looking in the wrong file. So when the request asks for JSON, the
 * answer is JSON — and the marker goes in a field rather than being dropped, so the provenance
 * survives parsing.
 */
function syntheticCall({ model, system = '', prompt = '', maxTokens = 0 } = {}) {
  const wantsJson = /\bJSON\b/.test(String(system)) || /\bJSON\b/.test(String(prompt));
  // A short stable digest of the request, so two different prompts give two different answers and
  // the same prompt always gives the same one.
  const digest = crypto.createHash('sha256')
    .update(`${model}\u0000${system}\u0000${prompt}`).digest('hex').slice(0, 12);

  const text = wantsJson
    ? JSON.stringify({
      synthetic: true,
      marker: MARKER,
      note: 'a deterministic development response. No provider was contacted and no model produced '
        + 'this. It exists so a workflow can traverse a governed call end to end.',
      digest,
      // Fields the kernel workflow's parsers look for, present so a downstream stage fails on its
      // own logic rather than on this responder's shape.
      summary: `${MARKER} synthetic summary ${digest}`,
      recommendation: `${MARKER} synthetic recommendation ${digest}`,
      items: [],
    })
    : `${MARKER} ${digest}\n\nThis is a deterministic development response. No provider was `
      + 'contacted and no model produced this text.';

  return {
    // The real transport returns the resolved literal id; there is no model here, so the field says
    // so rather than echoing a model name that nothing ran.
    model: `synthetic:${model || 'unspecified'}`,
    text,
    // ZERO, AND KNOWN, WITH EVIDENCE. Not the "failed therefore free" inference: no request was
    // dispatched, which is a fact about this process rather than a guess about a provider's billing.
    costUsd: 0,
    costKnown: true,
    zeroChargeEvidence: 'no request was dispatched: the synthetic responder in '
      + 'src/lib/office/synthetic-provider.js produced this response in-process, and the provider '
      + 'surface was never reached',
    usage: { input_tokens: 0, output_tokens: 0 },
    timedOut: false,
    timeoutMs: null,
    maxTokensRequested: maxTokens,
    synthetic: true,
    provider: SYNTHETIC_PROVIDER,
  };
}

module.exports = {
  SYNTHETIC_PROVIDER, MARKER, REFUSAL,
  authorizeSyntheticProvider, syntheticCall,
};
