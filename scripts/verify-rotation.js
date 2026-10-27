#!/usr/bin/env node
// ── PROVE THE CREDENTIALS CHANGED, WITHOUT HANDLING EITHER VALUE ─────────────
//
//   BEFORE rotating, on the server:
//     railway ssh 'node scripts/verify-rotation.js --snapshot=/tmp/fp.json'
//
//   AFTER rotating and redeploying:
//     railway ssh 'node scripts/verify-rotation.js --compare=/tmp/fp.json'
//     railway ssh 'node scripts/verify-rotation.js --health'
//
// Exit 0 = every credential expected to rotate did. Exit 1 = at least one did not.
//
// ── WHY THE SNAPSHOT, AND NOT A FILE OF OLD SECRETS ──────────────────────────
//
// The first version of this script took the leaked values in a JSON file and printed a
// fingerprint column. Two problems, and the second was mine.
//
// It required somebody to assemble the live leaked secrets into a file on disk — the exact
// material we are trying to retire — in order to prove they were retired.
//
// And it PRINTED fingerprints. A 12-hex prefix of SHA-256 is not a secret, but it is an oracle:
// given a candidate, it confirms a guess offline. For a human-chosen admin password against a
// wordlist, that is a real weakening, and the output went into a chat transcript.
//
// So this never takes a secret as input and never emits anything derived from one. It records
// fingerprints into a file the server writes and reads itself, and the only thing printed is
// CHANGED or unchanged per name. The fingerprints exist solely to be compared with each other.
//
// ── WHAT A CHANGED FINGERPRINT PROVES, AND WHAT IT DOES NOT ──────────────────
//
// Proves: this process now holds a different value than it held before.
// Does not prove: the old value was revoked at the provider. A GitHub token replaced here and
// left active at GitHub is still a live credential in whatever document carried it. Revocation
// is checked at the source; --health prints how.
'use strict';

const fs = require('fs');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};

const SNAPSHOT = arg('snapshot', '');
const COMPARE = arg('compare', '');
const HEALTH = has('health');

// ── REFUSE WHAT YOU DO NOT UNDERSTAND ────────────────────────────────────────
// On 27 Oct this script's predecessor was asked for --snapshot= twice. It did not have that flag,
// so argv matched nothing, it fell through to its default mode, and printed a confident fifty-line
// report answering a question nobody asked — while writing no snapshot file. The deploy carrying
// this version had not landed, and nothing in the output said so.
//
// Two guards, because the flag guard alone would not have caught it: the OLD binary is the one that
// ran, and no edit here can fix a file that is not deployed. So every mode also announces the commit
// it is running from. A stale deploy is then visible in the first line of output rather than inferred
// afterwards from /health.
const KNOWN = ['snapshot', 'compare', 'health'];
const unknown = argv.filter((a) => a.startsWith('--')
  && !KNOWN.includes(a.replace(/^--/, '').split('=')[0]));
if (unknown.length) {
  console.error(`verify-rotation: unrecognised argument(s): ${unknown.join(' ')}`);
  console.error(`  known flags: ${KNOWN.map((k) => `--${k}`).join('  ')}`);
  console.error('  If you expected one of these to work, the deployed copy of this script is older');
  console.error('  than the one you are reading. Check /health for the commit, then redeploy.');
  process.exit(2);
}

