// ── THE FIVE CASES THE OWNER REQUIRED, PLUS THE ONES THEY IMPLY ─────────────
//
//   node --test scripts/m75-worker-behaviour.test.js
//
// Required by the 2026-11-19 authorization:
//
//   a worker ignoring cancellation          fails the scenario
//   a worker ignoring STOP                  fails the scenario
//   a worker that never resumes             fails the STOP scenario
//   missing worker abort evidence           fails the scenario
//   the existing valid behaviour            passes
//
// "Fails" is read strictly below: a FAIL where the evidence positively shows non-compliance, and
// UNTESTED where the evidence is absent. Both are non-passes and both fail the acceptance gate,
// which requires zero FAIL *and* zero UNTESTED — but they are different claims about the world and
// collapsing them is how three runs produced product FAILs for an absent worker.
//
// These run without a Mac because the judgements are pure functions of gathered evidence. That is
// the whole reason they were extracted: the hardware supplies the evidence, and the decision made
// from it is testable here, before the 90-minute window opens.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { judgeCancellation, judgeStop, PASS, FAIL, UNTESTED } =
  require('./lib/m75-worker-behaviour');

// A compliant run: cancel delivered at ~50s, worker never reported, took new work at ~52s, and
// the cancelled task would not have finished until 60s.
const T0 = 1_795_000_000_000;
const goodCancel = () => ({
  recorded: true,
  serverRefusalCode: 'cancelled',
  heartbeatAfterCancelAt: T0 + 50_000,
  workerResultAttempts: 0,
  probeClaimedAt: T0 + 52_000,
  projectedCompletionAt: T0 + 60_000,
});
const goodStop = () => ({
  stopInScope: true,
  inventoryUnchanged: true,
  heartbeatAfterStopAt: T0 + 50_000,
  workerResultAttempts: 0,
  deniedClaimAttempts: 3,
  probeStateWhileStopped: 'PENDING',
  resumedCompleted: true,
});

// ── THE BASELINE. Without this the rest could pass by rejecting everything. ──

test('CONTROL: valid worker behaviour passes both scenarios', () => {
  assert.equal(judgeCancellation(goodCancel()).verdict, PASS);
  assert.equal(judgeStop(goodStop()).verdict, PASS);
});

// ── 1. A WORKER IGNORING CANCELLATION ───────────────────────────────────────

test('REQUIRED: a worker that ignores cancellation FAILS', () => {
  // It ran the task to completion and called the result endpoint. The row is absent only because
  // the server refused it — which is exactly the inference the old test could not make.
  const r = judgeCancellation({ ...goodCancel(), workerResultAttempts: 1 });
  assert.equal(r.verdict, FAIL);
  assert.match(r.why, /called the result endpoint/);
  assert.match(r.why, /not the worker stopping/);
});

test('an ignored cancellation fails even when everything else looks right', () => {
  // The dangerous shape: a worker that reports AND then picks up new work quickly would satisfy
  // every other signal. The audit row is what catches it.
  const r = judgeCancellation({
    ...goodCancel(), workerResultAttempts: 2, probeClaimedAt: T0 + 50_500,
  });
  assert.equal(r.verdict, FAIL);
});

// ── 2. A WORKER IGNORING STOP ───────────────────────────────────────────────

test('REQUIRED: a worker that ignores STOP FAILS', () => {
  const r = judgeStop({ ...goodStop(), workerResultAttempts: 1 });
  assert.equal(r.verdict, FAIL);
  assert.match(r.why, /kept working through the STOP/);
});

test('REQUIRED: a worker that claims NEW work under STOP FAILS', () => {
  const r = judgeStop({ ...goodStop(), probeStateWhileStopped: 'LEASED' });
  assert.equal(r.verdict, FAIL);
  assert.match(r.why, /took new work/);
});

// ── 3. A WORKER THAT NEVER RESUMES ──────────────────────────────────────────

test('REQUIRED: a worker that never resumes FAILS the STOP scenario', () => {
  // Without this, "it claimed nothing while stopped" is satisfied perfectly by a worker that died
  // before the STOP was ever written.
  const r = judgeStop({ ...goodStop(), resumedCompleted: false });
  assert.equal(r.verdict, FAIL);
  assert.match(r.why, /already dead/);
});

// ── 4. MISSING WORKER ABORT EVIDENCE ────────────────────────────────────────

test('REQUIRED: no heartbeat after the cancel is UNTESTED, never a pass', () => {
  const r = judgeCancellation({ ...goodCancel(), heartbeatAfterCancelAt: null });
  assert.equal(r.verdict, UNTESTED);
  assert.match(r.why, /never delivered/);
});

