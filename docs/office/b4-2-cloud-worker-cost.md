# The development cloud worker: measured footprint and what it will cost

**2026-11-26, for Priority 3 of the third directive:** *"Provide exact Railway service
configuration, expected incremental monthly cost, resource requirements, credential enrollment
procedure and owner actions. Do not provision paid infrastructure until I approve the cost."*

The service configuration, the enrolment procedure and the owner actions are in
`docs/office/b4-2-cloud-worker-owner-checklist.md`, which is unchanged and still accurate. **This
document is the part that was missing: the cost.** Nothing has been provisioned, and nothing will be
until you say a figure is acceptable.

---

## 1. The footprint, measured rather than estimated

`scripts/measure-worker-footprint.js` enrols a real worker identity against a real server, spawns
`src/worker-client/run.js` as a real subprocess, and samples `/proc/<pid>/status` and
`/proc/<pid>/stat` every 2.5 seconds for a minute. Run on 2026-11-26 in this Linux container, which
is the same platform Railway runs:

| measured | value |
|---|---|
| Resident memory, median | **72.1 MiB** |
| Resident memory, peak over the window | **73.3 MiB** |
| CPU consumed over 57.5 s | **0.15 CPU-seconds** |
| CPU as a fraction of one vCPU | **0.00261** (0.26 %) |
| HTTP requests to the API | **12 per minute** (the 5 s idle poll, as `client.js` sets it) |
| Request + response bodies | **792 bytes per minute**, 66 bytes per request |
| Inbound listeners | **0** — the worker opens no port |

**What the measurement does not include**, stated so the figures are not read as more than they
are: it measures request and response **bodies** over plain HTTP against a local server. Real
traffic adds HTTP headers, the HMAC signature, TLS handshakes and DNS. At a pessimistic 1 KB per
request that is ~518 MB of egress a month rather than the ~1 MB the bodies imply — which changes the
total by about **three cents**, so the omission does not matter to the decision. It is named anyway,
because an unstated omission in a cost estimate is how a cost estimate becomes wrong later.

It also measures the worker **idle**. A worker executing a task uses more CPU for the duration of
that task. The only work it is authorized to execute is `synthetic.echo` with no capabilities
granted, which is a few milliseconds of JSON handling; but the figure below that bounds this is the
configured limit, not this measurement.

---

## 2. Railway's rates, as its own documentation states them

Fetched from `docs.railway.com/pricing/plans` on 2026-11-26:

| | rate |
|---|---|
| Memory | **$10 per GB per month** ($0.000231 per GB-minute) |
| CPU | **$20 per vCPU per month** ($0.000463 per vCPU-minute) |
| Network egress | **$0.05 per GB** |
| Hobby plan | $5/month, **including $5 of usage** |
| Pro plan | $20/month, **including $20 of usage** |

Included usage resets each cycle and does not accumulate; you pay the difference only if usage
exceeds it.

> These are standard container rates. Railway's **VM** rates (sandboxes and cloud agents) are
> $50/GB and $50/vCPU — five and two-and-a-half times higher. The worker is an ordinary container
> service and must not be created as a sandbox or cloud agent. Confirm the service type when you
> create it, because that single choice is the difference between the figure below and roughly five
> times it.

---

## 3. The expected incremental monthly cost

From the measured footprint at the published rates, for a service running the whole month
(730 hours):

| | computation | per month |
|---|---|---|
| Memory | 0.0769 GB × $10 | **$0.77** |
| CPU | 0.00261 vCPU × $20 | **$0.05** |
| Egress | ≤ 0.52 GB × $0.05 | **$0.03** |
| | | **≈ $0.85 / month** |

**And the figure you may actually be charged is lower, possibly zero.** This is *usage*, and both
plans include usage: if the account's total usage for the cycle stays under the plan's included
amount, the incremental charge for this service is **$0.00**. Whether that is the case depends on
what the rest of the project is already consuming, which only your Railway dashboard knows. I have
not looked at it and will not without being asked.

### The honest shape of this number

**$0.85 is an expectation derived from a one-minute measurement. It is not a proven maximum charge,
and I am not presenting it as one.** The same reasoning the provider-spend work has to follow
applies here: a conservative estimate of what something costs is not a bound on what it can cost.
Three things could make it higher:

