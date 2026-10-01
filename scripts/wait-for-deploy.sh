#!/usr/bin/env bash
# Wait until the DEPLOYED commit is the one you just pushed — not until "uptime looks low".
#
# The uptime heuristic reports a false pass: a container that restarted for the previous deploy also has a
# low uptime, so a verification run straight afterwards asks old code and believes the answer. That cost a
# round trip and produced a wrong "still broken in production" report.
#
# ── AND IT USED TO REPORT A FALSE *FAIL*, WHICH IS JUST AS BAD ────────────────
#
# The comparison was `[ "$LIVE" = "$WANT" ]`, exact string equality. /health returns the FULL 40-character
# sha; `git log --oneline` gives you seven characters, and this script's own usage line invites a bare
# `[sha]`. So `wait-for-deploy.sh 2319b8a` could never match — it spun for 20 minutes and then exited 1
# on a deploy that had been live the whole time, printing `live 2319b8abb825, want 2319b8a` 120 times
# while the two plainly agreed. Caught on 2026-10-01.
#
# That is the same class of error as the uptime heuristic, in the other direction: a readiness check whose
# answer does not mean what it says. A false FAIL here is slightly less dangerous than a false PASS and
# considerably more corrosive, because the fix somebody reaches for is to stop running it.
#
# A PREFIX now matches, in either direction, with a minimum of 7 characters so a one-character argument
# cannot match every deploy.
#
# Usage:  scripts/wait-for-deploy.sh [sha] [base-url]
set -euo pipefail
WANT="${1:-$(git rev-parse HEAD)}"
BASE="${2:-https://app.playnexa.ai}"

# Refuse an argument that cannot be a commit, rather than waiting 20 minutes to say so.
if ! printf '%s' "$WANT" | grep -qE '^[0-9a-fA-F]{7,40}$'; then
  echo "FAIL  '$WANT' is not a commit sha (need 7-40 hex characters)" >&2
  exit 2
fi
WANT=$(printf '%s' "$WANT" | tr 'A-F' 'a-f')

echo "waiting for ${WANT:0:12} at $BASE"
for i in $(seq 1 120); do
  LIVE=$(curl -fsS -m 15 "$BASE/health" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("commit") or "")' 2>/dev/null || true)
  # Either may be the shorter of the two: we may be given a short sha, and /health could one day return one.
  if [ -n "$LIVE" ]; then
    case "$LIVE" in "$WANT"*) echo "live: ${LIVE:0:12} ✅"; exit 0;; esac
    case "$WANT" in "$LIVE"*) echo "live: ${LIVE:0:12} ✅"; exit 0;; esac
  fi
  if [ -z "$LIVE" ]; then
    # Says what actually happened. The old message claimed to be "falling back to uptime" and then did
    # nothing of the kind — it slept and retried, which is right, but a message that describes a different
    # strategy sends the next person looking for code that is not there. An empty answer is also what an
    # unreachable host looks like, which is worth naming because it is not a slow deploy.
    echo "  no commit from $BASE/health — not deployed yet, or the host is unreachable from here"
    sleep 10
    continue
  fi
  printf '  live %s, want %s\n' "${LIVE:0:12}" "${WANT:0:12}"
  sleep 10
done
echo "TIMED OUT — the deploy did not reach $WANT" >&2
exit 1
