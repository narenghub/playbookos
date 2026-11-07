# ENG-005 — A unique index on a table that already holds duplicates

**Status:** guard implemented and tested; **one data decision is required from the owner before the
migration can complete on production.** **Found:** 2026-11-07, by the first production-dump run that
executed the correct 53-step chain.

---

## What happened

With the right code finally running, the chain cleared `outreach` and halted later:

```
cphi exhibitors: scripts/migrate-cphi-exhibitors.js failed:
  CPHI migration error: could not create unique index "idx_cem_unique"
```

`CREATE UNIQUE INDEX IF NOT EXISTS idx_cem_unique ON cphi_exhibitor_matches (event_slug,
holder_normalized)` cannot be created because **production already contains duplicate
`(event_slug, holder_normalized)` pairs.** The index has never existed there, so nothing ever
prevented them accumulating.

Two things made it worse than it needed to be:

1. **The statement was bundled** into the same multi-statement `query()` as the `CREATE TABLE` and the
   three non-unique indexes, so one failing index took the whole step down.
2. **The error names the index, not a row.** "could not create unique index" gives the reader nothing
   to act on — not which pairs, not how many, not whether any of them matter.

## Why ENG-004's sweep did not catch it

`check-skipped-inline-constraints.js` was built for constraints declared **inside**
`CREATE TABLE IF NOT EXISTS`. On the very same run it reported, correctly:

> `no constraint declared inline is missing from this database`

`idx_cem_unique` is a standalone `CREATE UNIQUE INDEX`, so it was never examined. **Nine** such
indexes exist, on `molecules`, `molecule_aliases`, `molecule_pricing`, `molecule_dmf_matches`,
`study_molecules`, `research_findings`, `federal_awards`, `cphi_exhibitor_matches` — all holding
production rows, each able to halt its step the same way.

**The two classes fail in opposite directions, which is why one sweep missed the other:**

| | Inline constraint (ENG-004) | Standalone unique index (this ticket) |
|---|---|---|
| On an existing table | silently **SKIPPED** — `IF NOT EXISTS` skips the whole `CREATE TABLE` | **FAILS** and halts the step |
| Symptom | migration passes, guarantee quietly absent | migration stops dead |
| Danger | a lie you act on | a wall you can see |

A sweep looking only for lies will not find walls.

## Why the migration does not simply deduplicate

Two columns in `cphi_exhibitor_matches` carry human work:

- **`review_status`** — anything other than `'unreviewed'` is somebody's decision
- **`entity_note`** — free text, added by `migrate-cphi-entity-note.js`

The rest of the row is derived from a search (`searched_terms`, `checked_at`, `match_tier`) and is
recomputable. A migration that picked a survivor on its own could discard a review, and **no later run
could tell that it had.**

## The guard

`scripts/migrate-cphi-exhibitors.js`, with the unique index separated from the `CREATE TABLE` block:

`scripts/migrate-cphi-exhibitors.js` reports and refuses, and **contains no `DELETE` statement at
all**. An earlier version took `--resolve-duplicates` and did the cleanup itself; it worked and it was
tested, and it was still the wrong shape — two destructive paths for one table, and the one nobody
reads is the one that runs. There is now exactly one, `scripts/cphi-reconcile.js`:

| Situation | Behaviour |
|---|---|
| No duplicates | index created, nothing touched |
| Duplicates | migration **refuses**, names every group with its row ids, changes nothing, points at the reconciliation tool |
| `cphi-reconcile.js` (default) | **read-only**: full report and a plan file, per-group fingerprints, exit 1 because duplicates are a blocking finding |
| `--apply <plan> --confirm-not-production` | **one transaction per group**: merge, audit rows and deletions commit together or not at all. Keeps the reviewed/annotated row — **even when it is the older one** — carries human work the losers hold onto the survivor **with provenance**, deletes the rest **by explicit id** |
| Any group with contradicting human work | **CONFLICT**: left exactly as it is, with a `SELECT` for the rows |
| A group whose rows moved since the plan | **REFUSED** per group, under `SELECT … FOR UPDATE` so the check and the act are atomic |

Deletes are by id, never by pattern or timestamp — the rule the 2026-09-30 ten-minute `DELETE` broke.
Recovery is `cphi_reconcile_audit`, which holds the complete prior row as JSON for everything touched;
a deleted row was rebuilt from it field for field as part of the harness, rather than the table's
existence being taken as proof of recoverability.

## Verification

| Harness | Asserts | Result |
|---|---|---|
| `check-cphi-duplicate-guard.js` | the migration has **no `DELETE` statement at all** — refused with `(no flags)`, `--resolve-duplicates`, `--force` and `--yes`, rows untouched each time — plus conflict labelling and that the sweep now **predicts** this class | **27 assertions, exit 0** |
| `check-cphi-reconcile.js` | the reconciliation itself, on a dump restored into an isolated database: deterministic plan, a note on a non-surviving row carried onto the survivor with provenance, conflicts untouched, a deleted row rebuilt from the audit table field for field, a second apply a no-op, drift refused per group, and **one transaction per group** proved by an injected `BEFORE DELETE` failure that rolled back the merge, the deletes and the audit rows together | **66 assertions, exit 0** |
| `check-skipped-inline-constraints.js` | extended to standalone `CREATE UNIQUE INDEX`, including expression indexes (`LOWER(x)` used verbatim in the `GROUP BY`) and partial indexes (`WHERE` preserved, or the check invents duplicates the index would not object to) | run per dump |

---

## What the owner must do

**One data decision, once.** The next `scripts/verify-prod-dump.sh` run will print, against a restored
copy and never against production:

- every duplicate `(event_slug, holder_normalized)` group, with its row ids
- for each, how many of its rows carry a review or a note
- whether the whole set is resolvable, or whether any group is a genuine conflict

Then either:

- **all groups resolvable** → the migration is run with `--resolve-duplicates` for that one step, which
  keeps every reviewed and annotated row; or
- **some groups conflict** → the owner decides which row survives in each, deletes the others, and the
  step then passes with no flag at all.

Nothing about this is reversible by the migration, which is exactly why it refuses.

## Still open

Nothing in this ticket is blocked on engineering. `ENG-003` remains the standing deployment blocker;
the two release blockers remain the exposed credentials and the production-schema verification itself.
