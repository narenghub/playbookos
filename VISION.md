# PlaybookOS — Architecture Specification

## Overview

PlaybookOS is the operations and intelligence layer for Abiozen LLC, a US-based pharmaceutical API distribution company. It coordinates a six-layer stack that takes a single annual revenue input at the top, cascades targets through the organization, runs autonomous agents against operational data, monitors marketplace and customer-acquisition channels, aggregates every metric into a single analytics surface, and produces a daily briefing at the CEO level.

This document specifies what each layer does, what data it consumes, what AI-driven actions it performs, what it emits to the layer above it, and what external integrations it requires. It is not a marketing document; it is the source of truth for what the system is designed to do. The current build status of each component is tracked in Appendix A.

Conventions used below:

- Database tables and columns are referenced in `monospace`.
- API endpoints are written as `METHOD /path`.
- File references use repository-relative paths.
- "Claude" refers to the Anthropic Claude API; the wrapper is `runClaudeAnalysis` in `src/lib/core.js`.

---

## Layer 1 — Goal Engine

### Purpose

Translate a single annual revenue target, set once by leadership, into a tree of quarterly, monthly, weekly, and daily sub-targets per role and per team member. Below the annual level, no human enters numbers manually.

### Data inputs

- The annual revenue target row in `targets` (`period_type='annual'`).
- Team roster from `users` (id, role, is_active).
- Historical seasonality from prior-year `orders`, when available.
- Per-role activity-to-revenue conversion ratios derived from joins of `activity_logs` against `orders` over completed periods.
- Per-role daily baselines registered in `src/lib/core.js` `ROLE_BASELINES` (used as priors when historical data is thin).

### AI actions

- Claude analyzes seasonality to weight the monthly distribution across the year.
- Claude generates conservative, expected, and stretch sub-targets at every period level.
- Re-cascades when the annual target is updated, when actual revenue diverges from plan by more than 15%, or when a team member is added or deactivated.
- Flags any individual whose assigned cascade is mathematically unreachable given their role's conversion ratios.

### Outputs

- New or updated rows in `targets` covering every `period_type` (annual / quarterly / monthly / weekly / daily) and every relevant `metric` (revenue, prs_merged, skus_priced, outreach_emails, etc.).
- A JSON cascade tree available to the rest of the system via the Goal Engine output.
- An audit row in `ai_analyses` (`analysis_type='goal_cascade'`) capturing the assumption set used for each recalculation.

### Integrations needed

- None external. Uses Postgres and Claude only.

---

## Layer 2 — Execution Agents

Layer 2 is five independent autonomous agents. Each runs on its own schedule, consumes operational data, calls Claude for synthesis, and acts (writes data, sends email, fires alerts). Agents are independent of each other; the only shared dependency is the `targets` rows emitted by Layer 1 and the underlying operational tables.

### 2A. Revenue Agent

**Purpose.** Monitor revenue health weekly and emit a CEO-facing report with five concrete recommendations.

**Data inputs.** `orders` (30-day window), `targets` (monthly revenue), `skus` (catalog), order `notes` parsed for `product: NAME` references.

**AI actions.** Aggregates orders by `product_category`, `buyer_type`, and week. Computes velocity as last-7-day revenue against prior-7-day revenue and classifies it as accelerating, decelerating, or flat. Extracts top-3 molecules best-effort from order notes. Passes the structured aggregation to Claude with a prompt demanding exactly five numbered recommendations across five distinct angles (segment focus, procurement scale-up, biggest risk, acceleration move, weekly experiment).

**Outputs.** A row in `ai_analyses` (`analysis_type='revenue_intelligence'`) containing the full structured JSON. An HTML email to the admin user. The `GET /api/revenue/intelligence` endpoint serves the most recent report.

**Integrations needed.** Claude (analysis), Resend (email). No external integrations beyond these.

### 2B. Procurement Agent

**Purpose.** Convert the Revenue Agent's signal into a prioritized weekly sourcing list for the procurement team.

**Data inputs.** Most recent `ai_analyses` row of `analysis_type='revenue_intelligence'`, the `skus` table filtered to active items with `units_in_stock < 10`.

