#!/usr/bin/env node
/*
 * harvest-grants-gov.js — pull live grants.gov funding opportunities on demand.
 *
 *   node scripts/harvest-grants-gov.js             # harvest and write
 *   node scripts/harvest-grants-gov.js --dry-run   # search and report, write NOTHING
 *   node scripts/harvest-grants-gov.js --keyword "peptide synthesis"
 *
 * Same implementation as the grants-gov-harvest-6h cron — see src/lib/connectors/grants-gov-job.js.
 * A job an operator runs by hand must be the job the schedule runs, or a 3am misbehaviour cannot
 * be reproduced at 10am.
 *
 * Only POSTED opportunities are fetched. A forecast is an agency saying it intends to publish
 * something later, usually with no close date; it is not something anyone can apply to.
 *
 * Exit status: 0 harvested, 1 could not. Zero records across every keyword is exit 1 — these
 * keywords have standing federal activity, so an empty result means the request shape or the host
 * changed, not that nothing was posted.
 */
'use strict';

require('dotenv').config();

const JOB = require('../src/lib/connectors/grants-gov-job');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const kwIdx = argv.indexOf('--keyword');
const KEYWORDS = kwIdx >= 0 && argv[kwIdx + 1] ? [argv[kwIdx + 1]] : JOB.DEFAULT_KEYWORDS;

const log = (s) => process.stdout.write(`${s}\n`);
const bar = () => '─'.repeat(78);

async function main() {
  log(`\n${bar()}`);
  log('GRANTS.GOV HARVEST — posted opportunities only');
  log(bar());
  log(`  objective : ${JOB.OBJECTIVE_ID}`);
  log(`  keywords  : ${KEYWORDS.join(' · ')}`);
  log(`  mode      : ${DRY ? 'DRY RUN — nothing written' : 'harvest and write'}\n`);

  const r = await JOB.runGrantsHarvest({ log, dryRun: DRY, keywords: KEYWORDS });

  log('');
  log(`  searched            : ${r.stats.searched} of ${r.stats.keywords}`);
  log(`  records seen        : ${r.stats.seen}`);
  log(`  forecasts excluded  : ${r.stats.forecastsExcluded}`);
  log(`  normalised          : ${r.stats.normalized}`);
  log(`  skipped (no key)    : ${r.stats.skipped}`);
  log(`  inserted / updated  : ${r.stats.inserted} / ${r.stats.updated}`);
  for (const e of r.stats.errors) log(`  error: ${e}`);
  log('');

  if (!r.ok) {
    process.stderr.write(`harvest-grants-gov: ${r.error}\n\n`);
    process.exit(1);
  }
  if (r.declined) { log('DECLINED — another run already owns this intent.'); log(''); process.exit(0); }
  log(DRY
    ? 'PASS  dry run complete — nothing was written.'
    : `PASS  ${r.stats.inserted} new and ${r.stats.updated} updated funding opportunities.`);
  log('');
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`\nharvest-grants-gov: ${e.stack || e.message}\n\n`);
  process.exit(1);
});
