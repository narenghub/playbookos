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
#
# ── AND WHY THERE ARE NOW THREE VERDICTS, NOT TWO ────────────────────────────
#
# On 2026-11-03 this script printed `ok` for 31 of its 44 steps on the CEO's Mac while those steps
# executed NOTHING. Thirty-three harnesses searched for Postgres in Linux-only directories, found
# none on macOS, returned early and exited 0 — so `kill switch stops, propagates and audits`,
# `a supplier RFQ cannot be sent twice`, `cross-company work is refused by the database` and every
# other containment control reported a pass having run zero assertions.
#
# The aggregator was the defect, not the harnesses. It asked "did anything exit non-zero?", which
# makes "nothing failed" and "everything passed" the same answer. They are not the same answer, and
# the gap between them is where a third of this gate went missing. A step now reports non-execution
# with exit 3, and `pf_verdict` has somewhere to put it: INCOMPLETE, which is not exit 0.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/.."

# The aggregator lives in its own file so a negative control can drive it with synthetic exit codes
# and prove it reports what it should. See scripts/preflight-verdict.test.js.
. "$HERE/lib/verdict.sh"

echo "── preflight"
# The suite. --test exits non-zero if any test fails, which is the only signal that matters.
pf_step "test suite" env JWT_SECRET=preflight node --test $(find src scripts -name '*.test.js')
pf_step "SPA parses (local file)" node scripts/check-spa-parse.js
pf_step "classic nav parity" node scripts/verify-classic-nav-parity.js
# Executes the shipped molecule-search SQL on a real Postgres. The parsers above cannot tell whether
# a query RUNS — `column "name" does not exist` shipped past all of them once. SKIPs cleanly (exit 0)
# where no server is available, so this never blocks a laptop without Postgres installed.
pf_step "molecule search runs on Postgres" node scripts/check-molecule-search-sql.js
# The SCOPE target list. Four CTEs, a json_agg with an ORDER BY inside it, a SUM(DISTINCT) and a
# numeric cast — every one of those parses and then fails. It also asserts the RANKING, because the
# score decides which booth gets walked to first on a two-day floor.
pf_step "sponsor ranking runs on Postgres" node scripts/check-sponsor-rank-sql.js
# A one-off ops script is where a type mismatch bites hardest: it runs once, under pressure, against
# production. `joined_at = CASE WHEN $2 THEN NOW() ELSE joined_at END` passed node --check and the
# whole unit suite, then failed on the live database because joined_at is TEXT.
pf_step "partner repair SQL runs on Postgres" node scripts/check-partner-repair-sql.js
# The SCOPE QC tab. Twice — in two different scripts, a day apart, on the same table — a lab query
# shipped whose ORDER BY terms were all constant, so it ran ALPHABETICALLY and led with API
# manufacturers. Both versions were valid SQL returning sixty rows; what was wrong was WHICH sixty,
# which only a query running against data can show. This check seeds a population rigged against the
# alphabet, so a third collapse fails here rather than in Barcelona.
pf_step "SCOPE lab delegates run on Postgres" node scripts/check-lab-delegates-sql.js
# The territory grant. Its first live run granted both of the first partner's territories, then died on
# `column "status" does not exist` — I guessed a users column, so the write landed and the
# verification that was the whole point never ran. The test I had written for it PASSED, because it
# grepped the source for the query text: a grep proves the words are there, never that the statement
# runs. This executes every query against the real column sets and asserts the patch scopes.
pf_step "territory grant runs on Postgres" node scripts/check-territory-grant-sql.js
# The supplier cross-check reads three tables it does not own — dmf_holders, suppliers,
# cphi_exhibitor_matches — and its output decides which of three emails a contact receives. It also
# has to distinguish "searched and found nothing" from "could not search": GP-Pharm's brand core is
# "gp", which canAnchor refuses, so a name search returns nothing and reading that as "not a
# supplier" would file a drug-product maker as a buyer on a search that never ran.
pf_step "supplier cross-check runs on Postgres" node scripts/check-supplier-classify-sql.js
# The one-pager is attached to step 1 of all three sequences, so every CPHI contact reads it. It was
# first built by hand with no recorded command, which meant the HTML and the PDF could disagree
# silently — and on 12 Oct the signature title changed to match Naren's business card, which would
# have left the attachment contradicting the email carrying it.
pf_step "one-pager PDF matches its source" node scripts/build-one-pager.js --check
# The institution search is five CTEs with two DISTINCT ON picks, FILTER aggregates and three LEFT
# JOINs on a composite key — and its answer decides what a lead-data prospect is told. The failure
# it guards is not a crash: searching "Oxford" merged the English hospital with Baptist Memorial in
# Oxford, MISSISSIPPI, so 20 of 35 trials and every NCI sponsor belonged to the wrong hemisphere.
# Valid SQL, plausible output, wrong institution. The fixture seeds both Oxfords, so dropping
# country from the group key fails here rather than in front of a vendor.
pf_step "institution search runs on Postgres" node scripts/check-institution-search-sql.js
# The supplier-catalogue chain, on two PDFs committed to test-fixtures/. The unit tests feed the
# extractor hand-written strings, which proves the string logic and nothing about the layer that
# actually broke twice: pdf-parse threw "bad XRef entry" on the first valid PDF it was given, and
# pdfjs fills column gaps with synthetic whitespace ITEMS, so measuring glyph gaps found nothing
# and every row number stayed glued to its product name. Both were invisible to every test that
# did not open a PDF. This opens two, including the awkward layout real brochures use.
pf_step "catalogue extraction works on real PDFs" node scripts/check-catalogue-extract.js
# The demand count, which decides the one number the whole platform is judged by. It read 37 buyers
# when the table held 20 spam, 4 of our own test rows and 3 real people — a twelvefold flattery
# nobody would question in a board update. Worse, the first corrected version compared a nullable
# column directly, so the live Yttrium oxide enquiry (no company filed) evaluated to NULL and
# vanished from every bucket: not a buyer, not spam, not ours, no error. The fixture is the real
# October table, senders and all, and asserts the headline is 3 and that the buckets sum to the row
# count, so a disappearing customer fails here instead of being quietly uncounted.
pf_step "demand count runs on Postgres" node scripts/check-demand-count-sql.js
# Committed credentials. The 27 Oct audit found the repo clean of live third-party keys and two
# hard-coded admin-password fallbacks anyway — one of them the real production password, sitting in
# git history for everyone who has ever cloned. What the repo had was no check that would catch it.
# Deliberately narrow: vendor-prefixed tokens, DSNs carrying a password, and `process.env.X_SECRET
# || 'literal'`. A scanner that fires on anything high-entropy gets muted, and then misses the real
# one — the same alarm fatigue that let a broken cron send 168 false alerts a week unnoticed.
pf_step "no committed credentials" node scripts/check-secrets.js

