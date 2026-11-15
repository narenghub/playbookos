// ── THE CLOSED VOCABULARY OF WORK A WORKER MAY DO ───────────────────────────
//
// M7.2, owner refinement 3 of 2026-11-14: *"The initial worker should execute an allowlist of
// synthetic or read-only tasks — not arbitrary commands, shell scripts, or dynamically supplied
// code. Otherwise, the absence of provider credentials alone does not make execution safe."*
//
// That reasoning is the whole design. A worker running arbitrary supplied code on a machine in the
// office has the local network, the filesystem, and whatever that machine is signed into —
// regardless of what PlayNexa did or did not hand it. The credential boundary and the execution
// boundary are separate controls and both are required.
//
// So a task names a TYPE from this file, and the worker resolves that name to code it already
// ships. Never a shell string, never a script body, never a URL to fetch and run. A task type
// absent from here is refused before anything executes — not sandboxed, not logged and allowed.
//
// ── EVERY TYPE DECLARES WHETHER RE-EXECUTION IS SAFE ────────────────────────
//
// `reexecutable` exists because of the other half of the direction: *"Do not assume expired leases
// mean a task is safe to execute again."*
//
// An expired lease does not mean the work did not happen. It means NOBODY KNOWS whether it
// happened — the worker may have completed the task and died before reporting. That is the
// OUTCOME_UNKNOWN problem from the email ledger, relocated. Whether re-running is safe is a
// property of the WORK, not of the lease, and only the work can declare it.
//
// Default is FALSE for anything not stated. A type that forgets to declare it is treated as unsafe
// to repeat, which is the failure in the harmless direction.
//
// ── WHAT IS NOT HERE, AND WHY ───────────────────────────────────────────────
//
// No type sends anything, writes to a customer-facing record, or touches a provider. The worker
// produces PROPOSALS; anything consequential goes back through dispatch.js and the approval path.
// Adding a type that transmits would make the worker a second outbound execution path and undo
// what M5 and M6 bought — so it is a governance decision, not a new entry in a list.

'use strict';

/**
 * @typedef {Object} TaskType
 * @property {string}  summary        what it does, in one line
 * @property {boolean} reexecutable   is running it twice harmless?
 * @property {boolean} readOnly       does it write anything at all?
 * @property {number}  ceilingMinutes lease ceiling; the reaper abandons a lease past it
 */
const TASK_TYPES = Object.freeze({
  // ── M7.2 proof-of-concept types. Synthetic and read-only, by direction. ──
  'synthetic.echo': {
    summary: 'returns its own payload — proves the round trip and nothing else',
    reexecutable: true,
    readOnly: true,
    ceilingMinutes: 5,
  },
  'synthetic.sleep': {
    summary: 'waits, so lease expiry, heartbeat and cancellation can be exercised for real',
    reexecutable: true,
    readOnly: true,
    ceilingMinutes: 10,
  },
  'report.daily_operations': {
    summary: 'renders an internal operations summary from data already in the database',
    reexecutable: true,
    readOnly: true,
    ceilingMinutes: 15,
  },

  // ── An example of the OTHER kind, present so the distinction is exercised ──
  //
  // Not implemented and not enqueued by anything. It exists so the re-execution rule has a
  // non-reexecutable case to test against, rather than the rule being untested because every real
  // type happens to be safe. A test whose every fixture takes the same branch tests one branch.
  'proposal.draft_once': {
    summary: 'produces a single draft proposal record — repeating it would duplicate that record',
    reexecutable: false,
    readOnly: false,
    ceilingMinutes: 20,
  },
});

const KNOWN = Object.freeze(Object.keys(TASK_TYPES));

/** The default ceiling when a type does not declare one. Matches recovery.js's own default. */
const DEFAULT_CEILING_MINUTES = 180;

function isKnown(type) {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(TASK_TYPES, type);
}

/**
 * The definition, or null. A caller that gets null MUST refuse — there is no "unknown type, run it
 * anyway" path, and no sandbox that would make one acceptable.
 */
function definitionOf(type) {
  return isKnown(type) ? TASK_TYPES[type] : null;
}

/** Fail closed: anything undeclared is NOT safe to repeat. */
function isReexecutable(type) {
  const d = definitionOf(type);
  return Boolean(d && d.reexecutable === true);
}

function ceilingFor(type) {
  const d = definitionOf(type);
  return (d && Number.isFinite(d.ceilingMinutes)) ? d.ceilingMinutes : DEFAULT_CEILING_MINUTES;
}

/**
 * Every type must declare every field explicitly. A type added later that omits `reexecutable`
 * would silently default to false — which is the safe direction but a silent one, and a silent
 * default is how a dangerous type eventually arrives wearing a safe shape. So the registry is
 * validated rather than trusted, and the worker's own tests assert this returns nothing.
 */
function registryProblems(types = TASK_TYPES) {
  const problems = [];
  for (const [name, d] of Object.entries(types)) {
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(name)) {
      problems.push(`${name}: a type name must be lowercase namespace.action`);
    }
    for (const field of ['summary', 'reexecutable', 'readOnly', 'ceilingMinutes']) {
      if (!Object.prototype.hasOwnProperty.call(d, field)) {
        problems.push(`${name}: does not declare ${field}`);
      }
    }
    if (typeof d.reexecutable !== 'boolean') problems.push(`${name}: reexecutable must be a boolean`);
    if (typeof d.readOnly !== 'boolean') problems.push(`${name}: readOnly must be a boolean`);
    if (!Number.isFinite(d.ceilingMinutes) || d.ceilingMinutes <= 0) {
      problems.push(`${name}: ceilingMinutes must be a positive number`);
    }
    // A type that writes AND claims to be repeatable is the combination that duplicates records.
    // It is not forbidden outright — an idempotent upsert is a legitimate example — but it must be
    // stated deliberately rather than arrived at, so it is flagged for review here.
    if (d.reexecutable === true && d.readOnly === false) {
      problems.push(`${name}: declares reexecutable AND not readOnly — only correct if the write `
        + 'is genuinely idempotent; state why in `summary` and then remove this guard for it');
    }
  }
  return problems;
}

module.exports = {
  TASK_TYPES, KNOWN, DEFAULT_CEILING_MINUTES,
  isKnown, definitionOf, isReexecutable, ceilingFor, registryProblems,
};
