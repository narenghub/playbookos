// ── B3.4: GOVERNED CAPABILITY DISCOVERY ─────────────────────────────────────
//
// Step 5 of the owner's operating cycle: *"Discover authorized capabilities."*
//
// ── WHAT DISCOVERY IS, AND WHAT IT IS NOT ──────────────────────────────────
//
// This module answers "what could this company's agents do right now, and what is standing in the
// way of the rest". It is a REPORT. It grants nothing, and nothing downstream may treat its output
// as permission:
//
//   • every gate still runs. A step type reported `available` here is still validated by
//     office/decomposition.js against all six gates, and a capability reported clear is still
//     re-checked against the kill switch at the moment of use. Discovery is a snapshot; a stop can
//     land between the snapshot and the act, which is exactly why the act asks again.
//   • it returns no tokens, no credentials and no handles — there is nothing in the result a caller
//     could present as authority.
//   • scripts/check-capability-discovery-db.js asserts both: that a stopped capability is reported
//     unavailable, and that the report cannot be used to execute anything a gate would refuse.
//
// ── UNAVAILABLE IS REPORTED, NOT HIDDEN ────────────────────────────────────
//
// The tempting shape is to return only what works. That makes a stalled plan invisible: an agent
// asks what it can do, is told four things, and never learns that the fifth is one revoked worker
// away from being possible. So every known capability appears with a verdict and a REASON —
// `stopped`, `no_capable_worker`, `unknown` — and a caller that wants only the usable set filters
// it itself, having seen the rest.
//
// ── AND AN UNREADABLE SOURCE IS UNKNOWN, NEVER EMPTY ───────────────────────
//
// If the kill switch cannot be read, every capability is `unknown` rather than clear; if the worker
// fleet cannot be read, execution eligibility is `unknown` rather than "nothing is executable".
// The distinction matters because a caller acting on "nothing is executable" would report a
// platform with no capabilities, which is a claim about the business that a database error does not
// support — the rule office/memory.js and identity/company-membership.js both follow.

'use strict';

const autonomy = require('../autonomy');
const TYPES = require('../worker/task-types');
const DECOMP = require('./decomposition');
const DELEGATION = require('./delegation');
const { assertContext } = require('./context');

/** Verdicts a discovered capability can carry. */
const VERDICT = Object.freeze({
  AVAILABLE: 'available',
  STOPPED: 'stopped',
  NO_CAPABLE_WORKER: 'no_capable_worker',
  UNKNOWN: 'unknown',
});

/**
 * What can this company's agents do right now?
 *
 * The company comes from `ctx` and is never a parameter, so a caller cannot discover another
 * company's capabilities — the same structural choice as every other module in this kernel.
 *
 * @returns {{companyId, capabilities, taskTypes, delegableAgents, stepTypes, businessCapabilities,
 *            degraded}}
 */
