# PlayNexa — Autonomous OS Current State

**Date:** 2026-10-27 · **Method:** five parallel code audits, verified by reading implementation, not filenames · **Scope:** `narenghub/playbookos` at `1eba5e9`

---

## The one-line characterisation

**This is a well-engineered, heavily instrumented cron-driven batch system with one durable email workflow. It is not an agent runtime.** There is no delegation, no event bus, and no scheduler of agents. There is a clock, and 41 entries against it.

That is not a criticism of the work. Much of what is here is better than typical production code, and the operational reasoning written into the comments is the best asset in the repository. But the gap between what the system *is* and what §3 of the vision describes is structural, not incremental.

---

## Measured scale

| | |
|---|---|
| JS files | 399 |
| API routes | **271** across 4 route files |
| `CREATE TABLE` in `src/lib/db.js` | 55 |
| Migration scripts | 39, **none invoked at boot** |
| Agent modules | 24 |
| Roles | **14** (not 12 — the handoff doc omits `business_dev` and `partner`) |
| Cron jobs | **41** |
| Test files | 111 |
| `server.js` / `public/index.html` | 963 / 9,850 lines |

**The project handoff document is substantially out of date.** It describes a much smaller system, lists Stripe as "❌ Not built" when a signature-verified webhook exists at `src/api/routes.js:2221`, and omits two roles. `VISION.md` Appendix C lists ~23 crons where the code has 41. Neither document can be used as evidence of what exists — which is exactly what §28 of the brief anticipated.

---

## 1. Agent framework — PARTIAL (built, wired to nothing)

Two architectures exist. Only one runs.

**What runs:** 24 modules each exporting a differently-named async function — `runCEOBriefing`, `runProcurementAgent`, `runInquiryAgent` — with its own signature and ad-hoc return shape, called directly from `cron.schedule` blocks. They share one helper file, `src/lib/agent-core.js` (173 lines): `logAgentActivity`, `isHighImpact`, `enqueueApproval`, `createDailyTask`. No base class, no interface, no lifecycle, no registry.

**What is built and dead:** `src/lib/agents/contract.js` (152 lines) and `src/lib/agents/gate.js` (205 lines) are a genuine governance layer — a validated declarative registry with load-time fail-fast checks (`contract.js:111-126`), feature keys resolved against the permissions registry rather than a reinvented authz model, dependency injection as a test seam, and a single spine in `gate.js:66-125` that resolves permission, **fails closed on resolver error** (`gate.js:88`), audits allow and deny identically, times execution and never throws.

`callAgent`/`callTool` have **zero production call sites**. `gate.js` is imported only by its own test. The registry declares **2 of 24 agents**. `contract.js:5` says so itself: *"nothing imports this file yet."* `scripts/migrate-tool-audit.js:1` adds *"NOT wired into boot"* — so even the audit sink may not exist in the live database.

**Agent identity in production is a string literal**: `const AGENT = 'orchestrator'` (`orchestrator.js:16`), written into a free-text column. Nothing validates it against anything.

## 2. Agent registry — PARTIAL (in-code, 2 entries; no DB registry)

No `agent_registry` or `agent_capabilities` table exists in any of the 39 migrations. The only registry is the 2-entry array at `contract.js:54`.

## 3. Delegation — MISSING agent-to-agent; COMPLETE agent-to-human

No agent can delegate to another. No task envelope, no task id passed between agents, no callback. Composition happens only as direct function calls in one process (`orchestrator.js:96-110`), and **ordering between agents is encoded in cron offsets, not code** — see `server.js:320-326`, where the Email Engine must run 30 minutes after Market Intelligence because it reads rows the earlier job writes. That is a real pipeline dependency expressed as a clock offset.

Agent→human assignment is real and well built: `createDailyTask` (`agent-core.js:81-114`) with `source_kpi`, `agent_name`, `reasoning`; read back by the scorer; idempotent per user per day (`orchestrator.js:31-34`).

Three tables that look like infrastructure and are not:
- **`agent_messages`** — created at `db.js:498-506`; that is its only reference in the entire repo. Zero inserts, zero selects. Despite the name its columns are an email-tracking schema.
- **`execution_steps`** — a seeded project-plan checklist for humans (`db.js:219-223`). No agent touches it.
- **`ingested_events`** — a genuinely good write-only sink. No consumer anywhere.

## 4. Orchestration — PARTIAL (a router and a scorer, not an orchestrator)

`runMorningBriefing` (`orchestrator.js:87-120`) is a hardcoded if-chain over four segment strings. No dependency graph, no agent selection, no data passed between calls.

