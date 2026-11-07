# PRPA release — the whole thing on one page

**Ruling 29 items 2 and 7.** Status: **NO-GO.** Nine steps, seven of them yours. I will not ask for
deployment authorization until steps 1–6 are done and step 7 has passed.

**No secret value appears in this document, and I will never ask you for one.** If you paste a
secret into this conversation it is then in a chat log, and the correct response is to rotate it
again.

---

## Done — nothing here needs you

| | Evidence | Exit |
|---|---|---|
| The product: import, dashboard, feasibility, deadline confirmation, bid/no-bid, audit, CSV export | `prpa-e2e-demo.js` 46 assertions | **0** |
| The dashboard renders real data | `screenshot-prpa-tracker.js` 17 assertions | **0** |
| App starts and works with no superuser and no DDL | `check-startup-without-ddl.js` 28 assertions | **0** |
| Migration safe on a populated database, backup+restore proven | `verify-migration-readiness.js` 13 assertions | **0** |
| Every table a migration script creates, the migrator creates | `check-migration-coverage.js` — 152 tables | **0** |
| Destructive-operation inventory | `analyze-migration-risks.js` | **0** |
| Roles SQL prepared, applied nowhere | `docs/deploy/prod-roles.sql` | — |
| Full check suite | `preflight.sh` — 72/72 | **0** |

---

## Step 1 — change the admin password · **yours · blocks everything**

The password for `naren@abiozen.com` is in public Git history. Anyone who has ever cloned the
repository has it.

1. Sign in to PlaybookOS and change it. Use a value never used anywhere else.
2. Do **not** put it in Railway, a file, a document, or this chat.
3. Reply: *"password changed"*.

**I will not infer this from anything** — not from a failed login, not from a green secrets check.
`check-secrets.js --history` carries it as a known finding and **starts failing 2026-11-13**.

---

## Step 2 — rotate `JWT_SECRET` · **yours · immediately after step 1, never before**

Changing a password does **not** invalidate tokens already issued with it: `src/lib/core.js` signs
them with `expiresIn: '7d'`. Anyone who signed in while the password was public holds a working
token for up to a week. Rotating this is the only thing that kills them.

```sh
# on your machine; read the value from your own terminal
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Railway → Variables → `JWT_SECRET` → paste → redeploy. **Everyone is signed out, including you.**
That is the point.

Reversing steps 1 and 2 logs you out and leaves you signing back in with the password you have not
yet changed.

---

## Step 3 — the other credentials · **yours**

All appeared in the project handoff document.

| | Where |
|---|---|
| GitHub PAT | github.com → Settings → Developer settings → tokens. **Revoke the old one first**, then issue a replacement. |
| `TRIGGERS_SECRET`, `PLAYBOOKOS_WEBHOOK_SECRET`, `ENGAGEMENT_SECRET` | Generate as in step 2. Set all three, redeploy once — anything calling those webhooks needs the new value at the same moment. |
| Postgres superuser password | Railway → Postgres → rotate. Do it with step 5, same redeploy. |
| `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `ALGOLIA_API_KEY` (write), Google, LinkedIn, Apollo, Twilio, OpenAI | Each a separate judgement about exposure vs cost. `docs/security/remediation-checklist.md` lists them. |

---

## Step 4 — back up production · **yours · read-only**

Railway → your project → **Postgres service** → **Backups** → create one if there is none from
today → **download**.

This is a read. It does not modify the database.

---

## Step 5 — verify the migration against *your* schema · **yours · one command**

```sh
cd ~/Downloads/playbookos
git pull
scripts/verify-prod-dump.sh ~/Downloads/<the-backup-file>
echo $?
```

It builds a disposable local database from your backup, runs all 53 migration steps against
**production's real schema**, and reports what changed. **It cannot reach production** — there is no
connection string in it and it reads none from the environment.

Send me the output. It has no secrets in it: table names, row counts, verdicts.

**Why you and not me:** a production dump contains every row — password hashes, customers,
suppliers. Running it on your machine keeps all of that on your machine.

**This step is why the release is still NO-GO even with everything green.** Every test so far ran
against a database this repository built. A fresh install produced ~66 tables against production's
137 once before here, so "it works on mine" is not the same claim.

If it exits non-zero, send me the failing lines — I fix it and you re-run.

---

## Step 6 — create the restricted database role · **yours**

**No password is typed into any file.** This step used to say "replace the placeholder on line 38",
which put a live production password into a tracked file in a public repository. The role is now
created with no password at all — such a role cannot be logged into — and the password is set
interactively, so it exists in no file, no shell history and no server log.

```sh
cd ~/playbookos
read -rs PGPASSWORD && export PGPASSWORD    # paste the SUPERUSER password; nothing echoes
psql -h <host> -p <port> -U postgres -d railway
```

At the `psql` prompt:

```
\i docs/deploy/prod-roles.sql
\password playbookos_app
```

`\password` prompts twice, echoes nothing, hashes in the client and sends only the SCRAM verifier,
so a server with `log_statement=all` records no plaintext. This cannot be done in the Railway
**Data → Query** tab: `\password` is a psql command, not SQL, and doing it there would mean an SQL
statement carrying the plaintext.

