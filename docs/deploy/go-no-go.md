# GO / NO-GO — PRPA release

**Ruling 33 item 8.** Unresolved blockers and required owner actions only. Everything resolved is in
`docs/tickets/ENG-004` and `docs/deploy/migration-chain.md`.

---

# NO-GO

**Two blockers. Both are yours. I am not requesting deployment approval.**

| # | Blocker | Owner | Status |
|---|---|---|---|
| 1 | Exposed administrator password not confirmed changed; affected credentials not confirmed rotated | you | **OPEN** — ruling 33 item 7 keeps this open until you confirm |
| 2 | Migrations not yet validated against the **actual** production schema | you | **OPEN** — one command, below |

Nothing else is blocking. No migration has been run, nothing merged to `main`, nothing deployed, no
infrastructure provisioned, no production credential changed, no contracting officer contacted, no bid
submitted.

---

## Blocker 1 — credentials

**OPEN, and deliberately kept open.** Ruling 33 item 7: *"Keep the exposed administrator password and
affected credential rotations as OPEN blockers until explicitly confirmed completed."*

What is true:

- `check-secrets.js` exits 0 — no credential in the **working tree**. It says nothing about history.
- `check-secrets.js --history` exits 0 — it reports the exposure as a **known, tracked finding**, not
  as resolved. **That check begins failing on 2026-11-13.**
- The password for `naren@abiozen.com` is readable in public Git history: `scripts/init-db.js`
  (`bc5a8e5`) and `AUTONOMY_SECURITY_REVIEW.md` (`0c6a937`).

Ruling 32 item 1 said *"do not treat a successful secrets-check exit code as evidence that the known
historical exposure is resolved."* I have not.

### Required owner actions, in this order

1. **Change the administrator password.** Then reply *"password changed"*.
2. **Rotate `JWT_SECRET`** — and only after step 1. `src/lib/core.js` signs tokens with
   `expiresIn: '7d'`, so a password change leaves working sessions for up to a week; rotating the
   secret is the only thing that ends them. Verified behaviourally:
   `check-behavioral-regression.js` asserts a demoted account is refused on its **next** request with
   the same live token, so authorization is current — but authentication still rests on the signature.
3. **Then** the GitHub PAT, the database credentials, and the webhook secrets.

Steps and exact commands: `docs/deploy/RELEASE.md` steps 1–3, and
`docs/security/remediation-checklist.md`.

**I will never ask you for a secret value.** If one is pasted into our conversation, the correct
response is to rotate it again.

---

## Blocker 2 — production-schema validation

**OPEN.** Ruling 33 item 4: *"Validate all migrations against the actual production schema and report
before/after differences, data preservation, and actual exit codes."*

You ran this on 2026-11-06 and **it did its job**: exit 1, and it found two real defects on first
contact with the real database — one of which would have shipped a broken feature on every fresh
deployment. Both fixed. It needs one re-run.

### Required owner action — four commands

```sh
cd ~/playbookos
git fetch origin && git checkout feat/prpa-phase2-sam-prep && git pull
node scripts/migrate.js --plan | head -3        # must say 53 schema step(s)
scripts/verify-prod-dump.sh ~/Downloads/playbookos-prod.dump ; echo $?
```

**The `git checkout` is load-bearing.** The fixes are on `feat/prpa-phase2-sam-prep` at `cd5ec74`.
`main` is at `f284243`, which declares **47** steps, and the branch tip before this push (`9ff2bc7`)
did too — so on 2026-11-06 three separate runs of this verification all executed 47-step code and
reported the same already-fixed defect. `git pull` alone cannot fix that; the branch is the fix.

The first wrong run was worse than useless, because `cd ~/Downloads/playbookos && git pull` failed at
the `cd` — the directory did not exist — so the `git pull` never ran and the script executed from
another checkout. Nothing in 80 lines of output said so except `(47 schema steps declared)`.

`verify-prod-dump.sh` now prints its repo path, branch, SHA and step count as its first four lines and
**exits 3 without touching the dump** if the chain is shorter than
`scripts/expected-schema-steps.txt`. If it does not say 53, stop: everything after that is meaningless.

