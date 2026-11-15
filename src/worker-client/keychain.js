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

// ── WHY "IT IS NOT THERE" AND "I COULD NOT READ IT" ARE DIFFERENT ANSWERS ───
//
// hasSecret() used to return { present: false } for EVERY failure of
// `security find-generic-password` — item absent, authentication refused, keychain locked, binary
// missing, all of it. So the diagnostic reported "no credential" whenever the lookup failed, which
// is the lookup's outcome standing in for the item's existence. Another proxy measurement.
//
// That matters on macOS 26.4 and later. Apple's developer forums document reads of generic-password
// items returning errSecAuthFailed (-25293) WHILE THE KEYCHAIN REPORTS ITSELF UNLOCKED, triggered by
// a process reading the keychain early in startup — exactly what this worker does under launchd.
// The state persists across process restarts until somebody locks and unlocks the keychain by hand.
// In that state the old code said "not enrolled", the obvious response was to re-enrol, and
// re-enrolling spends a single-use token and fixes nothing.
//
// So the verdict is explicit, and "missing" is claimed ONLY when a not-found signature was actually
// observed. Anything unrecognised is `unknown` with the raw status and stderr, never downgraded to
// absent. An unknown answer the operator can investigate beats a confident wrong one.

const STATE = Object.freeze({
  READABLE: 'readable',         // the item exists and its value came back
  UNREADABLE: 'unreadable',     // it is there, or being refused — NOT absent
  MISSING: 'missing',           // a not-found signature was genuinely observed
  UNKNOWN: 'unknown',           // something else; details preserved, nothing concluded
  NOT_MACOS: 'not_macos',
});

// Matched on the text `security` prints, not on exit codes: the CLI's numeric codes are not
// documented as a stable mapping of OSStatus, and guessing one would be the same mistake in a new
// place. An unmatched signature falls through to UNKNOWN by design.
// `short` is for a log line, which is truncated and which a restart loop repeats every minute.
// `hint` is the full guidance, for the diagnostic, where there is room for it.
// ── ORDER IS LOAD-BEARING, AND SO IS NOT MATCHING A FUNCTION NAME ───────────
//
// The first version of this list matched MISSING on `SecKeychainSearchCopyNext`, and put it first.
// That is the name of the macOS FUNCTION that failed, and it appears in the not-found message AND
// in the errSecAuthFailed message — so -25293 was classified as "missing", which is the exact defect
// this code was written to remove. The regression tests caught it because they assert against the
// real strings macOS prints rather than a paraphrase.
//
// So: each pattern matches the distinctive part of its own message, nothing matches a function name,
// and the specific cases are evaluated before the general one. Note "specified ITEM could not be
// found" (absent) against "specified KEYCHAIN could not be found" (no such keychain) — one word
// apart, and a different answer.
const SIGNATURES = [
  { state: STATE.UNREADABLE, re: /user name or passphrase you entered is not correct|-?25293|errSecAuthFailed/i,
    short: 'macOS 26.4+ errSecAuthFailed — do NOT re-enrol; lock then unlock the login keychain',
    hint: 'macOS refused the read while reporting the keychain unlocked. This is the macOS 26.4+ '
      + 'defect (errSecAuthFailed / -25293). RE-ENROLLING WILL NOT FIX IT and spends a single-use '
      + 'token for nothing. Recovery: lock and then unlock the login keychain, which prompts for '
      + 'the account password at the console — "security lock-keychain", then '
      + '"security unlock-keychain". Consider updating to the latest macOS point release.' },
  { state: STATE.UNREADABLE, re: /interaction is not allowed|-?25308|errSecInteractionNotAllowed/i,
    short: 'macOS cannot prompt here — the worker must run in the account\'s GUI login session',
    hint: 'macOS will not prompt in this context, so the read cannot be authorised. The worker must '
      + 'run as a LaunchAgent inside the account\'s own GUI login session, not as a daemon and not '
      + 'over ssh.' },
  { state: STATE.UNREADABLE,
    re: /specified keychain could not be found|keychain (is )?locked|-?25295|errSecNoSuchKeychain|errSecInteractionRequired/i,
    short: 'the login keychain is locked or absent — log in to this account at the console',
    hint: 'The login keychain is locked, or is not where macOS expects it. Unlock it by logging in '
      + 'to this account at the console. Note the macOS 26.4.1 reports of loginwindow moving a '
      + 'login keychain aside and creating a blank replacement — if this account previously had a '
      + 'credential and now has none, check for a displaced keychain before re-enrolling.' },
  // Last, and narrow: the ITEM, not the keychain.
  { state: STATE.MISSING, re: /specified item could not be found|errSecItemNotFound|-?25300/i,
    short: 'no credential stored for this worker id — enrol it',
    hint: 'No credential is stored for this worker id. Enrol it.' },
];

