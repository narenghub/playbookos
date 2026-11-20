// ── THE WORKER CLIENT — OUTBOUND ONLY, AND IT NEVER RE-EXECUTES ─────────────
//
// M7.4. Polls the M7.3 API, executes one task at a time, heartbeats while it does, and reports.
// It opens no listening socket: every connection is outbound, which is what lets the machine sit
// behind a router with no port forwarded and no inbound rule.
//
// ── THE DISTINCTION THE WHOLE FILE TURNS ON ─────────────────────────────────
//
// Retrying a NETWORK CALL is safe. Retrying an EXECUTION is not.
//
//   claim        retried. Nothing has happened yet.
//   heartbeat    retried. It asserts liveness; a lost one costs nothing but lease time.
//   status       retried. Read-only.
//   result       retried — and this is the subtle one. Submission is idempotent on the server by
//                run_id, so re-sending a result the server may already have recorded is safe and
//                is the right thing to do after a timeout. It re-sends the SAME result; it does
//                not re-run the task to obtain a new one.
//
//   execution    NEVER retried, at any level, for any reason.
//
// If a task ran and its result could not be delivered, the outcome is UNCERTAIN: it may have
// completed, and the server may or may not know. The client records that locally and stops. It
// does not run the task again, and it does not report a guess. The server's own expiry handling
// moves the task to NEEDS_RESOLUTION, which is the truthful state.
//
// ── LOST CONNECTIVITY IS UNCERTAINTY, NOT PERMISSION ────────────────────────
//
// A worker whose heartbeats stop landing does not know whether it still holds the lease — the
// server may have abandoned it, and a human may already be acting on "outcome unknown". Continuing
// to execute on the assumption that the lease is fine is how two workers end up doing one task.
//
// So after HEARTBEAT_FAILURE_LIMIT consecutive failures the client ABORTS the running task and
// treats the outcome as uncertain. It is the pessimistic choice and it is the cheap one: the work
// can be re-authorised by a human, whereas a duplicate effect cannot be un-done.

'use strict';

const crypto = require('crypto');
const AUTH = require('../lib/worker/auth');
const EXEC = require('./executor');

const DEFAULTS = Object.freeze({
  idlePollMs: 5_000,
  maxAttempts: 5,
  baseBackoffMs: 500,
  maxBackoffMs: 30_000,
  heartbeatFailureLimit: 3,
  requestTimeoutMs: 15_000,
});

const freshNonce = () => crypto.randomBytes(16).toString('hex');

/**
 * Full jitter, not a fixed multiplier. With a fixed schedule, N workers that lose connectivity at
 * the same moment retry in lockstep for ever and arrive together each time — a thundering herd the
 * backoff was supposed to prevent. `random() * cap` decorrelates them.
 */
function backoffMs(attempt, { baseBackoffMs, maxBackoffMs }) {
  const cap = Math.min(maxBackoffMs, baseBackoffMs * (2 ** Math.max(0, attempt - 1)));
  return Math.floor(Math.random() * cap);
}

// ── A REVOKED CREDENTIAL IS NOT A TRANSIENT FAILURE ─────────────────────────
//
// Measured on 2026-11-20, 50 minutes after M7.5 scenario 8 revoked the office iMac's identity:
//
//     outcome  code       rows  last
//     DENIED   revoked    574   2026-11-20T20:28:19.933Z
//
// The client had retried every ~5s for an hour and would have continued for ever — roughly 690
// audit rows per hour, for a credential that cannot come back without a human minting a new token
// and enrolling it. `callWithRetry` already knows not to retry a 4xx decision, but the SERVICE
// LOOP retried the whole cycle regardless, which is the same mistake one level up.
//
// So this code is terminal: the loop stops. The process then exits ZERO, which matters, because
// `KeepAlive { SuccessfulExit false }` relaunches a non-zero exit and leaves a zero exit alone.
// Exiting non-zero here would turn a retry loop into a respawn loop at 1/minute.
//
// ONLY `revoked` is listed. `unknown_worker` and `bad_signature` are arguably terminal too, but a
// list is a decision about each member: those two are left to retry deliberately, because the one
// that is certain is enough to fix the measured defect, and widening it without evidence is how a
// worker ends up refusing to start over something transient. Recorded as a follow-up instead.
const TERMINAL_AUTH_CODES = Object.freeze(['revoked']);

