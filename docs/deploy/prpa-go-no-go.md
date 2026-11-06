# PRPA — GO / NO-GO production readiness

**Ruling 28 item 9.** Date: 2026-11-06. Branch: `feat/prpa-phase2-sam-prep`.

---

## The verdict

# NO-GO — on one thing, and it is yours

**The build is ready. The credentials are not.**

Everything ruling 28 asked me to complete is complete and verified, with exit codes below. The
release is held by a single condition I cannot satisfy and would not want to:

> **The administrator password for `naren@abiozen.com` is exposed in public Git history and has not
> been confirmed rotated.**

Deploying before that publishes an application whose admin credentials are readable by anyone who
has ever cloned the repository. `scripts/check-secrets.js --history` carries this finding and
**begins failing on 2026-11-13**.

**Change it, tell me it is done, and this becomes a GO** — subject to the four other steps in §4,
none of which take long.

---

## 1. What I completed

| # | Ruling 28 item | Evidence | Exit |
|---|---|---|---|
| 1 | MVP scope frozen | No feature added after the freeze. The eight capabilities are listed in §2. | — |
| 2 | Production migration readiness | `scripts/verify-migration-readiness.js` — 13 assertions | **0** |
| 3 | Least-privilege roles, proved | `scripts/check-startup-without-ddl.js` — 28 assertions | **0** |
| 4 | Security remediation checklist | `docs/security/remediation-checklist.md` — no secret value anywhere | — |
| 5 | Cloud deployment checklist | `docs/deploy/prpa-cloud-handover.md` | — |
| 6 | Complete CSV export, delivered | 253 rows, 37 columns; `validate-export-csv.js` 31 checks | **0** |
| 7 | URL, navigation path, user guide | `docs/deploy/prpa-user-guide.md` | — |
| 8 | Full local demonstration + preflight | §3 | see §3 |
| 9 | This report | — | — |

---

## 2. The frozen MVP

Manual import (CSV + single URL) · opportunity dashboard · eligibility and feasibility review ·
deadline confirmation · human bid/no-bid decisions · audit history · one-click Excel-compatible CSV
export.

**Nothing was added after the freeze.** Three things changed, all fixes to defects the readiness
review found, none of them new capability:

1. the migrator now treats `migrate-product-boundary.js`'s deliberate refusal as success rather
   than failure (§5.1);
2. the one non-idempotent step is gated on whether it has already run (§5.2);
3. two harnesses stopped using stub tables.

---

## 3. Exit codes, measured

Each run bare, as its own command, `$?` read. No pipes.

```
prpa-e2e-demo.js                   exit=0    46 assertions, import → … → Excel over HTTP
prpa-tracker-demo.js               exit=0    253 records end to end
check-startup-without-ddl.js       exit=0    28 assertions, ENG-003
verify-migration-readiness.js      exit=0    13 assertions, populated DB + backup/restore
screenshot-prpa-tracker.js         exit=0    17 assertions, the page renders real data
check-migration-coverage.js        exit=0    149 tables, no gap
check-prpa-route-collisions.js     exit=0    297 declarations, no path declared twice
check-opportunity-tracker.js       exit=0    137 assertions
validate-export-csv.js             exit=0    31 checks
check-date-formatting.js           exit=0    604 files, no raw date coercion
check-secrets.js                   exit=0    678 tracked files
check-secrets.js --history         exit=0    170 commits, 1 known finding (see the verdict)
check-release-blockers.js          exit=0    1 open blocker, reported
```

`scripts/preflight.sh` — **the result is recorded in §6, read from the log rather than from a task
notification.** Twice in this session a background notification reported "exit code 0" for a
preflight that exited 1, because the command ended in an `echo`. The log is the verdict.

---

## 4. What needs you

In order. **Steps 1–5 need no merge and no deployment.**

| # | Action | Why it blocks |
|---|---|---|
| 1 | **Change the admin password** and tell me it is done | public Git history; the whole NO-GO |
| 2 | Rotate `JWT_SECRET` — **after** step 1 | 7-day tokens minted under the old password stay valid until this |
| 3 | Rotate the GitHub PAT, DB credentials, webhook secrets | `docs/security/remediation-checklist.md` |
| 4 | Create `playbookos_app`, split `MIGRATION_DATABASE_URL` / `DATABASE_URL` | closes ENG-003's deployment half |
| 5 | Run `node scripts/migrate.js` against production, read `$?` | **the app will not start without it, by design** |
| 6 | **Merge to `main`** — which is the deployment | Railway auto-deploys from `main` |
| 7 | `wait-for-deploy.sh`, then `smoke-deployed.sh`, each bare | `/health` proves the server; these prove the app |
| 8 | Open **Federal Contracts** and check the dataset banner | `docs/deploy/prpa-user-guide.md` |

