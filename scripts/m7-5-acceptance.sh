#!/usr/bin/env bash
# ── M7.5 HARDWARE ACCEPTANCE — RUNS ON THE MAC MINI, NOWHERE ELSE ───────────
#
#   WORKER_API_BASE_URL=https://<dev-host> ./scripts/m7-5-acceptance.sh
#
# Every step prints the exact command, runs it, records the exit code, and writes all of it to a
# transcript. That is the point: the acceptance record is produced BY the run, not transcribed from
# it afterwards, because a hand-written record of a test is a statement about the writer.
#
# ── WHAT THIS SCRIPT IS FOR ─────────────────────────────────────────────────
#
# It was written on Linux and has NEVER been executed on macOS. It is the instrument, not the
# result. Until it runs on the Mac mini and produces a transcript, M7.5 has not begun. Expect it to
# fail somewhere on the first run; a first run on real hardware that passes cleanly usually means
# the test did not reach the hardware.
#
# ── IT WILL NOT TOUCH PRODUCTION ────────────────────────────────────────────
#
# It refuses outright if WORKER_API_BASE_URL names a production host, and it never takes a database
# URL. The server-side half of the scenario tests lives in scripts/m7-5-dev-driver.js, which runs on
# the DEVELOPMENT server and has its own refusal.
#
# EXIT 0 every executed step passed · 1 a step failed · 2 refused to start

set -uo pipefail

LABEL="ai.playnexa.worker"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/playnexa-worker"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
CTL="$REPO/installer/macos/workerctl"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TRANSCRIPT="$HOME/m7-5-acceptance-${STAMP}.log"

pass=0; fail=0; manual=0; notrun=0

say()  { printf '%s\n' "$*" | tee -a "$TRANSCRIPT"; }
head2() { say ""; say "── $* ──"; say ""; }

# Runs a command, records it verbatim with its exit code, and judges it against an expected code.
# `expect` of '*' means "any exit code is information, not a verdict".
step() {
  local name="$1" expect="$2"; shift 2
  say "\$ $*"
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  [ -n "$out" ] && printf '%s\n' "$out" | sed 's/^/    /' | tee -a "$TRANSCRIPT" >/dev/null
  [ -n "$out" ] && printf '%s\n' "$out" | sed 's/^/    /'
  say "  exit=$rc (expected $expect)"
  if [ "$expect" = "*" ]; then say "  INFO  $name"; return 0; fi
  if [ "$rc" = "$expect" ]; then pass=$((pass+1)); say "  PASS  $name"; return 0; fi
  fail=$((fail+1)); say "  FAIL  $name"; return 1
}

# A step a human must perform. Recorded as MANUAL, never as PASS: nobody should be able to read
# this transcript and think a reboot was tested when somebody only said it was.
ask() {
  local name="$1" instruction="$2"
  manual=$((manual+1))
  say ""
  say "  MANUAL STEP — $name"
  say "  $instruction"
  printf '  type the observed result, then return: '
  local answer; IFS= read -r answer
  say "  operator observed: ${answer:-<nothing entered>}"
}

skip() { notrun=$((notrun+1)); say "  NOT RUN  $1"; [ -n "${2:-}" ] && say "           $2"; }

# ── REFUSALS BEFORE ANYTHING RUNS ───────────────────────────────────────────

if [ "$(uname -s)" != "Darwin" ]; then
  printf 'REFUSED: this is %s, not Darwin.\n' "$(uname -s)" >&2
  printf 'M7.5 is hardware acceptance. Running it anywhere but the Mac mini would produce a\n' >&2
  printf 'transcript that LOOKS like hardware evidence and is not.\n' >&2
  exit 2
fi

BASE="${WORKER_API_BASE_URL:-}"
[ -n "$BASE" ] || { printf 'REFUSED: set WORKER_API_BASE_URL to the DEVELOPMENT API.\n' >&2; exit 2; }

case "$BASE" in
  https://*) ;;
  *) printf 'REFUSED: the base URL must be https:// — M7.5 requires certificate verification.\n' >&2; exit 2 ;;
