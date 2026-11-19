#!/usr/bin/env bash
# ── PREFLIGHT, WORKER-HARDWARE SCOPE ─────────────────────────────────────────
#
#   scripts/preflight-mac.sh   →  exit 0 = every check this machine CAN run, ran and passed
#
# This is NOT the push gate. `scripts/preflight.sh` is. Read on before using it as one.
#
# ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
#
# On 2026-11-18 the full preflight on the office iMac reported:
#
#     134 checks: 56 executed and passed · 3 failed · 75 did not execute
#
# Of the 75, nearly all read `skip  no Postgres available`. The aggregator was right to refuse to
# call that a pass — a check that did not run is not a check that passed — but the practical effect
# is a gate the worker hardware can never satisfy. A gate that always returns INCOMPLETE on a given
# machine stops being read on that machine, and then it protects nothing there.
#
# Two of the three failures were the same thing in a different form: `verify-restore.js` and
# `verify-migration-v2-on-restore.js` need `pg_restore`, which the Mac does not have. The third was
# a CSV check wanting a file produced in a cloud container. None of them was a defect in the tree,
# and none of them is answerable on a worker node.
#
# So this scope contains only checks that are MEANINGFUL AND EXECUTABLE on the worker hardware.
# Nothing here skips for want of a database, which is the point: the verdict is a real verdict.
#
# ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
#
# It does not run the database, restore, deployment or SPA checks — those belong to the cloud scope
# and are EXCLUDED here, a word the aggregator keeps distinct from SKIP. An excluded check was never
# part of this verdict; a skipped one should have been and wasn't. Confusing those two is exactly
# how 31 of 44 steps once printed `ok` having asserted nothing.
#
# It also will not quietly shrink. If any name below stops matching a step in preflight.sh — because
# the step was renamed or removed — `pf_scope_integrity` fails the run rather than letting a scope
# that matches nothing print PASS.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Exact step names, not patterns. Newline-delimited.
#
#   test suite     — the whole node --test suite, including every worker-client test: the heartbeat
#                    lifecycle, the Keychain account naming, workerctl's install/stop lifecycle
#                    under a shimmed launchd, and the crash-test handler's four gates.
#   M7.5 guards    — production refusals, the uname-shimmed platform gate, TLS verification, and
#                    cleanup-only-by-id. Portable since the gate stopped depending on the host.
#   workerctl doctor — that a diagnostic cannot report a tool's chatter as a configured value.
PF_ONLY='test suite
the M7.5 hardware scripts refuse production and cannot fake evidence
workerctl doctor cannot report a tool'"'"'s chatter as a configured value'
PF_SCOPE_NAME='mac / worker hardware'
export PF_ONLY PF_SCOPE_NAME

echo "── preflight: WORKER-HARDWARE SCOPE on $(uname -s) $(uname -m)"
echo "   This is not the push gate. Run scripts/preflight.sh for that."
exec "$HERE/preflight.sh"
