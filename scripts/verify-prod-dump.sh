#!/usr/bin/env bash
# ── VERIFY THE MIGRATION AGAINST A REAL PRODUCTION DUMP ──────────────────────
#
#   scripts/verify-prod-dump.sh ~/Downloads/prod-20261106.dump
#   echo $?
#
# Ruling 29 item 3. One command. It restores the dump into a DISPOSABLE local cluster, runs the
# migration against production's actual schema, and reports what changed.
#
# ── IT CANNOT TOUCH PRODUCTION ───────────────────────────────────────────────
#
# There is no connection string in this file and it reads none from the environment. The only
# database it talks to is one it creates in a temp directory, listening on a unix socket with no
# TCP port, destroyed when the run ends. Point it at a dump; it cannot reach the server the dump
# came from.
#
# ── WHY YOU RUN THIS AND NOT ME ──────────────────────────────────────────────
#
# A production dump contains every row in the database — including password hashes, customer and
# supplier records, and the contents of every table. Uploading one into a chat session puts all of
# that somewhere it does not need to be. Running it on your own machine keeps the data on your
# machine; the OUTPUT is a few dozen lines with no secrets in it, and that is all I need.
#
# ── WHAT YOU NEED ────────────────────────────────────────────────────────────
#
#   • Node 18+        (you have it — this repo runs on it)
#   • PostgreSQL 15/16 client AND server tools: initdb, pg_ctl, pg_restore, createdb
#       macOS:  brew install postgresql@16
#       check:  which initdb pg_restore
#
# Exit: 0 verified · 1 a check failed · 2 bad usage · 3 could not run

set -uo pipefail

# The repository this script lives in — resolved from $0, never from the caller's working directory,
# which is the whole point: the operator's `cd` is exactly what failed on 2026-11-06.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

DUMP="${1:-}"

if [ -z "$DUMP" ]; then
  cat <<'USAGE'

Usage: scripts/verify-prod-dump.sh <path-to-dump>

Get the dump WITHOUT touching production:

  1. railway.app  ->  your project  ->  the Postgres service
  2. "Backups" tab  ->  create a backup if there is none from today
  3. download it  ->  note where it saved

  (Railway's backup is a read operation. It does not modify the database.)

Or, from the CLI — this is the route that worked on 2026-11-06:

  railway link        # pick the project, then the Postgres service
  railway run bash -c 'pg_dump --format=custom "$DATABASE_PUBLIC_URL" > ~/Downloads/playbookos-prod.dump'

  DATABASE_PUBLIC_URL, not DATABASE_URL. "railway run" executes LOCALLY, so
  postgres.railway.internal does not resolve from a laptop. pg_dump is a read.

Then:

  scripts/verify-prod-dump.sh ~/Downloads/<the-file>
  echo $?

Send me the output. It contains no secrets — table names, row counts and verdicts only.

USAGE
  exit 2
fi

if [ ! -f "$DUMP" ]; then
  echo "verify-prod-dump: no such file: $DUMP" >&2
  exit 2
fi

# Find the toolchain the same way every harness in this repo does, rather than assuming a path.
for d in /usr/lib/postgresql/16/bin /usr/lib/postgresql/15/bin \
         /opt/homebrew/opt/postgresql@16/bin /opt/homebrew/opt/postgresql@15/bin \
         /usr/local/opt/postgresql@16/bin /usr/local/bin /usr/bin; do
  if [ -x "$d/initdb" ] && [ -x "$d/pg_restore" ]; then BIN="$d"; break; fi
done
if [ -z "${BIN:-}" ]; then
  if command -v initdb >/dev/null 2>&1 && command -v pg_restore >/dev/null 2>&1; then
    BIN="$(dirname "$(command -v initdb)")"
  else
    cat <<'MISSING' >&2

verify-prod-dump: PostgreSQL server tools not found (initdb / pg_restore).

  macOS:   brew install postgresql@16
  Ubuntu:  sudo apt-get install postgresql-16

This did NOT run. That is not a pass.

MISSING
    exit 3
  fi
fi

echo "  toolchain: $BIN"
echo "  dump:      $DUMP ($(wc -c <"$DUMP" | tr -d ' ') bytes)"

# ── WHICH CODE IS THIS? (ruling 34 item 1) ────────────────────────────────────
#
# On 2026-11-06 this was run after `cd ~/Downloads/playbookos && git pull` FAILED — the directory
# did not exist, so the `cd` errored, the `git pull` never happened, and the script ran from an older
# checkout somewhere else. It reported the exact failure that had already been fixed, and the only
# evidence anywhere in 80 lines of output was one parenthesis: "(47 schema steps declared)" where the
# current chain has 53.
#
# A verification that cannot say which code it is must not be trusted to say anything else, so it says
# so first, every time, unmissably. The step count is read from the migrator itself, so it cannot drift
# from what will actually run.
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(not a git checkout)')"
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '(unknown)')"
DIRTY="$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
STEPS="$(cd "$ROOT" && node -e 'process.stdout.write(String(require("./src/lib/migrate-all").SCHEMA_STEPS.length))' 2>/dev/null || echo '?')"

echo "  repo:      $ROOT"
echo "  branch:    $BRANCH @ $COMMIT$( [ "$DIRTY" != "0" ] && echo "  (${DIRTY} uncommitted change(s))" )"
# The expected count lives in ONE file, and scripts/doc-step-counts.test.js fails the build if it
# disagrees with SCHEMA_STEPS. A number typed into this script would go stale the next time the chain
# grows — which is what happened to eight documents in two days.
EXPECT="$(tr -d ' \n' <"$ROOT/scripts/expected-schema-steps.txt" 2>/dev/null || echo '?')"

echo "  chain:     $STEPS schema steps  <-- if this is not $EXPECT, you are running an OLD checkout"
echo ""

if [ "$STEPS" != "?" ] && [ "$EXPECT" != "?" ] && [ "$STEPS" -lt "$EXPECT" ] 2>/dev/null; then
  cat <<STALE >&2
──────────────────────────────────────────────────────────────────────────────
STOP — this checkout has $STEPS migration steps. The current chain has $EXPECT.

You are running code from before the fixes. A result from it says nothing about
whether the migration is ready, and its failures are ones already fixed.

  1. Find your working copy:   ls -d ~/playbookos ~/Downloads/playbookos ~/Desktop/playbookos 2>/dev/null
                               (or: git -C . remote -v  from wherever this ran)
  2. In THAT directory:        git pull
  3. Confirm:                  node scripts/migrate.js --plan | head -3
                               must say "53 schema step(s)"
  4. Re-run this script from there.

Nothing has been restored, migrated or changed. This did NOT run.
──────────────────────────────────────────────────────────────────────────────
STALE
  exit 3
fi

# The readiness harness creates and destroys its own cluster and takes the dump as its argument.
# Everything below is its work; this wrapper exists so the whole thing is one command.
cd "$(dirname "$0")/.." || exit 3
PATH="$BIN:$PATH" node scripts/verify-migration-readiness.js "$DUMP"
CODE=$?

echo ""
echo "  verify-migration-readiness exit code: $CODE"
if [ "$CODE" -ne 0 ]; then
  echo ""
  echo "  NOT verified. Send me everything above this line — the failing assertion names"
  echo "  the table or column, and that is what I need to fix it."
fi
exit $CODE