const COMMIT = String(process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'unknown';
const modeCount = [SNAPSHOT, COMPARE, HEALTH].filter(Boolean).length;
if (modeCount > 1) {
  console.error('verify-rotation: pick one of --snapshot= / --compare= / --health, not several.');
  process.exit(2);
}

const say = (s = '') => console.log(s);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

// Salted so the stored file is not a rainbow-table oracle on its own. The salt is random per
// snapshot and lives in the same file, which is fine: its only job is to make the digests
// meaningless to anyone who does not also hold the file, and the file is deleted after use.
const fp = (v, salt) => crypto.createHash('sha256').update(`${salt}\u0000${String(v)}`).digest('hex');

// Names only. Safe to commit, and the point of the list is that it is reviewable.
const CREDENTIALS = [
  // [name, requiredInProduction, expectedToRotateInThisRound]
  ['DATABASE_URL', true, true],
  ['ADMIN_PASSWORD', false, true],
  ['TRIGGERS_SECRET', false, true],
  ['PLAYBOOKOS_WEBHOOK_SECRET', false, true],
  ['ENGAGEMENT_SECRET', false, true],
  ['JWT_SECRET', true, false],
  ['ANTHROPIC_API_KEY', true, false],
  ['RESEND_API_KEY', true, false],
  ['STRIPE_SECRET_KEY', false, false],
  ['STRIPE_WEBHOOK_SECRET', false, false],
  ['GOOGLE_CLIENT_SECRET', false, false],
  ['GOOGLE_REFRESH_TOKEN', false, false],
  ['GOOGLE_SERVICE_ACCOUNT_JSON', false, false],
  ['ALGOLIA_API_KEY', false, false],
  ['APOLLO_API_KEY', false, false],
  ['LINKEDIN_ACCESS_TOKEN', false, false],
  ['TWILIO_AUTH_TOKEN', false, false],
  ['OPENAI_API_KEY', false, false],
];

function snapshot() {
  const salt = crypto.randomBytes(16).toString('hex');
  const out = { takenAt: new Date().toISOString(), salt, fingerprints: {} };
  let set = 0;
  for (const [name] of CREDENTIALS) {
    const v = process.env[name];
    if (v && String(v).trim()) { out.fingerprints[name] = fp(v, salt); set += 1; }
  }
  fs.writeFileSync(SNAPSHOT, JSON.stringify(out), { mode: 0o600 });
  say(`\n   ✓ recorded ${set} credential fingerprint(s) → ${SNAPSHOT}`);
  say('     No secret and no fingerprint is printed. The file is readable only by this user.');
  say('\n   Now rotate, redeploy, then:');
  say(`     railway ssh 'node scripts/verify-rotation.js --compare=${SNAPSHOT}'`);
  say(`\n   Delete the snapshot when you are done:  rm -P ${SNAPSHOT}\n`);
}

function compare() {
  let before;
  try { before = JSON.parse(fs.readFileSync(COMPARE, 'utf8')); } catch (e) {
    say(`   ✗ could not read ${COMPARE}: ${e.message}`);
    say('     Take a snapshot BEFORE rotating — there is nothing to compare against otherwise.');
    process.exit(2);
  }
  if (!before.salt || !before.fingerprints) {
    say(`   ✗ ${COMPARE} is not a snapshot from this script.`);
    process.exit(2);
  }

  say(`\n── rotation check · against a snapshot taken ${before.takenAt}\n`);
  say(`   ${pad('credential', 32)}${pad('expected', 12)}result`);
  say(`   ${'─'.repeat(70)}`);

  let fail = 0;
  for (const [name, required, shouldRotate] of CREDENTIALS) {
    const now = process.env[name];
    const was = before.fingerprints[name];
    let result;

    if (!now || !String(now).trim()) {
      result = required ? '✗ REQUIRED AND NOW UNSET' : 'not set';
      if (required) fail += 1;
    } else if (!was) {
      result = 'newly set (not in snapshot)';
    } else if (fp(now, before.salt) === was) {
      result = shouldRotate ? '✗ UNCHANGED — not rotated' : 'unchanged';
      if (shouldRotate) fail += 1;
    } else {
      result = shouldRotate ? '✓ CHANGED' : '✓ changed (not required, fine)';
    }
    say(`   ${pad(name, 32)}${pad(shouldRotate ? 'rotate' : '—', 12)}${result}`);
  }

  say('\n   Nothing above is derived from a secret value. "CHANGED" means the digest differs');
  say('   from the one in the snapshot; neither digest is printed.\n');

  if (fail) {
    say(`✗ FAIL — ${fail} credential(s) did not rotate or are missing.`);
    say('  If you rotated in Railway but this still says UNCHANGED: the running process captured');
    say('  its environment at launch. Redeploy, then run this again.\n');
    process.exit(1);
  }
  say('✓ PASS — every credential marked for rotation now holds a different value.');
  say(`  Delete the snapshot: rm -P ${COMPARE}\n`);
}

async function health() {
  const base = process.env.APP_URL || 'https://app.playnexa.ai';
  say('\n── post-rotation health\n');
  let fail = 0;
  const ok = (m) => say(`  ok    ${m}`);
  const bad = (m) => { fail += 1; say(`  FAIL  ${m}`); };

  // 1. The database. A rotated DSN that does not connect is the failure mode that matters most,
  //    and it shows up here rather than at 09:10 tomorrow.
  try {
    const { query } = require('../src/lib/db');
    const r = await query('SELECT 1 AS n');
    if (r.rows[0].n === 1) ok('database connects and answers with the rotated credential');
    else bad('database returned something unexpected');
  } catch (e) { bad(`database did not connect: ${e.message}`); }

  // 2. The application, not just the server.
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(15000) });
    const j = await res.json();
    if (res.status === 200 && j.db === 'connected') ok(`/health 200, db connected, commit ${String(j.commit).slice(0, 7)}`);
    else bad(`/health returned ${res.status} db=${j && j.db}`);
  } catch (e) { bad(`/health unreachable: ${e.message}`); }

  try {
    const res = await fetch(`${base}/api/auth/me`, { signal: AbortSignal.timeout(15000) });
    if (res.status === 401) ok('/api/auth/me refuses anonymous access');
    else bad(`/api/auth/me returned ${res.status}, expected 401`);
  } catch (e) { bad(`/api/auth/me unreachable: ${e.message}`); }

  // 3. Webhook authentication is still ENFORCED.
  //    Deliberately tested with a WRONG secret, never a right one: /api/triggers/check EXECUTES
  //    the milestone triggers when the secret is accepted, so a "does the new secret work" test
  //    would fire real side effects to prove a configuration detail. A rejection proves the guard
  //    is active; the --compare run above proves the value changed. Together that is sufficient.
  for (const [path, label] of [['/api/triggers/check', 'TRIGGERS_SECRET'],
    ['/api/customers/engagement-event', 'ENGAGEMENT_SECRET']]) {
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': 'deliberately-wrong' },
        body: JSON.stringify({ probe: true }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 401 || res.status === 403) ok(`${label}: a wrong secret is refused (${res.status})`);
      else if (res.status === 503) bad(`${label}: endpoint reports the secret is UNSET (503)`);
      else bad(`${label}: a wrong secret returned ${res.status} — expected 401/403`);
    } catch (e) { bad(`${label}: ${path} unreachable: ${e.message}`); }
  }

  say('\n   ══ STILL YOURS TO CHECK AT THE SOURCE ═════════════════════════════');
  say('   Nothing here can prove the OLD GitHub token was revoked — only that this server no');
  say('   longer uses it. Run this on your own machine, then clear it from history:');
  say('');
  say('      curl -s -o /dev/null -w \'%{http_code}\\n\' \\');
  say('        -H "Authorization: token $OLD_PAT" https://api.github.com/user     # expect 401');
  say('      unset OLD_PAT');
  say('');
  say('   And confirm the old admin password no longer authenticates:');
  say(`      curl -s -o /dev/null -w '%{http_code}\\n' -X POST ${base}/api/auth/login \\`);
  say('        -H "Content-Type: application/json" -d \'{"email":"…","password":"<old>"}\'  # not 200');
  say('');

  if (fail) { say(`✗ FAIL — ${fail} check(s) failed. Production is not verified healthy.\n`); process.exit(1); }
  say('✓ PASS — database, application and webhook authentication all healthy after rotation.\n');
}

