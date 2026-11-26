// ── WHAT AN OPERATOR HAS TO BE ABLE TO SEE (B2.9) ───────────────────────────
//
// Owner's Priority 3, directive of 2026-11-25, and Priority 6 of the second: the next integrated
// demonstration must show *"the actual scheduler, actual deployed development cloud worker, durable
// execution history, worker availability, objective status, recovery and subsequent memory-informed
// execution"*, and the Command Center must distinguish:
//
//   cloud worker vs iMac, BY NAME · online / offline / degraded / revoked / unknown · the last
//   AUTHENTICATED heartbeat · declared capabilities vs ACTUAL availability · running / pending /
//   blocked / failed / completed tasks · the hardware-dependent backlog · active objectives, agent
//   assignments and execution history · budget reserved / measured / remaining / UNRESOLVED
//   exposure · STOP controls and authorization refusals
//
// ── IT IS A READ MODEL, AND IT COMPOSES. IT DECIDES NOTHING ────────────────
//
// Every figure comes from the module that owns it: `office/scope.js` for the kernel,
// `worker/identity.js` and `worker/leases.js` for workers and their work, `worker/task-types.js`
// for which capability a type demands, `autonomy.js` for stops and refusals,
// `office/operational-facts.js` for the operational records. This file writes nothing, authorizes
// nothing, and holds no company predicate of its own — the company comes off the resolved context,
// as everywhere else in this directory.
//
// ── THE DISTINCTIONS ARE THE PRODUCT, NOT THE NUMBERS ──────────────────────
//
// A dashboard that prints one number per row is easy. The reason this module exists is that several
// pairs of things which LOOK alike have to be told apart, and each of them has already cost this
// project something:
//
//   · **DECLARED capability vs ACTUAL availability.** `exec:gui` being granted says a worker MAY
//     run GUI work. It is not evidence that an eligible desktop session exists right now, and the
//     tracker has carried that gap as B4.4c since the capability work landed. So a declared
//     capability whose live precondition nothing has verified is reported as `unverified`, not as
//     available — because a dashboard that shows it as available is how a GUI task gets dispatched
//     to a machine with no session.
//   · **UNKNOWN vs OFFLINE.** A worker that has never authenticated has no heartbeat, and calling
//     that "offline" claims knowledge nobody has. A read that FAILED is also unknown, and must not
//     read as a quiet system.
//   · **A STALE hold vs an UNRESOLVED charge.** `scope.reservationState` already separates them and
//     the separation must survive the trip to the screen: a hold past its window that was never
//     dispatched is reclaimable, and one that WAS dispatched is money that may be gone. Summing
//     them under one heading is how an overspend becomes invisible.
//   · **A BLOCKED backlog vs an empty queue.** Work waiting for a capability no live worker holds
//     is not "nothing to do", and B4.3 built the queue so that such a task keeps its attempts
//     unconsumed precisely so it stays visible. Here it gets a name.
//
// Every section degrades on its own: a failure to read workers must not empty the objectives, and
// anything unreadable is reported as unreadable rather than as zero.

'use strict';

/** How fresh an authenticated heartbeat must be for a worker to count as online. */
const ONLINE_WITHIN_SECONDS = (() => {
  const raw = Number.parseInt(process.env.WORKER_ONLINE_WITHIN_SECONDS || '180', 10);
  if (!Number.isFinite(raw)) return 180;
  return Math.min(3600, Math.max(30, raw));
})();

const WORKER_STATUS = Object.freeze({
  REVOKED: 'revoked',
  UNKNOWN: 'unknown',
  ONLINE: 'online',
  DEGRADED: 'degraded',
  OFFLINE: 'offline',
});

/**
 * Which KIND of node is this? Derived from the capabilities the server granted, never from the
 * label's text.
 *
 * The owner asked for cloud worker and iMac to be distinguishable BY NAME, and the name is the
 * label, reported verbatim. The KIND is a different question and a string match on "imac" would be
 * inference dressed as a fact — a worker labelled "mac-mini-spare" is not less of a hardware node,
 * and one labelled "imac-sim" on Railway is not more of one. What makes a node a hardware node is
 * the capability it was granted, which is a row in the database.
 */
function kindOf(capabilities = []) {
  const caps = Array.isArray(capabilities) ? capabilities : [];
  if (caps.includes('exec:gui')) return 'gui_session_node';
  if (caps.includes('exec:hardware')) return 'hardware_node';
  return 'cloud_eligible_only';
}

/**
 * Declared capabilities against what can actually be relied on right now.
 *
 * `exec:gui` is the case that matters (B4.4c): the grant is server-authorized and the SESSION is
 * not verified by anything, so it is reported `unverified`. `exec:hardware` is reported `declared`
 * — the machine either answers or it does not, and its heartbeat is the evidence, which the status
 * above already carries.
 */
