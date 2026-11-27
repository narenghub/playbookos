#!/usr/bin/env node
// ── ENROL A WORKER WITHOUT PUTTING THE SECRET IN A TRANSCRIPT ───────────────
//
//   node scripts/enroll-worker-no-transcript.js \
//     --label m7-dev-cloud-worker \
//     --api https://<m7-dev api>/ \
//     --out /tmp/worker-secret.txt
//
// Owner's Priority 1 of 2026-11-25:
//
//   *"Do not print enrollment tokens or worker secrets in terminal transcripts, logs,
//    documentation or chat."*
//
// ── WHY THIS SCRIPT EXISTS: I BROKE THAT RULE IN A DOCUMENT I DELIVERED ────
//
// The first version of docs/office/b4-2-cloud-worker-owner-checklist.md told the owner to run a
// `railway ssh … console.log(t.token)` and then a `curl` whose response was shown inline as
// `{"ok":true,"workerId":"wkr_…","secret":"…"}`. Both put a live credential into a terminal
// transcript — the one place the instruction names first — and a transcript is scrolled back
// through, copied into chat, and kept in shell history.
//
// Nothing about that was subtle. A credential that only has to pass from a server to a container
// should never be rendered to a human at all, and writing the procedure that way made the human
// the transport.
//
// ── WHAT THIS DOES INSTEAD ─────────────────────────────────────────────────
//
//   • mints the enrolment token in-process and never prints it;
//   • exchanges it for an identity over HTTPS and never prints the secret;
//   • writes ONLY the secret to a file created with mode 0600, which the operator pastes into the
//     Railway variable field (a masked input, not a transcript) and then deletes;
//   • prints the worker id — not a secret, and the thing the operator must configure — and a
//     SHA-256 fingerprint PREFIX of the secret, so they can confirm the right value landed in
//     Railway without ever seeing the value.
//
// A fingerprint prefix is not a secret: it is 12 hex characters of a hash of a 32-byte random
// value, which identifies the credential for comparison and reconstructs none of it.
//
// ── IT REFUSES TO RUN AGAINST PRODUCTION ───────────────────────────────────
//
// `--api` must not be a production host and `PLAYNEXA_WORKER_ENV` must be development. Enrolment
// mints a credential; doing it against production from a development script is the kind of
// mistake that is obvious afterwards and invisible at the time.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const label = arg('label');
const api = arg('api');
const out = arg('out');
const capabilities = (arg('capabilities', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

const die = (msg, code = 2) => { console.error(`REFUSED  ${msg}`); process.exit(code); };

// ── WHO IS MINTING THIS, AND THE REASON IT IS NOW REQUIRED ──────────────────
//
// Owner's fifth directive: *"Verify the enrollment script's prerequisites, database access
// requirements, authentication and secure secret handling."* Verifying that found a gap:
// `createEnrollmentToken` takes `createdBy` and defaulted it to `null`, and this script never
// passed one. **So the mint was authenticated by possession of the development DATABASE_URL and by
// nothing else, and the token row recorded no operator at all.** A credential that lets a container
// act inside the platform was being created by nobody.
//
// `--operator` is now required and is CHECKED rather than recorded: it must name an existing,
// active, non-external administrator in `users`. That is the same rule
// `identity/company-membership.js assertActorMayManage` applies before changing who may see a
// company's data, and for the same reason — an unverified actor string is a label, not an
// authorization. Enrolling a worker is no smaller an act.
const operator = arg('operator');

if (!label || !api || !out || !operator) {
  die('usage: --label <name> --api <https url> --out <file path> --operator <email>\n'
    + '              [--capabilities a,b]\n'
    + '         --operator must be an active internal administrator; the mint is recorded against\n'
    + '         them, and an enrolment nobody authorized is what this requirement removes.\n'
    + '         the secret is written ONLY to --out, with mode 0600, and never printed');
}

// ── THE PRODUCTION GUARDS ───────────────────────────────────────────────────
if (!/^https:\/\//.test(api) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(api)) {
  die(`--api must be https:// (loopback http is allowed for tests). Got ${api}`);
}
if (/playbookos-production|playbook\.abiozen\.com/.test(api)) {
  die('that is the PRODUCTION api. This script enrols development workers only, and enrolling '
    + 'against production from a development tool is the mistake that is obvious afterwards and '
    + 'invisible at the time');
}
if (String(process.env.PLAYNEXA_WORKER_ENV) !== 'development') {
  die("PLAYNEXA_WORKER_ENV must be 'development' to run this. Enrolment mints a credential");
}
// `exec:hardware` and `exec:gui` are refused outright: the owner's §3 forbids granting either to
// the cloud pilot, and B4.4c means `exec:gui` must not be granted to anything yet.
for (const c of capabilities) {
  if (c === 'exec:hardware' || c === 'exec:gui') {
    die(`refusing to grant ${c}: the cloud pilot is restricted to approved synthetic capabilities, `
      + 'and exec:gui is blocked for every identity until B4.4c is implemented and verified');
  }
}

(async () => {
  const IDENTITY = require('../src/lib/worker/identity');

  // 0. THE OPERATOR, RESOLVED AND CHECKED BEFORE ANYTHING IS MINTED.
  //
  // Refusals here cost nothing; a refusal after the mint would leave a spent token and an audit row
  // naming an operator who was never verified. The external-role check matters as much as the
  // active one: a partner is a real, active user and is not an administrator of this platform.
  let operatorId;
  try {
    const { query } = require('../src/lib/db');
    const { isExternalRole } = require('../src/lib/roles');
    const r = await query(
      'SELECT id, email, role, is_active FROM users WHERE lower(email) = lower($1)', [operator]);
    const u = r.rows[0];
    if (!u) die(`--operator ${operator} is not a user of this platform`);
    if (!u.is_active) die(`--operator ${operator} is a deactivated account`);
    if (isExternalRole(u.role)) {
      die(`--operator ${operator} holds the external role "${u.role}" and is not an internal `
        + 'administrator');
    }
    if (!['super_admin', 'admin'].includes(String(u.role))) {
      die(`--operator ${operator} holds the role "${u.role}". Minting a worker credential is an `
        + 'administrative act, so it requires admin or super_admin');
    }
    operatorId = u.id;
  } catch (e) {
    if (e && e.code === 'ERR_DIE') throw e;
    die(`the operator could not be verified (${e.message}). Refusing rather than minting a `
      + 'credential attributed to nobody — this needs the development DATABASE_URL, which is also '
      + 'what the mint itself needs');
  }

  // 1. MINT. In-process, and the token is never written anywhere but this variable.
  let token;
  try {
    // `syntheticOnly` is left at its default of TRUE and is deliberately NOT exposed as a flag:
    // this script exists to enrol the development cloud worker, which must be restricted, and a
    // `--unrestricted` option would be the one thing somebody copies from a runbook without
    // reading. Widening a fixture identity is done in a check, against a disposable cluster.
    const t = await IDENTITY.createEnrollmentToken({ label, capabilities, createdBy: operatorId });
    token = t && t.token;
    if (!token) die('the server did not return an enrolment token');
  } catch (e) {
    die(`could not mint an enrolment token: ${e.message}`);
  }

  // 2. EXCHANGE. Over the API, exactly as the container would.
  let res;
  try {
    const r = await fetch(`${api.replace(/\/+$/, '')}/api/worker/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, hostFingerprint: `railway-${label}` }),
    });
    res = await r.json();
  } catch (e) {
    die(`the enrolment request failed: ${e.message}. The token is now spent — mint a new one`);
  }
  if (!res || res.ok !== true || !res.workerId || !res.secret) {
    // The response may carry a code but never the secret, so it is safe to show.
    die(`enrolment refused: ${res && res.code ? res.code : 'no identity returned'}`
      + `${res && res.detail ? ` — ${res.detail}` : ''}`);
  }

  // 3. WRITE. Mode 0600, created exclusively so an existing file is never silently overwritten.
  const abs = path.resolve(out);
  try {
    fs.writeFileSync(abs, `${res.secret}\n`, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') {
      die(`${abs} already exists. Refusing to overwrite it — the identity is now enrolled and its `
        + 'secret is lost, so revoke this worker and enrol again with a fresh --out path', 3);
    }
    die(`could not write the secret file: ${e.message}`, 3);
  }

  // 4. REPORT. The worker id, which is configuration, and a fingerprint, which is not a secret.
  const fingerprint = crypto.createHash('sha256').update(res.secret).digest('hex').slice(0, 12);
  const caps = Array.isArray(res.capabilities) ? res.capabilities : capabilities;

  console.log('');
  console.log('  ENROLLED. The secret was NOT printed and is NOT in this transcript.');
  console.log('');
  console.log(`    WORKER_ID             ${res.workerId}`);
  console.log(`    capabilities          ${caps.length ? caps.join(', ') : '(none)'}`);
  console.log(`    secret fingerprint    sha256:${fingerprint}…  (12 hex of a hash — not a secret)`);
  console.log(`    secret file           ${abs}   (mode 0600)`);
  console.log('');
  console.log('  NEXT, without the value passing through a shell or a transcript:');
  console.log('    1. open the Railway service → Variables;');
  console.log('    2. paste the file contents into PLAYNEXA_DEV_WORKER_SECRET (a masked field);');
  console.log(`    3. set WORKER_ID to ${res.workerId};`);
  console.log('    4. shred the file:  shred -u ' + abs + '   (or rm -P on macOS)');
  console.log('');
  console.log('  To confirm the right value landed, run --doctor on the DEPLOYED container and');
  console.log('  compare its reported secretFingerprint to the one above. Neither prints a secret.');
  console.log('');
  process.exit(0);
})().catch((e) => {
  console.error(`FAIL  ${e.stack || e.message}`);
  process.exit(1);
});