# An exporter's stdout is a file somebody else opens. `initDB` prints the database banner — with the
# super-admin address in it — and three of the four exporters wrote that into customer-bound CSVs
# because the fix had been made in place in the fourth. The guard is now shared, and this proves the
# banner cannot reach stdout, that an administrative address does not survive even into the diverted
# diagnostic, that `--format=json` yields exactly one parseable document, and that a failure leaves
# stdout EMPTY rather than half a handover file.
pf_step "exporter stdout is uncontaminated" env JWT_SECRET=preflight node --test scripts/exporter-stdout.test.js
# The pre-rotation snapshot is the only record of what a credential was before it was rotated, and
# once rotated the before-state cannot be recreated. The first version kept it in /tmp on the
# Railway container — and the procedure requires a redeploy between writing it and reading it, which
# replaces the container, so the storage was destroyed by the one step it existed to survive. Both
# the file write and the file read worked perfectly, so no unit test could see it. This asserts the
# two things that cost something: a snapshot written by one process is readable by a DIFFERENT one,
# and a second snapshot is REFUSED rather than silently replacing the before-state with the
# after-state — which would report every credential unchanged and read as a clean bill of health on
# a rotation that never happened.
pf_step "rotation snapshot survives a new process" node scripts/check-rotation-snapshot-db.js
# The kill switch (P0.2). The unit tests prove the semantics against a stub; they cannot prove the
# three things it actually has to do, all of which live in the database: a stop written by one
# process is seen by ANOTHER with no restart (which is the whole meaning of "no redeploy to stop
# autonomy"), the STOP/RESUME history is written by a TRIGGER so a break-glass INSERT typed into a
# console is audited exactly like an API call, and deleting the active stop does not erase that
# history. It also MEASURES propagation with the LISTEN accelerator deliberately disabled — a kill
# switch whose latency is asserted in a comment is a kill switch nobody has timed.
pf_step "kill switch stops, propagates and audits" node scripts/check-autonomy-stop-db.js
# K8: a stop must NAME something. matchStop() matches by exact string equality, so a key no caller
# ever passes matches nothing for ever — yet before K8 such a stop was accepted, stored, audited and
# reported as successful. `capability=email_send` and `agent=seo` looked like protection and were
# not, and false safety evidence is worse than none because people stop looking. The dangerous
# direction here is OVER-strictness — refusing a legitimate stop denies an operator a halt — so the
# vocabularies are DERIVED from CRON_SCOPES/CAPABILITIES and every key in them is accepted by
# ENUMERATION, not by sampling two. A refused stop must also leave no row behind.
pf_step "a stop that protects nothing is refused" node scripts/check-autonomy-scope-validation-db.js
# One RFQ per supplier per request. Until 27 Oct the procurement agent deduplicated with a SELECT
# before the send and wrote its log row AFTER it, with no unique constraint behind the read — so a
# send whose record was lost, or two overlapping runs, both emailed a real supplier twice. Neither
# is a crash and neither is reachable from a unit test, because both live in the window between two
# statements. This races two independent pools for the same claim (and twenty), which is the only
# way to show it.
pf_step "a supplier RFQ cannot be sent twice" node scripts/check-supplier-rfq-claim-db.js
# Run identity: at most one ACTIVE execution per intent, unlimited terminal attempts, immutable
# history. The arbiter is a partial unique index over the active states, not application logic —
# and each of the two unique indexes is exercised with the OTHER REMOVED, because the first version
# of these checks passed with either one weakened: the retry trigger's attempt = predecessor + 1
# rule makes "two active rows with different attempt numbers" unreachable, so neither index was
# independently necessary for any assertion and the arbiter claim was untested.
pf_step "run identity invariants hold in Postgres" node scripts/check-run-identity-db.js
# The canary, under controlled failure. The one that matters most is the first: if the durable run
# identity cannot be created, the body must never be ENTERED — proven with a spy, because "it
# produced no output" is not evidence. Also proves a duplicate scheduled trigger is DECLINED rather
# than reported as a failure (a false "workflow failed" alert is worse than the duplicate), and that
# the three durability classes really do behave differently: CRITICAL throws, OPERATIONAL reports
# loudly without throwing, TELEMETRY degrades silently.
pf_step "canary fails closed and never fakes success" node scripts/check-run-canary-db.js
# K1 company isolation. The entire claim is that isolation is a property of the DATA and not of the
# query — composite foreign keys with MATCH FULL — so none of it can be proven with a stubbed
# query, which would accept all twelve cross-company attacks and report success. Two fixture
# companies in a real server; every kernel record is attempted against the OTHER company's run and
# must be refused by the engine; the legitimate same-company write of each is also exercised,
# because a write that always fails would satisfy every refusal assertion. M2 is the control that
# matters: MATCH SIMPLE is the PostgreSQL DEFAULT for a composite key and passes if ANY column is
# NULL, so on a legacy-nullable company_id it admits the evasion — without that control, a future
# migration omitting two words re-opens the hole and everything else still passes.
pf_step "cross-company work is refused by the database" node scripts/check-office-isolation-db.js
# The read side, which no foreign key can enforce. One accessor owns every kernel table name, so a
# caller cannot forget `WHERE company_id = ?` because a caller never writes it. This check fails if
# a kernel table is reached in SQL anywhere else — the difference between "every developer
# remembers" and "a check fails if they don't". It carries both negative controls: a planted
# violation must be caught, and prose naming the tables must NOT be, because a check that cries
# wolf gets an exemption added to it rather than a fix.
pf_step "kernel tables are reached only through the scoped accessor" node scripts/check-office-scope-discipline.js
# Is the K1 PRODUCTION validator trustworthy? It runs once against production and its verdict is
# what decides PRODUCTION VALIDATED, so three things need proving first: it writes nothing durable
# (a fixture left on production could not be removed — agent_run_events is append-only); it goes red
# for each distinct reason (five independent sabotages); and every refusal was INDEPENDENTLY
# evaluated. That last one is the trap: a failed statement aborts a Postgres transaction, so without
# a SAVEPOINT per attempt the first refusal makes every later statement fail 25P02 "transaction is
# aborted" — nine attacks would report success with only the first ever tested.
pf_step "the K1 production validator can go red and writes nothing" node scripts/check-k1-validator-runs.js
# K2 — the CEO control object and the Executive Agent. The ruled chain: CEO creates objective ->
# company identity fixed -> objective durable -> Executive Agent consumes it -> the run references
# the EXACT objective and company -> cross-company substitution refused. Every guarantee in it is a
# server-side object, so a stubbed query would accept the substitution and report success. The
# non-consequential boundary is proven twice over, because "it produced no output" is not evidence
# that nothing was attempted: the module's require graph must contain no mailer/WhatsApp/LLM/
# outbound module AT ALL, and a network spy must record zero calls while being shown able to fire.
pf_step "the CEO control object governs a non-consequential agent" node scripts/check-office-k2-db.js
# K4 recovery. 33 adversarial cases against a real server, because every mechanism is server-side:
# a partial unique index, two BEFORE triggers and row-level arbitration. The three that matter most:
# 20 concurrent reapers must yield exactly ONE transition, ONE durable record and ONE exception —
# counted, not eyeballed; retry must create a NEW run with the SAME intent, never reopen the prior
# one, or the attempt history of both is a lie; and a known-unknown (ACTION_ATTEMPTED with no
# terminal event) must never be auto-retried while still being retryable WITH a recorded human
# override, because a guard that refuses everything is not a guard. M1 removes the arbitrating
# state predicate and proves 20 of 20 reapers then all "recover" the same run.
pf_step "stale runs recover under arbitration, retries are new runs" node scripts/check-office-recovery-db.js
# The governed vertical slice (K5/K6 + G + H + I + J). Four claims worth disbelieving: unknown cost
# is not zero AT EVERY LAYER (fixing costOf alone would have moved the lie into a NOT NULL column);
# the model CANNOT change chemical identity, with the stale filed CAS refused by name because an
# instruction in a prompt is not a control and a wrong CAS in prose is the 21 July failure; approval
# BLOCKS before the action, with an immutable payload so what a human read is what executes; and an
# AI call whose cost cannot be persisted WITHHOLDS ITS TEXT, because an unaccounted call with usable
# output is a budget bypass. The provider is stubbed so the never-responds case is reachable at all.
pf_step "AI is bounded, metered, and cannot overrule identity" node scripts/check-office-governed-ai-db.js
pf_step "the governed-AI production validator stops before spending" node scripts/check-governed-ai-validator-runs.js
pf_step "R1: nothing sends without a claim, and no retry ever happens" node scripts/check-office-release-db.js
# The recipient set of a supplier letter. The first real preparation copied an address at ANOTHER
# COMPANY'S DOMAIN onto an Abiozen RFQ because its holder had a platform admin role — platform
# administrative authority is not communication-recipient authority. This executes the ordering and
# the DMF tier acceptance against a real Postgres, on a population rigged against the alphabet AND
# against the platform's own reliability_score, because a ranking that quietly falls back to either
# one still returns plausible rows.
pf_step "supplier evidence runs on Postgres and ranks by evidence" node scripts/check-supplier-evidence-sql.js
# The LAST script a human reads before a first production send. Its worst failure is not a crash —
# it is reporting PASS when a release precondition would refuse. Rehearsed on a throwaway cluster:
# green on a clean approval, RED for each precondition independently AND for the right reason, and
# writing nothing on any path including the red ones.
pf_step "the pre-release report can go red and writes nothing" node scripts/check-pre-release-report-runs.js
# Supersession: approved + never externally claimed → superseded, and NOTHING wider. The risk is
# not that it fails, it is that a decided approval quietly becomes re-decidable — so most of that
# harness asserts what must remain impossible, including claimed → superseded, which is the one
# ordering that must never happen.
pf_step "supersession is one transition and no wider" node scripts/check-office-supersede-db.js
# The LEGACY weekly RFQ cron — the one that sends real supplier email with no approval boundary.
# It resolved its sender with `... AND is_active=1` and a hardcoded fallback to a named human, so
# DEACTIVATING a departed director SELECTED him. The mailer is a spy here, so "never called" is
# counted; M1 restores the fallback and proves a letter then goes out over his name.
pf_step "the legacy RFQ cron cannot send as a departed employee" node scripts/check-legacy-procurement-sender-db.js
# The two PRE-KERNEL paths that email people outside the company on their own schedule. Until they
# declared a kill-switch identity the only scope reaching them was capability:email.send — every
# email in the platform — so containing one ungoverned sender silenced the 6pm scores and the
# briefings too. Every case asserts WHICH scope refused, because `ok === false` would pass when an
# unrelated gate refused first.
pf_step "each legacy external sender stops on its own, by name" node scripts/check-legacy-email-containment-db.js
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
pf_step "molecule identity holds in Postgres" node scripts/check-molecule-identity-db.js

