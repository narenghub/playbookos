// ── DISPATCH, BOUNDED — AND THE ONE THING IT WILL NOT DO ────────────────────
//
// M7.4. Resolves a task TYPE to a handler this build already contains, runs it under a deadline and
// an abort signal, validates its output, bounds its size, and returns a verdict.
//
// ── THE DISPATCH TABLE IS A CLOSED OBJECT, NOT A LOOKUP PATH ────────────────
//
// HANDLERS is a frozen map from type name to an already-required module. There is no
// `require(payload.module)`, no `require('./handlers/' + type)`, no eval, no Function constructor
// and no shell. A dynamic require built from a task field would turn the allowlist into a
// suggestion: `../../../something` is a valid string.
//
// A type present in the server's registry but absent here is refused as `no_handler` rather than
// attempted. The two lists are allowed to disagree — a type can be declared before it is
// implemented — and the disagreement must be a refusal, not an improvisation.
//
// ── AMBIGUITY IS NEVER RESOLVED BY RUNNING IT AGAIN ─────────────────────────
//
// The executor runs a handler AT MOST ONCE per lease. There is no retry here at any level, and
// that is the whole reason this file is separate from the client: the client retries network calls,
// which is safe, and must never be able to retry an execution, which is not.
//
// If a handler throws, the verdict is FAILED — a known outcome, reportable. If it is aborted, the
// verdict is ABORTED and the client stops touching the task. Neither is retried.
//
// ── THE CLIENT'S DEADLINE IS TIGHTER THAN THE SERVER'S CEILING ──────────────
//
// The server abandons a lease past its ceiling. If the worker used the same number it would still
// be running at the moment the server declared its outcome unknown, and would then try to report
// against an abandoned lease — producing an avoidable NEEDS_RESOLUTION every time a task ran long.
// So the client's deadline is a fraction of the ceiling, leaving room to abort, validate and
// report inside the window the server is still listening.

'use strict';

const TYPES = require('../lib/worker/task-types');

const HANDLERS = Object.freeze({
  'synthetic.echo': require('./handlers/synthetic-echo'),
});

/** Output larger than this is refused rather than submitted. */
const MAX_OUTPUT_BYTES = 64 * 1024;

/** Of a lease's ceiling, how much the worker will actually use before aborting itself. */
const DEADLINE_FRACTION = 0.8;

const VERDICT = Object.freeze({
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  ABORTED: 'ABORTED',
});

function handlerFor(taskType) {
  if (!TYPES.isKnown(taskType)) return { handler: null, code: 'unknown_task_type' };
  if (!Object.prototype.hasOwnProperty.call(HANDLERS, taskType)) {
    return { handler: null, code: 'no_handler' };
  }
  const h = HANDLERS[taskType];
  if (!h || typeof h.run !== 'function' || typeof h.validateOutput !== 'function') {
    return { handler: null, code: 'malformed_handler' };
  }
  return { handler: h, code: null };
}

function deadlineMsFor(taskType, { leaseExpiresInMinutes = null } = {}) {
  const ceilingMinutes = Number.isFinite(leaseExpiresInMinutes)
    ? leaseExpiresInMinutes : TYPES.ceilingFor(taskType);
  return Math.max(1_000, Math.floor(ceilingMinutes * 60_000 * DEADLINE_FRACTION));
}

/**
 * Runs one task, once.
 *
 * @returns {{verdict, output?, error?, code?, reason?, ms}}
 *   SUCCEEDED → output has been validated and is within bounds, and may be submitted
 *   FAILED    → a known failure. Reportable; the server records it and the task is FAILED
 *   ABORTED   → cancelled, deadline reached, or ownership lost. The client reports NOTHING and
 *               leaves the outcome to the server's own expiry handling
 */
async function execute({
  taskType, payload = {}, leaseExpiresInMinutes = null, signal = null,
} = {}) {
  const started = Date.now();
  const ms = () => Date.now() - started;

  const { handler, code } = handlerFor(taskType);
  if (!handler) {
    // Refused BEFORE anything runs. A type nobody implemented is not a thing to improvise.
    return { verdict: VERDICT.FAILED, code, ms: ms(),
      error: code === 'unknown_task_type'
        ? `'${taskType}' is not in the task-type allowlist`
        : `'${taskType}' is allowlisted but this build contains no handler for it` };
  }

  // One controller, aborted by whichever comes first: the caller's signal or our own deadline.
  const ac = new AbortController();
  const deadline = deadlineMsFor(taskType, { leaseExpiresInMinutes });
  let deadlineHit = false;
  const timer = setTimeout(() => { deadlineHit = true; ac.abort(); }, deadline);
  const onOuter = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onOuter, { once: true });
  }

  let out;
  try {
    out = await handler.run(payload, { signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuter);
    if (ac.signal.aborted || e.aborted || e.name === 'Aborted' || e.name === 'AbortError') {
      return { verdict: VERDICT.ABORTED, ms: ms(),
        reason: deadlineHit ? `the worker's own deadline of ${deadline}ms was reached` : 'cancelled' };
    }
    // A thrown handler is a KNOWN outcome: it did not succeed, and saying so is not a guess.
    return { verdict: VERDICT.FAILED, code: 'handler_threw', error: String(e && e.message).slice(0, 500), ms: ms() };
  }
  clearTimeout(timer);
  if (signal) signal.removeEventListener('abort', onOuter);

  // A handler that returned after the abort still does not get to report. Whether its work
  // completed is exactly the ambiguity cancellation creates, and inventing a success here is the
  // defect this whole milestone keeps circling.
  if (ac.signal.aborted) {
    return { verdict: VERDICT.ABORTED, ms: ms(),
      reason: deadlineHit
        ? `the handler returned after the ${deadline}ms deadline; its outcome is not claimed`
        : 'cancelled while the handler was returning' };
  }

  const problems = handler.validateOutput(out);
  if (problems && problems.length) {
    return { verdict: VERDICT.FAILED, code: 'invalid_output', ms: ms(),
      error: `the handler's output did not validate: ${problems.join('; ')}` };
  }

  let serialised;
  try { serialised = JSON.stringify(out); } catch (e) {
    return { verdict: VERDICT.FAILED, code: 'unserialisable_output', ms: ms(), error: e.message };
  }
  const bytes = Buffer.byteLength(serialised, 'utf8');
  if (bytes > MAX_OUTPUT_BYTES) {
    // Reported as a failure with the size, not truncated. A truncated result that looks like a
    // result is worse than a failure that says why.
    return { verdict: VERDICT.FAILED, code: 'output_too_large', ms: ms(),
      error: `output is ${bytes} bytes; the limit is ${MAX_OUTPUT_BYTES}` };
  }

  return { verdict: VERDICT.SUCCEEDED, output: out, bytes, ms: ms() };
}

/** Static self-description, used by the diagnostic command and by the tests. */
function capabilities() {
  return {
    implemented: Object.keys(HANDLERS).sort(),
    declaredButNotImplemented: TYPES.KNOWN.filter((t) => !HANDLERS[t]).sort(),
    maxOutputBytes: MAX_OUTPUT_BYTES,
    deadlineFraction: DEADLINE_FRACTION,
  };
}

module.exports = {
  execute, handlerFor, deadlineMsFor, capabilities,
  HANDLERS, VERDICT, MAX_OUTPUT_BYTES, DEADLINE_FRACTION,
};
