// ── THE WORKER API — OUTBOUND-POLLING ONLY, AND NOT MOUNTED ─────────────────
//
// M7.3. Four endpoints the macOS worker CALLS. The worker never listens: it opens connections out,
// claims work, heartbeats, asks whether it has been cancelled, and reports. There is no inbound
// port on the worker and nothing here requires one.
//
//   POST /api/worker/claim          lease one task
//   POST /api/worker/heartbeat      keep a lease alive; learn of cancellation
//   GET  /api/worker/lease/:runId   cancellation status, without extending the lease
//   POST /api/worker/result         report, exactly once
//
// ── THIS FILE EXPORTS NO ROUTER, DELIBERATELY ───────────────────────────────
//
// M7.3 requirement 10: *"Verify that the API cannot be mounted accidentally in the M6 release."*
//
// Every other router in this repository is mounted as `app.use('/api', require('./x.routes'))`.
// That idiom applied to this file FAILS, because `module.exports` is not a router — it is a factory.
// Three independent things therefore have to go wrong before this API is reachable:
//
//   1. somebody must call createWorkerRouter() rather than requiring the module as a router;
//   2. WORKER_API_ENABLED must be exactly 'true' in that process, or the factory throws;
//   3. server.js must mount the result — and a preflight check asserts server.js does not
//      mention this file at all.
//
// A single forgotten line cannot expose it. That is the difference between "not mounted yet" and
// "cannot be mounted by accident", and only the second is a property.
//
// ── WHERE THE TRANSACTION BOUNDARY SITS, AND WHY NOT AROUND EVERYTHING ──────
//
// Requirement 3 asks for ownership, lease validity and STOP checks to be enforced transactionally.
// They are — but AUTHENTICATION IS DELIBERATELY OUTSIDE that transaction.
//
// authenticateWorker() records the request's nonce, which is what prevents a replay. If that write
// shared a transaction with the operation, then any operation that rolled back would RELEASE the
// nonce, and the identical signed request could be replayed. The replay guarantee would hold only
// for requests that happened to succeed, which is the weaker half of the set.
//
// So: authenticate on its own connection and commit the nonce immediately — one nonce, one
// attempt, whatever the outcome. Then run ownership + lease validity + STOP + the write as one
// atomic unit, so a result can never be recorded against a half-validated lease.
//
// ── WHAT "TRANSACTIONAL STOP ENFORCEMENT" DOES AND DOES NOT MEAN ────────────
//
// Inside the transaction the STOP is read as of that transaction's snapshot. That makes the checks
// and the write atomic with respect to each other. It does NOT mean a STOP inserted at the same
// instant is guaranteed to be seen — nothing short of locking the stop table on every request
// would give that, and that would make the kill switch a bottleneck on every worker call.
//
// What bounds the gap is the kill switch's own design: a 1-second TTL for consequential lookups
// plus LISTEN/NOTIFY invalidation. So the honest claim is: a STOP takes effect within about a
// second, it is re-checked at claim, at every heartbeat and at result acceptance, and a result
// cannot slip through alongside a half-applied validation. It is written down because
// "transactional" reads like a stronger promise than it is.

'use strict';

const express = require('express');
const AUTH = require('../lib/worker/auth');
const LEASES = require('../lib/worker/leases');
const AUDIT = require('../lib/worker/audit');

const MOUNT_ENV = 'WORKER_API_ENABLED';

/** Exactly 'true'. Not truthy — 'false', '0' and 'yes' are all refusals. */
function isMountEnabled(env = process.env) {
  return env[MOUNT_ENV] === 'true';
}

const SIGNED_HEADERS = Object.freeze({
  id: 'x-worker-id',
  timestamp: 'x-worker-timestamp',
  nonce: 'x-worker-nonce',
  signature: 'x-worker-signature',
});

/**
 * The path the worker signed. `req.originalUrl` includes the mount prefix, and the query string is
 * excluded because the worker signs the path it requests without one. A mismatch here would make
 * every request fail with 'bad_signature', which is the confusing failure, so it is pinned by a test.
 */
const signedPath = (req) => String(req.originalUrl || req.url || '').split('?')[0];
const rawBodyOf = (req) => (req.rawBody ? Buffer.from(req.rawBody).toString('utf8') : '');