esac
# Named explicitly rather than pattern-matched on "prod": a host list is auditable and a substring
# rule is a guess. Add dev hosts here, never remove production ones.
for forbidden in app.playnexa.ai playbook.abiozen.com playbookos-production.up.railway.app abiozen.com; do
  case "$BASE" in
    *"$forbidden"*)
      printf 'REFUSED: %s is production. M7.5 runs against an isolated development environment.\n' "$forbidden" >&2
      exit 2 ;;
  esac
done

if [ "$(id -u)" = "0" ]; then printf 'REFUSED: do not run this as root.\n' >&2; exit 2; fi
if id -Gn 2>/dev/null | tr ' ' '\n' | grep -qx admin; then
  printf 'REFUSED: %s is in the admin group. M7.5 accepts a DEDICATED NON-ADMIN account.\n' "$(id -un)" >&2
  printf 'Running it as an admin would accept a configuration nobody intends to deploy.\n' >&2
  exit 2
fi

: > "$TRANSCRIPT"
say "M7.5 HARDWARE ACCEPTANCE — $STAMP"
say "transcript : $TRANSCRIPT"
say "dev API    : $BASE"
say "repo       : $REPO"
say "commit     : $(cd "$REPO" && git rev-parse HEAD 2>/dev/null || echo 'not a git checkout')"

# ── 1. THE ACCOUNT AND THE MACHINE ──────────────────────────────────────────
head2 "1. the account and the machine"
step "macOS is reporting itself"            0 uname -a
step "node is present"                      0 node --version
step "the account is not root"              0 sh -c '[ "$(id -u)" != 0 ]'
step "the account is NOT in the admin group" 0 sh -c '! id -Gn | tr " " "\n" | grep -qx admin'
step "the account has no sudo rights"        1 sh -c 'sudo -n true 2>/dev/null'
say ""
say "  Recorded for the posture decision, not judged here:"
step "FileVault state"                       '*' sh -c 'fdesetup status 2>/dev/null || echo "fdesetup needs admin; ask the owner"'
step "automatic login setting"               '*' sh -c 'defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || echo "no autoLoginUser set"'
step "this account is not an inbound SSH user" '*' sh -c 'systemsetup -getremotelogin 2>/dev/null || echo "systemsetup needs admin; ask the owner"'

# ── 2. INSTALL ──────────────────────────────────────────────────────────────
head2 "2. install, and the plist it writes"
WID="${WORKER_ID:-}"
if [ -z "$WID" ]; then
  skip "install" "WORKER_ID is not set. Mint an identity on the dev server first (m7-5-dev-driver.js mint)."
else
  step "workerctl install"                   0 "$CTL" install "$BASE" "$WID"
  step "the plist exists"                    0 test -f "$PLIST"
  step "the plist is valid"                  0 plutil -lint "$PLIST"
  step "the plist contains NO credential"    1 grep -qiE 'secret|password|token' "$PLIST"
  step "it carries only the three env keys"  0 sh -c "/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables' '$PLIST' | grep -cE 'WORKER_API_BASE_URL|WORKER_ID|NODE_ENV' | grep -qx 3"
  step "launchctl sees it"                   0 sh -c "launchctl print gui/\$(id -u)/${LABEL} >/dev/null"
  step "workerctl status reports it"         '*' "$CTL" status
fi

# ── 3. ENROLMENT AND CREDENTIAL PERSISTENCE ─────────────────────────────────
head2 "3. Keychain enrolment and credential persistence"
if [ -z "$WID" ]; then
  skip "enrolment" "no WORKER_ID"
else
  say "  The token is pasted at the prompt and is NOT echoed, NOT in argv, NOT in shell history."
  say "  Mint it on the dev server: node scripts/m7-5-dev-driver.js mint"
  ask "enroll" "run:  $CTL enroll $WID    — paste the token when asked. Report the final line."
  step "a Keychain item now exists"          0 sh -c "security find-generic-password -s ${LABEL} >/dev/null 2>&1"
  step "and its value is NOT printed by that lookup" 1 \
    sh -c "security find-generic-password -s ${LABEL} 2>/dev/null | grep -q 'password:'"
  step "doctor sees the credential without reading it" 0 "$CTL" doctor
  say ""
  say "  Persistence across a process restart (the weakest of the three, but free):"
  step "restart the worker"                  0 "$CTL" restart
  sleep 5
  step "it is running after the restart"     0 sh -c "launchctl print gui/\$(id -u)/${LABEL} 2>/dev/null | grep -qE 'state = running|pid = '"
