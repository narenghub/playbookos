#!/usr/bin/env bash
# ── IS THE SENDER SERVICE ALIVE, AND STILL REFUSING WHAT IT SHOULD? ───────────
#
#   scripts/smoke-sender-service.sh [sender-base-url]
#
# Run INSIDE the deployment, where the service is reachable, as its own command, and READ THE EXIT
# CODE. Final readiness item 5.
#
# ── WHAT THIS PROVES AND WHAT IT DOES NOT ─────────────────────────────────────
#
# It proves the service is up, authenticating, and refusing. It does NOT send anything, and it does
# NOT prove a message can be delivered — proving that requires sending one, which is not authorized
# and would not be a smoke test anyway.
#
# The distinction matters here more than usual. /health answering is the same shape of evidence that
# was green for hours on 2026-09-30 while the front end rendered nothing. So this asks the service
# to do its actual job — authenticate a request and refuse an unauthorized one — rather than asking
# whether its process is running.
#
# ── IT NEVER SENDS, AND THE REQUESTS IT MAKES CANNOT ──────────────────────────
#
# Two requests, both of which MUST be refused:
#   1. unsigned      → 401. If this succeeds, the service is unauthenticated and must be stopped.
#   2. badly signed  → 401. Proves the signature is actually verified, not merely required.
#
# Neither carries an approval or a digest, so even a service that wrongly accepted the signature
# would still refuse them at the approval check — the refusal is layered, and a 200 from either is
# a stop-everything finding.
#
# THE VERDICT IS THE EXIT CODE. 0 = alive and refusing. 1 = something is wrong. 3 = nothing proved.
set -uo pipefail

BASE="${1:-${SENDER_SERVICE_URL:-${SENDER_SERVICE_URL:-http://127.0.0.1:8081}}}"
BASE="${BASE%/}"

fail=0
ok()   { echo "  ok    $1"; }
bad()  { echo "  FAIL  $1"; [ -n "${2:-}" ] && echo "          $2"; fail=$((fail+1)); }
note() { echo "        $1"; }

echo "── sender service smoke: $BASE"
echo

# ── 1. IS IT THERE? ───────────────────────────────────────────────────────────
health="$(curl -fsS --max-time 10 "$BASE/health" 2>&1)" || {
  bad "GET /health did not answer" "$health"
  echo
  echo "INCOMPLETE  the service could not be reached, so nothing below was established."
  exit 3
}
ok "GET /health answered"
note "$health"

# The transports it serves must be the three this release expects. A service answering /health with
# an empty transport list is up and useless, and would refuse every send as "unknown transport".
for t in gmail_cphi gmail_outreach gmail_probe; do
  case "$health" in
    *"$t"*) ok "serves $t" ;;
    *)      bad "does NOT serve $t" "every dispatch naming it will be refused as an unknown transport" ;;
  esac
done

# ── 2. DOES IT REFUSE AN UNSIGNED REQUEST? ────────────────────────────────────
echo
body='{"message":{"to":"smoke@example.invalid","subject":"smoke","raw":"c21va2U","mailbox":"smoke@example.invalid"},"transport":"gmail_cphi","idempotencyKey":"smoke-unsigned"}'

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -X POST "$BASE/send" -H 'content-type: application/json' --data "$body" 2>/dev/null)"
if [ "$code" = "401" ]; then
  ok "POST /send unsigned → 401"
elif [ "$code" = "200" ]; then
  bad "POST /send unsigned → 200" \
    "THE SERVICE IS UNAUTHENTICATED. Anything that can reach it can ask it to send. Stop it."
else
  bad "POST /send unsigned → $code (expected 401)" \
    "it refused, but not as an authentication failure — check SENDER_SERVICE_SECRET is set"
fi

# ── 3. IS THE SIGNATURE ACTUALLY VERIFIED? ────────────────────────────────────
#
# A service that merely required the headers to be PRESENT would pass step 2 and fail here.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -X POST "$BASE/send" -H 'content-type: application/json' \
  -H 'x-sender-signature: 0000000000000000000000000000000000000000000000000000000000000000' \
  -H "x-sender-timestamp: $(( $(date +%s) * 1000 ))" \
  --data "$body" 2>/dev/null)"
if [ "$code" = "401" ]; then
  ok "POST /send with a wrong signature → 401"
elif [ "$code" = "200" ]; then
  bad "POST /send with a WRONG signature → 200" \
    "the signature is required but not verified. Stop the service."
else
  bad "POST /send with a wrong signature → $code (expected 401)"
fi

# ── 4. IS THE WRITE ENDPOINT GUARDED TOO? ─────────────────────────────────────
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -X POST "$BASE/write" -H 'content-type: application/json' \
  --data '{"op":"file_thread","params":{}}' 2>/dev/null)"
if [ "$code" = "401" ]; then
  ok "POST /write unsigned → 401"
else
  bad "POST /write unsigned → $code (expected 401)" \
    "the label-writing endpoint holds a write-capable Gmail credential"
fi

# ── 5. IS ANYTHING ELSE EXPOSED? ──────────────────────────────────────────────
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/" 2>/dev/null)"
if [ "$code" = "404" ]; then
  ok "GET / → 404, so only /health, /send and /write are served"
else
  bad "GET / → $code (expected 404)" "the service is serving something it was not built to serve"
fi

echo
if [ "$fail" -gt 0 ]; then
  echo "FAIL  $fail check(s) failed. The sender service must not be relied on in this state."
  exit 1
fi
echo "PASS  the sender service is alive, authenticating, and refusing. Nothing was sent."
echo "      This does NOT prove a message can be delivered — proving that requires sending one."
exit 0
