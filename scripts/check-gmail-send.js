#!/usr/bin/env node
// ── CAN WE SEND AS naren@abiozen.com THROUGH GOOGLE WORKSPACE? ────────────────
//
//   railway ssh 'node scripts/check-gmail-send.js'
//   railway ssh 'node scripts/check-gmail-send.js --as=sales@abiozen.com'
//
// READ ONLY. Mints a token, asks Gmail who it is, and reads the mailbox profile. **It sends
// nothing** — there is no draft, no test message, no email to anybody.
//
// ── WHY THIS COMES FIRST ─────────────────────────────────────────────────────
//
// The warm post-CPHI follow-ups go from Naresh's own mailbox, scheduled, continuing while he
// travels. That rests entirely on one thing being true: that the service account can impersonate
// a Workspace user for the Gmail send scope. src/lib/google-auth.js says in its own header that it
// was written "during the window before DWD is enabled in the Workspace Admin Console" — so
// whether that window has closed is unknown, and the honest way to find out is to ask Google
// rather than to build a scheduler on top of an assumption.
//
// Two auth paths, and which one answers matters:
//
//   service_account  — domain-wide delegation. NO TOKEN TO EXPIRE. This is the one that survives a
//                      two-week trip, and the only one worth running an autonomous agent on.
//   refresh_token    — the legacy OAuth fallback. It works, but the existing refresh token was
//                      minted for Search Console and will NOT carry a Gmail scope; and a refresh
//                      token that expires mid-trip breaks exactly the thing being asked for.
//
// So a PASS via refresh_token is a different, weaker answer than a PASS via service_account, and
// this says which one it got.
'use strict';

const { SCOPES, serviceAccountCreds } = require('../src/lib/google-auth');
const { gmailClientFor, SCOPE_SETS } = require('../src/lib/gmail/client');

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const SUBJECT = arg('as', 'naren@abiozen.com');

// What to ASK for, in preference order — resolved in src/lib/gmail/client.js, which tries the
// narrow set first and falls back to the one that is actually granted. The 2026-10-12 grant held
// gmail.modify and not gmail.send, and modify already permits sending, so insisting on send would
// have cost a console trip for no security gain: the admin grant is the boundary, not the request.
const NEEDED = [SCOPES.gmailSend, SCOPES.gmailReadonly];
const GRANT_LINE = [SCOPES.gmailSend, SCOPES.gmailReadonly].join(',');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(String(d).split('\n').map((l) => '          ' + l).join('\n')); };

function printAdminSteps() {
  const creds = serviceAccountCreds();
  console.log('\n   ── TO ENABLE SENDING AS A WORKSPACE USER ────');
  if (!creds) {
    console.log('   GOOGLE_SERVICE_ACCOUNT_JSON is not set or not valid JSON, so there is no');
    console.log('   service account to delegate to. That has to be fixed first.');
    return;
  }
  const project = creds.project_id || '(project unknown)';
  console.log('   THREE steps, and the first is the one that gets missed.\n');
  console.log(`   1. ENABLE THE GMAIL API in the service account's own Cloud project.`);
  console.log(`      console.cloud.google.com → project ${project}`);
  console.log(`      → APIs & Services → Library → Gmail API → Enable`);
  console.log(`      This project was created for Search Console, so the Gmail API is almost`);
  console.log(`      certainly off. Delegation alone does not help while it is: the calls fail with`);
  console.log(`      "Gmail API has not been used in project ... before or it is disabled".`);
  console.log('');
  console.log('   2. GRANT DOMAIN-WIDE DELEGATION in the Workspace Admin Console.');
  console.log('      admin.google.com → Security → Access and data control → API controls');
  console.log('                       → Manage Domain Wide Delegation → Add new');
  console.log(`      Client ID:  ${creds.client_id || '(client_id is missing from the service account JSON)'}`);
  console.log('      OAuth scopes (paste as one comma-separated line):');
  console.log(`      ${GRANT_LINE}`);
  console.log('      You must be a Workspace super admin on the domain. Allow a few minutes to');
  console.log('      propagate — if it still fails immediately, wait and re-run.');
  console.log('');
  console.log('   3. RE-RUN THIS CHECK. It should then say "via service_account".');
  console.log('');
  console.log(`   Service account: ${creds.client_email}`);
  console.log('');
  console.log('   ── WHAT THIS GRANT ACTUALLY GIVES AWAY, SAID PLAINLY ────');
  console.log('   Domain-wide delegation is DOMAIN-WIDE. It cannot be limited to one mailbox: once');
  console.log('   granted, that key can read and send mail as ANY user on the domain, and the key');
  console.log('   currently sits in a Railway environment variable. That is a real blast radius and');
  console.log('   it is the price of an agent that keeps running while nobody is watching.');
  console.log('');
  console.log('   The narrower alternative is an OAuth consent for ONE user, which reaches only that');
  console.log('   mailbox. Its catch: if the OAuth app\'s publishing status is still "Testing", the');
  console.log('   refresh token expires after SEVEN DAYS — which is precisely the failure that would');
  console.log('   strand a follow-up sequence mid-trip. Delegation has no token to expire.');
  console.log('');
  console.log('   If the blast radius is the greater worry, the tidier version is a SEPARATE service');
  console.log('   account for mail, so an SEO credential and a send-as-anyone credential are not the');
  console.log('   same string. Worth doing, not worth blocking the campaign on.');
}

