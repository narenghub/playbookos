# PRPA release gates — PASS / FAIL

**Ruling 32 gate 7.** Stopped before any production database mutation and before any merge to
`main`, as instructed. This is the summary you asked for.

---

# FAIL — two gates are unmet, and both are yours

I am **not** requesting execution approval. Ruling 32 says *"If any gate fails, stop immediately. Do
not bypass it or report the application as live."* Two gates are unmet.

Gate 2 is no longer unperformed — **you ran it, and it did its job.** It exited 1 and found two real
defects on first contact with the actual production database, one of which would have shipped a broken
feature on every fresh deployment. Both are fixed. What remains is one re-run of the same command
against the dump you already have.

Gate 1 has not moved: the exposed administrator password is still unconfirmed as changed, and that
check **begins failing on 2026-11-13**.

| Gate | Status | Who |
|---|---|---|
| **1. Admin password changed, credentials rotated** | **FAIL — unconfirmed** | you |
| **2. Backup restored, 54 steps validated against production's schema** | **FAIL — performed; 2 defects found and fixed; needs one re-run** | you |
| 3. Migration incompatibility, mutation, permissions, rollback | **PASS** — 2 incompatibilities found by gate 2, both resolved; confirmed by gate 2's re-run | done |
| 4. Least-privilege role + separate migration credentials | **PASS** (prepared, unapplied) | done / you to apply |
| 5. Full preflight + end-to-end, actual exit codes | **PASS** | done |
| 6. Exact migration and merge plan | **PASS** | done |
| 7. Stop and report | **this document** | done |

---

## Gate 1 — FAIL · unconfirmed

**Ruling 32 item 1 asks me to *confirm* the password has been changed. No such confirmation
exists.** Ruling 32 authorising the release does not state that the rotation happened, and I will
not read it as though it did — that is the one inference that would make every other gate
meaningless.

What is true:

- `check-secrets.js` exits 0 — that means no credential sits in the **working tree**. It says
  nothing about Git history.
- `check-secrets.js --history` exits 0 — it reports the exposure as a **known, tracked finding**,
  not as resolved. That check **begins failing on 2026-11-13**.
- The password for `naren@abiozen.com` is readable in public Git history: `scripts/init-db.js`
  (`bc5a8e5`) and `AUTONOMY_SECURITY_REVIEW.md` (`0c6a937`).

**To clear this gate:** change it, then reply *"password changed"*. Then `JWT_SECRET`, and only
after — `src/lib/core.js` signs tokens with `expiresIn: '7d'`, so a password change leaves working
tokens for up to a week and rotating the secret is the only thing that kills them. Steps 1–3 of
`docs/deploy/RELEASE.md`.

I will never ask you for a secret value, and if one is pasted into this conversation the correct
response is to rotate it again.

## Gate 2 — FAIL · performed, found a defect, fixed, needs ONE re-run

Ruling 32 item 2: *"Restore an authorized copy into an isolated environment and validate all 53
migration steps against the actual production schema."*

**You performed it on 2026-11-06.** `railway run pg_dump --format=custom` against
`DATABASE_PUBLIC_URL` produced a 25MB dump; `scripts/verify-prod-dump.sh` restored it into a
disposable cluster and **exited 1** — 7 assertions passed, 5 failed, 1 did not run.

**That gate earned its place.** Every green result before it described a database *this repository
built*. The first contact with the real one found two defects, one of them live in production-adjacent
code, and neither was findable any other way.

### What it found

| | |
|---|---|
| Reported | `outreach: unique on (entity_type, entity_id): MISSING` — the chain halted here |
| Actually | **your schema was correct.** The check was stale: `migrate-outreach-partner-scope.js` drops that constraint on purpose and replaces it with a per-partner unique index. The check still demanded the old one. |
| Behind it | that partner-scope script **was not in the migrator chain at all** — excluded as a "backfill". So a migrator-built database has no `outreach.partner_id`, and the application's own status-change query fails on it. Production works only because somebody ran it there by hand. |
| Also wrong | the report said *"5 column(s) the application reads are GONE"*. None had been dropped; none had ever existed. The chain had halted before the steps that create them. |