- a **crash loop**. The process exits non-zero on an unusable credential precisely so a supervisor
  retries it, and a restart loop burns CPU on process startup rather than idling. Measured startup
  is a fraction of a second, so even a restart every 10 seconds stays under a dollar a month — but
  it is a different regime from the one measured.
- **executing real work**, if the worker's capabilities are ever widened beyond the synthetic task
  it is enrolled for. They must not be: the enrolment script refuses `exec:hardware` and `exec:gui`.
- **a Railway pricing change.** The rates above were read on 2026-11-26 and are theirs to change.

### The figure that *is* a bound

A **configured resource limit is a hard bound; an estimate is not.** Railway lets a service be
capped, and that is the number worth approving, because it is the one the platform enforces rather
than the one I predict:

| if you cap the service at | the arithmetic maximum is |
|---|---|
| **256 MiB / 0.25 vCPU** (ample: 3.5× measured memory, 96× measured CPU) | **$7.68 / month** |
| | 0.2684 GB × $10 = $2.68, plus 0.25 vCPU × $20 = $5.00 | |
| 512 MiB / 0.5 vCPU | $15.37 / month |

**My recommendation: approve the 256 MiB / 0.25 vCPU cap.** The worker then cannot cost more than
$7.68 a month in resources no matter what it does, the expectation remains $0.85, and the headroom
is still more than thirty times the CPU it was measured using. If it ever hits that ceiling,
something is wrong and a capped service is the right place to find out.

### And a second, account-level bound

Railway supports **usage limits**, and this is the Priority 5 question — "is the provider-side
control a hard limit?" — asked about infrastructure instead of a model. Verified against Railway's
own documentation (`docs.railway.com/reference/usage-limits`, read 2026-11-26), there are two and
they behave differently:

- a **hard limit**, which **is** a hard stop for compute: at 100 % *"all your workloads will be
  taken offline to prevent them from incurring further resource usage"*, with reminder emails at
  75 %, 90 % and 100 %. So the spend cannot run away; the price of that guarantee is that reaching
  it takes **everything in the workspace** down, production included.
- a **custom email alert**, which Railway's own page calls *"a soft limit"*: an email, and
  *"your resources will remain unaffected."*

**Recommendation, and the reason it is not simply "set the hard limit low":** the hard limit is
workspace-wide, so a low one is a self-inflicted production outage waiting for a busy month. Set the
**soft** alert at a figure you want to hear about, keep the hard limit well above normal operation
as a true backstop, and let the **per-service resource cap** above be the thing that bounds *this*
worker. A per-service cap bounds one service without being able to take the others down.

Railway's documentation does not say whether workloads restart automatically in the next cycle after
a hard limit fires, so that is not claimed here.

---

## 4. What I am asking you to approve

One figure, and it is the ceiling rather than the expectation:

> **A development cloud worker service capped at 256 MiB memory and 0.25 vCPU, expected to cost
> about $0.85 per month in usage and unable to exceed $7.68 per month, created as a standard
> container service in the `playnexa-m7-dev` project, with no production credentials and no
> database access.**

On your word, the four owner actions in `b4-2-cloud-worker-owner-checklist.md` become live and I can
then demonstrate what Priority 3 asks for: a real cloud worker claiming and completing
cloud-eligible work while the iMac is unavailable, with hardware-dependent work staying queued and
consuming no attempts.

Until then nothing is provisioned. Everything that can be prepared without spending money is
prepared and verified: `scripts/check-cloud-worker-process-db.js`, 15 assertions, 0 failures.

---

## 5. Isolation, restated because it bears on cost as well as safety

Development and production stay completely separate, and the cost figure above depends on it being
true: a worker that reached production would be executing real work and the footprint would be a
different measurement entirely.

- a **separate Railway project** (`playnexa-m7-dev`), not a service inside production
- **four environment variables**, none of them a production credential, none of them a database URL
- `PLAYNEXA_WORKER_ENV=development` is a required condition for the credential path to work at all,
  and `secret-source.test.js` asserts the production refusal rather than trusting a sentence
- the identity is granted **no capabilities**, so hardware and GUI work cannot be claimed by it
- **rollback revokes the identity before removing the service**, in that order, as your standing
  instruction requires — a removed service with a live identity is a credential nothing is watching
