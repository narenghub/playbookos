#!/usr/bin/env node
/*
 * refresh-award-benchmarks.js — what has the government actually paid, per product service code.
 *
 *   node scripts/refresh-award-benchmarks.js            # refresh every PSC on the live board
 *   node scripts/refresh-award-benchmarks.js --dry-run  # fetch and report, write NOTHING
 *   node scripts/refresh-award-benchmarks.js --psc Q301 # one code
 *
 * Reads the distinct PSC codes from the live opportunity board and caches a percentile benchmark
 * for each. Writes ONLY to psc_award_benchmarks — it never touches an opportunity, an assessment
 * or a capability.
 *
 * Three USAspending requests per code, jumping straight to the percentile positions in the sorted
 * award list; see src/lib/connectors/usaspending-awards.js for why that rather than a sample.
 *
 * Exit status: 0 when every code was attempted and at least one benchmark was produced; 1 when
 * nothing could be computed. A code with too few awards is a RESULT, not a failure — some codes
 * genuinely have no comparable history, and that is what the board should say.
 */
'use strict';

require('dotenv').config();

const { query } = require('../src/lib/db');
const UA = require('../src/lib/connectors/usaspending-awards');
const { usd } = require('../src/lib/office/award-comparables');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const pscIdx = argv.indexOf('--psc');
const ONLY = pscIdx >= 0 && argv[pscIdx + 1] ? String(argv[pscIdx + 1]).toUpperCase() : null;
const YEARS = 3;

const log = (s) => process.stdout.write(`${s}\n`);
const bar = () => '─'.repeat(78);

const UPSERT = `
  INSERT INTO psc_award_benchmarks
    (psc_code, naics_code, window_years, award_count, p25_usd, median_usd, p75_usd,
     source_key, computed_at)
  VALUES ($1, '', $2, $3, $4, $5, $6, 'usaspending', NOW())
  ON CONFLICT (psc_code, naics_code, window_years) DO UPDATE SET
    award_count = EXCLUDED.award_count,
    p25_usd     = EXCLUDED.p25_usd,
    median_usd  = EXCLUDED.median_usd,
    p75_usd     = EXCLUDED.p75_usd,
    computed_at = EXCLUDED.computed_at`;

async function main() {
  log(`\n${bar()}`);
  log('AWARD BENCHMARKS — what the government actually paid');
  log(bar());

  let codes;
  if (ONLY) {
    codes = [ONLY];
  } else {
    const r = await query(
      `SELECT DISTINCT psc_code FROM federal_opportunities
        WHERE is_current AND psc_code IS NOT NULL AND btrim(psc_code) <> ''
        ORDER BY psc_code`);
    codes = r.rows.map((x) => x.psc_code);
  }

  log(`  codes  : ${codes.length}`);
  log(`  window : ${YEARS} years`);
  log(`  mode   : ${DRY ? 'DRY RUN — nothing written' : 'fetch and cache'}\n`);

  if (!codes.length) {
    process.stderr.write('refresh-award-benchmarks: no PSC codes on the board\n\n');
    process.exit(1);
  }

  let written = 0;
  let thin = 0;
  const failures = [];

  for (const psc of codes) {
    let b;
    try {
      b = await UA.fetchBenchmark({ psc, years: YEARS });
    } catch (e) {
      failures.push(`${psc}: ${e.message}`);
      log(`  ${psc.padEnd(6)} FAILED — ${e.message}`);
      continue;
    }

    if (!b.sufficient) {
      thin += 1;
      log(`  ${psc.padEnd(6)} ${String(b.n).padStart(6)} award(s) — too few for a benchmark`
        + (b.error ? ` (${b.error})` : ''));
      // Still cached, so the board can say "3 comparable awards" rather than "unknown". The
      // database CHECK refuses figures without a count behind them, and there are no figures here.
      if (!DRY) {
        await query(UPSERT, [psc, YEARS, b.n, null, null, null]);
      }
      continue;
    }

    log(`  ${psc.padEnd(6)} ${String(b.n).padStart(6)} award(s)   `
      + `p25 ${String(usd(b.p25)).padStart(14)}   `
      + `median ${String(usd(b.median)).padStart(14)}   `
      + `p75 ${String(usd(b.p75)).padStart(14)}`);

    if (!DRY) {
      await query(UPSERT, [psc, YEARS, b.n, b.p25, b.median, b.p75]);
      written += 1;
    }
  }

  log('');
  log(`  benchmarks written : ${written}`);
  log(`  too thin to price  : ${thin}`);
  log(`  failed             : ${failures.length}`);
  for (const f of failures) log(`    ${f}`);
  log('');

  if (!DRY && written === 0) {
    process.stderr.write('refresh-award-benchmarks: no benchmark could be computed\n\n');
    process.exit(1);
  }
  log(bar());
  log(DRY ? 'PASS  dry run complete — nothing written.' : `PASS  ${written} benchmark(s) cached.`);
  log('');
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`\nrefresh-award-benchmarks: ${e.stack || e.message}\n\n`);
  process.exit(1);
});
