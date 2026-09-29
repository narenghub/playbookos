#!/usr/bin/env bash
# Wait until the DEPLOYED commit is the one you just pushed — not until "uptime looks low".
#
# The uptime heuristic reports a false pass: a container that restarted for the previous deploy also has a
# low uptime, so a verification run straight afterwards asks old code and believes the answer. That cost a
# round trip and produced a wrong "still broken in production" report.
#
# Usage:  scripts/wait-for-deploy.sh [sha] [base-url]
set -euo pipefail
WANT="${1:-$(git rev-parse HEAD)}"
BASE="${2:-https://app.playnexa.ai}"
echo "waiting for ${WANT:0:12} at $BASE"
for i in $(seq 1 120); do
  LIVE=$(curl -fsS "$BASE/health" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("commit") or "")' 2>/dev/null || true)
  if [ "$LIVE" = "$WANT" ]; then echo "live: ${LIVE:0:12} ✅"; exit 0; fi
  if [ -z "$LIVE" ]; then echo "  /health has no commit field yet (pre-dating this script) — falling back to uptime"; sleep 10; continue; fi
  printf '  live %s, want %s\n' "${LIVE:0:12}" "${WANT:0:12}"
  sleep 10
done
echo "TIMED OUT — the deploy did not reach $WANT" >&2
exit 1
