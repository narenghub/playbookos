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
// ── B4.1: WHERE MAY THIS CAPABILITY EXECUTE? ────────────────────────────────
//
// Owner instruction, 2026-11-24: "Classify every execution capability as cloud eligible, physical
// hardware required, or authorized GUI session required."
//
// The classes, and the worker capability each one demands:
//
//   cloud_eligible        pure compute and database work. ANY authorized worker may execute it,
//                         cloud or hardware. This is the default a task type should want.
//   hardware_required     needs the physical machine itself — because the thing under test IS the
//                         machine, or because a local device, keychain or peripheral is involved.
//                         Demands the `exec:hardware` capability.
//   gui_session_required  needs a logged-in desktop session, so it cannot run headless at all.
//                         Demands `exec:gui`. Strictly narrower than hardware_required: a machine
//                         can be up, enrolled and executing while nobody is logged in, which is
//                         exactly the FileVault situation B4.4b is about.
//
// WHY A WORKER MUST DECLARE THE CAPABILITY RATHER THAN BEING TRUSTED BY NAME. A cloud worker and
// the iMac differ in what they can do, not in what they are called, and "the hardware one is the
// one called imac" is a convention a second machine breaks. The capability is a column on
// worker_identities, granted at enrollment, so a worker that has not been granted hardware
// execution cannot claim hardware work even if it asks for it.
const EXECUTION = Object.freeze({
  CLOUD_ELIGIBLE: 'cloud_eligible',
  HARDWARE_REQUIRED: 'hardware_required',
  GUI_SESSION_REQUIRED: 'gui_session_required',
});

/** The worker capability each class demands. cloud_eligible demands nothing extra. */
const EXECUTION_CAPABILITY = Object.freeze({
  [EXECUTION.CLOUD_ELIGIBLE]: null,
  [EXECUTION.HARDWARE_REQUIRED]: 'exec:hardware',
  [EXECUTION.GUI_SESSION_REQUIRED]: 'exec:gui',
});

