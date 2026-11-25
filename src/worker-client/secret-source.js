// ── WHERE A WORKER'S SECRET COMES FROM, PER PLATFORM ────────────────────────
//
//   const src = resolveSecretSource({ workerId });
//   if (!src.usable) refuse(src.reason);
//   const secret = src.read();          // never logged, never returned by doctor()
//
// B4.2 (owner's Priority 1, 2026-11-25) needs a worker running in a Linux container on Railway.
// The existing credential path is `keychain.js`, which is macOS-only and says so:
//
//     `${op} requires macOS Keychain and this is ${process.platform}. There is deliberately no
//      file-based fallback: pass the secret explicitly in tests instead.`
//
// and, about `deps.secret`:
//
//     "It is a parameter rather than an environment variable so that it cannot be set accidentally
//      by a deployment."
//
// ── THE REASON BEHIND THAT RULE IS SOUND, SO THIS DOES NOT BYPASS IT ───────
//
// The hazard the rule guards against is a secret arriving through ambient deployment
// configuration, where nobody decided it should. In a container there is no Keychain and no
// alternative: the platform's environment IS its secret store. So the question is not whether to
// read an environment variable but how to make reading one a DECISION rather than an accident.
//
// Four conditions, all required, none inferable from a single misconfiguration:
//
//   1. the platform is not macOS — on macOS the Keychain is used and this path is refused, so a
//      Mac cannot silently fall back to a weaker source;
//   2. `PLAYNEXA_WORKER_ENV` is exactly 'development' — the same gate the crash-test arming uses;
//   3. the secret arrives in `PLAYNEXA_DEV_WORKER_SECRET`, a name that exists for nothing else, so
//      a generic `WORKER_SECRET` left over from some other tool does not become a credential;
//   4. `WORKER_ID` is of the enrolled shape, so a half-configured service refuses rather than
//      attempting to authenticate as nothing.
//
// Any one missing is a refusal with the reason, not a fallback.
//
// ── THIS IS A WEAKENING, AND SAYING SO IS PART OF THE DESIGN ───────────────
//
// An environment variable is weaker than the Keychain. It is visible to anything that can read the
// process environment, it appears in a platform dashboard, and it survives in deployment history.
// The Keychain's protections — per-item ACLs, an OS prompt, no plaintext at rest — have no
// equivalent here.
//
// That is acceptable for a DEVELOPMENT worker holding a development identity that can execute only
// cloud-eligible synthetic work, and it is not acceptable for a production one. Condition 2 is
// what keeps those apart, and `check-worker-secret-source.js` asserts that a production
// environment is refused rather than trusting this paragraph.

'use strict';

const KEYCHAIN = require('./keychain');

const DEV_SECRET_VAR = 'PLAYNEXA_DEV_WORKER_SECRET';
const ENV_VAR = 'PLAYNEXA_WORKER_ENV';
const DEVELOPMENT = 'development';

const SOURCE = Object.freeze({
  KEYCHAIN: 'macos-keychain',
  DEV_ENV: 'development-environment-variable',
  NONE: 'none',
});

/**
 * Which credential source applies here, and may it be used?
 *
 * @returns {{usable:boolean, source:string, reason:string, read?:function}}
 *
 * `read` is a function rather than a value so that nothing holds the secret until it is needed,
 * and so that a caller logging this object cannot log the credential.
 */
function resolveSecretSource({ workerId } = {}, deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;

  if (!workerId || !/^wkr_[0-9a-f]{32}$/.test(String(workerId))) {
    return { usable: false, source: SOURCE.NONE,
      reason: 'WORKER_ID is missing or not of the enrolled shape, so there is no identity to read '
        + 'a secret for. A half-configured worker refuses rather than authenticating as nothing' };
  }

  // ── macOS: THE KEYCHAIN, AND NOTHING ELSE ───────────────────────────────
  //
  // Checked FIRST so a Mac can never reach the environment path. If a developer sets the
  // development variable on their laptop, it is ignored rather than silently preferred — the
  // weaker source must not be reachable where the stronger one exists.
  if (platform === 'darwin') {
    const probe = (deps.keychain || KEYCHAIN).probeSecret({ workerId }, deps);
    if (probe.state === (deps.keychain || KEYCHAIN).STATE.READABLE) {
      return { usable: true, source: SOURCE.KEYCHAIN, reason: 'macOS Keychain',
        read: () => (deps.keychain || KEYCHAIN).readSecret({ workerId }) };
    }
    return { usable: false, source: SOURCE.KEYCHAIN,
      reason: `the Keychain credential is not readable (${probe.state}). On macOS there is no `
        + 'other source: the development environment variable is deliberately ignored here, '
        + 'because a weaker credential path must not be reachable where the Keychain exists' };
  }

  // ── EVERYWHERE ELSE: DEVELOPMENT ONLY, BY AN EXPLICIT NAME ──────────────
  const declared = String(env[ENV_VAR] || '');
  if (declared !== DEVELOPMENT) {
    return { usable: false, source: SOURCE.NONE,
      reason: `${ENV_VAR} is ${JSON.stringify(declared || '(unset)')}, not '${DEVELOPMENT}'. A `
        + 'secret in an environment variable is weaker than the Keychain — visible to anything '
        + 'that can read the process environment, shown in a platform dashboard, and kept in '
        + 'deployment history — so it is permitted only for a development identity that can '
        + 'execute cloud-eligible synthetic work and nothing else' };
  }

  const secret = env[DEV_SECRET_VAR];
  if (!secret || !String(secret).trim()) {
    return { usable: false, source: SOURCE.DEV_ENV,
      reason: `${DEV_SECRET_VAR} is not set. It is deliberately NOT named WORKER_SECRET: a `
        + 'generic name invites an unrelated value from some other tool becoming this worker\'s '
        + 'credential, which is the accident the Keychain rule exists to prevent' };
  }

  return { usable: true, source: SOURCE.DEV_ENV,
    reason: `${DEV_SECRET_VAR} (development only — weaker than the Keychain, see this module's `
      + 'header)',
    read: () => String(env[DEV_SECRET_VAR]) };
}

/**
 * A one-line description for `--doctor`, carrying NO part of the secret.
 *
 * doctor() reports readiness and must never expose the credential; this returns the source and
 * whether it is usable, which is the whole of what a reader needs.
 */
function describeSecretSource({ workerId } = {}, deps = {}) {
  const r = resolveSecretSource({ workerId }, deps);
  return { usable: r.usable, source: r.source, reason: r.reason };
}

module.exports = {
  resolveSecretSource, describeSecretSource,
  SOURCE, DEV_SECRET_VAR, ENV_VAR, DEVELOPMENT,
};
