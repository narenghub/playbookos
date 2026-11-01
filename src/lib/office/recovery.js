// PlayNexa AI Office — K4: stale-run recovery and the retry entry point.
//
// ── WHY THIS IS NOT "HEARTBEAT OLDER THAN N" ─────────────────────────────────
//
// Measured before anything was designed, per the K4 ruling:
//
//   • ledger.heartbeat() has ZERO production callers. The only writer of heartbeat_at is
//     startRun(), which sets it once at CREATED -> RUNNING and never again.
//   • so COALESCE(heartbeat_at, started_at, created_at) is RUN START TIME, not liveness. The
//     existing staleRuns() read is therefore an age query wearing a liveness name.
//   • staleRuns() also only looks at RUNNING, so a run stranded in CREATED — process died between
//     createRun and startRun — is invisible to it.
//   • G7 is open: src/lib/llm.js and the nine agent files that bypass it have no AbortController.
//     A hung provider call produces an indefinitely RUNNING run, which is exactly the population
//     this file has to reason about.
//
// Consequence, stated plainly: THERE IS NO SIGNAL IN THIS SYSTEM THAT DISTINGUISHES A DEAD
// PROCESS FROM SLOW EXECUTION. Building "heartbeat older than N" on top of that would have
// invented an invariant the evidence does not support — the thing the ruling explicitly forbids.
//
// ── SO THE POLICY IS A DECLARED CEILING, PER RUN ─────────────────────────────
//
// agent_runs.max_runtime_minutes is what the CALLER declared this work should take. Exceeding it
// does not mean the run is dead; it means THE RUN DECLARED IT WOULD FINISH BY NOW AND DID NOT.
// That is a weaker claim than death and it is the strongest one available today, so the recovery
// it licenses is correspondingly conservative. Undeclared runs fall back to a per-workflow
// policy, and failing that to DEFAULT_CEILING_MINUTES — labelled below as a policy default and
// not as evidence.
//
// If per-run heartbeats or process-level liveness are introduced later, this policy tightens
// without changing shape: the eligibility predicate gets a better input. That is recorded as the
// strengthener, not built here, because K4 is "the smallest stale-run recovery mechanism".
//
// ── FOUR CLASSES, AS RULED ───────────────────────────────────────────────────
//
//   safe_stale      over ceiling, NO unresolved ACTION_ATTEMPTED  -> ABANDONED
//   known_unknown   over ceiling, unresolved ACTION_ATTEMPTED     -> ABANDONED + durable record
//   fresh           within ceiling                                -> untouched
//   terminal        SUCCEEDED/PARTIAL/FAILED/ABANDONED/STOPPED_BY_POLICY -> never reclassified
//
// WHY A KNOWN-UNKNOWN IS ALSO ABANDONED, WHICH IS A JUDGEMENT AND IS FLAGGED AS ONE.
// Leaving it non-terminal would be the conservative-looking choice and it is the dangerous one:
// uq_agent_runs_one_active means a non-terminal run PERMANENTLY BLOCKS EVERY FUTURE RUN OF THAT
// INTENT. One stranded consequential run would silently kill that workflow forever — the defect
// K4 exists to remove. ABANDONED does not manufacture certainty: it asserts "no outcome was
// recorded", which is precisely true, and it is neither SUCCEEDED nor FAILED. The ambiguity stays
// enforced where it belongs — the existing retry guard already demands a >=10 character human
// override to retry an ABANDONED predecessor OR any run with unresolved consequential actions, so
// nothing can be automatically retried over the top of it.
//
// ── CONCURRENCY ──────────────────────────────────────────────────────────────
//
// No SELECT-then-UPDATE. The UPDATE's own WHERE clause is the arbiter: it matches only a
// non-terminal state, so of N racing reapers exactly one gets a row back and the rest see zero
// and re-read the current state. Postgres row locking does the arbitration; nothing in JavaScript
// has to be correct for it to hold.
//
// ── RETRY IS NOT RESUME, AND THIS FILE INVENTS NO RETRY RULES ────────────────
//
// retryRun() creates a NEW physical run: new run_id, same intent_key, attempt + 1, predecessor
// set. The previous attempt stays terminal and immutable — attempt 1 remains historical evidence.
// Every eligibility rule is already enforced by trg_agent_runs_retry_guard in the database
// (FAILED retryable; ABANDONED/PARTIAL and unresolved actions require an override reason;
// CREATED/RUNNING/SUCCEEDED refused; intent must match; attempt must be predecessor + 1). This
// function's job is to FEED that guard correctly, not to re-decide any of it.

