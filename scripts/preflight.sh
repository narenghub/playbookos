#!/usr/bin/env bash
# ── EVERYTHING THAT MUST PASS BEFORE A PUSH. ONE VERDICT: THE EXIT CODE. ───────
#
#   scripts/preflight.sh   →  exit 0 = safe to push.  Anything else = do not push.
#
# Run this ON ITS OWN. Then read the exit code. Then decide to push, as a separate command.
#
# WHY IT IS ONE SCRIPT: on 2026-09-30 I broke production twice in one session by reading the tail of a
# multi-line report instead of its verdict — once with `spa-check.js | tail -1` (block 1 was broken, block 6
# said OK), and again by putting the test suite and `git push` in a single `&&` chain and reading the last
# line. A run whose result is a number cannot be misread that way.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/.."
FAILED=()

step () {                      # step <name> <command...>
  local name="$1"; shift
  if "$@" >/tmp/preflight-step.log 2>&1; then
    echo "  ok    $name"
  else
    echo "  FAIL  $name"
    tail -25 /tmp/preflight-step.log | sed 's/^/          /'
    FAILED+=("$name")
  fi
}

echo "── preflight"
# The suite. --test exits non-zero if any test fails, which is the only signal that matters.
step "test suite" env JWT_SECRET=preflight node --test $(find src scripts -name '*.test.js')
step "SPA parses (local file)" node scripts/check-spa-parse.js
step "classic nav parity" node scripts/verify-classic-nav-parity.js
# Executes the shipped molecule-search SQL on a real Postgres. The parsers above cannot tell whether
# a query RUNS — `column "name" does not exist` shipped past all of them once. SKIPs cleanly (exit 0)
# where no server is available, so this never blocks a laptop without Postgres installed.
step "molecule search runs on Postgres" node scripts/check-molecule-search-sql.js

if [ ${#FAILED[@]} -ne 0 ]; then
  echo "FAIL  ${#FAILED[@]} check(s) failed: ${FAILED[*]}" >&2
  echo "      DO NOT PUSH." >&2
  exit 1
fi
echo "PASS  safe to push — then run scripts/smoke-deployed.sh as its own command"