function availabilityOf(capabilities = [], { status }) {
  const caps = Array.isArray(capabilities) ? capabilities : [];
  return caps.map((c) => {
    if (status !== WORKER_STATUS.ONLINE) {
      return { capability: c, availability: 'unreachable',
        why: `the worker is ${status}, so nothing it declares can be relied on now` };
    }
    if (c === 'exec:gui') {
      return { capability: c, availability: 'unverified',
        why: 'a GUI capability is a GRANT, not evidence that an eligible desktop session exists '
          + 'right now — nothing verifies the session (B4.4c), so this must not read as available' };
    }
    return { capability: c, availability: 'declared',
      why: 'granted by the server and the worker is authenticating; the heartbeat is the evidence' };
  });
}

function statusOf(row, { now, stops }) {
  if (row.revoked_at) return WORKER_STATUS.REVOKED;
  if (!row.last_seen_at) return WORKER_STATUS.UNKNOWN;     // enrolled and never authenticated
  const ageMs = now - new Date(row.last_seen_at).getTime();
  const fresh = ageMs <= ONLINE_WITHIN_SECONDS * 1000;
  if (!fresh) return WORKER_STATUS.OFFLINE;
  // Reachable but unable to work: a stop that covers worker execution, by scope key or globally.
  const stopped = (stops || []).some((s) => (s.scope_type === 'global')
    || (s.scope_type === 'capability' && String(s.scope_key).startsWith('worker.'))
    || (s.scope_type === 'worker' && s.scope_key === row.id));
  return stopped ? WORKER_STATUS.DEGRADED : WORKER_STATUS.ONLINE;
}

/**
 * One snapshot for one company. Read-only.
 *
 * @returns a frozen object; every section carries its own `unreadable` rather than a zero.
 */
