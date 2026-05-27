# PlaybookOS

Internal operations and performance dashboard for Abiozen LLC. Tracks team activity, revenue against monthly and annual targets, GitHub developer velocity, Apollo outreach, SKU economics, and runs scheduled Claude-generated assessments toward a $10M FY26 revenue target.

## Stack

- Node.js 18+ · Express 4
- PostgreSQL (`pg`)
- Vanilla JS single-page app (`public/index.html`)
- Resend (transactional email)
- node-cron (scheduled jobs)
- Anthropic Claude (analysis), Apollo.io (sales outreach), GitHub API (developer metrics)

## Run locally

Requires Node 18+ and a reachable Postgres instance.

```bash
git clone https://github.com/narenghub/playbookos.git
cd playbookos
npm install
cp .env.example .env
# Edit .env with real values (see Environment variables below)
node server.js
```

The server initializes its schema on first boot (`initDB → initPhase2 → migrateSchemas`) and seeds an admin user from `ADMIN_EMAIL` / `ADMIN_PASSWORD` plus milestones, monthly targets, decision rules, execution steps, and integrations.

**`ADMIN_EMAIL` and `ADMIN_PASSWORD` are required on the very first deploy** — there is no hardcoded fallback. If no admin user exists in the database and either env var is unset, the server logs `FATAL: No admin user exists...` and exits. Subsequent boots skip the seed once an admin row exists, so these vars can be left unset (or rotated) after the first deploy.

Open http://localhost:3000 and log in with the admin credentials from `.env`.

Sanity check:

```bash
curl http://localhost:3000/health
# {"status":"ok","uptime":...,"timestamp":"...","db":"connected"}
```

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string. On Railway, set as a reference to `${{Postgres.DATABASE_URL}}` so it autoinjects. |
| `JWT_SECRET` | yes | Signs auth tokens. Server refuses to start without it. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `TRIGGERS_SECRET` | yes (for milestone cron) | Bearer token gating `POST /api/triggers/check`. The 6pm cron skips with a warning if unset. Same generation method as `JWT_SECRET`. |
| `PLAYBOOKOS_WEBHOOK_SECRET` | yes (for marketplace integration) | Shared secret validated against the `X-PlaybookOS-Secret` header on `POST /api/orders/webhook`. The endpoint returns 503 if unset. Same generation method as `JWT_SECRET`. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | **yes (first deploy)** | Bootstrap the first admin user. No hardcoded fallback — server exits with FATAL if no admin row exists in the DB and either is unset. Ignored on subsequent boots once an admin row exists. |
| `ANTHROPIC_API_KEY` | yes | Claude API key for AI analysis and market intelligence. |
| `RESEND_API_KEY` | yes | Resend API key for outbound email (invites, weekly reports, milestone triggers, Apollo outreach). |
| `APOLLO_API_KEY` | yes (for Apollo features) | Apollo.io API key. Required for every `/api/apollo/*` endpoint. |
| `GITHUB_TOKEN` | yes (for GitHub sync) | Personal access token with `repo`, `read:org`, `read:user` scopes. Used by the 8am sync cron and the manual "Sync GitHub now" button. |
| `GITHUB_ORG` | no | Default org for GitHub queries. |
| `ALGOLIA_APP_ID` / `ALGOLIA_API_KEY` / `ALGOLIA_INDEX_NAME` | yes (for Growth Agent) | Algolia Analytics API credentials. The Growth Agent queries no-result searches, top queries, CTR, and conversion rate against the named index. |
| `GOOGLE_SEARCH_CONSOLE_KEY` | no (Growth Agent enhances if set) | Bearer token for GSC `searchAnalytics/query`. Note: GSC requires OAuth — this is a short-lived token (default 1h). Leave empty to run growth-agent with Algolia signal alone. |
| `GSC_SITE_URL` | no | Override the GSC site URL. Default `sc-domain:abiozen.com`. |
| `PORT` | no | HTTP listen port. Defaults to 3000. |
| `BASE_URL` | no | Public URL of the deployed app — referenced in email links (invite acceptance, weekly report footer). |

## API endpoints

All routes are mounted under `/api` and require `Authorization: Bearer <token>` unless noted.

**Auth** — `POST /auth/login` (rate-limited 10/min/IP), `POST /auth/accept-invite` (rate-limited 10/min/IP), `GET /auth/me`

**Users / team** — `GET /users`, `POST /users/invite` (admin; validates role against catalog), `PUT /users/profile`, `PUT /users/:id`

