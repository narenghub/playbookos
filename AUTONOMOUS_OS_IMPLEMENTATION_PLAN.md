# PlayNexa — Implementation Plan to a Safe Autonomous Operations MVP

**Date:** 2026-10-27 · The smallest sequence from here to §34's definition of done

**Governing rule:** no step may increase what agents can do before increasing what can stop them.

---

## Day 0 — not engineering, and more urgent than all of it

**Rotate the GitHub PAT, the Postgres password, the admin password and the three webhook secrets.** They are in cleartext in the handoff document, which is shared and has been for weeks. The PAT has write access to the repository that auto-deploys to production.

This has been raised five times in this session. Everything below is wasted effort if the credentials stay live.

---

## P0 — safe to leave running

### P0.1 Kill switch · ~0.5 day · **do this first**

`system_state` table with scopes `global | company | agent | campaign`. Consulted at the top of `withAlerts`, so all 41 crons inherit it at once. A route and a button on Agent Control. A pause logs and returns — it must not raise an alert, or pausing becomes noisy and stops being used.

**Done when:** pausing an agent from the browser stops its next run with no redeploy, and the audit record says who paused it and when.

### P0.2 Timeout on `llm.js` · ~0.5 day

One `AbortController`, default 120s, configurable per call. Today a hung Claude request hangs its cron indefinitely and every monitor stays green — structurally the same hole as the 30 September outage CLAUDE.md is written about.

**Done when:** a test that stalls the fetch causes the call to reject within the timeout, and `withAlerts` emails.

### P0.3 Run ledger · ~1 day

`run_ledger` written at start and end of every cron body, again via `withAlerts`. Replaces status-by-string-matching. Carries `cost_usd`.

**Done when:** `SELECT SUM(cost_usd) FROM run_ledger WHERE started_at > now() - interval '1 day'` answers a question that currently has no answer anywhere in the system.

### P0.4 Close the remaining silent-failure holes · ~1 day

17 bare `await sendEmail(...)` with the result dropped, starting with the briefings — `mailer.js:22-28` records that two of those senders are **still 403ing**, which means oversight email is currently failing and nobody is told. Add a `--check` mode to preflight that fails when a Postgres-backed check *skips*, so 7 of 13 steps can no longer pass by doing nothing.

**Done when:** a refused briefing email appears as a named failure, and preflight cannot print PASS on a machine where half its checks did not run.

### P0.5 Route agents through `gate.js` · ~2 days

Register all 24 agents in `contract.js`; run `migrate-tool-audit.js`; replace direct calls in `server.js` with `callAgent`. **Order: external-text readers first** — `inquiry-agent`, `meet-agent`, `prospecting`, `research-intelligence` — because they are the prompt-injection surface and currently hold unrestricted database privilege.

**Done when:** `tool_call_audit` has a row per agent run with decision, cost and tokens, and an agent with a revoked feature key is refused rather than running.

### P0.6 Autonomy tiers + blocking approval · ~1.5 days

Add `tier` to each registry entry. `gated()` consults `isHighImpact()` for Tier 2 and `approval_queue` for Tier 3 — **blocking**, in the shape that already works at `procurement-agent.js:271-291`, where only `status='approved'` rows produce action.

**Done when:** a Tier 3 action does not execute until approved, and approving it *executes* rather than creating a to-do.

### P0.7 Global spend ceiling · ~0.5 day

Daily USD cap read from `run_ledger`, checked in `gated()`. The pattern exists at `research-intelligence/index.js:183-189` — generalise it.

**Done when:** exceeding the cap pauses autonomy and emails, rather than continuing.

**P0 total: ~7 days of focused work.**

---

## P1 — useful enterprise autonomy

| | Effort | Note |
|---|---|---|
| Event worker consuming `ingested_events`, starting with `CUSTOMER_REPLIED` | 2d | Keep the hourly poller as fallback, do not replace it |
| `llm.js` as sole provider path — collapse the 11 hand-rolled fetches, central model aliases | 2d | Prerequisite for any provider failover |
| Learning loop wired at both ends — outreach writes deliveries, reply classifier appends outcomes | 2d | Schema already exists and is excellent |
| Single decision queue aggregating the five scattered surfaces | 2d | The CEO brief prints a count today; it should print the items |
| Migration runner with a version table | 1d | 39 scripts currently run by hand; the live schema is unknown |
| Dedup keys on the non-campaign email crons | 1d | Two manual triggers currently send two emails |

