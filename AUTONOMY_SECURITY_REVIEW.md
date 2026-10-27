# PlayNexa — Autonomy Security Review

**Date:** 2026-10-27 · Threat model for unattended operation · Evidence in `AUTONOMOUS_OS_CURRENT_STATE.md`

A system that acts without a human watching has a different threat model from one that does not. The question is not "can it be broken into" but **"what can it do wrong, at speed, before anyone notices."**

---

## Findings requiring action before autonomy widens

### S1 — The handoff document leaks live production credentials · CRITICAL

The PlaybookOS handoff document attached to this project contains, in cleartext: a **working GitHub personal access token**, the full `DATABASE_URL` **including the Postgres password**, the **admin account password**, and **three 64-hex webhook secrets** (`TRIGGERS_SECRET`, `PLAYBOOKOS_WEBHOOK_SECRET`, `ENGAGEMENT_SECRET`).

This is a larger exposure than anything in the repository, which the audit found clean of live third-party keys. The document is shared, pasted between sessions, and has been for weeks.

**Every one of those must be rotated.** The PAT grants write access to the repository that auto-deploys to production. The database password grants direct access to all 55 tables. This has been raised five times in this session and remains open.

### S2 — `scripts/init-db.js:54` hard-codes the production admin password · HIGH

`const adminPass = process.env.ADMIN_PASSWORD || '<REDACTED>';` — the fallback literal is the same string as the live admin password. The script is legacy (`better-sqlite3`, referenced from no package script or doc) so it is not a live provisioning path, but the password is committed and real, and it is in git history.

*(The literal was quoted verbatim in the first draft of this document. That was the same mistake this section is about — writing a live credential into a new committed file while describing the leak. `scripts/check-secrets.js` caught it before it was pushed, which is the argument for having the check at all.)*

`scripts/setup-db.js:113` has the same shape with a weak default rather than the production password.

### S3 — Agents hold unrestricted database privilege · HIGH

19 of 24 agent modules import the shared pool and query with full rights. No `SET ROLE`, no per-agent user, no RLS. Agents run on cron outside any HTTP request, so they bypass `authMiddleware`, the permissions resolver and the product boundary entirely.

**Consequence:** any agent defect, or any successful prompt injection into an agent that reads external text, has write access to every table of every business. Several agents do read external text — inbound email (`inquiry-agent`), web pages (`prospecting`), meeting transcripts (`meet-agent`) and registry prose (`research-intelligence`).

`gate.js` implements exactly the control needed — fail-closed authorisation, on-behalf-of identity, per-call audit — and has zero callers.

### S4 — No kill switch · HIGH

There is no way to stop an agent without a redeploy, and `process.env` is captured at launch so even a flag change requires one. If an agent begins sending wrong email at 09:10, the fastest stop is a git push through Railway's build queue — observed this week to take several minutes, and to fail entirely during a Railway incident.

### S5 — Prompt injection has no boundary · HIGH

Agents consume untrusted text and act on the result with full privilege. There is no sanitisation layer, no instruction/data separation, no output validation before action, and no tiering that would route an injected high-impact action to a human. `isHighImpact()` exists and is never called.

The most exposed path is `inquiry-agent`, which reads arbitrary inbound email, asks Claude to classify it, and creates records and sends replies from the result. The spam gate is a good defence against *noise*; it is not a defence against *instructions*.

### S6 — Token revocation does not exist · MEDIUM

JWTs are valid for 7 days with no refresh, logout, revocation list, `jti` or `token_version`. A leaked token for an account that stays active and keeps its role cannot be killed. Deactivating the user is the only lever, and it is all-or-nothing.

### S7 — `authMiddleware` fails open · MEDIUM, accepted

If the role lookup throws, the request proceeds on the token's own claims. This is documented and deliberate — availability over strictness — and it is a reasonable trade for a human-facing API. It becomes less reasonable as autonomous paths multiply.

### S8 — Webhook secrets are compared non-timing-safely · LOW

`PLAYBOOKOS_WEBHOOK_SECRET`, `TRIGGERS_SECRET` and `ENGAGEMENT_SECRET` use plain string comparison. Stripe (HMAC + `timingSafeEqual` + 300s replay window) and `/api/events/ingest` (hashed credential, timing-safe, product derived from the credential rather than the payload) are both done correctly and are the model the others should follow.

### S9 — Cost has no ceiling · MEDIUM

One $2/day cap exists, on one subsystem. The other 40 crons can spend without bound, including weekly 8,000–9,000-token opus calls. A loop or a retry storm in an agent is a financial incident with no automatic brake and no aggregate anyone can see.

---

## Threat table