Full account: **`docs/tickets/ENG-004`**. All four are fixed; 47 → **54 steps** (see below).

### Why the re-run should pass

`scripts/check-production-shape-readiness.js` reconstructs the shape your run reported — no PRPA
tables, outreach partner-scoped with 159 rows — dumps it, and runs the **entire** gate-2 harness
against that dump. **17 assertions, exit 0.**

**It is not a substitute for your dump, and one number says why.** Your dump restored **140 tables**.
The reconstruction has **147** — the migrator's 152 less the 5 this release adds. So production is
missing roughly **seven further tables** that exist in the reconstruction, and I cannot say which,
because your report did not list them. The migration creates missing tables, so the likely answer is
"nothing to do". But a table absent in the reconstruction and *present* in production, carrying a
constraint this schema expects, is precisely the shape of the defect that halted the first run — and
it cannot appear in a reconstruction built from a report that never mentioned it.

That is what the re-run is for, and why I am not treating this harness as the gate.

The readiness check now also lists **every** skipped-constraint gap in your database *before*
migrating, so a second one surfaces in the same run rather than costing another 25MB backup.

### The re-run

```sh
cd ~/Downloads/playbookos && git pull
scripts/verify-prod-dump.sh ~/Downloads/playbookos-prod.dump
echo $?
```

The dump you already took is fine — nothing about it was at fault. No secrets in the output; the
script holds no connection string and cannot reach production.

---

## Gate 3 — PASS

### The rollback plan is now tested, not asserted

Three deployment documents said rollback means "redeploy the previous image, the migration is
additive". That sentence had been written three times and tested nowhere — and if it were wrong, it
would be wrong at the worst moment: production broken, migration already applied, recovery
procedure not working.

`scripts/check-previous-release-compat.js` — **13 assertions, exit 0**. It boots the **actually
deployed release** (`origin/main`, `f284243`) against a database the new migrator has migrated:

- it starts, `/health` returns 200 with `db: connected`
- `/api/auth/me` 401s anonymously; the SPA renders — it **serves**, not merely boots
- it still runs its own ~12 boot migrations over the new schema, and afterwards **152 tables remain,
  all 80 PRPA rows survive**, and the schema still passes the new release's readiness check — so a
  roll-forward after a rollback also works

### Data mutation, permissions, incompatibility

| | |
|---|---|
| Migration against a populated database | `verify-migration-readiness.js` — 13 assertions, **exit 0**: no table loses a row, re-runs change nothing, backup→restore reproduces exactly |
| Destructive-operation inventory | `analyze-migration-risks.js`: 6 destructive, 19 mutating, 4 breaking, 14 weakening, 8 rollback-only never reached |
| Permission failures | `check-startup-without-ddl.js` — 28 assertions, **exit 0** |
| The outreach key change, on three real shapes | `check-outreach-unique-repair.js` — 22 assertions, **exit 0** |
| A production-shaped dump, through the whole gate-2 harness | `check-production-shape-readiness.js` — 17 assertions, **exit 0** |

### Incompatibility — what gate 2 found, and what it changed here

Two defects, both fixed, both covered above and in full in `docs/tickets/ENG-004`:

1. **A stale schema assertion halted a correct database.** `migrate-outreach.js` demanded a constraint
   that `migrate-outreach-partner-scope.js` drops on purpose. It now accepts either key and reports
   which.
2. **A required schema step was not in the chain**, excluded as a "backfill" on the strength of its own
   description. A migrator-built database therefore had no `outreach.partner_id` and the application's
   own status-change query failed on it. It is now step `outreach partner scope`.

The second is the one worth noting at a release gate: it means **every green check in this repository
before today was running against a database where outreach was broken**, and a fresh deployment would
have shipped it that way. Rolling back would not have revealed it either, because the deployed release
has the column in production.

**Two items need your eye before migrating:**

