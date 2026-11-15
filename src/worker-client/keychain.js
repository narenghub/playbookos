// ── WHERE THE WORKER SECRET LIVES ON THE MACHINE ────────────────────────────
//
// M7.4. macOS Keychain, through the `security` binary. The secret is never written to a file in the
// repository, a dotfile, an environment variable in a plist, or a log line.
//
// ── WHY NOT A FILE, OR AN ENVIRONMENT VARIABLE IN THE LaunchAgent ───────────
//
// A LaunchAgent plist is world-readable and lives in ~/Library/LaunchAgents. A secret in its
// EnvironmentVariables block is readable by every process the user runs, survives in Time Machine
// backups, and shows up in `plutil` output when somebody debugs the service. A dotfile is the same
// story with extra steps.
//
// The Keychain item is ACL-bound to the worker account. Reading it as another user prompts or
// fails rather than silently succeeding.
//
// ── NO FALLBACK OFF macOS, DELIBERATELY ─────────────────────────────────────
//
// There is no "if not darwin, read a file instead". That fallback is how the development shortcut
// becomes the deployed shape — the code path exists, it works, and one day something runs with it
// on a machine nobody thought of. Off macOS this module refuses, and the tests inject the secret
// explicitly through `deps.secret`, which is visibly a test affordance rather than a quiet
// alternative.
//
// ── THE SECRET IS NEVER RETURNED THROUGH AN ERROR ───────────────────────────
//
// `security` prints the password on stdout. Every failure path here throws a message built from
// the exit status and stderr only — never from stdout, and never the command line, because
// `add-generic-password -w <secret>` puts the secret in argv where it would land in any error that
// echoed the command.

'use strict';

const { execFileSync } = require('child_process');

const SERVICE = 'ai.playnexa.worker';
const ACCOUNT_LABEL = 'worker-secret';

const isDarwin = () => process.platform === 'darwin';

function assertDarwin(op) {
  if (!isDarwin()) {
    throw new Error(
      `${op} requires macOS Keychain and this is ${process.platform}. There is deliberately no `
      + 'file-based fallback: pass the secret explicitly in tests instead.');
  }
}

/**
 * Reads the worker secret. Returns the secret string.
 *
 * `deps.secret` short-circuits for tests. It is a parameter rather than an environment variable so
 * that it cannot be set accidentally by a deployment.
 */
function readSecret({ workerId } = {}, deps = {}) {
  if (deps.secret) return String(deps.secret);
  assertDarwin('reading the worker secret');
  if (!workerId) throw new Error('a worker id is required to read its secret');
  try {
    const out = execFileSync('/usr/bin/security',
      ['find-generic-password', '-s', SERVICE, '-a', `${ACCOUNT_LABEL}:${workerId}`, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return String(out).replace(/\n$/, '');
  } catch (e) {
    // status and stderr only. stdout would be the secret.
    throw new Error(`the Keychain item for ${workerId} could not be read `
      + `(status ${e.status}): ${String(e.stderr || '').trim().slice(0, 200)}`);
  }
}

/**
 * Stores the worker secret. Used once, by the enrolment step of the installer.
 *
 * `-U` updates in place so re-running enrolment is idempotent rather than creating a second item
 * that `find-generic-password` would then choose between arbitrarily.
 */
function writeSecret({ workerId, secret } = {}) {
  assertDarwin('storing the worker secret');
  if (!workerId || !secret) throw new Error('both a worker id and a secret are required');
  try {
    execFileSync('/usr/bin/security',
      ['add-generic-password', '-U', '-s', SERVICE, '-a', `${ACCOUNT_LABEL}:${workerId}`,
        '-w', String(secret), '-T', '/usr/bin/security',
        '-D', 'PlayNexa worker credential'],
      { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error(`the Keychain item could not be written (status ${e.status}): `
      + String(e.stderr || '').trim().slice(0, 200));
  }
  return { stored: true, service: SERVICE, account: `${ACCOUNT_LABEL}:${workerId}` };
}

function deleteSecret({ workerId } = {}) {
  assertDarwin('deleting the worker secret');
  try {
    execFileSync('/usr/bin/security',
      ['delete-generic-password', '-s', SERVICE, '-a', `${ACCOUNT_LABEL}:${workerId}`],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    return { deleted: true };
  } catch (e) {
    // Absent is the desired end state, so a missing item is not a failure.
    return { deleted: false, reason: `not present or not removable (status ${e.status})` };
  }
}

/** Reports whether the item exists, WITHOUT reading it. Used by the diagnostic command. */
function hasSecret({ workerId } = {}) {
  if (!isDarwin()) return { present: false, reason: `not macOS (${process.platform})` };
  try {
    execFileSync('/usr/bin/security',
      ['find-generic-password', '-s', SERVICE, '-a', `${ACCOUNT_LABEL}:${workerId}`],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    return { present: true };
  } catch (e) {
    return { present: false, reason: `status ${e.status}` };
  }
}

module.exports = {
  SERVICE, ACCOUNT_LABEL, isDarwin,
  readSecret, writeSecret, deleteSecret, hasSecret,
};
