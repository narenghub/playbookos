# M7 development environment — runbook for a LOCAL agent session

**Read this whole file before running anything.** It is written for a Claude Code session running
**on Naren's Mac**, which has the `railway` CLI, his Railway authentication, and the ability to open
a TCP connection to a database. A cloud session cannot do this work: its network is HTTPS-only, so
it cannot reach Postgres at all.

## What this sets up

An isolated Railway development environment for testing the M7 Mac mini worker. **This is not
production and must never touch it.**

| | |
| --- | --- |
| Railway project | `playnexa-m7-dev` (exists; separate from `meticulous-laughter`) |
| Repo / branch | `narenghub/playbookos` @ `feat/m7-mac-mini-worker` |
| Dev API entry point | `scripts/dev-worker-api-server.js` — **never** `server.js` |
| Database | the Postgres service in `playnexa-m7-dev`, reached by tunnel |

## Hard boundaries — do not cross these, and do not "fix" them

- **No production deploys.** `origin/main` and the `meticulous-laughter` project are untouched.
- **No production database.** Never `postgres.railway.internal` from a production context, never
  `interchange.proxy.rlwy.net` (the Abiozen Django production DB).
- **No production STOP changes.** The three production STOPs
  (`capability|email.send`, `workflow|legacy-inquiry-buyer-email`,
  `workflow|legacy-supplier-rfq-email`) are not yours to alter.
- **No external messages.** No email, WhatsApp or payment.
- **Do not enable Public Access on the Postgres service.** It is deliberately private. Use the
  tunnel below. If something seems to need public access, stop and report instead.
- **Do not paste `WORKER_SECRET_SEAL_KEY`, any database password, or any token into a chat.**
- **If a script refuses, do not override it.** Several refusals exist specifically to stop a
  mistake that already nearly happened. Report the refusal verbatim.

## Step 1 — link the project

```sh
cd ~/playnexa-worker
git fetch origin feat/m7-mac-mini-worker && git checkout feat/m7-mac-mini-worker && git pull
git rev-parse --short HEAD
railway link           # choose: playnexa-m7-dev
railway status
```

Report the commit SHA and the `railway status` output. **Confirm the project is `playnexa-m7-dev`
before continuing.**

