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
# The SCOPE target list. Four CTEs, a json_agg with an ORDER BY inside it, a SUM(DISTINCT) and a
# numeric cast — every one of those parses and then fails. It also asserts the RANKING, because the
# score decides which booth gets walked to first on a two-day floor.
step "sponsor ranking runs on Postgres" node scripts/check-sponsor-rank-sql.js
# A one-off ops script is where a type mismatch bites hardest: it runs once, under pressure, against
# production. `joined_at = CASE WHEN $2 THEN NOW() ELSE joined_at END` passed node --check and the
# whole unit suite, then failed on the live database because joined_at is TEXT.
step "partner repair SQL runs on Postgres" node scripts/check-partner-repair-sql.js
# The SCOPE QC tab. Twice — in two different scripts, a day apart, on the same table — a lab query
# shipped whose ORDER BY terms were all constant, so it ran ALPHABETICALLY and led with API
# manufacturers. Both versions were valid SQL returning sixty rows; what was wrong was WHICH sixty,
# which only a query running against data can show. This check seeds a population rigged against the
# alphabet, so a third collapse fails here rather than in Barcelona.
step "SCOPE lab delegates run on Postgres" node scripts/check-lab-delegates-sql.js
# The territory grant. Its first live run granted both of the first partner's territories, then died on
# `column "status" does not exist` — I guessed a users column, so the write landed and the
# verification that was the whole point never ran. The test I had written for it PASSED, because it
# grepped the source for the query text: a grep proves the words are there, never that the statement
# runs. This executes every query against the real column sets and asserts the patch scopes.
step "territory grant runs on Postgres" node scripts/check-territory-grant-sql.js
# The supplier cross-check reads three tables it does not own — dmf_holders, suppliers,
# cphi_exhibitor_matches — and its output decides which of three emails a contact receives. It also
# has to distinguish "searched and found nothing" from "could not search": GP-Pharm's brand core is
# "gp", which canAnchor refuses, so a name search returns nothing and reading that as "not a
# supplier" would file a drug-product maker as a buyer on a search that never ran.
step "supplier cross-check runs on Postgres" node scripts/check-supplier-classify-sql.js
# The one-pager is attached to step 1 of all three sequences, so every CPHI contact reads it. It was
# first built by hand with no recorded command, which meant the HTML and the PDF could disagree
# silently — and on 12 Oct the signature title changed to match Naren's business card, which would
# have left the attachment contradicting the email carrying it.
step "one-pager PDF matches its source" node scripts/build-one-pager.js --check
# The institution search is five CTEs with two DISTINCT ON picks, FILTER aggregates and three LEFT
# JOINs on a composite key — and its answer decides what a lead-data prospect is told. The failure
# it guards is not a crash: searching "Oxford" merged the English hospital with Baptist Memorial in
# Oxford, MISSISSIPPI, so 20 of 35 trials and every NCI sponsor belonged to the wrong hemisphere.
# Valid SQL, plausible output, wrong institution. The fixture seeds both Oxfords, so dropping
# country from the group key fails here rather than in front of a vendor.
step "institution search runs on Postgres" node scripts/check-institution-search-sql.js
# The supplier-catalogue chain, on two PDFs committed to test-fixtures/. The unit tests feed the
# extractor hand-written strings, which proves the string logic and nothing about the layer that
# actually broke twice: pdf-parse threw "bad XRef entry" on the first valid PDF it was given, and
# pdfjs fills column gaps with synthetic whitespace ITEMS, so measuring glyph gaps found nothing
# and every row number stayed glued to its product name. Both were invisible to every test that
# did not open a PDF. This opens two, including the awkward layout real brochures use.
step "catalogue extraction works on real PDFs" node scripts/check-catalogue-extract.js
# The demand count, which decides the one number the whole platform is judged by. It read 37 buyers
# when the table held 20 spam, 4 of our own test rows and 3 real people — a twelvefold flattery
# nobody would question in a board update. Worse, the first corrected version compared a nullable
# column directly, so the live Yttrium oxide enquiry (no company filed) evaluated to NULL and
# vanished from every bucket: not a buyer, not spam, not ours, no error. The fixture is the real
# October table, senders and all, and asserts the headline is 3 and that the buckets sum to the row
# count, so a disappearing customer fails here instead of being quietly uncounted.
step "demand count runs on Postgres" node scripts/check-demand-count-sql.js
# Committed credentials. The 27 Oct audit found the repo clean of live third-party keys and two
# hard-coded admin-password fallbacks anyway — one of them the real production password, sitting in
# git history for everyone who has ever cloned. What the repo had was no check that would catch it.
# Deliberately narrow: vendor-prefixed tokens, DSNs carrying a password, and `process.env.X_SECRET
# || 'literal'`. A scanner that fires on anything high-entropy gets muted, and then misses the real
# one — the same alarm fatigue that let a broken cron send 168 false alerts a week unnoticed.
step "no committed credentials" node scripts/check-secrets.js
# The pre-rotation snapshot is the only record of what a credential was before it was rotated, and
# once rotated the before-state cannot be recreated. The first version kept it in /tmp on the
# Railway container — and the procedure requires a redeploy between writing it and reading it, which
# replaces the container, so the storage was destroyed by the one step it existed to survive. Both
# the file write and the file read worked perfectly, so no unit test could see it. This asserts the
# two things that cost something: a snapshot written by one process is readable by a DIFFERENT one,
# and a second snapshot is REFUSED rather than silently replacing the before-state with the
# after-state — which would report every credential unchanged and read as a clean bill of health on
# a rotation that never happened.
step "rotation snapshot survives a new process" node scripts/check-rotation-snapshot-db.js
# The kill switch (P0.2). The unit tests prove the semantics against a stub; they cannot prove the
# three things it actually has to do, all of which live in the database: a stop written by one
# process is seen by ANOTHER with no restart (which is the whole meaning of "no redeploy to stop
# autonomy"), the STOP/RESUME history is written by a TRIGGER so a break-glass INSERT typed into a
# console is audited exactly like an API call, and deleting the active stop does not erase that
# history. It also MEASURES propagation with the LISTEN accelerator deliberately disabled — a kill
# switch whose latency is asserted in a comment is a kill switch nobody has timed.
step "kill switch stops, propagates and audits" node scripts/check-autonomy-stop-db.js
# One RFQ per supplier per request. Until 27 Oct the procurement agent deduplicated with a SELECT
# before the send and wrote its log row AFTER it, with no unique constraint behind the read — so a
# send whose record was lost, or two overlapping runs, both emailed a real supplier twice. Neither
# is a crash and neither is reachable from a unit test, because both live in the window between two
# statements. This races two independent pools for the same claim (and twenty), which is the only
# way to show it.
step "a supplier RFQ cannot be sent twice" node scripts/check-supplier-rfq-claim-db.js
# Run identity: at most one ACTIVE execution per intent, unlimited terminal attempts, immutable
# history. The arbiter is a partial unique index over the active states, not application logic —
# and each of the two unique indexes is exercised with the OTHER REMOVED, because the first version
# of these checks passed with either one weakened: the retry trigger's attempt = predecessor + 1
# rule makes "two active rows with different attempt numbers" unreachable, so neither index was
# independently necessary for any assertion and the arbiter claim was untested.
step "run identity invariants hold in Postgres" node scripts/check-run-identity-db.js
# The canary, under controlled failure. The one that matters most is the first: if the durable run
# identity cannot be created, the body must never be ENTERED — proven with a spy, because "it
# produced no output" is not evidence. Also proves a duplicate scheduled trigger is DECLINED rather
# than reported as a failure (a false "workflow failed" alert is worse than the duplicate), and that
# the three durability classes really do behave differently: CRITICAL throws, OPERATIONAL reports
# loudly without throwing, TELEMETRY degrades silently.
step "canary fails closed and never fakes success" node scripts/check-run-canary-db.js
# Molecule identity (E1). The unit tests prove the naming rules against strings and cannot prove the
# four things that keep two substances apart once rows exist: that a name cannot be one molecule's
# identity and another's alias FROM EITHER INSERTION ORDER (two triggers — a test that inserts one
# way passes with half of it missing), that the real backfill REFUSES a CAS disagreement instead of
# taking the commoner value, that a second pass writes nothing, and that inchikey is still entirely
# NULL so the day a fuzzy resolver starts filling it a check fails loudly. The fixture is the 9 Oct
# case with real registry numbers — Leuprolide 53714-56-0 against Leuprolide Acetate 74381-53-6 —
# because collapsing those inflates a holder count into false scarcity and splitting the INN/USAN
# pair answers "we have no supplier" about a substance three companies hold. Each guard is also
# exercised with itself DISABLED, so a passing refusal is shown to come from the guard and not from
# a NOT NULL nobody noticed.
step "molecule identity holds in Postgres" node scripts/check-molecule-identity-db.js

