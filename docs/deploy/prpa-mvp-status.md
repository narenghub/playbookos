# PRPA MVP — what works, what is missing, what remains before production

**Ruling 27 item 9.** Written against the code as it stands, with the command that proves each claim.

**Nothing was deployed.** No merge to `main`, no production migration, no infrastructure
provisioned, no contracting officer contacted, no bid submitted (ruling 27 item 10).

---

## 1. Fully working

Each line names the check that proves it. All run bare; the exit code is the verdict.

| Capability | Proof |
|---|---|
| **Manual intake — CSV** | `POST /api/prpa/tracker/import/csv`, authenticated, with the sha256 of the bytes recorded. `prpa-e2e-demo.js` |
| **Manual intake — one solicitation URL** | `POST /api/prpa/tracker/import/url`, through the SSRF guard, rate-limited 10/min/user. Real fetch against sam.gov in the demo. |
| **The board** | 15 routes. Title, agency, solicitation number, deadline, set-aside, requested products/services, feasibility, missing evidence, source link, human review — every column ruling 27 item 2 names, asserted present on every row. |
| **Deadline confirmation** | `is_biddable` is a generated column requiring `deadline_confirmed_at`. Nothing is biddable until a human confirms. Demonstrated flipping false → true. |
| **Human bid/no-bid review** | Recorded with a rationale of ≥10 characters, enforced by a CHECK. A `bid` decision additionally requires admin. |
| **Duplicate / amendment handling** | Amendments keep the superseded version (`version_seq`); cross-number duplicates are flagged for a human and **never merged**. |
| **Audit history** | `opportunity_audit_events`, append-only by trigger — UPDATE and DELETE both refused, proved as the restricted role. 11 action types. |
| **Role-based permissions** | `authMiddleware` → `staffOnly` → `requireTier('procurement')`; `bid` and assessment are admin-only; all 15 routes classified in the product boundary. |
| **Excel export** | One click. BOM, CRLF, no cell starts with a formula character, and **provenance travels in the file**: source route, harvest date, export timestamp, per-row confirmed/unconfirmed columns. |
| **Dashboard** | Renders real data with both banners; 17 assertions including "no page errors". `screenshot-prpa-tracker.js` |
| **Dataset is not presented as live** | `is_live_feed: false` on every response, with an age-aware staleness warning. |
| **ENG-003 — the code half** | Boot applies no DDL. The app imports, assesses, confirms, reviews and exports as a role with NOSUPERUSER and no CREATE, while every DDL statement it attempts is refused. 28 assertions. |
| **Migration coverage** | 48 steps, a `schema_migrations` ledger, and a checker that fails if any migration script creates a table the migrator does not. |

```sh
node scripts/prpa-e2e-demo.js             # 46 assertions — import → … → Excel, over HTTP
node scripts/check-startup-without-ddl.js # 28 assertions — ENG-003
node scripts/screenshot-prpa-tracker.js   # 17 assertions — the page renders real data
node scripts/check-migration-coverage.js  # every table a script creates, the migrator creates
node scripts/check-prpa-route-collisions.js
node scripts/check-opportunity-tracker.js # 137 assertions — the library guards
```

---

## 2. What this product will not tell you, by construction

Not gaps. These are the answers it refuses to fake.

- **Nothing can be QUALIFIED.** The capability registry holds **zero** verified capabilities, so
  every verdict is `NEEDS_REVIEW` or `NOT_QUALIFIED` and every feasibility verdict is `UNPROVEN` at
  best. The board says so in a banner. Database CHECK constraints make it unreachable, not merely
  unlikely.
- **No margin figure anywhere.** No supplier quote exists for any requirement, and a margin with one
  side missing would be invented.
- **39 of 82 wave-1 notices have no resolvable product class**, because their bodies say only "see
  the attached documents". Reported `unknown`, never upgraded by inference.
- **A blank set-aside is not "unrestricted."** Where the field is empty and the text says otherwise,
  the row carries a `SET_ASIDE_UNVERIFIED` flag — and deliberately **no score penalty**, because
  docking it buried the only direct product fit on the board below a vaccine RFP.

---

## 3. Still missing

### 3.1 Needed before this is more than an MVP