**AI actions.** Reads top-5 categories and top-5 molecules from the revenue report. Filters low-stock SKUs by category match OR fuzzy name match against the molecule list. Ranks survivors by `sale_price * (10 - units_in_stock)` so high-margin near-empty items rank first. If no candidates match the revenue signal, falls back to all low-stock active SKUs and flags `used_fallback=true`.

**Outputs.** A ranked list of up to 10 SKUs. An HTML email to every user with `role='procurement'` titled "This week — source these N molecules first (revenue-impact ranked)". Each restocked SKU is expected to be reconciled in the SKU Economics page with new COA and SDS links.

**Integrations needed.** Resend (email). Future: supplier-quote APIs to auto-collect price quotes.

### 2C. Growth Agent

**Purpose.** Monitor marketplace search behavior and SEO performance to identify demand signals the catalog isn't capturing.

**Data inputs.** Algolia search analytics (terms searched, click-through and no-result rates), Google Search Console (impressions, clicks, average position per query), LinkedIn outreach response telemetry, internal marketplace traffic from the Abiozen storefront.

**AI actions.** Identifies queries with high impression count but zero clicks (visibility but not relevance), queries with high searches but no-result responses (missing catalog), and the delta between what buyers search and what the catalog promotes. Surfaces the gap as a prioritized "products buyers want but can't find" list. Claude synthesizes weekly into a recommendation set: which SKUs to add, which pages to improve, which keywords to target.

**Outputs.** A row in `ai_analyses` (`analysis_type='growth_intelligence'`). A weekly email to the admin user. A `GET /api/growth/intelligence` endpoint (admin) serving the latest report.

**Integrations needed.** Algolia Analytics API, Google Search Console API, LinkedIn API (or a LinkedIn data partner), and the Abiozen marketplace event stream.

### 2D. Performance Agent

**Purpose.** Score every active team member every evening 0-100, deliver a personalized coaching note, and escalate sustained underperformance to the CEO.

**Data inputs.** `activity_logs` and `github_stats` for the target date, `users.role` (drives the baseline), prior two rows in `performance_scores` for the same user (to detect three consecutive sub-60 days).

**AI actions.** `computeScoreForRole` in `src/lib/core.js` derives a 0-100 score: effort is sum of activity values for non-devs, or `activity_sum + commits + 5 * prs_merged` for devs. Score is `round((effort / baseline) * 70)` capped at 100; reaching baseline maps to 70. Blockers are derived inline (zero activity, zero commits for devs, no PR activity, sub-50% effort). Claude haiku is prompted for a 3-sentence coaching note shaped by the score band: reinforce for ≥70, suggest one action for 40–69, ask what support they need below 40.

**Outputs.** One row per user per day in `performance_scores` with `score_0_to_100`, `metrics_json`, `blockers_json`, `claude_coaching_note`, and `escalated_to_admin`. A coaching email to the user. An escalation email to the admin if `score_0_to_100 < 60` AND the two preceding stored rows are also under 60. `GET /api/performance/scores` (admin, 30-day team) and `GET /api/performance/my` (self, 30-day) expose the data.

**Integrations needed.** Claude (note generation), Resend (email). No external integrations.

### 2E. Customer Agent

**Purpose.** Watch sales pipeline activity, identify the warmest leads in real time, and tell the sales team who to call and what to say.

**Data inputs.** Apollo sequence stats (opens, replies, clicks, bounces), Apollo contact records, internal sales-rep activity from `activity_logs` (calls_made, demos_completed, outreach_emails), prior conversion data (which sequences and segments produced orders).

**AI actions.** Computes a per-contact warmth score from recent engagement signals (open rate, reply sentiment, click recency). Ranks the top N warm contacts per sales rep. Claude generates a personalized opener and a one-line "why this lead now" context note for each contact, drawing on the contact's industry, role, recent activity, and the buyer-segment characteristics observed in past conversions.

**Outputs.** A daily morning email to each sales-role user with their ranked call list. A `GET /api/customer/warm-leads` endpoint serving the same data. The `apollo_sequences` table is updated with per-sequence performance.

**Integrations needed.** Apollo.io (existing API key, `APOLLO_API_KEY`). Resend (email). Possibly a phone integration to log calls back into `activity_logs` automatically.

### 2F. Market Intelligence Agent

