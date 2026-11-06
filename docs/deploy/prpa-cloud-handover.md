# PRPA cloud deployment handover

**Ruling 27 items 6 and 7.** Everything below is a procedure for *you* to run. Nothing here has been
executed: no infrastructure was provisioned, no production migration was run, no credential was
rotated, and nothing was merged or deployed.

**This release is GATED on credential rotation.** See §1. That gate is not advisory.

---

## 1. The gate — do not deploy before this is true

Ruling 27 item 7: *"Preserve all credential-remediation blockers. Do not deploy with exposed or
unrotated credentials."*

| Finding | Status | What closes it |
|---|---|---|
| **Admin password exposed in public Git history** | **OPEN** | You change it and confirm. I have not inferred remediation from anything, and `password_mismatch` is not evidence. |
| GitHub PAT in the project handoff document | **OPEN** | Rotate per `docs/security/rotation-order.md`. |
| PostgreSQL credentials, webhook secrets, JWT secret | **OPEN** | Same document, **in its dependency order** — the order is forced, not a preference. |
| Repository visibility | **Your decision** | No history was rewritten and no visibility changed. |

The order in `docs/security/rotation-order.md` matters for one concrete reason worth repeating here:
`src/lib/core.js` signs tokens with `expiresIn: '7d'`, so **changing the admin password does not
invalidate tokens already minted with it**. Rotating `JWT_SECRET` is what revokes those, and it has
to come *after* the password change or you lock yourself out with a password you have not yet
changed.

Deploying before this is complete publishes an application whose admin credentials are in a public
Git history. That is the whole of the gate.

---

## 2. What is being deployed

A federal contract tracker: manual intake (CSV and single solicitation URL), a board with
eligibility and fulfilment feasibility, deadline confirmation, human bid/no-bid review, duplicate
and amendment handling, an append-only audit trail, and an Excel-compatible export.

**The data is a development dataset.** 253 real SAM.gov records harvested once on 2026-11-06, from
committed fixtures with their sha256. There is no scheduled harvest and no live feed — by design
(ruling 22 item 8 keeps that endpoint attended and manual). Every API response carries
`dataset.is_live_feed: false` and the dashboard shows it in a banner, because a board of real
solicitation numbers and real deadlines otherwise looks exactly like a live feed.

---

## 3. Environment configuration

### 3.1 The one variable that is new and load-bearing

```
MIGRATION_DATABASE_URL   the OWNER role — holds DDL, used only by scripts/migrate.js
DATABASE_URL             the APPLICATION role — no DDL, no superuser (see §4)
```

If `MIGRATION_DATABASE_URL` is unset the migrator falls back to `DATABASE_URL` and says so. That
works, and it does **not** deliver ENG-003's separation.

### 3.2 Also required

| Variable | Why |
|---|---|
| `JWT_SECRET` | the app refuses to start without it |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | **only on the first migration against an empty database** — `initDB()` seeds the first admin and refuses to fall back to a default. Once an admin row exists they are never read again. |
| `PRPA_COMPANY_SLUG` | defaults to `abiozen`; the company row every PRPA table is welded to |
| `NODE_ENV=production` | |

### 3.3 Not required by PRPA

No AWS variables. The document store is **not provisioned** — ruling 17 holds that, and the
attachment endpoint deliberately does not download or store anything server-side. It returns the
canonical SAM.gov links and says so in its response.

---

## 4. Database roles

Run as the owner, once, before the first deploy that uses the split URLs.

```sql
-- 1. the application role: no DDL, no superuser, no RLS bypass
CREATE ROLE playbookos_app LOGIN PASSWORD '<generate; never reuse>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

-- 2. PostgreSQL 15 already stops granting CREATE on public to PUBLIC. This is for a database
--    restored from an older dump, where PUBLIC may still hold it.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL    ON SCHEMA public FROM playbookos_app;

-- 3. what it may do
GRANT USAGE ON SCHEMA public TO playbookos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO playbookos_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO playbookos_app;

-- 4. and for tables a FUTURE migration creates, so this does not have to be re-run every time
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO playbookos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO playbookos_app;
```

Verify, as `playbookos_app`:

```sql
SELECT has_schema_privilege(current_user, 'public', 'CREATE');  -- must be false
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;  -- both false
```

