#!/usr/bin/env node
// ── PROVE THE OLD CREDENTIALS ARE DEAD ───────────────────────────────────────
//
//   railway ssh 'node scripts/verify-rotation.js'            # what is set, and its fingerprint
//   node scripts/verify-rotation.js --old=/tmp/old-creds.json
//
// Exit 0 = every credential checked has changed. Exit 1 = at least one is still the leaked value.
//
// ── WHY A SCRIPT AND NOT A CHECKLIST ─────────────────────────────────────────
//
// "Rotate the credentials" has been agreed several times and the old values are still live. The
// gap between intending to rotate and having rotated is invisible from the outside, and a
// documentation edit looks identical to a real rotation — the CEO brief says exactly that: "do
// not merely replace values in documentation."
//
// So this measures it. It compares what the running process actually holds against the values
// that leaked, and reports PASS or FAIL per credential.
//
// ── HOW IT AVOIDS EXPOSING ANYTHING ──────────────────────────────────────────
//
// Nothing secret is printed, ever. For each credential it prints a NAME, whether it is SET, and a
// 12-hex SHA-256 fingerprint — enough to tell two values apart, not enough to recover one.
//
// The old values are never passed on the command line and never put in an environment variable,
// because both end up in shell history, in `ps`, and in Railway's log of the command. They are
// read from a JSON file you create, which the script tells you to delete when it finishes.
//
// The file shape (every key optional — only what you supply is checked):
//
//   {
//     "DATABASE_URL":              "<the old one>",
//     "ADMIN_PASSWORD":            "<the old one>",
//     "TRIGGERS_SECRET":           "<the old one>",
//     "PLAYBOOKOS_WEBHOOK_SECRET": "<the old one>",
//     "ENGAGEMENT_SECRET":         "<the old one>",
//     "ANTHROPIC_API_KEY":         "<the old one>",
//     "RESEND_API_KEY":            "<the old one>"
//   }
//
// The GitHub PAT is not in this list because the server does not hold it. Verify that one
// directly — the runbook at the bottom of this file says how, and the check is a single HTTP
// status with no secret in the output.
'use strict';

const fs = require('fs');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const OLD_FILE = arg('old', '');

const say = (s = '') => console.log(s);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

/** A fingerprint, not a hash anyone can attack back to the value in a useful way. */
const fp = (v) => (v ? crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 12) : '—');

// The secrets this process is expected to hold. Names only — this list is safe to commit.
const EXPECTED = [
  ['DATABASE_URL', true],
  ['JWT_SECRET', true],
  ['ANTHROPIC_API_KEY', true],
  ['RESEND_API_KEY', true],
  ['TRIGGERS_SECRET', false],
  ['PLAYBOOKOS_WEBHOOK_SECRET', false],
  ['ENGAGEMENT_SECRET', false],
  ['STRIPE_SECRET_KEY', false],
  ['STRIPE_WEBHOOK_SECRET', false],
  ['GOOGLE_CLIENT_SECRET', false],
  ['GOOGLE_REFRESH_TOKEN', false],
  ['GOOGLE_SERVICE_ACCOUNT_JSON', false],
  ['ALGOLIA_API_KEY', false],
  ['APOLLO_API_KEY', false],
  ['LINKEDIN_ACCESS_TOKEN', false],
  ['TWILIO_AUTH_TOKEN', false],
  ['OPENAI_API_KEY', false],
  ['ADMIN_PASSWORD', false],
];

let fail = 0;
let checked = 0;

function main() {
  say('\n── credential rotation check');
  say('   Fingerprints only. No secret value is printed by this script, at any verbosity.\n');

  let old = null;
  if (OLD_FILE) {
    try {
      old = JSON.parse(fs.readFileSync(OLD_FILE, 'utf8'));
    } catch (e) {
      say(`   ✗ could not read ${OLD_FILE}: ${e.message}`);
      process.exit(2);
    }
  }

  say(`   ${pad('credential', 32)}${pad('set', 6)}${pad('fingerprint', 15)}verdict`);
  say(`   ${'─'.repeat(78)}`);

  for (const [name, required] of EXPECTED) {
    const now = process.env[name];
    const isSet = !!(now && String(now).trim());
    let verdict = '';

    if (!isSet) {
      verdict = required ? '⚠ REQUIRED AND UNSET' : 'not set';
      if (required) fail += 1;
    } else if (old && Object.prototype.hasOwnProperty.call(old, name)) {
      checked += 1;
      if (fp(now) === fp(old[name])) {
        verdict = '✗ STILL THE LEAKED VALUE';
        fail += 1;
      } else {
        verdict = '✓ rotated';
      }
    } else {
      verdict = old ? 'no old value supplied' : '(supply --old= to compare)';
    }

    say(`   ${pad(name, 32)}${pad(isSet ? 'yes' : 'no', 6)}${pad(fp(now), 15)}${verdict}`);
  }

  // ── THE ONE THING A FINGERPRINT CANNOT TELL YOU ────
  // A rotated value proves the SERVER changed. It does not prove the OLD one was revoked at the
  // provider — a GitHub token that was replaced here but never deleted there is still a live
  // credential in a document somebody has.
  say('\n   ══ WHAT THIS DOES AND DOES NOT PROVE ═══════════════════════════════');
  say('   PROVES:        this process now holds a different value than the one that leaked.');
  say('   DOES NOT PROVE: the old value was revoked at the provider. A token replaced here and');
  say('                   left active at GitHub is still a live credential in a shared document.');
  say('                   Revoke at the source, then confirm with the checks below.\n');

  if (OLD_FILE) {
    say(`   ⚠ DELETE ${OLD_FILE} NOW — it contains the leaked values in cleartext.`);
    say(`     rm -P ${OLD_FILE}      (or: shred -u ${OLD_FILE})\n`);
  }

  say('   ══ VERIFY AT THE SOURCE — run these yourself ═══════════════════════');
  say('   GitHub PAT (expect 401):');
  say('      curl -s -o /dev/null -w \'%{http_code}\\n\' -H "Authorization: token $OLD_PAT" \\');
  say('        https://api.github.com/user');
  say('      …then: unset OLD_PAT; history -d $((HISTCMD-2))');
  say('');
  say('   Admin password (expect anything but 200):');
  say('      curl -s -o /dev/null -w \'%{http_code}\\n\' -X POST \\');
  say('        https://app.playnexa.ai/api/auth/login -H "Content-Type: application/json" \\');
  say('        -d \'{"email":"naren@abiozen.com","password":"<THE OLD ONE>"}\'');
  say('');
  say('   Postgres: rotating the password in Railway invalidates the old DSN by construction.');
  say('   Webhook secrets: a changed fingerprint above is the evidence; do not fire the endpoints');
  say('   to test them — /api/triggers/check EXECUTES the triggers when the secret is accepted.\n');

  if (fail) {
    say(`✗ FAIL — ${fail} credential(s) are unrotated or missing. Rotation is NOT complete.\n`);
    process.exit(1);
  }
  if (!OLD_FILE) {
    say('ℹ Inventory only. Re-run with --old=<file> to prove the values changed.\n');
    process.exit(0);
  }
  say(`✓ PASS — ${checked} credential(s) compared, all differ from the leaked values.\n`);
}

main();