**Purpose.** Produce a large, fresh, non-repeating weekly pipeline of molecules for procurement to source — broad coverage of both research-grade chemicals and finished generic APIs, rather than a hand-tuned top-20.

**Data inputs.** Demand signals from Google Search Console (`fetchGSCData`), Algolia internal search (`syncAlgoliaSearchData`), and prior analyses; the `molecule_history` table (full table for dedup, rolling last-12-weeks names as the exclusion list); the active `skus` catalog for cross-checking.

**AI actions.** `runMarketIntelligence()` asks Claude (`claude-opus-4-7`) in batches for **100 research chemicals (non-GMP)** across 10 categories + **50 GMP generic APIs** proportioned across 9 therapeutic areas. New molecules are deduped against `molecule_history` by name+CAS (best-effort) and cross-checked against the catalog (`in_catalog`). CAS numbers are AI-generated and flagged for manual verification before sourcing.

**Outputs.** All 150 molecules stored in `molecule_history` (with `week_start`, `gmp_status`, `sourcing_status` pipeline, `details_json`). Top-20 research + top-10 GMP queued as `approval_queue` sourcing tasks for Palash. A weekly summary emailed to the CEO and snapshotted in `ai_analyses`. UI: the Market Intelligence page (Research / GMP / History tabs, filters, CSV export, inline sourcing-status editing). Runs Mondays at 09:00 CST (15:00 UTC) in its own cron slot, so results land when the team is awake to review them.

**Integrations needed.** Anthropic (`ANTHROPIC_API_KEY`), Google Search Console OAuth, Algolia, Resend (email). No new external services.

---

## Layer 3 — Marketplace Intelligence

### Purpose

Connect the marketplace surface — search, personalization, SEO — to the rest of PlaybookOS so that what buyers do on the storefront becomes a first-class input for procurement and growth decisions.

### Data inputs

- Algolia search analytics events (query string, click position, no-result flag, session id, timestamp).
- Bloomreach personalization data (segments shown, content interactions, conversion paths).
- Google Search Console query and page data (impressions, clicks, CTR, average position).
- Internal marketplace traffic and conversion telemetry (anonymized session events).

### AI actions

- Continuously identifies demand signals: terms searched but unstocked, terms searched but underpriced, terms with low CTR despite high impressions.
- Feeds the demand list into the Procurement Agent so sourcing priorities are influenced by what buyers are searching for in real time, not only by what has already sold.
- Adjusts product visibility automatically by re-ranking Algolia results and Bloomreach experiences based on stock + margin + demand signal, within human-approved rules.

### Outputs

- A daily demand-signal feed consumed by Layer 2C and Layer 2B.
- Updated Algolia ranking rules.
- Updated Bloomreach segment-to-experience mappings.
- A row in `ai_analyses` per cycle (`analysis_type='marketplace_intel'`) capturing the changes applied.

### Integrations needed

- Algolia (search analytics + indexing APIs).
- Bloomreach (personalization API, segment management API).
- Google Search Console (query data API).
- The Abiozen marketplace event stream (read-only).

---

## Layer 4 — Global Customer Acquisition

### Purpose

Run the inbound funnel above and below the marketplace: targeted LinkedIn outreach by region and buyer type, Apollo email sequences by segment, and AI-personalized cold outreach that adapts based on reply patterns. Track each contact from first email to first order.

### Data inputs

- Apollo contact lists filtered by segment (compounding pharmacy, research lab/biotech, generic manufacturer, university/research institute).
- LinkedIn member data sourced by region and title filters.
- Outbound message history per contact (channel, subject line, send time, opens, replies, clicks).
- First-order attribution per contact (joined back from `orders` via buyer email or buyer-side webhook payload).

### AI actions

- Generates per-contact opener variants conditioned on the contact's role, employer, industry, and what segment-specific messaging has historically produced replies.
- Adapts subject lines and body copy mid-sequence when reply rate falls below the historical baseline for the same segment.
- Promotes engaged contacts into Layer 2E (Customer Agent) for the sales team to call.
- Closes attribution: when an `orders` row arrives whose `buyer_email` matches a contact in an outreach campaign, the conversion is recorded against that campaign and that segment.

### Outputs

