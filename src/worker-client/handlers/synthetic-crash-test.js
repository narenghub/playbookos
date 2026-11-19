// ── A CRASH THE ACCEPTANCE RUN CAN CAUSE, RATHER THAN ASK FOR ───────────────
//
// M7.5 scenario 7 asks: when a worker dies holding a lease, is the lease recovered, is the task
// left in a correct terminal state, and is the work NOT silently re-executed?
//
// Twice — 2026-11-17 and 2026-11-18 — that scenario produced nothing, because the crash was a
// human typing `kill -9` at the right moment. On the 17th it never happened and the driver
// reported two FAILs for a crash that did not occur, one of which read as a serious correctness
// defect. On the 18th it happened 33 seconds early, during scenario 2, and six later scenarios
// failed for want of a worker. Both runs were worthless, and in opposite directions.
//
// The timing of a keystroke is not a test fixture. So the crash becomes a TASK: the worker leases
// it, and dying is what executing it means.
//
// ── WHY THIS IS NOT A REMOTE EXECUTION ENDPOINT ─────────────────────────────
//
// The owner's constraint was explicit: *"Do not create a general-purpose remote process execution
// endpoint."* This is not one, and the difference is structural rather than a matter of degree:
//
//   - The only action it can ever take is `kill(SIGKILL)` on its OWN pid. There is no command, no
//     argument, no path and no shell anywhere in this file. The payload cannot name a signal, a
//     process or anything else to act on.
//   - It is reached only through executor.js's frozen HANDLERS map, under a task type that has to
//     be in the closed registry. No dynamic require, same as every other handler.
//   - It refuses unless FOUR independent conditions hold, none of which is true by default, two of
//     which are set on the machine and two of which are in the task.
//
// ── THE FOUR GATES ──────────────────────────────────────────────────────────
//
//   1. PLAYNEXA_WORKER_ENV === 'development'
//        Set by `workerctl install --env development`, and ABSENT otherwise. An unstated
//        environment is treated as production, so a worker installed without the flag cannot do
//        this no matter what else is true. Note it is NOT derived from the API URL: the dev API's
//        own hostname is `m7-dev-worker-api-production.up.railway.app`, which contains the word
//        "production". A guard that inferred the environment from that string would be exactly
//        the kind of plausible-looking inference this repo keeps finding in its own code.
//
//   2. WORKER_ALLOW_CRASH_TEST === this worker's own WORKER_ID
//        Not a boolean. Arming is per-identity, so a variable left set on one machine cannot arm a
//        different worker, and re-enrolling (which changes the id) disarms it.
//
//   3. payload.confirm === 'crash-this-worker'
//        A task cannot arrive at this by accident or by a type confusion.
//
//   4. payload.workerId === this worker's own WORKER_ID
//        The task names which worker it is for. A crash task left in the queue — and queue
//        leftovers have already happened once, when a fresh identity inherited a previous run's
//        pending tasks — cannot take down the wrong worker.
//
// Any gate unmet is a thrown Error, which the executor turns into a FAILED verdict: reportable,
// visible, and NOT a crash. The driver reads that as "the handshake was refused" and marks the
// scenario UNTESTED rather than inventing a product failure.
//
// ── reexecutable: false ─────────────────────────────────────────────────────
//
// Declared in the registry, and it is the point of the scenario. The task's work is "die", whose
// completion can never be confirmed by the worker that did it — the textbook OUTCOME_UNKNOWN. The
// server must therefore resolve it without re-dispatching, and the scenario checks precisely that.

'use strict';

const CONFIRM_PHRASE = 'crash-this-worker';
const WORKER_ID_SHAPE = /^wkr_[0-9a-f]{32}$/;

/** Every refusal reason, as a code, so a test can assert on which gate stopped it. */
const REFUSED = Object.freeze({
  NOT_DEVELOPMENT: 'crash_test_refused: PLAYNEXA_WORKER_ENV is not "development"',
  NO_WORKER_ID: 'crash_test_refused: WORKER_ID is absent or malformed',
  NOT_ARMED: 'crash_test_refused: WORKER_ALLOW_CRASH_TEST is absent or malformed '
    + '(expected wkr_<32 hex>:<unix seconds>)',
  WRONG_WORKER_ARMED: 'crash_test_refused: WORKER_ALLOW_CRASH_TEST arms a different worker',
  EXPIRED: 'crash_test_refused: the arming window has expired',
  WINDOW_TOO_LONG: 'crash_test_refused: the arming deadline is more than a day away, so it is not '
    + 'a test window (a millisecond value mistaken for seconds looks exactly like this)',
  NOT_CONFIRMED: `crash_test_refused: payload.confirm must be "${CONFIRM_PHRASE}"`,
  WRONG_WORKER: 'crash_test_refused: payload.workerId names a different worker',
});

// ── ARMING EXPIRES BY THE CLOCK, NOT BY SOMEBODY REMEMBERING ────────────────
//
// The owner's requirement: *"The crash-test capability must be explicitly disarmed after testing,
// including on failure or interruption."*
//
// A runbook step cannot deliver that. A shell `trap` cannot either — it does not fire on a power
// cut, a kernel panic, or an operator closing the lid and going home, and this machine is meant to
// sit in an office running unattended. Anything that depends on a human completing a sequence has
// already failed the "or interruption" half of the requirement.
//
// So the arming variable carries a DEADLINE: `wkr_<32 hex>:<unix seconds>`. Past it the handler
// refuses, whatever else is true. An acceptance run that crashes, hangs, or is abandoned halfway
// leaves a worker that disarms itself — and a worker found armed days later cannot fire.
//
// A bare `wkr_<id>` with no deadline is REFUSED rather than treated as "armed forever". That form
// shipped briefly in cd5a748; failing closed on it means the upgrade cannot silently leave an
// unbounded arming behind.
const ARMED_SHAPE = /^(wkr_[0-9a-f]{32}):(\d{10,})$/;