| Threat | Exposure today | Control that exists | Control that is missing |
|---|---|---|---|
| Prompt injection via email/web/transcript | **High** — agents act with full DB rights | spam gate (noise only) | instruction/data separation, output validation, tiering |
| Credential theft | **High** — S1 | Gmail short-lived tokens; dual-slot rotation module | rotation of the leaked set; a broker for the rest |
| Cross-company data leakage | **Medium** | route-level product boundary | data-layer scoping; `product` column; enforce mode |
| Agent privilege escalation | **High** | none in the running path | `gate.js`, already written |
| Hallucinated action | **Medium** | evidence-or-no-send in outreach; `email_basis` | general output validation before act |
| Duplicate action | **Low on campaigns, High elsewhere** | claim-before-act + UNIQUE on sends | dedup keys on briefing/report crons |
| Infinite loop / retry storm | **Medium** | no retries exist, so no storm | timeouts, re-entrancy locks, spend cap |
| Unauthorised purchase | **Low** | procurement RFQ is genuinely approval-gated | the gate generalised to other spend |
| Unauthorised email | **Medium** | per-contact halt; suppression table | pause-per-campaign, pause-all |
| Data deletion / production destruction | **Medium** | CLAUDE.md cleanup discipline; delete-by-id | technical prevention rather than convention |
| Compromised edge node | **N/A** | — | the Mac mini does not exist yet |
| Silent failure of oversight | **Was High, now Medium** | two fixes today; `alertSendFailure` | 17 remaining dropped `sendEmail` results |

---

---

## Open follow-up: repository history remediation · OPEN · owner: CEO + engineering

**Not a Day 0 item. Rotation and revocation come first, and are sufficient to contain the active risk.**

Once rotation is verified, the leaked values remain in **git history** and in any clone taken before today:

| Where | What |
|---|---|
| `scripts/init-db.js` history | the admin password literal, in every commit before `98a0765` |
| `scripts/setup-db.js` history | a weak default admin password |
| the handoff document | GitHub PAT, Postgres DSN with password, admin password, three webhook secrets — **outside this repository and not fixable from it** |

**Why this is a follow-up rather than an emergency.** A rotated credential in history is a dead string. The urgency belongs to rotation, not to rewriting. And history rewriting is itself a risk: it invalidates every outstanding clone, breaks commit SHAs that `/health` and `wait-for-deploy.sh` compare against, and on a repository with autodeploy it can trigger a deploy of a rewritten tree.

**Decision needed:** whether to rewrite at all.

- **Do nothing** — defensible once rotation is verified. The strings are worthless. Cost: a future reader finds a real-looking password in history and has to establish it is dead.
- **Rewrite with `git filter-repo`** — removes the strings. Cost: force-push, every clone re-cloned, autodeploy paused during the operation, and a window where the deployed commit is not in the new history.

**Recommendation: do nothing to history, and fix the source instead.** The handoff document is the larger exposure and the one that keeps being pasted into new sessions. Replace its credential section with pointers to Railway variable names — that removes the live copy people actually read from, which history does not.

**Precondition if rewriting is ever chosen:** pause autodeploy, confirm no in-flight deploy, and re-run `scripts/smoke-deployed.sh` afterwards, because `wait-for-deploy.sh` compares against a commit SHA that will no longer exist.

---

## Recommended controls, in order

1. **Rotate everything in S1. Today.** Nothing else on this list matters as much, and it costs an afternoon.
2. **Build the kill switch.** A `system_state` row, a check at the top of `withAlerts`, and a route. Half a day, and it is the precondition for every other autonomy increase.
3. **Call `gate.js`.** It is written, tested and migrated. Route the agents through it, starting with the ones that read external text. This closes S3 and S5's privilege half simultaneously.
4. **Add a timeout to `llm.js`.** One `AbortController`. It closes the hung-cron hole that no monitor can see.
5. **Fix the 17 dropped `sendEmail` results**, starting with the briefings — the oversight channel must not be able to fail quietly, and two of its senders are known to be 403ing.
6. **Call `isHighImpact()` before Tier 2/3 actions**, and make approval *block* rather than create a to-do.
7. **Aggregate cost and set a global ceiling.** Until then S9 is unbounded and §21 of the vision is unmeasurable.
8. Timing-safe comparison on the three webhook secrets; `product` column and enforce mode for S6/S9's isolation half.

---

## A note on what is already good

It is worth recording, because a security review that only lists problems distorts the picture. The Gmail credential path — domain-wide delegation, mandatory subject, narrowest-first scope probing, and **validating the minted token against the right mailbox before handing it to a caller** — is better than most production systems manage. The Stripe webhook verification is textbook. `/api/events/ingest` deriving the product from the credential rather than trusting the payload is exactly right. `contact_suppression` keyed on the address so an objection survives re-ingestion is a privacy control most teams never think of.

The problem is not that this system was built carelessly. It is that **the careful parts are not the parts that run.**
