#!/usr/bin/env node
// ── CAN THIS PROCESS SEND EMAIL? ─────────────────────────────────────────────
//
//   node scripts/check-credential-isolation.js                 # in the application
//   node scripts/check-credential-isolation.js --expect sender # in the sender service
//
// Final readiness item 3. Run in BOTH processes. It answers one question about whichever process it
// is running in, and the two answers must differ: the sender service must be able to send, and the
// application must not.
//
// ── WHY CODE ISOLATION IS NOT CREDENTIAL ISOLATION ───────────────────────────
//
// Milestone 6 proved the structural half: exactly one module in the tree imports the send-capable
// Gmail transport, and it is the sender service. That is real and it is asserted on every preflight.
//
// It is not enough on its own. The application still reaches Gmail to READ — inquiry triage, the
// outreach agents' inbox scans — and it does so with the SAME Google identity, asking for a
// narrower scope set. `gmail/client.js` says exactly why that is weaker than it looks:
//
//     "the script never calls send is a property of today's code, while a token that cannot send
//      is a property of the grant."
//
// Asking for `gmail.readonly` is the first kind. The credential in the application's environment
// can mint a `gmail.send` or `gmail.modify` token the moment any code asks for one, and
// `gmail.modify` permits messages.send. So the honest statement today is: the application does not
// send, and could. This script measures which of those two states each process is in, rather than
// letting the stronger claim be made on the weaker evidence.
//
// ── NOTHING SENSITIVE LEAVES THIS SCRIPT ─────────────────────────────────────
//
// Variable NAMES and present/absent only. No value, no fragment of a value, no length, no prefix —
// a length is a fact about a secret, and this is meant to be run in production and pasted into a
// release record.
//
// EXIT 0  this process is in the state the flag says it should be
// EXIT 1  it is not
// EXIT 3  the expectation was not stated, so nothing was judged

'use strict';

const EXIT_NOT_JUDGED = 3;

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const note = (m) => console.log(`        ${m}`);

// ── WHAT CAN MINT A SEND-CAPABLE TOKEN ──────────────────────────────────────
//
// Taken from google-auth.js rather than guessed: serviceAccountCreds reads
// GOOGLE_SERVICE_ACCOUNT_JSON, and the OAuth fallback reads CLIENT_ID + CLIENT_SECRET +
// REFRESH_TOKEN. Either can ask for any delegated scope, so either is a send credential.
const GOOGLE_SA = ['GOOGLE_SERVICE_ACCOUNT_JSON'];
const GOOGLE_OAUTH = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
// Resend sends over HTTP with one key and no scopes at all, so its presence IS send capability.
const RESEND = ['RESEND_API_KEY'];

const present = (name) => !!(process.env[name] && String(process.env[name]).trim());
const allPresent = (names) => names.every(present);