fi

# ── 4. OUTBOUND HTTPS WITH VERIFICATION ─────────────────────────────────────
head2 "4. outbound HTTPS, certificate verification ON"
# The forbidden flags are deliberately NOT spelled out in the line below: scripts/check-m7-5-guards.js
# scans this file for them and cannot tell a quoted string from a command, which is the correct
# direction for that scanner to be blunt in. The rule is in its header instead.
say "  Certificate verification stays ON for every request here. A test that turns it off tests"
say "  nothing: it proves the socket opened, which was never in doubt."
HOSTPORT="$(printf '%s' "$BASE" | sed -e 's|https://||' -e 's|/.*||')"
step "the certificate chain verifies"        0 sh -c "echo | openssl s_client -connect ${HOSTPORT}:443 -servername ${HOSTPORT} -verify_return_error 2>&1 | grep -q 'Verify return code: 0'"
step "curl reaches it WITHOUT -k"            0 sh -c "curl -sS -o /dev/null -w '%{http_code}\n' '${BASE}/health'"
step "node's own TLS stack verifies it"      0 node -e "
  const https=require('https');const u=new URL(process.argv[1]);
  https.get({host:u.hostname,path:'/health',rejectUnauthorized:true},r=>{console.log('HTTP',r.statusCode);process.exit(0)})
    .on('error',e=>{console.error(String(e.message));process.exit(1)});" "$BASE"
step "and verification is NOT disabled in the environment" 1 \
  sh -c '[ -n "${NODE_TLS_REJECT_UNAUTHORIZED:-}" ] && [ "$NODE_TLS_REJECT_UNAUTHORIZED" != "1" ]'

# ── 5. NO INBOUND PORTS, NO PROVIDER CREDENTIALS ────────────────────────────
head2 "5. the worker listens for nothing and holds nothing"
PID="$(launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | sed -n 's/.*pid = \([0-9]*\).*/\1/p' | head -1)"
if [ -z "$PID" ]; then
  skip "inbound port and credential inspection" "the worker is not running; no pid to inspect"
else
  say "  worker pid: $PID"
  step "it holds NO listening socket"        1 sh -c "lsof -nP -p ${PID} -iTCP -sTCP:LISTEN 2>/dev/null | grep -q LISTEN"
  step "its only sockets are outbound"       '*' sh -c "lsof -nP -p ${PID} -iTCP 2>/dev/null || echo '(none)'"
  step "its environment has no provider credential" 1 \
    sh -c "ps eww ${PID} 2>/dev/null | grep -qiE 'RESEND|TWILIO|ANTHROPIC|OPENAI|APOLLO|LINKEDIN|ALGOLIA|DATABASE_URL|_KEY=|_SECRET=|_TOKEN='"
  step "its environment has no DATABASE_URL" 1 sh -c "ps eww ${PID} 2>/dev/null | grep -q 'DATABASE_URL'"
  say ""
  say "  And the machine as a whole, for the record:"
  step "inbound listeners owned by this account" '*' sh -c "lsof -nP -iTCP -sTCP:LISTEN -u \$(id -un) 2>/dev/null || echo '(none)'"
fi

# ── 6. LAUNCHCTL LIFECYCLE ──────────────────────────────────────────────────
head2 "6. launchctl bootstrap / kickstart / bootout, and idempotency"
if [ -z "$WID" ]; then
  skip "lifecycle" "no WORKER_ID"