async function snapshot(ctx, { limitHistory = 20 } = {}, deps = {}) {
  const scope = deps.scope || require('./scope');
  const IDENT = deps.workerIdentity || require('../worker/identity');
  const LEASES = deps.leases || require('../worker/leases');
  const TYPES = deps.taskTypes || require('../worker/task-types');
  const autonomy = deps.autonomy || require('../autonomy');
  const FACTS = deps.operationalFacts || require('./operational-facts');
  const now = deps.nowMs ? deps.nowMs() : Date.now();

  const unreadable = [];
  const section = async (name, fn, fallback) => {
    try { return await fn(); } catch (e) {
      unreadable.push({ section: name, error: e.message });
      return fallback;
    }
  };

  // ── STOPS FIRST: they decide whether a reachable worker is degraded ──────
  const stops = await section('stops', () => autonomy.listStops({ deps }), null);

  // ── WORKERS ─────────────────────────────────────────────────────────────
  const workerRows = await section('workers',
    () => IDENT.listWorkers({ includeRevoked: true }, deps), null);
  const workers = (workerRows || []).map((w) => {
    const caps = Array.isArray(w.capabilities) ? w.capabilities : [];
    const status = statusOf(w, { now, stops });
    return Object.freeze({
      id: w.id,
      name: w.label || null,            // verbatim: the operator's own name for the machine
      kind: kindOf(caps),
      status,
      // The owner asked for the last AUTHENTICATED heartbeat, and this column is written in
      // worker/auth.js AFTER the signature verifies — so it is exactly that, and not a
      // last-contacted timestamp that an unauthenticated request could move.
      lastAuthenticatedAt: w.last_seen_at ? new Date(w.last_seen_at).toISOString() : null,
      lastAuthenticatedAgeSeconds: w.last_seen_at
        ? Math.round((now - new Date(w.last_seen_at).getTime()) / 1000) : null,
      declaredCapabilities: Object.freeze(caps),
      capabilityAvailability: Object.freeze(availabilityOf(caps, { status })),
      revokedAt: w.revoked_at ? new Date(w.revoked_at).toISOString() : null,
      revokedReason: w.revoked_reason || null,
      enrolledAt: w.enrolled_at ? new Date(w.enrolled_at).toISOString() : null,
    });
  });

  // Capabilities that are actually servable right now: declared by an ONLINE worker. A revoked or
  // offline worker's grant is not capacity.
  const liveCapabilities = new Set();
  for (const w of workers) {
    if (w.status !== WORKER_STATUS.ONLINE) continue;
    for (const a of w.capabilityAvailability) {
      if (a.availability === 'declared') liveCapabilities.add(a.capability);
    }
  }

  // ── WORK ────────────────────────────────────────────────────────────────
  const work = await section('work', async () => {
    const counts = await LEASES.taskStateCounts({ companyId: ctx.companyId }, deps);
    const waiting = await LEASES.pendingTaskTypes({ companyId: ctx.companyId }, deps);
    // The hardware-dependent backlog: PENDING work whose required capability no ONLINE worker
    // serves. B4.3 keeps such a task PENDING with its attempts unconsumed so that it stays
    // visible; this is where it becomes legible.
    const blocked = waiting.map((t) => {
      const required = TYPES.requiredCapabilityOf(t.task_type);
      const servable = !required || liveCapabilities.has(required);
      return { taskType: t.task_type, pending: t.n, requiredCapability: required || null,
        servableNow: servable };
    });
    return Object.freeze({
      byState: Object.freeze(counts),
      blockedBacklog: Object.freeze(blocked.filter((b) => !b.servableNow)),
      servableBacklog: Object.freeze(blocked.filter((b) => b.servableNow)),
    });
  }, null);

  // ── OBJECTIVES, THEIR RUNS AND THEIR MONEY ──────────────────────────────
  const objectives = await section('objectives', async () => {
    const objs = await scope.listObjectives(ctx, deps);
    const out = [];
    for (const o of objs) {
      const money = await section(`budget:${o.id}`,
        () => scope.reservationState(ctx, o.id, deps), null);
      const measured = await section(`spend:${o.id}`,
        () => scope.spendForObjective(ctx, o.id, deps), null);
      const budget = o.budget_usd === null ? null : Number(o.budget_usd);
      const held = money ? Number(money.live_held) : null;
      const spent = measured ? Number(measured.usd) : null;
      out.push(Object.freeze({
        id: o.id,
        objective: o.objective,
        status: o.status,
        autonomyTier: o.autonomy_tier,
        budgetUsd: budget,
        spend: Object.freeze({
          measuredUsd: spent,
          heldUsd: held,
          // Stated as null rather than computed from a missing part: a remaining figure derived
          // from an unknown held amount is a number that looks safe and is not.
          remainingUsd: (budget !== null && held !== null && spent !== null)
            ? Number((budget - held - spent).toFixed(6)) : null,
          unmeasuredCalls: measured ? measured.unknown_calls : null,
          // KEPT SEPARATE, deliberately — see the module header.
          unresolvedExposureUsd: money ? Number(money.unresolved_usd) : null,
          unresolvedCount: money ? money.unresolved_count : null,
          staleHoldCount: money ? money.stale_count : null,
        }),
      }));
    }
    return Object.freeze(out);
  }, null);

  // ── EXECUTION HISTORY: the durable record, newest first ─────────────────
  const history = await section('history',
    () => scope.recentRuns(ctx, { limit: limitHistory }, deps), null);

  // ── OPEN ALERTS (B4.5), WHICH ARE THE MONITOR'S OUTPUT ──────────────────
  // The monitor files them and sends nothing; this is where they are read. Deliberately the
  // accessor's own list rather than a second predicate: an alert this page shows as open must be
  // one the monitor considers open, or the two will disagree in front of somebody at 3am.
  const alerts = await section('alerts', () => scope.openAlerts(ctx, { limit: 50 }, deps), null);

  // ── AUTHORIZATION REFUSALS ──────────────────────────────────────────────
  const refusals = await section('refusals',
    () => autonomy.history({ limit: limitHistory, deps }), null);

  // ── THE OPERATIONAL RECORDS (B3.19), WITH THEIR QUALITY ─────────────────
  const operational = await section('operationalFacts', async () => {
    const { businessToday } = deps.agentCore || require('../agent-core');
    return FACTS.collect(ctx, { asOf: businessToday() }, deps);
  }, null);

  return Object.freeze({
    companyId: ctx.companyId,
    at: new Date(now).toISOString(),
    onlineWithinSeconds: ONLINE_WITHIN_SECONDS,
    workers: Object.freeze(workers),
    workersUnreadable: workerRows === null,
    liveCapabilities: Object.freeze([...liveCapabilities].sort()),
    work,
    objectives,
    history: history ? Object.freeze(history) : null,
    stops: stops ? Object.freeze(stops) : null,
    openAlerts: alerts ? Object.freeze(alerts) : null,
    refusals: refusals ? Object.freeze(refusals) : null,
    operationalFacts: operational ? operational.facts : null,
    factQuality: operational ? operational.quality : null,
    // A section that could not be read is NAMED. An empty dashboard and a broken one look
    // identical otherwise, and this system has spent three weeks learning what that costs.
    unreadable: Object.freeze(unreadable),
  });
}

module.exports = { snapshot, WORKER_STATUS, ONLINE_WITHIN_SECONDS, kindOf, availabilityOf, statusOf };