- `docs/deploy/migration-risk-report.md` §1.1 — four `UPDATE users SET role=…` statements remap a
  legacy taxonomy on every run. Running at boot already, so not new; but anyone in production
  deliberately holding the role `procurement` or `marketing` will be silently reassigned. Gate 2's
  output shows you the current roles.
- §1.4, **new** — `DROP CONSTRAINT outreach_entity_type_entity_id_key` against a table with 159 real
  rows. On production it is a guarded no-op (the constraint is already gone, which is what the halt was
  about). It drops and recreates inside one transaction; a concurrent write in that window would leave
  a duplicate the new index then refuses. No rows are lost — asserted on production's shape.

## Gate 4 — PASS (prepared, applied nowhere)

`docs/deploy/prod-roles.sql` creates `playbookos_app` with `NOSUPERUSER NOCREATEDB NOCREATEROLE
NOBYPASSRLS`, grants DML only, and sets default privileges for future tables. It includes a
`CREATE TABLE eng003_probe` that **must fail** — a role that merely claims to be restricted proves
nothing.

Separate credentials: `MIGRATION_DATABASE_URL` (owner) and `DATABASE_URL` (app). The password
placeholder is yours to fill from `openssl rand -base64 24`; it is never to be pasted here.

Validated locally by `check-db-role-separation.js` (**exit 0**) and `check-startup-without-ddl.js`
(**exit 0**), both on disposable clusters.

## Gate 5 — PASS · actual exit codes

Each run bare, as its own command, `$?` read. No pipes.

```
prpa-e2e-demo.js                   exit=0    46 assertions, import → … → Excel over HTTP
prpa-tracker-demo.js               exit=0    253 records end to end
check-previous-release-compat.js   exit=0    13 assertions, the deployed release on the new schema
check-startup-without-ddl.js       exit=0    28 assertions, ENG-003
check-db-role-separation.js        exit=0    least-privilege roles
verify-migration-readiness.js      exit=0    13 assertions, populated DB + backup/restore
check-migration-coverage.js        exit=0    54 steps, 152 tables, every script accounted for
check-outreach-unique-repair.js    exit=0    22 assertions, the app's own upsert on 3 real DB shapes
check-production-shape-readiness.js exit=0   17 assertions, whole gate-2 harness on a prod-shaped dump
check-inline-constraint-sweep.js   exit=0    14 assertions, negative controls for the sweep
readiness-column-classification    exit=0    7 tests, dropped vs never-created
check-skipped-inline-constraints.js exit=0   63 inline constraints across 57 tables, enumerated
analyze-migration-risks.js         exit=0    6 destructive, 19 mutating, 4 breaking, 14 weakening
check-prpa-route-collisions.js     exit=0    no path declared twice
check-opportunity-tracker.js       exit=0    137 assertions
screenshot-prpa-tracker.js         exit=0    17 assertions, the page renders real data
validate-export-csv.js             exit=0    31 checks
check-date-formatting.js           exit=0    604 files
check-secrets.js                   exit=0    working tree only — see gate 1
check-secrets.js --history         exit=0    exposure TRACKED, not resolved — see gate 1
check-release-blockers.js          exit=0    1 open blocker, reported
```

### Preflight

```
── 80 checks: 80 executed and passed · 0 failed · 0 did not execute
PASS  every check executed and passed — safe to push.
PREFLIGHT_EXIT=0
```

**Read from the log file, not from the terminal.** Every one of the five preflight runs in this
release reported `exit code 0` in the shell while the log said otherwise, because the wrapper command
ended in `echo` and `$?` was the echo's. CLAUDE.md's rule — *a checker's verdict is its exit status* —
has a corollary this release kept proving: the status must be the status of the **checker**, not of
whatever ran last. The log line above is written by the run itself.

`0 did not execute` matters as much as `0 failed`. On 2026-11-03, 31 of 44 steps reported `ok` having
executed nothing; `scripts/lib/pg-cluster.js` reserves exit 3 for that, and preflight counts it as its
own verdict.

## Gate 6 — PASS · the exact plan

**Do not run any of this until gates 1 and 2 pass.**

