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

# ── SCOPES: ONE GATE, TWO MACHINES ──────────────────────────────────────────
#
# On 2026-11-18 preflight on the office iMac reported 56 executed, 3 failed and 75 that DID NOT
# EXECUTE — nearly all for want of a local Postgres. The aggregator was right to refuse to call
# that a pass, but the result is a gate the worker hardware can never satisfy, which in practice
# means nobody runs it there at all.
#
# So a run may declare a SCOPE: an explicit list of step names, and only those run. Everything else
# is EXCLUDED — deliberately not the same word as SKIP. A skip is a check that should have run and
# did not; an exclusion was never part of this verdict. Conflating those two is precisely how
# "nothing failed" became "everything passed" on 2026-11-03.
#
# PF_ONLY holds newline-delimited EXACT names, never a pattern. `pf_scope_integrity` then fails the
# run if a requested name matches no step — otherwise renaming a step would silently shrink the Mac
# gate to nothing while still printing PASS, which is the same defect wearing a different hat.
# ── AND THE SCOPE MUST NOT BE VISIBLE TO THE STEPS ──────────────────────────
#
# The first version of this took PF_ONLY straight from the exported environment. preflight.sh's
# FIRST step is the node test suite — which includes scripts/preflight-verdict.test.js, this
# aggregator's own negative control. That test sources this file and drives it with synthetic exit
# codes, and it inherited the exported PF_ONLY, so every synthetic step it created was filtered out
# as out-of-scope and three of its assertions failed.
#
# The aggregator's own test caught a defect in the aggregator, which is what it is for. The lesson
# is narrower than "unset variables": a scope decides WHICH STEPS RUN and must not be able to
# change HOW A STEP BEHAVES. So it is captured once, here, and removed from the environment before
# a single step is executed.
PF_ONLY_LIST="${PF_ONLY:-}"
PF_SCOPE_LABEL="${PF_SCOPE_NAME:-}"
unset PF_ONLY
unset PF_SCOPE_NAME
PF_EXCLUDED_N=0
PF_MATCHED_NAMES=''

pf_in_scope () {
  [ -n "$PF_ONLY_LIST" ] || return 0
  printf '%s\n' "$PF_ONLY_LIST" | grep -Fxq -- "$1"
}

pf_scope_integrity () {
  [ -n "$PF_ONLY_LIST" ] || return 0
  pf_missing=''
  pf_old_ifs="$IFS"
  IFS='
'
  for pf_want in $PF_ONLY_LIST; do
    [ -n "$pf_want" ] || continue
    if ! printf '%s\n' "$PF_MATCHED_NAMES" | grep -Fxq -- "$pf_want"; then
      pf_missing="${pf_missing}
  - $pf_want"
    fi
  done
  IFS="$pf_old_ifs"
  [ -z "$pf_missing" ] && return 0
  echo '' >&2
  echo "SCOPE ERROR  this run named step(s) that do not exist in preflight.sh:$pf_missing" >&2
  echo '      A scope that matches nothing is a gate that checks nothing while printing PASS.' >&2
  echo '      Fix the name in the scope wrapper, or the step it refers to.' >&2
  return 1
}

# pf_step <name> <command...>
pf_step () {
  pf_name="$1"
  if ! pf_in_scope "$pf_name"; then
    PF_EXCLUDED_N=$(( PF_EXCLUDED_N + 1 ))
    return 0
  fi
  PF_MATCHED_NAMES="${PF_MATCHED_NAMES}
${pf_name}"
  shift
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
  if ! pf_scope_integrity; then
    echo '      DO NOT PUSH.' >&2
    return 1
  fi
  pf_total=$(( PF_PASS_N + PF_FAIL_N + PF_SKIP_N ))
  echo ''
  echo "── $pf_total checks: $PF_PASS_N executed and passed · $PF_FAIL_N failed · $PF_SKIP_N did not execute"
  if [ "$PF_EXCLUDED_N" -ne 0 ]; then
    echo "   scope: ${PF_SCOPE_LABEL:-a subset} — $PF_EXCLUDED_N further step(s) were EXCLUDED from this run"
    echo "   An excluded step is not a passed step. This verdict covers only the $pf_total above."
  fi
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
  if [ "$PF_EXCLUDED_N" -ne 0 ]; then
    # A scoped run must never say "safe to push". It did not look at most of the tree, and the
    # whole reason this file exists is that a verdict which overstates its own coverage is worse
    # than no verdict.
    echo "PASS (${PF_SCOPE_LABEL:-scoped})  every check IN THIS SCOPE executed and passed."
    echo "      This is NOT the push gate: $PF_EXCLUDED_N step(s) were excluded. Run"
    echo '      scripts/preflight.sh with no scope before pushing.'
    return 0
  fi
  echo 'PASS  every check executed and passed — safe to push.'
  echo '      Then run scripts/smoke-deployed.sh as its own command.'
  return 0
}
