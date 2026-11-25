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

### ACTION 3 — enrol it, with the secret never reaching a transcript

**CORRECTION, 2026-11-25.** The first version of this document told you to run a `railway ssh …
console.log(t.token)` and then showed an enrolment response containing `"secret":"…"`. Both put a
live credential into a terminal transcript — the first place your instruction names — and a
transcript is scrolled back through, pasted into chat, and kept in shell history. Nothing about
that was subtle, and writing the procedure that way made you the transport for a credential that
only ever needs to travel from a server to a container. Replaced:

```sh
# Run on a host that can reach the m7-dev API and its database.
# Mints the token, exchanges it, and writes ONLY the secret to a 0600 file.
PLAYNEXA_WORKER_ENV=development   node scripts/enroll-worker-no-transcript.js     --label m7-dev-cloud-worker     --api  https://<the m7-dev API service URL>     --out  /tmp/m7-dev-cloud-worker.secret
```

It prints the **worker id** (configuration, not a secret), the granted **capabilities** (expected:
none), and a **SHA-256 fingerprint prefix** — twelve hex characters of a hash of a 32-byte random
value, which identifies the credential for comparison and reconstructs none of it. The secret
itself appears nowhere but the file.

Then, with the value never passing through a shell:

1. Railway → `m7-dev-cloud-worker` → **Variables**;
2. paste the file's contents into `PLAYNEXA_DEV_WORKER_SECRET` — a masked field, not a transcript;
3. set `WORKER_ID` to the id the script printed;
4. `shred -u /tmp/m7-dev-cloud-worker.secret` (`rm -P` on macOS).

The script **refuses** to run against the production API, refuses unless
`PLAYNEXA_WORKER_ENV=development`, refuses to grant `exec:hardware` or `exec:gui`, and refuses to
overwrite an existing `--out` file — because if it did, the identity would be enrolled and its
secret lost, which costs a revocation and a re-enrolment.

**Why the token is single-use matters here:** if the exchange fails after the mint, the token is
spent. Mint a new one rather than retrying the old, and the script says so.

### ACTION 3a — confirm the commits are compatible BEFORE enrolling

Your Priority 1: *"confirm the exact deployed API and worker commits are compatible before
enrollment."* Enrolment spends a single-use token, so a mismatch discovered afterwards costs a
revocation.

```sh
# The API's deployed commit, from its own health endpoint:
curl -sS https://<the m7-dev API service URL>/health      # → includes the deployed commit sha

# The worker service's deployed commit, from Railway:
railway status --service m7-dev-cloud-worker              # → deployment + commit

# They must BOTH contain the worker protocol as it stands at 161465c or later.
git log --oneline 161465c..<each sha> -- src/api/worker.routes.js src/lib/worker/ src/worker-client/
```

If that last command prints nothing for both, the two sides share the same protocol surface and
are compatible. If it prints commits for one and not the other, **the two are skewed on the files
that define the protocol** — redeploy the lagging side before enrolling. `src/worker-client/` is in
the list because the container runs it, and `src/api/worker.routes.js` and `src/lib/worker/`
because the server does.

### ACTION 4 — confirm the DEPLOYED CONTAINER, not a local command

Your Priority 1 is explicit: *"verify the actual deployed container, not merely a locally executed
railway run command."* `railway run` executes **locally** with the service's variables injected —
it proves the variables are right and proves nothing about the container, its image, or its
network path.

```sh
railway logs --service m7-dev-cloud-worker          # expect {"at":"started", …} then polling
railway ssh --service m7-dev-cloud-worker 'node /app/src/worker-client/run.js --doctor'
```

`railway ssh` runs **inside** the deployed container. `--service` is not optional: this project's
linked service is Postgres, so a bare `railway ssh` opens a shell in the database container where
there is no `node` and no `/app`, and the error reads as a broken deploy.

Expect from that `--doctor`:

| Field | Expected | Means |
|---|---|---|
| `credentialUsable` | `true` | the container found its credential |
| `credentialSource` | `development-environment-variable` | and by the development path, not some other |
| `credentialFingerprint` | **matches ACTION 3's fingerprint** | the right value landed, confirmed without either of us seeing it |
| `inboundListeners` | `0` | it opens no port — a checked fact, not a claim |
| `ready` | `true` | configuration and credential are both good |
| `authentication.state` | `authenticated` | it reached the API and the HMAC verified |

