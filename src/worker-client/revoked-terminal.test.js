// ── A REVOKED CREDENTIAL MUST STOP THE WORKER ───────────────────────────────
//
//   node --test src/worker-client/revoked-terminal.test.js
//
// Measured on the office iMac on 2026-11-20, 50 minutes after M7.5 scenario 8 revoked its identity:
//
//     outcome  code     rows  last
//     DENIED   revoked  574   2026-11-20T20:28:19.933Z
//
// Every ~5 seconds, for an hour, for a credential that cannot come back without a human minting a
// token. `callWithRetry` already refused to retry a 4xx decision; the SERVICE LOOP retried the
// whole cycle regardless, which is the same mistake one level up.
//
// The exit code matters as much as the stop. `KeepAlive { SuccessfulExit false }` relaunches a
// non-zero exit, so exiting 2 here would convert a 5-second retry loop into a 60-second respawn
// loop and keep writing audit rows for ever.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { WorkerClient, TERMINAL_AUTH_CODES, NIL_RUN_ID } = require('./client');

const WID = `wkr_${'a'.repeat(32)}`;

/** A client whose transport answers from a scripted list, recording every request. */
function clientWith(responses, opts = {}) {
  const sent = [];
  const logs = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    sent.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      status: r.status,
      json: async () => r.json,
    };
  };
  const client = new WorkerClient({
    baseUrl: 'https://dev.example.com',
    workerId: WID,
    secret: 'x'.repeat(64),
    fetchImpl,
    log: (l) => logs.push(l),
    sleep: async () => {},            // no real waiting
    ...opts,
  });
  return { client, sent, logs };
}

const REVOKED = { status: 401, json: { ok: false, code: 'revoked', detail: 'this worker was revoked' } };
const NOTHING = { status: 404, json: { ok: false, code: 'nothing_to_do' } };

// ── THE DEFECT ──────────────────────────────────────────────────────────────

test('DECISIVE: the loop stops on the FIRST revoked refusal', async () => {
  const { client, sent, logs } = clientWith([REVOKED]);
  const res = await client.loop({ maxCycles: 50 });

  assert.equal(res.cycles, 1, `the loop ran ${res.cycles} cycles for a revoked credential`);
  assert.equal(sent.length, 1, `${sent.length} requests were made; a revoked worker must stop after one`);
  assert.ok(res.terminal, 'the loop must report why it stopped');
  assert.equal(res.terminal.code, 'revoked');
  assert.ok(logs.some((l) => l.at === 'credential_terminal'), 'the stop must be logged');
});

test('CONTROL: without the fix this would have run every cycle it was given', async () => {
  // The same transport, but driving the loop the way the defect behaved: any non-terminal refusal
  // keeps polling. This proves the assertion above is about `revoked` specifically and not about
  // the loop being incapable of iterating.
  const { client, sent } = clientWith([NOTHING]);
  const res = await client.loop({ maxCycles: 5 });
  assert.equal(res.cycles, 5, 'a non-terminal refusal must keep polling');
  assert.equal(sent.length, 5);
  assert.equal(res.terminal, null);
});

test('the terminal list is narrow and explicit', () => {
  // Widening this without evidence is how a worker ends up refusing to start over something
  // transient. `unknown_worker` and `bad_signature` are deliberately absent — recorded as a
  // follow-up, not smuggled in here.
  assert.deepEqual([...TERMINAL_AUTH_CODES], ['revoked']);
});

test('a revoked refusal mid-run stops it there, not after the whole budget', async () => {
  const { client, sent } = clientWith([NOTHING, NOTHING, REVOKED, NOTHING, NOTHING]);
  const res = await client.loop({ maxCycles: 5 });
  assert.equal(res.cycles, 3);
  assert.equal(sent.length, 3);
  assert.equal(res.terminal.code, 'revoked');
});

// ── THE AUTH PROBE ──────────────────────────────────────────────────────────

