// ── DEDUPLICATED OPERATIONAL MONITORING, WITH NO TRANSPORT (B4.5) ───────────
//
// Owner's Priority 3, directive of 2026-11-25: *"implement deduplicated monitoring with NO external
// notifications until separately authorized. Do not repurpose the `email.alert` exemption for
// business mail."* And from B4.5's own row: *"silence > 5 min → one deduplicated alert, haltable by
// its own STOP."*
//
// ── THIS MODULE CANNOT SEND ANYTHING, BY CONSTRUCTION ──────────────────────
//
// It requires no mailer, no WhatsApp client, no fetch and no transport of any kind — the same shape
// as `office/memory.js`, which holds no transport so that an adversarial memory has no body to put
// in front of one. `monitor-has-no-transport.test.js` asserts that on the source.
//
// So "no external notifications until separately authorized" is not a flag somebody can flip by
// accident: there is nothing here to flip. Making this module able to notify would mean adding a
// dependency, which is a reviewable change rather than a configuration one. What it does instead is
// WRITE what it found, where the Command Center and an operator can read it.
//
// ── THE DEDUPLICATION IS A PRIMARY KEY, NOT A RULE ─────────────────────────
//
// Every finding has an id derived from its code and its subject, so a condition that persists for
// three days is ONE row whose `occurrences` and `last_seen_at` move. A monitor firing every five
// minutes cannot produce 864 identical rows even if somebody later forgets why that mattered —
// which is the same reason every effect in this directory is keyed by a derived id (B3.17).
//
// And an alert is resolved by the CONDITION going away, decided by the evaluation that just ran,
// never by a timeout. An alert that ages out while the fault is live is how a monitor teaches
// people to ignore it.
//
// ── WHAT IT WATCHES, AND THE ONE THING IT REFUSES TO CLAIM ─────────────────
//
// It reads the Command Center snapshot — the read model that already tells apart unknown from
// offline, declared from available, a stale hold from an unresolved charge — plus the scheduler's
// own heartbeat. It adds no second opinion about any of those: a monitor that recomputed them would
// drift from the dashboard, and then the two would disagree in front of somebody at 3am.
//
// The thing it refuses to claim is that the scheduler is BROKEN when the scheduler is simply
// switched off. `OFFICE_INITIATOR_ENABLED` is unset everywhere today, so a missing heartbeat is the
// expected state and the finding is `info` with that reason named. An alert that fires because the
// system is deliberately inert is noise, and noise is what makes a real alert unreadable.

'use strict';

/** Silence longer than this, from a scheduler that is supposed to be running, is a finding. */
const SILENCE_AFTER_SECONDS = (() => {
  const raw = Number.parseInt(process.env.OFFICE_MONITOR_SILENCE_SECONDS || '300', 10);
  if (!Number.isFinite(raw)) return 300;
  return Math.min(86_400, Math.max(60, raw));
})();

const SEVERITY = Object.freeze({ INFO: 'info', WARNING: 'warning', CRITICAL: 'critical' });

/**
 * A live run whose newest DURABLE write is older than this has stopped making progress, however
 * many ticks it has received.
 *
 * ── WHY IT IS LONGER THAN THE PHASE GRACE WINDOW ───────────────────────────
 *
 * The cycle's own grace is 60 minutes, and inside it a COLLECT that is waiting for a worker is
 * CORRECT behaviour that escalates nothing. An execution-stalled alert at 60 minutes would
 * therefore fire on every legitimate wait and duplicate `ex-wait-<runId>`, which is how an alarm
 * becomes noise. 120 minutes is past the point where the cycle has already escalated its own wait,
 * so this finding only ever means something the cycle itself did not account for.
 */
const STALLED_AFTER_SECONDS = (() => {
  const raw = Number.parseInt(process.env.OFFICE_MONITOR_STALLED_SECONDS || '7200', 10);
  if (!Number.isFinite(raw)) return 7200;
  return Math.min(604_800, Math.max(300, raw));
})();

