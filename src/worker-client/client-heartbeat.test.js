// ── DEFECT 6 — THE HEARTBEAT WAIT MUST OBSERVE THE ABORT ────────────────────
//
// Found on the office iMac, 2026-11-17, during the first acceptance run on real hardware. Every
// task took ~51s between `leased` and `reported` — including one whose handler returns
// immediately — because the heartbeat loop's `await this.sleep(everyMs)` ignored the AbortSignal,
// so the post-execution `await beat` blocked until that timer expired on its own.
//
// ── HOW THESE TESTS AVOID BEING A RACE AGAINST A REAL CLOCK ─────────────────
//
// `sleep` is injectable. The decisive test installs a sleep that NEVER resolves. With the defect
// present there is then nothing that can release `await beat`, so `runOnce()` can only return if
// the abort released the wait. A watchdog turns "it would have hung" into a FAILED ASSERTION with
// a readable message rather than a test-runner timeout, which is the difference between a
// regression that explains itself and one that looks like infrastructure flapping.
//
// Every test here asserts on the VALUE `runOnce` returns, not on log lines. A log line is a
// statement about what the code meant to do.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { WorkerClient } = require('./client');

const SECRET = 'a'.repeat(64);
const RUN_ID = 'run-1';
const TASK_ID = 'wtask_test';

/** A fetch stand-in that records every call and answers from a scripted table. */
function makeFetch({ heartbeat = () => ({ ok: true }), heartbeatEveryMs = 50_000 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    calls.push({ path, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (path === '/api/worker/claim') {
      return {
        status: 200,
        json: async () => ({
          ok: true,
          runId: RUN_ID,
          taskId: TASK_ID,
          taskType: 'synthetic.echo',
          payload: { hello: 'test' },
          leaseExpiresInMinutes: 10,
          heartbeatEveryMs,
        }),
      };
    }
    if (path === '/api/worker/heartbeat') {
      const body = heartbeat(calls.filter((c) => c.path === '/api/worker/heartbeat').length);
      return { status: body.status || 200, json: async () => body };
    }
    if (path === '/api/worker/result') {
      return { status: 200, json: async () => ({ ok: true, duplicate: false }) };
    }
    return { status: 404, json: async () => ({ ok: false }) };
  };
  return { fetchImpl, calls };
}

const countOf = (calls, path) => calls.filter((c) => c.path === path).length;

/**
 * Runs `p`, failing with a readable message if it does not settle in time. Without this, the
 * defect reappearing shows up as the whole test FILE timing out with no indication which
 * expectation was waiting or why.
 */
async function withWatchdog(p, ms, what) {
  let timer;
  const alarm = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `${what} did not settle within ${ms}ms. With a sleep that never resolves, this means the `
      + 'abort did not release the heartbeat wait — DEFECT 6 has regressed.')), ms);
  });
  try { return await Promise.race([p, alarm]); } finally { clearTimeout(timer); }
}

// ── THE REGRESSION ITSELF ───────────────────────────────────────────────────

test('an immediately-completed task reports without waiting out the heartbeat interval', async () => {
  const { fetchImpl, calls } = makeFetch({ heartbeatEveryMs: 50_000 });

  // NEVER resolves. The only thing that can release the heartbeat wait is the abort.
  const neverSleep = () => new Promise(() => {});

  const client = new WorkerClient({
    baseUrl: 'https://dev.example.test', workerId: 'wkr_' + 'b'.repeat(32), secret: SECRET,
    fetchImpl, sleep: neverSleep,
  });

  const out = await withWatchdog(client.runOnce(), 2_000, 'runOnce() on an instant task');

  assert.equal(out.did, 'reported', 'the task should have been reported');
  assert.equal(out.status, 'SUCCEEDED');
  assert.equal(countOf(calls, '/api/worker/result'), 1, 'exactly one result submission');

  // The observable form of the defect: time spent draining the heartbeat after execution.
  assert.ok(out.beatDrainMs < 1_000,
    `draining the heartbeat took ${out.beatDrainMs}ms; the defect is a drain of roughly one `
    + 'heartbeat interval');
});