`scripts/check-startup-without-ddl.js` performs exactly this setup on a disposable cluster and then
proves the application works inside it — 28 assertions, exit 0.

**Column-level grants for the scan verdict columns** (ruling 18 item 6) are designed and proved in
`scripts/check-db-role-separation.js` but are **not** in the block above, because the document store
they protect is not provisioned. Apply them with the S3 work, not before.

---

## 5. Migrations

```sh
node scripts/migrate.js --plan     # list the steps, connect to nothing
node scripts/migrate.js --check    # is the schema ready? changes nothing
node scripts/migrate.js            # apply
echo $?                            # read it
```

**47 schema steps.** It reports which connection it used and whether that role can `CREATE`, and
refuses to run as a role that cannot. It records every step in `schema_migrations` — a ledger that
did not exist before, which is why "which migrations has this database had?" had no answer anywhere.

After applying, it re-runs **the server's own readiness check** and fails if that still fails. A
migration that reports success while the server would refuse to start is the failure worth catching
at this step rather than at boot.

### 5.1 This must be a deploy step, not a boot step

`server.js` no longer migrates. It calls `src/lib/schema-ready.js`, which only `SELECT`s, and exits
non-zero with the command to run if the schema is absent. Starting anyway would give a server that
answers `/health` with 200 while every request fails — which is what the 2026-09-30 outage looked
like from outside.

On Railway, run the migrator as a release command before the start command.

### 5.2 What was found while building this

43 `scripts/migrate-*.js` files existed and **not one was in any chain** — each had been run by
hand, once, in whatever order was remembered. A freshly migrated database was missing **57 tables**,
and the SPA's own page load returned 500 on `/api/notifications` and `/api/outreach/tasks`. Those
are now 27 steps inside the migrator, and `scripts/check-migration-coverage.js` fails the build if a
migration script creates a table the migrator does not.

One script remains deliberately outside it: `migrate-enforce-denials.js`, which flips an enforcement
switch. That is a policy change, not a schema step, and it should stay a decision.

---

## 6. Rollback

### 6.1 Application

Railway redeploys the previous image. The schema is **additive** — every PRPA step is
`CREATE TABLE IF NOT EXISTS` / `CREATE OR REPLACE` — so the previous application runs against the
new schema unchanged. **Prefer this.** No schema rollback is needed to recover from a bad deploy.

### 6.2 Schema, if it is genuinely necessary

Each PRPA schema module exports `ROLLBACK_ORDER` (children first) and `ROLLBACK_EXTRA_DDL`:

| Module | Version | Drops |
|---|---|---|
| `src/lib/office/opportunity-audit-schema.js` | `2026-11-06.opportunity-audit.v5` | `opportunity_audit_events` + its append-only trigger and function |
| `src/lib/office/opportunity-schema.js` | `2026-11-06.opportunities.v4` | the five tracker tables, children first |
| `src/lib/office/intake-schema.js` | `2026-11-06.intake.v3` | the intake tables |

Then `DELETE FROM schema_migrations WHERE version = '<step name>'`.

**Dropping `federal_opportunities` destroys the human bid/no-bid record and the audit trail**, which
are the two things in this product that cannot be re-derived from a re-import. Export first:

```sh
curl -H "Authorization: Bearer <token>" \
  https://<host>/api/prpa/tracker/export.csv -o pre-rollback.csv
```

### 6.3 What has no rollback

The one destructive statement in the chain is inside `scripts/migrate-sitenex-rename.js`:
`ALTER TABLE sitenex_deals DROP COLUMN IF EXISTS referred_by`. It is a **no-op on production**,
whose schema is already post-rename. It is named here so it is not discovered.

---

## 7. Access control

| Surface | Gate |
|---|---|
| every `/api/prpa/tracker/*` route | `authMiddleware` → `staffOnly` → `requireTier('procurement')` |
| recording a **BID** decision | additionally `admin` or `super_admin` |
| running an assessment | `adminOnly` |
| the **Federal Contracts** page in the sidebar | the `FEDERAL` nav section, `access: ['admin']` |

**A deliberate asymmetry:** the nav is narrower than the API. A procurement director holds the data
but is not shown the page, because ruling 1 made the federal surface owner-first. Widening it is one
line in the `FEDERAL` section's access list.

