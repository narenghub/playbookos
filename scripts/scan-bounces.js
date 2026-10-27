#!/usr/bin/env node
// ── FIND THE DELIVERY FAILURES AND RECORD THEM, BY HAND ──────────────────────
//
//   railway ssh 'node scripts/scan-bounces.js'              # dry run
//   railway ssh 'node scripts/scan-bounces.js --execute'
//   railway ssh 'node scripts/scan-bounces.js --days=30 --execute'
//
// ── THIS IS A WRAPPER ────────────────────────────────────────────────────────
//
// The scan runs inside the 09:10 weekday outreach agent, immediately before any send, so the 5%
// gate is reading something current rather than something stale. The logic lives in
// src/lib/agents/outreach-agent.js; this is here for when you want to look between runs.
//
// ── WHY THE GATE NEEDED THIS AT ALL ──────────────────────────────────────────
//
// send-outreach refuses to start above a 5% bounce rate and computed that rate from
// outreach_bounces — a table nothing wrote to. It read 0 bounces in 8 sends, reported 0.0%, and
// allowed the batch. It would have reported 0.0% and allowed the batch if every address had
// failed. A check that cannot fail is indistinguishable from one that passes.
'use strict';

const { initDB } = require('../src/lib/db');
const { scanBounces, DEFAULT_FROM } = require('../src/lib/agents/outreach-agent');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};

const say = (s = '') => console.log(s);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

async function main() {
  await initDB();
  const execute = has('execute');
  const mailbox = arg('mailbox', DEFAULT_FROM);
  const days = parseInt(arg('days', '14'), 10) || 14;

  say(`\n── bounce scan · ${execute ? 'recording' : 'dry run'} · ${mailbox} · last ${days} days\n`);

  const r = await scanBounces({ mailbox, days, execute, log: say });

  say(`   ${r.scanned} message(s) from a postmaster in that window`);
  if (!r.found.length) {
    say('   No failures matched an address we wrote to.');
  } else {
    say('\n   ══ BOUNCES ═════════════════════════════════════════════════════════');
    for (const f of r.found) say(`      ${pad(f.kind, 9)}${pad(f.email, 40)}${f.detail}`);
  }
  if (r.unmatched) say(`\n   ${r.unmatched} postmaster message(s) named no address of ours — not counted.`);

  const distinct = new Set(r.found.map((f) => f.email)).size;
  say(`\n   ${distinct} address(es) bounced out of ${r.sent} send(s) — ${(r.rate * 100).toFixed(1)}%`);

  // THE LINE THAT MATTERS. A zero from an empty scan reads exactly like a zero from a clean list.
  if (!r.scanned) {
    say('\n   ⚠ No postmaster mail at all in the window. That is consistent with a clean list, and');
    say('     it reads identically to a scanner that cannot see bounces. Run');
    say('     scripts/verify-bounce-detection.js --execute to settle which, by causing one.');
  }
  if (r.rate > 0.05) {
    say('\n   ⚠ over 5%. The outreach agent will hold until the remaining addresses are verified.');
    say('     sales@abiozen.com took six weeks to warm and is the only warmed mailbox.');
  }

  if (!execute) { say('\n   DRY RUN — nothing recorded. Re-run with --execute.\n'); return; }
  say(`\n   ✅ ${r.recorded} new bounce(s) recorded (${r.found.length - r.recorded} already known).`);
  if (r.stopped) say(`   ${r.stopped} sequence(s) stopped on a hard bounce.`);
  say('');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('scan-bounces failed:', e && e.message ? e.message : e);
  process.exit(1);
});