const TASK_TYPES = Object.freeze({
  // ── M7.2 proof-of-concept types. Synthetic and read-only, by direction. ──
  'synthetic.echo': {
    summary: 'returns its own payload — proves the round trip and nothing else',
    reexecutable: true,
    readOnly: true,
    ceilingMinutes: 5,
    execution: EXECUTION.CLOUD_ELIGIBLE,
  },
  'synthetic.sleep': {
    summary: 'waits, so lease expiry, heartbeat and cancellation can be exercised for real',
    reexecutable: true,
    readOnly: true,
    ceilingMinutes: 10,
    execution: EXECUTION.CLOUD_ELIGIBLE,
  },
  // ── The acceptance handshake that replaces a manually timed `kill -9` ──
  //
  // Executing this type MEANS dying: the worker SIGKILLs itself while holding the lease. It exists
  // because M7.5 scenario 7 depended on an operator's timing twice and produced nothing both
  // times — once with the crash never happening at all (and two phantom FAILs reported for it),
  // once with it happening 33 seconds early and taking six later scenarios down with it.
  //
  // `reexecutable: false` is the substance here, not bookkeeping. The outcome of this work can
  // never be confirmed by the worker that performed it, so the server must resolve the abandoned
  // lease WITHOUT handing the task to anybody again. That is the property the scenario verifies.
  //
  // It writes nothing, and the handler refuses unless four independent conditions hold — see
  // src/worker-client/handlers/synthetic-crash-test.js. It lives in this registry rather than
  // being conditionally registered, because a vocabulary that changes shape with the environment
  // is not a closed vocabulary.
  'synthetic.crash_test': {
    summary: 'the worker SIGKILLs itself while holding the lease — development-only, and refused '
      + 'unless explicitly armed for this exact worker id',
    reexecutable: false,
    readOnly: true,
    ceilingMinutes: 5,
    // HARDWARE_REQUIRED, and it is the clearest case in the registry: the point of this type is
    // that the MACHINE dies and recovers. Executed in cloud it would prove something about a
    // container nobody is asking about. A cloud worker claiming it would make the M7.6 crash
    // scenario pass while measuring nothing — the defect class this project keeps finding.
    execution: EXECUTION.HARDWARE_REQUIRED,
  },
  'report.daily_operations': {
    summary: 'renders an internal operations summary from data already in the database',
    reexecutable: true,
    readOnly: true,
    ceilingMinutes: 15,
    execution: EXECUTION.CLOUD_ELIGIBLE,
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
    execution: EXECUTION.CLOUD_ELIGIBLE,
  },

  // ── An example of the THIRD class, present so the distinction is exercised ──
  //
  // Following this file's own established practice ("an example of the OTHER kind, present so the
  // distinction is exercised"): without a gui_session_required type, the branch that refuses a
  // headless worker would be untested because every real type happens to avoid it, and a test
  // whose every fixture takes the same branch tests one branch.
  //
  // Not implemented and enqueued by nothing. GUI_SESSION_REQUIRED is strictly narrower than
  // hardware: this needs somebody logged in, which is the distinction B4.4b turns on — a machine
  // can be up, enrolled and executing with no desktop session at all.
  'desktop.capture_once': {
    summary: 'captures one screenshot of a logged-in desktop session — not implemented; exists so '
      + 'the gui_session_required class has a case',
    reexecutable: true,
    readOnly: true,
    ceilingMinutes: 5,
    execution: EXECUTION.GUI_SESSION_REQUIRED,
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

/** Where may this type execute? Null for an unknown type — callers already refuse those. */
function executionClassOf(type) {
  return isKnown(type) ? TASK_TYPES[type].execution : null;
}

/**
 * Which worker capability does this type demand, or null if any authorized worker may run it.
 */
function requiredCapabilityOf(type) {
  const klass = executionClassOf(type);
  return klass ? EXECUTION_CAPABILITY[klass] : null;
}

/**
 * Could a worker holding these capabilities execute this type? B4.3's predicate.
 *
 * A worker with NO declared execution capabilities can run cloud-eligible work and nothing else.
 * That is deliberately fail-closed: the alternative — treating an undeclared worker as able to do
 * everything — would make the whole classification vacuous for every worker enrolled before it
 * existed, which is all of them.
 *
 * The consequence is recorded rather than worked around: the iMac worker must be granted
 * `exec:hardware` at enrollment before it can claim `synthetic.crash_test` again. That is an owner
 * action, and until it happens the task QUEUES rather than failing — which is the B4.3 behaviour
 * being built, arriving here as a side effect rather than as special handling.
 */
function workerMayExecute(type, capabilities = []) {
  const required = requiredCapabilityOf(type);
  if (required === null) return true;
  return Array.isArray(capabilities) && capabilities.includes(required);
}

/** Every type a worker with these capabilities may claim. Used to filter the claim query. */
function claimableTypesFor(capabilities = []) {
  return KNOWN.filter((t) => workerMayExecute(t, capabilities));
}

function registryProblems(types = TASK_TYPES) {
  const problems = [];
  for (const [name, d] of Object.entries(types)) {
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(name)) {
      problems.push(`${name}: a type name must be lowercase namespace.action`);
    }
    for (const field of ['summary', 'reexecutable', 'readOnly', 'ceilingMinutes', 'execution']) {
      if (!Object.prototype.hasOwnProperty.call(d, field)) {
        problems.push(`${name}: does not declare ${field}`);
      }
    }
    if (typeof d.reexecutable !== 'boolean') problems.push(`${name}: reexecutable must be a boolean`);
    if (typeof d.readOnly !== 'boolean') problems.push(`${name}: readOnly must be a boolean`);
    if (!Number.isFinite(d.ceilingMinutes) || d.ceilingMinutes <= 0) {
      problems.push(`${name}: ceilingMinutes must be a positive number`);
    }
    // B4.1. A type with no execution class would be claimable by anything, which is the state the
    // whole classification exists to end. Enforced here rather than defaulted, because a default
    // is a decision nobody made: the right class for a new type is a judgement about what it
    // touches, and guessing cloud_eligible for it is how hardware work reaches a container.
    if (!Object.values(EXECUTION).includes(d.execution)) {
      problems.push(`${name}: execution must be one of ${Object.values(EXECUTION).join(', ')} `
        + `(B4.1) — got ${JSON.stringify(d.execution)}`);
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
  EXECUTION, EXECUTION_CAPABILITY,
  executionClassOf, requiredCapabilityOf, workerMayExecute, claimableTypesFor,
  isKnown, definitionOf, isReexecutable, ceilingFor, registryProblems,
};