If `credentialFingerprint` does **not** match, the paste went wrong. Re-paste; do not re-enrol,
which would spend another token and leave a stale identity.

### ACTION 5 — server-side environment isolation, verified independently

Your Priority 1: *"independently verify server-side environment isolation."* The worker's own
`--doctor` is the worker's account of itself; this is the server's.

```sh
railway ssh --service m7-dev-worker-api 'node /app/scripts/check-worker-availability.js'
railway variables --service m7-dev-cloud-worker          # names only — confirm the list
```

The variable list must contain **exactly** `WORKER_API_BASE_URL`, `WORKER_ID`,
`PLAYNEXA_WORKER_ENV`, `PLAYNEXA_DEV_WORKER_SECRET`. If `DATABASE_URL`, `ANTHROPIC_API_KEY`,
`RESEND_API_KEY` or any production credential appears, **the isolation requirement is not met** —
remove it before enrolling or revoke and start again. The worker needs none of them, so their
absence is the control rather than a policy.

---

## 1a. Incremental Railway cost, before provisioning

Your Priority 1: *"provide any incremental Railway cost before provisioning."*

**I cannot quote your actual bill** — I have no access to your Railway account, your plan, or your
current usage, and a figure I inferred would be a guess presented as a number. What I can give you
is the resource shape, which is what the cost is computed from:

| Resource | What this service uses | Why |
|---|---|---|
| Replicas | **1** | one poller; two is not what this milestone measures |
| Memory | a single Node process, no server, no browser, no database pool | it holds one task at a time |
| CPU | near-idle between polls; a short burst per task | `synthetic.echo` is trivial work |
| Egress | HTTPS to the API only, small JSON | no provider calls, no file transfer |
| Storage | none | it writes nothing to disk |
| Public networking | **disabled** | so no ingress is billed and no port is exposed |

On Railway's usage-based pricing this is the cheapest shape a service can have — an always-on
process that is mostly asleep. **Check the number yourself before provisioning:** Railway shows a
projected cost per service in the dashboard, and your plan's included usage may absorb it
entirely. If the projection surprises you, the whole pilot can run with the service **paused**
between test windows, since the worker holds no state and enrolment survives a restart.

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

## 6. Rollback — REVOKE FIRST, THEN REMOVE

Your Priority 1: *"rollback must revoke the identity before removing the service."* That ordering
is not a formality and my first version had it backwards, treating deletion as the rollback and
revocation as an aside.

The reason: a deleted service's **credential still exists**. The secret was in its environment, it
may be in a deployment-history entry, in a snapshot, or in whatever you pasted it from. Deleting
the service removes the *runtime* and leaves a valid identity that the API will still
authenticate. Revoking first makes the credential worthless, and then the service is just
infrastructure.

```sh
# 1. REVOKE — the credential stops working immediately, server-side.
railway ssh --service m7-dev-worker-api   'node -e "require(\"/app/src/lib/worker/identity\").revokeWorker(process.env.W, {reason:\"pilot rollback\"}).then(()=>console.log(\"revoked\"))"'   --env W=<the worker id>

# 2. CONFIRM the revocation took effect, from the server's side.
railway ssh --service m7-dev-worker-api   'node -e "require(\"/app/src/lib/db\").query(\"SELECT id, revoked_at FROM worker_identities WHERE id=$1\",[process.env.W]).then(r=>console.log(r.rows))"'   --env W=<the worker id>
# revoked_at must be non-null. Until it is, step 3 would leave a live credential behind.

# 3. ONLY THEN remove the service.
#    Railway → m7-dev-cloud-worker → Settings → Delete service.
```

`check-cloud-worker-process-db.js` §7 proves step 1 is sufficient on its own: a revoked worker
claims nothing **even though its secret is still sitting in its environment**, because the server
is what refuses. That is the only place revocation can be enforced, and it is why revoking is a
real rollback rather than a tidy-up.

**Partial rollback, if you want to stop it without unwinding anything:** revoke the identity and
leave the service running. It will poll, be refused, and log the refusal — no tasks execute, no
state changes, and re-enrolment later is a fresh token. Pausing the service does the same without
touching the identity.

The service holds no data and writes to no database directly. Every row it created is an ordinary
`worker_tasks` / `worker_results` row in the **development** database.
