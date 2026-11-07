# The migration chain, and why its order is load-bearing

**Ruling 33 item 1.** Generated from `src/lib/migrate-all.js`, not transcribed. To print it yourself:

```sh
node scripts/migrate.js --plan        # reads nothing, connects to nothing, changes nothing
```

`scripts/doc-step-counts.test.js` fails the build if this document or any other quotes a step count
that disagrees with the migrator, because the chain has changed length four times in two days and each
change left a different subset of documents stating the previous number.

---

## Why a chain exists at all

There are **43** `scripts/migrate-*.js` files. Until 2026-11-05 **none** of them was in any chain: each
was run by hand against production with `railway ssh`. A fresh database was missing 57 tables and the
SPA's own page load returned 500. `scripts/check-migration-coverage.js` was written to close that, and
it did — for tables.

It did not close it for **columns**, and that gap cost two more days:

| Found | What was missing | How |
|---|---|---|
| 2026-11-06 | `outreach.partner_id` | the first real production-dump run halted on `outreach`, over a *correct* schema |
| 2026-11-07 | `outreach.channel` | `check-behavioral-regression.js` booted the server; the first outreach write returned **500** |
| 2026-11-07 | `users.invited_partner_id`, `prospects.country`, `prospects.source_partner_id`, `sitenex_contracts.region`, `sitenex_deals.status_changed_at`, `cphi_exhibitor_matches.entity_note` | the same sweep, once coverage was taught to enumerate every script rather than every table |

A migration that only `ADD COLUMN`s was invisible to the coverage checker by construction. It now fails
on **any** `migrate-*.js` that is in neither the chain nor the exclusion list, whatever it changes:
**39 in the chain, 4 excluded by name with a stated reason, 43 total.**

---

## The order, and the four places it matters

The plan is printed by the command above. Order is not cosmetic — later steps `ALTER` tables earlier
ones create, and three of the four orderings below were discovered by a step failing, not by reading:

| Step | Must follow | Because |
|---|---|---|
| **38. outreach partner scope** | 36. sitenex rename (creates partners) | `outreach.partner_id` carries a foreign key to `partners`. Placed next to step 12 (`outreach`), where it reads as though it belongs, it fails with `relation "partners" does not exist`. |
| **42. outreach vocabulary (channel)** | 12. outreach | it `ALTER`s `outreach` and `outreach_events`. |
| **44. partner book country/region** | 13. prospects, 39. sitenex phase3 | it alters `prospects` and `sitenex_contracts`. |
| **45. sitenex stage clock** | 36. sitenex rename | it alters `sitenex_deals`, which only exists after the rename. |

Steps 42–46 are grouped deliberately: every table they touch exists by then, and all five are
`ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, so each is a no-op where it has already been
applied — which is all of them on production.

### One step that had never run successfully anywhere

**45. sitenex stage clock.** `scripts/migrate-sitenex-stage-clock.js` carried this comment:

> *"So: add it empty, backfill what is knowable, and only then set the default for future inserts."*

The first two were implemented. **The third was never written**, and the verification three lines below
demanded it:

```js
if (!/now\(\)/i.test(col.column_default || '')) throw new Error('must DEFAULT NOW() so new rows start their clock');
```

So the script threw on every run it has ever had — including on production, where the `ADD COLUMN`
landed before the throw. `sitenex_deals.status_changed_at` is therefore present there **with no
default**, and every SiteNex deal created since starts with `status_changed_at` NULL: no stage clock at
all, for the column that exists to measure stage age.

It was in no chain, so nothing ever ran it anywhere the exit code was read. The missing
`ALTER COLUMN ... SET DEFAULT NOW()` is now in place, after the backfill — never on the `ADD COLUMN`,
because `ADD COLUMN ... DEFAULT NOW()` fills every existing row with `NOW()`, which turns a guess into
something that looks like a measurement.

**This is not repaired on production by the migration.** Existing deals keep their NULL, correctly —
when a deal's status last changed is not recoverable. New deals will start their clock. Rows created
between the hand-run and the migration are permanently unknowable, and read as not recorded.

---

## Boot applies no DDL

`server.js` runs `src/lib/schema-ready.js`, a **read-only** check, and exits non-zero with the command
to run if the schema is not ready. The chain is a separate process (`node scripts/migrate.js`), so the
application never needs DDL privileges — `docs/tickets/ENG-003`.

`schema-ready.js` now also requires `outreach.partner_id`. On 2026-11-06 it did not, and a server on a
database missing that column would have started, answered `/health` 200 with `db: connected`, and
failed every outreach status change: green from outside, broken in use, which is what 2026-09-30 looked
like.

---

## Ruling 33 item 3 — the exact safe command

```sh
cd ~/Downloads/playbookos && git pull
scripts/verify-prod-dump.sh ~/Downloads/playbookos-prod.dump
echo $?
```

The dump you already took is fine; nothing about it was at fault.

**Why it is safe, asserted rather than claimed** — `scripts/check-dump-test-isolation.js`, 10
assertions, exit 0. It creates a live decoy database, points `DATABASE_URL`,
`MIGRATION_DATABASE_URL`, `DATABASE_PUBLIC_URL`, `PGHOST`, `PGPORT`, `PGDATABASE` and `PGUSER` at it,
runs the readiness harness against a real dump, and then asserts the decoy is untouched: same single
table, same two rows, no `schema_migrations` ledger.

That matters because the isolation is an **ordering**, not a guard:

```
line 153   process.env.DATABASE_URL = urlFor('existing')      <- the disposable cluster
line 243   require('../src/lib/migrate-all')                   <- which requires src/lib/db
```

`src/lib/db` builds its connection pool from `DATABASE_URL` at require time, once. The overwrite
protects everything only because it happens first. Move either line — or add a top-level
`require('../src/lib/db')` — and every step marked `usesOwnPool: true`, which is most of the chain,
would run against whatever `DATABASE_URL` the operator had exported. The harness asserts that ordering
explicitly, so a future edit cannot quietly undo it.

The wrapper itself holds no connection string and never passes one to a client; both are asserted.

---

## Ruling 33 item 6 — the previous release on the migrated schema

`scripts/check-previous-release-compat.js` — **13 assertions, exit 0.** It boots the **actually
deployed** release (`origin/main`) against a database this chain has migrated, and asserts it *serves*
rather than merely boots: `/health` 200 with `db: connected`, `/api/auth/me` 401s anonymously, the SPA
renders. It then re-runs that release's own boot migrations over the new schema and confirms 152 tables
remain, all PRPA rows survive, and the schema still passes the new release's readiness check — so a
roll-forward after a rollback also works.

**Rollback is therefore redeploy the previous image.** That sentence had been written in three
deployment documents and tested nowhere; it is now tested. There is no schema rollback and none should
be attempted first — the chain is additive apart from the two documented statements in
`migration-risk-report.md` §1.2 and §1.4.

**The tested alternative recovery procedure**, if a rollback is not enough: restore the pre-migration
backup and re-migrate. `verify-migration-readiness.js` performs exactly this and asserts the restored
database matches the pre-migration baseline row for row. Note that a restored pre-release backup does
**not** pass the new release's readiness check, and correctly so — the migration is what adds those
tables. Recovery means restore *and then* re-migrate.