/** Syntactically valid, cannot exist. Used by the auth probe so it cannot touch real work. */
const NIL_RUN_ID = '00000000-0000-0000-0000-000000000000';

class WorkerClient {
  constructor({
    baseUrl, workerId, secret, fetchImpl = null, log = null, now = null, sleep = null, ...opts
  } = {}) {
    if (!baseUrl) throw new Error('a base URL is required');
    if (!workerId) throw new Error('a worker id is required');
    if (!secret) throw new Error('a worker secret is required');

    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.workerId = workerId;
    // Held in memory only. Never logged, never serialised, never placed in an error message.
    this._secret = secret;
    this.cfg = { ...DEFAULTS, ...opts };
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.now = now || (() => Date.now());
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = log || (() => {});
    this.stopped = false;
    /** Locally recorded uncertainty. Never resolved by guessing; surfaced by the diagnostic. */
    this.unresolved = [];
    /** Set when a refusal arrives that retrying cannot fix. Stops the loop; see TERMINAL_AUTH_CODES. */
    this.terminal = null;
  }

  /** One signed request. No retry here — retry policy belongs to the caller, per-operation. */
  async call(method, path, body = undefined) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const parts = {
      workerId: this.workerId,
      method,
      path,
      timestamp: String(this.now()),
      // A FRESH nonce on every single request, including every retry. Reusing one on a retry
      // would be indistinguishable from a replay and would be refused as one.
      nonce: freshNonce(),
      body: raw,
    };
    const headers = AUTH.signRequest(this._secret, parts);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.cfg.requestTimeoutMs);
    try {
      const res = await this.fetch(this.baseUrl + path, {
        method,
        headers: { ...headers, ...(raw ? { 'content-type': 'application/json' } : {}) },
        body: raw || undefined,
        signal: ac.signal,
      });
      let json = null;
      try { json = await res.json(); } catch (_) { json = null; }
      return { status: res.status, json, transportError: null };
    } catch (e) {
      // A transport failure is NOT a refusal. The difference matters: a 409 means the server
      // decided, a timeout means nobody knows.
      return { status: 0, json: null, transportError: String(e && e.message).slice(0, 200) };
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Retries transport failures and 5xx only. A 4xx is a DECISION — refused, stopped, revoked,
   * replayed — and retrying a decision just produces the same answer while looking like a
   * connectivity problem to whoever reads the logs.
   */
  async callWithRetry(method, path, body, { maxAttempts = this.cfg.maxAttempts } = {}) {
    let last = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      last = await this.call(method, path, body);
      const retryable = last.transportError !== null || last.status >= 500;
      if (!retryable) return { ...last, attempts: attempt };
      if (attempt < maxAttempts) {
        const wait = backoffMs(attempt, this.cfg);
        this.log({ at: 'retry', path, attempt, waitMs: wait, reason: last.transportError || `HTTP ${last.status}` });
        await this.sleep(wait);
      }
    }
    return { ...last, attempts: maxAttempts, exhausted: true };
  }

  // ── A WAIT THAT ACTUALLY OBSERVES THE SIGNAL ──────────────────────────────
  //
  // DEFECT 6 (found on real hardware, 2026-11-17). The heartbeat loop used to begin each pass with
  // a bare `await this.sleep(everyMs)`. `this.sleep` is a plain timer and ignores the signal, so
  // `ac.abort()` after execution released nothing: `await beat` then blocked until that timer
  // expired on its own. Observed on the office iMac — every task, including one whose handler
  // returns immediately, took ~51s between `leased` and `reported`, because the server issues a
  // ~50s heartbeat interval. Nothing was wrong with the task, the network or the server.
  //
  // `handlers/synthetic-echo.js` already documents this exact trap for handler authors — "A sleep
  // that actually wakes on abort rather than resolving late and checking afterwards" — and the
  // handler got it right while the client did not.
  //
  // WHY IT RESOLVES AND NEVER REJECTS. Its callers are loop guards, not work: each re-checks
  // `beating` and `signal.aborted` immediately afterwards and decides there. A rejecting wait
  // would turn an ordinary abort into an exception on a path whose whole job is to exit quietly,
  // and an abandoned rejection is an unhandled rejection.
  //
  // It WRAPS `this.sleep` rather than replacing it, so an injected clock still controls the timing
  // while the abort becomes observable — which is what makes the regression test deterministic
  // instead of a race against a real timer.
  _sleepUntilAborted(ms, signal) {
    if (!signal) return Promise.resolve(this.sleep(ms));
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', finish);
        resolve();
      };
      signal.addEventListener('abort', finish, { once: true });
      // `.then(finish, finish)`: a sleep that throws must not leave the loop waiting for ever, and
      // must not surface as a rejection nobody is positioned to catch.
      Promise.resolve(this.sleep(ms)).then(finish, finish);
    });
  }

  // ── ONE FULL CYCLE ────────────────────────────────────────────────────────

  /**
   * Claims at most one task, executes it, reports. Returns a description of what happened, so a
   * caller — or a test — can assert on it rather than inferring from logs.
   */
  async runOnce() {
    const claim = await this.callWithRetry('POST', '/api/worker/claim', {});
    if (claim.status === 404) return { did: 'nothing', reason: 'no claimable task' };
    if (claim.status !== 200 || !claim.json || !claim.json.ok) {
      return {
        did: 'not_claimed',
        status: claim.status,
        code: claim.json && claim.json.code,
        transportError: claim.transportError,
      };
    }

    const { runId, taskId, taskType, payload, leaseExpiresInMinutes, heartbeatEveryMs } = claim.json;
    this.log({ at: 'leased', runId, taskId, taskType });

    // ── HEARTBEAT, CONCURRENTLY, AS THE CANCELLATION CHANNEL ───────────────
    const ac = new AbortController();
    let cancelReason = null;
    let hbFailures = 0;
    let beating = true;
    const everyMs = Math.max(1_000, Number(heartbeatEveryMs) || 15_000);

    const beat = (async () => {
      while (beating && !ac.signal.aborted) {
        await this._sleepUntilAborted(everyMs, ac.signal);
        // Re-checked AFTER the wait, because the wait is exactly where completion happens. This is
        // what stops a heartbeat being sent for a task that has already finished.
        if (!beating || ac.signal.aborted) break;
        const hb = await this.call('POST', '/api/worker/heartbeat', { runId });

        if (hb.transportError || hb.status >= 500) {
          hbFailures += 1;
          this.log({ at: 'heartbeat_failed', runId, consecutive: hbFailures });
          if (hbFailures >= this.cfg.heartbeatFailureLimit) {
            // We no longer know whether we hold this lease. Stop, pessimistically.
            cancelReason = `lost contact with the server (${hbFailures} consecutive heartbeat failures); `
              + 'the lease may have been abandoned, so this execution is stopping and its outcome '
              + 'is uncertain';
            ac.abort();
          }
          continue;
        }
        hbFailures = 0;

        // A refusal or an explicit cancel both mean stop. `cancel` is present on both the granted
        // and the refused shape, which is why the API carries it in the denial body too.
        if (hb.json && hb.json.cancel === true) {
          cancelReason = hb.json.reason || hb.json.detail || 'cancelled by the server';
          this.log({ at: 'cancel_signalled', runId });
          ac.abort();
        } else if (hb.status !== 200) {
          cancelReason = `the lease is no longer live (HTTP ${hb.status}`
            + `${hb.json && hb.json.code ? ` ${hb.json.code}` : ''})`;
          ac.abort();
        }
      }
    })();

    const result = await EXEC.execute({ taskType, payload, leaseExpiresInMinutes, signal: ac.signal });
    const executedAt = this.now();
    beating = false;
    ac.abort();              // releases the heartbeat loop's wait — see _sleepUntilAborted
    // STILL AWAITED, DELIBERATELY. The wait now wakes on abort, but a heartbeat REQUEST already in
    // flight when execution finished is not cancelled by the abort: it is a network call with its
    // own timeout. Dropping this await would let `runOnce` return — and the next claim begin —
    // while a heartbeat for the finished run is still outstanding, which is the race the original
    // await existed to prevent. Keeping it costs at most one request timeout and only when a
    // heartbeat was genuinely mid-flight.
    await beat.catch(() => {});
    const beatDrainMs = this.now() - executedAt;

    // ── ABORTED: REPORT NOTHING ───────────────────────────────────────────
    //
    // Not FAILED. "Failed" is a claim that the work did not happen, and an aborted task may well
    // have completed its effect before the abort landed. The server's expiry handling will move
    // the task to NEEDS_RESOLUTION, which is the truthful state and the one a human can act on.
    if (result.verdict === EXEC.VERDICT.ABORTED) {
      const reason = cancelReason || result.reason || 'aborted';
      this.unresolved.push({ runId, taskId, taskType, reason, at: this.now() });
      // `ms` matters most on exactly this path: how far a task got before it was stopped is the
      // first question asked about an aborted run, and dropping it leaves only "something aborted".
      this.log({ at: 'aborted', runId, taskId, reason, ms: result.ms, beatDrainMs });
      return { did: 'aborted', runId, taskId, taskType, reason, reportedAnything: false,
        ms: result.ms, beatDrainMs };
    }

    // ── A KNOWN OUTCOME IS REPORTED, WITH RETRIES ─────────────────────────
    const status = result.verdict === EXEC.VERDICT.SUCCEEDED ? 'SUCCEEDED' : 'FAILED';
    const body = {
      runId,
      status,
      output: result.verdict === EXEC.VERDICT.SUCCEEDED
        ? result.output
        // A failure's output carries the reason in a bounded, structured shape rather than being
        // dropped — otherwise the only record of WHY is a log line on a machine nobody reads.
        : { failure: { code: result.code || 'failed', error: String(result.error || '').slice(0, 500) } },
    };

    // LATENCY IS RECORDED, NOT INFERRED. Defect 6 was invisible for as long as it was because the
    // only evidence was the gap between two log lines' timestamps, which reads as "the task took a
    // minute" rather than "the client waited for nothing". Three separate numbers now say where
    // the time went: execution, draining the heartbeat, and the report call itself.
    const reportStartedAt = this.now();
    const rep = await this.callWithRetry('POST', '/api/worker/result', body);
    const reportMs = this.now() - reportStartedAt;

    if (rep.status === 200 && rep.json && rep.json.ok) {
      this.log({ at: 'reported', runId, taskId, status, duplicate: Boolean(rep.json.duplicate),
        ms: result.ms, beatDrainMs, reportMs });
      return { did: 'reported', runId, taskId, taskType, status,
        duplicate: Boolean(rep.json.duplicate), ms: result.ms, beatDrainMs, reportMs };
    }

    if (rep.transportError || rep.exhausted) {
      // The task RAN and we cannot say whether the server recorded it. This is the one case that
      // must never become a re-execution. Recorded locally and left alone.
      this.unresolved.push({
        runId, taskId, taskType, at: this.now(),
        reason: `the task executed and its result could not be delivered (${rep.transportError || `HTTP ${rep.status}`}). `
          + 'The outcome is UNCERTAIN. It will not be re-executed.',
        executed: true,
      });
      this.log({ at: 'report_undeliverable', runId, taskId });
      return { did: 'executed_unreported', runId, taskId, taskType, reportedAnything: false,
        ms: result.ms, detail: rep.transportError || `HTTP ${rep.status}` };
    }

    // A 4xx: the server decided not to accept it — stopped, cancelled, lease not live, not ours.
    this.log({ at: 'report_refused', runId, code: rep.json && rep.json.code });
    return { did: 'report_refused', runId, taskId, taskType,
      status: rep.status, code: rep.json && rep.json.code };
  }

  /**
   * Is this credential accepted RIGHT NOW? One signed request, no side effect.
   *
   * A heartbeat for the nil run id authenticates and is then refused `lease_not_live`, because the
   * UPDATE matches no row. That is the point: it exercises exactly the authentication path the
   * worker depends on without claiming work, writing a result or touching a real lease. It spends
   * one nonce and writes one audit row, both of which are honest records that a diagnostic ran.
   *
   * `workerctl doctor` could not answer this question before — it reported `ready: true` on a
   * worker whose identity had been revoked, and on one that had been dead for eleven minutes,
   * because it checked environment variables and the Keychain and contacted nothing.
   */
  async probeAuth() {
    const r = await this.call('POST', '/api/worker/heartbeat', { runId: NIL_RUN_ID });
    const code = (r.json && r.json.code) || null;
    if (r.transportError || r.status === 0) {
      return { state: 'unreachable', code: null,
        detail: r.transportError || 'no response from the worker API' };
    }
    if (r.status === 401 || r.status === 403) {
      return {
        state: code === 'revoked' ? 'revoked' : 'rejected',
        code,
        detail: code === 'revoked'
          ? 'this worker identity has been revoked; a new identity must be enrolled'
          : `the server rejected this credential (HTTP ${r.status}${code ? `, ${code}` : ''})`,
      };
    }
    // Anything else means the signature, the nonce and the identity were all accepted. The refusal
    // that follows is about the nil lease, which is expected and is not an auth result.
    return { state: 'authenticated', code,
      detail: `the credential was accepted (HTTP ${r.status}${code ? `, ${code}` : ''})` };
  }

  /** The service loop. One task at a time: a single worker does not fan out. */
  async loop({ maxCycles = Infinity } = {}) {
    let cycles = 0;
    const outcomes = [];
    while (!this.stopped && cycles < maxCycles) {
      cycles += 1;
      let out;
      try {
        out = await this.runOnce();
      } catch (e) {
        out = { did: 'cycle_error', error: String(e && e.message).slice(0, 300) };
        this.log({ at: 'cycle_error', error: out.error });
      }
      outcomes.push(out);

      // Terminal before the sleep, so a revoked worker stops on its FIRST refusal rather than
      // after one more pointless wait.
      if (out.code && TERMINAL_AUTH_CODES.includes(out.code)) {
        this.terminal = { code: out.code, status: out.status || null, at: this.now() };
        this.log({ at: 'credential_terminal', code: out.code, status: out.status || null,
          cycles,
          note: 'this refusal cannot be fixed by retrying; stopping. The process exits 0 so launchd '
            + 'leaves it stopped. A human must enrol a new identity.' });
        break;
      }

      if (out.did === 'nothing' || out.did === 'not_claimed') {
        await this.sleep(this.cfg.idlePollMs);
      }
    }
    return { cycles, outcomes, unresolved: this.unresolved, terminal: this.terminal || null };
  }

  /** Graceful shutdown: finish nothing new, let the current task observe its own cancellation. */
  stop() { this.stopped = true; }
}

module.exports = { WorkerClient, backoffMs, freshNonce, DEFAULTS, TERMINAL_AUTH_CODES, NIL_RUN_ID };
