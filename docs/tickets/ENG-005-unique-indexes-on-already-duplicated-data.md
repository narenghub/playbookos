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

| Situation | Behaviour |
|---|---|
| No duplicates | index created, nothing touched |
| Duplicates, ≤1 human-touched row per group | **refuses by default**, names every group with its row ids, changes nothing |
| …with `--resolve-duplicates` | keeps the reviewed/annotated row — **even when it is the older one** — else the most recently checked; deletes the rest **by explicit id** |
| Any group with ≥2 human-touched rows | **refused even with the flag**, and hands over a `SELECT` for the conflicting rows |

**The migrator chain passes no flags**, so an unattended production migration can never delete a row.
Deletes are by id, never by pattern or timestamp — the rule the 2026-09-30 ten-minute `DELETE` broke.

## Verification

| Harness | Asserts | Result |
|---|---|---|
| `check-cphi-duplicate-guard.js` | all four situations above, plus that the reviewed row survives when it is the older one, and that the sweep now **predicts** this class | **24 assertions, exit 0** |
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
