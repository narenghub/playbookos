# PlayNexa — Autonomous OS Gap Analysis

**Date:** 2026-10-27 · Classified against every capability in the CEO brief · Evidence in `AUTONOMOUS_OS_CURRENT_STATE.md`

Verdicts: **COMPLETE** · **PARTIAL** · **MISSING** · **BROKEN** (exists and does not work) · **UNKNOWN** (cannot be determined from this checkout)

---

## Summary by section

| § | Capability | Verdict | One-line reason |
|---|---|---|---|
| 4 | CEO Control Panel | PARTIAL | 33 pages, no executive home; mission-control observes and starts, cannot stop |
| 5 | Executive Agent | **MISSING** | No agent translates objectives into coordinated work |
| 6 | Company Workspaces | PARTIAL | Route-shaped boundary over one flat DB; no tenant column anywhere |
| 7 | Abiozen revenue loop | PARTIAL | Target→Contact→Outreach→Reply works; RFQ→Quote→PO→Revenue does not close |
| 8 | Linkabl recruiting loop | **MISSING** | No implementation found |
| 9 | AROS compliance | PARTIAL | `aros_establishments` page exists; no approval policy on submissions |
| 10 | AI-first engineering | PARTIAL | Strong preflight, 111 tests; no CI, no failure injection |
| 11 | AI provider abstraction | **BROKEN** | 19 Anthropic call sites, 8 use the shared wrapper; no abstraction |
| 12 | Mac mini edge node | **MISSING** | No device identity, enrolment, heartbeat or job dispatch |
| 13 | Edge node security | **MISSING** | Nothing to secure yet |
| 14 | Credential broker | **MISSING** | `process.env` at call time; Gmail is the one scoped exception |
| 15 | Autonomy tiers | **MISSING** | No risk classification on any action |
| 16 | Human-in-the-loop | PARTIAL | One real blocking gate (procurement RFQ); the rest create to-dos |
| 17 | Event-driven model | **MISSING** | No bus; everything downstream of an event is a timer |
| 18 | Agent memory | PARTIAL | Excellent provenance in 5 tables, none in the core ones |
| 19 | Agent communication | **MISSING** | No task envelope; `agent_messages` is an unused table |
| 20 | Observability | PARTIAL | Status by string-matching; **no cost aggregation anywhere** |
| 21 | Agent economics | **MISSING** | Cost computed per call, aggregated nowhere; no attribution |
| 22 | Failure handling | PARTIAL | Alert-and-swallow; no retry, no timeout, no DLQ, no incidents |
| 23 | Kill switch | **MISSING** | No pause of any kind; 29 of 41 crons gated by nothing |
| 24 | CEO morning brief | PARTIAL | Two overlapping briefs; decision items counted, never listed |
| 25 | CEO mobile | **MISSING** | 2 `@media` rules in 9,850 lines |
| 26 | Trust & explainability | PARTIAL | Can answer *which agent*; cannot answer *which model, what cost, reversible* |

---

## P0 — required for safe autonomous operation

These are the gaps that make unattended operation unsafe **today**. Everything in this tier is about preventing harm or detecting it, not about capability.

**P0.1 — No kill switch.** 29 of 41 crons cannot be stopped without a redeploy, and a redeploy is the only way to change any flag because `process.env` is captured at launch. If an agent starts sending wrong emails at 09:10, the fastest available stop is a git push. *Evidence: §18 current state.*

**P0.2 — Agents run with unrestricted database privilege.** 19 of 24 agent modules import the shared pool; no `SET ROLE`, no RLS, no per-agent user. A prompt-injected or buggy agent can write any of 55 tables across all 6 products. The gate that would prevent this is written, tested, and called by nothing. *Evidence: §11.*

**P0.3 — No retry, no timeout, no dead-letter.** `llm.js` has no AbortController, so a hung Claude call hangs its cron indefinitely with every monitor green. A transient failure is a permanent skip. *Evidence: §19.*