const { ledger } = require('../run-ledger');

const ACTIVE = ['CREATED', 'RUNNING'];

// Per-workflow ceilings. Keyed by exact workflow name. This is policy, openly: it is where an
// operator records "this work really does take that long" instead of widening a global number.
const CEILINGS = Object.freeze({
  'objective-review': 15,
  // The reaper itself. A sweep over a few hundred rows is seconds of work; if it is still going
  // after 10 minutes it is wedged, and a later sweep should say so. It cannot abandon ITSELF —
  // see excludeRunId in reap() — but a PREVIOUS wedged reaper is a legitimate candidate.
  'quarter-hourly-office-recovery': 10,
});

// A POLICY DEFAULT, NOT AN EVIDENCE-BACKED THRESHOLD. Deliberately generous: with no liveness
// signal, the cost of being wrong early (abandoning live work) is worse than being wrong late.
const DEFAULT_CEILING_MINUTES = 180;

function ceilingFor(row) {
  if (row.max_runtime_minutes != null) return Number(row.max_runtime_minutes);
  if (row.workflow && CEILINGS[row.workflow] != null) return CEILINGS[row.workflow];
  return DEFAULT_CEILING_MINUTES;
}

function lazyQuery(deps) {
  return (deps && deps.query) || require('../db').query;
}

// ── MEASUREMENT (read-only) ─────────────────────────────────────────────────
//
// Returns every non-terminal run with its age, its effective ceiling, whether it is over it, and
// its unresolved-consequential-action count. Changes nothing. This is what must be read BEFORE
// the reaper is ever pointed at production: "do not let the first production reaper invocation
// discover its policy by modifying rows."
async function candidates({ limit = 500, excludeRunId = null } = {}, deps = {}) {
  const query = lazyQuery(deps);
  const r = await query(
    `SELECT r.run_id, r.state, r.workflow, r.agent, r.product, r.intent_key, r.attempt,
            r.company_id, r.objective_id, r.max_runtime_minutes,
            r.created_at, r.started_at,
            EXTRACT(EPOCH FROM (NOW() - COALESCE(r.started_at, r.created_at))) / 60.0 AS age_minutes,
            (SELECT COUNT(*)::int FROM agent_run_events e
              WHERE e.run_id = r.run_id AND e.kind = 'ACTION_ATTEMPTED'
                AND NOT EXISTS (SELECT 1 FROM agent_run_events t
                                 WHERE t.run_id = e.run_id
                                   AND t.action_kind IS NOT DISTINCT FROM e.action_kind
                                   AND t.subject_ref IS NOT DISTINCT FROM e.subject_ref
                                   AND t.kind IN ('ACTION_SUCCEEDED','ACTION_FAILED'))
            ) AS unresolved
       FROM agent_runs r
      WHERE r.state = ANY($1)
        AND ($3::uuid IS NULL OR r.run_id <> $3::uuid)
      ORDER BY COALESCE(r.started_at, r.created_at)
      LIMIT $2`,
    [ACTIVE, Math.min(Math.max(1, limit), 1000), excludeRunId]
  );
  return r.rows.map((row) => {
    const ceiling = ceilingFor(row);
    const age = Number(row.age_minutes);
    const over = age > ceiling;
    return {
      ...row,
      age_minutes: Number(age.toFixed(2)),
      ceiling_minutes: ceiling,
      ceiling_source: row.max_runtime_minutes != null ? 'declared'
        : (row.workflow && CEILINGS[row.workflow] != null ? 'workflow_policy' : 'default'),
      over_ceiling: over,
      classification: !over ? 'fresh' : (row.unresolved > 0 ? 'known_unknown' : 'safe_stale'),
    };
  });
}