---

## P2 / P3

**P2:** `product` column across business tables + `enforce` mode — mechanical, large, and the only honest route to company isolation. Timing-safe webhook comparison. Outbound 429 handling and backoff. Resolve the duplicate CEO brief.

**P3:** Mac mini edge node. Executive Agent. CEO mobile surface. Auto-rollback and canary.

---

## End-of-week demonstration (§34)

The brief asks for one complete production-quality workflow, and **the honest answer is that most of it already runs**. The Abiozen revenue loop currently works from Lead through Reply:

```
Mon 06:20  ingest        NIH RePORTER + Europe PMC → research_labs       ✅ running
Mon 07:00  accuracy      measured per source, emailed                    ✅ running
Weekday    route         need derived from evidence, fail-closed          ✅ running
09:10      send          claim-before-act, filed, spaced                  ✅ running
Hourly     reply sync    marks replies, stops sequences                   ✅ running (fixed today)
           ─────────────────────────────────────────────────────────────
           RFQ → supplier check → pricing → margin → quote                ❌ not closed
```

**8 real emails went to funded chemistry PIs on 26 October**, each opening with that professor's own grant number, every claim traceable to a `reporter.nih.gov` URL.

So the demonstration should not be a new workflow. It should be **the same workflow, governed**:

1. The 09:10 send runs through `gate.js`, with a tier, a spend check and an audit row per call.
2. `run_ledger` shows it started, finished, what it cost, and how many it declined and why.
3. A Tier 3 action — a quote above a threshold — **blocks** in `approval_queue` until approved from the browser.
4. Pausing the outreach agent from Agent Control stops the next run, with no redeploy.
5. The daily report names who was written to, the claim made to each, and who was skipped and for which missing field.

That is `EVENT → PLAYNEXA → AGENT → PLAN → TOOLS → ACTION → VERIFICATION → AUDIT → OUTCOME → DASHBOARD` on a workflow that is already producing real commercial contact — rather than a new demo built beside it.

**What it still will not prove:** that the loop closes to revenue. RFQ → Quote → PO is not built, and no amount of governance substitutes for it. That is the next business milestone, and it is a different piece of work from this one.

---

## Decisions that need the CEO, not the engineer

Per §35 of the brief, escalating only genuine business, security, cost or architecture decisions:

1. **Does the agent quote autonomously, or draft for approval?** This is the live question from the sourcing-inbox conversation. The catalogue is **95% unreviewed** (21 of 422 approved) and "can we source it" is often a phone call to BLD. My recommendation is draft-for-approval until outcome data exists — but the risk is yours to accept.
2. **Is `product` isolation worth the migration?** It is the largest single piece of work in this plan. If Abiozen, AROS and Linkabl will never share an endpoint or a customer, route-level separation may be sufficient for now. If they will, this is unavoidable and gets harder every month.
3. **What is the daily AI spend ceiling?** Needed to implement P0.7. There is no current figure because nothing aggregates cost.
4. **Which model family, pinned where?** Four families are in use, two stale. Consolidating is cheap now and expensive later.
5. **Does the Mac mini happen at all?** Nothing in the revenue loop needs it. It is a real capability with a real security surface, and it is P3 in my reading. If it is P0 in yours, say so and I will design it properly.

---

## What I have changed today, and what I have not

**Changed — two live defects, both in the safety net, neither architectural:**

- `0ac855f` — the hourly reply-sync threw `ReferenceError` on every run including every success, emailing a false cron-failure alert 24 times a day for eighteen days.
- `1eba5e9` — the alert path itself dropped `sendEmail`'s return, so a refused alert left a cron failure as a console line and nothing else.

**Not changed:** no architecture, no new agents, no production infrastructure, no schema. Per §36 STEP 6, this assessment stops here pending review.