function createWorkerRouter(deps = {}) {
  if (!deps.enable && !isMountEnabled(deps.env || process.env)) {
    throw new Error(
      `the worker API is not enabled: set ${MOUNT_ENV}=true to mount it. It is off by default `
      + 'because an endpoint that leases executable work should not become reachable by someone '
      + 'adding a line to server.js.');
  }

  const router = express.Router();
  const query = deps.query || null;
  const opDeps = { ...deps };
  const withTx = deps.withTransaction
    || ((fn) => require('../lib/db').withTransaction(fn));

  /** Audits and answers in one place, so no path can return without a trace. */
  // `body` exists because of a defect the end-to-end test found: leases.heartbeat returns
  // `cancel: true` on a lease that is no longer live — abandoned, closed, or never held — and the
  // first version of this function dropped it, answering 409 with a code and no cancel flag. A
  // worker checking `json.cancel` would have seen undefined on exactly the case where it most
  // needs to stop. A refusal is still information the caller has to act on.
  //
  // `reason_code` is deliberately NOT written into detail: the `code` column already holds it, and
  // duplicating it there made audit rows contain strings like 'bad_signature' and 'malformed_nonce'
  // — no secret, but enough to trip the leak scan, and a scan that has to allow a near-miss is a
  // scan that will one day allow the real thing.
  async function deny(res, req, { status, code, detail, workerId = null, runId = null, taskId = null, extra = {}, body = {} }) {
    await AUDIT.record({
      workerId, runId, taskId, endpoint: signedPath(req), outcome: 'DENIED',
      code, httpStatus: status, detail: extra,
    }, { query });
    return res.status(status).json({ ok: false, code, detail, ...body });
  }

  async function grant(res, req, { code, workerId, runId = null, taskId = null, body, extra = {} }) {
    await AUDIT.record({
      workerId, runId, taskId, endpoint: signedPath(req), outcome: 'GRANTED',
      code, httpStatus: 200, detail: extra,
    }, { query });
    return res.status(200).json({ ok: true, ...body });
  }

  /**
   * Authentication, on its own connection. See the note at the top of this file for why the nonce
   * must commit even when the operation that follows fails.
   */
  async function authenticate(req, res) {
    const h = req.headers;
    const result = await AUTH.authenticateWorker({
      workerId: h[SIGNED_HEADERS.id],
      method: req.method,
      path: signedPath(req),
      timestamp: h[SIGNED_HEADERS.timestamp],
      nonce: h[SIGNED_HEADERS.nonce],
      body: rawBodyOf(req),
      signature: h[SIGNED_HEADERS.signature],
    }, { ...opDeps, query });

    if (!result.ok) {
      // The worker id is recorded even when authentication failed — especially then. An audit that
      // can only name authenticated callers is silent about every attack.
      await deny(res, req, {
        status: result.status, code: result.code, detail: result.detail,
        workerId: h[SIGNED_HEADERS.id] || null,
        extra: { server_fault: Boolean(result.serverFault) },
      });
      return null;
    }
    return result;
  }

  // ── CLAIM ─────────────────────────────────────────────────────────────────
  router.post('/worker/claim', async (req, res) => {
    const who = await authenticate(req, res);
    if (!who) return undefined;

    const { taskId = null, overrideReason = null } = req.body || {};
    let out;
    try {
      out = await withTx(async (client) => {
        const txq = (sql, params) => client.query(sql, params);
        return LEASES.claimTask({ workerId: who.workerId, taskId, overrideReason },
          { ...opDeps, query: txq });
      });
    } catch (e) {
      return deny(res, req, { status: 500, code: 'claim_failed', detail: e.message, workerId: who.workerId });
    }

    if (!out.ok) {
      const status = out.code === 'stopped' ? 409 : out.code === 'nothing_to_do' ? 404 : 409;
      return deny(res, req, { status, code: out.code, detail: out.detail, workerId: who.workerId, taskId });
    }
    return grant(res, req, {
      code: 'leased', workerId: who.workerId, runId: out.runId, taskId: out.taskId,
      body: {
        runId: out.runId, taskId: out.taskId, taskType: out.taskType, payload: out.payload,
        leaseExpiresInMinutes: out.leaseExpiresInMinutes, heartbeatEveryMs: out.heartbeatEveryMs,
      },
      extra: { task_type: out.taskType, lease_minutes: out.leaseExpiresInMinutes },
    });
  });

  // ── HEARTBEAT ─────────────────────────────────────────────────────────────
  router.post('/worker/heartbeat', async (req, res) => {
    const who = await authenticate(req, res);
    if (!who) return undefined;

    const { runId = null } = req.body || {};
    let out;
    try {
      out = await withTx(async (client) => {
        const txq = (sql, params) => client.query(sql, params);
        return LEASES.heartbeat({ workerId: who.workerId, runId }, { ...opDeps, query: txq });
      });
    } catch (e) {
      return deny(res, req, { status: 500, code: 'heartbeat_failed', detail: e.message, workerId: who.workerId, runId });
    }

    if (!out.ok) {
      return deny(res, req, {
        status: 409, code: out.code, detail: out.detail, workerId: who.workerId, runId,
        extra: { cancel: Boolean(out.cancel) },
        // The worker must be able to read this without parsing the detail prose.
        body: { cancel: Boolean(out.cancel) },
      });
    }
    return grant(res, req, {
      code: out.cancel ? 'cancel_signalled' : 'alive', workerId: who.workerId, runId,
      body: { cancel: out.cancel, reason: out.reason || null },
      extra: { cancel: out.cancel },
    });
  });

  // ── CANCELLATION STATUS, WITHOUT EXTENDING THE LEASE ─────────────────────
  //
  // A worker that wants to know whether to stop should not have to assert it is still alive in
  // order to ask. Heartbeating to check for cancellation would keep a lease warm that may be about
  // to be cancelled, which is the wrong incentive.
  router.get('/worker/lease/:runId', async (req, res) => {
    const who = await authenticate(req, res);
    if (!who) return undefined;

    const runId = req.params.runId;
    let row;
    try {
      row = await withTx(async (client) => {
        const r = await client.query(
          `SELECT r.state AS lease_state, t.id AS task_id, t.state AS task_state,
                  t.cancel_requested_at, t.cancel_reason, t.company_id, t.workflow
             FROM agent_runs r
             LEFT JOIN worker_tasks t ON t.intent_key = r.intent_key
            WHERE r.run_id = $1 AND r.trigger = 'worker' AND r.trigger_detail = $2`,
          [runId, who.workerId]);
        if (!r.rows.length) return null;
        const g = await AUTH.authorizeWorkerAction(
          { workerId: who.workerId, company: r.rows[0].company_id, workflow: r.rows[0].workflow },
          { ...opDeps, query: (sql, p) => client.query(sql, p) });
        return { ...r.rows[0], stop: g.allowed ? null : g.stop };
      });
    } catch (e) {
      return deny(res, req, { status: 500, code: 'status_failed', detail: e.message, workerId: who.workerId, runId });
    }

    if (!row) {
      return deny(res, req, {
        status: 404, code: 'not_your_lease', detail: 'no such lease for this worker',
        workerId: who.workerId, runId,
      });
    }

    const cancel = Boolean(row.cancel_requested_at) || Boolean(row.stop)
      || row.lease_state !== 'RUNNING';
    return grant(res, req, {
      code: cancel ? 'cancel_signalled' : 'alive', workerId: who.workerId, runId, taskId: row.task_id,
      body: {
        cancel,
        leaseState: row.lease_state,
        reason: row.cancel_reason
          || (row.stop ? `stopped at scope ${row.stop.scope_type}: ${row.stop.reason}` : null)
          || (row.lease_state !== 'RUNNING' ? `lease is ${row.lease_state}` : null),
      },
      extra: { cancel, lease_state: row.lease_state },
    });
  });

  // ── RESULT ────────────────────────────────────────────────────────────────
  router.post('/worker/result', async (req, res) => {
    const who = await authenticate(req, res);
    if (!who) return undefined;

    const { runId = null, status = null, output = {} } = req.body || {};
    let out;
    try {
      out = await withTx(async (client) => {
        const txq = (sql, params) => client.query(sql, params);
        return LEASES.submitResult({ workerId: who.workerId, runId, status, output },
          { ...opDeps, query: txq });
      });
    } catch (e) {
      return deny(res, req, { status: 500, code: 'result_failed', detail: e.message, workerId: who.workerId, runId });
    }

    if (!out.ok) {
      const code = out.code;
      const httpStatus = code === 'not_your_lease' ? 403
        : code === 'stopped' || code === 'cancelled' || code === 'lease_not_live' ? 409 : 400;
      return deny(res, req, { status: httpStatus, code, detail: out.detail, workerId: who.workerId, runId });
    }

    // A result is a PROPOSAL. Nothing here transmits, and the response says so, because a worker
    // author reading only the API could otherwise reasonably assume reporting is acting.
    return grant(res, req, {
      code: out.duplicate ? 'result_duplicate' : 'result_recorded',
      workerId: who.workerId, runId, taskId: out.taskId,
      body: {
        duplicate: Boolean(out.duplicate),
        taskId: out.taskId,
        note: 'recorded as a proposal. Nothing is transmitted by reporting a result; anything '
          + 'consequential goes through the approval and dispatch path.',
      },
      extra: { duplicate: Boolean(out.duplicate), status: out.status || null },
    });
  });

  return router;
}

// NOT a router. See the note at the top: `app.use('/api', require('./worker.routes'))` must fail.
module.exports = { createWorkerRouter, isMountEnabled, MOUNT_ENV, SIGNED_HEADERS, signedPath };
