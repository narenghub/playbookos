#!/usr/bin/env bash
# ── PREFLIGHT, CLOUD SCOPE — THE PUSH GATE, UNCHANGED ────────────────────────
#
#   scripts/preflight-cloud.sh   →  exit 0 = safe to push
#
# This runs `scripts/preflight.sh` with NO scope: every check, including the database, restore,
# deployment and SPA ones. It is a named entry point rather than a different gate, so that "the Mac
# preflight" and "the cloud preflight" can be reported as two results without anybody being able to
# mistake the smaller one for the whole.
#
# Run it where a local Postgres and `pg_restore` exist — the cloud container or a machine with them
# installed. On the worker hardware it will correctly report INCOMPLETE for ~75 checks, which is a
# true statement about that machine and not a failure of the tree. Use scripts/preflight-mac.sh
# there.
#
# The verdict rules are the aggregator's, not this file's:
#
#   PASS        every check ran and passed              exit 0  — and only this is safe to push
#   FAIL        at least one check disproved something  exit 1
#   INCOMPLETE  nothing failed, but n checks DID NOT EXECUTE   exit 2
#
# Read the exit code. Do not pipe this through `head`, `tail` or `grep` and treat what you see as
# the result, and do not chain it to a push with `&&`.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Explicitly empty, in case it is set in the caller's environment from a Mac-scope run. A cloud
# verdict inheriting a scope would be the worst of both: the full gate's wording over a subset's
# coverage.
PF_ONLY=''
PF_SCOPE_NAME=''
export PF_ONLY PF_SCOPE_NAME

echo "── preflight: CLOUD SCOPE (the full push gate) on $(uname -s) $(uname -m)"
exec "$HERE/preflight.sh"