Then, still in psql, run the four verification queries at the bottom of `prod-roles.sql`. The
`CREATE TABLE eng003_probe` **must fail** with *permission denied for schema public*. If it
succeeds, stop and tell me. Leave psql and `unset PGPASSWORD`.

Finally, in the Railway **Variables UI** — typed into the field, not via `railway variables set`,
which writes to shell history:

- `MIGRATION_DATABASE_URL` = the existing superuser connection string
- `DATABASE_URL` = the same, with user and password swapped for `playbookos_app`

Railway Variables is a secret store and the only place that password should come to rest. Not a
chat, a document, a commit or a screenshot.

---

## Step 7 — I re-verify · **mine**

You tell me steps 1–6 are done and send step 5's output. I re-run the full suite against the
verified schema and report every exit code.

---

## Step 8 — I request authorization · **mine**

Only if step 7 is clean. I will ask you explicitly, in one message, naming what I am asking to do.

---

## Step 9 — deploy · **yours to authorize, then this exact sequence**

**Read before the first command.** A merge to `main` is itself the deploy trigger, so the merge must
come *after* every database change, not before. The order below is not a preference: reconciliation
must precede the migration (the migration creates `idx_cem_unique`, which cannot be created while
duplicates exist), and both must precede the merge.

**Turn Railway auto-deploy OFF for this window** — Railway → the service → Settings → disable the
automatic deploy from `main` — and turn it back on at the end. `railway.json` declares the migration
as `preDeployCommand`, which is the right mechanism for ordinary pushes, but Railway's documentation
does not state what happens when a pre-deploy command fails: whether the deploy is abandoned and
whether the previous deployment keeps serving. A controlled release should not rest on behaviour
nobody has confirmed, so for this one the trigger is in your hands.

Each line is its own command. Read the exit code before the next one.

```sh
# ── CHECKPOINT 0 — fresh backup. Nothing below is recoverable without it.
#    Take it from Railway, then CHECK ITS SIZE (~25 MB). A 0-byte backup is not a backup.
ls -lh ~/db-backups/<new>.dump

# ── CHECKPOINT 1 — rehearse everything on that fresh dump, in isolation.
scripts/verify-prod-dump.sh ~/db-backups/<new>.dump --reconcile-on-restore
echo $?                            # must be 0, or stop

# ── CHECKPOINT 2 — CPHI reconciliation, production. Two commands, with a review between them.
#
#    2a. PLAN. Read-only: it writes nothing to the database.
railway ssh 'bash -lc "cd /app && node scripts/cphi-reconcile.js --plan-out /tmp/cphi-plan.json"'
echo $?                            # 1 while duplicates exist — that is the blocking finding
#
#    Send me the report. The plan file records the database identity, the table-state
#    fingerprint, the expected group and deletion counts, the conflict count, and its own
#    integrity hash. I read it and tell you the plan id to confirm.
#
#    2b. APPLY. Needs BOTH the production flag and the plan id, which must be the id of the
#        plan in that file. Neither can be supplied by an environment variable.
railway ssh 'bash -lc "cd /app && node scripts/cphi-reconcile.js --apply /tmp/cphi-plan.json \
  --apply-to-production --confirm-plan-id <THE PLAN ID I GIVE YOU>"'
echo $?
#
#    It refuses, having changed nothing, if: the database is not the one the plan was built
#    from; any row in the table moved since the plan was made; the plan file was edited; the
#    plan's own counts disagree with its contents; any group is in CONFLICT; or the plan id
#    does not match. --apply-to-production and --confirm-not-production are mutually exclusive.
#
#    ROLLBACK POINT: every prior row is in cphi_reconcile_audit under that plan_id, and
#    cphi_reconcile_runs records that this run had target 'production' — so a rehearsal and
#    the real thing stay distinguishable afterwards.

# ── CHECKPOINT 3 — the 54-step migration, as the migrator, app still serving the OLD release.
#    Safe in this order because the schema is additive: the old release runs against it unchanged.
railway ssh 'node scripts/migrate.js'
echo $?                            # must be 0, or stop — do NOT merge on a failed migration
#    ROLLBACK POINT: restore checkpoint 0's dump. Past here, rollback is redeploy-only.

# ── CHECKPOINT 4 — merge to main. The database is already correct; this ships the code.
#    With auto-deploy off, merging changes nothing by itself.

# ── CHECKPOINT 5 — deploy, by hand, from the Railway UI.
scripts/wait-for-deploy.sh <sha>   # /health returns the deployed commit; uptime is NOT a signal
echo $?

# ── CHECKPOINT 6 — is the APPLICATION alive, not just the server?
scripts/smoke-deployed.sh
echo $?

# ── Finally: turn Railway auto-deploy back on.
```

If the migration is skipped, the app **exits non-zero at boot** with the command to run. Deliberate:
starting anyway gives a server answering `/health` with 200 while every request fails — which is
what the 2026-09-30 outage looked like from outside.

**Rollback:** redeploy the previous image. The schema is additive, so the previous release runs
against it unchanged. No schema rollback needed, and none should be attempted first.

---

## Then: open the dashboard

`https://playbookos-production.up.railway.app/#prpa-tracker`
→ sidebar → **FEDERAL** → **Federal Contracts** → **⬇ Export to Excel (CSV)**

Two-minute guide: `docs/deploy/prpa-user-guide.md`.
