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
      if (out.did === 'nothing' || out.did === 'not_claimed') {
        await this.sleep(this.cfg.idlePollMs);
      }
    }
    return { cycles, outcomes, unresolved: this.unresolved };
  }

  /** Graceful shutdown: finish nothing new, let the current task observe its own cancellation. */
  stop() { this.stopped = true; }
}

module.exports = { WorkerClient, backoffMs, freshNonce, DEFAULTS };