const CODES = Object.freeze({
  SCHEDULER_SILENT: 'scheduler_silent',
  SCHEDULER_DISABLED: 'scheduler_disabled',
  // Deliberately a DIFFERENT code from SCHEDULER_SILENT, and the distinction is the owner's
  // Priority 4: *"A scheduler repeatedly skipping ticks must not conceal a permanently stalled
  // execution."* Silence means the cron is not beating. This means the cron IS beating and nothing
  // is moving — which a heartbeat cannot see, and which is the worse of the two because every
  // signal looks healthy.
  EXECUTION_STALLED: 'execution_stalled',
  EXECUTION_PROGRESS_UNREADABLE: 'execution_progress_unreadable',
  WORKER_OFFLINE: 'worker_offline',
  WORKER_NEVER_AUTHENTICATED: 'worker_never_authenticated',
  WORKER_REVOKED_WITH_WORK: 'worker_revoked_while_work_waits',
  BACKLOG_BLOCKED: 'backlog_blocked_on_capability',
  UNRESOLVED_EXPOSURE: 'unresolved_financial_exposure',
  STALE_HOLD: 'stale_budget_hold',
  OPEN_EXCEPTIONS: 'open_exceptions',
  FACTS_UNSUPPORTABLE: 'operational_facts_unsupportable',
  SECTION_UNREADABLE: 'section_unreadable',
  STOP_IN_FORCE: 'stop_in_force',
});

/**
 * The id of a finding: its code and its subject, readable.
 *
 * ── WHY NOT A HASH ─────────────────────────────────────────────────────────
 *
 * The first version hashed them, and `check-approval-digest-discipline.js` refused it: that scanner
 * forbids a second `createHash` over fields anywhere in this codebase, because one expression of
 * "the message that was approved" is what keeps a producer and a consumer from each being
 * internally consistent and still disagreeing. The finding was a false positive in substance — no
 * message field is involved — and the rule is still the right one to keep strict, so the fix is to
 * not hash.
 *
 * It is better anyway. `office_monitor_alerts.id` is a TEXT key an operator reads in a table, and
 * `alert-worker_offline-wkr_4d25…` says which alert it is without a join — the same reason
 * `task-cycle-<runId>` is readable rather than a UUID. The subject is NOT truncated: two subjects
 * sharing a prefix would collide, and a colliding alert id means one fault hiding inside another's
 * `occurrences` count.
 */
function alertId(code, subject) {
  const safe = String(subject).replace(/[^A-Za-z0-9_:.@-]+/g, '_');
  return `alert-${code}-${safe}`;
}

const finding = (code, subject, severity, detail) => ({
  id: alertId(code, subject), code, subject, severity, detail,
});

/**
 * What is wrong right now, for one company. READ-ONLY: it writes nothing.
 *
 * @returns {{findings: Array, snapshot: object, schedulerEnabled: boolean}}
 */
