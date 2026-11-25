# B4.2 — development cloud worker: owner checklist

**2026-11-25, for Priority 1.** Everything that can be prepared without your hands is done and
verified. This names exactly what cannot be.

**Verified here, in this container:** `scripts/check-cloud-worker-process-db.js` — **15 assertions,
0 failures.** It spawns `node src/worker-client/run.js` as a real subprocess against a real server
and proves the process enrols, finds its own credential, claims, executes, completes, is stopped by
the kill switch, and is refused after revocation. **This container is Linux**, which is the same
platform Railway runs, so what Railway adds is being long-running and reachable — not a different
runtime.

---

## 0. The blocker that had to be cleared first, and why it was invisible

`src/worker-client/keychain.js` is macOS-only and refuses elsewhere **by design**:

> `${op} requires macOS Keychain and this is ${process.platform}. There is deliberately no
> file-based fallback: pass the secret explicitly in tests instead.`

So the worker **process could not start in a Linux container at all**, and no test would have told
us, because the existing runtime check injects the secret directly into the client library and
never starts `run.js`. The gap was between two things that were each correct about themselves.

`src/worker-client/secret-source.js` closes it **without bypassing the reason behind that rule.**
The hazard the rule guards is a credential arriving through ambient deployment configuration. In a
container the platform's environment *is* the secret store, so the question is how to make reading
one a decision rather than an accident. Four conditions, all required:

1. the platform is **not macOS** — a Mac can never fall back to the weaker path, even with the
   variable set;
2. `PLAYNEXA_WORKER_ENV` is exactly `development`;
3. the secret arrives in **`PLAYNEXA_DEV_WORKER_SECRET`** — deliberately not `WORKER_SECRET`, so a
   leftover value from another tool cannot become this worker's credential;
4. `WORKER_ID` is of the enrolled shape.

**This is a weakening and the code says so.** An environment variable is visible to anything that
can read the process environment, appears in the Railway dashboard, and survives in deployment
history. That is acceptable for a development identity that can run only cloud-eligible synthetic
work. Condition 2 is what keeps it out of production, and `secret-source.test.js` asserts the
production refusal rather than trusting this paragraph — sabotaged three ways, all caught.

Also fixed: `--doctor` measured the **Keychain** rather than the credential source, so a container
with a perfectly usable credential reported `ready: false`. On a cloud worker that would have read
as a broken deploy.

---

## 1. What needs your hands — four actions

### ACTION 1 — create the Railway service

In the existing **`playnexa-m7-dev`** project (not production):

| Setting | Value |
|---|---|
| Service name | `m7-dev-cloud-worker` |
| Source | the same GitHub repo, branch **`feat/m7-mac-mini-worker`** |
| Start command | `node src/worker-client/run.js` |
| Build | default Node build; no build step needed |
| Public networking | **disable it.** The worker opens no port — `--doctor` reports `inboundListeners: 0` as a checked fact. A public endpoint would be attack surface for a process that listens for nothing |
| Restart policy | on failure, which is Railway's default — the process exits non-zero on an unusable credential precisely so a supervisor retries |
| Replicas | **1.** Two would both poll, and while the lease protocol makes that safe, it is not what this milestone is measuring |

### ACTION 2 — set exactly four variables

```
WORKER_API_BASE_URL   = https://<the m7-dev API service URL>      # must be https
WORKER_ID             = wkr_<32 hex>                               # from ACTION 3
PLAYNEXA_WORKER_ENV   = development
PLAYNEXA_DEV_WORKER_SECRET = <the secret from ACTION 3>
```

Those are **all** of them — `grep` over the process's modules finds no others. Specifically do
**not** set: `DATABASE_URL` (the worker never touches a database; it talks to the API over HTTPS),
`ANTHROPIC_API_KEY`, `RESEND_API_KEY`, or any production credential. The worker needs none of them,
and your Priority 1 requirement of *"no production database access, no production provider
credentials"* is satisfied by their absence rather than by a policy.

### ACTION 3 — enrol it (one command, then one paste)

Enrolment is deliberately a two-step act: the server mints a **single-use** token, and the worker
exchanges it for a secret it then holds. The token spends on first use, so a re-enrolment attempt
on a working worker fails loudly instead of silently reissuing.

```sh
# 1. On the m7-dev API, mint a token for this worker (server-side, operator action):
railway ssh --service m7-dev-worker-api \
  'node -e "require(\"/app/src/lib/worker/identity\").createEnrollmentToken({label:\"m7-dev-cloud-worker\"}).then(t=>console.log(t.token))"'

# 2. Exchange it for an identity. Run this ONCE, from anywhere that can reach the API:
curl -sS -X POST "$WORKER_API_BASE_URL/api/worker/enroll" \
  -H 'content-type: application/json' \
  --data '{"token":"<the token>","hostFingerprint":"railway-m7-dev-cloud-worker"}'
# → {"ok":true,"workerId":"wkr_…","secret":"…"}
```

