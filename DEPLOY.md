# PlaybookOS Deployment Checklist

Pre-launch runbook to take the current `main` branch from local commits to live on Railway. Twelve commits behind production as of this writing — see "Commit inventory" at the bottom.

Read top to bottom. Items are ordered so that anything depending on a secret comes after the secret is set.

---

## 0. Pre-flight (do this once, before anything else)

- [ ] You have Railway CLI installed and authenticated as a member of the `narenghub` project. Test: `railway whoami` exits 0.
- [ ] You have GitHub push access to `narenghub/playbookos` from this machine. Test: `git ls-remote origin main` exits 0.
- [ ] The Railway project `meticulous-laughter` (id `c34fcdbe-c59e-4ffc-afde-a0770031b901`) is reachable. Test: the Railway dashboard lists service `playbookos` linked to service `Postgres`.
- [ ] The Postgres service in that project is healthy. Test: `railway variables --service Postgres --kv | grep DATABASE_PUBLIC_URL` returns a non-empty value.

If any of these fail, fix them before proceeding. The deploy will not work without all four.

---

## 1. Set environment variables in Railway

Generate strong random values for every `_SECRET` variable with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run that command four times — once per secret. Do not reuse the same value across secrets.

In the Railway dashboard, on the **playbookos** service → **Variables** tab, set each row below. The dashboard also accepts paste of `KEY=value` pairs. The table flags whether each variable is required for boot, required for a specific feature, or optional.

| Variable | Required when | Value source | Notes |
|---|---|---|---|
| `DATABASE_URL` | always | `${{Postgres.DATABASE_URL}}` (reference variable) | Already wired in current deploy. Verify it still points at the Postgres service. |
| `JWT_SECRET` | always — server throws on boot if missing | new 32-byte hex | Used by `signToken` / `verifyToken` in `src/lib/core.js`. |
| `ADMIN_EMAIL` | first boot only | `naren@abiozen.com` | Used only to seed the admin user on initDB. |
| `ADMIN_PASSWORD` | first boot only | strong password | Same — only consumed during initial seed. |
| `ANTHROPIC_API_KEY` | every Claude-driven cron + endpoint | console.anthropic.com | Used by Revenue, Performance, Goal, Growth, Customer, Briefing agents. |
| `RESEND_API_KEY` | every outbound email | resend.com/api-keys | Invites, weekly report, milestone triggers, daily coaching emails, daily briefing, procurement priorities, escalations, outreach. |
| `APOLLO_API_KEY` | `/api/apollo/*` and Apollo cumulative reply rate in metrics snapshot | apollo.io API key | Without this, Apollo endpoints return 400 and the metrics snapshot reports 0% reply rate. |
| `TRIGGERS_SECRET` | 6pm milestone cron | new 32-byte hex | The cron calls `POST /api/triggers/check` with this in the `Authorization: Bearer …` header. Without it, the route 401s and the cron logs a warning. |
| `PLAYBOOKOS_WEBHOOK_SECRET` | Abiozen marketplace → PlaybookOS order webhook | new 32-byte hex | Validates the `X-PlaybookOS-Secret` header on `POST /api/orders/webhook`. |
| `ENGAGEMENT_SECRET` | Apollo / any source → buyer_engagement ingestion | new 32-byte hex | Validates the `X-Engagement-Secret` header on `POST /api/customers/engagement-event`. |
| `GITHUB_TOKEN` | daily 8am GitHub sync + manual sync button | github.com/settings/tokens, scopes: repo, read:org, read:user | Without it, `syncGitHubForUser` returns null silently. |
| `GITHUB_ORG` | optional | `abiozen` | Default org for GitHub queries. |
| `ALGOLIA_APP_ID` | Monday 8am Growth Agent | Algolia dashboard → Settings → API Keys | Growth Agent skips with a clean reason if any of the three Algolia vars is missing. |
| `ALGOLIA_API_KEY` | Monday 8am Growth Agent | Algolia API key with analytics read access | |
| `ALGOLIA_INDEX_NAME` | Monday 8am Growth Agent + Algolia sync | `abiozen_products` | The unified catalog index. Code falls back to `abiozen_products` if unset, so this is effectively fixed. |
| `GOOGLE_SEARCH_CONSOLE_KEY` | optional Growth Agent enhancement | OAuth bearer token | GSC needs OAuth, not a static API key. Set only if you have a refresh mechanism. Growth Agent falls back to Algolia-only if missing or expired. |
| `GSC_SITE_URL` | optional | `sc-domain:abiozen.com` | Default value. Override if your GSC property uses a different identifier. |
| `BASE_URL` | optional | `https://playbookos-production.up.railway.app` | Already set in current deploy. Used in invite emails, daily briefing footer, and the weekly report footer. |
| `PORT` | optional | `3000` | Railway typically injects this automatically. |