The rest of that file is excellent and unrelated to orchestration: `runPerformanceCheck` (147-293) is a careful four-component scorer with idempotent upserts, and `runEscalationCheck` (298-425) a four-tier ladder with weekend skip, new-account grace and CEO digest batching. The `SEGMENT_ROLES`/`EXEMPT_ROLES` allowlist (68-79) is the best single piece of engineering judgement in the repo.

## 5. Scheduling — COMPLETE (41 crons, all real)

26 run in `America/Chicago`, **11 in UTC** — the job names honestly encode which. All are wrapped in `withAlerts`. **Only 4 of 41 check an enabling flag.**

## 6. Event system — MISSING

`src/lib/events/` is two unrelated things: a **trade-show registry** (CPHI, SCOPE — conferences, with per-role ranking rules) and a real **event ingest sink** (`ingest.js`, bearer-secret per source, product derived from the credential rather than the payload, payload-hash idempotency — genuinely good) that is **flag-gated off by default and has no consumer**.

No bus of any kind: no `LISTEN`/`NOTIFY`, no queue, no broker. Inbound webhooks exist and are real (orders, Stripe with HMAC + replay window), but each handler does its work inline and fires nothing onward.

**Everything downstream of an event is a timer.** The most load-bearing signal in the business — a supplier or customer reply — is discovered by hourly Gmail polling.

## 7. Workflow engine — PARTIAL (one real sequencer)

No general engine. One genuine durable workflow, and it is good: the outreach sequencer. Persistent per-subject state with a status CHECK and `next_due_at`; a UNIQUE index on `(channel, ref)`; **claim-before-act** — the send row is INSERTed *before* Gmail is called, so a race loses on the constraint rather than double-sending (`outreach-agent.js:274-283`, `23505` → decline). Deliberately **no retry**: a failed send keeps its claim row carrying the error, blocking blind retry and leaving an unconfirmed row for a human. That is the right choice for outbound mail.

Nothing else — procurement RFQs, inquiries, meetings, escalation — has persisted step state.

---

## 8. Authentication & RBAC — COMPLETE at the route layer

JWT HS256, 7-day expiry (`core.js:14-16`). The notable decision: **the token is authentication only; authorization is re-read from Postgres on every request** (`core.js:51,77`), so deactivation and role change are live. Documented with the incident that caused it.

**231 of 271 routes (85%) carry a server-side role gate.** `requireTier` ×82, `adminOnly` ×70, `requireAnyTier` ×56, `superAdminOnly` ×10. The claim that roles only drive UI is false — UI gating is additional. The 13 ungated routes are webhooks with shared-secret or HMAC checks, plus 5 intake routes using a consumable emailed token.

**Gaps:** no refresh, no logout, no revocation list, no `jti`. A stolen token for an account that stays active and keeps its role is valid for 7 days. `authMiddleware` **fails open** if the role lookup throws (`core.js:60-62`) — a documented, conscious trade.

## 9. Company isolation — PARTIAL, and route-shaped rather than data-shaped

**There is no tenant concept in the schema.** Zero `tenant_id`/`workspace_id`/`company_id` columns across all 55 tables.

What exists is a product boundary: 6 grantable products in `user_products`, granted per person rather than derived from role, logged, guarded by `superAdminOnly`. The design reasoning is sound.

**The decisive limitation: the product is resolved from the ROUTE, not the data.** Row-level resolution covers exactly two tables, one of which maps to `null` (`resolve-product.js:20`). No table has a `product` column. So the boundary stops a caller reaching an endpoint; it cannot stop a shared endpoint returning rows belonging to several businesses. **"No casual data leakage" is not established at the query layer.** Default mode is `shadow` — log-only, blocks nothing.

## 10. Credentials — PARTIAL

Everything comes from `process.env` at call time. No broker, no vault, no short-lived issuance — **except Gmail, which is the strongest credential path in the repo**: a Workspace service account with domain-wide delegation minting short-lived tokens impersonating a named mailbox, subject mandatory, scope sets probed narrowest-first, and the minted token **validated against the right mailbox before being handed to a caller** (`gmail/client.js:84-89`).

`outbound/credentials.js` implements dual-slot rotation for zero-downtime cutover. `algolia-keys.js` splits scoped keys but **every scoped getter falls back to the full write key**, so least privilege is aspirational.

## 11. Agent permissions — BROKEN

**19 of 24 agent modules import the shared connection pool directly** and query with full privilege. No `SET ROLE`, no per-agent database user, no row-level security. Agents run on cron outside any HTTP request, so they never pass through `authMiddleware`, the permissions resolver or the product boundary. **Every agent has unrestricted read/write to all 55 tables across all 6 products.**

The layer that would change this exists, is tested, has its migration written, and is called by nothing.

---

## 12. Approvals — PARTIAL

