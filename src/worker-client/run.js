#!/usr/bin/env node
// ── THE WORKER PROCESS ───────────────────────────────────────────────────────
//
//   node src/worker-client/run.js              poll for ever (what launchd starts)
//   node src/worker-client/run.js --once       one cycle, then exit
//   node src/worker-client/run.js --doctor     report readiness, contact nothing, change nothing
//
// Configuration comes from the environment; the SECRET never does. The id and the URL are not
// secrets and belong in the LaunchAgent; the secret is read from the Keychain at startup and held
// in memory only. See keychain.js for why an EnvironmentVariables entry would be the wrong place.
//
// ── IT OPENS NOTHING ────────────────────────────────────────────────────────
//
// No server, no port, no socket to listen on. `--doctor` reports that as a fact it can check
// rather than a claim the documentation makes.
//
// ── SHUTDOWN IS COOPERATIVE, THEN BOUNDED ───────────────────────────────────
//
// SIGTERM — which is what `launchctl kickstart -k` and a logout send — stops the loop taking new
// work and lets the running task observe its own cancellation. If the task has not finished within
// SHUTDOWN_GRACE_MS the process exits anyway, because a service that ignores SIGTERM gets SIGKILL
// from launchd and then nothing gets to run its cleanup at all.
//
// The outcome of a task interrupted this way is UNCERTAIN and is reported as nothing. The server's
// expiry handling moves it to NEEDS_RESOLUTION, which is true, rather than FAILED, which would be
// a guess.

'use strict';

const KEYCHAIN = require('./keychain');
const EXEC = require('./executor');
const { WorkerClient } = require('./client');

const SHUTDOWN_GRACE_MS = 20_000;