Note on names: the production project appears in `railway list` as **"Playbook OS"**. Older
documents call it `meticulous-laughter`; that is the same thing under its earlier name. Identify the
dev project by its ID — `a3d1f2d7-cf15-4feb-a079-e1539eaad77f` — rather than by name, since its only
environment is also called `production` (Railway's default for every project) and that is
confusing on sight.

## Step 2 — open a tunnel to the dev database

**`--tunnel-only` requires Railway CLI v5.** A Homebrew install may be on v4.57.1, where the flag
does not exist and `railway connect` has no tunnel mode at all. **Do not upgrade the global CLI to
get it** — the same binary is used for production (`railway ssh --service playbookos`), and that is
the owner's decision, not a step in this runbook. Use `npx` for this one command instead:

```sh
cd ~/playnexa-worker
npx -y @railway/cli@5 whoami                              # should show the existing login
npx -y @railway/cli@5 connect Postgres --tunnel-only
```

Authentication lives in the home directory and is shared between installs, so the npx'd v5 should
see the existing session. If `whoami` says unauthorized, stop and report rather than logging in.

From the v5 help, verbatim:

```
--tunnel-only  Open the local tunnel without launching a database client. Prints connection
               details for external tools ... and holds the tunnel open until Ctrl+C. Implies --ssh
--ssh          Tunnel to the database over SSH instead of a public TCP proxy.
               Works without a public domain; auto-enabled when the service has no public proxy URL
```

**The tunnel goes over SSH, not the public TCP proxy** — which is why Public Access must stay off
and nothing here needs it. If something suggests enabling `railway tcp-proxy` or Public Access to
make this work, that is the wrong branch: stop and report.

Leave the tunnel running in its own terminal. It prints a local host and port. The resulting
`DATABASE_URL` points at `127.0.0.1`, which every script here accepts, and which the database
identity gate treats like any other address — it still has to prove what it is.

## Step 3 — identify and migrate the database

In a second terminal, with `DATABASE_URL` set to the tunnel address:

```sh
export M7_5_DEV_CONFIRM=yes
node scripts/m7-dev-migrate.js; echo "exit=$?"
```

**Expected:** a section headed `identifying the database before anything is applied` reporting the
database as **development** (empty, or holding only M7's own tables), then six migrations, then
`PASS`, exit **0**.

**If it reports `production_fingerprint`, `unidentified` or `cannot_tell`, STOP.** That check exists
because the previous guard matched on hostname and was wrong in both directions. It asks the
database what it holds. A refusal means the `DATABASE_URL` is not what you think it is — do not
override it, do not widen the check, report what it printed.

It is idempotent. `--verify` checks without changing anything. `--rollback` drops the task, result
and audit tables and keeps identities.

## Step 4 — contain the database

```sh
node scripts/m7-dev-seed-containment.js; echo "exit=$?"
```

**Expected:** `42 stop(s) written`, then all 42 crons reported as STOPPED by `checkStopped()`
itself, `no global stop exists`, `capability worker.execute is permitted`, `PASS`, exit **0**.

A **global** stop here would halt the worker too. If one appears, stop and report.

## Step 5 — the dev API service

**Config as Code is refused for new services.** Railway rejects setting a config path with:

```
Failed to update service: Config as Code (railway.json / railway.toml) is deprecated.
Use Infrastructure as Code (.railway/railway.ts) instead.
```

So `railway.dev.json` cannot be attached to this service, and the **dashboard start command is the
mechanism**. Do NOT add `.railway/railway.ts` to this repository to work around it: its scoping
semantics are unverified, a file at the repo root could change how PRODUCTION deploys, and it is
not needed — see the safety argument below.

In the Railway dashboard, inside `playnexa-m7-dev`, on the service `m7-dev-worker-api`:

1. Connect the source: GitHub `narenghub/playbookos`, **and select branch
   `feat/m7-mac-mini-worker` as you connect it** — not afterwards. Connecting without choosing the
   branch builds `main` immediately.
2. Confirm the start command is `node scripts/dev-worker-api-server.js` and the health check is
   `/health`.
3. Variables — **exactly these five**, nothing else:

```
M7_DEV_API=yes
WORKER_API_ENABLED=true
WORKER_SECRET_SEAL_KEY=<openssl rand -hex 32 — generate it, never print or paste it>
DATABASE_URL=${{Postgres.DATABASE_URL}}
NODE_ENV=development
```

`${{Postgres.DATABASE_URL}}` is this project's own private address. That is correct and intended:
Railway's private DNS is project-scoped, so it is the DEV database, and the identity gate verifies
what it actually holds at boot rather than trusting the name.

The service refuses to start if any of `RESEND_API_KEY`, `TWILIO_*`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `APOLLO_API_KEY`, `LINKEDIN_*`, `ALGOLIA_*`, `GOOGLE_*` or
`ABIOZEN_DATABASE_URL` is present.

### Why the start command is enough, even if the root railway.json is still read

The open question is whether a new service auto-detects the repo-root `railway.json`, whose
`startCommand` is `node server.js`. Railway's refusal above says Config as Code is deprecated but
does not say whether the root file is still read. Only the deploy log settles it — and either way
the outcome is safe:

- **`server.js` refuses to start when `M7_DEV_API=yes` is set.** It exits 2 before `node-cron`, the
  mailer, WhatsApp, the routes or the `pg` driver are loaded, so no schedule can register and
  nothing can be sent. Verified by inspecting the real require cache: zero repo modules and one
  package loaded at the point of refusal.
- The root config's `preDeployCommand` targets `inquiry_messages`, a table that **does not exist**
  in this database. It would fail rather than change anything.

So the worst case is a failed deploy, which is loud, visible and harmless — not a cron server
quietly running against dev data.

### Step 5a — read the first deploy log

**Required:**

```
[m7-dev-worker-api] listening on <port>
[m7-dev-worker-api] crons registered: 0 (server.js is not loaded by this process)
[m7-dev-worker-api] provider clients constructed: 0
```

Plus an identity line from the boot gate confirming the database was identified as development.

**Two tells that the root `railway.json` won**, either of which means report and stop:

1. `REFUSED: M7_DEV_API=yes marks this as the M7 development worker service` — that is `server.js`
   refusing, which is the guard working but means the wrong start command was applied.
2. Any mention of `migrate-inquiry-direction-check` — that is the production `preDeployCommand`.

**And the one that must never appear:** any cron registration at all.

## Step 6 — verify the deployed API

```sh
curl -sS https://<dev-host>/health
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://<dev-host>/api/auth/login
echo | openssl s_client -connect <dev-host>:443 -servername <dev-host> -verify_return_error 2>&1 | grep 'Verify return code'
```

**Expected:** `{"status":"ok","service":"m7-dev-worker-api","production":false,"db":"connected",...}`
· **404** · `Verify return code: 0 (ok)`.

A 404 on `/api/auth/login` is required — anything else means the wrong service is deployed.

## Step 7 — mint an enrolment token

```sh
node scripts/m7-5-dev-driver.js mint --label macbook-dryrun
```

Single-use. Carry it to the worker account by hand; do not put it in a file or a message.

## Then stop and report

Report, verbatim:

1. The commit SHA and `railway status`
2. The full output of steps 3 and 4 with their exit codes
3. The **first deploy log**
4. The three curl results from step 6
5. Any refusal, in full, with no attempt to work around it

The Mac worker enrolment and installation follow, under a dedicated **non-admin** account
(`pnxworker`, UID 502, already created and verified). `installer/macos/workerctl` refuses to run as
root or as a member of the `admin` group — that is intended, not an obstacle to route around.