**Also yours, not blocking:** repository visibility.

---

## 5. What the readiness review found

Item 2 was the most valuable thing in this ruling, because it ran the migration against a database
that **already had data** — which is what production is, and which nothing else had done.

### 5.1 The migrator could not have run against production at all

`migrate-product-boundary.js` **refuses** to re-run once `user_products` has rows: *"a re-run
cannot tell revoked from never granted, so it would silently re-grant products somebody
deliberately took away."*

That refusal is correct, and it is the same hazard as the 2026-09-30 incident where a super admin's
deliberately removed `user_products` rows made a write look like a widening. But my migrator
treated it as a failed step — so `node scripts/migrate.js` against production would have **failed**.
The migrator now recognises that one refusal, by its own text, as "schema applied, backfill
correctly skipped". Any other failure still fails.

### 5.2 One step is not re-runnable

`migrate-sitenex-rename.js` guards its table renames but not its `ALTER INDEX ... RENAME`, so on an
already-renamed database it fails with *`relation "sitenex_packages_pkey" already exists`*. It is
now gated on whether `partners` exists — a table only that script creates, so its presence is an
exact record of whether the step has run. Nothing about the already-applied migration was changed.

### 5.3 What the review proves

- all 48 steps apply to a **populated** database
- **no table loses a row**; the human bid/no-bid decisions and the audit trail both survive —
  the two things that cannot be re-derived from a re-import
- a re-run changes nothing and creates no duplicate rows
- every column the application reads is still present (the migration is **additive**)
- `pg_dump --format=custom` → restore reproduces the pre-migration state **row for row**, and the
  restored database passes the readiness check the server runs at boot

### 5.4 The limitation, stated plainly

**This was validated against a production-LIKE database, not production's own schema.** No dump was
available — `railway ssh 'pg_dump …'` returned `command not found` on 2026-11-06.

A fresh install and production have diverged before in this repository: a fresh install built ~66
tables against production's 137. So a green run here means *"safe on a database shaped like the one
I built"*, which is weaker than it sounds.

**Before step 5 of §4, get a dump from Railway's backup UI and run:**

```sh
node scripts/verify-migration-readiness.js prod-YYYYMMDD.dump
echo $?
```

That retires this limitation. I would not call the migration production-proven without it.

---

## 6. Preflight

See `docs/deploy/prpa-mvp-status.md` for the defect list and
`docs/deploy/prpa-cloud-handover.md` for the deployment procedure.

```
scripts/preflight.sh      PREFLIGHT_EXIT=0
── 72 checks: 72 executed and passed · 0 failed · 0 did not execute
PASS  every check executed and passed — safe to push.
```

Read from `preflight6.log`, not from a task notification. **All four preflight runs in this session
reported "exit code 0" in their background notification; three of them had exited 1.** The
notification reflects the wrapper command, which ended in an `echo`, not the checker. Each of those
three caught something real:

1. a failing test suite (`rename-completeness` — the migration chain now legitimately names the
   pre-rename tables);
2. two credential-check failures, from `process.env.X || '<literal>'` fixture patterns I had
   introduced — the exact shape of a hard-coded fallback credential, which the checker cannot
   distinguish from a real one and correctly refuses;
3. `verify-migration-readiness.js` calling `createdb`, `pg_dump` and `pg_restore` without
   `-U postgres`. Those default the role to the invoking OS user, so it worked as root here and
   would have failed on your Mac with `role "nboda3230" does not exist` — the harness reporting
   "could not execute" instead of a result. That is the 2026-11-03 failure mode
   `scripts/lib/pg-cluster.js` exists to end, and its discipline test caught the repeat.

The branch is pushed: `9477351..397db66`, `PUSH_EXIT=0`.

---

## 7. What I did not do

No merge to `main`. No production migration. No deployment. No infrastructure provisioned. No
credential rotated. No contracting officer contacted. No bid submitted. No external communication
of any kind.

The branch is pushed and waiting.