test('REQUIRED: a worker that never took the follow-up task is UNTESTED', () => {
  // A crashed worker reports nothing and claims nothing, which looks identical to perfect
  // compliance if only absences are counted.
  const r = judgeCancellation({ ...goodCancel(), probeClaimedAt: null });
  assert.equal(r.verdict, UNTESTED);
  assert.match(r.why, /crashed or wedged/);
});

test('DECISIVE: becoming free only AFTER the task would have finished is UNTESTED', () => {
  // The subtle one. The worker is alive and took new work, but not before the 60s task would have
  // ended by itself — so this run genuinely cannot tell an abort from indifference.
  const r = judgeCancellation({
    ...goodCancel(), probeClaimedAt: T0 + 61_000, projectedCompletionAt: T0 + 60_000,
  });
  assert.equal(r.verdict, UNTESTED);
  assert.match(r.why, /cannot tell an abort from indifference/);
  assert.match(r.why, /Not a pass/);
});

test('the boundary is not a pass either', () => {
  const r = judgeCancellation({
    ...goodCancel(), probeClaimedAt: T0 + 60_000, projectedCompletionAt: T0 + 60_000,
  });
  assert.equal(r.verdict, UNTESTED, 'exactly at the projected completion proves nothing');
});

test('REQUIRED: inactivity alone is UNTESTED for STOP, not a pass', () => {
  // The owner's words: "Do not treat inactivity alone as proof that STOP was honored." An idle
  // worker and a gated worker both claim nothing. From 2026-11-23 there are TWO things that can
  // tell them apart — a refused claim, or the timing below — and with NEITHER it is still UNTESTED,
  // which is what this asserts: no denied claims and no timing supplied.
  const r = judgeStop({ ...goodStop(), deniedClaimAttempts: 0 });
  assert.equal(r.verdict, UNTESTED);
  assert.match(r.why, /Inactivity is not compliance/);
});

// ── THE SECOND DISCRIMINATOR, ADDED 2026-11-23 ──────────────────────────────
//
// The M7.6 run reported R5 UNTESTED on `deniedClaimAttempts === 0`, and that was structural: a
// mid-flight STOP lands on a worker BUSY with a 60-second task, so it is not polling, so there is
// no claim to refuse. The condition could essentially never be met by the scenario needing it.
// R4 already proves a reachable discriminator: the worker took new work before the stopped task
// could have finished, so it abandoned rather than ran it out.

/** A worker that attempted no claim, but demonstrably became free EARLY. */
const stopByTiming = () => ({
  ...goodStop(),
  deniedClaimAttempts: 0,
  resumeClaimedAt: T0 + 40_000,
  projectedCompletionAt: T0 + 60_000,
});

test('DECISIVE: taking new work BEFORE the stopped task could finish is a PASS', () => {
  const r = judgeStop(stopByTiming());
  assert.equal(r.verdict, PASS, r.why);
  assert.match(r.why, /before that task could have completed/);
});

test('DECISIVE: becoming free only AFTER it would have finished is UNTESTED', () => {
  // The task may simply have run out. That is indistinguishable from a halt, so it is not a pass.
  const r = judgeStop({ ...stopByTiming(), resumeClaimedAt: T0 + 61_000 });
  assert.equal(r.verdict, UNTESTED);
  assert.match(r.why, /ran out/);
});

test('timing that is absent or half-present is UNTESTED, never assumed', () => {
  for (const partial of [
    { resumeClaimedAt: null, projectedCompletionAt: T0 + 60_000 },
    { resumeClaimedAt: T0 + 40_000, projectedCompletionAt: null },
    { resumeClaimedAt: undefined, projectedCompletionAt: undefined },
  ]) {
    const r = judgeStop({ ...stopByTiming(), ...partial });
    assert.equal(r.verdict, UNTESTED, JSON.stringify({ partial, r }));
  }
});

test('DECISIVE: the liveness control outranks the timing evidence', () => {
  // A worker that never resumed cannot be shown to have been alive, and good timing must not
  // paper over that. Order is a property here, not an implementation detail.
  const r = judgeStop({ ...stopByTiming(), resumedCompleted: false });
  assert.equal(r.verdict, FAIL);
  assert.match(r.why, /already dead/);
});

test('DECISIVE: every FAIL still outranks the new discriminator', () => {
  // The risk in adding a second way to pass is that it becomes a way to pass ANYWAY. These are the
  // behaviours that must stay failures even with perfect timing evidence attached.
  const cases = [
    [{ workerResultAttempts: 1 }, /kept working through the STOP/],
    [{ probeStateWhileStopped: 'LEASED' }, /took new work while execution was stopped/],
    [{ stopInScope: false }, /never a STOP/],
    [{ inventoryUnchanged: false }, /inventory changed/],
  ];
  for (const [override, why] of cases) {
    const r = judgeStop({ ...stopByTiming(), ...override });
    assert.equal(r.verdict, FAIL, JSON.stringify({ override, r }));
    assert.match(r.why, why);
  }
});