function sendCapability() {
  const paths = [];
  if (allPresent(GOOGLE_SA)) paths.push({ provider: 'gmail', via: 'service account (domain-wide delegation)', vars: GOOGLE_SA });
  if (allPresent(GOOGLE_OAUTH)) paths.push({ provider: 'gmail', via: 'OAuth refresh token', vars: GOOGLE_OAUTH });
  if (allPresent(RESEND)) paths.push({ provider: 'resend', via: 'API key (no scopes — the key IS send capability)', vars: RESEND });
  return paths;
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--expect');
  const expect = i >= 0 ? String(argv[i + 1] || '').toLowerCase() : null;

  console.log('\n══ CREDENTIAL ISOLATION — THIS PROCESS ══\n');
  const deployed = process.env.RAILWAY_GIT_COMMIT_SHA || null;
  const service = process.env.RAILWAY_SERVICE_NAME || process.env.SERVICE_NAME || null;
  note(`service        ${service || '(not reported by the platform)'}`);
  note(`commit         ${deployed ? deployed.slice(0, 12) : '(not set)'}`);
  note(`expectation    ${expect || 'NOT STATED'}`);
  console.log();

  if (!['app', 'application', 'sender'].includes(expect || '')) {
    bad('no expectation was stated, so nothing was judged',
      'run with --expect app in the application, or --expect sender in the sender service. '
      + 'A script that reports capability without saying which capability is CORRECT here invites '
      + 'the reader to supply the conclusion they already had.');
    return EXIT_NOT_JUDGED;
  }
  const wantSend = expect === 'sender';

  // ── 1. WHAT THIS PROCESS COULD MINT ──────────────────────────────────────
  const paths = sendCapability();
  if (!paths.length) {
    note('no send-capable provider credential is present in this environment');
  } else {
    for (const p of paths) {
      note(`CAN SEND via ${p.provider}: ${p.via}  [${p.vars.join(', ')}]`);
    }
  }
  console.log();

  if (wantSend) {
    if (paths.some((p) => p.provider === 'gmail')) {
      ok('the sender service holds a Gmail credential, which is what it is for');
    } else {
      bad('the sender service has NO Gmail credential, so every send will be refused',
        `set one of: ${GOOGLE_SA.join(', ')} or ${GOOGLE_OAUTH.join(' + ')}`);
    }
    if (!present('SENDER_SERVICE_SECRET')) {
      bad('SENDER_SERVICE_SECRET is absent — the service cannot authenticate any caller',
        'start.js refuses to boot without it, so this process should not be running');
    } else {
      ok('SENDER_SERVICE_SECRET is present, so callers can be authenticated');
    }
  } else {
    if (!paths.length) {
      ok('the application holds NO send-capable credential — isolation is complete');
    } else {
      bad(`the application holds ${paths.length} send-capable credential path(s)`,
        'This is the GAP. The application does not send — one module imports the transport and it '
        + 'is the sender service, asserted on every preflight — but it COULD: these credentials '
        + 'mint whatever scope is asked for, and gmail.modify permits messages.send. Isolation is '
        + 'structural today, not credential-level.');
      console.log();
      note('TO CLOSE IT, and it is an owner task because it needs two identities:');
      note('  1. Give the sender service its own Google identity with gmail.send delegated.');
      note('  2. Narrow the application\'s delegation to gmail.readonly ONLY — it reads inboxes');
      note('     (inquiry triage, the outreach agents\' scans) and must keep doing so.');
      note('  3. Move RESEND_API_KEY to the sender service. Nothing in the application needs it');
      note('     once mailer.js dispatches rather than calling Resend itself.');
      note('  4. Re-run this with --expect app. It must then report no send-capable path.');
    }
    if (present('SENDER_SERVICE_URL')) {
      ok('SENDER_SERVICE_URL is set, so outbound mail is routed to the service');
    } else {
      bad('SENDER_SERVICE_URL is NOT set, so every dispatch will be refused',
        'the transport refuses rather than falling back in-process, which is the safe direction '
        + 'but means no mail moves at all');
    }
    if (!present('SENDER_SERVICE_SECRET')) {
      bad('SENDER_SERVICE_SECRET is absent — the application cannot sign a request');
    } else {
      ok('SENDER_SERVICE_SECRET is present, so requests can be signed');
      note('this secret authenticates a REQUEST and sends nothing by itself: every request it '
        + 'signs is still subject to the service\'s own STOP, approval, digest and idempotency '
        + 'checks');
    }
  }

  // ── 2. THE STRUCTURAL HALF, RE-ASSERTED HERE ─────────────────────────────
  //
  // Cheap, and it belongs in the same report: an operator reading this wants both halves in one
  // place, and the structural half is the one that currently holds.
  console.log();
  try {
    const LEX = require('./js-lex');
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..');
    const walk = (dir, out = []) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'test-fixtures'].includes(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.name.endsWith('.js')) out.push(path.relative(root, full));
      }
      return out;
    };
    const importers = walk(root).filter((rel) => {
      if (rel === 'src/lib/outbound/transports/gmail.js' || rel.endsWith('.test.js')) return false;
      const code = LEX.blankCommentsOnly(fs.readFileSync(path.join(root, rel), 'utf8'));
      return /require\(\s*['"`][^'"`]*transports\/gmail['"`]\s*\)/.test(code);
    });
    if (importers.length === 1 && importers[0] === 'src/services/sender/server.js') {
      ok('exactly one module imports the send-capable transport, and it is the sender service');
    } else {
      bad(`the send-capable transport is imported by: ${importers.join(', ') || '(nothing)'}`,
        importers.length === 0
          ? 'not even the service imports it, so nothing can send at all'
          : 'the credential is reachable from the application process');
    }
  } catch (e) {
    note(`the structural check could not run here (${e.message})`);
  }

  return fail ? 1 : 0;
}

const code = main();
console.log();
if (code === EXIT_NOT_JUDGED) console.log('NOT JUDGED  state the expectation and run it again.');
else if (code) console.log('FAIL  this process is not in the state it should be in.');
else console.log('PASS  this process is in the state it should be in. Nothing was written.');
process.exit(code);