Put the `workerId` and `secret` into the two Railway variables from ACTION 2. **`--service` is not
optional** on the `railway ssh` line: this project's linked service is Postgres, so a bare
`railway ssh` opens a shell in the database container where there is no `node` and no `/app`, and
the error reads as a broken deploy.

**No capabilities are granted.** The enrolment token carries them and this one carries none, so the
worker gets neither `exec:hardware` nor `exec:gui` — asserted in the check. That is your Priority 1
requirement and your §3's instruction, and it is enforced at the server: `consumeEnrollmentToken`
has no capabilities parameter and no module updates the column afterwards.

### ACTION 4 — confirm it, then approve what it may do

```sh
railway logs --service m7-dev-cloud-worker          # expect {"at":"started", …} then polling
railway run --service m7-dev-cloud-worker node src/worker-client/run.js --doctor
```

`--doctor` should report `credentialUsable: true`, `credentialSource:
development-environment-variable`, `ready: true`, `inboundListeners: 0`, and an `authentication`
block that says `authenticated`. It contacts the API and changes nothing, and it prints no part of
the secret.

---

## 2. What is verified without you — the 15 assertions

| Your bullet | Status | Where |
|---|---|---|
| Cloud worker enrolment and authenticated heartbeat | **verified** (enrolment, auth, lease, heartbeat during execution) | §1, §2, §3 |
| Cloud-eligible task execution | **verified** — `synthetic.echo` claimed and COMPLETED by the subprocess, result verdict SUCCEEDED | §3 |
| Hardware-required tasks pending without consuming attempts | **verified** — three cycles, still PENDING, no result row | §4 |
| Cloud execution continuing while the iMac is unavailable | **verified in a stronger form** — no hardware-capable worker exists in the cluster at all, and cloud work still completes | §5 |
| Correct worker revocation and STOP enforcement | **verified** — a `capability:worker.execute` stop leaves the task PENDING; a revoked identity claims nothing even though the secret is still in its environment | §6, §7 |
| Command Center visibility of both workers | **NOT done — B2.9** | — |

A detail worth keeping: `autonomy.stop` **refuses a capability that matches nothing** — *"this stop
would protect nothing"* — and names the four valid keys. My first fixture used `worker.claim` and
was rejected. A kill switch that accepted a scope it cannot enforce would be the worst kind of
control: set, reported as set, protecting nothing.

## 3. What the service adds that this cannot

- **Long-running operation** — B4.7's 72 hours. Every assertion here is `--once`.
- **Automatic process recovery by the platform supervisor.** The process exits non-zero on an
  unusable credential so a supervisor retries; that Railway *does* retry is Railway's behaviour.
- **The service's own networking and the real API URL over HTTPS.** Loopback HTTP is used here
  deliberately: a self-signed certificate would test Node's TLS stack, not this code.
- **Command Center visibility (B2.9)** — not started.

## 4. Non-destructive by construction

Your *"use controlled, non-destructive availability tests; deliberate hardware crashes require
separate authorization"*: nothing here crashes anything. "The iMac is unavailable" is tested as
*"no hardware worker exists"*, which is a stronger condition than offline and needs no crash. The
crash-test handler is not exercised and its arming window is expired.

## 5. If something goes wrong

| Symptom | Means | Fix |
|---|---|---|
| `{"at":"credential_unavailable","source":"none"}` | `PLAYNEXA_WORKER_ENV` is not `development`, or `WORKER_ID` is malformed | the message names which |
| `credential_unavailable` with `development-environment-variable` | `PLAYNEXA_DEV_WORKER_SECRET` unset or blank | set it |
| `WORKER_API_BASE_URL must be https://` | an `http://` URL that is not loopback | the HMAC authenticates but does not conceal; task payloads carry business content |
| `token_already_used` | the enrolment token was already spent | mint a new one; do not retry the old |
| authenticates, claims nothing, forever | a STOP is in force, or the identity is revoked | `autonomy.listStops()`; check `worker_identities.revoked_at` |

**Rollback is deleting the Railway service.** It holds no data, writes to no database directly, and
every row it created is an ordinary `worker_tasks`/`worker_results` row in the development
database. Revoking the identity (`IDENTITY.revokeWorker`) stops it immediately without deleting
anything, and the check proves that path works.
