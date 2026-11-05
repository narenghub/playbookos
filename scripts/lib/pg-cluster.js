// ── ONE DEFINITION OF "WHERE IS POSTGRES" AND "WHAT IS THE SUPERUSER CALLED" ──
//
// Thirty-five verification harnesses each start a disposable Postgres cluster. Each one carried its
// own copy of the search path and its own idea of what a missing Postgres means. On 2026-11-03 that
// produced THREE different verdicts from one missing dependency, in a single preflight run on the
// CEO's Mac:
//
//   33 harnesses  searched /usr/lib/postgresql/{16,15}/bin, /usr/local/bin, /usr/bin — none of which
//                 exist on Apple Silicon, where Homebrew puts Postgres in
//                 /opt/homebrew/opt/postgresql@16/bin — found nothing, returned early, and
//                 EXITED 0. Preflight printed `ok`.
//    2 harnesses  included the Homebrew paths and fell back to `which initdb`, so they got further:
//                 they started a cluster, then died on `role "postgres" does not exist`.
//
// So 31 of 44 preflight steps reported `ok` having executed nothing — including `kill switch stops,
// propagates and audits`, `a supplier RFQ cannot be sent twice`, `cross-company work is refused by
// the database` and `each legacy external sender stops on its own, by name`. Every containment
// control said `ok` and ran zero assertions, on the machine that pushes.
//
// That is the 2026-09-30 failure one layer up. There it was a verdict misread — `tail -1` showed an
// `OK` belonging to another block. Here it was a verdict NEVER COMPUTED, reporting itself as a pass.
//
// ── THE TWO CAUSES, AND WHY THEY LIVE HERE ──────────────────────────────────
//
// 1. THE SEARCH PATH WAS COPIED, SO IT DRIFTED. Thirty-five copies cannot be corrected once. This
//    module is the only place a path may be named, and pg-harness-discipline.test.js fails the build
//    if a harness declares its own — the same shape as the shared SOURCES definition.
//
// 2. `initdb` WAS NEVER TOLD THE SUPERUSER'S NAME. Every harness ran `initdb -D ... -A trust` and
//    then connected as `postgresql://postgres@...`. initdb defaults the bootstrap superuser to the
//    INVOKING OS USER. As root the harnesses `su postgres` first, so the role happened to be called
//    `postgres` and the hardcoded name matched by luck. Run as `nboda3230`, the superuser is
//    `nboda3230`, the database `postgres` exists, the ROLE does not, and the connection fails.
//
//    `-U postgres` is therefore not a tidy-up. It is the difference between a harness that proves
//    something on one machine by coincidence and one that proves it on every machine by instruction.
//
// ── AND THE THIRD, WHICH IS THE ONE THAT MATTERED ───────────────────────────
//
//   A check that did not run must never be reported as a check that passed.
//
// `notExecuted()` exits 3 — a code reserved for "this did not execute". Preflight's aggregator
// treats it as its own verdict, INCOMPLETE, which is NOT exit 0. The reason it is an exit code and
// not a line of output is the rule this repo was rebuilt around: a checker's verdict is its exit
// status, because output can be filtered, tailed and skimmed, and a number cannot.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Reserved exit code: the harness could not run, so it is asserting NOTHING. Distinct from 0
// (proved) and from 1 (disproved). Anything that grows a fourth meaning needs a fourth code.
const EXIT_NOT_EXECUTED = 3;

// Every place a Postgres server binary is known to live. Linux distribution packages, Homebrew on
// Apple Silicon (/opt/homebrew) and on Intel (/usr/local), MacPorts, and the Postgres.app bundle.
// Newest version first, so a machine with several gets the newest.
const BIN = [
  '/usr/lib/postgresql/18/bin',
  '/usr/lib/postgresql/17/bin',
  '/usr/lib/postgresql/16/bin',
  '/usr/lib/postgresql/15/bin',
  '/usr/lib/postgresql/14/bin',
  '/usr/pgsql-18/bin',
  '/usr/pgsql-17/bin',
  '/usr/pgsql-16/bin',
  '/opt/homebrew/opt/postgresql@18/bin',
  '/opt/homebrew/opt/postgresql@17/bin',
  '/opt/homebrew/opt/postgresql@16/bin',
  '/opt/homebrew/opt/postgresql@15/bin',
  '/opt/homebrew/bin',
  '/usr/local/opt/postgresql@18/bin',
  '/usr/local/opt/postgresql@17/bin',
  '/usr/local/opt/postgresql@16/bin',
  '/usr/local/opt/postgresql@15/bin',
  '/opt/local/lib/postgresql16/bin',
  '/Applications/Postgres.app/Contents/Versions/latest/bin',
  '/usr/local/bin',
  '/usr/bin',
];

