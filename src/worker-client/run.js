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

/** Readiness, without contacting the server and without reading the secret. */
function doctor(env = process.env) {
  const cfg = config(env);
  const caps = EXEC.capabilities();
  const key = cfg.workerId ? KEYCHAIN.hasSecret({ workerId: cfg.workerId }) : { present: false, reason: 'no WORKER_ID' };
  return {
    platform: process.platform,
    node: process.version,
    baseUrlConfigured: Boolean(cfg.baseUrl),
    baseUrlIsHttps: /^https:\/\//.test(cfg.baseUrl),
    workerIdConfigured: Boolean(cfg.workerId),
    // present/absent only. The value is never read here, let alone printed.
    keychainItemPresent: key.present,
    keychainDetail: key.present ? null : key.reason,
    implementedTaskTypes: caps.implemented,
    declaredButNotImplemented: caps.declaredButNotImplemented,
    maxOutputBytes: caps.maxOutputBytes,
    inboundListeners: 0,
    problems: cfg.problems,
    ready: cfg.problems.length === 0 && key.present,
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--doctor')) {
    process.stdout.write(`${JSON.stringify(doctor(env), null, 2)}\n`);
    return doctor(env).ready ? 0 : 1;
  }

  const cfg = config(env);
  if (cfg.problems.length) {
    for (const p of cfg.problems) logLine({ at: 'config_error', problem: p });
    return 2;
  }

  let secret;
  try {
    secret = KEYCHAIN.readSecret({ workerId: cfg.workerId });
  } catch (e) {
    logLine({ at: 'no_credential', detail: String(e.message).slice(0, 200) });
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
  logLine({ at: 'stopped', cycles: res.cycles, unresolved: res.unresolved.length });
  return 0;
}

module.exports = { main, config, doctor, logLine, SHUTDOWN_GRACE_MS, DROP_FROM_LOGS };

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => {
    logLine({ at: 'fatal', detail: String(e && e.message).slice(0, 300) });
    process.exit(1);
  });
}