/**
 * Classifies the state of the stored credential WITHOUT ever returning or logging its value.
 *
 * Two probes, because the difference between them is the signal: the first asks only for metadata
 * and never touches the secret; the second asks for the value and its stdout is discarded the
 * moment it is seen to exist.
 *
 * `deps.exec` and `deps.platform` exist so the regression tests can simulate macOS failures that
 * cannot be produced on Linux. They are parameters rather than environment variables so a
 * deployment cannot set them by accident.
 */
function probeSecret({ workerId } = {}, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'darwin') {
    return { state: STATE.NOT_MACOS, present: false, status: null,
      detail: `not macOS (${platform})`,
      short: `not macOS (${platform})`,
      hint: 'The Keychain is only consulted on macOS. Nothing is wrong here.' };
  }
  if (!workerId) {
    return { state: STATE.UNKNOWN, present: false, status: null,
      detail: 'no worker id was supplied, so nothing could be looked up',
      short: 'no WORKER_ID set',
      hint: 'Set WORKER_ID, or pass the id the LaunchAgent plist carries.' };
  }
  const exec = deps.exec || ((args, opts) => execFileSync('/usr/bin/security', args, opts));
  const account = `${ACCOUNT_LABEL}:${workerId}`;

  const attempt = (args, captureStdout) => {
    try {
      const out = exec(args, { encoding: 'utf8',
        stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'] });
      return { ok: true, out: captureStdout ? out : null };
    } catch (e) {
      return { ok: false, status: e && e.status, stderr: String((e && e.stderr) || '') };
    }
  };

  // Probe 1: metadata only. No -w, so the secret is never in play.
  const meta = attempt(['find-generic-password', '-s', SERVICE, '-a', account], false);

  // Probe 2: the value. Only to learn whether it is READABLE — the string itself is dropped here
  // and never enters the verdict, a message, or a log line.
  const value = attempt(['find-generic-password', '-s', SERVICE, '-a', account, '-w'], true);

  if (value.ok) {
    const len = String(value.out || '').replace(/\n$/, '').length;
    return { state: STATE.READABLE, present: true, status: 0,
      // The LENGTH, never the value. Enough to tell an empty item from a real one.
      detail: `the credential is present and readable (${len} characters)`,
      short: 'readable', hint: null };
  }

  // The value probe failed. Classify on its message; the metadata probe corroborates.
  const stderr = (value.stderr || meta.stderr || '').trim();
  const status = value.status !== undefined ? value.status : meta.status;

  for (const sig of SIGNATURES) {
    if (sig.re.test(stderr) || sig.re.test(String(status))) {
      // A not-found signature on the VALUE probe while the METADATA probe succeeded would be
      // contradictory — the item answered one query and not the other. Report that rather than
      // picking whichever answer came last.
      if (sig.state === STATE.MISSING && meta.ok) {
        return { state: STATE.UNREADABLE, present: true, status, detail: trim(stderr),
          short: 'contradictory: metadata lookup succeeded but the value read did not',
          hint: 'The item answered a metadata lookup but not a value read. Treat it as present and '
            + 'unreadable, not as absent, and do not re-enrol before investigating.' };
      }
      return {
        state: sig.state,
        present: sig.state !== STATE.MISSING,
        status,
        detail: trim(stderr),
        short: sig.short,
        hint: sig.hint,
      };
    }
  }

  // Nothing matched. Say so.
  return {
    state: STATE.UNKNOWN,
    // `null`, not false: we do not know, and false would be read as "absent".
    present: meta.ok ? true : null,
    status,
    detail: trim(stderr) || `the lookup failed with status ${status} and no message`,
    short: `unrecognised keychain failure (status ${status}) — do NOT re-enrol`,
    hint: 'This signature is not recognised, so no conclusion is drawn about whether the credential '
      + 'exists. Do NOT re-enrol on the strength of this. Run the security command by hand and '
      + 'report what it printed.',
  };
}

function trim(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 300); }

/**
 * Back-compatible boolean view. Kept because callers exist, but note what it cannot express:
 * `present` is null when the state is UNKNOWN, so a caller that treats it as a boolean sees
 * "not true" rather than being told "absent".
 */
function hasSecret({ workerId } = {}, deps = {}) {
  const p = probeSecret({ workerId }, deps);
  return { present: p.state === STATE.READABLE ? true : p.present, reason: p.detail, state: p.state };
}

module.exports = {
  SERVICE, ACCOUNT_LABEL, isDarwin, STATE, SIGNATURES,
  readSecret, writeSecret, deleteSecret, hasSecret, probeSecret,
};
