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

# ── IS THIS COMMIT EVEN SUPPOSED TO BE DEPLOYED? ──────────────────────────────
#
# WANT defaults to `git rev-parse HEAD`, which is right on main and wrong everywhere else. Run from
# a feature branch it waits for a commit that was never pushed to main and never will be — spinning
# for twenty minutes before exiting non-zero, correctly, for entirely the wrong reason. That
# happened on 2026-11-06: the migration had just been applied, the operator was on
# feat/prpa-phase2-sam-prep, and the instruction to run this came without a sha.
#
# A readiness check that makes someone wait twenty minutes to discover a typo in its own argument is
# the shape of a check people stop running. If the commit is not an ancestor of origin/main it is
# not going to be deployed by a push to main, and that is knowable in milliseconds.
#
# Deliberately advisory about its own limits: if git cannot answer — no repository, origin not
# fetched, a detached build environment — this says nothing and proceeds. A guard that refuses when
# it is merely uninformed is worse than no guard.
if git rev-parse --git-dir >/dev/null 2>&1 && git rev-parse --verify --quiet origin/main >/dev/null; then
  if git cat-file -e "${WANT}^{commit}" 2>/dev/null; then
    if ! git merge-base --is-ancestor "$WANT" origin/main 2>/dev/null; then
      echo "" >&2
      echo "REFUSED  ${WANT:0:12} is not an ancestor of origin/main, so a push to main will never" >&2
      echo "         deploy it. Waiting for it to go live would spin until the timeout." >&2
      echo "" >&2
      echo "         Currently on branch: $(git rev-parse --abbrev-ref HEAD)" >&2
      echo "         origin/main is at  : $(git rev-parse --short origin/main)" >&2
      echo "" >&2
      echo "         To smoke-test what IS deployed, name it:" >&2
      echo "           scripts/smoke-deployed.sh \$(git rev-parse --short origin/main)" >&2
      echo "" >&2
      echo "         This is not a statement about production — it is about the argument." >&2
      exit 2
    fi
  fi
fi

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
