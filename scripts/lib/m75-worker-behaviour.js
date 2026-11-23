// ── DID THE WORKER OBEY, OR DID NOBODY LOOK? ────────────────────────────────
//
// Scenarios 3 and 4 asked whether a cancellation and a STOP are honoured. Until 2026-11-20 their
// evidence was that no result row existed — which is satisfied by two different behaviours:
//
//   the worker aborted when the signal arrived            (compliance)
//   the worker ignored it, finished, reported, was refused (non-compliance)
//
// The refusal is what removes the row in the second case, so the row's absence cannot tell them
// apart. The server-side refusal assertion has the same problem in a different place: it is the
// DRIVER submitting as the worker, which tests the server's contract and says nothing about the
// machine in the office.
//
// ── WHAT DISCRIMINATES ──────────────────────────────────────────────────────
//
// `worker_audit` is written only by the HTTP route layer (src/api/worker.routes.js), so it records
// the real worker's requests and nothing else — the driver's in-process `LEASES.submitResult`
// bypasses the routes entirely and cannot contaminate it.
//
// That gives an ASYMMETRY. A worker that ignores the signal must run its task to completion and
// must then call the result endpoint; that call is audited whether it is granted or denied. A
// worker that aborts never makes the call at all. So:
//
//   a result-endpoint audit row for this run   ⇒ the worker kept working. POSITIVE non-compliance.
//   a DENIED claim with code `stopped`         ⇒ the worker tried to take work and was refused.
//                                                POSITIVE evidence it was gated, not merely idle.
//
// The second is what answers "do not treat inactivity alone as proof": an idle worker and a
// stopped worker both claim nothing, and only the audit distinguishes them.
//
// ── AND THE THIRD VERDICT ───────────────────────────────────────────────────
//
// Every judgement below can return UNTESTED. That is the point of them being here rather than
// inline: when the evidence cannot discriminate, saying so is the correct answer, and the rule
// this repo keeps relearning is that an unexercised check must not report a pass. A worker that
// became free only AFTER its task would have finished anyway is the clearest case — it is
// consistent with compliance and with indifference, so it is neither a PASS nor a FAIL.
//
// These are pure functions of gathered evidence, which is what lets the five required regressions
// (ignored cancel, ignored STOP, never resumed, missing abort evidence, valid behaviour) be tested
// without a Mac.

'use strict';

const PASS = 'PASS';
const FAIL = 'FAIL';
const UNTESTED = 'UNTESTED';

/**
 * @param {object} ev
 * @param {boolean} ev.recorded                  cancel_requested_at and cancel_reason are set
 * @param {?number} ev.heartbeatAfterCancelAt    ms: a worker heartbeat later than the cancel
 * @param {number}  ev.workerResultAttempts      worker_audit rows, result endpoint, THIS run
 * @param {?number} ev.probeClaimedAt            ms: when the worker claimed the follow-up echo
 * @param {number}  ev.projectedCompletionAt     ms: run started_at + the task's configured delay
 * @param {?string} ev.serverRefusalCode         the independent server-side contract check
 */
function judgeCancellation(ev) {
  if (!ev.recorded) {
    return { verdict: FAIL, why: 'the cancellation was not durably recorded on the task' };
  }
  // The contract check stays, as an independent assertion about the SERVER. It is not evidence
  // about the worker and is not treated as such.
  if (ev.serverRefusalCode !== 'cancelled') {
    return { verdict: FAIL,
      why: `the server accepted a result for a cancelled task (refusal code ${ev.serverRefusalCode})` };
  }
  if (ev.heartbeatAfterCancelAt === null || ev.heartbeatAfterCancelAt === undefined) {
    return { verdict: UNTESTED,
      why: 'no worker heartbeat landed after the cancellation, so the signal was never delivered. '
        + 'Nothing about the worker\'s compliance was exercised' };
  }
  if (ev.workerResultAttempts > 0) {
    return { verdict: FAIL,
      why: `the worker called the result endpoint ${ev.workerResultAttempts} time(s) for this run `
        + 'after being cancelled — it ran its task to completion and tried to report. The absent '
        + 'result row is the server refusing it, not the worker stopping' };
  }
  if (ev.probeClaimedAt === null || ev.probeClaimedAt === undefined) {
    return { verdict: UNTESTED,
      why: 'the worker never claimed the follow-up task, so it cannot be shown to have become '
        + 'available. A crashed or wedged worker also reports nothing' };
  }
  if (ev.probeClaimedAt >= ev.projectedCompletionAt) {
    return { verdict: UNTESTED,
      why: 'the worker became available only after the cancelled task would have finished on its '
        + 'own, so this run cannot tell an abort from indifference. Not a pass' };
  }
  return { verdict: PASS,
    why: 'the cancellation was delivered in a heartbeat, the worker made no attempt to report, and '
      + 'it took new work before the cancelled task could have completed' };
}