async function discover(ctx, { workflow = 'capability-discovery',
  agent = 'executive-agent' } = {}, deps = {}) {
  assertContext(ctx);

  const degraded = [];

  // ── 1. THE KILL-SWITCH CAPABILITY VOCABULARY ────────────────────────────
  //
  // Asked per capability, with this company's key. Asked as a consequential caller for the same
  // reason the other gates do: the read-only path ignores every scope but `capability`, and a
  // global or company stop is exactly what discovery must see.
  const capabilities = [];
  for (const capability of autonomy.CAPABILITIES) {
    let hit;
    try {
      hit = await autonomy.checkStopped(
        { company: ctx.companyId, capability, workflow, agent },
        { consequential: true, deps });
    } catch (e) {
      capabilities.push({ capability, verdict: VERDICT.UNKNOWN,
        reason: `the stop state could not be read (${e.message})` });
      if (!degraded.includes('kill_switch')) degraded.push('kill_switch');
      continue;
    }
    if (hit && hit.unknown === true) {
      capabilities.push({ capability, verdict: VERDICT.UNKNOWN, reason: hit.reason });
      if (!degraded.includes('kill_switch')) degraded.push('kill_switch');
      continue;
    }
    if (hit) {
      capabilities.push({ capability, verdict: VERDICT.STOPPED,
        reason: `stopped at ${hit.scope_type}${hit.scope_key ? `=${hit.scope_key}` : ''}: ${hit.reason}`,
        scope: hit.scope_type });
      continue;
    }
    capabilities.push({ capability, verdict: VERDICT.AVAILABLE });
  }
  const capVerdict = Object.fromEntries(capabilities.map((c) => [c.capability, c.verdict]));

  // ── 2. WHAT THE FLEET CAN EXECUTE ───────────────────────────────────────
  //
  // Enrolled and not revoked only. A revoked worker's capabilities are not the fleet's — counting
  // them would report a hardware task as executable by a machine that may never return.
  let fleet = null;
  try {
    fleet = await DECOMP.workerCapabilities(deps);
  } catch (e) {
    degraded.push('worker_fleet');
  }

  const taskTypes = TYPES.KNOWN.map((type) => {
    const def = TYPES.definitionOf(type);
    const needed = TYPES.requiredCapabilityOf(type);
    const row = {
      taskType: type,
      executionClass: TYPES.executionClassOf(type),
      requiredCapability: needed,
      readOnly: def.readOnly === true,
      reexecutable: def.reexecutable === true,
    };
    if (fleet === null) {
      row.verdict = VERDICT.UNKNOWN;
      row.reason = 'the worker fleet could not be read — execution eligibility is undecided, '
        + 'which is not the same as nothing being executable';
      return row;
    }
    if (capVerdict['worker.execute'] === VERDICT.STOPPED) {
      row.verdict = VERDICT.STOPPED;
      row.reason = 'worker.execute is stopped for this company';
      return row;
    }
    if (needed !== null && !fleet.has(needed)) {
      row.verdict = VERDICT.NO_CAPABLE_WORKER;
      row.reason = `no enrolled, non-revoked worker declares ${needed}; work of this type queues `
        + 'safely with its attempts unconsumed';
      return row;
    }
    row.verdict = VERDICT.AVAILABLE;
    return row;
  });

  // ── 3. WHICH AGENTS MAY BE DELEGATED TO ─────────────────────────────────
  const delegableAgents = [];
  for (const [name, def] of Object.entries(DELEGATION.DELEGABLE)) {
    let hit;
    try {
      hit = await autonomy.checkStopped(
        { company: ctx.companyId, capability: def.capability, workflow: def.workflow, agent: name },
        { consequential: true, deps });
    } catch (e) {
      delegableAgents.push({ agent: name, capability: def.capability, workflow: def.workflow,
        verdict: VERDICT.UNKNOWN, reason: `the stop state could not be read (${e.message})` });
      continue;
    }
    if (hit && hit.unknown === true) {
      delegableAgents.push({ agent: name, capability: def.capability, workflow: def.workflow,
        verdict: VERDICT.UNKNOWN, reason: hit.reason });
      continue;
    }
    delegableAgents.push({
      agent: name, capability: def.capability, workflow: def.workflow,
      consequential: def.consequential === true,
      verdict: hit ? VERDICT.STOPPED : VERDICT.AVAILABLE,
      ...(hit ? { reason: `stopped at ${hit.scope_type}${hit.scope_key ? `=${hit.scope_key}` : ''}: ${hit.reason}` } : {}),
    });
  }

  // ── 4. WHICH PLAN STEPS COULD BE PROPOSED ───────────────────────────────
  //
  // Derived from the two above rather than asked again, because a step's usability IS its
  // capability's verdict and its task type's verdict. Deriving keeps the two from disagreeing.
  const byTaskType = Object.fromEntries(taskTypes.map((t) => [t.taskType, t]));
  const stepTypes = Object.entries(DECOMP.STEP_VOCABULARY).map(([stepType, def]) => {
    const row = { stepType, capability: def.capability, taskType: def.taskType,
      consequential: def.consequential === true, prepareOnly: def.prepareOnly === true };
    const capV = def.capability === null ? VERDICT.AVAILABLE : capVerdict[def.capability];
    if (capV !== VERDICT.AVAILABLE) {
      row.verdict = capV;
      row.reason = `capability ${def.capability} is ${capV}`;
      return row;
    }
    if (def.taskType !== null) {
      const t = byTaskType[def.taskType];
      if (t && t.verdict !== VERDICT.AVAILABLE) {
        row.verdict = t.verdict;
        row.reason = t.reason;
        return row;
      }
    }
    row.verdict = VERDICT.AVAILABLE;
    return row;
  });

  // ── 5. THE COMPANY'S VERIFIED BUSINESS CAPABILITIES ─────────────────────
  //
  // A different kind of capability and deliberately kept separate: GMP certification is not
  // something an agent may DO, it is something the company HAS, and conflating the two would let a
  // held certificate read as an executable permission. Reported for the briefing's benefit.
  //
  // Through the existing registry, which already excludes fixture-sourced evidence at the accessor
  // rather than leaving that to the caller.
  let businessCapabilities = null;
  try {
    const registry = require('./capability-registry');
    businessCapabilities = (await registry.activeCapabilities(
      deps.query || require('../db').query, ctx.companyId))
      .map((r) => ({ name: r.name, kind: r.kind, businessLine: r.business_line,
        evidenceClass: r.evidence_class }));
  } catch (e) {
    // The REASON travels with the degradation. Without it a caller sees
    // `degraded: ['business_capabilities']` and has no way to tell a missing table from a bad
    // query — which is exactly where the first run of check-autonomous-office-cycle-db.js got
    // stuck, with the table present and the read still failing.
    degraded.push(`business_capabilities: ${e.message}`);
  }

  return {
    companyId: ctx.companyId,
    capabilities,
    taskTypes,
    delegableAgents,
    stepTypes,
    businessCapabilities,
    // Named so a caller can say "this report is partial" rather than quietly acting on a subset.
    degraded,
    at: new Date().toISOString(),
  };
}

/** The usable subset, for a caller that has already seen the rest. */
function availableOnly(report) {
  return {
    capabilities: report.capabilities.filter((c) => c.verdict === VERDICT.AVAILABLE)
      .map((c) => c.capability),
    taskTypes: report.taskTypes.filter((t) => t.verdict === VERDICT.AVAILABLE).map((t) => t.taskType),
    delegableAgents: report.delegableAgents.filter((a) => a.verdict === VERDICT.AVAILABLE)
      .map((a) => a.agent),
    stepTypes: report.stepTypes.filter((s) => s.verdict === VERDICT.AVAILABLE).map((s) => s.stepType),
  };
}

module.exports = { discover, availableOnly, VERDICT };