async function evaluate(ctx, { schedulerEnabled = null } = {}, deps = {}) {
  const CC = deps.commandCenter || require('./command-center');
  const scope = deps.scope || require('./scope');
  const now = deps.nowMs ? deps.nowMs() : Date.now();

  const snapshot = await CC.snapshot(ctx, { limitHistory: 10 }, deps);
  const findings = [];

  // Whether the scheduler is SUPPOSED to be running is an environment fact, and it is read here
  // rather than assumed, because the whole severity of the silence finding turns on it.
  const enabled = schedulerEnabled === null
    ? String((deps.env || process.env).OFFICE_INITIATOR_ENABLED || '') === 'true'
    : !!schedulerEnabled;

  // ── 1. IS THE SCHEDULER ALIVE? ──────────────────────────────────────────
  let beats = null;
  try {
    beats = await scope.schedulerHeartbeats(deps);
  } catch (e) {
    findings.push(finding(CODES.SECTION_UNREADABLE, 'scheduler_heartbeats', SEVERITY.WARNING,
      `the scheduler's own liveness signal could not be read: ${e.message}`));
  }
  if (beats) {
    const advance = beats.find((b) => b.name === 'office-cycle-advance');
    const ageSeconds = advance ? Math.round((now - new Date(advance.at).getTime()) / 1000) : null;
    if (!enabled) {
      // NOT a failure. `OFFICE_INITIATOR_ENABLED` is unset everywhere today, so silence is the
      // expected state and saying otherwise would be an alert that fires because the system is
      // deliberately inert.
      findings.push(finding(CODES.SCHEDULER_DISABLED, 'office-cycle-advance', SEVERITY.INFO,
        'the advancement cron is inert because OFFICE_INITIATOR_ENABLED is not set — this is the '
        + 'expected state today, and it is reported so that "no ticks" is never mistaken for a '
        + 'stalled scheduler'));
    } else if (ageSeconds === null) {
      findings.push(finding(CODES.SCHEDULER_SILENT, 'office-cycle-advance', SEVERITY.CRITICAL,
        'the advancement cron is enabled and has never recorded a heartbeat: nothing is advancing '
        + 'any authorized run'));
    } else if (ageSeconds > SILENCE_AFTER_SECONDS) {
      findings.push(finding(CODES.SCHEDULER_SILENT, 'office-cycle-advance', SEVERITY.CRITICAL,
        `the advancement cron last beat ${ageSeconds}s ago, past the ${SILENCE_AFTER_SECONDS}s `
        + 'bound — a run that exists is authorized and nothing is carrying it forward'));
    }
  }

  // ── 1b. IS EXECUTION MOVING? (reachability is not progress) ─────────────
  //
  // Measured from the DURABLE ROWS the phases leave behind, never from the heartbeat. A cron that
  // beats and refuses is reachable and frozen, and the heartbeat says nothing about which. This is
  // deliberately evaluated whether or not the scheduler is enabled: a run left live by a scheduler
  // somebody turned OFF is exactly the case where everything looks quiet and a run sits authorized
  // for ever, and `SCHEDULER_DISABLED` alone would present that as the expected state.
  try {
    const progress = await scope.liveRunProgress(ctx, { limit: 20 }, deps);
    for (const r of progress) {
      const at = r.last_progress_at ? new Date(r.last_progress_at).getTime() : null;
      if (!at) continue;                       // no timestamp at all: nothing to measure against
      const ageSeconds = Math.round((now - at) / 1000);
      if (ageSeconds <= STALLED_AFTER_SECONDS) continue;
      findings.push(finding(CODES.EXECUTION_STALLED, r.run_id, SEVERITY.CRITICAL,
        `run ${r.run_id} is ${r.state} and its newest durable write is ${ageSeconds}s old, past `
        + `the ${STALLED_AFTER_SECONDS}s bound. The scheduler's own liveness is reported `
        + 'separately and is not evidence about this: a cron can beat every fifteen seconds while '
        + 'every tick refuses, and then nothing is advancing a run that is still authorized to act'));
    }
  } catch (e) {
    // NAMED rather than swallowed. "Progress could not be measured" and "everything is moving"
    // must never look the same, which is the whole reason this file reports unreadable sections.
    findings.push(finding(CODES.EXECUTION_PROGRESS_UNREADABLE, 'live_run_progress', SEVERITY.CRITICAL,
      `whether any run is making progress could not be determined: ${e.message} — this is not the `
      + 'same as nothing being stalled'));
  }

  // ── 2. WORKERS ──────────────────────────────────────────────────────────
  if (snapshot.workersUnreadable) {
    findings.push(finding(CODES.SECTION_UNREADABLE, 'workers', SEVERITY.CRITICAL,
      'the worker identities could not be read, so worker availability is unknown — which is not '
      + 'the same as there being no workers'));
  }
  const pendingWork = (snapshot.work && snapshot.work.byState
    && snapshot.work.byState.pending) || 0;
  for (const w of snapshot.workers) {
    if (w.status === CC.WORKER_STATUS.OFFLINE) {
      findings.push(finding(CODES.WORKER_OFFLINE, w.id,
        pendingWork > 0 ? SEVERITY.WARNING : SEVERITY.INFO,
        `${w.name || w.id} (${w.kind}) last authenticated `
        + `${w.lastAuthenticatedAgeSeconds}s ago${pendingWork > 0
          ? `, while ${pendingWork} task(s) are pending` : ', with no work waiting'}`));
    }
    if (w.status === CC.WORKER_STATUS.UNKNOWN) {
      findings.push(finding(CODES.WORKER_NEVER_AUTHENTICATED, w.id, SEVERITY.INFO,
        `${w.name || w.id} is enrolled and has never authenticated — an identity that was issued `
        + 'and never used, which is worth knowing before anybody counts it as capacity'));
    }
    if (w.status === CC.WORKER_STATUS.REVOKED && pendingWork > 0) {
      findings.push(finding(CODES.WORKER_REVOKED_WITH_WORK, w.id, SEVERITY.INFO,
        `${w.name || w.id} is revoked (${w.revokedReason || 'no reason recorded'}) while `
        + `${pendingWork} task(s) wait — stated because a revoked node's capability is not capacity`));
    }
  }

  // ── 3. WORK NOTHING CAN SERVE ───────────────────────────────────────────
  for (const b of (snapshot.work ? snapshot.work.blockedBacklog : [])) {
    findings.push(finding(CODES.BACKLOG_BLOCKED, `${b.taskType}:${b.requiredCapability}`,
      SEVERITY.WARNING,
      `${b.pending} ${b.taskType} task(s) wait for ${b.requiredCapability}, which no online worker `
      + 'serves — B4.3 keeps them PENDING with their attempts unconsumed, so this is a backlog and '
      + 'not a failure, and it will not clear by itself'));
  }

  // ── 4. MONEY ────────────────────────────────────────────────────────────
  for (const o of (snapshot.objectives || [])) {
    if (o.spend.unresolvedExposureUsd > 0) {
      findings.push(finding(CODES.UNRESOLVED_EXPOSURE, o.id, SEVERITY.CRITICAL,
        `$${o.spend.unresolvedExposureUsd} is held against ${o.id} in an unresolved financial `
        + `state (${o.spend.unresolvedCount} hold(s)) — a dispatched hold whose charge nobody has `
        + 'reconciled keeps counting with no window, and only a human can close it'));
    }
    if (o.spend.staleHoldCount > 0) {
      findings.push(finding(CODES.STALE_HOLD, o.id, SEVERITY.WARNING,
        `${o.spend.staleHoldCount} hold(s) on ${o.id} are past their window and were never `
        + 'dispatched — reclaimable, and deliberately counted apart from unresolved exposure'));
    }
  }

  // ── 5. THE RECORDS THE BRIEFING RESTS ON ────────────────────────────────
  if (snapshot.factQuality && snapshot.factQuality.total
    && snapshot.factQuality.supportable < snapshot.factQuality.total) {
    const short = snapshot.factQuality.total - snapshot.factQuality.supportable;
    findings.push(finding(CODES.FACTS_UNSUPPORTABLE, 'operational_facts', SEVERITY.WARNING,
      `${short} of ${snapshot.factQuality.total} operational fact(s) cannot be supported `
      + '(missing, stale or unavailable), so a briefing built on them is not a statement of fact — '
      + 'see B3.19 and the attribution backfill'));
  }

  // ── 6. EVERY OTHER SECTION THAT COULD NOT BE READ ───────────────────────
  for (const u of (snapshot.unreadable || [])) {
    if (u.section === 'workers') continue;              // already reported above, at CRITICAL
    findings.push(finding(CODES.SECTION_UNREADABLE, u.section, SEVERITY.WARNING,
      `the ${u.section} section could not be read: ${u.error}`));
  }

  // ── 7. A STOP IS A FACT, NOT A FAULT ────────────────────────────────────
  for (const st of (snapshot.stops || [])) {
    findings.push(finding(CODES.STOP_IN_FORCE, `${st.scope_type}:${st.scope_key || ''}`,
      SEVERITY.INFO,
      `a ${st.scope_type} stop is in force${st.scope_key ? ` on ${st.scope_key}` : ''}: `
      + `${st.reason} (set by ${st.set_by || 'unknown'}) — reported because an operator looking at `
      + 'a quiet office must be able to see that it is quiet ON PURPOSE'));
  }

  return { findings, snapshot, schedulerEnabled: enabled, silenceAfterSeconds: SILENCE_AFTER_SECONDS };
}