**Don't trigger a deploy yet.** Set all variables first; Railway autodeploy on variable change is OK for the final variable, but each intermediate `set-variables` would otherwise kick a deploy of stale code.

---

## 2. Push the twelve commits to GitHub

```
cd /Users/nboda3230/Downloads/playbookos
git status -s              # should be clean
git log origin/main..HEAD --oneline   # should list 12 commits
git push origin main
```

If the push is rejected on auth, see the credential note at the end of this doc.

---

## 3. Trigger the Railway deploy

If GitHub autodeploy is reconnected (per VISION.md item), the push above triggers it automatically. Confirm by polling Railway deployments and waiting for the latest to flip from `BUILDING` to `SUCCESS`.

If autodeploy is still broken, deploy manually from the linked workspace:

```
cd /Users/nboda3230/Downloads/playbookos
railway link --project c34fcdbe-c59e-4ffc-afde-a0770031b901 --service playbookos --environment production
railway up --ci
```

`railway up` respects `.gitignore`, so `node_modules`, `.env`, `*.db*`, and `scripts/seed-real-data.js` are excluded from the bundle.

Watch the build logs for migration output. On first successful boot you should see lines from `initDB → initPhase2 → migrateSchemas`. Specifically look for:

```
✅ PostgreSQL database ready. Admin: naren@abiozen.com
✅ Phase 2 tables ready
✅ Schema migrations applied
ABIOZEN PLAYBOOKOS — RUNNING
```

If the boot throws on `JWT_SECRET environment variable is required`, you missed step 1. Go back, set it, redeploy.

---

## 4. Post-deploy smoke tests

Run these in order. Each should return what's described. URL is the public Railway domain — adjust if you've reconnected the `playbook.abiozen.com` custom domain in step 5.

```
URL=https://playbookos-production.up.railway.app

# 4.1 Health probe — also verifies DB connectivity
curl -s $URL/health
# expect: {"status":"ok","uptime":...,"timestamp":"...","db":"connected"}

# 4.2 Admin login (replace with real password from step 1)
curl -s -X POST $URL/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"naren@abiozen.com","password":"<ADMIN_PASSWORD>"}'
# expect: {"token":"eyJ...","user":{...}}
# export the token for the next calls:
TOKEN=<paste-token-from-above>

# 4.3 Health of each major endpoint (admin token required for most)
curl -s -H "Authorization: Bearer $TOKEN" $URL/api/dashboard/summary | head -c 300
curl -s -H "Authorization: Bearer $TOKEN" $URL/api/integrations | head -c 300
curl -s -H "Authorization: Bearer $TOKEN" $URL/api/metrics/today
# /metrics/today will return {"available": false} until the first midnight cron fires — that's expected.

# 4.4 Trigger one cascade manually to populate goal_cascades + weekly_kpis (otherwise first Monday is the soonest they get written)
curl -s -X POST -H "Authorization: Bearer $TOKEN" $URL/api/goals/cascade
# expect a counts object: {"counts":{"annual":1,"quarterly":4,"monthly":N,"weekly":N,"daily":N}}

# 4.5 Verify the new webhooks reject unauthenticated calls
curl -s -X POST $URL/api/orders/webhook
# expect: 401 "Invalid or missing X-PlaybookOS-Secret header"
curl -s -X POST $URL/api/customers/engagement-event
# expect: 401 "Invalid or missing X-Engagement-Secret header"
```