test('probeAuth reports revoked, authenticated and unreachable distinctly', async () => {
  const revoked = clientWith([REVOKED]);
  assert.equal((await revoked.client.probeAuth()).state, 'revoked');

  // A heartbeat for the nil run id authenticates and is then refused for the lease, which is the
  // expected shape: the credential was accepted.
  const live = clientWith([{ status: 409, json: { ok: false, code: 'lease_not_live' } }]);
  const okProbe = await live.client.probeAuth();
  assert.equal(okProbe.state, 'authenticated');
  assert.equal(okProbe.code, 'lease_not_live');

  const down = new WorkerClient({
    baseUrl: 'https://dev.example.com', workerId: WID, secret: 'x'.repeat(64),
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  const dead = await down.probeAuth();
  assert.equal(dead.state, 'unreachable');
  assert.match(dead.detail, /ECONNREFUSED/);
});

test('DECISIVE: the probe cannot claim work or submit a result', async () => {
  const { client, sent } = clientWith([{ status: 409, json: { ok: false, code: 'lease_not_live' } }]);
  await client.probeAuth();
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/api\/worker\/heartbeat$/,
    'the probe must use heartbeat; claim leases work and result writes one');
  assert.equal(sent[0].body.runId, NIL_RUN_ID);
  assert.ok(!sent.some((s) => /claim|result/.test(s.url)));
});

// ── THE DIAGNOSTIC NO LONGER CALLS A STOPPED WORKER READY ───────────────────

test('DECISIVE: diagnose() refuses to call a revoked worker operationally ready', async () => {
  const RUN = require('./run');
  const KEYCHAIN = require('./keychain');
  const env = { WORKER_API_BASE_URL: 'https://dev.example.com', WORKER_ID: WID };
  const readable = { exec: () => ({ ok: true, status: 0, stdout: 'x'.repeat(64), stderr: '' }) };

  const d = await RUN.diagnose(env, {
    ...readable,
    platform: 'darwin',
    processState: () => ({ alive: true, pids: [123], detail: null }),
    probeAuth: async () => ({ state: 'revoked', code: 'revoked', detail: 'revoked' }),
  });
  assert.equal(d.keychainState, KEYCHAIN.STATE.READABLE);
  assert.equal(d.ready, true, 'the old field still means configuration + credential');
  assert.equal(d.operational.ready, false, 'a revoked worker is not operationally ready');
  assert.ok(d.operational.reasons.some((r) => /authentication: revoked/.test(r)),
    d.operational.reasons.join('; '));
});

test('DECISIVE: diagnose() refuses to call a dead worker operationally ready', async () => {
  // The exact 2026-11-20 case: `ready: true, problems: []` while the worker had been dead for
  // eleven minutes, because doctor() checks configuration and the Keychain and contacts nothing.
  const RUN = require('./run');
  const env = { WORKER_API_BASE_URL: 'https://dev.example.com', WORKER_ID: WID };
  const d = await RUN.diagnose(env, {
    exec: () => ({ ok: true, status: 0, stdout: 'x'.repeat(64), stderr: '' }),
    platform: 'darwin',
    processState: () => ({ alive: false, pids: [], detail: 'no worker process is running' }),
    probeAuth: async () => ({ state: 'authenticated', code: null, detail: 'accepted' }),
  });
  assert.equal(d.operational.ready, false);
  assert.ok(d.operational.reasons.some((r) => /process: no worker process/.test(r)));
});

test('CONTROL: a healthy worker IS operationally ready', async () => {
  // Without this, the two assertions above are satisfied by a verdict that is never true.
  const RUN = require('./run');
  const env = { WORKER_API_BASE_URL: 'https://dev.example.com', WORKER_ID: WID };
  const d = await RUN.diagnose(env, {
    exec: () => ({ ok: true, status: 0, stdout: 'x'.repeat(64), stderr: '' }),
    platform: 'darwin',
    processState: () => ({ alive: true, pids: [4242], detail: null }),
    probeAuth: async () => ({ state: 'authenticated', code: 'lease_not_live', detail: 'accepted' }),
  });
  assert.deepEqual(d.operational.reasons, []);
  assert.equal(d.operational.ready, true);
});

test('diagnose() reports the four facts separately, each labelled', async () => {
  const RUN = require('./run');
  const d = await RUN.diagnose(
    { WORKER_API_BASE_URL: 'https://dev.example.com', WORKER_ID: WID },
    {
      exec: () => ({ ok: true, status: 0, stdout: 'x'.repeat(64), stderr: '' }),
      platform: 'darwin',
      processState: () => ({ alive: true, pids: [1], detail: null }),
      probeAuth: async () => ({ state: 'authenticated', code: null, detail: 'accepted' }),
    });
  assert.ok(Array.isArray(d.problems), 'configuration');
  assert.ok('keychainState' in d, 'credential');
  assert.ok(d.process && 'alive' in d.process, 'process');
  assert.ok(d.authentication && 'state' in d.authentication, 'authentication');
  assert.ok(d.operational && 'ready' in d.operational, 'overall');
});

test('the probe is skipped, and not silently passed, when the credential is unusable', async () => {
  const RUN = require('./run');
  const d = await RUN.diagnose({ WORKER_API_BASE_URL: '', WORKER_ID: '' }, { platform: 'darwin' });
  assert.notEqual(d.authentication.state, 'authenticated');
  assert.equal(d.operational.ready, false);
});

test('processState does not count the diagnostic itself as the worker', () => {
  // `--doctor` IS a run.js process. An unfiltered pgrep would report the diagnostic as the worker
  // and say "running" on a machine where nothing is.
  const RUN = require('./run');
  const s = RUN.processState({ exec: () => `${process.pid}\n` });
  assert.equal(s.alive, false, 'the diagnostic must not count itself');
  const s2 = RUN.processState({ exec: () => `${process.pid}\n999999\n` });
  assert.deepEqual(s2.pids, [999999]);
});

test('pgrep finding nothing is an answer, not a failure', () => {
  const RUN = require('./run');
  const s = RUN.processState({
    exec: () => { const e = new Error('no match'); e.status = 1; throw e; },
  });
  assert.equal(s.alive, false);
  assert.match(s.detail, /no worker process/);

  const broken = RUN.processState({
    exec: () => { const e = new Error('nope'); e.status = 127; throw e; },
  });
  assert.equal(broken.alive, null, 'an unavailable pgrep must be unknown, not false');
});