```sh
# ── 1. BACKUP (read-only) ─────────────────────────────────────────────────────
# railway.app -> project -> Postgres -> Backups -> create -> download
# Take it IMMEDIATELY before migrating. Railway's backup is a snapshot; anything written
# between taking it and migrating is not in it.

# ── 2. ROLES (one time) ───────────────────────────────────────────────────────
# Fill the password placeholder in docs/deploy/prod-roles.sql, run it in Railway -> Data -> Query.
# Then run the four verification queries at its foot. CREATE TABLE eng003_probe MUST fail.

# ── 3. VARIABLES ──────────────────────────────────────────────────────────────
# Railway -> Variables:
#   MIGRATION_DATABASE_URL = the existing superuser connection string
#   DATABASE_URL           = same, user+password swapped for playbookos_app

# ── 4. MIGRATE — before the app starts, as its own step ───────────────────────
node scripts/migrate.js
echo $?                      # must be 0. 54 steps. Confirm with `node scripts/migrate.js --plan`. Stop here if it is not.

# ── 5. MERGE — this IS the deployment; Railway auto-deploys from main ─────────
#   (requires your explicit approval; I will not do this)

# ── 6. VERIFY THE DEPLOYED COMMIT ─────────────────────────────────────────────
scripts/wait-for-deploy.sh <sha>     # /health returns the deployed commit. Uptime is NOT a signal:
echo $?                              # the previous container also has a low uptime.

# ── 7. SMOKE — separate command ───────────────────────────────────────────────
scripts/smoke-deployed.sh            # /health, the SPA parses, /api/auth/me 401s anonymously
echo $?

# ── 8. THE PRODUCT ────────────────────────────────────────────────────────────
curl -s -H "Authorization: Bearer <token>" https://<host>/api/prpa/tracker/dataset \
  | grep -o '"is_live_feed":[a-z]*'          # expect "is_live_feed":false
curl -s -H "Authorization: Bearer <token>" https://<host>/api/prpa/tracker/export.csv -o smoke.csv
head -c 3 smoke.csv | xxd | head -1          # expect the UTF-8 BOM: efbb bf
grep -c "Unconfirmed Fields" smoke.csv       # expect 1
```

**Rollback:** redeploy the previous image. **Now tested** — gate 3. No schema rollback, and none
should be attempted first.

**If the migration is skipped**, the app exits non-zero at boot with the command to run. Deliberate:
starting anyway gives a server answering `/health` 200 while every request fails, which is what
2026-09-30 looked like from outside.

---

## Where the dashboard will be

`https://playbookos-production.up.railway.app/#prpa-tracker`
→ sidebar → **FEDERAL** → **Federal Contracts** → **⬇ Export to Excel (CSV)**

Guide: `docs/deploy/prpa-user-guide.md`.

---

## What happens next

1. **Gate 2, re-run** — one command, against the dump you already have:
   ```sh
   cd ~/Downloads/playbookos && git pull
   scripts/verify-prod-dump.sh ~/Downloads/playbookos-prod.dump
   echo $?
   ```
   Send me everything it prints. No secrets in it.
2. **Gate 1** — change the administrator password, then reply *"password changed"*. Then `JWT_SECRET`,
   and only after: `src/lib/core.js` signs tokens with `expiresIn: '7d'`, so a password change leaves
   working tokens for up to a week and rotating the secret is the only thing that kills them. Steps 1–3
   of `docs/deploy/RELEASE.md`. **This check begins failing on 2026-11-13.**
3. I re-run everything against the verified schema and report every exit code, read from logs.
4. **Then** I ask you, explicitly and in one message, for execution approval.
5. On approval: migrate, merge, verify the deployed commit, smoke, confirm the dashboard and export.

**What I will not do without that approval:** run a production migration, merge to `main`, deploy,
provision infrastructure, contact a contracting officer, or submit a bid. Ruling 32 gate 7 stops me
before the first production database mutation, and this document is that stop.

**Nothing has been migrated, merged, deployed or provisioned. No contracting officer has been
contacted and no bid has been submitted.**