If any of 4.1–4.4 doesn't return what's described, fail-stop and check Railway logs before continuing.

---

## 5. External wiring (do once, after smoke tests pass)

These are integrations that PlaybookOS needs to receive data from, not just expose data to. Each is independent — set them up in any order.

- [ ] **Custom domain.** In Railway service settings → Networking, confirm `playbook.abiozen.com` is mapped to the playbookos service and the DNS A/CNAME record at your DNS provider is healthy. Today the DNS does not resolve (`curl playbook.abiozen.com` failed during pre-launch checks); fix this before sending invites that include the BASE_URL.

- [ ] **Abiozen marketplace order webhook.** In the Abiozen Django backend, in the Stripe success path (`orders/views.py`), fire `POST {URL}/api/orders/webhook` with the `X-PlaybookOS-Secret` header set to the value you just put in Railway. Body fields: `order_id` (use the Abiozen order_number, idempotent), `amount`, `buyer_email`, `buyer_type`, `product_category`, `product_name`, `order_date`. Without this, every online sale must be re-entered in PlaybookOS by an admin.

- [ ] **Apollo engagement events.** Apollo's web UI does not have a native webhook for opens/clicks/replies. Two options:
  - Set up Zapier or n8n to listen for "Email opened" / "Email clicked" / "Email replied" Apollo events and POST to `{URL}/api/customers/engagement-event` with the `X-Engagement-Secret` header. Body: `contact_email`, `event_type` (one of sent/opened/clicked/replied/bounced), `molecule_interest`, `sequence_id`, `event_at`.
  - Or write a separate poller that hits the Apollo per-contact analytics endpoint hourly and POSTs the deltas to the same endpoint.
  - Without this, `buyer_engagement` stays empty, warmth scores are all 0, `/customers/warm-leads` returns `[]`, and the daily briefing's warm-leads section reads "(no warm leads — buyer_engagement empty)".

- [ ] **Algolia analytics access.** In the Algolia dashboard, confirm the API key you set in step 1 has the `analytics` ACL. The Growth Agent only reads — no write permissions needed.

- [ ] **GSC OAuth.** Optional. If you want SEO data feeding the Growth Agent, the simple `GOOGLE_SEARCH_CONSOLE_KEY=<bearer>` approach expires every ~60 minutes. For production, replace `fetchGSCData` in `src/lib/agents/growth-agent.js` with a service-account-based refresh flow, or skip this entirely — the Growth Agent runs cleanly on Algolia signal alone.

- [ ] **Reconnect GitHub autodeploy.** Railway dashboard → playbookos service → Settings → Source → confirm the GitHub connection is healthy. If "Last deployment" predates this push, click **Disconnect**, then **Connect Repo**, select `narenghub/playbookos` and branch `main`. Toggle **Automatic Deployments** on. Set **Health Check Path** to `/health` so failed deploys auto-rollback. (See VISION.md / earlier session notes — autodeploy was broken since April 3.)

- [ ] **Migrate any users with legacy roles.** This release replaces the old role taxonomy (`procurement`, `sales`, `marketing`, `qc`) with a 10-role catalog (procurement_lead, customer_engagement, lead_chemist, logistics, recruitment, hr_accounts, seo_specialist, platform_ops, admin, dev). Users with old role values still work but won't be cascaded or scored against role-specific baselines. From the admin UI Team page (or directly via `PUT /api/users/:id` with the new `role` value), update each legacy user. Suggested mapping: `procurement → procurement_lead`, `sales → customer_engagement`, `marketing → seo_specialist`, `qc → lead_chemist`. Custom roles can be added at runtime via `POST /api/roles`.

---

## 6. First-week expected behavior

The first few days post-launch will look different from steady-state. This is normal — the system is bootstrapping its baselines.