// ── RECOVERY OF ONE RUN ─────────────────────────────────────────────────────
//
// Returns { recovered: true, classification } for the single winner, or
// { recovered: false, reason, state } for everyone else. Never throws on a race.
async function recoverRun(runId, deps = {}) {
  const query = lazyQuery(deps);

  const cur = (await query(
    `SELECT run_id, state, workflow, company_id, objective_id, max_runtime_minutes, intent_key,
            created_at, started_at,
            EXTRACT(EPOCH FROM (NOW() - COALESCE(started_at, created_at))) / 60.0 AS age_minutes
       FROM agent_runs WHERE run_id = $1`, [runId]
  )).rows[0];
  if (!cur) return { recovered: false, reason: 'no_such_run' };
  if (!ACTIVE.includes(cur.state)) return { recovered: false, reason: 'already_terminal', state: cur.state };

  const ceiling = ceilingFor(cur);
  if (Number(cur.age_minutes) <= ceiling) {
    return { recovered: false, reason: 'fresh', state: cur.state, age_minutes: Number(cur.age_minutes), ceiling_minutes: ceiling };
  }

  const unresolved = (await query(
    `SELECT COUNT(*)::int n FROM agent_run_events e
      WHERE e.run_id = $1 AND e.kind = 'ACTION_ATTEMPTED'
        AND NOT EXISTS (SELECT 1 FROM agent_run_events t
                         WHERE t.run_id = e.run_id
                           AND t.action_kind IS NOT DISTINCT FROM e.action_kind
                           AND t.subject_ref IS NOT DISTINCT FROM e.subject_ref
                           AND t.kind IN ('ACTION_SUCCEEDED','ACTION_FAILED'))`, [runId]
  )).rows[0].n;
  const classification = unresolved > 0 ? 'known_unknown' : 'safe_stale';

  // THE ARBITER. Only a non-terminal row can be claimed, so exactly one racer gets a row back.
  // Deliberately NOT a SELECT followed by an UPDATE: between those two statements another reaper
  // can win, and both would then proceed to escalate.
  const claimed = await query(
    `UPDATE agent_runs
        SET state = 'ABANDONED', ended_at = NOW()
      WHERE run_id = $1 AND state = ANY($2)
      RETURNING run_id, state`,
    [runId, ACTIVE]
  );
  if (!claimed.rows.length) {
    const now = (await query(`SELECT state FROM agent_runs WHERE run_id=$1`, [runId])).rows[0];
    return { recovered: false, reason: 'lost_race', state: now ? now.state : null };
  }

  // Durable, append-only, machine-queryable. An email is not a record (K4 ruling 12).
  await query(
    `INSERT INTO agent_run_events (run_id, kind, error, detail)
     VALUES ($1, 'RECOVERY_ABANDONED', $2, $3::jsonb)`,
    [runId,
     classification === 'known_unknown'
       ? `recovered as ABANDONED with ${unresolved} unresolved consequential action(s): outcome UNKNOWN, not failed`
       : null,
     JSON.stringify({
       classification,
       unresolved_actions: unresolved,
       age_minutes: Number(Number(cur.age_minutes).toFixed(2)),
       ceiling_minutes: ceiling,
       ceiling_source: cur.max_runtime_minutes != null ? 'declared' : (CEILINGS[cur.workflow] != null ? 'workflow_policy' : 'default'),
       prior_state: cur.state,
       policy: 'office/recovery: declared ceiling exceeded; ABANDONED asserts no recorded outcome, never failure',
     })]
  );

  // A known-unknown must reach a human queue, not only the ledger. office_exceptions is the K7
  // infrastructure that already exists (K4 ruling 12: adopt, do not build a second one) — but it
  // requires company_id NOT NULL and a composite FK to (run_id, company_id), so a LEGACY run
  // cannot be filed there at all. For those the append-only event above is the durable record,
  // and it is machine-queryable, which is the stated minimum.
  let exceptionId = null;
  if (classification === 'known_unknown' && cur.company_id && cur.objective_id) {
    try {
      const ctx = Object.freeze({ companyId: cur.company_id, objectiveId: cur.objective_id, runId: cur.run_id });
      exceptionId = `ex-recovery-${runId}`;
      await require('./scope').openException(ctx, {
        id: exceptionId,
        runId,
        source: 'office/recovery',
        reason: `run abandoned with ${unresolved} unresolved consequential action(s) — external effect may have occurred; outcome is UNKNOWN. A retry requires a recorded human override.`,
        severity: 'critical',
        slaHours: 4,
      }, deps);
    } catch (e) {
      // The ledger record above is already durable, so a queue failure must not lose the
      // classification. Reported, never swallowed silently.
      exceptionId = null;
      // eslint-disable-next-line no-console
      console.error(`[office/recovery] known-unknown ${runId} recorded in the ledger but NOT queued: ${e.message}`);
    }
  }

  return { recovered: true, classification, unresolved_actions: unresolved, exception_id: exceptionId };
}

