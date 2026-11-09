#!/usr/bin/env node
// ── TRIAGE sales@abiozen.com: CLASSIFY, LABEL, DRAFT ────────────────────────
//
//   node scripts/triage-inquiries.js             # label and draft
//   node scripts/triage-inquiries.js --dry-run   # classify and report, write NOTHING
//
// Owner decision 2026-11-09: drafts, never sends. See src/lib/agents/inquiry-triage.js for what
// that guarantee rests on, and why auto-sending was declined.
//
// Exit status: 0 ran, 1 could not run (auth, Gmail API). Zero messages is exit 0 — an empty
// mailbox is an ordinary morning, not a failure.

'use strict';

require('dotenv').config();

const TRIAGE = require('../src/lib/agents/inquiry-triage');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const log = (s) => process.stdout.write(`${s}\n`);
const bar = () => '─'.repeat(78);

async function main() {
  log(`\n${bar()}`);
  log('INQUIRY TRIAGE — classify, label, draft (never send)');
  log(bar());
  log(`  mailbox : ${TRIAGE.SALES_MAILBOX()}`);
  log(`  labels  : ${TRIAGE.CATEGORIES.map(TRIAGE.labelFor).join(', ')}`);
  log(`  mode    : ${DRY ? 'DRY RUN — nothing written' : 'label + draft'}\n`);

  const r = await TRIAGE.run({ dryRun: DRY, log });

  log('');
  log(`  checked  : ${r.checked}`);
  log(`  labelled : ${r.labelled}`);
  log(`  drafted  : ${r.drafted}`);
  log(`  skipped  : ${r.skipped}`);
  for (const s of r.samples) {
    log(`    [${String(s.category || 'unclassified').padEnd(12)}] ${s.subject} — ${s.note || ''}`);
  }
  if (r.errors.length) {
    log('');
    for (const e of r.errors) log(`  error: ${e}`);
  }
  log('');
  if (!r.ok) {
    process.stderr.write('triage: could not run — see errors above\n\n');
    process.exit(1);
  }
  log(`PASS  ${r.drafted} draft(s) waiting in ${TRIAGE.SALES_MAILBOX()}. Nothing was sent.`);
  log('');
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`\ntriage: ${e.stack || e.message}\n\n`);
  process.exit(1);
});