async function main() {
  console.log(`── Gmail send · can we act as ${SUBJECT}?\n`);
  console.log(`   scopes requested:`);
  for (const s of NEEDED) console.log(`      ${s}`);
  console.log();

  const res = await gmailClientFor(SUBJECT);
  if (res.error) {
    bad(`act as ${SUBJECT}`, [res.error, ...(res.tried || []).map((t) => `tried ${t}`)].join('\n'));
    const all = (res.tried || []).join(' ');
    if (/unauthorized_client/i.test(all)) {
      console.log('\n   "unauthorized_client" means Workspace is refusing to let this service');
      console.log('   account impersonate anyone for the scopes asked for. Either delegation is not');
      console.log('   granted, or the granted list does not contain them.');
    }
    if (/has not been used in project|is disabled/i.test(all)) {
      console.log('\n   The Gmail API is not enabled in the service account\'s Cloud project. That is');
      console.log('   step 1 below, and delegation cannot work around it.');
    }
    if (/insufficient authentication scopes/i.test(all)) {
      console.log('\n   A token minted but carries no Gmail scope — the Search-Console refresh token.');
      console.log('   Delegation is what fixes this; a fresh consent would too, less durably.');
    }
    printAdminSteps();
    console.log(`\nFAIL  cannot act as ${SUBJECT} — the follow-up agent must not be enabled\n`);
    process.exit(1);
  }

  ok(`token minted via ${res.via}, on the "${res.scopeSet}" scope set`);
  if (res.scopeSet === 'modify+readonly') {
    console.log('   note  gmail.send is not in the grant, so this is sending via gmail.modify,');
    console.log('         which permits it. Nothing to fix: modify is already delegated and is');
    console.log('         needed anyway by meet-agent and inquiry-agent to drop the UNREAD label.');
  }
  if (res.via !== 'service_account') {
    console.log(`   ⚠ This came from the OAuth REFRESH TOKEN, not the service account.`);
    console.log(`     It works, but a refresh token can be revoked or expire — and if the OAuth app`);
    console.log(`     is still in "Testing" status it expires after SEVEN DAYS, which would strand`);
    console.log(`     the sequence mid-trip. Delegation has no token to expire.`);
    printAdminSteps();
  }

  // ── WHOSE MAILBOX DID WE ACTUALLY GET? ────
  // Already proven by the resolver, which refuses a token for the wrong identity — a token can be
  // valid and be the wrong person, and a warm follow-up from the wrong address is worse than none.
  const profile = res.profile || {};
  ok(`the mailbox IS ${profile.emailAddress} — ${profile.messagesTotal} messages, ${profile.threadsTotal} threads`);
  const gmail = res.gmail;
  const tok = { access_token: res.access_token, via: res.via };

  // ── CAN WE SEE REPLIES? ────
  // Stop-on-reply is what keeps the agent from emailing somebody who already answered. It needs
  // read access, so it is checked separately from sending rather than assumed to come with it.
  try {
    const r = await gmail.users.messages.list({ userId: 'me', maxResults: 1, q: 'in:inbox' });
    const n = (r.data.messages || []).length;
    ok(`inbox is readable (${n} message returned) — stop-on-reply can work`);
  } catch (e) {
    bad('list inbox messages — stop-on-reply CANNOT work', (e && e.message) || String(e));
    console.log('          Without this the agent would keep following up after somebody replied,');
    console.log('          which on a list of people you met in person is the worst failure available.');
  }

  // ── SEND SCOPE, WITHOUT SENDING ────
  // There is no way to prove the send scope without sending, so this does not pretend to. It
  // reports what the token claims and says plainly that the first real send is the proof.
  try {
    const info = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(tok.access_token)}`);
    const data = await info.json().catch(() => ({}));
    const granted = String(data.scope || '').split(/\s+/).filter(Boolean);
    if (granted.length) {
      const hasSend = granted.includes(SCOPES.gmailSend) || granted.includes(SCOPES.gmailModify);
      if (hasSend) ok(`the token carries a send scope: ${granted.filter((s) => /gmail/.test(s)).join(' ')}`);
      else bad('the token carries NO Gmail send scope', `granted: ${granted.join(' ') || '(none reported)'}`);
    } else {
      console.log('  note  tokeninfo returned no scope list — not conclusive either way');
    }
  } catch (e) {
    console.log(`  note  could not read tokeninfo (${e.message}) — not conclusive either way`);
  }

  console.log('');
  if (fail) {
    console.log(`FAIL  ${fail} problem(s). The follow-up agent should not be enabled yet.`);
  } else {
    console.log(`PASS  we can act as ${SUBJECT} via ${tok.via}.`);
    if (tok.via === 'service_account') {
      console.log('      No token to expire, so the follow-ups will keep running while you travel.');
    }
    console.log('      Nothing was sent. The first real send is the only proof of the send scope.');
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('check-gmail-send failed:', e && e.message ? e.message : e);
  process.exit(1);
});