**One genuine blocking gate exists.** `procurement-agent.js:271-291` selects only `status='approved'` rows before creating RFQs, and supplier emails go out exclusively from that set. Outbound procurement solicitation really is approval-gated.

**Everything else is written and never blocked on.** Performance escalations, HR items and sourcing tasks reach `approval_queue`, and approving them `INSERT`s a `daily_tasks` row for a human to act. Nothing was held back. At `orchestrator.js:345-371` the escalation email and WhatsApp **are already sent before the approval row is created**.

**`isHighImpact()` — the only generic definition of "this needs a human" — has zero call sites.** `VISION.md:328` lists it as built.

No contract, payment, pricing-exception or regulatory path touches the queue at all.

## 13. Audit trail — PARTIAL

~40 call sites across 15 agents, genuinely read back by `GET /api/agent/activity` and the Agent Control page. Against the vision's four questions: *which agent* — yes. *Which model* — no column. *What did it cost* — no column. *Can it be reversed* — no entity reference, no before/after, no idempotency key.

`requires_approval` is written; `approved_by`/`approved_at` on that table **never are**. Most call sites swallow failure with `.catch(() => {})`, so a broken audit table yields a silently incomplete log.

## 14. Observability — PARTIAL; the cost ledger is unwired

`GET /api/agent/mission-control` derives per-agent last-run, errors-today and status — **by string-matching `output_summary` for `'%error%'`**. There is no run table; an agent that fails before it logs is invisible, and "running" is inferred from cron arithmetic plus an in-process Set that dies with the container.

**Cost is computed in three places and aggregated in none.** `llm.js:44` returns `{usage, costUsd}`; it is surfaced as a toast and discarded. `grep SUM(cost_usd)` returns nothing. **Nobody can answer "what did the platform spend yesterday."**

The table designed to hold cost, tokens, latency and decision — `tool_call_audit` — is written only through the gate nothing calls.

## 15. Memory provenance — PARTIAL, split sharply

**Excellent where someone wrote it deliberately.** `research_people.email_basis NOT NULL CHECK ('published','pattern_inferred','confirmed')` is the "UNKNOWN beats WRONG" principle actually encoded in a column — a guessed address is structurally marked unmailable. `supplier_products` separates extractor confidence from a human review layer *"Never written by the extractor"*. `contact_suppression` is keyed on the address so an objection survives re-ingestion.

**Absent in the core tables.** `clinical_studies` has classification provenance but no `source_url`, no review status, no owner — nothing can be marked disputed. `agent_activity_log`, `daily_tasks`, `approval_queue`, `kpi_hierarchy`, `orders`, `targets` have none. **Agent-asserted KPI and revenue figures carry no source.**

No two tables use the same vocabulary. There is no shared convention, only well-written one-offs.

## 16. Learning loop — MISSING in substance

`migrate-lead-outcomes.js` is the best-designed schema in the audit: `reason NOT NULL`, append-only enforced by a trigger that raises on UPDATE or DELETE, current state derived via a view rather than stored.

**The only writer is a human typing a CLI flag.** No agent, route or cron writes a delivery or an outcome; `grep` across `src/` returns nothing. **Nothing reads outcomes to adjust behaviour** — every scorer and threshold is static. The migration is not run at boot, so the tables exist in production only if someone ran it by hand.

`performance_scores` is a real loop, but it measures *humans*. **No agent output is ever scored against what happened.**

## 17. CEO brief / decision queue — PARTIAL

A substantial brief exists (`ceo-agent.js:38-140`) and a **second, overlapping one** (`briefing-agent.js`) independently re-queries the same data and sends its own email. Two agents, two emails, no shared data layer.

**There is no single "decisions requiring you" queue.** The CEO brief reads `approval_queue` and uses only `pendingApprovals.length` — a count in a footer. The items are never listed, linked or prioritised. Decisions are scattered across at least five unconnected surfaces.

---

## 18. Kill switch — MISSING

No global pause. No runtime pause of any kind. No credential revocation. `/api/agent/mission-control/:key/run` only **starts** agents; there is no stop.

**29 of 41 crons are gated by nothing at all.** And the flags are not a kill switch in practice: `process.env` is captured at launch, so changing a Railway variable does nothing until redeploy — a fact this repo documents at length because it cost a whole send on 12 October. **The only control is redeploy-to-change-one-feature.**

The one granular pause that works is per-contact (`outreach_state.status='halted'`), set by hand via `railway ssh`, one address at a time.

## 19. Failure handling — PARTIAL; there is no retry

`withAlerts` is the whole mechanism: on a throw, email and swallow. Its own header admits *"soft errors logged via try/catch inside the body are NOT alerted on"* — and agents are written to a never-throw contract, so **an agent returning `{error}` for every item runs green**.