# A customer quote must not take its price from a pricing row matched only on a shared CAS.
# molecule_pricing is unique on LOWER(molecule_name) and unconstrained on cas_number, so the old
# `OR cas_number=$2` let a buyer who named the right molecule AND gave the right CAS be priced from
# another substance at 2.4x, decided by physical row order through a LIMIT 1 with no ORDER BY — and
# the quote auto-sends. This exercises the SHIPPED findPricing, reverses the row order to prove
# order no longer decides, and includes the negative control: it reproduces the defect with the
# original SQL and proves the reconciliation goes red, because a green check that cannot be shown to
# fail is not safety evidence.
pf_step "a shared CAS cannot price a customer quote" node scripts/check-inquiry-pricing-identity.js

# Does the reconciliation RUN? On 31 Oct it printed every proof and then died on `after is not
# defined` — a variable left dangling when proof 10's migration pass was removed. node --check
# parses a file and cannot see an undefined reference, this project has no linter, and nothing here
# executed main(), so the only thing that could find it was a production run over an SSH connection
# that had already failed twice that morning. This runs main() against a local database built from
# the real DDL. It asserts that every line EXECUTES, not what the verdict was — against fixtures the
# verdict is meaningless.
pf_step "the reconciliation runs end to end" node scripts/check-reconcile-runs.js

