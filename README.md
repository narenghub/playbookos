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
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | yes (first boot) | Bootstrap admin user during the initial DB seed. Ignored on subsequent boots. |
| `ANTHROPIC_API_KEY` | yes | Claude API key for AI analysis and market intelligence. |
| `RESEND_API_KEY` | yes | Resend API key for outbound email (invites, weekly reports, milestone triggers, Apollo outreach). |
| `APOLLO_API_KEY` | yes (for Apollo features) | Apollo.io API key. Required for every `/api/apollo/*` endpoint. |
| `GITHUB_TOKEN` | yes (for GitHub sync) | Personal access token with `repo`, `read:org`, `read:user` scopes. Used by the 8am sync cron and the manual "Sync GitHub now" button. |
| `GITHUB_ORG` | no | Default org for GitHub queries. |
| `PORT` | no | HTTP listen port. Defaults to 3000. |
| `BASE_URL` | no | Public URL of the deployed app — referenced in email links (invite acceptance, weekly report footer). |

## API endpoints

All routes are mounted under `/api` and require `Authorization: Bearer <token>` unless noted.

**Auth** — `POST /auth/login` (rate-limited 10/min/IP), `POST /auth/accept-invite` (rate-limited 10/min/IP), `GET /auth/me`

**Users / team** — `GET /users`, `POST /users/invite` (admin), `PUT /users/profile`, `PUT /users/:id`

**Activity** — `POST /activity`, `GET /activity/my`, `GET /activity/team` (admin)

**Revenue / orders** — `POST /orders` (admin), `GET /orders`, `POST /orders/webhook` (header-auth, see below)

**Dashboard** — `GET /dashboard/summary`, `GET /dashboard/my`, `GET /dashboard/export` (CSV download of current month orders + summary stats; intended for board reports)

**GitHub** — `POST /github/sync`

**Milestones** — `GET /milestones`, `PUT /milestones/:id` (admin), `DELETE /milestones/duplicates` (admin)

**AI / triggers** — `POST /ai/analyze` (admin), `GET /ai/latest`, `POST /triggers/check` (requires `TRIGGERS_SECRET` in `Authorization: Bearer …` header)

**Targets** — `GET /targets`, `POST /targets` (admin)

**Decision engine** — `GET /decision-rules`, `POST /decision-rules/evaluate` (admin)

**SKUs** — `GET /skus`, `POST /skus` (admin), `POST /skus/bulk-upload` (admin), `GET /skus/export`

**Execution / integrations** — `GET /execution-steps`, `PUT /execution-steps/:id` (admin), `GET /integrations`

**Performance scoring** — `GET /performance/scores` (admin, last 30 days for everyone), `GET /performance/my` (logged-in user, last 30 days)

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
| `0 8 * * *` (daily 8am) | GitHub sync for all active devs | `syncGitHubAllDevs()` |
| `0 9 * * 1` (Monday 9am) | Claude weekly analysis + emailed report | `runWeeklyAnalysis()` |
| `0 18 * * *` (daily 6pm) | Milestone trigger check | `checkMilestoneTriggers()` via HTTP to self with `TRIGGERS_SECRET` |
| `0 18 * * *` (daily 6pm) | AI performance scoring + per-user coaching email | `scoreAllAndCoach()` |

All accept `{ dryRun: true }` for safe manual testing.

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
