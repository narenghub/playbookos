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

It builds a disposable local database from your backup, runs all 48 migration steps against
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

1. Open `docs/deploy/prod-roles.sql`, replace the password placeholder on line 38 with a freshly
   generated one (`openssl rand -base64 24`).
2. Railway → Postgres → **Data** → Query → paste → run.
3. Run the four verification queries at the bottom of that file. The `CREATE TABLE eng003_probe`
   **must fail** with *permission denied for schema public*. If it succeeds, stop and tell me.
4. Railway → Variables:
   - `MIGRATION_DATABASE_URL` = the existing superuser connection string
   - `DATABASE_URL` = the same, with user and password swapped for `playbookos_app`

---

## Step 7 — I re-verify · **mine**

You tell me steps 1–6 are done and send step 5's output. I re-run the full suite against the
verified schema and report every exit code.

---

## Step 8 — I request authorization · **mine**

Only if step 7 is clean. I will ask you explicitly, in one message, naming what I am asking to do.

---

## Step 9 — deploy · **yours to authorize, then this exact sequence**

```sh
node scripts/migrate.js            # as a deploy step, BEFORE the app starts
echo $?                            # must be 0

# merge to main — this IS the deployment; Railway auto-deploys from main

scripts/wait-for-deploy.sh <sha>   # /health returns the deployed commit; uptime is not a signal
echo $?

scripts/smoke-deployed.sh          # separate command: is the APPLICATION alive, not just the server
echo $?
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
