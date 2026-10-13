#!/usr/bin/env node
// ── FIND OUT WHO HAS REPLIED, NOW RATHER THAN IN FOUR DAYS ────────────────────
//
//   railway ssh 'node scripts/sync-cphi-replies.js'            → who has replied, no writes
//   railway ssh 'node scripts/sync-cphi-replies.js --execute'   → marks them replied
//
// Also runs hourly from server.js, which is the point: on 13 Oct the delivery audit found eight
// replies and the reply queue found none, because reply state was only ever written at the moment
// the runner was about to send somebody's next step — four days away. Gmail knew; PlaybookOS did
// not. A supplier's catalogue going unnoticed for four days is the campaign's whole value going
// stale in an inbox.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { isEvent } = require('../src/lib/events/registry');
const { gmailClientFor } = require('../src/lib/gmail/client');
const { syncReplies } = require('../src/lib/campaigns/reply-sync');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EVENT = arg('event', 'cphi-milan-2026');
const FROM_MAILBOX = arg('from', 'naren@abiozen.com');
const EXECUTE = process.argv.includes('--execute');

async function main() {
  await initDB();
  if (!isEvent(EVENT)) { console.log(`✗ "${EVENT}" is not an event.`); process.exit(1); }

  console.log(`── ${EVENT} · reply sync · ${EXECUTE ? 'WRITING' : 'dry run'}\n`);

  const g = await gmailClientFor(FROM_MAILBOX);
  if (g.error) { console.log(`   ✗ cannot act as ${FROM_MAILBOX}: ${g.error}`); process.exit(1); }

  const r = await syncReplies({
    gmail: g.gmail, event: EVENT, fromMailbox: FROM_MAILBOX, query,
    execute: EXECUTE, log: (s) => console.log(s),
  });

  if (r.replied.length) {
    console.log(`\n   ↩ replied — their sequence is stopped${EXECUTE ? '' : ' (would be)'}:`);
    for (const x of r.replied) {
      console.log(`      ${x.name} — ${x.company} (${x.campaign})`
        + `${x.autoReplies ? ` · ${x.autoReplies} auto-reply seen, not counted` : ''}`);
    }
  }
  if (r.unknown.length) {
    console.log(`\n   ⚠ could not read — left ACTIVE, which is the safe side:`);
    for (const x of r.unknown) console.log(`      ${x.name} — ${x.company}: ${x.why}`);
  }
  if (!EXECUTE) console.log('\n   DRY RUN — nothing written. Re-run with --execute.');
  console.log('\n   Then:  node scripts/cphi-replies.js\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('sync-cphi-replies failed:', e && e.message ? e.message : e);
  process.exit(1);
});
