#!/usr/bin/env node
// ── INVENTORY AND RECLAIM DISPOSABLE TEST CLUSTERS ──────────────────────────
//
//   node scripts/pg-cleanup.js                 # DRY RUN — report only
//   node scripts/pg-cleanup.js --apply         # remove clusters owned by runs that are gone
//
//   exit 0 = nothing needs attention, or the requested removal succeeded
//   exit 1 = resources exist that this tool REFUSES to touch, and somebody must look
//
// On 2026-11-24 preflight failed with "database TLS verification refuses the wrong certificate"
// and "the migration connects as the migrator". Neither was true. The disk was 100% full — 3.3 MB
// free — behind 688 orphaned cluster directories and 228 postgres processes left by preflight runs
// killed mid-flight, because every DB check cleans up in a `finally` and a `finally` does not run
// when the process is killed.
//
// ── WHAT THIS WILL AND WILL NOT DO ──────────────────────────────────────────
//
// It removes exactly one class: a cluster carrying this tool's own ownership marker whose creating
// process is provably gone — pid absent, or alive with a different start time, so a recycled pid
// cannot be mistaken for the original.
//
// It REFUSES, and reports, everything else:
//
//   · a cluster owned by a run that is still alive        — another test is using it
//   · a cluster whose ownership cannot be established     — incomplete evidence is not permission
//   · a directory with no marker at all                   — the 688 from the incident. A directory
//                                                           name is not evidence of ownership
//   · anything that does not canonicalise to a direct child of the disposable base — a symlink or
//     a traversal, which is how a cleanup tool deletes a real database
//
// Uncertainty is reported rather than resolved by deleting. A tool that guesses here becomes the
// next incident, and the first one cost two failures that looked like security regressions.

'use strict';

const D = require('./lib/pg-disposable');

const APPLY = process.argv.includes('--apply');

const out = D.cleanupStale({ dryRun: !APPLY });
const mib = (b) => (b === null ? 'unknown' : `${Math.round(b / 1048576)} MiB`);

console.log(`  base:       ${out.base}`);
console.log(`  free space: ${mib(out.freeBytes)}`);
console.log('');
console.log(`  mine (this run)............ ${out.counts.mine}`);
console.log(`  owned by a LIVE run........ ${out.counts.liveOther}   (never touched)`);
console.log(`  owned by a run that is gone ${out.counts.deadOwned}   (${APPLY ? 'removed' : 'removable'})`);
console.log(`  ownership uncertain........ ${out.counts.uncertain}   (refused)`);
console.log(`  unidentified / pre-utility. ${out.counts.unidentified}   (refused — inventory only)`);

const needsEyes = out.rows.filter((r) => r.state === D.STATE.UNCERTAIN
  || r.state === D.STATE.UNIDENTIFIED);
if (needsEyes.length) {
  console.log('\n  REFUSED — these need a person, not a sweep:');
  for (const r of needsEyes.slice(0, 40)) console.log(`    ${r.dir}\n      ${r.why}`);
  if (needsEyes.length > 40) console.log(`    … and ${needsEyes.length - 40} more`);
}

if (APPLY) {
  console.log(`\n  removed ${out.removed.length} cluster(s):`);
  for (const d of out.removed.slice(0, 40)) console.log(`    ${d}`);
  console.log(`\n  free space now: ${mib(D.cleanupStale({ dryRun: true }).freeBytes)}`);
} else if (out.counts.deadOwned) {
  console.log('\n  dry run. Re-run with --apply to remove the clusters owned by runs that are gone.');
}

// Exit non-zero when something was refused: a human has to decide about those, and a zero exit
// would let a full disk sit behind a clean-looking report.
if (needsEyes.length) {
  console.log('\nATTENTION: resources exist that this tool will not remove on its own evidence.');
  process.exit(1);
}
console.log('\nOK: nothing refused.');
process.exit(0);