The 25MB dump you already took is fine; nothing about it was ever at fault. Send me everything it
prints — there are no secrets in it, only table names, row counts and verdicts.

**Why it is safe** (ruling 33 item 2, asserted not claimed): `check-dump-test-isolation.js` — 10
assertions, exit 0 — creates a live decoy database, points `DATABASE_URL`,
`MIGRATION_DATABASE_URL`, `DATABASE_PUBLIC_URL`, `PGHOST`, `PGPORT`, `PGDATABASE` and `PGUSER` at it,
runs the readiness harness, and asserts the decoy is untouched afterwards. Details and the reason it
needed asserting: `docs/deploy/migration-chain.md`.

### What that run will tell you that I cannot

Your dump restored **140 tables**. A database this migrator builds has **152**, of which 5 are added
by this release — so production is missing roughly **seven further tables** that exist here, and I
cannot say which, because your report did not list them. The migration creates missing tables, so the
likely answer is "nothing to do". But a table absent here and **present** there, carrying a constraint
this schema expects, is exactly the shape of the defect that halted the first run, and it cannot appear
in any reconstruction built from a report that never mentioned it.

The readiness check now lists **every** skipped-constraint gap in your database *before* migrating, so
a second one surfaces in the same run rather than costing another backup.

---

## One item that needs your decision, not your action

`sitenex_deals.status_changed_at` exists on production **with no default**, because
`migrate-sitenex-stage-clock.js` has never passed its own verification — its comment promised a
`SET DEFAULT` the file never contained, so it threw on every run after the `ADD COLUMN` had landed.
Every SiteNex deal created since starts with no stage clock.

The migration fixes it for **new** deals. It does **not** backfill existing ones, and should not: when
a deal's status last changed is not recoverable, and a migration that guesses would turn an unknown
into something that reads as a measurement. Those rows will correctly read as *not recorded*.

Nothing is required of you. Say so if you would rather they were filled with an estimate, and I will
tell you what it would and would not mean.

---

## Verification standing behind this report

Every exit code read from a log or a bare run, never from a pipe, never from a terminal summary line.

```
preflight.sh                        see §Preflight in release-gate-summary.md
check-behavioral-regression.js      exit=0   32 assertions — auth, roles, product permissions,
                                             outreach, integration gating, over HTTP
check-dump-test-isolation.js        exit=0   10 assertions — decoy untouched
check-outreach-unique-repair.js     exit=0   23 assertions — the app's own upsert, 3 DB shapes
check-production-shape-readiness.js exit=0   17 assertions — gate-2 harness on a prod-shaped dump
check-previous-release-compat.js    exit=0   13 assertions — the deployed release on the new schema
check-migration-coverage.js         exit=0   53 steps, 152 tables, all 43 scripts accounted for
check-startup-without-ddl.js        exit=0   28 assertions — ENG-003
check-inline-constraint-sweep.js    exit=0   14 assertions — controls for the constraint sweep
screenshot-prpa-tracker.js          exit=0   17 assertions — the page renders real data
doc-step-counts.test.js             exit=0   3 tests — no document quotes a stale count
check-secrets.js                    exit=0   working tree only — see blocker 1
check-secrets.js --history          exit=0   exposure TRACKED, not resolved — see blocker 1
check-release-blockers.js           exit=0   1 open blocker (ENG-003), reported
```

ENG-003 remains an open release blocker by design and is reported rather than suppressed; its code half
is done — boot applies no DDL and the app runs as a role with no superuser, no DDL and no RLS bypass.
The remaining half is yours to apply (`docs/deploy/prod-roles.sql`) and is not gating this release.

---

## What happens after both blockers clear

1. You confirm the password change and rotations, and send me the output of the dump test.
2. I re-run every harness against the verified schema and report each exit code, read from logs.
3. **Then** I ask you, explicitly and in one message, for deployment approval.
4. On approval only: migrate, merge, verify the deployed commit, smoke-test, confirm the dashboard and
   the export.

Ruling 33: *"Do not run production migrations, merge to main, deploy, or change production credentials
without separate authorization."* This document is where I stop.