- **Day 0 (deploy day):** All cron jobs are scheduled but most haven't fired yet. `/metrics/today` returns `{available: false}`. `/briefing/latest` returns the empty state. `/api/goals/team-week` is empty unless you ran step 4.4.
- **Day 1, 00:00 UTC:** First `metrics_snapshots` row written (representing day 0). `/metrics/today` now serves data, but anomaly detection still says "insufficient baseline".
- **Day 1, 07:00 UTC:** First daily briefing email lands in admin inbox. Anomaly section reads `(insufficient baseline)`.
- **Day 1, 08:00 UTC:** First GitHub sync runs (likely 0 users with `github_username` until you set them).
- **Day 1, 18:00 UTC:** First performance scoring run. Most users score 0 because no activity has been logged. The 3-day escalation threshold is not yet reachable.
- **Day 4+:** Anomaly detection has enough snapshots to flag real swings (≥4 snapshots required).
- **Day 7+:** All bands of the briefing produce signal. Performance escalations can fire if any user has had three consecutive sub-60 days.
- **Next Monday 08:00 UTC:** First Growth Agent run (Algolia data permitting) and first scheduled Goal Engine cascade.
- **Next Monday 09:00 UTC:** First Revenue Intelligence email to admin.

---

## 7. Rollback procedure

If the deploy boots but a cron job starts firing destructive emails or wrong data:

1. In Railway dashboard → Deployments tab, click the previous successful deployment (the one from before this push) and click **Redeploy**. This reverts the running code in ~30 seconds.
2. Schema changes are forward-only via `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`; the older code will simply ignore the new columns and tables. No data loss.
3. To debug after rollback, the latest deployment ID and its logs remain in Railway for ~30 days. Pull them with `railway logs --service playbookos --deployment <id>`.

If the deploy boots cleanly but a specific feature misbehaves, you can:
- Disable a single cron by setting its required env var to empty (e.g., remove `TRIGGERS_SECRET` to silence the 6pm milestone cron; the cron skips with a warning).
- Manually trigger any job from a local terminal: `railway run --service Postgres bash -c 'DATABASE_URL=$DATABASE_PUBLIC_URL JWT_SECRET=test node scripts/test-crons.js --live'` (live mode runs the actual jobs with side effects — only do this if you understand what each fires).

---

## Commit inventory

Twelve commits queued for this push, oldest first. Each is self-contained — squashing into one commit is fine if you prefer a single launch SHA in the history.

| SHA | Summary |
|---|---|
| `aa89f93` | `.gitignore` broadened (`.db-shm`, `.db-wal`, seed-real-data); WAL files untracked |
| `4267bda` | README + `.env.example` rewritten to match Postgres + Resend + Apollo stack |
| `52018dc` | Orders webhook, CSV export, hardened POST /orders validation |
| `8d9942d` | `PLAYBOOKOS_WEBHOOK_SECRET` documented |
| `9cc433b` | Layer 2D — AI performance scoring + coaching emails + 3-day escalation |
| `000d1ce` | Layer 2A + 2B — Revenue Intelligence agent + procurement priorities |
| `b36ba2a` | VISION.md — six-layer architecture spec |
| `85abc04` | Layer 6 — Command Center 7am daily briefing agent |
| `8a6221f` | Layer 2C — Growth Agent (Algolia + GSC) |
| `4279ddb` | Layer 1 — Goal Engine cascade + weekly KPIs |
| `04351ad` | Layer 1 divergence-recalc + Layer 2E Customer Agent warmth scoring |
| `7335ed2` | Engagement webhook + LinkedIn tracking + Layer 5 metrics snapshots + anomaly detection |
| (next) | Pre-launch — conditional LinkedIn render, Run Cascade button, Command Center page, deploy checklist |

---

## Credential note

If `git push origin main` is rejected with `Permission to narenghub/playbookos.git denied to adificetech`, your stored GitHub credential on this machine is the wrong account. Two options:

- Re-auth as the `narenghub` user: `gh auth login`, then re-run the push.
- Or supply a one-time tokenized URL: `git push https://narenhub:ghp_<token>@github.com/narenghub/playbookos.git main`. **Rotate the token immediately after the push** — it lands in `~/.bash_history` and in this terminal's scrollback.
