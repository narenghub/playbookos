#!/usr/bin/env bash
# ── IS THE APPLICATION ALIVE? Not "is the server alive". ───────────────────────
#
# /health proves the process is up and the database answers. It does NOT prove the app renders. On
# 2026-09-30 /health returned 200 with db:connected for hours while the SPA rendered nothing, because a
# syntax error in an inline script had taken the whole front end down. Every monitor was green. That gap is
# what made the outage invisible.
#
# This closes it: wait for the expected commit to be live, then fetch the page a BROWSER gets and check that
# every inline script parses and the app's entry points are present.
#
# THE VERDICT IS THE EXIT CODE. Exit 0 = deployed and alive. Anything else = do not walk away.
#
#   scripts/smoke-deployed.sh [sha] [base-url]
#
# Run it as its own command, after a push, and READ THE EXIT CODE. Do not chain it with a push — the push is
# a separate decision made after reading this result.
set -uo pipefail

WANT="${1:-$(git rev-parse HEAD)}"
BASE="${2:-https://app.playnexa.ai}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "── smoke: ${WANT:0:12} at $BASE"

# 1. the right build has to be live first, or everything after this is about the wrong code
if ! "$HERE/wait-for-deploy.sh" "$WANT" "$BASE"; then
  echo "FAIL  the deploy never reached $WANT" >&2
  exit 1
fi

# 2. the server
HEALTH=$(curl -fsS -m 20 "$BASE/health" 2>/dev/null || true)
if [ -z "$HEALTH" ]; then echo "FAIL  /health did not answer" >&2; exit 1; fi
echo "  ok    /health: $(printf '%s' "$HEALTH" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(f"{d[\"status\"]}, db {d[\"db\"]}, up {int(d[\"uptime\"])}s")' 2>/dev/null || echo "$HEALTH")"

# 3. THE APPLICATION — the part /health cannot speak for
if ! node "$HERE/check-spa-parse.js" --url "$BASE/"; then
  echo "FAIL  the server is alive but the APPLICATION is not — the page will render nothing" >&2
  exit 1
fi

# 4. one authenticated read, so "renders" is backed by "and can fetch"
CODE=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$BASE/api/auth/me" || true)
if [ "$CODE" != "401" ]; then
  echo "FAIL  /api/auth/me returned $CODE without a token; expected 401" >&2
  exit 1
fi
echo "  ok    /api/auth/me refuses an anonymous caller (401), so the API stack is wired"

echo "PASS  ${WANT:0:12} is deployed and the application is alive"
