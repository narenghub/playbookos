// ── THE RUN LEDGER: OPERATIONS AND DURABILITY CLASSES ────────────────────────
//
// P0.3 item 4. Schema and identity rules live in src/lib/runs.js; this is what execution calls.
//
// ── DURABILITY IS A PROPERTY OF THE FUNCTION, NOT OF THE CALLER'S MEMORY ─────
//
// "Mid-run event writes are best-effort" was rejected as too broad, and rightly: it would let the
// exact worker-death ambiguity the ledger exists to expose happen invisibly. But making every
// write able to halt work would mean a failed heartbeat could take out a business process.
//
// So each function belongs to one of three classes, and the class is visible in its name and its
// behaviour rather than being a rule callers have to remember:
//
//   CRITICAL      createRun, actionAttempted
//                 THROWS on failure. The caller must not proceed — must not begin autonomous
//                 execution, must not perform the external action.
//
//   OPERATIONAL   startRun, actionSucceeded, actionFailed, finish
//                 Must be durable. Never throws (the work has already happened and throwing would
//                 lose the rest of the record), but a failure is loud, is reported through
//                 onDurabilityFailure, and NEVER becomes a silent success: a run whose outcome
//                 could not be written stays RUNNING and the reaper marks it ABANDONED, which is
//                 the truth — nobody knows how it ended.
//
//   TELEMETRY     heartbeat
//                 Best-effort and silent on failure. A heartbeat that cannot be written must not
//                 create an outage. The cost of losing one is that the reaper may call a live run
//                 abandoned, which is visible and recoverable.
//
// ── A DUPLICATE IS NOT A FAILURE ─────────────────────────────────────────────
//
// A 23505 from the active-intent index means another process already owns this intent. That is the
// switch working. createRun returns { duplicate: true } instead of throwing, and a caller that
// reports it as a failure would raise a false alert saying the workflow broke when in fact it was
// correctly declined.
'use strict';

const runs = require('./runs');

const CREATED = 'CREATED';
const RUNNING = 'RUNNING';

// Loud by default. The canary wiring replaces this with the cron alert channel, so a durability
// failure reaches a human rather than only Railway's log.
const defaultOnDurabilityFailure = (what, err) => {
  console.error(`[LEDGER DURABILITY] ${what}: ${err && err.message ? err.message : err}`);
};