- Apollo sequences created and updated programmatically per segment template (sequences S1–S4 already encoded in `public/index.html` as static templates).
- A `customer_acquisition_funnel` table (to be created) tracking each contact through stages: targeted, first-touch, engaged, demo, first-order, repeat.
- A weekly digest to the admin and sales-role users covering segment-level conversion rates and which messages won.

### Integrations needed

- Apollo.io (existing).
- LinkedIn outreach platform (e.g. Expandi, Heyreach, or LinkedIn Sales Navigator API). No existing integration.
- The Abiozen marketplace order webhook (existing — `POST /api/orders/webhook`) for attribution back to contacts.

### 4A. AI Email Engine (built)

`src/lib/agents/email-engine.js`, Monday 15:30 UTC, page **Email Engine**. Implements the "Apollo sequences created and updated programmatically per segment template" output above, replacing the static S1–S4 templates in `public/index.html` with generated, demand-driven content.

Each Monday it resolves that week's demand signals (GSC queries + the Layer 2F molecule feed) to real molecules, validates each against the catalog, and generates two email variants per molecule per buyer segment via Claude — A direct/product-focused, B insight/market-focused. Campaigns land in `email_campaigns` as drafts for admin approval; approved campaigns carry a prebuilt 3-step Apollo sequence payload (day 0 / day 3 / day 7).

Two deliberate limits, both load-bearing:

- **Availability claims are catalog-derived, never model-derived.** COA/SDS/purity/price/GMP flags come from `skus` and are injected into the prompt as the only assertable facts. This is what stops the engine promising documentation Abiozen does not hold — a compliance exposure, not a copy-quality issue.
- **Nothing sends itself.** Generation produces drafts only; a human approves, and only then can the campaign be pushed to Apollo. Apollo's sequence-creation endpoint additionally requires a master API key and is not on every plan, so publish can fail — in which case the payload is surfaced for manual creation and the campaign is *not* marked sent.

Not yet built from the Layer 4 spec above: reply-rate-driven mid-sequence adaptation, the `customer_acquisition_funnel` table, and order attribution back to a campaign. The engine currently generates and publishes; it does not yet learn from what won.

---

## Layer 5 — Operational Analytics

### Purpose

Single, consistent surface where every metric the company tracks lives in one schema, queryable through one API, displayed in one UI. No metric-by-metric dashboard sprawl.

### Data inputs

- Revenue from `orders`.
- Targets from `targets` (cascaded by Layer 1).
- SKU performance from `skus` plus order-level notes.
- Team scores from `performance_scores`.
- SEO rankings from Layer 3 (GSC) and search behavior from Layer 3 (Algolia).
- Marketplace growth (traffic, conversion) from Layer 3.
- Supplier pipeline from `skus` + `procurement` activity in `activity_logs`.
- Customer acquisition cost computed as outreach spend per closed first order, joined from Layer 4 funnel data.
- Lifetime value per buyer segment computed as cumulative `orders.amount` grouped by `buyer_type` over a 12-month window.

### AI actions

- Detects anomalies: any metric that deviates more than 2 standard deviations from its 30-day rolling mean.
- Detects covariance: when two metrics move together unexpectedly (e.g., search impressions up but conversion down), Claude is asked to explain the most likely cause and which layer owns the response.
- Generates the weekly executive view that becomes the input to Layer 6.

### Outputs

- A unified `metrics_snapshot` table (to be created) capturing daily values for every tracked metric.
- A `GET /api/analytics/overview` endpoint (admin) returning the current snapshot plus 30-day series for each metric.
- An anomaly feed exposed to the Command Center.

### Integrations needed

- Reuses every integration introduced in Layers 1–4. Layer 5 itself adds no new external services; it consolidates.

---

## Layer 6 — Command Center

### Purpose

Produce one email per day, delivered to Naresh at 7am, structured as: three things going well, three things at risk, three actions to take today. Replaces the need to log into PlaybookOS each morning to check dashboards.

### Data inputs

- The full output of Layer 5 (metrics snapshot, anomaly feed, weekly executive view).
- The most recent `ai_analyses` rows of all types: `revenue_intelligence`, `growth_intelligence`, `marketplace_intel`, `goal_cascade`.
- The most recent `performance_scores` rollups (team-level averages, count of escalations open).
- Pending milestones in `milestones` whose `target_date` is within 14 days and `status='pending'`.

### AI actions

