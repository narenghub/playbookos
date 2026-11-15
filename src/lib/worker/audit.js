// ── EVERY WORKER API CALL, GRANTED OR DENIED ────────────────────────────────
//
// M7.3 requirement 5: durable audit linkage across worker identity, task, agent_run, result and
// denial events. Requirement 10 of M7.5: *"All execution and denial events are auditable."*
//
// ── WHY NOT agent_run_events ────────────────────────────────────────────────
//
// It exists, it is the right shape for a run's timeline, and it cannot be used for this. Its
// `run_id` is `NOT NULL REFERENCES agent_runs(run_id)`, so it is structurally incapable of
// recording the event class that matters most here: a DENIAL. A refused claim has no run — that is
// the point of refusing it — and a bad signature does not even have a worker.
//
// An audit sink that can only record the calls that succeeded is the proxy-measurement defect
// wearing an auditor's hat: it would look complete and would be silent about every attack.
//
// So: one table, with every linkage nullable, and `agent_run_events` left alone for in-process
// agent runs. Two sinks for two different things, rather than one sink that half-fits both.
//
// ── NO FOREIGN KEYS, DELIBERATELY ───────────────────────────────────────────
//
// `worker_id` has no REFERENCES worker_identities(id), which looks like an omission and is the
// opposite. The most important audit row in this table is the one naming a worker id that does NOT
// exist — an enumeration attempt, a revoked machine still trying, a typo in a deployment. A
// foreign key would make exactly that row un-insertable, so the audit would fall silent at the
// moment it became interesting.
//
// Same reasoning for `run_id` and `task_id`: a denial often refers to a lease the caller does not
// hold or a task that was already cancelled.
//
// ── WHAT IS NEVER WRITTEN HERE ──────────────────────────────────────────────
//
// No request bodies, no signatures, no nonces, no secrets, no sealed values, no provider tokens.
// `detail` carries curated, non-secret facts chosen at each call site — never the raw request. The
// standing instruction is not to log message bodies or access tokens unnecessarily, and an audit
// table is precisely where that rule gets quietly broken by someone storing "the whole request,
// just in case".
//
// Recipient addresses are not written either: a worker task payload could contain one, and this
// table is read freely by anyone debugging a worker.

'use strict';

const OUTCOMES = Object.freeze(['GRANTED', 'DENIED']);

const DDL = [
  `CREATE TABLE IF NOT EXISTS worker_audit (
     id          BIGSERIAL PRIMARY KEY,
     at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     worker_id   TEXT,
     task_id     TEXT,
     run_id      UUID,
     endpoint    TEXT NOT NULL,
     outcome     TEXT NOT NULL,
     code        TEXT,
     http_status INTEGER,
     detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
     CONSTRAINT worker_audit_outcome_check CHECK (outcome IN ('GRANTED','DENIED'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_worker_audit_worker ON worker_audit (worker_id, at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_worker_audit_denied
     ON worker_audit (at DESC) WHERE outcome = 'DENIED'`,
  `CREATE INDEX IF NOT EXISTS idx_worker_audit_run ON worker_audit (run_id) WHERE run_id IS NOT NULL`,
];

const ROLLBACK = [
  `DROP INDEX IF EXISTS idx_worker_audit_run`,
  `DROP INDEX IF EXISTS idx_worker_audit_denied`,
  `DROP INDEX IF EXISTS idx_worker_audit_worker`,
  `DROP TABLE IF EXISTS worker_audit`,
];

async function migrateWorkerAudit(query) {
  for (const sql of DDL) await query(sql);
  return { ok: true, statements: DDL.length };
}

/** Keys that must never reach `detail`, whatever a caller passes. */
const FORBIDDEN = [
  'signature', 'nonce', 'secret', 'token', 'password', 'authorization', 'body', 'raw',
  'payload', 'output', 'to_email', 'to', 'html', 'text', 'cookie', 'key',
];

/**
 * Strips anything that could carry a secret or a recipient, rather than trusting each call site to
 * remember. A call site that genuinely needs a new field adds it to the allowlist deliberately.
 *
 * Shallow by design: a nested object is dropped entirely rather than walked, because "walk it and
 * sanitise as you go" is how a secret two levels down eventually gets written.
 */
function safeDetail(detail = {}) {
  const out = {};
  for (const [k, v] of Object.entries(detail || {})) {
    const key = String(k).toLowerCase();
    if (FORBIDDEN.some((f) => key === f || key.endsWith(`_${f}`) || key.includes(f))) continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[k] = typeof v === 'string' ? v.slice(0, 400) : v;
    }
    // objects, arrays and functions are dropped
  }
  return out;
}

/**
 * Records one worker API event. Never throws: an audit write failing must not turn a correctly
 * refused request into a 500, nor a granted one into a failure.
 *
 * It returns whether it wrote, so a caller that cares — the tests do — can assert on it rather
 * than assume. An audit sink nobody checks is a comfort, not a control.
 */
async function record({
  workerId = null, taskId = null, runId = null, endpoint, outcome, code = null,
  httpStatus = null, detail = {},
} = {}, deps = {}) {
  if (!endpoint || !OUTCOMES.includes(outcome)) {
    return { written: false, reason: 'an audit row needs an endpoint and a valid outcome' };
  }
  const query = deps.query || require('../db').query;
  try {
    await query(
      `INSERT INTO worker_audit (worker_id, task_id, run_id, endpoint, outcome, code, http_status, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [workerId, taskId, runId, String(endpoint), outcome, code, httpStatus,
        JSON.stringify(safeDetail(detail))]);
    return { written: true };
  } catch (e) {
    return { written: false, reason: e.message };
  }
}

module.exports = {
  DDL, ROLLBACK, OUTCOMES, FORBIDDEN,
  migrateWorkerAudit, record, safeDetail,
};