// ── THE REAPER ──────────────────────────────────────────────────────────────
//
// dryRun is the default ON PURPOSE. A reaper whose default is to act is one accidental invocation
// away from abandoning live production work, and the K4 ruling requires the candidate list to be
// read before anything is changed.
async function reap({ limit = 100, dryRun = true, excludeRunId = null } = {}, deps = {}) {
  // excludeRunId exists because the reaper now runs INSIDE a ledger run of its own (K4
  // activation). That run is CREATED/RUNNING while it works, so without this it would appear in
  // its own candidate list and — if it ever ran longer than its ceiling — abandon itself mid-flight
  // and then keep writing against a terminal run. The scheduler passes its own runId.
  const all = await candidates({ limit, excludeRunId }, deps);
  const eligible = all.filter((c) => c.over_ceiling);
  if (dryRun) {
    return {
      dry_run: true,
      inspected: all.length,
      eligible: eligible.length,
      safe_stale: eligible.filter((c) => c.classification === 'safe_stale').length,
      known_unknown: eligible.filter((c) => c.classification === 'known_unknown').length,
      fresh: all.length - eligible.length,
      would_change: eligible.map((c) => ({
        run_id: c.run_id, state: c.state, workflow: c.workflow,
        age_minutes: c.age_minutes, ceiling_minutes: c.ceiling_minutes,
        ceiling_source: c.ceiling_source, classification: c.classification,
      })),
    };
  }
  const results = [];
  for (const c of eligible) {
    if (excludeRunId && c.run_id === excludeRunId) continue;   // belt and braces
    results.push({ run_id: c.run_id, ...(await recoverRun(c.run_id, deps)) });
  }
  return {
    dry_run: false,
    inspected: all.length,
    recovered: results.filter((r) => r.recovered).length,
    skipped: results.filter((r) => !r.recovered).length,
    results,
  };
}