- Claude ranks all positive signals by magnitude and recency, selects the top three.
- Claude ranks all risk signals (anomalies, decelerating velocity, missed targets, sub-60 team scores, milestone slippage) by impact-to-target, selects the top three.
- Claude proposes three specific actions for the day, each tied to a concrete owner and a verifiable success criterion.
- Each item carries a one-sentence "why this matters" line.

### Outputs

- An HTML email to the admin user at 7am every morning (cron `0 7 * * *`).
- The same content stored in `ai_analyses` (`analysis_type='daily_briefing'`).
- A `GET /api/briefing/today` endpoint (admin) that serves the same content for in-app viewing if desired.

### Integrations needed

- None new. Uses Claude, Resend, and the Layer 5 data plane.

---

## Appendix A — Implementation status

Status of each component as of the date of this commit. Refresh as features ship.

| Layer | Component | Status | Reference |
|---|---|---|---|
| 1 | `targets` table + manual CRUD | Built | `src/api/routes.js` (`/targets`), `src/lib/db.js` initDB |
| 1 | Annual + monthly revenue seeds for FY26 | Built | `src/lib/db.js` initDB seed block |
| 1 | `goal_cascades` and `weekly_kpis` tables | Built | `src/lib/db.js` migrateSchemas |
| 1 | Claude-driven cascade to quarterly / weekly / daily | Built | `src/lib/agents/goal-engine.js` `cascadeGoals`, Monday 8am cron, `POST /api/goals/cascade` |
| 1 | Per-user role-conditioned target derivation | Built | `assignWeeklyKPIs` + `assignWeeklyKPIsForAll`, `GET /api/goals/my-week`, `GET /api/goals/team-week` |
| 1 | 15%-divergence-triggered recalc | Built | `checkAndRecalc` in goal-engine.js; 6pm cron; logs `analysis_type='goal_recalc'`; 7-day floor + 24h cooldown |
| 1 | "Run AI Goal Cascade" button on Dashboard | Built | admin-only card in `public/index.html` dashboard page; calls `POST /api/goals/cascade` with progress + result feedback |
| 1 | Expanded role taxonomy + runtime custom roles | Built | `src/lib/roles.js` BUILT_IN_ROLES (10 roles), `custom_roles` table, `GET /api/roles`, `POST /api/roles` (admin), validation on `/users/invite`; SPA my-activity + invite dropdowns fetch live |
| 2A | Revenue Agent — `analyzeRevenueTrends` | Built | `src/lib/agents/revenue-agent.js`, `GET /api/revenue/intelligence` |
| 2A | Monday 9am cron | Built | `server.js` |
| 2B | Procurement Agent — `getProcurementPriorities` | Built | `src/lib/agents/revenue-agent.js` |
| 2B | Supplier-quote auto-collection | Spec | not yet implemented |
| 2C | Growth Agent module | Built | `src/lib/agents/growth-agent.js`, `GET /api/growth/intelligence`, Monday 8am cron |
| 2C | Algolia signal integration | Built | `syncAlgoliaSearchData` in growth-agent |
| 2C | GSC signal integration | Partial | `fetchGSCData` is a bearer-token stub; production needs OAuth refresh / service account |
| 2C | LinkedIn / marketplace event-stream signal | Spec | not yet implemented |
| 2C | SEO Agent module (sibling to Growth Agent) | Built | `src/lib/agents/seo-agent.js`, `seo_rankings` table, `GET /api/seo/{rankings,gaps,no-results}`, Monday 8am cron, SEO Intelligence SPA page |
| 2D | Performance Agent — daily 6pm scoring + coaching | Built | `src/lib/core.js` `scoreTeamMember`, `src/lib/jobs.js` `scoreAllAndCoach`, `GET /api/performance/*` |
| 2D | 3-day below-60 escalation to admin | Built | `scoreTeamMember` |
| 2E | Customer Agent — warmth scoring + outreach recommendations | Built | `src/lib/agents/customer-agent.js`, `buyer_engagement` table, `GET /api/customers/warm-leads`, `GET /api/customers/outreach-today` |
| 2E | `buyer_engagement` event ingestion (shared-secret webhook) | Built | `POST /api/customers/engagement-event`, `ENGAGEMENT_SECRET` env var; molecule_interest column added |
| 3 | Algolia search analytics integration | Built | `syncAlgoliaSearchData` in `src/lib/agents/growth-agent.js` |
| 3 | Bloomreach personalization integration | Spec | not yet implemented |
| 3 | Google Search Console integration | Built | `fetchGSCData` — OAuth 2.0 refresh-token flow (`getGSCAccessToken`); needs `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` |
| 3 | Demand-signal feed into Procurement Agent | Spec | not yet wired (Growth Agent stores recommendations but Procurement Agent doesn't read them yet) |
| 4 | Apollo segment sequences (templates) | Built | `GET /api/sequences/templates`, S1–S4 in `public/index.html` |
| 4 | Apollo find-buyers + send-outreach | Built | `POST /api/apollo/find-buyers`, `POST /api/apollo/send-outreach` |
| 4 | LinkedIn outreach tracking — manual log + pipeline view | Built | `linkedin_outreach` table, `POST /api/linkedin/log`, `GET /api/linkedin/pipeline`; Monday revenue report includes 7-day pipeline summary |
| 4 | LinkedIn outreach automation (sending) | Spec | manual logging only; no LinkedIn API integration yet |
| 4 | Reply-pattern-driven message adaptation | Spec | not yet implemented |
| 4 | `customer_acquisition_funnel` table + first-order attribution | Spec | order webhook exists but no funnel-stage tracking |
| 5 | Unified `metrics_snapshots` table + daily aggregator | Built | `src/lib/agents/metrics-snapshot.js` `takeMetricsSnapshot`, midnight cron, `metrics_snapshots` schema with 13 fields |
| 5 | `GET /api/metrics/today` and `GET /api/metrics/history` | Built | `src/api/routes.js` |
| 5 | Anomaly detection (30% vs 7-day baseline) | Built | `detectAnomalies` in metrics-snapshot.js; wired into 7am briefing prompt + email banner |
| 5 | Causal-covariance Claude explainer | Spec | anomalies are flagged but not yet explained by Claude beyond what the briefing prompt produces |
| 6 | Daily 7am Command Center email | Built | `src/lib/agents/briefing-agent.js` `generateDailyBriefing`, `server.js` 7am cron |
| 6 | "3 going well / 3 at risk / 3 actions" structure | Built | Claude prompt in `briefing-agent.js` enforces this exact structure |
| 6 | `GET /api/briefing/latest` | Built | `src/api/routes.js` |
| 6 | Command Center page in admin SPA | Built | `public/index.html` `pages['command-center']`; one-screen view of anomalies, briefing, warm leads, outreach recs, metrics snapshot, weekly KPIs |
| 7 | KPI Engine — hierarchy, scoring, bottlenecks, cross-team dependencies | Built | `src/lib/kpi-engine.js`; `kpi_hierarchy` table seeded with the $10M vision and strategic goals |
| 7 | Agent activity log — every action recorded before execution | Built | `agent_activity_log` table, `logAgentActivity` in `src/lib/agent-core.js`, `GET /api/agent/activity` |
| 7 | Human approval queue for high-impact actions | Built | `approval_queue` table, `enqueueApproval` / `isHighImpact` in `agent-core.js`, `GET` + `PUT /api/agent/approvals` |
| 7 | CEO Agent — daily executive briefing + 5 revenue-ranked actions | Built | `src/lib/agents/ceo-agent.js`, 7am CST cron |
| 7 | Procurement Agent — daily sourcing tasks routed to approval queue | Built | `src/lib/agents/procurement-agent.js`, 10:30pm CST cron |
| 7 | Sales Agent — call list + follow-up task assignment | Built | `src/lib/agents/sales-agent.js`, 8am CST cron |
| 7 | HR Agent — weekly team-health review + recommendations | Built | `src/lib/agents/hr-agent.js`, Monday 8am CST |
| 7 | Orchestrator — timezone-routed morning briefing | Built | `src/lib/agents/orchestrator.js` `runMorningBriefing`, 4 CST crons |
| 7 | `daily_tasks` table + My Tasks page (all roles) | Built | `GET /api/agent/tasks/my`, `PUT /api/agent/tasks/:id`, `GET /api/agent/tasks/team`, `pages['my-tasks']` |
| 7 | Agent Control command center page (admin) | Built | `public/index.html` `pages['agent-control']`; `GET /api/agent/overview`, `/agent/dependencies` |
| 7 | LinkedIn AI Content Engine — 4 generators + scheduler + UGC publish | Built | `src/lib/agents/linkedin-agent.js`; `linkedin_content_queue` table; `POST /api/linkedin/generate-post`, `GET /api/linkedin/content-queue`, `PUT /api/linkedin/content-queue/:id`, `POST /api/linkedin/publish/:id`, `GET /api/linkedin/analytics`; Mon 10am CST cron; LinkedIn Content SPA page |
| 7 | Performance Accountability — 4-component daily scoring + streaks | Built | `runPerformanceCheck` in `src/lib/agents/orchestrator.js`; new columns on `performance_scores` (task_completion / kpi_progress / activity / response / total_score / streaks / is_weekly_summary); fires at the 6pm CST cron alongside the legacy scoring |
| 7 | Escalation workflow — 4 levels (reminder / warning / escalate / critical) | Built | `runEscalationCheck` in `orchestrator.js`; email + WhatsApp; level 2 notifies the user's domain director; levels 3 & 4 escalate to the CEO and enqueue an approval_queue review item |
| 7 | WhatsApp messaging via Twilio | Built | `src/lib/whatsapp.js` `sendWhatsApp(to, message, {user_id, message_type})`; `whatsapp_log` table; skips gracefully when TWILIO env vars are unset |
| 7 | Performance dashboard + My Performance page | Built | `GET /api/performance/{team, my, alerts, history/:userId}`, `POST /api/performance/calculate`; `pages['performance']` (admin + directors) and `pages['my-performance']` (all roles) in `public/index.html` |

## Appendix B — Cross-layer dependencies

- Layer 1 (Goal Engine) writes `targets` rows that are read by every other layer for "% of target" calculations.
- Layer 2A (Revenue Agent) writes `ai_analyses` rows that Layer 2B (Procurement Agent) reads to decide what to source.
- Layer 3 (Marketplace Intelligence) writes a demand-signal feed that Layer 2B reads to weight sourcing decisions toward what is being searched right now, not only what has already sold.
- Layer 2E (Customer Agent) reads Apollo telemetry written by Layer 4 (Customer Acquisition) campaigns.
- Layer 5 (Operational Analytics) reads every Layer 1–4 output and produces the snapshot and anomaly feed that Layer 6 consumes.
- Layer 6 (Command Center) is downstream of everything and writes nothing back (other than a `daily_briefing` row in `ai_analyses` for audit).

## Appendix C — Schedule summary

| Cron | Trigger | Owner |
|---|---|---|
| `0 7 * * *` | Daily 7am Command Center briefing | Layer 6 (built) |
| `0 8 * * *` | GitHub developer sync | Layer 5 input (built) |
| `0 9 * * 1` | Monday weekly AI analysis | Layer 5 (built) |
| `0 9 * * 1` | Monday Revenue Agent → Procurement Agent chain | Layer 2A → 2B (built) |
| `0 8 * * 1` | Monday Growth Agent weekly synthesis (Algolia + GSC → Claude) | Layer 2C (built) |
| `0 18 * * *` | Daily 6pm milestone trigger check | Layer 5 input (built) |
| `0 18 * * *` | Daily 6pm Performance Agent scoring + coaching | Layer 2D (built) |
| `30 22 * * *` CST | Procurement team IST briefing | Layer 7 (built) |
| `30 1 * * *` CST | Dev + SEO team IST briefing | Layer 7 (built) |
| `0 7 * * *` CST | CEO briefing | Layer 7 (built) |
| `0 8 * * *` CST | US team briefing + agent task assignment | Layer 7 (built) |
| `0 10 * * 1` CST | Monday LinkedIn content scheduler — drafts Mon/Wed/Fri posts | Layer 7 (built) |
| continuous | Layer 3 marketplace-intelligence ingestion | Layer 3 (spec) |
| `0 15 * * 1` | Monday Market Intelligence molecule feed | Layer 2F (built) |
| `30 15 * * 1` | Monday AI Email Engine — 20 campaigns / 40 variants across 4 segments | Layer 4A (built) |
| continuous | Layer 4 outbound sequence orchestration | Layer 4 (partial) |