/**
 * @param {object} ev
 * @param {boolean} ev.stopInScope               authorizeWorkerAction refuses this worker
 * @param {?number} ev.heartbeatAfterStopAt      ms: a worker heartbeat later than the STOP
 * @param {number}  ev.workerResultAttempts      worker_audit rows, result endpoint, THIS run
 * @param {number}  ev.deniedClaimAttempts       worker_audit DENIED `stopped` while the STOP held
 * @param {string}  ev.probeStateWhileStopped    the state of a task offered during the STOP
 * @param {boolean} ev.resumedCompleted          that same task completed after the STOP cleared
 * @param {boolean} ev.inventoryUnchanged        the containment STOPs are as they were
 * @param {?number} ev.resumeClaimedAt           ms: when the worker claimed work after the STOP
 * @param {?number} ev.projectedCompletionAt     ms: when the stopped task would have finished alone
 */
function judgeStop(ev) {
  if (!ev.stopInScope) {
    return { verdict: FAIL,
      why: 'the fixture STOP is not in the scope the worker path consults, so it was never a STOP' };
  }
  if (!ev.inventoryUnchanged) {
    return { verdict: FAIL, why: 'the containment STOP inventory changed' };
  }
  if (ev.heartbeatAfterStopAt === null || ev.heartbeatAfterStopAt === undefined) {
    return { verdict: UNTESTED,
      why: 'no worker heartbeat landed after the STOP, so it was never delivered' };
  }
  if (ev.workerResultAttempts > 0) {
    return { verdict: FAIL,
      why: `the worker called the result endpoint ${ev.workerResultAttempts} time(s) for a STOPped `
        + 'run — it kept working through the STOP' };
  }
  if (ev.probeStateWhileStopped !== 'PENDING') {
    return { verdict: FAIL,
      why: `a task offered during the STOP went to ${ev.probeStateWhileStopped} — the worker took `
        + 'new work while execution was stopped' };
  }
  // The resume is the LIVENESS CONTROL and is checked before any positive evidence is weighed:
  // without it, "the worker claimed nothing" is equally explained by a worker that was already
  // dead. Order matters, so it is asserted by a test.
  if (!ev.resumedCompleted) {
    return { verdict: FAIL,
      why: 'the worker never resumed after the STOP cleared, so "it claimed nothing" is equally '
        + 'explained by a worker that was already dead. The resume is the control' };
  }

  // ── TWO SUFFICIENT DISCRIMINATORS, BECAUSE ONE OF THEM IS UNREACHABLE HERE ──
  //
  // Until 2026-11-23 this required `deniedClaimAttempts > 0` — a claim the authority refused. The
  // M7.6 run reported R5 UNTESTED on exactly that, and the reason is structural rather than bad
  // luck: a mid-flight STOP lands on a worker that is BUSY executing a 60-second task, so it is
  // not polling, so there is no claim for the authority to refuse. The condition could almost
  // never be satisfied by the scenario that needs it.
  //
  // So either of two things now settles it, and the weaker measurements keep their own branches:
  //
  //   A. a refused claim           direct evidence the authority turned the worker away
  //   B. the R4 discriminator      the worker took new work BEFORE the stopped task could have
  //                               finished on its own, so it abandoned it rather than running it
  //                               out. This is the same reasoning R4 proves works in practice.
  //
  // What has NOT been loosened: every FAIL above stands, the liveness control above stands, and
  // with neither A nor B the verdict is still UNTESTED. "The probe stayed PENDING" remains
  // insufficient on its own — it is satisfied by a stopped worker AND by a merely busy one, which
  // is the ambiguity that produced the UNTESTED in the first place.
  if (ev.deniedClaimAttempts > 0) {
    return { verdict: PASS,
      why: 'the STOP was delivered in a heartbeat, the worker attempted to claim and was refused, it '
        + 'never reported for the stopped run, and it resumed when the STOP cleared' };
  }
  if (ev.resumeClaimedAt === null || ev.resumeClaimedAt === undefined
      || ev.projectedCompletionAt === null || ev.projectedCompletionAt === undefined) {
    return { verdict: UNTESTED,
      why: 'no claim was refused, and there is no timing to compare: without either, nothing '
        + 'distinguishes a stopped worker from an idle or busy one. Inactivity is not compliance' };
  }
  if (ev.resumeClaimedAt >= ev.projectedCompletionAt) {
    return { verdict: UNTESTED,
      why: 'the worker took new work only after the stopped task would have finished on its own, so '
        + 'this run cannot tell a halt from a task that simply ran out. Not a pass' };
  }
  return { verdict: PASS,
    why: 'the STOP was delivered in a heartbeat, the worker never reported for the stopped run, it '
      + 'took new work before that task could have completed — so it abandoned it rather than '
      + 'running it out — and it resumed when the STOP cleared' };
}

module.exports = { judgeCancellation, judgeStop, PASS, FAIL, UNTESTED };