**No timeouts on cron bodies, no retries, no backoff, no dead-letter queue, no incident records, no re-entrancy lock.** Four jobs fire simultaneously at Monday 08:00.

**`src/lib/llm.js:60` — the shared Claude wrapper every agent uses — has no timeout and no AbortController.** A hung request hangs that cron indefinitely with every monitor green. Its sibling `outbound/http.js:4` names the gap explicitly.

## 20. Idempotency — PARTIAL; strong on the newest paths

Claim-before-act with UNIQUE indexes on the campaign path; 57 `ON CONFLICT` clauses; email-ID claims on inbound processing.

**Non-idempotent:** every outbound-email cron that is not a campaign (CEO brief, US-team brief, coaching emails, reorder agent, data-accuracy report — two manual triggers = two emails) and `POST /api/agent/tasks/generate`, which duplicates the whole day's tasks for every user if pressed twice.

## 21. Rollback — MISSING

No undo, no compensating actions, no versioning. Recording exists (`agent_activity_log`, `email_log`, stored `rfc822_id`), which is the raw material for a manual reversal and nothing more.

## 22. Testing — PARTIAL, excellent at one thing

111 test files. No `npm test`; the entry point is `scripts/preflight.sh`, which runs 13 steps.

**Seven of those run against a real Postgres** — spinning a throwaway cluster, running the shipped SQL, tearing down in a `finally`. That is a rare and genuinely strong class of test. **But they self-skip**: on a machine without `initdb`, 7 of 13 steps pass by doing nothing and preflight still prints `PASS safe to push`.

Adversarial tests exist and are well constructed — `intake-scope.test.js` asserts that no secret string appears at any depth in any response, a negative assertion that catches a column added later.

**Absent:** no end-to-end test of a cron firing, and **no failure injection at all** — nothing simulates a Gmail 500, a hung Claude call, a DB disconnect mid-send, or two cron runs racing for the same claim row.

## 23. Deployment — no gate

`git push main` → Railway autodeploy. **No CI, no workflows, no hooks.** `preflight.sh` is a convention a human must choose to run, and CLAUDE.md explicitly forbids chaining it to the push — correct reasoning about exit-code misreading, but it means **the only gate is discipline**.

Post-deploy verification is good (`smoke-deployed.sh`: commit match, health, deployed-page parse, anonymous 401) but it is detection after the bad code is already serving, and only if somebody runs it.

---

## 24. Silent failure — where the repo is best and worst

This is the system's defining characteristic, in both directions.

**The guards are real and unusually thoughtful.** `alertSendFailure` escalates a Resend authorisation refusal after 1,113 emails were lost over eight weeks to *"every layer doing the right local thing and the aggregate being silence."* `sendEmail`'s return type was deliberately **not** widened to an object because every `if (await sendEmail(...))` would become unconditionally true. The outreach agent **names** the people it skipped and the field that was missing, because *"'22 not routed' is what hid a broken department check for a day."* A greeting that cannot render is fatal rather than degraded. `rs.replied === null` skips rather than guessing.

**And two live defects were found in the safety net itself, both fixed today:**

- **`server.js:712`** — `let r` scoped inside a loop, read outside it. The hourly reply-sync threw `ReferenceError` on **every run, including every successful one**, after the work had completed. `withAlerts` emailed a cron-failure alert **24 times a day for eighteen days**. The warning it was trying to print had never once appeared. Fixed in `0ac855f`.
- **`cron-alerts.js:46`** — `await sendEmail(...)` with the boolean dropped. A refused alert left a cron failure as a console line and nothing else. The one path whose entire job is to break silence could fail silently, in exactly the way this codebase already wrote an essay about. Fixed in `1eba5e9`.

The first is the clearest available evidence that **the alert channel is not being read** — which is what alarm fatigue does, and why the second mattered.

**Also still open:** 81 swallowed exceptions in non-test `src/`; 17 bare `await sendEmail(...)` with the result dropped, including the briefings that constitute the entire human-oversight channel — and `mailer.js:22-28` records that two of those senders are **still 403ing**.

---

## The pattern worth naming

**This repository consistently builds the correct abstraction and then does not adopt it.**

`contract.js`, `gate.js`, `outbound/http.js`, `llm.js`, `migrate-lead-outcomes.js`, `permissions/registry.js` are each well-written, well-documented, and used by between **0 and 8** of their 11–19 potential call sites. The governance layer, the timeout layer, the cost layer and the learning layer all exist as islands.

**The best engineering in the repo is in the unwired parts.** The wired paths are the thin ones.

That is the actual finding. Not that capabilities are missing — several are built to a higher standard than the running code — but that **nothing connects them to execution**. Which is, precisely, what a control plane is.
