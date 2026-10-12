#!/usr/bin/env node
// ── SEND THE POST-CPHI FOLLOW-UPS, BY HAND ────────────────────────────────────
//
//   railway ssh 'node scripts/run-cphi-followup.js'                      → what WOULD go, now
//   railway ssh 'node scripts/run-cphi-followup.js --to=naren@abiozen.com --execute --max=1'
//   railway ssh 'node scripts/run-cphi-followup.js --execute --max=5'
//
// ── THIS IS A FRONT END, NOT THE CAMPAIGN ────────────────────────────────────
//
// The send loop lives in src/lib/campaigns/cphi-runner.js, because the hourly cron in server.js
// runs the same campaign and a second copy of "who is due and what do we send them" would be a
// second answer that nobody checks. This file parses flags, prints, and sets an exit code.
//
// ── SEND ONE TO YOURSELF FIRST ───────────────────────────────────────────────
//
// `--to=` redirects every message to one address while rendering the real content for the real
// contact. It is the only proof that the send scope works, that the attachment survives, that the
// HTML renders where it lands, and that the name in the greeting is the right one. Nothing is
// recorded against the real contact, so they stay due.
'use strict';

const { initDB } = require('../src/lib/db');
const { runFollowups } = require('../src/lib/campaigns/cphi-runner');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};

async function main() {
  await initDB();
  const res = await runFollowups({
    event: arg('event', 'cphi-milan-2026'),
    fromMailbox: arg('from', 'naren@abiozen.com'),
    redirectTo: arg('to', null),
    campaign: arg('campaign', null),
    max: parseInt(arg('max', '5'), 10),
    execute: process.argv.includes('--execute'),
    ignoreWindow: process.argv.includes('--ignore-window'),
    log: (s = '') => console.log(s),
  });
  // A run where some sends failed exits non-zero: CLAUDE.md — the verdict is the exit status, and
  // "3 sent, 2 failed" scrolling past in a terminal is not a verdict anybody reads.
  if (res.failed) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('run-cphi-followup failed:', e && e.message ? e.message : e);
  process.exit(1);
});
