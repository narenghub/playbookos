# ── THE PREFLIGHT AGGREGATOR. THREE VERDICTS, AND ONLY ONE OF THEM IS ZERO. ───
#
# Sourced by preflight.sh. It lives in its own file for one reason: a negative control has to be able
# to drive it with synthetic exit codes and prove it reports what it should. An aggregator welded
# into the middle of a 90-step script cannot be tested, and the thing that went wrong on 2026-11-03
# was the aggregator, not any individual check.
#
# ── WHY THREE ──────────────────────────────────────────────────────────────
#
# The old aggregator asked one question: did any step exit non-zero? So "nothing failed" and
# "everything passed" were the same answer, and 31 of 44 steps on the CEO's Mac exited 0 having
# executed nothing. The word PASS was printed over a run that proved a third of what it claimed.
#
#   PASS        every step ran and every step passed            exit 0   — and only this
#   FAIL        at least one step ran and disproved something   exit 1
#   INCOMPLETE  nothing failed, but n steps DID NOT EXECUTE     exit 2
#
# A step signals non-execution with exit code 3 (pg-cluster.js EXIT_NOT_EXECUTED). Preflight does not
# infer it from output: output can be tailed, grepped and skimmed, and that is how 2026-09-30
# happened. An exit code cannot be partially read.
#
# ── WHY NO ARRAYS ──────────────────────────────────────────────────────────
#
# The previous aggregator used `FAILED=()` with `set -u`. On bash 3.2 — which is /bin/bash on every
# macOS — `${#FAILED[@]}` on an EMPTY array is an unbound-variable error. So the PASS branch would
# have died on the CEO's Mac with `FAILED: unbound variable`: the one branch that says "safe to push"
# was the one branch that had never executed there, because the Mac had never had a clean run. Names
# accumulate in newline-delimited strings, which behave identically on bash 3.2 and bash 5.

PF_FAIL_NAMES=''
PF_SKIP_NAMES=''
PF_PASS_N=0
PF_FAIL_N=0
PF_SKIP_N=0
PF_EXIT_NOT_EXECUTED=3
PF_LOG="${PF_LOG:-/tmp/preflight-step.log}"

# pf_step <name> <command...>
pf_step () {
  pf_name="$1"; shift
  if "$@" >"$PF_LOG" 2>&1; then
    pf_rc=0
  else
    pf_rc=$?
  fi
  if [ "$pf_rc" -eq 0 ]; then
    PF_PASS_N=$(( PF_PASS_N + 1 ))
    echo "  ok    $pf_name"
  elif [ "$pf_rc" -eq "$PF_EXIT_NOT_EXECUTED" ]; then
    PF_SKIP_N=$(( PF_SKIP_N + 1 ))
    PF_SKIP_NAMES="${PF_SKIP_NAMES}
  - $pf_name"
    echo "  SKIP  $pf_name  — DID NOT EXECUTE, asserted nothing"
    sed 's/^/          /' "$PF_LOG" | tail -4
  else
    PF_FAIL_N=$(( PF_FAIL_N + 1 ))
    PF_FAIL_NAMES="${PF_FAIL_NAMES}
  - $pf_name"
    echo "  FAIL  $pf_name"
    sed 's/^/          /' "$PF_LOG" | tail -25
  fi
}

# pf_verdict — prints the verdict and RETURNS the exit code the caller must exit with.
pf_verdict () {
  pf_total=$(( PF_PASS_N + PF_FAIL_N + PF_SKIP_N ))
  echo ''
  echo "── $pf_total checks: $PF_PASS_N executed and passed · $PF_FAIL_N failed · $PF_SKIP_N did not execute"
  if [ "$PF_FAIL_N" -ne 0 ]; then
    echo '' >&2
    echo "FAIL  $PF_FAIL_N check(s) failed:$PF_FAIL_NAMES" >&2
    if [ "$PF_SKIP_N" -ne 0 ]; then
      echo "      and $PF_SKIP_N further check(s) did not execute:$PF_SKIP_NAMES" >&2
    fi
    echo '      DO NOT PUSH.' >&2
    return 1
  fi
  if [ "$PF_SKIP_N" -ne 0 ]; then
    echo '' >&2
    echo "INCOMPLETE  nothing failed, but $PF_SKIP_N check(s) DID NOT EXECUTE:$PF_SKIP_NAMES" >&2
    echo '      A check that did not run is not a check that passed. These prove nothing, and this' >&2
    echo '      run does not establish that the tree is safe to push. Install the missing' >&2
    echo '      dependency (most often a local Postgres) and run it again.' >&2
    echo '      DO NOT PUSH.' >&2
    return 2
  fi
  echo ''
  echo 'PASS  every check executed and passed — safe to push.'
  echo '      Then run scripts/smoke-deployed.sh as its own command.'
  return 0
}
