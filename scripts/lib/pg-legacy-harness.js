// ── THE LEGACY HARNESS CONTRACT, BACKED BY THE VERIFIED LIFECYCLE UTILITY ───
//
// Owner's requirement 4, 2026-11-26: *"Complete B7.20b. The recurring disposable PostgreSQL storage
// exhaustion must be resolved before the continuous reliability demonstration. Migrate the remaining
// legacy harnesses to the verified lifecycle utility. Do not delete unverified or unrelated
// resources."*
//
// ── WHY A SHIM AND NOT 84 REWRITES ──────────────────────────────────────────
//
// Eighty-four files start their own Postgres. Fifty-one of them carry the SAME copy-pasted
// `startTemp`/`stopTemp` pair in fifteen near-identical variants; the rest differ. Rewriting each
// one by hand is eighty-four chances to introduce a different bug into a check that currently
// works, and it would not make the next copy-paste any less likely.
//
// So this module presents the legacy contract EXACTLY — `startTemp()` returns a connection URL or
// `null`, `stopTemp()` tears down — and implements it with `pg-disposable`. Migrating a file becomes
// deleting two functions and adding one require, which is mechanical and which the gate verifies by
// actually running the check.
//
// ── THE DEFECT THIS FIXES, MEASURED ─────────────────────────────────────────
//
// The legacy pair leaks for two reasons, and neither is "somebody forgot a finally":
//
//   1. **`.finally(stopTemp)` does not cover the paths that actually happen.** These scripts call
//      `process.exit()` on both pass and fail, and their watchdogs call it on a stall. A `finally`
//      attached to a promise does not run when the process exits from inside it, and it certainly
//      does not run on SIGTERM. `pg-disposable` installs SIGINT/SIGTERM/SIGHUP and `exit` handlers
//      and re-raises the signal, so the exit status still reflects it.
//   2. **A leaked legacy cluster is UNRECLAIMABLE.** It carries no ownership record, so
//      `pg-cleanup.js` correctly refuses to delete it — *"deletion requires positive evidence of
//      ownership, and uncertainty means report, not delete"* — and it reports it as `unidentified`,
//      inventory only. The directories therefore accumulate for ever. Every cluster created through
//      the utility writes an `OWNER.json` naming the marker, the run id, the pid and the pid's start
//      time, so a dead run's cluster is positively identifiable and removable.
//
// **Measured today:** 66 orphaned `/var/tmp/m7-identity-*` directories at ~171 MiB each — **28 GB**,
// from `check-db-identity-db.js` alone. The immediate cause was me: I killed a running preflight
// three times with `pkill`, and `.finally` covers none of those. The disk then filled mid-gate and
// several checks reported `SKIP infrastructure unavailable` — **a full disk presenting as a missing
// database, for the second time in this project.** That is the defect class this repository keeps
// finding, and this time it was in the instrument's own plumbing.
//
// ── TWO BEHAVIOUR CHANGES, BOTH DELIBERATE, BOTH IMPROVEMENTS ───────────────
//
//   · **The fixed port is gone.** Each legacy harness hard-coded one (`55963`, `55987`, …), which
//     is why two concurrent runs of the same check could not coexist and why an orphan holding the
//     port blocked a later run. The utility allocates a random high port per cluster.
//   · **The base directory follows the utility**, which honours `PNX_PG_BASE` and defaults to
//     `os.tmpdir()`. The legacy pair wrote to `/var/tmp` unconditionally, which is why the orphans
//     were somewhere `pg-cleanup` was not even looking.
//
// `startTemp()` still returns `null` rather than throwing when the environment cannot support a
// cluster, because every caller branches on that and prints its own NOT EXECUTED message. An
// InfrastructureError is translated to `null` with its reason on stderr — the reason is kept,
// because *"a blocked port and a missing binary need different action, and conflating them is what
// hid a self-inflicted failure for an afternoon."*

'use strict';

const DISPOSABLE = require('./pg-disposable');

/**
 * One cluster per module, which is what the legacy contract assumed. A second `startTemp()` without
 * an intervening `stopTemp()` is a caller error and is reported rather than silently leaking the
 * first cluster.
 */
let current = null;

/**
 * Start a disposable cluster and return its connection URL, or `null` when one cannot be started.
 *
 * @param {string} label  short identifier for the cluster directory, so an operator reading an
 *                        inventory can tell which check left it. Pass the legacy prefix.
 * @returns {string|null}
 */
function startTemp(label = 'legacy') {
  if (current) {
    process.stderr.write(
      '[pg-legacy-harness] startTemp() called twice without stopTemp(); returning the live '
      + 'cluster rather than leaking the first\n');
    return current.url;
  }
  try {
    current = DISPOSABLE.create({ label: String(label).replace(/[^A-Za-z0-9-]/g, '').slice(0, 24) });
    return current.url;
  } catch (e) {
    // The REASON is preserved on stderr even though the return value is `null`, so an
    // infrastructure failure is not indistinguishable from "no Postgres installed".
    if (e && e.infrastructure) {
      process.stderr.write(`[pg-legacy-harness] ${e.message}\n`);
      current = null;
      return null;
    }
    throw e;
  }
}

/**
 * Tear the cluster down. Safe to call when none was started, and safe to call twice — the utility's
 * `destroy()` is idempotent, and the exit handlers call it too, so a caller keeping its existing
 * `.finally(stopTemp)` is correct and now merely redundant.
 */
function stopTemp() {
  if (!current) return;
  const c = current;
  current = null;
  try { c.destroy(); } catch (_) { /* a cluster that is already gone is the desired state */ }
}

/** The live cluster, for a caller that needs its base directory or port. */
function cluster() { return current; }

/**
 * A LIVE stand-in for the legacy `temp` object, for the harnesses that kept one.
 *
 * ── WHY THIS EXISTS, AND THE DEFECT IT REPAIRS ─────────────────────────────
 *
 * The legacy harnesses were not one shape but a family. Most assigned `temp = { base, dir }` inside
 * their own `startCluster()` and then read `temp.base` in a teardown and sometimes in the body —
 * for a `pg_dump -h`, a dump path, a `pg_restore -h`. Migrating the START function and leaving the
 * rest meant `temp` was never assigned again, so `temp.base` threw
 * `Cannot read properties of null (reading 'base')`.
 *
 * **Twenty files were in that state, and five gate checks failed because of it.** The first gate
 * run after the migration showed several of those failures and I attributed them all to a missing
 * `autonomy_stops` table, which was a real and separate cause — so a plausible explanation for one
 * failure stood in for the diagnosis of five others. That is this repository's recurring defect,
 * committed by me, in the repair for another instance of it.
 *
 * This returns GETTERS rather than a snapshot, because the legacy code reads `temp.base` long after
 * the cluster is created and, in a couple of files, after a restart. A snapshot taken at module
 * load would be null for exactly the same reason the original bug was.
 *
 * `asPostgres` is included because several of those teardowns branch on it; the utility does not
 * expose it, and it is the same question the utility asks internally.
 */
function legacyTemp() {
  return {
    get base() { return current ? current.base : null; },
    get dir() { return current ? current.dir : null; },
    get port() { return current ? current.port : null; },
    get asPostgres() { return !!(process.getuid && process.getuid() === 0); },
  };
}

// `EXIT_NOT_EXECUTED` is deliberately NOT re-exported: it lives in `scripts/lib/pg-cluster.js`,
// which is where every caller already gets it from, and a second source for the number that means
// "this proved nothing" is exactly the kind of duplication that lets two files disagree about it.
module.exports = { startTemp, stopTemp, cluster, legacyTemp };