| Gap | Consequence |
|---|---|
| **The dataset ages and nothing refreshes it** | In a month the board is mostly closed solicitations beside live-looking deadlines. The banner mitigates; it does not fix. A re-harvest procedure — attended, per ruling 22 item 8 — is the next real work. |
| **No attachment text extraction** | `/documents` lists attachments and links them. Where a notice body is empty, the scope is in those files and nobody has read it. This is why 39 rows are `unknown`. |
| **The capability registry is empty** | Until capabilities are verified and activated through the guarded path, this is a *disqualification* engine: it can tell you what you cannot do and never what you can. |
| **No supplier quotes** | The margin check can never return anything but UNKNOWN. |

### 3.2 Built but not wired

- **Column-level grants** for the scan verdict columns (ruling 18 item 6) are designed and proved,
  but not applied — the document store they protect is not provisioned (ruling 17 holds that).
- **No alerting.** The operational signals in the handover exist in logs and responses; nothing
  routes them anywhere.

### 3.3 Deliberately not built

Nothing that contacts a contracting officer, submits a bid, sends email, or harvests unattended.
Asserted against the router's code, not left to a comment.

---

## 4. Exact remaining steps before production release

In order. Steps 1–5 need no merge and no deployment.

1. **Rotate credentials** per `docs/security/rotation-order.md`, in its dependency order, and
   **confirm the admin password has changed**. It remains OPEN; nothing has been inferred.
2. **Decide repository visibility.** No history rewritten, no visibility changed.
3. **Create the `playbookos_app` role and its grants** — exact statements in
   `docs/deploy/prpa-cloud-handover.md` §4.
4. **Split the URLs:** `MIGRATION_DATABASE_URL` (owner), `DATABASE_URL` (app). This is what closes
   ENG-003; the code half is done.
5. **Run `node scripts/migrate.js`** against the production database as a deploy step, and read
   `$?`. 48 steps. The app will not start without it — by design.
6. **Merge to `main` and deploy.** Needs your separate authorization (ruling 27 item 10). Railway
   auto-deploys from `main`, so the merge *is* the deployment.
7. **`scripts/wait-for-deploy.sh` then `scripts/smoke-deployed.sh`**, each bare, each `$?` read.
8. **Open Federal Contracts** and confirm the dataset banner.

### 4.1 The one thing that will break a naive deploy

If step 5 is skipped, the application **exits non-zero at boot** with the command to run. That is
deliberate: starting anyway gives a server answering `/health` with 200 while every request fails,
which is what 2026-09-30 looked like from outside.

---

## 5. Defects found while building this

Each was found by running something, not by reading.

1. **Three new routes were dead on arrival.** `routes.js` already declared `/prpa/opportunities`,
   `/prpa/review-queue` and `/prpa/capabilities`, and it mounts first — Express gives the request to
   the first match, so the new handlers would never have run. Namespaced to `/prpa/tracker/*`;
   `check-prpa-route-collisions.js` now fails the build on any such collision.
2. **57 tables were reachable only by running a script by hand.** 43 `migrate-*.js` files, none in
   any chain. A freshly migrated database 500'd on its own page load.
3. **The PRPA schema could never have applied to a real database.** `verified_capabilities` lacked
   the composite UNIQUE its foreign key needs, and the v3 seed row violated three constraints on
   `source_connectors` — it had only ever run against a stub.
4. **A recorded decision never appeared on the board.** `listOpportunities` aliases the review
   columns (`bid_decision`); the route read `r.decision`. The API said saved, the board showed
   nothing.
5. **The dataset endpoint 500'd** on guessed column names — so the banner that tells a reader the
   data is *not live* was the thing that failed to load.
6. **`MATCH FULL` refused every set-wide audit event.** `company_id` is NOT NULL, so a null
   `opportunity_id` made a partially-null pair. Changed to `MATCH SIMPLE`, which is correct here and
   nowhere else in this schema.
7. **The date bug, a fifth and sixth time** — `contract-render.js` was writing "Sat Nov 21" into the
   payment schedule of a generated contract. `check-date-formatting.js` now sweeps 604 files every
   preflight run.
8. **Two of my own checkers were wrong in opposite directions:** the collision checker was verified
   by making it go red deliberately; the coverage checker failed while reporting "0 tables across 0
   scripts", a red with nothing to fix, which trains a reader to ignore exit codes.