else
  step "stop (bootout)"                      0 "$CTL" stop
  step "it is gone from the GUI domain"      1 sh -c "launchctl print gui/\$(id -u)/${LABEL} >/dev/null 2>&1"
  step "stop again is harmless"              0 "$CTL" stop
  step "install again (bootout-then-bootstrap)" 0 "$CTL" install "$BASE" "$WID"
  step "install a THIRD time is still clean" 0 "$CTL" install "$BASE" "$WID"
  step "it is loaded"                        0 sh -c "launchctl print gui/\$(id -u)/${LABEL} >/dev/null"
  step "kickstart"                           0 "$CTL" start
  step "logs exist and are being written"    0 test -s "$LOG_DIR/worker.log"
  step "workerctl logs reads them"           0 "$CTL" logs 20
fi

# ── 7. UNINSTALL AND REINSTALL ──────────────────────────────────────────────
head2 "7. uninstall, then reinstall"
if [ -z "$WID" ]; then
  skip "uninstall" "no WORKER_ID"
else
  step "uninstall"                           0 "$CTL" uninstall
  step "the plist is gone"                   1 test -f "$PLIST"
  step "the logs are deliberately LEFT"      0 test -d "$LOG_DIR"
  step "the Keychain item is deliberately LEFT" 0 sh -c "security find-generic-password -s ${LABEL} >/dev/null 2>&1"
  say "  (revocation on the server is what ends access; deleting the local copy only stops it working)"
  step "uninstall again is harmless"         0 "$CTL" uninstall
  step "reinstall works"                     0 "$CTL" install "$BASE" "$WID"
  step "and the retained credential still authenticates" 0 "$CTL" doctor
fi

# ── 8. LOGOUT AND REBOOT — THE 24/7 QUESTION ────────────────────────────────
head2 "8. logout and reboot"
say "  READ THE M7.5 REPORT BEFORE THIS SECTION. A per-user LaunchAgent is expected to STOP at"
say "  logout and NOT to start after a reboot without automatic login. These steps are here to"
say "  CONFIRM that on the hardware, not to discover it. If the worker survives a logout, the"
say "  architecture is not what this repo believes it is and that is the finding."
ask "logout" "Log out of this account entirely (do not just close the terminal). Log back in. Then run: $CTL status — did the worker keep running while logged out, and is it running now?"
ask "reboot" "Reboot the Mac mini. Do NOT log in. Wait 3 minutes. From the dev server, check whether this worker claimed anything (node scripts/m7-5-dev-driver.js watch). Report: did it come back without a login?"
ask "reboot + login" "Now log in as this account. Run: $CTL status — did it start on login, and how long did that take?"

# ── 9. END-TO-END AND THE FAILURE SCENARIOS ─────────────────────────────────
head2 "9. synthetic.echo end to end, and the six failure scenarios"
say "  These need the dev SERVER to act — enqueue, cancel, STOP, revoke, expire. The driver that"
say "  does that half runs there, not here:"
say ""
say "      node scripts/m7-5-dev-driver.js scenarios --worker $WID"
say ""
say "  Run it on the dev server while this worker is running, then paste its verdict below. It is a"
say "  separate script on a separate machine on purpose: a test where one process plays both the"
say "  worker and the server proves the two halves agree with themselves."
ask "end-to-end and scenarios" "Run the driver on the dev server and report its final PASS/FAIL line and exit code."

# ── VERDICT ─────────────────────────────────────────────────────────────────
say ""
say "────────────────────────────────────────────────────────────────────────────"
say "  automated steps : $pass passed, $fail failed"
say "  manual steps    : $manual recorded (NOT counted as passes)"
say "  not run         : $notrun"
say "  transcript      : $TRANSCRIPT"
say "────────────────────────────────────────────────────────────────────────────"
if [ "$fail" -gt 0 ]; then
  say "FAIL  $fail automated step(s) failed on this hardware. M7.5 is not accepted."
  exit 1
fi
if [ "$notrun" -gt 0 ]; then
  say "INCOMPLETE  $notrun step(s) did not run. M7.5 is not accepted on a partial transcript."
  exit 1
fi
say "automated steps all passed. ACCEPTANCE IS STILL NOT COMPLETE until the manual results above"
say "and the dev-driver verdict are reviewed — this script cannot judge a reboot for you."
exit 0