// ── AND THE DEADLINE ITSELF IS BOUNDED ──────────────────────────────────────
//
// Found on 2026-11-19 by demonstrating the expiry rather than trusting the tests that covered it:
// `WORKER_ALLOW_CRASH_TEST=<id>:1763575000000` — a MILLISECOND value, which is what Date.now()
// returns and the obvious slip for anyone editing this by hand — matched `\d{10,}` and was read as
// epoch SECONDS. That is the year 58,000. The arming would never expire, which is the exact thing
// the deadline exists to prevent, arriving through the deadline itself.
//
// A tighter regex is not the fix: 10 digits reaches the year 2286, so `<id>:9999999999` would slip
// past any shape check while being just as unbounded in practice. The fix is semantic — a window
// longer than a day is not a test window, and the installer already refuses to WRITE one
// (`--crash-test=<minutes>` is capped at 1440). This refuses to HONOUR one, so a plist edited by
// hand, or written by an older version, cannot grant more than the installer would.
//
// The slack covers the gap between the installer computing the deadline and the worker reading it.
const MAX_ARMING_MS = (24 * 60 * 60 * 1000) + (5 * 60 * 1000);

/**
 * Decides, without doing anything. Separated from `run` so the decision is testable without a
 * process to kill, and so every gate can be exercised independently.
 *
 * @returns {{allowed: boolean, reason: string|null, workerId: string|null}}
 */
function decide(payload = {}, env = process.env, now = Date.now()) {
  const workerId = String(env.WORKER_ID || '');

  if (env.PLAYNEXA_WORKER_ENV !== 'development') {
    return { allowed: false, reason: REFUSED.NOT_DEVELOPMENT, workerId: null };
  }
  if (!WORKER_ID_SHAPE.test(workerId)) {
    return { allowed: false, reason: REFUSED.NO_WORKER_ID, workerId: null };
  }
  const armed = ARMED_SHAPE.exec(String(env.WORKER_ALLOW_CRASH_TEST || ''));
  if (!armed) {
    return { allowed: false, reason: REFUSED.NOT_ARMED, workerId: null };
  }
  if (armed[1] !== workerId) {
    return { allowed: false, reason: REFUSED.WRONG_WORKER_ARMED, workerId: null };
  }
  const deadlineMs = Number(armed[2]) * 1000;
  if (!Number.isFinite(deadlineMs) || now > deadlineMs) {
    return {
      allowed: false,
      reason: `${REFUSED.EXPIRED} (expired ${new Date(deadlineMs).toISOString()})`,
      workerId: null,
    };
  }
  if (deadlineMs - now > MAX_ARMING_MS) {
    return {
      allowed: false,
      reason: `${REFUSED.WINDOW_TOO_LONG} (deadline ${new Date(deadlineMs).toISOString()})`,
      workerId: null,
    };
  }
  if (payload.confirm !== CONFIRM_PHRASE) {
    return { allowed: false, reason: REFUSED.NOT_CONFIRMED, workerId: null };
  }
  if (payload.workerId !== workerId) {
    return { allowed: false, reason: REFUSED.WRONG_WORKER, workerId: null };
  }
  return { allowed: true, reason: null, workerId };
}

/**
 * @param {object} payload
 * @param {object} deps  signal, plus env/kill/log/pid for tests. Defaults are the real process.
 */
async function run(payload = {}, deps = {}) {
  const {
    env = process.env,
    kill = (pid, sig) => process.kill(pid, sig),
    pid = process.pid,
    now = Date.now(),
    log = (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
  } = deps;

  const verdict = decide(payload, env, now);
  if (!verdict.allowed) throw new Error(verdict.reason);

  // Written BEFORE dying, and flushed by the write itself, so the log carries proof that the crash
  // was this handshake rather than an unrelated fault. Without this line a reader cannot tell a
  // deliberate acceptance crash from a real one, which would make the log useless for exactly the
  // incident it is meant to document.
  log({
    ts: new Date().toISOString(),
    at: 'crash_test_self_kill',
    workerId: verdict.workerId,
    pid,
    signal: 'SIGKILL',
    note: 'M7.5 scenario 7 — deliberate, gated, self-inflicted. The lease is held at this moment.',
  });

  // The pid is this process's own, by construction — it is not read from the payload, the
  // environment or the network, and there is no code path here that could kill anything else.
  kill(pid, 'SIGKILL');

  // Unreachable in production use: SIGKILL cannot be caught, blocked or handled. Reached only in
  // tests, where `kill` is a stub. Returning a shape that fails validateOutput would be a
  // confusing second failure mode, so it returns the honest thing instead.
  await Promise.resolve();
  return { killed: false, workerId: verdict.workerId, note: 'SIGKILL did not take effect' };
}

function validateOutput(out) {
  if (out === null || typeof out !== 'object' || Array.isArray(out)) {
    return ['output must be a plain object'];
  }
  const problems = [];
  if (typeof out.killed !== 'boolean') problems.push('`killed` must be a boolean');
  if (out.killed === true) {
    // A worker that was SIGKILLed cannot report anything, so a result claiming the kill succeeded
    // is a contradiction and must not be storable.
    problems.push('a worker that was killed cannot report its own death');
  }
  return problems;
}

module.exports = {
  run, validateOutput, decide, CONFIRM_PHRASE, REFUSED, WORKER_ID_SHAPE, ARMED_SHAPE,
};