**Roles** — `GET /roles` (authenticated; returns built-in + custom roles with metrics + baselines), `POST /roles` (admin; create a custom role with snake_case `role_name`, `display_name`, and a `metrics` array)

**Activity** — `POST /activity`, `GET /activity/my`, `GET /activity/team` (admin)

**Revenue / orders** — `POST /orders` (admin), `GET /orders`, `POST /orders/webhook` (header-auth, see below)

**Dashboard** — `GET /dashboard/summary`, `GET /dashboard/my`, `GET /dashboard/export` (CSV download of current month orders + summary stats; intended for board reports)

**GitHub** — `POST /github/sync`

**Milestones** — `GET /milestones`, `PUT /milestones/:id` (admin), `DELETE /milestones/duplicates` (admin)

**AI / triggers** — `POST /ai/analyze` (admin), `GET /ai/latest`, `POST /triggers/check` (requires `TRIGGERS_SECRET` in `Authorization: Bearer …` header)

**Targets** — `GET /targets`, `POST /targets` (admin)

**Goals (Goal Engine — Layer 1)** — `POST /goals/cascade` (admin; runs the full cascade from annual targets, then chains `assignWeeklyKPIsForAll()` so every active user gets this week's KPIs), `POST /goals/assign-kpis` (admin; runs only the weekly KPI assignment against the existing cascade — no Claude call), `GET /goals/my-week` (current week KPIs for the logged-in user; auto-instantiates from cascade if missing), `GET /goals/team-week` (admin, current week KPIs for everyone)

**Customer Agent (Layer 2E)** — `GET /customers/warm-leads` (admin, top 10 by warmth score), `GET /customers/outreach-today` (admin, today's Claude-generated call list with talking points per lead; serves cached row if generated today, otherwise generates fresh), `POST /customers/engagement-event` (shared-secret gated; ingests opens/clicks/replies/bounces from Apollo or any source)

**LinkedIn outreach (Layer 4)** — `POST /linkedin/log` (admin, manually log an outreach attempt), `GET /linkedin/pipeline` (admin, aggregate stats by stage, by segment, plus 20 most recent rows)

**Operational metrics (Layer 5)** — `GET /metrics/today` (admin, latest snapshot row), `GET /metrics/history?days=90` (admin, time series for trend charts)

**Decision engine** — `GET /decision-rules`, `POST /decision-rules/evaluate` (admin)

**SKUs** — `GET /skus`, `POST /skus` (admin), `POST /skus/bulk-upload` (admin), `GET /skus/export`

**Algolia sync** — `POST /algolia/sync` (admin; pushes active PlaybookOS SKUs to the unified `abiozen_products` index), `POST /algolia/sync-abiozen` (admin; pushes active Abiozen marketplace products — requires `ABIOZEN_DATABASE_URL`). Shared logic in `src/lib/algolia-sync.js`; CLI equivalent at `scripts/sync-algolia.js`.

**Execution / integrations** — `GET /execution-steps`, `PUT /execution-steps/:id` (admin), `GET /integrations`

**Performance scoring** — `GET /performance/scores` (admin, last 30 days for everyone), `GET /performance/my` (logged-in user, last 30 days)

**Revenue intelligence** — `GET /revenue/intelligence` (admin) returns the most recent Monday-morning revenue report: category/buyer-segment breakdowns, weekly trend, velocity delta, monthly target progress, top molecules parsed from order notes, and Claude's 5 actionable recommendations

**Command Center daily briefing** — `GET /briefing/latest` (admin) returns the most recent 7am briefing: 24-hour snapshot, recent orders, flagged team members, upcoming milestones, and the structured "What's going well / At risk / Actions for today" briefing from Claude

**Growth intelligence** — `GET /growth/intelligence` (admin) returns the most recent Monday-morning Growth Agent output: aggregated demand signals from Algolia internal search + GSC, and Claude's top-10 list of molecules buyers want but the catalog doesn't carry

**SEO intelligence** — `GET /seo/rankings` (admin/seo_specialist) — 30-day keyword time series with computed trend (improving / declining / flat / new); `GET /seo/gaps` — current content-gap opportunities (high impressions, low rank, low CTR); `GET /seo/no-results` — Algolia zero-result searches that don't match any active SKU

**Market intelligence** — `POST /market/analyze` (admin), `GET /market/latest`

**Apollo.io** — `POST /apollo/find-buyers`, `POST /apollo/send-outreach`, `GET /apollo/sequences`, `GET /apollo/stats`, `GET /apollo/debug`, `GET /sequences/templates` (all admin)

**Health** — `GET /health` (unauthenticated). Returns `{status, uptime, timestamp, db}`; 503 if the DB probe fails.

## Marketplace integration — POST /api/orders/webhook

The Abiozen storefront posts each confirmed order to PlaybookOS so revenue dashboards and the weekly Claude report stay in sync without manual re-entry.

- Auth: shared secret in the `X-PlaybookOS-Secret` header, validated against `PLAYBOOKOS_WEBHOOK_SECRET`
- Idempotent: re-posting the same `order_id` is a no-op (`ON CONFLICT DO NOTHING`)
- Audited: every accepted call writes a row to `email_log` with `trigger_type='webhook'`

Body:

```json
{
  "order_id": "abz_ord_7f4e...",
  "amount": 8500.00,
  "buyer_email": "purchasing@example-pharmacy.com",
  "buyer_type": "compounding_pharmacy",
  "product_category": "GLP-1",
  "product_name": "Semaglutide 99% 5g",
  "order_date": "2026-05-19"
}
```

Response: `{ "received": true, "order_id": "abz_ord_7f4e..." }`

Required fields: `order_id`, `amount` (number, non-negative), `order_date` (YYYY-MM-DD). Other fields are stored in `notes` if present.

## Cron jobs

Defined in `server.js`, implementations in `src/lib/jobs.js`.

| Schedule | Job | Function |
|---|---|---|
| `0 0 * * *` (daily 00:00 UTC) | Layer 5 — write daily metrics_snapshots row (yesterday's day-of-record) | `takeMetricsSnapshot()` |
| `0 7 * * *` (daily 7am) | Layer 6 — Command Center daily briefing emailed to admin | `generateDailyBriefing()` |
| `0 8 * * 1` (Monday 8am) | Layer 1 — Goal Engine: cascade annual targets then assign weekly KPIs to every active user | `cascadeGoals()` → `assignWeeklyKPIsForAll()` |
| `0 8 * * 1` (Monday 8am) | Layer 2C — Growth Agent: Algolia search sync then SEO recommendations | `syncAlgoliaSearchData()` → `generateSEORecommendations()` |
| `0 8 * * 1` (Monday 8am) | SEO Agent — keyword ranking persistence, content-gap tasks for seo_specialist, missing-from-catalog rollup | `trackKeywordRankings()` → `generateSEOTasksForTeam()` → `trackAlgoliaNoResults()` |
| `0 8 * * *` (daily 8am) | GitHub sync for all active devs | `syncGitHubAllDevs()` |
| `0 9 * * 1` (Monday 9am) | Claude weekly analysis + emailed report | `runWeeklyAnalysis()` |
| `0 9 * * 1` (Monday 9am) | Revenue Intelligence agent — 30-day analysis, emails Naresh, then chains procurement priorities email to Palash | `analyzeRevenueTrends()` → `getProcurementPriorities()` |
| `0 18 * * *` (daily 6pm) | Milestone trigger check | `checkMilestoneTriggers()` via HTTP to self with `TRIGGERS_SECRET` |
| `0 18 * * *` (daily 6pm) | AI performance scoring + per-user coaching email | `scoreAllAndCoach()` |
| `0 18 * * *` (daily 6pm) | Layer 1 — 15% divergence check, auto-recalc if exceeded | `checkAndRecalc()` |

All accept `{ dryRun: true }` for safe manual testing.

### Command Center daily briefing

`src/lib/agents/briefing-agent.js`. Single function `generateDailyBriefing({dryRun})`, fired by the 7am cron.

Gathers a 24-hour snapshot covering new orders, today/yesterday revenue against the per-day target derived from the current month target, performance scores from yesterday's `performance_scores` rows, Apollo cumulative replies with a delta against the prior briefing's stored cumulative (so day-1 shows total only, day-2+ shows delta), new SKUs added in the last 24 hours, GitHub commits and PRs merged from yesterday, and any milestones whose `target_date` is within 7 days and still `pending`.

Claude is prompted for a strict three-section briefing — "What's going well", "What's at risk", "Actions for today" — three numbered items each, every line referencing an actual number from the snapshot, every action carrying an owner and a measurable success criterion. Output is stored as JSON in `ai_analyses` with `analysis_type='daily_briefing'` and emailed to the admin user (falls back to `naren@abiozen.com` if no admin row exists).

Caveat on the Apollo number: Apollo's API only exposes per-sequence cumulative `unique_replied`, not a time-windowed count. The briefing reports both the cumulative total and the delta since the prior briefing's stored value. First-day briefings show only the total.

### Role taxonomy

Single source of truth lives in `src/lib/roles.js` (built-in) and the `custom_roles` table (admin-added at runtime). Both are merged by `getAllRoles()` and served by `GET /api/roles`.

Built-in roles (and their daily activity baselines used by performance scoring):

| `role_name` | Display | Metrics | Baseline |
|---|---|---|---|
| `admin` | Admin | orders_entered, revenue_closed, team_reviews | 3 |
| `dev` | Developer | prs_merged, commits, features_deployed, bugs_fixed | 8 |
| `procurement_lead` | Procurement Lead | molecules_sourced, suppliers_contacted, coas_collected, rfqs_sent, purchase_orders_placed | 15 |
| `customer_engagement` | Customer Engagement | quotes_sent, accounts_created, leads_followed_up, orders_closed, response_time_hrs | 20 |
| `lead_chemist` | Lead Chemist | orders_repacked, labels_printed, shipments_dispatched, qc_checks_completed | 12 |
| `logistics` | Logistics | pickups_completed, transfers_completed, inbound_receipts_logged | 8 |
| `recruitment` | Recruitment | candidates_screened, interviews_scheduled, offers_made, hires_completed | 5 |
| `hr_accounts` | HR & Accounts | payroll_processed, employee_issues_resolved, invoices_processed | 4 |
| `seo_specialist` | SEO Specialist | keywords_optimized, pages_indexed, backlinks_built, ranking_improvements, content_published | 10 |
| `platform_ops` | Platform Ops | issues_resolved, deployments_completed, uptime_pct, tickets_closed | 6 |

To add a custom role at runtime:

```
curl -X POST $URL/api/roles \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role_name":"finance_analyst","display_name":"Finance Analyst","metrics":["models_built","reports_published","forecasts_updated"]}'
```

Once created, the role appears in the my-activity dropdown for users assigned to it, in the team invite dropdown, and gets a row in every Monday's goal cascade with role-appropriate weekly KPIs from Claude. Custom roles inherit a default baseline of 5; tune by editing `getAllRoles` in `src/lib/roles.js`.

**Legacy role values:** the prior taxonomy (`procurement`, `sales`, `marketing`, `qc`) is no longer in the built-in catalog. Existing users with those values still work but won't appear in nav lists that gate on role, won't get weekly KPI cascades for their (now unknown) role, and will score against the admin baseline. Migrate them via the admin Team page or directly with `PUT /api/users/:id` setting the new `role`.

### Operational metrics snapshot (Layer 5)

`src/lib/agents/metrics-snapshot.js`. Two exports.

`takeMetricsSnapshot({dryRun, dateOverride})` runs at midnight UTC and writes one row to `metrics_snapshots` representing the day that just ended. Aggregates pulled in one function:
- `revenue_actual` and `revenue_target` (pro-rata from monthly target) for that day, plus `revenue_pct`.
- `team_avg_score` from `performance_scores` for the same date.
- `top_sku` parsed best-effort from order notes over the trailing 7 days. Caveat: orders have no FK to `skus`, so this is a string match against `product:` lines written by the marketplace webhook.
- `top_buyer_segment` by revenue over trailing 7 days.
- `apollo_emails_sent` for the day; `apollo_reply_rate` over trailing 7 days.
- `linkedin_pipeline_count` (total roster in `linkedin_outreach`).
- `warm_leads_count` — distinct contacts with a clicked or replied event in trailing 7 days.
- `skus_added_this_week`, `github_commits_this_week`.

`detectAnomalies({thresholdPct})` reads the last 8 snapshots, treats the most recent as "today" and the prior 7 as baseline, and flags every numeric metric whose absolute delta vs the baseline mean exceeds `thresholdPct` (default 30). Returns an array sorted by delta magnitude. If fewer than 4 snapshots exist, returns `{anomalies: [], note: 'insufficient baseline'}` so the briefing doesn't surface noise during the first week of deployment.

The 7am briefing now calls `detectAnomalies()` and renders a red anomaly banner above the briefing prose if any are present. The Claude prompt is also told that anomalies are the most actionable signal, so they get prioritized into the "WHAT'S AT RISK" / "WHAT'S GOING WELL" sections.

### LinkedIn outreach (Layer 4)

New `linkedin_outreach` table; rows are populated manually via `POST /api/linkedin/log` (no integration yet — see VISION.md for the LinkedIn automation gap). `GET /api/linkedin/pipeline` returns aggregate counts (total / connected / replied, plus this-week variants), segment breakdown, and the 20 most recent rows. The Monday 9am Revenue Intelligence report includes a LinkedIn pipeline line in the prompt and a green pipeline card in the email.

### Customer Agent (Layer 2E)

`src/lib/agents/customer-agent.js`. Three exports plus a new `buyer_engagement` event table.

`scoreLeadWarmth(contactEmail)` reads from `buyer_engagement` and computes a 0-100 score: `+20` for any opens, `+30` for any clicks, `+50` for any replies, `+10` bonus for 3+ opens, `+20` bonus for a reply within 24 hours of the latest send. Caps at 100. Returns score plus a list of human-readable signal strings.

`getWarmLeads({limit})` joins `buyer_contacts` with `buyer_engagement`, scores every contact that has at least one event, returns the top N by score (default 10).

`generateOutreachRecommendations({dryRun})` pulls the top 10 warm leads plus the last 30 days of best-selling product categories from `orders`, asks Claude haiku for a JSON array of per-lead recommendations (priority, molecule to lead with, talking points, channel — call/email/linkedin based on warmth band). Stores in `ai_analyses` with `analysis_type='outreach_recommendations'`, `period_key=YYYY-MM-DD` so each day's recommendations are findable.

`GET /api/customers/outreach-today` serves the most recent row for today; if none exists, it generates a fresh one on demand. `GET /api/customers/warm-leads` is the raw scored list without Claude.

The 7am daily briefing now includes top 3 warm leads — as a section in the Claude prompt and as a small table in the email — so Naresh sees the day's call list at the same time as his briefing.

**Data caveat for buyer_engagement**: this table is empty until something populates it. Apollo's REST API only exposes sequence-level aggregate stats, not per-contact opens/clicks/replies. To get per-contact data you need either an Apollo webhook delivering events to PlaybookOS (not yet built; would need a `POST /api/customers/engagement-event` endpoint with a shared secret), or a separate polling job that hits Apollo's per-contact analytics. Until then, `getWarmLeads` returns an empty array, `generateOutreachRecommendations` skips with a reason, and the briefing's warm-leads section shows `(no warm leads — buyer_engagement empty)`.

### Goal Engine (Layer 1)

`src/lib/agents/goal-engine.js`. Cascades the annual targets in the `targets` table into a tree of quarterly, monthly, weekly, and daily rows in `goal_cascades`, then instantiates per-user weekly KPIs in `weekly_kpis`.

`cascadeGoals({dryRun})` runs the whole tree:
- Loads annual targets from `targets` for the current year.
- Loads existing monthly targets (the seeded `2026-05`…`2026-12` rows) and uses them verbatim — they take precedence over anything Claude would generate.
- Calls Claude ONCE with the annual targets, team roster grouped by role, existing monthly seeds, and per-role metric vocabularies (from `public/index.html` my-activity page). Claude returns quarterly target_values plus per-role weekly KPIs in a single JSON object.
- Deletes existing `auto_generated=1` rows with `period_end >= today` so re-running is idempotent for future periods. Manual overrides (`auto_generated=0`) and historical rows are preserved.
- Inserts: annual rows (one per metric), quarterly rows from Claude, monthly rows from the seed (linked to their quarter), weekly per-role rows for the current week + next 12 weeks from Claude (one row per role × metric × week), daily rows for the current week only (Mon-Fri, weekly target / 5).

`assignWeeklyKPIs(userId, weekStart)` reads the weekly cascade rows for the user's role and the given Monday, and upserts a row per KPI into `weekly_kpis` (unique on `(user_id, week_start, kpi_name)`).

`assignWeeklyKPIsForAll({dryRun})` iterates all active users with a role and calls `assignWeeklyKPIs` for each, scoped to the current week.

The Monday 8am cron runs `cascadeGoals()` then `assignWeeklyKPIsForAll()`. `POST /api/goals/cascade` lets an admin trigger the full cascade on demand (e.g., after editing annual targets). `GET /api/goals/my-week` auto-instantiates KPIs from the cascade if the user hits it before that Monday's cron has run.

The math is split deterministically vs. Claude-driven:
- Deterministic: monthly from seed, quarterly sum-of-months when seeds cover the quarter, daily = weekly / 5 business days.
- Claude: quarterly fallback when seeds don't cover, per-role weekly KPI allocation (the part requiring judgment).

`checkAndRecalc({dryRun})` is wired to the daily 6pm cron. It compares this-month MTD revenue against a pro-rata target (`monthly_target * days_elapsed / days_in_month`). If the absolute divergence exceeds 15%, it calls `cascadeGoals()` and logs the event in `ai_analyses` as `analysis_type='goal_recalc'`. Safeguards: skips during the first 7 days of the month (too noisy), and enforces a 24-hour cooldown so a sustained slump doesn't trigger a Claude call every evening.

### SEO Agent

`src/lib/agents/seo-agent.js`. Four exports plus a new `seo_rankings` table. Distinct from but overlapping the Growth Agent: Growth Agent focuses on "catalog expansion" (molecules buyers want that we don't carry); SEO Agent focuses on "page optimization" (molecules we DO carry but rank poorly for on Google). Both consume the same Algolia + GSC low-level fetchers from `growth-agent.js`.

`trackKeywordRankings({dryRun})` pulls the top-50 GSC queries via `fetchGSCData()` and persists one row per query in `seo_rankings` keyed on `(query, recorded_date)`. The Monday cron creates a weekly time series; over time the table accumulates a per-query history that the `/seo/rankings` endpoint reads to compute trend.

`identifyContentGaps()` filters the live GSC data to queries with `impressions >= 100 AND position > 10 AND ctr < 0.02`, ranks them by `impressions / position`, returns top 10. These are queries where Abiozen already shows up in Google but doesn't convert — fixable by improving existing pages rather than building new ones.

`generateSEOTasksForTeam({dryRun})` takes those gaps, matches them against the current `skus` catalog, and asks Claude haiku to convert each catalog-matched gap into a specific writing task (e.g. "Write product description for Semaglutide targeting query 'buy semaglutide API USA'"). Tasks include `page_type` (product_description / category_page / blog_post / landing_page) and priority. Stored in `ai_analyses` (`analysis_type='seo_tasks'`) and emailed to every user with `role='seo_specialist'`.

`trackAlgoliaNoResults()` pulls Algolia's no-result queries and filters out anything that fuzzy-matches a current active SKU. The remainder is what the catalog is missing — closely related to the Growth Agent / Procurement Agent inputs but exposed as its own endpoint for the SEO Intelligence dashboard.

Caveat: `seo_rankings` data quality depends on GSC working. With `GOOGLE_SEARCH_CONSOLE_KEY` unset or expired (it's a bearer token, not an API key), `trackKeywordRankings` skips cleanly and the `/seo/rankings` endpoint returns an empty array. The SEO Intelligence dashboard tells the admin exactly which fixture is missing.

### Growth Intelligence agent

`src/lib/agents/growth-agent.js`. Two functions, chained on the Monday 8am cron.

`syncAlgoliaSearchData({days})` calls the Algolia Analytics API for the named index across the trailing N days (default 7): `searches/noResults` (zero-hit queries), `searches` (top queries), `conversions/conversionRate`, `clicks/clickThroughRate`. Returns a structured object including per-call errors so partial failures don't kill the whole sync.

`generateSEORecommendations({dryRun})` aggregates the Algolia output with GSC data from `fetchGSCData()` (best-effort — GSC needs a fresh OAuth bearer token to actually return rows), filters out queries that already match a SKU in the active catalog, ranks the remainder by composite score (`algolia_no_result_count * 10 + gsc_impressions`), and asks Claude haiku to identify the top 10 real pharmaceutical molecules in that list. Claude is required to return strictly JSON; if parsing fails the raw text is preserved alongside an empty `top_molecules` array. The full structured result is stored in `ai_analyses` with `analysis_type='growth_intelligence'`.

Caveat on GSC: the env var `GOOGLE_SEARCH_CONSOLE_KEY` is a bearer token, not an API key. GSC requires OAuth; the token expires (default 1 hour). For production, replace the simple-bearer path in `fetchGSCData` with a proper refresh flow or service-account-issued token. With the variable unset, the agent runs on Algolia signal alone.

### Revenue Intelligence agent

Lives in `src/lib/agents/revenue-agent.js`. Two functions, chained on the Monday 9am cron:

**`analyzeRevenueTrends({dryRun})`**: pulls the last 30 days of `orders` and aggregates by product_category, buyer_type, and week. Computes velocity (last 7 days vs prior 7 days) and progress against the monthly revenue target from `targets`. Extracts top-3 molecules best-effort from order `notes` (the marketplace webhook writes `product: NAME` into notes). Passes everything to Claude haiku and asks for exactly 5 numbered recommendations covering segment focus, procurement scale-up, biggest risk, acceleration move, and a weekly experiment. Persists the full structured result + recommendation text into `ai_analyses` with `analysis_type='revenue_intelligence'`, and emails Naresh the HTML report.

**`getProcurementPriorities({dryRun})`**: reads the latest revenue_intelligence row, takes the top-5 categories and top-5 molecules, and cross-references against `skus` where `is_active=1 AND units_in_stock < 10`. SKUs are scored by `sale_price * (10 - units_in_stock)` so high-margin near-empty items rank first. Top 10 go to every user with role `procurement` in an email titled "This week — source these N molecules first". If no SKU matches the revenue signal, falls back to all low-stock active SKUs and flags `used_fallback=true` in the response.

Caveat: `orders` has no FK to `skus`, only a free-text `product_category`. The agent works with what's there — category-level signals when SKU categories overlap, plus the notes-parsing fallback for molecule names. If you want true SKU-level revenue attribution, the orders table needs a `sku_id` column and the webhook needs to send it.

### AI performance scoring

Every evening at 6pm, `scoreAllAndCoach` runs `scoreTeamMember(userId, today)` for each active non-admin user. The score (0-100) is derived from their role's daily baseline applied to that day's `activity_logs` totals plus, for devs, `github_stats`. Each user gets a 3-sentence Claude-written coaching email; their score, metrics, blockers, and the coaching note are persisted to `performance_scores`. If a user scores below 60 for three consecutive days, `escalated_to_admin` flips to true on the row and Naresh gets an escalation email with the blockers and the coaching note.

Per-role daily baselines (in `src/lib/core.js` `ROLE_BASELINES`):

| Role | Baseline (reaching it ≈ 70/100) |
|---|---|
| dev | 8 (commits + 5*PRs_merged + activity sum) |
| procurement | 50 (activity sum, e.g. skus_priced) |
| sales | 20 (outreach_emails, calls, demos, etc.) |
| marketing | 5 |
| qc | 10 |
| admin | 3 |

Override targets live in the `targets` table (per-user, per-period, per-metric) but the score function currently uses the role baselines as the primary signal. Use `POST /api/targets` to seed custom targets if you want per-individual goals. Use the test harness:

```bash
DATABASE_URL=... node scripts/test-crons.js          # dry-run, no side effects
DATABASE_URL=... node scripts/test-crons.js --live   # real run (sends email, inserts ai_analyses, etc.)
```

## AI Agent System

A three-layer agent architecture that decomposes the $10M vision into daily tasks,
runs specialized agents, and keeps a human in the loop for high-impact actions.

**Layer 1 — Foundation.** `src/lib/kpi-engine.js` decomposes Vision → Strategic
Goals → Team KPIs → Daily Tasks (`getKPIHierarchy`), scores users 0–100
(`calculateKPIScore`), finds the most-behind KPIs (`getBottlenecks`), and maps the
procurement → sales → marketplace → SEO chain (`getCrossTeamDependencies`).
`src/lib/agent-core.js` provides shared helpers: every agent action is written to
`agent_activity_log` (with reasoning, source KPI, and a 0–100 confidence score)
before it executes, and high-impact actions — procurement spend over $1,000,
outreach to a new segment, hiring/escalation — are routed to `approval_queue`
instead of auto-executing.

**Layer 2 — Specialized agents.**

| Agent | File | Schedule | Output |
|---|---|---|---|
| CEO | `agents/ceo-agent.js` | 7:00am CST | Executive summary + 5 revenue-ranked actions |
| Procurement | `agents/procurement-agent.js` | 10:30pm CST | 5 sourcing tasks → approval queue |
| Sales | `agents/sales-agent.js` | 8:00am CST | Call list + follow-up tasks for sales reps |
| HR | `agents/hr-agent.js` | Monday 8am CST | Weekly team-health report + recommendations |

`agents/orchestrator.js` `runMorningBriefing({ segment })` routes each segment to
its agents at the local time matching that team's morning, using the new
`users.timezone` column. Segments: `ceo`, `procurement_ist`, `dev_seo_ist`,
`us_team`, or `all`.

**Layer 3 — Command Center.** An admin-only **Agent Control** page (CEO mission
control, agent activity feed, approval queue, team health, cross-team
dependencies) and a **My Tasks** page on every role showing today's AI-assigned
tasks with the source KPI behind each.

**Endpoints:** `GET /api/agent/tasks/my`, `PUT /api/agent/tasks/:id`,
`GET /api/agent/tasks/team`, `POST /api/agent/tasks/generate`,
`GET /api/agent/approvals`, `PUT /api/agent/approvals/:id`,
`GET /api/agent/activity`, `GET /api/agent/dependencies`, `GET /api/agent/overview`.

The agents reuse `ANTHROPIC_API_KEY` (reasoning) and `RESEND_API_KEY` (briefing
emails) — no new environment variables are required.

### LinkedIn AI Content Engine

`src/lib/agents/linkedin-agent.js` exports four generators —
`generateProductPost(molecule)`, `generateMarketIntelligencePost(analysisData)`,
`generateCompanyUpdate(metrics)`, and `scheduleLinkedInContent()` — each
returning `{headline, body, hashtags, full_post}` capped at LinkedIn's 1300-char
share-commentary limit and stamped with the spec's hashtag set.

The Monday 10am CST cron runs `scheduleLinkedInContent()`, which drafts three
posts (Mon = product, Wed = market intelligence, Fri = company update) into the
`linkedin_content_queue` table at `status='draft'` and emails the CEO for
review. Approval flow is two-step: `PUT /api/linkedin/content-queue/:id` with
`{action:"approve"}`, then `POST /api/linkedin/publish/:id` to push to the
LinkedIn UGC API.

**Endpoints** — `POST /api/linkedin/generate-post`, `GET /api/linkedin/content-queue`,
`PUT /api/linkedin/content-queue/:id` (approve/reject/edit), `POST /api/linkedin/publish/:id`,
`GET /api/linkedin/analytics`.

**Env vars** — `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`,
`LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_ORGANIZATION_ID`. Without these the
scheduler still drafts posts; publish skips with a 503 until set.

**Frontend** — LinkedIn Content page in the INTELLIGENCE section (admin and
sales_director only). Shows the week's Mon/Wed/Fri slots, engagement totals,
a Generate-post form, and the draft/approved/published queue with action
buttons.

## Deploy to Railway

Production lives in Railway project `meticulous-laughter`, service `playbookos`, linked to a `Postgres` service. `DATABASE_URL` autoinjects via reference variable.

**Initial setup (already done for prod):**
1. Railway → new project → provision PostgreSQL
2. Add a second service → "Deploy from GitHub repo" → `narenghub/playbookos` → branch `main`
3. In playbookos service Variables: paste everything from `.env.example` with real values. Set `DATABASE_URL=${{Postgres.DATABASE_URL}}` so it tracks the Postgres instance.
4. Optional: set Health Check Path to `/health` so Railway gates new deploys on a healthy startup and rolls back on failure.

**Subsequent deploys:** push to `main`. Railway auto-deploys within ~60 seconds.

**If autodeploy stops working:**
- Service Settings → Source → verify the GitHub connection is healthy; reconnect if not
- Or trigger a manual deploy: `railway link --service playbookos`, then `railway up`

## Project layout

```
playbookos/
├── server.js                Express server, /health endpoint, cron schedules
├── public/index.html        single-file SPA (admin + per-role views)
├── src/
│   ├── api/routes.js        every /api/* endpoint + auth rate limiting
│   └── lib/
│       ├── core.js          auth, JWT, GitHub fetch, Claude wrapper
│       ├── db.js            pg pool, schema init, seeds, migrations
│       ├── jobs.js          cron job functions (testable, dry-runnable)
│       └── mailer.js        Resend wrapper + email_log persistence
└── scripts/
    ├── test-crons.js        manually invoke each cron
    ├── seed-real-data.js    one-off seed for SKUs + test order (gitignored)
    └── add-decision-rules.js  legacy seed (covered by initPhase2 now)
```
# Thu May 21 15:06:46 CDT 2026
# Thu May 21 16:12:11 CDT 2026
# Thu May 21 16:40:16 CDT 2026
# Thu May 21 16:52:54 CDT 2026
# Thu May 21 17:44:21 CDT 2026
# Thu May 21 17:46:16 CDT 2026
# Thu May 21 17:58:12 CDT 2026
# Thu May 21 20:24:45 CDT 2026
# Thu May 21 20:32:21 CDT 2026
# Thu May 21 22:27:12 CDT 2026
# Fri May 22 16:16:27 CDT 2026
# Fri May 22 16:25:04 CDT 2026
# Fri May 22 16:46:48 CDT 2026
# Fri May 22 17:49:21 CDT 2026
# Fri May 22 18:17:23 CDT 2026
# Fri May 22 18:22:27 CDT 2026
# Fri May 22 18:26:51 CDT 2026
# Fri May 22 18:34:33 CDT 2026
# Fri May 22 18:39:36 CDT 2026
# Tue May 26 08:15:02 CDT 2026
