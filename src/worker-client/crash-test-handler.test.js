// ── THE CRASH HANDSHAKE: EVERY GATE, INDEPENDENTLY ──────────────────────────
//
// `synthetic.crash_test` is the only handler whose correct behaviour is to kill the process it is
// running in. That makes two things essential and they pull in opposite directions:
//
//   - it must actually kill, or scenario 7 is untestable for a third time;
//   - it must be impossible to reach by accident, and the gates must be verified one at a time,
//     because four conditions checked only together means three of them are untested.
//
// So `decide()` is separated from `run()`, and `run()` takes an injectable `kill`. Every refusal
// test asserts that `kill` was NEVER called — a refusal that throws after killing the process
// would pass a test that only looked at the exception.
//
// The last control is the one that matters most: with the REAL process environment, the handler
// refuses. If that ever fails, this file is a liability rather than a test.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const H = require('./handlers/synthetic-crash-test');
const TYPES = require('../lib/worker/task-types');
const EXEC = require('./executor');

const WID = `wkr_${'a1b2'.repeat(8)}`;
const armedEnv = () => ({
  PLAYNEXA_WORKER_ENV: 'development',
  WORKER_ID: WID,
  WORKER_ALLOW_CRASH_TEST: WID,
});
const goodPayload = () => ({ confirm: 'crash-this-worker', workerId: WID });

/** Records every kill it is asked to perform, and performs none. */
function spy() {
  const kills = [];
  const lines = [];
  return {
    kills,
    lines,
    deps: {
      env: armedEnv(),
      pid: 4242,
      kill: (pid, sig) => kills.push([pid, sig]),
      log: (l) => lines.push(l),
    },
  };
}

// ── THE ARMED PATH ──────────────────────────────────────────────────────────

test('fully armed: it SIGKILLs its own pid and logs that the crash was deliberate', async () => {
  const s = spy();
  await H.run(goodPayload(), s.deps);

  assert.deepEqual(s.kills, [[4242, 'SIGKILL']], 'exactly one kill, of its own pid, with SIGKILL');
  assert.equal(s.lines.length, 1);
  assert.equal(s.lines[0].at, 'crash_test_self_kill');
  assert.equal(s.lines[0].workerId, WID);
  assert.equal(s.lines[0].pid, 4242);
  // Written before the kill, or it would never be written at all.
  assert.match(String(s.lines[0].note), /lease is held/i);
});

test('the pid it kills comes from the process, never from the payload', async () => {
  const s = spy();
  await H.run({ ...goodPayload(), pid: 99999, signal: 'SIGTERM' }, s.deps);
  assert.deepEqual(s.kills, [[4242, 'SIGKILL']],
    'a payload naming a pid or a signal must have no influence whatsoever');
});

// ── EVERY GATE, ONE AT A TIME ───────────────────────────────────────────────

const refusals = [
  ['PLAYNEXA_WORKER_ENV is absent', (e) => { delete e.PLAYNEXA_WORKER_ENV; }, {}, /not "development"/],
  ['PLAYNEXA_WORKER_ENV is production', (e) => { e.PLAYNEXA_WORKER_ENV = 'production'; }, {}, /not "development"/],
  ['PLAYNEXA_WORKER_ENV is a near-miss', (e) => { e.PLAYNEXA_WORKER_ENV = 'dev'; }, {}, /not "development"/],
  ['WORKER_ID is malformed', (e) => { e.WORKER_ID = 'worker-1'; }, {}, /WORKER_ID is absent or malformed/],
  ['the arming variable is absent', (e) => { delete e.WORKER_ALLOW_CRASH_TEST; }, {}, /does not equal this worker/],
  ['the arming variable is a boolean', (e) => { e.WORKER_ALLOW_CRASH_TEST = 'yes'; }, {}, /does not equal this worker/],
  ['the arming variable names another worker', (e) => { e.WORKER_ALLOW_CRASH_TEST = `wkr_${'f'.repeat(32)}`; }, {}, /does not equal this worker/],
  ['the payload is not confirmed', null, { confirm: 'yes' }, /payload\.confirm must be/],
  ['the payload confirms nothing at all', null, { confirm: undefined }, /payload\.confirm must be/],
  ['the payload names a different worker', null, { workerId: `wkr_${'e'.repeat(32)}` }, /names a different worker/],
  ['the payload names no worker', null, { workerId: undefined }, /names a different worker/],
];