**P0.4 — The oversight channel can fail silently.** Two live defects found and fixed today (`0ac855f`, `1eba5e9`); **17 bare `await sendEmail(...)` remain** with the result dropped, including the briefings that are the entire human-oversight path — and two of those senders are recorded as still 403ing. *Evidence: §24.*

**P0.5 — No autonomy tiering.** Nothing classifies an action by risk. `isHighImpact()` — the only such definition — has zero call sites. Tier 3 actions (contracts, payments, pricing exceptions) have no gate at all. *Evidence: §12.*

**P0.6 — Data isolation is not enforced at the query layer.** The product boundary is route-shaped; no table carries a product column; default mode is `shadow`, which blocks nothing. A shared endpoint can return rows from several businesses. *Evidence: §9.*

**P0.7 — No deployment gate.** No CI. `preflight.sh` is a convention; nothing prevents a push that skipped it. The 7 Postgres-backed checks self-skip on a machine without `initdb` and still print PASS. *Evidence: §23.*

---

## P1 — required for useful enterprise autonomy

**P1.1 — No event bus.** The most valuable signal in the business — a reply — is found by hourly polling. Everything is a timer. *§6.*

**P1.2 — No agent-to-agent delegation.** Pipeline ordering is encoded in cron offsets. Adding a step means editing a schedule. *§3.*

**P1.3 — No cost aggregation or budget.** Cost is computed three times and summed nowhere; one $2/day cap exists on one subsystem. Nobody can answer what the platform spent yesterday, and §21's whole premise is unmeasurable. *§14.*

**P1.4 — No learning loop in operation.** The best-designed schema in the repo has one writer: a human typing a CLI flag. Nothing reads outcomes to change behaviour. *§16.*

**P1.5 — No single decision queue.** Items are scattered across five surfaces; the CEO brief prints a count, never the items. *§17.*

**P1.6 — No provider abstraction.** Swapping or failing over from Anthropic means editing 19 files. Model pins have already drifted into four families, two of them stale. *§11 of the brief.*

**P1.7 — Core tables carry no provenance.** KPI and revenue figures asserted by agents have no source. *§15.*

---

## P2 — optimisation and scale

Non-idempotent email crons (two triggers = two emails); the duplicate CEO brief; the self-skipping Postgres checks; `algolia-keys.js` falling back to the write key; 81 swallowed exceptions; no outbound 429 or backoff handling anywhere; `agent_activity_log.approved_by`/`approved_at` dead columns; no migration runner (39 scripts, run by hand).

## P3 — future capability

Mac mini edge node and its security model; Linkabl recruiting loop; CEO mobile surface; cross-company intelligence services; auto-rollback and canary release.

---

## UNKNOWN — cannot be determined from the repository

1. **Which migrations have actually run in production.** None of the 39 scripts is invoked at boot. The live schema is whatever someone executed by hand over `railway ssh`. This is the single largest unknown, and several P0 items depend on knowing it.
2. **Whether `PERMISSIONS_ENFORCE_ROLES` or `PRODUCT_BOUNDARY_MODE=enforce` are set in production.** Both default off. A design doc claims enforce since 2026-09-29; that is prose about a Railway variable and unverifiable from source.
3. **Actual spend.** No aggregation exists, so current AI cost is unmeasured rather than measured-and-acceptable.

---

## The honest framing

Counting verdicts understates the position in one direction and overstates it in another.

**Understates:** several MISSING capabilities are not greenfield. `gate.js` already implements fail-closed authorisation with a cost and decision ledger. `contract.js` already implements a validated registry. `migrate-lead-outcomes.js` already implements an append-only outcome ledger with a trigger enforcing it. **These do not need designing. They need calling.** The distance from MISSING to COMPLETE for autonomy tiering, agent permissions and the learning loop is wiring, not architecture.

**Overstates:** the things that are genuinely absent — a kill switch, retries, an event bus, cost aggregation, data-layer isolation — are the ones that make the difference between a system that is impressive and a system that can be left alone. Those are the P0s, and none of them is hard. A kill switch is a table, a check, and a route.

**The decisive constraint is not engineering effort. It is that nothing today can stop the system except a deploy.** Everything else in P0 is a consequence of that.