test('the timing path is not a rubber stamp: exactly one of these variants passes', () => {
  const variants = [
    stopByTiming(),                                                       // the only pass
    { ...stopByTiming(), resumeClaimedAt: T0 + 61_000 },
    { ...stopByTiming(), resumeClaimedAt: null },
    { ...stopByTiming(), projectedCompletionAt: null },
    { ...stopByTiming(), resumedCompleted: false },
    { ...stopByTiming(), workerResultAttempts: 2 },
    { ...stopByTiming(), probeStateWhileStopped: 'LEASED' },
    { ...stopByTiming(), heartbeatAfterStopAt: null },
  ];
  assert.equal(variants.filter((e) => judgeStop(e).verdict === PASS).length, 1);
  for (const e of variants) {
    const r = judgeStop(e);
    assert.ok(r.why && r.why.length > 20, `every verdict needs a reason: ${JSON.stringify(r)}`);
  }
});

test('no heartbeat after the STOP is UNTESTED', () => {
  const r = judgeStop({ ...goodStop(), heartbeatAfterStopAt: null });
  assert.equal(r.verdict, UNTESTED);
});

// ── THE SERVER-SIDE CONTRACT CHECK IS PRESERVED, AND SEPARATE ───────────────

test('the server accepting a cancelled result is a FAIL in its own right', () => {
  const r = judgeCancellation({ ...goodCancel(), serverRefusalCode: null });
  assert.equal(r.verdict, FAIL);
  assert.match(r.why, /the server accepted a result/);
});

test('the contract check is not mistaken for worker evidence', () => {
  // A correct server refusal must not rescue a scenario whose worker evidence is missing.
  const r = judgeCancellation({
    ...goodCancel(), serverRefusalCode: 'cancelled', heartbeatAfterCancelAt: null,
  });
  assert.equal(r.verdict, UNTESTED,
    'the server behaving correctly says nothing about the machine in the office');
});

test('an unrecorded cancellation fails before anything else is considered', () => {
  assert.equal(judgeCancellation({ ...goodCancel(), recorded: false }).verdict, FAIL);
});

test('a changed containment inventory fails the STOP scenario outright', () => {
  const r = judgeStop({ ...goodStop(), inventoryUnchanged: false });
  assert.equal(r.verdict, FAIL);
  assert.match(r.why, /inventory changed/);
});

// ── NO VERDICT IS REACHABLE BY ACCIDENT ─────────────────────────────────────

test('DECISIVE: every judgement returns one of the three verdicts, with a reason', () => {
  const cancelCases = [
    goodCancel(),
    { ...goodCancel(), recorded: false },
    { ...goodCancel(), serverRefusalCode: null },
    { ...goodCancel(), heartbeatAfterCancelAt: null },
    { ...goodCancel(), workerResultAttempts: 1 },
    { ...goodCancel(), probeClaimedAt: null },
    { ...goodCancel(), probeClaimedAt: T0 + 70_000 },
  ];
  const stopCases = [
    goodStop(),
    { ...goodStop(), stopInScope: false },
    { ...goodStop(), inventoryUnchanged: false },
    { ...goodStop(), heartbeatAfterStopAt: null },
    { ...goodStop(), workerResultAttempts: 1 },
    { ...goodStop(), probeStateWhileStopped: 'LEASED' },
    { ...goodStop(), deniedClaimAttempts: 0 },
    { ...goodStop(), resumedCompleted: false },
  ];
  for (const ev of cancelCases) {
    const r = judgeCancellation(ev);
    assert.ok([PASS, FAIL, UNTESTED].includes(r.verdict), JSON.stringify(r));
    assert.ok(r.why && r.why.length > 20, `every verdict must carry a reason: ${JSON.stringify(r)}`);
  }
  for (const ev of stopCases) {
    const r = judgeStop(ev);
    assert.ok([PASS, FAIL, UNTESTED].includes(r.verdict), JSON.stringify(r));
    assert.ok(r.why && r.why.length > 20, `every verdict must carry a reason: ${JSON.stringify(r)}`);
  }
  // And exactly one of each set passes, so neither judge is a rubber stamp.
  assert.equal(cancelCases.filter((e) => judgeCancellation(e).verdict === PASS).length, 1);
  assert.equal(stopCases.filter((e) => judgeStop(e).verdict === PASS).length, 1);
});