/**
 * Evaluate, file what is found, and resolve what is no longer found.
 *
 * Writes only to `office_monitor_alerts`, through the accessor. Sends nothing — there is nothing
 * here that could.
 */
async function sweep(ctx, opts = {}, deps = {}) {
  const scope = deps.scope || require('./scope');
  const { findings, snapshot, schedulerEnabled, silenceAfterSeconds } =
    await evaluate(ctx, opts, deps);

  const filed = [];
  const errors = [];
  for (const f of findings) {
    try {
      const row = await scope.recordAlert(ctx, {
        id: f.id, code: f.code, subject: f.subject, severity: f.severity, detail: f.detail,
      }, deps);
      filed.push({ id: f.id, code: f.code, occurrences: row.occurrences });
    } catch (e) {
      // NOT swallowed: an alert that failed to persist is a fault the monitor itself cannot see
      // next time, which is the swallowed-write defect this repository has paid for three times.
      errors.push({ id: f.id, code: f.code, error: e.message });
    }
  }

  let resolved = [];
  if (!errors.length) {
    // Only when every finding was filed. Resolving against a partial set would close an alert
    // because its write failed, which is the most dangerous possible direction for this to fail in.
    try {
      resolved = await scope.resolveAlertsExcept(ctx, { ids: findings.map((f) => f.id) }, deps);
    } catch (e) { errors.push({ id: null, code: 'resolve', error: e.message }); }
  }

  return {
    ok: errors.length === 0,
    filed, resolved, errors,
    counts: {
      critical: findings.filter((f) => f.severity === SEVERITY.CRITICAL).length,
      warning: findings.filter((f) => f.severity === SEVERITY.WARNING).length,
      info: findings.filter((f) => f.severity === SEVERITY.INFO).length,
    },
    schedulerEnabled, silenceAfterSeconds,
    // Carried so a caller logging this does not have to take a second snapshot to say why.
    at: snapshot.at,
  };
}

module.exports = {
  evaluate, sweep, alertId, CODES, SEVERITY, SILENCE_AFTER_SECONDS, STALLED_AFTER_SECONDS,
};