test('no heartbeat is sent for a task that has already finished', async () => {
  const { fetchImpl, calls } = makeFetch({ heartbeatEveryMs: 50_000 });
  const neverSleep = () => new Promise(() => {});
  const client = new WorkerClient({
    baseUrl: 'https://dev.example.test', workerId: 'wkr_' + 'c'.repeat(32), secret: SECRET,
    fetchImpl, sleep: neverSleep,
  });

  await withWatchdog(client.runOnce(), 2_000, 'runOnce() on an instant task');

  assert.equal(countOf(calls, '/api/worker/heartbeat'), 0,
    'a finished run must not be heartbeated — the wait is re-checked after it wakes');
});

// ── CONTROLS: THE FIX MUST NOT HAVE BOUGHT SPEED WITH SAFETY ────────────────

test('CONTROL: heartbeats still fire while a task is genuinely running', async () => {
  // Resolving immediately makes the loop iterate as fast as the task allows. The task takes real
  // time (its handler steps in 100ms slices), so heartbeats must occur during it.
  const { fetchImpl, calls } = makeFetch({ heartbeatEveryMs: 1_000 });
  const immediate = () => new Promise((r) => setImmediate(r));
  const client = new WorkerClient({
    baseUrl: 'https://dev.example.test', workerId: 'wkr_' + 'd'.repeat(32), secret: SECRET,
    fetchImpl, sleep: immediate,
  });

  // A claim that carries a delay, so execution outlasts at least one heartbeat pass.
  const slowFetch = async (url, opts) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/worker/claim') {
      return {
        status: 200,
        json: async () => ({
          ok: true, runId: RUN_ID, taskId: TASK_ID, taskType: 'synthetic.echo',
          payload: { delayMs: 300 }, leaseExpiresInMinutes: 10, heartbeatEveryMs: 1_000,
        }),
      };
    }
    return fetchImpl(url, opts);
  };
  client.fetch = slowFetch;

  const out = await withWatchdog(client.runOnce(), 5_000, 'runOnce() on a 300ms task');

  assert.equal(out.did, 'reported');
  assert.ok(countOf(calls, '/api/worker/heartbeat') >= 1,
    'a running task must still be heartbeated — otherwise the lease silently expires');
});

test('CONTROL: a cancel delivered on the heartbeat still aborts and reports nothing', async () => {
  const { fetchImpl, calls } = makeFetch({
    heartbeatEveryMs: 1_000,
    heartbeat: () => ({ ok: false, cancel: true, reason: 'cancelled by the server' }),
  });
  const immediate = () => new Promise((r) => setImmediate(r));
  const client = new WorkerClient({
    baseUrl: 'https://dev.example.test', workerId: 'wkr_' + 'e'.repeat(32), secret: SECRET,
    fetchImpl, sleep: immediate,
  });
  client.fetch = async (url, opts) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/worker/claim') {
      return {
        status: 200,
        json: async () => ({
          ok: true, runId: RUN_ID, taskId: TASK_ID, taskType: 'synthetic.echo',
          payload: { delayMs: 5_000 }, leaseExpiresInMinutes: 10, heartbeatEveryMs: 1_000,
        }),
      };
    }
    return fetchImpl(url, opts);
  };

  const out = await withWatchdog(client.runOnce(), 5_000, 'runOnce() on a cancelled task');

  assert.equal(out.did, 'aborted', 'a cancelled task must abort');
  assert.equal(out.reportedAnything, false, 'an aborted task reports NOTHING — not even FAILED');
  assert.equal(countOf(calls, '/api/worker/result'), 0, 'no result may be submitted for an abort');
  assert.equal(client.unresolved.length, 1, 'the uncertain outcome is recorded locally');
});

// ── NO UNHANDLED REJECTIONS ─────────────────────────────────────────────────

test('a sleep that THROWS does not strand the loop or leak a rejection', async () => {
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { fetchImpl } = makeFetch({ heartbeatEveryMs: 50_000 });
    const client = new WorkerClient({
      baseUrl: 'https://dev.example.test', workerId: 'wkr_' + 'f'.repeat(32), secret: SECRET,
      fetchImpl,
      sleep: () => Promise.reject(new Error('clock exploded')),
    });

    const out = await withWatchdog(client.runOnce(), 2_000, 'runOnce() with a throwing sleep');
    assert.equal(out.did, 'reported', 'a broken clock must not prevent reporting a finished task');

    // Give any stray rejection a turn to surface before asserting there was none.
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, [], 'the heartbeat wait must not produce an unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
