# ENG-004 — Stale schema assertions, and migration steps excluded by their own description

**Status:** code fixed; the class is now swept. **Found:** 2026-11-06, by the first gate-2 run against
a real production dump. **Severity:** one live defect on every fresh deployment, plus a false release
blocker on a correct production database.

---

## What happened, in order

The first run of `scripts/verify-prod-dump.sh` against the real 25MB production dump exited 1 and
halted the migration chain on one step:

```
outreach: unique on (entity_type, entity_id): MISSING
❌ the upsert has nothing to conflict on — setStatus would duplicate rows
```

Four separate things were wrong, each hidden behind the one in front of it.

### 1. The halt was a stale assertion, not a defect

`scripts/migrate-outreach.js` creates `outreach` with `UNIQUE (entity_type, entity_id)` and then
verifies the constraint exists. On 2026-10-01 `scripts/migrate-outreach-partner-scope.js`
**deliberately dropped it**, added `outreach.partner_id`, and replaced it with

```sql
CREATE UNIQUE INDEX uq_outreach_entity_partner
  ON outreach (entity_type, entity_id, COALESCE(partner_id, 0))
```

so a partner and our own staff can each hold a record for the same prospect — and that script
*throws* if the entity-only constraint is still present. `src/lib/outreach/index.js` has conflicted on
the three-column expression ever since.

The earlier verification was never updated. On production, where partner scoping had been applied, it
demanded a constraint that a later migration removes by design, and stopped the release over a schema
that was correct. The tell was in the report all along: `partner_id` was in the column list it printed.

This is the failure described in `CLAUDE.md` for `verify-product-revocation-live.js` — *"an expectation
built from live account state goes stale the moment somebody changes that account, and the script finds
out by writing."* Here the state was changed by a later migration rather than by a person, and the
script found out by failing a release.

### 2. The first fix was worse than the defect

It added the constraint back, under the name `outreach_entity_type_entity_id_key` — the exact name
partner scope looks for and throws on. On a database where a partner and staff both hold a record for
one prospect the `ALTER TABLE` would fail; where it succeeded it would have re-imposed
one-record-per-prospect on a product that had deliberately moved past it. Reverted.

### 3. The real defect: a schema step excluded by its own summary line

`migrate-outreach-partner-scope.js` was not in the migrator chain. It sat on
`scripts/check-migration-coverage.js`'s exclusion list as *"back-fills partner scope over existing
rows"*. That is accurate and incomplete: it also `ADD COLUMN partner_id`, `DROP CONSTRAINT`, and
`CREATE UNIQUE INDEX`.

So a database built by the migrator had no `outreach.partner_id` at all, and the application's own
`setStatus` upsert failed on it. Measured directly, not inferred:

```
outreach columns: id, entity_type, entity_id, product, status, owner_user_id,
                  last_contacted_at, next_action_at, note, created_at, updated_at
has partner_id: false
APP UPSERT FAILS: column "partner_id" does not exist
```

Production works **only because somebody ran that script there by hand.** Every green check in this
repository had been running against a database where outreach was broken, and a fresh deployment would
have shipped it that way. This is the same defect as the 43 hand-run scripts, surviving one round
longer because it was classified by its description instead of by what it executes.

### 4. The readiness report described a destructive migration that had not happened

Because the chain halted, the steps that create this release's tables never ran — and §6 reported:

```
FAIL  5 column(s) the application reads are GONE
      federal_opportunities.solicitation_number, …, opportunity_bid_reviews.decision
```

None had been dropped. None had ever existed in that database. "GONE" describes the one thing that
check exists to detect, and it sent the reader looking for a `DROP` that was not in the chain.

---

## Fixes

| | |
|---|---|
| `scripts/migrate-outreach.js` | accepts **either** key and reports which — entity-only (pre-partner-scope) or per-partner. Fails only if neither exists, or if both do (which would forbid the per-partner rows). |
| `src/lib/migrate-all.js` | `migrate-outreach-partner-scope.js` is now step **`outreach partner scope`**, placed after `sitenex rename (creates partners)` because `partner_id` carries a FK to `partners`. 48 → **49 steps**. |
| `scripts/check-migration-coverage.js` | exclusion removed; the list now carries a note that an entry there is a *claim* a script changes no schema, and that it was once accepted on a summary line. |
| `scripts/verify-migration-readiness.js` | reads column presence **before** the migration, so DROPPED and NEVER-CREATED are separate findings. Downstream failures of a halted chain are reported as such instead of as four independent faults. |

## New verification

| Harness | Asserts | Result |
|---|---|---|
| `check-outreach-unique-repair.js` | the application's own upsert works after the migration on three real shapes: fresh, pre-partner-scope, production's. One child process per case, because `src/lib/db`'s pool binds the first `DATABASE_URL`. | **22 assertions, exit 0** |
| `check-skipped-inline-constraints.js` | enumerates every constraint declared inside `CREATE TABLE IF NOT EXISTS` — **63 across 57 tables** — and, with `--against <url>`, which are actually missing from a real database. Marks as SUPERSEDED any whose conventional name a later migration drops. | run per dump |
| `check-inline-constraint-sweep.js` | negative controls: the sweep goes red on a real gap, stays green with the constraint, accepts a bare unique index, separates a safe repair from one needing a decision, and does **not** report a superseded constraint. | **14 assertions, exit 0** |
| `readiness-column-classification.test.js` | dropped vs never-created, including that a missing baseline never asserts a drop. | **7 tests, exit 0** |
| `check-production-shape-readiness.js` | reconstructs production's reported shape, dumps it, and runs the whole gate-2 harness against it. | **17 assertions, exit 0** |

---

## The lesson worth keeping

**Both wrong answers came from asserting the SHAPE of the schema instead of the BEHAVIOUR that depends
on it.** A shape assertion — this constraint, that index — goes stale the moment a later migration
deliberately changes it, and then it either fails loudly while the product works, or passes quietly
while the product does not. Both happened here, to the same table, in one afternoon.

So `check-outreach-unique-repair.js` asserts the upsert copied from `src/lib/outreach/index.js`,
executed against the migrated database. It cannot go stale without the application changing with it.

The second lesson is narrower and cost just as much: **an entry on an exclusion list is a claim about
what a script executes, and it was accepted on the strength of what the script said about itself.**
`check-migration-coverage.js` now carries that note where the next person will add the next entry.

The third is about reporting. A checker that cries wolf is not merely noisy — the first run of the
constraint sweep invented `UNIQUE (so)` and `UNIQUE (a)` out of English prose in SQL comments, and a
checker whose third verdict nobody reads is exactly how 2026-09-30 happened. Every new checker here
has a negative control that watches it say no.

## Still open

Nothing in this ticket. `ENG-003` remains the deployment blocker; gates 1 and 2 of ruling 32 remain
with the owner.