async function main() {
  // First line of every run. If this is not the commit you just pushed, nothing below is the code
  // you think you are running, and the rest of the output is about a different program.
  say(`\n   [verify-rotation · running from commit ${COMMIT}]`);

  if (SNAPSHOT) return snapshot();
  if (COMPARE) return compare();
  if (HEALTH) return health();

  // Default: an inventory of what is SET. No fingerprints, because the first version printed them
  // and that output is now in a chat transcript.
  say('\n── credential inventory · names and set/unset only\n');
  let missing = 0;
  for (const [name, required, shouldRotate] of CREDENTIALS) {
    const isSet = !!(process.env[name] && String(process.env[name]).trim());
    if (required && !isSet) missing += 1;
    say(`   ${pad(name, 32)}${pad(isSet ? 'set' : 'NOT SET', 10)}${shouldRotate ? 'to rotate' : ''}`);
  }
  say('\n   No fingerprints are printed here. To prove rotation:');
  say('     1. before:  --snapshot=/tmp/fp.json');
  say('     2. rotate in Railway, redeploy');
  say('     3. after:   --compare=/tmp/fp.json   then   --health');
  say(`     4. rm -P /tmp/fp.json\n`);
  if (missing) { say(`✗ ${missing} required credential(s) unset.\n`); process.exit(1); }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('verify-rotation failed:', e && e.message ? e.message : e);
  process.exit(1);
});
