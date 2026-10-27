#!/usr/bin/env node
// ── SEND THE NEED-BASED SEQUENCES, BY HAND ───────────────────────────────────
//
//   railway ssh 'node scripts/send-outreach.js'                         # dry run
//   railway ssh 'node scripts/send-outreach.js --to=naren@abiozen.com --execute --max=1'
//   railway ssh 'node scripts/send-outreach.js --execute --max=8'
//
// Dry run unless --execute.
//
// ── THIS IS A WRAPPER, NOT THE IMPLEMENTATION ────────────────────────────────
//
// The logic lives in src/lib/agents/outreach-agent.js, which is what the 09:10 weekday cron
// calls. If this script had its own copy, the thing you test by hand and the thing that runs
// unattended would be two implementations that agree until they do not — which is exactly how a
// SCOPE contact was queued to receive a CPHI letter, and how five of our own test records were
// queued for cold outreach.
//
// So this parses flags, prints, and calls the agent. Nothing else.
'use strict';

const { initDB } = require('../src/lib/db');
const { runOutreach, DEFAULT_FROM } = require('../src/lib/agents/outreach-agent');
const { composeOutreachReport } = require('../src/lib/agents/outreach-report');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};

const say = (s = '') => console.log(s);

async function main() {
  await initDB();

  const execute = has('execute');
  const redirectTo = arg('to', '') || null;
  const from = arg('from', DEFAULT_FROM);

  say(`\n── outreach · ${execute ? 'SENDING' : 'dry run'} · from ${from}\n`);
  if (redirectTo) {
    say(`   ⚠ EVERY message is redirected to ${redirectTo}.`);
    say('     The content is still rendered for the real contact, so this is a true test of what');
    say('     they would receive — but nobody else gets anything.');
    say('     NOTHING IS RECORDED: no claim row, no sequence state. The real contact is untouched');
    say('     and still due.\n');
  }

  const r = await runOutreach({
    execute,
    redirectTo,
    from,
    replyTo: arg('reply-to', undefined),
    need: arg('need', ''),
    max: parseInt(arg('max', '8'), 10) || 8,
    bounceLimit: arg('bounce-limit', '') ? Number(arg('bounce-limit', '5')) / 100 : undefined,
    log: say,
  });

  if (r.stopped) { say(`\n   ✋ ${r.stopped}\n`); process.exit(1); }

  say(`\n   ${r.routed} routed · ${r.due} due now`);
  const skip = Object.entries(r.skipped || {}).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ');
  if (skip) say(`   skipped: ${skip}`);
  if (r.declined.length) {
    say(`\n   ${r.declined.length} not written to — no evidence, so no email:`);
    for (const d of r.declined.slice(0, 40)) {
      say(`      ${String(d.who).padEnd(24)}${String(d.org || '').slice(0, 30).padEnd(31)}${d.why || ''}`);
    }
  }

  if (!execute) {
    say('\n   DRY RUN — nothing sent. Re-run with --execute.');
    say(`   First real send should go to yourself:  --to=${from} --execute --max=1\n`);
    return;
  }

  say(`\n   ${r.sent} sent · ${r.failed} failed`);
  if (r.repliedNow.length) say(`   ${r.repliedNow.length} replied — sequence stopped: ${r.repliedNow.join(', ')}`);
  if (r.unfiled.length) {
    say(`\n   ⚠ ${r.unfiled.length} thread(s) UNFILED — their replies will not stop the sequence:`);
    for (const u of r.unfiled) say(`      ${u.who}  thread ${u.threadId}  (${u.why})`);
  }

  // The same report the cron emails, printed. Seeing it here is how you know what the unattended
  // run will actually say.
  if (has('report')) {
    const rep = composeOutreachReport({ run: r, bounce: null });
    say(`\n   ── the report the agent would send ──\n   Subject: ${rep.subject}`);
    say(`   (worth sending: ${rep.worthSending})`);
  }
  say('');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('send-outreach failed:', e && e.message ? e.message : e);
  process.exit(1);
});