# A customer quote must not take its price from a pricing row matched only on a shared CAS.
# molecule_pricing is unique on LOWER(molecule_name) and unconstrained on cas_number, so the old
# `OR cas_number=$2` let a buyer who named the right molecule AND gave the right CAS be priced from
# another substance at 2.4x, decided by physical row order through a LIMIT 1 with no ORDER BY — and
# the quote auto-sends. This exercises the SHIPPED findPricing, reverses the row order to prove
# order no longer decides, and includes the negative control: it reproduces the defect with the
# original SQL and proves the reconciliation goes red, because a green check that cannot be shown to
# fail is not safety evidence.
step "a shared CAS cannot price a customer quote" node scripts/check-inquiry-pricing-identity.js

# Does the reconciliation RUN? On 31 Oct it printed every proof and then died on `after is not
# defined` — a variable left dangling when proof 10's migration pass was removed. node --check
# parses a file and cannot see an undefined reference, this project has no linter, and nothing here
# executed main(), so the only thing that could find it was a production run over an SSH connection
# that had already failed twice that morning. This runs main() against a local database built from
# the real DDL. It asserts that every line EXECUTES, not what the verdict was — against fixtures the
# verdict is meaningless.
step "the reconciliation runs end to end" node scripts/check-reconcile-runs.js

if [ ${#FAILED[@]} -ne 0 ]; then
  echo "FAIL  ${#FAILED[@]} check(s) failed: ${FAILED[*]}" >&2
  echo "      DO NOT PUSH." >&2
  exit 1
fi
echo "PASS  safe to push — then run scripts/smoke-deployed.sh as its own command"