The product boundary (`src/lib/products/route-map.js`) classifies all 15 routes under `abiozen`
concretely — not as a wildcard, because an unclassified route 403s for everyone under enforce and a
wildcard would silently absorb a future route belonging elsewhere.

### 7.1 What no endpoint in this surface can do

Asserted by `scripts/prpa-e2e-demo.js` against the router's **code** (comments stripped — the file
explains these restrictions at length, and scanning raw text failed it for describing them):

- send email — there is no mailer reference at all
- submit a bid or quote
- schedule an unattended harvest
- reach any host other than `sam.gov`: exactly **two** outbound fetches, both through the SSRF guard

Manual URL intake is rate-limited to 10/minute/user. That is to stop a loop in a browser tab turning
an attended tool into an unattended harvester, not to stop an attacker who already holds a token.

---

## 8. Smoke tests, after deploying

Run each **bare, as its own command, and read `$?`**. Never chain a verification with anything.

```sh
scripts/wait-for-deploy.sh <sha>     # /health returns the deployed commit; uptime is not a signal
echo $?

scripts/smoke-deployed.sh            # /health, the SPA parses, /api/auth/me 401s anonymously
echo $?
```

Then the three that are specific to this release:

```sh
# 1. the schema is present and the app did NOT migrate at boot
railway logs | grep "schema check: ready"
#    "SCHEMA NOT READY" means the migrator has not run — the app will have exited.

# 2. the tracker answers, and declares itself a development dataset
curl -s -H "Authorization: Bearer <token>" https://<host>/api/prpa/tracker/dataset \
  | grep -o '"is_live_feed":[a-z]*'
#    expect: "is_live_feed":false

# 3. the export downloads, opens in Excel, and carries its provenance
curl -s -H "Authorization: Bearer <token>" https://<host>/api/prpa/tracker/export.csv -o smoke.csv
head -c 3 smoke.csv | xxd | head -1          # expect the UTF-8 BOM: efbb bf
grep -c "Unconfirmed Fields" smoke.csv        # expect 1 — the provenance columns are present
```

**`/health` proves the server is alive. These prove the application is.** That distinction is the
2026-09-30 outage: every monitor was green while the SPA rendered nothing.

---

## 9. Operational monitoring

### 9.1 What to watch

| Signal | Why it matters | Where |
|---|---|---|
| `[boot] SCHEMA NOT READY` | the app exited; migrations did not run | container logs |
| `[prpa] AUDIT WRITE FAILED` | an action succeeded but was not recorded — the audit trail is incomplete from that point | container logs |
| 503 `schema_missing` / `company_missing` | PRPA is not provisioned in that environment | API responses |
| 429 on `/api/prpa/tracker/import/url` | someone is driving manual intake like a harvester | API responses |
| 502 from `/documents` or `/import/url` | SAM.gov unreachable; the feature degrades, nothing else breaks | API responses |

### 9.2 The dataset ages, and that is the thing most likely to mislead

`dataset.age_days` grows every day and nothing refreshes it. At the time of writing every deadline
in the dataset is within weeks. **A month from now the board will be mostly closed solicitations
displayed beside live-looking deadlines.** The banner says so, computed from the harvest date.

If PRPA is going to be used rather than demonstrated, the next real piece of work is a re-harvest
procedure — attended, per ruling 22 item 8 — not a scheduled job.

### 9.3 What is NOT monitored

There is no alerting wired to any of the above. The signals exist in logs and responses; routing
them anywhere is not built, and claiming otherwise would be worse than not having it.

---

## 10. The order to do this in

1. **Rotate credentials** per `docs/security/rotation-order.md`, and confirm the admin password. §1.
2. Decide repository visibility.
3. Create `playbookos_app` and the grants. §4.
4. Set `MIGRATION_DATABASE_URL` (owner) and `DATABASE_URL` (app).
5. Run `node scripts/migrate.js` against the production database. Read `$?`. §5.
6. Deploy — which is the merge to `main`, and needs your authorization (ruling 27 item 10).
7. `scripts/wait-for-deploy.sh`, then `scripts/smoke-deployed.sh`, each bare. §8.
8. Open **Federal Contracts** and confirm the dataset banner says what it should.

Steps 1–5 can all be done before any merge. Only step 6 is the irreversible one.