// ── THE RETRY ENTRY POINT ───────────────────────────────────────────────────
//
// The smallest supported path to attempt 2. Every rule is the database's; this reads the
// predecessor and hands createRun the right values. A refusal from the guard is returned, not
// translated — a rewritten error message is a second place for the policy to live.
async function retryRun(predecessorRunId, { overrideReason = null, triggerDetail = null } = {}, deps = {}) {
  const query = lazyQuery(deps);
  const p = (await query(
    `SELECT run_id, root_run_id, parent_run_id, trigger, workflow, agent, product, tenant_id,
            objective_id, company_id, actor_user_id, intent_key, attempt, state, max_runtime_minutes
       FROM agent_runs WHERE run_id = $1`, [predecessorRunId]
  )).rows[0];
  if (!p) return { retried: false, reason: 'no_such_run' };

  // Reported here rather than left to the guard only because the guard's message would name the
  // column, not the situation. The guard still enforces it — this is not the decision.
  if (!p.intent_key) {
    return { retried: false, reason: 'no_intent_key',
      detail: 'the predecessor has no intent_key, so a retry cannot be shown to be the same work' };
  }

  // K4 ruling 10: "STOPPED_BY_POLICY -> kill policy re-evaluated before retry."
  //
  // A policy stop is not a failure, and time passing does not lift it. Retrying one without
  // re-asking would walk straight through the kill switch — the one control the programme has
  // already production-validated — because the retry is a NEW run and nothing else on this path
  // consults autonomy. The scopes mirror scopesForCron's shape so one vocabulary governs both.
  if (p.state === 'STOPPED_BY_POLICY') {
    const autonomy = (deps && deps.autonomy) || require('../autonomy');
    let blocked;
    try {
      blocked = await autonomy.checkStopped(
        { workflow: p.workflow || undefined, agent: p.agent || undefined, company: p.company_id || undefined },
        { consequential: true, deps: { query } }
      );
    } catch (e) {
      // Fail closed. An unknowable kill state must not become permission to retry.
      return { retried: false, reason: 'killswitch_check_failed', detail: e.message };
    }
    if (blocked) {
      return { retried: false, reason: 'still_stopped_by_policy',
        scope_type: blocked.scope_type, scope_key: blocked.scope_key || null };
    }
  }

  const L = (deps && deps.ledger) || ledger({ query });
  try {
    const created = await L.createRun({
      trigger: p.trigger,
      triggerDetail: triggerDetail || `retry of ${predecessorRunId} (attempt ${p.attempt})`,
      workflow: p.workflow, agent: p.agent, product: p.product, tenantId: p.tenant_id,
      objectiveId: p.objective_id, companyId: p.company_id, actorUserId: p.actor_user_id,
      intentKey: p.intent_key,
      attempt: p.attempt + 1,
      predecessorRunId,
      retryOverrideReason: overrideReason,
      rootRunId: p.root_run_id,
      parentRunId: p.parent_run_id,
    });
    if (created.duplicate) return { retried: false, reason: 'intent_already_active', intentKey: created.intentKey };
    return { retried: true, runId: created.runId, attempt: p.attempt + 1, predecessorRunId };
  } catch (e) {
    // The database refused. Surfaced verbatim: it is the authoritative policy statement.
    return { retried: false, reason: 'refused_by_retry_guard', code: e.code, detail: e.message };
  }
}

// Known-unknowns that recovery has recorded. Machine-queryable, which is the ruled minimum.
async function knownUnknownRecoveries({ limit = 200 } = {}, deps = {}) {
  const query = lazyQuery(deps);
  const r = await query(
    `SELECT e.run_id, e.at, e.error, e.detail, r.workflow, r.intent_key, r.attempt, r.state,
            r.company_id, r.objective_id
       FROM agent_run_events e JOIN agent_runs r USING (run_id)
      WHERE e.kind = 'RECOVERY_ABANDONED'
        AND (e.detail->>'classification') = 'known_unknown'
      ORDER BY e.at DESC LIMIT $1`, [Math.min(Math.max(1, limit), 1000)]
  );
  return r.rows;
}

module.exports = {
  candidates, recoverRun, reap, retryRun, knownUnknownRecoveries,
  CEILINGS, DEFAULT_CEILING_MINUTES, ceilingFor, ACTIVE,
};
