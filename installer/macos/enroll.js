#!/usr/bin/env node
// ── EXCHANGE AN ENROLMENT TOKEN FOR A KEYCHAIN ITEM ─────────────────────────
//
//   WORKER_ENROLL_TOKEN=<token> node installer/macos/enroll.js <worker-id-or-blank> [--url <https>]
//
// Called by `workerctl enroll`. Run once per machine.
//
// ── THE TOKEN AND THE SECRET NEVER TOUCH argv, A FILE, OR stdout ────────────
//
// The token arrives in the environment of this one process (workerctl reads it with `read -s`, so
// it is not in shell history either) and is used immediately. The secret that comes back is passed
// to `security add-generic-password` and then dropped.
//
// Nothing is printed except the worker id and a confirmation. `security` is invoked with
// execFileSync and an argument array — never a shell string — so the secret cannot be split by the
// shell, logged by a trace, or captured from `ps` by anything other than a process already running
// as this user.
//
// WRITTEN BUT NOT EXECUTED ON APPLE HARDWARE: the Keychain write is unverified by execution,
// because `security` does not exist on Linux.

'use strict';

const KEYCHAIN = require('../../src/worker-client/keychain');

function arg(name, argv) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const token = env.WORKER_ENROLL_TOKEN || '';
  const expectId = argv.find((a) => /^wkr_/.test(a)) || null;
  const url = (arg('--url', argv) || env.WORKER_API_BASE_URL || '').replace(/\/$/, '');

  if (!token) {
    process.stderr.write('WORKER_ENROLL_TOKEN is not set. workerctl supplies it; do not pass it as an argument.\n');
    return 2;
  }
  if (!url) {
    process.stderr.write('no API base URL: pass --url https://… or set WORKER_API_BASE_URL\n');
    return 2;
  }
  // Enrolment is the one request that carries a credential BACK. Over plain HTTP that hands the
  // worker secret to the network, so loopback is the only exception and it exists for the tests.
  if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
    process.stderr.write('refusing to enrol over plain HTTP: the response contains the worker secret\n');
    return 2;
  }

  let res; let body;
  try {
    res = await fetch(`${url}/api/worker/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, hostFingerprint: `${process.platform}-${require('os').hostname()}` }),
    });
    body = await res.json();
  } catch (e) {
    process.stderr.write(`could not reach ${url}: ${String(e && e.message).slice(0, 200)}\n`);
    return 1;
  }

  if (!res.ok || !body || !body.ok) {
    // The server's code, not the token, and not the response verbatim — it contains the secret on
    // the success path and echoing "the whole body" on failure is how that habit starts.
    process.stderr.write(`enrolment refused (HTTP ${res.status}): ${(body && body.code) || 'unknown'}\n`);
    return 1;
  }
  if (expectId && body.workerId !== expectId) {
    process.stderr.write(`the server enrolled ${body.workerId}, not the ${expectId} you asked for. `
      + 'Nothing was stored. Check which token you used.\n');
    return 1;
  }

  try {
    KEYCHAIN.writeSecret({ workerId: body.workerId, secret: body.secret });
  } catch (e) {
    process.stderr.write(`the secret could NOT be stored: ${String(e.message).slice(0, 200)}\n`
      + 'The token is now spent. Mint another and try again.\n');
    return 1;
  }

  process.stdout.write(`enrolled ${body.workerId}${body.label ? ` (${body.label})` : ''}\n`);
  process.stdout.write('the secret is in the login Keychain and was not written anywhere else\n');
  return 0;
}

module.exports = { main };

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => {
    process.stderr.write(`enrolment failed: ${String(e && e.message).slice(0, 200)}\n`);
    process.exit(1);
  });
}