# The Gate 2 identity measurement is a READ-ONLY script that gets exactly one chance to be right:
# it runs once against production, over an SSH connection that failed three distinct ways on 31 Oct,
# and its numbers decide the backfill strategy. So every outcome class is exercised here, and above
# all that a CAS can VETO a name match but never make one — a shared registry number resolving a
# name is the defect that priced a quote 2.4x out, and as a design input it would be worse. Also
# asserts the "READS ONLY" claim on the tin by measuring row counts either side of a run.
pf_step "gate 2 identity measurement runs and writes nothing" node scripts/check-gate2-measure-runs.js

# The identity-evidence script answers one question with a commercial consequence -- did an RFQ
# whose CAS contradicts the canonical identity actually reach a supplier -- in one run against
# production, over an SSH connection that failed three ways on 31 Oct. The assertion that matters
# most is that a CLAIM is not a SEND: supplier_outreach_log writes 'pending' BEFORE the email, so
# reading that row as a send would manufacture a commercial-safety finding out of an attempt. All
# five verdict classes are exercised, and the "READS ONLY" claim is measured across six tables.
pf_step "identity evidence tells a send from a claim" node scripts/check-identity-evidence-runs.js

# A checksum-invalid CAS must never be printed as authoritative on a customer quotation. Measured,
# not hypothetical: the active molecule_pricing row for Semaglutide holds 910463-68-5, which FAILS
# this repo's own CAS checksum, and createInquiry lets a buyer who gives no CAS inherit the pricing
# row's -- so a number the buyer never wrote reaches them in the quotation's "CAS Number" row. The
# control DISABLES the real guard in the shipped file and proves the malformed number gets through,
# then restores the file and verifies the restoration by content hash. The guard SUPPRESSES and
# never substitutes the canonical value: printing a well-formed CAS from elsewhere would assert an
# identity relationship this fix has no authority to invent.
pf_step "a malformed CAS cannot reach a customer quote" node scripts/check-quote-cas-authority.js