// ── THE PRESENCE OF initdb DOES NOT MEAN A SERVER IS INSTALLED ─────────────
//
// Homebrew's `libpq` formula is the CLIENT library, and it ships psql, pg_dump, pg_restore AND
// initdb — but no `postgres`. It is commonly linked into /opt/homebrew/bin, which is in BIN. So a
// test for initdb alone selects a directory that cannot run a database:
//
//   initdb: error: program "postgres" is needed by initdb but was not found in the same
//           directory as "/opt/homebrew/Cellar/libpq/18.3/bin/initdb"
//
// That is from the CEO's Mac, and it is why the restore verification selected a toolchain that had
// just proved it could read a 1.16 archive and then could not start a cluster at all. The machine
// genuinely had both halves of the problem: client tools new enough to read the dump with no
// server, and a server (postgresql@16) too old to read it.
//
// A usable cluster toolchain needs all three binaries startCluster actually invokes. Checking for
// the one that gives the directory its name was the whole mistake.
const CLUSTER_BINARIES = ['initdb', 'postgres', 'pg_ctl'];
function canStartACluster(dir) {
  return !!dir && CLUSTER_BINARIES.every((b) => fs.existsSync(path.join(dir, b)));
}

// The directory holding a COMPLETE server toolchain, or null. The PATH fallback matters: a Homebrew
// `brew link`ed install, a pgenv/asdf shim or a container image can put initdb somewhere no list
// predicts, and a list that cannot be completed is a list that will silently fail to find a server
// again.
function pgBin() {
  for (const d of BIN) if (canStartACluster(d)) return d;
  try {
    const p = execFileSync('which', ['initdb'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const dir = path.dirname(p.trim());
    return canStartACluster(dir) ? dir : null;
  } catch (_) { return null; }
}

// Directories that hold client tools but no server — reported separately so a person is not left
// wondering why the obvious one was passed over.
function pgClientOnlyDirs() {
  const out = [];
  const seen = new Set();
  const add = (d) => {
    if (!d || seen.has(d)) return;
    seen.add(d);
    if (fs.existsSync(path.join(d, 'pg_restore')) && !canStartACluster(d)) out.push(d);
  };
  for (const d of BIN) add(d);
  try {
    const p = execFileSync('which', ['pg_restore'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    add(path.dirname(p.trim()));
  } catch (_) { /* nothing on PATH */ }
  return out;
}

// EVERY installed toolchain, newest-first, not just the first one found.
//
// pgBin() returns one directory and that is right for a harness building a database from scratch:
// any version will do. It is WRONG for restoring a dump, because a dump can only be read by a
// pg_restore at least as new as the pg_dump that wrote it, and these are independent choices on a
// developer machine. On the CEO's Mac `pg_dump` on PATH was PostgreSQL 17 while pgBin() returned a
// versioned Homebrew keg of 16 — which outranks the unversioned /opt/homebrew/bin in BIN — so a
// 24.92 MiB production backup came back as `unsupported version (1.16) in file header`.
//
// A caller that needs a specific capability must be able to TEST each candidate rather than trust
// the ordering, so this returns all of them. Deduped, because /opt/homebrew/bin and a keg can be the
// same install reached two ways, and probing one twice would report the same answer twice.
function pgBinCandidates() {
  const found = [];
  const seen = new Set();
  const add = (d) => {
    if (!d || seen.has(d) || !canStartACluster(d)) return;
    seen.add(d);
    found.push(d);
  };
  for (const d of BIN) add(d);
  try {
    const p = execFileSync('which', ['initdb'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    add(path.dirname(p.trim()));
  } catch (_) { /* nothing on PATH */ }
  return found;
}

// `initdb -A trust -U postgres`. Named so a harness cannot half-apply it, and so the discipline test
// can assert that no harness assembles its own initdb invocation.
const INITDB_FLAGS = '-A trust -U postgres';

// Report that this check did not execute, and say so with the exit code rather than only in prose.
function notExecuted(reason) {
  console.log(`SKIP  ${reason}`);
  console.log('      This check asserted NOTHING. It is not a pass.');
  process.exit(EXIT_NOT_EXECUTED);
}

module.exports = {
  BIN,
  pgBin,
  pgBinCandidates,
  pgClientOnlyDirs,
  canStartACluster,
  INITDB_FLAGS,
  EXIT_NOT_EXECUTED,
  notExecuted,
};