for (const [name, mutateEnv, payloadOverride, expected] of refusals) {
  test(`REFUSES and does not kill when ${name}`, async () => {
    const s = spy();
    if (mutateEnv) mutateEnv(s.deps.env);
    const payload = { ...goodPayload(), ...payloadOverride };

    await assert.rejects(() => H.run(payload, s.deps), expected);
    assert.deepEqual(s.kills, [], 'a refusal that still killed the process would be the worst case');
    assert.deepEqual(s.lines, [], 'and it must not log a deliberate-crash line it did not perform');
  });
}

// ── THE EXECUTOR PATH: A REFUSAL IS A REPORTABLE FAILURE, NOT A CRASH ───────

test('through the executor, an unarmed crash task FAILS reportably', async () => {
  // No env injection here: this is the real process, which is not armed. The verdict must be a
  // clean FAILED the worker can report, not an abort and not a dead process.
  const r = await EXEC.execute({
    taskType: 'synthetic.crash_test',
    payload: { confirm: 'crash-this-worker', workerId: WID },
    leaseExpiresInMinutes: 5,
  });
  assert.equal(r.verdict, 'FAILED', JSON.stringify(r));
  assert.match(String(r.error || r.reason || ''), /crash_test_refused/, JSON.stringify(r));
});

test('the executor resolves the type to a real handler', () => {
  // No `EXEC.handlerFor ? … : …` fallback here on purpose. A test that quietly substitutes a
  // passing stub when the export disappears is a test that reports health about nothing.
  assert.equal(typeof EXEC.handlerFor, 'function', 'executor must export handlerFor');
  const r = EXEC.handlerFor('synthetic.crash_test');
  assert.equal(r.code, null, 'the type must be in the frozen HANDLERS map');
  assert.equal(typeof r.handler.run, 'function');
  assert.equal(typeof r.handler.validateOutput, 'function');
});

// ── THE REGISTRY ────────────────────────────────────────────────────────────

test('the type is declared non-reexecutable, read-only, and the registry is clean', () => {
  assert.ok(TYPES.isKnown('synthetic.crash_test'));
  const d = TYPES.definitionOf('synthetic.crash_test');
  assert.equal(d.readOnly, true, 'it writes nothing');
  assert.equal(TYPES.isReexecutable('synthetic.crash_test'), false,
    'a task whose outcome cannot be confirmed by its own worker must never be handed out again');
  assert.deepEqual(TYPES.registryProblems(), [],
    'adding this type must not introduce a registry problem');
});

// ── OUTPUT VALIDATION ───────────────────────────────────────────────────────

test('output claiming the kill succeeded is refused as a contradiction', () => {
  assert.deepEqual(H.validateOutput({ killed: false }), []);
  const problems = H.validateOutput({ killed: true });
  assert.ok(problems.length > 0);
  assert.match(problems.join(' '), /cannot report its own death/);
});

// ── CONTROLS ────────────────────────────────────────────────────────────────

test('CONTROL: the real process environment is NOT armed', () => {
  const v = H.decide(goodPayload(), process.env);
  assert.equal(v.allowed, false,
    'if this ever passes, any crash_test task reaching this build would kill it');
});

test('CONTROL: decide() does allow the armed case, so the refusals are not unconditional', () => {
  const v = H.decide(goodPayload(), armedEnv());
  assert.equal(v.allowed, true);
  assert.equal(v.reason, null);
  assert.equal(v.workerId, WID);
});

test('CONTROL: the handler contains no shell, no dynamic require and no payload-derived target', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'handlers', 'synthetic-crash-test.js'), 'utf8',
  );
  for (const forbidden of ['child_process', 'exec(', 'spawn(', 'eval(', 'new Function']) {
    assert.ok(!src.includes(forbidden), `the crash handler must not contain ${forbidden}`);
  }
  // The only kill target in the file is the process's own pid.
  assert.match(src, /kill\(pid, 'SIGKILL'\)/);
  assert.ok(!/kill\([^)]*payload/.test(src), 'nothing from the payload may reach kill()');
});