# The supplier-overlap measurement decides whether canonical capability matching is worth building.
# Coverage of 321 molecules is not value; coverage of molecules somebody has asked to source is.
# The three resolved-RFQ cases must not collapse into each other -- resolved with a multi-supplier
# comparison, resolved with one, and resolved with NONE are different facts, and an unresolved RFQ
# is a fourth. It calls the SHIPPED matchSuppliers rather than reimplementing its scoring.
pf_step "supplier overlap keeps its cases apart" node scripts/check-supplier-overlap-runs.js

# ONE definition of what E1 reads identity from (P1). `SOURCES` was duplicated across five scripts
# -- I believed three until the extraction found two more -- and identical copies are correct right
# up until somebody edits one. The very next change to that list is Commercial Canonical Intake
# ADDING to it, which is exactly the edit that would have diverged: a source added to the backfill
# but not the reconciliation creates molecules the reconciliation cannot see; added to the
# reconciliation but not the backfill, every row of an unread table is reported missing. Both look
# like a reconciliation problem and neither is, and the 29 Oct 38-molecule incident was this same
# defect in a different place. Asserts object IDENTITY, not equality -- equality would still pass if
# the duplication came back with the same contents. Includes a mutation control that removes a
# source at runtime and proves every consumer observes it, and one that plants a reintroduced copy
# and proves the scan catches it. It runs the reconciliation check as a child, so this step is slow
# and deliberately self-contained.
pf_step "one shared SOURCES definition, provably load-bearing" node scripts/check-sources-centralized.js

