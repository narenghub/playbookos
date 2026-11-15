// ── THE FIRST EXECUTABLE TASK ────────────────────────────────────────────────
//
// M7.4. `synthetic.echo` returns its own payload. It computes nothing useful on purpose: the point
// of the first executable task is to prove the round trip — claim, execute, cancel, report — with a
// task whose correctness nobody has to reason about.
//
// ── A HANDLER IS A PURE FUNCTION OF ITS INPUT PLUS A SIGNAL ──────────────────
//
// It receives the payload and an AbortSignal, and returns structured output. It gets no database
// handle, no credentials, no network client and no filesystem helper. Not because this particular
// task would misuse them, but because the handler signature is what the next ten tasks will be
// written against, and a signature that hands over a database connection is one where somebody
// eventually writes to it.
//
// ── IT MUST OBSERVE THE SIGNAL, NOT JUST ACCEPT IT ───────────────────────────
//
// A handler that takes a signal and never checks it is cooperative cancellation in name only. The
// executor enforces a hard deadline regardless, but that is a backstop: it can stop WAITING for a
// handler, it cannot stop the handler's own loop. So a handler that does any iterating must check
// `signal.aborted` between units of work, and this one does — including in the delay path, which is
// where a real task spends its time.

'use strict';

/** Hard ceiling on the payload this task will look at. Bigger inputs are refused, not truncated. */
const MAX_PAYLOAD_BYTES = 16 * 1024;

class Aborted extends Error {
  constructor() { super('aborted'); this.name = 'Aborted'; this.aborted = true; }
}

/** A sleep that actually wakes on abort rather than resolving late and checking afterwards. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Aborted());
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() { clearTimeout(t); reject(new Aborted()); }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    return undefined;
  });
}

/**
 * @param {object}      payload  the task's own payload, already parsed
 * @param {AbortSignal} signal   aborted on STOP, revocation, cancellation, lease loss or deadline
 * @returns {Promise<object>}    structured output; the executor validates and bounds it
 */
async function run(payload = {}, { signal } = {}) {
  const raw = JSON.stringify(payload || {});
  if (Buffer.byteLength(raw, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error(`payload is ${Buffer.byteLength(raw, 'utf8')} bytes; this task accepts at most ${MAX_PAYLOAD_BYTES}`);
  }

  // An optional delay exists so cancellation and deadlines can be exercised against a task that
  // actually takes time. Capped, because a handler should not be able to pin a worker for longer
  // than its type's ceiling by asking nicely in its payload.
  const requested = Number(payload.delayMs || 0);
  const delayMs = Math.max(0, Math.min(Number.isFinite(requested) ? requested : 0, 60_000));

  const steps = delayMs > 0 ? Math.max(1, Math.ceil(delayMs / 100)) : 0;
  for (let i = 0; i < steps; i++) {
    if (signal && signal.aborted) throw new Aborted();
    await sleep(Math.min(100, delayMs - (i * 100)), signal);
  }
  if (signal && signal.aborted) throw new Aborted();

  return {
    echoed: payload,
    steps,
    // Deliberately no timestamps, hostnames, usernames or paths. Output travels to the server and
    // is readable by anyone debugging a worker; a handler that casually includes the machine's
    // hostname has made every result mildly identifying for no benefit.
  };
}

/**
 * Structured output validation, declared next to the handler that produces it. The executor refuses
 * to submit output that fails this, because the alternative is a server storing whatever shape a
 * buggy handler happened to return and a reader later trusting it.
 */
function validateOutput(out) {
  const problems = [];
  if (out === null || typeof out !== 'object' || Array.isArray(out)) {
    return ['output must be a plain object'];
  }
  if (!Object.prototype.hasOwnProperty.call(out, 'echoed')) problems.push('missing `echoed`');
  if (!Number.isInteger(out.steps) || out.steps < 0) problems.push('`steps` must be a non-negative integer');
  for (const k of Object.keys(out)) {
    if (!['echoed', 'steps'].includes(k)) problems.push(`unexpected key \`${k}\``);
  }
  return problems;
}

module.exports = { run, validateOutput, MAX_PAYLOAD_BYTES, Aborted, sleep };