function ledger({ query, onDurabilityFailure = defaultOnDurabilityFailure } = {}) {
  const q = query || require('./db').query;

  // ── CRITICAL ───────────────────────────────────────────────────────────────

  /**
   * Create the durable run identity. FAIL-CLOSED: throws if it cannot be persisted, and the caller
   * must not begin autonomous execution. A meaningful autonomous execution may not run invisibly.
   *
   * Returns { runId, rootRunId, duplicate: false } or { duplicate: true, intentKey } when another
   * process already owns the intent — which is not an error.
   */
  async function createRun(spec) {
    const {
      trigger, triggerDetail = null, workflow = null, agent = null,
      product, tenantId = null, objectiveId = null, actorUserId = null,
      intentKey = null, attempt = 1, predecessorRunId = null, retryOverrideReason = null,
      parentRunId = null, rootRunId = null,
    } = spec;

    if (!trigger) throw new Error('run.trigger is required');
    if (!product) throw new Error('run.product is required: a run with no owning workspace cannot be attributed');

    const runId = runs.newRunId();
    // A root run is its own root. A delegated run inherits the tree's root, and so does a retry of
    // one — a retry occupies the same position in the delegation graph as the attempt it replaces.
    const root = rootRunId || runId;

    try {
      await q(
        `INSERT INTO agent_runs
           (run_id, root_run_id, parent_run_id, trigger, trigger_detail, workflow, agent, product,
            tenant_id, objective_id, actor_user_id, state, intent_key, attempt,
            predecessor_run_id, retry_override_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [runId, root, parentRunId, trigger, triggerDetail, workflow, agent, product,
          tenantId, objectiveId, actorUserId, CREATED, intentKey, attempt,
          predecessorRunId, retryOverrideReason],
      );
    } catch (e) {
      if (e.code === '23505') {
        // Another process owns this intent. Declined, not failed.
        return { duplicate: true, intentKey, runId: null, rootRunId: null };
      }
      throw e;   // fail-closed: the caller must not proceed
    }

    // The creation event is part of the same critical step: a run with no RUN_CREATED event has an
    // identity but no history, and the history is the evidence.
    await q(`INSERT INTO agent_run_events (run_id, kind, detail) VALUES ($1, 'RUN_CREATED', $2::jsonb)`,
      [runId, JSON.stringify({ trigger, workflow, intent_key: intentKey, attempt })]);

    return { duplicate: false, runId, rootRunId: root };
  }

  /**
   * Record that a consequential external action is ABOUT to be performed. CRITICAL: throws if it
   * cannot be persisted, and the caller must NOT perform the action.
   *
   * This is the write that converts a worker death from "silently maybe sent" into a known-unknown:
   * an ACTION_ATTEMPTED with no terminal event is UNKNOWN_OUTCOME — neither failed nor safe.
   */
  async function actionAttempted(runId, { actionKind, subjectType = null, subjectRef = null, detail = null }) {
    if (!actionKind) throw new Error('actionKind is required');
    await q(
      `INSERT INTO agent_run_events (run_id, kind, action_kind, subject_type, subject_ref, detail)
       VALUES ($1, 'ACTION_ATTEMPTED', $2, $3, $4, $5::jsonb)`,
      [runId, actionKind, subjectType, subjectRef, detail ? JSON.stringify(detail) : null],
    );
  }

  // ── OPERATIONAL ────────────────────────────────────────────────────────────

  async function operational(what, fn) {
    try { await fn(); return { ok: true }; }
    catch (e) { onDurabilityFailure(what, e); return { ok: false, error: e.message }; }
  }

  const startRun = (runId) => operational(`startRun ${runId}`, async () => {
    await q(`UPDATE agent_runs SET state=$2, started_at=NOW(), heartbeat_at=NOW() WHERE run_id=$1`,
      [runId, RUNNING]);
    await q(`INSERT INTO agent_run_events (run_id, kind) VALUES ($1, 'RUN_STARTED')`, [runId]);
  });

  const actionSucceeded = (runId, o) => operational(`actionSucceeded ${o.actionKind}`, async () => {
    await q(
      `INSERT INTO agent_run_events
         (run_id, kind, action_kind, subject_type, subject_ref, success, cost_usd, tokens_input, tokens_output, detail)
       VALUES ($1,'ACTION_SUCCEEDED',$2,$3,$4,TRUE,$5,$6,$7,$8::jsonb)`,
      [runId, o.actionKind, o.subjectType || null, o.subjectRef || null,
        o.costUsd == null ? null : o.costUsd, o.tokensInput == null ? null : o.tokensInput,
        o.tokensOutput == null ? null : o.tokensOutput, o.detail ? JSON.stringify(o.detail) : null],
    );
  });

  const actionFailed = (runId, o) => operational(`actionFailed ${o.actionKind}`, async () => {
    await q(
      `INSERT INTO agent_run_events
         (run_id, kind, action_kind, subject_type, subject_ref, success, error, detail)
       VALUES ($1,'ACTION_FAILED',$2,$3,$4,FALSE,$5,$6::jsonb)`,
      [runId, o.actionKind, o.subjectType || null, o.subjectRef || null,
        String(o.error || '').slice(0, 2000), o.detail ? JSON.stringify(o.detail) : null],
    );
  });

  /**
   * Terminal transition. OPERATIONAL: never throws, but a failure is loud and leaves the run
   * RUNNING for the reaper rather than asserting an outcome nobody could record.
   *
   * `state` is derived from the events when not given, so PARTIAL is a fact about what happened
   * rather than a judgement the caller makes.
   */
  async function finish(runId, { state = null, error = null, stoppedBy = null } = {}) {
    let terminal = state;
    if (!terminal) {
      const r = await q(
        `SELECT
           COUNT(*) FILTER (WHERE kind='ACTION_SUCCEEDED')::int AS ok_n,
           COUNT(*) FILTER (WHERE kind='ACTION_FAILED')::int    AS bad_n
         FROM agent_run_events WHERE run_id = $1`, [runId]).catch(() => null);
      const okN = r ? r.rows[0].ok_n : 0;
      const badN = r ? r.rows[0].bad_n : 0;
      if (error) terminal = okN > 0 ? 'PARTIAL' : 'FAILED';
      else if (badN > 0 && okN > 0) terminal = 'PARTIAL';
      else if (badN > 0) terminal = 'FAILED';
      else terminal = 'SUCCEEDED';
    }
    return operational(`finish ${runId} -> ${terminal}`, async () => {
      await q(
        `UPDATE agent_runs SET state=$2, ended_at=NOW(), stopped_by=COALESCE($3, stopped_by)
          WHERE run_id=$1`,
        [runId, terminal, stoppedBy],
      );
      await q(
        `INSERT INTO agent_run_events (run_id, kind, error, detail)
         VALUES ($1, 'RUN_ENDED', $2, $3::jsonb)`,
        [runId, error ? String(error).slice(0, 2000) : null, JSON.stringify({ state: terminal })],
      );
    }).then((res) => ({ ...res, state: terminal }));
  }

  /** A policy stop. The run never becomes SUCCEEDED, and it points at the exact refusal. */
  const stoppedByPolicy = (runId, autonomyEventId, reason) =>
    operational(`stoppedByPolicy ${runId}`, async () => {
      await q(`UPDATE agent_runs SET state='STOPPED_BY_POLICY', ended_at=NOW(), stopped_by=$2 WHERE run_id=$1`,
        [runId, autonomyEventId || null]);
      await q(
        `INSERT INTO agent_run_events (run_id, kind, detail) VALUES ($1,'STOPPED_BY_POLICY',$2::jsonb)`,
        [runId, JSON.stringify({ reason: reason || null, autonomy_event_id: autonomyEventId || null })],
      );
    });

  /** Roll the event costs up onto the run. Partial by construction — see cost coverage in the design. */
  const accumulateCost = (runId) => operational(`accumulateCost ${runId}`, async () => {
    await q(
      `UPDATE agent_runs r
          SET cost_usd = s.c, tokens_input = s.i, tokens_output = s.o
         FROM (SELECT SUM(cost_usd) c, SUM(tokens_input) i, SUM(tokens_output) o
                 FROM agent_run_events WHERE run_id = $1) s
        WHERE r.run_id = $1`, [runId]);
  });

  // ── TELEMETRY ──────────────────────────────────────────────────────────────

  /** Best-effort and silent. A heartbeat must never be able to stop business work. */
  async function heartbeat(runId) {
    try {
      await q(`UPDATE agent_runs SET heartbeat_at=NOW() WHERE run_id=$1 AND state='RUNNING'`, [runId]);
      return true;
    } catch (_) { return false; }
  }

  // ── READS ──────────────────────────────────────────────────────────────────

  /**
   * Consequential actions attempted with no terminal acknowledgement: UNKNOWN_OUTCOME. Neither
   * FAILED nor safe to retry. This is a safety feature, not observability — it is what a human
   * consults before authorising a retry over an ambiguity.
   */
  async function unresolvedActions({ limit = 200 } = {}) {
    const r = await q(
      `SELECT r.run_id, r.intent_key, r.workflow, r.attempt, r.state AS run_state,
              e.id AS event_id, e.at, e.action_kind, e.subject_type, e.subject_ref
         FROM agent_run_events e JOIN agent_runs r USING (run_id)
        WHERE e.kind = 'ACTION_ATTEMPTED'
          AND NOT EXISTS (SELECT 1 FROM agent_run_events t
                           WHERE t.run_id = e.run_id
                             AND t.action_kind IS NOT DISTINCT FROM e.action_kind
                             AND t.subject_ref IS NOT DISTINCT FROM e.subject_ref
                             AND t.kind IN ('ACTION_SUCCEEDED','ACTION_FAILED'))
        ORDER BY e.at DESC LIMIT $1`, [Math.min(Math.max(1, limit), 1000)]);
    return r.rows;
  }

  /** Runs that stopped reporting. Deliberately a read: marking them is a separate explicit step. */
  async function staleRuns({ olderThanMinutes = 90, limit = 200 } = {}) {
    const r = await q(
      `SELECT run_id, intent_key, workflow, attempt, started_at, heartbeat_at
         FROM agent_runs
        WHERE state = 'RUNNING'
          AND COALESCE(heartbeat_at, started_at, created_at) < NOW() - ($1 || ' minutes')::interval
        ORDER BY COALESCE(heartbeat_at, started_at, created_at) LIMIT $2`,
      [String(olderThanMinutes), Math.min(Math.max(1, limit), 1000)]);
    return r.rows;
  }

  const timeline = async (runId) => (await q(
    `SELECT at, kind, action_kind, subject_type, subject_ref, success, error, cost_usd, detail
       FROM agent_run_events WHERE run_id=$1 ORDER BY at, id`, [runId])).rows;

  const getRun = async (runId) => (await q(`SELECT * FROM agent_runs WHERE run_id=$1`, [runId])).rows[0] || null;

  const attemptsOf = async (intentKey) => (await q(
    `SELECT run_id, attempt, state, started_at, ended_at, predecessor_run_id, retry_override_reason
       FROM agent_runs WHERE intent_key=$1 ORDER BY attempt`, [intentKey])).rows;

  const lineageOf = async (rootRunId) => (await q(
    `SELECT run_id, parent_run_id, predecessor_run_id, attempt, intent_key, workflow, state
       FROM agent_runs WHERE root_run_id=$1 ORDER BY created_at`, [rootRunId])).rows;

  return {
    createRun, actionAttempted,
    startRun, actionSucceeded, actionFailed, finish, stoppedByPolicy, accumulateCost,
    heartbeat,
    unresolvedActions, staleRuns, timeline, getRun, attemptsOf, lineageOf,
  };
}

module.exports = { ledger, CREATED, RUNNING };

// ── THE CANARY WRAPPER (P0.3 item 5) ─────────────────────────────────────────
//
// Used by exactly ONE cron for now: daily-8utc-github-sync. The shared withAlerts behaviour of the
// other 36 is untouched, deliberately — the point of a canary is to find out whether this is safe
// enough to become infrastructure, and wiring 37 jobs before knowing that would defeat it.
//
// The sequence, and why each step is where it is:
//
//   scheduled slot  ->  intent_key          derived from node-cron's matched wall clock
//        CREATED persisted                  FAIL-CLOSED: no row, no execution
//        kill switch checked                a stop here means the body never runs
//        RUNNING persisted
//        the existing body, unchanged
//        terminal state persisted           SUCCEEDED / FAILED / PARTIAL, never guessed
//
// The kill-switch check is inside, after CREATED, so a policy stop leaves durable evidence that the
// run existed and was refused — rather than leaving no trace at all, which is what happens today.
async function instrumentedRun(spec, body, deps = {}) {
  const {
    workflow, product, agent = null, trigger = 'cron', triggerDetail = null,
    intentKey = null, firedAt = null,
  } = spec;

  const L = deps.ledger || ledger({ query: deps.query, onDurabilityFailure: deps.onDurabilityFailure });
  const autonomy = deps.autonomy || require('./autonomy');
  // Only the DB-touching half is injectable. scopesForCron is a pure lookup over a static map, so
  // taking it from a stub lets a test accidentally blank the cron's scopes and still pass — which
  // happened here: the stub omitted it and every case failed for the wrong reason while two
  // assertions still read green.
  const { scopesForCron } = require('./autonomy');
  const key = intentKey !== null ? intentKey : require('./runs').cronIntentKey(workflow, firedAt);

  // ── FAIL CLOSED ────────────────────────────────────────────────────────────
  // If the durable identity cannot be created, autonomous execution does not begin. Approved
  // explicitly: a meaningful autonomous execution may not run invisibly.
  let created;
  try {
    created = await L.createRun({
      trigger, triggerDetail, workflow, agent, product, intentKey: key, attempt: 1,
    });
  } catch (e) {
    console.error(`[LEDGER FAIL-CLOSED] ${workflow}: run identity could not be created, so the body did NOT run: ${e.message}`);
    return { ran: false, reason: 'ledger_unavailable', error: e.message };
  }

  // A duplicate is the arbiter working, not a failure. Reporting it as FAILED would raise a false
  // alert claiming the workflow broke when another process correctly owns the slot.
  if (created.duplicate) {
    console.log(`[LEDGER DUPLICATE] ${workflow}: intent ${key} is already owned by another execution; declining.`);
    return { ran: false, reason: 'duplicate_intent', intentKey: key };
  }

  const { runId } = created;

  // The kill switch, consulted after the run exists so the refusal is recorded against it.
  try {
    const blocked = await autonomy.checkStopped(
      scopesForCron(workflow), { consequential: true, deps },
    );
    if (blocked) {
      let eventId = null;
      try {
        const r = await (deps.query || require('./db').query)(
          `SELECT id FROM autonomy_events
            WHERE action IN ('STOP','REFUSED') AND scope_type=$1 AND COALESCE(scope_key,'')=$2
            ORDER BY id DESC LIMIT 1`, [blocked.scope_type, blocked.scope_key || '']);
        eventId = r.rows.length ? r.rows[0].id : null;
      } catch (_) { /* the link is evidence, not a precondition */ }
      await L.stoppedByPolicy(runId, eventId, blocked.reason);
      console.warn(`[STOPPED_BY_POLICY] ${workflow}: ${blocked.scope_type} — ${blocked.reason}`);
      return { ran: false, reason: 'stopped_by_policy', runId, scope: blocked.scope_type };
    }
  } catch (e) {
    // checkStopped already fails closed on a database problem, so arriving here is a defect in the
    // switch. Halt and say so: a cron must not run with the brakes in unknown condition.
    await L.finish(runId, { state: 'FAILED', error: `kill-switch check failed: ${e.message}` });
    console.error(`[LEDGER] ${workflow}: kill-switch check failed, body did NOT run: ${e.message}`);
    return { ran: false, reason: 'killswitch_check_failed', runId, error: e.message };
  }

  await L.startRun(runId);

  let result;
  try {
    result = await body({ runId, ledger: L, intentKey: key });
  } catch (e) {
    const fin = await L.finish(runId, { error: e.message });
    console.error(`[LEDGER] ${workflow} run ${runId} -> ${fin.state}: ${e.message}`);
    // Rethrown so withAlerts still alerts exactly as it does today. The canary changes what is
    // RECORDED, not how failure is reported.
    throw e;
  }

  await L.accumulateCost(runId);
  const fin = await L.finish(runId, {});
  return { ran: true, runId, intentKey: key, state: fin.state, result };
}

module.exports.instrumentedRun = instrumentedRun;