# Where a CAS entered the workflow that emailed three suppliers. Its answer decides whether the
# defect is a row or a producer, so what matters most is the line between what it can establish and
# what it must call UNKNOWN -- an inferred provenance would be used to decide whether to change a
# producer. Asserts that a structured payload field and a regex scraped out of a sentence are told
# apart (they point at different culprits), that a CAS found elsewhere is reported WITHOUT claiming
# direction of travel, and that the SHIPPED parseApproval reproduces the historical extraction: the
# salt's name and the base's registry number, pulled from one sentence by two regexes that never
# meet.
pf_step "approval provenance distinguishes its cases" node scripts/check-approval-provenance-runs.js

# The supplier RFQ send boundary. On 21 July 2026 an RFQ reached Laurus Labs, Divi's and Dr Reddy's
# titled "Tramadol Hydrochloride (27203-92-5)" against a canonical 36282-47-0 -- and BOTH numbers
# pass the CAS checksum, which is exactly why the quote guard's checksum test is insufficient here.
# A checksum answers "could this be a CAS"; it cannot answer "does this CAS belong to the substance
# and FORM being requested". The guard runs before rfqClaim.claim, so a refusal leaves no pending
# supplier_outreach_log row -- the row the evidence tooling reads to decide whether a supplier was
# contacted. Every refusal asserts zero claims and zero sends, measured with a mail spy rather than
# inferred from silence. Seven mutations, each proving it changed its target before claiming a
# failure, and both source files restored by content hash.
pf_step "no RFQ sends an unsupported CAS" node scripts/check-rfq-identity-guard-db.js

# The deployment validator, whose verdict is what closes the interim RFQ guard. Two things about it
# have to be proven before it is believed. First, IT WRITES NOTHING DURABLE: proving the append-only
# trigger behaviourally needs a real row (the trigger is FOR EACH ROW, so a zero-row UPDATE succeeds
# trivially and would be a check passing for an unrelated reason), so it inserts one inside a
# transaction it deliberately rolls back -- and if that rollback ever failed the row could NOT be
# removed, because the table is append-only. The rollback is therefore asserted, not assumed.
# Second, IT CAN GO RED: drop the trigger, drop the table, or "correct" the historical Tramadol CAS,
# and it fails for that reason. Dropping the trigger must also break the UPDATE/DELETE proofs,
# otherwise those were never testing the trigger.
pf_step "the deployment validator can go red and writes nothing" node scripts/check-rfq-guard-validation-runs.js