/** One line of JSON per event. No secrets, no payloads, no outputs — see the filter below. */
const DROP_FROM_LOGS = ['secret', 'signature', 'nonce', 'token', 'password', 'payload', 'output', 'echoed'];
function logLine(ev) {
  const safe = {};
  for (const [k, v] of Object.entries(ev || {})) {
    const key = String(k).toLowerCase();
    if (DROP_FROM_LOGS.some((f) => key.includes(f))) continue;
    safe[k] = typeof v === 'string' ? v.slice(0, 300) : v;
  }
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...safe })}\n`);
}

function config(env = process.env) {
  const problems = [];
  const baseUrl = env.WORKER_API_BASE_URL || '';
  const workerId = env.WORKER_ID || '';
  if (!baseUrl) problems.push('WORKER_API_BASE_URL is not set');
  else if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(baseUrl)) {
    // Plain HTTP is permitted ONLY to loopback, for the tests. Anything else must be HTTPS: the
    // HMAC authenticates the request but does not conceal the payload, and a task payload can
    // carry business content.
    problems.push('WORKER_API_BASE_URL must be https:// (http:// is allowed only to loopback)');
  }
  if (!workerId) problems.push('WORKER_ID is not set');
  else if (!/^wkr_[0-9a-f]{32}$/.test(workerId)) problems.push('WORKER_ID is not of the enrolled shape');
  return { baseUrl, workerId, problems };
}

/**
 * Readiness, without contacting the server and without exposing the secret.
 *
 * `keychainState` replaced a bare `keychainItemPresent` boolean. That boolean could not express
 * "the credential IS there and macOS refused to hand it over", so it reported "absent" — and the
 * obvious response to absent is to re-enrol, which spends a single-use token and fixes nothing.
 * See the comment above probeSecret() in keychain.js for the macOS 26.4+ defect that makes this
 * the likely first failure on a current macOS.
 */
function doctor(env = process.env, deps = {}) {
  const cfg = config(env);
  const caps = EXEC.capabilities();
  const key = KEYCHAIN.probeSecret({ workerId: cfg.workerId }, deps);

  // Only `readable` means the worker can actually start. `unknown` deliberately counts as neither
  // ready nor missing.
  const credentialUsable = key.state === KEYCHAIN.STATE.READABLE;

  return {
    platform: process.platform,
    node: process.version,
    baseUrlConfigured: Boolean(cfg.baseUrl),
    baseUrlIsHttps: /^https:\/\//.test(cfg.baseUrl),
    workerIdConfigured: Boolean(cfg.workerId),
    // missing | readable | unreadable | unknown | not_macos — never a boolean standing in for these.
    keychainState: key.state,
    keychainStatus: key.status,
    keychainDetail: key.detail,
    keychainRecovery: key.hint,
    // Kept for continuity, and null where the honest answer is "we do not know".
    keychainItemPresent: key.present,
    implementedTaskTypes: caps.implemented,
    declaredButNotImplemented: caps.declaredButNotImplemented,
    maxOutputBytes: caps.maxOutputBytes,
    inboundListeners: 0,
    problems: cfg.problems,
    ready: cfg.problems.length === 0 && credentialUsable,
  };
}

// ── WHAT `READY` MUST MEAN, AND WHY `doctor()` IS LEFT ALONE ────────────────
//
// `doctor()` above answers one question — is this machine CONFIGURED and is the credential
// readable — and it answers it without contacting anything. That is a useful question and other
// code depends on its shape, so it keeps its name and its meaning.
//
// What it cannot answer, and was being read as though it could:
//
//   2026-11-20  `ready: true, problems: []` while the worker had been dead for eleven minutes
//   2026-11-20  `ready: true` while the identity was revoked and 574 requests had been refused
//
// Both true to the letter. Neither is operational readiness. So `diagnose()` reports FOUR separate
// facts, each labelled by what it measures, and derives an overall verdict from all of them:
//
//   configuration    env vars present and well-shaped        (no network, no processes)
//   credential       the Keychain item is readable           (no network)
//   process          is a worker actually running             (pgrep, excluding this diagnostic)
//   authentication   does the server accept this credential   (one signed, side-effect-free call)
//
// A fact that could not be established is reported as such and is never counted as a pass — the
// same rule the acceptance driver follows with UNTESTED.

const WORKER_PROCESS_PATTERN = 'worker-client/run.js';

/**
 * Is a worker process running for this user, not counting the one asking?
 *
 * `--doctor` is itself a `run.js` process, so an unfiltered pgrep reports the diagnostic as the
 * worker and would say "running" on a machine where nothing is.
 */
function processState(deps = {}) {
  const run = deps.exec || ((cmd, args) => require('node:child_process')
    .execFileSync(cmd, args, { encoding: 'utf8' }));
  try {
    const out = String(run('pgrep', ['-u', String(process.getuid()), '-f', WORKER_PROCESS_PATTERN]));
    const pids = out.split('\n').map((x) => x.trim()).filter(Boolean)
      .map(Number).filter((n) => Number.isInteger(n) && n !== process.pid);
    return { alive: pids.length > 0, pids, detail: pids.length ? null : 'no worker process is running' };
  } catch (e) {
    // pgrep exits 1 when nothing matches, which is an answer, not a failure.
    const status = e && typeof e.status === 'number' ? e.status : null;
    if (status === 1) return { alive: false, pids: [], detail: 'no worker process is running' };
    return { alive: null, pids: [], detail: `pgrep could not run (${status === null ? 'unknown' : status})` };
  }
}

/**
 * The full operational picture. Async, because authentication cannot be established without
 * asking the server.
 */
async function diagnose(env = process.env, deps = {}) {
  const base = doctor(env, deps);
  const proc = deps.processState ? deps.processState() : processState(deps);

  let auth = { state: 'skipped', code: null,
    detail: 'the authentication probe was skipped (--no-network)' };
  const wantNetwork = !(deps.noNetwork === true);
  if (wantNetwork && base.baseUrlConfigured && base.workerIdConfigured
      && base.keychainState === KEYCHAIN.STATE.READABLE) {
    try {
      const probe = deps.probeAuth
        ? await deps.probeAuth()
        : await (async () => {
          const cfg = config(env);
          const secret = KEYCHAIN.readSecret({ workerId: cfg.workerId });
          const { WorkerClient } = require('./client');
          return new WorkerClient({ baseUrl: cfg.baseUrl, workerId: cfg.workerId, secret })
            .probeAuth();
        })();
      auth = probe;
    } catch (e) {
      auth = { state: 'unreachable', code: null,
        detail: `the probe could not be made: ${String(e && e.message).slice(0, 160)}` };
    }
  } else if (wantNetwork) {
    auth = { state: 'skipped', code: null,
      detail: 'not probed: the configuration or the credential is not usable yet' };
  }

  // Each reason names the fact that failed, so the verdict is never a bare false.
  const reasons = [];
  if (base.problems.length) reasons.push(`configuration: ${base.problems.join('; ')}`);
  if (base.keychainState !== KEYCHAIN.STATE.READABLE) {
    reasons.push(`credential: ${base.keychainState}`);
  }
  if (proc.alive !== true) reasons.push(`process: ${proc.detail || 'not running'}`);
  if (auth.state !== 'authenticated') reasons.push(`authentication: ${auth.state}`);

  return {
    ...base,
    process: proc,
    authentication: auth,
    operational: { ready: reasons.length === 0, reasons },
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--doctor')) {
    // A superset of doctor()'s fields, so every existing reader keeps working, plus the three
    // facts it could not establish. The exit code follows OPERATIONAL readiness: a stopped or
    // revoked worker exits non-zero here, which is the whole point of the change.
    const d = await diagnose(env, { noNetwork: argv.includes('--no-network') });
    process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
    return d.operational.ready ? 0 : 1;
  }

  const cfg = config(env);
  if (cfg.problems.length) {
    for (const p of cfg.problems) logLine({ at: 'config_error', problem: p });
    return 2;
  }

  // ── THE LINE A RESTART LOOP REPEATS EVERY MINUTE ──────────────────────────
  //
  // launchd restarts this process on a non-zero exit, throttled to 60s. If the credential cannot be
  // read, that is the line an operator will see sixty times an hour, so it has to say WHICH failure
  // it is. It used to say `no_credential` for every case — including the macOS 26.4+ state where the
  // credential is present and macOS refuses to release it, where "no credential" is simply false and
  // points at re-enrolment, which spends a token and changes nothing.
  let secret;
  const probe = KEYCHAIN.probeSecret({ workerId: cfg.workerId });
  if (probe.state !== KEYCHAIN.STATE.READABLE) {
    logLine({
      at: 'credential_unavailable',
      keychainState: probe.state,
      keychainStatus: probe.status,
      detail: probe.detail,
      recovery: probe.short,
    });
    return 2;
  }
  try {
    secret = KEYCHAIN.readSecret({ workerId: cfg.workerId });
  } catch (e) {
    // The probe said readable and the read then failed: a race, or the state changed between them.
    // Reported as its own case rather than folded into either of the two above.
    logLine({ at: 'credential_read_failed_after_probe', detail: String(e.message).slice(0, 200) });
    return 2;
  }

  const client = new WorkerClient({
    baseUrl: cfg.baseUrl, workerId: cfg.workerId, secret, log: logLine,
  });

  let forced = false;
  const onSignal = (sig) => {
    logLine({ at: 'shutdown_requested', signal: sig });
    client.stop();
    setTimeout(() => {
      if (!forced) {
        forced = true;
        logLine({ at: 'shutdown_forced', afterMs: SHUTDOWN_GRACE_MS,
          note: 'a task was still running; its outcome is uncertain and nothing was reported for it' });
        process.exit(0);
      }
    }, SHUTDOWN_GRACE_MS).unref();
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  logLine({ at: 'started', workerId: cfg.workerId, platform: process.platform,
    implemented: EXEC.capabilities().implemented.join(',') });

  const res = await client.loop({ maxCycles: argv.includes('--once') ? 1 : Infinity });
  for (const u of res.unresolved) {
    logLine({ at: 'unresolved', runId: u.runId, taskId: u.taskId, executed: Boolean(u.executed),
      reason: u.reason });
  }
  logLine({ at: 'stopped', cycles: res.cycles, unresolved: res.unresolved.length,
    terminal: res.terminal ? res.terminal.code : null });
  if (res.terminal) {
    // Exit 0 DELIBERATELY. `KeepAlive { SuccessfulExit false }` relaunches a non-zero exit, so
    // exiting 2 here would convert an every-5-seconds retry loop into an every-60-seconds respawn
    // loop and keep writing audit rows for a credential that needs a human.
    logLine({ at: 'stopped_terminal', code: res.terminal.code,
      note: 'exiting 0 so launchd leaves this worker stopped; enrol a new identity to resume' });
  }
  return 0;
}

module.exports = {
  main, config, doctor, diagnose, processState, logLine,
  SHUTDOWN_GRACE_MS, DROP_FROM_LOGS, WORKER_PROCESS_PATTERN,
};

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => {
    logLine({ at: 'fatal', detail: String(e && e.message).slice(0, 300) });
    process.exit(1);
  });
}
