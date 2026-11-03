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
  '/usr/lib/postgresql/17/bin',
  '/usr/lib/postgresql/16/bin',
  '/usr/lib/postgresql/15/bin',
  '/usr/lib/postgresql/14/bin',
  '/usr/pgsql-17/bin',
  '/usr/pgsql-16/bin',
  '/opt/homebrew/opt/postgresql@17/bin',
  '/opt/homebrew/opt/postgresql@16/bin',
  '/opt/homebrew/opt/postgresql@15/bin',
  '/opt/homebrew/bin',
  '/usr/local/opt/postgresql@17/bin',
  '/usr/local/opt/postgresql@16/bin',
  '/usr/local/opt/postgresql@15/bin',
  '/opt/local/lib/postgresql16/bin',
  '/Applications/Postgres.app/Contents/Versions/latest/bin',
  '/usr/local/bin',
  '/usr/bin',
];

// The directory holding initdb, or null. The PATH fallback matters: a Homebrew `brew link`ed
// install, a pgenv/asdf shim or a container image can put initdb somewhere no list predicts, and a
// list that cannot be completed is a list that will silently fail to find a server again.
function pgBin() {
  for (const d of BIN) if (fs.existsSync(path.join(d, 'initdb'))) return d;
  try {
    const p = execFileSync('which', ['initdb'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const dir = path.dirname(p.trim());
    return dir && fs.existsSync(path.join(dir, 'initdb')) ? dir : null;
  } catch (_) { return null; }
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

module.exports = { BIN, pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED, notExecuted };