# R2. src/lib/molecules/synonyms.js de-salts names on purpose, for SEARCH, and documents the limit
# itself: stripping `testosterone enanthate` to `testosterone` is "correct for FINDING a supplier and
# wrong for ordering one". Until this check existed that scoping rule was enforced only by whoever
# read the file. DEFAULT DENY: every file is forbidden from importing the search-only functions
# unless src/lib/molecules/search-scope.js lists it with a reason, so a new matcher is forbidden the
# moment somebody creates it, by doing nothing.
#
# It plants a real import in a non-allowlisted path, asserts it is caught by name, and removes it --
# because a check whose detector never matched anything would pass with a clean report, which is the
# false green this repo has already shipped twice. It did exactly that on its first run: a regex
# comment-stripper had eaten the region of routes.js holding the real import, so the check found
# ZERO callers and reported success.
#
# Weaker than the engine-side guards, and says so: it is static, it can be defeated by a dynamic
# require or a wrapper, and routes.js is allowlisted because it hosts the search endpoints -- so a
# pricing handler added inline there sits inside the exemption. That residual risk is recorded in
# search-scope.js with its remedy rather than left implied.
pf_step "the search rule cannot reach a commercial path" node scripts/check-search-rule-scope.js

# The PRPA connector schema, against a real server. src/lib/connectors/schema.test.js reads the DDL
# TEXT and so proves the migration SAYS the right thing; it cannot prove a server accepts it or that
# a constraint fires. Every guard here is exercised twice -- intact the violation is refused BY NAME
# (Rule 8: a refusal test must prove which control refused), then with the guard dropped the same
# violation must SUCCEED, so nothing passes unproven.
#
# It found one of my own claims to be wrong. PR-2 said MATCH FULL on (run_id, company_id) closes the
# evasion where a row points at another company's run with a NULL company_id. On a NULLABLE column
# it does. But both columns are NOT NULL here, so the half-NULL row cannot be written at all and
# MATCH FULL is defence-in-depth rather than the operative control -- exactly the "a NOT NULL nobody
# noticed" case the molecule identity step above was written to catch. It stays, because it becomes
# load-bearing the moment company_id is relaxed; it must not be removed on the grounds that it never
# fires. The check now records that attribution rather than letting the pass imply the wrong cause.
#
# Isolated and disposable only: it starts its own cluster in /var/tmp and REFUSES a CONN_PG_URL that
# looks like a hosted or production database. Fixtures are deleted by recorded id and leaks are
# reported; it never asserts a table is empty.
pf_step "the connector schema holds in Postgres, every guard load-bearing" node scripts/check-connector-schema-db.js

# The census produced the number a ruling was asked to act on, and that number was then reported
# wrongly -- as a defect in the canonical molecule layer rather than as a measurement of what a
# candidate merge rule WOULD collapse. The reporting error is corrected; this answers the next
# question, which is whether the arithmetic itself is right.
#
# It runs the SHIPPED script as a child process against a disposable cluster seeded with a fixture
# set whose answer is computable by hand, rather than reimplementing the grouping -- a second copy
# would prove only that two copies of the same reasoning agree. It then perturbs the data by exactly
# one conflict and requires the count to move by exactly one, so a script printing hard-coded
# numbers would fail.
#
# It also asserts the report STATES ITS SCOPE (study_molecules only, source data, prospective).
# That sentence is what stops the number being misread again, so its absence is a failure.
pf_step "the census counts what it says it counts" node scripts/check-census-arithmetic-db.js

# PR-6. views.test.js asserts every builder MENTIONS company_id, which is a text check and would
# pass on `WHERE company_id = company_id` or on a join that scopes one table and not the other. The
# only way to know a view does not leak is to put a SECOND company's rows in the database and look.
#
# Both tenants are seeded with structurally identical rows on purpose: data that looked different
# would make a leak obvious, data that looks the same makes it invisible unless the test checks ids.
# Then the predicate is removed and the same query must return the other tenant — without that, a
# view returning nothing for an unrelated reason would pass the leak test while proving nothing.
#
# It also refuses to count a 0-row result as isolation coverage, and records moleculeDemandCandidates
# as single-tenant BY NECESSITY rather than disguising the gap as a pass: study_molecules has no
# company_id, so that view cannot isolate and a green tick beside it would be a lie.
pf_step "dashboard views are tenant-scoped in Postgres" node scripts/check-dashboard-views-db.js

pf_verdict
exit $?
