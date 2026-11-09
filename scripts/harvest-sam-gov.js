#!/usr/bin/env node
// ── AUTOMATED SAM.gov HARVEST ────────────────────────────────────────────────
//
//   node scripts/harvest-sam-gov.js            # harvest and import
//   node scripts/harvest-sam-gov.js --dry-run  # harvest, report, write NOTHING
//
// Owner decision, 2026-11-08: ingest automatically from sam.gov/api/prod/sgs/v1/ — the SAM.gov web
// UI's own JSON backend — rather than wait on GSA explaining why the DOCUMENTED api.sam.gov paths
// return empty 404s. The trade is stated in src/lib/connectors/sam-sgs.js: an undocumented
// endpoint can change without notice, so the harvester fails LOUDLY rather than returning an empty
// board that looks calm and current.
//
// Exit status is the verdict: 0 harvested and imported, 1 failed, 2 bad usage.
// Zero NEW records is exit 0 — nothing new was posted, which is an ordinary Sunday.
// Zero records SEEN is exit 1 — that is a broken harvest wearing the same clothes.

'use strict';

require('dotenv').config();

const { query } = require('../src/lib/db');
const SGS = require('../src/lib/connectors/sam-sgs');
const { runHarvestAndImport } = require('../src/lib/connectors/sam-sgs-job');
const { isoDay } = require('../src/lib/office/iso-day');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const log = (s) => process.stdout.write(`${s}\n`);
const bar = () => '─'.repeat(78);

async function main() {
  log(`\n${bar()}`);
  log('SAM.gov HARVEST');
  log(bar());
  log(`  route   : ${SGS.SGS_SEARCH}  (web UI backend, no API key, UNDOCUMENTED)`);
  log(`  naics   : ${SGS.DEFAULT_NAICS.join(', ')}`);
  log(`  types   : ${SGS.BIDDABLE_TYPES.join(', ')}`);
  log(`  mode    : ${DRY ? 'DRY RUN — nothing will be written' : 'import'}\n`);

  const res = await runHarvestAndImport(query, { log, dryRun: DRY });
  const { stats } = res;

  log('');
  log(`  pages fetched      : ${stats.pagesFetched}`);
  log(`  records seen       : ${stats.recordsSeen}`);
  log(`  biddable harvested : ${stats.biddable}`);
  log(`  with a deadline    : ${stats.withDeadline}`);
  log(`  without one        : ${stats.withoutDeadline}`);
  log(`  closed, skipped    : ${stats.closedSkipped}`);

  // A harvest that SAW nothing is broken, not quiet. Every NAICS code here has standing federal
  // activity; zero records across all of them means the route changed, not that procurement
  // stopped. This is the check that keeps an undocumented dependency honest.
  if (!res.ok) {
    process.stderr.write(`\nharvest: ${res.error}\n\n`);
    process.exit(1);
  }

  if (DRY) {
    log(`\n${bar()}`);
    log('DRY RUN — nothing written. Soonest five:');
    for (const r of res.rows.slice(0, 5)) {
      log(`  ${isoDay(r.ResponseDeadLine) || 'unknown   '}  ${String(r['Sol#']).slice(0, 20).padEnd(20)} ${String(r.Title).slice(0, 44)}`);
    }
    log('');
    process.exit(0);
  }

  const r = res;

  log(`\n${bar()}`);
  log(`  batch     : ${r.batchId}`);
  log(`  inserted  : ${r.outcome.inserted.length}`);
  log(`  amended   : ${r.outcome.amended.length}`);
  log(`  unchanged : ${r.outcome.unchanged.length}`);
  log(`  rejected  : ${(r.outcome.rejected || []).length}`);
  if ((r.unmatchedHeaders || []).length) {
    log(`  columns not mapped: ${r.unmatchedHeaders.join(', ')}`);
  }
  for (const a of r.outcome.amended.slice(0, 10)) {
    log(`    amended: ${a.solicitation_number} → v${a.version}`);
  }
  log('');
  log(`PASS  ${r.outcome.inserted.length} new · ${r.outcome.amended.length} amended`);
  log('');
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`\nharvest: ${e.stack || e.message}\n`);
  if (e.detail) process.stderr.write(`         detail: ${JSON.stringify(e.detail)}\n`);
  process.stderr.write('\n');
  process.exit(1);
});
